// Per-section fit of the lyrics to the score: morae of the sung (kana) text for Japanese, estimated syllables
// for English, one per Han character for Chinese, against the Vocal note onsets of the matching score section.
// Advisory only (the official editing notes ask to keep syllables in line with each section's Vocal notes,
// in any language); nothing is blocked on it.
import { sectionOnsetCounts, sungLyricBlockTexts } from "../abc/consistency";
import type { Score } from "../abc/model";
import { HAN } from "./hiragana";

/** Small kana that merge with the previous mora (きゃ = 1 mora). っ / ッ, ー and ん / ン are morae of their own. */
const SMALL = new Set([..."ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮ"]);

/** Morae of the kana in `text`. Kanji, Latin letters, digits and punctuation are not counted. */
export function countMorae(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const kana = (c >= 0x3041 && c <= 0x3096) || (c >= 0x30a1 && c <= 0x30fa) || ch === "ー";
    if (kana && !SMALL.has(ch)) n++;
  }
  return n;
}

/**
 * Estimated English syllables of `text`: vowel groups per word (a word-initial "y" before a vowel is a
 * consonant: "yes" = 1), minus a final silent single "e" ("make" = 1) except in consonant + "le" ("table" = 2)
 * or when it is the only vowel group ("the" = 1); at least 1 per word. Apostrophes (' or ’) stay inside the
 * word ("don't" = "don’t" = 1), hyphenated words are split, [tags] and digits are ignored. An estimate: "-ed" / "-es"
 * endings and diphthongs are sometimes off by one.
 */
export function countSyllablesEn(text: string): number {
  const words = text
    .toLowerCase()
    // typographic apostrophes (’ ‘ ʼ ＇ and the backtick) as the ASCII one, so "don’t" stays one word
    .replace(/[‘’ʼ＇`]/g, "'")
    .replace(/\[[^\]\n]*\]/g, " ")
    .replace(/[0-9]/g, " ")
    .split(/[^a-z']+/)
    .map((w) => w.replace(/'/g, ""))
    .filter((w) => /[a-z]/.test(w));
  let n = 0;
  for (const w of words) {
    const body = /^y[aeiou]/.test(w) ? w.slice(1) : w;
    const groups = body.match(/[aeiouy]+/g) ?? [];
    let count = groups.length;
    const silentE = count > 1 && groups[groups.length - 1] === "e" && w.endsWith("e") && !/[^aeiouy]le$/.test(w);
    if (silentE) count--;
    n += Math.max(1, count);
  }
  return n;
}

/**
 * Sung Japanese (the kana text): the morae of the kana plus the estimated syllables of Latin words ("Stay with me
 * きみと" = 3 + 3). Full-width letters from a Japanese IME count like ASCII ones (NFKC).
 */
export function countSungJa(line: string): number {
  const t = line.normalize("NFKC");
  return countMorae(t) + countSyllablesEn(t);
}

const HAN_CHAR = new RegExp(`[${HAN}]`, "gu");

/** Chinese: one syllable per Han character (supplementary-plane characters included). */
export function countSyllablesZh(text: string): number {
  return (text.match(HAN_CHAR) ?? []).length;
}

/** Ratio (morae / onsets) outside this range is marked. */
export const FIT_LOW = 0.6;
export const FIT_HIGH = 1.3;

export interface SectionFitRow {
  /** score section name ("verse") */
  name: string;
  /** lyric tag of the paired block, when paired */
  tag: string | null;
  /** Vocal onsets, pickups from a preceding unsung section included */
  onsets: number;
  /** morae (or syllables, see sectionFit's `count`) of the paired lyric block; null = no text / not paired */
  morae: number | null;
  flag: "low" | "high" | null;
}

export interface SectionFit {
  rows: SectionFitRow[];
  /** sung score sections and sung lyric blocks could be paired one to one */
  paired: boolean;
}

/**
 * Sung score sections with their Vocal onsets, paired in order with the sung lyric blocks of `sungText`
 * (the text actually sent: the kana text for Japanese). `sungText` null (no kana version) or a different
 * section count gives rows without counts. `count` counts one line (countMorae; countSyllablesEn for English).
 */
export function sectionFit(score: Score, sungText: string | null, count: (line: string) => number = countMorae): SectionFit {
  const sung = sectionOnsetCounts(score).filter((s) => s.sung);
  const blocks = sungText ? sungLyricBlockTexts(sungText) : [];
  const paired = sungText !== null && blocks.length === sung.length && sung.length > 0;
  const rows = sung.map((s, i): SectionFitRow => {
    if (!paired) return { name: s.name, tag: null, onsets: s.withPickup, morae: null, flag: null };
    const morae = blocks[i].lines.reduce((n, l) => n + count(l), 0);
    const ratio = s.withPickup > 0 ? morae / s.withPickup : Infinity;
    return { name: s.name, tag: blocks[i].tag, onsets: s.withPickup, morae, flag: ratio < FIT_LOW ? "low" : ratio > FIT_HIGH ? "high" : null };
  });
  return { rows, paired };
}
