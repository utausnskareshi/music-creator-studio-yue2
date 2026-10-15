// Write-back of key and meter changes (serializeAbc) in the official group form: round trips of every fixture
// (the official SheetSage2 exporter samples included), the official abc_tools.py check, and the editing paths
// that must keep working with non-uniform bars (transpose, instrumental transform, MIDI, bar arithmetic).
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Midi } from "@tonejs/midi";
import { parseAbc } from "../parse";
import { serializeAbc } from "../serialize";
import { validateNativeAbc } from "../native";
import { compareScores } from "../compare";
import { PPQ, barAtTick, barStartTick, cloneScore, keyAtTick, meterAtTick, recomputeBars, type Score } from "../model";
import { moveNotes, transposeScore } from "../edit";
import { toInstrumental } from "../instrumental";
import { midiToScore, scoreToMidi } from "../midi";

const fx = (name: string) => readFileSync(join(__dirname, "..", "__fixtures__", name), "utf8");
const PLAIN = ["full_en.abc", "full_ja.abc", "full_long.abc", "melody_cover.abc", "official_score.abc", "official_melody.abc", "official_example_ins.abc", "plan_l32.abc", "transcription_l16.abc"];
const SS2 = ["ss2_plain_melody.abc", "ss2_plain_full.abc", "ss2_pickup_key_melody.abc", "ss2_pickup_key_full.abc", "ss2_meter_melody.abc", "ss2_meter_full.abc"];
const FIXTURES = [...PLAIN, ...SS2];

/** Native skeleton (L:1/16, 4/4, C) with optional groups after the first one. */
function abc(vocal: string, ins = "Z|", extra = "", key = "C", meter = "4/4") {
  return (
    `X:1\nT:\nM:${meter}\nL:1/16\nQ:1/4=120\n` +
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n' +
    'V: Ins clef=treble name="Ins Melody" snm="Inst."\n' +
    `K:${key}\n% verse\nV: Vocal\n${vocal}\nV: Ins\n${ins}\n${extra}`
  );
}
const U = PPQ / 4; // ticks per 1/16 unit
const BAR = 4 * PPQ; // a 4/4 bar
const noteList = (s: Score) => s.notes.map((n) => `${n.voice}:${n.start}:${n.duration}:${n.pitch}`).sort();

/** parse -> serialize -> parse must give the same music, timelines, sections and bar grid, and native-valid text. */
function expectRoundTrip(text: string): { score: Score; out: string; back: Score } {
  const score = parseAbc(text);
  const out = serializeAbc(score);
  const back = parseAbc(out);
  expect(compareScores(score, back).lines).toEqual([]);
  expect(noteList(back)).toEqual(noteList(score));
  expect(back.chords).toEqual(score.chords);
  expect(back.sections).toEqual(score.sections);
  expect(back.keyChanges).toEqual(score.keyChanges);
  expect(back.meterChanges).toEqual(score.meterChanges);
  expect(back.key).toBe(score.key);
  expect(back.meter).toEqual(score.meter);
  expect(back.bars).toBe(score.bars);
  expect(validateNativeAbc(out).errors).toEqual([]);
  expect(serializeAbc(back)).toBe(out); // stable
  return { score, out, back };
}

describe("serializeAbc round trip with key and meter changes", () => {
  for (const name of FIXTURES) {
    it(`round-trips ${name}`, () => {
      expectRoundTrip(fx(name));
    });
  }

  it("reproduces the official exporter's melody-only samples byte for byte", () => {
    for (const name of ["ss2_plain_melody.abc", "ss2_pickup_key_melody.abc", "ss2_meter_melody.abc"]) {
      expect(serializeAbc(parseAbc(fx(name))), name).toBe(fx(name));
    }
  });

  it("writes a bar-line key change as K: under both voices of a new group", () => {
    const out = serializeAbc(parseAbc(fx("ss2_pickup_key_full.abc")));
    expect(out).toContain('% chorus\nV: Vocal\nK:Am\n"Am"z4C2z2E4^C2z2|"Am"D4G2z2D2z2C4|"Am"C4F4D4E4|"Am"G2z2E2z2G6z2|\nV: Ins\nK:Am\nZ4|\n');
    expect(out.match(/^K:/gm)).toHaveLength(3); // header + both voices once
  });

  it("writes an inline key change in both voices before the chord symbol, and meter changes as M: groups", () => {
    const out = serializeAbc(parseAbc(fx("ss2_meter_full.abc")));
    expect(out).toContain('\nV: Vocal\n"C/E"z4[K:Am]"Am"z4E2z2B,2z2|"Am"^C2z2C4E4C4|\nV: Ins\nz4[K:Am]z12|Z|\n');
    expect(out).toContain('\nV: Vocal\nM:3/4\n"Am"C4F4D2z2|\nV: Ins\nM:3/4\nZ|\nV: Vocal\nM:1/4\n"Am"^C4|\nV: Ins\nM:1/4\nZ|\n');
    expect(out).toContain('% outro\nV: Vocal\nM:4/4\n"Am"z16|Z3|\nV: Ins\nM:4/4\n');
    expect(out).not.toContain("K:Am\n"); // the inline change is not repeated as a K: line at the next group
  });

  it("ties a held note across an inline key change and never compresses such a bar to Z", () => {
    const text = abc("E8-[K:Am]E8|", "z8[K:Am]z8|");
    const { score, out } = expectRoundTrip(text);
    expect(score.keyChanges).toEqual([{ tick: 8 * U, key: "Am" }]);
    expect(score.notes.filter((n) => n.voice === "Vocal")).toMatchObject([{ start: 0, duration: 16 * U, pitch: 64 }]);
    expect(out).toContain("\nV: Vocal\nE8-[K:Am]E8|\nV: Ins\nz8[K:Am]z8|\n");
    // built by hand: a plain score plus a key change inside the bar (the note is split with a tie at the change)
    const built = parseAbc(abc("E16|", "Z|"));
    built.keyChanges = [{ tick: 8 * U, key: "Am" }];
    expect(serializeAbc(built)).toBe(out);
    // a chord at the change: [K:] first, then the chord
    const withChord = parseAbc(abc('"C"z16|', "Z|"));
    withChord.keyChanges = [{ tick: 4 * U, key: "Am" }];
    withChord.chords.push({ start: 4 * U, symbol: "Am" });
    expect(serializeAbc(withChord)).toContain('\nV: Vocal\n"C"z4[K:Am]"Am"z12|\nV: Ins\nz4[K:Am]z12|\n');
  });

  it("uses the new key signature and resets accidentals after an inline change", () => {
    // F#4 in C, then after [K:D] an F# (in the signature) and an F natural (explicit)
    const s = parseAbc(abc("^F8[K:D]F4=F4|", "z8[K:D]z8|"));
    expect(s.notes.map((n) => n.pitch)).toEqual([66, 66, 65]);
    const out = serializeAbc(s);
    expect(out).toContain("\nV: Vocal\n^F8[K:D]F4=F4|\nV: Ins\nz8[K:D]z8|\n");
    expect(parseAbc(out).notes.map((n) => n.pitch)).toEqual([66, 66, 65]);
  });

  it("writes a bar-line key change built by hand as a K: group", () => {
    const s = parseAbc(abc("C16|F16|", "Z2|"));
    s.keyChanges = [{ tick: BAR, key: "G" }];
    const out = serializeAbc(s);
    expect(out).toContain("% verse\nV: Vocal\nC16|\nV: Ins\nZ|\nV: Vocal\nK:G\n=F16|\nV: Ins\nK:G\nZ|\n");
    const back = parseAbc(out);
    expect(back.keyChanges).toEqual(s.keyChanges);
    expect(back.notes.map((n) => n.pitch)).toEqual([60, 65]);
    expect(validateNativeAbc(out).errors).toEqual([]);
  });

  it("writes a 4/4 -> 3/4 -> 4/4 meter change with the bar grid of the timeline", () => {
    const text = abc("C16|", "Z|", "V: Vocal\nM:3/4\nD12|\nV: Ins\nM:3/4\nZ|\nV: Vocal\nM:4/4\nE16|\nV: Ins\nM:4/4\nZ|\n");
    const { score, out } = expectRoundTrip(text);
    expect(score.meterChanges).toEqual([
      { tick: BAR, meter: [3, 4] },
      { tick: BAR + 3 * PPQ, meter: [4, 4] },
    ]);
    expect(barStartTick(score, 2)).toBe(BAR + 3 * PPQ);
    expect(out).toBe(text);
    // by hand: the same timeline on a plain score
    const built = parseAbc(abc("C16|", "Z|"));
    built.notes.push({ id: 98, voice: "Vocal", start: BAR, duration: 12 * U, pitch: 62 }, { id: 99, voice: "Vocal", start: BAR + 3 * PPQ, duration: 16 * U, pitch: 64 });
    built.meterChanges = [
      { tick: BAR, meter: [3, 4] },
      { tick: BAR + 3 * PPQ, meter: [4, 4] },
    ];
    built.bars = recomputeBars(built);
    expect(serializeAbc(built)).toBe(text);
  });

  it("splits a section at a change in its middle without repeating the label", () => {
    const s = parseAbc(abc("C16|C16|C16|C16|C16|C16|", "Z4|Z2|"));
    s.keyChanges = [{ tick: 3 * BAR, key: "Am" }];
    const out = serializeAbc(s);
    expect(out.match(/^% /gm)).toHaveLength(1);
    expect(out).toContain("% verse\nV: Vocal\nC16|C16|C16|\nV: Ins\nZ3|\nV: Vocal\nK:Am\nC16|C16|C16|\nV: Ins\nK:Am\nZ3|\n");
    const back = parseAbc(out);
    expect(back.sections).toEqual([{ name: "verse", bar: 0 }]);
    expect(back.keyChanges).toEqual(s.keyChanges);
    expect(back.bars).toBe(6);
    // a meter change in the middle of a section, on a plain 4-bar block boundary too
    const m = parseAbc(abc("C16|C16|C16|C16|C16|C16|", "Z4|Z2|"));
    m.meterChanges = [{ tick: 4 * BAR, meter: [2, 4] }];
    const mo = serializeAbc(m);
    expect(mo).toContain("V: Vocal\nM:2/4\nC8-|C8|C8-|C8|\nV: Ins\nM:2/4\nZ4|\n");
    expect(parseAbc(mo).meterChanges).toEqual(m.meterChanges);
  });

  it("writes an irregular bar before an off-grid meter change with its actual length", () => {
    const s = parseAbc(abc("C16|D16|", "Z2|"));
    s.meterChanges = [{ tick: BAR + BAR / 2, meter: [3, 4] }]; // half a bar into bar 2
    const out = serializeAbc(s);
    expect(out).toContain("V: Vocal\nC16|D8-|\nV: Ins\nZ|z8|\nV: Vocal\nM:3/4\nD8z4|\nV: Ins\nM:3/4\nZ|\n");
    const back = parseAbc(out);
    expect(back.meterChanges).toEqual(s.meterChanges);
    expect(noteList(back)).toEqual(noteList(s));
    expect(barAtTick(back, BAR + BAR / 2)).toBe(2);
  });

  it("drops restated keys and meters and folds a change at tick 0 into the header", () => {
    const s = parseAbc(abc("C16|C16|", "Z2|"));
    s.keyChanges = [
      { tick: 0, key: "G" },
      { tick: BAR, key: "G major" },
    ];
    s.meterChanges = [{ tick: BAR, meter: [4, 4] }];
    const out = serializeAbc(s);
    expect(out).toContain("\nK:G\n% verse\nV: Vocal\nC16|C16|\nV: Ins\nZ2|\n");
    expect(parseAbc(out).keyChanges).toEqual([]);
    expect(parseAbc(out).meterChanges).toEqual([]);
  });

  it("raises L: to the four-subbeat floor of every meter in the score", () => {
    const s = parseAbc(abc("C16|", "Z|"));
    s.meterChanges = [{ tick: BAR, meter: [5, 8] }];
    s.bars = 2;
    const out = serializeAbc(s);
    expect(out).toContain("L:1/32\n");
    expect(out).toContain("V: Vocal\nM:5/8\nZ|\nV: Ins\nM:5/8\nZ|\n");
    expect(validateNativeAbc(out).errors).toEqual([]);
    expect(validateNativeAbc(out).warnings).toEqual([]);
  });
});

describe("editing with key and meter changes", () => {
  it("transposes the header key, every key change and the chords in their own key", () => {
    const s = parseAbc(fx("ss2_pickup_key_full.abc"));
    const up = transposeScore(s, 1)!;
    expect(up.keyUnchanged).toBe(false);
    expect(up.score.key).toBe("Ab");
    expect(up.score.keyChanges).toEqual([{ tick: s.keyChanges![0].tick, key: "Bbm" }]);
    const chordAt = (score: Score, tick: number) => score.chords.find((c) => c.start === tick)!.symbol;
    const chorus = s.keyChanges![0].tick;
    expect(chordAt(s, chorus)).toBe("Am");
    expect(chordAt(up.score, chorus)).toBe("Bbm"); // flats: the key in effect there is Bbm
    expect(chordAt(up.score, s.chords[0].start)).toBe("Ab");
    const out = serializeAbc(up.score);
    expect(validateNativeAbc(out).errors).toEqual([]);
    expect(out).toContain("\nK:Ab\n");
    expect(out).toContain("\nV: Vocal\nK:Bbm\n");
    // and back down
    const down = transposeScore(up.score, -1)!;
    expect(noteList(down.score)).toEqual(noteList(s));
    expect(down.score.keyChanges).toEqual(s.keyChanges);
    expect(down.score.key).toBe("G");
    // an octave shift leaves every key alone
    expect(transposeScore(s, 12)!.score.keyChanges).toEqual(s.keyChanges);
  });

  it("keeps the timelines through the instrumental transform, and the result stays native", () => {
    for (const name of ["ss2_meter_full.abc", "ss2_pickup_key_full.abc", "official_example_ins.abc"]) {
      const s = parseAbc(fx(name));
      const r = toInstrumental(s);
      expect(r.score.keyChanges).toEqual(s.keyChanges);
      expect(r.score.meterChanges).toEqual(s.meterChanges);
      const out = serializeAbc(r.score);
      expect(validateNativeAbc(out).errors, name).toEqual([]);
      const back = parseAbc(out);
      expect(back.notes.some((n) => n.voice === "Vocal")).toBe(false);
      expect(back.keyChanges).toEqual(s.keyChanges);
      expect(back.meterChanges).toEqual(s.meterChanges);
      expect(back.bars).toBe(s.bars);
    }
  });

  it("moves notes across a meter change on the tick grid and keeps the bar count right", () => {
    const s = parseAbc(fx("ss2_meter_full.abc"));
    const chorus = s.notes.filter((n) => n.voice === "Vocal" && n.start >= barStartTick(s, 9));
    const moved = moveNotes(s.notes, new Set(chorus.map((n) => n.id)), U)!;
    const next = { ...s, notes: moved, bars: Math.max(s.bars, recomputeBars({ ...s, notes: moved })) };
    expect(next.bars).toBe(s.bars);
    const out = serializeAbc(next);
    expect(validateNativeAbc(out).errors).toEqual([]);
    expect(noteList(parseAbc(out))).toEqual(noteList(next));
    // bar arithmetic follows the timeline: the 1/4 bars are one quarter long
    const quarterBar = s.meterChanges!.find((c) => c.meter[0] === 1)!.tick;
    expect(meterAtTick(s, quarterBar)).toEqual([1, 4]);
    expect(barStartTick(s, barAtTick(s, quarterBar) + 1)).toBe(quarterBar + PPQ);
    expect(keyAtTick(s, quarterBar)).toBe("Am");
  });
});

describe("MIDI export and import of key and meter changes", () => {
  it("writes real key signatures (sharps count, mode) despite the @tonejs/midi encoder offset", () => {
    const s = parseAbc(fx("ss2_meter_full.abc"));
    const bytes = scoreToMidi(s);
    const sigs: number[][] = [];
    for (let i = 0; i + 4 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0x59 && bytes[i + 2] === 2) sigs.push([bytes[i + 3], bytes[i + 4]]);
    expect(sigs).toEqual([
      [1, 0], // G major
      [0, 1], // A minor
    ]);
    expect(new Midi(bytes).header.keySignatures.map((k) => [k.key, k.scale])).toEqual([
      ["G", "major"],
      ["C", "minor"],
    ]);
    // a minor-type mode and a flat key
    const modal = parseAbc(abc("C16|", "Z|", "", "Edor"));
    modal.keyChanges = [{ tick: BAR, key: "Bb" }];
    const kb = new Midi(scoreToMidi(modal)).header.keySignatures.map((k) => [k.key, k.scale]);
    expect(kb).toEqual([
      ["D", "minor"],
      ["Bb", "major"],
    ]);
  });

  it("round-trips key and meter changes through MIDI", () => {
    for (const name of ["ss2_meter_full.abc", "ss2_pickup_key_full.abc", "official_example_ins.abc"]) {
      const s = parseAbc(fx(name));
      const r = midiToScore(scoreToMidi(s), null, { unit: s.unit });
      expect(r.warnings, name).toEqual([]);
      expect(r.score.key, name).toBe(s.key);
      expect(r.score.meter, name).toEqual(s.meter);
      expect(r.score.keyChanges, name).toEqual(s.keyChanges);
      expect(r.score.meterChanges, name).toEqual(s.meterChanges);
      expect(r.score.bars, name).toBe(s.bars);
      expect(noteList(r.score), name).toEqual(noteList(s));
    }
    // a foreign file: minor scale at tick 0, later change on the grid
    const m = new Midi();
    m.header.setTempo(120);
    m.header.keySignatures = [{ ticks: 0, key: "F", scale: "minor" }];
    m.header.timeSignatures = [{ ticks: 0, timeSignature: [3, 4] }, { ticks: m.header.ppq * 6, timeSignature: [4, 4] }];
    m.header.update();
    const t = m.addTrack();
    t.name = "Vocal";
    t.addNote({ midi: 60, ticks: 0, durationTicks: m.header.ppq });
    const bytes = m.toArray();
    // @tonejs/midi's own encoder shifts the key: repair the byte as a DAW would have written it (Dm = -1 flat)
    for (let i = 0; i + 4 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0x59 && bytes[i + 2] === 2) bytes[i + 3] = 0xff;
    const r = midiToScore(bytes, null, { unit: 16 });
    expect(r.score.key).toBe("Dm");
    expect(r.score.meter).toEqual([3, 4]);
    expect(r.score.meterChanges).toEqual([{ tick: 6 * PPQ, meter: [4, 4] }]);
    expect(r.score.keyChanges).toEqual([]);
    // without a base score's timelines: the file's win; without any signature the base's stay
    const base = parseAbc(fx("ss2_meter_full.abc"));
    const plain = new Midi();
    plain.header.setTempo(120);
    plain.addTrack().addNote({ midi: 60, ticks: 0, durationTicks: 480 });
    const kept = midiToScore(plain.toArray(), base, { unit: 16 });
    expect(kept.score.keyChanges).toEqual(base.keyChanges);
    expect(kept.score.meterChanges).toEqual(base.meterChanges);
  });
});

// The official helper: python abc_tools.py compare <fixture> <re-serialized> must report a match for every
// fixture (same sounding notes and bar grid), and inspect must accept the hand-built cases. Skipped when the
// embedded interpreter or the script is not available (set MCS_YUE2_PYTHON / YUE2_ABC_TOOLS to point at them).
const PYTHON = process.env.MCS_YUE2_PYTHON ?? "C:/MCSYuE2/runtime/ComfyUI_windows_portable/python_embeded/python.exe";
const ABC_TOOLS = process.env.YUE2_ABC_TOOLS ?? "";
const official = existsSync(PYTHON) && ABC_TOOLS !== "" && existsSync(ABC_TOOLS);

describe.skipIf(!official)("official abc_tools.py", () => {
  const run = (args: string[]) => spawnSync(PYTHON, ["-B", "-X", "utf8", ABC_TOOLS, ...args], { encoding: "utf8" });

  it("compare: every re-serialized fixture keeps the official invariants", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcs-abc-"));
    try {
      for (const name of FIXTURES) {
        const before = join(dir, `before-${name}`);
        const after = join(dir, `after-${name}`);
        writeFileSync(before, fx(name), "utf8");
        writeFileSync(after, serializeAbc(parseAbc(fx(name))), "utf8");
        const r = run(["compare", before, after]);
        expect(r.status, `${name}: ${r.stderr}${r.stdout}`).toBe(0);
        expect(JSON.parse(r.stdout).match, name).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inspect: accepts the hand-built change cases and the transposed / instrumental scores", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcs-abc-"));
    try {
      const held = parseAbc(abc("E16|", "Z|"));
      held.keyChanges = [{ tick: 8 * U, key: "Am" }];
      const bar = parseAbc(abc("C16|F16|", "Z2|"));
      bar.keyChanges = [{ tick: BAR, key: "G" }];
      const meter = parseAbc(abc("C16|", "Z|", "V: Vocal\nM:3/4\nD12|\nV: Ins\nM:3/4\nZ|\nV: Vocal\nM:4/4\nE16|\nV: Ins\nM:4/4\nZ|\n"));
      const mid = parseAbc(abc("C16|C16|C16|C16|C16|C16|", "Z4|Z2|"));
      mid.keyChanges = [{ tick: 3 * BAR, key: "Am" }];
      const cases: Record<string, string> = {
        held: serializeAbc(held),
        bar: serializeAbc(bar),
        meter: serializeAbc(meter),
        mid: serializeAbc(mid),
        transposed: serializeAbc(transposeScore(parseAbc(fx("ss2_pickup_key_full.abc")), 1)!.score),
        instrumental: serializeAbc(toInstrumental(parseAbc(fx("ss2_meter_full.abc"))).score),
      };
      for (const [name, text] of Object.entries(cases)) {
        const file = join(dir, `${name}.abc`);
        writeFileSync(file, text, "utf8");
        const r = run(["inspect", file]);
        expect(r.status, `${name}: ${r.stderr}`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cloneScore keeps the timelines", () => {
  it("copies key and meter changes", () => {
    const s = parseAbc(fx("ss2_meter_full.abc"));
    const c = cloneScore(s);
    expect(c.keyChanges).toEqual(s.keyChanges);
    expect(c.meterChanges).toEqual(s.meterChanges);
    expect(c.meterChanges).not.toBe(s.meterChanges);
  });
});
