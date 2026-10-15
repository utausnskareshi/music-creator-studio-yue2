import { describe, expect, it } from "vitest";
import { parseAbc, parseAbcDetailed, type IrregularBar } from "../../abc/parse";
import { serializeAbc } from "../../abc/serialize";
import { createGestureUndo, hasUnsavedScoreEdits, irregularBarList, irregularBarsNotice, pickAndRead, pushUndoEntry, rollChangeAction, tempoFromInput, undoSelection, undoText, UNDO_LIMIT, type UndoEntry } from "../scoreEditorState";

/**
 * The editor's PianoRoll onChange wiring (ScoreEditor.onRollChange through rollChangeAction / commit / undo) against a
 * plain undo stack; `emitted` lists what reached the parent.
 * `edit`: a commit from outside the roll (keyboard, toolbar), which pushes its own entry.
 */
function editor() {
  const gesture = createGestureUndo();
  const stack: string[] = [];
  const emitted: string[] = [];
  let state = "loaded";
  const commit = (next: string, withUndo: boolean) => {
    if (withUndo) pushUndoEntry(stack, state);
    gesture.start();
    state = next;
    emitted.push(next);
  };
  return {
    stack,
    emitted,
    get state() {
      return state;
    },
    start: () => gesture.start(),
    change(next: string, isGesture = false) {
      const a = rollChangeAction(gesture, { gesture: isGesture });
      if (a.kind === "preview") {
        if (a.pushUndo) pushUndoEntry(stack, state);
        state = next;
      } else if (a.kind === "commit") commit(next, a.withUndo);
    },
    revert(next = "drag start") {
      const a = rollChangeAction(gesture, { revert: true });
      const prev = a.kind === "revert" && a.pop ? stack.pop() : undefined;
      if (prev !== undefined) state = prev;
      else commit(next, true);
    },
    edit(next: string) {
      pushUndoEntry(stack, state);
      gesture.start(); // commit
      state = next;
    },
    undo() {
      const prev = stack.pop();
      if (prev === undefined) return;
      gesture.start();
      state = prev;
    },
  };
}

describe("one undo entry per piano-roll gesture", () => {
  it("a drag of many steps pushes once, holding the state before the drag", () => {
    const e = editor();
    e.change("edit 1"); // a plain edit before the drag
    e.start();
    for (let i = 0; i < 40; i++) e.change(`drag ${i}`, true);
    e.change("drag end");
    expect(e.stack).toEqual(["loaded", "edit 1"]);
    // the steps were only shown: the parent got the edit before the drag and the drag's end, once each
    expect(e.emitted).toEqual(["edit 1", "drag end"]);
    e.change("delete"); // later edits outside a gesture push again
    expect(e.stack).toEqual(["loaded", "edit 1", "drag end"]);
  });

  it("a click that only selects pushes nothing; a create gesture pushes once", () => {
    const e = editor();
    e.start(); // mousedown on a note, no movement, no change
    expect(e.stack).toEqual([]);
    e.start();
    e.change("created", true); // the note is created at mousedown
    e.change("longer", true);
    e.change("longer"); // mouse up
    expect(e.stack).toEqual(["loaded"]);
  });

  it("a revert with nothing pushed keeps the drag-start notes as an edit of their own", () => {
    const e = editor();
    e.start();
    e.revert("drag start");
    expect(e.state).toBe("drag start");
    expect(e.stack).toEqual(["loaded"]);
    expect(e.emitted).toEqual(["drag start"]);
  });

  it("a drag that ends where it began goes back to the state before it and leaves no entry", () => {
    const e = editor();
    e.start(); // mousedown on a note's right edge
    e.change("longer", true);
    e.change("original length", true); // shrunk back: PianoRoll sends a revert, not a commit
    e.revert();
    expect(e.state).toBe("loaded");
    expect(e.stack).toEqual([]);
    expect(e.emitted).toEqual([]);
    // later edits keep one entry each: a keyboard edit, then a right-click delete (no gesture start)
    e.edit("up");
    e.change("deleted");
    expect(e.stack).toEqual(["loaded", "up"]);
    e.undo();
    expect(e.state).toBe("up"); // undoing the delete keeps the keyboard edit
  });

  it("an edit outside the roll ends a gesture left open, so the next roll edit still pushes", () => {
    const e = editor();
    e.start();
    e.change("drag", true); // a step whose drag never sent its end
    e.edit("up");
    e.change("deleted");
    expect(e.stack).toEqual(["loaded", "drag", "up"]);
  });

  it("drops the oldest entries beyond the limit", () => {
    const s: number[] = [];
    for (let i = 0; i < UNDO_LIMIT + 5; i++) pushUndoEntry(s, i);
    expect(s).toHaveLength(UNDO_LIMIT);
    expect(s[0]).toBe(5);
  });
});

describe("undoSelection", () => {
  const score = parseAbc("X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal\nV: Ins\nK:C\nV: Vocal\nC4D4E4F4|\nV: Ins\nC16|\n");
  const entry = (rebased?: boolean): UndoEntry => ({ score, base: score.bars, dirty: true, source: "", rebased });
  it("keeps the ids that still exist for an ordinary undo", () => {
    const ids = score.notes.map((n) => n.id);
    expect([...undoSelection(entry(), new Set([ids[0], 999]))]).toEqual([ids[0]]);
  });
  it("clears the selection when the undo crosses a rebase (the ids name other notes there)", () => {
    expect(undoSelection(entry(true), new Set(score.notes.map((n) => n.id))).size).toBe(0);
  });
});

describe("undoText", () => {
  const src = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal\nV: Ins\nK:C\nV: Vocal\nz6z2 C8|\nV: Ins\nC16|\n';
  const score = parseAbc(src);
  it("gives the verbatim source when undoing back to the unedited score", () => {
    const e: UndoEntry = { score, base: score.bars, dirty: false, source: src };
    expect(undoText(e, serializeAbc)).toBe(src);
  });
  it("serializes an edited score", () => {
    const e: UndoEntry = { score, base: score.bars, dirty: true, source: "stale" };
    expect(undoText(e, serializeAbc)).toBe(serializeAbc(score));
  });
});

describe("tempoFromInput", () => {
  it("rounds and clamps a typed tempo, and skips a no-op", () => {
    expect(tempoFromInput("90", 120)).toBe(90);
    expect(tempoFromInput("120.6", 100)).toBe(121);
    expect(tempoFromInput("9", 120)).toBe(20);
    expect(tempoFromInput("999", 120)).toBe(300);
    expect(tempoFromInput("120", 120)).toBeNull();
  });
  it("ignores an empty or invalid field (it goes back to the score's tempo)", () => {
    expect(tempoFromInput("", 120)).toBeNull();
    expect(tempoFromInput("  ", 120)).toBeNull();
    expect(tempoFromInput("abc", 120)).toBeNull();
  });
});

describe("irregularBarsNotice", () => {
  it("says nothing for a regular score", () => {
    expect(irregularBarsNotice([], true)).toBeNull();
  });
  it("names the bars, and whether the bar lines were already rewritten", () => {
    const bars: IrregularBar[] = [
      { voice: "Vocal", bar: 1 },
      { voice: "Ins", bar: 1 },
    ];
    expect(irregularBarsNotice(bars, true)).toBe(
      "小節の長さが拍子と合わない小節があったため（ボーカル 1 小節目・伴奏声部 1 小節目）、それより後の小節線を拍子どおりの位置に書き直しました（音の時間位置は変わりません）",
    );
    expect(irregularBarsNotice(bars, false)).toBe(
      "小節の長さが拍子と合わない小節があります（ボーカル 1 小節目・伴奏声部 1 小節目）。ピアノロールは拍子どおりの小節線で表示しています。編集すると、それより後の小節線はこの位置に書き直されます",
    );
  });
  it("lists at most three", () => {
    const bars: IrregularBar[] = [2, 5, 7, 9, 11].map((bar) => ({ voice: "Vocal", bar }));
    expect(irregularBarsNotice(bars, true)).toContain("（ボーカル 2 小節目・ボーカル 5 小節目・ボーカル 7 小節目 ほか 2 か所）");
  });
  it("names the bars with irregularBarList (the Melody chord strip's question uses it too)", () => {
    expect(irregularBarList([{ voice: "Vocal", bar: 1 }, { voice: "Ins", bar: 1 }])).toBe("（ボーカル 1 小節目・伴奏声部 1 小節目）");
    const bars: IrregularBar[] = [2, 5, 7, 9].map((bar) => ({ voice: "Ins", bar }));
    expect(irregularBarList(bars)).toBe("（伴奏声部 2 小節目・伴奏声部 5 小節目・伴奏声部 7 小節目 ほか 1 か所）");
    expect(irregularBarsNotice(bars, false)).toContain(irregularBarList(bars));
  });
  it("is what the editor shows for a pickup applied as text", () => {
    const text = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal\nV: Ins\nK:C\nV: Vocal\nG4|"C"c4B4A4G4|"F"A16|\nV: Ins\nz4|C16|F16|\n';
    expect(irregularBarsNotice(parseAbcDetailed(text).irregularBars, true)).toContain("ボーカル 1 小節目・伴奏声部 1 小節目");
  });
});

describe("pickAndRead (an import's file dialog and read)", () => {
  /** a promise the test resolves later, as the native dialog and the file read do */
  function later<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  /** the editor's load counter and mount flag (loadRef / mountedRef) */
  function editorRefs() {
    const refs = { load: 0, mounted: true };
    const loaded = refs.load;
    return { refs, isCurrent: () => refs.mounted && refs.load === loaded };
  }

  it("gives the file's bytes when nothing changed", async () => {
    const { isCurrent } = editorRefs();
    const r = await pickAndRead(async () => "a.mid", async () => [1, 2, 3], isCurrent);
    expect(r).toEqual({ kind: "file", bytes: new Uint8Array([1, 2, 3]) });
  });

  it("gives none when the dialog is cancelled", async () => {
    const { isCurrent } = editorRefs();
    let read = 0;
    expect(await pickAndRead(async () => null, async () => (read++, []), isCurrent)).toEqual({ kind: "none" });
    expect(read).toBe(0);
  });

  it("drops the import when another score loads while the dialog is open (a followed song finished)", async () => {
    const { refs, isCurrent } = editorRefs();
    const dialog = later<string | null>();
    let read = 0;
    const result = pickAndRead(() => dialog.promise, async () => (read++, [1]), isCurrent);
    refs.load++; // the load effect of song 2
    dialog.resolve("a.mid");
    expect(await result).toEqual({ kind: "stale" });
    expect(read).toBe(0);
  });

  it("drops the import when the editor is unmounted during the read (a transcription remounted it)", async () => {
    const { refs, isCurrent } = editorRefs();
    const file = later<number[]>();
    const result = pickAndRead(async () => "a.abc", () => file.promise, isCurrent);
    await Promise.resolve();
    refs.mounted = false;
    file.resolve([1]);
    expect(await result).toEqual({ kind: "stale" });
  });
});

describe("hasUnsavedScoreEdits", () => {
  it("reports an edited score or unapplied ABC text", () => {
    expect(hasUnsavedScoreEdits(false, "X:1", "X:1")).toBe(false);
    // a piano-roll edit stays unsaved after its serialized text became the source (the echo)
    expect(hasUnsavedScoreEdits(true, "X:1", "X:1")).toBe(true);
    expect(hasUnsavedScoreEdits(false, "X:1\nK:D", "X:1")).toBe(true);
    expect(hasUnsavedScoreEdits(true, "X:1\nK:D", "X:1")).toBe(true);
  });
});
