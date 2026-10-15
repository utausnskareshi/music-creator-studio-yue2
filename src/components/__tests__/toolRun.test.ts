import { describe, expect, it } from "vitest";
import { TOOL_CANCELLED_ERROR, TOOL_CANCELLED_STAGE, type ToolProgress } from "../../api";
import {
  toolBusyLabel,
  TOOL_CANCEL_TOO_LATE_HINT,
  TOOL_CANCEL_WAIT_HINT,
  isOwnToolEvent,
  newToolRunId,
  toolCancelButtonView,
  toolCancelState,
  toolOutcome,
  toolRejected,
  toolSettled,
  toolStarted,
} from "../toolRun";

const ev = (over: Partial<ToolProgress>): ToolProgress => ({ tool: "separate", stage: "処理中", promptId: null, done: false, error: null, ...over });

describe("tool run state (cancel buttons of the tool pages)", () => {
  it("starts without a prompt id", () => {
    expect(toolStarted("transcribe", "開始")).toEqual({ tool: "transcribe", stage: "開始", promptId: null, done: false, error: null });
  });

  it("offers cancel only for the page's own running run, and only once ComfyUI accepted the prompt", () => {
    expect(toolCancelState(null, true).show).toBe(false);
    expect(toolCancelState(ev({ stage: "ComfyUI を起動中" }), true)).toEqual({ show: true, promptId: null, title: TOOL_CANCEL_WAIT_HINT });
    const accepted = toolCancelState(ev({ promptId: "p-1" }), true);
    expect(accepted.show).toBe(true);
    expect(accepted.promptId).toBe("p-1");
    expect(accepted.title).not.toBe(TOOL_CANCEL_WAIT_HINT);
    // another page's run of the same tool, or a finished run: no button
    expect(toolCancelState(ev({ promptId: "p-1" }), false)).toMatchObject({ show: false, promptId: null });
    expect(toolCancelState(ev({ promptId: "p-1", done: true }), true).show).toBe(false);
    // the steps after the prompt (出力を保存中) carry no id: cancelling is no longer possible
    expect(toolCancelState(ev({ stage: "出力を保存中" }), true).promptId).toBeNull();
  });

  it("explains a disabled button: not accepted yet, or already past the prompt", () => {
    for (const stage of ["開始", "ComfyUI を起動中", "音源を準備中", "歌詞を整列中"]) {
      expect(toolCancelState(ev({ stage }), true).title).toBe(TOOL_CANCEL_WAIT_HINT);
    }
    expect(toolCancelState(ev({ stage: "出力を保存中" }), true)).toEqual({ show: true, promptId: null, title: TOOL_CANCEL_TOO_LATE_HINT });
  });

  it("shows キャンセル中… once a cancel was sent for the current prompt, and is usable again after a failed request", () => {
    const accepted = toolCancelState(ev({ promptId: "p-1" }), true);
    expect(toolCancelButtonView(accepted, null)).toEqual({ label: "キャンセル", disabled: false });
    expect(toolCancelButtonView(accepted, "p-1")).toEqual({ label: "キャンセル中…", disabled: true });
    // a cancel sent for an earlier run does not block this one
    expect(toolCancelButtonView(accepted, "p-0")).toEqual({ label: "キャンセル", disabled: false });
    // not cancellable yet
    expect(toolCancelButtonView(toolCancelState(ev({ stage: "音源を準備中" }), true), null)).toEqual({ label: "キャンセル", disabled: true });
  });

  it("ends a cancelled run neutral, whatever the last event was", () => {
    const cancelled = { tool: "separate", stage: TOOL_CANCELLED_STAGE, promptId: null, done: true, error: null };
    expect(toolRejected(ev({ promptId: "p-1" }), "separate", TOOL_CANCELLED_ERROR)).toEqual(cancelled);
    expect(toolRejected(null, "separate", TOOL_CANCELLED_ERROR)).toEqual(cancelled);
    // the backend's final キャンセル event came first
    expect(toolRejected(ev({ stage: TOOL_CANCELLED_STAGE, done: true }), "separate", TOOL_CANCELLED_ERROR)).toEqual(cancelled);
    expect(toolOutcome(cancelled)).toEqual({ text: TOOL_CANCELLED_ERROR, error: false });
  });

  it("ends a failed run with the backend's error, or the rejection when no final event came", () => {
    expect(toolRejected(ev({ stage: "失敗", done: true, error: "CUDA out of memory" }), "separate", "CUDA out of memory")).toMatchObject({ stage: "失敗", done: true, error: "CUDA out of memory" });
    // e.g. 音声ファイルが見つかりません: the command returned before any event
    const early = toolRejected(ev({ stage: "開始" }), "separate", "音声ファイルが見つかりません");
    expect(early).toEqual({ tool: "separate", stage: "失敗", promptId: null, done: true, error: "音声ファイルが見つかりません" });
    expect(toolOutcome(early)).toEqual({ text: "音声ファイルが見つかりません", error: true });
    // the tool of the current run is kept (ExportPage: separate, then align)
    expect(toolRejected(ev({ tool: "align" }), "separate", "x").tool).toBe("align");
    expect(toolRejected(null, "plan", "x").tool).toBe("plan");
  });

  it("settles a run whose final event never came and leaves finished ones as they are", () => {
    expect(toolSettled(ev({ stage: "処理中", promptId: "p-1" }))).toMatchObject({ done: true, stage: "処理中" });
    const done = ev({ stage: "完了", done: true });
    expect(toolSettled(done)).toBe(done);
    expect(toolSettled(null)).toBeNull();
  });

  it("shows no result line while running or after a success", () => {
    expect(toolOutcome(null)).toBeNull();
    expect(toolOutcome(ev({ error: "x" }))).toBeNull();
    expect(toolOutcome(ev({ stage: "完了", done: true }))).toBeNull();
  });
});

describe("own-run events (several pages stay mounted and may run the same tool)", () => {
  it("gives every call its own id", () => {
    const a = newToolRunId();
    const b = newToolRunId();
    expect(a).not.toBe(b);
    expect(a.startsWith("run-")).toBe(true);
  });

  it("takes only the events of the page's own run of its tools", () => {
    const mine = ev({ runId: "r1", promptId: "p-1" });
    expect(isOwnToolEvent(mine, "r1", ["separate"])).toBe(true);
    expect(isOwnToolEvent(mine, "r1", ["align", "separate"])).toBe(true);
    // another page's separation of the same tool, at the same time
    expect(isOwnToolEvent(ev({ runId: "r2", promptId: "p-2" }), "r1", ["separate"])).toBe(false);
    // no run of this page, an event without an id, or another tool
    expect(isOwnToolEvent(mine, null, ["separate"])).toBe(false);
    expect(isOwnToolEvent(ev({}), "r1", ["separate"])).toBe(false);
    expect(isOwnToolEvent(ev({ tool: "transcribe", runId: "r1" }), "r1", ["separate"])).toBe(false);
  });
});

describe("toolBusyLabel", () => {
  const t = (stage: string): ToolProgress => ({ tool: "transcribe", stage, promptId: null, done: false, error: null });
  it("shows the verb alone for the generic stages and the stage when it says more", () => {
    expect(toolBusyLabel("転写中", null)).toBe("転写中…");
    expect(toolBusyLabel("転写中", t("開始"))).toBe("転写中…");
    expect(toolBusyLabel("転写中", t("処理中"))).toBe("転写中…");
    expect(toolBusyLabel("分離中", t("ComfyUI を起動中"))).toBe("分離中（ComfyUI を起動中）");
    expect(toolBusyLabel("分離中", t("出力を保存中"))).toBe("分離中（出力を保存中）");
    expect(toolBusyLabel("ボーカルを分離中", t("ボーカルを分離中"))).toBe("ボーカルを分離中…");
  });
});
