import { describe, expect, it } from "vitest";
import { inlineSegments, plainText } from "../inline";
import { countDoc, filterDoc, foldWithMap, helpKey, markInline, markRanges, otherPageCounts, queryTerms } from "../search";
import type { HelpDoc } from "../types";

const doc: HelpDoc = {
  page: "separate",
  title: "ボーカル分離",
  sections: [
    { id: "overview", title: "この画面でできること", blocks: [{ kind: "text", text: "音源をボーカルと伴奏に分けます。" }] },
    {
      id: "steps",
      title: "基本の流れ",
      blocks: [{ kind: "steps", items: ["音源を選びます。", "分離モデルを選びます。", "「ボーカルと伴奏に分離」を押します。"] }],
    },
    {
      id: "fields",
      title: "各項目の説明",
      blocks: [
        {
          kind: "fields",
          title: "分離モデル",
          rows: [
            { name: "分離モデル", desc: "分離に使うモデルです。", range: "5 種類", def: "BS-Roformer 1297" },
            { name: "ボーカルと伴奏に分離", desc: "分離を始めます。VRAM を約 3〜4GB 使います。" },
          ],
        },
      ],
    },
    { id: "tips", title: "ヒントと注意", blocks: [{ kind: "list", items: ["結果は `separated` フォルダに入ります。", "サクラのような曲名でも使えます。"] }, { kind: "note", tone: "warn", text: "ほかのアプリで開いていると保存に失敗します。" }] },
    { id: "faq", title: "よくある質問", blocks: [{ kind: "faq", items: [{ q: "VRAM が足りない", a: "LLM を停止します。" }] }] },
  ],
};

describe("help search: folding", () => {
  it("folds case, width and kana as the library search does", () => {
    expect(helpKey("ＢＰＭ")).toBe("bpm");
    expect(helpKey("サクラ")).toBe("さくら");
    expect(helpKey("ｻｸﾗ")).toBe("さくら");
    // a voiced half-width katakana is two characters that NFKC composes into one
    expect(helpKey("ｶﾞ")).toBe("が");
    // both wave dashes (the IME's full-width tilde and U+301C) are one character
    expect(helpKey("3〜4")).toBe(helpKey("3～4"));
  });

  it("maps every folded character back to the source text, code point by code point", () => {
    const f = foldWithMap("Ａ㌔𠮟ｶ");
    expect(f.key).toBe("aきろ𠮟か");
    // each folded UTF-16 unit points at the start and end of its source character
    expect(f.starts).toEqual([0, 1, 1, 2, 2, 4]);
    expect(f.ends).toEqual([1, 2, 2, 4, 4, 5]);
  });

  it("splits the query into terms (full-width spaces too) and ignores a blank query", () => {
    expect(queryTerms(" 曲長　上限 ")).toEqual(["曲長", "上限"]);
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("help search: highlighting", () => {
  it("marks every occurrence of every term, whole source characters, merged when they touch", () => {
    expect(markRanges("ボーカルとボーカル", ["ぼーかる"])).toEqual([
      [0, 4],
      [5, 9],
    ]);
    // an expanded character is marked whole when a match touches part of it
    expect(markRanges("約 1㌔", ["き"])).toEqual([[3, 4]]);
    // a surrogate pair is never split
    expect(markRanges("𠮟る", ["𠮟"])).toEqual([[0, 2]]);
    // overlapping and adjacent ranges merge
    expect(markRanges("abcd", ["ab", "bc", "d"])).toEqual([[0, 4]]);
    expect(markRanges("abc", [])).toEqual([]);
  });

  it("matches across inline code and marks each piece", () => {
    expect(inlineSegments("結果は `separated` フォルダ")).toEqual([
      { text: "結果は ", code: false },
      { text: "separated", code: true },
      { text: " フォルダ", code: false },
    ]);
    // an unpaired backtick stays as text
    expect(inlineSegments("a`b")).toEqual([{ text: "a`b", code: false }]);
    expect(plainText("結果は `separated` フォルダ")).toBe("結果は separated フォルダ");
    expect(markInline("は `separated` フ", ["は", "sep"])).toEqual([
      { text: "は", code: false, mark: true },
      { text: " ", code: false, mark: false },
      { text: "sep", code: true, mark: true },
      { text: "arated", code: true, mark: false },
      { text: " フ", code: false, mark: false },
    ]);
    // a match that runs from the text into the code
    expect(markInline("a`bc`d", ["ab"])).toEqual([
      { text: "a", code: false, mark: true },
      { text: "b", code: true, mark: true },
      { text: "c", code: true, mark: false },
      { text: "d", code: false, mark: false },
    ]);
    // nothing found: the pieces, unmarked
    expect(markInline("は `separated` フ", ["xyz"]).some((p) => p.mark)).toBe(false);
  });
});

describe("help search: filtering", () => {
  it("shows everything for a blank query", () => {
    const r = filterDoc(doc, " ");
    expect(r.hits).toBe(0);
    expect(r.sections.map((s) => s.section.id)).toEqual(["overview", "steps", "fields", "tips", "faq"]);
    expect(r.sections[1].blocks[0]).toMatchObject({ kind: "steps", numbers: [1, 2, 3] });
  });

  it("keeps only the matching items, all terms in one item, and counts them", () => {
    const r = filterDoc(doc, "vram 3");
    // the row says 「VRAM を約 3〜4GB」; the FAQ answer has VRAM but no 3
    expect(r.hits).toBe(1);
    expect(r.sections.map((s) => s.section.id)).toEqual(["fields"]);
    const block = r.sections[0].blocks[0];
    expect(block.kind === "fields" && block.rows.map((x) => x.name)).toEqual(["ボーカルと伴奏に分離"]);
  });

  it("keeps the numbers of the steps that match", () => {
    const r = filterDoc(doc, "選びます");
    expect(r.sections[0].blocks[0]).toEqual({ kind: "steps", items: ["音源を選びます。", "分離モデルを選びます。"], numbers: [1, 2] });
  });

  it("keeps a whole section when its title matches, and a whole table when its panel name does", () => {
    const bySection = filterDoc(doc, "ヒント");
    expect(bySection.sections.map((s) => s.section.id)).toEqual(["tips"]);
    expect(bySection.sections[0].blocks).toHaveLength(2);
    expect(bySection.sections[0].titleHit).toBe(true);
    const byPanel = filterDoc(doc, "分離モデル");
    const fields = byPanel.sections.find((s) => s.section.id === "fields")!;
    expect(fields.blocks[0].kind === "fields" && fields.blocks[0].rows).toHaveLength(2);
  });

  it("counts a panel's name once when its table has the section's title (one heading on screen)", () => {
    const rows = [{ name: "種類", desc: "使うモデルです。" }];
    const panel: HelpDoc = { page: "separate", title: "ボーカル分離", sections: [{ id: "model", title: "分離モデル", panel: true, blocks: [{ kind: "fields", title: "分離モデル", rows }] }] };
    expect(countDoc(panel, "分離モデル")).toBe(1);
    // a part of the panel shown under its own heading counts too
    const part: HelpDoc = { ...panel, sections: [{ ...panel.sections[0], blocks: [{ kind: "fields", title: "分離モデルの詳細", rows }] }] };
    expect(countDoc(part, "分離モデル")).toBe(2);
  });

  it("matches katakana, half-width and full-width forms", () => {
    expect(countDoc(doc, "ｻｸﾗ")).toBe(1);
    expect(countDoc(doc, "さくら")).toBe(1);
    expect(countDoc(doc, "ＳＥＰＡＲＡＴＥＤ")).toBe(1);
    expect(countDoc(doc, "存在しない語")).toBe(0);
  });

  it("counts the other pages' matches, only those with any", () => {
    const other: HelpDoc = { page: "export", title: "書き出し", sections: [{ id: "a", title: "形式", blocks: [{ kind: "text", text: "VRAM は使いません。" }] }] };
    const docs = { separate: doc, export: other } as const;
    expect(otherPageCounts(docs, ["separate", "export"], "separate", "vram")).toEqual([{ page: "export", title: "書き出し", hits: 1 }]);
    expect(otherPageCounts(docs, ["separate", "export"], "separate", "")).toEqual([]);
  });
});
