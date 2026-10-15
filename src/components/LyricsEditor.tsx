// Lyrics editor with language selection and an optional hiragana version for singing (Japanese only).
// Left: lyrics as written (kanji) — stored with the song and used for synced lyrics / tags.
// Right: hiragana version (editable) — what is actually sent to the model when present.
import { useEffect, useMemo, useRef, useState } from "react";
import { useChoiceDialog } from "./ChoiceDialog";
import {
  buildPreview,
  detectLanguage,
  hasSungVersion,
  isSungStale,
  leftoverKanji,
  mergeReconvert,
  sungHasHandEdits,
  toHiragana,
  type LyricsLanguage,
  type PreviewLine,
} from "../lyrics/hiragana";
import { COMMON_TAGS, MAX_TAG_LENGTH, TAG_GROUPS, TAG_INPUT_MAX_UNITS, formatTag, insertTagAt, nextNumber, numberedTag, tagOverflow, type TagOption } from "../lyrics/sectionTags";

const LANG_LABELS: Record<LyricsLanguage, string> = { ja: "日本語", en: "英語", zh: "中国語", other: "その他" };
const RECENT_KEY = "mcs.recentTags";
const RECENT_MAX = 8;
/** leftover kanji listed in the warning (the rest is counted) */
const LEFTOVER_SHOWN = 10;

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    // a tag an earlier version cut in the middle of an emoji is dropped (it breaks every IPC call with the lyrics)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "" && formatTag(x) === x).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(tags: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(tags));
  } catch {
    /* storage unavailable */
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface LyricsEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** hiragana version for generation; null = none */
  sung: string | null;
  onSungChange: (v: string | null) => void;
  language: LyricsLanguage;
  onLanguageChange: (l: LyricsLanguage) => void;
  showTags?: boolean;
  minHeight?: number;
  placeholder?: string;
  /** Rendered under the editor (line counts etc.) */
  footer?: React.ReactNode;
  /**
   * Kanji text the hiragana version was made from (or loaded with), kept by the page so a song loaded from the
   * library is checked too, and so the page's generation check (confirmSungLyrics) sees the same state.
   */
  sungSource: string | null;
  onSungSourceChange: (source: string | null) => void;
  /**
   * The page runs work the hiragana conversion would conflict with (its question over the work's, or lyrics about
   * to be replaced): 「ひらがな化」 and 「ひらがな版を破棄」 are disabled with `busyHint` as their tooltip. Typing stays
   * possible (pages/locks.ts).
   */
  busy?: boolean;
  busyHint?: string;
  /**
   * The editor converts the lyrics (「ひらがな化」) or checks the hiragana version before discarding it: the page's
   * generate buttons wait (pages/locks.ts "converting"), since a send meanwhile would sing the text the result is
   * about to replace. Reported false again when the editor unmounts.
   */
  onBusyChange?: (busy: boolean) => void;
}

export default function LyricsEditor({ value, onChange, sung, onSungChange, language, onLanguageChange, showTags = true, minHeight = 260, placeholder, footer, sungSource, onSungSourceChange, busy = false, busyHint, onBusyChange }: LyricsEditorProps) {
  const [converting, setConverting] = useState(false);
  /** 「ひらがな版を破棄」 is checking for hand-fixed readings (may load the dictionary first) */
  const [discarding, setDiscarding] = useState(false);
  const working = converting || discarding;
  const reportBusy = useRef(onBusyChange);
  reportBusy.current = onBusyChange;
  useEffect(() => {
    reportBusy.current?.(working);
  }, [working]);
  useEffect(() => () => reportBusy.current?.(false), []);
  const [preview, setPreview] = useState<PreviewLine[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** outcome of the last conversion (kept reading fixes, a result dropped because the lyrics changed) */
  const [note, setNote] = useState<string | null>(null);
  const [numbering, setNumbering] = useState(false);
  const [customTag, setCustomTag] = useState("");
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const { ask, dialog } = useChoiceDialog();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Caret of the left textarea, remembered with the text it belongs to so an external replacement
  // (AI draft, reset) falls back to appending at the end.
  const caretRef = useRef<{ pos: number; text: string } | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const pickerTags = useMemo(() => new Map(TAG_GROUPS.flatMap((g) => g.tags).map((t) => [t.tag, t])), []);
  // The latest props, read after a conversion's await: the page may replace the lyrics meanwhile (AI draft,
  // reset, a song loaded from the library), and a late result must not overwrite them. Every conversion or
  // discard takes a new request number; only the latest one may apply its result.
  const latest = useRef({ value, sung, source: sungSource });
  latest.current = { value, sung, source: sungSource };
  const convReq = useRef(0);

  useEffect(() => {
    if (pendingCaret.current === null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    }
  }, [value]);

  const japanese = language === "ja";
  // A blank hiragana version is not used for generation (effectiveLyrics), so the UI treats it as absent too.
  const hasSung = hasSungVersion(sung);
  // The same rule the generation check uses (confirmSungLyrics).
  const stale = useMemo(() => isSungStale(value, sung, sungSource), [value, sung, sungSource]);
  const leftover = useMemo(() => (japanese && sung !== null && hasSung ? leftoverKanji(sung) : []), [japanese, sung, hasSung]);

  // Keep the furigana preview in sync with both panes (debounced; readings come from the edited
  // hiragana version when it still lines up with the kanji text, otherwise from the dictionary).
  useEffect(() => {
    if (!japanese || !hasSung) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      buildPreview(value, sung)
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e) => {
          // the tokenizer load is retried on the next edit (loadTokenizer forgets a failed load)
          if (cancelled) return;
          setPreview(null);
          setPreviewError(`読みの確認表示を作れませんでした（辞書の読み込みに失敗: ${errorText(e)}）`);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, sung, japanese, hasSung]);

  const kanjiCount = useMemo(() => preview?.reduce((n, l) => n + l.segments.filter((s) => s.ruby !== undefined).length, 0) ?? 0, [preview]);
  const unreadCount = useMemo(() => preview?.reduce((n, l) => n + l.segments.filter((s) => s.unread).length, 0) ?? 0, [preview]);
  const dictLines = useMemo(() => preview?.filter((l) => l.source === "dict").length ?? 0, [preview]);

  const rememberCaret = (ta: HTMLTextAreaElement) => {
    caretRef.current = { pos: ta.selectionStart, text: ta.value };
  };

  const insertTag = (opt: TagOption | string) => {
    const base = typeof opt === "string" ? opt : opt.tag;
    const numberable = typeof opt !== "string" && !!opt.numberable;
    const tag = numbering && numberable ? numberedTag(base, nextNumber(value, base)) : base;
    const caret = caretRef.current && caretRef.current.text === value ? caretRef.current.pos : null;
    const r = insertTagAt(value, caret, tag);
    pendingCaret.current = r.caret;
    caretRef.current = { pos: r.caret, text: r.text };
    onChange(r.text);
  };

  // the part of a typed tag beyond MAX_TAG_LENGTH characters, which formatTag cuts off at the insert
  const overflow = tagOverflow(customTag);
  const insertCustom = () => {
    const tag = formatTag(customTag);
    if (!tag) return;
    insertTag(tag);
    setCustomTag("");
    const next = [tag, ...recent.filter((t) => t !== tag)].slice(0, RECENT_MAX);
    setRecent(next);
    saveRecent(next);
  };

  const clearRecent = () => {
    setRecent([]);
    saveRecent([]);
  };

  /** Whether `sungText` holds reading fixes: it differs from the dictionary conversion of `kanji` (unknown = yes). */
  const handEdited = async (sungText: string, kanji: string): Promise<boolean> => {
    try {
      return sungHasHandEdits(sungText, (await toHiragana(kanji)).text);
    } catch {
      return true;
    }
  };

  const convert = async () => {
    const id = ++convReq.current;
    const text = value;
    // still the latest request, for the lyrics it was made for
    const valid = () => id === convReq.current && latest.current.value === text;
    const dropped = () => {
      if (id === convReq.current) setNote("変換中に歌詞が変わったため、変換結果を破棄しました。もう一度ひらがな化してください。");
    };
    setConverting(true);
    setError(null);
    setNote(null);
    try {
      const fresh = await toHiragana(text);
      if (!valid()) return dropped();
      const { sung: cur, source } = latest.current;
      let next = fresh.text;
      let kept = 0;
      if (cur !== null && cur.trim()) {
        // Lines of the kanji text that did not change keep their (possibly hand-fixed) readings.
        const merged = source !== null ? mergeReconvert(text, source, cur, fresh.text) : null;
        if (merged) {
          next = merged.text;
          kept = merged.kept;
        } else if (await handEdited(cur, source ?? text)) {
          if (!valid()) return dropped();
          const choice = await ask({
            title: "ひらがな版を作り直します",
            message:
              (source === null
                ? "ひらがな化した元の歌詞が分からないため、手直しした読みを行ごとに残せません。"
                : "右の欄の行の数がひらがな化した時と変わっているため、手直しした読みを行ごとに残せません。") +
              "作り直すと、右の欄で手直しした読みは置き換えられます。",
            choices: [{ value: "replace", label: "置き換える", kind: "primary" }],
          });
          if (choice !== "replace") return;
          if (!valid()) return dropped();
        }
      }
      onSungSourceChange(text);
      onSungChange(next);
      setShowPreview(true);
      if (kept > 0) setNote(`変更のない ${kept} 行は、右の欄で手直しした読みを残しました（すべて変換し直すには「ひらがな版を破棄」してから「ひらがな化」してください）。`);
    } catch (e) {
      if (id === convReq.current) setError(`ひらがな化に失敗しました: ${errorText(e)}`);
    } finally {
      if (id === convReq.current) setConverting(false);
    }
  };

  /**
   * Stops waiting for the running conversion (the page's generate buttons wait for it; a dictionary that does not
   * load holds them up to its timeout): its result is dropped and the hiragana version stays as it was.
   */
  const cancelConvert = () => {
    convReq.current++;
    setConverting(false);
  };

  const clear = async () => {
    const { sung: cur, source, value: text } = latest.current;
    // The hand-edit check may load the dictionary (several seconds on first use) and the dialog waits for the
    // user; the page may swap the lyrics meanwhile (song selection, AI draft, reset). Discard only the version
    // the user asked about.
    const same = () => latest.current.value === text && latest.current.sung === cur && latest.current.source === source;
    const changed = () => setNote("確認中に歌詞が変わったため、ひらがな版は破棄していません。必要ならもう一度「ひらがな版を破棄」してください。");
    if (cur !== null && cur.trim()) {
      setDiscarding(true);
      let edited: boolean;
      try {
        edited = await handEdited(cur, source ?? text);
      } finally {
        setDiscarding(false);
      }
      if (!same()) return changed();
      if (edited) {
        const choice = await ask({
          title: "ひらがな版を破棄します",
          message: "右の欄で手直しした読みは失われます。破棄すると、生成には左の歌詞（漢字あり）を使います。",
          choices: [{ value: "discard", label: "破棄する", kind: "danger" }],
        });
        if (choice !== "discard") return;
        if (!same()) return changed();
      }
    }
    // A conversion still running must not bring the discarded version back.
    convReq.current++;
    setConverting(false);
    setNote(null);
    onSungChange(null);
    onSungSourceChange(null);
    setPreview(null);
    setPreviewError(null);
  };

  const autoDetect = () => onLanguageChange(detectLanguage(value));

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <div className="row" style={{ gap: 6 }}>
          <span className="muted">歌詞の言語</span>
          <div className="seg" role="group" aria-label="歌詞の言語">
            {(Object.keys(LANG_LABELS) as LyricsLanguage[]).map((l) => (
              <button key={l} className={language === l ? "on" : ""} aria-pressed={language === l} onClick={() => onLanguageChange(l)}>
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
          <button className="btn sm" onClick={autoDetect} title="歌詞の文字種から言語を推定">自動判定</button>
        </div>
        {/* while converting also after a switch of the language: the conversion's キャンセル stays reachable */}
        {(japanese || converting) && (
          <div className="row">
            <button className="btn sm primary" onClick={convert} disabled={converting || discarding || !value.trim() || busy} title={busy ? busyHint : undefined}>
              {converting ? "変換中…" : hasSung ? "再度ひらがな化" : "ひらがな化（生成用）"}
            </button>
            {/* not disabled while the page is busy: stopping the conversion is always safe */}
            {converting && (
              <button className="btn sm" onClick={cancelConvert} title="ひらがな化を取り消します（右の欄は変換前のままです）">
                キャンセル
              </button>
            )}
            {sung !== null && (
              <button className="btn sm" onClick={clear} disabled={discarding || busy} title={busy ? busyHint : "ひらがな版を破棄し、左の歌詞で生成する"}>
                {discarding ? "確認中…" : "ひらがな版を破棄"}
              </button>
            )}
          </div>
        )}
      </div>

      {showTags && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="chips">
            {COMMON_TAGS.map((t) => (
              <button key={t.tag} type="button" className="chip" onClick={() => insertTag(t)} title={`[${t.tag}] をカーソル位置（行の途中ならその行の前、未指定なら末尾）に挿入`}>
                + {t.ja} [{t.tag}]
              </button>
            ))}
            <button
              type="button"
              className={numbering ? "chip on" : "chip"}
              aria-pressed={numbering}
              onClick={() => setNumbering((v) => !v)}
              title="Aメロやサビに通し番号を付けて挿入します（[Verse 1] [Verse 2] …。公式サンプルで多い書き方）"
            >
              {numbering ? "☑" : "☐"} 番号を付ける
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <select
              value=""
              onChange={(e) => {
                const t = pickerTags.get(e.target.value);
                if (t) insertTag(t);
              }}
              title="公式サンプルで使われているその他のタグ"
            >
              <option value="">その他のタグを選んで挿入…</option>
              {TAG_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.tags.map((t) => (
                    <option key={t.tag} value={t.tag}>
                      {t.ja} [{t.tag}]
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <input
              type="text"
              value={customTag}
              onChange={(e) => setCustomTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  insertCustom();
                }
              }}
              placeholder="任意のタグ（例: Guitar Solo / Verse 2: Female / Whisper）"
              maxLength={TAG_INPUT_MAX_UNITS}
              spellCheck={false}
            />
            <button className="btn sm" onClick={insertCustom} disabled={!formatTag(customTag)} title="入力したタグを [ ] で囲んで挿入">
              [ ] で挿入
            </button>
          </div>
          {overflow > 0 && <div className="hint">タグは {MAX_TAG_LENGTH} 文字までのため、最後の {overflow} 文字は挿入されません</div>}
          {recent.length > 0 && (
            <div className="chips">
              <span className="muted">最近使ったタグ:</span>
              {recent.map((t) => (
                <button key={t} type="button" className="chip" onClick={() => insertTag(t)} title={`[${t}] を挿入`}>
                  + [{t}]
                </button>
              ))}
              <button type="button" className="chip" onClick={clearRecent} title="最近使ったタグの履歴を消す">
                履歴を消す
              </button>
            </div>
          )}
          <div className="muted small">
            タグは自由記述です（YuE2 に決まった語彙はなく、[ ] の行は曲構成のヒントとしてそのままモデルに渡ります）。英語推奨。番号（[Verse 2]）や歌い手の指定（[Chorus: Female & Male]）も使えます。
          </div>
        </div>
      )}

      <div className={japanese && sung !== null ? "lyrics-pair" : undefined}>
        <label className="field">
          <span className="lbl">
            <span>{japanese && sung !== null ? "歌詞（漢字あり・保存 / 同期歌詞用）" : "歌詞"}</span>
          </span>
          <textarea
            ref={textareaRef}
            className="lyrics"
            value={value}
            onChange={(e) => {
              rememberCaret(e.target);
              onChange(e.target.value);
            }}
            onKeyUp={(e) => rememberCaret(e.currentTarget)}
            onClick={(e) => rememberCaret(e.currentTarget)}
            onSelect={(e) => rememberCaret(e.currentTarget)}
            onBlur={(e) => rememberCaret(e.currentTarget)}
            spellCheck={false}
            placeholder={placeholder ?? "[Verse]\n歌詞を入力...\n\n[Chorus]\n..."}
            style={{ minHeight }}
          />
        </label>
        {japanese && sung !== null && (
          <label className="field">
            <span className="lbl">
              <span>{hasSung ? "ひらがな版（生成に使用・編集可）" : "ひらがな版（編集可）"}</span>
              {!hasSung ? (
                <span className="hint">ひらがな版が空のため、生成には左の歌詞（漢字あり）を使います</span>
              ) : (
                stale && <span className="hint">ひらがな化の後に左の歌詞が変更されています（生成時にどうするか確認します。「再度ひらがな化」を押すと、変更のない行の読みは残ります）</span>
              )}
            </span>
            <textarea className="lyrics" value={sung} onChange={(e) => onSungChange(e.target.value)} spellCheck={false} style={{ minHeight }} />
          </label>
        )}
      </div>

      {error && <div style={{ color: "var(--danger)" }} className="small">{error}</div>}
      {japanese && note && <div className="muted small">{note}</div>}

      {japanese && hasSung && leftover.length > 0 && (
        <div className="hint">
          ひらがな版に読めなかった漢字が残っています（{leftover.slice(0, LEFTOVER_SHOWN).join("・")}
          {leftover.length > LEFTOVER_SHOWN ? ` ほか ${leftover.length - LEFTOVER_SHOWN} 字` : ""}）。右の欄で読みを入力してください。
        </div>
      )}

      {japanese && hasSung && (
        <div className="muted small">
          生成には右のひらがな版を使います。曲に保存される歌詞と同期歌詞の埋め込みには左の歌詞（漢字あり）を使います。
        </div>
      )}

      {japanese && hasSung && previewError && <div className="muted small">{previewError}</div>}

      {japanese && hasSung && preview && (
        <details open={showPreview} onToggle={(e) => setShowPreview((e.target as HTMLDetailsElement).open)}>
          <summary>
            変換内容の確認（漢字 {kanjiCount} 箇所{unreadCount > 0 ? `・読みのない漢字 ${unreadCount} 箇所` : ""}。漢字の上に読みを表示。左右の歌詞欄の変更に自動で追従）
          </summary>
          <div className="ruby-preview">
            {preview.map((l, i) => (
              <div key={i} className={l.verbatim ? "muted" : ""}>
                {l.verbatim
                  ? l.original || " "
                  : l.segments.map((s, j) =>
                      s.ruby !== undefined ? (
                        <ruby key={j}>
                          {s.text}
                          <rt className={l.source === "dict" ? "dict" : undefined}>{s.ruby}</rt>
                        </ruby>
                      ) : s.unread ? (
                        <span key={j} style={{ color: "var(--warn)", textDecoration: "underline wavy" }} title="読みがありません（右の欄で読みを入力してください）">
                          {s.text}
                        </span>
                      ) : (
                        <span key={j}>{s.text}</span>
                      ),
                    )}
              </div>
            ))}
          </div>
          <div className="muted small">
            青: ひらがな版（右）の読み。{dictLines > 0 ? `橙: 右のひらがな版と対応が取れない ${dictLines} 行は辞書の読みを表示しています（行数や仮名部分が一致しない場合）。` : ""}
            {unreadCount > 0 ? "波線: 読みのない漢字（辞書にない、または右の欄でも漢字のまま）。" : ""}
          </div>
        </details>
      )}
      {footer}
      {dialog}
    </div>
  );
}
