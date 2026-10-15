// Parser input checks: missing K:, body fields, L: units, sections after an unclosed bar, duplicate chords.
import { describe, expect, it } from "vitest";
import { AbcParseError, parseAbc, validateAbc } from "../parse";
import { serializeAbc } from "../serialize";

const HEAD = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\n';
const score = (body: string, head = HEAD, key = "K:C\n") => head + key + body;

describe("parseAbc input checks", () => {
  it("rejects a score without K: instead of reading it as an empty score", () => {
    const text = score("% verse\nV: Vocal\nC16|\nV: Ins\nC16|\n", HEAD, "");
    expect(() => parseAbc(text)).toThrow(AbcParseError);
    expect(validateAbc(text)).toMatch(/K: 行がありません/);
    // the message places K: after the voice declarations of the header, as the YuE2 layout has it
    expect(validateAbc(text)).toContain("声部宣言 V: Vocal / V: Ins の後");
    // free text before the header is still fine
    expect(parseAbc("Here is the score:\n" + score("V: Vocal\nC16|\nV: Ins\nC16|\n")).notes).toHaveLength(2);
  });

  it("names a field line in the body instead of 'unreadable character'", () => {
    for (const [line, re] of [
      ["L:1/8", /本文中のフィールド L:/],
      ["Q:1/4=90", /本文中のフィールド Q:/],
      ["C: someone", /本文中のフィールド C:/],
      ["w: la la", /歌詞行 w:/],
    ] as const) {
      expect(validateAbc(score(`V: Vocal\n${line}\nC16|\nV: Ins\nC16|\n`))).toMatch(re);
    }
    // between K: and the first V: as well (not 「V: … の指定前に音符があります」)
    expect(validateAbc(score("T: title\nV: Vocal\nC16|\nV: Ins\nC16|\n"))).toMatch(/本文中のフィールド T:/);
    // M: / K: after V: are still group changes
    expect(parseAbc(score("V: Vocal\nC16|\nV: Ins\nC16|\nV: Vocal\nK:G\nG16|\nV: Ins\nK:G\nG16|\n")).keyChanges).toHaveLength(1);
  });

  it("accepts only L:1/n with a power of two up to 1024", () => {
    const withUnit = (u: string) => score("V: Vocal\nC16|\nV: Ins\nC16|\n", HEAD.replace("L:1/16", `L:${u}`));
    expect(validateAbc(withUnit("1/24"))).toMatch(/L:1\/24 は未対応/);
    expect(validateAbc(withUnit("1/0"))).toMatch(/L:1\/0 は未対応/);
    expect(validateAbc(withUnit("11/16"))).toMatch(/1\/n 形式/);
    expect(parseAbc(withUnit("1/32")).unit).toBe(32);
    expect(parseAbc(withUnit("1/8 % unit")).unit).toBe(8); // a trailing comment
  });

  it("rejects a score without L: instead of reading it at 1/16 (ABC's default for 4/4 is 1/8)", () => {
    // read at 1/16, every note was half as long, two written bars shared one and the chords moved to mid-bar
    const text = score('V: Vocal\n"C"C2D2E2F2|"G"G8|\nV: Ins\nZ2|\n', HEAD.replace("L:1/16\n", ""));
    expect(() => parseAbc(text)).toThrow(AbcParseError);
    expect(validateAbc(text)).toMatch(/^L: 行がありません/);
    // L: anywhere in the header is fine
    expect(parseAbc(score("V: Vocal\nC16|\nV: Ins\nC16|\n", HEAD.replace("L:1/16\n", "").replace("M:4/4\n", "M:4/4\nL:1/16\n"))).unit).toBe(16);
  });

  it("treats Unicode spaces in a music line as spaces, as the official check does", () => {
    // NBSP (pasted from a web page) and U+3000 (typed with the IME on) were 「解釈できない文字 " "」
    for (const sp of [" ", "　", " "]) {
      const s = parseAbc(score(`V: Vocal\nC4${sp}D4E4F4|\nV: Ins\nC16|\n`));
      expect(s.notes.filter((n) => n.voice === "Vocal").map((n) => n.pitch)).toEqual([60, 62, 64, 65]);
    }
  });

  it("names an invisible character by its code point", () => {
    // a zero-width space is no space for the official check either: the message must show what to delete
    expect(validateAbc(score("V: Vocal\nC4​D4E4F4|\nV: Ins\nC16|\n"))).toBe("行 10: 解釈できない文字 U+200B（目に見えない文字です。削除してください）");
    expect(validateAbc(score("V: Vocal\nC4D4E4F4|@\nV: Ins\nC16|\n"))).toBe('行 10: 解釈できない文字 "@"');
  });

  it("places a section after a line whose last bar has no closing barline", () => {
    const text = score("% verse\nV: Vocal\nC4D4E4F4|C16\nV: Ins\nC16|C16\n% chorus\nV: Vocal\nD16|\nV: Ins\nD16|\n");
    const s = parseAbc(text);
    expect(s.sections).toEqual([
      { name: "verse", bar: 0 },
      { name: "chorus", bar: 2 },
    ]);
    // written back, both verse bars stay in the verse group
    const back = serializeAbc(s);
    const verse = back.slice(back.indexOf("% verse"), back.indexOf("% chorus"));
    expect(verse.match(/\|/g)?.length).toBe(4); // 2 bars in each voice
  });

  it("keeps one chord per position: a duplicate is dropped, a different one is an error", () => {
    expect(parseAbc(score('V: Vocal\n"C""C"C16|\nV: Ins\nC16|\n')).chords).toEqual([{ start: 0, symbol: "C" }]);
    expect(parseAbc(score('V: Vocal\n"C"C16|\nV: Ins\n"C"C16|\n')).chords).toEqual([{ start: 0, symbol: "C" }]);
    const msg = validateAbc(score('V: Vocal\n"C""G"C16|\nV: Ins\nC16|\n'));
    expect(msg).toMatch(/^行 10: 同じ位置に異なるコード記号があります/);
  });
});
