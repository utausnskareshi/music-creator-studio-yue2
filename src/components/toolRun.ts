// State rules of a page's own tool run (transcribe / separate / align / plan) as shown by its tool://progress
// events: start, the end of the call (also when the backend sent no final event), cancel and the result line.
import { TOOL_CANCELLED_ERROR, TOOL_CANCELLED_STAGE, isToolCancelled, type ToolProgress } from "../api";

/** Title of the cancel button while the run cannot be cancelled yet (before ComfyUI accepted the prompt). */
export const TOOL_CANCEL_WAIT_HINT = "ComfyUI が処理を受け付けるとキャンセルできます";

/** Title of the cancel button after the prompt ended (e.g. 出力を保存中): the run cannot be cancelled any more. */
export const TOOL_CANCEL_TOO_LATE_HINT = "この段階ではキャンセルできません";

/** Stages the backend (tools.rs) sends after run_prompt returned: cancel_tool no longer reaches the run. */
const AFTER_PROMPT_STAGES: ReadonlySet<string> = new Set(["出力を保存中"]);

let runSeq = 0;

/**
 * A new id for one tool call of a page (passed as the call's runId; every tool://progress event of the run carries
 * it). Several pages stay mounted and may each run the same tool: a page follows only the events of its own run.
 */
export function newToolRunId(): string {
  const rnd = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `run-${++runSeq}-${rnd}`;
}

/** The event belongs to the page's own run `runId` (null: the page runs nothing) of one of `tools`. */
export function isOwnToolEvent(p: ToolProgress, runId: string | null, tools: readonly string[]): boolean {
  return runId !== null && p.runId === runId && tools.includes(p.tool);
}

/**
 * Label of a page's busy button while its tool runs: the page's own verb (`転写中` …), with the backend's stage in
 * parentheses only when it says more than that (「転写中（ComfyUI を起動中）」, not 「転写中: 処理中」).
 */
export function toolBusyLabel(verb: string, t: ToolProgress | null): string {
  const s = t?.stage ?? "";
  return !s || s === "開始" || s === "処理中" || s === verb ? `${verb}…` : `${verb}（${s}）`;
}

/** State a page shows right after it started a tool call (no event from the backend yet). */
export function toolStarted(tool: ToolProgress["tool"], stage: string): ToolProgress {
  return { tool, stage, promptId: null, done: false, error: null };
}

/**
 * State after the page's tool call rejected with `e`. A cancelled run ends neutral (stage キャンセル, no error);
 * any other failure ends as 失敗 with the backend's final error text, or `e` when no final event came (an IPC
 * error, or a check that failed before the run started).
 */
export function toolRejected(t: ToolProgress | null, tool: ToolProgress["tool"], e: unknown): ToolProgress {
  const name = t?.tool ?? tool;
  if (isToolCancelled(e)) return { tool: name, stage: TOOL_CANCELLED_STAGE, promptId: null, done: true, error: null };
  return { tool: name, stage: "失敗", promptId: null, done: true, error: t?.error ?? String(e) };
}

/** The call returned: a run whose final event never came is not left running (busy would stick). */
export function toolSettled(t: ToolProgress | null): ToolProgress | null {
  return t && !t.done ? { ...t, done: true } : t;
}

export interface ToolCancelState {
  /** the button is shown: the page's own run is in progress */
  show: boolean;
  /** prompt to cancel; null while the run cannot be cancelled (the button is disabled) */
  promptId: string | null;
  title: string;
}

/**
 * Cancel button of a page's own run (`ownRun`: the page's call has not returned; events of another page's run
 * of the same tool show no button). Usable while the latest event carries the promptId, which the backend sends
 * with 処理中 once ComfyUI accepted the prompt. Without it the title says why: not accepted yet (starting ComfyUI,
 * 音源を準備中 …) or already past the prompt (出力を保存中).
 */
export function toolCancelState(t: ToolProgress | null, ownRun: boolean): ToolCancelState {
  const show = ownRun && Boolean(t && !t.done);
  const promptId = show ? (t?.promptId ?? null) : null;
  const title = promptId ? "この処理をキャンセルします" : t && AFTER_PROMPT_STAGES.has(t.stage) ? TOOL_CANCEL_TOO_LATE_HINT : TOOL_CANCEL_WAIT_HINT;
  return { show, promptId, title };
}

/**
 * Label and enabled state of the shown cancel button. `sent`: the prompt a cancel was sent for (reset to null when
 * the cancel request failed, which enables the button again); the button then waits for the run to end.
 */
export function toolCancelButtonView(c: ToolCancelState, sent: string | null): { label: string; disabled: boolean } {
  const cancelling = c.promptId !== null && sent === c.promptId;
  return { label: cancelling ? "キャンセル中…" : "キャンセル", disabled: !c.promptId || cancelling };
}

/** Result line of a finished run: the error text (red) or a neutral note for a cancelled run; null otherwise. */
export function toolOutcome(t: ToolProgress | null): { text: string; error: boolean } | null {
  if (!t || !t.done) return null;
  if (t.error) return { text: t.error, error: true };
  if (t.stage === TOOL_CANCELLED_STAGE) return { text: TOOL_CANCELLED_ERROR, error: false };
  return null;
}
