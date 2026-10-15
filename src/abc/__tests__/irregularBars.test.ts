// Bars written shorter or longer than the meter (a pickup, a lost beat): the score keeps one timeline on the meter's
// bar grid, so writing it back moves every later bar line. parseAbcDetailed reports them so the editor can say so.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbc, parseAbcDetailed } from "../parse";
import { serializeAbc } from "../serialize";

const HEAD = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n';
const two = (vocal: string, ins: string) => `${HEAD}% verse\nV: Vocal\n${vocal}\nV: Ins\n${ins}\n`;

describe("irregular bars", () => {
  it("reports a pickup in each voice", () => {
    const r = parseAbcDetailed(two('G4|"C"c4B4A4G4|"F"A16|', "z4|C16|F16|"));
    expect(r.irregularBars).toEqual([
      { voice: "Vocal", bar: 1 },
      { voice: "Ins", bar: 1 },
    ]);
    // the score itself is what parseAbc gives
    expect(r.score).toEqual(parseAbc(two('G4|"C"c4B4A4G4|"F"A16|', "z4|C16|F16|")));
    // and written back, the bar lines after it do move (what the notice tells the user)
    expect(serializeAbc(r.score)).toContain('V: Vocal\nG4"C"c4B4A4|G4"F"A12-|A4z12|');
  });

  it("numbers a short bar in the middle as written", () => {
    expect(parseAbcDetailed(two('C16|D8|"G"E16|F16|', "Z|Z|Z|Z|")).irregularBars).toEqual([{ voice: "Vocal", bar: 2 }]);
    // after a whole-bar rest count
    expect(parseAbcDetailed(two("Z2|D8|E16|", "Z4|")).irregularBars).toEqual([{ voice: "Vocal", bar: 3 }]);
  });

  it("does not report what the write-back keeps", () => {
    // a short last bar: nothing after it moves (it is padded with a rest)
    expect(parseAbcDetailed(two("C16|D4|", "Z|z4|")).irregularBars).toEqual([]);
    // an irregular bar right before an off-grid meter change is written with its actual length
    const s = parseAbc(two("C16|D16|", "Z2|"));
    s.meterChanges = [{ tick: 1536, meter: [3, 4] }];
    expect(parseAbcDetailed(serializeAbc(s)).irregularBars).toEqual([]);
    // a bar written over two (no bar line in between) keeps the grid
    expect(parseAbcDetailed(two("C16D16|E16|", "Z3|")).irregularBars).toEqual([]);
  });

  it("finds none in the official fixtures", () => {
    const dir = join(__dirname, "..", "__fixtures__");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".abc"))) {
      expect([f, parseAbcDetailed(readFileSync(join(dir, f), "utf8")).irregularBars]).toEqual([f, []]);
    }
  });
});
