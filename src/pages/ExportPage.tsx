import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, formatBytes, isToolCancelled, type ExportRequest, type ExportResult, type Song, type ToolProgress } from "../api";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import Player from "../components/Player";
import { useChoiceDialog } from "../components/ChoiceDialog";
import ToolCancelButton, { ToolOutcomeNote } from "../components/ToolCancelButton";
import { isOwnToolEvent, newToolRunId, toolBusyLabel, toolRejected, toolSettled, toolStarted } from "../components/toolRun";
import { useOnPageHide, usePageVisibility, usePageVisibilityRef } from "../components/PageActive";
import { SELECTION_LOAD_LABEL, formSongOf, hasLineTimings, noticeFrom, selectionLoad, selectionSwitchQuestion, unloadedSelectionHint } from "./keepAlive";
import { LOCK_HINT, lockHint } from "./locks";
import { detectLanguage, toAlignmentReading } from "../lyrics/hiragana";
import {
  applyAlignment,
  clampLineIndex,
  countRejectedAlignments,
  countPlaceholders,
  countUnromanizedLines,
  emptyAlignmentMessage,
  finalizeSynced,
  followTimeDraft,
  formatLrcTime,
  linesOutOfDate,
  lyricsForTags,
  parseLrcTime,
  peakFromSongJson,
  placeholderLines,
  plainLyricLines,
  rebuildLines,
  resetTimings,
  setLineTime,
  syncDefault,
  timeFieldCommit,
  UROMAN_HINT,
  type TimedLine,
} from "../export/syncedLines";
import { pickSongStems, stemsInFolder } from "../export/stems";
import { OneAtATime, bitrateStops, exportBitrate, lookAtSelection, sameFilePath, sourcePick } from "../export/form";
import PageHeader from "../components/PageHeader";

type Fmt = ExportRequest["format"];
const FORMATS: { id: Fmt; label: string; lossy: boolean; tags: boolean }[] = [
  { id: "mp3", label: "MP3（libmp3lame）", lossy: true, tags: true },
  { id: "m4a", label: "M4A / AAC", lossy: true, tags: true },
  { id: "flac", label: "FLAC（可逆）", lossy: false, tags: true },
  { id: "ogg", label: "OGG Vorbis", lossy: true, tags: true },
  { id: "opus", label: "Opus", lossy: true, tags: true },
  { id: "wav16", label: "WAV 16bit", lossy: false, tags: false },
  { id: "wav24", label: "WAV 24bit", lossy: false, tags: false },
  { id: "wav32f", label: "WAV 32bit float（無劣化）", lossy: false, tags: false },
];

/** Used when the node's model list cannot be read (the first entry of separation_models is the default). */
const FALLBACK_SEPARATION_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt";

/**
 * The vocals of the last separation for automatic timing, reused while the source stays the same (a retry
 * after editing lines does not separate again, and an external file does not get a new separated folder
 * each time). Module level, so it survives switching pages in this app session.
 */
let lastSeparation: { source: string; songId: string | null; vocalsPath: string } | null = null;

const SRC_LABEL: Record<TimedLine["src"], string> = {
  placeholder: "仮の時刻（未設定）",
  aligned: "自動検出した時刻",
  interpolated: "前後の行から推定した時刻",
  tapped: "打刻した時刻",
  manual: "手入力した時刻",
};

/**
 * A library song's own separated vocals when the file is as long as the song; null otherwise. The stems automatic
 * timing made for itself come first, then the separation page's (export/stems.ts songStemCandidates).
 */
const songStemsFor = (folder: string, source: string) => pickSongStems(folder, source, api.audioDuration);

const TIME_FORMAT_HINT = "時刻は 分:秒.百分の一秒（例 01:23.45）の形式で入力してください";

/** The library selection 書き出し would load (keepAlive.ts selectionLoad selectedId): a finished song, else null. */
export function loadableSelection(songs: readonly Pick<Song, "id" | "status">[], selectedId: string | null): string | null {
  const s = selectedId === null ? undefined : songs.find((x) => x.id === selectedId);
  return s?.status === "done" ? s.id : null;
}

/**
 * A line's time field. While focused it edits a draft that is committed on blur / Enter (Esc cancels), so
 * half-typed text is never applied. The draft lives only while the field has focus: times replaced from
 * outside (tap, automatic timing, rebuilt lines) always show once the field is left, and while it is focused
 * an untouched draft follows them. Only text the user changed is committed (timeFieldCommit).
 */
function LrcTimeInput({ timeMs, onCommit, onInvalid, style, disabled, title }: { timeMs: number; onCommit: (ms: number) => void; onInvalid: () => void; style?: CSSProperties; disabled?: boolean; title?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  // The text shown while untouched (set on focus, follows outside changes); null while not focused.
  const shown = useRef<string | null>(null);
  const cancelled = useRef(false);
  const invalid = draft !== null && parseLrcTime(draft) === null;
  useEffect(() => {
    const prev = shown.current;
    const next = formatLrcTime(timeMs);
    if (prev === null || prev === next) return;
    shown.current = next;
    setDraft((d) => followTimeDraft(d, prev, next));
  }, [timeMs]);
  const commit = () => {
    const text = draft;
    const base = shown.current;
    setDraft(null);
    shown.current = null;
    if (cancelled.current || text === null || base === null) {
      cancelled.current = false;
      return;
    }
    // Only focused and left (or the same time retyped): not a manual time, the neighbours stay as they are.
    const r = timeFieldCommit(text, base);
    if (r.kind === "invalid") onInvalid();
    else if (r.kind === "commit") onCommit(r.ms);
  };
  return (
    <input
      type="text"
      className="mono"
      value={draft ?? formatLrcTime(timeMs)}
      title={invalid ? TIME_FORMAT_HINT : title}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onFocus={(e) => {
        cancelled.current = false;
        shown.current = formatLrcTime(timeMs);
        setDraft(shown.current);
        e.currentTarget.select();
      }}
      onChange={(e) => {
        // focused without onFocus (a dialog gave the focus back while React ignored the event): the edit starts here
        if (shown.current === null) shown.current = formatLrcTime(timeMs);
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        // Enter that confirms an IME composition must not commit the half-typed text.
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          if (invalid) return onInvalid(); // keep editing
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      style={{ width: 100, ...style, ...(invalid ? { borderColor: "var(--danger)" } : {}) }}
    />
  );
}

export default function ExportPage() {
  const { songs, selectedSongId, selectSong, config, showToast } = useStore(
    useShallow((s) => ({ songs: s.songs, selectedSongId: s.selectedSongId, selectSong: s.selectSong, config: s.config, showToast: s.showToast })),
  );
  const { active, label: pageLabel } = usePageVisibility();
  const visibility = usePageVisibilityRef();
  const selected = useMemo(() => songs.find((s) => s.id === selectedSongId) ?? null, [songs, selectedSongId]);
  const [source, setSource] = useState("");
  const [format, setFormat] = useState<Fmt>("mp3");
  const [bitrate, setBitrate] = useState(320);
  const [loudnorm, setLoudnorm] = useState(false);
  const [targetLufs, setTargetLufs] = useState(-14);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [trim, setTrim] = useState(false);
  const [meta, setMeta] = useState({ title: "", artist: "", album: "", year: String(new Date().getFullYear()), genre: "", comment: "Generated with YuE2 / Music Creator Studio YuE2" });
  const [cover, setCover] = useState<string | null>(null);
  const [lyrics, setLyrics] = useState("");
  const [lines, setLines] = useState<TimedLine[]>([]);
  // null = automatic (on only when no placeholder times remain); true/false = the user's choice.
  const [syncChoice, setSyncChoice] = useState<boolean | null>(null);
  const [hardClip, setHardClip] = useState(false);
  // Sample peak of the library song (song.json info); null when unknown.
  const [peak, setPeak] = useState<number | null>(null);
  // Song length for interpolating lines after the last aligned one.
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [language, setLanguage] = useState<"ja" | "en" | "zh" | "other">("ja");
  // Whether the optional uroman romanizer (Korean, Cyrillic … lyrics) is installed; null while unknown.
  const [uromanInstalled, setUromanInstalled] = useState<boolean | null>(null);
  const [tool, setTool] = useState<ToolProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  // One export at a time: the page turns busy only once a destination is chosen (OneAtATime).
  const [exportOnce] = useState(() => new OneAtATime());
  // 「書き出す」 is being handled, from the click (its question and the save dialog) to the end of the export: the
  // library selection is not followed meanwhile (the export writes the form as it was at the click).
  const [exportRunning, setExportRunning] = useState(false);
  // This page's own automatic timing call is running (its cancel button). Its run id (set synchronously) picks
  // this run's tool events: a separation started on the separation page is not taken for it.
  const [aligning, setAligning] = useState(false);
  const runRef = useRef<string | null>(null);
  const [tapIndex, setTapIndex] = useState(0);
  // Separation model for automatic timing: the first (recommended) entry of the node's list.
  const [separationModel, setSeparationModel] = useState(FALLBACK_SEPARATION_MODEL);
  // Separate again instead of reusing existing vocals (lastSeparation, or the library song's songStems).
  const [reseparate, setReseparate] = useState(false);
  // The form's library song's own separated vocals (songStemsFor), probed when it is loaded: automatic timing
  // reuses them, so the button label and the 「ボーカルを分離し直す」 option show that before the first run.
  const [songStems, setSongStems] = useState<string | null>(null);
  const [tapError, setTapError] = useState(false);
  // The source as set last (synchronously, unlike the state): late async results for an older source are dropped.
  const sourceRef = useRef("");
  const { ask, dialog } = useChoiceDialog();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [playMs, setPlayMs] = useState<number | null>(null);
  // Line currently being sung (last line whose timestamp has passed) while the tap player is playing.
  const playingLine = useMemo(() => {
    if (playMs === null) return -1;
    let idx = -1;
    lines.forEach((l, i) => {
      if (l.timeMs <= playMs) idx = i;
    });
    return idx;
  }, [playMs, lines]);
  useEffect(() => {
    if (playingLine < 0 || !listRef.current) return;
    const row = listRef.current.children[playingLine] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [playingLine]);
  const [tapUrl, setTapUrl] = useState<string | null>(null);

  useEffect(() => {
    const un = api.onToolProgress((p) => {
      if (isOwnToolEvent(p, runRef.current, ["align", "separate"])) setTool(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    api
      .setupStatus()
      .then((cs) => setUromanInstalled(cs.some((c) => c.id === "uroman_pip" && c.installed)))
      .catch(() => setUromanInstalled(null));
    api
      .separationModels()
      .then((m) => m[0] && setSeparationModel(m[0]))
      .catch(() => undefined); // keep the fallback
  }, []);

  const changeSource = (p: string) => {
    sourceRef.current = p;
    setSource(p);
    setTapUrl(null);
    setTapError(false);
    // Both belong to the previous source: a hidden "separate again" must not overwrite the next song's stems.
    setReseparate(false);
    setSongStems(null);
  };

  // The tap player is silent while the page is hidden.
  useOnPageHide(() => audioRef.current?.pause());

  /**
   * The library song the form was loaded from (null: none yet, or a file picked here) with the lyrics and title as
   * loaded: timings, edited lyrics or an edited title are work that loading another song would replace.
   */
  const loadedRef = useRef<{ id: string | null; name: string; lyrics: string; title: string }>({ id: null, name: "", lyrics: "", title: "" });
  const askingLoad = useRef(false);
  /** the loadable library selection this page last saw while shown (keepAlive.ts selectionLoad seenId) */
  const seenSel = useRef<string | null>(null);
  // The form's own song (null: a picked file, nothing yet, or deleted meanwhile). Automatic timing reads the song
  // folder, the hiragana lyrics and the truncation flags from it, never from the library selection, which may be
  // another song (still rendering, or declined) while this page keeps its work.
  const formSong = formSongOf(songs, loadedRef.current.id);
  // Songs deleted in ライブラリ: an automatic timing of the form's song deleted while it runs ends as 中止 (the
  // backend keeps no stems for it), not as a failure.
  const lastDeleted = useStore((s) => s.lastDeletedSong);
  const deletedIds = useRef(new Set<string>());
  useEffect(() => {
    if (lastDeleted) deletedIds.current.add(lastDeleted.id);
  }, [lastDeleted?.n]);
  /** The form song's name now (a rename in ライブラリ shows at once), else the name it was loaded with. */
  const formName = formSong?.title ?? loadedRef.current.name;
  // The form's own song was renamed in ライブラリ (the page stays mounted, so nothing reloads it): an unedited title
  // follows the new name; an edited one stays (and still counts as work unless it is the new name).
  useEffect(() => {
    const t = formSong?.title;
    const loaded = loadedRef.current;
    if (t === undefined || loaded.id !== formSong!.id || t === loaded.title) return;
    const old = loaded.title;
    loadedRef.current = { ...loaded, name: t, title: t };
    setMeta((m) => (m.title === old ? { ...m, title: t } : m));
  }, [formSong?.id, formSong?.title]);
  const loadSong = (song: Song) => {
    loadedRef.current = { id: song.id, name: song.title, lyrics: song.lyrics, title: song.title };
    const audioPath = song.audioPath;
    changeSource(audioPath);
    setMeta((m) => ({ ...m, title: song.title }));
    setLyrics(song.lyrics);
    setLanguage(detectLanguage(song.lyrics));
    setResult(null);
    // Placeholder times (i * 4 s) are only a starting grid for tap-sync; they are marked so they are
    // never exported as real timing.
    setLines(placeholderLines(plainLyricLines(song.lyrics)));
    setSyncChoice(null);
    setTapIndex(0);
    setDurationMs(song.duration > 0 ? Math.round(song.duration * 1000) : null);
    setPeak(null);
    // Late answers for a song that is no longer the source are dropped.
    if (song.folder) {
      api
        .readTextFile(`${song.folder}\\song.json`)
        .then((j) => sourceRef.current === audioPath && setPeak(peakFromSongJson(j)))
        .catch(() => sourceRef.current === audioPath && setPeak(null));
      songStemsFor(song.folder, audioPath)
        .then((v) => sourceRef.current === audioPath && setSongStems(v))
        .catch(() => undefined);
    }
    api
      .fileUrl(audioPath)
      .then((u) => sourceRef.current === audioPath && setTapUrl(u))
      .catch(() => sourceRef.current === audioPath && setTapUrl(null));
  };

  /**
   * Load `target` (a finished library song) unless the page already saw it (`seenId`, keepAlive.ts selectionLoad),
   * after asking when the form holds timings, edits or a running automatic timing. Keeping the work leaves the
   * selection alone: the page goes on with its own song or file, and the 「選択中の曲を読み込む」 button loads the
   * selection later (seenId null).
   */
  const followSelection = (target: Song, seenId: string | null) => {
    if (askingLoad.current) return;
    const loaded = loadedRef.current;
    const timed = hasLineTimings(lines);
    const lyricsEdited = lyrics !== loaded.lyrics;
    const titleEdited = meta.title !== loaded.title;
    const keepable = loaded.id !== null ? songs.some((s) => s.id === loaded.id) : source !== "";
    const d = selectionLoad({ active, selectedId: target.id, loadedId: loaded.id, seenId, hasWork: timed || lyricsEdited || titleEdited || aligning, keepable });
    if (d === "none") return;
    if (d === "load") return loadSong(target);
    const q = selectionSwitchQuestion({
      page: pageLabel,
      current: formName || "音声ファイル",
      next: target.title,
      work: [timed ? "同期歌詞のタイミング" : "", lyricsEdited ? "歌詞の編集" : "", titleEdited ? "タイトルの編集" : "", aligning ? "タイミングの自動検出（実行中）" : ""].filter(Boolean),
    });
    askingLoad.current = true;
    void ask({ title: q.title, message: q.message, note: q.note, choices: [{ value: "load", label: q.loadLabel, kind: "danger" }], cancelLabel: q.keepLabel }).then((c) => {
      askingLoad.current = false;
      if (c !== "load") return;
      const st = useStore.getState();
      const now = st.songs.find((s) => s.id === target.id);
      if (now && now.status === "done" && st.selectedSongId === now.id) loadSong(now);
    });
  };

  // Load the selected song into the form: when another finished song is selected, and when the selected song
  // finishes rendering while this page is shown. The page stays mounted while hidden and follows the selection
  // only when shown, and only a selection made since it last looked: a song selected meanwhile is loaded on
  // return (followSelection). From the click on 「書き出す」 until the export ends the source stays: the selection
  // is followed once the export ends (lookAtSelection), unless its result is shown (see writeExport).
  const selectedDone = selected?.status === "done";
  useEffect(() => {
    const target = selected && selected.status === "done" ? selected : null;
    const seen = seenSel.current;
    const look = lookAtSelection(seen, { active, exporting: exportRunning, targetId: target?.id ?? null });
    seenSel.current = look.seen;
    if (look.look && target) followSelection(target, seen);
  }, [active, exportRunning, selected?.id, selectedDone]);

  // Every way the line list changes (song load, rebuild, automatic timing) leaves the tap position on a line.
  useEffect(() => {
    setTapIndex((i) => clampLineIndex(i, lines.length));
  }, [lines.length]);

  const fmt = FORMATS.find((f) => f.id === format)!;
  // the bitrate the export uses (the slider value is shared by the lossy formats; MP3 has fewer rates)
  const stops = bitrateStops(format);
  const kbps = exportBitrate(format, bitrate);
  const placeholders = countPlaceholders(lines);
  const estimated = lines.filter((l) => l.src === "interpolated").length;
  const syncOn = syncChoice ?? syncDefault(lines);
  const backwards = useMemo(() => finalizeSynced(lines).clamped, [lines]);
  // The lyrics were edited after the lines were built: synced lyrics / .lrc would still use the old lines.
  const linesStale = useMemo(() => linesOutOfDate(lyrics, lines), [lyrics, lines]);
  const tapLine = clampLineIndex(tapIndex, lines.length);
  const reusesLast = lastSeparation !== null && lastSeparation.source === source && lastSeparation.songId === (formSong?.id ?? null);
  const canReuseSeparation = reusesLast || songStems !== null;
  // The page's own work (pages/locks.ts): while timing is detected, the lines it will replace are not edited by
  // hand (taps, typed times, a rebuild) and the language and source it reads stay put; while a file is written,
  // the source stays.
  const hint = lockHint({ aligning, exporting });

  const rebuildFromLyrics = () => {
    // Times are kept only for lines whose text is unchanged (matched in order), never by index.
    setLines(rebuildLines(plainLyricLines(lyrics), lines, durationMs));
    setSyncChoice(null);
  };

  const pickSource = async () => {
    const p = await open({ multiple: false, filters: [{ name: "音声", extensions: ["wav", "flac", "mp3", "m4a", "ogg", "opus"] }] });
    if (typeof p !== "string") return;
    // another file resets the timings, so those are asked about (export/form.ts sourcePick)
    const pick = sourcePick({ current: source, picked: p, timed: hasLineTimings(lines) });
    if (pick === "ask") {
      const choice = await ask({
        title: "同期歌詞のタイミングがあります",
        message: "別の音声ファイルに切り替えると、検出・打刻・入力した行の時刻はすべて仮の時刻に戻ります（いまの音源に合わせた時刻のため）。歌詞とタイトルはそのまま残ります。",
        choices: [{ value: "switch", label: "切り替える", kind: "danger" }],
      });
      if (choice !== "switch") return;
    }
    if (pick === "keep") {
      // The source itself picked again (e.g. rewritten in place by another app): the timings, lyrics, title and
      // library song stay; what is read from the file is read again below (its length, the tap player), and vocals
      // separated from its earlier contents are not reused.
      if (lastSeparation && sameFilePath(lastSeparation.source, p)) lastSeparation = null;
      setTapUrl(null);
      setTapError(false);
      showToast("info", "同じ音声ファイルを読み込み直しました（行の時刻はそのままです）");
    } else {
      changeSource(p);
      // the form now belongs to this file (lyrics and title stay as they are)
      loadedRef.current = { id: null, name: p.split(/[\\/]/).pop() ?? p, lyrics, title: meta.title };
      selectSong(null);
      // Times aligned / tapped against the previous audio do not belong to this file (times typed while no audio
      // was chosen stay with the first one).
      if (pick !== "attach") {
        setLines((ls) => resetTimings(ls));
        setSyncChoice(null);
        setTapIndex(0);
      }
      setResult(null);
      setPeak(null);
      setDurationMs(null);
    }
    const cur = sourceRef.current;
    api
      .audioDuration(cur)
      .then((d) => sourceRef.current === cur && d && d > 0 && setDurationMs(Math.round(d * 1000)))
      .catch(() => undefined); // unknown: a new file stays without a length, the kept source keeps its own
    api
      .fileUrl(cur)
      .then((u) => sourceRef.current === cur && setTapUrl(u))
      .catch(() => sourceRef.current === cur && setTapUrl(null));
  };
  const pickCover = async () => {
    const p = await open({ multiple: false, filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg"] }] });
    if (typeof p === "string") setCover(p);
  };

  const autoAlign = async () => {
    if (!source) return showToast("error", "音源を選択してください");
    const plain = plainLyricLines(lyrics);
    if (plain.length === 0) return showToast("error", "歌詞が空です");
    const src = source;
    // the form's song, not the selection (its folder receives the stems; see formSong)
    const song = formSong;
    const songId = song?.id ?? null;
    // the language this run aligns with (the select is disabled meanwhile; read once, not after each await)
    const lang = language;
    setBusy(true);
    const runId = newToolRunId();
    runRef.current = runId;
    setAligning(true);
    // A separation or alignment call is running: its failure is that run's result line (see the catch below).
    let inToolCall = false;
    try {
      // Separate first for cleaner alignment (uses the song folder when available). The vocals of the last
      // run for this source are reused unless the user asks to separate again (or the file is gone).
      let vocalsPath: string | null = null;
      let reusedSongStems = false;
      const cached = lastSeparation;
      if (!reseparate && cached && cached.source === src && cached.songId === songId) {
        const d = await api.audioDuration(cached.vocalsPath).catch(() => null);
        if (d && d > 0) vocalsPath = cached.vocalsPath;
      }
      if (vocalsPath === null && !reseparate && songId && song?.folder) {
        // A library song separated before (here or on the separation page, any model): its vocals serve for
        // alignment instead of separating again. Probed again here: the file may have changed since the song
        // was loaded.
        const candidate = await songStemsFor(song.folder, src);
        if (candidate) {
          vocalsPath = candidate;
          reusedSongStems = true;
          lastSeparation = { source: src, songId, vocalsPath };
        }
      }
      if (vocalsPath === null) {
        lastSeparation = null;
        setTool(toolStarted("separate", "ボーカルを分離中"));
        // "align": the backend keeps these stems apart from the separation page's (separated\align for a library
        // song, one reused cache folder for other files)
        inToolCall = true;
        const sep = await api.separateAudio(src, separationModel, songId, "align", runId);
        inToolCall = false;
        vocalsPath = sep.vocalsPath;
        lastSeparation = { source: src, songId, vocalsPath };
        setReseparate(false);
      }
      // (a cancelled separation rejected above: the chain stops before this step)
      setTool(toolStarted("align", "歌詞を整列中"));
      // Align against the text that was actually sung (hiragana version) when it has the same line structure;
      // timestamps are then attached to the kanji lines shown here.
      const sungText = song?.lyricsSung ?? "";
      const alignText = sungText.trim() && plainLyricLines(sungText).length === plainLyricLines(lyrics).length ? sungText : lyrics;
      // Japanese: write the particles は/へ as sung (私は -> わたしわ, 東京へ -> とうきょうえ) and send kanji as their
      // kuromoji reading in hiragana (the romanizer misreads kanji: 君 -> kun). The part of speech comes from the
      // kanji lines shown here (kuromoji misreads hiragana-only text); same line structure, so aligned indices
      // still map to the lines above.
      let alignInput = alignText;
      if (lang === "ja") {
        try {
          alignInput = await toAlignmentReading(alignText, lyrics);
        } catch {
          alignInput = alignText; // dictionary unavailable: the written text still aligns, particles as は/へ
        }
      }
      inToolCall = true;
      const aligned = await api.alignLyrics(vocalsPath, alignInput, lang, runId);
      inToolCall = false;
      if (sourceRef.current !== src) {
        // Another file was chosen while this ran: these times belong to the previous one.
        return showToast("info", "処理中に音源が変わったため、自動検出の結果は反映しませんでした");
      }
      if (aligned.length === 0) throw new Error(emptyAlignmentMessage(lang, alignText, uromanInstalled));
      // Lines the node skipped (no romanizable tokens) are interpolated from their aligned neighbours.
      // Lines forced into the audio's end with near-zero scores (never sung) are estimated like skipped ones.
      const next = applyAlignment(plain, alignText, aligned, durationMs);
      const unheard = countRejectedAlignments(plain, alignText, aligned);
      setLines(next);
      setSyncChoice(null);
      setTapIndex(0); // new times: tapping starts from the top again
      const hit = next.filter((l) => l.src === "aligned").length;
      const cut = song?.truncatedSemantic === true || song?.truncatedAbc === true;
      const unheardNote = unheard
        ? `。${unheard} 行は音声中に見つかりませんでした（推定時刻・灰色）${cut ? "。この曲はトークン上限で途中までしか生成されていません" : ""}`
        : "";
      // Lines in a script only uroman romanizes (Korean, Cyrillic …) came back without a result: the optional
      // component is missing (with it installed, the node reads such lines like any other).
      const unromanized = uromanInstalled ? 0 : countUnromanizedLines(plain, alignText, aligned, lang);
      const scriptNote = unromanized ? `。${unromanized} 行はローマ字化できない文字体系のため整列できませんでした（${UROMAN_HINT}）` : "";
      const stemsFile = reusedSongStems && vocalsPath && song?.folder ? stemsInFolder(vocalsPath, song.folder) : null;
      const stemsNote = stemsFile ? `。曲フォルダにある分離結果（${stemsFile}）を使いました（分離し直す場合は「ボーカルを分離し直す」をオンに）` : "";
      showToast(
        unheard || unromanized ? "info" : "success",
        noticeFrom(
          (hit < next.length ? `${hit} / ${next.length} 行のタイミングを検出しました（残りは前後から推定）` : `${hit} 行のタイミングを検出しました`) + unheardNote + scriptNote + stemsNote,
          visibility.current.active,
          visibility.current.label,
        ),
      );
    } catch (e) {
      if (songId !== null && deletedIds.current.has(songId)) {
        // The form's song was deleted meanwhile (the user's own action): 中止 with a notice, not a red failure.
        setTool(null);
        showToast("info", noticeFrom("曲がライブラリから削除されたため、タイミングの自動検出を中止しました", visibility.current.active, visibility.current.label));
        return;
      }
      // A cancelled separation or alignment ends neutral (「キャンセルしました」 next to the button), not as an error.
      // A failed one shows its error there too, also when the backend's final event did not arrive before the
      // call returned (events after this run are no longer taken, see runRef).
      if (isToolCancelled(e) || inToolCall) setTool((t) => toolRejected(t, "align", e));
      if (!isToolCancelled(e)) showToast("error", noticeFrom(String(e), visibility.current.active, visibility.current.label));
    } finally {
      // A command that failed before the backend's final progress event must not leave "処理中" behind.
      if (runRef.current === runId) runRef.current = null;
      setTool(toolSettled);
      setAligning(false);
      setBusy(false);
    }
  };

  // Tap-to-sync: play the source and press the button / Space to stamp the current line.
  const stamp = () => {
    const a = audioRef.current;
    if (!a || lines.length === 0) return;
    const idx = clampLineIndex(tapIndex, lines.length);
    const ms = Math.round(a.currentTime * 1000);
    // Also re-estimates the grey (interpolated) neighbours from the new anchor.
    setLines((ls) => setLineTime(ls, idx, ms, "tapped", durationMs));
    setTapIndex(clampLineIndex(idx + 1, lines.length));
  };

  const writeExport = async () => {
    if (!source) return showToast("error", "音源を選択してください");
    if (syncOn && linesStale) {
      const choice = await ask({
        title: "歌詞と同期歌詞の行が一致しません",
        message: "歌詞が編集されていますが、同期歌詞の行は編集前のままです。このまま書き出すと、通常の歌詞タグは新しい歌詞、同期歌詞と .lrc は下の行（編集前）になります。",
        choices: [
          { value: "rebuild", label: "行を作り直す（書き出しは中止）", kind: "primary" },
          { value: "asis", label: "このまま書き出す" },
        ],
      });
      if (choice === null) return;
      if (choice === "rebuild") {
        rebuildFromLyrics();
        return showToast("info", "歌詞から行を作り直しました。時刻を確認してから書き出してください");
      }
    }
    // The extension mapping must match export.rs (extension_for): every WAV variant is .wav.
    const ext = format.startsWith("wav") ? "wav" : format;
    const base = (meta.title || "song").replace(/[\\/:*?"<>|]/g, "_");
    const dest = await save({ defaultPath: `${config?.outputDir ?? ""}\\${base}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!dest) return;
    setBusy(true);
    setExporting(true);
    setResult(null);
    try {
      // Lyric order is kept (no sorting); a line earlier than the previous one is clamped to it.
      const { synced, clamped } = finalizeSynced(lines);
      const req: ExportRequest = {
        source,
        dest,
        format,
        bitrateKbps: kbps,
        mp3Vbr: null,
        loudnorm,
        targetLufs,
        fadeInSec: fadeIn,
        fadeOutSec: fadeOut,
        trimSilence: trim,
        hardClip: hardClip && !loudnorm,
        ...meta,
        coverImage: cover,
        lyrics: lyricsForTags(lyrics),
        // Sent for WAV too: WAV gets no tags, but the .lrc sidecar is written. Empty = plain lyrics only, no .lrc.
        synced: syncOn ? synced : [],
        writeLrc: true,
        language: language === "ja" ? "jpn" : language === "en" ? "eng" : language === "zh" ? "zho" : "und",
      };
      const r = await api.exportAudio(req);
      // (the source is locked while the file is written; a result never shows under another source's form)
      if (sourceRef.current === req.source) {
        setResult(r);
        // A song selected (or finished) in the library during the export is not loaded over the result of the file
        // just written: it counts as seen, and 「選択中の曲を読み込む」 loads it.
        const st = useStore.getState();
        seenSel.current = loadableSelection(st.songs, st.selectedSongId);
      }
      const notes = [...(r.warnings ?? [])];
      if (syncOn && placeholders > 0) notes.push(`仮の時刻のままの行 ${placeholders} 行を含めて書き出しました`);
      if (syncOn && clamped > 0) notes.push(`${clamped} 行の時刻を前の行に揃えました`);
      showToast(notes.length ? "info" : "success", `書き出しました: ${r.dest}${notes.length ? `（${notes.join(" / ")}）` : ""}`);
    } catch (e) {
      showToast("error", String(e));
    } finally {
      setBusy(false);
      setExporting(false);
    }
  };
  const doExport = () =>
    exportOnce.run(async () => {
      setExportRunning(true);
      try {
        await writeExport();
      } finally {
        setExportRunning(false);
      }
    });

  return (
    <div>
      <PageHeader page="export" />
      <p className="page-desc">形式変換、ラウドネス正規化、メタデータと同期歌詞（MP3: SYLT+USLT / M4A: ©lyr / FLAC・OGG: LYRICS）の埋め込み、.lrc の併出力を行います。</p>
      <div className="grid-compose">
        <div className="stack">
          <div className="panel stack">
            <h3>音源</h3>
            <div className="row">
              <button className="btn" onClick={pickSource} disabled={busy} title={busy ? hint : undefined}>音声ファイルを選択</button>
              <span className="muted small">ライブラリで選択中の曲が自動で入ります</span>
            </div>
            <div className="mono small" style={{ wordBreak: "break-all" }}>{source || "未選択"}</div>
            {selected && (selected.status === "queued" || selected.status === "running") && (
              <div className="muted small">
                選択中の曲「{selected.title}」は生成中です。完了すると読み込みます（作業中の内容がある場合は確認します）。
                {source && formName ? `いまは「${formName}」が入っています。` : ""}
              </div>
            )}
            {selected?.status === "done" && selected.id !== loadedRef.current.id && (
              <div className="hint row between">
                <span>{unloadedSelectionHint(selected.title, formName)}</span>
                <button className="btn sm" onClick={() => followSelection(selected, null)} disabled={busy} title={busy ? hint : undefined}>
                  {SELECTION_LOAD_LABEL}
                </button>
              </div>
            )}
          </div>
          <div className="panel stack">
            <h3>形式</h3>
            <select value={format} onChange={(e) => setFormat(e.target.value as Fmt)}>
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
            {fmt.lossy && (
              <label className="field">
                <span className="lbl"><span>ビットレート</span><span className="mono">{kbps} kbps</span></span>
                {/* MP3 offers only its own rates (bitrateStops): the slider steps through them */}
                <input type="range" min={0} max={stops.length - 1} step={1} value={stops.indexOf(kbps)} onChange={(e) => setBitrate(stops[Number(e.target.value)])} />
              </label>
            )}
            <label className="row"><input type="checkbox" checked={loudnorm} onChange={(e) => setLoudnorm(e.target.checked)} /> ラウドネス正規化（EBU R128）</label>
            {loudnorm && (
              <label className="field">
                <span className="lbl"><span>目標ラウドネス</span><span className="mono">{targetLufs} LUFS</span></span>
                <input type="range" min={-23} max={-8} step={0.5} value={targetLufs} onChange={(e) => setTargetLufs(Number(e.target.value))} />
              </label>
            )}
            {!loudnorm && (
              <label className="row"><input type="checkbox" checked={hardClip} onChange={(e) => setHardClip(e.target.checked)} /> <span style={{ flex: "1 1 0", minWidth: 0 }}>0 dBFS を超えるサンプルをクリップする（正規化オフ時。元データの 0 dBFS 超えを抑えます。非可逆形式はエンコード後にわずかに超えることがあるため、確実に抑えるにはラウドネス正規化を使ってください）</span></label>
            )}
            {!loudnorm && peak !== null && peak >= 1.0 && (
              <div className="hint">生成時のピークが 0 dBFS を超えていました（ピーク {peak.toFixed(3)}）。ラウドネス正規化（トゥルーピーク −1 dBTP）を有効にすることをおすすめします。</div>
            )}
            <div className="row">
              <label className="field"><span className="lbl">フェードイン（秒）</span><input type="number" min={0} max={30} step={0.5} value={fadeIn} onChange={(e) => setFadeIn(Number(e.target.value))} /></label>
              <label className="field"><span className="lbl">フェードアウト（秒）</span><input type="number" min={0} max={30} step={0.5} value={fadeOut} onChange={(e) => setFadeOut(Number(e.target.value))} /></label>
            </div>
            <label className="row"><input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} /> 前後の無音をトリム</label>
            {trim && <div className="muted small">同期歌詞の時刻とフェードアウト位置は、トリム後の長さに合わせて自動で調整します。</div>}
          </div>
          <div className="panel stack">
            <h3>メタデータ</h3>
            {(["title", "artist", "album", "year", "genre", "comment"] as const).map((k) => (
              <label key={k} className="field">
                <span className="lbl">{{ title: "タイトル", artist: "アーティスト", album: "アルバム", year: "年", genre: "ジャンル", comment: "コメント" }[k]}</span>
                <input type="text" value={meta[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} />
              </label>
            ))}
            <div className="row">
              <button className="btn sm" onClick={pickCover}>ジャケット画像を選択</button>
              <span className="mono small" style={{ wordBreak: "break-all" }}>{cover ?? "なし"}</span>
              {cover && <button className="btn sm" onClick={() => setCover(null)}>解除</button>}
            </div>
            {!fmt.tags && <div className="hint">WAV にはタグを書き込みません（同期歌詞を有効にすると .lrc は出力されます）。</div>}
          </div>
        </div>
        <div className="stack">
          <div className="panel stack">
            <h3>同期歌詞</h3>
            <div className="row">
              <span className="muted">言語</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value as typeof language)} style={{ width: 120 }} disabled={aligning} title={aligning ? LOCK_HINT.aligning : undefined}>
                <option value="ja">日本語</option>
                <option value="en">英語</option>
                <option value="zh">中国語</option>
                <option value="other">その他</option>
              </select>
              <button className="btn primary" onClick={autoAlign} disabled={!source || busy}>
                {tool && !tool.done
                  ? toolBusyLabel(tool.tool === "separate" ? "ボーカルを分離中" : "歌詞を整列中", tool)
                  : canReuseSeparation && !reseparate
                    ? `タイミングを自動検出（${reusesLast ? "前回" : "曲フォルダ"}の分離結果で整列）`
                    : "タイミングを自動検出（分離＋整列）"}
              </button>
              <ToolCancelButton tool={tool} running={aligning} />
              <ToolOutcomeNote tool={tool} />
              {(canReuseSeparation || reseparate) && (
                <label className="row small"><input type="checkbox" checked={reseparate} disabled={busy} onChange={(e) => setReseparate(e.target.checked)} /> ボーカルを分離し直す</label>
              )}
            </div>
            <textarea className="lyrics" value={lyrics} onChange={(e) => setLyrics(e.target.value)} style={{ minHeight: 120 }} spellCheck={false} placeholder="歌詞（[Verse] などのタグ行は除外されます）" />
            <div className="row">
              <button className={`btn sm${linesStale ? " primary" : ""}`} onClick={rebuildFromLyrics} disabled={aligning} title={aligning ? LOCK_HINT.aligning : undefined}>歌詞から行を作り直す</button>
              <span className="muted small">{lines.length} 行</span>
            </div>
            {linesStale && lines.length > 0 && (
              <div className="hint">歌詞が編集されています。「歌詞から行を作り直す」を押すと下の行（同期歌詞）に反映されます（押さずに書き出すと、同期歌詞と .lrc は下の行のままです）。</div>
            )}
            <label className="row"><input type="checkbox" checked={syncOn} disabled={lines.length === 0} onChange={(e) => setSyncChoice(e.target.checked)} /> 同期歌詞を埋め込む / .lrc を出力</label>
            {syncOn && placeholders > 0 && (
              <div className="hint">仮の時刻（4 秒間隔）のままの行が {placeholders} 行あります。自動検出・打刻・時刻の入力で設定してから書き出してください。</div>
            )}
            {!syncOn && placeholders > 0 && (
              <div className="muted small">タイミング未設定の行があるため、同期歌詞は既定でオフです（通常の歌詞タグのみ書き込み、.lrc は出力しません）。</div>
            )}
            {estimated > 0 && <div className="muted small">灰色の {estimated} 行は、前後の行から推定した時刻です。</div>}
            {syncOn && backwards > 0 && <div className="hint">{backwards} 行の時刻が前の行より早くなっています。書き出し時は前の行の時刻に揃えます。</div>}
            {tapUrl && (
              <div className="stack" style={{ gap: 6 }}>
                <audio
                  ref={audioRef}
                  src={tapUrl}
                  controls
                  style={{ width: "100%" }}
                  onTimeUpdate={(e) => setPlayMs(Math.round(e.currentTarget.currentTime * 1000))}
                  onPause={() => setPlayMs(null)}
                  onEnded={() => setPlayMs(null)}
                  onError={() => setTapError(true)}
                  onLoadedData={() => setTapError(false)}
                />
                {tapError && (
                  <div className="hint">この音声を再生できませんでした。タップ同期と ▶ には再生が必要です（楽曲保存先・データフォルダの外にあるファイルは再生できないことがあります。その場合は自動検出か時刻の入力を使ってください）。</div>
                )}
                <div className="row">
                  <button className="btn" onClick={stamp} disabled={lines.length === 0 || aligning} title={aligning ? LOCK_HINT.aligning : undefined}>この行に現在位置を打刻（{lines.length === 0 ? "行がありません" : `${tapLine + 1} 行目`}）</button>
                  <button className="btn sm" onClick={() => setTapIndex(0)} disabled={aligning} title={aligning ? LOCK_HINT.aligning : undefined}>先頭から</button>
                  <span className="muted small">再生しながら打刻ボタンで行ごとのタイミングを手動設定できます</span>
                </div>
              </div>
            )}
            <div ref={listRef} className="list" style={{ maxHeight: 320, overflow: "auto" }}>
              {lines.map((l, i) => {
                // Placeholder / estimated times are shown grey so they are not mistaken for real timing.
                const grey = l.src === "placeholder" || l.src === "interpolated" ? { color: "var(--text-2)" } : undefined;
                return (
                <div
                  key={i}
                  className={`song-row ${i === tapLine ? "selected" : ""} ${i === playingLine ? "playing" : ""}`}
                  style={{ gridTemplateColumns: "110px 1fr auto" }}
                  onClick={() => setTapIndex(i)}
                  title={SRC_LABEL[l.src]}
                >
                  <LrcTimeInput
                    timeMs={l.timeMs}
                    style={grey}
                    disabled={aligning}
                    title={aligning ? LOCK_HINT.aligning : undefined}
                    onInvalid={() => showToast("error", TIME_FORMAT_HINT)}
                    onCommit={(ms) => {
                      const t = durationMs != null ? Math.min(ms, durationMs) : ms;
                      setLines((ls) => setLineTime(ls, i, t, "manual", durationMs));
                    }}
                  />
                  {/* the keyboard control of the row is its text (the time field and ▶ stay separate controls) */}
                  <span
                    style={grey}
                    role="button"
                    tabIndex={0}
                    aria-current={i === tapLine ? "true" : undefined}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setTapIndex(i);
                      }
                    }}
                  >
                    {l.text}
                  </span>
                  <button
                    className="btn sm"
                    aria-label={`「${l.text || `${i + 1} 行目`}」の時刻から再生`}
                    title="この行の時刻から再生"
                    onClick={(e) => { e.stopPropagation(); if (audioRef.current) { audioRef.current.currentTime = l.timeMs / 1000; audioRef.current.play().catch(() => undefined); /* a load failure shows via onError */ } }}
                  >
                    ▶
                  </button>
                </div>
                );
              })}
            </div>
          </div>
          <div className="panel stack">
            <div className="row">
              <button className="btn primary big" onClick={doExport} disabled={!source || busy}>{exporting ? "書き出し中…" : "書き出す"}</button>
              {result && (
                <span className="small">
                  {formatBytes(result.bytes)} · ffmpeg {result.ffmpegSeconds.toFixed(1)} 秒 {result.lrcPath ? "· .lrc あり" : ""} <button className="btn sm" onClick={() => api.revealPath(result.dest).catch((e) => showToast("error", String(e)))}>フォルダを開く</button>
                </span>
              )}
            </div>
            {result?.warnings?.map((w, i) => <div key={i} className="hint">{w}</div>)}
            {result && <Player audioPath={result.dest} title={result.dest.split("\\").pop()} />}
          </div>
        </div>
      </div>
      {dialog}
    </div>
  );
}

