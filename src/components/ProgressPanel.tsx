import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { nodeLabel, useStore, type ProgressState } from "../store";
import { MUSIC_TOKENS_PER_SECOND } from "../library/songMeta";
import { useChoiceDialog } from "./ChoiceDialog";
import { usePageActive } from "./PageActive";

/** Queued songs listed by name; the rest are counted. */
const QUEUE_SHOWN = 8;

export default function ProgressPanel() {
  const shown = usePageActive();
  // On a hidden page (kept mounted behind the one shown) the progress stays as last shown, so the panel does not
  // re-render on every ComfyUI progress event; it reads the current one when the page is shown again.
  const lastProgress = useRef<ProgressState | null>(null);
  const progress = useStore((s) => (shown || lastProgress.current === null ? s.progress : lastProgress.current));
  lastProgress.current = progress;
  const songs = useStore((s) => s.songs);
  const showToast = useStore((s) => s.showToast);
  const active = Boolean(progress.songId);
  const [, tick] = useState(0);
  const [cancellingAll, setCancellingAll] = useState(false);
  const { ask, dialog } = useChoiceDialog();
  // The log sticks to its newest line unless the user scrolled up to read older ones. A hidden page has no
  // layout (scrollTop does nothing there), so it scrolls again when shown.
  const logRef = useRef<HTMLDivElement>(null);
  const logAtBottom = useRef(true);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && shown && logAtBottom.current) el.scrollTop = el.scrollHeight;
  }, [progress.log, shown]);
  // the elapsed time only moves while a job runs, and only on the page shown (it is computed afresh when shown)
  useEffect(() => {
    if (!active || !shown) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active, shown]);
  const song = songs.find((s) => s.id === progress.songId);
  // oldest first: the order the queue runs them (the list is newest first)
  const queued = useMemo(() => songs.filter((s) => s.status === "queued").reverse(), [songs]);
  const elapsed = progress.startedAt ? Math.floor((Date.now() - progress.startedAt) / 1000) : 0;
  // The music stage's max is the token budget, a ceiling (at least the 6-minute default): the model stops at the
  // song's end, typically far below it. Its bar is shown as running, with the generated length as text.
  const music = progress.node === "music" && progress.max > 0;
  const pct = progress.max > 0 && !music ? (progress.value / progress.max) * 100 : 0;
  const tokenInfo = music
    ? ` 生成済み 約 ${(progress.value / MUSIC_TOKENS_PER_SECOND).toFixed(0)} 秒（${progress.value} トークン・上限 ${(progress.max / MUSIC_TOKENS_PER_SECOND).toFixed(0)} 秒・曲の終わりで自動停止）`
    : progress.max > 0
      ? ` ${progress.value} / ${progress.max}`
      : "";

  const cancel = async (id: string) => {
    try {
      await api.cancelJob(id);
    } catch (e) {
      showToast("error", `キャンセルできませんでした: ${String(e)}`);
    }
  };
  // Only the waiting songs: the running one keeps going (it has its own button).
  const cancelQueued = async () => {
    const choice = await ask({
      title: "待機中の曲をキャンセル",
      message: `待機中の ${queued.length} 曲をすべてキャンセルします。生成中の曲はそのまま続きます。`,
      choices: [{ value: "cancel", label: "すべてキャンセル", kind: "danger" }],
      cancelLabel: "戻る",
    });
    if (choice !== "cancel") return;
    setCancellingAll(true);
    let failed = 0;
    // the queue moved on while the dialog was open: a song that has started meanwhile is not cancelled
    const targets = useStore.getState().songs.filter((s) => s.status === "queued");
    for (const s of targets) {
      if (useStore.getState().songs.find((x) => x.id === s.id)?.status !== "queued") continue;
      try {
        // only while still queued: one that started after the check above goes on (the backend checks again)
        await api.cancelJob(s.id, true);
      } catch {
        failed++;
      }
    }
    setCancellingAll(false);
    if (failed > 0) showToast("error", `${failed} 曲をキャンセルできませんでした（すでに開始または終了した可能性があります）`);
  };

  return (
    <div className="panel stack" style={{ gap: 8 }}>
      <h3>進行状況</h3>
      {!active ? (
        // 「待機中」 is kept for the queue below: an idle panel saying it would read as a song waiting
        <div className="muted">{progress.stage || "実行中の生成はありません"}</div>
      ) : (
        <>
          <div className="row between">
            <div>
              <b>{song?.title ?? ""}</b> <span className="muted">{progress.stage}</span>
            </div>
            <div className="muted">{elapsed} 秒経過</div>
          </div>
          <div>
            {nodeLabel(progress.node)}
            <span className="muted">{tokenInfo}</span>
          </div>
          <div className={`progress-bar ${progress.max === 0 || music ? "indeterminate" : ""}`}>
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="row">
            <button
              className="btn danger sm"
              onClick={() => {
                if (progress.songId) cancel(progress.songId);
              }}
            >
              キャンセル
            </button>
          </div>
        </>
      )}
      {queued.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="row between">
            <span className="small">待機中 {queued.length} 曲</span>
            <button className="btn sm danger" disabled={cancellingAll} onClick={cancelQueued}>
              {cancellingAll ? "キャンセル中…" : "待機中をすべてキャンセル"}
            </button>
          </div>
          {queued.slice(0, QUEUE_SHOWN).map((s, i) => (
            <div key={s.id} className="row between small">
              <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.title}>
                {i + 1}. {s.title}
              </span>
              <button className="btn sm" onClick={() => cancel(s.id)}>
                キャンセル
              </button>
            </div>
          ))}
          {queued.length > QUEUE_SHOWN && <div className="small muted">ほか {queued.length - QUEUE_SHOWN} 曲</div>}
        </div>
      )}
      {progress.log.length > 0 && (
        <div
          className="log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            logAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
        >
          {progress.log.join("\n")}
        </div>
      )}
      {dialog}
    </div>
  );
}
