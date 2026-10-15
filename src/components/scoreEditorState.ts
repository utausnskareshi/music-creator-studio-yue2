// Score editor state rules: undo bookkeeping, the tempo field, notices and file imports (kept apart from React so
// they can be unit-tested).
import { VOICE_LABEL, type Score } from "../abc/model";
import type { IrregularBar } from "../abc/parse";
import { liveSelection } from "../abc/edit";

export interface UndoEntry {
  score: Score;
  /** keptBars at the time (see baseBarsRef in ScoreEditor) */
  base: number;
  /** the score had been edited at the time (false: it was still the text as taken in) */
  dirty: boolean;
  /** the text the score stood for at the time (see currentScoreAbc) */
  source: string;
  /** pushed by a rebase commit (text applied, ABC / MIDI imported): the next score's note ids were numbered anew, so they name other notes than this one's */
  rebased?: boolean;
}

/**
 * The selection after undoing to `entry`: ids that still exist in its score (an ordinary undo keeps what is
 * selected), or nothing when the undo crosses a rebase (the same ids name unrelated notes there).
 */
export function undoSelection(entry: UndoEntry, selected: Set<number>): Set<number> {
  return entry.rebased ? new Set() : liveSelection(entry.score.notes, selected);
}

export const UNDO_LIMIT = 100;

/** Push an entry; the oldest ones are dropped beyond `limit`. */
export function pushUndoEntry<T>(stack: T[], entry: T, limit = UNDO_LIMIT): void {
  stack.push(entry);
  while (stack.length > limit) stack.shift();
}

/**
 * The ABC to show and pass on after undoing to `entry`: the text as taken in when the entry was still unedited
 * (so an undo back to the loaded score sends it verbatim again), else the serialized score.
 */
export function undoText(entry: UndoEntry, serialize: (s: Score) => string): string {
  return entry.dirty ? serialize(entry.score) : entry.source;
}

/**
 * One undo entry per piano-roll gesture (a drag is many updates). `step()` for each update during the gesture:
 * true only for the first, which pushes the state from before the gesture. `finish()` for the commit that ends
 * it, or for any edit that is not part of a gesture: true when that commit must push the entry itself (nothing
 * was pushed by a step). `cancel()` for a gesture that ended where it began: true when a step pushed the entry,
 * which the caller then pops to go back to the state before the gesture. `start()` forgets an unfinished gesture
 * (also called for every other commit, so a gesture left open can never swallow a later edit's entry).
 */
export function createGestureUndo() {
  let pushed = false;
  return {
    start() {
      pushed = false;
    },
    step(): boolean {
      if (pushed) return false;
      pushed = true;
      return true;
    },
    finish(): boolean {
      const push = !pushed;
      pushed = false;
      return push;
    },
    cancel(): boolean {
      const popped = pushed;
      pushed = false;
      return popped;
    },
  };
}

/** What the editor does with a piano-roll change (onRollChange). */
export type RollChangeAction =
  /** a drag step: shown, not emitted; `pushUndo` for the first step of the drag (the state from before it) */
  | { kind: "preview"; pushUndo: boolean }
  /** the drag ended where it began: `pop` the entry its first step pushed and restore it (nothing is emitted) */
  | { kind: "revert"; pop: boolean }
  /** an edit to keep: committed and emitted, pushing its own undo entry unless the drag's first step did */
  | { kind: "commit"; withUndo: boolean };

/** The action for a piano-roll change, advancing the gesture tracker (one undo entry and one emit per drag). */
export function rollChangeAction(gesture: ReturnType<typeof createGestureUndo>, opts?: { gesture?: boolean; revert?: boolean }): RollChangeAction {
  if (opts?.gesture) return { kind: "preview", pushUndo: gesture.step() };
  if (opts?.revert) return { kind: "revert", pop: gesture.cancel() };
  return { kind: "commit", withUndo: gesture.finish() };
}

export const TEMPO_MIN = 20;
export const TEMPO_MAX = 300;

/**
 * The tempo to commit from the tempo field's text: rounded and clamped to TEMPO_MIN..TEMPO_MAX; null when the text
 * is empty or not a number (the field goes back to the score's tempo) or the tempo would not change.
 */
export function tempoFromInput(draft: string, current: number): number | null {
  if (!draft.trim()) return null;
  const n = Math.round(Number(draft));
  if (!Number.isFinite(n)) return null;
  const bpm = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, n));
  return bpm === current ? null : bpm;
}

/** "（ボーカル 2 小節目・伴奏声部 2 小節目）": the irregular bars as the notices name them (at most three, then a count). */
export function irregularBarList(bars: IrregularBar[]): string {
  const shown = bars.slice(0, 3).map((b) => `${VOICE_LABEL[b.voice]} ${b.bar} 小節目`);
  return `（${shown.join("・")}${bars.length > 3 ? ` ほか ${bars.length - 3} か所` : ""}）`;
}

/**
 * The notice for bars written shorter or longer than the meter (parseAbcDetailed): the score keeps the meter's bar
 * grid, so their later bar lines move when it is written back. `rewritten`: that already happened (the text was
 * applied or a file imported, and the text tab shows the result); else it happens at the first edit.
 */
export function irregularBarsNotice(bars: IrregularBar[], rewritten: boolean): string | null {
  if (bars.length === 0) return null;
  const where = irregularBarList(bars);
  return rewritten
    ? `小節の長さが拍子と合わない小節があったため${where}、それより後の小節線を拍子どおりの位置に書き直しました（音の時間位置は変わりません）`
    : `小節の長さが拍子と合わない小節があります${where}。ピアノロールは拍子どおりの小節線で表示しています。編集すると、それより後の小節線はこの位置に書き直されます`;
}

export type PickedFile = { kind: "file"; bytes: Uint8Array } | { kind: "none" } | { kind: "stale" };

/**
 * An import's file dialog (`pick`) and file read. Both wait while the app goes on: when `isCurrent` turns false
 * after either (another score was loaded, or the editor was unmounted), the result is "stale" and must not be
 * applied: it would be built on the previous score and reach the page as an edit of the wrong one.
 */
export async function pickAndRead(pick: () => Promise<string | string[] | null>, read: (path: string) => Promise<ArrayLike<number>>, isCurrent: () => boolean): Promise<PickedFile> {
  const path = await pick();
  if (typeof path !== "string") return { kind: "none" };
  if (!isCurrent()) return { kind: "stale" };
  const bytes = await read(path);
  if (!isCurrent()) return { kind: "stale" };
  return { kind: "file", bytes: new Uint8Array(bytes) };
}

/**
 * Whether the editor holds changes that were not rendered or saved (reported through onDirtyChange): an edited
 * score (`dirty`, also after the text echo of a piano-roll edit) or ABC text typed in the text tab and not applied
 * to the score yet (`text` differs from the `source` the score was taken from).
 */
export function hasUnsavedScoreEdits(dirty: boolean, text: string, source: string): boolean {
  return dirty || text !== source;
}
