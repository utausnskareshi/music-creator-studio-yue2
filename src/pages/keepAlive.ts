// Pages that stay mounted while another page is shown, and the rules for what a hidden page may do. The work
// pages keep their input and the results of runs that finish while the user is elsewhere; everything with a
// global effect (sound, polling, dialogs, loading the library selection into a form) waits until the page is
// shown again (see PageActive.tsx for the hooks).
import type { Page } from "../store";
import type { TimedLine } from "../export/syncedLines";

/** Sidebar names of the pages (also used in notices about a hidden page). */
export const PAGE_LABEL: Record<Page, string> = {
  compose: "作曲",
  cover: "カバー / 耳コピ",
  edit: "AI 編集",
  separate: "ボーカル分離",
  export: "書き出し",
  library: "ライブラリ",
  settings: "設定",
};

/**
 * Pages kept mounted (hidden) after their first visit. ライブラリ and 設定 are built afresh on every visit: they
 * show the store and the saved settings, and 設定 re-reads the paths and component status when it opens.
 */
export const KEPT_PAGES: readonly Page[] = ["compose", "cover", "edit", "separate", "export"];

export const isKeptPage = (p: Page): boolean => KEPT_PAGES.includes(p);

/** The visited kept pages after showing `page` (the same set when nothing changes, so no re-render follows). */
export function withVisit(visited: ReadonlySet<Page>, page: Page): ReadonlySet<Page> {
  if (!isKeptPage(page) || visited.has(page)) return visited;
  return new Set([...visited, page]);
}

/**
 * The pages to render, in a fixed order (a page's place in the tree never changes, so React keeps its state):
 * every visited kept page, plus `page` itself when it is not kept.
 */
export function mountedPages(visited: ReadonlySet<Page>, page: Page): Page[] {
  const order: Page[] = [...KEPT_PAGES, "library", "settings"];
  return order.filter((p) => (isKeptPage(p) ? visited.has(p) || p === page : p === page));
}

/** Scroll position of the shared page container when `page` is shown: where a kept page was left, else the top. */
export function restoredScroll(saved: Partial<Record<Page, number>>, page: Page): number {
  return isKeptPage(page) ? Math.max(0, saved[page] ?? 0) : 0;
}

export type SelectionLoad = "none" | "load" | "ask";

export interface SelectionLoadInput {
  /** the page is shown (a hidden page never loads: it looks again when it is shown) */
  active: boolean;
  /** the library selection this page would load (null: nothing loadable, e.g. no song or one still rendering) */
  selectedId: string | null;
  /** the song the form was loaded from (null: nothing yet, a file picked on the page, or input without a song) */
  loadedId: string | null;
  /**
   * the loadable selection the page last saw while shown (it loaded it, asked about it, or it already was the
   * form's song): only a selection made since then is followed, so a selection the user declined to load is not
   * asked about again (e.g. on every switch between two pages that hold work on different songs)
   */
  seenId?: string | null;
  /** the form holds work that loading would replace (a conversation, edits, timings …) */
  hasWork: boolean;
  /** what the form holds can still be kept (書き出し: its song still exists, or it is a picked file) */
  keepable: boolean;
}

/**
 * What a page whose form is loaded from the library selection (AI 編集, 書き出し) does with the selection. It
 * follows the selection only while it is shown, and only a selection it has not seen yet. When the selection
 * moved on while the page was hidden (a pick in ライブラリ, a new song selected on 作曲), the page loads the new
 * song at once if nothing would be lost, and asks first when the form holds work. Keeping the work leaves the
 * selection as it is: the page works on its own song (formSongOf), never on the selection, and offers to load
 * the selection later (unloadedSelectionHint).
 */
export function selectionLoad(i: SelectionLoadInput): SelectionLoad {
  if (!i.active || i.selectedId === null || i.selectedId === i.loadedId || i.selectedId === i.seenId) return "none";
  return i.hasWork && i.keepable ? "ask" : "load";
}

/**
 * The song a page's form belongs to: the library entry with the form's id, else the entry as last seen (deleted
 * meanwhile: its title and generation settings still describe the work). Null when the form has no song.
 * Everything tied to the form (song folder, hiragana lyrics, seed, sampling) is read from it, not from the library
 * selection, which may be another song while the page keeps its work.
 */
export function formSongOf<T extends { id: string }>(songs: readonly T[], id: string | null, last: T | null = null): T | null {
  if (id === null) return null;
  return songs.find((s) => s.id === id) ?? (last !== null && last.id === id ? last : null);
}

/** The fields of a form as loaded, compared with the fields now (strings; null counts as empty). */
export function formChanged(loaded: Record<string, string | null>, now: Record<string, string | null>): boolean {
  const keys = new Set([...Object.keys(loaded), ...Object.keys(now)]);
  for (const k of keys) if ((loaded[k] ?? "") !== (now[k] ?? "")) return true;
  return false;
}

/** 書き出し: timings that are not the placeholder grid (aligned, tapped, typed or interpolated from those). */
export function hasLineTimings(lines: readonly TimedLine[]): boolean {
  return lines.some((l) => l.src !== "placeholder");
}

/** The question's load choice, and the button that loads a selection the page did not load. */
export const SELECTION_LOAD_LABEL = "選択中の曲を読み込む";

export interface SelectionSwitchQuestion {
  title: string;
  message: string;
  note: string;
  loadLabel: string;
  keepLabel: string;
}

/**
 * The question of selectionLoad's "ask": `page` holds work (`work`, e.g. 対話 3 件) on `current` (a song title, a
 * file name, or "" for input without a song), and the library selection is now `next`.
 */
export function selectionSwitchQuestion(o: { page: string; current: string; next: string; work: string[] }): SelectionSwitchQuestion {
  const what = o.work.length ? `（${o.work.join("・")}）` : "";
  const holder = o.current ? `「${o.current}」の作業中の内容${what}` : `曲を選ばずに入力した作業中の内容${what}`;
  return {
    title: "作業中の内容があります",
    message: `${o.page}画面には${holder}があります。ライブラリで選択中の「${o.next}」を読み込むと、この内容は失われます。`,
    note: `続ける場合、ライブラリの選択はそのままで、この画面では${o.current ? `「${o.current}」の` : "今の"}作業を続けます。選択中の曲は、あとから画面の「${SELECTION_LOAD_LABEL}」で読み込めます。`,
    loadLabel: SELECTION_LOAD_LABEL,
    keepLabel: "今の作業を続ける",
  };
}

/** Shown while the library selection (`next`) is not the song of the page's form (`current`; "" = no song). */
export function unloadedSelectionHint(next: string, current: string): string {
  const kept = current ? `「${current}」の作業を続けています` : "曲を選ばずに入力した作業を続けています";
  return `ライブラリで選択中の「${next}」はこの画面に読み込んでいません（${kept}）。`;
}

/** A completion notice of a page that is not shown names the page, so the user knows where the result is. */
export function noticeFrom(text: string, active: boolean, label: string): string {
  return active || !label ? text : `${text}（「${label}」画面）`;
}

/** Notice for a question a hidden page asked: it is shown when the user opens that page. */
export function deferredQuestionNotice(label: string, title: string): string {
  return `「${label}」画面で確認が必要です（${title}）。画面を開くと表示します`;
}
