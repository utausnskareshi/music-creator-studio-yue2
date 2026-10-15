// Degenerate meters and lengths: refused with a message where they come in, never a serializer that runs forever
// (the editor's commit serializes synchronously, so a hang would freeze the WebView).
import { describe, expect, it } from "vitest";
import { AbcParseError, parseAbc, validateAbc } from "../parse";
import { serializeAbc } from "../serialize";
import { editedBars } from "../edit";
import { MAX_BARS, emptyScore, isSupportedMeter, type Score } from "../model";

const HEAD = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n';
const two = (vocal: string, ins = "Z|", head = HEAD) => `${head}V: Vocal\n${vocal}\nV: Ins\n${ins}\n`;
const withMeter = (m: string, vocal = "C4D4E4F4|", ins = "Z|") => two(vocal, ins, HEAD.replace("M:4/4", `M:${m}`));

/** What the editor's commit does with a parsed score (ScoreEditor.commit with rebase). */
const commitLike = (s: Score) => {
  s.bars = editedBars(s.bars || 0, s);
  return serializeAbc(s);
};

describe("meters", () => {
  it("accepts the meters the dialect has", () => {
    for (const m of ["4/4", "3/4", "6/8", "5/8", "1/4", "12/8", "2/2", "7/16"]) expect(validateAbc(withMeter(m))).toBeNull();
    expect(parseAbc(withMeter("C")).meter).toEqual([4, 4]);
    expect(parseAbc(withMeter("C|")).meter).toEqual([2, 2]);
    expect(parseAbc(withMeter("3/4 % waltz")).meter).toEqual([3, 4]);
  });

  it("refuses a header meter whose bar would be empty, huge or fractional", () => {
    // 1/4096: a 0-tick bar (Infinity bars); 100000000/4: a rest of millions of units; 4/24: a 171-tick bar
    for (const m of ["1/4096", "100000000/4", "4/24", "0/4", "4/0"]) {
      expect(() => parseAbc(withMeter(m))).toThrow(AbcParseError);
      expect(validateAbc(withMeter(m))).toMatch(/^行 3: 拍子 M:/);
    }
  });

  it("refuses a compound meter instead of reading only its last part", () => {
    expect(validateAbc(withMeter("2+3/8"))).toMatch(/^行 3: 拍子 M:2\+3\/8 を解釈できません/);
  });

  it("refuses the same meters in a group change", () => {
    const text = two("C16|\nV: Vocal\nM:1/4096\nC4|\nV: Ins\nM:1/4096\nZ|", "Z|");
    expect(validateAbc(text)).toMatch(/拍子 M:1\/4096 は未対応/);
  });

  it("isSupportedMeter: numerator 1..64, denominator a power of two up to 1024", () => {
    expect(isSupportedMeter([4, 4])).toBe(true);
    expect(isSupportedMeter([64, 1024])).toBe(true);
    for (const m of [[0, 4], [65, 4], [4, 24], [1, 2048], [4, -2147483648], [4.5, 4], [NaN, 4]]) expect(isSupportedMeter(m)).toBe(false);
  });
});

describe("lengths", () => {
  it("refuses a zero length instead of an Infinity or empty note", () => {
    // C/0 gave a note of Infinity ticks; the score then serialized to the header lines only
    expect(validateAbc(two("C/0D4|"))).toMatch(/^行 10: 長さの指定 "\/0" は使えません/);
    expect(validateAbc(two("C0D4|"))).toMatch(/^行 10: 長さの指定 "0" は使えません/);
    expect(validateAbc(two("z/0C4|"))).toMatch(/長さの指定/);
    expect(validateAbc(two("C16|", "Z0|"))).toMatch(/^行 12: 長さの指定 "Z0" は使えません/);
    // ordinary lengths are unchanged
    expect(parseAbc(two("C/2D3/2E//F12|")).notes.map((n) => n.duration)).toEqual([32, 96, 16, 768]);
  });

  it("refuses a rest count or a note length beyond the limit, naming the line", () => {
    expect(validateAbc(two("C16|", "Z99999999|"))).toMatch(new RegExp(`^行 12: 曲が長すぎます（最大 ${MAX_BARS} 小節`));
    expect(validateAbc(two("C9999999999|"))).toMatch(/^行 10: 曲が長すぎます/);
    // a long song still loads
    expect(parseAbc(two("C16|", `Z${MAX_BARS - 1}|`)).bars).toBe(MAX_BARS - 1);
  });
});

describe("the serializer refuses what it cannot write instead of looping", () => {
  it("a bar count beyond the limit", () => {
    const s = { ...emptyScore(), bars: MAX_BARS + 1 };
    expect(() => serializeAbc(s)).toThrow(/曲が長すぎるため書き出せません/);
    expect(serializeAbc({ ...emptyScore(), bars: 8 })).toContain("Z4|");
  });

  it("a degenerate meter (0-tick or negative bars, from a corrupt MIDI file)", () => {
    const note = { id: 1, voice: "Vocal" as const, start: 0, duration: 256, pitch: 60 };
    for (const meter of [[0, 4], [1, 4096], [4, -2147483648]] as [number, number][]) {
      expect(() => serializeAbc({ ...emptyScore(), meter, notes: [note], bars: 1 })).toThrow(/拍子 .* は書き出せません/);
      expect(() => serializeAbc({ ...emptyScore(), meterChanges: [{ tick: 1024, meter }], notes: [note], bars: 2 })).toThrow(/は書き出せません/);
    }
  });

  it("notes at NaN or Infinity (an unreadable time division) instead of writing the header only", () => {
    const s = { ...emptyScore(), notes: [{ id: 1, voice: "Vocal" as const, start: NaN, duration: NaN, pitch: 60 }], bars: NaN };
    expect(() => serializeAbc(s)).toThrow(/書き出せません/);
    const inf = { ...emptyScore(), notes: [{ id: 1, voice: "Vocal" as const, start: 0, duration: Infinity, pitch: 60 }], bars: 1 };
    expect(() => serializeAbc(inf)).toThrow(/書き出せません/);
  });

  it("a parsed and committed score round-trips as before", () => {
    const s = parseAbc(two('"C"C4D4E4F4|"G"G16|', "C,16|G,,16|"));
    const out = commitLike(s);
    expect(out).toContain('V: Vocal\n"C"C4D4E4F4|"G"G16|');
    expect(parseAbc(out).notes).toEqual(s.notes);
  });
});
