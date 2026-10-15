import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useStore } from "../../store";
import {
  BACKDROP_Z,
  TOAST_Z,
  answerOnPress,
  cancelOnBackdropPress,
  cancelOnUnmount,
  deliberatePress,
  focusTopDialog,
  isTopDialog,
  pushDialog,
  removeDialog,
  stackedZIndex,
  updatedPending,
  type OpenDialog,
  type Pending,
} from "../ChoiceDialog";

/** z-index of a rule in styles.css. */
function cssZIndex(selector: string): number {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const rule = new RegExp(`(?:^|\\n)\\s*${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
  const z = rule && /z-index:\s*(\d+)/.exec(rule[1]);
  if (!z) throw new Error(`no z-index for ${selector}`);
  return Number(z[1]);
}

/** ChoiceDialog.tsx: the hook, and the component from `function ChoiceDialog(` to the end. */
const SOURCE = readFileSync(new URL("../ChoiceDialog.tsx", import.meta.url), "utf8");
const COMPONENT = SOURCE.slice(SOURCE.indexOf("function ChoiceDialog("));

describe("ChoiceDialog stacking", () => {
  it("paints a newly opened dialog over every open one (it owns the keyboard)", () => {
    // Dialogs render in place: a page's question comes before its score editor's in the DOM, so with one z-index
    // the editor's older question would be painted over the page's newer one that takes Esc / Enter.
    expect(stackedZIndex([])).toBe(BACKDROP_Z);
    expect(stackedZIndex([BACKDROP_Z])).toBe(BACKDROP_Z + 1);
    expect(stackedZIndex([BACKDROP_Z, BACKDROP_Z + 1])).toBe(BACKDROP_Z + 2);
    // the oldest was answered meanwhile: the new one still goes over the one left open
    expect(stackedZIndex([BACKDROP_Z + 1])).toBe(BACKDROP_Z + 2);
  });

  it("keeps every dialog under the toasts", () => {
    expect(stackedZIndex([TOAST_Z - 1])).toBeLessThan(TOAST_Z);
    expect(stackedZIndex(Array.from({ length: 20 }, (_, i) => BACKDROP_Z + i))).toBeLessThan(TOAST_Z);
  });

  it("matches styles.css", () => {
    expect(cssZIndex(".modal-backdrop")).toBe(BACKDROP_Z);
    expect(cssZIndex(".toast")).toBe(TOAST_Z);
  });

  it("gives the keyboard to the newest open dialog, which is the one painted on top", () => {
    const stack: OpenDialog[] = [];
    // the editor's question, then the page's question over it
    expect(pushDialog(stack, 1)).toBe(BACKDROP_Z);
    expect(pushDialog(stack, 2)).toBe(BACKDROP_Z + 1);
    expect(isTopDialog(stack, 2)).toBe(true);
    expect(isTopDialog(stack, 1)).toBe(false);
    // the page's question is answered: the editor's has the keyboard again (and gets the focus back, not the page)
    expect(removeDialog(stack, 2)).toBe(true);
    expect(isTopDialog(stack, 1)).toBe(true);
    // a newer question still goes over the one left open
    expect(pushDialog(stack, 3)).toBe(BACKDROP_Z + 1);
    // the older one closes under it: the newer keeps the keyboard and the focus
    expect(removeDialog(stack, 1)).toBe(false);
    expect(isTopDialog(stack, 3)).toBe(true);
    expect(removeDialog(stack, 3)).toBe(true);
    expect(stack).toEqual([]);
    expect(removeDialog(stack, 3)).toBe(false);
  });

  // The exit question opened over the library's delete question, from its 削除する; the delete question then changed
  // in place (the song started) and lost that button. When the exit question closes, its opener is gone: the delete
  // question, on top again, takes the focus as when it opened, instead of leaving it nowhere (Enter would do nothing).
  it("gives the focus to the dialog on top again when the closing one's opener cannot take it", () => {
    const stack: OpenDialog[] = [];
    const below = vi.fn();
    pushDialog(stack, 1, below);
    pushDialog(stack, 2, vi.fn());
    removeDialog(stack, 2);
    focusTopDialog(stack);
    expect(below).toHaveBeenCalledOnce();
    focusTopDialog([]);
    const effect = COMPONENT.slice(COMPONENT.indexOf("useLayoutEffect("), COMPONENT.indexOf("const details"));
    expect(effect).toMatch(/const z = pushDialog\(openDialogs, id, takeFocus\);/);
    expect(effect).toMatch(/if \(top\) \{\s*if \(opener && opener\.isConnected\) opener\.focus\(\);\s*(\/\/[^\n]*\s*)*if \(!opener \|\| document\.activeElement !== opener\) focusTopDialog\(openDialogs\);\s*\}/);
    // the page's body is no opener (nothing had the focus)
    expect(effect).toMatch(/document\.activeElement !== document\.body/);
  });

  it("is what the dialog uses: its backdrop gets the z-index, and only the top dialog takes keys", () => {
    const effect = COMPONENT.slice(COMPONENT.indexOf("useLayoutEffect("), COMPONENT.indexOf("const details"));
    expect(effect).toMatch(/const z = pushDialog\(openDialogs, id, takeFocus\);/);
    expect(effect).toMatch(/backdropRef\.current\.style\.zIndex = String\(z\)/);
    expect(effect).toMatch(/if \(!isTopDialog\(openDialogs, id\)\) return;/);
    expect(effect).toMatch(/const top = removeDialog\(openDialogs, id\);/);
    expect(COMPONENT).toMatch(/className="modal-backdrop" ref=\{backdropRef\}/);
  });
});

describe("ChoiceDialog presses", () => {
  it("ignores the second press of a double click (it lands on the question the first one opened)", () => {
    expect(deliberatePress({ detail: 1 })).toBe(true);
    // keyboard activation (Enter / Space on the focused button)
    expect(deliberatePress({ detail: 0 })).toBe(true);
    expect(deliberatePress({ detail: 2 })).toBe(false);
    expect(deliberatePress({ detail: 3 })).toBe(false);
  });

  it("answers with a button only on a deliberate press", () => {
    const onClose = vi.fn();
    answerOnPress(onClose, "replace")({ detail: 2 });
    answerOnPress(onClose, null)({ detail: 2 });
    expect(onClose).not.toHaveBeenCalled();
    answerOnPress(onClose, "replace")({ detail: 1 });
    expect(onClose).toHaveBeenLastCalledWith("replace");
    answerOnPress(onClose, null)({ detail: 0 });
    expect(onClose).toHaveBeenLastCalledWith(null);
  });

  it("cancels on the backdrop only on a deliberate press outside the modal", () => {
    const onClose = vi.fn();
    const backdrop = {};
    const press = cancelOnBackdropPress(onClose);
    press({ target: backdrop, currentTarget: backdrop, detail: 2 });
    // a press inside the modal reaches the backdrop's handler too
    press({ target: {}, currentTarget: backdrop, detail: 1 });
    expect(onClose).not.toHaveBeenCalled();
    press({ target: backdrop, currentTarget: backdrop, detail: 1 });
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("is what every press handler of the dialog goes through", () => {
    const handlers = [...COMPONENT.matchAll(/\bon(?:Click|MouseDown|MouseUp|PointerDown|PointerUp|DoubleClick)=\{([^\n]*?)\}>/g)].map((m) => m[1]);
    expect(handlers).toEqual(["cancelOnBackdropPress(onClose)", "answerOnPress(onClose, c.value)", "answerOnPress(onClose, null)"]);
    // no other way to answer
    expect(COMPONENT.match(/onClose\(/g)).toHaveLength(1);
  });
});

describe("a question whose owner unmounts", () => {
  const pending = (title: string) => {
    const resolve = vi.fn();
    const p: Pending = { id: 1, request: { title, message: "", choices: [] }, resolve, notice: null };
    return { p, resolve };
  };

  it("closes without a toast on the page shown (カバー remounts its score editor for a new transcription)", () => {
    useStore.getState().showToast("success", "転写が完了しました");
    const { p, resolve } = pending("未反映の ABC テキスト");
    cancelOnUnmount(p, true);
    expect(resolve).toHaveBeenCalledWith(null);
    // not 「画面を離れたため…」: the page was not left, and the transcription's news stays
    expect(useStore.getState().toast).toMatchObject({ kind: "success", text: "転写が完了しました" });
  });

  it("is reported when its page is hidden (the question waited there, unseen)", () => {
    const { p, resolve } = pending("未反映の ABC テキスト");
    cancelOnUnmount(p, false);
    expect(resolve).toHaveBeenCalledWith(null);
    expect(useStore.getState().toast).toMatchObject({ kind: "error", text: "画面を離れたため「未反映の ABC テキスト」の確認ができず、処理を中止しました" });
  });

  it("is cancelled that way by the hook's cleanup", () => {
    const hook = SOURCE.slice(SOURCE.indexOf("export function useChoiceDialog("), SOURCE.indexOf("export function cycleFocusIndex("));
    expect(hook).toMatch(/cancelOnUnmount\(p, visibility\.current\.active\)/);
  });
});

// A page whose open question no longer fits (ライブラリ: a waiting song started while its delete question is open)
// changes it in place. Asking again would mount a new dialog: it would open over a dialog opened after the first one
// (the app's exit question) and take its keyboard, and focus would no longer return to the element that opened it.
describe("ChoiceDialog update in place", () => {
  it("keeps the open question's dialog (its id, so no remount) and its answer, with the new request", () => {
    const resolve = vi.fn();
    const p: Pending = { id: 7, request: { title: "曲を削除", message: "a", choices: [{ value: "delete", label: "削除する", kind: "danger" }] }, resolve, notice: null };
    const next = updatedPending(p, { title: "曲を削除", message: "b", choices: [], cancelLabel: "閉じる" });
    expect(next).not.toBe(p);
    expect(next?.id).toBe(7);
    expect(next?.resolve).toBe(resolve);
    expect(next?.request).toEqual({ title: "曲を削除", message: "b", choices: [], cancelLabel: "閉じる" });
    // nothing open: nothing to update
    expect(updatedPending(null, { title: "x", message: "", choices: [] })).toBeNull();
  });

  it("is what the hook's update does, and the dialog keeps its key", () => {
    const hook = SOURCE.slice(SOURCE.indexOf("export function useChoiceDialog("), SOURCE.indexOf("export function cycleFocusIndex("));
    expect(hook).toMatch(/const next = updatedPending\(pendingRef\.current, request as ChoiceRequest<string>\);/);
    expect(hook).toMatch(/return \{ ask, update, dialog \};/);
    expect(hook).toMatch(/<ChoiceDialog key=\{pending\.id\}/);
  });
});
