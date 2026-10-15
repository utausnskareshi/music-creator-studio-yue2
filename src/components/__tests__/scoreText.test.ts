import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbc } from "../../abc/parse";
import { serializeAbc } from "../../abc/serialize";
import { currentScoreAbc } from "../scoreText";

const fx = (name: string) => readFileSync(join(__dirname, "..", "..", "abc", "__fixtures__", name), "utf8");

// A SheetSage2 "full" transcription writes a bar rest split in two (z6z2); serializing merges it.
const FULL = [
  "X:1",
  "T:",
  "M:2/4",
  "L:1/16",
  "Q:1/4=100",
  'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
  'V: Ins clef=treble name="Ins Melody" snm="Inst."',
  "K:D",
  "% verse",
  "V: Vocal",
  "d4e4|f8|",
  "V: Ins",
  '"D"z6z2|"A"A,8|',
  "",
].join("\n");

describe("currentScoreAbc", () => {
  it("passes an unedited score on verbatim (split rests of a full transcription stay)", () => {
    const score = parseAbc(FULL);
    const serialized = serializeAbc(score);
    expect(serialized).not.toBe(FULL);
    const out = currentScoreAbc({ dirty: false, hasScore: true, source: FULL, serialized, text: FULL });
    expect(out).toBe(FULL);
    expect(out).toContain('"D"z6z2|');
  });

  it("passes an unedited score with key and meter changes on verbatim too", () => {
    const text = fx("ss2_meter_full.abc");
    const serialized = serializeAbc(parseAbc(text));
    expect(currentScoreAbc({ dirty: false, hasScore: true, source: text, serialized, text })).toBe(text);
    expect(currentScoreAbc({ dirty: true, hasScore: true, source: text, serialized, text: serialized })).toBe(serialized);
  });

  it("sends the serialized score after an edit", () => {
    const serialized = serializeAbc(parseAbc(FULL));
    // after commit the editor's source is the serialized text; the rule must not depend on that
    expect(currentScoreAbc({ dirty: true, hasScore: true, source: FULL, serialized, text: serialized })).toBe(serialized);
  });

  it("serializes on demand, and only for an edited score", () => {
    let calls = 0;
    const serialized = () => {
      calls++;
      return "SERIALIZED";
    };
    expect(currentScoreAbc({ dirty: false, hasScore: true, source: FULL, serialized, text: FULL })).toBe(FULL);
    expect(calls).toBe(0);
    expect(currentScoreAbc({ dirty: true, hasScore: true, source: FULL, serialized, text: FULL })).toBe("SERIALIZED");
    expect(calls).toBe(1);
    expect(currentScoreAbc({ dirty: true, hasScore: true, source: FULL, serialized: () => "", text: "TYPED" })).toBe("TYPED");
  });

  it("falls back to the text tab without a score", () => {
    expect(currentScoreAbc({ dirty: false, hasScore: false, source: "BAD", serialized: "", text: "TYPED" })).toBe("TYPED");
  });
});
