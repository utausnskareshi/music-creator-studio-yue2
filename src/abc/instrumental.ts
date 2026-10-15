// Instrumental transform (official YuE2 instrumental skill: instrumentalize.py / instrumental.py prepare()):
// move every Vocal note into the Ins voice, keep chords/sections/rests and the bar grid (trailing silent bars
// included), and render with empty lyrics or the score's section tags. The style follows prepare(): it starts
// with "Instrumental" and carries the four negatives. Because our style comes from the vocal-song form, vocal
// and language descriptors are removed first (our own, conservative addition).
//
// instrumentalStyle()'s rules and lyricTagsFromAbc() are ported from prepare() and lyric_tags() of
// skills/yue2-music/instrumental/scripts/instrumental.py of YuE2 (https://github.com/multimodal-art-projection/YuE),
// MIT License, Copyright (c) 2026 yue2-music contributors (the full notice is in THIRD_PARTY_NOTICES.md).
import { REQUESTED_TITLE_MAX_CHARS } from "../config/rules";
import { cloneScore, recomputeBars, type Note, type Score } from "./model";

export interface InstrumentalResult {
  score: Score;
  movedNotes: number;
  /** Ins notes shortened or dropped because a vocal note overlapped them (vocal wins). */
  overlaps: number;
}

export function toInstrumental(input: Score): InstrumentalResult {
  const score = cloneScore(input); // keyChanges / meterChanges are carried through
  const vocal = score.notes.filter((n) => n.voice === "Vocal").sort((a, b) => a.start - b.start);
  let ins = score.notes.filter((n) => n.voice === "Ins").sort((a, b) => a.start - b.start);
  let overlaps = 0;
  let nextId = score.notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
  for (const v of vocal) {
    const moved: Note = { id: nextId++, voice: "Ins", start: v.start, duration: v.duration, pitch: v.pitch };
    const vEnd = moved.start + moved.duration;
    const kept: Note[] = [];
    for (const n of ins) {
      const nEnd = n.start + n.duration;
      if (nEnd <= moved.start || n.start >= vEnd) {
        kept.push(n);
        continue;
      }
      overlaps++;
      if (n.start < moved.start) kept.push({ ...n, duration: moved.start - n.start });
      // the tail is a new note: ids stay unique (selection and the edit helpers match notes by id)
      if (nEnd > vEnd) kept.push({ ...n, id: nextId++, start: vEnd, duration: nEnd - vEnd });
      // fully covered notes are dropped
    }
    kept.push(moved);
    ins = kept.sort((a, b) => a.start - b.start);
  }
  score.notes = ins;
  // The official transfer keeps the bar grid exactly ("Voice transfer changed meter, timing or tempo").
  score.bars = Math.max(input.bars, recomputeBars(score));
  return { score, movedNotes: vocal.length, overlaps };
}

const NEGATIVES = ["no vocals", "no singing", "no choir", "no spoken words"];
const VOCAL_WORD = /\b(vocals?|vocalist|voice|singers?|singing|sung|rap(per|ping)?|choir|duet|a ?cappella)\b/i;
const LANGUAGE_ONLY = /^(japanese|english|chinese|mandarin|cantonese|korean)( lyrics| language)?$/i;

const INSTRUMENTAL_SUFFIX = "（インスト）";
/** The backend's automatic instrumental titles (jobs.rs default_title): "インスト: <style words>" or "インスト <date>". */
const AUTO_INSTRUMENTAL_TITLE = /^インスト[: ]/;

/**
 * Library title of an instrumental version of the song titled `title` ("<title>（インスト）"); undefined for none.
 * A title that is already an instrumental one (marked, or the backend's automatic "インスト: …") stays as is. A
 * long title is shortened so the mark fits the backend's REQUESTED_TITLE_MAX_CHARS (it would cut the mark).
 */
export function instrumentalTitle(title: string | null | undefined): string | undefined {
  const t = (title ?? "").trim();
  if (!t) return undefined;
  if (t.endsWith(INSTRUMENTAL_SUFFIX) || AUTO_INSTRUMENTAL_TITLE.test(t)) return t;
  const chars = Array.from(t); // code points, as the backend counts
  const room = REQUESTED_TITLE_MAX_CHARS - Array.from(INSTRUMENTAL_SUFFIX).length;
  const base = chars.length > room ? chars.slice(0, room).join("").trimEnd() : t;
  return `${base}${INSTRUMENTAL_SUFFIX}`;
}

/**
 * Style prompt for an instrumental render, as the official prepare(): "Instrumental, <style>, no vocals,
 * no singing, no choir, no spoken words." Comma-separated items that describe a voice ("bright female vocal",
 * "rap") or are only a language ("Japanese") are dropped; everything else ("trap", "Japanese koto",
 * "no instrumental break") is kept. Idempotent.
 */
export function instrumentalStyle(style: string): string {
  let bareInstrumental = false;
  const items = style
    .split(",")
    .map((x) => x.trim())
    .filter((x) => {
      const bare = x.replace(/[.\s]+$/, "");
      if (!bare) return false;
      if (NEGATIVES.includes(bare.toLowerCase())) return false; // re-added below, in the official order
      if (/^instrumental$/i.test(bare)) {
        bareInstrumental = true; // becomes the leading "Instrumental"
        return false;
      }
      if (LANGUAGE_ONLY.test(bare)) return false;
      if (VOCAL_WORD.test(bare) && !/^no\b/i.test(bare)) return false;
      return true;
    });
  let s = items.join(", ").trim().replace(/[.,\s]+$/, "");
  if (!s) s = bareInstrumental ? "Instrumental" : "Expressive instrumental music";
  if (!/^instrumental\b/i.test(s)) s = `Instrumental, ${s}`;
  for (const c of NEGATIVES) if (!s.toLowerCase().includes(c)) s += `, ${c}`;
  return `${s}.`;
}

/** Python str.title(): upper-case a cased character that follows an uncased one, lower-case the rest. */
export function pyTitle(s: string): string {
  let out = "";
  let prevCased = false;
  for (const ch of s) {
    const cased = ch.toLowerCase() !== ch.toUpperCase();
    out += cased ? (prevCased ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prevCased = cased;
  }
  return out;
}

/**
 * Lyrics made of the score's section tags, as the official lyric_tags(): every "% label" line becomes
 * "[Label]", joined by blank lines, with a trailing newline. "" when the score has no section labels.
 * Pass the ABC text that is actually submitted.
 */
export function lyricTagsFromAbc(text: string): string {
  const labels = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.startsWith("% "))
    .map((l) => l.slice(2));
  return labels.map((x) => `[${pyTitle(x)}]`).join("\n\n") + (labels.length ? "\n" : "");
}
