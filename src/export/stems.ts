// Which separated vocals of a library song automatic lyric timing reuses, and how the toast names the file.

/**
 * A library song's separated vocals, in the order automatic timing tries them: first the stems it made for
 * itself (<folder>\separated\align\vocals.wav — they exist only after an automatic timing separated, e.g. when
 * 「ボーカルを分離し直す」 was on, so the latest choice keeps winning after a restart), then the separation page's
 * <folder>\separated\vocals.wav (any model).
 */
export function songStemCandidates(folder: string): string[] {
  const base = folder.replace(/\\+$/, "");
  return [`${base}\\separated\\align\\vocals.wav`, `${base}\\separated\\vocals.wav`];
}

/**
 * The first candidate as long as the song (±0.5 s: not an unrelated or cut-off file); null when the song's
 * length is unknown or none fits. `duration` answers null for a missing or unreadable file.
 */
export async function pickSongStems(folder: string, source: string, duration: (path: string) => Promise<number | null>): Promise<string | null> {
  const probe = (p: string) => duration(p).catch(() => null);
  const ds = await probe(source);
  if (!ds) return null;
  for (const candidate of songStemCandidates(folder)) {
    const dv = await probe(candidate);
    if (dv && Math.abs(dv - ds) < 0.5) return candidate;
  }
  return null;
}

/** The stems' path inside the song folder (e.g. "separated\align\vocals.wav"); null for a file elsewhere. */
export function stemsInFolder(vocalsPath: string, folder: string): string | null {
  const base = folder.replace(/\\+$/, "");
  if (!base || !vocalsPath.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) return null;
  return vocalsPath.slice(base.length + 1);
}
