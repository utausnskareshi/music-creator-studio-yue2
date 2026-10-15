import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbc } from "../parse";
import { Midi } from "@tonejs/midi";
import { midiToScore, scoreToMidi } from "../midi";
import { PPQ } from "../model";
import { serializeAbc } from "../serialize";

const fx = (name: string) => readFileSync(join(__dirname, "..", "__fixtures__", name), "utf8");

describe("MIDI round trip", () => {
  it("writes meter changes as time signatures", () => {
    const s = parseAbc(fx("official_example_ins.abc"));
    const h = new Midi(scoreToMidi(s)).header;
    expect(h.timeSignatures.map((t) => [t.ticks, ...t.timeSignature])).toEqual([
      [0, 4, 4],
      [(4 * 4 * PPQ * h.ppq) / PPQ, 5, 8],
    ]);
    const r = midiToScore(scoreToMidi(s), s, { unit: 32, vocalTrack: 0, insTrack: 1 });
    expect(r.score.notes.filter((n) => n.voice === "Ins").map((n) => n.pitch)).toEqual(s.notes.filter((n) => n.voice === "Ins").map((n) => n.pitch));
  });

  it("exports and re-imports notes on the 1/32 grid", () => {
    const score = parseAbc(fx("full_en.abc"));
    const bytes = scoreToMidi(score);
    expect(bytes.length).toBeGreaterThan(100);
    const r = midiToScore(bytes, score, { unit: 32 });
    expect(r.score.bpm).toBe(score.bpm);
    expect(r.score.meter).toEqual(score.meter);
    const key = (n: { voice: string; start: number; duration: number; pitch: number }) => `${n.voice}:${n.start}:${n.duration}:${n.pitch}`;
    expect(r.score.notes.map(key).sort()).toEqual(score.notes.map(key).sort());
    // chords/sections are kept from the base score, so the ABC still serializes.
    expect(serializeAbc(r.score)).toContain('"C"');
  });
});

interface TrackSpec {
  name: string;
  channel?: number;
  /** notes as [beat, beats, pitch] */
  notes: [number, number, number][];
}

/** A MIDI file with the given tempo events (beat, bpm; file order kept) and tracks, at the library's PPQ. */
function midiFile(tempos: [number, number][], tracks: TrackSpec[], meters: [number, number, number][] = []): Uint8Array {
  const m = new Midi();
  const q = m.header.ppq;
  m.header.tempos = tempos.map(([beat, bpm]) => ({ ticks: beat * q, bpm }));
  m.header.timeSignatures = meters.map(([beat, n, d]) => ({ ticks: beat * q, timeSignature: [n, d] }));
  m.header.update();
  for (const t of tracks) {
    const track = m.addTrack();
    track.name = t.name;
    track.channel = t.channel ?? 0;
    for (const [beat, beats, pitch] of t.notes) track.addNote({ midi: pitch, ticks: beat * q, durationTicks: beats * q });
  }
  return m.toArray();
}

const quarters = (count: number, pitch = 60): [number, number, number][] => Array.from({ length: count }, (_, i) => [i, 1, pitch]);
const onsets = (r: { score: { notes: { voice: string; start: number }[] } }, voice = "Vocal") =>
  r.score.notes.filter((n) => n.voice === voice).map((n) => n.start / PPQ);

describe("MIDI import positions (ticks, not seconds)", () => {
  it("keeps the beats after a tempo change, and a meter change on its bar", () => {
    const bytes = midiFile([[0, 120], [8, 60]], [{ name: "Vocal", notes: quarters(16) }], [[0, 4, 4], [12, 3, 4]]);
    const r = midiToScore(bytes, null, { unit: 16 });
    expect(onsets(r)).toEqual([...Array(16).keys()]);
    expect(r.score.notes.every((n) => n.duration === PPQ)).toBe(true);
    expect(r.score.meterChanges).toEqual([{ tick: 12 * PPQ, meter: [3, 4] }]);
    expect(r.score.bpm).toBe(120);
    expect(r.warnings.some((w) => w.includes("途中のテンポ変化"))).toBe(true);
  });

  it("uses the last tempo at tick 0 and keeps the rhythm with duplicated tick-0 tempos", () => {
    const r = midiToScore(midiFile([[0, 120], [0, 100]], [{ name: "Vocal", notes: quarters(8) }]), null);
    expect(r.score.bpm).toBe(100);
    expect(onsets(r)).toEqual([...Array(8).keys()]);
    expect(r.warnings.some((w) => w.includes("テンポ変化"))).toBe(false);
  });

  it("keeps late notes on their beats with a fractional tempo", () => {
    const r = midiToScore(midiFile([[0, 127.5]], [{ name: "Vocal", notes: [[300, 1, 60], [301, 1, 62]] }]), null);
    expect(r.score.bpm).toBe(128);
    expect(onsets(r)).toEqual([300, 301]);
    expect(r.warnings.some((w) => w.includes("127.5"))).toBe(true);
  });

  it("does not stretch a file without tempo events onto a score at another tempo", () => {
    const base = parseAbc(fx("full_en.abc"));
    const r = midiToScore(midiFile([], [{ name: "Vocal", notes: quarters(4) }]), { ...base, bpm: 90 });
    expect(onsets(r)).toEqual([0, 1, 2, 3]);
    expect(r.score.bpm).toBe(120); // the MIDI default
  });

  it("restating the same tempo gives no warning (a whole BPM reads back as a near value)", () => {
    const r = midiToScore(midiFile([[0, 90], [16, 90]], [{ name: "Vocal", notes: quarters(4) }]), null);
    expect(r.score.bpm).toBe(90);
    expect(r.warnings).toEqual([]);
  });
});

describe("MIDI import track choice", () => {
  it("never puts a drum track (channel 10) into a voice", () => {
    const r = midiToScore(midiFile([[0, 120]], [{ name: "Drums", channel: 9, notes: quarters(4, 36) }, { name: "Piano", notes: quarters(4, 64) }]), null);
    expect(r.score.notes.filter((n) => n.voice === "Vocal").map((n) => n.pitch)).toEqual([64, 64, 64, 64]);
    expect(r.score.notes.filter((n) => n.voice === "Ins")).toEqual([]);
    expect(r.warnings.some((w) => w.includes('ドラム（チャンネル10）のトラック "Drums"'))).toBe(true);
  });

  it("assigns lead and bass around a drum track", () => {
    const tracks = [
      { name: "Drums", channel: 9, notes: quarters(4, 36) },
      { name: "Synth Lead", notes: quarters(4, 72) },
      { name: "Bass", notes: quarters(4, 40) },
    ];
    const r = midiToScore(midiFile([[0, 120]], tracks), null);
    expect(new Set(r.score.notes.filter((n) => n.voice === "Vocal").map((n) => n.pitch))).toEqual(new Set([72]));
    expect(new Set(r.score.notes.filter((n) => n.voice === "Ins").map((n) => n.pitch))).toEqual(new Set([40]));
  });

  it("refuses a file with only drum notes instead of returning an empty score", () => {
    expect(() => midiToScore(midiFile([[0, 120]], [{ name: "Drums", channel: 9, notes: quarters(4, 36) }]), null)).toThrow(/ドラム/);
  });

  it("names the voice in Japanese when overlapping notes are dropped", () => {
    const r = midiToScore(midiFile([[0, 120]], [{ name: "Vocal", notes: [[0, 2, 60], [0, 2, 64], [0, 2, 67]] }]), null);
    expect(r.warnings.some((w) => w.startsWith("ボーカル: "))).toBe(true);
  });
});

/** Variable-length quantity (SMF delta times). */
const vlq = (n: number): number[] => {
  const out = [n & 0x7f];
  while ((n >>>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
};
type RawEvent = [delta: number, ...bytes: number[]];
/**
 * A format-0 SMF built byte by byte (the @tonejs encoder cannot write an SMPTE division, a broken signature or a
 * key signature correctly): a track named "Vocal" with the given events, at the given division word.
 */
function rawMidi(events: RawEvent[], division = 480): Uint8Array {
  const body = [[0, 0xff, 0x03, 5, ...[..."Vocal"].map((c) => c.charCodeAt(0))] as RawEvent, ...events, [0, 0xff, 0x2f, 0] as RawEvent].flatMap(([delta, ...bytes]) => [...vlq(delta), ...bytes]);
  const n = body.length;
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (division >> 8) & 0xff, division & 0xff, 0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body]);
}
const timeSig = (num: number, denPow: number, delta = 0): RawEvent => [delta, 0xff, 0x58, 4, num, denPow, 24, 8];
const keySig = (sharps: number, minor = 0, delta = 0): RawEvent => [delta, 0xff, 0x59, 2, sharps & 0xff, minor];
const tempoUs = (us: number, delta = 0): RawEvent => [delta, 0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
/** quarter notes at division 480 */
const rawQuarters = (pitches: number[]): RawEvent[] => pitches.flatMap((p): RawEvent[] => [[0, 0x90, p, 100], [480, 0x80, p, 0]]);

describe("MIDI import of files it cannot hold", () => {
  it("refuses an SMPTE (timecode) or zero time division instead of an empty score reported as read", () => {
    for (const division of [0xe728, 0]) {
      // every note came out at NaN and the score serialized to its header lines only
      expect(() => midiToScore(rawMidi(rawQuarters([62, 60]), division), null)).toThrow(/拍単位ではない MIDI/);
    }
  });

  it("ignores a time signature with no or a degenerate bar, with a warning", () => {
    // 0/4 and 1/4096: 0-tick bars, and the commit's serializeAbc never ended; 4/2^31: a negative denominator
    // under which every note was dropped
    for (const [num, denPow, shown] of [[0, 2, "0/4"], [1, 12, "1/4096"], [4, 31, "4/-2147483648"]] as const) {
      const r = midiToScore(rawMidi([timeSig(num, denPow), ...rawQuarters([60, 62, 64, 65, 67])]), null);
      expect(r.score.meter).toEqual([4, 4]);
      expect(r.warnings).toContain(`拍子 ${shown} は扱えないため無視しました`);
      expect(r.score.bars).toBe(2);
      expect(serializeAbc(r.score)).toContain("V: Vocal\nC4D4E4F4|G4z12|");
    }
    // a broken later change is skipped the same way; the header meter stays
    const r = midiToScore(rawMidi([timeSig(3, 2), ...rawQuarters([60, 62, 64]), timeSig(0, 2), ...rawQuarters([65])]), null);
    expect(r.score.meter).toEqual([3, 4]);
    expect(r.score.meterChanges).toEqual([]);
  });

  it("uses 120 BPM for a tempo of 0 µs (Infinity), with a warning", () => {
    const r = midiToScore(rawMidi([tempoUs(0), ...rawQuarters([60])]), null);
    expect(r.score.bpm).toBe(120);
    expect(r.warnings).toContain("テンポの値が不正なため 120 BPM にしました");
    expect(serializeAbc(r.score)).toContain("Q:1/4=120\n");
  });

  it("refuses a file longer than the score can hold", () => {
    // a note 20000 bars in: the commit would write millions of rest bars
    expect(() => midiToScore(rawMidi([[480 * 4 * 20000, 0x90, 60, 100], [480, 0x80, 60, 0]]), null)).toThrow(/曲が長すぎるため読み込めません/);
  });
});

describe("MIDI import of signatures restated at tick 0", () => {
  it("uses the last time signature at tick 0, the one in effect (as for the tempo)", () => {
    const r = midiToScore(rawMidi([timeSig(4, 2), timeSig(3, 2), ...rawQuarters([62, 62, 62, 62, 62, 62])]), null);
    expect(r.score.meter).toEqual([3, 4]);
    expect(r.score.meterChanges).toEqual([]);
    expect(r.score.bars).toBe(2);
  });

  it("uses the last key signature at tick 0", () => {
    const r = midiToScore(rawMidi([keySig(0), keySig(2), ...rawQuarters([62, 66])]), null);
    expect(r.score.key).toBe("D");
    expect(r.score.keyChanges).toEqual([]);
    // a later change still counts
    const later = midiToScore(rawMidi([keySig(0), keySig(2), ...rawQuarters([62]), keySig(-1), ...rawQuarters([65])]), null);
    expect(later.score.key).toBe("D");
    expect(later.score.keyChanges).toEqual([{ tick: PPQ, key: "F" }]);
  });
});
