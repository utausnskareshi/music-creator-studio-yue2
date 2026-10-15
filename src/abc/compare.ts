// Symbolic comparison of two scores (official: "Check musical events, not character strings";
// abc_tools.py compare). Notes are compared after tie merging (parseAbc already merges ties), keyed by voice,
// onset, duration and pitch in PPQ ticks — positions do not depend on Q:, so a tempo-only edit keeps every
// note equal and the tempo is reported on its own line, like the official --allow-tempo-change.
import { VOICES, VOICE_LABEL, barAtTick, recomputeBars, type Note, type Score, type VoiceName } from "./model";

export interface VoiceDiff {
  /** same onset, different pitch or duration */
  changed: number;
  /** onsets only in `after` */
  added: number;
  /** onsets only in `before` */
  removed: number;
  /** 1-based bar numbers (in `before`'s grid, `after`'s for added notes) with a difference */
  bars: number[];
}

export interface ScoreDiff {
  /** every note of both voices, and the bar grid (meters and bar count), are unchanged (tempo, chords and key not included) */
  notesMatch: boolean;
  voices: Record<VoiceName, VoiceDiff>;
  /** 1-based bars whose chord symbols differ */
  chordBars: number[];
  tempo: { from: number; to: number } | null;
  meterChanged: boolean;
  /** bar count, trailing silent bars included (official: "bar meter/time grid differs") */
  barCount: { from: number; to: number } | null;
  keyChanged: boolean;
  /** Japanese summary lines, empty when nothing differs */
  lines: string[];
}

function meterText(s: Score): string {
  return [`${s.meter[0]}/${s.meter[1]}`, ...(s.meterChanges ?? []).map((c) => `${c.tick}:${c.meter[0]}/${c.meter[1]}`)].join(",");
}

function keyText(s: Score): string {
  return [s.key, ...(s.keyChanges ?? []).map((c) => `${c.tick}:${c.key}`)].join(",");
}

function barList(bars: number[], max = 12): string {
  const shown = bars.slice(0, max).join(", ");
  return bars.length > max ? `${shown} ほか` : shown;
}

export function compareScores(before: Score, after: Score): ScoreDiff {
  const voices = {} as Record<VoiceName, VoiceDiff>;
  const lines: string[] = [];
  let notesMatch = true;
  for (const v of VOICES) {
    const a = new Map<number, Note>();
    const b = new Map<number, Note>();
    for (const n of before.notes) if (n.voice === v) a.set(n.start, n);
    for (const n of after.notes) if (n.voice === v) b.set(n.start, n);
    const d: VoiceDiff = { changed: 0, added: 0, removed: 0, bars: [] };
    const bars = new Set<number>();
    for (const [start, n] of a) {
      const m = b.get(start);
      if (!m) {
        d.removed++;
        bars.add(barAtTick(before, start) + 1);
      } else if (m.pitch !== n.pitch || m.duration !== n.duration) {
        d.changed++;
        bars.add(barAtTick(before, start) + 1);
      }
    }
    for (const start of b.keys()) {
      if (!a.has(start)) {
        d.added++;
        bars.add(barAtTick(after, start) + 1);
      }
    }
    d.bars = [...bars].sort((x, y) => x - y);
    voices[v] = d;
    if (d.changed || d.added || d.removed) {
      notesMatch = false;
      lines.push(`${VOICE_LABEL[v]}: 変更 ${d.changed} 音・追加 ${d.added} 音・削除 ${d.removed} 音（小節 ${barList(d.bars)}）`);
    }
  }

  const chordKey = (s: Score) => {
    const m = new Map<number, string>();
    for (const c of s.chords) m.set(c.start, c.symbol);
    return m;
  };
  const ca = chordKey(before);
  const cb = chordKey(after);
  const chordBars = new Set<number>();
  for (const [t, sym] of ca) if (cb.get(t) !== sym) chordBars.add(barAtTick(before, t) + 1);
  for (const [t, sym] of cb) if (ca.get(t) !== sym) chordBars.add(barAtTick(after, t) + 1);
  const chordList = [...chordBars].sort((x, y) => x - y);
  if (chordList.length) lines.push(`コード: 小節 ${barList(chordList)} で変更`);

  const tempo = Math.round(before.bpm) !== Math.round(after.bpm) ? { from: before.bpm, to: after.bpm } : null;
  if (tempo) lines.push(`テンポ: ${tempo.from} → ${tempo.to} BPM（音符は拍の位置で比較しています）`);
  const meterChanged = meterText(before) !== meterText(after);
  if (meterChanged) {
    notesMatch = false;
    lines.push(`拍子: ${before.meter[0]}/${before.meter[1]}${before.meterChanges?.length ? "（途中変更あり）" : ""} → ${after.meter[0]}/${after.meter[1]}${after.meterChanges?.length ? "（途中変更あり）" : ""}`);
  }
  const bars = (s: Score) => Math.max(s.bars || 0, recomputeBars(s));
  const barCount = bars(before) !== bars(after) ? { from: bars(before), to: bars(after) } : null;
  if (barCount) {
    notesMatch = false;
    lines.push(`小節数: ${barCount.from} → ${barCount.to}（曲の長さが変わります）`);
  }
  const keyChanged = keyText(before) !== keyText(after);
  if (keyChanged) lines.push(`調: ${before.key}${before.keyChanges?.length ? "（転調あり）" : ""} → ${after.key}${after.keyChanges?.length ? "（転調あり）" : ""}`);

  return { notesMatch, voices, chordBars: chordList, tempo, meterChanged, barCount, keyChanged, lines };
}
