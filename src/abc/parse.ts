// Parser for the YuE2 ABC dialect (two monophonic voices, quoted chords, % section comments).
// Key and meter changes follow the native rules (abc_tools.py / sheetsage2_abc.py): a group may start with
// `M:` / `K:` lines right after `V: Vocal` and `V: Ins`, and `[K:x]` may change the key inside a bar. Each voice
// keeps its own key, accidentals and bar length; both voices must change at the same time.
import { MAX_BARS, MAX_TICKS, abcPitchToMidi, emptyScore, isSupportedMeter, keySignature, sameKey, ticksPerBar, ticksPerUnit, withinLengthLimit, type KeyChange, type MeterChange, type Note, type Score, type VoiceName } from "./model";

export class AbcParseError extends Error {
  constructor(message: string, public line: number) {
    super(line > 0 ? `行 ${line}: ${message}` : message);
  }
}

interface VoiceState {
  pos: number; // ticks
  bar: number; // bars completed
  accidentals: Record<string, number>; // per-bar accidental memory keyed by letter (case-insensitive)
  pendingTie: Note | null;
  /** written (key-less) pitch of the tied note, so an unmarked continuation across a barline keeps its accidental */
  pendingWritten: number | null;
  key: string;
  keySig: Record<string, number>;
  meter: [number, number];
  barTicks: number;
  /** where the current meter started (tick / bar index) */
  meterTick: number;
  meterBar: number;
  keys: KeyChange[];
  meters: MeterChange[];
  /** the voice has at least one music line */
  seen: boolean;
  /** tick of the last bar line (or meter change), and the bars written so far (Z4 counts 4) */
  lastBarline: number;
  written: number;
  /** bar lines that close a bar not a whole number of bars long: tick, and the bar's number as written */
  irregular: { tick: number; bar: number }[];
}

/**
 * A bar the text writes shorter or longer than its meter (a pickup, a lost beat). The score keeps one timeline on
 * the meter's bar grid, so written back, every bar line after it moves to the grid. Not reported: a short last bar
 * (it is padded) and one right before a meter change (written with its actual length).
 */
export interface IrregularBar {
  voice: VoiceName;
  /** 1-based, as written in that voice */
  bar: number;
}

export interface AbcParseResult {
  score: Score;
  irregularBars: IrregularBar[];
}

/** An M: value: n/d (see isSupportedMeter), C or C| (a trailing % comment is allowed); anything else is an error. */
function parseMeter(value: string, lineNo: number): [number, number] {
  const v = value.replace(/%.*$/, "").trim();
  if (v === "C") return [4, 4];
  if (v === "C|") return [2, 2];
  const m = v.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) throw new AbcParseError(`拍子 M:${v} を解釈できません（n/d の分数で書いてください）`, lineNo);
  const meter: [number, number] = [Number(m[1]), Number(m[2])];
  // A 0-tick bar (1/4096) never ends a serialized score, and a fractional one (4/24) moves notes on a round trip.
  if (!isSupportedMeter(meter)) throw new AbcParseError(`拍子 M:${v} は未対応です（分子は 1〜64、分母は 2 の累乗・1024 以下）`, lineNo);
  return meter;
}

export function parseAbc(text: string): Score {
  return parseAbcDetailed(text).score;
}

/** parseAbc, and the bars whose bar lines the write-back moves (see IrregularBar). */
export function parseAbcDetailed(text: string): AbcParseResult {
  const score = emptyScore();
  score.voiceHeaders = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  /** index of the last music line (not blank, a % line or a field line such as V: / M: / K:), -1 if none */
  let lastMusic = lines.length - 1;
  while (lastMusic >= 0 && /^(?:$|%|[A-Za-z]:)/.test(lines[lastMusic].trim())) lastMusic--;
  const newVoice = (): VoiceState => ({
    pos: 0,
    bar: 0,
    accidentals: {},
    pendingTie: null,
    pendingWritten: null,
    key: score.key,
    keySig: keySignature(score.key),
    meter: [score.meter[0], score.meter[1]],
    barTicks: ticksPerBar(score),
    meterTick: 0,
    meterBar: 0,
    keys: [],
    meters: [],
    seen: false,
    lastBarline: 0,
    written: 0,
    irregular: [],
  });
  const states: Record<VoiceName, VoiceState> = { Vocal: newVoice(), Ins: newVoice() };
  let current: VoiceName | null = null;
  let inBody = false;
  let nextId = 1;
  let unitTicks = ticksPerUnit(score.unit);
  let unitSeen = false;
  /** chord symbol at each tick, both voices (official compile_score.py: one chord event per onset) */
  const chordAt = new Map<number, string>();

  const setHeaderMeter = (meter: [number, number]) => {
    score.meter = meter;
    for (const st of Object.values(states)) {
      st.meter = [meter[0], meter[1]];
      st.barTicks = ticksPerBar(score);
    }
  };
  const setHeaderKey = (key: string) => {
    score.key = key;
    for (const st of Object.values(states)) {
      st.key = key;
      st.keySig = keySignature(key);
    }
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.trim();
    const lineNo = li + 1;
    if (!line) continue;
    if (line.startsWith("%")) {
      // "%%" lines are directives (e.g. %%MIDI), not section labels.
      if (line.startsWith("%%")) continue;
      const name = line.slice(1).trim();
      // A label with no music after it (a trailing "% end") introduces nothing: it is dropped. Placed at the
      // current voice, it would land inside the song when that voice is the shorter one.
      if (name && inBody && li < lastMusic) {
        // Section starts where the music it introduces starts: in the voice a following V: line names, else in
        // the current voice. In the native layout both voices are there (a label before each group's V: Vocal);
        // written a voice at a time, the other voice may already be at the end. Before any voice: the furthest
        // bar either has reached. From the position, not st.bar: a music line whose last bar has no closing "|"
        // has still filled that bar. The other voice's copy of a label lands on the same bar and is dropped.
        const voice = voiceAfter(li) ?? current;
        const bar = voice ? barIndex(states[voice]) : Math.max(barIndex(states.Vocal), barIndex(states.Ins));
        if (!score.sections.some((s) => s.bar === bar && s.name === name)) score.sections.push({ name, bar });
      }
      continue;
    }
    const field = line.match(/^([A-Za-z]):\s*(.*)$/);
    if (field && !inBody) {
      const [, key, value] = field;
      switch (key) {
        case "X":
          score.x = value.trim();
          break;
        case "T":
          score.title = value.trim();
          break;
        case "M":
          setHeaderMeter(parseMeter(value, lineNo));
          break;
        case "L": {
          const m = value.replace(/%.*$/, "").trim().match(/^1\s*\/\s*(\d+)$/); // a trailing % comment is allowed
          if (!m) throw new AbcParseError(`L: は 1/n 形式で指定してください (${value})`, lineNo);
          const den = Number(m[1]);
          // Every unit must be a whole number of ticks (1024 per whole note), as the native check requires.
          if (!(den >= 1 && den <= 1024 && 1024 % den === 0)) throw new AbcParseError(`L:1/${den} は未対応です（分母は 2 の累乗・1024 以下）`, lineNo);
          score.unit = den;
          unitTicks = ticksPerUnit(score.unit);
          unitSeen = true;
          break;
        }
        case "Q": {
          const m = value.match(/(\d+)\s*\/\s*(\d+)\s*=\s*(\d+)/);
          if (m) {
            // Convert to quarter-note BPM.
            const beat = Number(m[1]) / Number(m[2]);
            score.bpm = Math.round(Number(m[3]) * (beat / 0.25));
          } else {
            const n = value.match(/(\d+)/);
            if (n) score.bpm = Number(n[1]);
          }
          break;
        }
        case "K":
          setHeaderKey(value.trim());
          inBody = true; // K: is the last header field in ABC
          break;
        case "V":
          score.voiceHeaders.push(line);
          break;
        default:
          break; // ignore other headers
      }
      continue;
    }
    if (!inBody) continue;

    const vm = line.match(/^V:\s*(\w+)/);
    if (vm) {
      const name = vm[1] as VoiceName;
      if (name !== "Vocal" && name !== "Ins") throw new AbcParseError(`未対応の声部 "${name}"（Vocal / Ins のみ対応）`, lineNo);
      current = name;
      continue;
    }
    // Group-level meter / key change: a standalone M: or K: line after "V: <voice>".
    const change = line.match(/^([MK]):\s*(.*)$/);
    if (change) {
      const [, kind, value] = change;
      const meter = kind === "M" ? parseMeter(value, lineNo) : null;
      if (!current) {
        // Still before the first voice block: treat it as a (late) header field.
        if (meter) setHeaderMeter(meter);
        else setHeaderKey(value.trim());
      } else if (meter) changeMeter(states[current], meter);
      else changeKey(states[current], value.trim());
      continue;
    }
    // Any other field line in the body (L:, Q:, T:, w:, …; also C: / D:, which would otherwise read as a note).
    const other = line.match(/^([A-Za-z]):/);
    if (other) {
      const f = other[1];
      if (f === "w" || f === "W") throw new AbcParseError("歌詞行 w: / W: は譜面では使えません（歌詞は歌詞欄に入力してください）", lineNo);
      throw new AbcParseError(`本文中のフィールド ${f}: は未対応です（本文で使えるのは V: と、V: 直後の M: / K: だけです）`, lineNo);
    }
    if (/^\[[MLQ]:/.test(line)) {
      throw new AbcParseError("行頭のインラインフィールド [M:] / [L:] / [Q:] は未対応です", lineNo);
    }
    if (!current) throw new AbcParseError("V: Vocal / V: Ins の指定前に音符があります", lineNo);
    states[current].seen = true;
    parseMusicLine(line, lineNo, current);
    // A runaway count (Z99999999, C9999999999) would make writing the score back take minutes or all memory.
    if (!(barIndex(states[current]) <= MAX_BARS && states[current].pos <= MAX_TICKS)) {
      throw new AbcParseError(`曲が長すぎます（最大 ${MAX_BARS} 小節。Z の小節数や音の長さの数字を確認してください）`, lineNo);
    }
  }
  // Without K: nothing after the header is read (the body starts at K:), which would give an empty score.
  if (!inBody) throw new AbcParseError("K: 行がありません（K: はヘッダの最後、声部宣言 V: Vocal / V: Ins の後・本文の前に書いてください）", 0);
  // Without L: ABC's default unit depends on the meter (1/8 from 3/4 up, as the staff view reads it): rather than
  // guess, require it as the native header does, so the piano roll, the staff and the write-back agree.
  if (!unitSeen) throw new AbcParseError("L: 行がありません（ヘッダの M: の後に L:1/16 などの単位音価を書いてください）", 0);

  if (score.voiceHeaders.length === 0) score.voiceHeaders = emptyScore().voiceHeaders;
  score.notes.sort((a, b) => a.start - b.start || a.voice.localeCompare(b.voice));
  score.chords.sort((a, b) => a.start - b.start);
  score.sections.sort((a, b) => a.bar - b.bar);

  // Both voices must share one key / meter timeline (official: "Voice key-change timelines differ").
  const { Vocal: vocal, Ins: ins } = states;
  if (vocal.seen && ins.seen) {
    const sameKeys = vocal.keys.length === ins.keys.length && vocal.keys.every((k, i) => Math.abs(k.tick - ins.keys[i].tick) <= 1 && sameKey(k.key, ins.keys[i].key));
    const sameMeters =
      vocal.meters.length === ins.meters.length &&
      vocal.meters.every((m, i) => Math.abs(m.tick - ins.meters[i].tick) <= 1 && m.meter[0] === ins.meters[i].meter[0] && m.meter[1] === ins.meters[i].meter[1]);
    if (!sameKeys || !sameMeters) throw new AbcParseError("声部間で転調/拍子変更の位置が一致しません", 0);
  }
  const timeline = vocal.seen || !ins.seen ? vocal : ins;
  // A change at the very start (e.g. K:/M: right after the first V: lines) only restates the header: fold it
  // into the header so the score stays editable. Nothing sounds before tick 0, so the music is the same.
  while (timeline.keys.length && timeline.keys[0].tick === 0) score.key = timeline.keys.shift()!.key;
  while (timeline.meters.length && timeline.meters[0].tick === 0) score.meter = timeline.meters.shift()!.meter;
  score.keyChanges = timeline.keys.map((k) => ({ ...k }));
  score.meterChanges = timeline.meters.map((m) => ({ tick: m.tick, meter: [m.meter[0], m.meter[1]] }));
  const barsOf = (st: VoiceState) => Math.max(st.bar, st.meterBar + Math.ceil((st.pos - st.meterTick) / st.barTicks));
  score.bars = Math.max(barsOf(vocal), barsOf(ins));
  if (!withinLengthLimit(score, score.bars)) throw new AbcParseError(`曲が長すぎます（最大 ${MAX_BARS} 小節）`, 0);
  // A label after the last music introduces nothing (one with no music line after it was skipped above; this
  // catches one whose music adds no time): kept, it would count as music and be written back as an extra silent
  // bar (the official check rejects it: no music after the section comment).
  score.sections = score.sections.filter((s) => s.bar < score.bars);
  const irregularBars: IrregularBar[] = [];
  for (const voice of ["Vocal", "Ins"] as VoiceName[]) {
    const st = states[voice];
    for (const b of st.irregular) {
      // a short last bar is padded, and one right before a meter change keeps its length: nothing after it moves
      if (st.pos - b.tick <= 1 || st.meters.some((m) => Math.abs(m.tick - b.tick) <= 1)) continue;
      irregularBars.push({ voice, bar: b.bar });
    }
  }
  return { score, irregularBars };

  /** The voice a V: line right after line `li` names (blank lines and other labels skipped), else null. */
  function voiceAfter(li: number): VoiceName | null {
    for (let j = li + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith("%")) continue;
      const v = next.match(/^V:\s*(\w+)/)?.[1];
      return v === "Vocal" || v === "Ins" ? v : null;
    }
    return null;
  }

  /** Bar index at the voice's position: exact multiples count as-is, an irregular bar is rounded up. */
  function barIndex(st: VoiceState): number {
    const rel = st.pos - st.meterTick;
    const whole = Math.round(rel / st.barTicks);
    return st.meterBar + (Math.abs(rel - whole * st.barTicks) > 1 ? Math.ceil(rel / st.barTicks) : whole);
  }

  function changeMeter(st: VoiceState, meter: [number, number]) {
    if (meter[0] === st.meter[0] && meter[1] === st.meter[1]) return;
    st.meterBar = barIndex(st);
    st.bar = st.meterBar;
    st.meterTick = st.pos;
    st.lastBarline = st.pos;
    st.meter = meter;
    st.barTicks = ticksPerBar({ meter });
    st.meters.push({ tick: st.pos, meter: [meter[0], meter[1]] });
  }

  function changeKey(st: VoiceState, key: string) {
    st.accidentals = {}; // accidentals reset at a key change
    if (sameKey(key, st.key)) return; // "K:C major" after "K:C" keeps the signature: not a change
    st.key = key;
    st.keySig = keySignature(key);
    st.keys.push({ tick: st.pos, key });
  }

  function parseMusicLine(line: string, lineNo: number, voice: VoiceName) {
    const st = states[voice];
    let i = 0;
    const n = line.length;
    while (i < n) {
      const ch = line[i];
      if (/\s/.test(ch)) {
        // every whitespace, as the official check (Python isspace): NBSP from a web page, U+3000 from the IME
        i++;
        continue;
      }
      if (ch === "|") {
        // Bar line (also handles || and |] loosely)
        i++;
        while (i < n && (line[i] === "|" || line[i] === "]")) i++;
        // If the voice is exactly at a bar boundary, count it; otherwise (an irregular bar) keep going but
        // align the bar counter to the actual position.
        st.bar = barIndex(st);
        st.accidentals = {};
        // A bar that is not a whole number of bars long (a pickup, a lost beat) is noted (IrregularBar).
        const len = st.pos - st.lastBarline;
        if (len > 0) {
          st.written++;
          const r = len % st.barTicks;
          if (Math.min(r, st.barTicks - r) > 1) st.irregular.push({ tick: st.pos, bar: st.written });
        }
        st.lastBarline = st.pos;
        continue;
      }
      if (ch === '"') {
        const end = line.indexOf('"', i + 1);
        if (end < 0) throw new AbcParseError("コード記号の引用符が閉じていません", lineNo);
        const symbol = line.slice(i + 1, end).trim();
        // One chord per position (the serializer writes one): the same symbol again, also from the other voice,
        // is a harmless duplicate; a different one is an error, as in the official compile_score.py.
        const prev = chordAt.get(st.pos);
        if (prev !== undefined && prev !== symbol) throw new AbcParseError(`同じ位置に異なるコード記号があります（"${prev}" と "${symbol}"。1 つにしてください）`, lineNo);
        if (prev === undefined) {
          chordAt.set(st.pos, symbol);
          score.chords.push({ start: st.pos, symbol }); // chords in Ins are tolerated; the serializer moves them to Vocal
        }
        i = end + 1;
        continue;
      }
      if (ch === "Z") {
        // Whole-bar rest(s) in the voice's current meter
        if (st.pendingTie) throw new AbcParseError("タイの後に休符は置けません", lineNo);
        i++;
        let num = "";
        while (i < n && /\d/.test(line[i])) num += line[i++];
        const count = num ? Number(num) : 1;
        if (count === 0) throw new AbcParseError(`長さの指定 "Z${num}" は使えません（0 は指定できません）`, lineNo);
        st.pos += count * st.barTicks;
        st.written += count - 1; // the bar line after it counts the last one
        continue;
      }
      if (ch === "z" || ch === "x") {
        if (st.pendingTie) throw new AbcParseError("タイの後に休符は置けません", lineNo);
        i++;
        const { ticks, next } = readDuration(line, i, unitTicks, lineNo);
        i = next;
        st.pos += ticks;
        continue;
      }
      if (ch === "[") {
        // Inline field like [K:G] — a key change for this voice at this time; chord stacks are unsupported.
        const end = line.indexOf("]", i);
        if (end < 0) throw new AbcParseError("[ が閉じていません", lineNo);
        const inner = line.slice(i + 1, end);
        const f = inner.match(/^([KMLQ]):\s*(.*)$/);
        if (f) {
          if (f[1] === "K") changeKey(st, f[2].trim());
          else throw new AbcParseError(`インラインフィールド [${f[1]}:] は未対応です`, lineNo);
          i = end + 1;
          continue;
        }
        throw new AbcParseError("和音（[CEG] 形式）は未対応です。YuE2 の譜面は単旋律です", lineNo);
      }
      // Accidentals
      let acc: number | null = null;
      if (ch === "^" || ch === "_" || ch === "=") {
        let a = 0;
        while (i < n && (line[i] === "^" || line[i] === "_" || line[i] === "=")) {
          if (line[i] === "^") a += 1;
          else if (line[i] === "_") a -= 1;
          else a = 0;
          i++;
        }
        acc = a;
      }
      const letter = line[i];
      if (!letter || !/[A-Ga-g]/.test(letter)) {
        if (letter === "-" ) {
          // stray tie
          i++;
          continue;
        }
        if (letter === "(" || letter === ")" || letter === "{" || letter === "}" || letter === "~" || letter === "!" || letter === ">" || letter === "<" || letter === "." ) {
          throw new AbcParseError(`未対応の記号 "${letter}"（連符・装飾音・スラー・付点リズムは YuE2 では使えません）`, lineNo);
        }
        throw new AbcParseError(`解釈できない文字 ${shownChar(line, i)}`, lineNo);
      }
      i++;
      let octave = 0;
      while (i < n && (line[i] === "'" || line[i] === ",")) {
        octave += line[i] === "'" ? 1 : -1;
        i++;
      }
      const { ticks, next } = readDuration(line, i, unitTicks, lineNo);
      i = next;
      let tie = false;
      if (i < n && line[i] === "-") {
        tie = true;
        i++;
      }
      const upper = letter.toUpperCase();
      const written = abcPitchToMidi(letter, 0, octave);
      let accidental: number;
      if (acc !== null) {
        accidental = acc;
        st.accidentals[upper] = acc; // propagates by letter across octaves within the bar
      } else if (upper in st.accidentals) {
        accidental = st.accidentals[upper];
      } else {
        accidental = st.keySig[upper] ?? 0;
      }
      let pitch = abcPitchToMidi(letter, accidental, octave);
      if (st.pendingTie) {
        // An unmarked continuation of the same written note keeps the tied pitch (also across a barline);
        // it does not change the accidental state for later untied notes.
        if (acc === null && st.pendingWritten === written) pitch = st.pendingTie.pitch;
        if (pitch !== st.pendingTie.pitch) throw new AbcParseError("タイは同じ高さの音同士でなければなりません", lineNo);
        if (Math.abs(st.pendingTie.start + st.pendingTie.duration - st.pos) <= 1) {
          st.pendingTie.duration += ticks;
          st.pos += ticks;
          if (!tie) {
            st.pendingTie = null;
            st.pendingWritten = null;
          }
          continue;
        }
      }
      const note: Note = { id: nextId++, voice, start: st.pos, duration: ticks, pitch };
      score.notes.push(note);
      st.pos += ticks;
      st.pendingTie = tie ? note : null;
      st.pendingWritten = tie ? written : null;
    }
  }
}

/** The character at `i` for a message: quoted, or its code point when it cannot be seen (U+200B, a control). */
function shownChar(line: string, i: number): string {
  const cp = line.codePointAt(i);
  if (cp === undefined) return `"${line[i]}"`;
  const ch = String.fromCodePoint(cp);
  return /\p{C}/u.test(ch) ? `U+${cp.toString(16).toUpperCase().padStart(4, "0")}（目に見えない文字です。削除してください）` : `"${ch}"`;
}

/** Read an optional duration multiplier/divisor after a note or rest: "", "3", "3/2", "/2", "/" */
function readDuration(line: string, i: number, unitTicks: number, lineNo: number): { ticks: number; next: number } {
  const from = i;
  let num = "";
  while (i < line.length && /\d/.test(line[i])) num += line[i++];
  let den = "";
  if (line[i] === "/") {
    i++;
    while (i < line.length && /\d/.test(line[i])) den += line[i++];
    if (!den) den = "2";
    while (line[i] === "/") {
      i++;
      den = String(Number(den) * 2);
    }
  }
  const mult = num ? Number(num) : 1;
  const div = den ? Number(den) : 1;
  // "/0" would be a note of Infinity ticks (the score then writes back as its header only); "0" an empty one.
  if (mult === 0 || div === 0) throw new AbcParseError(`長さの指定 "${line.slice(from, i)}" は使えません（0 は指定できません）`, lineNo);
  return { ticks: Math.round((unitTicks * mult) / div), next: i };
}

/** Quick validation helper: returns an error message (Japanese) or null. */
export function validateAbc(text: string): string | null {
  try {
    parseAbc(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
