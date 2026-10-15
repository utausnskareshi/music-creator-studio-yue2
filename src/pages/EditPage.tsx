import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isToolCancelled, type ChatMessage, type EditReply, type LlmStatus, type Song } from "../api";
import { newToolRunId } from "../components/toolRun";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { diffLines, diffStats } from "../diff";
import { parseAbc } from "../abc/parse";
import { validateNativeAbc } from "../abc/native";
import { compareScores } from "../abc/compare";
import { AcceptedAdvice, confirmScoreAdvice, findingsAcceptedAtApply, scoreFindings, scoreHasChords } from "../compose/scoreAdvice";
import { SubmitGuard, singleClick } from "../compose/submitPlan";
import ScoreEditor from "../components/ScoreEditor";
import ProgressPanel from "../components/ProgressPanel";
import Player from "../components/Player";
import LyricsEditor from "../components/LyricsEditor";
import SectionFitTable from "../components/SectionFitTable";
import { useChoiceDialog, type ChoiceRequest } from "../components/ChoiceDialog";
import { usePageVisibility, usePageVisibilityRef } from "../components/PageActive";
import { SELECTION_LOAD_LABEL, formChanged, formSongOf, noticeFrom, selectionLoad, selectionSwitchQuestion, unloadedSelectionHint } from "./keepAlive";
import { LOCK_HINT } from "./locks";
import { detectLanguage, effectiveLyrics, hasSungVersion, normalizeNewlines, reconvertKeepingFixes, sameLyricsText, toHiragana, type HiraganaResult, type LyricsLanguage } from "../lyrics/hiragana";
import { confirmSungLyrics } from "../lyrics/confirmSung";
import { styleBpm, styleBpmDiffers, withStyleBpm } from "../lyrics/styleBpm";
import PageHeader from "../components/PageHeader";
import {
  DEFAULT_SAMPLING,
  EditConversation,
  KEEP_MELODY,
  clampSeed,
  compactEditHistory,
  diffWithContext,
  durationLimits,
  editHistoryBudget,
  editWork,
  editedSinceSent,
  latestReplyIndex,
  localEditFit,
  localLlmView,
  melodyReaskBase,
  melodyReaskText,
  dropRepeatedFields,
  reaskText,
  repeatedFieldsNote,
  rerenderTitle,
  worthReask,
  mmss,
  plannedScoreLoad,
  randomSeed,
  reaskHistoryBudget,
  replyVerdict,
  replaceAbcTempo,
  rerenderMaxDuration,
  rerenderLabel,
  rerenderModeAndCfg,
  samplingFrom,
  scoreCutWarning,
  statedAbcTempo,
  storedMaxDuration,
  storedParams,
  styleTempoSync,
  summarizeAbc,
  tempoDialogDefault,
  type ReplyVerdict,
} from "../compose/rules";

interface Turn {
  role: "user" | "assistant";
  text: string;
  reply?: EditReply;
  applied?: boolean;
  /** the ABC the request was made against (the diff and the melody check compare with it) */
  sentAbc?: string;
  /** the score in the editor when the request was sent (the melody re-ask sends an earlier one): the apply check */
  editorAbc?: string;
  /** the style the request was made with (the diff and the tempo dialog compare with it) */
  sentStyle?: string;
  /** the (kanji) lyrics the request was made with (the diff compares with them) */
  sentLyrics?: string;
  /** checker findings that remained after the automatic re-ask: applying asks for confirmation */
  problems?: string[];
  /** the reply could not be parsed at all */
  unparsable?: boolean;
  /** the instruction asked to keep the melody but the Vocal notes changed */
  melodyChanges?: string[];
  /** the one follow-up request for the melody was sent (or this turn is that request's reply) */
  reasked?: boolean;
  /** the request failed: not sent again as history */
  error?: boolean;
  /** the song the conversation was about when the reply arrived (applied only to that song) */
  songId?: string | null;
  /** the score the apply put into the editor (the reply, or the reply with the tempo dialog's Q: change) */
  appliedAbc?: string;
}

const SUGGESTIONS = [
  "サビのコードをジャズ風のセブンスコードにリハーモナイズして。メロディは変えないで",
  "全体のテンポを 8 BPM 上げて、もっと疾走感のあるロックアレンジにして",
  "Aメロのメロディを少し落ち着いた低めの音域に移して",
  "イントロを 4 小節短くして",
  "サビを一番盛り上がるように、最高音を上げて",
  "歌詞の 2 番を、1 番と韻を踏むように書き直して",
  "スタイルをシティポップ風にして、ローズピアノとスラップベースを加えて",
];

/** Section mismatch text of this page's 「譜面の確認」 dialog. */
const EDIT_MISMATCH_MESSAGE = "譜面と歌詞のセクションが対応していない可能性があります（公式: セクションを増減・複製したら譜面と歌詞の両方を直す）。";

/**
 * ABC text typed in the score editor's text tab and not applied (ScoreEditor textDirty): the editor's own buttons
 * ask about it, the page's actions here. A render or a send uses the applied score (`hasScore`; without one the
 * render plans a score again, or stays without one for an Off song (`offRender`), and the AI gets none) and the
 * text stays in the editor; an apply that changes the score (the reply's, `replyHasScore`, or the tempo dialog's
 * Q:) replaces the text. True = go on. The page cannot apply the text itself: the user does that in the editor.
 */
export async function unappliedScoreTextOk(
  i: { textDirty: boolean; action: "render" | "send" | "apply"; hasScore: boolean; replyHasScore?: boolean; offRender?: boolean },
  ask: <T extends string>(r: ChoiceRequest<T>) => Promise<T | null>,
): Promise<boolean> {
  if (!i.textDirty) return true;
  const then =
    i.action === "apply"
      ? `${i.replyHasScore ? "提案の譜面を適用" : "譜面の Q: を変更"}すると、テキストの変更は失われます。`
      : i.hasScore
        ? `${i.action === "render" ? "反映済みの譜面で生成します" : "AI には反映済みの譜面を送ります"}（テキストの変更はそのまま残ります）。`
        : `反映済みの譜面がないため、${i.action === "send" ? "AI には譜面なしで送ります" : i.offRender ? "譜面なしで生成します" : "譜面を再計画して生成します"}（テキストの譜面は使われず、そのまま残ります）。`;
  const c = await ask({
    title: "未反映の ABC テキスト",
    message: `ABC テキストの変更がまだ譜面に反映されていません。${then}`,
    note: "テキストの変更を使う場合は、キャンセルして「テキストを譜面に反映」を押してください。",
    choices: [{ value: "go", label: i.action === "apply" ? "変更を破棄して適用" : "反映せずに続ける", kind: "danger" }],
  });
  return c === "go";
}

export default function EditPage() {
  // Not the whole progress: the page stays mounted while hidden and must not re-render on every progress event.
  const { songs, selectedSongId, selectSong, config, showToast } = useStore(
    useShallow((s) => ({ songs: s.songs, selectedSongId: s.selectedSongId, selectSong: s.selectSong, config: s.config, showToast: s.showToast })),
  );
  const generating = useStore((s) => Boolean(s.progress.songId));
  const { ask, dialog } = useChoiceDialog();
  const { active, label: pageLabel } = usePageVisibility();
  const visibility = usePageVisibilityRef();
  const selected = useMemo(() => songs.find((s) => s.id === selectedSongId) ?? null, [songs, selectedSongId]);
  const [abc, setAbc] = useState("");
  const [style, setStyle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [sungLyrics, setSungLyrics] = useState<string | null>(null);
  /** kanji text the hiragana version belongs to (null = unknown / none) */
  const [sungSource, setSungSource] = useState<string | null>(null);
  const [lyricsLanguage, setLyricsLanguage] = useState<LyricsLanguage>("ja");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** apply() is rebuilding the hiragana version */
  const [converting, setConverting] = useState(false);
  /** the lyrics editor converts to hiragana (a send meanwhile would sing the text the result replaces) */
  const [lyricsConverting, setLyricsConverting] = useState(false);
  /** 「この譜面で再生成」 runs between its button and api.generate (its questions, the hiragana conversion, the send) */
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  /** the local LLM is being started or stopped from this page */
  const [llmBusy, setLlmBusy] = useState<"start" | "stop" | null>(null);
  const [showDiff, setShowDiff] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { limit, defaultMax } = durationLimits(config);
  // Score findings the user already accepted (at apply or at an earlier render): not asked again.
  const [acceptedAdvice] = useState(() => new AcceptedAdvice());
  /** an LLM request is in flight (checked before anything else, so no path sends a second one) */
  const inFlight = useRef(false);
  /**
   * The conversation's generation and its pending request (rules.ts): a reset or another song starts a new
   * conversation, and a late reply of an old one, or of a cancelled request, is dropped.
   */
  const [conv] = useState(() => new EditConversation());
  /**
   * The song the conversation is about (the form was loaded from it, or this page's 再生成 made it); null
   * for input without a song. The ref is read by async code, the state renders the song's player and settings.
   */
  const convSong = useRef<string | null>(null);
  const [convSongId, setConvSongId] = useState<string | null>(null);
  const setConv = (id: string | null) => {
    convSong.current = id;
    setConvSongId(id);
  };
  /** that song as last seen in the library (its title and settings still apply after it was deleted there) */
  const lastConvSong = useRef<Song | null>(null);
  /** the form as loaded from that song: a change of it is work that loading another song would replace */
  const loadedForm = useRef<Record<string, string | null>>({});
  /** the question about loading another song is open */
  const askingLoad = useRef(false);
  /** the library selection this page last saw while shown (keepAlive.ts selectionLoad seenId) */
  const seenSel = useRef<string | null>(null);
  const abcRef = useRef(abc);
  abcRef.current = abc;
  /** the form as it is now, for the check after apply's waits (the first dictionary load is slow) */
  const formNow = useRef({ abc, style, lyrics, sungLyrics, sungSource });
  formNow.current = { abc, style, lyrics, sungLyrics, sungSource };
  /**
   * The score editor holds ABC text typed in its text tab and not applied (ScoreEditor onDirtyChange): the page's
   * actions use the applied score, and loading a score (a reply, another song) drops the text.
   */
  const scoreTextDirty = useRef(false);
  const onScoreDirty = useCallback((_dirty: boolean, textDirty: boolean) => {
    scoreTextDirty.current = textDirty;
  }, []);
  const [guard] = useState(() => new SubmitGuard());

  // The LLM status is polled only while the page is shown (it stays mounted while hidden), and read again when it
  // is shown (the provider may have been changed on 設定 meanwhile).
  useEffect(() => {
    if (!active) return;
    api.llmStatus().then(setStatus).catch(() => setStatus(null));
    const t = setInterval(() => api.llmStatus().then(setStatus).catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [active]);

  /** the form song as last seen by the effect below that loads a finished song's score */
  const synced = useRef<{ id: string | null; status: string | null; abc: string }>({ id: null, status: null, abc: "" });

  // The conversation's own song (not the library selection: that may be another song while this page keeps its
  // work, or none). Its player, seed and sampling settings, and the apply check, all come from it.
  const convLive = useMemo(() => songs.find((s) => s.id === convSongId) ?? null, [songs, convSongId]);
  if (convLive) lastConvSong.current = convLive;
  const formSong = formSongOf(songs, convSongId, lastConvSong.current);
  /** the mode the form song was made with (a render without a score keeps it, rerenderModeAndCfg) */
  const storedMode = storedParams(formSong?.paramsJson).mode ?? formSong?.mode;

  /** Load a song into the form; a new conversation starts. */
  const loadSong = (song: Song) => {
    conv.restart();
    setConv(song.id);
    lastConvSong.current = song;
    synced.current = { id: song.id, status: song.status, abc: song.abc };
    loadedForm.current = { abc: song.abc, style: song.style, lyrics: song.lyrics, sung: song.lyricsSung || null };
    setAbc(song.abc);
    setStyle(song.style);
    setLyrics(song.lyrics);
    setSungLyrics(song.lyricsSung || null);
    // The stored pair was consistent when the song was generated.
    setSungSource(song.lyricsSung ? song.lyrics : null);
    setLyricsLanguage(detectLanguage(song.lyrics));
    setTurns([]);
  };

  /**
   * Load `target` (the library selection) unless the page already saw it (`seenId`, keepAlive.ts selectionLoad),
   * after asking when a conversation or edits would be lost. Work without a song (typed or pasted, or its song was
   * deleted in ライブラリ) is asked about too. Keeping the work leaves the selection alone: the page goes on with
   * its own song, and the 「選択中の曲を読み込む」 button loads the selection later (seenId null). A reply still
   * pending (the page was left while waiting) is named, and loading cancels its request (as キャンセル does).
   */
  const followSelection = (target: Song, seenId: string | null) => {
    if (askingLoad.current) return;
    const edited = formChanged(loadedForm.current, { abc, style, lyrics, sung: sungLyrics });
    const work = editWork({ turns: turns.length, edited, textDirty: scoreTextDirty.current, pending: conv.pending !== null });
    const d = selectionLoad({ active, selectedId: target.id, loadedId: convSong.current, seenId, hasWork: work.length > 0, keepable: true });
    if (d === "none") return;
    if (d === "load") return loadSong(target);
    const q = selectionSwitchQuestion({ page: pageLabel, current: formSong?.title ?? "", next: target.title, work });
    askingLoad.current = true;
    void ask({ title: q.title, message: q.message, note: q.note, choices: [{ value: "load", label: q.loadLabel, kind: "danger" }], cancelLabel: q.keepLabel }).then((c) => {
      askingLoad.current = false;
      if (c !== "load") return;
      const st = useStore.getState();
      const now = st.songs.find((s) => s.id === target.id);
      if (!now || st.selectedSongId !== now.id) return;
      // the reply would be dropped anyway (another conversation): the request ends now instead of keeping the
      // page busy (and the LLM working) until it arrives
      if (conv.pending !== null) cancelSend();
      loadSong(now);
    });
  };

  // Follow the library selection. The page stays mounted while hidden and follows it only when shown, and only
  // a selection made since it last looked: a song selected meanwhile is loaded on return (followSelection). The
  // song this page's own 再生成 selects is already the conversation's song. While 再生成 or 適用 is between its
  // button and its last write into the form (sending, converting), a new selection is followed once it is done.
  const holdSelection = sending || converting;
  useEffect(() => {
    if (!active || holdSelection) return;
    const seen = seenSel.current;
    seenSel.current = selected?.id ?? null;
    if (selected) followSelection(selected, seen);
  }, [active, selected?.id, holdSelection]);

  // A song rendered without a score (the planner writes one) gets its score when it finishes: load it while
  // the editor is still empty (never over a score typed in the meantime, applied or not: rules.ts plannedScoreLoad).
  // Only the conversation's song counts, whatever is selected now.
  useEffect(() => {
    if (!convLive) return;
    const prev = synced.current;
    synced.current = { id: convLive.id, status: convLive.status, abc: convLive.abc };
    const d = plannedScoreLoad(prev, convLive, { abc: abcRef.current, textDirty: scoreTextDirty.current });
    if (d === "load") {
      loadedForm.current = { ...loadedForm.current, abc: convLive.abc };
      setAbc(convLive.abc);
      showToast("info", noticeFrom("計画された譜面を読み込みました", visibility.current.active, visibility.current.label));
    } else if (d === "kept") {
      const text = "計画された譜面は、ABC テキストに未反映の変更があるため読み込みませんでした（ライブラリの曲の「ABC 譜面」で確認できます）";
      showToast("info", noticeFrom(text, visibility.current.active, visibility.current.label));
    }
  }, [convLive?.id, convLive?.status, convLive?.abc]);

  // The conversation ends at its newest turn. A turn that arrives while the page is hidden (display: none, where
  // scrollTo does nothing) is scrolled to when the page is shown again; a plain page switch leaves the list as it
  // was. The first effect runs before the second, so a change while shown scrolls at once.
  const scrollPending = useRef(false);
  const scrolledFor = useRef({ turns: -1, busy: false });
  useEffect(() => {
    const seen = scrolledFor.current;
    if (seen.turns !== turns.length || seen.busy !== busy) {
      scrolledFor.current = { turns: turns.length, busy };
      scrollPending.current = true;
    }
    if (!active || !scrollPending.current) return;
    scrollPending.current = false;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [active, turns.length, busy]);

  /** unappliedScoreTextOk for this form (`replyHasScore`: the apply puts the reply's score in, not only a Q: change). */
  const unappliedTextOk = (action: "render" | "send" | "apply", replyHasScore = false): Promise<boolean> =>
    unappliedScoreTextOk({ textDirty: scoreTextDirty.current, action, hasScore: abc.trim() !== "", replyHasScore, offRender: storedMode === "off" }, ask);

  /** the score the user chose to send anyway although it may not fit the local LLM's reply (not asked again) */
  const fitAccepted = useRef<string | null>(null);
  /**
   * Local LLM: a reply that changes the score carries all of it, and a long score does not fit the local server's
   * output cap (thinking included) or its context (rules.ts localEditFit). Asked before sending instead of failing
   * after minutes of generation; true = send.
   */
  const localFitOk = async (i: { abc: string; style: string; lyrics: string; sung: string | null; instruction: string }): Promise<boolean> => {
    const llm = config?.llm;
    if (!llm || llm.provider !== "local" || fitAccepted.current === i.abc) return true;
    const fit = localEditFit({ contextSize: llm.contextSize, thinking: llm.thinking, ...i });
    if (!fit) return true;
    const c = await ask({
      title: "譜面が長いため失敗する可能性があります",
      message: fit.promptTooLong
        ? `譜面と歌詞がローカル LLM のコンテキスト長（${llm.contextSize.toLocaleString()} トークン）に収まらないため、送ると失敗します。`
        : `この曲の譜面は約 ${fit.scoreTokens.toLocaleString()} トークンあり、譜面を変える指示では、AI が返す完全な譜面がローカル LLM の応答の上限（約 ${fit.room.toLocaleString()} トークン${llm.thinking ? "、思考を含む" : ""}）に収まらない可能性があります（上限で途切れるまで生成してから失敗します）。`,
      details: [
        fit.promptTooLong ? "" : "スタイルや歌詞だけを変える指示なら、譜面は返されないため、このまま送れます。",
        fit.promptTooLong || fit.contextBound ? "設定の「コンテキスト長」を増やすと収まる可能性があります。" : "",
        fit.withoutThinkingFits ? "設定で「思考モード」をオフにすると収まる可能性があります。" : "",
        "設定のプロバイダをクラウドの API（Anthropic API など）にすると、応答の上限が大きいため長い譜面も編集できます。",
      ].filter(Boolean),
      choices: [{ value: "send", label: "このまま送る", kind: fit.promptTooLong ? "danger" : "primary" }],
    });
    if (c !== "send") return false;
    fitAccepted.current = i.abc;
    return true;
  };

  /**
   * `keepMelody`: compare the reply's Vocal notes with the sent score whatever the wording (the melody re-ask).
   * `fromInput`: the text is the instruction box's, which is then cleared (a chip or the re-ask keeps a draft).
   * `baseAbc`: the score to send instead of the editor's (the melody re-ask of an earlier turn).
   * `fromReask`: the reply is the melody re-ask's (it offers no further automatic re-ask).
   */
  const send = async (text: string, opts: { keepMelody?: boolean; fromInput?: boolean; baseAbc?: string; fromReask?: boolean } = {}) => {
    const instruction = text.trim();
    if (!instruction || inFlight.current) return;
    inFlight.current = true;
    const sentAbc = opts.baseAbc ?? abc;
    const editorAbc = abc;
    const sentStyle = style;
    const sentLyrics = lyrics;
    // what a reply's field is "the same as": an empty field keeps the editor's, so the score counts only when the
    // editor's is the one sent (not for the melody re-ask's earlier score, which a reply may rightly restore)
    const sentFields = { abc: sentAbc === editorAbc ? sentAbc : null, style: sentStyle, lyrics: sentLyrics };
    // The reading actually sung, as read-only context for syllable counts (Japanese with a hiragana version).
    const sung = lyricsLanguage === "ja" && hasSungVersion(sungLyrics) ? sungLyrics : null;
    // Asked before anything is sent (the melody re-ask goes out as offered): ABC text not applied (the applied
    // score is sent), and a score too long for the local LLM's reply. Nothing is sent for a form that another
    // song replaced while a question was open.
    if (!opts.fromReask) {
      const genAtClick = conv.gen;
      const ok = (await unappliedTextOk("send")) && (await localFitOk({ abc: sentAbc, style: sentStyle, lyrics: sentLyrics, sung, instruction }));
      if (!ok || conv.gen !== genAtClick) {
        inFlight.current = false;
        return;
      }
    }
    const requestId = newToolRunId();
    // a new conversation, or キャンセル (the draft goes back into the box then)
    const stale = conv.begin(requestId);
    if (opts.fromInput) setInput("");
    setTurns((t) => [...t, { role: "user", text: instruction }]);
    sentInstruction.current = { text: instruction, fromInput: Boolean(opts.fromInput) };
    setBusy(true);
    try {
      // Older replies go without their score (the context block holds the current state); on the local server
      // the oldest exchanges are left out until the request fits its context.
      // null: the cloud, or a local context size of 0 (the model's own, unknown here): nothing is trimmed
      const budget = config?.llm.provider === "local" ? editHistoryBudget({ contextSize: config.llm.contextSize, abc: sentAbc, style: sentStyle, lyrics: sentLyrics, sung, instruction }) : null;
      const historyTurns = turns.map((t) => ({ role: t.role, text: t.text, raw: t.reply?.raw, explanation: t.reply?.explanation, error: t.error }));
      const compacted = compactEditHistory(historyTurns, budget);
      const history = compacted.messages;
      let dropped = compacted.dropped;
      const edit = (h: ChatMessage[], ins: string) => api.llmEdit(sentAbc, sentStyle, sentLyrics, h, ins, sung, requestId);
      let reply = await edit(history, instruction);
      if (stale()) return;
      const originalBars = (() => {
        try {
          return sentAbc.trim() ? parseAbc(sentAbc).bars : 0;
        } catch {
          return 0;
        }
      })();
      type Verdict = ReplyVerdict;
      // Validate the returned ABC before offering it: an excerpt, text the parser rejects, or text outside the
      // official native dialect (validateNativeAbc, advisory) gets one automatic re-ask (rules.ts replyVerdict).
      const check = (r: EditReply): Verdict => replyVerdict(originalBars, r.abc, instruction);
      // The sent score itself (once): a problem it already has is not the reply's fault, so it gets no
      // automatic re-ask (it would cost a second LLM round trip every turn and rarely fixes it).
      const sentParses = (() => {
        if (!sentAbc.trim()) return true;
        try {
          parseAbc(sentAbc);
          return true;
        } catch {
          return false;
        }
      })();
      const sentNativeErrors = sentAbc.trim() ? validateNativeAbc(sentAbc).errors.length : 0;
      let verdict = check(reply);
      let retryFailed = "";
      let reaskSkipped = false;
      if (verdict && worthReask(verdict, sentParses, sentNativeErrors)) {
        const first = { reply, verdict };
        const again = reaskText(verdict, originalBars);
        // The re-ask sends the first exchange (about one more score) on top of the history: on the local server
        // the older history gets only what is left, and without room for the first exchange there is no re-ask.
        const retryBudget = reaskHistoryBudget(budget, { instruction, firstRaw: reply.raw, again });
        if (retryBudget !== null && retryBudget < 0) {
          reaskSkipped = true;
        } else {
          const older = retryBudget === null ? compacted : compactEditHistory(historyTurns, retryBudget);
          const retryHistory: ChatMessage[] = [...older.messages, { role: "user", content: instruction }, { role: "assistant", content: reply.raw }];
          try {
            reply = await edit(retryHistory, again);
            verdict = check(reply);
            // a retry that came back without a score is worse than the first reply: keep the first one (a retry
            // that gives the sent score back is its answer: for a lyrics-only instruction that is the right one, and
            // the repeated score is dropped below)
            if (!reply.abc.trim() && first.reply.abc.trim()) ({ reply, verdict } = first);
            else dropped = Math.max(dropped, older.dropped);
          } catch (e) {
            // the first reply is still usable (its findings are reported and confirmed at apply)
            ({ reply, verdict } = first);
            retryFailed = `\n\n⚠ 自動の再依頼に失敗しました（${String(e)}）。最初の返答を表示します。`;
          }
          if (stale()) return;
        }
      }
      // A field returned whole but unchanged counts as unchanged (""), and a reply with nothing else says so.
      const repeated = dropRepeatedFields(reply, sentFields);
      reply = repeated.reply;
      // the sent score itself came back: its own findings are not the reply's
      if (repeated.repeated.includes("abc")) verdict = null;
      let note = "";
      if (repeated.repeated.length && !reply.abc.trim() && !reply.style.trim() && !reply.lyrics.trim()) note += `\n\n${repeatedFieldsNote(repeated.repeated)}`;
      const turn: Turn = { role: "assistant", text: "", reply, sentAbc, editorAbc, sentStyle, sentLyrics, songId: convSong.current, ...(opts.fromReask ? { reasked: true } : {}) };
      const barsNote = (level: "reask" | "note" | "shortened", bars: number) =>
        level === "reask"
          ? `\n\n⚠ 返された譜面は ${bars} 小節しかありません（元は ${originalBars} 小節）。抜粋の可能性が高いので、適用前に差分を確認してください。`
          : level === "note"
            ? `\n\n⚠ 返された譜面は ${bars} 小節しかありません（元は ${originalBars} 小節）。短くする指示でも短すぎるため抜粋の可能性があります。適用前に差分を確認してください。`
            : `\n\n※ 小節数が ${originalBars} → ${bars} に減りました。指示どおりの削除か、抜粋になっていないかを適用前に差分で確認してください。`;
      if (verdict?.kind === "parse") {
        note = `\n\n⚠ 返された譜面に問題があります: ${verdict.message}。「修正して」と伝えると再試行します（このまま適用する場合は確認します）。`;
        turn.problems = [verdict.message];
        turn.unparsable = true;
      } else if (verdict?.kind === "native") {
        note = `\n\n⚠ 返された譜面が公式の記法チェックに ${verdict.errors.length} 件通りません。適用するときに確認します（「修正して」と伝えると再試行します）。`;
        if (verdict.shortLevel) note += barsNote(verdict.shortLevel, verdict.bars);
        turn.problems = verdict.errors;
      } else if (verdict?.kind === "short") {
        note = barsNote(verdict.level, verdict.bars);
        // a still-short reply may also break the notation: apply confirms that too
        const nat = reply.abc.trim() ? validateNativeAbc(reply.abc) : null;
        if (nat && !nat.ok) turn.problems = nat.errors;
      }
      // "Keep the melody": report what changed in the notes (official: check musical events, not strings).
      if ((opts.keepMelody || KEEP_MELODY.test(instruction)) && reply.abc.trim() && sentAbc.trim() && verdict?.kind !== "parse") {
        try {
          const d = compareScores(parseAbc(sentAbc), parseAbc(reply.abc));
          const v = d.voices.Vocal;
          if (v.changed || v.added || v.removed || d.barCount || d.meterChanged) {
            turn.melodyChanges = d.lines;
            note += `\n\n⚠ 「メロディは変えない」指示ですが、ボーカルの音符が変わっています:\n${d.lines.join("\n")}`;
          }
        } catch {
          /* the original score cannot be parsed: nothing to compare */
        }
      }
      const droppedNote = dropped > 0 ? `\n\n（ローカル LLM のコンテキスト長に収めるため、古いやり取り ${dropped} 件は送っていません）` : "";
      const skippedNote = reaskSkipped ? "\n\n（ローカル LLM のコンテキスト長に収まらないため、自動の再依頼は行っていません）" : "";
      turn.text = reply.explanation + retryFailed + note + skippedNote + droppedNote;
      setTurns((t) => [...t, turn]);
      // the page stays mounted while hidden: tell the user where the reply is
      if (!visibility.current.active) showToast("info", noticeFrom("AI の返答が届きました", false, visibility.current.label));
    } catch (e) {
      if (!stale() && !isToolCancelled(e)) setTurns((t) => [...t, { role: "assistant", text: `エラー: ${String(e)}`, error: true }]);
    } finally {
      conv.end(requestId);
      inFlight.current = false;
      setBusy(false);
    }
  };
  const sentInstruction = useRef<{ text: string; fromInput: boolean } | null>(null);
  /** キャンセル: the request ends, its instruction leaves the conversation and (typed in the box) goes back there. */
  const cancelSend = () => {
    const id = conv.cancel();
    if (!id) return;
    api.llmCancel(id).catch(() => {});
    const sent = sentInstruction.current;
    setTurns((t) => (t.length > 0 && t[t.length - 1].role === "user" ? t.slice(0, -1) : t));
    if (sent?.fromInput) setInput((cur) => (cur.trim() ? cur : sent.text));
    showToast("info", "AI への依頼をキャンセルしました");
  };

  /** One follow-up request asking to restore the vocal melody, against the score the turn was made from. */
  const reaskMelody = (idx: number) => {
    const t = turns[idx];
    if (!t?.melodyChanges || t.reasked || inFlight.current || idx !== latestReplyIndex(turns)) return;
    const base = melodyReaskBase({ sentAbc: t.sentAbc, applied: t.applied, replyAbc: t.reply?.abc, appliedAbc: t.appliedAbc }, abc);
    if (base === null) return;
    setTurns((ts) => ts.map((x, i) => (i === idx ? { ...x, reasked: true } : x)));
    send(melodyReaskText(t.melodyChanges), { keepMelody: true, baseAbc: base, fromReask: true });
  };

  const resetConversation = () => {
    // not while 適用 rebuilds the hiragana version (its reply would be dropped with the conversation)
    if (inFlight.current || converting) return;
    conv.restart();
    setTurns([]);
    setShowDiff(null);
  };

  const apply = async (idx: number) => {
    const t = turns[idx];
    const r = t?.reply;
    if (!r) return;
    if ((t.songId ?? null) !== convSong.current) return showToast("error", "この提案は別の曲に対するものなので適用できません");
    // The conversation and the song as the apply starts: its questions and the (first, slow) dictionary load wait,
    // and the result is written only into the form it was made for (checked before the commit below).
    const startGen = conv.gen;
    const startSong = convSong.current;
    // The reply was made from the state when it was requested: edits made since (while it was pending, or after
    // it arrived; another reply applied meanwhile) would be replaced without showing in its diff.
    const editedSince = editedSinceSent(t, r, { abc, style, lyrics });
    if (editedSince.length > 0) {
      const go = await ask({
        title: "依頼した後に編集された内容があります",
        message: `この提案を依頼した後に${editedSince.join("と")}が編集されています。適用すると、その編集は失われます（「差分を表示」は依頼したときの内容との比較です）。`,
        choices: [{ value: "replace", label: "置き換える", kind: "primary" }],
      });
      if (!go) return;
    }
    const notes: string[] = [];
    let nextAbc = abc;
    let nextStyle = style;
    // the findings the apply dialog listed (null = no dialog), and whether it was the unparsable one
    let accepted: { shown: string[]; unparsable: boolean } | null = null;
    if (r.abc.trim()) {
      let problems = t.problems ?? [];
      let unparsable = t.unparsable ?? false;
      if (problems.length === 0) {
        try {
          parseAbc(r.abc);
        } catch (e) {
          problems = [e instanceof Error ? e.message : String(e)];
          unparsable = true;
        }
      }
      if (problems.length > 0) {
        const go = await ask({
          title: "返された譜面に問題があります",
          message: unparsable
            ? "この譜面はアプリの譜面パーサーで解釈できません。適用するとピアノロールでは編集できず（ABC テキストは編集できます）、「この譜面で再生成」では元の ABC がそのまま送られます。"
            : "この譜面は公式の記法チェック（abc_tools の検査、参考）に通っていません。生成が崩れる可能性があります。",
          details: problems,
          choices: [{ value: "apply", label: unparsable ? "このまま適用" : "非ネイティブ記法のまま適用", kind: "primary" }],
        });
        if (!go) return;
        accepted = { shown: problems, unparsable };
      }
      nextAbc = r.abc;
    }
    if (r.style.trim()) nextStyle = r.style;
    // Tempo: the score is the plan the audio follows, so the style follows its Q: (only a Q: the score really
    // has). When the reply's style names another tempo - only the style changed, or the model changed the
    // style's tempo but not Q: - ask which one is meant instead of silently undoing either.
    const bpm = nextAbc.trim() ? statedAbcTempo(nextAbc) : null;
    if (bpm) {
      const sb = r.style.trim() ? styleBpm(r.style) : null;
      // not for a Q: whose tempo the style cannot take (Q:1/4=0.4 rounds to 0 BPM): the sync would do nothing
      if (sb !== null && styleBpmDiffers(r.style, bpm)) {
        // The focused (primary) choice keeps whatever the edit changed: when only Q: moved (the reply's style
        // still names the sent tempo), following the score comes first so Enter does not undo the new tempo.
        const first = tempoDialogDefault({ sentAbc: t.sentAbc, sentStyle: t.sentStyle, replyHasAbc: r.abc.trim() !== "", bpm, styleBpm: sb });
        const abcChoice = { value: "abc", label: `譜面の Q: を ${sb} BPM に変更` };
        const styleChoice = { value: "style", label: `スタイルを譜面の ${Math.round(bpm)} BPM に合わせる` };
        const c = await ask({
          title: "テンポが譜面と異なります",
          message: `${r.abc.trim() ? "返されたスタイル" : "新しいスタイル"}は ${sb} BPM ですが、譜面の Q: は ${Math.round(bpm)} BPM です（公式: テンポは譜面とスタイルで揃える）。どちらに揃えますか？`,
          choices: first === "style" ? [{ ...styleChoice, kind: "primary" as const }, abcChoice] : [{ ...abcChoice, kind: "primary" as const }, styleChoice],
        });
        if (!c) return;
        if (c === "abc") {
          nextAbc = replaceAbcTempo(nextAbc, sb);
          notes.push(`譜面の Q: を ${sb} BPM に変更しました`);
        } else {
          const sync = styleTempoSync(nextStyle, bpm);
          if (sync) {
            nextStyle = sync.style;
            notes.push(sync.note);
          }
        }
      } else {
        const sync = r.abc.trim() ? styleTempoSync(nextStyle, bpm) : null;
        if (sync) {
          nextStyle = sync.style;
          notes.push(sync.note);
        }
      }
    }
    // with LF line breaks, as typed text has (a model may send \r\n escapes): the form, the hiragana rebuild and
    // the song's stored lyrics then all see the same text
    const nextLyrics = r.lyrics.trim() ? normalizeNewlines(r.lyrics) : lyrics;
    const lyricsChanged = r.lyrics.trim() !== "" && !sameLyricsText(r.lyrics, lyrics);
    // ABC text typed in the editor and not applied is replaced by a new score (the reply's, or the tempo dialog's
    // Q: change). Asked before the hiragana rebuild, never after it: a question opened during that (slow) wait,
    // 送信's or a song load's, would be replaced by it (one at a time) and cancelled without a word. Text typed
    // during the rebuild refuses the apply below instead (`textDirtyOk`: none, or the text the user agreed to drop).
    if (nextAbc !== abc && !(await unappliedTextOk("apply", r.abc.trim() !== ""))) return;
    const textDirtyOk = scoreTextDirty.current;
    let failed = false;
    // The hiragana version is what is sung: rebuild it from the edited lyrics, or the edit would not be sung.
    // Converted before anything is committed, so a 再生成 during the (first, slow) dictionary load never
    // sees the new lyrics with the old hiragana version. A pane emptied by hand is no version (the kanji lyrics
    // are sung, as the editor says next to it): it stays empty, and the edited kanji lyrics are sung. It keeps the
    // source of the readings it last held (as when the kanji lyrics are edited by hand next to it): readings
    // brought back with Ctrl+Z in the pane are then shown as made for the old lyrics, and 「再度ひらがな化」 pairs
    // them by the old lines.
    const rebuildSung = lyricsChanged && lyricsLanguage === "ja" && hasSungVersion(sungLyrics);
    let rebuilt: HiraganaResult | null = null;
    let rebuildError: unknown = null;
    if (rebuildSung) {
      setConverting(true);
      try {
        rebuilt = await toHiragana(nextLyrics);
      } catch (e) {
        rebuildError = e;
      } finally {
        setConverting(false);
      }
    }
    // Everything below writes values taken at the click: another song or conversation, or a form edited while
    // the hiragana version was rebuilt (the editors stay usable), would be overwritten with them.
    const during = rebuildSung ? "ひらがな版の作り直し中に" : "適用の確認中に";
    if (conv.gen !== startGen || convSong.current !== startSong) return showToast("info", `${during}別の曲が読み込まれたため、提案は適用しませんでした`);
    const f = formNow.current;
    if (f.abc !== abc || f.style !== style || f.lyrics !== lyrics || f.sungLyrics !== sungLyrics || f.sungSource !== sungSource)
      return showToast("info", `${during}譜面・スタイル・歌詞が変わったため、提案は適用しませんでした。もう一度「適用」を押してください`);
    if (nextAbc !== abc && scoreTextDirty.current && !textDirtyOk)
      return showToast("info", `${during} ABC テキストが編集されたため、提案は適用しませんでした。もう一度「適用」を押してください`);
    // The findings the user just accepted hold for this exact score at the first render - only those the dialog
    // listed (an unparsable reply's native-check findings were never shown, so the render dialog shows them).
    if (accepted) acceptedAdvice.accept(nextAbc, null, findingsAcceptedAtApply(nextAbc, accepted.shown, accepted.unparsable));
    setAbc(nextAbc);
    setStyle(nextStyle);
    setLyrics(nextLyrics);
    setTurns((ts) => ts.map((x, i) => (i === idx ? { ...x, applied: true, appliedAbc: nextAbc } : x)));
    if (rebuilt) {
      // Lines the edit left alone keep their (possibly hand-fixed) readings, as with 「ひらがな化」 in the editor.
      const next = reconvertKeepingFixes(nextLyrics, sungSource, sungLyrics, rebuilt.text);
      setSungLyrics(next.text);
      setSungSource(nextLyrics);
      notes.push(
        !next.merged
          ? "歌詞が変わったためひらがな版を作り直しました（右の欄で手直しした読みはやり直してください）"
          : next.kept > 0
            ? `歌詞が変わったためひらがな版を作り直しました（変更のない ${next.kept} 行は手直しした読みを残しました）`
            : "歌詞が変わったため、変更された行のひらがな版を作り直しました",
      );
    } else if (rebuildError !== null) {
      setSungLyrics(null);
      setSungSource(null);
      failed = true;
      notes.push(`ひらがな版を作り直せなかったため破棄しました（漢字の歌詞で生成されます）: ${rebuildError instanceof Error ? rebuildError.message : String(rebuildError)}`);
    }
    showToast(failed ? "error" : "success", [`編集内容を適用しました。「${nextAbc.trim() ? "この譜面で再生成" : "再生成"}」で音声を生成できます`, ...notes].join("。"));
  };

  /**
   * The lyrics to send (`text`) and the hiragana version the form holds afterwards (`sung`, rebuilt when it was out
   * of date); asks when the hiragana version may be out of date. Null = cancelled.
   */
  const confirmSung = async (): Promise<{ text: string; sung: string | null } | null> => {
    const d = await confirmSungLyrics({ lyrics, sungLyrics, sungSource, language: lyricsLanguage }, ask);
    if (!d) return null;
    if (d.update) {
      setSungLyrics(d.update.sungLyrics);
      setSungSource(d.update.sungSource);
    }
    return { text: d.text, sung: d.update ? d.update.sungLyrics : sungLyrics };
  };

  /** Queue the render; true when a job was queued. */
  const renderNow = async (): Promise<boolean> => {
    if (!style.trim()) {
      showToast("error", "スタイルが空です");
      return false;
    }
    if (!(await unappliedTextOk("render"))) return false;
    // the conversation song whose settings the render keeps (not the library selection)
    const base = formSong;
    const confirmed = await confirmSung();
    if (confirmed === null) return false;
    const sung = confirmed.text;
    // The score is sent exactly as stored or edited (the planner's text ends in "|\n"; YuE2 tokenizes it
    // verbatim, official cli.py reads it byte for byte): trim() only decides whether there is a score.
    const a = abc.trim() ? abc : "";
    const notes: string[] = [];
    let hasChords = false;
    if (a) {
      const findings = scoreFindings(a);
      hasChords = scoreHasChords(a, findings);
      const advice = await confirmScoreAdvice({ abc: a, sung, findings, accepted: acceptedAdvice, ask, mismatchMessage: EDIT_MISMATCH_MESSAGE });
      if (!advice.ok) return false;
      notes.push(...advice.notes);
    }
    let st = style.trim();
    const summary = a ? summarizeAbc(a) : null;
    // only a Q: the score really has (without one the parsers assume 120)
    const sync = a ? styleTempoSync(st, statedAbcTempo(a)) : null;
    if (sync) {
      st = sync.style;
      notes.push(sync.note);
    }
    // Same sampling settings as the song being edited (official: only the intended fields change).
    const p = storedParams(base?.paramsJson);
    const sampling = samplingFrom(p, DEFAULT_SAMPLING);
    // Without a score the song keeps its own mode (an off song is not re-planned as full).
    const { mode, cfgScale } = rerenderModeAndCfg({ hasAbc: a !== "", hasChords, storedMode: p.mode ?? base?.mode, cfgScale: sampling.cfgScale });
    if (cfgScale !== sampling.cfgScale) notes.push(`off 用の cfg ${sampling.cfgScale} は譜面付きの生成では使わず、公式既定の ${cfgScale} にしました`);
    // estimate_duration failed: a minute (rerenderMaxDuration never goes below the default budget anyway)
    const est = await api.estimateDuration(sung).catch(() => 60);
    const maxDuration = rerenderMaxDuration({ stored: storedMaxDuration(p), lyricEstimate: est, scoreSec: summary?.seconds ?? null, limit, defaultMax });
    // the configured maximum caps the budget below the score: asked as on 作曲 (the song would be cut off)
    const cut = scoreCutWarning(summary && summary.seconds > 0 ? summary.seconds : null, maxDuration);
    if (cut && !(await ask({ title: "曲長の上限が譜面の長さより短くなっています", message: cut, choices: [{ value: "asis", label: `${mmss(maxDuration)} のまま生成` }] }))) return false;
    // The tempo sync goes into the field as it is now (it stays editable while the questions and the hiragana
    // conversion wait): only the tempo is set, as on 作曲.
    if (sync) setStyle((cur) => (cur === style ? st : withStyleBpm(cur, sync.bpm)));
    try {
      const song = await api.generate({
        title: rerenderTitle(base, lyrics),
        style: st,
        lyrics: sung,
        lyricsDisplay: normalizeNewlines(lyrics),
        mode,
        abc: a,
        seed: base ? clampSeed(base.seed) : randomSeed(),
        maxDuration,
        temperature: sampling.temperature,
        topP: sampling.topP,
        topK: sampling.topK,
        repetitionPenalty: sampling.repetitionPenalty,
        cfgScale,
        steps: sampling.steps,
        abcTemperature: sampling.abcTemperature,
      });
      // The new song is what was just sent: the form and the conversation continue with it (the selection effect
      // then has nothing to load). The form as it now stands counts as loaded: the score as typed (whitespace
      // only is sent as none), the style after the tempo sync, the hiragana version confirmSung left.
      setConv(song.id);
      lastConvSong.current = song;
      loadedForm.current = { abc, style: sync ? st : style, lyrics, sung: confirmed.sung };
      setTurns((ts) => ts.map((t) => (t.role === "assistant" ? { ...t, songId: song.id } : t)));
      selectSong(song.id);
      showToast("info", ["再生成を開始しました", ...notes].join("。"));
      return true;
    } catch (e) {
      showToast("error", String(e));
      return false;
    }
  };

  const render = async () => {
    if (!guard.begin("render")) return;
    setSending(true);
    try {
      if (await renderNow()) guard.accepted("render");
    } finally {
      guard.end();
      setSending(false);
    }
  };

  // A server answering on the local port that this app did not start (another llama-server): shown as such,
  // and it cannot be stopped from here (no start / stop button).
  const externalLlm = Boolean(status && status.provider === "local" && status.external);
  // Our server counts as running while its process runs, also before /health answers (loading, or the settings
  // before a change): it holds VRAM and can be stopped (rules.ts localLlmView).
  const llmView = status ? localLlmView(status) : null;
  const localLabel = status
    ? externalLlm
      ? `外部の llama-server（ポート ${status.port}・このアプリでは停止できません）`
      : `ローカル llama.cpp（${status.model ?? config?.llm.localModel ?? ""}）${llmView?.toggle === "start" ? " 停止（送信時に自動起動）" : ` ${llmView?.label ?? ""}`}`
    : "";
  const providerLabel = status ? (status.provider === "local" ? localLabel : status.provider === "anthropic" ? `Anthropic API（${config?.llm.anthropicModel}）${status.hasAnthropicKey ? "" : " · キー未設定"}` : `OpenAI 互換 API（${config?.llm.openaiModel}）${status.hasOpenaiKey ? "" : " · キー未設定"}`) : "";

  const toggleLlm = async () => {
    const op = llmView?.toggle;
    if (!op || llmBusy) return;
    setLlmBusy(op);
    try {
      await (op === "stop" ? api.llmStop() : api.llmStart());
    } catch (e) {
      // e.g. the stop refused while another page's AI request is still answered by the server (作曲's draft)
      showToast("error", `${op === "stop" ? "LLM を停止できませんでした" : "LLM を起動できませんでした"}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await api.llmStatus().then(setStatus).catch(() => {});
      setLlmBusy(null);
    }
  };

  // The render's mode as renderNow picks it: the score's (chords -> Full), else the song's own (storedMode).
  const renderLabel = useMemo(() => {
    const a = abc.trim() ? abc : "";
    return rerenderLabel(a !== "", rerenderModeAndCfg({ hasAbc: a !== "", hasChords: a !== "" && scoreHasChords(a), storedMode, cfgScale: 1 }).mode);
  }, [abc, storedMode]);

  return (
    <div>
      {dialog}
      <PageHeader page="edit">
        <div className="muted small">{providerLabel}</div>
      </PageHeader>
      <p className="page-desc">自然文の指示で ABC 譜面・スタイル・歌詞を書き換えます。提案は差分を確認してから適用し、「この譜面で再生成」（譜面がないときは「再生成」）で音声を生成します。編集対象はライブラリで選択中の曲です（作業中に別の曲が選ばれたときは、読み込む前に確認します）。</p>
      {selected && selected.id !== convSongId && (
        <div className="hint row between" style={{ marginBottom: 12 }}>
          <span>{unloadedSelectionHint(selected.title, formSong?.title ?? "")}</span>
          {/* loading another song ends the conversation: not under a pending reply, nor while 再生成 sends this form (pages/locks.ts) */}
          <button className="btn sm" onClick={() => followSelection(selected, null)} disabled={busy || sending} title={busy ? LOCK_HINT.llmWaiting : sending ? LOCK_HINT.sending : undefined}>
            {SELECTION_LOAD_LABEL}
          </button>
        </div>
      )}
      <div className="grid-compose">
        <div className="stack">
          <div className="panel stack" style={{ minHeight: 420 }}>
            <h3>対話</h3>
            <div ref={listRef} className="stack" style={{ maxHeight: 420, overflow: "auto", gap: 8 }}>
              {turns.length === 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="muted small">例:</div>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="chip" onClick={() => send(s)} disabled={busy} style={{ alignSelf: "flex-start" }}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {turns.map((t, i) => (
                <div key={i} className="panel" style={{ padding: 10, background: t.role === "user" ? "var(--accent-soft)" : "var(--bg)" }}>
                  <div className="muted small">{t.role === "user" ? "あなた" : "アシスタント"}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{t.text}</div>
                  {t.reply && (
                    <div className="row" style={{ marginTop: 8 }}>
                      {(t.reply.abc || t.reply.style || t.reply.lyrics) && (
                        <>
                          <button className="btn sm" onClick={() => setShowDiff(showDiff === i ? null : i)}>
                            {showDiff === i ? "差分を隠す" : "差分を表示"}
                          </button>
                          {/* not while 再生成 sends the form (its tempo sync and hiragana update would land on the applied one) */}
                          <button className="btn primary sm" disabled={t.applied || converting || sending} title={sending && !t.applied ? LOCK_HINT.sending : undefined} onClick={() => apply(i)}>
                            {t.applied ? "適用済み" : "適用"}
                          </button>
                        </>
                      )}
                      {t.melodyChanges && !t.reasked && (() => {
                        // only the latest reply: the history's latest instruction and reply are the ones the re-ask revises
                        const latest = i === latestReplyIndex(turns);
                        const base = melodyReaskBase({ sentAbc: t.sentAbc, applied: t.applied, replyAbc: t.reply?.abc, appliedAbc: t.appliedAbc }, abc);
                        return (
                          <button
                            className="btn sm"
                            disabled={busy || !latest || base === null}
                            onClick={() => reaskMelody(i)}
                            title={
                              !latest
                                ? "後のやり取りがあるため再依頼できません（元のメロディに戻す指示は、新しく送ってください）"
                                : base === null
                                  ? "このやり取りの後に譜面が変わったため再依頼できません（変更を残したまま元のメロディに戻す指示は、新しく送ってください）"
                                  : "ボーカルの音符を元に戻すよう、1 回だけ再依頼します"
                            }
                          >
                            メロディを保つよう再依頼
                          </button>
                        );
                      })()}
                      <span className="muted small">
                        {t.reply.provider} · {t.reply.seconds.toFixed(1)} 秒 · {t.reply.promptTokens}+{t.reply.completionTokens} トークン
                      </span>
                    </div>
                  )}
                  {t.reply && showDiff === i && (
                    <DiffView reply={t.reply} abc={t.sentAbc ?? abc} style={t.sentStyle ?? style} lyrics={t.sentLyrics ?? lyrics} editedSince={t.applied ? [] : editedSinceSent(t, t.reply, { abc, style, lyrics })} />
                  )}
                </div>
              ))}
              {busy && (
                <div className="row">
                  <span className="muted">考え中…</span>
                  <button className="btn sm" onClick={cancelSend} title="AI への依頼を取り消します（クラウドの API では、送信済みの依頼が課金されることがあります）">
                    キャンセル
                  </button>
                </div>
              )}
            </div>
            <div className="row">
              <textarea
                className="grow"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    // one request at a time: the draft stays in the box while a reply is pending
                    if (!busy) send(input, { fromInput: true });
                  }
                }}
                placeholder="例: サビをもっとエモーショナルにして（Ctrl+Enter で送信）"
                style={{ minHeight: 60 }}
              />
              <button className="btn primary" onClick={() => send(input, { fromInput: true })} disabled={busy || !input.trim()}>
                送信
              </button>
            </div>
            <div className="row">
              <button
                className="btn sm"
                onClick={resetConversation}
                disabled={busy || converting}
                title={busy ? "応答を待っている間はリセットできません" : converting ? "提案の適用（ひらがな版の作り直し）が終わるまでお待ちください" : "これまでの対話を消し、次の指示から新しい会話として送ります"}
              >
                会話をリセット
              </button>
              {status?.provider === "local" && !externalLlm && (
                // stopping the server would cut the pending request off (pages/locks.ts)
                <button className="btn sm" onClick={toggleLlm} disabled={llmBusy !== null || busy} title={busy ? LOCK_HINT.llmWaiting : undefined}>
                  {llmBusy === "start" ? "LLM を起動中…（最大 3 分）" : llmBusy === "stop" ? "LLM を停止中…" : llmView?.toggle === "stop" ? "LLM を停止（VRAM 解放）" : "LLM を起動"}
                </button>
              )}
            </div>
            {status?.provider === "local" && status.restartRequired && !externalLlm && (
              <div className="hint">LLM の設定が変更されています。次の AI リクエストで新しい設定で再起動します。</div>
            )}
          </div>
          <div className="panel stack">
            <h3>現在のスタイルと歌詞</h3>
            <label className="field"><span className="lbl">スタイル</span><textarea value={style} onChange={(e) => setStyle(e.target.value)} style={{ minHeight: 56 }} /></label>
            <LyricsEditor
              value={lyrics}
              onChange={setLyrics}
              sung={sungLyrics}
              onSungChange={setSungLyrics}
              sungSource={sungSource}
              onSungSourceChange={setSungSource}
              language={lyricsLanguage}
              onLanguageChange={setLyricsLanguage}
              showTags={false}
              minHeight={140}
              busy={sending}
              busyHint={LOCK_HINT.sending}
              onBusyChange={setLyricsConverting}
              footer={abc.trim() ? <SectionFitTable abc={abc} lyrics={lyrics} sung={sungLyrics} language={lyricsLanguage} /> : undefined}
            />
          </div>
        </div>
        <div className="stack">
          <div className="panel stack">
            <div className="row between">
              <h3>現在の譜面</h3>
              {/* the reply may change the score, style and lyrics: rendered once it is in, and once the lyrics editor's hiragana conversion ends (pages/locks.ts) */}
              <button
                className="btn primary"
                onClick={singleClick(() => void render())}
                disabled={generating || converting || busy || lyricsConverting}
                title={busy ? LOCK_HINT.llmWaiting : lyricsConverting ? LOCK_HINT.converting : undefined}
              >
                {renderLabel}
              </button>
            </div>
            <ScoreEditor abc={abc} onAbcChange={setAbc} onDirtyChange={onScoreDirty} lyrics={effectiveLyrics(lyrics, sungLyrics, lyricsLanguage)} />
          </div>
          <ProgressPanel />
          {convLive?.status === "done" && (
            <div className="panel">
              <h3>編集中の曲</h3>
              <Player audioPath={convLive.audioPath} title={convLive.title} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The reply against the state it was requested with; `editedSince`: fields edited since then, which applying replaces. */
function DiffView({ reply, abc, style, lyrics, editedSince }: { reply: EditReply; abc: string; style: string; lyrics: string; editedSince: string[] }) {
  const blocks: { title: string; before: string; after: string }[] = [];
  if (reply.abc.trim()) blocks.push({ title: "ABC 譜面", before: abc, after: reply.abc });
  if (reply.style.trim()) blocks.push({ title: "スタイル", before: style, after: reply.style });
  if (reply.lyrics.trim()) blocks.push({ title: "歌詞", before: lyrics, after: reply.lyrics });
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      {editedSince.length > 0 && <div className="hint">依頼した後に{editedSince.join("と")}が編集されています。差分は依頼したときの内容との比較で、適用するとその編集は失われます。</div>}
      {blocks.map((b) => {
        const d = diffLines(b.before, b.after);
        const st = diffStats(d);
        return (
          <div key={b.title}>
            <div className="muted small">
              {b.title}: +{st.added} / -{st.removed} 行
            </div>
            <div className="log" style={{ maxHeight: 220 }}>
              {diffWithContext(d).map((x, i) =>
                x.kind === "gap" ? (
                  <div key={i} style={{ color: "var(--text-3)" }}>
                    … （{x.skipped} 行省略）
                  </div>
                ) : (
                  <div key={i} style={{ color: x.kind === "add" ? "var(--success)" : x.kind === "del" ? "var(--danger)" : "var(--text-3)" }}>
                    {x.kind === "add" ? "+ " : x.kind === "del" ? "- " : "  "}
                    {x.text}
                  </div>
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
