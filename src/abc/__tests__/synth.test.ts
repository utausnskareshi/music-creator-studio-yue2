// Score preview: the audio graph holds the notes of the next half minute, not the whole score (every connected
// node costs the audio thread on each render quantum, so a 900 s score made the preview drop out).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyScore, PPQ, type Note } from "../model";
import { playScore } from "../synth";

class FakeParam {
  value = 0;
  setValueAtTime() {
    return this;
  }
  exponentialRampToValueAtTime() {
    return this;
  }
}
class FakeNode {
  connect<T>(n: T): T {
    return n;
  }
  disconnect() {}
}
class FakeOsc extends FakeNode {
  type = "";
  frequency = new FakeParam();
  startAt: number | null = null;
  stoppedNow = false;
  start(t: number) {
    this.startAt = t;
  }
  stop(t?: number) {
    if (t === undefined) this.stoppedNow = true;
  }
}
class FakeContext {
  static last: FakeContext;
  currentTime = 0;
  state = "running";
  destination = new FakeNode();
  oscillators: FakeOsc[] = [];
  constructor() {
    FakeContext.last = this;
  }
  createOscillator() {
    const o = new FakeOsc();
    this.oscillators.push(o);
    return o;
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: "", frequency: new FakeParam() });
  }
  resume() {}
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("window", globalThis);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A 900 s score at 120 BPM: 1800 quarter notes in a row (0.5 s each). */
const longScore = () => {
  const notes: Note[] = Array.from({ length: 1800 }, (_, i) => ({ id: i + 1, voice: "Vocal", start: i * PPQ, duration: PPQ, pitch: 60 + (i % 12) }));
  return { ...emptyScore(), notes, bars: 450 };
};

/** Let the context clock and the timers run to `seconds`. */
const runTo = (seconds: number) => {
  const ac = FakeContext.last;
  while (ac.currentTime < seconds) {
    ac.currentTime += 1;
    vi.advanceTimersByTime(1000);
  }
};

describe("playScore", () => {
  it("makes nodes only for the next 30 s, then tops them up as the preview plays", () => {
    let ended = 0;
    const h = playScore(longScore(), 0, () => ended++);
    const ac = FakeContext.last;
    // notes start at 0.05 + 0.5 k s: those before 30.05 s, not all 1800
    expect(ac.oscillators).toHaveLength(60);
    runTo(10);
    expect(ac.oscillators).toHaveLength(80); // up to 10 + 30 s
    runTo(905);
    expect(ac.oscillators).toHaveLength(1800);
    // every note was scheduled at its own time, once
    expect(ac.oscillators.map((o) => o.startAt)).toEqual(Array.from({ length: 1800 }, (_, i) => 0.05 + i * 0.5));
    expect(ended).toBe(1);
    h.stop(); // after the end: nothing more
    expect(ended).toBe(1);
  });

  it("stop() silences the scheduled notes and makes no more", () => {
    FakeContext.last.currentTime = 0;
    FakeContext.last.oscillators = [];
    let ended = 0;
    const h = playScore(longScore(), 0, () => ended++);
    const ac = FakeContext.last;
    runTo(20);
    const made = ac.oscillators.length;
    h.stop();
    expect(ended).toBe(1);
    // the notes still to sound are stopped now
    expect(ac.oscillators.filter((o) => (o.startAt ?? 0) >= 20).every((o) => o.stoppedNow)).toBe(true);
    runTo(120);
    expect(ac.oscillators).toHaveLength(made);
    expect(ended).toBe(1);
  });

  it("starts from a later position, cutting a held note at the start", () => {
    FakeContext.last.currentTime = 0;
    FakeContext.last.oscillators = [];
    const h = playScore(longScore(), 1000 * PPQ + PPQ / 2, () => {});
    const ac = FakeContext.last;
    expect(ac.oscillators[0].startAt).toBe(0.05); // the note under the start position, from its middle
    expect(ac.oscillators[1].startAt).toBe(0.3); // then every 0.5 s: 60 more before 30.05 s
    expect(ac.oscillators).toHaveLength(61);
    h.stop();
  });
});
