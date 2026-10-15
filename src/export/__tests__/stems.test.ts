import { describe, expect, it } from "vitest";
import { pickSongStems, songStemCandidates, stemsInFolder } from "../stems";

const F = "C:\\out\\20261001_song";
const ALIGN = `${F}\\separated\\align\\vocals.wav`;
const PAGE = `${F}\\separated\\vocals.wav`;
const SRC = `${F}\\song.wav`;

const probeWith = (durations: Record<string, number>) => async (p: string) => {
  if (p === "throws") throw new Error("ffprobe failed");
  return durations[p] ?? null;
};

describe("songStemCandidates", () => {
  it("tries automatic timing's own stems first, then the separation page's", () => {
    expect(songStemCandidates(F)).toEqual([ALIGN, PAGE]);
    expect(songStemCandidates(`${F}\\`)).toEqual([ALIGN, PAGE]);
  });
});

describe("pickSongStems", () => {
  it("prefers the stems separated again for timing over the separation page's", async () => {
    expect(await pickSongStems(F, SRC, probeWith({ [SRC]: 120, [ALIGN]: 120.2, [PAGE]: 120 }))).toBe(ALIGN);
  });
  it("uses the separation page's stems when timing has none of its own", async () => {
    expect(await pickSongStems(F, SRC, probeWith({ [SRC]: 120, [PAGE]: 119.7 }))).toBe(PAGE);
  });
  it("skips stems that are not as long as the song", async () => {
    expect(await pickSongStems(F, SRC, probeWith({ [SRC]: 120, [ALIGN]: 60, [PAGE]: 120 }))).toBe(PAGE);
    expect(await pickSongStems(F, SRC, probeWith({ [SRC]: 120, [ALIGN]: 60, [PAGE]: 90 }))).toBeNull();
  });
  it("finds nothing when the song's length is unknown or the probe fails", async () => {
    expect(await pickSongStems(F, SRC, probeWith({ [ALIGN]: 120 }))).toBeNull();
    expect(await pickSongStems(F, "throws", probeWith({ [ALIGN]: 120 }))).toBeNull();
    const failing = async (): Promise<number | null> => {
      throw new Error("no ffprobe");
    };
    expect(await pickSongStems(F, SRC, failing)).toBeNull();
  });
});

describe("stemsInFolder", () => {
  it("names the file relative to the song folder", () => {
    expect(stemsInFolder(ALIGN, F)).toBe("separated\\align\\vocals.wav");
    expect(stemsInFolder(PAGE, `${F}\\`)).toBe("separated\\vocals.wav");
    expect(stemsInFolder(PAGE.toUpperCase(), F)).toBe("SEPARATED\\VOCALS.WAV");
  });
  it("is null for a file outside the folder", () => {
    expect(stemsInFolder("C:\\data\\align\\vocals.wav", F)).toBeNull();
    expect(stemsInFolder(`${F}_2\\separated\\vocals.wav`, F)).toBeNull();
    expect(stemsInFolder(PAGE, "")).toBeNull();
  });
});
