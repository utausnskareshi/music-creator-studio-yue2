// Keys of the help: F1 opens it (src/App.tsx), and inside the dialog Esc closes it and Tab stays in it
// (src/components/HelpDialog.tsx). The dialog's listener takes every key before the page (like ChoiceDialog), so all
// of its key handling is here.

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** A key the IME is still using (a conversion is open): Esc cancels the conversion, Tab picks a prediction. */
export function isImeKey(e: KeyLike): boolean {
  return Boolean(e.isComposing) || e.key === "Process" || e.keyCode === 229;
}

/** F1 alone, outside a conversion: open the help of the page shown. */
export function isHelpKey(e: KeyLike): boolean {
  return e.key === "F1" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !isImeKey(e);
}

export type HelpKeyAction = "none" | "close" | "tab" | "tab-back" | "prevent";

/** What the open help does with a key; `top`: no question is open over it (a question has the keyboard then). */
export function helpKeyAction(e: KeyLike, top: boolean): HelpKeyAction {
  if (!top || isImeKey(e)) return "none";
  if (e.key === "Escape") return "close";
  if (e.key === "Tab") return e.shiftKey ? "tab-back" : "tab";
  if (e.key === "F1") return "prevent";
  return "none";
}
