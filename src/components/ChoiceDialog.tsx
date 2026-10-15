// A modal with explicit choices; also the app's only confirmation dialog (the WebView's own confirm / alert /
// prompt do not work under tauri-plugin-dialog). A page calls `ask()` and renders `dialog`; the promise resolves
// with the chosen value, or null when the user cancels (キャンセル, Esc or a click outside).
// A page that is hidden (kept mounted behind another page, see PageActive.tsx) may ask too, e.g. when a slow call
// it started finishes: the question waits, unseen and without taking the keyboard, until the page is shown again,
// and a notice tells the user where it waits.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { deferredQuestionNotice } from "../pages/keepAlive";
import { usePageVisibilityRef } from "./PageActive";

export interface Choice<T extends string> {
  value: T;
  label: string;
  kind?: "primary" | "danger";
}

export interface ChoiceRequest<T extends string> {
  title: string;
  message: ReactNode;
  /** bullet points under the message (e.g. checker findings) */
  details?: string[];
  /** small print under the details (e.g. what happens when the user closes the window again) */
  note?: string;
  choices: Choice<T>[];
  cancelLabel?: string;
}

export interface Pending {
  /** remounts the dialog per question (initial focus, focus return) */
  id: number;
  request: ChoiceRequest<string>;
  resolve: (v: string | null) => void;
  /** the notice shown because the page was hidden when it asked (removed once the question is on screen) */
  notice: string | null;
}

const MAX_DETAILS = 12;
let questionSeq = 0;

/**
 * Removes the notice of a hidden page's question (it is on screen now, or no longer waits), shown or kept behind
 * another toast, and the sidebar's mark of its page.
 */
function dropNotice(p: Pending | null) {
  if (!p) return;
  const { dropToastText, clearWaitingQuestion } = useStore.getState();
  clearWaitingQuestion(p.id);
  if (!p.notice) return;
  dropToastText(p.notice);
  p.notice = null;
}

/** A question that could not be shown (its page was left) cancels the flow that asked; the user is told so. */
function notifyAbandoned(title: string) {
  useStore.getState().showToast("error", `画面を離れたため「${title}」の確認ができず、処理を中止しました`);
}

/**
 * The question `p` of an owner that unmounts is cancelled (the flow that asked gets null). The user is told only
 * when its page is hidden: the work pages stay mounted, so an owner unmounting on the page shown was replaced
 * there (カバー's score editor, remounted for a new transcription), and its question was about content that is
 * gone. A toast would be false (the page was not left) and would replace the page's own news (「転写が完了しました」).
 */
export function cancelOnUnmount(p: Pending | null, pageShown: boolean) {
  if (!p) return;
  dropNotice(p);
  p.resolve(null);
  if (!pageShown) notifyAbandoned(p.request.title);
}

/**
 * The open question `p` with `request` instead of its own: the same question (its id, so its dialog is not mounted
 * again, and its answer goes to the same flow). Null when no question is open.
 */
export function updatedPending(p: Pending | null, request: ChoiceRequest<string>): Pending | null {
  return p ? { ...p, request } : null;
}

export function useChoiceDialog() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  // Set inside the effect (not by useRef(true)): StrictMode's simulated unmount / remount must end mounted.
  const mountedRef = useRef(false);
  const visibility = usePageVisibilityRef();

  const ask = useCallback(<T extends string>(request: ChoiceRequest<T>): Promise<T | null> => {
    // After the page unmounted nobody could answer: cancel at once instead of never settling.
    if (!mountedRef.current) {
      notifyAbandoned(request.title);
      return Promise.resolve(null);
    }
    // Only one question at a time: an unanswered earlier one counts as cancelled (its notice goes with it).
    dropNotice(pendingRef.current);
    pendingRef.current?.resolve(null);
    const { active, label, page } = visibility.current;
    const notice = active ? null : deferredQuestionNotice(label, request.title);
    const id = ++questionSeq;
    if (notice) {
      useStore.getState().showToast("info", notice, { sticky: true });
      if (page) useStore.getState().setWaitingQuestion({ id, page, title: request.title });
    }
    return new Promise<T | null>((resolve) => {
      const p: Pending = { id, request: request as ChoiceRequest<string>, resolve: resolve as (v: string | null) => void, notice };
      pendingRef.current = p;
      setPending(p);
    });
  }, [visibility]);

  /**
   * Changes the open question in place (a page whose question no longer fits what it asks about). Asking again would
   * mount a new dialog: over a dialog opened after this one (the app's exit question), taking its keyboard, and with
   * focus no longer returning to what opened the question. The focused button stays focused. False when none is open.
   */
  const update = useCallback(<T extends string>(request: ChoiceRequest<T>): boolean => {
    const next = updatedPending(pendingRef.current, request as ChoiceRequest<string>);
    if (!next) return false;
    pendingRef.current = next;
    setPending(next);
    return true;
  }, []);

  const close = useCallback((v: string | null) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    dropNotice(p);
    p?.resolve(v);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // An owner that unmounts with a question open cancels it.
      const p = pendingRef.current;
      pendingRef.current = null;
      cancelOnUnmount(p, visibility.current.active);
    };
  }, []);

  // A hidden page's question is not rendered: it would be invisible and still take every key press.
  const shown = Boolean(pending) && visibility.current.active;
  useEffect(() => {
    // the question is on screen now: its notice has done its job
    if (shown) dropNotice(pendingRef.current);
  }, [shown]);
  const dialog = pending && shown ? <ChoiceDialog key={pending.id} request={pending.request} onClose={close} /> : null;
  return { ask, update, dialog };
}

/** Index to focus after Tab (Shift+Tab when `back`) among `count` elements, when `current` (-1 = outside) is focused. */
export function cycleFocusIndex(count: number, current: number, back: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return back ? count - 1 : 0;
  return back ? (current - 1 + count) % count : (current + 1) % count;
}

/** Choice buttons first, then キャンセル: the initial focus is キャンセル when any choice is destructive. */
export function initialFocusIndex(choices: Choice<string>[]): number {
  return choices.some((c) => c.kind === "danger") ? choices.length : 0;
}

/** z-index of .modal-backdrop and of .toast in styles.css: stacked dialogs stay under the toasts. */
export const BACKDROP_Z = 40;
export const TOAST_Z = 50;

/**
 * z-index of a dialog opened while dialogs with the z-indexes `open` are shown: over all of them, so the dialog
 * that takes the keyboard is also the one on screen. Dialogs render in place and a page's question comes before
 * its editors' in the DOM: with one z-index for all, an editor's older question was painted over the newer one.
 */
export function stackedZIndex(open: readonly number[]): number {
  return Math.min(TOAST_Z - 1, Math.max(BACKDROP_Z, ...open.map((z) => z + 1)));
}

/**
 * A press that answers the dialog: not the second press of a double click (a double-clicked generate button
 * opens its question with the first click; the second must neither dismiss nor answer it unread). Keyboard
 * activation of a button has detail 0.
 */
export function deliberatePress(e: { detail: number }): boolean {
  return e.detail <= 1;
}

/** onClick of a choice or the cancel button: answers `value`, not on the second press of a double click. */
export function answerOnPress(onClose: (v: string | null) => void, value: string | null) {
  return (e: { detail: number }) => {
    if (deliberatePress(e)) onClose(value);
  };
}

/** onMouseDown of the backdrop: a press outside the modal cancels, not the second press of a double click. */
export function cancelOnBackdropPress(onClose: (v: string | null) => void) {
  return (e: { target: unknown; currentTarget: unknown; detail: number }) => {
    if (e.target === e.currentTarget && deliberatePress(e)) onClose(null);
  };
}

export interface OpenDialog {
  id: number;
  z: number;
  /** gives the dialog the focus it takes when it opens (unless it holds the focus already) */
  focus?: () => void;
}

/** Puts dialog `id` on top of the open dialogs `stack` (newest last); returns its z-index (stackedZIndex). */
export function pushDialog(stack: OpenDialog[], id: number, focus?: () => void): number {
  const z = stackedZIndex(stack.map((d) => d.z));
  stack.push({ id, z, focus });
  return z;
}

/** The dialog on top of `stack` takes the focus (the one over it closed and its opener could not take it back). */
export function focusTopDialog(stack: readonly OpenDialog[]) {
  stack[stack.length - 1]?.focus?.();
}

/** Dialog `id` is the top one: only it handles the keyboard. */
export function isTopDialog(stack: readonly OpenDialog[], id: number): boolean {
  return stack[stack.length - 1]?.id === id;
}

/** Takes dialog `id` off `stack`; true when it was the top one (it had the keyboard and the focus). */
export function removeDialog(stack: OpenDialog[], id: number): boolean {
  const i = stack.findIndex((d) => d.id === id);
  if (i < 0) return false;
  stack.splice(i, 1);
  return i === stack.length;
}

// Open dialogs, newest last: only the top one handles the keyboard (e.g. the app's close question over a page's),
// and it is painted on top (stackedZIndex).
let dialogSeq = 0;
const openDialogs: OpenDialog[] = [];

// Other modal dialogs (the help, HelpDialog.tsx) join the same stack: the newest dialog, of either kind, is painted
// on top and takes the keyboard, and the ids come from the one counter (two dialogs with one id would both act on Esc).

/** Puts a new dialog on top of the open ones: its id and z-index (`focus`: what it focuses when it is on top again). */
export function joinDialogStack(focus?: () => void): { id: number; z: number } {
  const id = ++dialogSeq;
  return { id, z: pushDialog(openDialogs, id, focus) };
}

/** Dialog `id` is the top one: only it handles the keyboard. */
export const isOnTopOfStack = (id: number): boolean => isTopDialog(openDialogs, id);

/** Takes dialog `id` off the stack; true when it was the top one. */
export const leaveDialogStack = (id: number): boolean => removeDialog(openDialogs, id);

/** The dialog now on top takes the focus. */
export const focusStackTop = (): void => focusTopDialog(openDialogs);

/** A dialog is open (a question or the help): F1 opens no help over it. */
export const anyDialogOpen = (): boolean => openDialogs.length > 0;

function ChoiceDialog({ request, onClose }: { request: ChoiceRequest<string>; onClose: (v: string | null) => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  // the question as it is now (it may change in place: useChoiceDialog update)
  const requestRef = useRef(request);
  requestRef.current = request;
  const focusIndex = initialFocusIndex(request.choices);
  // A layout effect: the z-index is set before the dialog is first painted (not one frame under an older one).
  useLayoutEffect(() => {
    const id = ++dialogSeq;
    idRef.current = id;
    const buttons = () => Array.from(modalRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    // The focus the dialog takes when it opens; also when it is on top again and the focus went nowhere.
    const takeFocus = () => {
      if (!modalRef.current || modalRef.current.contains(document.activeElement)) return;
      buttons()[initialFocusIndex(requestRef.current.choices)]?.focus();
    };
    const z = pushDialog(openDialogs, id, takeFocus);
    if (backdropRef.current) backdropRef.current.style.zIndex = String(z);
    // what had the focus (not the page's body: nothing had it)
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    buttons()[focusIndex]?.focus();
    // The modal owns the keyboard: stopped in the capture phase on window, the key reaches no page or editor
    // shortcut behind it (window / document handlers or React onKeyDown, e.g. the score editor's key handler for
    // Space, Delete and the arrow keys). Enter / Space still act on the focused button (default action); Tab
    // cycles through the dialog's buttons so focus never reaches the page.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (!isTopDialog(openDialogs, id)) return;
      if (e.key === "Escape") {
        onClose(null);
      } else if (e.key === "Tab") {
        const list = buttons();
        const next = cycleFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        e.preventDefault();
        list[next]?.focus();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      const top = removeDialog(openDialogs, id);
      // give focus back to what had it before the question (when it is still on screen); not when a newer
      // dialog over this one holds the focus
      if (top) {
        if (opener && opener.isConnected) opener.focus();
        // the opener is gone or cannot take the focus (a button of the question below, lost when that question changed
        // in place; a button disabled meanwhile): the dialog now on top takes it, as when it opened
        if (!opener || document.activeElement !== opener) focusTopDialog(openDialogs);
      }
    };
    // focusIndex is fixed for the dialog's lifetime: every question mounts its own dialog (key)
  }, [onClose]);
  // A question changed in place (useChoiceDialog update) may have lost the focused button (削除する, gone while the
  // song is generated): the focus goes to the button a new question would focus. Only on the top dialog: a dialog
  // opened over this one keeps the focus.
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal || modal.contains(document.activeElement) || !isTopDialog(openDialogs, idRef.current)) return;
    modal.querySelectorAll<HTMLElement>("button:not([disabled])")[initialFocusIndex(request.choices)]?.focus();
  }, [request]);
  const details = request.details ?? [];
  return (
    <div className="modal-backdrop" ref={backdropRef} onMouseDown={cancelOnBackdropPress(onClose)}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={request.title} ref={modalRef}>
        <h3>{request.title}</h3>
        <div className="modal-message">{request.message}</div>
        {details.length > 0 && (
          <ul className="modal-details">
            {details.slice(0, MAX_DETAILS).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
            {details.length > MAX_DETAILS && <li>ほか {details.length - MAX_DETAILS} 件</li>}
          </ul>
        )}
        {request.note && <div className="modal-note">{request.note}</div>}
        <div className="modal-actions">
          {request.choices.map((c) => (
            <button key={c.value} className={`btn${c.kind ? ` ${c.kind}` : ""}`} onClick={answerOnPress(onClose, c.value)}>
              {c.label}
            </button>
          ))}
          <button className="btn" onClick={answerOnPress(onClose, null)}>
            {request.cancelLabel ?? "キャンセル"}
          </button>
        </div>
      </div>
    </div>
  );
}
