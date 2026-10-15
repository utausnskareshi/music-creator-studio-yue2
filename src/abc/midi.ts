// MIDI <-> Score conversion using @tonejs/midi.
import { Midi } from "@tonejs/midi";
import { MAX_BARS, OFFICIAL_KEYS, PPQ, VOICE_LABEL, barStartTick, barsForEnd, emptyScore, isSupportedMeter, parseKey, recomputeBars, sameKey, ticksPerUnit, withinLengthLimit, type KeyChange, type MeterChange, type Note, type Score, type VoiceName } from "./model";

/** Header marker at the end of the last bar, so trailing silent bars survive a round trip. */
const END_MARKER = "End";

/**
 * Placeholder for the exported key signatures. @tonejs/midi 2.x encodes a key signature as indexOf(key) + 7
 * instead of the signed sharps count (a written "G" comes out as 15 sharps and reads back as no key), so the
 * events are written under this name — the only one whose encoded byte (21) can never be a real sharps count
 * (-7..7) — and patched in the bytes afterwards (patchKeySignatures). Reading uses the same table in the other
 * direction and is correct for standard files.
 */
const KEY_SENTINEL = { key: "C#", scale: "major", byte: 21 } as const;

/**
 * Export: two tracks (Vocal, Ins), tempo, the time signature of the header and of every meter change, and the
 * key signature of the header key and of every key change, so the bar lines and the key follow the score.
 * A header marker "End" is written at the end of the last bar: the encoder ends each track at its last note, so
 * without it trailing silent bars (an outro tail the score keeps) would be lost on import.
 */
export function scoreToMidi(score: Score): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(score.bpm);
  const toMidiTicks = (tick: number) => Math.round((tick * midi.header.ppq) / PPQ);
  midi.header.timeSignatures = [
    { ticks: 0, timeSignature: [score.meter[0], score.meter[1]] },
    ...(score.meterChanges ?? []).map((c) => ({ ticks: toMidiTicks(c.tick), timeSignature: [c.meter[0], c.meter[1]] })),
  ];
  const keySigs = keySignatureEvents(score).map((k) => ({ ...k, ticks: toMidiTicks(k.tick) }));
  midi.header.keySignatures = keySigs.map((k) => ({ ticks: k.ticks, key: KEY_SENTINEL.key, scale: KEY_SENTINEL.scale }));
  midi.header.meta.push({ type: "marker", text: END_MARKER, ticks: toMidiTicks(barStartTick(score, Math.max(1, score.bars))) });
  midi.header.update();
  // @tonejs/midi uses its own PPQ (default 480): positions are converted in ticks, as on import.
  for (const voice of ["Vocal", "Ins"] as VoiceName[]) {
    const track = midi.addTrack();
    track.name = voice;
    track.channel = voice === "Vocal" ? 0 : 1;
    for (const n of score.notes.filter((x) => x.voice === voice)) {
      const ticks = toMidiTicks(n.start);
      track.addNote({ midi: n.pitch, ticks, durationTicks: toMidiTicks(n.start + n.duration) - ticks, velocity: voice === "Vocal" ? 0.9 : 0.7 });
    }
  }
  return patchKeySignatures(midi.toArray(), keySigs);
}

interface KeySig {
  tick: number;
  /** sharps (positive) or flats (negative) */
  fifths: number;
  minor: boolean;
}

/**
 * The header key and every key change as MIDI key signatures (sharps count, major/minor; a mode becomes the
 * major or minor key with the same signature). A key that cannot be read or needs more than seven accidentals
 * is left out; a restated signature is not written again.
 */
function keySignatureEvents(score: Score): KeySig[] {
  const out: KeySig[] = [];
  const changes = (score.keyChanges ?? []).slice().sort((a, b) => a.tick - b.tick);
  for (const c of [{ tick: 0, key: score.key }, ...changes]) {
    const k = parseKey(c.key);
    if (!k || Math.abs(k.fifths) > 7) continue;
    const minor = k.mode === "minor" || k.mode === "dor" || k.mode === "phr" || k.mode === "loc";
    const last = out[out.length - 1];
    if (last && last.fifths === k.fifths && last.minor === minor) continue;
    out.push({ tick: c.tick, fifths: k.fifths, minor });
  }
  return out;
}

const readU32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/**
 * Replace the sentinel key signatures of the first track (the header track: it holds only meta events, and the
 * encoder sorts them by time) with the real sharps count and mode, in tick order. FF 59 02 <sf> <mi> with
 * sf = 21 can only be one of our sentinels there.
 */
function patchKeySignatures(bytes: Uint8Array, sigs: KeySig[]): Uint8Array {
  if (sigs.length === 0 || bytes.length < 22) return bytes;
  const track = 8 + readU32(bytes, 4); // after the MThd chunk
  const end = Math.min(bytes.length, track + 8 + readU32(bytes, track + 4));
  let k = 0;
  for (let i = track + 8; k < sigs.length && i + 4 < end; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0x59 && bytes[i + 2] === 2 && bytes[i + 3] === KEY_SENTINEL.byte && bytes[i + 4] === 0) {
      bytes[i + 3] = sigs[k].fifths & 0xff;
      bytes[i + 4] = sigs[k].minor ? 1 : 0;
      k++;
      i += 4;
    }
  }
  return bytes;
}

/** The official key name of an imported key signature (major name + major/minor scale), null when unreadable. */
function importedKeyName(k: { key?: string; scale: string }): string | null {
  const i = k.key === undefined ? -1 : (OFFICIAL_KEYS as readonly string[]).indexOf(k.key);
  if (i < 0 || i > 14) return null;
  return OFFICIAL_KEYS[i + (k.scale === "minor" ? 15 : 0)];
}

export interface MidiImportOptions {
  /** Snap grid unit denominator (16 = sixteenth notes). */
  unit?: number;
  /** Track indexes to map to Vocal / Ins. Defaults: track named "Vocal"/"Ins", else first two tracks with notes (never a drum track). */
  vocalTrack?: number;
  insTrack?: number;
}

export interface MidiImportResult {
  score: Score;
  trackNames: string[];
  warnings: string[];
}

/**
 * Import: quantize to the unit grid, force monophony per voice (later note truncates earlier). The time and
 * key signatures become the header meter / key and the meter / key changes of the score (on the snap grid);
 * without any, the base score's stay.
 */
export function midiToScore(data: Uint8Array, base: Score | null, opts: MidiImportOptions = {}): MidiImportResult {
  const midi = new Midi(data);
  // An SMPTE (timecode) division has no ticks per quarter note (ppq undefined, or 0): every position would be NaN.
  if (!(midi.header.ppq > 0)) throw new Error("時間単位が拍単位ではない MIDI（SMPTE 形式のタイムコードなど）は読み込めません（拍単位で書き出した MIDI を使ってください）");
  const unit = opts.unit ?? 16;
  const grid = ticksPerUnit(unit);
  const warnings: string[] = [];
  const warnOnce = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const score = base ? { ...base, notes: [] as Note[] } : emptyScore();
  // Tempo: the one in effect at tick 0 (the last tick-0 event in file order; MIDI's default 120 when there is
  // none). Only the header value: positions are converted in ticks, so the rhythm never depends on it.
  const tempos = midi.header.tempos;
  const atZero = tempos.filter((t) => t.ticks === 0);
  let firstBpm = atZero.length ? atZero[atZero.length - 1].bpm : 120;
  if (!(Number.isFinite(firstBpm) && firstBpm <= 1000)) {
    // a 0 µs tempo reads as Infinity BPM (written as Q:1/4=Infinity, read back as 1)
    warnings.push("テンポの値が不正なため 120 BPM にしました");
    firstBpm = 120;
  }
  score.bpm = Math.max(1, Math.round(firstBpm));
  // The file stores microseconds per quarter, so a whole BPM such as 90 reads back as 90.00009: compare loosely.
  const differs = (a: number, b: number) => Math.abs(a - b) > 0.05;
  if (differs(score.bpm, firstBpm)) warnings.push(`テンポ ${Math.round(firstBpm * 100) / 100} BPM は整数の ${score.bpm} BPM にしました`);
  if (tempos.some((t) => t.ticks > 0 && differs(t.bpm, firstBpm))) {
    warnings.push(`途中のテンポ変化は譜面に反映されず、最初のテンポ（${score.bpm} BPM）で再生されます（音符の拍の位置はそのままです）`);
  }
  /** a position of the file (its own PPQ) as a score tick on the snap grid: in ticks, independent of the tempo map */
  const toTick = (midiTicks: number) => Math.round((midiTicks * PPQ) / midi.header.ppq / grid) * grid;
  // The header meter is the signature in effect at tick 0 (the last one there, as for the tempo; else the first
  // one); every later signature that differs from the one before it is a meter change (a restated signature is
  // not). A signature with no or a degenerate bar (0/4, 1/4096, a 1<<31 denominator of a corrupt file) is ignored.
  const tsList = midi.header.timeSignatures
    .filter((t) => {
      if (isSupportedMeter(t.timeSignature)) return true;
      warnOnce(`拍子 ${t.timeSignature[0]}/${t.timeSignature[1]} は扱えないため無視しました`);
      return false;
    })
    .sort((a, b) => a.ticks - b.ticks);
  if (tsList.length) {
    const first = tsList.filter((t) => t.ticks === 0).pop() ?? tsList[0];
    score.meter = [first.timeSignature[0], first.timeSignature[1]];
    const changes: MeterChange[] = [];
    let cur = score.meter;
    for (const t of tsList) {
      const tick = toTick(t.ticks);
      const meter: [number, number] = [t.timeSignature[0], t.timeSignature[1]];
      if (tick <= 0 || (meter[0] === cur[0] && meter[1] === cur[1])) continue;
      changes.push({ tick, meter });
      cur = meter;
    }
    score.meterChanges = changes;
  }
  // Key signatures the same way (major/minor only: what MIDI has).
  const ksList = midi.header.keySignatures.filter((k) => importedKeyName(k) !== null).sort((a, b) => a.ticks - b.ticks);
  if (ksList.length) {
    const first = ksList.filter((k) => k.ticks === 0).pop() ?? ksList[0];
    score.key = importedKeyName(first)!;
    const changes: KeyChange[] = [];
    let cur = score.key;
    for (const k of ksList) {
      const tick = toTick(k.ticks);
      const key = importedKeyName(k)!;
      if (tick <= 0 || sameKey(key, cur)) continue;
      changes.push({ tick, key });
      cur = key;
    }
    score.keyChanges = changes;
  }
  score.unit = unit;
  const tracks = midi.tracks.map((t, i) => ({ i, name: t.name || `Track ${i + 1}`, count: t.notes.length, drum: t.instrument.percussion }));
  // A drum track (channel 10) holds hits, not a melody: it is never chosen automatically (an explicit
  // vocalTrack / insTrack is still used as given).
  const pitched = tracks.filter((t) => !t.drum);
  const withNotes = pitched.filter((t) => t.count > 0);
  const drumsWithNotes = tracks.filter((t) => t.drum && t.count > 0);
  // A named track claims its voice even when it is empty (an instrumental score's "Vocal" track), so the Ins
  // track is never copied into Vocal; a matching track with notes is preferred over an empty one. Each name
  // gets one voice: an explicit vocal word wins, then an instrument word, so the official V: names "Vocal Melody"
  // / "Ins Melody" (the track names MuseScore, abc2midi and music21 write) and names like "Piano Melody" or
  // "Lead Guitar" land in the right voice; a bare "Melody" / "Lead" is the vocal line.
  const voiceOf = (name: string): VoiceName | null =>
    /vocal|voice/i.test(name) ? "Vocal" : /ins|accomp|piano|guitar/i.test(name) ? "Ins" : /melody|lead/i.test(name) ? "Vocal" : null;
  const byName = (voice: VoiceName) =>
    (withNotes.find((t) => voiceOf(t.name) === voice) ?? pitched.find((t) => voiceOf(t.name) === voice))?.i;
  const vocalByName = byName("Vocal");
  const insByName = byName("Ins");
  // Unnamed tracks: the first one with notes is Vocal, the next one Ins. A lone track named as the Ins voice
  // ("Ins Melody", "Instrumental", "Accompaniment": an instrumental score) stays Ins; a lone track named only
  // after its instrument ("Piano", "Acoustic Guitar": the part name MuseScore and DAWs write) is the melody and
  // goes to Vocal, as before the per-voice names.
  // "Inst." (the official snm) counts; a numbered DAW default like "Inst 1" does not.
  const explicitIns = insByName !== undefined && /\b(?:ins|instrumental)\b|\binst\b(?!\.?\s*\d)|accomp/i.test(tracks[insByName].name);
  const vocalIdx =
    opts.vocalTrack ?? vocalByName ?? withNotes.find((t) => t.i !== insByName)?.i ?? (explicitIns ? undefined : withNotes[0]?.i);
  let insIdx = opts.insTrack ?? insByName ?? withNotes.find((t) => t.i !== vocalIdx)?.i;
  if (opts.vocalTrack === undefined && opts.insTrack === undefined && insIdx === vocalIdx) {
    insIdx = withNotes.find((t) => t.i !== vocalIdx)?.i;
  }
  const used = new Set([vocalIdx, insIdx]);
  if (drumsWithNotes.length && withNotes.length === 0 && !drumsWithNotes.some((t) => used.has(t.i))) {
    // Nothing to import: fail rather than replace the score with an empty one.
    throw new Error("ドラム（チャンネル10）以外に音符のあるトラックがないため、読み込めません");
  }
  for (const t of drumsWithNotes) if (!used.has(t.i)) warnings.push(`ドラム（チャンネル10）のトラック "${t.name}" は読み込みませんでした`);
  let id = 1;
  const importTrack = (idx: number | undefined, voice: VoiceName) => {
    if (idx === undefined) return;
    const track = midi.tracks[idx];
    const notes = track.notes
      .map((n) => {
        // Both edges on the grid, from the file's ticks (a tempo map or a fractional tempo moves nothing).
        const start = toTick(n.ticks);
        const end = Math.max(start + grid, toTick(n.ticks + n.durationTicks));
        return { start, end, pitch: n.midi };
      })
      .sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    let lastEnd = -1;
    let dropped = 0;
    for (const n of notes) {
      if (n.start < lastEnd) {
        // Overlap: truncate previous note to keep monophony; drop if fully inside.
        const prev = score.notes[score.notes.length - 1];
        if (prev && prev.voice === voice && prev.start < n.start) prev.duration = n.start - prev.start;
        else {
          dropped++;
          continue;
        }
      }
      score.notes.push({ id: id++, voice, start: n.start, duration: n.end - n.start, pitch: Math.max(0, Math.min(127, n.pitch)) });
      lastEnd = n.end;
    }
    if (dropped) warnings.push(`${VOICE_LABEL[voice]}: 和音など重なった ${dropped} 音を省略しました（単旋律にするため）`);
  };
  importTrack(vocalIdx, "Vocal");
  importTrack(insIdx, "Ins");
  // Song end: our own "End" marker (trailing silent bars). A foreign file's end-of-track is not used: DAWs often
  // write it at the project end, far past the music.
  const endMidi = Math.max(0, ...midi.header.meta.filter((m) => m.type === "marker" && m.text === END_MARKER).map((m) => m.ticks));
  const endTick = endMidi > 0 ? toTick(endMidi) : 0;
  score.bars = Math.max(recomputeBars(score), endTick > 0 ? barsForEnd(score, endTick) : 1);
  if (!withinLengthLimit(score, score.bars)) throw new Error(`曲が長すぎるため読み込めません（最大 ${MAX_BARS} 小節）`);
  return { score, trackNames: tracks.map((t) => `${t.name} (${t.count})`), warnings };
}
