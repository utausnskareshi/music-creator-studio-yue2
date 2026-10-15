// Synced-lyrics line model for the export page: every line remembers where its time came from, so
// placeholder times are never exported as if they were real timing.
import type { AlignedLine, LyricLine } from "../api";

/**
 * Where a line's time came from.
 * - placeholder: made up (i * 4 s) — not real timing
 * - aligned: measured by auto-alignment
 * - interpolated: estimated between aligned / tapped / manual neighbours
 * - tapped: tap-sync while playing
 * - manual: typed in by the user
 */
export type TimeSource = "placeholder" | "aligned" | "interpolated" | "tapped" | "manual";
/**
 * `endMs`: where the aligner heard the line end (aligned lines only). Estimated lines after it start no earlier,
 * so the next line does not show while this one is still sung. Dropped when the time is set by hand.
 */
export type TimedLine = LyricLine & { src: TimeSource; endMs?: number };

/** Spacing of placeholder times. */
export const PLACEHOLDER_STEP_MS = 4000;

/**
 * A trimmed line that is not a sung lyric line: blank, or a section tag ([Verse] …). Must match the
 * MCS_AlignLyrics node (comfy-nodes/mcs_yue2_nodes/nodes.py, `if not line or line.startswith("[")`), whose
 * `index` counts the original lines; plainLyricLines and lyricsLineIndex below depend on the same rule.
 */
export function isNonLyricLine(trimmed: string): boolean {
  return trimmed === "" || trimmed.startsWith("[");
}

/** Non-empty lyric lines without section tags ([Verse] …), trimmed. */
export function plainLyricLines(lyrics: string): string[] {
  return lyrics
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !isNonLyricLine(l));
}

/**
 * The plain lyrics for the export tags (USLT / ©lyr / LYRICS): section tag lines removed, blank lines kept so
 * the stanza spacing stays (unlike plainLyricLines).
 */
export function lyricsForTags(lyrics: string): string {
  return lyrics
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !l.trim().startsWith("["))
    .join("\n")
    .trim();
}

/**
 * Whether the line list no longer matches the lyrics text (the text was edited without rebuilding the lines):
 * the synced lyrics / .lrc would then be written from the old lines while the plain tag has the new text.
 */
export function linesOutOfDate(lyrics: string, lines: { text: string }[]): boolean {
  const plain = plainLyricLines(lyrics);
  return plain.length !== lines.length || plain.some((t, i) => t !== lines[i].text);
}

/**
 * A typed synced-lyrics time in ms, or null when it cannot be read. Accepts m:ss, m:ss.f / .ff / .fff (the
 * fraction is decimal, not centiseconds: 1:02.5 = 62.5 s) and plain seconds (75.5). Full-width digits and
 * "：" / "．" typed with the IME are folded (NFKC). Seconds of 60 or more in m:ss are rejected.
 */
export function parseLrcTime(input: string): number | null {
  const v = input.normalize("NFKC").trim();
  const frac = (f: string | undefined) => (f ? Math.round(Number(`0.${f}`) * 1000) : 0);
  let m = v.match(/^(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (m) {
    const sec = Number(m[2]);
    if (sec >= 60) return null;
    return Number(m[1]) * 60_000 + sec * 1000 + frac(m[3]);
  }
  m = v.match(/^(\d{1,5})(?:[.,](\d{1,3}))?$/);
  if (m) return Number(m[1]) * 1000 + frac(m[2]);
  return null;
}

/** A line's time as its time field shows it: mm:ss.cc (centiseconds). */
export function formatLrcTime(ms: number): string {
  const cs = Math.round(ms / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${c.toString().padStart(2, "0")}`;
}

export type TimeFieldResult = { kind: "none" } | { kind: "invalid" } | { kind: "commit"; ms: number };

/**
 * What leaving a line's time field does with its draft. `shown` is the text the field showed while untouched
 * (at focus, or the time replaced from outside since): a field that was only focused and left, or retyped to
 * that same time, commits nothing, so it never overwrites a time that changed from outside meanwhile.
 */
export function timeFieldCommit(draft: string, shown: string): TimeFieldResult {
  if (draft === shown) return { kind: "none" };
  const ms = parseLrcTime(draft);
  if (ms === null) return { kind: "invalid" };
  const base = parseLrcTime(shown);
  if (base !== null && Math.round(ms / 10) === Math.round(base / 10)) return { kind: "none" };
  return { kind: "commit", ms };
}

/**
 * The draft of a focused time field when the line's time changes from outside (automatic timing finished, the
 * line list was replaced): an untouched draft follows the new time, text the user typed is kept.
 */
export function followTimeDraft(draft: string | null, shown: string, next: string): string | null {
  return draft !== null && draft === shown ? next : draft;
}

/** A tap-sync position that points at an existing line (0 for an empty list). */
export function clampLineIndex(index: number, count: number): number {
  return Math.min(Math.max(0, Math.trunc(index) || 0), Math.max(0, count - 1));
}

export function placeholderLines(plain: string[]): TimedLine[] {
  return plain.map((text, i) => ({ text, timeMs: i * PLACEHOLDER_STEP_MS, src: "placeholder" }));
}

/** Lines whose time is real (measured or set by the user); interpolated/placeholder ones are not. */
function isAnchor(l: TimedLine): boolean {
  return l.src === "aligned" || l.src === "tapped" || l.src === "manual";
}

/**
 * Fill placeholder / interpolated lines linearly between the nearest real neighbours.
 * Lines before the first anchor are spread between 0 and it; lines after the last anchor are spread
 * between it and the song end (`endMs`), or put at the last anchor when the end is unknown.
 * Without any anchor the lines are left unchanged.
 */
export function interpolateMissing(lines: TimedLine[], endMs?: number | null): TimedLine[] {
  const anchors = lines.map((l, i) => (isAnchor(l) ? i : -1)).filter((i) => i >= 0);
  if (anchors.length === 0) return lines;
  const out = lines.map((l) => ({ ...l }));
  for (let i = 0; i < out.length; i++) {
    if (isAnchor(out[i])) continue;
    const prev = [...anchors].reverse().find((a) => a < i);
    const next = anchors.find((a) => a > i);
    let t: number;
    // the previous anchor's sung end, when the aligner reported one below the upper bound `hi`
    const sungEnd = (p: number, hi: number): number | null => {
      const e = out[p].endMs;
      return e !== undefined && e > out[p].timeMs && e < hi ? e : null;
    };
    if (prev !== undefined && next !== undefined) {
      const tp = out[prev].timeMs;
      const tn = out[next].timeMs;
      const lo = sungEnd(prev, tn);
      // from the end of the previous sung line (the first estimated line starts there), else between the anchors
      t = lo !== null ? lo + ((tn - lo) * (i - prev - 1)) / (next - prev - 1) : tp + ((tn - tp) * (i - prev)) / (next - prev);
    } else if (next !== undefined) {
      // Before the first anchor: between 0 (virtual index -1) and the anchor.
      t = (out[next].timeMs * (i + 1)) / (next + 1);
    } else {
      const tp = out[prev!].timeMs;
      const end = endMs != null && endMs > tp ? endMs : tp;
      const lo = sungEnd(prev!, end);
      t = lo !== null ? lo + ((end - lo) * (i - prev! - 1)) / (out.length - prev! - 1) : tp + ((end - tp) * (i - prev!)) / (out.length - prev!);
    }
    out[i] = { ...out[i], timeMs: Math.max(0, Math.round(t)), src: "interpolated" };
  }
  return out;
}

/** Map the i-th non-empty, non-tag lyric line to its original line index (matches the node's `index`). */
export function lyricsLineIndex(lyrics: string, plainIndex: number): number {
  let k = 0;
  const arr = lyrics.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < arr.length; i++) {
    if (isNonLyricLine(arr[i].trim())) continue;
    if (k === plainIndex) return i;
    k++;
  }
  return -1;
}

/** Word score (MMS_FA mean token probability) below which a word was not really heard. */
export const MIN_WORD_SCORE = 0.03;
/** More words per second than anyone sings: the aligner squeezed unsung text into the audio's end. */
export const MAX_WORDS_PER_SECOND = 8;
/**
 * The same ceiling when every word is one syllable: the node aligns Chinese one character (one syllable) at
 * a time, and fast Mandarin pop or rap reaches 8-10 syllables a second.
 */
export const MAX_SYLLABLES_PER_SECOND = 12;

const SINGLE_HANZI = /^\p{Script=Han}$/u;
/** One character: the node splits a Chinese line per character, so a Latin word in it ("baby") is one per letter. */
const SINGLE_CHAR = /^[\p{L}\p{N}]$/u;
/** About one syllable: a Latin word of at most 3 letters ("la", "no", "go") or one kana / Han character. */
const SYLLABLE_WORD = /^(?:\p{Script=Latin}{1,3}|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])$/u;
/** One kana / Han character: one mora or syllable in any line. */
const SINGLE_KANA_HAN = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]$/u;
/** Sung syllables without meaning ("la", "na na", "oh", "yeah", "doo"): chant words in any language. */
const VOCABLE = /^(?:la|na|da|doo|dum|dee|di|ba|pa|sha|ya|yo|hey|ho|ha|oh|ohh|ooh|oo|ah|ahh|eh|ay|uh|mm|hmm|wo|woo|whoa|woah|yeah)$/;

/**
 * A line the node aligned per character (Chinese): every word one character, at least one of them a Han
 * character ("我爱你 baby" comes back as 我 / 爱 / 你 / b / a / b / y).
 */
function isPerCharacterLine(words: { text?: unknown }[]): boolean {
  const texts = words.map((w) => String(w.text ?? "").trim());
  return texts.every((t) => SINGLE_CHAR.test(t)) && texts.some((t) => SINGLE_HANZI.test(t));
}

/**
 * A chant of about one syllable per word, in any language: either only vocables ("la la la", "oh, oh, oh",
 * "yeah yeah yeah") and kana / Han characters, or 4+ short words where one word makes up at least half of the
 * line ("no no no no"). Ordinary lines of short words ("let it go", "you and me all") are not chants and keep
 * the word ceiling; single letters alone are spelled-out text, not a chant.
 */
function isSyllableLine(words: { text?: unknown }[]): boolean {
  const texts = words.map((w) => String(w.text ?? "").replace(/[\p{P}\p{S}]/gu, "").trim().toLowerCase());
  if (texts.length === 0 || texts.every((t) => /^\p{Script=Latin}$/u.test(t))) return false;
  if (texts.every((t) => VOCABLE.test(t) || SINGLE_KANA_HAN.test(t))) return true;
  if (texts.length < 4 || !texts.every((t) => SYLLABLE_WORD.test(t))) return false;
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Math.max(...counts.values()) * 2 >= texts.length;
}

/**
 * Whether an aligned line was really found in the audio. Forced alignment places every word somewhere, so
 * lines that were never sung (a song cut off by the token budget) get crammed into the last second with
 * near-zero scores. A line counts when the median word score is at least MIN_WORD_SCORE and, with 3 or more
 * words, it is not sung faster than MAX_WORDS_PER_SECOND (MAX_SYLLABLES_PER_SECOND when every word is about one
 * syllable: Chinese, one word per character with its Latin letters, and chants like "La la la" or "no no no no"
 * in any language, which the node splits per word; see isSyllableLine). A line without word scores (older node
 * output) counts.
 */
export function isConfidentAlignment(a: AlignedLine): boolean {
  const scores = (a.words ?? []).map((w) => Number(w.score)).filter((s) => Number.isFinite(s)).sort((x, y) => x - y);
  if (scores.length === 0) return true;
  const mid = scores.length >> 1;
  const median = scores.length % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;
  if (median < MIN_WORD_SCORE) return false;
  const words = a.words.length;
  const dur = a.end - a.start;
  const ceiling = isPerCharacterLine(a.words) || isSyllableLine(a.words) ? MAX_SYLLABLES_PER_SECOND : MAX_WORDS_PER_SECOND;
  if (words >= 3 && (!(dur > 0) || words / dur > ceiling)) return false;
  return true;
}

/** The node's entry for the i-th displayed line (by the aligned text's line index, else by text). */
function alignedEntries(plain: string[], alignText: string, aligned: AlignedLine[]): (AlignedLine | undefined)[] {
  const byIndex = new Map(aligned.map((a) => [a.index, a]));
  const byText = new Map(aligned.map((a) => [a.line, a]));
  return plain.map((text, i) => byIndex.get(lyricsLineIndex(alignText, i)) ?? byText.get(text));
}

/**
 * Attach alignment results to the displayed lines. `alignText` is the text that was aligned (the
 * hiragana version when it has the same line structure); a line is 'aligned' only when the node
 * returned a confident entry for it (isConfidentAlignment), the rest is interpolated from the aligned
 * neighbours.
 */
export function applyAlignment(plain: string[], alignText: string, aligned: AlignedLine[], endMs?: number | null): TimedLine[] {
  const entries = alignedEntries(plain, alignText, aligned);
  const lines: TimedLine[] = plain.map((text, i) => {
    const a = entries[i];
    if (!a || !isConfidentAlignment(a)) return { text, timeMs: i * PLACEHOLDER_STEP_MS, src: "placeholder" };
    const line: TimedLine = { text, timeMs: Math.max(0, Math.round(a.start * 1000)), src: "aligned" };
    if (a.end > a.start) line.endMs = Math.round(a.end * 1000);
    return line;
  });
  return interpolateMissing(lines, endMs);
}

/** Lines the node returned but that were not found in the audio (see isConfidentAlignment). */
export function countRejectedAlignments(plain: string[], alignText: string, aligned: AlignedLine[]): number {
  return alignedEntries(plain, alignText, aligned).filter((a) => a && !isConfidentAlignment(a)).length;
}

/**
 * Rebuild the line list from edited lyrics. A line keeps its time only when the same text is found
 * (in order) among the old lines; everything else becomes a placeholder. The new lines are estimated
 * from the kept real times only when the old list had no placeholder (a full alignment); after taps or
 * typed times on the placeholder grid they stay placeholders, so a rebuild does not turn the made-up
 * grid into "estimated" timing that would be exported by default.
 */
export function rebuildLines(plain: string[], old: TimedLine[], endMs?: number | null): TimedLine[] {
  let cursor = 0;
  const lines: TimedLine[] = plain.map((text, i) => {
    for (let j = cursor; j < old.length; j++) {
      if (old[j].text === text && isAnchor(old[j])) {
        cursor = j + 1;
        return { ...old[j] };
      }
    }
    return { text, timeMs: i * PLACEHOLDER_STEP_MS, src: "placeholder" };
  });
  return countPlaceholders(old) === 0 ? interpolateMissing(lines, endMs) : lines;
}

/**
 * Re-estimate the lines that are already 'interpolated' after an anchor changed (tap / typed time).
 * Anchors are never touched, and placeholders stay placeholders: one tap does not turn the whole
 * made-up grid into "estimated" timing that would be exported by default.
 */
export function refreshInterpolated(lines: TimedLine[], endMs?: number | null): TimedLine[] {
  if (!lines.some((l) => l.src === "interpolated")) return lines;
  const re = interpolateMissing(lines, endMs);
  return lines.map((l, i) => (l.src === "interpolated" ? re[i] : l));
}

/** Replace one line's time with a real one (tap / typed) and re-estimate the interpolated lines. */
export function setLineTime(lines: TimedLine[], index: number, timeMs: number, src: "tapped" | "manual", endMs?: number | null): TimedLine[] {
  // a time set by hand has no sung end of the aligner's any more
  const next = lines.map((l, i) => {
    if (i !== index) return l;
    const { endMs: _dropped, ...rest } = l;
    return { ...rest, timeMs: Math.max(0, Math.round(timeMs)), src };
  });
  return refreshInterpolated(next, endMs);
}

/** Lines for a different audio file: the texts are kept, every time becomes a placeholder again. */
export function resetTimings(lines: TimedLine[]): TimedLine[] {
  return placeholderLines(lines.map((l) => l.text));
}

export function countPlaceholders(lines: TimedLine[]): number {
  return lines.filter((l) => l.src === "placeholder").length;
}

/** Synced lyrics are embedded by default only when no line still has a made-up time. */
export function syncDefault(lines: TimedLine[]): boolean {
  return lines.length > 0 && countPlaceholders(lines) === 0;
}

/**
 * Lines to send for SYLT / LRC: lyric order (no sorting), times made non-decreasing by clamping each
 * line to at least the previous one, `src` stripped. `clamped` counts the lines that were moved.
 */
export function finalizeSynced(lines: TimedLine[]): { synced: LyricLine[]; clamped: number } {
  let prev = 0;
  let clamped = 0;
  const synced = lines.map((l) => {
    let t = Math.max(0, Math.round(l.timeMs));
    if (t < prev) {
      t = prev;
      clamped++;
    }
    prev = t;
    return { timeMs: t, text: l.text };
  });
  return { synced, clamped };
}

/** How to get the optional uroman romanizer (setup component "uroman_pip"). */
export const UROMAN_HINT = "「設定 → セットアップをやり直す」で「多言語ローマ字化（uroman）」を導入すると対応できます";

/**
 * Whether `text` (with letters) is in a script only uroman romanizes. The node reads Latin letters as they
 * are, kana / kanji for ja (pykakasi) and hanzi for zh (pypinyin); Hangul, Cyrillic, Greek, Arabic, Thai …
 * (and the language "other" unless the text is Latin) need the optional uroman component.
 */
export function needsUroman(language: string, text: string): boolean {
  if (!/\p{L}/u.test(text) || /[A-Za-z]/.test(text)) return false;
  if (language === "ja") return !/[\u3040-\u30ff\u3400-\u9fff]/.test(text);
  if (language === "zh") return !/[\u3400-\u9fff]/.test(text);
  return true;
}

/** Displayed lines the node returned nothing for that hold text in a script only uroman romanizes. */
export function countUnromanizedLines(plain: string[], alignText: string, aligned: AlignedLine[], language: string): number {
  const entries = alignedEntries(plain, alignText, aligned);
  return plain.filter((text, i) => !entries[i] && needsUroman(language, text)).length;
}

/**
 * Message for an empty alignment result. MMS_FA only knows Latin letters: a script without a romanizer
 * (see needsUroman) cannot be aligned until uroman is installed (`uromanInstalled`: null when unknown).
 * For ja/zh the cause is usually elsewhere (romanizer missing, no audible vocals).
 */
export function emptyAlignmentMessage(language: string, text: string, uromanInstalled: boolean | null = null): string {
  const body = plainLyricLines(text).join("");
  const romanizable =
    language === "ja" ? /[\u3040-\u30ff\u3400-\u9fff]/.test(body) : language === "zh" ? /[\u3400-\u9fff]/.test(body) : false;
  if (needsUroman(language, body)) {
    if (uromanInstalled) return "整列結果が空でした（ボーカル分離の結果を確認してください）";
    return `この文字体系は自動整列に未対応です。${UROMAN_HINT}（それまではタップ同期を使ってください）`;
  }
  if (romanizable) return "整列結果が空でした（ローマ字化ライブラリ（pykakasi / pypinyin）の導入状況と、ボーカル分離の結果を確認してください）";
  return "整列結果が空でした";
}

/** `peak` from the song.json `info` (MCS_AudioInfo JSON string, or already an object). */
export function peakFromSongJson(json: string): number | null {
  try {
    const meta = JSON.parse(json);
    const info = typeof meta?.info === "string" ? JSON.parse(meta.info) : meta?.info;
    const peak = Number(info?.peak);
    return Number.isFinite(peak) ? peak : null;
  } catch {
    return null;
  }
}
