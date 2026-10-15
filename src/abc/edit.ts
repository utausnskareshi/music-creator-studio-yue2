// Pure editing operations used by the score editor (kept here so they can be unit-tested without React).
import { CHORD_SYMBOL_RE, keyAtTick, parseKey, recomputeBars, type Chord, type Note, type Score } from "./model";

/** Keep each voice monophonic: shorten or remove notes of the same voice that overlap `n`. */
export function truncateOverlaps(notes: Note[], n: Note): Note[] {
  const out: Note[] = [];
  for (const m of notes) {
    if (m.voice !== n.voice || m.id === n.id) {
      out.push(m);
      continue;
    }
    const mEnd = m.start + m.duration;
    const nEnd = n.start + n.duration;
    if (mEnd <= n.start || m.start >= nEnd) {
      out.push(m);
    } else if (m.start < n.start) {
      out.push({ ...m, duration: n.start - m.start });
    } else if (mEnd > nEnd) {
      out.push({ ...m, start: nEnd, duration: mEnd - nEnd });
    } // else fully covered: dropped
  }
  return out;
}

/**
 * Move the notes `ids` by `delta` ticks, then resolve overlaps the way the piano roll does after a mouse move
 * (the moved notes win). null when a note would move before the start of the song: clamping it at 0 would
 * change the spacing of the selection.
 */
export function moveNotes(notes: Note[], ids: Set<number>, delta: number): Note[] | null {
  if (notes.some((n) => ids.has(n.id) && n.start + delta < 0)) return null;
  return settleMoved(
    notes.map((n) => (ids.has(n.id) ? { ...n, start: n.start + delta } : n)),
    ids,
  );
}

/** Resolve overlaps after a move: each moved note (`ids`) wins against the other notes of its voice. */
export function settleMoved(notes: Note[], ids: Iterable<number>): Note[] {
  let out = notes;
  for (const id of ids) {
    const n = out.find((m) => m.id === id);
    if (n) out = truncateOverlaps(out.filter((m) => m.id !== id), n).concat(n);
  }
  return out;
}

// ---------- piano-roll gestures (the component converts pixels to ticks / pitches and calls these) ----------

/**
 * Clamp a move drag's offset once for the whole selection (`origin`: the moved notes as they were when the drag
 * started), so the selection moves rigidly: never before the start of the song, and never further outside the
 * drawn pitch rows `lo..hi` than it already is. An offset of 0 is always allowed, so a note outside the rows
 * keeps its pitch on a sideways drag.
 */
export function clampMoveDelta(origin: { start: number; pitch: number }[], dTick: number, dPitch: number, lo: number, hi: number): { dTick: number; dPitch: number } {
  if (origin.length === 0) return { dTick, dPitch };
  const minStart = Math.min(...origin.map((o) => o.start));
  const minP = Math.min(...origin.map((o) => o.pitch));
  const maxP = Math.max(...origin.map((o) => o.pitch));
  return {
    dTick: Math.max(dTick, -minStart),
    dPitch: Math.min(Math.max(dPitch, Math.min(0, lo - minP)), Math.max(0, hi - maxP)),
  };
}

/** A move drag step: `base` (the notes at drag start) with the notes `ids` moved by an already clamped offset. */
export function moveGesture(base: Note[], ids: Set<number>, dTick: number, dPitch: number): Note[] {
  return base.map((n) => (ids.has(n.id) ? { ...n, start: n.start + dTick, pitch: n.pitch + dPitch } : n));
}

/**
 * A resize (or create) drag step: `note` with the new `duration`, its overlaps resolved against `base` (the
 * notes at drag start), so a neighbour the note passed over comes back when the note is shortened again.
 */
export function resizeGesture(base: Note[], note: Note, duration: number): Note[] {
  const updated = { ...note, duration };
  return truncateOverlaps(base.filter((m) => m.id !== note.id), updated).concat(updated);
}

/** A new note (id: the highest id + 1) on `voice`; notes of that voice it overlaps are shortened or removed. */
export function createNote(notes: Note[], voice: Note["voice"], start: number, pitch: number, duration: number): { notes: Note[]; note: Note } {
  const id = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
  const note: Note = { id, voice, start, duration, pitch };
  return { notes: resizeGesture(notes, note, duration), note };
}

/** A note drag as it ends (the piano roll's drag state, reduced to what decides its end). */
export type NoteDragEnd =
  | { kind: "move"; moved: boolean; dTick: number; dPitch: number }
  | { kind: "resize"; changed: boolean; duration: number; note: Note }
  | { kind: "create" };

/**
 * How a note drag ends. "none": it sent no step (a click that only selects). "commit": its last step is the edit
 * to keep. "revert": it sent steps but ended where it began (a note grown and shrunk back, a selection moved and
 * brought back), so the editor goes back to the score from before the drag instead of keeping a no-op edit.
 * A create drag always keeps its new note.
 */
export function noteDragEnd(d: NoteDragEnd): "none" | "commit" | "revert" {
  if (d.kind === "create") return "commit";
  if (d.kind === "move") return !d.moved ? "none" : d.dTick === 0 && d.dPitch === 0 ? "revert" : "commit";
  return !d.changed ? "none" : d.duration === d.note.duration ? "revert" : "commit";
}

/** A note drag as the piano roll keeps it: the drag-start notes, and the notes its last step sent (none yet: absent). */
export type NoteDragState =
  | { kind: "move"; moved: boolean; dTick: number; dPitch: number; ids: Set<number>; base: Note[]; last?: Note[] }
  | { kind: "resize"; changed: boolean; duration: number; note: Note; base: Note[]; last?: Note[] }
  | { kind: "create"; base: Note[]; last?: Note[] };

/**
 * The notes of the onChange that ends a note drag (see noteDragEnd), or null when it sent no step. Built from the
 * notes the drag's own last step sent, never from the score of the render the handler was bound in: a step and
 * the mouse up handled before React re-renders (both in one input task) must still end with that step.
 */
export function dragEndChange(d: NoteDragState): { notes: Note[]; revert: boolean } | null {
  const end = noteDragEnd(d);
  if (end === "none") return null;
  if (end === "revert") return { notes: d.base, revert: true };
  const last = d.last ?? d.base;
  // after a move, overlaps are resolved (the moved notes win)
  return { notes: d.kind === "move" ? settleMoved(last, d.ids) : last, revert: false };
}

/**
 * A key the editor turns into an edit (Delete / Backspace, the arrows, Ctrl+Z) pressed while a note drag is held
 * (`dragKind`: the piano roll's drag, null for none). The piano roll swallows it: the drag builds every step and
 * its end from the notes at its start, so the edit would come undone at the next step or the mouse up.
 */
export function editKeyDuringDrag(dragKind: string | null, e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  if (dragKind !== "move" && dragKind !== "resize" && dragKind !== "create") return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return key === "Delete" || key === "Backspace" || key.startsWith("Arrow") || (key === "z" && (e.ctrlKey || e.metaKey));
}

/** Box selection: the notes that touch ticks t0..t1 and pitches pLo..pHi (edges included), added to `base`. */
export function boxSelect(notes: Note[], t0: number, t1: number, pLo: number, pHi: number, base: Iterable<number> = []): Set<number> {
  const ids = new Set(base);
  for (const n of notes) {
    if (n.start + n.duration >= t0 && n.start <= t1 && n.pitch <= pHi && n.pitch >= pLo) ids.add(n.id);
  }
  return ids;
}

/** The selected ids that are notes of `notes` (a selection can outlive the notes it named). */
export function liveSelection(notes: Note[], selected: Set<number>): Set<number> {
  return new Set(notes.filter((n) => selected.has(n.id)).map((n) => n.id));
}

/** Transpose the notes `ids`; null when a pitch would leave MIDI 0..127 (refused rather than clamped). */
export function transposeNotes(notes: Note[], ids: Set<number>, semis: number): Note[] | null {
  if (notes.some((n) => ids.has(n.id) && (n.pitch + semis < 0 || n.pitch + semis > 127))) return null;
  return notes.map((n) => (ids.has(n.id) ? { ...n, pitch: n.pitch + semis } : n));
}

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

function pitchClass(name: string): number {
  let pc = LETTER_PC[name[0].toUpperCase()];
  for (const c of name.slice(1)) pc += c === "#" ? 1 : c === "b" ? -1 : 0;
  return ((pc % 12) + 12) % 12;
}

/**
 * Move a K: value by `semis`, keeping its mode and any trailing text ("m", " dorian", " clef=treble"), and
 * spell the new tonic with the fewest accidentals among the spellings that give a valid key signature.
 * null when the key cannot be parsed or no spelling is valid.
 */
export function transposeKey(key: string, semis: number): string | null {
  const k = parseKey(key);
  if (!k) return null;
  const trimmed = key.trim();
  const tail = trimmed.slice(k.tonic.length); // everything after the tonic (parseKey keeps its length)
  const pc = (pitchClass(k.tonic) + semis + 1200) % 12;
  const candidates = [...new Set([SHARP_NAMES[pc], FLAT_NAMES[pc]])]
    .map((t) => ({ key: t + tail, parsed: parseKey(t + tail) }))
    .filter((c) => c.parsed !== null && Math.abs(c.parsed.fifths) <= 7); // an official spelling
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const d = Math.abs(a.parsed!.fifths) - Math.abs(b.parsed!.fifths);
    if (d !== 0) return d;
    // equal (F# / Gb): stay on the side of the original key
    const wantSharp = k.fifths >= 0;
    return (a.parsed!.fifths >= 0) === wantSharp ? -1 : 1;
  });
  return candidates[0].key;
}

/**
 * Move a chord symbol's root and slash bass by `semis`, keeping the quality suffix; sharps or flats follow
 * the new key signature (`preferFlats`). null when the symbol is not a root-quality-bass chord (e.g. "N").
 */
export function transposeChordSymbol(symbol: string, semis: number, preferFlats: boolean): string | null {
  const m = symbol.match(CHORD_SYMBOL_RE);
  if (!m) return null;
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  const move = (name: string) => names[(pitchClass(name) + semis + 1200) % 12];
  return move(m[1]) + m[2] + (m[3] ? `/${move(m[3])}` : "");
}

export interface TransposeResult {
  score: Score;
  /** chord symbols that could not be moved (left as they are) */
  unmovedChords: number;
  /** the key could not be moved (left as it is) */
  keyUnchanged: boolean;
}

/**
 * Whole-score transpose: notes, and — unless it is an octave shift — the K: key (the header and every later key
 * change) and every chord root/bass, so the melody stays on its harmony. null when a note would leave MIDI 0..127.
 */
export function transposeScore(score: Score, semis: number): TransposeResult | null {
  const notes = transposeNotes(score.notes, new Set(score.notes.map((n) => n.id)), semis);
  if (!notes) return null;
  if (semis % 12 === 0) return { score: { ...score, notes }, unmovedChords: 0, keyUnchanged: false };
  const newKey = transposeKey(score.key, semis);
  let keyUnchanged = newKey === null;
  const keyChanges = (score.keyChanges ?? []).map((c) => {
    const moved = transposeKey(c.key, semis);
    if (moved === null) keyUnchanged = true;
    return { ...c, key: moved ?? c.key };
  });
  const moved: Score = { ...score, notes, key: newKey ?? score.key, keyChanges };
  let unmovedChords = 0;
  const chords: Chord[] = score.chords.map((c) => {
    // sharps or flats follow the key in effect where the chord sounds
    const preferFlats = (parseKey(keyAtTick(moved, c.start))?.fifths ?? 0) < 0;
    const symbol = transposeChordSymbol(c.symbol, semis, preferFlats);
    if (symbol === null) {
      if (c.symbol !== "N") unmovedChords++;
      return { ...c };
    }
    return { ...c, symbol };
  });
  return { score: { ...moved, chords }, unmovedChords, keyUnchanged };
}

/**
 * Bar count after an edit: at least `baseBars` (the bars of the score as it was taken in, so its trailing silent
 * bars survive deletions) and as many as the music needs. Measured from the base, not from the previous edit,
 * so bars a drag only passed through are not kept.
 */
export function editedBars(baseBars: number, next: Score): number {
  return Math.max(baseBars, recomputeBars(next));
}
