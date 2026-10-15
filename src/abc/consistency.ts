// Advisory check that the score's "% section" comments and the lyrics' [Tag] blocks still describe the same
// form (official docs/editing.md: "For section deletion, duplication, or reordering, update both the score
// and corresponding lyric sections."). It never throws and never changes anything: callers show the strings
// as an info notice. The official tools do not enforce this, so the wording stays soft.
import { barStartTick, type Score } from "./model";

/** A section with fewer Vocal onsets than this is not "sung" (e.g. pickup notes at the end of an intro). */
export const SUNG_ONSET_THRESHOLD = 4;

export interface SectionOnsets {
  name: string;
  /** zero-based bar where the section starts */
  bar: number;
  /** Vocal note onsets inside the section */
  onsets: number;
  /** at least SUNG_ONSET_THRESHOLD onsets */
  sung: boolean;
  /** onsets including pickup notes carried over from a preceding section that is not sung */
  withPickup: number;
}

/** Vocal onsets per score section, in order. Pickups of an unsung section are carried into the next sung one. */
export function sectionOnsetCounts(score: Score): SectionOnsets[] {
  const secs = score.sections.slice().sort((a, b) => a.bar - b.bar);
  const vocal = score.notes.filter((n) => n.voice === "Vocal");
  const out: SectionOnsets[] = secs.map((s, i) => {
    const from = barStartTick(score, s.bar);
    const to = i + 1 < secs.length ? barStartTick(score, secs[i + 1].bar) : Infinity;
    const onsets = vocal.filter((n) => n.start >= from && n.start < to).length;
    return { name: s.name, bar: s.bar, onsets, sung: onsets >= SUNG_ONSET_THRESHOLD, withPickup: onsets };
  });
  let carry = 0;
  for (const s of out) {
    if (!s.sung) {
      carry += s.onsets;
      s.withPickup = 0;
      continue;
    }
    s.withPickup = s.onsets + carry;
    carry = 0;
  }
  return out;
}

// Tags that mark a part without singing. Intro / Outro are not in the list: they count when they carry lyrics.
const INSTRUMENTAL_TAG = /^(instrumental\b.*|.*\bsolo|interlude|break|breakdown|drum break|drop|build-?up|fade (in|out)|silence|abrupt end|full band enters)$/i;

export interface LyricBlock {
  tag: string | null;
  lines: number;
}

export interface LyricBlockText {
  tag: string | null;
  /** the sung lines of the block (trimmed, non-empty) */
  lines: string[];
}

/** Lyric blocks that contain sung text, with their lines: a [Tag] line starts a block; empty and instrumental blocks are left out. */
export function sungLyricBlockTexts(lyrics: string): LyricBlockText[] {
  const blocks: LyricBlockText[] = [];
  let cur: LyricBlockText = { tag: null, lines: [] };
  const flush = () => {
    if (cur.lines.length > 0 && !(cur.tag && INSTRUMENTAL_TAG.test(baseName(cur.tag)))) blocks.push(cur);
  };
  for (const raw of lyrics.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[([^\]]*)\]$/.exec(line);
    if (m) {
      flush();
      cur = { tag: m[1].trim(), lines: [] };
    } else cur.lines.push(line);
  }
  flush();
  return blocks;
}

/** Lyric blocks that contain sung text, in order: a [Tag] line starts a block; empty and instrumental blocks are left out. */
export function sungLyricBlocks(lyrics: string): LyricBlock[] {
  return sungLyricBlockTexts(lyrics).map((b) => ({ tag: b.tag, lines: b.lines.length }));
}

/** "Verse 2: Female" -> "verse"; "Pre-Chorus" -> "pre-chorus"; "% chorus2" -> "chorus" */
function baseName(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/:.*$/, "")
    .replace(/[0-9]+/g, "")
    .replace(/[^a-z぀-ヿ一-鿿-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^pre ?chorus$/, "pre-chorus");
}

/** Start of the compareSections hint for lyrics without any section tag (advisory; pages show it as a note). */
export const UNTAGGED_LYRICS_HINT = "歌詞にセクションタグ（[Verse] / [Chorus] など）がありません";

/** true for the untagged-lyrics hint of compareSections (not a mismatch the user made). */
export function isUntaggedLyricsHint(message: string): boolean {
  return message.startsWith(UNTAGGED_LYRICS_HINT);
}

const KNOWN = new Set(["intro", "verse", "pre-chorus", "chorus", "bridge", "outro", "hook", "refrain", "post-chorus"]);

/**
 * Compare the sung score sections with the sung lyric blocks. Returns Japanese warnings (empty = consistent
 * or nothing to compare). Mainly the number of sections; names only as a soft hint when both sides use
 * common section names. Never throws.
 */
export function compareSections(score: Score, lyricsText: string): string[] {
  try {
    if (!lyricsText.trim() || score.sections.length === 0) return [];
    const blocks = sungLyricBlocks(lyricsText);
    if (blocks.length === 0) return [];
    const sung = sectionOnsetCounts(score).filter((s) => s.sung);
    const scoreNames = sung.map((s) => s.name);
    const lyricNames = blocks.map((b) => (b.tag === null ? "（タグなし）" : `[${b.tag}]`));
    // No tag at all: the lyrics cannot be paired with the sections, which is not a section the user added or
    // deleted. Official: write the lyrics with section tags such as [Verse] and [Chorus] (docs/generation.md).
    // A score with no sung section at all (an instrumental) has nothing to sing them on: that stays a mismatch.
    if (sung.length > 0 && blocks.every((b) => b.tag === null)) {
      return sung.length > 1
        ? [
            `${UNTAGGED_LYRICS_HINT}（公式: 歌詞はセクションタグ付きで書く）。譜面の歌うセクション（${scoreNames.join(" → ")}）に合わせて各ブロックの先頭にタグを付けると、譜面と歌詞の対応が取りやすくなります。`,
          ]
        : [];
    }
    if (sung.length !== blocks.length) {
      return [
        `譜面の歌うセクション（${sung.length}: ${scoreNames.join(" → ") || "なし"}）と歌詞のセクション（${blocks.length}: ${lyricNames.join(" → ")}）の数が一致しません。セクションを追加・削除・複製したときは譜面と歌詞の両方を直してください。`,
      ];
    }
    const a = sung.map((s) => baseName(s.name));
    const b = blocks.map((x) => (x.tag === null ? "" : baseName(x.tag)));
    const comparable = a.every((x) => KNOWN.has(x)) && b.every((x) => KNOWN.has(x));
    if (comparable && a.some((x, i) => x !== b[i])) {
      return [`（参考）セクション名の並びが譜面（${scoreNames.join(" → ")}）と歌詞（${lyricNames.join(" → ")}）で異なります。順序を入れ替えた場合は両方を揃えてください。`];
    }
    return [];
  } catch {
    return [];
  }
}
