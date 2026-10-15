// Pure rules for the settings page and the setup wizard (validation, warnings, precision choice).
import type { ComponentStatus } from "../api";

/**
 * ComfyUI release the app is tested against. Must equal src-tauri/src/setup.rs COMFYUI_VERSION
 * (checked by the `tested_comfyui_version_matches_setup_rs` test).
 */
export const TESTED_COMFYUI_VERSION = "0.37.0";

/**
 * Bounds of the song-length settings. 900 s is the native YuE2GenerateMusic max_duration maximum. The one
 * TS source of these numbers: they must equal src-tauri/src/config.rs MAX_DURATION_CAP / MIN_DURATION_LIMIT
 * (checked by the `duration_bounds_match_config_rules_ts` test).
 */
export const DURATION_LIMIT_MIN = 60;
export const DURATION_LIMIT_MAX = 900;
export const DURATION_DEFAULT_MIN = 8;
/** Native YuE2GenerateMusic max_duration maximum (ComfyUI v0.37.0); alias of DURATION_LIMIT_MAX. */
export const MAX_DURATION_CAP = DURATION_LIMIT_MAX;
/**
 * Longest song title (in characters) the backend keeps from GenerateParams.title; a longer one is cut. Must equal
 * src-tauri/src/jobs.rs REQUESTED_TITLE_CHARS (checked by the `requested_title_limit_matches_rules_ts` test).
 */
export const REQUESTED_TITLE_MAX_CHARS = 60;
const FALLBACK_LIMIT = DURATION_LIMIT_MAX;
const FALLBACK_DEFAULT = 360;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Normalise the two duration fields (on blur / save, never per keystroke): the limit to an integer in
 * [60, 900], the default to an integer in [8, limit]. Empty or invalid input falls back to 900 / 360.
 */
export function normalizeDurations(maxDurationLimit: number, defaultMaxDuration: number): { maxDurationLimit: number; defaultMaxDuration: number } {
  const limit = Math.round(clamp(Number.isFinite(maxDurationLimit) ? maxDurationLimit : FALLBACK_LIMIT, DURATION_LIMIT_MIN, DURATION_LIMIT_MAX));
  const def = Math.round(clamp(Number.isFinite(defaultMaxDuration) ? defaultMaxDuration : FALLBACK_DEFAULT, DURATION_DEFAULT_MIN, limit));
  return { maxDurationLimit: limit, defaultMaxDuration: def };
}

/**
 * Longest data root that is safe while Windows long paths are off (the default). The deepest installed file
 * is about 240 characters below the data root (a license file in torch's dist-info; the depth depends on the
 * torch / onnxruntime versions). The app, 7zr and the uninstaller handle longer paths, but pip (onnxruntime
 * files ~166 below the root) fails above ~92 characters and ComfyUI cannot import torch above ~140.
 */
export const DATA_ROOT_MAX_SAFE_LEN = 80;

/** Trim and remove one pair of surrounding double quotes (Explorer's 「パスのコピー」 adds them). */
export function cleanLocation(path: string): string {
  const t = path.trim();
  return (t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t).trim();
}

export type LocationKind = "data" | "out";

const LOCATION_LABEL: Record<LocationKind, string> = { data: "データルート", out: "楽曲の保存先" };

/**
 * Why `path` cannot be saved as the data root / song folder, or null. The same rules as
 * src-tauri/src/config.rs location_error (which rejects the save): an absolute path (C:\… or \\server\share\…)
 * below a drive or share root, no characters Windows forbids in names, no folder name ending in a space or
 * a period, and no ';' in the data root (the bundled ffmpeg is added to PATH).
 */
export function locationError(path: string, kind: LocationKind): string | null {
  const label = LOCATION_LABEL[kind];
  if (!path.trim()) return `${label}を指定してください`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return `${label}に制御文字が含まれています`;
  if (/[<>"|?*]/.test(path)) return `${label}に使えない文字（< > " | ? *）が含まれています`;
  if (path.split("").some((ch, i) => ch === ":" && i !== 1)) return `${label}の「:」はドライブ名（例: C:）の直後にだけ使えます`;
  if (kind === "data" && path.includes(";")) return `${label}に「;」は使えません（同梱の ffmpeg を見つけられなくなります）`;
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path);
  if (!drive && !unc) return `${label}には絶対パス（例: C:\\MCSYuE2）を指定してください`;
  const parts = path.split(/[\\/]+/).filter(Boolean).slice(drive ? 1 : 2);
  for (const p of parts) {
    if (p === "." || p === "..") return `${label}に「.」「..」は使えません`;
    if (/[ .]$/.test(p)) return `${label}のフォルダ名の末尾に空白やピリオドは使えません（「${p}」）`;
  }
  if (parts.length === 0) return `${label}にドライブ直下（例: D:\\）は指定できません。フォルダを作って指定してください`;
  return null;
}

/** The user's profile folder or one of its standard folders (Documents, Music, Desktop, …). */
function isShellFolder(path: string): boolean {
  return /^[A-Za-z]:\\Users\\[^\\]+(\\(Documents|Music|Desktop|Downloads|Pictures|Videos|OneDrive[^\\]*))?\\?$/i.test(path.replace(/\//g, "\\"));
}

/**
 * Advisory notes for the data root (saving is still allowed): `$` / `%` (ComfyUI runs os.path.expandvars on
 * extra_model_paths.yaml's base_path, so they can be rewritten to another folder even though the path is
 * quoted), a path longer than DATA_ROOT_MAX_SAFE_LEN, and a shared user folder.
 */
export function dataRootWarning(path: string): string | null {
  const notes: string[] = [];
  if (/[$%]/.test(path)) notes.push("パスに「$」または「%」が含まれています。ComfyUI が環境変数として展開し、モデルが見つからなくなる可能性があるため、別のフォルダを推奨します。");
  if (path.trim().length > DATA_ROOT_MAX_SAFE_LEN)
    notes.push(`パスが長すぎます（${path.trim().length} 文字）。Windows の長いパスが無効な環境では、pip での導入や ComfyUI の起動に失敗することがあります。${DATA_ROOT_MAX_SAFE_LEN} 文字以内（例: C:\\MCSYuE2）を推奨します。`);
  if (isShellFolder(path)) notes.push("ユーザーの共通フォルダそのものです。アプリ専用のフォルダ（例: C:\\MCSYuE2）を推奨します（アンインストール時の自動削除の対象外になります）。");
  return notes.length ? notes.join(" ") : null;
}

/**
 * Folders of the data root the app owns: the uninstaller's tools prompt removes each with everything in it, except
 * comfy_input\mcs_uploads, comfy_output\mcs and mcs_sep, where it deletes only the app's own files at the top (they
 * may have been the song folder once) and then the folder when it is left empty. The app prunes or replaces what is
 * in several of them (its ComfyUI outputs and staged inputs, the separation and alignment work folders, setup's
 * extraction folder). Must equal what src-tauri/windows/hooks.nsh McsDeleteDataRoot removes recursively (McsRMDirR)
 * or deletes the app's files in (McsDeleteOwnFiles), and so its McsOutputInDataRoot list (checked by a test).
 */
export const DATA_ROOT_OWNED_FOLDERS = [
  "runtime\\ComfyUI_windows_portable",
  "runtime\\bin",
  "runtime\\ffmpeg",
  "runtime\\llama",
  "runtime\\.mcs_extracting",
  "cache\\sep_work",
  "cache\\align_stems",
  "comfy_input\\mcs_uploads",
  "comfy_output\\mcs",
  "comfy_output\\mcs_sep",
] as const;

/** A folder path as Windows compares it: "\" separators (a UNC path keeps its leading pair), none at the end, any case. */
function folderKey(path: string): string {
  const p = path.trim();
  const body = p.replace(/[\\/]+/g, "\\").replace(/\\$/, "");
  return (/^[\\/]{2}/.test(p) ? `\\${body}` : body).toLowerCase();
}

/**
 * Advisory notes for the song folder: a folder of the data root the app owns (DATA_ROOT_OWNED_FOLDERS) or one
 * inside it, where songs can go with the app's clean-ups and the uninstaller cannot remove the tools (no check
 * without `dataRoot`), and the user's Music / Documents / … folder itself instead of a subfolder.
 */
export function outputDirWarning(path: string, dataRoot = ""): string | null {
  const root = folderKey(dataRoot);
  const out = folderKey(path);
  for (const d of root ? DATA_ROOT_OWNED_FOLDERS : []) {
    const key = `${root}\\${d.toLowerCase()}`;
    if (out === key || out.startsWith(`${key}\\`))
      return `データルートの中の、アプリが管理するフォルダ（${d}）${out === key ? "そのもの" : "の中"}です。アプリが作業ファイルを自動で削除するため曲が消えることがあり、アンインストール時もツールとモデルを自動では削除できません。データルートの外のフォルダ（例: …\\Music\\Music Creator Studio YuE2）を推奨します。`;
  }
  if (!isShellFolder(path)) return null;
  return "ユーザーの共通フォルダそのものです。アプリ専用のサブフォルダ（例: …\\Music\\Music Creator Studio YuE2）を推奨します（アンインストール時の自動削除の対象外になります）。";
}

export type Precision = "bf16" | "int8";

const CHECKPOINT_COMPONENT: Record<Precision, string> = { bf16: "yue2_bf16", int8: "yue2_int8" };

/** Whether each precision's checkpoint is installed. `null` while the component list is not loaded. */
export function installedPrecisions(comps: ComponentStatus[]): Record<Precision, boolean> | null {
  if (!comps.length) return null;
  const has = (id: string) => comps.some((c) => c.id === id && c.installed);
  return { bf16: has(CHECKPOINT_COMPONENT.bf16), int8: has(CHECKPOINT_COMPONENT.int8) };
}

/**
 * VRAM (MiB) from which the BF16 model fits comfortably; below it the wizard prefers INT8. The same line as
 * src-tauri/src/lib.rs free_comfy_for_llm (20000 MiB), which frees ComfyUI for the local LLM on smaller cards.
 */
export const BF16_MIN_VRAM_MIB = 20000;
/** VRAM (MiB) below which even the INT8 model may not fit (setup wizard hint). */
export const INT8_MIN_VRAM_MIB = 10000;

/**
 * Precision chosen when the wizard finishes: when it may choose (`firstSetup`: wizardMayChoosePrecision, a first setup
 * or a re-run while the user never chose a precision in Settings), INT8 below BF16_MIN_VRAM_MIB when its checkpoint
 * is installed. Otherwise (an explicit choice survives a re-run) the current choice is kept, unless its checkpoint
 * is missing and the other one is installed.
 */
export function autoPrecision(vramMib: number | null | undefined, comps: ComponentStatus[], current: Precision, firstSetup = true): Precision {
  const inst = installedPrecisions(comps);
  if (firstSetup && vramMib != null && vramMib > 0 && vramMib < BF16_MIN_VRAM_MIB && inst?.int8) return "int8";
  if (inst && !inst[current]) {
    if (inst.bf16) return "bf16";
    if (inst.int8) return "int8";
  }
  return current;
}

/**
 * Whether the setup wizard may choose the precision (autoPrecision's `firstSetup`): on a first setup, also
 * one that resumes after the app was closed during the downloads (the license is accepted before them), and
 * on any run while the user never chose a precision in Settings. An explicit choice survives a re-run.
 */
export function wizardMayChoosePrecision(config: { licenseAccepted?: boolean; precisionExplicit?: boolean } | null | undefined): boolean {
  return !config?.licenseAccepted || !config?.precisionExplicit;
}

/** Official YuE2 nodes the app's graphs need; a missing one means the ComfyUI build itself lacks YuE2. */
export function isNativeYue2Node(name: string): boolean {
  return /^(YuE2|EmptyYuE2)/.test(name);
}

/** Every required setup component is installed (the wizard may finish; a re-run may return to the app). */
export function requiredInstalled(comps: ComponentStatus[]): boolean {
  const required = comps.filter((c) => c.required);
  return required.length > 0 && required.every((c) => c.installed);
}

/**
 * Components pre-selected on the wizard's download step: the missing required ones, and the usual optional
 * ones (`optionalDefaultOn`) only while a required one is still missing, i.e. on a first setup (also one
 * resumed after a restart). A re-run to add a small component does not pre-select gigabytes the user skipped.
 */
export function defaultSetupSelection(comps: ComponentStatus[], optionalDefaultOn: ReadonlySet<string>): Set<string> {
  const firstSetup = comps.some((c) => c.required && !c.installed);
  const sel = new Set<string>();
  for (const c of comps) if (!c.installed && (c.required || (firstSetup && optionalDefaultOn.has(c.id)))) sel.add(c.id);
  return sel;
}

/** Setup progress phase of a component the user stopped with 中断 (not an error). */
export function isCancelledPhase(phase: string): boolean {
  return phase === "cancelled";
}

/** Why the two ports cannot be saved, or null (same rules as config.rs AppConfig::validate). */
export function portsError(comfyPort: number, llmPort: number): string | null {
  const bad = (p: number) => !Number.isInteger(p) || p < 1 || p > 65535;
  if (bad(comfyPort)) return "ComfyUI ポートは 1〜65535 の整数で指定してください";
  if (bad(llmPort)) return "LLM ポートは 1〜65535 の整数で指定してください";
  if (comfyPort === llmPort) return "ComfyUI ポートと LLM ポートは別の番号にしてください";
  return null;
}

/**
 * An http:// Base URL to another machine: the API key would travel unencrypted. Loopback means localhost,
 * *.localhost, [::1] and an IPv4 literal 127.x.x.x (not a host name that merely starts with "127.").
 */
export function isInsecureRemoteUrl(url: string): boolean {
  const m = /^http:\/\/(\[[^\]]*\]|[^/:?#]+)/i.exec(url.trim());
  if (!m) return false;
  const host = m[1].toLowerCase();
  return !(host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host));
}

/**
 * scheme://host[:port] of an http(s) Base URL (default ports dropped, as src-tauri/src/llm.rs url_origin
 * does), or null for anything else.
 */
export function urlOrigin(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The stored OpenAI key is bound to another origin than the Base URL: the backend refuses to send it there until
 * a key is entered again. False while the key is not bound yet or the URL is not a valid http(s) URL.
 */
export function openaiKeyOriginMismatch(boundOrigin: string | null | undefined, baseUrl: string): boolean {
  if (!boundOrigin) return false;
  const origin = urlOrigin(baseUrl);
  return origin !== null && origin !== boundOrigin;
}

/**
 * The API keys 「LLM 設定を保存」 hands to save_secrets (null leaves the saved key as it is). Typed keys are trimmed,
 * and a field holding only spaces changes nothing: only 「キーを削除」 deletes a key (it sends ""). An OpenAI-compatible
 * key is held back while the settings could not be saved (`configSaved` false): the backend binds it to the Base URL
 * of its first request, which would be the old saved one instead of the one typed next to the key.
 */
export function apiKeysToSave(anthropicKey: string, openaiKey: string, configSaved: boolean): { anthropic: string | null; openai: string | null; openaiHeld: boolean } {
  const a = anthropicKey.trim();
  const o = openaiKey.trim();
  return { anthropic: a || null, openai: o && configSaved ? o : null, openaiHeld: Boolean(o) && !configSaved };
}

/**
 * The notice after 「LLM 設定を保存」. Null when only the settings failed: save() already showed that error. Otherwise
 * it replaces that toast, so it repeats the error.
 */
export function llmSaveNotice(o: { saveError: string | null; keysSaved: boolean; openaiHeld: boolean }): { kind: "success" | "error"; text: string } | null {
  if (o.saveError === null) return { kind: "success", text: o.keysSaved ? "設定と API キーを保存しました" : "設定を保存しました" };
  const held = "OpenAI 互換 API のキーはまだ保存していません（Base URL と一緒に保存します。設定を直してから、もう一度「LLM 設定を保存」を押してください）";
  if (o.keysSaved && o.openaiHeld) return { kind: "error", text: `Anthropic の API キーは保存しましたが、設定を保存できませんでした: ${o.saveError}。${held}` };
  if (o.keysSaved) return { kind: "error", text: `API キーは保存しましたが、設定を保存できませんでした: ${o.saveError}` };
  if (o.openaiHeld) return { kind: "error", text: `設定を保存できませんでした: ${o.saveError}。${held}` };
  return null;
}

/**
 * Tells a ComfyUI start (設定 「起動」) that 「停止」 ended from one that failed: a stop while the start waits makes
 * the start report 「ComfyUI プロセスが終了しました」. `start` resolves false instead of rejecting when a stop was
 * sent while it ran. A refused stop does not count (the process runs on, so the start's own failure still shows).
 */
export class ComfyStopTracker {
  private sent = 0;

  async stop(call: () => Promise<void>): Promise<void> {
    // counted before the call: the start can fail before this call returns
    this.sent++;
    try {
      await call();
    } catch (e) {
      this.sent--;
      throw e;
    }
  }

  async start(call: () => Promise<void>): Promise<boolean> {
    const before = this.sent;
    try {
      await call();
      return true;
    } catch (e) {
      if (this.sent !== before) return false;
      throw e;
    }
  }
}

/** Why 「VRAM を解放」 is unavailable (its tooltip), or null: it is a request to a ComfyUI that answers. */
export function freeVramBlock(comfy: { alive: boolean; processRunning: boolean } | null): string | null {
  if (comfy?.alive) return null;
  return comfy?.processRunning ? "ComfyUI の起動中です。起動が終わってから実行してください" : "ComfyUI は停止しています";
}

/**
 * Default context size (tokens) of the local LLM. Must equal src-tauri/src/llm.rs LlmSettings::defaults (checked by
 * the `default_context_size_matches_rules_ts` test).
 */
export const LLM_CONTEXT_SIZE_DEFAULT = 16384;
/** Context sizes (tokens) offered for the local LLM. */
const LLM_CONTEXT_SIZES = [8192, LLM_CONTEXT_SIZE_DEFAULT, 24576, 32768];

/**
 * The context size choices, with the configured value added when it is another (hand-set) one, so the select
 * shows the real setting. 0 is kept too: llama-server's -c 0 takes the size from the model.
 */
export function llmContextSizeOptions(current: number): number[] {
  if (!Number.isInteger(current) || current < 0 || LLM_CONTEXT_SIZES.includes(current)) return [...LLM_CONTEXT_SIZES];
  return [...LLM_CONTEXT_SIZES, current].sort((a, b) => a - b);
}

/** Label of a context size choice. */
export function llmContextSizeLabel(n: number): string {
  if (n === 0) return "0（モデルの設定値）";
  return `${n.toLocaleString("ja-JP")}${n === LLM_CONTEXT_SIZE_DEFAULT ? "（既定）" : ""}`;
}

export interface SettingsSaveChanges {
  vaeChanged: boolean;
  comfyPortChanged: boolean;
  dataRootChanged: boolean;
  /** a ComfyUI this app did not start answers (its launch flags cannot be changed from here) */
  externalComfy: boolean;
  /** this app's own ComfyUI process runs (the backend restarts it with the new launch settings once idle) */
  comfyProcessRunning: boolean;
  /** the required components are installed at the saved data root (null: unknown) */
  dataRootReady: boolean | null;
  llmPortChanged: boolean;
  llmProcessRunning: boolean;
}

/** Notes shown after 「設定を保存しました」 for settings that take effect later (or not at all). */
export function settingsSaveNotes(c: SettingsSaveChanges): string[] {
  const notes: string[] = [];
  if (c.dataRootChanged && c.dataRootReady === false) {
    // The backend still restarts its ComfyUI at the new root, where the start fails: say what to do instead.
    notes.push(
      `データルートを変更しました。新しい場所には必要なコンポーネントがまだないため、「セットアップをやり直す」で新しい場所にセットアップしてから ComfyUI を起動してください${
        c.comfyProcessRunning ? "（動作中の ComfyUI は、空き次第停止します）" : ""
      }`,
    );
  } else if (c.vaeChanged || c.comfyPortChanged || c.dataRootChanged) {
    if (c.vaeChanged && c.externalComfy && !c.comfyPortChanged) notes.push("このアプリが起動していない ComfyUI が動作中のため、VAE 精度の変更は反映されません");
    else if (c.comfyProcessRunning) notes.push("ComfyUI の起動設定の変更は、ComfyUI が空き次第（生成やツールの実行中なら終わってから）再起動して反映します");
  }
  if (c.llmPortChanged && c.llmProcessRunning) notes.push("LLM ポートの変更は、次の AI リクエストで LLM を再起動して反映します");
  return notes;
}
