// Piano-roll gesture rules (edit.ts): move / resize / create / box select, computed from the drag-start notes.
import { describe, expect, it } from "vitest";
import { boxSelect, clampMoveDelta, createNote, dragEndChange, editKeyDuringDrag, liveSelection, moveGesture, noteDragEnd, resizeGesture, settleMoved } from "../edit";
import type { Note } from "../model";

const note = (id: number, start: number, duration: number, pitch = 60, voice: Note["voice"] = "Vocal"): Note => ({ id, voice, start, duration, pitch });
const LO = 36;
const HI = 96;

describe("the end of a drag keeps its own last step", () => {
  // The piano roll records the notes each step sends (`last`); the end is built from them, so a step and the mouse
  // up handled before a re-render still end with that step (not with the previous render's score).
  it("commits the last step of a move, a resize and a create", () => {
    const base = [note(1, 0, 256), note(2, 512, 256)];
    const ids = new Set([1]);
    const moved = moveGesture(base, ids, 0, 2);
    const end = dragEndChange({ kind: "move", moved: true, dTick: 0, dPitch: 2, ids, base, last: moved });
    expect(end).toEqual({ notes: settleMoved(moved, ids), revert: false });
    expect(end!.notes.find((n) => n.id === 1)!.pitch).toBe(62);
    const longer = resizeGesture(base, base[0], 384);
    expect(dragEndChange({ kind: "resize", changed: true, duration: 384, note: base[0], base, last: longer })).toEqual({ notes: longer, revert: false });
    const created = createNote(base, "Vocal", 1024, 64, 64);
    expect(dragEndChange({ kind: "create", base, last: created.notes })).toEqual({ notes: created.notes, revert: false });
  });

  it("reverts a drag whose last step went back to where it began, and ignores a click", () => {
    const base = [note(1, 0, 256)];
    expect(dragEndChange({ kind: "move", moved: true, dTick: 0, dPitch: 0, ids: new Set([1]), base, last: base })).toEqual({ notes: base, revert: true });
    expect(dragEndChange({ kind: "resize", changed: true, duration: 256, note: base[0], base, last: base })).toEqual({ notes: base, revert: true });
    expect(dragEndChange({ kind: "move", moved: false, dTick: 0, dPitch: 0, ids: new Set([1]), base })).toBeNull();
    expect(dragEndChange({ kind: "resize", changed: false, duration: 256, note: base[0], base })).toBeNull();
  });
});

describe("move drag", () => {
  it("keeps the spacing at the start of the song instead of piling notes up at tick 0", () => {
    const base = [note(1, 256, 256), note(2, 512, 256), note(3, 768, 256)];
    const ids = new Set([1, 2, 3]);
    const { dTick, dPitch } = clampMoveDelta(base, -2048, 0, LO, HI);
    expect(dTick).toBe(-256);
    const moved = settleMoved(moveGesture(base, ids, dTick, dPitch), ids);
    expect(moved.map((n) => n.start).sort((a, b) => a - b)).toEqual([0, 256, 512]);
    expect(moved).toHaveLength(3);
  });

  it("never pushes a note further out of the drawn rows, and keeps out-of-view pitches on a sideways drag", () => {
    const base = [note(1, 0, 256, 24), note(2, 256, 256, 60)]; // 24 is below the rows (36..96)
    // sideways: pitch untouched
    expect(clampMoveDelta(base, 512, 0, LO, HI)).toEqual({ dTick: 512, dPitch: 0 });
    // down: refused (the low note would go further out); up: allowed
    expect(clampMoveDelta(base, 0, -5, LO, HI).dPitch).toBe(0);
    expect(clampMoveDelta(base, 0, 7, LO, HI).dPitch).toBe(7);
    // a selection inside the rows stops at their edges, as one block
    const inside = [note(1, 0, 256, 90), note(2, 256, 256, 80)];
    expect(clampMoveDelta(inside, 0, 12, LO, HI).dPitch).toBe(6);
    const moved = moveGesture(inside, new Set([1, 2]), 0, 6);
    expect(moved.map((n) => n.pitch)).toEqual([96, 86]);
  });

  it("moves only the selected notes from the drag-start state", () => {
    const base = [note(1, 0, 256), note(2, 256, 256, 62)];
    const out = moveGesture(base, new Set([2]), 256, 1);
    expect(out[0]).toBe(base[0]);
    expect(out[1]).toMatchObject({ start: 512, pitch: 63 });
    expect(base[1]).toMatchObject({ start: 256, pitch: 62 }); // the snapshot is not changed
  });
});

describe("resize / create drag", () => {
  it("restores a neighbour the note passed over when it is shortened again", () => {
    const c = note(1, 0, 64);
    const d = note(2, 128, 64, 62);
    const base = [c, d];
    const grown = resizeGesture(base, c, 256); // covers D completely: D is dropped
    expect(grown.map((n) => n.id).sort()).toEqual([1]);
    const back = resizeGesture(base, c, 64); // computed from the drag start again
    expect(back.find((n) => n.id === 2)).toEqual(d);
    expect(back.find((n) => n.id === 1)?.duration).toBe(64);
  });

  it("creates a note with the next id and clips the note it overlaps", () => {
    const base = [note(4, 0, 512), note(7, 0, 512, 50, "Ins")];
    const r = createNote(base, "Vocal", 256, 64, 64);
    expect(r.note).toEqual({ id: 8, voice: "Vocal", start: 256, duration: 64, pitch: 64 });
    expect(r.notes.find((n) => n.id === 4)?.duration).toBe(256);
    expect(r.notes.find((n) => n.id === 7)).toEqual(base[1]); // other voice untouched
  });
});

describe("selection", () => {
  it("box select adds the touched notes (edges included) to the base selection", () => {
    const notes = [note(1, 0, 256, 60), note(2, 256, 256, 64), note(3, 1024, 256, 60), note(4, 256, 256, 72)];
    expect([...boxSelect(notes, 256, 512, 60, 64, [9])].sort()).toEqual([1, 2, 9]);
    expect([...boxSelect(notes, 256, 512, 60, 64)].sort()).toEqual([1, 2]);
  });

  it("keeps only ids that are notes of the score", () => {
    expect([...liveSelection([note(1, 0, 1), note(3, 0, 1)], new Set([1, 2, 3]))]).toEqual([1, 3]);
  });
});

describe("end of a note drag", () => {
  const n = note(1, 0, 256);
  it("reverts a resize that comes back to the original length instead of keeping a no-op edit", () => {
    expect(noteDragEnd({ kind: "resize", changed: true, duration: 256, note: n })).toBe("revert");
    expect(noteDragEnd({ kind: "resize", changed: true, duration: 512, note: n })).toBe("commit");
    expect(noteDragEnd({ kind: "resize", changed: false, duration: 256, note: n })).toBe("none");
  });
  it("reverts a move brought back to where it started; a click without movement sends nothing", () => {
    expect(noteDragEnd({ kind: "move", moved: true, dTick: 0, dPitch: 0 })).toBe("revert");
    expect(noteDragEnd({ kind: "move", moved: true, dTick: 64, dPitch: 0 })).toBe("commit");
    expect(noteDragEnd({ kind: "move", moved: true, dTick: 0, dPitch: -1 })).toBe("commit");
    expect(noteDragEnd({ kind: "move", moved: false, dTick: 0, dPitch: 0 })).toBe("none");
  });
  it("always keeps a created note", () => {
    expect(noteDragEnd({ kind: "create" })).toBe("commit");
  });
});

describe("edit keys while a note drag is held", () => {
  const key = (k: string, ctrlKey = false, metaKey = false) => ({ key: k, ctrlKey, metaKey });

  it("why: a drag's end is built from its start notes, so a note deleted in between comes back", () => {
    const base = [note(1, 0, 256), note(2, 1024, 256, 64)];
    const last = moveGesture(base, new Set([1]), 512, 0); // the step after a Delete of note 1
    const end = dragEndChange({ kind: "move", moved: true, dTick: 512, dPitch: 0, ids: new Set([1]), base, last });
    expect(end!.notes.map((n) => n.id).sort()).toEqual([1, 2]);
  });

  it("swallows Delete / Backspace, the arrows and Ctrl+Z during a move, resize or create drag", () => {
    for (const kind of ["move", "resize", "create"] as const) {
      for (const k of [key("Delete"), key("Backspace"), key("ArrowUp"), key("ArrowDown"), key("ArrowLeft"), key("ArrowRight"), key("z", true), key("Z", true), key("z", false, true)]) {
        expect([kind, k.key, editKeyDuringDrag(kind, k)]).toEqual([kind, k.key, true]);
      }
    }
  });

  it("leaves the keys alone without a note drag, and keys that do not edit", () => {
    for (const k of [key("Delete"), key("ArrowUp"), key("z", true)]) {
      expect(editKeyDuringDrag(null, k)).toBe(false);
      expect(editKeyDuringDrag("box", k)).toBe(false);
    }
    for (const k of [key(" "), key("a", true), key("z"), key("Shift")]) expect(editKeyDuringDrag("move", k)).toBe(false);
  });
});
