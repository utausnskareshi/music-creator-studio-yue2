// Piano-roll hit areas: notes are edited only where they are drawn (not under the header or the keys column).
import { describe, expect, it } from "vitest";
import { inNoteArea } from "../PianoRoll";

describe("inNoteArea", () => {
  it("is the grid right of the keys column and below the header", () => {
    expect(inNoteArea(46, 40)).toBe(true);
    expect(inNoteArea(500, 300)).toBe(true);
  });

  it("excludes the header (chords, sections, bar numbers) and the keys column, where hidden notes lie", () => {
    // a right-click on a chord name at y=25 hit the F4 note scrolled under the header and deleted it
    expect(inNoteArea(300, 25)).toBe(false);
    expect(inNoteArea(300, 39)).toBe(false);
    // a right-click on a piano key hit a note left of the visible grid
    expect(inNoteArea(20, 200)).toBe(false);
    expect(inNoteArea(45, 200)).toBe(false);
  });
});
