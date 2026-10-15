// In-memory score model for the YuE2 ABC dialect.
// Time is measured in ticks: 256 ticks per quarter note (PPQ), the same grid the FL pack uses.

export const PPQ = 256;
export const VOICES = ["Vocal", "Ins"] as const;
export type VoiceName = (typeof VOICES)[number];
/** The voices' names in the UI (messages, the editor's voice toggle, change summaries). */
export const VOICE_LABEL: Record<VoiceName, string> = { Vocal: "ボーカル", Ins: "伴奏声部" };

export interface Note {
  id: number;
  voice: VoiceName;
  /** start in ticks from the beginning of the song */
  start: number;
  /** length in ticks */
  duration: number;
  /** MIDI pitch 0..127 */
  pitch: number;
}

export interface Chord {
  /** tick position (in the Vocal voice timeline) */
  start: number;
  symbol: string;
}

export interface Section {
  name: string;
  /** zero-based bar index where the section begins */
  bar: number;
}

/** A key change inside the body: a `K:` line after `V:` (group level) or an inline `[K:x]`. */
export interface KeyChange {
  /** tick where the new key takes effect (both voices change at the same time) */
  tick: number;
  key: string;
}

/** A meter change: an `M:` line after `V:` that starts a new group. Always on a bar boundary. */
export interface MeterChange {
  tick: number;
  meter: [number, number];
}

export interface Score {
  /** Header lines preserved verbatim except M/L/Q/K which are derived from fields below. */
  x: string;
  title: string;
  /** meter numerator/denominator (the header M:, in effect from tick 0) */
  meter: [number, number];
  /** unit note length denominator (L:1/den) */
  unit: number;
  /** tempo: quarter notes per minute (Q:1/4=bpm) */
  bpm: number;
  /** the header K: (in effect from tick 0); later changes are in keyChanges */
  key: string;
  voiceHeaders: string[];
  notes: Note[];
  chords: Chord[];
  sections: Section[];
  /** number of bars (max over voices) */
  bars: number;
  /** Key changes after the header, ordered by tick. Shared by both voices (the official dialect requires it). */
  keyChanges?: KeyChange[];
  /** Meter changes after the header, ordered by tick. Shared by both voices. */
  meterChanges?: MeterChange[];
}

export function ticksPerBar(score: Pick<Score, "meter">): number {
  const [num, den] = score.meter;
  return Math.round((PPQ * 4 * num) / den);
}

/**
 * A meter the dialect can hold: numerator 1..64, denominator a power of two up to 1024 (the L: rule, and the
 * native check's), so every bar is a whole number of ticks, at least one. Others (0/4, 1/4096, 4/24) would give
 * empty or fractional bars.
 */
export function isSupportedMeter(meter: readonly number[]): boolean {
  const [n, d] = meter;
  return Number.isInteger(n) && n >= 1 && n <= 64 && Number.isInteger(d) && d >= 1 && d <= 1024 && (d & (d - 1)) === 0;
}

/** Longest score: bars, and ticks (10000 bars of 4/4). Far beyond any song; more is a typo or a corrupt file. */
export const MAX_BARS = 10000;
export const MAX_TICKS = MAX_BARS * PPQ * 4;

/** `bars` bars of the score stay within MAX_BARS and MAX_TICKS (false for NaN / Infinity too). */
export function withinLengthLimit(score: Pick<Score, "meter" | "meterChanges">, bars: number): boolean {
  return bars <= MAX_BARS && barStartTick(score, bars) <= MAX_TICKS;
}

/** True when the score has a key or meter change after the header (written back as M: / K: lines and inline [K:]). */
export function hasTimelineChanges(score: Pick<Score, "keyChanges" | "meterChanges">): boolean {
  return (score.keyChanges?.length ?? 0) > 0 || (score.meterChanges?.length ?? 0) > 0;
}

interface MeterSegment {
  tick: number;
  bar: number;
  barTicks: number;
  meter: [number, number];
}

/** Bars counted from `ticks` of music in one meter: a partial (irregular) bar counts as a bar, as the parser does. */
function barsIn(ticks: number, barTicks: number): number {
  const r = Math.round(ticks / barTicks);
  return Math.abs(ticks - r * barTicks) <= 1 ? r : Math.ceil(ticks / barTicks);
}

/** The meter timeline as segments: [header meter from tick 0, then each change]. */
function meterSegments(score: Pick<Score, "meter" | "meterChanges">): MeterSegment[] {
  const segs: MeterSegment[] = [{ tick: 0, bar: 0, barTicks: ticksPerBar(score), meter: score.meter }];
  for (const c of (score.meterChanges ?? []).slice().sort((a, b) => a.tick - b.tick)) {
    const prev = segs[segs.length - 1];
    if (c.tick <= prev.tick) {
      segs[segs.length - 1] = { ...prev, barTicks: ticksPerBar({ meter: c.meter }), meter: c.meter };
      continue;
    }
    segs.push({ tick: c.tick, bar: prev.bar + barsIn(c.tick - prev.tick, prev.barTicks), barTicks: ticksPerBar({ meter: c.meter }), meter: c.meter });
  }
  return segs;
}

function segmentForBar(segs: MeterSegment[], bar: number): MeterSegment {
  let s = segs[0];
  for (const x of segs) if (x.bar <= bar) s = x;
  return s;
}

function segmentForTick(segs: MeterSegment[], tick: number): MeterSegment {
  let s = segs[0];
  for (const x of segs) if (x.tick <= tick) s = x;
  return s;
}

/** Tick where a (zero-based) bar starts, honoring meter changes. */
export function barStartTick(score: Pick<Score, "meter" | "meterChanges">, bar: number): number {
  const s = segmentForBar(meterSegments(score), bar);
  return s.tick + (bar - s.bar) * s.barTicks;
}

/** Zero-based index of the bar that contains `tick`, honoring meter changes. */
export function barAtTick(score: Pick<Score, "meter" | "meterChanges">, tick: number): number {
  const s = segmentForTick(meterSegments(score), tick);
  return s.bar + Math.floor((tick - s.tick) / s.barTicks);
}

/** Meter in effect at `tick`. */
export function meterAtTick(score: Pick<Score, "meter" | "meterChanges">, tick: number): [number, number] {
  return segmentForTick(meterSegments(score), tick).meter;
}

/** Key in effect at `tick` (the header key unless a later change applies). */
export function keyAtTick(score: Pick<Score, "key" | "keyChanges">, tick: number): string {
  let key = score.key;
  for (const c of (score.keyChanges ?? []).slice().sort((a, b) => a.tick - b.tick)) if (c.tick <= tick) key = c.key;
  return key;
}

/** Bars needed to hold everything up to `endTick` (a bar that is only partly used still counts). */
export function barsForEnd(score: Pick<Score, "meter" | "meterChanges">, endTick: number): number {
  const s = segmentForTick(meterSegments(score), Math.max(0, endTick - 1));
  return s.bar + Math.ceil((endTick - s.tick) / s.barTicks);
}

export function ticksPerUnit(unit: number): number {
  return Math.round((PPQ * 4) / unit);
}

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks / PPQ) * (60 / bpm);
}

export function secondsToTicks(seconds: number, bpm: number): number {
  return (seconds / 60) * bpm * PPQ;
}

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function pitchName(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1;
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${octave}`;
}

/** The two voice-definition lines of the native dialect (official compile_score.py / abc_tools.parse). */
export const NATIVE_VOICE_HEADERS = ['V: Vocal clef=treble name="Vocal Melody" snm="Vocal"', 'V: Ins clef=treble name="Ins Melody" snm="Inst."'];

/** The 30 keys of the native dialect (official abc_tools.KEYS / SheetSage2 exporter): 15 major, 15 minor. */
export const OFFICIAL_KEYS = [
  "Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#",
  "Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m",
] as const;

// Sharps (positive) or flats (negative) of the major key on each natural tonic, as in abc_tools.KEYS; a sharp
// on the tonic adds 7, a flat subtracts 7 (G# major = 8, so G#m = 5 and G# dorian = 6 stay in range).
const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
// Mode offsets from the major key on the same tonic.
const MODE_FIFTHS: Record<ModeKind, number> = { major: 0, minor: -3, dor: -2, mix: -1, lyd: 1, phr: -4, loc: -5 };
// Long forms first; the lookahead lets trailing text such as "clef=treble" through while "Dmix" is not read as "D" + "m".
const KEY_RE = /^([A-G])([#b]?)\s*(minor|min|major|maj|mixolydian|mix|dorian|dor|lydian|lyd|phrygian|phr|locrian|loc|aeolian|aeo|ionian|ion|m)?(?![a-z])/i;

type ModeKind = "major" | "minor" | "dor" | "mix" | "lyd" | "phr" | "loc";

function modeKind(mode: string): ModeKind {
  const m = mode.toLowerCase();
  if (m === "m" || m.startsWith("min") || m.startsWith("aeo")) return "minor";
  if (m.startsWith("dor")) return "dor";
  if (m.startsWith("mix")) return "mix";
  if (m.startsWith("lyd")) return "lyd";
  if (m.startsWith("phr")) return "phr";
  if (m.startsWith("loc")) return "loc";
  return "major"; // "", maj, major, ion, ionian
}

/**
 * Parse a K: value into tonic, mode and its sharps(+)/flats(-) count; null if it is not a key we can resolve.
 * Theoretical keys beyond seven accidentals (Dbm = -8, C#lyd = +8; reachable range -13..13) are resolved too,
 * so their pitches are read correctly (with double accidentals); they are not official keys (normalizeKey).
 */
export function parseKey(key: string): { tonic: string; mode: ModeKind; fifths: number; rest: string } | null {
  const m = key.trim().match(KEY_RE);
  if (!m) return null;
  const tonic = m[1].toUpperCase() + (m[2] ? m[2].toLowerCase() : "");
  const mode = modeKind(m[3] ?? "");
  const accidental = tonic.length > 1 ? (tonic[1] === "#" ? 7 : -7) : 0;
  const fifths = LETTER_FIFTHS[tonic[0]] + accidental + MODE_FIFTHS[mode];
  return { tonic, mode, fifths, rest: key.trim().slice(m[0].length) };
}

/**
 * Two K: values give the same key signature ("C" / "C major", "Am" / "A minor clef=treble", "Dmix" / "G");
 * values that cannot be resolved compare as text.
 */
export function sameKey(a: string, b: string): boolean {
  return (normalizeKey(a) ?? a.trim()) === (normalizeKey(b) ?? b.trim());
}

/**
 * Key signature: map letter (A-G) -> accidental (-2..+2). Major, minor and the church modes; unknown keys are
 * all-natural. Beyond seven accidentals the first letters of the same order get a double accidental
 * (Dbm: B = -2, every other letter -1; C#lyd: F = +2, every other letter +1).
 */
export function keySignature(key: string): Record<string, number> {
  const sig: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
  const k = parseKey(key);
  if (!k) return sig;
  const sharpsOrder = ["F", "C", "G", "D", "A", "E", "B"];
  const flatsOrder = ["B", "E", "A", "D", "G", "C", "F"];
  const order = k.fifths > 0 ? sharpsOrder : flatsOrder;
  const sign = k.fifths > 0 ? 1 : -1;
  const n = Math.abs(k.fifths);
  for (let i = 0; i < Math.min(n, 7); i++) sig[order[i]] = sign;
  for (let i = 0; i < n - 7; i++) sig[order[i]] = 2 * sign;
  return sig;
}

/**
 * The official key with the same signature: major-type modes (major/ionian, mixolydian, lydian) map to the
 * major key, minor-type modes (minor/aeolian, dorian, phrygian, locrian) to the minor key. "Dmix" -> "G",
 * "Edor" -> "Bm", "Am clef=treble" -> "Am". Pitches do not change. null when the key cannot be resolved or
 * needs more than seven accidentals (Dbm, G#: no official spelling).
 */
export function normalizeKey(key: string): string | null {
  const k = parseKey(key);
  if (!k || Math.abs(k.fifths) > 7) return null;
  const minorType = k.mode === "minor" || k.mode === "dor" || k.mode === "phr" || k.mode === "loc";
  return OFFICIAL_KEYS[k.fifths + 7 + (minorType ? 15 : 0)];
}

const LETTER_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** ABC letter + octave (from case and marks) + accidental -> MIDI. Lowercase = octave 5 (c = C5 = 72), uppercase = octave 4 (C = 60). */
export function abcPitchToMidi(letter: string, accidental: number, octaveShift: number): number {
  const upper = letter.toUpperCase();
  const base = letter === upper ? 60 : 72;
  return base + LETTER_SEMITONE[upper] + accidental + 12 * octaveShift;
}

export function emptyScore(): Score {
  return {
    x: "1",
    title: "",
    meter: [4, 4],
    unit: 16,
    bpm: 120,
    key: "C",
    voiceHeaders: [...NATIVE_VOICE_HEADERS],
    notes: [],
    chords: [],
    sections: [],
    bars: 0,
    keyChanges: [],
    meterChanges: [],
  };
}

export function cloneScore(s: Score): Score {
  return {
    ...s,
    meter: [s.meter[0], s.meter[1]],
    voiceHeaders: [...s.voiceHeaders],
    notes: s.notes.map((n) => ({ ...n })),
    chords: s.chords.map((c) => ({ ...c })),
    sections: s.sections.map((x) => ({ ...x })),
    keyChanges: (s.keyChanges ?? []).map((c) => ({ ...c })),
    meterChanges: (s.meterChanges ?? []).map((c) => ({ tick: c.tick, meter: [c.meter[0], c.meter[1]] })),
  };
}

/**
 * Bars that hold music: derived from note ends, chord onsets, section starts and key/meter changes.
 * Trailing whole-bar rests are not counted, so callers that must keep the bar grid use
 * Math.max(score.bars, recomputeBars(score)).
 */
export function recomputeBars(s: Score): number {
  let end = 0;
  for (const n of s.notes) end = Math.max(end, n.start + n.duration);
  for (const c of s.chords) end = Math.max(end, c.start + 1);
  for (const sec of s.sections) end = Math.max(end, barStartTick(s, sec.bar) + 1);
  for (const c of s.keyChanges ?? []) end = Math.max(end, c.tick + 1);
  for (const c of s.meterChanges ?? []) end = Math.max(end, c.tick + 1);
  return Math.max(1, barsForEnd(s, end));
}

/** Ordered list of chord suffixes YuE2 accepts (root/slash handled separately). */
export const CHORD_QUALITIES = ["", "m", "dim", "aug", "7", "maj7", "m7", "dim7", "m7b5", "sus4", "sus2", "6", "m6", "7sus4", "m(maj7)"];

/** Chord symbol split of the native dialect (abc_tools.CHORD): root, quality, optional slash bass; bb/## allowed. */
export const CHORD_SYMBOL_RE = /^([A-G](?:bb|##|b|#)?)(.*?)(?:\/([A-G](?:bb|##|b|#)?))?$/;

/**
 * A chord symbol of the native dialect (root, one of CHORD_QUALITIES, optional slash bass). A reference helper:
 * the checks in use are native.ts CHORD (advisory, built from the same list) and CHORD_SYMBOL_RE in edit.ts.
 */
export function isValidChordSymbol(sym: string): boolean {
  const m = sym.match(CHORD_SYMBOL_RE);
  if (!m) return false;
  return CHORD_QUALITIES.includes(m[2]);
}
