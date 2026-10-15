// Serializer: Score -> YuE2 ABC dialect text, in the layout of the official SheetSage2 exporter
// (comfy/audio_encoders/sheetsage2_abc.py score_to_abc / _measure_groups / _render_voice_measure):
// groups of up to four bars, each a "V: Vocal" block followed by a "V: Ins" block. A section ("% name"), a meter
// change or a key change on a bar line starts a new group, and the change is written as an M: / K: line under
// both voices; a key change inside a bar is written inline as [K:x] in both voices (before the chord symbol).
import { MAX_BARS, NATIVE_VOICE_HEADERS, barAtTick, barStartTick, isSupportedMeter, keyAtTick, keySignature, meterAtTick, normalizeKey, recomputeBars, sameKey, ticksPerBar, ticksPerUnit, withinLengthLimit, type KeyChange, type MeterChange, type Note, type Score, type VoiceName } from "./model";

const MAX_UNIT = 1024;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n && p < MAX_UNIT) p *= 2;
  return p;
}

/** The four-subbeat floor of L:: 4 × the denominator of every meter in the score (official abc_unit_denominator). */
function unitFloor(score: Pick<Score, "meter" | "meterChanges">): number {
  let floor = 4 * score.meter[1];
  for (const c of score.meterChanges ?? []) floor = Math.max(floor, 4 * c.meter[1]);
  return floor;
}

/**
 * L: denominator to write: keep the score's own L: (official: "Preserve an exported L: value"), go finer when an
 * edit needs it, and never below the four-subbeat floor 4 × meter denominator (abc-repair.md, compile_score.py).
 */
export function serializeUnit(score: Score, forced?: number): number {
  const floor = unitFloor(score);
  const u = forced !== undefined ? Math.max(forced, floor) : Math.max(score.unit || 16, chooseUnit(score), floor);
  return Math.min(MAX_UNIT, nextPow2(u));
}

const ALLOWED_MULT = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_SEMI = [0, 2, 4, 5, 7, 9, 11];

export interface SerializeOptions {
  /** Force unit length denominator (raised to the 4 × meter denominator floor); otherwise chosen automatically. */
  unit?: number;
  /** Bars per voice block (YuE2 uses 1–4). */
  barsPerBlock?: number;
  /** Drop chord symbols (melody mode). */
  stripChords?: boolean;
}

/** Choose the coarsest unit (1/16 or 1/32 or 1/64) that represents every note start/duration and change position. */
export function chooseUnit(score: Score): number {
  for (const unit of [16, 32, 64]) {
    const t = ticksPerUnit(unit);
    const ok =
      score.notes.every((n) => n.start % t === 0 && n.duration % t === 0) &&
      score.chords.every((c) => c.start % t === 0) &&
      (score.keyChanges ?? []).every((c) => c.tick % t === 0) &&
      (score.meterChanges ?? []).every((c) => c.tick % t === 0);
    if (ok) return unit;
  }
  return 64;
}

/** Snap every note/chord and key/meter change to the given unit grid (in place on a copy). */
export function quantize(score: Score, unit: number): Score {
  const t = ticksPerUnit(unit);
  const snap = (v: number) => Math.round(v / t) * t;
  const notes = score.notes.map((n) => {
    const start = snap(n.start);
    const end = Math.max(start + t, snap(n.start + n.duration));
    return { ...n, start, duration: end - start };
  });
  return {
    ...score,
    unit,
    notes,
    chords: score.chords.map((c) => ({ ...c, start: snap(c.start) })),
    keyChanges: (score.keyChanges ?? []).map((c) => ({ ...c, tick: snap(c.tick) })),
    meterChanges: (score.meterChanges ?? []).map((c) => ({ tick: snap(c.tick), meter: [c.meter[0], c.meter[1]] as [number, number] })),
  };
}

/**
 * The key / meter timelines as they are written: ordered, a change at tick 0 folded into the header, a restated
 * key or meter dropped (it is no change: the parser records none either), the last of two changes at one tick kept.
 */
function normalizeTimelines(score: Score): Score {
  let headerKey = score.key;
  let key = score.key;
  const keyChanges: KeyChange[] = [];
  for (const c of lastPerTick(score.keyChanges ?? [])) {
    if (c.tick <= 0) {
      headerKey = c.key;
      key = c.key;
      continue;
    }
    if (sameKey(c.key, key)) continue;
    keyChanges.push({ tick: c.tick, key: c.key });
    key = c.key;
  }
  let headerMeter = score.meter;
  let meter = score.meter;
  const meterChanges: MeterChange[] = [];
  for (const c of lastPerTick(score.meterChanges ?? [])) {
    if (c.tick <= 0) {
      headerMeter = c.meter;
      meter = c.meter;
      continue;
    }
    if (c.meter[0] === meter[0] && c.meter[1] === meter[1]) continue;
    meterChanges.push({ tick: c.tick, meter: [c.meter[0], c.meter[1]] });
    meter = c.meter;
  }
  return { ...score, key: headerKey, meter: [headerMeter[0], headerMeter[1]], keyChanges, meterChanges };
}

/** Changes ordered by tick, one per tick (the last one wins); ticks before the start count as tick 0. */
function lastPerTick<T extends { tick: number }>(changes: T[]): T[] {
  const byTick = new Map<number, T>();
  for (const c of changes.slice().sort((a, b) => a.tick - b.tick)) byTick.set(Math.max(0, c.tick), { ...c, tick: Math.max(0, c.tick) });
  return [...byTick.values()];
}

export function serializeAbc(input: Score, opts: SerializeOptions = {}): string {
  const unit = serializeUnit(input, opts.unit);
  const score = normalizeTimelines(quantize(input, unit));
  const unitTicks = ticksPerUnit(unit);
  const barsPerBlock = Math.max(1, Math.min(4, opts.barsPerBlock ?? 4));
  // The bar loops below run up to totalBars: a 0-tick or negative bar (a corrupt MIDI time signature), a runaway
  // length or a NaN position must be refused here, or they never end (or silently write no music at all).
  for (const m of [score.meter, ...(score.meterChanges ?? []).map((c) => c.meter)]) {
    if (!isSupportedMeter(m)) throw new Error(`拍子 ${m[0]}/${m[1]} は書き出せません（分子は 1〜64、分母は 2 の累乗・1024 以下）`);
  }
  const totalBars = Math.max(score.bars, recomputeBars(score));
  if (!withinLengthLimit(score, totalBars)) throw new Error(`曲が長すぎるため書き出せません（最大 ${MAX_BARS} 小節）`);
  const chords = opts.stripChords ? [] : score.chords.slice().sort((a, b) => a.start - b.start);

  const out: string[] = [];
  // Native header (official compile_score.py / abc_tools.parse): always X:1, a blank T: and the two exact voice
  // definitions. score.x / title / voiceHeaders are kept for display only; YuE2 tokenizes the header verbatim.
  out.push("X:1");
  out.push("T:");
  out.push(`M:${score.meter[0]}/${score.meter[1]}`);
  out.push(`L:1/${unit}`);
  out.push(`Q:1/4=${Math.round(score.bpm)}`);
  for (const v of NATIVE_VOICE_HEADERS) out.push(v);
  out.push(`K:${normalizeKey(score.key) ?? score.key}`);

  // Where a group must start (bar indexes): sections, meter changes (always on a bar line of the timeline: an
  // irregular bar before an off-grid change is written with its actual length) and key changes on a bar line.
  // A key change inside a bar does not start a group: it is written inline in that bar (official _measure_groups
  // compares the key at a bar's start with the key at the END of the previous bar).
  const sectionsAt = new Map<number, string[]>();
  for (const s of score.sections.slice().sort((a, b) => a.bar - b.bar)) sectionsAt.set(s.bar, [...(sectionsAt.get(s.bar) ?? []), s.name]);
  const meterAtBar = new Map<number, [number, number]>();
  for (const c of score.meterChanges ?? []) meterAtBar.set(barAtTick(score, c.tick), c.meter);
  const keyAtBar = new Map<number, string>();
  const inlineKeys = new Map<number, KeyChange[]>();
  for (const c of score.keyChanges ?? []) {
    const bar = barAtTick(score, c.tick);
    if (barStartTick(score, bar) === c.tick) keyAtBar.set(bar, c.key);
    else inlineKeys.set(bar, [...(inlineKeys.get(bar) ?? []), c]);
  }
  const groupStarts = [...new Set([0, ...sectionsAt.keys(), ...meterAtBar.keys(), ...keyAtBar.keys()])].filter((b) => b < totalBars).sort((a, b) => a - b);

  const byVoice: Record<VoiceName, Note[]> = { Vocal: [], Ins: [] };
  for (const n of score.notes) byVoice[n.voice].push(n);
  byVoice.Vocal.sort((a, b) => a.start - b.start);
  byVoice.Ins.sort((a, b) => a.start - b.start);

  for (let gi = 0; gi < groupStarts.length; gi++) {
    const from = groupStarts[gi];
    const to = gi + 1 < groupStarts.length ? groupStarts[gi + 1] : totalBars;
    for (const name of sectionsAt.get(from) ?? []) out.push(`% ${name}`);
    for (let bar = from; bar < to; bar += barsPerBlock) {
      const end = Math.min(to, bar + barsPerBlock);
      for (const voice of ["Vocal", "Ins"] as VoiceName[]) {
        out.push(`V: ${voice}`);
        if (bar === from) {
          // The change that starts the group, under both voices (official: "matching M: or K: fields in both voice blocks").
          const meter = meterAtBar.get(from);
          if (meter) out.push(`M:${meter[0]}/${meter[1]}`);
          const key = keyAtBar.get(from);
          if (key !== undefined) out.push(`K:${normalizeKey(key) ?? key}`);
        }
        out.push(renderBars(byVoice[voice], voice === "Vocal" ? chords : [], bar, end));
      }
    }
  }
  return out.join("\n") + "\n";

  function renderBars(notes: Note[], chordList: { start: number; symbol: string }[], fromBar: number, toBar: number): string {
    let line = "";
    let emptyRun = 0;
    const flushEmpty = () => {
      if (emptyRun > 0) {
        line += emptyRun === 1 ? "Z|" : `Z${emptyRun}|`;
        emptyRun = 0;
      }
    };
    for (let bar = fromBar; bar < toBar; bar++) {
      const bs = barStartTick(score, bar);
      const be = barStartTick(score, bar + 1);
      const events = buildBarEvents(notes, chordList, bs, be, inlineKeys.get(bar) ?? []);
      // A silent bar is compressed to Z only when it has the full length of its meter (Z counts by measures) and
      // carries no chord or key change (official: "Do not use a compressed rest over a harmonic or key change").
      const silent = events.every((e) => e.pitch === null && !e.chord && e.key === undefined);
      if (silent && be - bs === ticksPerBar({ meter: meterAtTick(score, bs) })) {
        emptyRun++;
        continue;
      }
      flushEmpty();
      line += renderBar(events, bs) + "|";
    }
    flushEmpty();
    return line;
  }

  interface Ev {
    start: number;
    duration: number;
    pitch: number | null; // null = rest
    tieOut: boolean;
    chord?: string;
    /** an inline key change takes effect at this event */
    key?: string;
  }

  function buildBarEvents(notes: Note[], chordList: { start: number; symbol: string }[], bs: number, be: number, keys: KeyChange[]): Ev[] {
    const evs: Ev[] = [];
    // notes overlapping this bar (clipped) — monophonic safety net: when notes overlap, the earlier note keeps
    // its length and the later one is clipped to start where the earlier ends (dropped only if nothing is left)
    const inBar = notes.filter((n) => n.start < be && n.start + n.duration > bs);
    let cursor = bs;
    for (const n of inBar) {
      const s = Math.max(bs, n.start, cursor);
      const e = Math.min(be, n.start + n.duration);
      if (s >= e) continue; // fully covered by the previous note
      if (s > cursor) evs.push({ start: cursor, duration: s - cursor, pitch: null, tieOut: false });
      evs.push({ start: s, duration: e - s, pitch: n.pitch, tieOut: n.start + n.duration > be });
      cursor = e;
    }
    if (cursor < be) evs.push({ start: cursor, duration: be - cursor, pitch: null, tieOut: false });
    const barChords = chordList.filter((c) => c.start >= bs && c.start < be);
    // Split events so that every chord position and every inline key change starts an event; a held note is
    // tied across the split (official: `"C"E16-"Am7"E16`, `E16-[K:Am]E16`).
    for (const tick of [...barChords.map((c) => c.start), ...keys.map((k) => k.tick)]) {
      const idx = evs.findIndex((e) => e.start < tick && e.start + e.duration > tick);
      if (idx >= 0) {
        const e = evs[idx];
        const first: Ev = { ...e, duration: tick - e.start, tieOut: e.pitch !== null };
        const second: Ev = { ...e, start: tick, duration: e.start + e.duration - tick };
        evs.splice(idx, 1, first, second);
      }
    }
    for (const c of barChords) {
      const e = evs.find((x) => x.start === c.start);
      if (e && !e.chord) e.chord = c.symbol; // one chord per position
    }
    for (const k of keys) {
      const e = evs.find((x) => x.start === k.tick);
      if (e) e.key = k.key;
    }
    return evs;
  }

  function renderBar(evs: Ev[], bs: number): string {
    let keySig = keySignature(keyAtTick(score, bs));
    let accState: Record<string, number> = {};
    let s = "";
    for (const e of evs) {
      if (e.key !== undefined) {
        // Inline key change before the chord symbol (official _render_voice_measure); accidentals reset.
        s += `[K:${normalizeKey(e.key) ?? e.key}]`;
        keySig = keySignature(e.key);
        accState = {};
      }
      if (e.chord) s += `"${e.chord}"`;
      const parts = splitDuration(e.duration / unitTicks);
      for (let pi = 0; pi < parts.length; pi++) {
        const mult = parts[pi];
        if (e.pitch === null) {
          s += `z${mult === 1 ? "" : mult}`;
        } else {
          s += renderPitch(e.pitch, accState, keySig) + (mult === 1 ? "" : String(mult));
          const last = pi === parts.length - 1;
          if (!last || e.tieOut) s += "-";
        }
      }
    }
    return s;
  }

  function renderPitch(pitch: number, accState: Record<string, number>, keySig: Record<string, number>): string {
    const pc = ((pitch % 12) + 12) % 12;
    const octave = Math.floor(pitch / 12) - 1; // MIDI 60 -> 4
    // Prefer a natural letter; otherwise sharp of the letter below, or flat if the key uses flats.
    let li = LETTER_SEMI.indexOf(pc);
    let accidental = 0;
    if (li < 0) {
      const flatsKey = Object.values(keySig).some((v) => v < 0);
      if (flatsKey) {
        li = LETTER_SEMI.indexOf(pc + 1);
        accidental = -1;
      } else {
        li = LETTER_SEMI.indexOf(pc - 1);
        accidental = 1;
      }
    }
    const letter = LETTERS[li];
    // Determine what the reader would assume without an explicit accidental.
    const assumed = letter in accState ? accState[letter] : keySig[letter] ?? 0;
    let prefix = "";
    if (assumed !== accidental) {
      prefix = accidental === 0 ? "=" : accidental > 0 ? "^".repeat(accidental) : "_".repeat(-accidental);
      accState[letter] = accidental;
    }
    // Octave: uppercase = octave 4, lowercase = octave 5.
    let name: string;
    let shift: number;
    if (octave >= 5) {
      name = letter.toLowerCase();
      shift = octave - 5;
      return prefix + name + "'".repeat(shift);
    }
    name = letter;
    shift = 4 - octave;
    return prefix + name + ",".repeat(shift);
  }
}

/** Split a duration (in units) into allowed multipliers, largest first (tied together). */
export function splitDuration(units: number): number[] {
  let remaining = Math.max(1, Math.round(units));
  const parts: number[] = [];
  while (remaining > 0) {
    let pick = 1;
    for (const m of ALLOWED_MULT) if (m <= remaining) pick = m;
    parts.push(pick);
    remaining -= pick;
  }
  return parts;
}
