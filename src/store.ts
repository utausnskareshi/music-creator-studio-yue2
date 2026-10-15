import { create } from "zustand";
import { api, type AppConfig, type ComfyEvent, type ComfyStatus, type JobUpdate, type Song } from "./api";

export type Page = "compose" | "cover" | "edit" | "separate" | "export" | "library" | "settings";

export interface ProgressState {
  promptId: string | null;
  songId: string | null;
  stage: string;
  node: string | null;
  value: number;
  max: number;
  startedAt: number | null;
  log: string[];
}

export type ToastKind = "info" | "error" | "success";

export interface Toast {
  /** increases with every toast, so a timer only clears the toast it started for */
  id: number;
  kind: ToastKind;
  text: string;
  /** stays until the user closes it or another toast replaces it */
  sticky: boolean;
}

export interface ToastOptions {
  /** display time in ms (default: 15 s for errors, 6 s otherwise) */
  ms?: number;
  sticky?: boolean;
}

export interface SelectOptions {
  follow?: boolean;
}

/** A song deleted from the library (pages that hold its files let go of them). */
export interface DeletedSong {
  id: string;
  /** its folder was kept (outside the song folder): its files still exist */
  kept: boolean;
  /** counts every delete, so the same id deleted again is seen as new */
  n: number;
}

/** A question a hidden page asked; it waits until that page is shown (ChoiceDialog). */
export interface WaitingQuestion {
  id: number;
  page: Page;
  title: string;
}

export interface FollowState {
  /** the selection may follow new results (see AppStore.followSelection) */
  follow?: boolean;
  /** unsaved score edits: never follow */
  scoreDirty?: boolean;
}

interface AppStore {
  config: AppConfig | null;
  page: Page;
  comfy: ComfyStatus | null;
  songs: Song[];
  /** how many of the newest songs the library loads (grows with 「さらに読み込む」) */
  songLimit: number;
  /** the last load was cut at the limit: older songs may not be loaded */
  moreSongs: boolean;
  selectedSongId: string | null;
  /** the selection follows new results on 作曲 (set by auto-select and by a submit; a hand pick clears it) */
  followSelection: boolean;
  /** a score editor holds unsaved edits of the selected song: a finished job must not replace the selection */
  scoreDirty: boolean;
  progress: ProgressState;
  toast: Toast | null;
  /**
   * sticky toasts another toast is shown over (oldest first): they come back when that one goes, so a hidden
   * page's question notice or an unread failure is not lost to a passing notice
   */
  toastsBehind: Toast[];
  /** questions of hidden pages (the sidebar marks their pages until the question is shown or dropped) */
  waitingQuestions: WaitingQuestion[];
  /** the last song deleted in the library */
  lastDeletedSong: DeletedSong | null;
  /** the help dialog is open with this page's help (its ヘルプ button or F1; HelpDialog.tsx) */
  help: Page | null;

  setPage: (p: Page) => void;
  openHelp: (p: Page) => void;
  closeHelp: () => void;
  loadConfig: () => Promise<void>;
  saveConfig: (c: AppConfig) => Promise<void>;
  refreshComfy: () => Promise<void>;
  refreshSongs: () => Promise<void>;
  /** load SONG_PAGE more of the older songs */
  loadMoreSongs: () => Promise<void>;
  /** `follow`: keep showing new results on 作曲 (a submit); a hand pick leaves it off */
  selectSong: (id: string | null, opts?: SelectOptions) => void;
  /** reported by the page whose score editor has unsaved edits (it clears the flag again on unmount) */
  setScoreDirty: (dirty: boolean) => void;
  applyJobUpdate: (u: JobUpdate) => void;
  applyComfyEvent: (e: ComfyEvent) => void;
  showToast: (kind: ToastKind, text: string, opts?: ToastOptions) => void;
  /** closes the toast shown (a sticky toast it covered comes back) */
  dismissToast: () => void;
  /** removes a toast with this text, shown or kept behind (e.g. a question notice whose question is on screen now) */
  dropToastText: (text: string) => void;
  setWaitingQuestion: (q: WaitingQuestion) => void;
  clearWaitingQuestion: (id: number) => void;
  songDeleted: (id: string, kept: boolean) => void;
}

/** How many covered sticky toasts are kept. */
const TOASTS_BEHIND_MAX = 3;

const NODE_LABELS: Record<string, string> = {
  loader: "モデルを読み込み中",
  abc: "ABC 譜面を計画中",
  abc_preview: "譜面を取得",
  transcribe: "音源を譜面に転写中",
  music: "音楽トークンを生成中",
  seconds_preview: "曲長を確定",
  negative: "条件を準備",
  latent: "潜在空間を準備",
  sampler: "音響レンダリング中",
  decode: "音声にデコード中",
  save: "音声を保存中",
  info: "音声を解析中",
  mcs_status: "打ち切りを確認",
  cover_audio: "参考音源を読み込み",
  audio_encoder: "SheetSage2 を読み込み",
  src: "音源を読み込み",
  sep: "ボーカルを分離中",
  save_v: "ボーカルを保存",
  save_i: "伴奏を保存",
};

export const nodeLabel = (n: string | null) => (n ? NODE_LABELS[n] ?? n : "");

/** Songs per library load, and the step of 「さらに読み込む」. */
export const SONG_PAGE = 500;
/** Progress log lines kept (the newest). */
export const LOG_LINES = 40;
const TOAST_MS = 6000;
const ERROR_TOAST_MS = 15000;

/** Pages whose form is loaded from the selected song: a finished background job must not replace it there. */
const FORM_PAGES: ReadonlySet<Page> = new Set<Page>(["export", "edit", "separate"]);

/**
 * Whether a song that just finished should become the selection. `prev` is the song list before the update (so
 * the selected song's state is the one the user was looking at).
 * - never on the Export / AI edit / Separate pages (their forms load from the selection; null there can mean an
 *   external file), and never while a score editor holds unsaved edits;
 * - when nothing is selected, or the selected song is gone;
 * - never away from another queued / running song (the user, or Cover / AI edit, follows that job);
 * - when the selected song failed or was cancelled;
 * - on 作曲 only while the selection follows new results (it was auto-selected or submitted there): a song the
 *   user picked by hand stays.
 */
export function shouldFollowFinished(page: Page, selectedSongId: string | null, prev: Song[], finishedId: string, state: FollowState = {}): boolean {
  if (selectedSongId === finishedId) return false;
  if (FORM_PAGES.has(page) || state.scoreDirty) return false;
  if (selectedSongId === null) return true;
  const cur = prev.find((s) => s.id === selectedSongId);
  if (!cur) return true;
  if (cur.status === "queued" || cur.status === "running") return false;
  if (cur.status === "error" || cur.status === "cancelled") return true;
  return page === "compose" && !!state.follow;
}

/** Where a song that was not opened can be found, for the completion notice. */
function openHint(page: Page): string {
  if (page === "library") return "";
  return page === "compose" ? "（最近の生成から開けます）" : "（ライブラリで開けます）";
}

const emptyProgress: ProgressState = { promptId: null, songId: null, stage: "", node: null, value: 0, max: 0, startedAt: null, log: [] };

/** What one prompt's ComfyUI events show. */
type PromptView = Pick<ProgressState, "node" | "value" | "max" | "log">;

/** Applies a ComfyUI event to a prompt's view; false for the kinds that change nothing. */
function applyEventTo(v: PromptView, e: ComfyEvent): boolean {
  switch (e.kind) {
    case "executing":
      v.node = e.node;
      v.value = 0;
      v.max = 0;
      if (e.node) v.log = [...v.log.slice(-(LOG_LINES - 1)), `${new Date().toLocaleTimeString()} ${nodeLabel(e.node)}`];
      return true;
    case "progress":
      v.node = e.node ?? v.node;
      v.value = e.value ?? 0;
      v.max = e.max ?? 0;
      return true;
    case "execution_error":
      v.log = [...v.log.slice(-(LOG_LINES - 1)), `エラー: ${e.message ?? ""}`];
      return true;
    default:
      return false;
  }
}

/**
 * Events of prompts that are not the running generation's, by prompt id (the newest few). Tool runs (分離・転写・
 * 整列・譜面の計画) share the generations' client id, so their events come here too: they are never shown as a song's
 * progress. A generation's prompt can start in ComfyUI before its 生成中 update names it: its events are taken over
 * then.
 */
const otherPrompts = new Map<string, PromptView>();
const OTHER_PROMPTS_MAX = 8;

/**
 * Job updates are numbered; while a song list loads, the newest per song is kept to be applied over that list, with
 * the number of the song's 待機中 (its first update, sent when it was submitted) if that came meanwhile too.
 */
let jobUpdateSeq = 0;
let songLoads = 0;
const updatesWhileLoading = new Map<string, { seq: number; song: Song; queuedSeq: number }>();

/**
 * Puts a song's newest state into the list (in place); a song not in it is added first only while it waits or runs,
 * or when `isNew` (announced while the list loaded and missing from it: submitted after the list was read), so a late
 * update of a deleted song does not bring it back. A listed song keeps its title: titles change only through a rename,
 * which sends no job update and reloads the list, while a job update may carry the title it read just before the
 * rename. Returns its index before, or -1.
 */
function putSong(songs: Song[], s: Song, isNew = false): number {
  const i = songs.findIndex((x) => x.id === s.id);
  if (i >= 0) songs[i] = { ...s, title: songs[i].title };
  else if (isNew || s.status === "queued" || s.status === "running") songs.unshift(s);
  return i;
}

let toastSeq = 0;
/** the running status call; a call that arrives meanwhile asks for one more afterwards */
let comfyInFlight: Promise<void> | null = null;
let comfyAgain = false;

const sameStatus = (a: ComfyStatus | null, b: ComfyStatus) => a !== null && JSON.stringify(a) === JSON.stringify(b);

export const useStore = create<AppStore>((set, get) => ({
  config: null,
  page: "compose",
  comfy: null,
  songs: [],
  songLimit: SONG_PAGE,
  moreSongs: false,
  selectedSongId: null,
  followSelection: false,
  scoreDirty: false,
  progress: emptyProgress,
  toast: null,
  toastsBehind: [],
  waitingQuestions: [],
  lastDeletedSong: null,
  help: null,

  setPage: (page) => set({ page }),
  openHelp: (help) => set({ help }),
  closeHelp: () => set({ help: null }),
  loadConfig: async () => set({ config: await api.getConfig() }),
  saveConfig: async (c) => set({ config: await api.saveConfig(c) }),
  refreshComfy: () => {
    // The 5 s poll must not pile up behind a slow status call, and an unchanged status re-renders nothing. A call
    // during a running one (e.g. right after start / stop) may see a state the running call fetched too early: it
    // waits for one more call, started after the running one, so its caller always sees a fresh status.
    if (comfyInFlight) {
      comfyAgain = true;
      return comfyInFlight;
    }
    const run = async () => {
      try {
        const comfy = await api.comfyStatus();
        if (!sameStatus(get().comfy, comfy)) set({ comfy });
      } catch {
        /* ignore */
      }
    };
    const current: Promise<void> = run().then(() => {
      comfyInFlight = null;
      if (!comfyAgain) return;
      comfyAgain = false;
      return get().refreshComfy();
    });
    comfyInFlight = current;
    return current;
  },
  // Reload at least as many songs as are shown, so a rename / delete does not drop the older ones already loaded.
  // Job updates that arrive while the list loads may be newer than it (e.g. 完了, a song's last update, after the DB
  // was read): each song's newest one is applied over the list again, and a song submitted meanwhile is listed even
  // when it has already ended. For the job's own fields, a list newer than such an update is always followed by the
  // song's own next update; the title is not (a rename sends none), so the list's title is kept (see putSong).
  refreshSongs: async () => {
    const limit = Math.max(get().songLimit, get().songs.length);
    const since = jobUpdateSeq;
    songLoads++;
    try {
      const loaded = await api.listSongs(limit);
      const songs = loaded.slice();
      for (const { seq, song, queuedSeq } of updatesWhileLoading.values()) if (seq > since) putSong(songs, song, queuedSeq > since);
      set({ songs, moreSongs: loaded.length >= limit });
    } finally {
      if (--songLoads === 0) updatesWhileLoading.clear();
    }
  },
  loadMoreSongs: async () => {
    set({ songLimit: Math.max(get().songLimit, get().songs.length) + SONG_PAGE });
    await get().refreshSongs();
  },
  selectSong: (id, opts) => set({ selectedSongId: id, followSelection: opts?.follow ?? false }),
  setScoreDirty: (scoreDirty) => {
    if (get().scoreDirty !== scoreDirty) set({ scoreDirty });
  },

  applyJobUpdate: (u) => {
    jobUpdateSeq++;
    if (songLoads > 0) {
      const queuedSeq = u.song.status === "queued" ? jobUpdateSeq : (updatesWhileLoading.get(u.song.id)?.queuedSeq ?? 0);
      updatesWhileLoading.set(u.song.id, { seq: jobUpdateSeq, song: u.song, queuedSeq });
    }
    const prev = get().songs;
    const songs = prev.slice();
    const i = putSong(songs, u.song);
    // the title the list shows (a listed song keeps its own)
    const title = i >= 0 ? songs[i].title : u.song.title;
    const p = { ...get().progress };
    if (u.song.status === "running") {
      const newSong = p.songId !== u.song.id;
      // each song's lines start under its own title (the log keeps earlier runs)
      if (newSong) p.log = [...p.log.slice(-(LOG_LINES - 1)), `── 「${title}」 ──`];
      // a new song never takes over the last one's prompt
      const promptId = u.promptId ?? (newSong ? null : p.promptId);
      if (newSong || promptId !== p.promptId) {
        // nothing shown so far is this prompt's, except its own events that came before this update
        const early = promptId ? otherPrompts.get(promptId) : undefined;
        p.node = early?.node ?? null;
        p.value = early?.value ?? 0;
        p.max = early?.max ?? 0;
        if (early) p.log = [...p.log, ...early.log].slice(-LOG_LINES);
        if (promptId) otherPrompts.clear();
      }
      p.songId = u.song.id;
      p.promptId = promptId;
      p.stage = u.stage;
      if (!p.startedAt) p.startedAt = Date.now();
    } else if (u.song.id === p.songId) {
      Object.assign(p, emptyProgress, { log: p.log });
      p.stage = u.stage;
    }
    const patch: Partial<AppStore> = { songs, progress: p };
    let doneNotice = false;
    const { page, selectedSongId, followSelection, scoreDirty } = get();
    if (u.song.status === "done" && i >= 0) {
      if (shouldFollowFinished(page, selectedSongId, prev, u.song.id, { follow: followSelection, scoreDirty })) {
        patch.selectedSongId = u.song.id;
        // an auto-selected result keeps following the next ones on 作曲
        patch.followSelection = true;
      } else doneNotice = selectedSongId !== u.song.id;
    }
    set(patch);
    if (u.song.status === "error") {
      get().showToast("error", `「${title}」の生成に失敗しました: ${u.song.error}`, { sticky: true });
    } else if (doneNotice && get().toast?.kind !== "error") {
      // an unread failure is not replaced by a completion notice
      get().showToast("info", `「${title}」の生成が完了しました${openHint(page)}`);
    }
  },

  applyComfyEvent: (e) => {
    if (e.promptId && e.promptId !== get().progress.promptId) {
      // not the running generation's prompt (also while none is known): kept aside, see otherPrompts
      const v = { ...(otherPrompts.get(e.promptId) ?? { node: null, value: 0, max: 0, log: [] }) };
      if (!applyEventTo(v, e)) return;
      otherPrompts.delete(e.promptId);
      otherPrompts.set(e.promptId, v);
      if (otherPrompts.size > OTHER_PROMPTS_MAX) otherPrompts.delete(otherPrompts.keys().next().value!);
      return;
    }
    const p = { ...get().progress };
    if (applyEventTo(p, e)) set({ progress: p });
  },

  showToast: (kind, text, opts) => {
    const id = ++toastSeq;
    const sticky = opts?.sticky ?? false;
    const covered = get().toast;
    const behind = covered?.sticky ? [...get().toastsBehind, covered].slice(-TOASTS_BEHIND_MAX) : get().toastsBehind;
    set({ toast: { id, kind, text, sticky }, toastsBehind: behind });
    if (sticky) return;
    setTimeout(
      () => {
        if (get().toast?.id === id) get().dismissToast();
      },
      opts?.ms ?? (kind === "error" ? ERROR_TOAST_MS : TOAST_MS),
    );
  },
  dismissToast: () => {
    const behind = get().toastsBehind;
    set({ toast: behind.length ? behind[behind.length - 1] : null, toastsBehind: behind.slice(0, -1) });
  },
  dropToastText: (text) => {
    const behind = get().toastsBehind;
    if (behind.some((t) => t.text === text)) set({ toastsBehind: behind.filter((t) => t.text !== text) });
    if (get().toast?.text === text) get().dismissToast();
  },
  setWaitingQuestion: (q) => set({ waitingQuestions: [...get().waitingQuestions.filter((w) => w.id !== q.id), q] }),
  songDeleted: (id, kept) => set({ lastDeletedSong: { id, kept, n: (get().lastDeletedSong?.n ?? 0) + 1 } }),
  clearWaitingQuestion: (id) => {
    if (get().waitingQuestions.some((w) => w.id === id)) set({ waitingQuestions: get().waitingQuestions.filter((w) => w.id !== id) });
  },
}));
