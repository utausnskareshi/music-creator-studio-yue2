// Score editor: piano roll + ABC text + staff preview, with playback, MIDI/ABC I/O and re-render hook.
// Key/meter changes after the header are kept in the score and written back by the serializer in the official
// group form (M: / K: lines under both voices, inline [K:] inside a bar); an unedited score is passed on verbatim.
import { useCallback, useEffect, useRef, useState } from "react";
import abcjs from "abcjs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { OFFICIAL_KEYS, PPQ, VOICE_LABEL, barAtTick, cloneScore, hasTimelineChanges, normalizeKey, recomputeBars, type Score, type VoiceName } from "../abc/model";
import { parseAbcDetailed, type AbcParseResult } from "../abc/parse";
import { serializeAbc } from "../abc/serialize";
import { editedBars, liveSelection, moveNotes, transposeNotes, transposeScore } from "../abc/edit";
import { validateNativeAbc } from "../abc/native";
import { compareSections } from "../abc/consistency";
import { playScore, type PlaybackHandle } from "../abc/synth";
import { midiToScore, scoreToMidi } from "../abc/midi";
import { createEchoGuard } from "./echoGuard";
import { currentScoreAbc } from "./scoreText";
import { TEMPO_MAX, TEMPO_MIN, createGestureUndo, hasUnsavedScoreEdits, irregularBarsNotice, pickAndRead, pushUndoEntry, rollChangeAction, tempoFromInput, undoSelection, undoText, type UndoEntry } from "./scoreEditorState";
import { useChoiceDialog } from "./ChoiceDialog";
import { useOnPageHide, usePageActive } from "./PageActive";
import PianoRoll, { type PianoRollChange } from "./PianoRoll";

export interface ScoreEditorProps {
  /** Incoming ABC (e.g. from the last generation). Changing it replaces the editor content. */
  abc: string;
  /**
   * What `abc` belongs to on the page (作曲: the selected song). Two songs may have the same score text, which
   * loads nothing: an action that waited for a dialog or a file (an import) is still dropped when this changed.
   */
  loadKey?: string;
  /** Called with the serialized ABC whenever the user edits. */
  onAbcChange?: (abc: string) => void;
  /** "この譜面で再生成": the score as taken in until it is edited, then the serialized score. */
  onRender?: (abc: string, hasChords: boolean) => void;
  /** "インストゥルメンタル版を生成": receives the current score (vocal notes still in place). */
  onRenderInstrumental?: (abc: string) => void;
  /** Lyrics sent with this score, for the section consistency notice after applying ABC text. */
  lyrics?: string;
  /** the render buttons are unavailable (a generation runs, or the page's work conflicts: pages/locks.ts) */
  busy?: boolean;
  /** tooltip of the disabled render buttons (why they are unavailable) */
  busyHint?: string;
  /**
   * Whether the editor holds edits a new `abc` would replace: an edited score or ABC text not applied yet.
   * `textDirty`: ABC text typed in the text tab and not applied (lost when a new `abc` loads; applied score edits
   * are reported through onAbcChange and can be kept by the page).
   */
  onDirtyChange?: (dirty: boolean, textDirty: boolean) => void;
}

type Tab = "roll" | "text" | "staff";

const RANGE_ERROR = "音域 (MIDI 0〜127) を超えるため移調できません";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What an action that waits acts on: the editor is mounted, its count of loads from `abc`, and its loadKey. */
export interface LoadState {
  mounted: boolean;
  load: number;
  key: string | undefined;
}

/**
 * For an action that awaits a dialog or a file: a check that is true while the editor still shows the score the
 * action started on (`now` reads the editor's state): still mounted, no score loaded since, and the same loadKey.
 */
export function loadCheck(now: () => LoadState): () => boolean {
  const at = { ...now() };
  return () => {
    const s = now();
    return s.mounted && s.load === at.load && s.key === at.key;
  };
}

export default function ScoreEditor({ abc, loadKey, onAbcChange, onRender, onRenderInstrumental, lyrics, busy, busyHint, onDirtyChange }: ScoreEditorProps) {
  const [score, setScore] = useState<Score | null>(null);
  const [text, setText] = useState(abc);
  /**
   * ABC text the current score was taken in from; render/export send it unchanged while the score is not dirty
   * (see currentScoreAbc in scoreText.ts), and the serialized score once it is edited.
   */
  const [source, setSource] = useState(abc);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("roll");
  const [voice, setVoice] = useState<VoiceName>("Vocal");
  const [snapUnit, setSnapUnit] = useState(16);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** footer line, shown on every tab; `error` in the danger colour */
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  /** the tempo field while it is being typed in (null: it shows the score's tempo) */
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const playRef = useRef<PlaybackHandle | null>(null);
  const undoRef = useRef<UndoEntry[]>([]);
  /** one undo entry per piano-roll drag */
  const gestureRef = useRef(createGestureUndo());
  /**
   * Bar count of the score as it was taken in (loaded, applied as text, imported; set by trimming). Edits keep
   * at least these bars, so the source's trailing silent bars survive deletions, but bars a drag only passed
   * through are not kept (keeping the running count of every drag step would only ever grow it).
   */
  const baseBarsRef = useRef(0);
  /** the serialized text of a score object (set by commit, or by serializedOf on demand), so it is serialized once */
  const serialRef = useRef<{ score: Score; text: string } | null>(null);
  /** counts the scores loaded from the `abc` prop: an action that waited for a dialog is dropped when it changed */
  const loadRef = useRef(0);
  /** false once unmounted (CoverPage remounts the editor for a new transcription): a pending import is dropped */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** the page's loadKey as it is now */
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;
  /** For an action that awaits a dialog or a file: true while the editor still shows the score it started on. */
  const sameLoad = () => loadCheck(() => ({ mounted: mountedRef.current, load: loadRef.current, key: loadKeyRef.current }));
  /** counts loads, as state: the piano roll gets it as resetKey in the same render as the new score */
  const [loadSeq, setLoadSeq] = useState(0);
  const staffRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef(0);
  /** the editor's own output, so a page that feeds it back as `abc` (EditPage) does not reset the editor */
  const echoRef = useRef(createEchoGuard());
  const { ask, dialog } = useChoiceDialog();

  const say = (msg: string, isError = false) => setMessage({ text: msg, error: isError });

  // Load incoming ABC. The editor's own output coming back as the prop is skipped: resetting here would wipe
  // the notices that applyText sets in the same update, and re-parse a score that is already current.
  useEffect(() => {
    if (echoRef.current.isEcho(abc)) return;
    loadRef.current++;
    setLoadSeq((n) => n + 1); // the piano roll drops a drag of the previous score (same render as the new score)
    // A different score: nothing of the previous one carries over. Note ids restart at 1 on every parse, so an
    // old selection or undo entry would act on unrelated notes of this one; its preview stops.
    undoRef.current = [];
    gestureRef.current.start();
    setSelected(new Set());
    playRef.current?.stop(); // its onEnd resets `playing` and playRef
    seekRef.current = 0;
    setCursor(null);
    setMessage(null);
    setBpmDraft(null);
    setText(abc);
    setSource(abc);
    setDirty(false);
    setNotices([]);
    if (!abc.trim()) {
      setScore(null);
      setError(null);
      return;
    }
    try {
      const { score: s, irregularBars } = parseAbcDetailed(abc);
      baseBarsRef.current = s.bars;
      setScore(s);
      setError(null);
      // passed on verbatim until edited; the piano roll already shows the meter's bar lines
      const note = irregularBarsNotice(irregularBars, false);
      if (note) setNotices([note]);
    } catch (e) {
      // Keep the raw text in the text tab (editable); nothing is re-serialized from a failed parse.
      setScore(null);
      setError(errText(e));
    }
  }, [abc]);

  /**
   * The serialized current score ("" when it cannot be written as ABC). Computed only where it is used (staff
   * tab, render, export), not on every render: a drag step sets a new score object on every mouse move.
   */
  const serializedOf = (s: Score | null): string => {
    if (!s) return "";
    if (serialRef.current?.score === s) return serialRef.current.text;
    let out = "";
    try {
      out = serializeAbc(s);
    } catch {
      // "" as for any score that cannot be written; the caller reports it
    }
    serialRef.current = { score: s, text: out };
    return out;
  };
  /** The ABC the current score stands for: the text as taken in until the score is edited (see currentScoreAbc). */
  const currentAbc = () => currentScoreAbc({ dirty, hasScore: Boolean(score), source, serialized: () => serializedOf(score), text });
  /** ABC text typed in the text tab and not applied to the score yet */
  const textDirty = text !== source;
  const unsaved = hasUnsavedScoreEdits(dirty, text, source);
  useEffect(() => {
    onDirtyChange?.(unsaved, textDirty);
  }, [unsaved, textDirty, onDirtyChange]);

  const pushUndo = useCallback(
    (rebased = false) => {
      if (!score) return;
      pushUndoEntry(undoRef.current, { score: cloneScore(score), base: baseBarsRef.current, dirty, source, rebased });
    },
    [score, dirty, source],
  );

  /** Pass edited ABC to the parent. Notices describe the text they were made for, so an edit clears them. */
  const emit = useCallback(
    (s: string) => {
      setNotices([]);
      echoRef.current.emit(s);
      onAbcChange?.(s);
    },
    [onAbcChange],
  );

  /**
   * Apply an edit. Keeps the taken-in bar count (baseBarsRef: trailing silent bars stay) unless `keepBars` is
   * false. `rebase`: `next` comes from outside (text, file import) and its own bar count becomes the base; its
   * note ids are new, so the selection is cleared. false when the score cannot be written as ABC (nothing changes).
   */
  const commit = useCallback(
    (next: Score, withUndo = true, keepBars = true, rebase = false): boolean => {
      const base = rebase ? next.bars || 0 : baseBarsRef.current;
      next.bars = keepBars ? editedBars(base, next) : recomputeBars(next);
      let s: string;
      try {
        s = serializeAbc(next);
      } catch (e) {
        setError(errText(e));
        setMessage({ text: `譜面を ABC に書き出せません: ${errText(e)}`, error: true });
        return false;
      }
      if (withUndo) pushUndo(rebase);
      gestureRef.current.start(); // this commit ends any gesture (a drag's own commit has already called finish)
      baseBarsRef.current = keepBars ? base : next.bars;
      serialRef.current = { score: next, text: s };
      setScore(next);
      setDirty(true);
      setText(s);
      setSource(s);
      setError(null);
      setMessage(null); // a caller's own message set after this call wins
      if (rebase) setSelected(new Set());
      emit(s);
      return true;
    },
    [pushUndo, emit],
  );

  /** A step in the middle of a piano-roll drag: shown at once; the drag's last commit serializes and emits. */
  const preview = (next: Score) => {
    next.bars = editedBars(baseBarsRef.current, next);
    setScore(next);
    setDirty(true);
  };

  const onRollChange = (next: Score, opts?: PianoRollChange) => {
    const a = rollChangeAction(gestureRef.current, opts);
    if (a.kind === "preview") {
      if (a.pushUndo) pushUndo(); // the state before the drag, once per drag
      preview(next);
    } else if (a.kind === "revert") {
      // The drag ended where it began: back to the score from before it, which its first step pushed (the
      // parent never saw the steps, so nothing is emitted, and an unedited score is passed on verbatim again).
      const prev = a.pop ? undoRef.current.pop() : undefined;
      if (prev) {
        baseBarsRef.current = prev.base;
        setScore(prev.score);
        setDirty(prev.dirty);
      } else {
        commit(next); // nothing to go back to: keep the drag-start notes as an edit of their own
      }
    } else {
      commit(next, a.withUndo);
    }
  };

  /**
   * Unapplied ABC text: ask before an action that would ignore it (render, export, preview) or overwrite it (any
   * edit, import, undo). true when the action may go on (the text is then discarded). Applying the text stops the
   * action: it was meant for the score as it was before, so the user runs it again on the applied score. A score
   * loaded while the dialog was open also stops it (the action would act on the previous score), as does another
   * loadKey (the page's callbacks the action holds are those of the previous song).
   */
  const pendingTextOk = async (): Promise<boolean> => {
    if (!textDirty) return true;
    const isCurrent = sameLoad();
    const c = await ask({
      title: "未反映の ABC テキスト",
      message: "ABC テキストの変更がまだ譜面に反映されていません。",
      choices: [
        { value: "apply", label: "テキストを譜面に反映する", kind: "primary" },
        { value: "discard", label: "変更を破棄して続ける", kind: "danger" },
      ],
    });
    if (c === null || !isCurrent()) return false;
    if (c === "apply") {
      if (applyText()) say("ABC テキストを反映しました。続けるには、もう一度操作してください");
      else say("ABC テキストに誤りがあるため反映できません（ABC テキストのタブで確認してください）", true);
      return false;
    }
    setText(source);
    return true;
  };

  const undo = async () => {
    if (undoRef.current.length === 0 || !(await pendingTextOk())) return;
    const prev = undoRef.current.pop();
    if (!prev) return;
    gestureRef.current.start(); // a drag still in progress pushes its start state again on its next step
    let out: string;
    try {
      out = undoText(prev, serializeAbc);
    } catch (e) {
      undoRef.current.push(prev);
      setError(errText(e));
      say(`譜面を ABC に書き出せません: ${errText(e)}`, true);
      return;
    }
    baseBarsRef.current = prev.base;
    serialRef.current = prev.dirty ? { score: prev.score, text: out } : null;
    setScore(prev.score);
    setText(out);
    setSource(out);
    // Back to the score as taken in: not edited, and its text is passed on verbatim again.
    setDirty(prev.dirty);
    setError(null);
    setMessage(null);
    setSelected((sel) => undoSelection(prev, sel));
    emit(out);
  };

  // playback
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      if (playRef.current) setCursor(playRef.current.position());
    }, 40);
    return () => clearInterval(t);
  }, [playing]);

  const startAt = (from: number) => {
    if (!score) return;
    playRef.current = playScore(score, from, () => {
      setPlaying(false);
      playRef.current = null;
    });
    setPlaying(true);
  };

  const togglePlay = async () => {
    if (playing) {
      playRef.current?.stop();
      playRef.current = null;
      setPlaying(false);
      return;
    }
    if (!score || !(await pendingTextOk())) return;
    setMessage(null); // the footer shows the playback position
    startAt(seekRef.current);
  };

  /** Move the playback position; a running preview continues from there. */
  const seekTo = (t: number) => {
    seekRef.current = t;
    setCursor(t);
    setMessage(null);
    if (playing && score) {
      // stop() calls the old onEnd right away (playRef = null, playing = false): stop first, then start anew
      playRef.current?.stop();
      startAt(t);
    }
  };
  useEffect(() => () => playRef.current?.stop(), []);
  // The preview stops when its page is hidden (the page stays mounted behind the one shown); its onEnd resets it.
  useOnPageHide(() => playRef.current?.stop());

  // staff rendering (the ABC is worked out only on the staff tab). Only on the page shown: abcjs measures text in
  // the layout, which a hidden page (display: none) does not have; the staff is drawn when the page is shown.
  const pageShown = usePageActive();
  const staffAbc = tab === "staff" ? currentAbc() : "";
  useEffect(() => {
    if (tab !== "staff" || !staffRef.current || !pageShown) return;
    try {
      abcjs.renderAbc(staffRef.current, staffAbc, { responsive: "resize", add_classes: true, staffwidth: 900 });
    } catch (e) {
      staffRef.current.textContent = `五線譜の描画に失敗: ${errText(e)}`;
    }
  }, [tab, staffAbc, pageShown]);

  /** Advisory notes for the ABC that now stands for the score (never blocks anything), after `first`. */
  const adviseOn = (abcText: string, s: Score, first: string[] = []) => {
    const out = [...first];
    const nat = validateNativeAbc(abcText);
    if (!nat.ok) {
      out.push(`公式の記法チェック（参考）: ${nat.errors.slice(0, 3).join(" / ")}${nat.errors.length > 3 ? ` ほか ${nat.errors.length - 3} 件` : ""}`);
    }
    out.push(...nat.warnings);
    if (lyrics) out.push(...compareSections(s, lyrics));
    setNotices(out);
  };

  /** 「テキストを譜面に反映」; false when the text does not parse (the error is shown in the text tab). */
  const applyText = (): boolean => {
    let parsed: AbcParseResult;
    try {
      parsed = parseAbcDetailed(text);
    } catch (e) {
      setError(errText(e));
      return false;
    }
    const s = parsed.score;
    setError(null);
    if (!commit(s, true, true, true)) return false;
    say("ABC テキストを反映しました");
    // bar lines the commit just moved (the native check below sees only the rewritten text)
    const moved = irregularBarsNotice(parsed.irregularBars, true);
    adviseOn(serializeAbc(s), s, moved ? [moved] : []);
    return true;
  };

  /** Leaving the text tab with unapplied text: apply it, discard it, or stay. */
  const switchTab = async (t: Tab) => {
    if (t === tab) return;
    if (tab === "text" && textDirty) {
      const isCurrent = sameLoad();
      const c = await ask({
        title: "未反映の ABC テキスト",
        message: "ABC テキストの変更がまだ譜面に反映されていません。",
        choices: [
          { value: "apply", label: "反映して切り替える", kind: "primary" },
          { value: "discard", label: "変更を破棄して切り替える", kind: "danger" },
        ],
      });
      // a score loaded meanwhile replaced the text the question was about (as in pendingTextOk)
      if (c === null || !isCurrent()) return;
      if (c === "apply") {
        if (!applyText()) return; // a parse error: stay, the error is shown here
      } else {
        setText(source);
      }
    }
    setTab(t);
  };

  const transpose = async (semis: number) => {
    if (!score || !(await pendingTextOk())) return;
    // Only notes that exist: a selection can outlive the notes it named.
    const live = liveSelection(score.notes, selected);
    if (live.size) {
      // A selection is a melody edit: chords and key stay.
      const notes = transposeNotes(score.notes, live, semis);
      if (!notes) return say(RANGE_ERROR, true);
      commit({ ...score, notes });
      return;
    }
    const r = transposeScore(score, semis);
    if (!r) return say(RANGE_ERROR, true);
    if (!commit(r.score)) return; // notes, chords and key in one undo step
    if (semis % 12 !== 0) {
      const extra: string[] = [];
      if (r.keyUnchanged) extra.push("調を読み取れないため K: はそのままです");
      if (r.unmovedChords) extra.push(`解釈できないコード ${r.unmovedChords} 個はそのままです`);
      const chordsMoved = r.score.chords.filter((c) => c.symbol !== "N").length > r.unmovedChords ? "・コードも移動" : "";
      say(`移調しました（調 ${normalizeKey(r.score.key) ?? r.score.key}${chordsMoved}）${extra.length ? " / " + extra.join(" / ") : ""}`);
    }
  };

  /** Commit the tempo field (blur, Enter, a spinner step): once, and only when the tempo really changes. */
  const commitTempo = async (value: string | null = bpmDraft) => {
    setBpmDraft(null);
    if (!score || value === null) return;
    const bpm = tempoFromInput(value, score.bpm);
    if (bpm === null || !(await pendingTextOk())) return;
    commit({ ...score, bpm });
  };
  /** The header key only: key changes later in the song stay as they are. */
  const setKey = async (key: string) => {
    if (score && (await pendingTextOk())) commit({ ...score, key });
  };

  const musicBars = score ? recomputeBars(score) : 0;
  const trimTrailingBars = async () => {
    if (!score || score.bars <= musicBars || !(await pendingTextOk())) return;
    const removed = score.bars - musicBars;
    if (commit({ ...score, bars: musicBars }, true, false)) say(`末尾の空小節を ${removed} 小節削除しました`);
  };

  // Import / export failures are reported in the footer line, which every tab shows.
  /**
   * The file of an import, or null (cancelled, or dropped because another score was loaded or the editor was
   * unmounted while the dialog or the read waited: a followed generation, a finished transcription).
   */
  const importFile = async (filter: { name: string; extensions: string[] }): Promise<Uint8Array | null> => {
    const isCurrent = sameLoad();
    const f = await pickAndRead(() => open({ filters: [filter], multiple: false }), (path) => api.readBinaryFile(path), isCurrent);
    if (f.kind === "stale" && mountedRef.current) say("読み込み中に別の譜面が読み込まれたため、ファイルの読み込みを中止しました", true);
    return f.kind === "file" ? f.bytes : null;
  };
  const importMidi = async () => {
    if (!(await pendingTextOk())) return;
    try {
      const bytes = await importFile({ name: "MIDI", extensions: ["mid", "midi"] });
      if (!bytes) return;
      const r = midiToScore(bytes, score, { unit: snapUnit });
      if (commit(r.score, true, true, true)) {
        say(`MIDI を読み込みました（トラック: ${r.trackNames.join(", ")}）${r.warnings.length ? " / " + r.warnings.join(" / ") : ""}`);
      }
    } catch (e) {
      say(`MIDI の読み込みに失敗しました: ${errText(e)}`, true);
    }
  };
  const exportMidi = async () => {
    if (!score || !(await pendingTextOk())) return;
    try {
      const path = await save({ filters: [{ name: "MIDI", extensions: ["mid"] }], defaultPath: "score.mid" });
      if (!path) return;
      // the backend appends .mid to a name typed with another extension: name the file actually written then
      const written = await api.writeBinaryFile(path, Array.from(scoreToMidi(score)));
      say(written && written !== path ? `MIDI を書き出しました（${written}）` : "MIDI を書き出しました");
    } catch (e) {
      say(`MIDI の書き出しに失敗しました: ${errText(e)}`, true);
    }
  };
  const importAbc = async () => {
    if (!(await pendingTextOk())) return;
    try {
      const bytes = await importFile({ name: "ABC", extensions: ["abc", "txt"] });
      if (!bytes) return;
      const t = new TextDecoder("utf-8").decode(bytes);
      const { score: s, irregularBars } = parseAbcDetailed(t);
      // Same advisory notes as 「テキストを譜面に反映」 (moved bar lines, native check, sections vs lyrics); after
      // commit, which clears the notices of the previous text.
      if (commit(s, true, true, true)) {
        say("ABC を読み込みました");
        const moved = irregularBarsNotice(irregularBars, true);
        adviseOn(serializeAbc(s), s, moved ? [moved] : []);
      }
    } catch (e) {
      say(`ABC の読み込みに失敗しました: ${errText(e)}`, true);
    }
  };
  const exportAbc = async () => {
    if (!(await pendingTextOk())) return;
    try {
      const path = await save({ filters: [{ name: "ABC", extensions: ["abc"] }], defaultPath: "score.abc" });
      if (!path) return;
      const written = await api.writeTextFile(path, currentAbc());
      say(written && written !== path ? `ABC を書き出しました（${written}）` : "ABC を書き出しました");
    } catch (e) {
      say(`ABC の書き出しに失敗しました: ${errText(e)}`, true);
    }
  };

  const render = async () => {
    if (!score || !onRender || !(await pendingTextOk())) return;
    onRender(currentAbc(), hasChords);
  };
  const renderInstrumental = async () => {
    if (!score || !onRenderInstrumental || !(await pendingTextOk())) return;
    // As render: the text as taken in until the score is edited, so the page sees its bar lines as written and says
    // when the conversion moves them (ComposePage renderInstrumentalFromAbc). No fallback to the text tab's text.
    const abcNow = currentScoreAbc({ dirty, hasScore: true, source, serialized: () => serializedOf(score), text: "" });
    if (!abcNow) return say("譜面を書き出せないため変換できません（ABC テキストのタブで直してから試してください）", true);
    onRenderInstrumental(abcNow);
  };

  // Keyboard shortcuts of the piano roll. Scoped to the editor (not the page): keys pressed on the page's
  // other controls keep their own meaning. Space on a focused button presses that button.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (tab !== "roll" || !score) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key; // CapsLock / Shift give "Z" / "A"
    const mod = e.ctrlKey || e.metaKey;
    if (key === " ") {
      if (target.closest("button, summary, a[href], [role=button]")) return;
      e.preventDefault();
      if (!e.repeat) void togglePlay();
      return;
    }
    if (key === "z" && mod) {
      e.preventDefault();
      void undo();
      return;
    }
    if (key === "a" && mod) {
      e.preventDefault();
      setSelected(new Set(score.notes.filter((n) => n.voice === voice).map((n) => n.id)));
      return;
    }
    const live = liveSelection(score.notes, selected);
    if (live.size === 0) return;
    if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      if (commit({ ...score, notes: score.notes.filter((n) => !live.has(n.id)) })) setSelected(new Set());
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();
      const d = (key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1);
      const notes = transposeNotes(score.notes, live, d);
      if (notes) commit({ ...score, notes });
      else say(RANGE_ERROR, true);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      e.preventDefault();
      const d = (key === "ArrowRight" ? 1 : -1) * ((PPQ * 4) / snapUnit);
      // Overlaps are resolved as after a mouse move; a move past the start of the song is refused.
      const notes = moveNotes(score.notes, live, d);
      if (notes) commit({ ...score, notes });
      else say("曲の先頭より前には移動できません", true);
    }
  };

  const hasChords = Boolean(score && score.chords.length > 0);
  const normKey = score ? normalizeKey(score.key) : null;

  return (
    <div className="stack" style={{ gap: 8 }} onKeyDown={onKeyDown}>
      <div className="row between">
        <div className="seg" role="group" aria-label="表示の切り替え">
          {(["roll", "text", "staff"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} aria-pressed={tab === t} onClick={() => void switchTab(t)}>
              {t === "roll" ? "ピアノロール" : t === "text" ? `ABC テキスト${textDirty ? "（未反映）" : ""}` : "五線譜"}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="btn sm" disabled={!score} onClick={() => void togglePlay()}>
            {playing ? "■ 停止" : "▶ 譜面を試聴"}
          </button>
          <button className="btn sm" disabled={!score} onClick={() => seekTo(0)} title="先頭に戻る" aria-label="先頭に戻る">
            ⏮
          </button>
          <button className="btn sm" disabled={!score || undoRef.current.length === 0} onClick={() => void undo()}>
            元に戻す
          </button>
          {onRender && (
            <button className="btn primary sm" disabled={!score || busy} onClick={() => void render()} title={busy && busyHint ? busyHint : hasChords ? "Full モード（コード付き譜面）で再生成" : "Melody モード（メロディのみ）で再生成"}>
              この譜面で再生成{hasChords ? "（Full）" : "（Melody）"}
            </button>
          )}
          {onRenderInstrumental && (
            <button className="btn sm" disabled={!score || busy} onClick={() => void renderInstrumental()} title={busy && busyHint ? busyHint : "ボーカルの音符を伴奏声部に移し、歌詞なしで生成します"}>
              インストゥルメンタル版を生成
            </button>
          )}
        </div>
      </div>

      {score && (
        <div className="row small" style={{ gap: 8 }}>
          <span className="muted">編集する声部</span>
          <div className="seg" role="group" aria-label="編集する声部">
            {(["Vocal", "Ins"] as VoiceName[]).map((v) => (
              <button key={v} className={voice === v ? "on" : ""} aria-pressed={voice === v} onClick={() => setVoice(v)}>
                {VOICE_LABEL[v]}
              </button>
            ))}
          </div>
          <span className="muted">スナップ</span>
          <select value={snapUnit} onChange={(e) => setSnapUnit(Number(e.target.value))} style={{ width: 90 }}>
            <option value={4}>1/4</option>
            <option value={8}>1/8</option>
            <option value={16}>1/16</option>
            <option value={32}>1/32</option>
          </select>
          <span className="muted">移調</span>
          <button className="btn sm" onClick={() => void transpose(-12)}>-8va</button>
          <button className="btn sm" onClick={() => void transpose(-1)}>-1</button>
          <button className="btn sm" onClick={() => void transpose(1)}>+1</button>
          <button className="btn sm" onClick={() => void transpose(12)}>+8va</button>
          <span className="muted">テンポ</span>
          <input
            type="number"
            value={bpmDraft ?? String(score.bpm)}
            min={TEMPO_MIN}
            max={TEMPO_MAX}
            step={1}
            title={`${TEMPO_MIN}〜${TEMPO_MAX}（Enter またはフォーカスを外すと確定、Esc で取り消し）`}
            onChange={(e) => {
              // Typing only edits the field; a spinner step (an input event that is not typing) is committed at once.
              if (typeof InputEvent !== "undefined" && !(e.nativeEvent instanceof InputEvent)) void commitTempo(e.target.value);
              else setBpmDraft(e.target.value);
            }}
            onBlur={() => void commitTempo()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") setBpmDraft(null);
            }}
            style={{ width: 70 }}
          />
          <span className="muted">調</span>
          <select value={normKey ?? score.key} onChange={(e) => void setKey(e.target.value)} style={{ width: 76 }} title="YuE2 のネイティブ記法で使える 30 の調（曲頭の調号だけを変え、音の高さは変えません。曲中の転調はそのまま残ります）">
            {normKey === null && <option value={score.key}>{score.key || "（なし）"}（非対応）</option>}
            {OFFICIAL_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {score.bars > musicBars && (
            <button className="btn sm" onClick={() => void trimTrailingBars()} title="音符・コード・セクションのない末尾の小節を削除します">
              末尾の空小節を削除
            </button>
          )}
          <span className="muted">
            {score.bars} 小節 · {score.notes.filter((n) => n.voice === "Vocal").length} / {score.notes.filter((n) => n.voice === "Ins").length} 音 · {score.chords.length} コード{dirty ? " · 編集済み" : ""}{hasTimelineChanges(score) ? " · 曲中に転調/拍子変更あり" : ""}
          </span>
        </div>
      )}
      {notices.map((n, i) => (
        <div key={i} className="hint">
          {n}
        </div>
      ))}

      {tab === "roll" && score && (
        <PianoRoll resetKey={loadSeq} score={score} onChange={onRollChange} onGestureStart={() => gestureRef.current.start()} activeVoice={voice} snapUnit={snapUnit} cursorTick={cursor} onSeek={seekTo} selected={selected} onSelect={setSelected} height={380} />
      )}
      {tab === "roll" && !score && <div className="empty">{error ? `譜面を解釈できません: ${error}（ABC テキストのタブで修正できます）` : "譜面がありません。曲を生成するか、ABC / MIDI を読み込んでください。"}</div>}
      {tab === "text" && (
        <div className="stack" style={{ gap: 6 }}>
          <textarea className="abc" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ minHeight: 320 }} />
          {textDirty && <div className="hint">ABC テキストの変更は未反映です（「テキストを譜面に反映」を押すと譜面に反映されます）</div>}
          <div className="row">
            <button className="btn sm" onClick={applyText}>
              テキストを譜面に反映
            </button>
            {error && <span style={{ color: "var(--danger)" }} className="small">{error}</span>}
          </div>
        </div>
      )}
      {tab === "staff" && <div ref={staffRef} className="staff" />}

      <div className="row between small">
        <div className="row">
          <button className="btn sm" onClick={() => void importAbc()}>ABC を読み込む</button>
          <button className="btn sm" disabled={!score} onClick={() => void exportAbc()}>ABC を書き出す</button>
          <button className="btn sm" onClick={() => void importMidi()}>MIDI を読み込む</button>
          <button className="btn sm" disabled={!score} onClick={() => void exportMidi()}>MIDI を書き出す</button>
        </div>
        {message ? (
          <span className={message.error ? "" : "muted"} style={message.error ? { color: "var(--danger)" } : undefined}>
            {message.text}
          </span>
        ) : (
          <span className="muted">{cursor !== null && score ? `再生位置 小節 ${barAtTick(score, cursor) + 1}` : ""}</span>
        )}
      </div>
      {dialog}
    </div>
  );
}
