// Tiny offline WebAudio synth for previewing a score (no soundfont download needed).
import { secondsToTicks, ticksToSeconds, type Note, type Score } from "./model";

export interface PlaybackHandle {
  stop: () => void;
  /** current position in ticks */
  position: () => number;
  readonly startedAt: number;
}

let ctx: AudioContext | null = null;
function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/**
 * The audio graph holds the notes that start in the next LOOKAHEAD seconds, topped up every REFILL_MS: every
 * connected node costs the audio thread on each render quantum, so the whole score at once (a 900 s score) made
 * the preview drop out, and every seek rebuilt it all. The refill keeps 20 s or more ahead, past timer throttling.
 */
const LOOKAHEAD = 30;
const REFILL_MS = 10_000;

/** Play the score from `fromTick`. Vocal = triangle lead, Ins = soft saw; chords are ignored. */
export function playScore(score: Score, fromTick = 0, onEnd?: () => void): PlaybackHandle {
  const ac = audio();
  if (ac.state === "suspended") ac.resume();
  const master = ac.createGain();
  master.gain.value = 0.35;
  master.connect(ac.destination);
  const t0 = ac.currentTime + 0.05;
  const bpm = score.bpm || 120;
  let endTime = t0;
  /** the notes still to sound, with their start / end on the context clock, in start order */
  const queue: { n: Note; s: number; e: number }[] = [];
  for (const n of score.notes) {
    const start = n.start - fromTick;
    if (start + n.duration <= 0) continue;
    const s = t0 + ticksToSeconds(Math.max(0, start), bpm);
    const e = t0 + ticksToSeconds(start + n.duration, bpm);
    if (e <= s) continue;
    queue.push({ n, s, e });
    endTime = Math.max(endTime, e);
  }
  queue.sort((a, b) => a.s - b.s);
  let next = 0;
  let nodes: { osc: AudioScheduledSourceNode; e: number }[] = [];
  /** Make the nodes of the notes that start before `until` (those that have ended are let go). */
  const schedule = (until: number) => {
    nodes = nodes.filter((x) => x.e + 0.02 > ac.currentTime);
    for (; next < queue.length && queue[next].s < until; next++) {
      const { n, s, e } = queue[next];
      const osc = ac.createOscillator();
      osc.type = n.voice === "Vocal" ? "triangle" : "sawtooth";
      osc.frequency.value = midiToHz(n.pitch);
      const g = ac.createGain();
      const peak = n.voice === "Vocal" ? 0.9 : 0.35;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(peak, s + 0.01);
      g.gain.setValueAtTime(peak, Math.max(s + 0.01, e - 0.03));
      g.gain.exponentialRampToValueAtTime(0.0001, e);
      const filter = ac.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = n.voice === "Vocal" ? 4000 : 1800;
      osc.connect(filter).connect(g).connect(master);
      osc.start(s);
      osc.stop(e + 0.02);
      nodes.push({ osc, e });
    }
  };
  schedule(t0 + LOOKAHEAD);
  const refill = window.setInterval(() => schedule(ac.currentTime + LOOKAHEAD), REFILL_MS);
  let stopped = false;
  const finish = () => {
    stopped = true;
    window.clearInterval(refill);
    master.disconnect();
  };
  const timer = window.setTimeout(() => {
    if (!stopped) {
      finish();
      onEnd?.();
    }
  }, Math.max(0, (endTime - ac.currentTime) * 1000 + 100));
  return {
    startedAt: t0,
    stop: () => {
      if (stopped) return;
      window.clearTimeout(timer);
      for (const { osc } of nodes) {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
      }
      finish();
      onEnd?.();
    },
    position: () => fromTick + secondsToTicks(ac.currentTime - t0, bpm),
  };
}

/** Short single-note preview (used when clicking/dragging notes). */
export function previewNote(pitch: number, voice: "Vocal" | "Ins", seconds = 0.25) {
  const ac = audio();
  if (ac.state === "suspended") ac.resume();
  const osc = ac.createOscillator();
  osc.type = voice === "Vocal" ? "triangle" : "sawtooth";
  osc.frequency.value = midiToHz(pitch);
  const g = ac.createGain();
  const t = ac.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  osc.connect(g).connect(ac.destination);
  osc.start(t);
  osc.stop(t + seconds + 0.02);
}
