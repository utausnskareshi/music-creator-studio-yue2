// Pure rules shared by the compose, cover and AI-edit pages: the music token budget (max_duration), seeds,
// a lenient reading of ABC text that the strict parser rejects, instrumental lyrics and the parameters stored
// with a song. Nothing here touches React state, so it is unit-tested directly.
import type { ChatMessage, GenerateParams } from "../api";
import { barStartTick, hasTimelineChanges, recomputeBars, ticksToSeconds, type Score } from "../abc/model";
import { parseAbc } from "../abc/parse";
import { validateNativeAbc } from "../abc/native";
import { pyTitle } from "../abc/instrumental";
import { COMMON_TAGS, TAG_GROUPS } from "../lyrics/sectionTags";
import { MAX_DURATION_CAP, normalizeDurations } from "../config/rules";
import { styleBpm as styleBpmOf, styleBpmDiffers, withStyleBpm } from "../lyrics/styleBpm";

/** Official YuE2GenerateMusic default (360 s = 9000 tokens, protocol.py max_tokens); the model ends earlier at its end token. */
export const OFFICIAL_MAX_DURATION = 360;
/** Native YuE2GenerateMusic max_duration maximum (ComfyUI v0.37.0); defined in config/rules.ts. */
export { MAX_DURATION_CAP };

/** Largest seed the app accepts: a JS-safe integer inside the official [0, 2^63) range and ComfyUI's u64. */
export const MAX_SEED = Number.MAX_SAFE_INTEGER;

/** A seed from user input or a stored song: an integer in [0, 2^53-1]; anything unreadable becomes 0. */
export function clampSeed(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), MAX_SEED);
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * The configured limits, clamped defensively with the settings page's rule (normalizeDurations, the same
 * bounds as AppConfig::normalize); a missing config falls back to 900 / 360.
 */
export function durationLimits(config: { maxDurationLimit?: number; defaultMaxDuration?: number } | null | undefined): { limit: number; defaultMax: number } {
  const num = (v: number | undefined) => (v === undefined || v === null ? NaN : Number(v));
  const n = normalizeDurations(num(config?.maxDurationLimit), num(config?.defaultMaxDuration));
  return { limit: n.maxDurationLimit, defaultMax: n.defaultMaxDuration };
}

/** Provenance of an instrumental render, copied into GenerateParams only when set. */
export interface InstrumentalProvenance {
  sourceAbc?: string;
  instrumentalTransfer?: GenerateParams["instrumentalTransfer"];
  plan?: GenerateParams["plan"];
}

export function provenanceParams(p: InstrumentalProvenance): Partial<Pick<GenerateParams, "sourceAbc" | "instrumentalTransfer" | "plan">> {
  return {
    ...(p.sourceAbc ? { sourceAbc: p.sourceAbc } : {}),
    ...(p.instrumentalTransfer ? { instrumentalTransfer: p.instrumentalTransfer } : {}),
    ...(p.plan ? { plan: p.plan } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// ABC summary (strict parse first, lenient header/barline reading when the parser rejects the text)

export interface AbcSummary {
  bars: number;
  /** nominal length: bars × bar length at the Q: tempo (meter changes honoured) */
  seconds: number;
  bpm: number;
  key: string;
  meter: [number, number];
  /** chord symbols present */
  hasChords: boolean;
  /** key or meter changes after the header (only shown as a badge, 転調/拍子変更あり; such scores are edited and written back in the official group form like any other) */
  timelineChanges: boolean;
  /** null when parseAbc accepted the text; otherwise its message (the numbers then come from the lenient reader) */
  parseError: string | null;
}

/** Nominal length of a parsed score in seconds (trailing silent bars included). */
export function scoreSeconds(score: Score): number {
  const bars = Math.max(score.bars || 0, recomputeBars(score));
  return ticksToSeconds(barStartTick(score, bars), score.bpm);
}

const FIELD_LINE = /^[A-Za-z]:/;

/** Chord symbols in the music lines ("N" = no chord does not count). Used when the strict parser rejects the text. */
export function rawHasChords(text: string): boolean {
  let inBody = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!inBody) {
      if (line.startsWith("K:")) inBody = true;
      continue;
    }
    if (!line || line.startsWith("%") || FIELD_LINE.test(line)) continue;
    // quoted strings in pairs: in "N"z32|"N" the text between two markers is no chord
    for (const q of line.matchAll(/"([^"\n]*)"/g)) if (q[1].trim() && q[1].trim() !== "N") return true;
  }
  return false;
}

function parseMeter(v: string): [number, number] | null {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(v);
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return [Number(m[1]), Number(m[2])];
  if (v.trim() === "C") return [4, 4];
  if (v.trim() === "C|") return [2, 2];
  return null;
}

/**
 * Q:1/4=96 -> 96; Q:3/8=60 -> 90 (quarter notes per minute); Q:120 -> 120. Read as parseAbc reads it: the n/d=bpm
 * part anywhere in the value (Q:"Allegro" 1/4=140), else the first number (Q:C=140).
 */
function parseTempo(v: string): number | null {
  const beat = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)/.exec(v);
  if (beat) {
    const value = Number(beat[3]);
    const den = Number(beat[2]);
    return value > 0 && den > 0 ? (value * Number(beat[1]) * 4) / den : null;
  }
  const m = /(\d+(?:\.\d+)?)/.exec(v);
  const value = m ? Number(m[1]) : NaN;
  return value > 0 ? value : null;
}

/**
 * Header fields and a barline count, without the strict parser: M:/Q:/K: from the header, body M: lines per
 * voice, one bar per run of "|". Good enough for an info line and a duration budget.
 */
export function lenientAbcSummary(text: string): AbcSummary | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let meter: [number, number] = [4, 4];
  let bpm = 120;
  let key = "?";
  let inBody = false;
  let voice = "";
  const perVoice = new Map<string, { bars: number; beats: number; meter: [number, number] }>();
  let changes = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("%")) continue;
    if (!inBody) {
      if (line.startsWith("M:")) meter = parseMeter(line.slice(2)) ?? meter;
      else if (line.startsWith("Q:")) bpm = parseTempo(line.slice(2)) ?? bpm;
      else if (line.startsWith("K:")) {
        key = line.slice(2).trim() || key;
        inBody = true;
      }
      continue;
    }
    if (line.startsWith("V:")) {
      voice = line.slice(2).trim().split(/\s+/)[0] ?? "";
      if (!perVoice.has(voice)) perVoice.set(voice, { bars: 0, beats: 0, meter: [meter[0], meter[1]] });
      continue;
    }
    const st = perVoice.get(voice) ?? { bars: 0, beats: 0, meter: [meter[0], meter[1]] as [number, number] };
    perVoice.set(voice, st);
    if (line.startsWith("M:")) {
      st.meter = parseMeter(line.slice(2)) ?? st.meter;
      changes = true;
      continue;
    }
    if (line.startsWith("K:")) {
      changes = true;
      continue;
    }
    if (FIELD_LINE.test(line)) continue;
    if (/\[K:/.test(line)) changes = true;
    const music = line.replace(/"[^"\n]*"/g, "");
    // one bar per barline; a multi-bar rest "Z4|" stands for four
    const n = (music.match(/\|+\]?/g) ?? []).length + [...music.matchAll(/Z(\d+)/g)].reduce((s, m) => s + Math.max(0, Number(m[1]) - 1), 0);
    st.bars += n;
    st.beats += n * ((st.meter[0] * 4) / st.meter[1]);
  }
  let best = { bars: 0, beats: 0 };
  for (const v of perVoice.values()) if (v.beats > best.beats) best = v;
  if (!inBody && best.bars === 0) return null;
  return {
    bars: best.bars,
    seconds: (best.beats * 60) / bpm,
    bpm,
    key,
    meter,
    hasChords: rawHasChords(text),
    timelineChanges: changes,
    parseError: null,
  };
}

/**
 * The tempo the score really states: the header Q: (before the first K:), read as summarizeAbc reads it.
 * Null when the header has no Q: - the parsers then assume 120, which must not be copied into the style.
 */
export function statedAbcTempo(text: string): number | null {
  let q: number | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("K:")) break;
    if (line.startsWith("Q:")) q = parseTempo(line.slice(2));
  }
  if (q === null) return null;
  return summarizeAbc(text)?.bpm ?? q;
}

/** Summary of ABC text: exact when parseAbc accepts it, lenient otherwise. Null for empty or unreadable text. */
export function summarizeAbc(text: string): AbcSummary | null {
  if (!text.trim()) return null;
  try {
    const s = parseAbc(text);
    return {
      bars: Math.max(s.bars || 0, recomputeBars(s)),
      seconds: scoreSeconds(s),
      bpm: s.bpm,
      key: s.key,
      meter: s.meter,
      hasChords: s.chords.length > 0,
      timelineChanges: hasTimelineChanges(s),
      parseError: null,
    };
  } catch (e) {
    const lenient = lenientAbcSummary(text);
    const msg = e instanceof Error ? e.message : String(e);
    return lenient ? { ...lenient, parseError: msg } : null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Music token budget

export interface BudgetInput {
  /** automatic budget on */
  auto: boolean;
  /** the manual value (used when auto is off) */
  manual: number;
  limit: number;
  defaultMax: number;
  /** the ABC actually sent ("" when the planner writes one, or in off mode) */
  abc: string;
  /** estimate_duration of the lyrics actually sent, in seconds */
  lyricEstimate: number;
}

export interface Budget {
  seconds: number;
  /** what decided the value */
  source: "manual" | "score" | "lyrics" | "default";
  /** nominal length of the supplied ABC (null without an ABC or when it cannot be read) */
  scoreSeconds: number | null;
  /** Japanese warning when the limit (manual, or the configured maximum capping the automatic one) is shorter than the supplied score */
  warning: string | null;
}

/** 185 -> "3:05" (formatSeconds without the api import, for the pure modules). */
export function mmss(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Budget for a fixed score: its nominal length × 1.15 + 10 s (docs/USER_GUIDE.md). */
export function scoreMarginSeconds(scoreSec: number): number {
  return Math.ceil(scoreSec * 1.15 + 10);
}

/** Budget for lyrics without a score: estimate_duration × 1.3 + 15 s. */
export function lyricMarginSeconds(estimate: number): number {
  return Math.ceil(Math.max(0, estimate) * 1.3 + 15);
}

/**
 * Budget for a cover of a transcribed reference: nominal × 1.1 + 15 s. Deliberately not scoreMarginSeconds:
 * it is documented to the user as its own rule (USER_GUIDE 「長い参考音源では譜面の長さ × 1.1 + 15 秒」), so it
 * changes only together with the guide.
 */
export function coverMarginSeconds(scoreSec: number): number {
  return Math.ceil(scoreSec * 1.1 + 15);
}

/**
 * max_duration for one request. Automatic: never below the configured default (360 s, the official node and
 * template value; the model stops at its end token, so a generous budget does not lengthen a normal song),
 * raised for a long score (nominal × 1.15 + 10 s) or long lyrics (estimate × 1.3 + 15 s), capped at the limit;
 * a score the capped budget cannot hold gets the warning (scoreCutWarning). Manual: the user's value, with a
 * warning when a supplied score is longer.
 */
export function durationBudget(i: BudgetInput): Budget {
  const limit = Math.max(8, Math.floor(i.limit));
  const def = Math.min(limit, Math.max(8, i.defaultMax || OFFICIAL_MAX_DURATION));
  const sum = i.abc.trim() ? summarizeAbc(i.abc) : null;
  const scoreSec = sum && sum.seconds > 0 ? sum.seconds : null;
  if (!i.auto) {
    const seconds = Math.min(limit, Math.max(8, i.manual));
    const warning = scoreSec !== null && scoreSec > seconds ? `譜面の長さ（約 ${mmss(scoreSec)}）が曲長の上限（${mmss(seconds)}）を超えています。曲の途中で切れる可能性があります` : null;
    return { seconds, source: "manual", scoreSeconds: scoreSec, warning };
  }
  if (i.abc.trim()) {
    const want = scoreSec !== null ? scoreMarginSeconds(scoreSec) : 0;
    const seconds = Math.min(limit, Math.max(def, want));
    // "score" only when the score really raised it (capped back to the default, nothing was extended)
    return { seconds, source: seconds > def ? "score" : "default", scoreSeconds: scoreSec, warning: scoreCutWarning(scoreSec, seconds) };
  }
  const want = lyricMarginSeconds(i.lyricEstimate);
  const seconds = Math.min(limit, Math.max(def, want));
  // as for a score: "lyrics" only when they really raised it (capped back to the default, nothing was extended)
  return { seconds, source: seconds > def ? "lyrics" : "default", scoreSeconds: null, warning: null };
}

/**
 * Warning for an automatic budget (作曲, AI 編集's re-render) that the configured maximum caps below the score's
 * nominal length (`scoreSec`): the song would be cut off before the score ends. Null when it fits.
 */
export function scoreCutWarning(scoreSec: number | null, seconds: number): string | null {
  if (scoreSec === null || !(scoreSec > seconds)) return null;
  return `譜面の長さ（約 ${mmss(scoreSec)}）が、設定の「曲長の最大値」（${mmss(seconds)}）を超えています。曲の途中で切れる可能性があります`;
}

/**
 * max_duration for a cover of a transcribed score: never below the configured default (the official cover
 * template uses 360 s), raised for a longer reference (nominal × 1.1 + 15 s), capped at the limit.
 */
export function coverMaxDuration(scoreSec: number | null, limit: number, defaultMax: number): number {
  const lim = Math.max(8, Math.floor(limit));
  const def = Math.min(lim, Math.max(8, defaultMax || OFFICIAL_MAX_DURATION));
  const want = scoreSec && scoreSec > 0 ? coverMarginSeconds(scoreSec) : 0;
  return Math.min(lim, Math.max(def, want));
}

/**
 * max_duration for re-rendering an existing song (AI edit): never below the configured default or the song's
 * own budget, raised for longer edited lyrics (estimate × 1.3 + 15 s) or a longer score (nominal × 1.15 + 10 s).
 */
export function rerenderMaxDuration(i: { stored: number | null; lyricEstimate: number; scoreSec: number | null; limit: number; defaultMax: number }): number {
  const lim = Math.max(8, Math.floor(i.limit));
  const def = Math.min(lim, Math.max(8, i.defaultMax || OFFICIAL_MAX_DURATION));
  const lyricCap = lyricMarginSeconds(i.lyricEstimate);
  const scoreCap = i.scoreSec && i.scoreSec > 0 ? scoreMarginSeconds(i.scoreSec) : 0;
  return Math.min(lim, Math.max(def, i.stored ?? 0, lyricCap, scoreCap));
}

// ---------------------------------------------------------------------------------------------------------
// Lyrics helpers

/** Planner lyrics when an instrumental is requested without lyrics (official instrumental.py plan_with_model). */
export const DEFAULT_PLANNING_TAGS = "[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n";

/** Lyrics contain at least one line that is not a [Tag] or blank (i.e. words to sing). */
export function hasSungWords(lyrics: string): boolean {
  return lyrics
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .some((l) => {
      const t = l.trim();
      return t !== "" && !(t.startsWith("[") && t.endsWith("]"));
    });
}

const normTag = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .trim()
    .replace(/^pre ?chorus$/, "pre-chorus")
    .replace(/^post ?chorus$/, "post-chorus");

const CATALOG = [...COMMON_TAGS, ...TAG_GROUPS.flatMap((g) => g.tags)];

/**
 * A lyric skeleton from the score's "% label" section comments (official docs/covers.md: "align section tags
 * and lyric order with the score"): each label becomes its catalog tag ("% pre-chorus" -> "[Pre-Chorus]"),
 * consecutive duplicates are merged, an empty line follows each tag. "" when the score has no labels.
 */
export function tagSkeletonFromAbc(text: string): string {
  const tags: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.startsWith("% ")) continue;
    const label = raw.slice(2).trim();
    if (!label) continue;
    const hit = CATALOG.find((t) => normTag(t.tag) === normTag(label));
    const tag = hit ? hit.tag : pyTitle(label);
    if (tags[tags.length - 1] !== tag) tags.push(tag);
  }
  return tags.map((t) => `[${t}]\n`).join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// ABC text edits that keep the rest of the text verbatim

/** Set the header tempo line to Q:1/4=<bpm> (inserted before the first header V: line, or K:, when missing). */
export function replaceAbcTempo(text: string, bpm: number): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const b = Math.round(bpm);
  const q = lines.findIndex((l) => l.trim().startsWith("Q:"));
  const k = lines.findIndex((l) => l.trim().startsWith("K:"));
  if (q >= 0 && (k < 0 || q < k)) {
    lines[q] = `Q:1/4=${b}`;
    return lines.join("\n");
  }
  const v = lines.findIndex((l) => l.trim().startsWith("V:"));
  // a V: after K: is a body line: the header ends at K:
  const at = v >= 0 && (k < 0 || v < k) ? v : k >= 0 ? k : lines.length;
  lines.splice(at, 0, `Q:1/4=${b}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// Parameters stored with a song

export interface Sampling {
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  cfgScale: number;
  steps: number;
  abcTemperature: number;
}

/** The node / official defaults (workflow.rs serde defaults). */
export const DEFAULT_SAMPLING: Sampling = { temperature: 1.0, topP: 0.95, topK: 100, repetitionPenalty: 1.2, cfgScale: 1.0, steps: 32, abcTemperature: 0.7 };

/** GenerateParams stored with a song, leniently (old rows: "" or "{}"; any field may be missing). */
export function storedParams(paramsJson: string | null | undefined): Partial<GenerateParams> {
  if (!paramsJson) return {};
  try {
    const v = JSON.parse(paramsJson) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<GenerateParams>) : {};
  } catch {
    return {};
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Sampling settings of a stored request, field by field, falling back to `fallback` for missing values. */
export function samplingFrom(p: Partial<GenerateParams>, fallback: Sampling): Sampling {
  return {
    temperature: num(p.temperature) ?? fallback.temperature,
    topP: num(p.topP) ?? fallback.topP,
    topK: num(p.topK) ?? fallback.topK,
    repetitionPenalty: num(p.repetitionPenalty) ?? fallback.repetitionPenalty,
    cfgScale: num(p.cfgScale) ?? fallback.cfgScale,
    steps: num(p.steps) ?? fallback.steps,
    abcTemperature: num(p.abcTemperature) ?? fallback.abcTemperature,
  };
}

/** The stored maxDuration when it is a usable number. */
export function storedMaxDuration(p: Partial<GenerateParams>): number | null {
  const v = num(p.maxDuration);
  return v !== undefined && v > 0 ? v : null;
}

/** The request used a fixed ABC (not the planner): its stored abc is non-empty and the mode is not off. */
export function usedFixedAbc(p: Partial<GenerateParams>, mode: string): boolean {
  return mode !== "off" && typeof p.abc === "string" && p.abc.trim() !== "";
}

// ---------------------------------------------------------------------------------------------------------
// AI edit requests

/**
 * A melody word right after one of these names one section's melody (Aメロ, サビのメロディ, Aメロのメロディ,
 * 2番目の旋律 …), not the whole melody. 元のメロディ / 曲全体のメロディ still mean the whole one.
 */
const SECTION_SCOPE = String.raw`(?<![A-DＡ-Ｄa-dａ-ｄ]|[A-DＡ-Ｄa-dａ-ｄ]メロの|サビ|サビの|サビ前の|イントロの|間奏の|アウトロの|ブリッジの|コーラスの|前奏の|後奏の|番の|番目の)`;
const KEEP_WORDING = "(?:は|を)?(?:変えない|変えず|変更しない|変更せず|そのまま|維持|保)";

/**
 * The instruction asks to leave the (vocal) melody alone: メロディ / メロ / 旋律 followed by "keep" wording. A bare
 * メロ right after a section letter (Aメロ, Ｂメロ) names a section, not the whole melody, and does not count;
 * neither does a melody (メロ or 旋律) scoped to one section (サビメロ, サビのメロディ, Aメロのメロディ, 2番のメロ,
 * サビの旋律): the other sections may change.
 */
export const KEEP_MELODY = new RegExp(
  `${SECTION_SCOPE}(?:メロ(?:ディー?)?|旋律)${KEEP_WORDING}|keep the melody|melody unchanged|(?:don't|do not) change the melody`,
  "i",
);

/**
 * The instruction asks for fewer bars (a section or bars removed), so a much shorter reply is expected. Kept to
 * wording that removes sections: bare まとめ / 抜い / 省 also appear in ordinary rewrites (コードをまとめて,
 * 装飾音を省いて) and would switch off the excerpt guard.
 */
export const SHORTEN_INTENT =
  /短く|短縮|カット|削除|削っ|削る|減ら|消し|消す|省略|(?:番|奏|ロ|サビ|メロ|コーラス|セクション|小節|ブリッジ)[をは]?省|なくし|無くし|取り除|除い|除く|[1１]\s*コーラス|ワンコーラス|[1１]\s*番だけ|だけにし|だけ残|shorten|\bcut\b|remove|delete|\bdrop\b|\btrim\b|one chorus/i;

/** A reply with fewer bars than this share of the sent score is treated as an excerpt (元の 7 割未満). */
export const EXCERPT_RATIO = 0.7;
/** Below this share even a shortening instruction does not explain the reply (a request rarely removes 70 %). */
export const EXCERPT_FLOOR_RATIO = 0.3;

/**
 * Excerpt check of an AI-edit reply: "reask" (one automatic re-ask for the complete score), "note" (only a
 * warning: the instruction asked to shorten, but the reply is far shorter than any such request), "shortened"
 * (a neutral hint to check the diff: SHORTEN_INTENT also matches removing an instrument or an effect, where an
 * excerpt would otherwise pass unnoticed) or null.
 */
export function excerptCheck(originalBars: number, replyBars: number, instruction: string): "reask" | "note" | "shortened" | null {
  if (!(originalBars > 0) || replyBars >= originalBars * EXCERPT_RATIO) return null;
  if (!SHORTEN_INTENT.test(instruction)) return "reask";
  return replyBars < originalBars * EXCERPT_FLOOR_RATIO ? "note" : "shortened";
}

/** Verdict on an AI-edit reply's score (see replyVerdict). */
export type ReplyVerdict =
  | { kind: "parse"; message: string }
  | { kind: "short"; bars: number; level: "reask" | "note" | "shortened" }
  | { kind: "native"; errors: string[]; bars: number; shortLevel?: "note" | "shortened" }
  | null;

/**
 * Check of an AI-edit reply's score, in this order: text the parser rejects; an excerpt that needs the re-ask for
 * the complete score; text outside the official native dialect (validateNativeAbc, advisory), which keeps a
 * shortening instruction's bar-count hint as `shortLevel` (a shorter score is what was asked for, its notation
 * still gets checked, re-asked and confirmed at apply); else the bar-count hint alone, or null.
 */
export function replyVerdict(originalBars: number, replyAbc: string, instruction: string): ReplyVerdict {
  if (!replyAbc.trim()) return null;
  let bars: number;
  try {
    bars = parseAbc(replyAbc).bars;
  } catch (e) {
    return { kind: "parse", message: e instanceof Error ? e.message : String(e) };
  }
  const excerpt = excerptCheck(originalBars, bars, instruction);
  if (excerpt === "reask") return { kind: "short", bars, level: "reask" };
  const nat = validateNativeAbc(replyAbc);
  if (!nat.ok) return { kind: "native", errors: nat.errors, bars, ...(excerpt ? { shortLevel: excerpt } : {}) };
  return excerpt ? { kind: "short", bars, level: excerpt } : null;
}

/**
 * Whether a reply's verdict gets the one automatic re-ask: an excerpt to re-ask for, a score the parser rejects
 * (unless the sent score already fails to parse), or native-dialect errors when the sent score had none or the
 * reply has more (a problem the sent score already has is not the reply's fault).
 */
export function worthReask(v: ReplyVerdict, sentParses: boolean, sentNativeErrors: number): boolean {
  return v !== null && (v.kind === "short" ? v.level === "reask" : v.kind === "parse" ? sentParses : sentNativeErrors === 0 || v.errors.length > sentNativeErrors);
}

/** The follow-up request of that re-ask. */
export function reaskText(v: NonNullable<ReplyVerdict>, originalBars: number): string {
  return v.kind === "short"
    ? `返された譜面は ${v.bars} 小節しかありません（元は ${originalBars} 小節）。抜粋ではなく、変更していないセクションも含めて X:1 から最後の小節まで「完全な譜面」を abc に入れて返してください。`
    : v.kind === "parse"
      ? `返された譜面を解釈できません（${v.message}）。YuE2 のネイティブ ABC 記法に従って直し、X:1 から最後の小節まで完全な譜面を abc に入れて返してください。`
      : `返された譜面が YuE2 のネイティブ ABC 記法の検査に通りません:\n- ${v.errors.slice(0, 8).join("\n- ")}\n指摘を直し、X:1 から最後の小節まで完全な譜面を abc に入れて返してください。`;
}

export type EditField = "abc" | "style" | "lyrics";

/** Style or lyrics text compared without line-ending and outer-whitespace differences. */
const sameText = (a: string, b: string) => a.replace(/\r\n?/g, "\n").trim() === b.replace(/\r\n?/g, "\n").trim();

/**
 * A score compared without line-ending differences and one final line break only: its other outer whitespace is
 * read (the native check wants X:1 on the first line and bar lines at the ends; YuE2 tokenizes the text as is), so a
 * reply that changes only that is a change.
 */
const sameScore = (a: string, b: string) => {
  const n = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return n(a) === n(b);
};

/**
 * A reply with every field that only repeats what was sent emptied ("" means unchanged, as the edit prompt asks):
 * a model sometimes returns a field whole although it did not change it (or says it did). `repeated` names those
 * fields, so the page can say that nothing changed there. A sent field given as null is never compared: "" keeps
 * what the editor holds, so it means "unchanged" only when that is what was sent (the melody re-ask of an applied
 * turn sends the earlier score, and a reply that restores it is the change it asked for).
 */
export function dropRepeatedFields<T extends Record<EditField, string>>(reply: T, sent: Record<EditField, string | null>): { reply: T; repeated: EditField[] } {
  const repeated = (["abc", "style", "lyrics"] as const).filter((k) => {
    const s = sent[k];
    return reply[k].trim() !== "" && s !== null && (k === "abc" ? sameScore(reply[k], s) : sameText(reply[k], s));
  });
  if (!repeated.length) return { reply, repeated };
  const out = { ...reply };
  for (const k of repeated) out[k] = "" as T[EditField];
  return { reply: out, repeated };
}

/**
 * The title of an AI edit's re-render: the edited song's current one (a re-render keeps its song's title, as on
 * 作曲's piano roll). Without a song (a score typed in), or when the edit made a vocal song an instrumental or the
 * other way round (the title may carry the instrumental mark or a lyric line), the backend names it.
 */
export function rerenderTitle(song: { title: string; lyrics: string } | null | undefined, lyricsNow: string): string | undefined {
  if (!song || hasSungWords(song.lyrics) !== hasSungWords(lyricsNow)) return undefined;
  return song.title.trim() || undefined;
}

/** The page's note for a reply whose returned fields all repeated what was sent (nothing to apply). */
export function repeatedFieldsNote(repeated: EditField[]): string {
  const names: Record<EditField, string> = { abc: "譜面", style: "スタイル", lyrics: "歌詞" };
  return `⚠ AI が返した${repeated.map((k) => names[k]).join("・")}は送った内容と同じで、変更はありませんでした。指示を言い換えてもう一度お試しください。`;
}

/**
 * The compareScores lines a melody re-ask asks to undo: the vocal notes and the bar grid. Chord, tempo, key and
 * accompaniment lines are what the instruction asked for (a reharmonization), so restoring them would undo it.
 */
export function melodyRelevantLines(lines: string[]): string[] {
  return lines.filter((l) => !/^(?:コード|テンポ|調|伴奏声部):/.test(l));
}

/** The one follow-up request that asks to restore the vocal melody (its reply is melody-checked again). */
export function melodyReaskText(changes: string[]): string {
  const relevant = melodyRelevantLines(changes);
  return `メロディは変えないでください（ボーカルの音符は元の譜面のまま）。次の変更を元に戻し、指示されたそれ以外の変更だけを行った完全な譜面を返してください:\n${(relevant.length ? relevant : changes).join("\n")}`;
}

/**
 * The score a melody re-ask of a turn is made against: the turn's sent score, while the editor still holds it
 * (not applied) or holds exactly the score the apply put there (`appliedAbc`: the reply, or the reply with the
 * tempo dialog's Q: change; the reply when not recorded). Null when the score changed since (another turn
 * applied, a hand edit): the re-ask would silently drop those changes, so it is not offered.
 */
export function melodyReaskBase(t: { sentAbc?: string; applied?: boolean; replyAbc?: string; appliedAbc?: string }, currentAbc: string): string | null {
  if (!t.sentAbc?.trim()) return null;
  if (currentAbc === t.sentAbc) return t.sentAbc;
  const applied = t.appliedAbc ?? t.replyAbc;
  if (t.applied && applied !== undefined && currentAbc === applied) return t.sentAbc;
  return null;
}

/**
 * Rough token count for the local model's context budget. Qwen-style tokenizers split ABC (single-digit
 * durations, note letters, bar lines) into about one token per 1.5 characters and give kana and kanji about one
 * token each, so an ASCII character counts 1/1.5 and any other character 1. English prose (the system prompt)
 * is overestimated, which only leaves more room.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 1.5 + other);
}

/** llm.rs edit_system_prompt (about 5.5 KB of English, roughly 1.5k real tokens) plus the canned acknowledgement, with room to spare. */
export const EDIT_SYSTEM_PROMPT_TOKENS = 3000;
/** llm.rs max_tokens of an edit reply (thinking included). */
export const EDIT_MAX_REPLY_TOKENS = 8192;

/**
 * Tokens left for the conversation history of an AI-edit request on the local server (context_size): the
 * system prompt, the context block (current style, lyrics, sung reading, score) and the instruction are sent
 * anyway, and the reply needs room for thinking plus a complete score. Null (no trimming, as for the cloud) when
 * the size is not a positive integer: 0 is llama-server's `-c 0`, the model's own context, which the app does
 * not know.
 */
export function editHistoryBudget(i: { contextSize: number; abc: string; style: string; lyrics: string; sung: string | null; instruction: string }): number | null {
  if (!(Number.isInteger(i.contextSize) && i.contextSize > 0)) return null;
  const context = estimateTokens(i.abc) + estimateTokens(i.style) + estimateTokens(i.lyrics) + estimateTokens(i.sung ?? "") + 200;
  const reply = Math.min(EDIT_MAX_REPLY_TOKENS, estimateTokens(i.abc) + 3000);
  return Math.max(0, i.contextSize - EDIT_SYSTEM_PROMPT_TOKENS - context - estimateTokens(i.instruction) - reply);
}

/** A conversation turn as the history builder needs it. */
export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
  /** the model's JSON reply (absent for an error turn) */
  raw?: string;
  explanation?: string;
  /** the request failed: this turn and the user turn before it are not sent again */
  error?: boolean;
}

/** Marker of an older reply whose score, style and lyrics are left out of the history. */
export const OMITTED_REPLY_NOTE = "（この時点の譜面・スタイル・歌詞は省略。最新の状態は冒頭の「現在の状態」を参照）";

/**
 * The history sent with an AI-edit request. Failed exchanges (an error turn and the user turn before it) and
 * unanswered user turns are left out. The latest reply stays verbatim (it may be an unapplied suggestion that
 * 「修正して」 builds on); older replies keep the JSON shape with empty abc/style/lyrics (= unchanged, the
 * context block holds the current state) and their explanation. With a token budget (the local server), the
 * oldest exchanges are dropped until the rest fits; `dropped` counts them.
 */
export function compactEditHistory(turns: readonly HistoryTurn[], budgetTokens: number | null): { messages: ChatMessage[]; dropped: number } {
  const pairs: { user: HistoryTurn; assistant: HistoryTurn }[] = [];
  for (let i = 0; i < turns.length; i++) {
    const u = turns[i];
    if (u.role !== "user") continue;
    const a = turns[i + 1];
    if (!a || a.role !== "assistant") continue;
    i++;
    if (a.error) continue;
    pairs.push({ user: u, assistant: a });
  }
  let latest = -1;
  pairs.forEach((p, i) => {
    if (p.assistant.raw !== undefined) latest = i;
  });
  const assistantContent = (a: HistoryTurn, i: number): string => {
    if (a.raw === undefined) return a.text;
    if (i === latest) return a.raw;
    return JSON.stringify({ abc: "", style: "", lyrics: "", explanation: `${a.explanation ?? ""}${OMITTED_REPLY_NOTE}` });
  };
  let exchanges: ChatMessage[][] = pairs.map((p, i) => [
    { role: "user", content: p.user.text },
    { role: "assistant", content: assistantContent(p.assistant, i) },
  ]);
  let dropped = 0;
  if (budgetTokens !== null) {
    const size = (m: ChatMessage[]) => m.reduce((n, x) => n + estimateTokens(x.content) + 8, 0);
    let total = exchanges.reduce((n, m) => n + size(m), 0);
    while (exchanges.length > 0 && total > budgetTokens) {
      total -= size(exchanges[0]);
      exchanges = exchanges.slice(1);
      dropped++;
    }
  }
  return { messages: exchanges.flat(), dropped };
}

/**
 * History budget of the automatic re-ask on the local server: it sends the first exchange (the instruction and
 * the whole first reply, about one more score) and the re-ask text on top of the older history, which
 * editHistoryBudget did not reserve. Null = no budget (cloud). Negative = the first exchange alone does not
 * fit: the re-ask would eat the reply's room (a truncated reply or a 400), so it is not sent.
 */
export function reaskHistoryBudget(budget: number | null, i: { instruction: string; firstRaw: string; again: string }): number | null {
  if (budget === null) return null;
  return budget - (estimateTokens(i.instruction) + 8) - (estimateTokens(i.firstRaw) + 8) - estimateTokens(i.again);
}

/**
 * Index of the latest assistant turn with a reply (-1 when none): the one compactEditHistory sends verbatim.
 * Only that turn offers the melody re-ask, which revises the history's latest instruction and reply.
 */
export function latestReplyIndex(turns: readonly { role: string; reply?: unknown; error?: boolean }[]): number {
  let latest = -1;
  turns.forEach((t, i) => {
    if (t.role === "assistant" && t.reply !== undefined && !t.error) latest = i;
  });
  return latest;
}

/** Thinking a real score edit takes (llm.rs: 1000–2000 tokens; the 4,096-token cap only stops loops). */
export const EDIT_TYPICAL_THINKING_TOKENS = 2000;
/** The reply's explanation and JSON frame around the complete score. */
export const EDIT_REPLY_PROSE_TOKENS = 400;
/**
 * llm.rs edit_system_prompt as the model counts it (about 5.5 KB of English, roughly 1.5k real tokens). The
 * pre-check uses it instead of EDIT_SYSTEM_PROMPT_TOKENS, whose room to spare would warn about songs that fit.
 */
export const EDIT_SYSTEM_PROMPT_REAL_TOKENS = 1500;

export interface LocalEditFit {
  /** the complete score as the JSON reply carries it */
  scoreTokens: number;
  /** what the reply can use (thinking included): max_tokens, or less when the prompt fills the context */
  room: number;
  /** the prompt alone (system prompt, current state, instruction) exceeds the context: the request fails at once */
  promptTooLong: boolean;
  /** a larger context size would make room (the 8,192-token output cap is not what limits it) */
  contextBound: boolean;
  /** thinking is on, and the reply would fit without it */
  withoutThinkingFits: boolean;
}

/**
 * Pre-check of an AI-edit request on the local server (asked before sending): a reply that changes the score
 * carries the complete score, JSON-escaped, plus its explanation, after the model's thinking, within max_tokens
 * (EDIT_MAX_REPLY_TOKENS, thinking included) and what the context leaves after the prompt. Null when a typical
 * reply fits; otherwise the numbers for the warning. The history is not counted (compactEditHistory drops it to
 * fit), nor a context size of 0 (the model's own, unknown here).
 */
export function localEditFit(i: { contextSize: number; thinking: boolean; abc: string; style: string; lyrics: string; sung: string | null; instruction: string }): LocalEditFit | null {
  if (!i.abc.trim()) return null;
  const scoreTokens = estimateTokens(JSON.stringify(i.abc));
  const answer = scoreTokens + EDIT_REPLY_PROSE_TOKENS;
  const need = answer + (i.thinking ? EDIT_TYPICAL_THINKING_TOKENS : 0);
  const prompt = EDIT_SYSTEM_PROMPT_REAL_TOKENS + estimateTokens(i.abc) + estimateTokens(i.style) + estimateTokens(i.lyrics) + estimateTokens(i.sung ?? "") + estimateTokens(i.instruction) + 200;
  const contextRoom = Number.isInteger(i.contextSize) && i.contextSize > 0 ? i.contextSize - prompt : Infinity;
  const room = Math.min(EDIT_MAX_REPLY_TOKENS, contextRoom);
  if (need <= room) return null;
  return {
    scoreTokens,
    room: Math.max(0, room),
    promptTooLong: contextRoom <= 0,
    contextBound: contextRoom < need && need <= EDIT_MAX_REPLY_TOKENS,
    withoutThinkingFits: i.thinking && answer <= room,
  };
}

/**
 * The AI-edit requests of EditPage's conversation: one is answered at a time, and its reply is used only while it
 * is still pending (not cancelled) in the conversation it was sent in (a reset or another song starts a new
 * one). Plain state, so the interleavings are unit-tested; the page keeps one instance.
 */
export class EditConversation {
  private generation = 0;
  private request: string | null = null;

  /** the conversation's generation: an async step that waited compares it before writing into the form */
  get gen(): number {
    return this.generation;
  }

  /** the request being answered (null: none, or it was cancelled) */
  get pending(): string | null {
    return this.request;
  }

  /** A new conversation (会話をリセット, another song loaded): a reply of the old one is dropped. */
  restart(): void {
    this.generation++;
  }

  /** A request starts; the returned check is true once its reply must be dropped (cancelled, or another conversation). */
  begin(requestId: string): () => boolean {
    const gen = this.generation;
    this.request = requestId;
    return () => this.generation !== gen || this.request !== requestId;
  }

  /** キャンセル: the pending request's id, to cancel it in the backend (null: nothing pending). Its reply is dropped. */
  cancel(): string | null {
    const id = this.request;
    this.request = null;
    return id;
  }

  /** The request ended (answered, failed or dropped); a newer pending request is left alone. */
  end(requestId: string): void {
    if (this.request === requestId) this.request = null;
  }
}

/**
 * The fields an AI-edit reply would replace that were edited after its request was sent (the piano roll, the
 * style or lyrics box, another reply applied meanwhile), named for the apply question; [] when none. The score is
 * compared with the one in the editor when the request was sent (`editorAbc`: a melody re-ask sends the turn's
 * earlier score while the editor holds its applied reply), else `sentAbc`. Only the fields the reply returns
 * count (an unchanged field comes back empty and is left as it is).
 */
export function editedSinceSent(
  t: { sentAbc?: string; editorAbc?: string; sentStyle?: string; sentLyrics?: string },
  reply: { abc: string; style: string; lyrics: string },
  now: { abc: string; style: string; lyrics: string },
): string[] {
  const out: string[] = [];
  const abcThen = t.editorAbc ?? t.sentAbc;
  if (reply.abc.trim() && abcThen !== undefined && now.abc !== abcThen) out.push("譜面");
  if (reply.style.trim() && t.sentStyle !== undefined && now.style !== t.sentStyle) out.push("スタイル");
  if (reply.lyrics.trim() && t.sentLyrics !== undefined && now.lyrics !== t.sentLyrics) out.push("歌詞");
  return out;
}

/** What AI 編集 holds that loading another song would replace (the work list of its selection question). */
export function editWork(i: { turns: number; edited: boolean; textDirty: boolean; pending: boolean }): string[] {
  return [
    i.turns > 0 ? `対話 ${i.turns} 件` : "",
    i.pending ? "AI への依頼（応答待ち）" : "",
    i.edited ? "譜面・スタイル・歌詞の変更" : "",
    i.textDirty ? "未反映の ABC テキスト" : "",
  ].filter(Boolean);
}

/** AI 編集's song as the planned-score load sees it (its id, status and stored score). */
export interface PlannedScoreSong {
  id: string | null;
  status: string | null;
  abc: string;
}

/**
 * A song rendered without a score (the planner writes one) gets its score when it finishes. "load": put it into
 * the editor, which is still empty. "kept": the empty editor holds ABC text typed meanwhile and not applied
 * (`textDirty`), which loading would replace: the text stays and the user is told (the score stays in the song).
 * null: nothing to do (another song than last time, not finished, already seen, no planned score, or a score in
 * the editor that it must not replace).
 */
export function plannedScoreLoad(prev: PlannedScoreSong, now: PlannedScoreSong, form: { abc: string; textDirty: boolean }): "load" | "kept" | null {
  if (prev.id !== now.id || now.status !== "done") return null;
  if (prev.status === "done" && prev.abc === now.abc) return null;
  if (!now.abc.trim() || form.abc.trim()) return null;
  return form.textDirty ? "kept" : "load";
}

/**
 * How the local LLM is shown (AI 編集, 設定) and what its button does. This app's server counts as running while
 * its process runs, also when /health on the configured port does not answer: the model is still loading (or a
 * start ran past its time limit), or it runs with the settings from before a change (another port) until the
 * next AI request restarts it. Either way it holds VRAM and can be stopped. A server this app did not start has
 * no button (null).
 */
export function localLlmView(s: { alive: boolean; processRunning: boolean; external: boolean; restartRequired: boolean }): { label: string; toggle: "start" | "stop" | null } {
  if (s.external) return { label: "稼働中（このアプリが起動していない llama-server）", toggle: null };
  if (s.alive) return { label: "稼働中", toggle: "stop" };
  if (s.processRunning) return { label: s.restartRequired ? "稼働中（変更前の設定）" : "起動中", toggle: "stop" };
  return { label: "停止", toggle: "start" };
}

/**
 * The style with the score's tempo (official: tempo in the ABC and the style agree), with the note for the
 * toast, or null when there is no stated tempo or the style already names it.
 */
export function styleTempoSync(style: string, bpm: number | null): { style: string; bpm: number; note: string } | null {
  if (!bpm || !styleBpmDiffers(style, bpm)) return null;
  const b = Math.round(bpm);
  return { style: withStyleBpm(style, bpm), bpm: b, note: `スタイルの BPM を譜面の Q: に合わせました（${b} BPM）` };
}

/** バリエーション数: an integer in 1..8 (anything unreadable becomes 1). */
export function clampVariations(v: unknown): number {
  return Math.max(1, Math.min(8, Math.floor(Number(v)) || 1));
}

/**
 * バリエーション数 when the field is committed (blur, Enter, send): its value clamped to 1..8, or `previous` when it is
 * empty or not a number (an emptied field goes back to the last count instead of 1).
 */
export function committedVariations(text: string, previous: number): number {
  const t = text.trim();
  return t !== "" && Number.isFinite(Number(t)) ? clampVariations(t) : clampVariations(previous);
}

/** cfg_scale of the 「公式 off 互換」 button (official runtime's off-mode guidance; 2-branch AR). */
export const OFF_COMPAT_CFG = 1.01;

type RenderMode = "full" | "melody" | "off";

/**
 * Mode and cfg_scale of an AI-edit re-render. With a score the mode follows it (chords -> full, else melody);
 * without one the song keeps its own mode, so an off song stays off (no planner, off instruction prefix)
 * instead of becoming a planned full song. When an off song gets a score from the edit, its off-compatible
 * 1.01 is not carried into the full/melody render (official full/melody default 1.0, protocol.py).
 */
export function rerenderModeAndCfg(i: { hasAbc: boolean; hasChords: boolean; storedMode: string | null | undefined; cfgScale: number }): { mode: RenderMode; cfgScale: number } {
  const stored: RenderMode = i.storedMode === "off" || i.storedMode === "melody" || i.storedMode === "full" ? i.storedMode : "full";
  const mode: RenderMode = i.hasAbc ? (i.hasChords ? "full" : "melody") : stored;
  const cfgScale = stored === "off" && mode !== "off" && i.cfgScale === OFF_COMPAT_CFG ? 1.0 : i.cfgScale;
  return { mode, cfgScale };
}

/**
 * AI 編集's render button, named as in 作曲: 「この譜面で再生成（Full / Melody）」 with a score (the render's mode
 * from rerenderModeAndCfg). Without a score it re-renders in the song's own mode: 譜面なし for Off, a score planned
 * again with the song's seed for Melody / Full.
 */
export function rerenderLabel(hasAbc: boolean, mode: RenderMode): string {
  const m = mode === "off" ? "Off" : mode === "melody" ? "Melody" : "Full";
  if (hasAbc) return `この譜面で再生成（${m}）`;
  return mode === "off" ? "再生成（譜面なし・Off）" : `再生成（譜面を再計画・${m}）`;
}

/**
 * Which side the AI-edit tempo dialog offers first (the focused, primary choice) when the reply's style BPM
 * and its score's Q: disagree: "style" (follow the score) when only Q: moved compared with what was sent,
 * so Enter keeps a requested tempo change; otherwise "abc" (change Q: to the style's BPM).
 */
export function tempoDialogDefault(i: { sentAbc?: string; sentStyle?: string; replyHasAbc: boolean; bpm: number; styleBpm: number | null }): "abc" | "style" {
  const sentQ = i.sentAbc?.trim() ? statedAbcTempo(i.sentAbc) : null;
  const sentSb = i.sentStyle?.trim() ? styleBpmOf(i.sentStyle) : null;
  const qChanged = i.replyHasAbc && sentQ !== null && Math.round(sentQ) !== Math.round(i.bpm);
  const styleChanged = sentSb === null || sentSb !== i.styleBpm;
  return qChanged && !styleChanged ? "style" : "abc";
}

// ---------------------------------------------------------------------------------------------------------
// Compose page piano-roll edits

/** A piano-roll edit of one song on the compose page, kept until it is rendered, undone or discarded. */
export interface PianoEdit {
  title: string;
  /** the song's score the edit started from */
  base: string;
  abc: string;
}

/**
 * The compose page's piano-roll edits per song id ("" = no song selected). An edit back at its base is
 * removed. Kept per song, so a selection change (a finished job selects its song, a new request selects the
 * queued one) does not throw the edits away: selecting the song again shows them in the piano roll.
 */
export function recordPianoEdit(edits: Readonly<Record<string, PianoEdit>>, songId: string, e: PianoEdit): Record<string, PianoEdit> {
  const next = { ...edits };
  const base = next[songId]?.base ?? e.base;
  if (e.abc === base) delete next[songId];
  else next[songId] = { title: e.title, base, abc: e.abc };
  return next;
}

/**
 * Edits of songs other than the selected one, which the page lists: `exists` = the song can be selected again
 * (its edits come back in the piano roll); every edit can be copied into the form's ABC.
 */
export function otherPianoEdits(edits: Readonly<Record<string, PianoEdit>>, selectedId: string, existingIds: ReadonlySet<string>): { id: string; title: string; exists: boolean }[] {
  return Object.entries(edits)
    .filter(([id, e]) => id !== selectedId && e.abc !== e.base)
    .map(([id, e]) => ({ id, title: e.title, exists: existingIds.has(id) }));
}

// ---------------------------------------------------------------------------------------------------------
// AI-edit diff view

/** A diff with at most this many unchanged lines is shown in full; a longer one only around the changes. */
export const DIFF_FULL_MAX_SAME = 60;
/** Unchanged lines kept before and after each change in a shortened diff. */
export const DIFF_CONTEXT_LINES = 2;

export type DiffGap = { kind: "gap"; skipped: number };

/**
 * The rows of a line diff to show: all of them for a short diff; otherwise every change with `ctx` unchanged
 * lines around it, each other run of unchanged lines collapsed into one gap row (「… N 行省略」).
 */
export function diffWithContext<T extends { kind: "same" | "add" | "del" }>(d: readonly T[], ctx = DIFF_CONTEXT_LINES, fullMax = DIFF_FULL_MAX_SAME): (T | DiffGap)[] {
  if (d.filter((x) => x.kind === "same").length <= fullMax) return [...d];
  const keep = d.map((x) => x.kind !== "same");
  d.forEach((x, i) => {
    if (x.kind === "same") return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(d.length - 1, i + ctx); k++) keep[k] = true;
  });
  const out: (T | DiffGap)[] = [];
  let skipped = 0;
  d.forEach((x, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: "gap", skipped });
      skipped = 0;
      out.push(x);
    } else skipped++;
  });
  if (skipped) out.push({ kind: "gap", skipped });
  return out;
}
