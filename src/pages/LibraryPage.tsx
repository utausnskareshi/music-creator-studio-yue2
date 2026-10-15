import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, formatSeconds, type KeptFolder, type Song } from "../api";
import { useStore } from "../store";
import Player from "../components/Player";
import { useChoiceDialog, type ChoiceRequest } from "../components/ChoiceDialog";
import { MAX_DURATION_CAP, isTruncated, keyParams, largerLimitParams, modeLabel, shortenedBudget, songMatches, songStatusLabel, truncationNotices } from "../library/songMeta";
import { SubmitGuard, singleClick } from "../compose/submitPlan";
import { REQUESTED_TITLE_MAX_CHARS } from "../config/rules";
import { editedTitle, fieldTitle } from "./ComposePage";
import PageHeader from "../components/PageHeader";

const RUNNING_DELETE_HINT = "生成中の曲は削除できません。先にキャンセルしてください";

/** Why delete_song left the song folder on disk (the song itself is gone from the library). */
export function keptFolderNotice(kept: KeptFolder): string {
  // the folder may well be inside 保存先: its drive (USB disk, NAS) is just not connected now. Or it was never made (a
  // song that ended before then may still hold its planned path): the two look the same while the drive is away.
  if (kept.unreachable) return `曲フォルダのドライブ（ネットワークの場所）に接続できないため、曲フォルダが残っているか確認できませんでした。接続後、残っていればエクスプローラーで削除してください: ${kept.path}`;
  return `曲フォルダは保存先の外にあるため残しました: ${kept.path}`;
}

/** The first sentence of the delete confirmation: the song folder only when the song has one (none was made for it). */
export function deleteSongLead(title: string, folder: string): string {
  if (!folder) return `「${title}」をライブラリから削除します。元に戻せません。`;
  return `「${title}」をライブラリから削除し、曲フォルダも削除します。元に戻せません（ごみ箱には移動しません）。`;
}

/**
 * The song folder a song has, as 詳細 and the delete confirmation name it: none while it waits (its row holds only the
 * planned path; jobs.rs makes the folder once the song starts, and delete_song takes a waiting song out of the queue).
 */
export function songFolder(s: Pick<Song, "status" | "folder">): string {
  return s.status === "queued" ? "" : s.folder;
}

/** The delete confirmation of a waiting song that started while it was open: delete_song refuses a running song. */
export function runningDeleteNotice(title: string): string {
  return `「${title}」の生成が始まったため、今は削除できません。先にキャンセルしてください。`;
}

/**
 * The answers of the delete question for a song in state `status`: none but 閉じる while it is generated (delete_song
 * refuses it; キャンセル would read as cancelling the generation).
 */
export function deleteSongAnswers(status: Song["status"]): Pick<ChoiceRequest<"delete">, "choices" | "cancelLabel"> {
  if (status === "running") return { choices: [], cancelLabel: "閉じる" };
  return { choices: [{ value: "delete", label: "削除する", kind: "danger" }] };
}

/** The open delete question: its song, and whether it was asked while the song was generated (no 削除する). */
export interface DeleteQuestion {
  id: string;
  running: boolean;
}

/**
 * The song whose open delete question no longer fits it, so it is asked again: it started (no 削除する while it is
 * generated) or ended (削除する again, and its folder) since. Null when there is none.
 */
export function staleDeleteQuestion<S extends Pick<Song, "id" | "status">>(open: DeleteQuestion | null, songs: readonly S[]): S | null {
  if (!open) return null;
  const s = songs.find((x) => x.id === open.id);
  return s && (s.status === "running") !== open.running ? s : null;
}

/**
 * The delete confirmation's message, from the song as it is now: a waiting song may start, make its folder and finish
 * while the question is open (削除する then deletes that folder).
 */
function DeleteSongMessage({ song }: { song: Song }) {
  const s = useStore((st) => st.songs.find((x) => x.id === song.id)) ?? song;
  // no folder sentence or path while it runs: it cannot be deleted, and its folder is made only later in the run
  if (s.status === "running") return <>{runningDeleteNotice(s.title)}</>;
  const folder = songFolder(s);
  return (
    <>
      {deleteSongLead(s.title, folder)}
      {s.status === "queued" && "\n待機中の生成も取り消されます。"}
      {folder && (
        <>
          {"\n"}
          <span className="mono small">{folder}</span>
        </>
      )}
    </>
  );
}

/**
 * The name a rename stores: one line of at most REQUESTED_TITLE_MAX_CHARS characters (作曲's 曲タイトル rule, the title
 * generate keeps when the song is used again), without spaces at either end; 無題 when nothing is left.
 */
export function renamedTitle(typed: string): string {
  return fieldTitle(typed.trim()).trim() || "無題";
}

/** What finishing a rename stores: an untouched name stays as it is (also an older one over the limit), unless empty. */
export function renameResult(typed: string, current: string): string {
  return typed === current && current.trim() !== "" ? current : renamedTitle(typed);
}

export default function LibraryPage() {
  const songs = useStore((s) => s.songs);
  const moreSongs = useStore((s) => s.moreSongs);
  const selectedSongId = useStore((s) => s.selectedSongId);
  const config = useStore((s) => s.config);
  const { selectSong, refreshSongs, loadMoreSongs, showToast } = useStore.getState();
  const { ask, update, dialog } = useChoiceDialog();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  /** the song whose delete is running (its row's buttons wait for it) */
  const [deleting, setDeleting] = useState<string | null>(null);
  // set once a rename was committed or cancelled, so the blur that follows does not commit (again)
  const renameDone = useRef(false);
  const selected = useMemo(() => songs.find((s) => s.id === selectedSongId) ?? null, [songs, selectedSongId]);
  const filtered = useMemo(() => songs.filter((s) => songMatches(s, q)), [songs, q]);

  // the name before an IME composition: its committed text is cut against it (as in 作曲's 曲タイトル)
  const titleBeforeIme = useRef<string | null>(null);
  const startRename = (s: Song) => {
    renameDone.current = false;
    titleBeforeIme.current = null;
    setEditing(s.id);
    setTitle(s.title);
  };
  /** Typing in the name field: what is over REQUESTED_TITLE_MAX_CHARS comes off the inserted text (editedTitle). */
  const onTitleEdit = (el: HTMLInputElement, prev: string) => {
    const { value, caret } = editedTitle(prev, el.value, el.selectionEnd);
    if (value !== el.value) {
      // written here with its caret: React then leaves the field alone (its own write would move the caret to the end)
      el.value = value;
      el.setSelectionRange(caret, caret);
    }
    setTitle(value);
  };
  const finishRename = async (s: Song, commit: boolean) => {
    if (renameDone.current) return;
    renameDone.current = true;
    setEditing(null);
    const next = renameResult(title, s.title);
    if (!commit || next === s.title) return;
    try {
      await api.renameSong(s.id, next);
    } catch (e) {
      showToast("error", `名前を変更できませんでした: ${String(e)}`);
    }
    refreshSongs().catch(() => {});
  };
  // Like the other generate buttons: one send at a time, and a second press right after it is ignored.
  const [guard] = useState(() => new SubmitGuard());
  const [regenerating, setRegenerating] = useState(false);
  const regenerateLarger = async () => {
    if (!selected) return;
    const params = largerLimitParams(selected, config?.maxDurationLimit ?? MAX_DURATION_CAP);
    if (!params || !guard.begin("larger")) return;
    setRegenerating(true);
    try {
      await api.generate(params);
      guard.accepted("larger");
      showToast("success", `曲長の上限を ${params.maxDuration} 秒にして再生成を待ち行列に追加しました`);
    } catch (e) {
      showToast("error", String(e));
    } finally {
      guard.end();
      setRegenerating(false);
    }
  };
  const selectedParams = selected ? keyParams(selected) : null;
  const selectedNotices = selected ? truncationNotices(selected) : [];
  const selectedShort = selected ? shortenedBudget(selected) : null;
  const larger = selected && selected.truncatedSemantic === true ? largerLimitParams(selected, config?.maxDurationLimit ?? MAX_DURATION_CAP) : null;
  // a running song's folder may not be made yet: 開く then shows the nearest folder above it (reveal_path)
  const selectedFolder = selected ? songFolder(selected) : "";

  /** The delete question for the song as it is now (its answers follow its state: deleteSongAnswers). */
  const deleteRequest = (s: Song): ChoiceRequest<"delete"> => ({
    title: "曲を削除",
    message: <DeleteSongMessage song={s} />,
    ...deleteSongAnswers(s.status),
  });
  const deleteQuestion = useRef<DeleteQuestion | null>(null);
  const remove = async (s: Song) => {
    const question = { id: s.id, running: s.status === "running" };
    deleteQuestion.current = question;
    const choice = await ask(deleteRequest(s));
    // replaced by another question (answered null): that one goes on
    if (deleteQuestion.current !== question) return;
    deleteQuestion.current = null;
    if (choice !== "delete") return;
    setDeleting(s.id);
    try {
      const kept = await api.deleteSong(s.id, true);
      if (useStore.getState().selectedSongId === s.id) selectSong(null);
      // pages that still hold this song's files (ボーカル分離, カバー) let go of them
      useStore.getState().songDeleted(s.id, kept !== null);
      if (kept) showToast("info", keptFolderNotice(kept));
    } catch (e) {
      showToast("error", String(e));
    } finally {
      setDeleting((cur) => (cur === s.id ? null : cur));
    }
    refreshSongs().catch(() => {});
  };
  // A waiting song may start while its delete question is open, and end again: the open question is then changed in
  // place, so its answers follow the song's state like its message does. Not asked again: a new dialog would open
  // over one opened after it (the app's exit question) and take its keyboard, and focus would no longer return to
  // the row's 削除 button.
  useEffect(() => {
    const open = deleteQuestion.current;
    const s = staleDeleteQuestion(open, songs);
    if (open && s && update(deleteRequest(s))) open.running = s.status === "running";
  }, [songs]);

  const cancel = async (s: Song) => {
    try {
      await api.cancelJob(s.id);
    } catch (e) {
      showToast("error", `キャンセルできませんでした: ${String(e)}`);
    }
  };

  const more = async () => {
    setLoadingMore(true);
    try {
      await loadMoreSongs();
    } catch (e) {
      showToast("error", `曲の一覧を読み込めませんでした: ${String(e)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  // Enter / Space select the focused row, F2 renames it; keys typed in the rename input or on a button are theirs.
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, s: Song) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectSong(s.id);
    } else if (e.key === "F2") {
      e.preventDefault();
      startRename(s);
    }
  };

  const playerPlaceholder = !selected ? "曲を選択してください" : selected.status !== "done" ? "生成が完了すると再生できます" : undefined;

  return (
    <div>
      {dialog}
      <PageHeader page="library" />
      <div className="grid-compose">
        <div className="panel stack">
          <input type="text" placeholder="タイトル・スタイル・歌詞で検索（大文字・小文字、カタカナ・ひらがなは区別しません）" value={q} onChange={(e) => setQ(e.target.value)} />
          {moreSongs && (
            <div className="row between small muted">
              <span>
                最新 {songs.length} 曲を表示中です。
                {q.trim() && "古い曲はまだ読み込まれていないため、検索に出ないことがあります。"}
              </span>
              <button className="btn sm" disabled={loadingMore} onClick={more}>
                {loadingMore ? "読み込み中…" : "さらに読み込む"}
              </button>
            </div>
          )}
          <div className="list">
            {filtered.map((s) => {
              const isSel = s.id === selectedSongId;
              const pending = s.status === "queued" || s.status === "running";
              return (
                <div
                  key={s.id}
                  className={`song-row with-actions ${isSel ? "selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-current={isSel ? "true" : undefined}
                  onClick={() => selectSong(s.id)}
                  onKeyDown={(e) => onRowKey(e, s)}
                >
                  <div>
                    {editing === s.id ? (
                      // At most REQUESTED_TITLE_MAX_CHARS characters, kept by editedTitle as in 作曲's 曲タイトル (maxLength
                      // only caps the UTF-16 units); an IME composition is cut when it ends, against the name it started from.
                      <input
                        type="text"
                        value={title}
                        maxLength={REQUESTED_TITLE_MAX_CHARS * 2}
                        autoFocus
                        aria-label="曲名"
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
                        onKeyDown={(e) => {
                          // the Enter / Escape of an IME conversion is the IME's
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === "Enter") finishRename(s, true);
                          else if (e.key === "Escape") finishRename(s, false);
                        }}
                        onBlur={() => finishRename(s, true)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div
                        className="song-title"
                        title="ダブルクリック（または F2）で名前を変更"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startRename(s);
                        }}
                      >
                        {s.title}
                      </div>
                    )}
                    <div className="song-meta">
                      {new Date(s.createdAt).toLocaleString()} · {modeLabel(s.mode)} · シード {s.seed} · {s.duration ? formatSeconds(s.duration) : ""}
                    </div>
                  </div>
                  <span className={`badge ${s.status}`}>{songStatusLabel(s.status)}</span>
                  {s.status === "done" && isTruncated(s) ? (
                    <span className="badge warn" title={truncationNotices(s).join("\n")}>
                      上限到達
                    </span>
                  ) : (
                    <span />
                  )}
                  <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    {pending && (
                      <button
                        className="btn sm"
                        disabled={deleting === s.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          cancel(s);
                        }}
                      >
                        キャンセル
                      </button>
                    )}
                    <button
                      className="btn sm danger"
                      disabled={s.status === "running" || deleting === s.id}
                      title={s.status === "running" ? RUNNING_DELETE_HINT : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(s);
                      }}
                    >
                      {deleting === s.id ? "削除中…" : "削除"}
                    </button>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && <div className="empty">{q.trim() && songs.length > 0 ? "一致する曲がありません" : "曲がありません"}</div>}
          </div>
        </div>
        <div className="stack">
          <div className="panel">
            <Player audioPath={selected?.status === "done" ? selected.audioPath : null} title={selected?.title} placeholder={playerPlaceholder} />
          </div>
          {selected && (
            <div className="panel stack">
              <h3>詳細</h3>
              <div className="kv">
                <div className="k">スタイル</div>
                <div>{selected.style}</div>
                <div className="k">モード / シード</div>
                <div>
                  {modeLabel(selectedParams?.mode ?? selected.mode)} / {selectedParams?.seed ?? selected.seed}
                </div>
                <div className="k">主なパラメータ</div>
                <div>
                  曲長上限 {selectedParams?.maxDuration != null ? `${selectedParams.maxDuration} 秒` : "不明"}
                  {selectedShort ? `（実効上限 ${selectedShort.effective.toFixed(1)} 秒：プロンプト長により短縮）` : ""} / CFG {selectedParams?.cfgScale} / ステップ {selectedParams?.steps}
                </div>
                <div className="k">曲長 / 生成時間</div>
                <div>
                  {formatSeconds(selected.duration)} / {selected.wallSeconds.toFixed(1)} 秒（ピーク VRAM {selected.peakVramGib.toFixed(1)} GB）
                </div>
                {/* none for a waiting song, or one that ended before its folder was made */}
                {selectedFolder && (
                  <>
                    <div className="k">フォルダ</div>
                    <div className="mono small" style={{ wordBreak: "break-all" }}>
                      {selectedFolder} <button className="btn sm" onClick={() => api.revealPath(selectedFolder).catch((e) => showToast("error", String(e)))}>開く</button>
                    </div>
                  </>
                )}
                {selected.status === "done" && selectedNotices.length > 0 && (
                  <>
                    <div className="k">打ち切り</div>
                    <div className="stack" style={{ gap: 4 }}>
                      {selectedNotices.map((n) => (
                        <div key={n} className="hint">
                          {n}
                        </div>
                      ))}
                      {larger && (
                        <div>
                          <button className="btn sm" disabled={regenerating} onClick={singleClick(() => void regenerateLarger())}>
                            {regenerating ? "追加中…" : `上限を ${larger.maxDuration} 秒に広げて再生成`}
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
                {selected.error && (
                  <>
                    <div className="k">エラー</div>
                    <div className="selectable" style={{ color: "var(--danger)", whiteSpace: "pre-wrap" }}>
                      {selected.error}
                    </div>
                  </>
                )}
              </div>
              <details>
                <summary>歌詞</summary>
                <pre className="log" style={{ maxHeight: 300 }}>{selected.lyrics}</pre>
              </details>
              {selected.lyricsSung && (
                <details>
                  <summary>歌唱テキスト（モデルに渡したひらがな）</summary>
                  <pre className="log" style={{ maxHeight: 300 }}>{selected.lyricsSung}</pre>
                </details>
              )}
              {selected.abc && (
                <details>
                  <summary>ABC 譜面</summary>
                  <pre className="log" style={{ maxHeight: 300 }}>{selected.abc}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
