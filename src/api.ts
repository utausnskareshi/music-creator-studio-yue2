// Typed wrappers around the Tauri commands.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AppConfig {
  dataRoot: string;
  outputDir: string;
  comfyPort: number;
  llmPort: number;
  precision: "bf16" | "int8";
  /** the user chose the precision in Settings (the setup wizard then keeps it) */
  precisionExplicit?: boolean;
  freeVramAfterGeneration: boolean;
  defaultMaxDuration: number;
  maxDurationLimit: number;
  licenseAccepted: boolean;
  setupCompleted: boolean;
  llm: LlmSettings;
  /** Launch ComfyUI with --fp32-vae (official runtime decodes in FP32; more VRAM; needs a ComfyUI restart) */
  vaeFp32: boolean;
  /** VAE decode node: auto (fits next to the model -> plain, else tiled) / plain (official template) / tiled */
  vaeDecode: "auto" | "plain" | "tiled";
}

export interface LlmSettings {
  provider: "local" | "anthropic" | "openai";
  localModel: string;
  contextSize: number;
  gpuLayers: number;
  thinking: boolean;
  /** cap the thinking per request (lyrics draft 1,024 / score edit 4,096 tokens) so the reply always has room for its answer */
  limitThinking: boolean;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  temperature: number;
  unloadBeforeGeneration: boolean;
}

export interface LlmStatus {
  provider: string;
  processRunning: boolean;
  alive: boolean;
  port: number;
  model: string | null;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  localModels: string[];
  /** a llama-server answers on the LLM port but this app did not start it (it cannot stop or restart it) */
  external: boolean;
  /** this app's llama-server runs with other settings than the config; the next AI request restarts it */
  restartRequired: boolean;
  /** origin (scheme://host:port) the stored OpenAI key is sent to; null until its first use */
  openaiKeyOrigin: string | null;
}

export interface ChatMessage { role: "user" | "assistant" | "system"; content: string }

export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** of the whole request, a retry included */
  seconds: number;
  provider: string;
  /** 1, or 2 when the reply came from the second try of a draft (see onLlmRetry) */
  attempts: number;
}

/** "llm://retry": a request is being sent once more (a local draft whose first reply ran to the length limit, without thinking this time). */
export interface LlmRetry {
  purpose: "draft" | "edit";
}

export interface EditReply {
  abc: string;
  style: string;
  lyrics: string;
  explanation: string;
  raw: string;
  promptTokens: number;
  completionTokens: number;
  seconds: number;
  provider: string;
}

export interface ComponentStatus {
  id: string;
  name: string;
  description: string;
  url: string;
  kind: "file" | "seven_zip" | "zip" | "pip";
  dest: string;
  size: number;
  sha256: string | null;
  required: boolean;
  marker: string;
  /** zip: the archive's top-level folder is stripped when extracting */
  stripRoot: boolean;
  installed: boolean;
  installedBytes: number;
}

export interface SetupProgress {
  id: string;
  /** cancelled: the user stopped the install (resumable, not an error) */
  phase: "download" | "verify" | "extract" | "done" | "error" | "cancelled";
  downloaded: number;
  total: number;
  bytesPerSec: number;
  message: string;
}

/** setup://finished: a setup_install run ended. error: what the run failed with (as its call rejects), null on success. */
export interface SetupFinished {
  error: string | null;
}

/** Start of the error setup_install is refused with while a run goes on (lib.rs SETUP_ALREADY_RUNNING). */
export const SETUP_ALREADY_RUNNING = "セットアップは既に実行中です";
/** Error of a setup run the user stopped with 中断 (setup.rs CANCELLED_MSG); the next start resumes the downloads. */
export const SETUP_CANCELLED_ERROR = "ユーザーが中断しました（再開できます）";

/** setup_install was refused because a run goes on (the page was reloaded meanwhile: the backend keeps running it). */
export function isSetupAlreadyRunning(e: unknown): boolean {
  return String(e).trim().startsWith(SETUP_ALREADY_RUNNING);
}

/** The setup run failed only because it was stopped with 中断. */
export function isSetupCancelled(e: unknown): boolean {
  return String(e).trim() === SETUP_CANCELLED_ERROR;
}

export interface SystemCheck {
  gpuName: string | null;
  driverVersion: string | null;
  vramMib: number | null;
  driverOk: boolean;
  /** free space on the data root's drive; null when Windows tells none (e.g. for a data root this account cannot read) */
  freeDiskGib: number | null;
  dataRootExists: boolean;
  /**
   * The data root exists but this account cannot use it (setup's message, as ダウンロード開始 would fail with).
   * Where it cannot even be read, freeDiskGib is null and every component looks not installed; a folder that can be
   * read but not written (a read-only share, コントロールされたフォルダー アクセス) shows both as they are.
   */
  dataRootError: string | null;
  /** nvidia-smi did not answer and was stopped (the GPU fields are then empty though a GPU may be there) */
  gpuProbeTimedOut: boolean;
}

/** The data root's fields of SystemCheck alone (data_root_check: no nvidia-smi). */
export type DataRootCheck = Pick<SystemCheck, "freeDiskGib" | "dataRootExists" | "dataRootError">;

export interface ComfyStatus {
  processRunning: boolean;
  alive: boolean;
  port: number;
  comfyuiVersion: string | null;
  pytorchVersion: string | null;
  gpuName: string | null;
  vramTotal: number;
  vramUsed: number;
  hasWavSaver: boolean;
  queueRunning: number;
  queuePending: number;
  activeSongId: string | null;
  /** Tool runs (転写・分離・整列・譜面の計画) in flight, from their start to saving their outputs */
  toolsInFlight: number;
  /** ComfyUI version this app is tested with */
  expectedComfyuiVersion: string;
  /** The running server reports another version (warning only) */
  versionMismatch: boolean;
  /** Checked nodes the server lacks (native YuE2 ones block generation; MCS_* ones only disable features) */
  missingNodes: string[];
  /** MCS_YuE2Status is available (exact truncation flag) */
  hasStatusNode: boolean;
  /** The app's ComfyUI process runs with --fp32-vae */
  vaeFp32Active: boolean;
  /** The app's ComfyUI runs with another VAE precision than the settings (restarts when idle) */
  restartRequired: boolean;
}

export interface ComfyEvent {
  kind: string;
  promptId: string | null;
  node: string | null;
  value: number | null;
  max: number | null;
  output: unknown;
  message: string | null;
  queueRemaining: number | null;
}

export interface GenerateParams {
  /** song title; the backend derives one from the lyrics / style when omitted */
  title?: string;
  style: string;
  /** Text sent to the model (hiragana version for Japanese when available) */
  lyrics: string;
  /** Lyrics as written (kanji); stored with the song and used for tags / synced lyrics */
  lyricsDisplay?: string;
  mode: "full" | "melody" | "off";
  abc: string;
  seed: number;
  maxDuration: number;
  abcTemperature?: number;
  abcTopP?: number;
  abcTopK?: number;
  abcRepetitionPenalty?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  cfgScale?: number;
  steps?: number;
  /** instrumental render: the untouched source score (the plan) before the Vocal -> Ins transfer */
  sourceAbc?: string;
  /** instrumental render: notes moved from Vocal into Ins, and overlaps adjusted */
  instrumentalTransfer?: { movedNotes: number; overlaps: number };
  /** instrumental render planned for it: the planner's own inputs */
  plan?: { style: string; lyrics: string; mode: string; seed: number; abcTemperature: number };
}

export interface Song {
  id: string;
  createdAt: string;
  title: string;
  style: string;
  lyrics: string;
  /** Text that was actually sung (hiragana version); empty when identical to lyrics */
  lyricsSung: string;
  mode: string;
  seed: number;
  abc: string;
  duration: number;
  audioPath: string;
  folder: string;
  paramsJson: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  error: string;
  parentId: string | null;
  wallSeconds: number;
  peakVramGib: number;
  /** The music token budget ran out (the song may stop mid-phrase); null = unknown (older songs) */
  truncatedSemantic?: boolean | null;
  /** The ABC planner used its whole token budget; null = unknown / not planned by YuE2 */
  truncatedAbc?: boolean | null;
  /** Music budget ComfyUI actually used (s); below maxDuration when it was shortened for a long prompt. null = unknown */
  effectiveMaxSeconds?: number | null;
}

export interface JobUpdate {
  song: Song;
  promptId: string | null;
  stage: string;
}

export interface ToolProgress {
  tool: "transcribe" | "separate" | "align" | "plan" | (string & {});
  /** the last event of a cancelled run (api.cancelTool) has stage TOOL_CANCELLED_STAGE, done and no error */
  stage: string;
  /** set from the 処理中 event on, once ComfyUI accepted the prompt (needed by api.cancelTool) */
  promptId: string | null;
  done: boolean;
  error: string | null;
  /** the runId the page passed to the tool call (on every event of that run; null for a call without one) */
  runId?: string | null;
}

export interface SeparationResult {
  vocalsPath: string;
  instrumentalPath: string;
  folder: string;
}

export interface AlignedWord { text: string; start: number; end: number; score: number }
export interface AlignedLine { index: number; line: string; start: number; end: number; words: AlignedWord[] }
export interface LyricLine { timeMs: number; text: string }
export interface ExportRequest {
  source: string;
  dest: string;
  format: "wav16" | "wav24" | "wav32f" | "flac" | "mp3" | "m4a" | "ogg" | "opus";
  bitrateKbps: number;
  mp3Vbr: number | null;
  loudnorm: boolean;
  targetLufs: number;
  fadeInSec: number;
  fadeOutSec: number;
  trimSilence: boolean;
  /** Hard-clip samples above 0 dBFS (only applied when loudnorm is off). */
  hardClip?: boolean;
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  comment: string;
  coverImage: string | null;
  lyrics: string;
  synced: LyricLine[];
  writeLrc: boolean;
  language: string;
}
export interface ExportResult { dest: string; lrcPath: string | null; bytes: number; ffmpegSeconds: number; warnings?: string[] }

/** Final tool://progress stage of a cancelled tool run (neutral, not an error). */
export const TOOL_CANCELLED_STAGE = "キャンセル";
/** Error a cancelled tool call rejects with (transcribeAudio, separateAudio, alignLyrics, planScore). */
export const TOOL_CANCELLED_ERROR = "キャンセルしました";

/** The tool call failed only because the user cancelled it (no error toast needed). */
export function isToolCancelled(e: unknown): boolean {
  return String(e).trim() === TOOL_CANCELLED_ERROR;
}

/** Waveform overview of an audio file (audio_peaks): per-channel peaks and the duration in seconds. */
export interface AudioPeaks {
  peaks: number[][];
  duration: number;
}

/** A song folder delete_song left on disk (lib.rs KeptFolder). */
export interface KeptFolder {
  path: string;
  /** its drive or network share cannot be reached now (else: not confirmed as the song's own folder) */
  unreachable: boolean;
}

/**
 * What is still running when the user closes the window (app://close-requested). The backend then keeps the
 * window open until the user confirms (app_exit). Every field is optional so an older or partial payload still
 * yields a message.
 */
export interface CloseRequest {
  /** a song is being generated */
  generating?: boolean;
  /** title of the song being generated */
  activeTitle?: string | null;
  /** songs waiting in the queue */
  queued?: number;
  /** transcription / separation / alignment / planning runs */
  tools?: number;
  /** export_audio runs */
  exports?: number;
  /** the setup wizard is downloading or installing */
  setup?: boolean;
  /** the backend's ready-made question for the dialog */
  message?: string;
  /** the backend's note for the dialog (closing the window again right away quits without asking) */
  hint?: string;
}

/** The lines listing what a close would interrupt (empty when the payload names nothing). */
export function closeRequestLines(r: CloseRequest | null | undefined): string[] {
  if (!r || typeof r !== "object") return [];
  const out: string[] = [];
  if (r.generating) out.push(r.activeTitle ? `生成中の曲：「${r.activeTitle}」` : "曲を生成中です");
  if (typeof r.queued === "number" && r.queued > 0) out.push(`待機中の曲：${r.queued} 曲`);
  if (typeof r.tools === "number" && r.tools > 0) out.push(`音声の処理（転写・分離・歌詞の整列・譜面の計画）：${r.tools} 件`);
  if (typeof r.exports === "number" && r.exports > 0) out.push(`書き出し：${r.exports} 件`);
  if (r.setup) out.push("セットアップ（ダウンロード・展開）を実行中です");
  return out;
}

/**
 * The close question, its detail lines and the backend's note (hint). The backend's own message is used when it
 * sends one; the details then keep only what it does not say (the song's title, the counts). Queued songs are
 * mentioned only when there are some, or when the payload says nothing about what runs.
 */
export function closeRequestDialog(r: CloseRequest | null | undefined): { message: string; details: string[]; note?: string } {
  const lines = closeRequestLines(r);
  const note = r && typeof r === "object" && typeof r.hint === "string" && r.hint.trim() ? r.hint.trim() : undefined;
  if (r && typeof r === "object" && typeof r.message === "string" && r.message.trim()) {
    const specific = lines.filter((l) => l.includes("「") || /\d/.test(l));
    return { message: r.message.trim(), details: specific, note };
  }
  const queued = lines.length === 0 || (typeof r?.queued === "number" && r.queued > 0);
  return {
    message: `実行中の処理があります。終了すると中断されます${queued ? "（待機中の曲も生成されません）" : ""}。終了しますか？`,
    details: lines,
    note,
  };
}

export interface AppPaths {
  configPath: string;
  logDir: string;
  comfyLog: string;
  appVersion: string;
}

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  /** notices from this launch start (an unusable config.json / secrets.json); each is returned once */
  takeStartupNotices: () => invoke<string[]>("take_startup_notices"),
  saveConfig: (config: AppConfig) => invoke<AppConfig>("save_config", { config }),
  appPaths: () => invoke<AppPaths>("app_paths"),
  systemCheck: () => invoke<SystemCheck>("system_check"),
  /** the data root's part of systemCheck, without nvidia-smi (a hung driver keeps that waiting for its timeout) */
  dataRootCheck: () => invoke<DataRootCheck>("data_root_check"),
  setupStatus: () => invoke<ComponentStatus[]>("setup_status"),
  setupInstall: (ids: string[]) => invoke<void>("setup_install", { ids }),
  setupCancel: () => invoke<void>("setup_cancel"),
  setupFinalize: () => invoke<void>("setup_finalize"),
  comfyStatus: () => invoke<ComfyStatus>("comfy_status"),
  comfyStart: () => invoke<void>("comfy_start"),
  comfyStop: () => invoke<void>("comfy_stop"),
  comfyFreeVram: () => invoke<void>("comfy_free_vram"),
  generate: (params: GenerateParams) => invoke<Song>("generate", { params }),
  /** `queuedOnly`: only while it waits in the queue (「待機中をすべてキャンセル」 leaves a song that has just started). */
  cancelJob: (songId: string, queuedOnly = false) => invoke<void>("cancel_job", { songId, queuedOnly }),
  listSongs: (limit = 500) => invoke<Song[]>("list_songs", { limit }),
  renameSong: (id: string, title: string) => invoke<void>("rename_song", { id, title }),
  /** Resolves with the song folder that was kept and why, or null when nothing was kept. */
  deleteSong: (id: string, deleteFiles: boolean) => invoke<KeptFolder | null | undefined>("delete_song", { id, deleteFiles }).then((kept) => kept ?? null),
  estimateDuration: (lyrics: string) => invoke<number>("estimate_duration", { lyrics }),
  fileUrl: (path: string) => invoke<string>("file_url", { path }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  readBinaryFile: (path: string) => invoke<number[]>("read_binary_file", { path }),
  /** Resolves with the path actually written (a missing .mid is appended to the typed name). */
  writeBinaryFile: (path: string, data: number[]) => invoke<string>("write_binary_file", { path, data }),
  /** Resolves with the path actually written (a missing .abc is appended to the typed name). */
  writeTextFile: (path: string, text: string) => invoke<string>("write_text_file", { path, text }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  // runId (optional, every tool call): echoed in the run's tool://progress events, so a page follows only its own run.
  transcribeAudio: (path: string, mode: "melody" | "full", runId?: string | null) => invoke<string>("transcribe_audio", { path, mode, runId: runId ?? null }),
  /** purpose "align": stems made only for automatic lyric timing (kept apart from the separation page's stems) */
  separateAudio: (path: string, model: string, songId?: string | null, purpose?: "align" | null, runId?: string | null) =>
    invoke<SeparationResult>("separate_audio", { path, model, songId: songId ?? null, purpose: purpose ?? null, runId: runId ?? null }),
  separationModels: () => invoke<string[]>("separation_models"),
  alignLyrics: (path: string, lyrics: string, language: string, runId?: string | null) => invoke<AlignedLine[]>("align_lyrics", { path, lyrics, language, runId: runId ?? null }),
  exportAudio: (request: ExportRequest) => invoke<ExportResult>("export_audio", { request }),
  audioDuration: (path: string) => invoke<number | null>("audio_duration", { path }),
  /** Waveform peaks computed by the backend, so the player streams the file instead of downloading and decoding it whole. */
  audioPeaks: (path: string, buckets?: number) => invoke<AudioPeaks>("audio_peaks", { path, buckets: buckets ?? null }),
  /** Quit after the user confirmed a close request (runs the normal ComfyUI / LLM shutdown). */
  appExit: () => invoke<void>("app_exit"),
  /** Cancel a tool run by the promptId of its tool://progress events; the call then rejects with TOOL_CANCELLED_ERROR. */
  cancelTool: (promptId: string) => invoke<void>("cancel_tool", { promptId }),
  llmStatus: () => invoke<LlmStatus>("llm_status"),
  llmStart: () => invoke<void>("llm_start"),
  llmStop: () => invoke<void>("llm_stop"),
  saveSecrets: (anthropicApiKey: string | null, openaiApiKey: string | null) => invoke<void>("save_secrets", { anthropicApiKey, openaiApiKey }),
  /** sungLyrics: the hiragana reading actually sung (read-only context for syllable counts) */
  /** requestId: api.llmCancel(requestId) ends the request; the call then rejects with TOOL_CANCELLED_ERROR */
  llmEdit: (abc: string, style: string, lyrics: string, history: ChatMessage[], instruction: string, sungLyrics?: string | null, requestId?: string | null) =>
    invoke<EditReply>("llm_edit", { abc, style, lyrics, history, instruction, sungLyrics: sungLyrics ?? null, requestId: requestId ?? null }),
  /** abcTemperature defaults to the official planner value (0.7); the seed is always the caller's (stored with the render) */
  planScore: (style: string, lyrics: string, mode: "full" | "melody", seed: number, abcTemperature?: number | null, runId?: string | null) =>
    invoke<string>("plan_score", { style, lyrics, mode, seed, abcTemperature: abcTemperature ?? null, runId: runId ?? null }),
  llmComplete: (system: string, user: string, schema: unknown | null, requestId?: string | null) => invoke<ChatResult>("llm_complete", { system, user, schema, requestId: requestId ?? null }),
  /** Cancel an LLM request by the requestId given to llmEdit / llmComplete (the local server keeps running). */
  llmCancel: (requestId: string) => invoke<void>("llm_cancel", { requestId }),
  createDiagnosticBundle: () => invoke<string>("create_diagnostic_bundle"),
  onToolProgress: (cb: (p: ToolProgress) => void): Promise<UnlistenFn> => listen<ToolProgress>("tool://progress", (e) => cb(e.payload)),

  onSetupProgress: (cb: (p: SetupProgress) => void): Promise<UnlistenFn> => listen<SetupProgress>("setup://progress", (e) => cb(e.payload)),
  /** The end of every setup_install run, also of one a reloaded page did not start (its call is gone with the old page). */
  onSetupFinished: (cb: (f: SetupFinished) => void): Promise<UnlistenFn> => listen<SetupFinished>("setup://finished", (e) => cb(e.payload)),
  onLlmRetry: (cb: (r: LlmRetry) => void): Promise<UnlistenFn> => listen<LlmRetry>("llm://retry", (e) => cb(e.payload)),
  onComfyEvent: (cb: (e: ComfyEvent) => void): Promise<UnlistenFn> => listen<ComfyEvent>("comfy://event", (e) => cb(e.payload)),
  onJobUpdate: (cb: (u: JobUpdate) => void): Promise<UnlistenFn> => listen<JobUpdate>("job://update", (e) => cb(e.payload)),
  onCloseRequested: (cb: (r: CloseRequest) => void): Promise<UnlistenFn> => listen<CloseRequest>("app://close-requested", (e) => cb(e.payload)),
};

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function formatSeconds(s: number): string {
  if (!isFinite(s) || s < 0) return "--:--";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}
