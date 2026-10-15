// Native-dialect compliance: keys, key/meter changes, ties, L: preservation, overlap safety net.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AbcParseError, parseAbc } from "../parse";
import { serializeAbc } from "../serialize";
import { OFFICIAL_KEYS, PPQ, barAtTick, barStartTick, hasTimelineChanges, isValidChordSymbol, keySignature, normalizeKey, parseKey, recomputeBars, sameKey, type Score } from "../model";
import { toInstrumental } from "../instrumental";

const fx = (name: string) => readFileSync(join(__dirname, "..", "__fixtures__", name), "utf8");

/** Native score skeleton like the official test helper (L:1/32). */
function score(vocal: string, ins = "Z|", meter = "4/4", key = "C", extra = "") {
  return (
    `X:1\nT:\nM:${meter}\nL:1/32\nQ:1/4=88\n` +
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n' +
    'V: Ins clef=treble name="Ins Melody" snm="Inst."\n' +
    `K:${key}\n% verse\nV: Vocal\n${vocal}\nV: Ins\n${ins}\n${extra}`
  );
}
const U = PPQ / 8; // ticks per 1/32 unit
const pitches = (s: Score, v: "Vocal" | "Ins") => s.notes.filter((n) => n.voice === v).map((n) => n.pitch);

describe("keys", () => {
  it("matches the official key_accidentals for all 30 keys", () => {
    OFFICIAL_KEYS.forEach((k, i) => {
      const count = (i % 15) - 7;
      const expected: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
      for (const l of (count > 0 ? "FCGDAEB" : "BEADGCF").slice(0, Math.abs(count))) expected[l] = count > 0 ? 1 : -1;
      expect(keySignature(k), k).toEqual(expected);
      expect(normalizeKey(k)).toBe(k);
    });
  });

  it("reads G#m / D#m / A#m with 5 / 6 / 7 sharps", () => {
    expect(pitches(parseAbc(score("F8G8A8B8|", "Z|", "4/4", "G#m")), "Vocal")).toEqual([66, 68, 70, 71]);
    expect(Object.values(keySignature("D#m")).filter((v) => v === 1).length).toBe(6);
    expect(Object.values(keySignature("A#m")).filter((v) => v === 1).length).toBe(7);
  });

  it("writes an explicit natural against the G#m signature", () => {
    const s = parseAbc(score("=F8F8z16|", "Z|", "4/4", "G#m"));
    expect(pitches(s, "Vocal")).toEqual([65, 65]);
    expect(serializeAbc(s)).toContain("=F8F8z16|");
  });

  it("does not read long mode names as minor, and keeps trailing text working", () => {
    expect(pitches(parseAbc(score("f32|", "Z|", "4/4", "Dmix")), "Vocal")).toEqual([78]);
    expect(keySignature("Amaj").G).toBe(1);
    expect(keySignature("Cmajor").B).toBe(0);
    expect(keySignature("D dorian")).toEqual(keySignature("C"));
    expect(keySignature("Am clef=treble")).toEqual(keySignature("Am"));
    expect(keySignature("G clef=treble").F).toBe(1);
  });

  it("normalizes modes to the official key with the same signature", () => {
    expect(normalizeKey("Dmix")).toBe("G");
    expect(normalizeKey("Edor")).toBe("Bm");
    expect(normalizeKey("Am clef=treble")).toBe("Am");
    expect(normalizeKey("bm")).toBe("Bm");
    expect(normalizeKey("H")).toBeNull();
    // A Dmix import is written as K:G without changing a pitch.
    const text = score("f8F8c8=c8|", "Z|", "4/4", "Dmix");
    const out = serializeAbc(parseAbc(text));
    expect(out).toContain("\nK:G\n");
    expect(parseAbc(out).notes.map((n) => n.pitch)).toEqual(parseAbc(text).notes.map((n) => n.pitch));
  });

  it("resolves modes on a sharp or flat tonic from the tonic itself", () => {
    expect(parseKey("G#dor")?.fifths).toBe(6);
    expect(normalizeKey("G#dor")).toBe("D#m");
    expect(normalizeKey("D#phr")).toBe("G#m");
    expect(normalizeKey("A#loc")).toBe("G#m");
    expect(parseKey("A#loc")?.fifths).toBe(5);
    expect(normalizeKey("Bbmix")).toBe("Eb");
    expect(normalizeKey("Cbm")).toBeNull(); // 10 flats
    expect(normalizeKey("B#")).toBeNull(); // 12 sharps
  });

  it("compares keys by signature", () => {
    expect(sameKey("C", "C major")).toBe(true);
    expect(sameKey("Am clef=treble", "A minor")).toBe(true);
    expect(sameKey("Dmix", "G")).toBe(true);
    expect(sameKey("C", "Am")).toBe(false);
    expect(sameKey("H", "H")).toBe(true);
    expect(sameKey("H", "C")).toBe(false);
  });

  it("accepts double-accidental chord roots", () => {
    expect(isValidChordSymbol("F##m7/C#")).toBe(true);
    expect(isValidChordSymbol("Bbbaug")).toBe(true);
    expect(isValidChordSymbol("Cmaj9")).toBe(false);
  });
});

describe("key and meter changes", () => {
  it("keeps an inline [K:] change in its own voice and records it", () => {
    const s = parseAbc(score('"C"F16[K:D]F16|', "F16[K:D]F16|"));
    expect(pitches(s, "Vocal")).toEqual([65, 66]);
    expect(pitches(s, "Ins")).toEqual([65, 66]);
    expect(s.key).toBe("C");
    expect(s.keyChanges).toEqual([{ tick: 16 * U, key: "D" }]);
    // written back inline, in both voices
    const out = serializeAbc(s);
    expect(out).toContain('\nV: Vocal\n"C"F16[K:D]F16|\nV: Ins\nF16[K:D]F16|\n');
    expect(parseAbc(out).keyChanges).toEqual(s.keyChanges);
  });

  it("resets bar accidentals at a key change", () => {
    expect(pitches(parseAbc(score("^F8[K:C]F8z16|")), "Vocal")).toEqual([66, 65]);
  });

  it("rejects voices whose key timelines differ", () => {
    expect(() => parseAbc(score("C16[K:D]C16|", "C32|"))).toThrow(/声部間で転調\/拍子変更の位置が一致しません/);
  });

  it("parses the official example-ins.abc with its M:5/8 group", () => {
    const s = parseAbc(fx("official_example_ins.abc"));
    expect(s.meter).toEqual([4, 4]);
    expect(s.meterChanges).toEqual([{ tick: 4 * 4 * PPQ, meter: [5, 8] }]);
    expect(s.bars).toBe(6);
    expect(barStartTick(s, 5)).toBe(4 * 4 * PPQ + 5 * (PPQ / 2));
    const outro = s.sections.find((x) => x.name === "outro")!;
    expect(outro.bar).toBe(4);
    // Ins "E8G8B4-|B4G8D8|" in G: E4 G4 B4(tied) G4 D4
    const tail = s.notes.filter((n) => n.voice === "Ins" && n.start >= 4 * 4 * PPQ);
    expect(tail.map((n) => [n.start - 4 * 4 * PPQ, n.duration, n.pitch])).toEqual([
      [0, 8 * U, 64],
      [8 * U, 8 * U, 67],
      [16 * U, 8 * U, 71],
      [24 * U, 8 * U, 67],
      [32 * U, 8 * U, 62],
    ]);
    expect(barAtTick(s, 4 * 4 * PPQ + 20 * U)).toBe(5);
    expect(recomputeBars(s)).toBe(6);
    expect(serializeAbc(s)).toBe(fx("official_example_ins.abc"));
    expect(() => toInstrumental(s)).not.toThrow();
  });

  it("applies group-level K: lines to the following bars", () => {
    const tail = "V: Vocal\nK:D\nF32|\nV: Ins\nK:D\nC32|\n";
    const s = parseAbc(score("F32|", "C32|", "4/4", "C", tail));
    expect(pitches(s, "Vocal")).toEqual([65, 66]);
    expect(pitches(s, "Ins")).toEqual([60, 61]);
    expect(s.keyChanges).toEqual([{ tick: 4 * PPQ, key: "D" }]);
  });

  it("does not record a K: that restates the key in another spelling", () => {
    const restated = parseAbc(score("F32|", "C32|", "4/4", "C", "V: Vocal\nK:C major\nF32|\nV: Ins\nK:C\nC32|\n"));
    expect(restated.keyChanges).toEqual([]);
    expect(hasTimelineChanges(restated)).toBe(false);
    const minor = parseAbc(score("A32|", "Z|", "4/4", "Am clef=treble", "V: Vocal\nK:A minor\nA32|\nV: Ins\nK:Amin\nZ|\n"));
    expect(minor.keyChanges).toEqual([]);
    // A real change spelled differently in the two voices is one change.
    const d = parseAbc(score("F32|", "C32|", "4/4", "C", "V: Vocal\nK:D\nF32|\nV: Ins\nK:Dmaj\nC32|\n"));
    expect(d.keyChanges).toEqual([{ tick: 4 * PPQ, key: "D" }]);
    expect(pitches(d, "Ins")).toEqual([60, 61]);
  });

  it("folds a key / meter set at the very start into the header, so the score stays editable", () => {
    const s = parseAbc(score("K:G\nM:3/4\nF24|", "K:G\nM:3/4\nZ|"));
    expect(s.key).toBe("G");
    expect(s.meter).toEqual([3, 4]);
    expect(s.keyChanges).toEqual([]);
    expect(s.meterChanges).toEqual([]);
    expect(pitches(s, "Vocal")).toEqual([66]);
    const out = serializeAbc(s);
    expect(out).toContain("\nK:G\n");
    expect(out).toContain("\nM:3/4\n");
    expect(pitches(parseAbc(out), "Vocal")).toEqual([66]);
  });

  it("uses the new bar length for Z and bar counting after a meter change", () => {
    const tail = "V: Vocal\nM:3/4\nZ|D24|\nV: Ins\nM:3/4\nZ2|\n";
    const s = parseAbc(score("C32|", "Z|", "4/4", "C", tail));
    const d = s.notes.find((n) => n.pitch === 62)!;
    expect(d.start).toBe(4 * PPQ + 3 * PPQ);
    expect(s.bars).toBe(3);
    expect(s.meterChanges).toEqual([{ tick: 4 * PPQ, meter: [3, 4] }]);
  });

  it("treats %% directives as non-sections", () => {
    const s = parseAbc(score("C32|").replace("% verse", "%%MIDI program 1"));
    expect(s.sections).toEqual([]);
  });
});

describe("ties", () => {
  it("keeps the tied accidental on an unmarked continuation across a barline", () => {
    const s = parseAbc(score("^F32-|F8F24|", "Z2|"));
    expect(s.notes.filter((n) => n.voice === "Vocal").map((n) => [n.start, n.duration, n.pitch])).toEqual([
      [0, 1280, 66],
      [1280, 768, 65],
    ]);
  });

  it("merges ties inside a bar and across chord splits", () => {
    const s = parseAbc(score('"C"C16-"Am7"C16|'));
    expect(s.notes.filter((n) => n.voice === "Vocal").map((n) => [n.start, n.duration, n.pitch])).toEqual([[0, 32 * U, 60]]);
    expect(parseAbc(score("^F16-F16|")).notes[0].duration).toBe(32 * U);
  });

  it("rejects a tie that changes pitch or runs into a rest", () => {
    expect(() => parseAbc(score("^F16-=F16|"))).toThrow(/タイは同じ高さの音同士でなければなりません/);
    expect(() => parseAbc(score("C32-|D32|", "Z2|"))).toThrow(/タイは同じ高さ/);
    expect(() => parseAbc(score("C32-|z32|", "Z2|"))).toThrow(/タイの後に休符は置けません/);
    expect(() => parseAbc(score("C32-|Z|", "Z2|"))).toThrow(AbcParseError);
  });
});

describe("serializer unit (L:)", () => {
  const all = ["full_en.abc", "full_ja.abc", "full_long.abc", "melody_cover.abc", "official_score.abc", "official_melody.abc", "plan_l32.abc", "transcription_l16.abc"];
  for (const name of all) {
    it(`round-trips ${name} byte for byte`, () => {
      const text = fx(name);
      expect(serializeAbc(parseAbc(text))).toBe(text);
    });
  }

  it("keeps 6/8 at L:1/32 and raises a coarser L: to the 4 x denominator floor", () => {
    expect(serializeAbc(parseAbc(score("C8D8E8|", "Z|", "6/8")))).toContain("L:1/32\n");
    expect(serializeAbc(parseAbc(score("C8D8E8|", "Z|", "6/8")))).toContain("C8D8E8|");
    const coarse = score("C4D4E4|", "Z|", "6/8").replace("L:1/32", "L:1/16");
    const out = serializeAbc(parseAbc(coarse));
    expect(out).toContain("L:1/32\n");
    expect(out).toContain("C8D8E8|");
    expect(serializeAbc(parseAbc(coarse), { unit: 16 })).toContain("L:1/32\n");
  });

  it("goes finer when an edit needs it and keeps 1/16 for a 4/4 MIDI-style score", () => {
    const s = parseAbc(fx("official_score.abc"));
    expect(serializeAbc(s)).toContain("L:1/16\n");
    s.notes.push({ id: 9999, voice: "Ins", start: 4 * 4 * PPQ * 7 + U, duration: U, pitch: 60 });
    const out = serializeAbc(s);
    expect(out).toContain("L:1/32\n");
    expect(parseAbc(out).notes.some((n) => n.start === 4 * 4 * PPQ * 7 + U && n.duration === U)).toBe(true);
  });
});

describe("overlap safety net", () => {
  it("clips a later overlapping note instead of dropping it", () => {
    const s = parseAbc("X:1\nM:4/4\nL:1/16\nQ:1/4=100\nK:C\nV: Vocal\nc4d4e4f4|\n");
    const e = s.notes.find((n) => n.pitch === 76)!;
    e.start -= PPQ / 2; // an eighth earlier, into d
    const out = serializeAbc(s);
    expect(out).toContain("c4d4e2z2f4|");
  });
});

describe("trailing silent bars", () => {
  it("keeps melody_cover at 26 bars through toInstrumental", () => {
    const s = parseAbc(fx("melody_cover.abc"));
    expect(s.bars).toBe(26);
    expect(recomputeBars(s)).toBe(25);
    const r = toInstrumental(s);
    expect(r.score.bars).toBe(26);
    expect(parseAbc(serializeAbc(r.score)).bars).toBe(26);
  });
});
