import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { api, formatSeconds } from "../api";
import { useStore } from "../store";
import { useOnPageHide, usePageActive } from "./PageActive";

/** Peak buckets requested for the waveform (a few per pixel of the widest panel). */
const PEAK_BUCKETS = 3000;

export default function Player({
  audioPath,
  title,
  placeholder = "音源がありません",
}: {
  audioPath: string | null;
  title?: string;
  /** shown when there is no audio (e.g. 「生成が完了すると再生できます」) */
  placeholder?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  // increases with every audioPath: results of an older load are dropped
  const loadSeq = useRef(0);
  const pathRef = useRef<string | null>(audioPath);
  /** the file the waveform holds, and in which WaveSurfer instance */
  const shownRef = useRef<{ ws: WaveSurfer; path: string | null } | null>(null);
  const active = usePageActive();
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [volume, setVolume] = useState(0.9);

  useEffect(() => {
    if (!boxRef.current) return;
    const ws = WaveSurfer.create({
      container: boxRef.current,
      height: 96,
      waveColor: "#3f4b66",
      progressColor: "#5b8cff",
      cursorColor: "#e6e8ee",
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
    });
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));
    ws.on("timeupdate", (t) => setTime(t));
    ws.on("ready", (d) => {
      // an emptied player shows no length (see the empty() below)
      setDuration(pathRef.current ? d : 0);
      setLoading(false);
    });
    ws.on("error", (err) => {
      // a load replaced by a newer one aborts its fetch: not a failure of the current file
      if (err?.name === "AbortError" || !pathRef.current) return;
      setLoading(false);
      setFailed(true);
    });
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, []);

  // A hidden page (kept mounted behind the one shown) loads nothing: a file selected meanwhile is loaded when the
  // page is shown again, so clicking through songs elsewhere does not read every file once per hidden player.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !active) return;
    if (shownRef.current?.ws === ws && shownRef.current.path === audioPath) return;
    shownRef.current = { ws, path: audioPath };
    const seq = ++loadSeq.current;
    pathRef.current = audioPath;
    const stale = () => seq !== loadSeq.current || wsRef.current !== ws;
    setTime(0);
    setDuration(0);
    setPlaying(false);
    setFailed(false);
    if (!audioPath) {
      setLoading(false);
      ws.empty();
      // empty() only removes the src attribute: the media element keeps the previous song (its duration comes back
      // with the empty load's `ready`, and a click on the empty waveform would seek in it). Unload it for real.
      const media = ws.getMediaElement();
      media.removeAttribute("src");
      media.load();
      return;
    }
    setLoading(true);
    const fail = (e: unknown) => {
      if (stale() || (e as { name?: string } | null)?.name === "AbortError") return;
      setLoading(false);
      setFailed(true);
    };
    (async () => {
      const url = await api.fileUrl(audioPath);
      if (stale()) return;
      // With precomputed peaks wavesurfer neither downloads nor decodes the whole file: the media element streams
      // it through the protocol's range responses. Without them (older backend, unreadable format) it falls back
      // to the full load.
      const peaks = await api.audioPeaks(audioPath, PEAK_BUCKETS).catch(() => null);
      if (stale()) return;
      if (peaks && peaks.peaks.length > 0 && peaks.duration > 0) await ws.load(url, peaks.peaks, peaks.duration);
      else await ws.load(url);
    })().catch(fail);
  }, [audioPath, active]);

  useEffect(() => {
    wsRef.current?.setVolume(volume);
  }, [volume]);

  // A page that is not shown makes no sound (it stays mounted behind the page the user is on).
  useOnPageHide(() => wsRef.current?.pause());

  const note = failed ? "この音源を読み込めませんでした" : !audioPath && title !== undefined ? placeholder : "";

  return (
    <div className="player">
      <div className="row between">
        <div className="song-title">{title ?? (audioPath ? "" : placeholder)}</div>
        <div className="time">
          {formatSeconds(time)} / {formatSeconds(duration)}
        </div>
      </div>
      <div className="wave" ref={boxRef} />
      <div className="row">
        <button className="btn" disabled={!audioPath || loading || failed} onClick={() => wsRef.current?.playPause()} aria-label={playing ? "一時停止" : "再生"}>
          {/* both labels in one grid cell: the button is always as wide as the longer one, so 停止 never moves */}
          <span style={{ display: "inline-grid", justifyItems: "center" }}>
            <span style={{ gridArea: "1 / 1", visibility: playing ? "hidden" : "visible" }} aria-hidden="true">
              ▶ 再生
            </span>
            <span style={{ gridArea: "1 / 1", visibility: playing ? "visible" : "hidden" }} aria-hidden="true">
              ⏸ 一時停止
            </span>
          </span>
        </button>
        <button className="btn" disabled={!audioPath || failed} onClick={() => wsRef.current?.stop()}>
          ■ 停止
        </button>
        <label className="row small muted" style={{ gap: 6 }}>
          音量
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} style={{ width: 120 }} />
        </label>
        {audioPath && (
          <button className="btn sm" onClick={() => api.revealPath(audioPath).catch((e) => useStore.getState().showToast("error", String(e)))}>
            フォルダを開く
          </button>
        )}
        {loading && <span className="muted">読み込み中…</span>}
        {note && (
          <span className="muted" style={failed ? { color: "var(--danger)" } : undefined}>
            {note}
          </span>
        )}
      </div>
    </div>
  );
}
