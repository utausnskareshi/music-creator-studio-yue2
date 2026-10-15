import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionFitNote, sectionFitView } from "../SectionFitTable";

const abc = readFileSync(join(__dirname, "..", "..", "abc", "__fixtures__", "full_ja.abc"), "utf8");

describe("section fit note", () => {
  it("asks for lyrics when there are none, in every language", () => {
    for (const lang of ["ja", "en", "zh"] as const) {
      const fit = sectionFitView(abc, "  \n", null, lang)!;
      expect(fit.empty).toBe(true);
      expect(fit.rows.length).toBeGreaterThan(0); // the onsets still guide lyric writing
      expect(sectionFitNote(fit, "footer")).toBe("歌詞を入力すると、セクションごとの音数と比較します。");
    }
  });

  it("explains a missing hiragana version and an unpaired section count", () => {
    const kanji = sectionFitView(abc, "[Verse]\n朝の光", null, "ja")!;
    expect(kanji.countable).toBe(false);
    expect(sectionFitNote(kanji, "footer")).toContain("ひらがな版がないため");
    const en = sectionFitView(abc, "[Verse]\nmorning light", null, "en")!;
    expect(en.countable).toBe(true);
    if (!en.paired) expect(sectionFitNote(en, "footer")).toContain("対応付けできません");
    expect(sectionFitView(abc, "x", null, "other")).toBeNull();
  });

  it("counts a hiragana version even when the kanji pane is empty", () => {
    const fit = sectionFitView(abc, "", "[Verse]\nあさ", "ja")!;
    expect(fit.empty).toBe(false);
    expect(fit.countable).toBe(true);
  });
});
