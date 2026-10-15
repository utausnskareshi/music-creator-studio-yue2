import { describe, expect, it } from "vitest";
import type { Song } from "../../api";
import { MUSIC_TOKENS_PER_SECOND, isTruncated, keyParams, largerLimitParams, modeLabel, parseSongParams, pendingPlayerPlaceholder, searchKey, shortenedBudget, songMatches, songStatusLabel, truncationNotices } from "../songMeta";

function song(over: Partial<Song> = {}, params: Record<string, unknown> | null = { style: "pop", lyrics: "[Verse]\nla", mode: "full", abc: "", seed: 5, maxDuration: 90 }): Song {
  return {
    id: "a", createdAt: "2026-09-28T10:00:00+09:00", title: "t", style: "pop", lyrics: "l", lyricsSung: "", mode: "full", seed: 5, abc: "",
    duration: 90, audioPath: "", folder: "", paramsJson: params ? JSON.stringify(params) : "", status: "done", error: "", parentId: null,
    wallSeconds: 1, peakVramGib: 1, ...over,
  };
}

describe("parseSongParams", () => {
  it("reads stored params and rejects junk", () => {
    expect(parseSongParams(song().paramsJson)?.maxDuration).toBe(90);
    expect(parseSongParams("")).toBeNull();
    expect(parseSongParams("{not json")).toBeNull();
    expect(parseSongParams("[1,2]")).toBeNull();
    expect(parseSongParams(JSON.stringify({ style: "s" }))).toBeNull();
  });
});

describe("keyParams", () => {
  it("falls back to node defaults for old params", () => {
    expect(keyParams(song())).toEqual({ mode: "full", seed: 5, maxDuration: 90, cfgScale: 1, steps: 32 });
    const k = keyParams(song({}, { style: "s", lyrics: "l", mode: "off", abc: "", seed: 7, maxDuration: 60, cfgScale: 1.01, steps: 48 }));
    expect(k).toEqual({ mode: "off", seed: 7, maxDuration: 60, cfgScale: 1.01, steps: 48 });
    expect(keyParams(song({ mode: "melody", seed: 3 }, null))).toEqual({ mode: "melody", seed: 3, maxDuration: null, cfgScale: 1, steps: 32 });
  });
});

describe("truncation", () => {
  it("treats missing/null flags as unknown (no notice)", () => {
    expect(truncationNotices(song())).toEqual([]);
    expect(truncationNotices(song({ truncatedSemantic: null, truncatedAbc: null }))).toEqual([]);
    expect(isTruncated(song({ truncatedSemantic: false }))).toBe(false);
    expect(truncationNotices(song({ truncatedSemantic: true }))[0]).toContain("上限到達");
    expect(truncationNotices(song({ truncatedAbc: true }))[0]).toContain("譜面が上限トークン");
    expect(isTruncated(song({ truncatedAbc: true }))).toBe(true);
  });

  it("larger limit = previous budget x1.5, capped at the limit and 900 s", () => {
    expect(largerLimitParams(song(), 900)?.maxDuration).toBe(135);
    expect(largerLimitParams(song({}, { style: "s", lyrics: "l", mode: "full", abc: "", seed: 5, maxDuration: 67 }), 900)?.maxDuration).toBe(101);
    expect(largerLimitParams(song({}, { style: "s", lyrics: "l", mode: "full", abc: "", seed: 5, maxDuration: 700 }), 1200)?.maxDuration).toBe(900);
    expect(largerLimitParams(song({}, { style: "s", lyrics: "l", mode: "full", abc: "", seed: 5, maxDuration: 300 }), 360)?.maxDuration).toBe(360);
    expect(largerLimitParams(song({}, { style: "s", lyrics: "l", mode: "full", abc: "", seed: 5, maxDuration: 360 }), 360)).toBeNull();
    expect(largerLimitParams(song({}, null), 900)).toBeNull();
    const p = largerLimitParams(song(), 900)!;
    expect(p.seed).toBe(5);
    expect(p.lyrics).toBe("[Verse]\nla");
  });

  it("the larger-limit render keeps the song's current title, not the one stored at generation", () => {
    // renamed in the library after generation: rename_song changes songs.title only
    const renamed = song({ title: "改名した曲" }, { title: "AI のタイトル案", style: "s", lyrics: "l", mode: "full", abc: "", seed: 5, maxDuration: 90 });
    expect(largerLimitParams(renamed, 900)?.title).toBe("改名した曲");
    // params saved before titles were stored
    expect(largerLimitParams(song({ title: "朝の歌" }), 900)?.title).toBe("朝の歌");
    // no title: the backend picks its automatic one
    expect(largerLimitParams(song({ title: "  " }), 900)?.title).toBeUndefined();
  });

  it("a budget ComfyUI shortened for a long prompt gets its own notice and no larger-limit offer", () => {
    // Full budget used (effective == requested): the normal notice and the larger-limit button.
    expect(shortenedBudget(song({ effectiveMaxSeconds: 90 }))).toBeNull();
    expect(largerLimitParams(song({ truncatedSemantic: true, effectiveMaxSeconds: 90 }), 900)?.maxDuration).toBe(135);
    // Unknown effective budget (older songs / cached node): as before.
    expect(shortenedBudget(song({ effectiveMaxSeconds: null }))).toBeNull();
    // Shortened to 80 s of the requested 90 s.
    const s = song({ truncatedSemantic: true, effectiveMaxSeconds: 80 });
    expect(shortenedBudget(s)).toEqual({ effective: 80, requested: 90 });
    expect(truncationNotices(s)[0]).toContain("実効上限 80.0 秒");
    expect(truncationNotices(s)[0]).toContain("指定 90 秒から短縮");
    expect(largerLimitParams(s, 900)).toBeNull();
    // Shortened but not truncated: no truncation notice.
    expect(truncationNotices(song({ truncatedSemantic: false, effectiveMaxSeconds: 80 }))).toEqual([]);
  });
});

describe("library search", () => {
  it("folds case, width and katakana", () => {
    expect(searchKey("J-Pop")).toBe("j-pop");
    expect(searchKey("ｐｏｐ")).toBe("pop");
    expect(searchKey("サクラ")).toBe("さくら");
    expect(searchKey("ｻｸﾗ")).toBe("さくら");
  });

  it("matches title, style, lyrics and the sung lyrics", () => {
    const s = song({ title: "春の歌", style: "J-Pop, Female Vocal", lyrics: "[Verse]\n桜が咲いた", lyricsSung: "[Verse]\nさくらがさいた" });
    expect(songMatches(s, "")).toBe(true);
    expect(songMatches(s, "   ")).toBe(true);
    expect(songMatches(s, "pop")).toBe(true);
    expect(songMatches(s, " FEMALE ")).toBe(true);
    expect(songMatches(s, "春")).toBe(true);
    expect(songMatches(s, "桜")).toBe(true);
    expect(songMatches(s, "さくら")).toBe(true);
    expect(songMatches(s, "サクラ")).toBe(true);
    expect(songMatches(s, "rock")).toBe(false);
    expect(songMatches({ title: "t", style: "s", lyrics: "l" }, "t")).toBe(true);
  });
});

describe("MUSIC_TOKENS_PER_SECOND", () => {
  it("is the frame rate the budget comparison uses", () => {
    expect(MUSIC_TOKENS_PER_SECOND).toBe(25);
    // 89.98 s rounds to the same 2250 frames as 90 s: not shortened
    expect(shortenedBudget(song({ effectiveMaxSeconds: 89.98 }))).toBeNull();
    expect(shortenedBudget(song({ effectiveMaxSeconds: 89.9 }))?.effective).toBe(89.9);
  });
});

describe("songStatusLabel", () => {
  it("labels every job status and shows an unknown one as is", () => {
    expect(["done", "running", "queued", "error", "cancelled"].map(songStatusLabel)).toEqual(["完了", "生成中", "待機中", "エラー", "キャンセル済み"]);
    expect(songStatusLabel("interrupted")).toBe("interrupted");
    expect(songStatusLabel("toString")).toBe("toString");
  });
});

describe("pendingPlayerPlaceholder", () => {
  it("promises playback only for a song that is still waiting or generating", () => {
    expect(pendingPlayerPlaceholder(song({ status: "queued" }))).toBe("生成が完了すると再生できます");
    expect(pendingPlayerPlaceholder(song({ status: "running" }))).toBe("生成が完了すると再生できます");
    // never finishes, or has its audio: the Player's default text
    expect(pendingPlayerPlaceholder(song({ status: "error" }))).toBeUndefined();
    expect(pendingPlayerPlaceholder(song({ status: "cancelled" }))).toBeUndefined();
    expect(pendingPlayerPlaceholder(song({ status: "done" }))).toBeUndefined();
    expect(pendingPlayerPlaceholder(null)).toBeUndefined();
  });
});

describe("modeLabel", () => {
  it("names the modes like 作曲's buttons and passes other values through", () => {
    expect(["full", "melody", "off"].map(modeLabel)).toEqual(["Full", "Melody", "Off"]);
    expect(modeLabel("other")).toBe("other");
  });
});
