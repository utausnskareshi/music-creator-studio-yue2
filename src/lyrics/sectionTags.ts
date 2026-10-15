// Section tags for YuE2 lyrics.
// YuE2 has no fixed tag vocabulary: a `[...]` line is free text that the model reads as a hint about
// the song structure. The official examples and the WildSongBench prompts use everything from
// [Verse 2] and [Hook] to [Guitar Solo], [Fade Out] or [Chorus: Female & Male]. The catalog below
// collects the tags that appear there; anything else can be typed by hand (English works best).

export interface TagOption {
  tag: string;
  /** Japanese label shown next to the tag */
  ja: string;
  /** Gets a running number ([Verse 1], [Verse 2] …) when numbering is on */
  numberable?: boolean;
}

export interface TagGroup {
  label: string;
  tags: TagOption[];
}

/** The seven chips shown by default (the structure of a typical song) */
export const COMMON_TAGS: TagOption[] = [
  { tag: "Intro", ja: "イントロ" },
  { tag: "Verse", ja: "Aメロ", numberable: true },
  { tag: "Pre-Chorus", ja: "Bメロ", numberable: true },
  { tag: "Chorus", ja: "サビ", numberable: true },
  { tag: "Bridge", ja: "Cメロ", numberable: true },
  { tag: "Interlude", ja: "間奏", numberable: true },
  { tag: "Outro", ja: "アウトロ" },
];

/** Additional tags for the picker, grouped by purpose */
export const TAG_GROUPS: TagGroup[] = [
  {
    label: "構成（その他）",
    tags: [
      { tag: "Hook", ja: "フック（決めフレーズ）", numberable: true },
      { tag: "Refrain", ja: "リフレイン", numberable: true },
      { tag: "Post-Chorus", ja: "ポストコーラス（サビの後）", numberable: true },
      { tag: "Final Chorus", ja: "ラストのサビ" },
      { tag: "Pre-Bridge", ja: "Cメロの前" },
      { tag: "Breakdown", ja: "ブレイクダウン（静かに落とす）" },
      { tag: "Build-up", ja: "ビルドアップ（盛り上げ）" },
      { tag: "Drop", ja: "ドロップ" },
      { tag: "Break", ja: "ブレイク" },
      { tag: "End", ja: "エンディング" },
    ],
  },
  {
    label: "演奏のみ（歌なし）",
    tags: [
      { tag: "Instrumental", ja: "インストゥルメンタル" },
      { tag: "Instrumental Intro", ja: "演奏のみのイントロ" },
      { tag: "Instrumental Break", ja: "演奏のみのブレイク" },
      { tag: "Instrumental Interlude", ja: "演奏のみの間奏" },
      { tag: "Instrumental Outro", ja: "演奏のみのアウトロ" },
      { tag: "Solo", ja: "ソロ" },
      { tag: "Guitar Solo", ja: "ギターソロ" },
      { tag: "Piano Solo", ja: "ピアノソロ" },
      { tag: "Saxophone Solo", ja: "サックスソロ" },
      { tag: "Drum Break", ja: "ドラムブレイク" },
    ],
  },
  {
    label: "歌い方",
    tags: [
      { tag: "Rap Verse", ja: "ラップ（Aメロ）", numberable: true },
      { tag: "Rap Bridge", ja: "ラップ（Cメロ）" },
      { tag: "Spoken", ja: "語り" },
      { tag: "Whisper", ja: "ささやき" },
      { tag: "Humming", ja: "ハミング" },
      { tag: "Ad-libs", ja: "アドリブ" },
      { tag: "Harmony", ja: "ハーモニー（重ね歌）" },
      { tag: "Chant", ja: "チャント（掛け声）" },
      { tag: "Vocoder", ja: "ボコーダー" },
    ],
  },
  {
    label: "歌い手の指定（デュエット）",
    tags: [
      { tag: "Verse: Female", ja: "Aメロ（女性）", numberable: true },
      { tag: "Verse: Male", ja: "Aメロ（男性）", numberable: true },
      { tag: "Pre-Chorus: Female & Male", ja: "Bメロ（男女）", numberable: true },
      { tag: "Chorus: Female & Male", ja: "サビ（男女）", numberable: true },
      { tag: "Bridge: Female & Male", ja: "Cメロ（男女）" },
    ],
  },
  {
    label: "演出",
    tags: [
      { tag: "Fade In", ja: "フェードイン" },
      { tag: "Fade Out", ja: "フェードアウト" },
      { tag: "Silence", ja: "無音" },
      { tag: "Abrupt End", ja: "急に終わる" },
      { tag: "Full Band Enters", ja: "バンド全体が入る" },
    ],
  },
];

/** Longest tag in characters (code points). */
export const MAX_TAG_LENGTH = 60;
/**
 * The 任意のタグ field's maxLength, which counts UTF-16 units: a tag of MAX_TAG_LENGTH characters of two units each
 * (emoji) in typed brackets fits; formatTag cuts what is inserted to MAX_TAG_LENGTH characters.
 */
export const TAG_INPUT_MAX_UNITS = (MAX_TAG_LENGTH + 2) * 2;

/** Half of a surrogate pair without its other half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Normalize a hand-typed tag: full-width letters/digits/spaces from a Japanese IME become ASCII,
 * brackets and line breaks are stripped, whitespace collapsed. Empty when unusable. Cut by characters, not
 * UTF-16 units: half an emoji in the lyrics would make every IPC call that carries them fail.
 */
export function formatTag(raw: string): string {
  return Array.from(normalizedTag(raw)).slice(0, MAX_TAG_LENGTH).join("").trim();
}

/** formatTag before its cut to MAX_TAG_LENGTH characters. */
function normalizedTag(raw: string): string {
  let t = raw.normalize("NFKC").replace(LONE_SURROGATE, "").replace(/[\r\n]+/g, " ").trim();
  t = t.replace(/^[\[［]+/, "").replace(/[\]］]+$/, "").trim();
  // (trimmed again: a bracket removed inside may leave a space at either end, "[] Solo", "Solo [")
  return t.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * How many characters of the tag typed in 任意のタグ formatTag will cut off (0 when it fits): the field takes more
 * than MAX_TAG_LENGTH characters (its maxLength counts UTF-16 units, two per emoji), so it says so before the insert.
 */
export function tagOverflow(raw: string): number {
  return Math.max(0, Array.from(normalizedTag(raw)).length - MAX_TAG_LENGTH);
}

/** Split "Verse 2: Female" into its base name, number and suffix (": Female"). */
export function parseTag(tag: string): { base: string; number: number | null; suffix: string } {
  const m = /^(.*?)(?:\s+(\d+))?\s*(:.*)?$/.exec(tag.trim());
  if (!m) return { base: tag.trim(), number: null, suffix: "" };
  return { base: m[1].trim(), number: m[2] ? parseInt(m[2], 10) : null, suffix: m[3] ? `: ${m[3].slice(1).trim()}` : "" };
}

/** "Verse: Female" + 2 → "Verse 2: Female"; "Chorus" + 3 → "Chorus 3" */
export function numberedTag(tag: string, n: number): string {
  const p = parseTag(tag);
  return `${p.base} ${n}${p.suffix}`;
}

/** Next running number for a tag, counting the tag lines already in the lyrics (case-insensitive). */
export function nextNumber(lyrics: string, tag: string): number {
  const base = parseTag(tag).base.toLowerCase();
  let maxNumbered = 0;
  let plain = 0;
  for (const line of lyrics.split("\n")) {
    const m = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (!m) continue;
    const p = parseTag(m[1]);
    if (p.base.toLowerCase() !== base) continue;
    if (p.number !== null) maxNumbered = Math.max(maxNumbered, p.number);
    else plain++;
  }
  return Math.max(maxNumbered, plain) + 1;
}

/**
 * Insert `[tag]` on its own line at `caret` (or at the end when the caret is unknown). A caret inside a line
 * (text on both sides of it) inserts the tag before that line, so a sung line is never cut in two; a caret at
 * the start or end of a line stays where it is.
 * Returns the new text and where the caret should go (the start of the line after the tag).
 */
export function insertTagAt(text: string, caret: number | null, tag: string): { text: string; caret: number } {
  let pos = caret === null || caret < 0 || caret > text.length ? text.length : caret;
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const nl = text.indexOf("\n", pos);
  const lineEnd = nl < 0 ? text.length : nl;
  if (pos > lineStart && pos < lineEnd && text.slice(lineStart, pos).trim() !== "" && text.slice(pos, lineEnd).trim() !== "") pos = lineStart;
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  let prefix = "";
  if (before !== "" && !before.endsWith("\n\n")) prefix = before.endsWith("\n") ? "\n" : "\n\n";
  const line = `[${tag}]`;
  const suffix = after.startsWith("\n") ? "" : "\n";
  return { text: before + prefix + line + suffix + after, caret: before.length + prefix.length + line.length + 1 };
}
