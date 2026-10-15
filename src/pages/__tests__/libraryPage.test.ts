import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import type { Song } from "../../api";
import { REQUESTED_TITLE_MAX_CHARS } from "../../config/rules";
import { deleteSongAnswers, deleteSongLead, keptFolderNotice, renameResult, renamedTitle, runningDeleteNotice, songFolder, staleDeleteQuestion } from "../LibraryPage";

const libraryCode = () => readFileSync(fileURLToPath(new URL("../LibraryPage.tsx", import.meta.url)), "utf8");

describe("song delete notice", () => {
  it("says why the song folder was kept (lib.rs KeptFolder)", () => {
    // the folder may well be inside 保存先: its drive or share is only not connected now
    const away = keptFolderNotice({ path: "E:\\Songs\\2026-10-01\\123456_abcdefgh", unreachable: true });
    expect(away).toContain("接続できないため");
    expect(away).not.toContain("保存先の外");
    expect(away.endsWith(": E:\\Songs\\2026-10-01\\123456_abcdefgh")).toBe(true);
    // not confirmed as the song's own folder
    expect(keptFolderNotice({ path: "D:\\other", unreachable: false })).toBe("曲フォルダは保存先の外にあるため残しました: D:\\other");
  });

  it("does not claim a folder is there when its drive cannot be reached (it may never have been made)", () => {
    // a song that ended before its folder was made can hold the planned path: missing on an unplugged drive looks the same
    const away = keptFolderNotice({ path: "E:\\Songs\\2026-10-01\\123456_abcdefgh", unreachable: true });
    expect(away).toBe(
      "曲フォルダのドライブ（ネットワークの場所）に接続できないため、曲フォルダが残っているか確認できませんでした。接続後、残っていればエクスプローラーで削除してください: E:\\Songs\\2026-10-01\\123456_abcdefgh",
    );
    expect(away).not.toContain("削除していません");
  });
});

describe("a song without a folder", () => {
  it("is deleted without a word about its folder (none was made for it)", () => {
    expect(deleteSongLead("春の歌", "E:\\Songs\\2026-10-01\\123456_abcdefgh")).toBe("「春の歌」をライブラリから削除し、曲フォルダも削除します。元に戻せません（ごみ箱には移動しません）。");
    expect(deleteSongLead("春の歌", "")).toBe("「春の歌」をライブラリから削除します。元に戻せません。");
    const message = deleteMessageCode();
    expect(message).toContain("{deleteSongLead(s.title, folder)}");
    // its path only when there is one
    expect(message).toMatch(/\{folder && \(\s*<>\s*\{"\\n"\}\s*<span className="mono small">\{folder\}<\/span>/);
  });

  it("shows no フォルダ row in 詳細 (開く would reveal an empty path)", () => {
    const code = libraryCode();
    const detail = code.slice(code.indexOf("<h3>詳細</h3>"));
    expect(detail).toMatch(
      /\{selectedFolder && \(\s*<>\s*<div className="k">フォルダ<\/div>\s*<div [^>]*>\s*\{selectedFolder\} <button className="btn sm" onClick=\{\(\) => api\.revealPath\(selectedFolder\)/,
    );
    // the guarded row is the only one
    expect(detail.split('<div className="k">フォルダ</div>').length).toBe(2);
    expect(detail.split("api.revealPath(").length).toBe(2);
  });
});

/** The delete confirmation's message: the component remove() asks with. */
function deleteMessageCode(): string {
  const code = libraryCode();
  // the question remove() asks and the effect changes in place (deleteRequest)
  const request = code.slice(code.indexOf("const deleteRequest = "), code.indexOf("const cancel = "));
  expect(request).toMatch(/message: <DeleteSongMessage song=\{s\} \/>,/);
  const at = code.indexOf("function DeleteSongMessage(");
  expect(at).toBeGreaterThan(-1);
  return code.slice(at, code.indexOf("\n}\n", at));
}

describe("a waiting (待機中) song", () => {
  const queued = { status: "queued" as Song["status"], folder: "E:\\Songs\\2026-10-07\\101500_abcdef12" };

  it("has no song folder yet: its row holds only the planned path (jobs.rs makes the folder once the song starts)", () => {
    expect(songFolder(queued)).toBe("");
    expect(deleteSongLead("春の歌", songFolder(queued))).toBe("「春の歌」をライブラリから削除します。元に戻せません。");
    // from the start on, the row's folder (made at the start of the run, or about to be)
    for (const status of ["running", "done", "error", "cancelled"] as const) expect(songFolder({ ...queued, status }), status).toBe(queued.folder);
    // a song that ended before its folder was made has none in its row (jobs.rs mark_ended)
    expect(songFolder({ status: "error", folder: "" })).toBe("");
  });

  it("is confirmed without a folder or a path, by a message that follows the song while it is open", () => {
    const message = deleteMessageCode();
    // the row as it is now, not as it was at the click: a waiting song may start, make its folder and finish
    // while the question is open, and 削除する then deletes that folder
    expect(message).toMatch(/const s = useStore\(\(st\) => st\.songs\.find\(\(x\) => x\.id === song\.id\)\) \?\? song;/);
    expect(message).toContain("const folder = songFolder(s);");
    expect(message).toContain('{s.status === "queued" && "\\n待機中の生成も取り消されます。"}');
    // nothing about the folder from the planned path
    expect(message).not.toMatch(/\.folder\b/);
  });

  it("shows no フォルダ row or 開く in 詳細 until it starts", () => {
    expect(libraryCode()).toMatch(/const selectedFolder = selected \? songFolder\(selected\) : "";/);
  });
});

describe("a waiting song that starts while its delete question is open", () => {
  it("is not offered 削除する while it is generated (delete_song refuses it)", () => {
    // only 閉じる: キャンセル would read as cancelling the generation, which the message asks for
    expect(deleteSongAnswers("running")).toEqual({ choices: [], cancelLabel: "閉じる" });
    for (const status of ["queued", "done", "error", "cancelled"] as const) {
      expect(deleteSongAnswers(status), status).toEqual({ choices: [{ value: "delete", label: "削除する", kind: "danger" }] });
    }
  });

  it("says it cannot be deleted now, without its planned folder (made only later) or the 待機中 line", () => {
    const notice = runningDeleteNotice("B");
    expect(notice).toBe("「B」の生成が始まったため、今は削除できません。先にキャンセルしてください。");
    expect(notice).not.toContain("曲フォルダ");
    const message = deleteMessageCode();
    const branch = message.indexOf('if (s.status === "running") return <>{runningDeleteNotice(s.title)}</>;');
    expect(branch).toBeGreaterThan(-1);
    // before the folder sentence, the 待機中 line and the path
    expect(branch).toBeLessThan(message.indexOf("const folder = songFolder(s);"));
  });

  it("is asked again when it starts or ends, so the answers follow its state (a song that finished is deleted)", () => {
    const planned = "E:\\Songs\\2026-10-07\\101500_bbbbbbbb";
    const song = (status: Song["status"]) => ({ id: "b", status, folder: planned });
    const open = { id: "b", running: false };
    // asked while it waited: asked again once it runs
    expect(staleDeleteQuestion(open, [song("queued")])).toBeNull();
    expect(staleDeleteQuestion(open, [song("running")])).toEqual(song("running"));
    // asked again while it ran: asked again once it ended (削除する deletes it and its folder)
    const running = { id: "b", running: true };
    expect(staleDeleteQuestion(running, [song("running")])).toBeNull();
    for (const status of ["done", "error", "cancelled"] as const) expect(staleDeleteQuestion(running, [song(status)]), status).toEqual(song(status));
    // no question, or the song is not in the list
    expect(staleDeleteQuestion(null, [song("running")])).toBeNull();
    expect(staleDeleteQuestion(open, [{ ...song("running"), id: "a" }])).toBeNull();
  });

  it("asks with the answers of the song's state, and a replaced question does not answer", () => {
    const code = libraryCode();
    const remove = code.slice(code.indexOf("const remove = "), code.indexOf("const cancel = "));
    expect(remove).toMatch(/const question = \{ id: s\.id, running: s\.status === "running" \};\s*deleteQuestion\.current = question;\s*const choice = await ask\(deleteRequest\(s\)\);/);
    const request = code.slice(code.indexOf("const deleteRequest = "), code.indexOf("const deleteQuestion = "));
    expect(request).toContain("...deleteSongAnswers(s.status),");
    expect(remove + request).not.toContain('label: "削除する"');
    // a question replaced by another one (answered null) ends here
    expect(remove).toMatch(/if \(deleteQuestion\.current !== question\) return;\s*deleteQuestion\.current = null;\s*if \(choice !== "delete"\) return;/);
  });

  // Asking again would mount a new dialog over one opened after it (the app's exit question, which would lose its
  // keyboard) and drop the row's 削除 button that focus returns to.
  it("changes the open question in place when the song starts or ends, instead of asking again", () => {
    const code = libraryCode();
    expect(code).toMatch(/const \{ ask, update, dialog \} = useChoiceDialog\(\);/);
    // the store's songs (job updates) are watched while it is open
    expect(code).toMatch(
      /useEffect\(\(\) => \{\s*const open = deleteQuestion\.current;\s*const s = staleDeleteQuestion\(open, songs\);\s*if \(open && s && update\(deleteRequest\(s\)\)\) open\.running = s\.status === "running";\s*\}, \[songs\]\);/,
    );
    expect(code).not.toMatch(/void remove\(s\)/);
  });
});

describe("song rename", () => {
  it("keeps one line of REQUESTED_TITLE_MAX_CHARS characters, as generate keeps a title", () => {
    // counted in code points like the backend (HTML maxLength counts UTF-16 units)
    expect(renamedTitle("🎵".repeat(REQUESTED_TITLE_MAX_CHARS + 10))).toBe("🎵".repeat(REQUESTED_TITLE_MAX_CHARS));
    expect(renamedTitle("あ".repeat(80))).toBe("あ".repeat(REQUESTED_TITLE_MAX_CHARS));
    expect(renamedTitle("一行目\n二行目")).toBe("一行目 二行目");
    expect(renamedTitle("a\tb")).toBe("a b");
  });

  it("trims the name, and an empty one becomes 無題", () => {
    expect(renamedTitle("  春の歌 ")).toBe("春の歌");
    expect(renamedTitle(` ${"x".repeat(REQUESTED_TITLE_MAX_CHARS)} `)).toBe("x".repeat(REQUESTED_TITLE_MAX_CHARS));
    expect(renamedTitle("   ")).toBe("無題");
    expect(renamedTitle("")).toBe("無題");
  });

  it("leaves an untouched name as it is, but not an empty one", () => {
    const long = "あ".repeat(REQUESTED_TITLE_MAX_CHARS + 5);
    // an older name over the limit is not cut by opening and closing the field
    expect(renameResult(long, long)).toBe(long);
    expect(renameResult("春の歌", "春の歌")).toBe("春の歌");
    expect(renameResult(" 夏の歌 ", "春の歌")).toBe("夏の歌");
    expect(renameResult("", "")).toBe("無題");
    expect(renameResult("  ", "  ")).toBe("無題");
  });

  it("limits typing like 作曲's 曲タイトル, and leaves an IME composition alone", () => {
    const code = readFileSync(fileURLToPath(new URL("../LibraryPage.tsx", import.meta.url)), "utf8");
    const at = code.indexOf('aria-label="曲名"');
    expect(at).toBeGreaterThan(-1);
    const input = code.slice(code.lastIndexOf("<input", at), code.indexOf("/>", at));
    const edit = code.slice(code.indexOf("const onTitleEdit"), code.indexOf("const finishRename"));
    // what is over the limit comes off the inserted text, not off the end of the name
    expect(edit).toMatch(/editedTitle\(prev, el\.value, el\.selectionEnd\)/);
    expect(input).toMatch(/onChange=\{\(e\) => \(\(e\.nativeEvent as InputEvent\)\.isComposing \? setTitle\(e\.target\.value\) : onTitleEdit\(e\.target, title\)\)\}/);
    expect(input).toMatch(/onCompositionEnd=/);
    // Enter that commits an IME conversion does not commit the rename
    expect(input).toMatch(/if \(e\.nativeEvent\.isComposing\) return;/);
  });
});
