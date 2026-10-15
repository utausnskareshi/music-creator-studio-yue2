// The help dialog, opened by a page's ヘルプ button (PageHeader.tsx) or F1 (App.tsx) with that page's help. One for
// the app, rendered by the shell outside the pages. It is a modal like the questions (ChoiceDialog.tsx) and joins
// their stack: a question that opens while the help is shown (an AI draft that finished, the exit question) is
// painted over it and takes the keyboard, and the help has it again when the question closes.
import { useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page } from "../store";
import { HELP, HELP_ORDER } from "../help";
import { helpKeyAction } from "../help/keys";
import HelpView from "./HelpView";
import { answerOnPress, cancelOnBackdropPress, cycleFocusIndex, focusStackTop, isOnTopOfStack, joinDialogStack, leaveDialogStack } from "./ChoiceDialog";

export default function HelpDialog() {
  const help = useStore((s) => s.help);
  const closeHelp = useStore((s) => s.closeHelp);
  return help ? <HelpModal initialPage={help} onClose={closeHelp} /> : null;
}

/** What Tab moves between in `root`, in document order: enabled controls and the help's text pane, as shown. */
function tabStops(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')).filter((el) => el.offsetParent !== null);
}

function HelpModal({ initialPage, onClose }: { initialPage: Page; onClose: () => void }) {
  // the page whose help is shown: another one can be picked in the dialog (the app's page stays)
  const [page, setPage] = useState(initialPage);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // what had the focus when the help opened (not the page's body: nothing had it). Read once per opening: in
  // development StrictMode runs the effect below twice, and the second run would find the help's own search box.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);

  // Once per opening, before the first paint. The keyboard listener is registered once and stays first among the
  // dialogs' listeners while the help is open: listeners on window run in the order they were added, and a
  // question opened later must come after it (registering again would put the help after the question, and one
  // Esc would close both).
  useLayoutEffect(() => {
    if (openerRef.current === undefined) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    const opener = openerRef.current;
    const takeFocus = () => {
      if (!modalRef.current || modalRef.current.contains(document.activeElement)) return;
      searchRef.current?.focus();
    };
    const { id, z } = joinDialogStack(takeFocus);
    if (backdropRef.current) backdropRef.current.style.zIndex = String(z);
    searchRef.current?.focus();
    // The dialog owns the keyboard, as a question does: stopped in the capture phase on window, no key reaches the
    // page behind it (typing in the search box still types: only the propagation stops). Only the dialog on top acts.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const action = helpKeyAction(e, isOnTopOfStack(id));
      if (action === "none") return;
      e.preventDefault();
      if (action === "close") {
        closeRef.current();
      } else if (action === "tab" || action === "tab-back") {
        const stops = tabStops(modalRef.current);
        stops[cycleFocusIndex(stops.length, stops.indexOf(document.activeElement as HTMLElement), action === "tab-back")]?.focus();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      // The focus goes back to what had it (the page's ヘルプ button, the field F1 was pressed in), unless a dialog
      // opened over the help holds it; when that is gone, the dialog now on top takes it. Once React's change is
      // done: React runs this cleanup in the middle of it and ignores the DOM events fired there, so the field's own
      // focus handler (書き出し's time field starts its edit in it) would not run.
      if (leaveDialogStack(id)) {
        queueMicrotask(() => {
          const active = document.activeElement;
          // something has the focus already: a dialog opened in the same change, or the help again (StrictMode)
          if (active && active !== document.body) return;
          if (opener && opener.isConnected) opener.focus({ preventScroll: true });
          if (!opener || document.activeElement !== opener) focusStackTop();
        });
      }
    };
  }, []);

  // another page's help or other search words: from the top. A page picked in the empty search's list takes away
  // the button that had the focus: the help's text gets it (it would be on the page's body, outside the dialog).
  useLayoutEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
    if (modalRef.current && !modalRef.current.contains(document.activeElement)) paneRef.current?.focus({ preventScroll: true });
  }, [page, query]);

  const toSection = (id: string) => {
    const pane = paneRef.current;
    const section = pane?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    // the pane itself scrolls (scrollIntoView would also scroll the dialog's and the app's own containers)
    if (pane && section) pane.scrollTop = section.offsetTop;
  };

  return (
    <div
      className="modal-backdrop"
      ref={backdropRef}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // keeps the focus where it is (Chromium would move it to the page's body after the dialog is gone; closing
        // gives it back to the opener)
        e.preventDefault();
        cancelOnBackdropPress(() => closeRef.current())(e);
      }}
    >
      <HelpView
        docs={HELP}
        order={HELP_ORDER}
        page={page}
        input={input}
        query={query}
        titleId="help-dialog-title"
        onInput={(text, composing) => {
          setInput(text);
          // an IME conversion is searched once it is committed (compositionend)
          if (!composing) setQuery(text);
        }}
        onCompositionEnd={(text) => {
          setInput(text);
          setQuery(text);
        }}
        onClear={() => {
          setInput("");
          setQuery("");
          searchRef.current?.focus();
        }}
        onPage={setPage}
        onSection={toSection}
        onClose={answerOnPress(() => closeRef.current(), null)}
        modalRef={modalRef}
        searchRef={searchRef}
        paneRef={paneRef}
      />
    </div>
  );
}
