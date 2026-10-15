import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbc } from "../../abc/parse";
import { sectionOnsetCounts } from "../../abc/consistency";
import { countMorae, countSungJa, countSyllablesEn, countSyllablesZh, sectionFit } from "../mora";

const fx = (name: string) => readFileSync(join(__dirname, "..", "..", "abc", "__fixtures__", name), "utf8");

describe("countMorae", () => {
  it("counts kana, skips small kana, counts っ ー ん", () => {
    expect(countMorae("きょう")).toBe(2);
    expect(countMorae("がっこう")).toBe(4);
    expect(countMorae("らーめん")).toBe(4);
    expect(countMorae("シャッター")).toBe(4);
    expect(countMorae("朝の光")).toBe(1); // only の is kana
    expect(countMorae("Hello 123")).toBe(0);
  });
});

describe("countSungJa", () => {
  it("adds the English syllables of a Japanese line to its morae", () => {
    expect(countSungJa("Stay with me きみと")).toBe(6);
    expect(countSungJa("Ｏｈ ｙｅａｈ")).toBe(2); // full-width letters from a Japanese IME
    expect(countSungJa("きょう")).toBe(2);
    expect(countSungJa("ｷｮｳ")).toBe(2); // half-width katakana
  });

  it("does not flag a Japanese section with an English phrase as too short", () => {
    const score = parseAbc(fx("full_ja.abc"));
    const sung = sectionOnsetCounts(score).filter((s) => s.sung);
    const n = sung[0].withPickup;
    // about half the notes on English words, the rest on kana
    const english = "oh ".repeat(Math.ceil(n / 2)).trim();
    const lyrics = sung.map((s, i) => `[${s.name}]\n${i === 0 ? `${english} ${"あ".repeat(n - Math.ceil(n / 2))}` : "あ".repeat(s.withPickup)}`).join("\n\n");
    expect(sectionFit(score, lyrics, countMorae).rows[0].flag).toBe("low");
    expect(sectionFit(score, lyrics, countSungJa).rows[0].flag).toBeNull();
  });
});

describe("sectionFit", () => {
  const score = parseAbc(fx("full_ja.abc"));
  const sung = sectionOnsetCounts(score).filter((s) => s.sung);

  it("pairs sung sections with lyric blocks and flags big gaps", () => {
    const blocks = sung.map((s, i) => `[${s.name}]\n${i === 0 ? "あ".repeat(s.withPickup) : "あ"}`).join("\n\n");
    const fit = sectionFit(score, blocks);
    expect(fit.paired).toBe(true);
    expect(fit.rows[0].morae).toBe(sung[0].withPickup);
    expect(fit.rows[0].flag).toBeNull();
    if (fit.rows.length > 1) expect(fit.rows[1].flag).toBe("low");
    const many = sung.map((s) => `[${s.name}]\n${"あ".repeat(s.withPickup * 2)}`).join("\n\n");
    expect(sectionFit(score, many).rows.every((r) => r.flag === "high")).toBe(true);
  });

  it("shows no morae without a kana version or with a different section count", () => {
    expect(sectionFit(score, null).rows.every((r) => r.morae === null)).toBe(true);
    const fit = sectionFit(score, "[Verse]\nあいう");
    if (sung.length !== 1) {
      expect(fit.paired).toBe(false);
      expect(fit.rows.every((r) => r.morae === null)).toBe(true);
    }
  });
});

describe("English syllables (estimate)", () => {
  it("counts vowel groups with the silent-e and y rules", () => {
    const n = (w: string) => countSyllablesEn(w);
    expect([n("the"), n("table"), n("make"), n("yes"), n("don't"), n("beautiful"), n("agree"), n("love")]).toEqual([1, 2, 1, 1, 1, 3, 2, 1]);
    expect(n("[Verse] well-known 2024")).toBe(2);
    expect(countSyllablesZh("我爱你 love")).toBe(3);
    expect(countSyllablesZh("𠮟我")).toBe(2); // supplementary-plane Han character
    expect(countSyllablesZh("々〆")).toBe(0); // Japanese iteration marks are no Chinese syllables
  });

  it("keeps typographic apostrophes inside the word", () => {
    expect(countSyllablesEn("don’t")).toBe(1);
    expect(countSyllablesEn("I’m you’re")).toBe(2);
    expect(countSyllablesEn("can‘t won＇t ma`am")).toBe(3);
    expect(countSyllablesEn("‘hello’")).toBe(2); // quote marks are dropped
  });

  it("pairs English lyric blocks with the score sections", () => {
    const score = parseAbc(fx("full_en.abc"));
    const sung = sectionOnsetCounts(score).filter((s) => s.sung);
    const lyrics = sung.map((s, i) => `[${s.name}]\n${i % 2 ? "la la la la" : "morning light across the window"}`).join("\n\n");
    const fit = sectionFit(score, lyrics, countSyllablesEn);
    expect(fit.paired).toBe(true);
    expect(fit.rows[0].morae).toBe(8); // mor-ning light a-cross the win-dow
    // the Japanese default is unchanged
    expect(sectionFit(score, lyrics).rows[0].morae).toBe(0);
  });
});
