import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComfyEvent, ComfyStatus, JobUpdate, Song } from "../api";

vi.mock("../api", () => ({
  api: {
    listSongs: vi.fn(async (limit: number) => Array.from({ length: Math.min(limit, 3) }, (_, i) => ({ id: `s${i}` }))),
    comfyStatus: vi.fn(),
  },
}));

import { api } from "../api";
import { LOG_LINES, SONG_PAGE, shouldFollowFinished, useStore, type Page, type ProgressState } from "../store";

const emptyProgress: ProgressState = { promptId: null, songId: null, stage: "", node: null, value: 0, max: 0, startedAt: null, log: [] };

function song(id: string, status: Song["status"], over: Partial<Song> = {}): Song {
  return {
    id, createdAt: "2026-09-30T10:00:00+09:00", title: `曲${id}`, style: "pop", lyrics: "", lyricsSung: "", mode: "full", seed: 1, abc: "",
    duration: 0, audioPath: "", folder: "", paramsJson: "", status, error: "", parentId: null, wallSeconds: 0, peakVramGib: 0, ...over,
  };
}

const update = (s: Song, stage = "", promptId: string | null = null): JobUpdate => ({ song: s, promptId, stage });
const event = (over: Partial<ComfyEvent>): ComfyEvent => ({ kind: "executing", promptId: null, node: null, value: null, max: null, output: null, message: null, queueRemaining: null, ...over });

function reset(page: Page = "compose", songs: Song[] = [], selectedSongId: string | null = null, followSelection = false) {
  useStore.setState({
    page, songs, selectedSongId, followSelection, scoreDirty: false, songLimit: SONG_PAGE, moreSongs: false, progress: { ...emptyProgress, log: [] }, toast: null,
    comfy: null, toastsBehind: [], waitingQuestions: [],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
  reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("applyJobUpdate: song list", () => {
  it("replaces a known song in place and adds a new queued or running song first", () => {
    reset("library", [song("a", "done"), song("b", "queued")]);
    useStore.getState().applyJobUpdate(update(song("b", "running")));
    expect(useStore.getState().songs.map((s) => [s.id, s.status])).toEqual([["a", "done"], ["b", "running"]]);
    useStore.getState().applyJobUpdate(update(song("c", "queued")));
    expect(useStore.getState().songs[0].id).toBe("c");
  });

  it("does not bring back a deleted song from a late update", () => {
    reset("library", [song("a", "done")]);
    for (const status of ["done", "error", "cancelled"] as const) useStore.getState().applyJobUpdate(update(song("gone", status)));
    expect(useStore.getState().songs.map((s) => s.id)).toEqual(["a"]);
    expect(useStore.getState().selectedSongId).toBeNull();
  });
});

describe("applyJobUpdate: progress", () => {
  it("tracks the running song and sets startedAt once", () => {
    reset("compose", [song("a", "queued")]);
    useStore.getState().applyJobUpdate(update(song("a", "running"), "生成中", "p1"));
    const p = useStore.getState().progress;
    expect(p).toMatchObject({ songId: "a", promptId: "p1", stage: "生成中" });
    const started = p.startedAt;
    expect(started).toBe(Date.now());
    vi.advanceTimersByTime(5000);
    useStore.getState().applyJobUpdate(update(song("a", "running"), "出力を保存中"));
    expect(useStore.getState().progress).toMatchObject({ promptId: "p1", stage: "出力を保存中", startedAt: started });
  });

  it("starts each song's lines in the log under its title", () => {
    reset("compose", [song("a", "queued"), song("b", "queued")]);
    useStore.setState({ progress: { ...emptyProgress, log: ["old"] } });
    useStore.getState().applyJobUpdate(update(song("a", "running"), "生成中", "p1"));
    useStore.getState().applyJobUpdate(update(song("a", "running"), "出力を保存中", "p1"));
    expect(useStore.getState().progress.log).toEqual(["old", "── 「曲a」 ──"]);
    useStore.getState().applyJobUpdate(update(song("a", "done"), "完了"));
    useStore.getState().applyJobUpdate(update(song("b", "running"), "生成中", "p2"));
    expect(useStore.getState().progress.log).toEqual(["old", "── 「曲a」 ──", "── 「曲b」 ──"]);
    useStore.setState({ progress: { ...emptyProgress, log: Array.from({ length: LOG_LINES }, (_, i) => `l${i}`) } });
    useStore.getState().applyJobUpdate(update(song("a", "running"), "生成中", "p3"));
    expect(useStore.getState().progress.log).toHaveLength(LOG_LINES);
  });

  it("resets on the running song's terminal update but keeps the log", () => {
    reset("compose", [song("a", "running")]);
    useStore.setState({ progress: { ...emptyProgress, songId: "a", promptId: "p1", node: "music", value: 5, max: 10, startedAt: 1, log: ["x"] } });
    useStore.getState().applyJobUpdate(update(song("a", "cancelled"), "キャンセル済み"));
    expect(useStore.getState().progress).toEqual({ ...emptyProgress, stage: "キャンセル済み", log: ["x"] });
  });

  it("leaves the progress alone for another song's terminal update", () => {
    reset("compose", [song("a", "running"), song("b", "queued")]);
    const running = { ...emptyProgress, songId: "a", promptId: "p1", stage: "生成中", log: [] };
    useStore.setState({ progress: running });
    useStore.getState().applyJobUpdate(update(song("b", "cancelled"), "キャンセル済み"));
    expect(useStore.getState().progress).toEqual(running);
  });
});

describe("applyJobUpdate: selection when a song finishes", () => {
  const finish = (id: string) => useStore.getState().applyJobUpdate(update(song(id, "done"), "完了"));

  it("keeps a finished song selected on the Export and AI edit pages", () => {
    for (const page of ["export", "edit", "separate"] as const) {
      reset(page, [song("a", "done"), song("b", "running")], "a");
      finish("b");
      expect(useStore.getState().selectedSongId).toBe("a");
      expect(useStore.getState().toast).toMatchObject({ kind: "info" });
      expect(useStore.getState().toast?.text).toContain("曲b");
    }
  });

  it("keeps an external file (no selection) on the Export page", () => {
    reset("export", [song("b", "running")], null);
    finish("b");
    expect(useStore.getState().selectedSongId).toBeNull();
  });

  it("shows the new results on 作曲 while the selection follows them", () => {
    reset("compose", [song("a", "done"), song("b", "running")], "a", true);
    finish("b");
    expect(useStore.getState().selectedSongId).toBe("b");
    expect(useStore.getState().toast).toBeNull();
    // nothing selected: the first result is auto-selected, and the next one follows it
    reset("compose", [song("b", "running"), song("c", "queued")], null);
    finish("b");
    expect(useStore.getState()).toMatchObject({ selectedSongId: "b", followSelection: true });
    finish("c");
    expect(useStore.getState().selectedSongId).toBe("c");
  });

  it("follows a submit's variations on 作曲 (selectSong with follow)", () => {
    reset("compose", [song("v2", "queued"), song("v1", "queued")]);
    useStore.getState().selectSong("v1", { follow: true });
    useStore.getState().applyJobUpdate(update(song("v1", "running")));
    finish("v1");
    expect(useStore.getState().selectedSongId).toBe("v1");
    finish("v2");
    expect(useStore.getState().selectedSongId).toBe("v2");
  });

  it("keeps a song picked by hand on 作曲", () => {
    reset("compose", [song("a", "done"), song("b", "running")], "a", true);
    useStore.getState().selectSong("a");
    expect(useStore.getState().followSelection).toBe(false);
    finish("b");
    expect(useStore.getState().selectedSongId).toBe("a");
    expect(useStore.getState().toast?.text).toContain("最近の生成から開けます");
  });

  it("never replaces a song whose score has unsaved edits", () => {
    for (const [page, sel] of [["compose", "a"], ["compose", null], ["cover", null], ["library", "zz"]] as const) {
      reset(page, [song("a", "done"), song("b", "running")], sel, true);
      useStore.getState().setScoreDirty(true);
      finish("b");
      expect(useStore.getState().selectedSongId).toBe(sel);
    }
    // clean again: the next result is shown
    reset("compose", [song("a", "done"), song("b", "running")], "a", true);
    useStore.getState().setScoreDirty(true);
    useStore.getState().setScoreDirty(false);
    finish("b");
    expect(useStore.getState().selectedSongId).toBe("b");
  });

  it("keeps following the selected song's own job", () => {
    reset("cover", [song("a", "queued"), song("b", "running")], "a");
    finish("b");
    expect(useStore.getState().selectedSongId).toBe("a");
    useStore.getState().applyJobUpdate(update(song("a", "running")));
    finish("a");
    expect(useStore.getState().selectedSongId).toBe("a");
  });

  it("does not replace a finished song the user opened in the library", () => {
    reset("library", [song("a", "done"), song("b", "running")], "a", true);
    finish("b");
    expect(useStore.getState().selectedSongId).toBe("a");
    // the notice does not point to the page the user is on
    expect(useStore.getState().toast?.text).toBe("「曲b」の生成が完了しました");
  });

  it("moves on from a failed song, and selects when nothing is selected", () => {
    reset("library", [song("a", "error"), song("b", "running")], "a");
    finish("b");
    expect(useStore.getState().selectedSongId).toBe("b");
    reset("settings", [song("b", "running")], null);
    finish("b");
    expect(useStore.getState().selectedSongId).toBe("b");
  });

  it("uses the state from before the update", () => {
    // the selected song itself finishing: nothing changes, and no notice
    expect(shouldFollowFinished("library", "a", [song("a", "running")], "a")).toBe(false);
    reset("library", [song("a", "running")], "a");
    finish("a");
    expect(useStore.getState().selectedSongId).toBe("a");
    expect(useStore.getState().toast).toBeNull();
    // a selected song that is not in the list any more
    expect(shouldFollowFinished("library", "zz", [song("a", "running")], "a")).toBe(true);
  });
});

describe("toasts", () => {
  it("shows a job failure until it is closed", () => {
    reset("compose", [song("a", "running")], null);
    useStore.getState().applyJobUpdate(update(song("a", "error", { error: "ノードがありません" }), "エラー"));
    const t = useStore.getState().toast;
    expect(t).toMatchObject({ kind: "error", sticky: true });
    expect(t?.text).toContain("ノードがありません");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(useStore.getState().toast?.id).toBe(t?.id);
    useStore.getState().dismissToast();
    expect(useStore.getState().toast).toBeNull();
  });

  it("does not cover an unread failure with a completion notice", () => {
    reset("export", [song("a", "done"), song("b", "running"), song("c", "running")], "a");
    useStore.getState().applyJobUpdate(update(song("b", "error", { error: "x" })));
    useStore.getState().applyJobUpdate(update(song("c", "done")));
    expect(useStore.getState().toast).toMatchObject({ kind: "error" });
  });

  it("clears only its own toast, after 6 s (15 s for errors)", () => {
    const { showToast } = useStore.getState();
    showToast("success", "保存しました");
    vi.advanceTimersByTime(4000);
    showToast("success", "保存しました");
    const second = useStore.getState().toast?.id;
    vi.advanceTimersByTime(2500); // the first timer fires: the second toast stays
    expect(useStore.getState().toast?.id).toBe(second);
    vi.advanceTimersByTime(4000);
    expect(useStore.getState().toast).toBeNull();

    showToast("error", "失敗");
    vi.advanceTimersByTime(14000);
    expect(useStore.getState().toast).not.toBeNull();
    vi.advanceTimersByTime(1500);
    expect(useStore.getState().toast).toBeNull();

    showToast("info", "長め", { ms: 30000 });
    vi.advanceTimersByTime(20000);
    expect(useStore.getState().toast?.text).toBe("長め");
  });

  it("brings back a sticky notice once a passing toast goes", () => {
    reset("export", [song("x", "done"), song("a", "running")], "x");
    useStore.setState({ toast: { id: 999, kind: "info", text: "「作曲」画面で確認が必要です", sticky: true } });
    // a completion notice covers it ...
    useStore.getState().applyJobUpdate(update(song("a", "done")));
    expect(useStore.getState().toast?.text).toContain("生成が完了しました");
    // ... and the question notice is back when it times out
    vi.advanceTimersByTime(6500);
    expect(useStore.getState().toast?.text).toBe("「作曲」画面で確認が必要です");
    // closing a covering toast by hand brings it back too
    useStore.getState().showToast("success", "保存しました");
    useStore.getState().dismissToast();
    expect(useStore.getState().toast?.text).toBe("「作曲」画面で確認が必要です");
    // an error still replaces it, and it returns after the error
    useStore.getState().showToast("error", "失敗");
    expect(useStore.getState().toast?.kind).toBe("error");
    vi.advanceTimersByTime(15500);
    expect(useStore.getState().toast?.text).toBe("「作曲」画面で確認が必要です");
  });

  it("drops a notice whose question no longer waits, shown or kept behind", () => {
    const { showToast, dropToastText } = useStore.getState();
    showToast("info", "質問", { sticky: true });
    showToast("success", "保存しました");
    dropToastText("質問");
    expect(useStore.getState().toastsBehind).toEqual([]);
    vi.advanceTimersByTime(6500);
    expect(useStore.getState().toast).toBeNull();
    showToast("info", "質問", { sticky: true });
    useStore.getState().dropToastText("質問");
    expect(useStore.getState().toast).toBeNull();
  });

  it("marks pages with a waiting question until it is cleared", () => {
    const { setWaitingQuestion, clearWaitingQuestion } = useStore.getState();
    setWaitingQuestion({ id: 1, page: "compose", title: "a" });
    setWaitingQuestion({ id: 2, page: "edit", title: "b" });
    // another toast does not remove the mark
    useStore.getState().showToast("info", "x");
    expect(useStore.getState().waitingQuestions.map((w) => w.page)).toEqual(["compose", "edit"]);
    clearWaitingQuestion(1);
    clearWaitingQuestion(1);
    expect(useStore.getState().waitingQuestions.map((w) => w.page)).toEqual(["edit"]);
  });
});

describe("applyComfyEvent", () => {
  beforeEach(() => {
    useStore.setState({ progress: { ...emptyProgress, songId: "a", promptId: "p1", log: [] } });
  });

  it("ignores another prompt's events and applies events without a prompt id", () => {
    useStore.getState().applyComfyEvent(event({ kind: "progress", promptId: "other", node: "music", value: 3, max: 9 }));
    expect(useStore.getState().progress.value).toBe(0);
    useStore.getState().applyComfyEvent(event({ kind: "progress", promptId: null, node: "music", value: 3, max: 9 }));
    expect(useStore.getState().progress).toMatchObject({ node: "music", value: 3, max: 9 });
  });

  it("keeps another prompt's events aside while no prompt is known", () => {
    useStore.setState({ progress: { ...emptyProgress, log: ["x"] } });
    const before = useStore.getState().progress;
    useStore.getState().applyComfyEvent(event({ kind: "executing", promptId: "any", node: "loader" }));
    useStore.getState().applyComfyEvent(event({ kind: "execution_error", promptId: "any", message: "OOM" }));
    expect(useStore.getState().progress).toBe(before);
  });

  it("executing resets the counters and logs only a real node; progress keeps the node", () => {
    useStore.getState().applyComfyEvent(event({ kind: "progress", promptId: "p1", node: "sampler", value: 4, max: 8 }));
    useStore.getState().applyComfyEvent(event({ kind: "executing", promptId: "p1", node: "decode" }));
    let p = useStore.getState().progress;
    expect(p).toMatchObject({ node: "decode", value: 0, max: 0 });
    expect(p.log).toHaveLength(1);
    expect(p.log[0].endsWith("音声にデコード中")).toBe(true);
    useStore.getState().applyComfyEvent(event({ kind: "executing", promptId: "p1", node: null }));
    expect(useStore.getState().progress.log).toHaveLength(1);
    useStore.getState().applyComfyEvent(event({ kind: "progress", promptId: "p1", node: null, value: 1, max: 2 }));
    p = useStore.getState().progress;
    expect(p).toMatchObject({ node: null, value: 1, max: 2 });
  });

  it("logs execution errors, ignores unknown kinds and caps the log", () => {
    useStore.getState().applyComfyEvent(event({ kind: "execution_error", promptId: "p1", message: "OOM" }));
    expect(useStore.getState().progress.log).toEqual(["エラー: OOM"]);
    const before = useStore.getState().progress;
    useStore.getState().applyComfyEvent(event({ kind: "status", promptId: "p1" }));
    expect(useStore.getState().progress).toBe(before);
    for (let i = 0; i < 100; i++) useStore.getState().applyComfyEvent(event({ kind: "executing", promptId: "p1", node: "music" }));
    expect(useStore.getState().progress.log).toHaveLength(LOG_LINES);
  });
});

describe("ComfyUI events of tool runs (same client id as the generations)", () => {
  const comfy = (over: Partial<ComfyEvent>) => useStore.getState().applyComfyEvent(event(over));
  const job = (s: Song, stage: string, promptId: string | null = null) => useStore.getState().applyJobUpdate(update(s, stage, promptId));

  it("never shows or logs a tool's steps under a song, also once a generation waits behind it", () => {
    reset("compose", [song("a", "running")]);
    job(song("a", "running"), "生成中", "gen-a");
    job(song("a", "done"), "完了", "gen-a");
    const log = useStore.getState().progress.log;
    // a separation and a score plan run in ComfyUI while nothing generates
    comfy({ kind: "executing", promptId: "tool-sep", node: "src" });
    comfy({ kind: "executing", promptId: "tool-sep", node: "sep" });
    comfy({ kind: "executing", promptId: "tool-plan", node: "abc" });
    comfy({ kind: "progress", promptId: "tool-plan", node: "abc", value: 1200, max: 8192 });
    comfy({ kind: "execution_error", promptId: "tool-sep", message: "MCS_VocalSeparate (sep): x" });
    expect(useStore.getState().progress).toMatchObject({ songId: null, node: null, value: 0, max: 0, log });
    // a generation is submitted: ComfyUI holds its prompt behind the tools
    job(song("g", "queued"), "待機中");
    job(song("g", "running"), "生成中", "gen-g");
    expect(useStore.getState().progress).toMatchObject({ songId: "g", promptId: "gen-g", node: null, value: 0, max: 0, log: [...log, "── 「曲g」 ──"] });
    comfy({ kind: "progress", promptId: "tool-plan", node: "abc", value: 1300, max: 8192 });
    expect(useStore.getState().progress).toMatchObject({ node: null, value: 0, max: 0 });
    // its own events are shown
    comfy({ kind: "executing", promptId: "gen-g", node: "loader" });
    expect(useStore.getState().progress.node).toBe("loader");
  });

  it("keeps a tool's steps out of a song that waits for the AI or for ComfyUI to start", () => {
    for (const stage of ["AI の応答を待っています", "ComfyUI を起動中"]) {
      reset("compose", [song("g", "queued")]);
      job(song("g", "running"), stage);
      const before = useStore.getState().progress;
      comfy({ kind: "executing", promptId: "tool-sep2", node: "sep" });
      comfy({ kind: "progress", promptId: "tool-sep2", node: "sep", value: 37, max: 100 });
      comfy({ kind: "execution_error", promptId: "tool-sep2", message: "MCS_VocalSeparate (sep): x" });
      expect(useStore.getState().progress).toBe(before);
    }
  });

  it("takes over the generation's own events that came before its 生成中 update", () => {
    reset("compose", [song("g", "queued")]);
    comfy({ kind: "executing", promptId: "tool-x", node: "transcribe" });
    // ComfyUI started the generation's prompt before the worker sent 生成中
    comfy({ kind: "executing", promptId: "gen-early", node: "loader" });
    comfy({ kind: "progress", promptId: "gen-early", node: "loader", value: 2, max: 4 });
    job(song("g", "running"), "生成中", "gen-early");
    const p = useStore.getState().progress;
    expect(p).toMatchObject({ songId: "g", promptId: "gen-early", node: "loader", value: 2, max: 4 });
    expect(p.log).toHaveLength(2);
    expect(p.log[0]).toBe("── 「曲g」 ──");
    expect(p.log[1].endsWith("モデルを読み込み中")).toBe(true);
  });

  it("starts a new song or prompt without the node and counters shown before", () => {
    reset("compose", [song("a", "running"), song("b", "queued")]);
    useStore.setState({ progress: { ...emptyProgress, songId: "a", promptId: "gen-a2", stage: "生成中", node: "music", value: 5, max: 10, startedAt: 1, log: [] } });
    // the next song starts without a terminal update of the last one (and never takes over its prompt)
    job(song("b", "running"), "ComfyUI を起動中");
    expect(useStore.getState().progress).toMatchObject({ songId: "b", promptId: null, node: null, value: 0, max: 0 });
    useStore.setState({ progress: { ...useStore.getState().progress, node: "abc", value: 3, max: 8192 } });
    job(song("b", "running"), "生成中", "gen-b2");
    expect(useStore.getState().progress).toMatchObject({ promptId: "gen-b2", node: null, value: 0, max: 0 });
    // a later update of the same prompt keeps them
    comfy({ kind: "progress", promptId: "gen-b2", node: "music", value: 7, max: 9 });
    job(song("b", "running"), "出力を保存中", "gen-b2");
    expect(useStore.getState().progress).toMatchObject({ node: "music", value: 7, max: 9 });
  });
});

describe("song list loading", () => {
  /** listSongs answers only when the test resolves it (job updates can arrive meanwhile) */
  const pendingList = () => {
    let resolve: (s: Song[]) => void = () => {};
    vi.mocked(api.listSongs).mockImplementationOnce(() => new Promise<Song[]>((r) => (resolve = r)));
    return (s: Song[]) => resolve(s);
  };

  it("keeps a job update that arrived while the list was loading (the list was read before it)", async () => {
    reset("library", [song("b", "running"), song("a", "done")], "b");
    const answer = pendingList();
    const loading = useStore.getState().refreshSongs();
    // the song finishes while the list is on its way: 完了 is its last update
    useStore.getState().applyJobUpdate(update(song("b", "done", { audioPath: "b.wav" }), "完了", "gen-b"));
    answer([song("b", "running"), song("a", "done")]);
    await loading;
    expect(useStore.getState().songs.map((s) => [s.id, s.status, s.audioPath])).toEqual([["b", "done", "b.wav"], ["a", "done", ""]]);
  });

  it("keeps a song queued while the list was loading, so its later failure is listed", async () => {
    reset("library", [song("a", "done")]);
    const answer = pendingList();
    const loading = useStore.getState().refreshSongs();
    useStore.getState().applyJobUpdate(update(song("c", "queued"), "待機中"));
    answer([song("a", "done")]);
    await loading;
    expect(useStore.getState().songs.map((s) => s.id)).toEqual(["c", "a"]);
    useStore.getState().applyJobUpdate(update(song("c", "error", { error: "x" }), "エラー"));
    expect(useStore.getState().songs.map((s) => [s.id, s.status])).toEqual([["c", "error"], ["a", "done"]]);
  });

  it("lists a song queued and ended while the list was loading (its newest update is no longer 待機中)", async () => {
    reset("library", [song("a", "done")]);
    const answer = pendingList();
    const loading = useStore.getState().refreshSongs();
    useStore.getState().applyJobUpdate(update(song("c", "queued"), "待機中"));
    useStore.getState().applyJobUpdate(update(song("c", "error", { error: "x" }), "エラー"));
    useStore.getState().applyJobUpdate(update(song("d", "queued"), "待機中"));
    useStore.getState().applyJobUpdate(update(song("d", "cancelled"), "キャンセル済み"));
    answer([song("a", "done")]);
    await loading;
    expect(useStore.getState().songs.map((s) => [s.id, s.status])).toEqual([["d", "cancelled"], ["c", "error"], ["a", "done"]]);
  });

  it("does not bring back a song queued before the load that the list no longer has", async () => {
    reset("library", [song("a", "done")]);
    // c is announced during a first load, so for the second load its 待機中 is older than the list
    const first = pendingList();
    const loading1 = useStore.getState().refreshSongs();
    useStore.getState().applyJobUpdate(update(song("c", "queued"), "待機中"));
    const second = pendingList();
    const loading2 = useStore.getState().refreshSongs();
    // c is deleted (its queued job cancelled) before the second load reads the list
    useStore.getState().applyJobUpdate(update(song("c", "cancelled"), "キャンセル済み"));
    first([song("c", "queued"), song("a", "done")]);
    await loading1;
    second([song("a", "done")]);
    await loading2;
    expect(useStore.getState().songs.map((s) => s.id)).toEqual(["a"]);
  });

  it("keeps a renamed song's title over a job update that read the title before the rename", async () => {
    reset("library", [song("b", "running", { title: "旧名" }), song("a", "done")], "a");
    // the rename's reload starts, then 完了 (read with the old title) arrives before the list
    const answer = pendingList();
    const loading = useStore.getState().refreshSongs();
    useStore.getState().applyJobUpdate(update(song("b", "done", { title: "旧名", audioPath: "b.wav" }), "完了", "gen-b"));
    answer([song("b", "done", { title: "新名", audioPath: "b.wav" }), song("a", "done")]);
    await loading;
    expect(useStore.getState().songs.map((s) => [s.id, s.status, s.title])).toEqual([["b", "done", "新名"], ["a", "done", "曲a"]]);
  });

  it("keeps a listed song's title when a late job update carries the old one", () => {
    reset("library", [song("b", "running", { title: "新名" }), song("a", "done")], "a");
    useStore.getState().applyJobUpdate(update(song("b", "done", { title: "旧名", audioPath: "b.wav" }), "完了", "gen-b"));
    expect(useStore.getState().songs.map((s) => [s.id, s.status, s.title, s.audioPath])).toEqual([["b", "done", "新名", "b.wav"], ["a", "done", "曲a", ""]]);
    expect(useStore.getState().toast?.text).toBe("「新名」の生成が完了しました");
    // a song the list does not have yet comes with its own title
    useStore.getState().applyJobUpdate(update(song("c", "queued", { title: "朝の歌" }), "待機中"));
    expect(useStore.getState().songs[0]).toMatchObject({ id: "c", title: "朝の歌" });
  });

  it("takes the loaded list over updates from before the load, and drops a deleted song's late update", async () => {
    reset("library", [song("b", "queued"), song("a", "queued")]);
    useStore.getState().applyJobUpdate(update(song("b", "running"), "生成中", "gen-b3"));
    const answer = pendingList();
    const loading = useStore.getState().refreshSongs();
    // a's job was cancelled by its delete: the list no longer has it
    useStore.getState().applyJobUpdate(update(song("a", "cancelled"), "キャンセル済み"));
    answer([song("b", "done", { title: "新しい名前" })]);
    await loading;
    expect(useStore.getState().songs.map((s) => [s.id, s.status, s.title])).toEqual([["b", "done", "新しい名前"]]);
    // nothing is kept for the next load
    const next = pendingList();
    const again = useStore.getState().refreshSongs();
    next([song("b", "done")]);
    await again;
    expect(useStore.getState().songs.map((s) => [s.id, s.status])).toEqual([["b", "done"]]);
  });

  it("reloads at least as many songs as are shown, and loads more on request", async () => {
    const listSongs = vi.mocked(api.listSongs);
    listSongs.mockClear();
    useStore.setState({ songs: Array.from({ length: 700 }, (_, i) => song(`x${i}`, "done")), songLimit: SONG_PAGE });
    await useStore.getState().refreshSongs();
    expect(listSongs).toHaveBeenLastCalledWith(700);
    // the mock returns 3 songs: everything is loaded
    expect(useStore.getState().moreSongs).toBe(false);
    listSongs.mockImplementationOnce(async (limit?: number) => Array.from({ length: limit ?? 0 }, (_, i) => song(`y${i}`, "done")));
    useStore.setState({ songs: [] });
    await useStore.getState().refreshSongs();
    expect(useStore.getState().moreSongs).toBe(true);
    useStore.setState({ songs: [], songLimit: SONG_PAGE });
    await useStore.getState().loadMoreSongs();
    expect(useStore.getState().songLimit).toBe(SONG_PAGE * 2);
    expect(listSongs).toHaveBeenLastCalledWith(SONG_PAGE * 2);
  });
});

describe("refreshComfy", () => {
  const status = (over: Partial<ComfyStatus> = {}): ComfyStatus => ({
    processRunning: true, alive: true, port: 8188, comfyuiVersion: "0.37.0", pytorchVersion: null, gpuName: null, vramTotal: 1, vramUsed: 0,
    hasWavSaver: true, queueRunning: 0, queuePending: 0, activeSongId: null, toolsInFlight: 0, expectedComfyuiVersion: "0.37.0", versionMismatch: false,
    missingNodes: [], hasStatusNode: true, vaeFp32Active: false, restartRequired: false, ...over,
  });

  it("keeps the same object when nothing changed", async () => {
    const comfyStatus = vi.mocked(api.comfyStatus);
    comfyStatus.mockResolvedValueOnce(status());
    await useStore.getState().refreshComfy();
    const first = useStore.getState().comfy;
    comfyStatus.mockResolvedValueOnce(status());
    await useStore.getState().refreshComfy();
    expect(useStore.getState().comfy).toBe(first);
    comfyStatus.mockResolvedValueOnce(status({ vramUsed: 5 }));
    await useStore.getState().refreshComfy();
    expect(useStore.getState().comfy?.vramUsed).toBe(5);
  });

  it("does not overlap status calls, and runs one more for calls made meanwhile", async () => {
    const comfyStatus = vi.mocked(api.comfyStatus);
    comfyStatus.mockClear();
    let release: (s: ComfyStatus) => void = () => {};
    comfyStatus.mockImplementationOnce(() => new Promise<ComfyStatus>((r) => (release = r)));
    // the poll is running with a status fetched before a start
    const poll = useStore.getState().refreshComfy();
    // two explicit refreshes (e.g. after start) arrive meanwhile: they wait, and share one follow-up call
    let explicitDone = false;
    const explicit = useStore.getState().refreshComfy().then(() => (explicitDone = true));
    const another = useStore.getState().refreshComfy();
    await Promise.resolve();
    expect(comfyStatus).toHaveBeenCalledTimes(1);
    expect(explicitDone).toBe(false);
    comfyStatus.mockResolvedValueOnce(status({ processRunning: true, alive: true }));
    release(status({ processRunning: false, alive: false }));
    await Promise.all([poll, explicit, another]);
    expect(comfyStatus).toHaveBeenCalledTimes(2);
    // the explicit caller sees the fresh status, not the early one
    expect(useStore.getState().comfy?.alive).toBe(true);
    // nothing pending: the next call runs at once, alone
    comfyStatus.mockResolvedValueOnce(status({ vramUsed: 3 }));
    await useStore.getState().refreshComfy();
    expect(comfyStatus).toHaveBeenCalledTimes(3);
    expect(useStore.getState().comfy?.vramUsed).toBe(3);
  });

  it("keeps working after a failed status call", async () => {
    const comfyStatus = vi.mocked(api.comfyStatus);
    comfyStatus.mockRejectedValueOnce(new Error("down"));
    await useStore.getState().refreshComfy();
    comfyStatus.mockResolvedValueOnce(status({ vramUsed: 7 }));
    await useStore.getState().refreshComfy();
    expect(useStore.getState().comfy?.vramUsed).toBe(7);
  });
});

describe("the help dialog", () => {
  it("opens with the help of the page asked for and closes", () => {
    useStore.setState({ help: null });
    useStore.getState().openHelp("export");
    expect(useStore.getState().help).toBe("export");
    // the page shown does not change: the help only shows that page's help
    expect(useStore.getState().page).not.toBe("library");
    useStore.getState().openHelp("library");
    expect(useStore.getState().help).toBe("library");
    useStore.getState().closeHelp();
    expect(useStore.getState().help).toBeNull();
  });
});
