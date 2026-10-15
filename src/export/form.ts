// Rules of the 書き出し form besides the synced lyrics (syncedLines.ts) and the stems (stems.ts).

/**
 * The CBR bitrates (kbps) MP3 offers: MPEG-1 Layer III, from 64 up. The export writes MP3 at 32 kHz or more (a lower
 * source rate goes to 48 kHz, export.rs output_rate), where these are the rates. libmp3lame silently writes any
 * other value at a neighbouring one (e.g. 144 as 128), so the slider offers only these.
 */
export const MP3_BITRATES: readonly number[] = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/**
 * AAC, Vorbis and Opus take any bitrate: 64 to 320 in steps of 16. (The export moves the Vorbis / Opus value into
 * what the source's channel count allows, with a note: export.rs lossy_kbps.)
 */
const FREE_BITRATES: readonly number[] = Array.from({ length: 17 }, (_, i) => 64 + i * 16);

/** The bitrate slider's stops (kbps) for a lossy `format`. */
export function bitrateStops(format: string): number[] {
  return [...(format === "mp3" ? MP3_BITRATES : FREE_BITRATES)];
}

/**
 * The bitrate an export of `format` uses for the slider value `kbps` (shared by all formats): the nearest of its
 * stops, a tie going up. A value set on another format keeps its own steps there.
 */
export function exportBitrate(format: string, kbps: number): number {
  const stops = bitrateStops(format);
  let best = stops[0];
  for (const s of stops) if (Math.abs(s - kbps) <= Math.abs(best - kbps)) best = s;
  return best;
}

/** Two paths name the same file (Windows: case and / vs \ do not matter). */
export function sameFilePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return a !== "" && b !== "" && norm(a) === norm(b);
}

/**
 * What 「音声ファイルを選択」 does with the picked file: "attach" while the page has no audio yet (times typed then
 * were not set against any audio, so they stay with the first file), "keep" when it is the source already (its
 * timings, lyrics and title stay; the page reads the file's length and the tap player again, for a file rewritten in
 * place), "ask" when the lines hold timings (they were set against the current audio and are reset for another
 * file), else "switch".
 */
export function sourcePick(o: { current: string; picked: string; timed: boolean }): "keep" | "ask" | "switch" | "attach" {
  if (o.current === "") return "attach";
  if (sameFilePath(o.current, o.picked)) return "keep";
  return o.timed ? "ask" : "switch";
}

/**
 * One look of 書き出し at the library selection (`targetId`: the selected song when it is finished, else null) from
 * the one it saw last (`seen`, keepAlive.ts selectionLoad seenId). The page looks only while it is shown, and not
 * while an export runs (`exporting`: from the click on 「書き出す」, through its questions and the save dialog, until
 * the file is written): the source stays until then (the lock, pages/locks.ts), so a selection made meanwhile is
 * followed once the export ends instead of replacing the form under it. Not looking keeps `seen`.
 */
export function lookAtSelection(seen: string | null, o: { active: boolean; exporting: boolean; targetId: string | null }): { look: boolean; seen: string | null } {
  if (!o.active || o.exporting) return { look: false, seen };
  return { look: true, seen: o.targetId };
}

/**
 * Runs one call at a time: `run` does nothing while an earlier call is still running. 「書き出す」 asks and opens the
 * save dialog before the page turns busy, so the second click of a double click would otherwise open a second
 * dialog and write the same file twice at once.
 */
export class OneAtATime {
  private running = false;

  async run(fn: () => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await fn();
    } finally {
      this.running = false;
    }
  }
}
