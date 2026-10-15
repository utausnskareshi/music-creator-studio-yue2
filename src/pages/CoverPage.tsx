import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, formatSeconds, isToolCancelled, type ToolProgress } from "../api";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import StyleBuilder from "../components/StyleBuilder";
import ScoreEditor from "../components/ScoreEditor";
import Player from "../components/Player";
import ProgressPanel from "../components/ProgressPanel";
import SectionFitTable from "../components/SectionFitTable";
import { useChoiceDialog, type ChoiceRequest } from "../components/ChoiceDialog";
import { irregularBarsNotice } from "../components/scoreEditorState";
import ToolCancelButton, { ToolOutcomeNote } from "../components/ToolCancelButton";
import { isOwnToolEvent, newToolRunId, toolBusyLabel, toolRejected, toolSettled, toolStarted } from "../components/toolRun";
import { usePageVisibilityRef } from "../components/PageActive";
import { formSongOf, noticeFrom } from "./keepAlive";
import { lockHint, lockReason } from "./locks";
import { pendingPlayerPlaceholder, truncationNotices } from "../library/songMeta";
import { parseAbcDetailed, type IrregularBar } from "../abc/parse";
import { serializeAbc } from "../abc/serialize";
import { type Score } from "../abc/model";
import { instrumentalStyle, lyricTagsFromAbc, toInstrumental } from "../abc/instrumental";
import { AcceptedAdvice, confirmScoreAdvice, scoreFindings } from "../compose/scoreAdvice";
import { SubmitGuard, singleClick } from "../compose/submitPlan";
import LyricsEditor from "../components/LyricsEditor";
import { detectLanguage, effectiveLyrics, normalizeNewlines, type LyricsLanguage } from "../lyrics/hiragana";
import { confirmSungLyrics } from "../lyrics/confirmSung";
import { styleBpm, withStyleBpm } from "../lyrics/styleBpm";
import PageHeader from "../components/PageHeader";
import {
  MAX_SEED,
  clampSeed,
  coverMaxDuration,
  durationLimits,
  hasSungWords,
  mmss,
  randomSeed as newRandomSeed,
  rawHasChords,
  scoreCutWarning,
  scoreSeconds,
  statedAbcTempo,
  styleTempoSync,
  summarizeAbc,
  tagSkeletonFromAbc,
} from "../compose/rules";

/** Section mismatch text of this page's 「譜面の確認」 dialog. */
const COVER_MISMATCH_MESSAGE = "譜面と歌詞のセクションが対応していない可能性があります（公式: セクションタグと歌詞の順序を譜面に合わせる）。";

/**
 * Before a send from the page's own buttons, which use the applied score: while the score editor holds ABC text
 * that is not applied, the score on screen is another one. Asks whether to generate from the applied score (the
 * page cannot apply the editor's text itself, so the way to use the text is named). True when the send may go on;
 * the text stays in the editor either way. The editor's own buttons ask in the editor instead.
 */
export async function appliedScoreOk(textDirty: boolean, ask: <T extends string>(r: ChoiceRequest<T>) => Promise<T | null>): Promise<boolean> {
  if (!textDirty) return true;
  const c = await ask({
    title: "未反映の ABC テキスト",
    message:
      "「転写された譜面」の ABC テキストの変更がまだ譜面に反映されていません。このまま生成すると、反映済みの譜面（ピアノロールと五線譜の譜面）を使います。テキストの内容で生成するには、キャンセルして「テキストを譜面に反映」を押してから、もう一度生成してください。",
    choices: [{ value: "applied", label: "反映済みの譜面で生成" }],
  });
  return c === "applied";
}

/**
 * Before a cover send: the configured 曲長の最大値 caps its budget (`maxDuration`, coverMaxDuration) below the score's
 * nominal length, so the song would be cut off before the score ends. Asks as 作曲 and AI 編集 do; true when the
 * send may go on.
 */
export async function coverLengthOk(scoreSec: number | null, maxDuration: number, ask: <T extends string>(r: ChoiceRequest<T>) => Promise<T | null>): Promise<boolean> {
  const cut = scoreCutWarning(scoreSec, maxDuration);
  if (!cut) return true;
  return (await ask({ title: "曲長の上限が譜面の長さより短くなっています", message: cut, choices: [{ value: "asis", label: `${mmss(maxDuration)} のまま生成` }] })) === "asis";
}

/**
 * The score was edited while a transcription ran (the page stays usable meanwhile), against the editor's state at
 * its click: the applied score changed, or ABC text was left unapplied since. Text already unapplied at the click
 * does not count (replacing it was agreed to before the transcription started).
 */
export function editedDuringTranscription(atClick: { editedAbc: string; scoreDirty: boolean }, now: { editedAbc: string; scoreDirty: boolean }): boolean {
  return now.editedAbc !== atClick.editedAbc || (now.scoreDirty && !atClick.scoreDirty);
}

export default function CoverPage() {
  // Not the whole progress: the page stays mounted while hidden and must not re-render on every progress event.
  const { songs, selectedSongId, selectSong, config, showToast } = useStore(
    useShallow((s) => ({ songs: s.songs, selectedSongId: s.selectedSongId, selectSong: s.selectSong, config: s.config, showToast: s.showToast })),
  );
  const generating = useStore((s) => Boolean(s.progress.songId));
  const { ask, dialog } = useChoiceDialog();
  const visibility = usePageVisibilityRef();
  const [source, setSource] = useState<string>("");
  /** the library song the source came from (null: a picked file) */
  const [sourceSongId, setSourceSongId] = useState<string | null>(null);
  /** the last cover this page queued: 「生成結果」 shows it, not whatever the library selection is now */
  const [coverSongId, setCoverSongId] = useState<string | null>(null);
  /** the score editor holds edits (a changed score, or ABC text not applied yet) */
  const [scoreDirty, setScoreDirty] = useState(false);
  /** of these, ABC text not applied yet (the page's generate buttons use the applied score) */
  const scoreTextDirty = useRef(false);
  const onScoreDirty = useCallback((dirty: boolean, textDirty: boolean) => {
    setScoreDirty(dirty);
    scoreTextDirty.current = textDirty;
  }, []);
  const [mode, setMode] = useState<"melody" | "full">("melody");
  /** what the current score was transcribed with (the toggle may have moved since) */
  const [transcribedMode, setTranscribedMode] = useState<"melody" | "full" | null>(null);
  const [abc, setAbc] = useState("");
  const [editedAbc, setEditedAbc] = useState("");
  /** successful transcriptions: the editor is remounted with each, also when the text is the same as before */
  const [loadCount, setLoadCount] = useState(0);
  const [tool, setTool] = useState<ToolProgress | null>(null);
  /** this page's transcription call has not returned yet (its cancel button) */
  const [transcribing, setTranscribing] = useState(false);
  /** run id of that call: only its tool events are shown */
  const runRef = useRef<string | null>(null);
  const [style, setStyle] = useState("Japanese, soulful jazz-pop, expressive male vocal, Rhodes piano, upright bass, brushed drums, 88 BPM");
  const [lyrics, setLyrics] = useState("");
  const [sungLyrics, setSungLyrics] = useState<string | null>(null);
  /** kanji text the hiragana version belongs to (null = unknown / none) */
  const [sungSource, setSungSource] = useState<string | null>(null);
  const [lyricsLanguage, setLyricsLanguage] = useState<LyricsLanguage>("ja");
  const [seed, setSeed] = useState<number>(() => newRandomSeed());
  const [randomSeed, setRandomSeed] = useState(true);

  useEffect(() => {
    // The page stays mounted while hidden, so a transcription that ends meanwhile still lands here.
    const un = api.onToolProgress((p) => {
      if (isOwnToolEvent(p, runRef.current, ["transcribe"])) setTool(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const selected = useMemo(() => songs.find((s) => s.id === selectedSongId) ?? null, [songs, selectedSongId]);
  const coverSong = useMemo(() => formSongOf(songs, coverSongId), [songs, coverSongId]);
  /** the score as it is now, for a transcription that returns later */
  const formNow = useRef({ abc, editedAbc, scoreDirty });
  formNow.current = { abc, editedAbc, scoreDirty };
  // A source song deleted in ライブラリ: its audio is gone (unless its folder was kept outside the song folder).
  // The transcribed score is the user's work and stays.
  const lastDeleted = useStore((s) => s.lastDeletedSong);
  useEffect(() => {
    if (!lastDeleted || lastDeleted.id !== sourceSongId) return;
    setSourceSongId(null);
    if (!lastDeleted.kept) setSource("");
  }, [lastDeleted?.n]);
  const busy = Boolean(tool && !tool.done);
  /** a generate flow runs between its button and api.generate (its questions and the send itself) */
  const [sending, setSending] = useState(false);
  /** the lyrics editor converts to hiragana (a send meanwhile would sing the text the result replaces) */
  const [lyricsConverting, setLyricsConverting] = useState(false);
  // The page's own work: the controls it conflicts with are disabled meanwhile (pages/locks.ts). A transcription
  // replaces the score, so nothing is generated from the old one and the source it reads stays put.
  const locks = { transcribing: busy, sending, converting: lyricsConverting };
  const lock = lockReason(locks);
  const locked = lock !== null;
  const hint = lockHint(locks);
  const { limit, defaultMax } = durationLimits(config);
  const score = editedAbc || abc;
  const summary = useMemo(() => summarizeAbc(score), [score]);
  const info = summary
    ? `${summary.bars} 小節 · ${formatSeconds(summary.seconds)} · ${Math.round(summary.bpm)} BPM · ${summary.key}${summary.timelineChanges ? " · 転調/拍子変更あり" : ""}${summary.parseError ? "（簡易解析）" : ""}`
    : "";
  const skeleton = useMemo(() => tagSkeletonFromAbc(score), [score]);

  const pickFile = async () => {
    const p = await open({ multiple: false, filters: [{ name: "音声", extensions: ["wav", "flac", "mp3", "m4a", "ogg", "opus", "aac"] }] });
    if (typeof p === "string") {
      setSource(p);
      setSourceSongId(null);
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
    // an instrumental's stored lyrics are only its section tags: nothing to sing, so nothing is copied
    if (selected.lyrics && !lyrics && hasSungWords(selected.lyrics)) {
      setLyrics(selected.lyrics);
      setSungLyrics(selected.lyricsSung || null);
      setSungSource(selected.lyricsSung ? selected.lyrics : null);
      setLyricsLanguage(detectLanguage(selected.lyrics));
    }
  };

  /** The score was edited since it was transcribed / loaded (the editor's own state, or its applied edits). */
  const scoreEdited = () => formNow.current.scoreDirty || formNow.current.editedAbc !== formNow.current.abc;
  const transcribe = async () => {
    if (!source) return showToast("error", "音源を選択してください");
    if (scoreEdited()) {
      const c = await ask({
        title: "譜面を転写し直します",
        message: "転写された譜面の編集（未反映の ABC テキストを含む）は失われます。",
        choices: [{ value: "redo", label: "転写し直す", kind: "danger" }],
      });
      if (!c) return;
    }
    // edits the user already agreed to replace above are not asked about again
    const atClick = { editedAbc: formNow.current.editedAbc, scoreDirty: formNow.current.scoreDirty };
    // the mode this transcription uses (the toggle is disabled meanwhile, and the record below names this one)
    const m = mode;
    const runId = newToolRunId();
    runRef.current = runId;
    setTool(toolStarted("transcribe", "開始"));
    setTranscribing(true);
    try {
      const result = await api.transcribeAudio(source, m, runId);
      if (editedDuringTranscription(atClick, formNow.current)) {
        const c = await ask({
          title: "転写中に譜面が編集されました",
          message: "転写結果で置き換えると、その編集は失われます。",
          choices: [{ value: "replace", label: "置き換える", kind: "danger" }],
        });
        if (!c) {
          showToast("info", "転写結果は反映しませんでした");
          return;
        }
      }
      setAbc(result);
      setEditedAbc(result);
      // a new editor for the new transcription: the same text as before must still drop the earlier edits
      setLoadCount((n) => n + 1);
      setTranscribedMode(m);
      // Describe the transcribed tempo in the style too (official: tempo in the ABC and the style must agree).
      const sync = styleTempoSync(style, statedAbcTempo(result));
      if (sync) {
        const bpm = sync.bpm;
        setStyle((s) => withStyleBpm(s, bpm));
        showToast("success", noticeFrom(`転写が完了しました。スタイルの BPM を譜面のテンポ（${bpm} BPM）に合わせました`, visibility.current.active, visibility.current.label));
      } else showToast("success", noticeFrom("転写が完了しました", visibility.current.active, visibility.current.label));
    } catch (e) {
      // A failure before the backend's final event must not leave 転写中 behind; a cancel is not an error
      // (the page shows 「キャンセルしました」).
      setTool((t) => toolRejected(t, "transcribe", e));
      if (!isToolCancelled(e)) showToast("error", noticeFrom(String(e), visibility.current.active, visibility.current.label));
    } finally {
      setTool(toolSettled);
      setTranscribing(false);
      if (runRef.current === runId) runRef.current = null;
    }
  };

  /** The lyrics to send; asks when the hiragana version may be out of date. Null = cancelled. */
  const confirmSung = async (): Promise<string | null> => {
    const d = await confirmSungLyrics({ lyrics, sungLyrics, sungSource, language: lyricsLanguage }, ask);
    if (!d) return null;
    if (d.update) {
      setSungLyrics(d.update.sungLyrics);
      setSungSource(d.update.sungSource);
    }
    return d.text;
  };

  /** Style with the score's tempo (updates the form, only its tempo); the note is added to `notes`. */
  const syncStyleBpm = (st: string, text: string, notes: string[]): string => {
    const sync = styleTempoSync(st, statedAbcTempo(text));
    if (!sync) return st;
    const bpm = sync.bpm;
    setStyle((cur) => withStyleBpm(cur, bpm));
    notes.push(sync.note);
    return sync.style;
  };

  const currentSeed = () => (randomSeed ? newRandomSeed() : clampSeed(seed));

  // Score findings the user already chose to send anyway (same score and sung text): not asked again.
  const [acceptedAdvice] = useState(() => new AcceptedAdvice());

  // Double submits: one send at a time, and a second press right after an accepted send is ignored.
  const [guard] = useState(() => new SubmitGuard());
  const guarded =
    <A extends unknown[]>(key: string, fn: (...args: A) => Promise<boolean>) =>
    async (...args: A) => {
      if (!guard.begin(key)) return;
      setSending(true);
      try {
        if (await fn(...args)) guard.accepted(key);
      } finally {
        guard.end();
        setSending(false);
      }
    };

  /**
   * Instrumental cover (official instrumental skill, cover path): the transcribed Vocal notes move into the Ins
   * voice; chords stay only for a "melody + chords" transcription (the official --keep-harmony); the style
   * becomes the instrumental style and the lyrics are the score's section tags (official default). True when
   * the job was queued.
   */
  const instrumentalCover = async (text: string): Promise<boolean> => {
    if (!style.trim()) {
      showToast("error", "スタイルを入力してください");
      return false;
    }
    let parsed: Score;
    let irregularBars: IrregularBar[];
    try {
      ({ score: parsed, irregularBars } = parseAbcDetailed(text));
    } catch (e) {
      showToast("error", `譜面を解釈できません: ${e instanceof Error ? e.message : String(e)}（インストゥルメンタル変換には解釈できる譜面が必要です）`);
      return false;
    }
    // No Q: in the score (the parser assumed 120): the re-serialized score takes the style's tempo instead.
    const styleTempo = styleBpm(style);
    if (statedAbcTempo(text) === null && styleTempo !== null) parsed.bpm = styleTempo;
    const r = toInstrumental(parsed);
    // official --keep-harmony goes with the "full" transcription: decided by how this score was transcribed,
    // not by where the 「抽出する内容」 toggle is now
    const keepHarmony = (transcribedMode ?? mode) === "full";
    const droppedChords = !keepHarmony && r.score.chords.length > 0;
    if (!keepHarmony) r.score.chords = [];
    let transformed: string;
    try {
      transformed = serializeAbc(r.score);
    } catch (e) {
      showToast("error", `インストゥルメンタルへの変換に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const scoreSec = scoreSeconds(r.score);
    const maxDuration = coverMaxDuration(scoreSec, limit, defaultMax);
    // asked before the style's tempo is synced: a cancel leaves the form as it was
    if (!(await coverLengthOk(scoreSec, maxDuration, ask))) return false;
    const notes = [`ボーカルの ${r.movedNotes} 音を伴奏声部に移しました${r.overlaps ? `（重なった伴奏音 ${r.overlaps} 箇所を調整）` : ""}${droppedChords ? "。「メロディのみ」の転写なのでコードは使いません" : ""}`];
    // The converted score is written from the meter's bar grid: after a bar shorter or longer than the meter, every
    // later bar line moves (as in the score editor).
    const rebarred = irregularBarsNotice(irregularBars, true);
    if (rebarred) notes.push(rebarred);
    const base = syncStyleBpm(style.trim(), transformed, notes);
    try {
      // The stored lyrics are the section tags actually sent (official lyric_tags()); the transcription and the
      // transfer record are kept with the song (official instrumental skill).
      const song = await api.generate({
        style: instrumentalStyle(base),
        lyrics: lyricTagsFromAbc(transformed),
        mode: r.score.chords.length > 0 ? "full" : "melody",
        abc: transformed,
        seed: currentSeed(),
        maxDuration,
        sourceAbc: text,
        instrumentalTransfer: { movedNotes: r.movedNotes, overlaps: r.overlaps },
      });
      setCoverSongId(song.id);
      // a hidden page does not change what the other pages work on
      if (visibility.current.active) selectSong(song.id);
      showToast("info", ["インストゥルメンタル版カバーの生成を開始しました", ...notes].join("。"));
      return true;
    } catch (e) {
      showToast("error", String(e));
      return false;
    }
  };

  const cover = async (): Promise<boolean> => {
    if (!score.trim()) {
      showToast("error", "先に転写するか譜面を読み込んでください");
      return false;
    }
    if (!style.trim()) {
      showToast("error", "スタイルを入力してください");
      return false;
    }
    const sung = await confirmSung();
    if (sung === null) return false;
    // Nothing to sing is decided from what is sung (the hiragana version when there is one, or what its question
    // chose), not from the kanji pane.
    if (!hasSungWords(sung)) {
      const choice = await ask({
        title: "歌う歌詞がありません",
        message:
          "歌詞なしのまま通常のカバーとして生成すると、ボーカルの旋律が歌詞のない声（ハミングなど）で鳴ることがあります。公式のインストゥルメンタル版カバーの手順では、ボーカルの音符を伴奏声部に移して歌なしで生成します。",
        choices: [
          { value: "inst", label: "インストゥルメンタル版カバー（歌なし）を生成", kind: "primary" },
          { value: "vocal", label: "ボーカル譜のまま生成" },
        ],
      });
      if (!choice) return false;
      if (choice === "inst") return instrumentalCover(score);
    }
    const findings = scoreFindings(score);
    const hasChords = findings.parsed ? findings.parsed.chords.length > 0 : rawHasChords(score);
    // lyrics without section tags: only a note after sending, not a dialog on every send
    const advice = await confirmScoreAdvice({ abc: score, sung, findings, accepted: acceptedAdvice, ask, mismatchMessage: COVER_MISMATCH_MESSAGE });
    if (!advice.ok) return false;
    const scoreSec = summary?.seconds ?? null;
    const maxDuration = coverMaxDuration(scoreSec, limit, defaultMax);
    if (!(await coverLengthOk(scoreSec, maxDuration, ask))) return false;
    const notes: string[] = [...advice.notes];
    const st = syncStyleBpm(style.trim(), score, notes);
    try {
      const song = await api.generate({
        style: st,
        lyrics: sung,
        lyricsDisplay: normalizeNewlines(lyrics),
        mode: hasChords ? "full" : "melody",
        abc: score,
        seed: currentSeed(),
        maxDuration,
      });
      setCoverSongId(song.id);
      if (visibility.current.active) selectSong(song.id);
      showToast("info", ["カバー生成を開始しました", ...notes].join("。"));
      return true;
    } catch (e) {
      showToast("error", String(e));
      return false;
    }
  };

  const generateCover = guarded("cover", async () => (await appliedScoreOk(scoreTextDirty.current, ask)) && cover());
  const generateInstrumentalCover = guarded("instrumental-cover", instrumentalCover);
  /** the page's 「インストゥルメンタル版カバーを生成」 (the editor's own button has asked about its text already) */
  const instrumentalCoverFromPage = guarded("instrumental-cover", async () => (await appliedScoreOk(scoreTextDirty.current, ask)) && instrumentalCover(score));
  // what a cover would sing now (the hiragana version when there is one): the editor compares its sections
  const sungNow = effectiveLyrics(lyrics, sungLyrics, lyricsLanguage);

  return (
    <div>
      {dialog}
      <PageHeader page="cover" />
      <p className="page-desc">既存の音源を SheetSage2 で ABC 譜面に転写し、メロディと構造を保ったまま、新しいスタイルと歌詞で演奏・歌唱させます。元の音色や歌手の声は引き継がれません。</p>
      <div className="grid-compose">
        <div className="stack">
          <div className="panel stack">
            <h3>1. 参考音源</h3>
            <div className="row">
              <button className="btn" onClick={pickFile} disabled={busy} title={busy ? hint : undefined}>音声ファイルを選択</button>
              <button className="btn" onClick={useLibrarySong} disabled={!selected || busy} title={busy ? hint : undefined}>ライブラリの選択中の曲を使う</button>
            </div>
            <div className="mono small" style={{ wordBreak: "break-all" }}>{source || "未選択（WAV / FLAC / MP3 / M4A / OGG）"}</div>
            {source && (
              <div className="panel" style={{ padding: 10 }}>
                <Player audioPath={source} title="参考音源" />
              </div>
            )}
          </div>
          <div className="panel stack">
            <h3>2. 転写（耳コピ）</h3>
            <div className="row">
              <span className="muted" style={{ width: 90 }}>抽出する内容</span>
              <div className="seg" role="group" aria-label="抽出する内容">
                <button className={mode === "melody" ? "on" : ""} aria-pressed={mode === "melody"} onClick={() => setMode("melody")} disabled={busy} title={busy ? hint : undefined}>メロディのみ</button>
                <button className={mode === "full" ? "on" : ""} aria-pressed={mode === "full"} onClick={() => setMode("full")} disabled={busy} title={busy ? hint : undefined}>メロディ＋コード</button>
              </div>
            </div>
            <div className="muted small">
              {mode === "melody" ? "主旋律と構造だけを保ち、伴奏はスタイルに従って自由に演奏させます（推奨）。" : "元曲のコード進行も保ちます。原曲に近いアレンジになります。"}
            </div>
            <div className="row">
              <button className="btn primary" onClick={transcribe} disabled={!source || locked} title={locked && lock !== "transcribing" ? hint : undefined}>
                {busy ? toolBusyLabel("転写中", tool) : "音源を譜面に転写"}
              </button>
              <ToolCancelButton tool={tool} running={transcribing} />
              <ToolOutcomeNote tool={tool} />
              {info && <span className="muted small">{info}</span>}
            </div>
          </div>
          <div className="panel stack">
            <h3>3. 新しい歌詞</h3>
            <LyricsEditor
              value={lyrics}
              onChange={setLyrics}
              sung={sungLyrics}
              onSungChange={setSungLyrics}
              sungSource={sungSource}
              onSungSourceChange={setSungSource}
              language={lyricsLanguage}
              onLanguageChange={setLyricsLanguage}
              busy={sending}
              busyHint={hint}
              onBusyChange={setLyricsConverting}
              minHeight={160}
              placeholder={"[Verse]\n新しい歌詞...\n\n[Chorus]\n...\n\n空のまま生成すると、インストゥルメンタル版カバー（歌なし）にするか確認します"}
              footer={score.trim() ? <SectionFitTable abc={score} lyrics={lyrics} sung={sungLyrics} language={lyricsLanguage} /> : undefined}
            />
            {!lyrics.trim() && skeleton && (
              <div className="row">
                <button
                  className="btn sm"
                  onClick={() => {
                    setLyrics(skeleton);
                    setSungLyrics(null);
                    setSungSource(null);
                  }}
                  title="譜面の % セクション（intro / verse / chorus…）から [Verse] などのタグを並べた歌詞の枠を作ります（公式: セクションタグと歌詞の順序を譜面に合わせる）"
                >
                  譜面のセクションから歌詞の枠を作る
                </button>
              </div>
            )}
            <div className="muted small">元曲の歌詞は自動では取得されません（自分で入力するか、ライブラリの曲なら歌詞が引き継がれます）。元の歌詞と近い音数・同じセクション構成にすると歌いやすくなります。</div>
          </div>
          <div className="panel stack">
            <h3>4. 新しいスタイル</h3>
            <StyleBuilder value={style} onChange={setStyle} />
            <div className="row">
              <span className="muted">シード</span>
              <label className="row"><input type="checkbox" checked={randomSeed} onChange={(e) => setRandomSeed(e.target.checked)} /> ランダム</label>
              <input type="number" min={0} max={MAX_SEED} step={1} value={seed} disabled={randomSeed} onChange={(e) => setSeed(clampSeed(e.target.value))} style={{ width: 150 }} />
            </div>
            <div className="row">
              <button className="btn primary big" onClick={singleClick(() => void generateCover())} disabled={!score || generating || locked} title={hint}>
                この譜面でカバーを生成
              </button>
              <button className="btn" onClick={singleClick(() => void instrumentalCoverFromPage())} disabled={!score || generating || locked} title={hint ?? "転写したボーカルの音符を伴奏声部に移し、歌なしで生成します（公式のインストゥルメンタル版カバーの手順）。コードは「メロディ＋コード」で転写したときだけ使います"}>
                インストゥルメンタル版カバーを生成
              </button>
            </div>
          </div>
        </div>
        <div className="stack">
          <div className="panel stack">
            <h3>転写された譜面（編集可）</h3>
            <ScoreEditor
              key={loadCount}
              abc={abc}
              onAbcChange={setEditedAbc}
              onDirtyChange={onScoreDirty}
              lyrics={sungNow.trim() ? sungNow : undefined}
              busy={generating || locked}
              busyHint={hint}
              onRenderInstrumental={(a) => void generateInstrumentalCover(a)}
            />
          </div>
          <ProgressPanel />
          {coverSong && (
            <div className="panel stack">
              <h3>生成結果</h3>
              <Player audioPath={coverSong.status === "done" ? coverSong.audioPath : null} title={coverSong.title} placeholder={pendingPlayerPlaceholder(coverSong)} />
              {truncationNotices(coverSong).map((t) => (
                <div key={t} className="hint">
                  {t}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
