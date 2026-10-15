// One rule for a hiragana pane emptied by hand: it is no hiragana version anywhere (the kanji lyrics are sung, as the
// editor says next to it). An AI edit's 適用 does not rebuild it, the check before a render does not ask about it, an
// AI draft does not count it as something to lose, and the help says so. What is sung (not the kanji pane) also
// decides the notes and questions about lyrics with nothing to sing.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChoiceRequest } from "../../components/ChoiceDialog";
import { NO_WORDS_NOTE, draftReplaces } from "../../compose/submitPlan";
import { coverHelp } from "../../help/content/cover";
import { editHelp } from "../../help/content/edit";
import { confirmSungLyrics } from "../confirmSung";
import { effectiveLyrics, hasSungVersion } from "../hiragana";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const guide = readFileSync(new URL("../../../docs/USER_GUIDE.md", import.meta.url), "utf8");

/** The body of the arrow function declared by `decl` in `code` (from its first "{" to the matching "}"). */
function body(code: string, decl: string): string {
  const at = code.indexOf(decl);
  expect(at, decl).toBeGreaterThan(-1);
  return block(code, code.indexOf("{", code.indexOf("=>", at)));
}

/** The brace block opened at `open` (inclusive). */
function block(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error("unbalanced block");
}

/** The block of the statement starting with `head` in `code` (`if (x) {` ... `}`). */
function blockOf(code: string, head: string): string {
  const at = code.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  return block(code, at + head.length - 1);
}

/** `code` with the given blocks taken out. */
const without = (code: string, ...blocks: string[]) => blocks.reduce((c, b) => c.replace(b, ""), code);

describe("a hiragana pane emptied by hand", () => {
  it("is no hiragana version: the kanji lyrics are sung", () => {
    expect(hasSungVersion(null)).toBe(false);
    expect(hasSungVersion("")).toBe(false);
    // blank lines and spaces, the full-width one too
    expect(hasSungVersion(" \n　\n")).toBe(false);
    expect(hasSungVersion("あさのひかり")).toBe(true);
    expect(effectiveLyrics("朝の光", "", "ja")).toBe("朝の光");
    expect(effectiveLyrics("朝の光", "  \n", "ja")).toBe("朝の光");
    expect(effectiveLyrics("朝の光", "あさのひかり", "ja")).toBe("あさのひかり");
    expect(effectiveLyrics("朝の光", "あさのひかり", "en")).toBe("朝の光");
  });

  it("is not asked about before a render, even when the kanji lyrics changed after it was made", async () => {
    const asked: ChoiceRequest<string>[] = [];
    const ask = async <T extends string>(r: ChoiceRequest<T>): Promise<T | null> => {
      asked.push(r as ChoiceRequest<string>);
      return null;
    };
    for (const sungLyrics of ["", "  \n"]) {
      const d = await confirmSungLyrics({ lyrics: "[Verse]\n空が静かに", sungLyrics, sungSource: "[Verse]\n街が静かに", language: "ja" }, ask);
      // the kanji lyrics are sent, the pane is left as it is
      expect(d).toEqual({ text: "[Verse]\n空が静かに" });
    }
    expect(asked).toHaveLength(0);
  });

  it("is nothing an AI draft would replace (it holds no readings), while typed lyrics next to it still are", () => {
    const base = { lyrics: "DEF", defaultLyrics: "DEF", style: "S", defaultStyle: "S", composedStyle: "" };
    expect(draftReplaces({ ...base, sungLyrics: "" }).lyrics).toBe(false);
    expect(draftReplaces({ ...base, sungLyrics: " \n" }).lyrics).toBe(false);
    expect(draftReplaces({ ...base, sungLyrics: "わたしの" }).lyrics).toBe(true);
    // the kanji lyrics decide on their own
    expect(draftReplaces({ ...base, lyrics: "私の歌詞", sungLyrics: "" }).lyrics).toBe(true);
    const lastDraft = { lyrics: "AI の歌詞", style: "S" };
    expect(draftReplaces({ ...base, lyrics: "AI の歌詞", sungLyrics: "", lastDraft }).lyrics).toBe(false);
    expect(draftReplaces({ ...base, lyrics: "AI の歌詞（手直し）", sungLyrics: "", lastDraft }).lyrics).toBe(true);
  });

  it("is not rebuilt by AI 編集's 適用: only a version with text is converted and written", () => {
    const apply = body(read("pages/EditPage.tsx"), "const apply = async (");
    const decl = apply.match(/const rebuildSung = ([^;]*);/)?.[1] ?? "";
    expect(decl).toMatch(/\bhasSungVersion\(sungLyrics\)/);
    expect(decl).toMatch(/\blyricsChanged\b/);
    expect(decl).toMatch(/lyricsLanguage === "ja"/);
    expect(apply).toMatch(/if \(rebuildSung\) \{\s*setConverting\(true\);/);
    expect(apply).toContain('const during = rebuildSung ? "ひらがな版の作り直し中に" : "適用の確認中に";');
    // the conversion runs only for such a version, and the pane is written only from its result (or dropped when it
    // failed): nothing else in 適用 touches the hiragana version
    const rebuild = blockOf(apply, "if (rebuildSung) {");
    const rebuilt = blockOf(apply, "if (rebuilt) {");
    const failed = blockOf(apply, "} else if (rebuildError !== null) {");
    expect(rebuild).toContain("await toHiragana(nextLyrics)");
    expect(rebuilt).toMatch(/setSungLyrics\(next\.text\);\s*setSungSource\(nextLyrics\);/);
    expect(failed).toMatch(/setSungLyrics\(null\);\s*setSungSource\(null\);/);
    expect(without(apply, rebuild, rebuilt, failed)).not.toMatch(/toHiragana\(|setSungLyrics\(|setSungSource\(/);
  });

  it("gives the AI no reading as context", () => {
    const edit = read("pages/EditPage.tsx");
    const send = body(edit, "const send = async (");
    expect(send).toContain('const sung = lyricsLanguage === "ja" && hasSungVersion(sungLyrics) ? sungLyrics : null;');
    // that `sung` is what the request, the fit check and the history budget get
    expect(send).toContain("api.llmEdit(sentAbc, sentStyle, sentLyrics, h, ins, sung, requestId)");
    expect(send).toMatch(/localFitOk\(\{[^}]*\bsung,/);
    expect(send).toMatch(/editHistoryBudget\(\{[^}]*\bsung,/);
  });

  it("is decided with the same rule in every page and component", () => {
    expect(read("components/LyricsEditor.tsx")).toContain("const hasSung = hasSungVersion(sung);");
    expect(read("lyrics/confirmSung.ts")).toMatch(/!hasSungVersion\(st\.sungLyrics\)/);
    expect(read("components/SectionFitTable.tsx")).toMatch(/const sungText = hasSungVersion\(sung\) \?/);
    const compose = read("pages/ComposePage.tsx");
    expect(compose).toMatch(/risk\.lyrics \? \(hasSungVersion\(sungLyrics\) \? "歌詞（ひらがな版を含む）"/);
    expect(compose).toMatch(/\{hasSungVersion\(sungLyrics\) && lyricsLanguage === "ja" && <div className="muted small">生成にはひらがな版の歌詞を使用します。<\/div>\}/);
    // no page or component checks a blank hiragana version on its own (the `.trim()` spellings; the other places
    // that decide from the pane have their own checks above and in the pages' tests)
    for (const dir of ["pages", "components"])
      for (const f of readdirSync(new URL(`../../${dir}`, import.meta.url)).filter((n) => /\.tsx?$/.test(n))) {
        const code = read(`${dir}/${f}`);
        expect(code, `${dir}/${f}`).not.toMatch(/\bsung(?:Lyrics)?\??\.trim\(\)/);
        expect(code, `${dir}/${f}`).not.toMatch(/\bsung(?:Lyrics)? !== null && sung(?:Lyrics)?\.trim/);
      }
  });

  it("is described in AI 編集's help and the guide as left empty by 適用", () => {
    const text = JSON.stringify(editHelp);
    expect(text).toContain("右のひらがな版の欄を空にしていたとき（漢字の歌詞で生成する扱い）は、ひらがな版を作り直さず");
    expect(text).not.toContain("欄を空にするかわりに「ひらがな版を破棄」");
    expect(guide).toContain("右の欄を空にしているとき（漢字の歌詞で生成する扱い）は作り直さず、空のままです。");
  });
});

describe("lyrics with nothing to sing", () => {
  it("are noted without promising a song without a voice: an instrumental render can still let one in now and then", () => {
    expect(NO_WORDS_NOTE).not.toContain("確実");
    expect(NO_WORDS_NOTE).toContain("「インストゥルメンタル版を生成」");
    expect(NO_WORDS_NOTE).toContain("まれに声が混じることがあります");
    // plain sentences: the toast joins the notes with 。 and may add the page's name in brackets after the last one
    expect(NO_WORDS_NOTE).not.toMatch(/）$/);
    // the help and the guide say the same
    const composeHelp = read("help/content/compose.ts");
    expect(composeHelp).not.toMatch(/確実に歌なし/);
    expect(composeHelp).toContain("それでもまれに声が混じることがあります");
    expect(guide).not.toMatch(/確実に歌なし/);
    expect(guide).toContain("それでもまれに声が混じることがあります");
  });

  it("are decided from what is sung on the cover page too, after the hiragana question", () => {
    const cover = read("pages/CoverPage.tsx");
    const send = body(cover, "const cover = async (");
    const sung = send.indexOf("const sung = await confirmSung();");
    const nothing = send.indexOf("if (!hasSungWords(sung)) {");
    expect(sung).toBeGreaterThan(-1);
    expect(nothing).toBeGreaterThan(sung);
    expect(send).not.toMatch(/hasSungWords\(lyrics\)/);
    // the score editor compares its sections with what would be sung
    expect(cover).toContain("const sungNow = effectiveLyrics(lyrics, sungLyrics, lyricsLanguage);");
    expect(cover).toContain("lyrics={sungNow.trim() ? sungNow : undefined}");
  });

  it("are described as the page decides them: in its help (in the page's order) and in the guide", () => {
    const help = JSON.stringify(coverHelp);
    const hiragana = help.indexOf("日本語の歌詞をひらがな化した後に左の歌詞を変えたとき");
    const nothing = help.indexOf("歌う歌詞（ひらがな版があるときはひらがな版）がない（空、またはタグだけ）とき");
    expect(hiragana).toBeGreaterThan(-1);
    expect(nothing).toBeGreaterThan(hiragana);
    expect(help).toContain("歌う歌詞（ひらがな版があるときはひらがな版）が空のまま（またはタグだけで）「この譜面でカバーを生成」を押すと");
    expect(guide).toContain("歌う歌詞（ひらがな版があるときはひらがな版）が空のまま「この譜面でカバーを生成」を押した場合も");
  });
});

describe("the texts about the hiragana version", () => {
  it("quote what the screen shows", () => {
    // the editor's hint for a version made from older kanji lyrics, word for word
    const hint = read("components/LyricsEditor.tsx").match(/<span className="hint">(ひらがな化の後に左の歌詞が変更されています[^<]*)<\/span>/)?.[1];
    expect(hint).toBeTruthy();
    expect(guide).toContain(`「${hint}」と表示されます`);
  });

  it("say the piano roll's note also covers what the form would sing", () => {
    expect(read("help/content/compose.ts")).toContain("ひらがな版の読みを直した、ひらがな版を空にしたなど、歌われる歌詞だけが違うときも");
    expect(guide).toContain("フォームの内容（スタイル・歌詞、ひらがな版を空にしたなどで歌われる歌詞が違う場合を含む）と違う場合はその旨が表示されます");
  });
});

describe("line breaks of the lyrics stored with a song", () => {
  it("are LF in the display text every page sends, and in an AI edit's lyrics once applied", () => {
    // a display text that differs from the sung text only in its line breaks would be stored as a hiragana version
    expect(read("pages/ComposePage.tsx")).toContain("const display = over.lyricsDisplay ?? (formLyrics ? normalizeNewlines(lyrics) : sung);");
    expect(read("pages/CoverPage.tsx")).toContain("lyricsDisplay: normalizeNewlines(lyrics),");
    const edit = read("pages/EditPage.tsx");
    expect(edit).toContain("lyricsDisplay: normalizeNewlines(lyrics),");
    expect(edit).toContain("const nextLyrics = r.lyrics.trim() ? normalizeNewlines(r.lyrics) : lyrics;");
  });
});
