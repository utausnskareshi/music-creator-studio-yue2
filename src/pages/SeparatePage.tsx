import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isToolCancelled, type SeparationResult, type ToolProgress } from "../api";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import Player from "../components/Player";
import ToolCancelButton, { ToolOutcomeNote } from "../components/ToolCancelButton";
import { isOwnToolEvent, newToolRunId, toolBusyLabel, toolRejected, toolSettled, toolStarted } from "../components/toolRun";
import { usePageVisibilityRef } from "../components/PageActive";
import { noticeFrom } from "./keepAlive";
import { LOCK_HINT } from "./locks";
import PageHeader from "../components/PageHeader";

const MODEL_LABELS: Record<string, string> = {
  "model_bs_roformer_ep_317_sdr_12.9755.ckpt": "BS-Roformer 1297（最高品質・推奨）",
  "model_bs_roformer_ep_368_sdr_12.9628.ckpt": "BS-Roformer 1296",
  "vocals_mel_band_roformer.ckpt": "MelBand-Roformer（Kim）",
  "melband_roformer_big_beta4.ckpt": "MelBand-Roformer big beta4",
  "htdemucs_ft.yaml": "Demucs htdemucs_ft（高速・低 VRAM）",
};

export default function SeparatePage() {
  const { songs, selectedSongId, showToast } = useStore(useShallow((s) => ({ songs: s.songs, selectedSongId: s.selectedSongId, showToast: s.showToast })));
  const visibility = usePageVisibilityRef();
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [source, setSource] = useState("");
  const [sourceSongId, setSourceSongId] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolProgress | null>(null);
  /** this page's separation call has not returned yet (its cancel button; another page's run shows none) */
  const [running, setRunning] = useState(false);
  /** run id of that call: only its tool events are shown (automatic timing on 書き出し separates too) */
  const runRef = useRef<string | null>(null);
  const [result, setResult] = useState<SeparationResult | null>(null);
  const [comps, setComps] = useState<{ id: string; installed: boolean }[]>([]);
  // A song deleted in ライブラリ while it is this page's source: its audio (unless its folder was kept outside the
  // song folder) and the stems separated from it are gone, so the page lets go of them. A separation of it still
  // running shows no result when it returns (the backend refuses to save it: a notice, not an error).
  const lastDeleted = useStore((s) => s.lastDeletedSong);
  const deletedIds = useRef(new Set<string>());
  useEffect(() => {
    if (!lastDeleted) return;
    deletedIds.current.add(lastDeleted.id);
    if (lastDeleted.id !== sourceSongId) return;
    setSourceSongId(null);
    setResult(null);
    if (!lastDeleted.kept) setSource("");
  }, [lastDeleted?.n]);

  useEffect(() => {
    api.separationModels().then((m) => {
      setModels(m);
      setModel(m[0] ?? "");
    });
    api.setupStatus().then((cs) => setComps(cs.map((c) => ({ id: c.id, installed: c.installed }))));
    const un = api.onToolProgress((p) => {
      if (isOwnToolEvent(p, runRef.current, ["separate"])) setTool(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const selected = useMemo(() => songs.find((s) => s.id === selectedSongId) ?? null, [songs, selectedSongId]);
  const busy = Boolean(tool && !tool.done);
  const libInstalled = comps.find((c) => c.id === "audio_separator")?.installed ?? true;
  const modelInstalled = comps.find((c) => c.id === "bs_roformer")?.installed ?? true;

  const pickFile = async () => {
    const p = await open({ multiple: false, filters: [{ name: "音声", extensions: ["wav", "flac", "mp3", "m4a", "ogg", "opus", "aac"] }] });
    if (typeof p === "string") {
      setSource(p);
      setSourceSongId(null);
      setResult(null);
    }
  };
  const useLibrarySong = () => {
    if (!selected) return showToast("info", "ライブラリで曲を選択してください");
    if (selected.status !== "done" || !selected.audioPath)
      return showToast(
        "info",
        selected.status === "queued" || selected.status === "running" ? "選択中の曲はまだ生成中です（完了後に使えます）" : "選択中の曲には音声がありません（生成が完了した曲を選んでください）",
      );
    setSource(selected.audioPath);
    setSourceSongId(selected.id);
    setResult(null);
  };
  const run = async () => {
    if (!source) return showToast("error", "音源を選択してください");
    setResult(null);
    const runId = newToolRunId();
    runRef.current = runId;
    setTool(toolStarted("separate", "開始"));
    setRunning(true);
    const songAtStart = sourceSongId;
    try {
      const r = await api.separateAudio(source, model, sourceSongId, null, runId);
      // the source song was deleted meanwhile (its folder with the stems too)
      if (songAtStart && deletedIds.current.has(songAtStart)) return;
      setResult(r);
      showToast("success", noticeFrom("ボーカル分離が完了しました", visibility.current.active, visibility.current.label));
    } catch (e) {
      if (songAtStart && deletedIds.current.has(songAtStart)) {
        // The source song was deleted meanwhile (the page let go of it; the backend saves no stems for it): the
        // user's own action ends the run as 中止, with a notice instead of a red failure.
        setTool(null);
        showToast("info", noticeFrom("曲がライブラリから削除されたため、分離を中止しました", visibility.current.active, visibility.current.label));
        return;
      }
      // Some failures return before the backend sends its final progress event: end the busy state here.
      // A cancel is not an error: the page shows 「キャンセルしました」 instead of a red toast.
      setTool((t) => toolRejected(t, "separate", e));
      if (!isToolCancelled(e)) showToast("error", noticeFrom(String(e), visibility.current.active, visibility.current.label));
    } finally {
      setTool(toolSettled);
      setRunning(false);
      if (runRef.current === runId) runRef.current = null;
    }
  };

  return (
    <div>
      <PageHeader page="separate" />
      <p className="page-desc">生成した曲や外部の音源から、ボーカルと伴奏（インストゥルメンタル）を分離して WAV で書き出します。同期歌詞のタイミング検出にも分離したボーカルが使われます。</p>
      {(!libInstalled || !modelInstalled) && (
        <div className="panel" style={{ borderColor: "var(--warn)", marginBottom: 12 }}>
          <span className="hint">分離ライブラリまたはモデルが未導入です。設定の「セットアップをやり直す」から audio-separator と BS-Roformer を追加してください。</span>
        </div>
      )}
      <div className="grid-compose">
        <div className="stack">
          <div className="panel stack">
            <h3>音源</h3>
            {/* the running separation reads this source and model: both stay put until it ends (pages/locks.ts) */}
            <div className="row">
              <button className="btn" onClick={pickFile} disabled={busy} title={busy ? LOCK_HINT.separating : undefined}>音声ファイルを選択</button>
              <button className="btn" onClick={useLibrarySong} disabled={!selected || busy} title={busy ? LOCK_HINT.separating : undefined}>ライブラリの選択中の曲を使う</button>
            </div>
            <div className="mono small" style={{ wordBreak: "break-all" }}>{source || "未選択"}</div>
            {source && (
              <div className="panel" style={{ padding: 10 }}>
                <Player audioPath={source} title="元の音源" />
              </div>
            )}
          </div>
          <div className="panel stack">
            <h3>分離モデル</h3>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} title={busy ? LOCK_HINT.separating : undefined}>
              {models.map((m) => (
                <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>
              ))}
            </select>
            <div className="muted small">初回はモデル（数百 MB）の取得に時間がかかることがあります。VRAM 使用量は約 3〜4GB です。</div>
            <div className="row">
              <button className="btn primary big" onClick={run} disabled={!source || busy}>
                {busy ? toolBusyLabel("分離中", tool) : "ボーカルと伴奏に分離"}
              </button>
              <ToolCancelButton tool={tool} running={running} />
              <ToolOutcomeNote tool={tool} />
            </div>
          </div>
        </div>
        <div className="stack">
          <div className="panel stack">
            <h3>ボーカル</h3>
            <Player audioPath={result?.vocalsPath ?? null} title={result ? "vocals.wav" : undefined} placeholder="分離すると表示されます" />
          </div>
          <div className="panel stack">
            <h3>伴奏（インストゥルメンタル）</h3>
            <Player audioPath={result?.instrumentalPath ?? null} title={result ? "instrumental.wav" : undefined} placeholder="分離すると表示されます" />
          </div>
          {result && (
            <div className="row">
              <button className="btn" onClick={() => api.revealPath(result.folder).catch((e) => showToast("error", String(e)))}>出力フォルダを開く</button>
              <span className="mono small">{result.folder}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
