import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMON_TAGS, MAX_TAG_LENGTH, TAG_GROUPS, TAG_INPUT_MAX_UNITS, formatTag, insertTagAt, tagOverflow, nextNumber, numberedTag, parseTag } from "../sectionTags";

describe("tag catalog", () => {
  it("has unique ASCII tags", () => {
    const all = [...COMMON_TAGS, ...TAG_GROUPS.flatMap((g) => g.tags)].map((t) => t.tag);
    expect(new Set(all).size).toBe(all.length);
    for (const t of all) expect(t).toMatch(/^[A-Za-z0-9 :&-]+$/);
  });
});

describe("formatTag", () => {
  it("strips brackets, line breaks and extra spaces", () => {
    expect(formatTag("  [ Guitar  Solo ]\n")).toBe("Guitar Solo");
    expect(formatTag("［Verse 2: Female］")).toBe("Verse 2: Female");
    expect(formatTag("Ｇｕｉｔａｒ　Ｓｏｌｏ　２")).toBe("Guitar Solo 2"); // full-width input from a Japanese IME
    expect(formatTag("[[]]")).toBe("");
    expect(formatTag("   ")).toBe("");
  });

  it("lets the 任意のタグ field hold a tag of MAX_TAG_LENGTH characters in brackets, also of emoji (its maxLength counts UTF-16 units)", () => {
    const emoji = `[${"🎸".repeat(MAX_TAG_LENGTH)}]`;
    expect(emoji.length).toBeLessThanOrEqual(TAG_INPUT_MAX_UNITS);
    expect(formatTag(emoji)).toBe("🎸".repeat(MAX_TAG_LENGTH));
    // and the field uses it
    const editor = readFileSync(new URL("../../components/LyricsEditor.tsx", import.meta.url), "utf8");
    expect(editor).toMatch(/maxLength={TAG_INPUT_MAX_UNITS}/);
  });

  it("says how much of a tag typed beyond MAX_TAG_LENGTH characters will not be inserted (the field takes more)", () => {
    const long = "Verse 2: Female lead vocal with soft whispered harmonies and gentle piano, building up";
    expect(Array.from(long).length).toBe(86);
    expect(tagOverflow(long)).toBe(86 - MAX_TAG_LENGTH);
    // counted as inserted: brackets and doubled spaces do not count, emoji count once
    expect(tagOverflow(`[${"a".repeat(MAX_TAG_LENGTH)}]`)).toBe(0);
    expect(tagOverflow("a  ".repeat(30))).toBe(0);
    expect(tagOverflow("🎸".repeat(MAX_TAG_LENGTH + 3))).toBe(3);
    expect(tagOverflow("")).toBe(0);
    // a bracket left at either end with a space before or after it is not inserted and not counted
    expect(tagOverflow(`${"a".repeat(MAX_TAG_LENGTH)} [`)).toBe(0);
    expect(tagOverflow(`${"a".repeat(MAX_TAG_LENGTH)} []`)).toBe(0);
    expect(formatTag(`[] ${"a".repeat(MAX_TAG_LENGTH)}`)).toBe("a".repeat(MAX_TAG_LENGTH));
    // the field shows it under the input
    const editor = readFileSync(new URL("../../components/LyricsEditor.tsx", import.meta.url), "utf8");
    expect(editor).toContain("const overflow = tagOverflow(customTag);");
    expect(editor).toContain("{overflow > 0 && <div className=\"hint\">");
  });

  it("cuts at MAX_TAG_LENGTH characters without splitting an emoji (a lone surrogate breaks every IPC call)", () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // 61 UTF-16 units: the emoji straddles unit 60
    const straddling = formatTag(`${"x".repeat(MAX_TAG_LENGTH - 1)}🔥`);
    expect(straddling).not.toMatch(loneSurrogate);
    expect(JSON.stringify(`[${straddling}]`)).not.toMatch(/\\ud[89a-f]/i);
    expect(Array.from(straddling)).toHaveLength(MAX_TAG_LENGTH);
    // counted in characters (code points): 31 characters stay whole
    expect(formatTag(`a${"🔥".repeat(30)}`)).toBe(`a${"🔥".repeat(30)}`);
    expect(formatTag("🎵".repeat(MAX_TAG_LENGTH + 5))).toBe("🎵".repeat(MAX_TAG_LENGTH));
    // half a character from elsewhere (a recent-tag chip saved by an earlier version) is dropped
    expect(formatTag("Guitar Solo \uD83D")).toBe("Guitar Solo");
  });
});

describe("numbering", () => {
  it("parses base, number and suffix", () => {
    expect(parseTag("Verse 2: Female")).toEqual({ base: "Verse", number: 2, suffix: ": Female" });
    expect(parseTag("Pre-Chorus")).toEqual({ base: "Pre-Chorus", number: null, suffix: "" });
    expect(parseTag("Chorus:Female & Male")).toEqual({ base: "Chorus", number: null, suffix: ": Female & Male" });
  });

  it("numbers tags including performer suffixes", () => {
    expect(numberedTag("Chorus", 3)).toBe("Chorus 3");
    expect(numberedTag("Verse: Female", 1)).toBe("Verse 1: Female");
  });

  it("continues from the tags already in the lyrics", () => {
    expect(nextNumber("", "Verse")).toBe(1);
    expect(nextNumber("[Verse 1]\nla\n\n[verse 2]\nla\n\n[Chorus]\n", "Verse")).toBe(3);
    expect(nextNumber("[Chorus]\nla\n[Chorus]\nla", "Chorus")).toBe(3);
    expect(nextNumber("[Verse 1: Female]\nla", "Verse: Male")).toBe(2);
    expect(nextNumber("[Pre-Chorus 2]\n", "Chorus")).toBe(1);
  });
});

describe("insertTagAt", () => {
  it("appends on its own line at the end", () => {
    expect(insertTagAt("", null, "Verse")).toEqual({ text: "[Verse]\n", caret: 8 });
    expect(insertTagAt("la la", null, "Chorus")).toEqual({ text: "la la\n\n[Chorus]\n", caret: 16 });
    expect(insertTagAt("la la\n", null, "Chorus").text).toBe("la la\n\n[Chorus]\n");
    expect(insertTagAt("la la\n\n", null, "Chorus").text).toBe("la la\n\n[Chorus]\n");
  });

  it("inserts at the caret without breaking surrounding lines", () => {
    const r = insertTagAt("aaa\nbbb", 4, "Bridge"); // caret at the start of the second line
    expect(r.text).toBe("aaa\n\n[Bridge]\nbbb");
    expect(r.text.slice(r.caret)).toBe("bbb");
    const mid = insertTagAt("aaa\nbbb", 3, "Bridge"); // caret at the end of the first line
    expect(mid.text).toBe("aaa\n\n[Bridge]\nbbb");
    expect(mid.text.slice(mid.caret)).toBe("bbb");
  });

  it("inserts before the line when the caret is inside it (never splits a sung line)", () => {
    const r = insertTagAt("aaa\n朝の光", 6, "Chorus"); // caret after 朝の
    expect(r.text).toBe("aaa\n\n[Chorus]\n朝の光");
    expect(r.text.slice(r.caret)).toBe("朝の光");
    expect(insertTagAt("朝の光が窓を照らして", 2, "Verse").text).toBe("[Verse]\n朝の光が窓を照らして");
    // at the end of a line (the usual state after typing it) the tag goes after it
    expect(insertTagAt("aaa\n朝の光\nbbb", 7, "Chorus").text).toBe("aaa\n朝の光\n\n[Chorus]\nbbb");
  });

  it("does not add a blank line before a tag at the very top", () => {
    expect(insertTagAt("la la", 0, "Intro").text).toBe("[Intro]\nla la");
  });
});
