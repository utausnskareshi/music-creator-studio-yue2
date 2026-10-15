// Regression checks after the compliance fixes: native header on every re-serialization, theoretical keys,
// MIDI import/export details, untagged lyrics and the editor's bar count during drags.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Midi } from "@tonejs/midi";
import { parseAbc } from "../parse";
import { serializeAbc } from "../serialize";
import { validateNativeAbc } from "../native";
import { keySignature, normalizeKey, recomputeBars, type Score } from "../model";
import { editedBars, transposeKey } from "../edit";
import { midiToScore, scoreToMidi } from "../midi";
import { toInstrumental } from "../instrumental";
import { compareSections, isUntaggedLyricsHint } from "../consistency";

const fx = (name: string) => readFileSync(join(__dirname, "..", "__fixtures__", name), "utf8");

function abc(vocal: string, opts: { key?: string; header?: string; ins?: string } = {}) {
  const header =
    opts.header ??
    'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\n';
  return `${header}K:${opts.key ?? "C"}\n% verse\nV: Vocal\n${vocal}\nV: Ins\n${opts.ins ?? "Z|"}\n`;
}
const vocalPitches = (s: Score) => s.notes.filter((n) => n.voice === "Vocal").sort((a, b) => a.start - b.start).map((n) => n.pitch);

describe("serializeAbc writes the native header", () => {
  it("drops a title and loose voice definitions of the input", () => {
    const titled = fx("official_score.abc").replace(/^T:.*$/m, "T:My Song");
    expect(validateNativeAbc(titled).ok).toBe(false);
    const out = serializeAbc(parseAbc(titled));
    expect(out.split("\n").slice(0, 2)).toEqual(["X:1", "T:"]);
    expect(validateNativeAbc(out).ok).toBe(true);
    expect(serializeAbc(toInstrumental(parseAbc(titled)).score)).toMatch(/^X:1\nT:\n/);
    const loose = abc("C4D4E4F4|", { header: "X:7\nT:Title\nM:4/4\nL:1/16\nQ:1/4=100\nV:Vocal\nV:Ins\n" });
    const out2 = serializeAbc(parseAbc(loose));
    expect(validateNativeAbc(out2).ok).toBe(true);
    // the untouched native example still round-trips byte for byte
    expect(serializeAbc(parseAbc(fx("official_score.abc")))).toBe(fx("official_score.abc"));
  });
});

describe("theoretical keys (more than seven accidentals)", () => {
  it("reads Db minor with every letter flat and B double-flat", () => {
    expect(keySignature("Dbm")).toEqual({ A: -1, B: -2, C: -1, D: -1, E: -1, F: -1, G: -1 });
    expect(vocalPitches(parseAbc(abc("D4F4A4d4|", { key: "Dbm" })))).toEqual([61, 64, 68, 73]);
    expect(vocalPitches(parseAbc(abc("B16|", { key: "Dbm" })))).toEqual([69]);
  });

  it("reads C# lydian with F double-sharp", () => {
    expect(vocalPitches(parseAbc(abc("C2E2G2c2F8|", { key: "C#lyd" })))).toEqual([61, 65, 68, 73, 67]);
  });

  it("keeps the pitches through serialize -> parse and never names an official key for them", () => {
    const s = parseAbc(abc("D4F4A4d4|B8=B8|", { key: "Dbm" }));
    const back = parseAbc(serializeAbc(s));
    expect(vocalPitches(back)).toEqual(vocalPitches(s));
    expect(normalizeKey("Dbm")).toBeNull();
    expect(normalizeKey("G#")).toBeNull();
    expect(normalizeKey("Dmix")).toBe("G");
    // transposing lands on an official spelling
    expect(transposeKey("Dbm", 1)).toBe("Dm");
  });
});

describe("MIDI import", () => {
  it("imports meter changes (a restated signature is not a change)", () => {
    const s = parseAbc(fx("official_example_ins.abc"));
    const r = midiToScore(scoreToMidi(s), null, { unit: 32 });
    expect(r.score.meter).toEqual([4, 4]);
    expect(r.score.meterChanges).toEqual(s.meterChanges);
    expect(r.warnings).toEqual([]);
    const plain = parseAbc(fx("full_en.abc"));
    expect(midiToScore(scoreToMidi(plain), null, { unit: 32 }).score.meterChanges).toEqual([]);
    // the same signature written twice is not a change
    const m = new Midi(scoreToMidi(plain));
    m.header.timeSignatures.push({ ticks: m.header.ppq * 16, timeSignature: [4, 4] });
    m.header.update();
    expect(midiToScore(m.toArray(), null, { unit: 32 }).score.meterChanges).toEqual([]);
  });

  it("does not copy an instrumental's Ins line into Vocal", () => {
    const inst = toInstrumental(parseAbc(fx("full_en.abc"))).score;
    const insCount = inst.notes.filter((n) => n.voice === "Ins").length;
    expect(inst.notes.some((n) => n.voice === "Vocal")).toBe(false);
    const r = midiToScore(scoreToMidi(inst), null, { unit: 32 });
    expect(r.score.notes.filter((n) => n.voice === "Vocal").length).toBe(0);
    expect(r.score.notes.filter((n) => n.voice === "Ins").length).toBe(insCount);
  });

  it("maps the official track names Vocal Melody / Ins Melody even when Vocal is empty", () => {
    const build = (names: [string, number][]) => {
      const m = new Midi();
      for (const [name, count] of names) {
        const t = m.addTrack();
        t.name = name;
        for (let k = 0; k < count; k++) t.addNote({ midi: 60 + k, ticks: k * m.header.ppq, durationTicks: m.header.ppq });
      }
      return m.toArray();
    };
    const voices = (bytes: Uint8Array) => {
      const n = midiToScore(bytes, null, { unit: 16 }).score.notes;
      return { vocal: n.filter((x) => x.voice === "Vocal").length, ins: n.filter((x) => x.voice === "Ins").length };
    };
    // an instrumental written by MuseScore / abc2midi / music21: empty Vocal Melody, accompaniment in Ins Melody
    expect(voices(build([["Vocal Melody", 0], ["Ins Melody", 2]]))).toEqual({ vocal: 0, ins: 2 });
    expect(voices(build([["Ins Melody", 2], ["Vocal Melody", 0]]))).toEqual({ vocal: 0, ins: 2 });
    // the empty Vocal track left out entirely: a lone Ins track stays Ins
    expect(voices(build([["Ins Melody", 3]]))).toEqual({ vocal: 0, ins: 3 });
    expect(voices(build([["Instrumental", 3]]))).toEqual({ vocal: 0, ins: 3 });
    expect(voices(build([["Accompaniment", 3]]))).toEqual({ vocal: 0, ins: 3 });
    expect(voices(build([["Inst.", 3]]))).toEqual({ vocal: 0, ins: 3 });
    // a numbered DAW default name is not an explicit Ins voice: the lone melody goes to Vocal
    expect(voices(build([["Inst 1", 3]]))).toEqual({ vocal: 3, ins: 0 });
    expect(voices(build([["Inst. 2", 3]]))).toEqual({ vocal: 3, ins: 0 });
    // a lone track named after its instrument (MuseScore part name, DAW track) is the melody: Vocal
    expect(voices(build([["Piano", 3]]))).toEqual({ vocal: 3, ins: 0 });
    expect(voices(build([["Acoustic Guitar", 4]]))).toEqual({ vocal: 4, ins: 0 });
    expect(voices(build([["Piano", 3], ["Conductor", 0]]))).toEqual({ vocal: 3, ins: 0 });
    // with a second track the instrument name still claims Ins
    expect(voices(build([["Piano", 3], ["", 2]]))).toEqual({ vocal: 2, ins: 3 });
    expect(voices(build([["Vocal Melody", 2], ["Ins Melody", 3]]))).toEqual({ vocal: 2, ins: 3 });
    expect(voices(build([["Piano Melody", 3], ["Melody", 2]]))).toEqual({ vocal: 2, ins: 3 });
    expect(voices(build([["Lead Guitar", 3], ["Lead", 2]]))).toEqual({ vocal: 2, ins: 3 });
    // unnamed tracks keep the order rule
    expect(voices(build([["", 2], ["", 3]]))).toEqual({ vocal: 2, ins: 3 });
    expect(voices(build([["", 2]]))).toEqual({ vocal: 2, ins: 0 });
  });

  it("keeps trailing silent bars", () => {
    const s = parseAbc(abc("c4d4e4f4|Z3|", { ins: "C16|Z3|" }));
    expect(s.bars).toBe(4);
    expect(midiToScore(scoreToMidi(s), null, { unit: 16 }).score.bars).toBe(4);
    expect(midiToScore(scoreToMidi(s), s, { unit: 16 }).score.bars).toBe(4);
    const full = parseAbc(fx("full_en.abc"));
    expect(midiToScore(scoreToMidi(full), full, { unit: 32 }).score.bars).toBe(full.bars);
  });
});

describe("compareSections with untagged lyrics", () => {
  it("hints at the missing tags instead of reporting added or deleted sections", () => {
    const score = parseAbc(fx("plan_l32.abc"));
    const w = compareSections(score, "朝の光が\n街が目を覚ます\n\n走り出そう\n影はもう");
    expect(w.length).toBe(1);
    expect(isUntaggedLyricsHint(w[0])).toBe(true);
    expect(w[0]).not.toMatch(/数が一致しません/);
    expect(w[0]).not.toMatch(/追加・削除/);
  });

  it("still reports untagged lyrics on a score without a sung section", () => {
    const inst = parseAbc(fx("official_example_ins.abc"));
    expect(inst.notes.some((n) => n.voice === "Vocal")).toBe(false);
    for (const lyrics of ["朝の光が\n街が目を覚ます", "[Verse]\n朝の光が\n街が目を覚ます"]) {
      const w = compareSections(inst, lyrics);
      expect(w.length).toBe(1);
      expect(isUntaggedLyricsHint(w[0])).toBe(false);
      expect(w[0]).toMatch(/0: なし/);
      expect(w[0]).toMatch(/数が一致しません/);
    }
    // one sung section and untagged lyrics: nothing to pair up, no warning
    expect(compareSections(parseAbc(abc("C4D4E4F4|")), "朝の光が\n街が目を覚ます")).toEqual([]);
  });
});

describe("editor bar count during a drag", () => {
  it("returns to the taken-in bars when a note goes past the end and back", () => {
    const s = parseAbc(fx("official_melody.abc"));
    const base = s.bars;
    const last = s.notes.filter((n) => n.voice === "Vocal").sort((a, b) => b.start - a.start)[0];
    const barTicks = recomputeBars(s) > 0 ? (s.meter[0] * 4 * 256) / s.meter[1] : 0;
    let cur: Score = s;
    for (const d of [1, 2, 3, 2, 1, 0]) {
      const notes = s.notes.map((n) => (n.id === last.id ? { ...n, start: last.start + d * barTicks } : n));
      const next = { ...cur, notes };
      cur = { ...next, bars: editedBars(base, next) };
      if (d === 3) expect(cur.bars).toBeGreaterThan(base);
    }
    expect(cur.bars).toBe(base);
    // deleting the last phrase keeps the source's bars (trailing rests stay)
    const fewer = { ...s, notes: s.notes.filter((n) => n.id !== last.id) };
    expect(editedBars(base, fewer)).toBe(base);
  });
});
