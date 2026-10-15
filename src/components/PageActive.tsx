// Whether the page a component belongs to is the one shown. The work pages stay mounted while hidden (App.tsx,
// src/pages/keepAlive.ts): their input and running calls survive a page switch, but nothing on a hidden page may
// act on the whole app — sound stops, polling pauses, questions wait until the page is shown again. Outside a
// page (the app shell, the setup wizard) everything counts as shown.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { Page } from "../store";

export interface PageVisibility {
  /** the page is the one shown */
  active: boolean;
  /** the page's sidebar name ("" outside a page) */
  label: string;
  /** the page (null outside a page) */
  page?: Page | null;
}

const PageVisibilityContext = createContext<PageVisibility>({ active: true, label: "", page: null });

/** Wraps one page: hidden (display: none) while another page is shown, and tells its components which it is. */
export function PageSlot({ active, label, page = null, children }: { active: boolean; label: string; page?: Page | null; children: ReactNode }) {
  const value = useMemo(() => ({ active, label, page }), [active, label, page]);
  return (
    <div hidden={!active}>
      <PageVisibilityContext.Provider value={value}>{children}</PageVisibilityContext.Provider>
    </div>
  );
}

export function usePageVisibility(): PageVisibility {
  return useContext(PageVisibilityContext);
}

/** The page this component belongs to is shown. */
export function usePageActive(): boolean {
  return useContext(PageVisibilityContext).active;
}

/** The current visibility for async code (a result that arrives later, a notice naming the page). */
export function usePageVisibilityRef(): RefObject<PageVisibility> {
  const v = usePageVisibility();
  const ref = useRef(v);
  ref.current = v;
  return ref;
}

/** Runs `onHide` when the page is hidden (stop playback …); the latest callback is used. */
export function useOnPageHide(onHide: () => void) {
  const active = usePageActive();
  const cb = useRef(onHide);
  cb.current = onHide;
  useEffect(() => {
    if (!active) cb.current();
  }, [active]);
}
