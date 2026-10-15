import { describe, expect, it } from "vitest";
import { MP3_BITRATES, OneAtATime, bitrateStops, exportBitrate, lookAtSelection, sameFilePath, sourcePick } from "../form";
import { selectionLoad } from "../../pages/keepAlive";

// The CBR bitrates of MPEG-1 Layer III (32 kHz and up: the export writes MP3 at no lower rate, export.rs output_rate).
const MPEG1_LAYER3 = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

describe("export bitrate", () => {
  it("offers MP3 only rates libmp3lame writes as chosen", () => {
    expect(bitrateStops("mp3")).toEqual([...MP3_BITRATES]);
    for (const kbps of bitrateStops("mp3")) {
      expect(MPEG1_LAYER3).toContain(kbps);
      expect(exportBitrate("mp3", kbps)).toBe(kbps);
    }
    expect(bitrateStops("mp3")[0]).toBe(64);
    expect(bitrateStops("mp3")[bitrateStops("mp3").length - 1]).toBe(320);
  });

  it("sends MP3 a legal rate for a value chosen on another format (nearest, a tie goes up)", () => {
    // LAME would silently write 128 / 160 / 192 / 224 / 256 / 256 / 320 for these
    expect(exportBitrate("mp3", 144)).toBe(160);
    expect(exportBitrate("mp3", 176)).toBe(192);
    expect(exportBitrate("mp3", 208)).toBe(224);
    expect(exportBitrate("mp3", 240)).toBe(256);
    expect(exportBitrate("mp3", 272)).toBe(256);
    expect(exportBitrate("mp3", 288)).toBe(320);
    expect(exportBitrate("mp3", 304)).toBe(320);
    for (let kbps = 64; kbps <= 320; kbps += 16) expect(MPEG1_LAYER3).toContain(exportBitrate("mp3", kbps));
  });

  it("keeps the free 16 kbps steps of AAC, Vorbis and Opus", () => {
    for (const f of ["m4a", "ogg", "opus"]) {
      const stops = bitrateStops(f);
      expect(stops).toHaveLength(17);
      expect(stops[0]).toBe(64);
      expect(stops[stops.length - 1]).toBe(320);
      expect(exportBitrate(f, 144)).toBe(144);
      expect(exportBitrate(f, 288)).toBe(288);
    }
    // the shared value survives a trip through MP3: only what MP3 sends is snapped
    expect(exportBitrate("m4a", 176)).toBe(176);
  });
});

describe("sameFilePath", () => {
  it("compares Windows paths without case and separator differences", () => {
    expect(sameFilePath("C:\\Music\\曲A\\song.wav", "c:/music/曲a/SONG.WAV")).toBe(true);
    expect(sameFilePath("C:\\Music\\a.wav", "C:\\Music\\a.wav")).toBe(true);
    expect(sameFilePath("C:\\Music\\a.wav", "C:\\Music\\a_master.wav")).toBe(false);
    expect(sameFilePath("C:\\Music\\a.wav", "")).toBe(false);
    expect(sameFilePath("", "")).toBe(false);
  });
});

describe("sourcePick", () => {
  it("keeps the form when the source itself is picked again (its timings stay)", () => {
    expect(sourcePick({ current: "C:\\Music\\曲A\\song.wav", picked: "c:/music/曲a/song.wav", timed: true })).toBe("keep");
    expect(sourcePick({ current: "C:\\Music\\曲A\\song.wav", picked: "C:\\Music\\曲A\\song.wav", timed: false })).toBe("keep");
  });

  it("asks before another file resets the timings set against the current audio", () => {
    expect(sourcePick({ current: "C:\\Music\\a.wav", picked: "C:\\Music\\a_master.wav", timed: true })).toBe("ask");
    expect(sourcePick({ current: "C:\\Music\\a.wav", picked: "C:\\Music\\a_master.wav", timed: false })).toBe("switch");
  });

  it("attaches the first file to the form without asking: times typed with no audio were not set against any", () => {
    expect(sourcePick({ current: "", picked: "C:\\Music\\a.wav", timed: true })).toBe("attach");
    expect(sourcePick({ current: "", picked: "C:\\Music\\a.wav", timed: false })).toBe("attach");
  });
});

describe("lookAtSelection", () => {
  it("follows the selection only while shown", () => {
    expect(lookAtSelection("A", { active: false, exporting: false, targetId: "B" })).toEqual({ look: false, seen: "A" });
    expect(lookAtSelection("A", { active: true, exporting: false, targetId: "B" })).toEqual({ look: true, seen: "B" });
    // a selected song still rendering: nothing to load, and its completion is new to the page
    expect(lookAtSelection("A", { active: true, exporting: false, targetId: null })).toEqual({ look: true, seen: null });
  });

  it("leaves the source alone while a file is written; a song selected meanwhile follows once the export ends", () => {
    // song A is loaded (seen) and exporting; the user selects B in ライブラリ and comes back to 書き出し
    let s = lookAtSelection("A", { active: false, exporting: true, targetId: "B" });
    s = lookAtSelection(s.seen, { active: true, exporting: true, targetId: "B" });
    expect(s).toEqual({ look: false, seen: "A" });
    // the export ends: B is still new to the page, so it is loaded then (or asked about when the form holds work)
    s = lookAtSelection(s.seen, { active: true, exporting: false, targetId: "B" });
    expect(s).toEqual({ look: true, seen: "B" });
    expect(selectionLoad({ active: true, selectedId: "B", loadedId: "A", seenId: "A", hasWork: false, keepable: true })).toBe("load");
  });

  it("does not load a selected song that finishes rendering during the export until the export ends", () => {
    let s = lookAtSelection(null, { active: true, exporting: true, targetId: "S" });
    expect(s).toEqual({ look: false, seen: null });
    s = lookAtSelection(s.seen, { active: true, exporting: false, targetId: "S" });
    expect(s).toEqual({ look: true, seen: "S" });
  });
});

describe("OneAtATime", () => {
  it("ignores a call while one runs (the second click of a double click on 書き出す)", async () => {
    const once = new OneAtATime();
    let calls = 0;
    let release: () => void = () => undefined;
    const fn = () => {
      calls++;
      return new Promise<void>((r) => (release = r));
    };
    const first = once.run(fn);
    await once.run(fn); // returns at once without running fn
    expect(calls).toBe(1);
    release();
    await first;
    // free again afterwards
    const next = once.run(fn);
    expect(calls).toBe(2);
    release();
    await next;
  });

  it("is free again after a call that failed", async () => {
    const once = new OneAtATime();
    await expect(once.run(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    let ran = false;
    await once.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
