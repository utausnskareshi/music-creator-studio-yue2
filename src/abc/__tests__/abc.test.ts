import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbc, validateAbc } from "../parse";
import { serializeAbc, splitDuration } from "../serialize";
import { PPQ, keySignature, ticksPerBar } from "../model";

const fx = (name: string) => readFileSync(join(__dirname, "..", "__fixtures__", name), "utf8");

function noteSet(text: string) {
  const s = parseAbc(text);
  return s.notes.map((n) => `${n.voice}:${n.start}:${n.duration}:${n.pitch}`).sort();
}
function chordSet(text: string) {
  return parseAbc(text)
    .chords.map((c) => `${c.start}:${c.symbol}`)
    .sort();
}

describe("keySignature", () => {
  it("handles majors and minors", () => {
    expect(keySignature("G").F).toBe(1);
    expect(keySignature("F").B).toBe(-1);
    expect(keySignature("Am").F).toBe(0);
    expect(keySignature("Em").F).toBe(1);
    expect(keySignature("Bb").E).toBe(-1);
    expect(keySignature("Eb").A).toBe(-1);
  });
});

describe("parseAbc", () => {
  it("parses the generated full-mode score", () => {
    const s = parseAbc(fx("full_en.abc"));
    expect(s.unit).toBe(32);
    expect(s.bpm).toBe(86);
    expect(s.key).toBe("C");
    expect(s.sections.map((x) => x.name)).toEqual(["intro", "verse", "chorus", "outro"]);
    expect(s.sections[0].bar).toBe(0);
    expect(s.sections[1].bar).toBe(5); // intro = 4 bars + 1 bar
    expect(s.chords[0]).toEqual({ start: 28 * 32, symbol: "C" }); // z24z4"C" at 28 units of 1/32
    // First vocal note in verse: "C"c6 at bar 5 -> C5 (72)
    const firstVocal = s.notes.filter((n) => n.voice === "Vocal")[0];
    expect(firstVocal.start).toBe(5 * ticksPerBar(s));
    expect(firstVocal.pitch).toBe(72);
    expect(firstVocal.duration).toBe(6 * 32);
    expect(s.bars).toBe(25); // intro 5 + verse 8 + chorus 8 + outro 4
  });

  it("applies key signature, explicit accidentals and per-bar propagation", () => {
    const s = parseAbc("X:1\nM:4/4\nL:1/16\nQ:1/4=100\nK:G\nV: Vocal\nF4 ^G4 G4 =F4|F4|\n");
    const p = s.notes.map((n) => n.pitch);
    // Uppercase = octave 4. F in G major = F#4 (66); ^G = G#4 (68); G after ^G in the same bar keeps sharp (68); =F natural (65); new bar F -> F# (66)
    expect(p).toEqual([66, 68, 68, 65, 66]);
  });

  it("merges ties and handles whole-bar rests and octave marks", () => {
    const s = parseAbc("X:1\nM:4/4\nL:1/16\nQ:1/4=120\nK:C\nV: Vocal\nc16-|c8 z8|Z2|C,4 c'4 z8|\n");
    expect(s.notes[0].duration).toBe(24 * 64); // 16+8 units of 1/16 (64 ticks) tied across the bar line
    expect(s.notes[1].pitch).toBe(48); // C,
    expect(s.notes[2].pitch).toBe(84); // c'
    expect(s.notes[1].start).toBe(4 * ticksPerBar(s));
  });

  it("reports unsupported notation", () => {
    expect(validateAbc("X:1\nK:C\nV: Vocal\n(3abc|")).toMatch(/未対応/);
    expect(validateAbc("X:1\nK:C\nV: Vocal\n[CEG]4|")).toMatch(/和音/);
    expect(validateAbc(fx("full_ja.abc"))).toBeNull();
    expect(validateAbc(fx("melody_cover.abc"))).toBeNull();
    expect(validateAbc(fx("full_long.abc"))).toBeNull();
  });
});

describe("serializeAbc round trip", () => {
  for (const name of ["full_en.abc", "full_long.abc", "melody_cover.abc", "full_ja.abc"]) {
    it(`round-trips ${name}`, () => {
      const text = fx(name);
      const out = serializeAbc(parseAbc(text));
      expect(noteSet(out)).toEqual(noteSet(text));
      expect(chordSet(out)).toEqual(chordSet(text));
      const a = parseAbc(text);
      const b = parseAbc(out);
      expect(b.sections).toEqual(a.sections);
      expect(b.bpm).toBe(a.bpm);
      expect(b.key).toBe(a.key);
      // And the output is itself stable.
      expect(serializeAbc(parseAbc(out))).toBe(out);
    });
  }

  it("keeps the YuE2 dialect layout", () => {
    const out = serializeAbc(parseAbc(fx("full_en.abc")));
    const lines = out.split("\n");
    expect(lines[0]).toBe("X:1");
    expect(lines).toContain("K:C");
    expect(lines.filter((l) => l.startsWith("% ")).length).toBe(4);
    expect(lines.filter((l) => l === "V: Vocal").length).toBeGreaterThan(0);
    // Every V: Vocal is followed by a V: Ins before the next section comment.
    const body = lines.slice(lines.indexOf("K:C") + 1);
    let expectVocal = true;
    for (const l of body) {
      if (l === "V: Vocal") {
        expect(expectVocal).toBe(true);
        expectVocal = false;
      } else if (l === "V: Ins") {
        expect(expectVocal).toBe(false);
        expectVocal = true;
      }
    }
    expect(out).not.toMatch(/\|\|/);
  });

  it("writes accidentals relative to key and bar state", () => {
    const s = parseAbc("X:1\nM:4/4\nL:1/16\nQ:1/4=100\nK:G\nV: Vocal\nF4 ^G4 G4 =F4|F4 z12|\n");
    const out = serializeAbc(s);
    const body = out.split("K:G\n")[1];
    expect(body).toContain("F4^G4G4=F4|");
    expect(body).toContain("F4z12|");
  });

  it("splits long durations into allowed multipliers", () => {
    expect(splitDuration(5)).toEqual([4, 1]);
    expect(splitDuration(48)).toEqual([48]);
    expect(splitDuration(50)).toEqual([48, 2]);
    expect(splitDuration(7)).toEqual([6, 1]);
  });

  it("attaches chords to rests by splitting them", () => {
    const s = parseAbc("X:1\nM:4/4\nL:1/16\nQ:1/4=100\nK:C\nV: Vocal\nZ|\n");
    s.chords.push({ start: 0, symbol: "C" }, { start: PPQ * 2, symbol: "G" });
    const out = serializeAbc(s);
    expect(out).toContain('"C"z8"G"z8|');
  });

  it("strips chords for melody mode", () => {
    const out = serializeAbc(parseAbc(fx("full_en.abc")), { stripChords: true });
    expect(out).not.toMatch(/"[A-G]/);
  });
});
