import { describe, expect, it } from "vitest";
import { helpKeyAction, isHelpKey, isImeKey } from "../keys";

const key = (k: string, o: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; isComposing: boolean; keyCode: number }> = {}) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 0,
  ...o,
});

describe("help keys", () => {
  it("opens the help with F1 alone, not with a modifier or during an IME conversion", () => {
    expect(isHelpKey(key("F1"))).toBe(true);
    for (const m of ["ctrlKey", "altKey", "shiftKey", "metaKey"] as const) expect(isHelpKey(key("F1", { [m]: true }))).toBe(false);
    expect(isHelpKey(key("F1", { isComposing: true }))).toBe(false);
    expect(isHelpKey(key("F2"))).toBe(false);
  });

  it("knows the keys an IME is still using", () => {
    expect(isImeKey(key("Escape", { isComposing: true }))).toBe(true);
    // the IME's own key events: "Process" and keyCode 229
    expect(isImeKey(key("Process"))).toBe(true);
    expect(isImeKey(key("Tab", { keyCode: 229 }))).toBe(true);
    expect(isImeKey(key("Escape"))).toBe(false);
  });

  it("closes with Esc and moves focus with Tab only on top and outside an IME conversion", () => {
    expect(helpKeyAction(key("Escape"), true)).toBe("close");
    expect(helpKeyAction(key("Tab"), true)).toBe("tab");
    expect(helpKeyAction(key("Tab", { shiftKey: true }), true)).toBe("tab-back");
    expect(helpKeyAction(key("F1"), true)).toBe("prevent");
    expect(helpKeyAction(key("a"), true)).toBe("none");
    // a question over the help has the keyboard
    expect(helpKeyAction(key("Escape"), false)).toBe("none");
    expect(helpKeyAction(key("Tab"), false)).toBe("none");
    // Esc cancels a conversion and Tab picks a prediction in MS-IME: the help leaves them to the IME
    expect(helpKeyAction(key("Escape", { isComposing: true }), true)).toBe("none");
    expect(helpKeyAction(key("Tab", { keyCode: 229 }), true)).toBe("none");
  });
});
