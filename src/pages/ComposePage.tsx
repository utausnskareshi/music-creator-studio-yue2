import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatSeconds, isToolCancelled, type GenerateParams, type Song, type ToolProgress } from "../api";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import StyleBuilder, { composeStyle, emptySelection, type StyleSelection } from "../components/StyleBuilder";
import { writeSong, type SongDraft, type SongLength } from "../lyrics/songwriter";
import { REQUESTED_TITLE_MAX_CHARS } from "../config/rules";
import { lockHint, lockReason } from "./locks";
import Player from "../components/Player";
import ProgressPanel from "../components/ProgressPanel";
import ScoreEditor from "../components/ScoreEditor";
import LyricsEditor from "../components/LyricsEditor";
import SectionFitTable from "../components/SectionFitTable";
import { useChoiceDialog } from "../components/ChoiceDialog";
import { irregularBarsNotice } from "../components/scoreEditorState";
import ToolCancelButton from "../components/ToolCancelButton";
import { isOwnToolEvent, newToolRunId, toolBusyLabel, toolSettled, toolStarted } from "../components/toolRun";
import { usePageVisibilityRef } from "../components/PageActive";
import { noticeFrom } from "./keepAlive";
import { detectLanguage, effectiveLyrics, hasSungVersion, normalizeNewlines, sameLyricsText, type LyricsLanguage } from "../lyrics/hiragana";
import { confirmSungLyrics } from "../lyrics/confirmSung";
import { styleBpm, withStyleBpm } from "../lyrics/styleBpm";
import { parseAbcDetailed, type IrregularBar } from "../abc/parse";
import { serializeAbc } from "../abc/serialize";
import type { Score } from "../abc/model";
import { instrumentalStyle, instrumentalTitle, lyricTagsFromAbc, toInstrumental } from "../abc/instrumental";
import { AcceptedAdvice } from "../compose/scoreAdvice";
import { SubmitGuard, draftReplaces, planSubmission, singleClick, type Mode } from "../compose/submitPlan";
import { isTruncated, modeLabel, pendingPlayerPlaceholder, songStatusLabel, truncationNotices } from "../library/songMeta";
import PageHeader from "../components/PageHeader";
import {
  DEFAULT_PLANNING_TAGS,
  DEFAULT_SAMPLING,
  MAX_SEED,
  OFFICIAL_MAX_DURATION,
  OFF_COMPAT_CFG,
  clampSeed,
  committedVariations,
  durationBudget,
  durationLimits,
  otherPianoEdits,
  provenanceParams,
  randomSeed as newRandomSeed,
  recordPianoEdit,
  rerenderModeAndCfg,
  samplingFrom,
  storedMaxDuration,
  storedParams,
  statedAbcTempo,
  styleTempoSync,
  usedFixedAbc,
  type InstrumentalProvenance,
  type PianoEdit,
  type Sampling,
} from "../compose/rules";

const DEFAULT_STYLE = "Japanese, J-pop, bright female vocal, piano, acoustic guitar, light drums, hopeful, 120 BPM";
/** shown when the backend sends the draft once more (its first reply ran to the length limit) */
export const RETRY_NOTICE = "AI の応答が長さ上限で途切れたため、思考なしでもう一度作成しています（1 分ほどかかることがあります）";

interface SubmitOverrides {
  mode?: Mode;
  abc?: string;
  /** text sent to the model (skips the form's hiragana handling) */
  lyrics?: string;
  /** lyrics stored with the song; defaults to `lyrics` (or the form's lyrics) */
  lyricsDisplay?: string;
  style?: string;
  count?: number;
  /** seed of the first job (later variations are random) */
  seed?: number;
  sampling?: Sampling;
  /** never send a budget below this (the stored budget of the song being re-rendered) */
  minMaxDuration?: number;
  /** extra lines for the final toast */
  notes?: string[];
  /** run the advisory score checks on a score passed in `abc` (the editor's 「この譜面で再生成」; no mode switch) */
  adviseScore?: boolean;
  /** form changes of the caller, applied with submitWith's own only once every dialog was confirmed */
  formUpdates?: (() => void)[];
  /** instrumental render: source score, transfer record and planner inputs stored with the song */
  provenance?: InstrumentalProvenance;
  /** song title (default: the AI draft's title while the form holds its lyrics, else the backend's automatic one) */
  title?: string;
}

/**
 * The 曲タイトル field's value: one line (a control character becomes a space, as the backend stores it; the text
 * input would only hide a line break) of at most REQUESTED_TITLE_MAX_CHARS characters, counted in code points like
 * the counter and the backend (the input's maxLength counts UTF-16 units: 30 emoji filled it). For titles the
 * page sets (an AI draft, a reused library song), which maxLength does not clip; typing goes through editedTitle.
 * Spaces at either end stay while the user types.
 */
export function fieldTitle(v: string): string {
  return Array.from(v.replace(/\p{Cc}/gu, " ")).slice(0, REQUESTED_TITLE_MAX_CHARS).join("");
}

/**
 * The 曲タイトル field after the user's edit of `prev` into `next`, whose caret `end` (UTF-16 offset) ends the
 * inserted text: as fieldTitle, but what is over the limit comes off the end of the inserted text, as with the
 * native maxLength, so the title that was there stays (fieldTitle would drop its end). An edit that is not one
 * insertion before the caret is not taken. Returns the value and its caret.
 */
export function editedTitle(prev: string, next: string, end: number | null): { value: string; caret: number } {
  const v = next.replace(/\p{Cc}/gu, " ");
  const at = Math.min(Math.max(end ?? v.length, 0), v.length);
  const over = Array.from(v).length - REQUESTED_TITLE_MAX_CHARS;
  if (over <= 0) return { value: v, caret: at };
  // prev = head + replaced text + tail, v = head + inserted text + tail
  const tail = v.slice(at);
  if (!prev.endsWith(tail)) return { value: prev, caret: Math.min(at, prev.length) };
  const room = Math.min(at, prev.length - tail.length);
  let head = 0;
  while (head < room && prev[head] === v[head]) head++;
  // not between the halves of a surrogate pair (two emoji may share the first half)
  const unit = v.charCodeAt(head - 1);
  if (head > 0 && unit >= 0xd800 && unit <= 0xdbff) head--;
  const inserted = Array.from(v.slice(head, at));
  const kept = inserted.slice(0, Math.max(0, inserted.length - over)).join("");
  return { value: v.slice(0, head) + kept + tail, caret: head + kept.length };
}

/** The fields an AI draft replaces, as they were when it was requested or are now. */
type DraftFields = { lyrics: string; style: string; sungLyrics: string | null; title: string };

/**
 * The fields edited while the AI draft was written (the form stays editable meanwhile), which taking the draft would
 * replace: the lyrics (with their hiragana version) and the title count only when they are replaced (not `styleOnly`).
 * A hiragana version emptied meanwhile is nothing to lose: an emptied pane is no version (hasSungVersion), and taking
 * the draft drops the version anyway.
 */
export function editedWhileWriting(atClick: DraftFields, now: DraftFields, styleOnly: boolean): { lyrics: boolean; title: boolean; style: boolean } {
  return {
    lyrics: !styleOnly && (now.lyrics !== atClick.lyrics || (now.sungLyrics !== atClick.sungLyrics && hasSungVersion(now.sungLyrics))),
    title: !styleOnly && now.title !== atClick.title,
    style: now.style !== atClick.style,
  };
}

/**
 * The form differs from the selected song, which the piano roll's 「この譜面で再生成」 and 「インストゥルメンタル版を
 * 生成」 render with its own style and lyrics: in the style, the kanji lyrics, or the text the form would sing (its
 * hiragana version; an emptied one sings the kanji lyrics) against what the song sang.
 */
export function formDiffersFromSong(song: Pick<Song, "style" | "lyrics" | "lyricsSung">, form: { style: string; lyrics: string; sungLyrics: string | null; language: LyricsLanguage }): boolean {
  return song.style.trim() !== form.style.trim() || song.lyrics.trim() !== form.lyrics.trim() || !sameLyricsText(effectiveLyrics(form.lyrics, form.sungLyrics, form.language), song.lyricsSung || song.lyrics);
}

/** The note of a 「この譜面で再生成」 that left the form's ABC as it was (formAbcAfterRerender). */
export const FORM_ABC_KEPT_NOTE = "「譜面を指定して生成」の ABC 欄には別の譜面があるため、再生成した譜面はコピーしていません";

/**
 * The form's ABC after 「この譜面で再生成」 queued the score `rendered`: a copy of it, unless that would lose what the
 * form holds. The form may hold a typed or pasted score, or the only copy of another song's piano-roll edit (「ABC
 * 欄に読み込む」): it is replaced only when it is empty or a song keeps its text (`kept`: the score of the song
 * re-rendered, and the score the previous re-render queued, which its new song keeps).
 */
export function formAbcAfterRerender(form: string, rendered: string, kept: readonly (string | null | undefined)[]): string {
  return !form.trim() || form === rendered || kept.includes(form) ? rendered : form;
}

/**
 * The note for an instrumental whose style was edited while its score was planned (typing is not locked): the
 * render keeps the style the score was planned with (score, style and the stored plan agree), and the edit stays
 * in the form for the next request.
 */
export function planningStyleNotes(planned: string, now: string): string[] {
  return planned.trim() === now.trim() ? [] : ["譜面の計画中に変更したスタイルは、この曲には使っていません（計画を始めたときのスタイルで生成しました）"];
}

export default function ComposePage() {
  // Not the whole progress: the page stays mounted while hidden and must not re-render on every progress event.
  const { config, songs, selectedSongId, selectSong, setScoreDirty, showToast, comfyAlive } = useStore(
    useShallow((s) => ({
      config: s.config,
      songs: s.songs,
      selectedSongId: s.selectedSongId,
      selectSong: s.selectSong,
      setScoreDirty: s.setScoreDirty,
      showToast: s.showToast,
      // only this (the whole status changes with the VRAM use on every poll)
      comfyAlive: Boolean(s.comfy?.alive),
    })),
  );
  const generating = useStore((s) => Boolean(s.progress.songId));
  const { ask, dialog } = useChoiceDialog();
  const visibility = usePageVisibilityRef();
  // Unsaved piano-roll edits keep a finished background job from replacing the selection. The page stays mounted
  // while another page is shown and its editor keeps the edits, so the flag stays too; it must not outlive the page
  // (a new setup rebuilds every page).
  useEffect(() => () => useStore.getState().setScoreDirty(false), []);
  /** the piano roll holds ABC text not applied yet (a new song loaded into it would drop that text) */
  const scoreTextDirty = useRef(false);
  const onScoreDirty = useCallback(
    (dirty: boolean, textDirty: boolean) => {
      setScoreDirty(dirty);
      scoreTextDirty.current = textDirty;
    },
    [setScoreDirty],
  );
  /** progress of the instrumental's score planning (tool "plan") and whether this page's planning call runs */
  const [planTool, setPlanTool] = useState<ToolProgress | null>(null);
  const [planning, setPlanning] = useState(false);
  /** run id of that call: only its tool events are shown */
  const planRun = useRef<string | null>(null);
  useEffect(() => {
    const un = api.onToolProgress((p) => {
      if (isOwnToolEvent(p, planRun.current, ["plan"])) setPlanTool(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
  const [style, setStyle] = useState(DEFAULT_STYLE);
  // The page starts without lyrics (the placeholder shows the tag layout); the language starts as Japanese.
  const [lyrics, setLyrics] = useState("");
  const [sungLyrics, setSungLyrics] = useState<string | null>(null);
  /** kanji text the hiragana version belongs to (null = unknown / none) */
  const [sungSource, setSungSource] = useState<string | null>(null);
  const [lyricsLanguage, setLyricsLanguage] = useState<LyricsLanguage>("ja");
  const [instrumentalBusy, setInstrumentalBusy] = useState(false);
  /** the lyrics editor converts to hiragana (a send meanwhile would sing the text the result replaces) */
  const [lyricsConverting, setLyricsConverting] = useState(false);
  const [instTags, setInstTags] = useState(true);
  const [styleSel, setStyleSel] = useState<StyleSelection>(emptySelection);
  const [brief, setBrief] = useState("");
  const [songLength, setSongLength] = useState<SongLength>("standard");
  const [writing, setWriting] = useState(false);
  /** the song's title (empty: the backend names it after its lyrics / style); the AI draft fills it in */
  const [title, setTitle] = useState("");
  /** the title field's value when an IME composition started (its text is cut to the limit when it is committed) */
  const titleBeforeIme = useRef<string | null>(null);
  /** Takes the user's edit of the title field `el` (made from `prev`), cut to the limit by editedTitle. */
  const onTitleEdit = (el: HTMLInputElement, prev: string) => {
    const { value, caret } = editedTitle(prev, el.value, el.selectionEnd);
    if (value !== el.value) {
      // written here with its caret: React then finds the field equal to the state and leaves it alone (its own
      // write would move the caret to the end)
      el.value = value;
      el.setSelectionRange(caret, caret);
    }
    setTitle(value);
  };
  /** a generate flow runs between its button and api.generate (its questions, estimates and the send itself) */
  const [sending, setSending] = useState(false);
  const [draftInfo, setDraftInfo] = useState<SongDraft | null>(null);
  /** the lyrics, style and title the last AI draft put into the form (replacing them again loses nothing typed) */
  const [lastDraft, setLastDraft] = useState<{ lyrics: string; style: string; title: string } | null>(null);
  /** the fields as they are now, for the check after the (slow) draft request */
  const formNow = useRef({ lyrics, style, sungLyrics, title });
  useEffect(() => {
    formNow.current = { lyrics, style, sungLyrics, title };
  });

  /**
   * AI songwriting: brief -> lyrics + style prompt + chips. When the draft would replace lyrics or a style the
   * user wrote (or a hiragana version with hand-fixed readings), asks first: replace, take only the style, or
   * cancel (the fields are set programmatically, so Ctrl+Z cannot bring them back). The fields stay editable
   * while the draft is written: what was typed meanwhile is asked about again before it is replaced.
   */
  const writeWithAi = async () => {
    if (!brief.trim()) return showToast("error", "曲のイメージを入力してください");
    const risk = draftReplaces({ lyrics, defaultLyrics: "", sungLyrics, style, defaultStyle: DEFAULT_STYLE, composedStyle: composeStyle(styleSel), title, lastDraft });
    let styleOnly = false;
    if (risk.lyrics || risk.style || risk.title) {
      const what = [risk.lyrics ? (hasSungVersion(sungLyrics) ? "歌詞（ひらがな版を含む）" : "歌詞") : "", risk.title ? "曲タイトル" : "", risk.style ? "スタイル" : ""].filter(Boolean).join("と");
      const c = await ask({
        title: "入力済みの内容を置き換えます",
        message: `AI が作った歌詞・曲タイトル・スタイルで、今の${what}を置き換えます。置き換えた内容は元に戻せません。`,
        choices: [{ value: "replace", label: "置き換える", kind: "primary" }, ...(risk.lyrics || risk.title ? [{ value: "style" as const, label: "スタイルだけ反映（歌詞と曲タイトルはそのまま）" }] : [])],
      });
      if (!c) return;
      styleOnly = c === "style";
    }
    const atClick = { lyrics, style, sungLyrics, title };
    const requestId = newToolRunId();
    writeReq.current = requestId;
    setWriting(true);
    try {
      const d = await writeSong(brief, lyricsLanguage, songLength, requestId);
      // キャンセル was pressed as the reply arrived: it is not used
      if (writeReq.current !== requestId) return;
      const meanwhile = editedWhileWriting(atClick, formNow.current, styleOnly);
      if (meanwhile.lyrics || meanwhile.title || meanwhile.style) {
        const what = [meanwhile.lyrics ? "歌詞" : "", meanwhile.title ? "曲タイトル" : "", meanwhile.style ? "スタイル" : ""].filter(Boolean).join("と");
        const c = await ask({
          title: "作成中に編集された内容があります",
          message: `歌詞とスタイルの作成中に${what}が編集されました。AI の案で置き換えると、その編集は失われます。`,
          choices: [{ value: "replace", label: "置き換える", kind: "primary" }, ...(meanwhile.lyrics || meanwhile.title ? [{ value: "style" as const, label: "スタイルだけ反映（歌詞と曲タイトルはそのまま）" }] : [])],
        });
        if (!c) return showToast("info", "AI の案は反映しませんでした");
        if (c === "style") styleOnly = true;
      }
      const draftTitle = fieldTitle(d.title);
      if (!styleOnly) {
        setLyrics(d.lyrics);
        setTitle(draftTitle);
        setSungLyrics(null);
        setSungSource(null);
      }
      setStyle(d.style);
      setStyleSel(d.selection);
      // the notes describe the drafted lyrics: not shown when only the style was taken
      setDraftInfo(styleOnly ? null : d);
      setLastDraft((prev) => ({ lyrics: styleOnly ? (prev?.lyrics ?? "") : d.lyrics, style: d.style, title: styleOnly ? (prev?.title ?? "") : draftTitle }));
      showToast("success", noticeFrom(`${styleOnly ? "スタイルを反映しました（歌詞と曲タイトルはそのまま）" : "歌詞とスタイルを作成しました"}（${d.provider}、${d.seconds.toFixed(0)} 秒${d.attempts > 1 ? "、2 回目の作成で成功" : ""}）`, visibility.current.active, visibility.current.label));
    } catch (e) {
      // a cancel was announced by cancelWriting
      if (!isToolCancelled(e)) showToast("error", noticeFrom(`歌詞の作成に失敗しました: ${e instanceof Error ? e.message : String(e)}`, visibility.current.active, visibility.current.label));
    } finally {
      if (writeReq.current === requestId) writeReq.current = null;
      setWriting(false);
    }
  };
  /** the request id of the draft being written (null: none, or it was cancelled) */
  const writeReq = useRef<string | null>(null);
  // The backend sends a draft once more (without thinking) when the first reply ran to the length limit: the
  // wait gets longer, so the page says why while its own draft is being written.
  useEffect(() => {
    const un = api.onLlmRetry((r) => {
      if (r.purpose === "draft" && writeReq.current) showToast("info", noticeFrom(RETRY_NOTICE, visibility.current.active, visibility.current.label));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
  const cancelWriting = () => {
    const id = writeReq.current;
    if (!id) return;
    writeReq.current = null;
    api.llmCancel(id).catch(() => {});
    showToast("info", "歌詞とスタイルの作成をキャンセルしました");
  };

  /** Clear lyrics (both panes), the title and the style (prompt + chips), after confirming in the page's dialog. */
  const resetInputs = async () => {
    const c = await ask({
      title: "歌詞とスタイルをリセット",
      message: "歌詞（ひらがな版を含む）・曲タイトル・スタイル（チップ・プロンプト）を空にします。元に戻せません。",
      choices: [{ value: "reset", label: "リセットする", kind: "danger" }],
    });
    if (c !== "reset") return;
    setLyrics("");
    setTitle("");
    setSungLyrics(null);
    setSungSource(null);
    setStyle("");
    setStyleSel(emptySelection());
    setDraftInfo(null);
  };
  const [mode, setMode] = useState<Mode>("full");
  const [abc, setAbc] = useState("");
  const [useAbc, setUseAbc] = useState(false);
  /** the 「譜面を指定して生成」 panel is open (its own state: unchecking the box inside must not close it) */
  const [abcOpen, setAbcOpen] = useState(false);
  const [seed, setSeed] = useState<number>(() => newRandomSeed());
  const [randomSeed, setRandomSeed] = useState(true);
  const [autoDuration, setAutoDuration] = useState(true);
  const [maxDuration, setMaxDuration] = useState(config?.defaultMaxDuration ?? OFFICIAL_MAX_DURATION);
  /** the manual 最大長 was set by the user or from a song's settings; until then it follows the default on 設定 */
  const maxDurationSet = useRef(false);
  const defaultMaxDuration = config?.defaultMaxDuration;
  useEffect(() => {
    // The page stays mounted while 設定 changes the default (and the config may arrive after the first render).
    if (!maxDurationSet.current && defaultMaxDuration !== undefined) setMaxDuration(defaultMaxDuration);
  }, [defaultMaxDuration]);
  const [estimate, setEstimate] = useState(60);
  const [adv, setAdv] = useState<Sampling>(DEFAULT_SAMPLING);
  /** バリエーション数 as typed (clamped to 1..8 on blur / Enter and when sending) */
  const [variationsText, setVariationsText] = useState("1");
  /** the last committed count: an emptied or invalid field goes back to it (not to 1) */
  const variations = useRef(1);
  const commitVariations = () => {
    const n = committedVariations(variationsText, variations.current);
    variations.current = n;
    setVariationsText(String(n));
  };

  useEffect(() => {
    const t = setTimeout(() => api.estimateDuration(lyrics).then(setEstimate), 300);
    return () => clearTimeout(t);
  }, [lyrics]);

  const selected = useMemo(() => songs.find((s) => s.id === selectedSongId) ?? null, [songs, selectedSongId]);
  /**
   * Piano-roll edits per song (src/compose/rules.ts recordPianoEdit). Kept apart from the form's ABC, which the
   * user may have typed or pasted: 「…譜面を読み込む」 copies them on request. Kept per song, so a selection
   * change (a finished job, a new request) does not discard them: the song shows them again when selected.
   */
  const [pianoEdits, setPianoEdits] = useState<Record<string, PianoEdit>>({});
  const selKey = selected?.id ?? "";
  const editedAbc = pianoEdits[selKey]?.abc ?? null;
  const pianoRollEdited = editedAbc !== null;
  const songIds = useMemo(() => new Set(songs.map((s) => s.id)), [songs]);
  const otherEdits = useMemo(() => otherPianoEdits(pianoEdits, selKey, songIds), [pianoEdits, selKey, songIds]);
  const onPianoEdit = (a: string) => setPianoEdits((m) => recordPianoEdit(m, selKey, { title: selected?.title ?? "", base: selected?.abc ?? "", abc: a }));
  /** Forget a song's piano-roll edit (only while it still holds abc, when given). */
  const dropPianoEdit = (key: string, abc?: string) =>
    setPianoEdits((m) => {
      if (!(key in m) || (abc !== undefined && m[key].abc !== abc)) return m;
      const next = { ...m };
      delete next[key];
      return next;
    });
  /** the score the last 「この譜面で再生成」 queued (its new song keeps it: a form's ABC that holds it may be replaced) */
  const rerendered = useRef<string | null>(null);
  /** Copy another song's (or the no-song) piano-roll edit into the form's ABC; it is then no longer kept apart. */
  const loadOtherPianoEdit = (key: string) => {
    const e = pianoEdits[key];
    if (!e) return;
    setAbc(e.abc);
    setAbcOpen(true);
    dropPianoEdit(key);
    showToast("info", `ピアノロールの譜面（${e.title || "曲を選ぶ前に編集した譜面"}）を「譜面を指定して生成」の ABC 欄に読み込みました${mode === "off" ? "（モードを Full / Melody にすると使えます）" : ""}`);
  };
  const discardPianoEdit = async () => {
    const c = await ask({
      title: "ピアノロールの編集を破棄",
      message: `「${selected?.title ?? "譜面"}」のピアノロールでの編集を破棄し、曲の譜面に戻します。元に戻せません。`,
      choices: [{ value: "discard", label: "破棄する", kind: "danger" }],
    });
    if (c === "discard") dropPianoEdit(selKey);
  };
  const { limit, defaultMax } = durationLimits(config);
  /**
   * The length settings as they are now: submitWith reads them when it plans the send. The instrumental render
   * calls it after its (slow) planning, and 設定 may have changed the default or the limit meanwhile (the page stays
   * mounted and follows them; the controls on the page are locked).
   */
  const durationsNow = useRef({ auto: autoDuration, manual: maxDuration, limit, defaultMax });
  durationsNow.current = { auto: autoDuration, manual: maxDuration, limit, defaultMax };
  const formAbc = mode !== "off" && useAbc ? abc : "";
  // Budget of the form as it stands (display only; submitWith recomputes it from what is actually sent).
  const shownBudget = useMemo(
    () => durationBudget({ auto: autoDuration, manual: maxDuration, limit, defaultMax, abc: formAbc, lyricEstimate: estimate }),
    [autoDuration, maxDuration, limit, defaultMax, formAbc, estimate],
  );
  const busy = generating;
  // The page's own work (the AI draft, the instrumental's planning, a send with its questions, the lyrics
  // editor's hiragana conversion): the controls it conflicts with are disabled meanwhile, with the reason as their
  // tooltip (pages/locks.ts). Typing stays possible; what was typed during the draft is asked about before the
  // draft replaces it.
  const locks = { writing, planning: instrumentalBusy, sending, converting: lyricsConverting };
  const lock = lockReason(locks);
  const locked = lock !== null;
  const hint = lockHint(locks);
  // The instrumental render reads these settings from its click, after the (slow) planning: they wait for it
  // (settings, not actions: LOCK_HINT.planning's 「実行できません」 does not fit them).
  const planningHint = instrumentalBusy ? "インストゥルメンタル版の譜面を計画中は変更できません。完了するか「キャンセル」で取り消してください" : undefined;

  // Double submits: one send at a time, and a second press of the same button right after an accepted send is
  // ignored (deliberate queueing while a job runs stays possible).
  const [guard] = useState(() => new SubmitGuard());
  const guarded = (key: string, fn: () => Promise<boolean>) => async () => {
    if (!guard.begin(key)) return;
    setSending(true);
    try {
      if (await fn()) guard.accepted(key);
    } finally {
      guard.end();
      setSending(false);
    }
  };

  const submit = guarded("generate", () => submitWith({}));

  /**
   * The lyrics to send. When the hiragana version may be out of date (the kanji lyrics changed after it was
   * made), asks: convert again, sing the kanji lyrics, send it as it is, or cancel (null).
   */
  const confirmSung = async (): Promise<string | null> => {
    const d = await confirmSungLyrics({ lyrics, sungLyrics, sungSource, language: lyricsLanguage }, ask);
    if (!d) return null;
    if (d.update) {
      setSungLyrics(d.update.sungLyrics);
      setSungSource(d.update.sungSource);
    }
    return d.text;
  };

  // Score findings the user already chose to send anyway (same score and sung text): not asked again.
  const [acceptedAdvice] = useState(() => new AcceptedAdvice());

  /** Send one request (or the variations). True when at least one job was queued. */
  const submitWith = async (over: SubmitOverrides): Promise<boolean> => {
    if (!(over.style ?? style).trim()) {
      showToast("error", "スタイルを入力してください");
      return false;
    }
    const formLyrics = over.lyrics === undefined;
    let sung = over.lyrics;
    if (sung === undefined) {
      const s = await confirmSung();
      if (s === null) return false;
      sung = s;
    }
    const display = over.lyricsDisplay ?? (formLyrics ? normalizeNewlines(lyrics) : sung);

    // Mode matching, advisory checks, style tempo and budget (src/compose/submitPlan.ts). Its form changes
    // (mode, chord-stripped score, style tempo) are applied only once every dialog has been confirmed.
    const plan = await planSubmission(
      {
        formMode: mode,
        formAbc: useAbc ? abc : "",
        formStyle: style,
        sung,
        formLyrics,
        over: { mode: over.mode, abc: over.abc, style: over.style, adviseScore: over.adviseScore, minMaxDuration: over.minMaxDuration, notes: over.notes },
        durations: { ...durationsNow.current, fallbackEstimate: estimate },
      },
      { ask, estimateDuration: api.estimateDuration, acceptedAdvice },
    );
    if (!plan) return false;

    const fc = plan.formChanges;
    if (fc.mode) setMode(fc.mode);
    if (fc.abc !== undefined) setAbc(fc.abc);
    if (fc.styleBpm !== undefined) {
      const bpm = fc.styleBpm;
      // the field as it is now (it may have been edited while a dialog was open), with only the tempo set
      setStyle((cur) => withStyleBpm(cur, bpm));
      setStyleSel((s) => ({ ...s, bpm }));
    }
    for (const f of over.formUpdates ?? []) f();
    const sampling = over.sampling ?? adv;
    // the caller's title (a re-render keeps its song's), else the form's title field; empty = the backend's own
    const songTitle = over.title?.trim() || (formLyrics ? title.trim() || undefined : undefined);
    const n = over.count ?? committedVariations(variationsText, variations.current);
    let queued = 0;
    // The queued song is followed only while 作曲 is shown (a hidden page must not change what 書き出し / AI 編集
    // work on; the finished song is announced instead), and not while the piano roll holds ABC text that is not
    // applied (loading the new song into the editor would drop it).
    let keptSelection = false;
    try {
      for (let i = 0; i < n; i++) {
        const s = i === 0 && over.seed !== undefined ? clampSeed(over.seed) : randomSeed || i > 0 ? newRandomSeed() : clampSeed(seed);
        const params: GenerateParams = {
          title: songTitle,
          style: plan.style,
          lyrics: sung,
          lyricsDisplay: display,
          mode: plan.mode,
          abc: plan.abc,
          seed: s,
          maxDuration: plan.maxDuration,
          temperature: sampling.temperature,
          topP: sampling.topP,
          topK: sampling.topK,
          repetitionPenalty: sampling.repetitionPenalty,
          cfgScale: sampling.cfgScale,
          steps: sampling.steps,
          abcTemperature: sampling.abcTemperature,
          ...provenanceParams(over.provenance ?? {}),
        };
        const song = await api.generate(params);
        queued++;
        // the new song is followed from the start (its result, and those of the next variations, are selected
        // when they finish; a hand pick stops that)
        if (i === 0) {
          if (visibility.current.active && !scoreTextDirty.current) selectSong(song.id, { follow: true });
          else keptSelection = visibility.current.active;
        }
        if (over.seed === undefined && !randomSeed && i === 0) setSeed(s);
      }
      const kept = keptSelection ? ["ピアノロールに未反映の ABC テキストがあるため、選択はそのままにしました（最近の生成から開けます）"] : [];
      showToast("info", noticeFrom([n > 1 ? `${n} 曲を待ち行列に追加しました` : "生成を開始しました", ...plan.notes, ...kept].join("。"), visibility.current.active, visibility.current.label));
    } catch (e) {
      showToast("error", String(e));
    }
    return queued > 0;
  };

  /**
   * Instrumental from a score (official instrumental skill): move the Vocal notes into the accompaniment voice
   * and render with the section tags as lyrics (or none), with the instrumental style. The editor's vocal
   * score is left as it is.
   */
  const renderInstrumentalFromAbc = async (
    sourceAbc: string,
    opts: { seed?: number; style?: string; sampling?: Sampling; minMaxDuration?: number; plan?: InstrumentalProvenance["plan"]; notes?: string[]; title?: string } = {},
  ): Promise<boolean> => {
    let parsed: Score;
    let irregularBars: IrregularBar[];
    try {
      ({ score: parsed, irregularBars } = parseAbcDetailed(sourceAbc));
    } catch (e) {
      showToast("error", `譜面を解釈できません: ${e instanceof Error ? e.message : String(e)}（インストゥルメンタル変換には解釈できる譜面が必要です。ABC テキストを直してから試してください）`);
      return false;
    }
    // No Q: in the score (the parser assumed 120): the re-serialized score takes the style's tempo instead.
    const styleTempo = styleBpm(opts.style ?? style);
    if (statedAbcTempo(sourceAbc) === null && styleTempo !== null) parsed.bpm = styleTempo;
    let transformed: string;
    let r: ReturnType<typeof toInstrumental>;
    try {
      r = toInstrumental(parsed);
      transformed = serializeAbc(r.score);
    } catch (e) {
      showToast("error", `インストゥルメンタルへの変換に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const notes = [...(opts.notes ?? []), `ボーカルの ${r.movedNotes} 音を伴奏声部に移しました${r.overlaps ? `（重なった伴奏音 ${r.overlaps} 箇所を調整）` : ""}`];
    // The converted score is written from the meter's bar grid: after a bar shorter or longer than the meter, every
    // later bar line moves (as in the score editor and the Melody chord strip).
    const rebarred = irregularBarsNotice(irregularBars, true);
    if (rebarred) notes.push(rebarred);
    // Tempo first, so instrumentalStyle() keeps the score's BPM. The form's style follows only once the
    // render is confirmed (submitWith applies formUpdates after its dialogs; a cancel changes nothing), and
    // only its tempo: style edits made while the score was being planned are kept.
    let base = (opts.style ?? style).trim();
    const formUpdates: (() => void)[] = [];
    const sync = styleTempoSync(base, r.score.bpm);
    if (sync) {
      base = sync.style;
      if (opts.style === undefined) {
        const bpm = sync.bpm;
        formUpdates.push(() => {
          setStyle((cur) => withStyleBpm(cur, bpm));
          setStyleSel((s) => ({ ...s, bpm }));
        });
      }
      notes.push(sync.note);
    }
    const m: Mode = r.score.chords.length > 0 ? "full" : "melody";
    // The lyrics stored with the song are the section tags actually sent (official lyric_tags()); the backend
    // keeps them as the song's lyrics, so reusing the song reproduces this request.
    return submitWith({
      mode: m,
      abc: transformed,
      lyrics: instTags ? lyricTagsFromAbc(transformed) : "",
      style: instrumentalStyle(base),
      count: 1,
      seed: opts.seed,
      sampling: opts.sampling,
      minMaxDuration: opts.minMaxDuration,
      notes,
      formUpdates,
      title: opts.title,
      provenance: { sourceAbc, instrumentalTransfer: { movedNotes: r.movedNotes, overlaps: r.overlaps }, plan: opts.plan },
    });
  };

  /** One-button instrumental: plan a score (same seed as the render), then render it without vocals. */
  const generateInstrumental = async () => {
    if (instrumentalBusy) return;
    if (!style.trim()) return showToast("error", "スタイルを入力してください");
    setInstrumentalBusy(true);
    try {
      const s = randomSeed ? newRandomSeed() : clampSeed(seed);
      let source = mode !== "off" && useAbc && abc.trim() ? abc : "";
      let plan: InstrumentalProvenance["plan"];
      if (!source) {
        // Official instrumental.py: plan with the user's lyrics when given, else with a default form skeleton
        // and the instrumental style.
        const withLyrics = lyrics.trim() !== "";
        // the planner reads the sung text, so a stale hiragana version is resolved first (as for every send)
        const planLyrics = withLyrics ? await confirmSung() : DEFAULT_PLANNING_TAGS;
        if (planLyrics === null) return;
        showToast("info", "譜面を計画しています（ComfyUI が停止中なら自動起動します）…");
        // the planner's own inputs are stored with the render (its style and lyrics differ from the render's)
        const planMode = mode === "melody" ? "melody" : "full";
        plan = { style: withLyrics ? style.trim() : instrumentalStyle(style.trim()), lyrics: planLyrics, mode: planMode, seed: s, abcTemperature: adv.abcTemperature };
        const runId = newToolRunId();
        planRun.current = runId;
        setPlanTool(toolStarted("plan", "開始"));
        setPlanning(true);
        try {
          source = await api.planScore(plan.style, plan.lyrics, planMode, s, adv.abcTemperature, runId);
        } finally {
          setPlanTool(toolSettled);
          setPlanning(false);
          if (planRun.current === runId) planRun.current = null;
        }
      }
      // the form's title with the instrumental mark (none typed: the backend's 「インスト: …」 title), as it is
      // now: typing is not locked while the score is planned. The style stays the one the score was planned with;
      // the toast says so when it was edited meanwhile.
      await renderInstrumentalFromAbc(source, { seed: s, plan, title: instrumentalTitle(formNow.current.title), notes: planningStyleNotes(style, formNow.current.style) });
    } catch (e) {
      // a cancelled planning is not an error (nothing was queued)
      if (isToolCancelled(e)) showToast("info", "譜面の計画をキャンセルしました");
      else showToast("error", String(e));
    } finally {
      setInstrumentalBusy(false);
    }
  };

  /**
   * Re-render requests from the score editor use the song whose score is shown, not the form. They always
   * render with a score, so an off song's off-compatible cfg (1.01) is not carried over (as in AI edit).
   */
  const selectedRequest = () => {
    if (!selected) return {};
    const p = storedParams(selected.paramsJson);
    const sampling = samplingFrom(p, DEFAULT_SAMPLING);
    const { cfgScale } = rerenderModeAndCfg({ hasAbc: true, hasChords: false, storedMode: p.mode ?? selected.mode, cfgScale: sampling.cfgScale });
    return {
      style: selected.style,
      seed: clampSeed(selected.seed),
      sampling: { ...sampling, cfgScale },
      minMaxDuration: storedMaxDuration(p) ?? undefined,
      notes: cfgScale !== sampling.cfgScale ? [`off 用の cfg ${sampling.cfgScale} は譜面付きの生成では使わず、公式既定の ${cfgScale} にしました`] : [],
    };
  };
  const formDiffers = Boolean(selected && formDiffersFromSong(selected, { style, lyrics, sungLyrics, language: lyricsLanguage }));

  const reuseSelected = () => {
    if (!selected) return;
    const p = storedParams(selected.paramsJson);
    const m = (["full", "melody", "off"].includes(selected.mode) ? selected.mode : "full") as Mode;
    setStyle(selected.style);
    // the chips describe the old style no longer (the same as the reset and the initial hand-written default)
    setStyleSel(emptySelection());
    // a song renamed in ライブラリ may have a longer title (the field shows what the send keeps)
    setTitle(fieldTitle(selected.title));
    setLyrics(selected.lyrics);
    setSungLyrics(selected.lyricsSung || null);
    // The stored pair was consistent when it was generated.
    setSungSource(selected.lyricsSung ? selected.lyrics : null);
    setLyricsLanguage(detectLanguage(selected.lyrics));
    setMode(m);
    setSeed(clampSeed(selected.seed));
    setRandomSeed(false);
    setAdv(samplingFrom(p, DEFAULT_SAMPLING));
    const md = storedMaxDuration(p);
    if (md !== null) {
      setAutoDuration(false);
      maxDurationSet.current = true;
      setMaxDuration(Math.min(limit, Math.round(md)));
    }
    // A fixed-score run keeps its score; a planned run re-plans with the same seed (its plan stays viewable).
    const fixed = usedFixedAbc(p, m);
    setUseAbc(fixed);
    if (fixed) setAbcOpen(true);
    const text = fixed ? (p.abc ?? "") : selected.abc;
    if (text) setAbc(text);
    setVariationsText("1");
    variations.current = 1;
    showToast("info", `選択中の曲の設定を読み込みました（シード ${clampSeed(selected.seed)}・${fixed ? "譜面固定" : m === "off" ? "譜面なし" : "譜面は同じシードで再計画"}${md !== null ? `・曲長の上限 ${formatSeconds(Math.min(limit, md))}` : ""}）`);
  };

  const budgetLabel = shownBudget.source === "score" ? "（譜面の長さから延長）" : shownBudget.source === "lyrics" ? "（歌詞の長さから延長）" : "";

  return (
    <div>
      {dialog}
      <PageHeader page="compose">
        <div className="muted">
          {comfyAlive ? "ComfyUI 稼働中" : "ComfyUI は最初の生成時に自動起動します"}
          {config?.precision === "int8" ? " · INT8 モデル" : " · BF16 モデル"}
        </div>
      </PageHeader>
      <div className="grid-compose">
        <div className="stack">
          <div className="panel stack">
            <div className="row between">
              <h3 style={{ margin: 0 }}>AI で歌詞とスタイルを作成</h3>
              <button className="btn sm danger" onClick={resetInputs} disabled={locked} title={hint ?? "歌詞（ひらがな版を含む）・曲タイトル・スタイル（チップ・プロンプト）を空にします"}>
                歌詞とスタイルをリセット
              </button>
            </div>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={"曲のイメージを日本語で自由に。例: 夏の終わりの海辺で、昔の恋を思い出す切ないミディアムバラード。女性ボーカルでピアノ中心、最後は少し前向きに。"}
              style={{ minHeight: 72 }}
              spellCheck={false}
            />
            <div className="row">
              <span className="muted">長さ</span>
              <div className="seg" role="group" aria-label="長さ">
                {(["short", "standard", "long"] as SongLength[]).map((l) => (
                  <button key={l} className={songLength === l ? "on" : ""} aria-pressed={songLength === l} onClick={() => setSongLength(l)} title={l === "short" ? "約 1 分の歌詞を作成します" : l === "standard" ? "約 3 分の歌詞を作成します" : "約 4 分の歌詞を作成します"}>
                    {l === "short" ? "短め 約1分" : l === "standard" ? "標準 約3分" : "長め 約4分"}
                  </button>
                ))}
              </div>
              <button className="btn primary" onClick={writeWithAi} disabled={writing || !brief.trim() || locked} title={locked && lock !== "writing" ? hint : undefined}>
                {writing ? "作成中（数十秒）…" : "歌詞とスタイルを作成"}
              </button>
              {writing && (
                <button className="btn sm" onClick={cancelWriting} title="AI への依頼を取り消します（クラウドの API では、送信済みの依頼が課金されることがあります）">
                  キャンセル
                </button>
              )}
              <span className="muted small">歌詞の言語は下の「歌詞の言語」に従います</span>
            </div>
            {draftInfo?.explanation && <div className="muted small">{draftInfo.explanation}</div>}
          </div>

          <div className="panel stack">
            <h3>歌詞</h3>
            <label className="field">
              <span className="lbl">
                <span>曲タイトル</span>
                <span className="mono" style={{ whiteSpace: "nowrap" }}>
                  {Array.from(title).length} / {REQUESTED_TITLE_MAX_CHARS}
                </span>
              </span>
              {/* The limit is kept in characters by editedTitle (maxLength only caps the UTF-16 units of two per
                  character); not while an IME composes, where a cut would break the composition: its committed
                  text is cut against the title it started from. */}
              <input
                type="text"
                value={title}
                maxLength={REQUESTED_TITLE_MAX_CHARS * 2}
                onChange={(e) => ((e.nativeEvent as InputEvent).isComposing ? setTitle(e.target.value) : onTitleEdit(e.target, title))}
                onCompositionStart={(e) => {
                  titleBeforeIme.current = e.currentTarget.value;
                }}
                onCompositionEnd={(e) => {
                  const before = titleBeforeIme.current;
                  titleBeforeIme.current = null;
                  if (before === null) setTitle(fieldTitle(e.currentTarget.value));
                  else onTitleEdit(e.currentTarget, before);
                }}
                placeholder="空欄なら歌詞の 1 行目などから自動で付けます"
                title="生成する曲の名前です。「歌詞とスタイルを作成」で AI の案が入ります。空欄なら歌詞の最初の行（タグを除く）などから自動で付けます"
                spellCheck={false}
                aria-label="曲タイトル"
              />
            </label>
            <LyricsEditor
              value={lyrics}
              onChange={setLyrics}
              sung={sungLyrics}
              onSungChange={setSungLyrics}
              sungSource={sungSource}
              onSungSourceChange={setSungSource}
              language={lyricsLanguage}
              onLanguageChange={setLyricsLanguage}
              // not for its own conversion (「ひらがな版を破棄」 stays available, as before; its キャンセル always is)
              busy={locked && lock !== "converting"}
              busyHint={hint}
              onBusyChange={setLyricsConverting}
              footer={
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row between muted">
                    <span>
                      {lyrics.split("\n").filter((l) => l.trim() && !l.trim().startsWith("[")).length} 行 · 推定 {formatSeconds(estimate)}
                    </span>
                    {lyricsLanguage === "ja" && <span className="hint">日本語ボーカルは実験的対応です（公式ベンチマークは英語・中国語のみ。ComfyUI 公式ドキュメントでは日本語も対応言語に含まれます）</span>}
                  </div>
                  {formAbc.trim() && <SectionFitTable abc={formAbc} lyrics={lyrics} sung={sungLyrics} language={lyricsLanguage} />}
                </div>
              }
            />
          </div>

          <div className="panel stack">
            <h3>スタイル</h3>
            <StyleBuilder value={style} onChange={setStyle} selection={styleSel} onSelectionChange={setStyleSel} />
          </div>
        </div>

        <div className="stack">
          <div className="panel stack">
            <h3>生成設定</h3>
            <div className="row">
              <span className="muted" style={{ width: 110 }}>
                譜面の計画
              </span>
              <div className="seg" role="group" aria-label="譜面の計画">
                {(["full", "melody", "off"] as const).map((m) => (
                  <button key={m} className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)} title={m === "full" ? "メロディ＋コードの譜面を計画してから生成" : m === "melody" ? "メロディのみの譜面を計画してから生成" : "譜面を計画せず直接生成"}>
                    {modeLabel(m)}
                  </button>
                ))}
              </div>
            </div>
            <div className="muted small">
              {mode === "full" && "AI がまず ABC 譜面（メロディとコード）を計画し、それを元に音声を生成します。譜面は後から編集して再生成できます。"}
              {mode === "melody" && "メロディのみを譜面として計画し、伴奏はスタイルに従って自由に演奏させます。カバー生成に向いています。"}
              {mode === "off" &&
                (adv.cfgScale !== 1
                  ? "譜面の計画を省略し、歌詞とスタイルから一発で生成します。cfg_scale が 1 以外のため 2 分岐になり、低速です。"
                  : "譜面の計画を省略し、歌詞とスタイルから一発で生成します。最も高速です。")}
            </div>

            {mode !== "off" && (
              <details open={abcOpen} onToggle={(e) => setAbcOpen((e.currentTarget as HTMLDetailsElement).open)}>
                <summary>譜面を指定して生成（ABC 記譜法）</summary>
                <div className="stack" style={{ marginTop: 8 }}>
                  <label className="row">
                    <input type="checkbox" checked={useAbc} onChange={(e) => setUseAbc(e.target.checked)} />
                    下の ABC 譜面を固定して音声だけを生成する
                  </label>
                  <textarea className="abc" value={abc} onChange={(e) => setAbc(e.target.value)} spellCheck={false} placeholder={"X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble name=\"Vocal Melody\" snm=\"Vocal\"\nV: Ins clef=treble name=\"Ins Melody\" snm=\"Inst.\"\nK:C\n% verse\nV: Vocal\n..."} />
                  {(pianoRollEdited || selected?.abc) && (
                    <button className="btn sm" onClick={() => setAbc(pianoRollEdited && editedAbc !== null ? editedAbc : (selected?.abc ?? ""))} title="下の「譜面（ピアノロール）」に表示している譜面を、この欄にコピーします">
                      {pianoRollEdited ? "ピアノロールの譜面（編集済み）を読み込む" : "選択中の曲の譜面を読み込む"}
                    </button>
                  )}
                  <div className="muted small">送信時にコードの有無でモードを合わせ（コードなし → Melody）、公式の記法チェックと歌詞のセクション照合を行います。スタイルの BPM は譜面の Q: に合わせます。</div>
                </div>
              </details>
            )}

            <div className="row">
              <span className="muted" style={{ width: 110 }}>
                曲長の上限
              </span>
              <label className="row" title={planningHint}>
                <input type="checkbox" checked={autoDuration} onChange={(e) => setAutoDuration(e.target.checked)} disabled={instrumentalBusy} />
                自動（既定 {defaultMax} 秒・長い歌詞/譜面は延長）
                {/* the manual limit is shown next to its slider only */}
                {autoDuration && (
                  <>
                    ：{formatSeconds(shownBudget.seconds)}
                    {budgetLabel}
                  </>
                )}
              </label>
              {!autoDuration && (
                <>
                  <input
                    type="range"
                    aria-label="曲長の上限（秒）"
                    aria-valuetext={formatSeconds(Math.min(limit, maxDuration))}
                    min={8}
                    max={limit}
                    step={1}
                    value={Math.min(limit, maxDuration)}
                    onChange={(e) => {
                      maxDurationSet.current = true;
                      setMaxDuration(Number(e.target.value));
                    }}
                    disabled={instrumentalBusy}
                    title={planningHint}
                    style={{ width: 180 }}
                  />
                  <span className="mono">{formatSeconds(Math.min(limit, maxDuration))}</span>
                </>
              )}
            </div>
            {shownBudget.warning && <div className="hint">{shownBudget.warning}</div>}
            <div className="muted small">上限は 25 トークン = 1 秒で換算されます。モデルが自然に終了すれば上限より短くなります（公式ノード・テンプレートの既定は 6 分）。譜面を固定した生成では譜面の長さから延長します。上級設定で {formatSeconds(limit)} まで。プロンプト（スタイル・歌詞・譜面）が長いと、モデルの文脈長（約 24576 トークン）に収めるため ComfyUI が実際の上限を自動で短縮します（長い譜面や大きな上限ほど短縮されやすく、短縮時はライブラリに表示されます）。</div>

            <div className="row">
              <span className="muted" style={{ width: 110 }}>
                シード
              </span>
              <label className="row">
                <input type="checkbox" checked={randomSeed} onChange={(e) => setRandomSeed(e.target.checked)} />
                ランダム
              </label>
              <input type="number" min={0} max={MAX_SEED} step={1} value={seed} disabled={randomSeed} onChange={(e) => setSeed(clampSeed(e.target.value))} style={{ width: 160 }} />
              <span className="muted">バリエーション数</span>
              <input
                type="number"
                min={1}
                max={8}
                value={variationsText}
                onChange={(e) => setVariationsText(e.target.value)}
                onBlur={commitVariations}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitVariations();
                }}
                style={{ width: 64 }}
              />
            </div>

            <details>
              <summary>詳細パラメータ</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                {(
                  [
                    ["temperature", "音楽 temperature", 0, 5, 0.05],
                    ["topP", "音楽 top_p", 0.01, 1, 0.01],
                    ["topK", "音楽 top_k", 1, 1000, 1],
                    ["repetitionPenalty", "音楽 repetition_penalty", 0.1, 3, 0.01],
                    ["cfgScale", "cfg_scale（1 以外は 2 分岐で低速）", 0, 20, 0.01],
                    ["steps", `レンダリングステップ（公式 ${DEFAULT_SAMPLING.steps}。減らすと高速だが音質低下）`, 4, 64, 1],
                    ["abcTemperature", "譜面 temperature", 0, 5, 0.05],
                  ] as const
                ).map(([k, label, min, max, step]) => (
                  <div key={k} className="stack" style={{ gap: 4 }}>
                    <label className="field">
                      <span className="lbl">
                        <span>{label}</span>
                        <span className="mono">{adv[k]}</span>
                      </span>
                      <input type="range" min={min} max={max} step={step} value={adv[k]} onChange={(e) => setAdv({ ...adv, [k]: Number(e.target.value) })} disabled={instrumentalBusy} title={planningHint} />
                    </label>
                    {k === "steps" && adv.steps < DEFAULT_SAMPLING.steps && <div className="hint">公式推奨値（{DEFAULT_SAMPLING.steps}）未満です。試聴用に速くしたいとき向けで、音質が下がります。</div>}
                    {k === "cfgScale" && mode === "off" && (
                      <div className="row small">
                        <span className="muted">off モードで公式 YuE2 ランタイムと同じ誘導にするには {OFF_COMPAT_CFG}（AR 2 分岐で約 2 倍低速）。ComfyUI のテンプレート既定は {DEFAULT_SAMPLING.cfgScale.toFixed(1)} です。</span>
                        <button className="btn sm" disabled={adv.cfgScale === OFF_COMPAT_CFG || instrumentalBusy} onClick={() => setAdv({ ...adv, cfgScale: OFF_COMPAT_CFG })} title={planningHint}>
                          公式 off 互換 ({OFF_COMPAT_CFG})
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                <button className="btn sm" onClick={() => setAdv(DEFAULT_SAMPLING)} disabled={instrumentalBusy} title={planningHint}>
                  既定値に戻す
                </button>
              </div>
            </details>

            <div className="row">
              <button className="btn primary big" onClick={singleClick(() => void submit())} disabled={!config || locked} title={hint}>
                {busy ? "待ち行列に追加" : "生成する"}
              </button>
              <button
                className="btn"
                onClick={singleClick(() => void generateInstrumental())}
                disabled={!config || locked}
                title={locked && lock !== "planning" ? hint : "譜面を計画してからボーカルの音符を伴奏声部に移し、歌詞なしで生成します（公式のインストゥルメンタル版の手順）"}
              >
                {instrumentalBusy ? toolBusyLabel("譜面を計画中", planning && planTool && !planTool.done ? planTool : null) : "インストゥルメンタル版を生成"}
              </button>
              <ToolCancelButton tool={planTool} running={planning} />
              {selected && (
                <button className="btn" onClick={reuseSelected} disabled={locked} title={hint ?? "選択中の曲のスタイル・歌詞・曲タイトル・シード・モード・詳細パラメータをフォームに読み込みます"}>
                  選択中の曲の設定を再利用
                </button>
              )}
            </div>
            <label className="row small" title={planningHint ?? "公式の instrumental 手順の既定では、譜面のセクション名（% verse など）を [Verse] のようなタグだけの歌詞として渡します。オフにすると空の歌詞で生成します"}>
              <input type="checkbox" checked={instTags} onChange={(e) => setInstTags(e.target.checked)} disabled={instrumentalBusy} />
              インストゥルメンタル: セクションタグ（[Verse] など）だけを歌詞として渡す（公式既定）
            </label>
            {hasSungVersion(sungLyrics) && lyricsLanguage === "ja" && <div className="muted small">生成にはひらがな版の歌詞を使用します。</div>}
          </div>

          <ProgressPanel />

          <div className="panel">
            <h3>プレイヤー</h3>
            <Player
              audioPath={selected?.status === "done" ? selected.audioPath : null}
              title={selected?.title}
              placeholder={pendingPlayerPlaceholder(selected)}
            />
            {selected && truncationNotices(selected).map((t) => (
              <div key={t} className="hint">
                {t}
              </div>
            ))}
          </div>

          <div className="panel stack">
            <h3>譜面（ピアノロール）</h3>
            <ScoreEditor
              abc={editedAbc ?? selected?.abc ?? ""}
              loadKey={selKey}
              busy={busy || locked}
              busyHint={hint}
              lyrics={selected ? selected.lyricsSung || selected.lyrics : undefined}
              onAbcChange={onPianoEdit}
              onDirtyChange={onScoreDirty}
              onRender={(a, hasChords) =>
                void guarded("rerender", async () => {
                  // The render keeps the selected song's request; only the score is copied into the form, once it
                  // was queued (a cancelled dialog or a failed send leaves the form's ABC as the user left it), and
                  // never over a score only the form holds: typed, pasted, or another song's edit (loadOtherPianoEdit).
                  const key = selKey;
                  const kept = [selected?.abc, rerendered.current];
                  const req = selectedRequest();
                  const keepsForm = formAbcAfterRerender(abc, a, kept) !== a;
                  const ok = await submitWith({
                    mode: hasChords ? "full" : "melody",
                    abc: a,
                    adviseScore: true,
                    count: 1,
                    ...(selected ? { lyrics: selected.lyricsSung || selected.lyrics, lyricsDisplay: selected.lyrics, title: selected.title } : {}),
                    ...req,
                    notes: [...(req.notes ?? []), ...(keepsForm ? [FORM_ABC_KEPT_NOTE] : [])],
                  });
                  if (ok) {
                    // the field as it is now (it stays editable while the request is sent)
                    setAbc((cur) => formAbcAfterRerender(cur, a, kept));
                    rerendered.current = a;
                    // the new song holds the edited score: no need to keep it apart
                    dropPianoEdit(key, a);
                  }
                  return ok;
                })()
              }
              onRenderInstrumental={(a) => void guarded("instrumental-score", () => renderInstrumentalFromAbc(a, { ...selectedRequest(), title: instrumentalTitle(selected?.title) }))()}
            />
            {pianoRollEdited && (
              <div className="row" style={{ flexWrap: "wrap" }}>
                {mode !== "off" && (
                  <span className="muted small grow">ピアノロールの編集は上の ABC 欄には自動で入りません。フォームで使うには「譜面を指定して生成」の「ピアノロールの譜面（編集済み）を読み込む」を押してください。</span>
                )}
                <button className="btn sm" onClick={() => void discardPianoEdit()} title="この曲のピアノロールでの編集を破棄して、曲の譜面に戻します">
                  編集を破棄
                </button>
              </div>
            )}
            {otherEdits.length > 0 && (
              <div className="stack">
                <div className="muted small">ほかの曲のピアノロールの編集が残っています（まだ生成に使っていません）。曲を選び直すとピアノロールに戻ります。</div>
                {otherEdits.map((e) => (
                  <div key={e.id} className="row" style={{ flexWrap: "wrap" }}>
                    <span className="small grow">{e.id ? e.title || "無題" : "曲を選ぶ前に編集した譜面"}</span>
                    {e.exists && (
                      <button className="btn sm" onClick={() => selectSong(e.id)}>
                        この曲を開く
                      </button>
                    )}
                    <button className="btn sm" onClick={() => loadOtherPianoEdit(e.id)} title="この譜面を「譜面を指定して生成」の ABC 欄にコピーします">
                      ABC 欄に読み込む
                    </button>
                  </div>
                ))}
              </div>
            )}
            {selected && formDiffers && (
              <div className="muted small">
                「この譜面で再生成」「インストゥルメンタル版を生成」は、選択中の曲（{selected.title}）のスタイル・歌詞・シード {clampSeed(selected.seed)}・詳細パラメータで生成します（上のフォームの内容とは異なります）。
              </div>
            )}
          </div>

          <div className="panel stack">
            <h3>最近の生成</h3>
            <div className="list">
              {songs.slice(0, 8).map((s) => (
                <div
                  key={s.id}
                  className={`song-row ${s.id === selectedSongId ? "selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-current={s.id === selectedSongId ? "true" : undefined}
                  onClick={() => selectSong(s.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectSong(s.id);
                    }
                  }}
                >
                  <div>
                    <div className="song-title">{s.title}</div>
                    <div className="song-meta">
                      {modeLabel(s.mode)} · シード {s.seed} · {s.duration ? formatSeconds(s.duration) : ""} {s.wallSeconds ? `· ${s.wallSeconds.toFixed(0)} 秒で生成` : ""}
                    </div>
                  </div>
                  <span className={`badge ${s.status}`}>{songStatusLabel(s.status)}</span>
                  {isTruncated(s) ? (
                    <span className="badge warn" title={truncationNotices(s).join("\n")}>
                      上限到達
                    </span>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
              {songs.length === 0 && <div className="empty">まだ曲がありません</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
