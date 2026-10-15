import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  SETUP_ALREADY_RUNNING,
  SETUP_CANCELLED_ERROR,
  api,
  closeRequestDialog,
  closeRequestLines,
  isSetupAlreadyRunning,
  isSetupCancelled,
  isToolCancelled,
  type SetupFinished,
} from "../api";
import { cycleFocusIndex, initialFocusIndex } from "../components/ChoiceDialog";

describe("ChoiceDialog focus", () => {
  it("starts on キャンセル when a choice is destructive", () => {
    expect(initialFocusIndex([{ value: "go", label: "生成する", kind: "primary" }, { value: "as", label: "そのまま" }])).toBe(0);
    // the cancel button follows the choices
    expect(initialFocusIndex([{ value: "delete", label: "削除する", kind: "danger" }])).toBe(1);
    expect(initialFocusIndex([{ value: "a", label: "A" }, { value: "reset", label: "リセットする", kind: "danger" }])).toBe(2);
  });

  it("cycles Tab / Shift+Tab inside the dialog", () => {
    expect(cycleFocusIndex(3, 0, false)).toBe(1);
    expect(cycleFocusIndex(3, 2, false)).toBe(0);
    expect(cycleFocusIndex(3, 0, true)).toBe(2);
    // focus outside the dialog comes back in
    expect(cycleFocusIndex(3, -1, false)).toBe(0);
    expect(cycleFocusIndex(3, -1, true)).toBe(2);
    expect(cycleFocusIndex(0, -1, false)).toBe(-1);
  });
});

describe("closeRequestLines", () => {
  it("lists what a close would interrupt", () => {
    expect(closeRequestLines({ generating: true, activeTitle: "春の歌", queued: 2, tools: 1, setup: false })).toEqual([
      "生成中の曲：「春の歌」",
      "待機中の曲：2 曲",
      "音声の処理（転写・分離・歌詞の整列・譜面の計画）：1 件",
    ]);
    expect(closeRequestLines({ generating: true, setup: true })).toEqual(["曲を生成中です", "セットアップ（ダウンロード・展開）を実行中です"]);
  });

  it("builds the question from the backend message, or from what runs", () => {
    // the backend's own question; the details keep only what it does not say
    expect(closeRequestDialog({ generating: true, tools: 2, setup: true, message: "曲の生成・セットアップが実行中です。終了しますか？" })).toEqual({
      message: "曲の生成・セットアップが実行中です。終了しますか？",
      details: ["音声の処理（転写・分離・歌詞の整列・譜面の計画）：2 件"],
    });
    // setup only: queued songs are not mentioned
    expect(closeRequestDialog({ setup: true }).message).toBe("実行中の処理があります。終了すると中断されます。終了しますか？");
    expect(closeRequestDialog({ generating: true, queued: 3 }).message).toContain("待機中の曲も生成されません");
    // nothing named: the cautious question
    expect(closeRequestDialog({})).toEqual({ message: "実行中の処理があります。終了すると中断されます（待機中の曲も生成されません）。終了しますか？", details: [] });
    expect(closeRequestDialog({ setup: true, message: "  " }).message).not.toBe("  ");
  });

  it("passes the backend's hint on as the dialog note", () => {
    const hint = "10 秒以内にもう一度ウィンドウを閉じると、確認せずに終了します。";
    expect(closeRequestDialog({ generating: true, message: "終了しますか？", hint: ` ${hint} ` }).note).toBe(hint);
    expect(closeRequestDialog({ setup: true, hint }).note).toBe(hint);
    expect(closeRequestDialog({ setup: true, hint: "  " }).note).toBeUndefined();
    expect(closeRequestDialog({ setup: true }).note).toBeUndefined();
  });

  it("counts the running exports", () => {
    // the backend names 書き出し in its question; the count is what the details add
    expect(closeRequestLines({ exports: 2 })).toEqual(["書き出し：2 件"]);
    expect(closeRequestLines({ exports: 0, setup: true })).toEqual(["セットアップ（ダウンロード・展開）を実行中です"]);
    expect(closeRequestDialog({ tools: 1, exports: 1, message: "音声の処理（転写・分離・歌詞の整列・譜面の計画）・書き出しが実行中です。終了しますか？" }).details).toEqual([
      "音声の処理（転写・分離・歌詞の整列・譜面の計画）：1 件",
      "書き出し：1 件",
    ]);
  });

  it("tolerates empty or unexpected payloads", () => {
    expect(closeRequestLines(null)).toEqual([]);
    expect(closeRequestLines({})).toEqual([]);
    expect(closeRequestLines("x" as never)).toEqual([]);
  });
});

describe("api contract", () => {
  it("deleteSong resolves with the kept folder or null", async () => {
    const inv = vi.mocked(invoke);
    inv.mockResolvedValueOnce(undefined);
    await expect(api.deleteSong("a", true)).resolves.toBeNull();
    inv.mockResolvedValueOnce({ path: "D:\\songs\\x", unreachable: true });
    await expect(api.deleteSong("a", true)).resolves.toEqual({ path: "D:\\songs\\x", unreachable: true });
    expect(inv).toHaveBeenLastCalledWith("delete_song", { id: "a", deleteFiles: true });
  });

  it("passes the planner seed and the peak request through", async () => {
    const inv = vi.mocked(invoke);
    inv.mockResolvedValue("");
    await api.planScore("pop", "[Verse]", "full", 42);
    expect(inv).toHaveBeenLastCalledWith("plan_score", { style: "pop", lyrics: "[Verse]", mode: "full", seed: 42, abcTemperature: null, runId: null });
    await api.audioPeaks("a.wav");
    expect(inv).toHaveBeenLastCalledWith("audio_peaks", { path: "a.wav", buckets: null });
    await api.appExit();
    expect(inv).toHaveBeenLastCalledWith("app_exit");
  });

  it("sends the tool cancel and the separation purpose", async () => {
    const inv = vi.mocked(invoke);
    inv.mockResolvedValue(undefined);
    await api.cancelTool("p-1");
    expect(inv).toHaveBeenLastCalledWith("cancel_tool", { promptId: "p-1" });
    await api.separateAudio("a.wav", "m.ckpt", "s1", "align");
    expect(inv).toHaveBeenLastCalledWith("separate_audio", { path: "a.wav", model: "m.ckpt", songId: "s1", purpose: "align", runId: null });
    await api.separateAudio("a.wav", "m.ckpt");
    expect(inv).toHaveBeenLastCalledWith("separate_audio", { path: "a.wav", model: "m.ckpt", songId: null, purpose: null, runId: null });
  });

  it("passes the page's run id to every tool call", async () => {
    const inv = vi.mocked(invoke);
    inv.mockResolvedValue(undefined);
    await api.transcribeAudio("a.wav", "full", "r1");
    expect(inv).toHaveBeenLastCalledWith("transcribe_audio", { path: "a.wav", mode: "full", runId: "r1" });
    await api.transcribeAudio("a.wav", "melody");
    expect(inv).toHaveBeenLastCalledWith("transcribe_audio", { path: "a.wav", mode: "melody", runId: null });
    await api.separateAudio("a.wav", "m.ckpt", null, "align", "r2");
    expect(inv).toHaveBeenLastCalledWith("separate_audio", { path: "a.wav", model: "m.ckpt", songId: null, purpose: "align", runId: "r2" });
    await api.alignLyrics("v.wav", "la", "ja", "r2");
    expect(inv).toHaveBeenLastCalledWith("align_lyrics", { path: "v.wav", lyrics: "la", language: "ja", runId: "r2" });
    await api.planScore("pop", "[Verse]", "melody", 7, 0.5, "r3");
    expect(inv).toHaveBeenLastCalledWith("plan_score", { style: "pop", lyrics: "[Verse]", mode: "melody", seed: 7, abcTemperature: 0.5, runId: "r3" });
  });

  it("recognises the error of a cancelled tool call", () => {
    expect(isToolCancelled("キャンセルしました")).toBe(true);
    expect(isToolCancelled(new Error("キャンセルしました"))).toBe(false);
    expect(isToolCancelled("失敗: キャンセルしました")).toBe(false);
  });
});

describe("setup run contract", () => {
  const lib = readFileSync(fileURLToPath(new URL("../../src-tauri/src/lib.rs", import.meta.url)), "utf8");
  const setup = readFileSync(fileURLToPath(new URL("../../src-tauri/src/setup.rs", import.meta.url)), "utf8");

  it("recognises the refusal of a second setup_install (a wizard reloaded while the run goes on)", () => {
    const refusal = /const SETUP_ALREADY_RUNNING: &str = "([^"]+)";/.exec(lib)?.[1];
    expect(refusal, "lib.rs SETUP_ALREADY_RUNNING").toBeTruthy();
    expect(refusal!.startsWith(SETUP_ALREADY_RUNNING)).toBe(true);
    expect(isSetupAlreadyRunning(refusal)).toBe(true);
    expect(isSetupAlreadyRunning(`  ${refusal}`)).toBe(true);
    expect(isSetupAlreadyRunning("フォルダ C:\\MCSYuE2 を作成できません")).toBe(false);
  });

  it("recognises the error of a setup run stopped with 中断", () => {
    const cancelled = /pub const CANCELLED_MSG: &str = "([^"]+)";/.exec(setup)?.[1];
    expect(cancelled, "setup.rs CANCELLED_MSG").toBe(SETUP_CANCELLED_ERROR);
    expect(isSetupCancelled(SETUP_CANCELLED_ERROR)).toBe(true);
    expect(isSetupCancelled(`${SETUP_CANCELLED_ERROR}\n`)).toBe(true);
    expect(isSetupCancelled(`一部の任意コンポーネントを導入できませんでした:\n${SETUP_CANCELLED_ERROR}`)).toBe(false);
  });

  it("types every field of the system check (gpuProbeTimedOut: nvidia-smi did not answer)", () => {
    const rust = /pub struct SystemCheck \{([\s\S]*?)\n\}/.exec(setup)?.[1] ?? "";
    const fields = [...rust.matchAll(/pub (\w+):/g)].map((m) => m[1].replace(/_(\w)/g, (_, c: string) => c.toUpperCase()));
    expect(fields).toContain("gpuProbeTimedOut");
    const ts = readFileSync(fileURLToPath(new URL("../api.ts", import.meta.url)), "utf8");
    const iface = /export interface SystemCheck \{([\s\S]*?)\n\}/.exec(ts)?.[1] ?? "";
    for (const f of fields) expect(iface, `SystemCheck.${f} in api.ts`).toMatch(new RegExp(`\\b${f}\\??:`));
  });

  it("hears the end of a setup run with its error (setup://finished)", async () => {
    expect(lib).toContain('app.emit("setup://finished", SetupFinished { error:');
    const lsn = vi.mocked(listen);
    lsn.mockResolvedValueOnce(() => {});
    const heard: SetupFinished[] = [];
    await api.onSetupFinished((f) => heard.push(f));
    expect(lsn).toHaveBeenLastCalledWith("setup://finished", expect.any(Function));
    const handler = lsn.mock.lastCall![1] as (e: { payload: SetupFinished }) => void;
    handler({ payload: { error: null } });
    handler({ payload: { error: "x" } });
    expect(heard).toEqual([{ error: null }, { error: "x" }]);
  });
});
