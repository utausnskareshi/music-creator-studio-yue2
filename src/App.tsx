import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, closeRequestDialog, type CloseRequest } from "./api";
import { useStore, type Page } from "./store";
import { anyDialogOpen, useChoiceDialog } from "./components/ChoiceDialog";
import ComfyStatusBar from "./components/ComfyStatusBar";
import HelpDialog from "./components/HelpDialog";
import { isHelpKey } from "./help/keys";
import SetupWizard from "./pages/SetupWizard";
import ComposePage from "./pages/ComposePage";
import LibraryPage from "./pages/LibraryPage";
import SettingsPage from "./pages/SettingsPage";
import CoverPage from "./pages/CoverPage";
import SeparatePage from "./pages/SeparatePage";
import ExportPage from "./pages/ExportPage";
import EditPage from "./pages/EditPage";
import { PageSlot } from "./components/PageActive";
import { PAGE_LABEL, mountedPages, restoredScroll, withVisit } from "./pages/keepAlive";

const NAV: { id: Page; label: string; ico: string }[] = [
  { id: "compose", label: PAGE_LABEL.compose, ico: "♪" },
  { id: "cover", label: PAGE_LABEL.cover, ico: "⟲" },
  { id: "edit", label: PAGE_LABEL.edit, ico: "✎" },
  { id: "separate", label: PAGE_LABEL.separate, ico: "⫶" },
  { id: "export", label: PAGE_LABEL.export, ico: "⇩" },
  { id: "library", label: PAGE_LABEL.library, ico: "▤" },
  { id: "settings", label: PAGE_LABEL.settings, ico: "⚙" },
];

// Created once: re-rendering the shell (a page switch) does not re-render the pages; only what reads the page's
// visibility (PageActive.tsx) updates.
const PAGES: Record<Page, ReactNode> = {
  compose: <ComposePage />,
  cover: <CoverPage />,
  edit: <EditPage />,
  separate: <SeparatePage />,
  export: <ExportPage />,
  library: <LibraryPage />,
  settings: <SettingsPage />,
};

function ToastView() {
  const toast = useStore((s) => s.toast);
  const dismissToast = useStore((s) => s.dismissToast);
  if (!toast) return null;
  return (
    <div key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <div className="toast-text">{toast.text}</div>
      <button className="toast-close" aria-label="閉じる" title="閉じる" onClick={dismissToast}>
        ×
      </button>
    </div>
  );
}

export default function App() {
  // Only what App itself renders: the sidebar status and the toast subscribe on their own.
  const config = useStore((s) => s.config);
  const { ask, dialog } = useChoiceDialog();

  useEffect(() => {
    const { loadConfig, refreshSongs, refreshComfy, applyJobUpdate, applyComfyEvent, showToast } = useStore.getState();
    loadConfig();
    // A broken settings file started the app with the defaults (the setup wizard opens): say why, until closed.
    api
      .takeStartupNotices()
      .then((notices) => notices.forEach((n) => showToast("error", n, { sticky: true })))
      .catch(() => {});
    refreshSongs().catch((e) => showToast("error", `曲の一覧を読み込めませんでした: ${String(e)}`));
    refreshComfy();
    // The backend keeps the window open while something runs and asks here first.
    const onCloseRequested = async (r: CloseRequest) => {
      const { message, details, note } = closeRequestDialog(r);
      const choice = await ask({
        title: "アプリを終了",
        message,
        details,
        note,
        choices: [{ value: "exit", label: "終了する", kind: "danger" }],
        cancelLabel: "終了しない",
      });
      if (choice !== "exit") return;
      try {
        await api.appExit();
      } catch (e) {
        showToast("error", `終了できませんでした: ${String(e)}`);
      }
    };
    const unsubs: Promise<() => void>[] = [api.onJobUpdate(applyJobUpdate), api.onComfyEvent(applyComfyEvent), api.onCloseRequested(onCloseRequested)];
    const timer = setInterval(refreshComfy, 5000);
    return () => {
      clearInterval(timer);
      unsubs.forEach((u) => u.then((f) => f()));
    };
  }, [ask]);

  if (!config)
    return (
      <>
        <div className="page">読み込み中…</div>
        {dialog}
        <ToastView />
      </>
    );
  if (!config.setupCompleted)
    return (
      <>
        <SetupWizard />
        {dialog}
        <ToastView />
      </>
    );

  return (
    <>
      <Shell />
      {dialog}
      <ToastView />
    </>
  );
}

/**
 * The main window: sidebar and pages. The work pages (keepAlive.ts KEPT_PAGES) stay mounted after their first
 * visit and are only hidden, so their input, results and running calls survive a page switch; ライブラリ and 設定
 * are built afresh on every visit. Mounted only while setup is complete (a new setup starts every page afresh).
 */
function Shell() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  // pages whose question waits until they are shown (the toast that announced it may have been replaced)
  const waitingKey = useStore((s) => [...new Set(s.waitingQuestions.map((w) => w.page))].sort().join(","));
  const waitingPages = useMemo(() => new Set(waitingKey ? waitingKey.split(",") : []), [waitingKey]);
  const [visited, setVisited] = useState<ReadonlySet<Page>>(() => withVisit(new Set(), page));
  const nextVisited = withVisit(visited, page);
  if (nextVisited !== visited) setVisited(nextVisited);

  // The scroll container is shared: a kept page comes back where it was left, any other page starts at the top.
  const pageRef = useRef<HTMLDivElement>(null);
  const scrolls = useRef<Partial<Record<Page, number>>>({});
  const shown = useRef(page);
  useLayoutEffect(() => {
    shown.current = page;
    pageRef.current?.scrollTo({ top: restoredScroll(scrolls.current, page) });
  }, [page]);

  // F1: the help of the page shown. Registered first in the capture phase, so it sees F1 before any dialog's
  // listener stops it: it always keeps WebView's own F1, and opens nothing while a question or the help is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isHelpKey(e)) return;
      e.preventDefault();
      if (anyDialogOpen()) return;
      const s = useStore.getState();
      s.openHelp(s.page);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      // the shell goes (セットアップをやり直す): its help with it, so it is not open again when the shell comes back
      useStore.getState().closeHelp();
    };
  }, []);

  return (
    <>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-title">Music Creator Studio</div>
            <div className="brand-sub">YuE2 · ComfyUI ローカル生成</div>
          </div>
          {NAV.map((n) => {
            const waiting = waitingPages.has(n.id);
            return (
              <button
                key={n.id}
                className={`nav-btn ${page === n.id ? "active" : ""}`}
                aria-current={page === n.id ? "page" : undefined}
                aria-label={waiting ? `${n.label}（確認待ち）` : undefined}
                title={waiting ? "この画面で確認が必要です。画面を開くと表示します" : undefined}
                onClick={() => setPage(n.id)}
              >
                <span className="ico">{n.ico}</span>
                {n.label}
                {waiting && <span className="nav-badge">確認待ち</span>}
              </button>
            );
          })}
          <ComfyStatusBar />
        </aside>
        <main className="main">
          <div
            className="page"
            ref={pageRef}
            onScroll={(e) => {
              scrolls.current[shown.current] = e.currentTarget.scrollTop;
            }}
          >
            {mountedPages(visited, page).map((p) => (
              <PageSlot key={p} active={p === page} label={PAGE_LABEL[p]} page={p}>
                {PAGES[p]}
              </PageSlot>
            ))}
          </div>
        </main>
      </div>
      {/* outside the pages: not in a hidden page, and the wheel over its backdrop scrolls no page behind it */}
      <HelpDialog />
    </>
  );
}
