// Helpers for the library view: key generation parameters, truncation notices and the
// "regenerate with a larger limit" parameters.
import type { GenerateParams, Song } from "../api";
import { DURATION_LIMIT_MIN, MAX_DURATION_CAP } from "../config/rules";

/** YuE2GenerateMusic.max_duration maximum in ComfyUI v0.37.0 (defined in config/rules.ts) */
export { MAX_DURATION_CAP };

/** YuE2 music tokens (latent frames) per second of audio: ComfyUI budgets round(maxDuration * 25) tokens. */
export const MUSIC_TOKENS_PER_SECOND = 25;

const STATUS_LABEL: Record<Song["status"], string> = { done: "完了", running: "生成中", queued: "待機中", error: "エラー", cancelled: "キャンセル済み" };

/** Badge text of a song's job status (the library and 作曲's recent list); an unknown status shows as is. */
export function songStatusLabel(status: string): string {
  return Object.prototype.hasOwnProperty.call(STATUS_LABEL, status) ? STATUS_LABEL[status as Song["status"]] : status;
}

/** Display name of a song's planning mode, as on 作曲's buttons (Full / Melody / Off); an unknown value shows as is. */
export function modeLabel(mode: string): string {
  return mode === "full" ? "Full" : mode === "melody" ? "Melody" : mode === "off" ? "Off" : mode;
}

/**
 * Player text for a selected song without audio (作曲): only a song still waiting or generating will become
 * playable; a failed or cancelled one (and no selection) keeps the Player's default 「音源がありません」.
 */
export function pendingPlayerPlaceholder(song: Pick<Song, "status"> | null | undefined): string | undefined {
  return song && (song.status === "queued" || song.status === "running") ? "生成が完了すると再生できます" : undefined;
}

/** The GenerateParams stored with a song (null when missing or unreadable). */
export function parseSongParams(paramsJson: string | null | undefined): GenerateParams | null {
  if (!paramsJson) return null;
  try {
    const v = JSON.parse(paramsJson) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const p = v as Partial<GenerateParams>;
    if (typeof p.style !== "string" || typeof p.lyrics !== "string" || typeof p.maxDuration !== "number") return null;
    return p as GenerateParams;
  } catch {
    return null;
  }
}

export interface KeyParams {
  mode: string;
  seed: number | null;
  maxDuration: number | null;
  cfgScale: number;
  steps: number;
}

/** Key parameters for display. Old songs without a field show the node defaults (cfg 1.0, 32 steps). */
export function keyParams(song: Song): KeyParams {
  const p = parseSongParams(song.paramsJson);
  return {
    mode: p?.mode ?? song.mode,
    seed: p?.seed ?? song.seed ?? null,
    maxDuration: p?.maxDuration ?? null,
    cfgScale: p?.cfgScale ?? 1.0,
    steps: p?.steps ?? 32,
  };
}

type TruncationFields = Pick<Song, "truncatedSemantic" | "truncatedAbc"> & Partial<Pick<Song, "effectiveMaxSeconds" | "paramsJson">>;

/**
 * The music budget ComfyUI actually used when it was shorter than the requested maxDuration
 * (it lowers the budget so a long prompt fits the context). Null when not shortened or unknown.
 */
export function shortenedBudget(song: TruncationFields): { effective: number; requested: number } | null {
  const eff = song.effectiveMaxSeconds;
  const requested = parseSongParams(song.paramsJson)?.maxDuration;
  if (typeof eff !== "number" || !Number.isFinite(eff) || eff <= 0 || typeof requested !== "number") return null;
  // Compare in frames, as ComfyUI does: round(maxDuration * 25).
  if (Math.round(eff * MUSIC_TOKENS_PER_SECOND) >= Math.max(1, Math.round(requested * MUSIC_TOKENS_PER_SECOND))) return null;
  return { effective: eff, requested };
}

/** Warning lines for a song whose token budget ran out (empty = none or unknown). */
export function truncationNotices(song: TruncationFields): string[] {
  const out: string[] = [];
  const short = shortenedBudget(song);
  if (song.truncatedSemantic === true && short) {
    out.push(
      `上限到達：プロンプトが長いため実効上限 ${short.effective.toFixed(1)} 秒（指定 ${short.requested} 秒から短縮）で打ち切られました。上限を広げても変わらないため、歌詞・スタイル・譜面を短くしてください`,
    );
  } else if (song.truncatedSemantic === true) out.push("上限到達：途中で終わっている可能性があります（曲長の上限まで生成されました）");
  if (song.truncatedAbc === true) out.push("譜面が上限トークンで打ち切られています（要確認：歌詞を短くするかシードを変えて再生成）");
  return out;
}

export function isTruncated(song: TruncationFields): boolean {
  return song.truncatedSemantic === true || song.truncatedAbc === true;
}

/**
 * Parameters to regenerate with a larger duration limit: the previous budget × 1.5 (rounded up),
 * capped at the configured limit (≤ 900 s). The explicit maxDuration bypasses the Compose page's
 * automatic duration. The song's current title is sent, not the one stored in its params (a rename
 * changes only the library title), as 作曲's 「この譜面で再生成」 does. Null when the song has no
 * readable params, is already at the cap, or its budget was shortened for a long prompt (a larger
 * maxDuration would not change it).
 */
export function largerLimitParams(song: Song, limit: number): GenerateParams | null {
  const p = parseSongParams(song.paramsJson);
  if (!p || shortenedBudget(song)) return null;
  const cap = Math.min(Math.max(DURATION_LIMIT_MIN, Math.floor(limit)), MAX_DURATION_CAP);
  const next = Math.min(Math.ceil(p.maxDuration * 1.5), cap);
  if (!(next > p.maxDuration)) return null;
  return { ...p, maxDuration: next, title: song.title.trim() || undefined };
}

/**
 * Text folded for the library search: NFKC (full-width Latin / half-width kana to their usual forms),
 * lower case, and katakana to hiragana, so "ｐｏｐ" finds "J-Pop" and "サクラ" finds the sung "さくら".
 */
export function searchKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** The song matches a (raw) search query in its title, style, lyrics or sung lyrics. An empty query matches all. */
export function songMatches(song: Pick<Song, "title" | "style" | "lyrics"> & Partial<Pick<Song, "lyricsSung">>, query: string): boolean {
  const needle = searchKey(query.trim());
  if (!needle) return true;
  return [song.title, song.style, song.lyrics, song.lyricsSung ?? ""].some((t) => searchKey(t).includes(needle));
}
