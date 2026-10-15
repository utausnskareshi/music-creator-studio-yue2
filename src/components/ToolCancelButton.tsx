// Cancel button and result line of a page's own tool run (rules in toolRun.ts).
import { useState } from "react";
import { api, type ToolProgress } from "../api";
import { useStore } from "../store";
import { toolCancelButtonView, toolCancelState, toolOutcome } from "./toolRun";

/**
 * 「キャンセル」 for the page's own run (`running`: its call has not returned yet). Disabled until ComfyUI accepted
 * the prompt; the cancelled call then rejects with 「キャンセルしました」, which the page shows as neutral.
 */
export default function ToolCancelButton({ tool, running }: { tool: ToolProgress | null; running: boolean }) {
  const showToast = useStore((s) => s.showToast);
  /** prompt a cancel was sent for (the button waits for the run to end) */
  const [sent, setSent] = useState<string | null>(null);
  const c = toolCancelState(tool, running);
  if (!c.show) return null;
  const view = toolCancelButtonView(c, sent);
  const cancel = async () => {
    const id = c.promptId;
    if (!id) return;
    setSent(id);
    try {
      await api.cancelTool(id);
    } catch (e) {
      setSent(null); // the run goes on: the button is usable again
      showToast("error", `キャンセルできませんでした: ${String(e)}`);
    }
  };
  return (
    <button type="button" className="btn sm" onClick={() => void cancel()} disabled={view.disabled} title={c.title}>
      {view.label}
    </button>
  );
}

/** The finished run's error (red) or 「キャンセルしました」 (neutral); nothing while it runs or after a success. */
export function ToolOutcomeNote({ tool }: { tool: ToolProgress | null }) {
  const o = toolOutcome(tool);
  if (!o) return null;
  return (
    <span className={o.error ? "small" : "muted small"} style={o.error ? { color: "var(--danger)" } : undefined}>
      {o.text}
    </span>
  );
}
