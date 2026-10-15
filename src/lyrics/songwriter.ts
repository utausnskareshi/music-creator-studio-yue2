// AI songwriting: a Japanese brief -> lyrics (with section tags) + style prompt + chip selections.
import { api } from "../api";
import { GROUPS, emptySelection, type StyleSelection } from "../components/StyleBuilder";
import { REQUESTED_TITLE_MAX_CHARS } from "../config/rules";
import type { LyricsLanguage } from "./hiragana";
import { BPM_MAX, BPM_MIN, styleBpm } from "./styleBpm";

export type SongLength = "short" | "standard" | "long";

export interface SongDraft {
  title: string;
  lyrics: string;
  style: string;
  selection: StyleSelection;
  explanation: string;
  /** of the whole request, a retry included */
  seconds: number;
  provider: string;
  /** 1, or 2 when the draft came from the second try (the first reply ran to the length limit) */
  attempts: number;
}

const LANG_NAME: Record<LyricsLanguage, string> = { ja: "日本語", en: "英語", zh: "中国語（普通話）", other: "曲のイメージに書かれた言語" };

/** The language chip of the lyrics language (the vocabulary has none for "other"). */
const LANG_CHIP: Record<LyricsLanguage, string | null> = { ja: "Japanese", en: "English", zh: "Mandarin", other: null };

const LENGTH_NAME: Record<SongLength, string> = { short: "短め（約 1 分）", standard: "標準（約 3 分）", long: "長め（約 4 分）" };

const LENGTH_SPEC: Record<SongLength, string> = {
  short: "[Verse] 4 行 → [Chorus] 4 行（合計 8〜10 行、約 1 分）",
  standard: "[Verse] 4 行 → [Pre-Chorus] 2 行 → [Chorus] 4 行 → [Verse] 4 行 → [Pre-Chorus] 2 行 → [Chorus] 4 行 → [Bridge] 2〜4 行 → [Chorus] 4 行（合計 24〜30 行、約 2 分半〜3 分）",
  long: "[Intro]（タグのみ、歌詞なし）→ [Verse] 4 行 → [Pre-Chorus] 2 行 → [Chorus] 4 行 → [Verse] 4 行 → [Pre-Chorus] 2 行 → [Chorus] 4 行 → [Bridge] 4 行 → [Chorus] 4 行 → [Chorus] 4 行（歌詞を少し変える）→ [Outro] 2 行（合計 34〜40 行、約 4 分）",
};

/** Most chips per group a draft may select (the schema's maxItems, also enforced when parsing). */
const MAX_ITEMS = { genres: 3, voice: 3, instruments: 5, moods: 3 };

/** Chip values of a group. The vocal group has no instrumental value: a draft always has a sung part (an
 * instrumental goes through the compose page's instrumental workflow, not a style word). */
function enumOf(key: string): string[] {
  return GROUPS.find((g) => g.key === key)!.items.map((i) => i.en).filter((v) => !/\binstrumental\b/i.test(v));
}

/** The draft's JSON schema; with the lyrics language (not "other") its language chip is that one value. */
export function songSchema(language?: LyricsLanguage) {
  const chip = language ? LANG_CHIP[language] : null;
  return {
    type: "object",
    properties: {
      // (the limit as words, not maxLength: the OpenAI-compatible path sends the schema in strict mode)
      title: { type: "string", description: `曲のタイトル案（歌詞と同じ言語、1 行、${REQUESTED_TITLE_MAX_CHARS} 文字以内）` },
      lyrics: { type: "string", description: "セクションタグ付きの歌詞全文" },
      style: { type: "string", description: "YuE2 用の英語スタイルプロンプト（カンマ区切り、BPM で終える）" },
      selections: {
        type: "object",
        properties: {
          language: { type: "string", enum: chip ? [chip] : enumOf("lang") },
          genres: { type: "array", items: { type: "string", enum: enumOf("genre") }, minItems: 1, maxItems: MAX_ITEMS.genres },
          vocal: { type: "string", enum: enumOf("vocal") },
          voice: { type: "array", items: { type: "string", enum: enumOf("voice") }, maxItems: MAX_ITEMS.voice },
          instruments: { type: "array", items: { type: "string", enum: enumOf("inst") }, minItems: 1, maxItems: MAX_ITEMS.instruments },
          moods: { type: "array", items: { type: "string", enum: enumOf("mood") }, minItems: 1, maxItems: MAX_ITEMS.moods },
          bpm: { type: "integer", minimum: BPM_MIN, maximum: BPM_MAX },
        },
        required: ["language", "genres", "vocal", "voice", "instruments", "moods", "bpm"],
        additionalProperties: false,
      },
      explanation: { type: "string", description: "曲の狙いとスタイル選択の理由（日本語で 2〜3 文）" },
    },
    required: ["title", "lyrics", "style", "selections", "explanation"],
    additionalProperties: false,
  };
}

export function systemPrompt(language: LyricsLanguage, length: SongLength): string {
  return `あなたはプロの作詞家兼音楽プロデューサーです。ユーザーが日本語で書いた「曲のイメージ」から、AI 音楽生成モデル YuE2 に入力する歌詞とスタイルプロンプトを作ります。指定の JSON オブジェクトだけを返してください。

## 歌詞の規則
- 言語: ${LANG_NAME[language]}。
- セクションは英語のタグを行頭に置き（基本は [Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Interlude] [Outro]。曲想に合えば [Hook] [Instrumental] [Guitar Solo] [Rap Verse] [Fade Out] などの自由なタグや、[Verse 1] [Verse 2] の番号付きも可）、セクションの間は空行で区切る。タグの行には歌詞を書かない。
- 構成（長さ: ${LENGTH_NAME[length]}）: ${LENGTH_SPEC[length]}
- 構成のセクションの数・順番・各セクションの行数を必ず守る。構成にないセクションを足したり、繰り返しを増やしたりしない（タグの名前は曲想に合わせて変えてよい）。曲の長さはセクションの数と行数で決まるため、守らないと指定した長さにならない。
- 1 行は歌いやすい長さ（日本語なら 7〜12 モーラ、英語なら 5〜9 語）。行末の韻や反復（リフレイン）を活かし、サビは同じ歌詞を繰り返してよい。
- 具体的な情景・感情・比喩を使い、説明的にならない。記号・絵文字・括弧・コーラス表記（例: (Oh)）は使わない。
- 既存楽曲の歌詞の引用・模倣は禁止。人名・商品名は避ける。

## スタイルプロンプトの規則
- 英語のカンマ区切りで、言語 → ジャンル → ボーカル → 楽器 → 雰囲気 → BPM の順に並べる。例: "Japanese, city pop, warm female vocal, Rhodes piano, slap bass, light drums, nostalgic, 104 BPM"
- ${LANG_CHIP[language] ? `style の最初の語（言語）と selections.language は "${LANG_CHIP[language]}" にする。` : "style の最初の語は歌詞の言語の英語名（例: Spanish）にする。selections.language は、歌詞の言語が語彙にあればその語にする（なければ使われないため、どれを選んでもよい）。"}
- selections には語彙リストの中から曲に合うものだけを選ぶ。genres・voice・moods は各 ${MAX_ITEMS.genres} 個まで、instruments は ${MAX_ITEMS.instruments} 個まで。bpm は ${BPM_MIN}〜${BPM_MAX} の整数で、style の BPM と同じ値にする。style の文章には selections の語に加えて、質感や情景を表す語を 2〜4 個足してよい。
- 必ずボーカル（歌）のある曲にする。ユーザーがインストゥルメンタル（歌なし）を求めた場合も歌詞とボーカルを書き、explanation で「歌なしにするには作曲画面の『インストゥルメンタル版を生成』を使ってください」と伝える。`;
}

function stripFences(s: string): string {
  const t = s.trim();
  return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

/** The JSON object in the reply: from its first "{" to its last "}" (text before or after it is skipped). */
function jsonObjectText(s: string): string {
  const t = stripFences(s);
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

const UNREADABLE = "AI の応答を JSON として読めませんでした（応答が途中で切れた可能性があります）。もう一度試すか、曲の長さを短くしてください。";

/** Parse the model output into a draft; throws on malformed content (a Japanese message, the parser error as `cause`). */
export function parseSongDraft(content: string, meta: { seconds: number; provider: string; attempts?: number; language?: LyricsLanguage }): SongDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonObjectText(content));
  } catch (e) {
    throw Object.assign(new Error(UNREADABLE), { cause: e });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(UNREADABLE);
  const obj = parsed as Record<string, unknown>;
  const s = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : "");
  const lyrics = s("lyrics").replace(/\r\n?/g, "\n").trim();
  if (!lyrics) throw new Error("歌詞が空でした");
  const sel = (typeof obj.selections === "object" && obj.selections !== null ? obj.selections : {}) as Record<string, unknown>;
  // known values only, each once, at most `max` (the schema's maxItems; a model may ignore it)
  const arr = (k: string, allowed: string[], max: number) =>
    Array.isArray(sel[k]) ? [...new Set((sel[k] as unknown[]).filter((x): x is string => typeof x === "string" && allowed.includes(x)))].slice(0, max) : [];
  const one = (k: string, allowed: string[]) => (typeof sel[k] === "string" && allowed.includes(sel[k] as string) ? [sel[k] as string] : []);
  const modelBpm = typeof sel.bpm === "number" && Number.isFinite(sel.bpm) && sel.bpm > 0 ? Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(sel.bpm))) : 0;
  // The lyrics are written in the requested language, so its chip is that one; the model's choice counts only without
  // a request. For "other" the vocabulary may have the language (Korean) or not (Spanish, where the model can only
  // pick a wrong chip): its chip is kept only when the style text starts with that language.
  const requestedChip = meta.language ? LANG_CHIP[meta.language] : undefined;
  const modelChip = one("language", enumOf("lang"));
  const styleLang = s("style").split(",")[0].trim().toLowerCase();
  const selection: StyleSelection = {
    groups: {
      lang: requestedChip === undefined ? modelChip : requestedChip ? [requestedChip] : modelChip.filter((c) => c.toLowerCase() === styleLang),
      genre: arr("genres", enumOf("genre"), MAX_ITEMS.genres),
      vocal: one("vocal", enumOf("vocal")),
      voice: arr("voice", enumOf("voice"), MAX_ITEMS.voice),
      inst: arr("instruments", enumOf("inst"), MAX_ITEMS.instruments),
      mood: arr("moods", enumOf("mood"), MAX_ITEMS.moods),
    },
    bpm: modelBpm,
  };
  let style = s("style").trim();
  if (!style) {
    // Fall back to the chips when the model forgot the prompt text.
    const parts = [...selection.groups.lang, ...selection.groups.genre, ...selection.groups.vocal, ...selection.groups.voice, ...selection.groups.inst, ...selection.groups.mood];
    if (selection.bpm) parts.push(`${selection.bpm} BPM`);
    style = parts.join(", ");
  }
  // The tempo the prompt states is the one sent (and synced with a score's Q:), so the chips follow it.
  selection.bpm = styleBpm(style) ?? modelBpm;
  // One line of at most REQUESTED_TITLE_MAX_CHARS characters (code points), as the backend keeps it: a run of
  // control characters (line breaks, tabs) with the ASCII blanks around it becomes one space; other spaces
  // (a full-width U+3000 included) stay.
  const title = Array.from(s("title").replace(/[ \t]*\p{Cc}+[ \t]*/gu, " ").trim()).slice(0, REQUESTED_TITLE_MAX_CHARS).join("").trimEnd();
  return { title, lyrics, style, selection: selection.groups.lang.length || selection.groups.genre.length ? selection : emptySelection(), explanation: s("explanation").trim(), seconds: meta.seconds, provider: meta.provider, attempts: meta.attempts ?? 1 };
}

/** The user message of a draft request: the brief, and the length again (the model follows it more closely there). */
export function userMessage(brief: string, length: SongLength): string {
  return `曲のイメージ:\n${brief.trim()}\n\n長さ: ${LENGTH_NAME[length]}。構成: ${LENGTH_SPEC[length]}`;
}

/** Ask the configured LLM for a song draft (`requestId`: api.llmCancel ends it). */
export async function writeSong(brief: string, language: LyricsLanguage, length: SongLength, requestId?: string): Promise<SongDraft> {
  const r = await api.llmComplete(systemPrompt(language, length), userMessage(brief, length), songSchema(language), requestId ?? null);
  return parseSongDraft(r.content, { seconds: r.seconds, provider: r.provider, attempts: r.attempts, language });
}
