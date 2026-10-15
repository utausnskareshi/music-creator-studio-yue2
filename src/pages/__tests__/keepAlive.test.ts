import { describe, expect, it } from "vitest";
import {
  KEPT_PAGES,
  PAGE_LABEL,
  SELECTION_LOAD_LABEL,
  deferredQuestionNotice,
  formChanged,
  formSongOf,
  hasLineTimings,
  mountedPages,
  noticeFrom,
  restoredScroll,
  selectionLoad,
  selectionSwitchQuestion,
  unloadedSelectionHint,
  withVisit,
} from "../keepAlive";
import type { Page } from "../../store";
import type { TimedLine } from "../../export/syncedLines";

describe("kept pages", () => {
  it("keeps the work pages mounted after their first visit, and rebuilds ライブラリ / 設定", () => {
    expect(KEPT_PAGES).toEqual(["compose", "cover", "edit", "separate", "export"]);
    let v: ReadonlySet<Page> = new Set();
    v = withVisit(v, "compose");
    expect(mountedPages(v, "compose")).toEqual(["compose"]);
    v = withVisit(v, "library");
    expect([...v]).toEqual(["compose"]);
    // ライブラリ is shown, 作曲 stays mounted behind it
    expect(mountedPages(v, "library")).toEqual(["compose", "library"]);
    v = withVisit(v, "export");
    // a fixed order, whatever the order of the visits
    expect(mountedPages(v, "settings")).toEqual(["compose", "export", "settings"]);
    expect(mountedPages(v, "cover")).toEqual(["compose", "cover", "export"]);
  });

  it("returns the same set when nothing changes (no re-render)", () => {
    const v: ReadonlySet<Page> = new Set<Page>(["compose"]);
    expect(withVisit(v, "compose")).toBe(v);
    expect(withVisit(v, "settings")).toBe(v);
    expect(withVisit(v, "edit")).not.toBe(v);
  });

  it("brings a kept page back where it was left; any other page starts at the top", () => {
    const saved = { compose: 420, library: 900, export: -5 };
    expect(restoredScroll(saved, "compose")).toBe(420);
    expect(restoredScroll(saved, "cover")).toBe(0);
    expect(restoredScroll(saved, "library")).toBe(0);
    expect(restoredScroll(saved, "export")).toBe(0);
  });

  it("names every page like the sidebar", () => {
    expect(PAGE_LABEL.cover).toBe("カバー / 耳コピ");
    expect(Object.keys(PAGE_LABEL).sort()).toEqual(["compose", "cover", "edit", "export", "library", "separate", "settings"]);
  });
});

describe("selectionLoad (AI 編集 / 書き出し follow the library selection)", () => {
  const base = { active: true, selectedId: "b", loadedId: "a", hasWork: false, keepable: true };

  it("never loads on a hidden page", () => {
    expect(selectionLoad({ ...base, active: false })).toBe("none");
    expect(selectionLoad({ ...base, active: false, hasWork: true })).toBe("none");
  });

  it("does nothing for the song already loaded or without a loadable selection", () => {
    expect(selectionLoad({ ...base, selectedId: "a", hasWork: true })).toBe("none");
    expect(selectionLoad({ ...base, selectedId: null })).toBe("none");
  });

  it("loads another song at once when nothing would be lost", () => {
    expect(selectionLoad(base)).toBe("load");
    // the first load of the page
    expect(selectionLoad({ ...base, loadedId: null, keepable: false })).toBe("load");
  });

  it("asks before replacing work that can still be kept", () => {
    expect(selectionLoad({ ...base, hasWork: true })).toBe("ask");
    // work on a picked file (no library song) can be kept too
    expect(selectionLoad({ ...base, loadedId: null, hasWork: true })).toBe("ask");
    // the song of the work was deleted meanwhile: nothing to go back to
    expect(selectionLoad({ ...base, hasWork: true, keepable: false })).toBe("load");
  });

  it("follows only a selection made since the page last looked", () => {
    // declined before (or already seen while shown): not asked again
    expect(selectionLoad({ ...base, hasWork: true, seenId: "b" })).toBe("none");
    expect(selectionLoad({ ...base, seenId: "b" })).toBe("none");
    // a later selection is followed
    expect(selectionLoad({ ...base, hasWork: true, seenId: "c" })).toBe("ask");
    expect(selectionLoad({ ...base, seenId: null })).toBe("load");
  });
});

/**
 * The selection effect of AI 編集 / 書き出し (EditPage / ExportPage followSelection): on every run while shown the
 * page remembers the selection, and "keep" leaves the selection and the form as they are.
 */
interface PageSim {
  loadedId: string | null;
  seenId: string | null;
  hasWork: boolean;
  asked: number;
}
const sim = (loadedId: string | null, hasWork: boolean): PageSim => ({ loadedId, seenId: loadedId, hasWork, asked: 0 });
function show(p: PageSim, selectedId: string | null, answer: "load" | "keep" = "keep") {
  const seen = p.seenId;
  p.seenId = selectedId;
  if (selectedId === null) return;
  const d = selectionLoad({ active: true, selectedId, loadedId: p.loadedId, seenId: seen, hasWork: p.hasWork, keepable: true });
  if (d === "ask") p.asked++;
  if (d === "load" || (d === "ask" && answer === "load")) {
    p.loadedId = selectedId;
    p.hasWork = false;
  }
}

describe("selection sequences across kept pages", () => {
  it("two pages with work on different songs do not ask on every switch", () => {
    // AI 編集 holds a conversation on A; 書き出し holds timings on B, which is selected
    const edit = sim("a", true);
    const exp = sim("b", true);
    const selection = "b";
    show(edit, selection);
    expect(edit.asked).toBe(1);
    for (let i = 0; i < 3; i++) {
      show(exp, selection);
      show(edit, selection);
    }
    expect([edit.asked, exp.asked]).toEqual([1, 0]);
    // both keep their own songs; the selection was never changed by a keep
    expect([edit.loadedId, exp.loadedId]).toEqual(["a", "b"]);
  });

  it("asks each page once about a new pick in ライブラリ", () => {
    const edit = sim("a", true);
    const exp = sim("b", true);
    show(edit, "c");
    show(exp, "c");
    show(edit, "c");
    show(exp, "c");
    expect([edit.asked, exp.asked]).toEqual([1, 1]);
    // picking another song, then the declined one again, is a new selection
    show(edit, "d", "load");
    expect(edit.loadedId).toBe("d");
    edit.hasWork = true;
    show(edit, "c");
    expect(edit.asked).toBe(3);
  });

  it("keeps the work when the selection is cleared or still rendering (nothing loadable)", () => {
    const edit = sim("a", true);
    show(edit, null);
    expect([edit.loadedId, edit.asked]).toEqual(["a", 0]);
    // 書き出し: a queued song is not loadable (null) until it finishes; then it is a new selection
    const exp = sim("a", true);
    show(exp, null);
    show(exp, "q");
    expect(exp.asked).toBe(1);
  });

  it("loads at once when the page holds no work", () => {
    const exp = sim("a", false);
    show(exp, "b");
    expect([exp.loadedId, exp.asked]).toEqual(["b", 0]);
  });
});

describe("formSongOf (the song a page works on, not the selection)", () => {
  const songs = [{ id: "a", title: "春" }, { id: "b", title: "夏" }];
  it("finds the form's song in the library", () => {
    expect(formSongOf(songs, "a")).toEqual({ id: "a", title: "春" });
    expect(formSongOf(songs, null)).toBeNull();
    expect(formSongOf(songs, "x")).toBeNull();
  });
  it("falls back to the song as last seen when it was deleted", () => {
    const last = { id: "x", title: "消えた曲" };
    expect(formSongOf(songs, "x", last)).toBe(last);
    // a stale snapshot of another song is never used
    expect(formSongOf(songs, "y", last)).toBeNull();
    // the library entry wins over the snapshot
    expect(formSongOf(songs, "a", { id: "a", title: "古い題" })?.title).toBe("春");
  });
});

describe("work detection", () => {
  it("compares the form with the form as loaded", () => {
    expect(formChanged({ abc: "X:1", sung: null }, { abc: "X:1", sung: "" })).toBe(false);
    expect(formChanged({ abc: "X:1" }, { abc: "X:2" })).toBe(true);
    expect(formChanged({}, { lyrics: "a" })).toBe(true);
    expect(formChanged({ lyrics: "a" }, {})).toBe(true);
  });

  it("counts any timing but the placeholder grid", () => {
    const l = (src: TimedLine["src"]): TimedLine => ({ text: "x", timeMs: 0, src });
    expect(hasLineTimings([])).toBe(false);
    expect(hasLineTimings([l("placeholder"), l("placeholder")])).toBe(false);
    for (const src of ["aligned", "tapped", "manual", "interpolated"] as const) expect(hasLineTimings([l("placeholder"), l(src)])).toBe(true);
  });
});

describe("texts", () => {
  it("names the page of a notice only while it is hidden", () => {
    expect(noticeFrom("転写が完了しました", true, "カバー / 耳コピ")).toBe("転写が完了しました");
    expect(noticeFrom("転写が完了しました", false, "カバー / 耳コピ")).toBe("転写が完了しました（「カバー / 耳コピ」画面）");
    expect(noticeFrom("x", false, "")).toBe("x");
  });

  it("says where a hidden page's question waits", () => {
    expect(deferredQuestionNotice("作曲", "曲の長さの上限")).toBe("「作曲」画面で確認が必要です（曲の長さの上限）。画面を開くと表示します");
  });

  it("builds the question before another song replaces the work", () => {
    const q = selectionSwitchQuestion({ page: "AI 編集", current: "春の歌", next: "夏の歌", work: ["対話 3 件", "譜面・スタイル・歌詞の変更"] });
    expect(q.message).toBe("AI 編集画面には「春の歌」の作業中の内容（対話 3 件・譜面・スタイル・歌詞の変更）があります。ライブラリで選択中の「夏の歌」を読み込むと、この内容は失われます。");
    expect(q.note).toBe("続ける場合、ライブラリの選択はそのままで、この画面では「春の歌」の作業を続けます。選択中の曲は、あとから画面の「選択中の曲を読み込む」で読み込めます。");
    expect(q.loadLabel).toBe(SELECTION_LOAD_LABEL);
    expect(q.keepLabel).toBe("今の作業を続ける");
    const file = selectionSwitchQuestion({ page: "書き出し", current: "demo.wav", next: "夏の歌", work: [] });
    expect(file.message).toContain("「demo.wav」の作業中の内容があります");
    // input without a song (AI 編集: typed or pasted)
    const none = selectionSwitchQuestion({ page: "AI 編集", current: "", next: "夏の歌", work: ["対話 1 件"] });
    expect(none.message).toBe("AI 編集画面には曲を選ばずに入力した作業中の内容（対話 1 件）があります。ライブラリで選択中の「夏の歌」を読み込むと、この内容は失われます。");
    expect(none.note).toContain("この画面では今の作業を続けます");
  });

  it("says that the selection is not loaded, and what the page holds", () => {
    expect(unloadedSelectionHint("夏の歌", "春の歌")).toBe("ライブラリで選択中の「夏の歌」はこの画面に読み込んでいません（「春の歌」の作業を続けています）。");
    expect(unloadedSelectionHint("夏の歌", "")).toBe("ライブラリで選択中の「夏の歌」はこの画面に読み込んでいません（曲を選ばずに入力した作業を続けています）。");
  });
});
