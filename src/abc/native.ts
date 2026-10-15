// Portions of this file are ported from skills/yue2-music/scripts/abc_tools.py of YuE2
// (https://github.com/multimodal-art-projection/YuE), Copyright (c) 2026 the YuE2 authors, licensed under the
// Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Changes: translated from Python to
// TypeScript, limited to parse / parse_bar, with Japanese messages for this app. See THIRD_PARTY_NOTICES.md.
//
// Native-dialect checker: a faithful TypeScript port of the official skill helper
// skills/yue2-music/scripts/abc_tools.py (parse / parse_bar). It checks the bounded two-voice dialect that
// YuE2 and SheetSage2 export — header lines, voice blocks, bar arithmetic, durations, chords, keys, ties —
// with exact integer arithmetic. Messages are Japanese and name the group, voice and bar.
//
// This is an advisory helper only. The official helper says a rejection "does not establish that a score is
// invalid", and parseAbc / validateAbc do not call it: show the result as a warning, never block with it.
import { CHORD_QUALITIES, NATIVE_VOICE_HEADERS, OFFICIAL_KEYS } from "./model";

export interface NativeCheck {
  /** true when the text passes every check of the official helper */
  ok: boolean;
  errors: string[];
  /** advisory notes that the general helper does not reject */
  warnings: string[];
}

const DURATIONS = new Set([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]);
const PITCH_NAME = "[A-G](?:bb|##|b|#)?";
const CHORD = new RegExp(`^${PITCH_NAME}(?:${CHORD_QUALITIES.map((q) => q.replace(/[()]/g, "\\$&")).join("|")})(?:/${PITCH_NAME})?$`);
const TOKEN = /"([^"\n]*)"|\[K:([^\]\n]+)\]|(\^\^|__|\^|_|=)?([A-Ga-gz])([,']*)([0-9]*)(-?)/y;
const NATURAL: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const KEYS: Record<string, number> = Object.fromEntries(OFFICIAL_KEYS.map((k, i) => [k, (i % 15) - 7]));
const VOICES = ["Vocal", "Ins"] as const;
const MAX_ERRORS = 20;
/** exact time grid: ticks per quarter note (every legal L: and meter denominator divides it) */
const Q = 4096;

class NativeError extends Error {}

function fail(cond: boolean, message: string): void {
  if (cond) throw new NativeError(message);
}

function keyAccidentals(key: string): Record<string, number> {
  fail(!(key in KEYS), `調 ${JSON.stringify(key)} は未対応です（標準の長調/短調 30 種の K: を使ってください）`);
  const count = KEYS[key];
  const result: Record<string, number> = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  for (const letter of (count > 0 ? "FCGDAEB" : "BEADGCF").slice(0, Math.abs(count))) result[letter] = count > 0 ? 1 : -1;
  return result;
}

const isPow2 = (d: number) => d > 0 && (d & (d - 1)) === 0;

function meterValue(text: string): [number, number] {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(text);
  fail(!m, `拍子 ${JSON.stringify(text)} は未対応です（n/d の分数で書いてください）`);
  const n = Number(m![1]);
  const d = Number(m![2]);
  fail(d > 1024 || !isPow2(d), `拍子の分母 ${d} は未対応です（2 の累乗・1024 以下）`);
  return [n, d];
}

/** quarters as a readable fraction ("7/2") */
function quarters(ticks: number): string {
  const g = gcd(Math.abs(ticks), Q);
  const num = ticks / g;
  const den = Q / g;
  return den === 1 ? String(num) : `${num}/${den}`;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

interface Voice {
  meter: [number, number];
  key: string;
  time: number;
  notes: [number, number, number][];
  bars: [number, number, string][];
  chords: [number, string][];
  keys: [number, string][];
  pending: [number, number] | null;
}

function parseBar(body: string, voice: Voice, unitTicks: number, context: string): void {
  const [n, d] = voice.meter;
  const length = (4 * n * Q) / d;
  const start = voice.time;
  let offset = 0;
  let local: Record<string, number> = {}; // native exporters propagate accidentals by letter, across octaves
  try {
    if (body === "Z") {
      fail(voice.pending !== null, `${context}: タイが全休符 Z に入っています`);
      offset = length;
    } else {
      let cursor = 0;
      while (cursor < body.length) {
        if (/\s/.test(body[cursor])) {
          cursor++;
          continue;
        }
        TOKEN.lastIndex = cursor;
        const m = TOKEN.exec(body);
        fail(!m || m.index !== cursor, `${context}: 未対応の記号 ${JSON.stringify(body.slice(cursor, cursor + 24))}`);
        cursor = TOKEN.lastIndex;
        const [, chord, key, acc, note, octave, durationText, tie] = m!;
        fail(offset >= length, `${context}: 小節の終わりの後に記号があります`);
        if (chord !== undefined) {
          fail(!CHORD.test(chord), `${context}: 未対応のコード ${JSON.stringify(chord)}`);
          voice.chords.push([start + offset, chord]);
          continue;
        }
        if (key !== undefined) {
          keyAccidentals(key);
          voice.key = key;
          voice.keys.push([start + offset, key]);
          local = {};
          continue;
        }
        const units = Number(durationText || "1");
        fail(!DURATIONS.has(units), `${context}: 未対応の音価 ${units}（対応する長さをタイでつないでください）`);
        const duration = units * unitTicks;
        fail(offset + duration > length, `${context}: 音符/休符が拍子の長さを超えています`);
        fail(octave.includes(",") && octave.includes("'"), `${context}: オクターブ記号 , と ' が混在しています`);
        if (note === "z") {
          fail(Boolean(acc || octave || tie), `${context}: 休符に臨時記号・オクターブ記号・タイは付けられません`);
          fail(voice.pending !== null, `${context}: タイの後に休符があります`);
        } else {
          const letter = note.toUpperCase();
          let written = 60 + NATURAL[letter] + (note === note.toLowerCase() ? 12 : 0);
          written += 12 * ([...octave].filter((c) => c === "'").length - [...octave].filter((c) => c === ",").length);
          let alteration = letter in local ? local[letter] : keyAccidentals(voice.key)[letter];
          if (acc) {
            alteration = { "=": 0, _: -1, __: -2, "^": 1, "^^": 2 }[acc]!;
            local[letter] = alteration;
          }
          let pitch = written + alteration;
          if (voice.pending !== null) {
            const [oldPitch, oldWritten] = voice.pending;
            // An unmarked continuation keeps its tied accidental across a barline; later untied notes are unaffected.
            if (!acc && written === oldWritten) pitch = oldPitch;
            fail(pitch !== oldPitch, `${context}: タイで音高が変わっています（${oldPitch} → ${pitch}）`);
            voice.notes[voice.notes.length - 1][2] += duration;
          } else {
            fail(pitch < 0 || pitch > 127, `${context}: 音高 ${pitch} が MIDI の範囲 (0〜127) 外です`);
            voice.notes.push([start + offset, pitch, duration]);
          }
          voice.pending = tie ? [pitch, written] : null;
        }
        offset += duration;
      }
    }
    fail(offset !== length, `${context}: 小節の長さ ${quarters(offset)} 拍が拍子の長さ ${quarters(length)} 拍と一致しません`);
  } finally {
    // keep the grid moving so later bars are still checked after an error in this one
    voice.bars.push([start, length, `${n}/${d}`]);
    voice.time += length;
  }
}

/** Split like Python str.splitlines(). */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Check `text` against the official native dialect (abc_tools.parse). Errors in one bar do not stop the
 * check of later bars; a structural error (header, voice block layout) stops it.
 */
export function validateNativeAbc(text: string): NativeCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const push = (e: unknown) => {
    if (!(e instanceof NativeError)) throw e;
    if (errors.length < MAX_ERRORS) errors.push(e.message);
  };
  try {
    const lines = splitLines(text);
    fail(lines.length < 12, "ネイティブの 2 声 ABC として行数が足りません");
    fail(lines[0] !== "X:1" || lines[1] !== "T:", "1〜2 行目はネイティブの X:1 と空の T: にしてください");
    fail(!lines[2].startsWith("M:"), "3 行目に M: がありません");
    const meter = meterValue(lines[2].slice(2));
    const unitMatch = /^L:1\/([1-9][0-9]*)$/.exec(lines[3]);
    fail(!unitMatch, "4 行目は L:1/<2 の累乗>（通常 L:1/32）にしてください");
    const denominator = Number(unitMatch![1]);
    fail(denominator > 1024 || !isPow2(denominator), `L:1/${denominator} は未対応です（分母は 2 の累乗・1024 以下）`);
    const unitTicks = (4 * Q) / denominator;
    fail(!/^Q:1\/4=[1-9][0-9]*$/.test(lines[4]), "5 行目は Q:1/4=<整数の BPM> にしてください");
    fail(lines[5] !== NATIVE_VOICE_HEADERS[0] || lines[6] !== NATIVE_VOICE_HEADERS[1], "6〜7 行目はネイティブの Vocal / Ins 声部定義行のままにしてください");
    fail(!lines[7].startsWith("K:"), "8 行目に K: がありません");
    const key = lines[7].slice(2);
    keyAccidentals(key);
    const voices: Record<string, Voice> = {};
    for (const name of VOICES) voices[name] = { meter: [meter[0], meter[1]], key, time: 0, notes: [], bars: [], chords: [], keys: [[0, key]], pending: null };
    let cursor = 8;
    let group = 0;
    while (cursor < lines.length) {
      while (cursor < lines.length && lines[cursor].startsWith("% ")) cursor++;
      fail(cursor === lines.length, "セクションコメントの後に音楽がありません");
      group++;
      const counts: number[] = [];
      for (const name of VOICES) {
        const context = `グループ ${group}・${name}`;
        fail(cursor >= lines.length || lines[cursor] !== `V: ${name}`, `${context}: ここには「V: ${name}」の行が必要です`);
        cursor++;
        const voice = voices[name];
        const fields = new Set<string>();
        while (cursor < lines.length && (lines[cursor].startsWith("M:") || lines[cursor].startsWith("K:"))) {
          const fieldName = lines[cursor][0];
          const value = lines[cursor].slice(2);
          fail(fields.has(fieldName), `${context}: ${fieldName}: が重複しています`);
          fields.add(fieldName);
          if (fieldName === "M") voice.meter = meterValue(value);
          else {
            keyAccidentals(value);
            voice.key = value;
            voice.keys.push([voice.time, value]);
          }
          cursor++;
        }
        fail(cursor >= lines.length, `${context}: 音楽の行がありません`);
        const line = lines[cursor];
        fail(!line.endsWith("|"), `${context}: 音楽の行は通常の小節線「|」で終えてください`);
        cursor++;
        const bars: string[] = [];
        for (const raw of line.slice(0, -1).split("|")) {
          const bar = raw.trim();
          fail(!bar, `${context}: 空の小節、または未対応の複縦線/反復記号があります`);
          const rest = /^Z([2-4])?$/.exec(bar);
          if (rest) for (let i = 0; i < Number(rest[1] || "1"); i++) bars.push("Z");
          else bars.push(bar);
        }
        fail(bars.length < 1 || bars.length > 4, `${context}: 1 ブロックは Z 休符を展開して 1〜4 小節にしてください（${bars.length} 小節）`);
        counts.push(bars.length);
        for (const bar of bars) {
          try {
            parseBar(bar, voice, unitTicks, `${context}・小節 ${voice.bars.length + 1}`);
          } catch (e) {
            push(e);
            voice.pending = null;
          }
        }
      }
      fail(counts[0] !== counts[1], `グループ ${group}: Vocal と Ins で小節数が異なります（${counts[0]} / ${counts[1]}）`);
    }
    for (const name of VOICES) if (voices[name].pending !== null) push(new NativeError(`${name}: 曲の最後でタイが解決していません`));
    if (voices.Ins.chords.length) push(new NativeError("コード記号は Ins ではなく Vocal に書いてください"));
    if (JSON.stringify(voices.Vocal.bars) !== JSON.stringify(voices.Ins.bars)) push(new NativeError("Vocal と Ins で拍子/小節の区切りが一致しません"));
    if (JSON.stringify(voices.Vocal.keys) !== JSON.stringify(voices.Ins.keys)) push(new NativeError("Vocal と Ins で転調の位置が一致しません"));
    // Advisory: the official instrumental path needs L at least 4 × every meter denominator (four-subbeat grid).
    const dens = new Set(voices.Vocal.bars.map((b) => Number(b[2].split("/")[1])));
    for (const d of dens) {
      if (denominator % (4 * d)) warnings.push(`L:1/${denominator} は ${d} 分の拍子には粗すぎます（公式のインストゥルメンタル版への変換は L:1/${4 * d} 以上が必要）`);
    }
  } catch (e) {
    push(e);
  }
  return { ok: errors.length === 0, errors, warnings };
}
