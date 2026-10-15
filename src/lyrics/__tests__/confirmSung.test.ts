import { describe, expect, it } from "vitest";
import type { ChoiceRequest } from "../../components/ChoiceDialog";
import { confirmSungLyrics, type SungState } from "../confirmSung";
import type { HiraganaResult } from "../hiragana";

const kanji = "[Verse]\n空が静かに目を覚ます";
const oldKanji = "[Verse]\n街が静かに目を覚ます";
const oldKana = "[Verse]\nまちわしずかにめをさます"; // a reading fixed by hand
const stale: SungState = { lyrics: kanji, sungLyrics: oldKana, sungSource: oldKanji, language: "ja" };

/** An ask() that answers from a script and records the questions. */
function scripted(...answers: (string | null)[]) {
  const asked: ChoiceRequest<string>[] = [];
  const ask = async <T extends string>(r: ChoiceRequest<T>): Promise<T | null> => {
    asked.push(r as ChoiceRequest<string>);
    return (answers.shift() ?? null) as T | null;
  };
  return { ask, asked };
}
const converted = async (text: string): Promise<HiraganaResult> => ({ text: text.replace("空", "そら").replace("静", "しず").replace("目", "め").replace("覚", "さ") });
const broken = async (): Promise<HiraganaResult> => {
  throw new Error("辞書の読み込みがタイムアウトしました");
};

describe("confirmSungLyrics", () => {
  it("sends without asking when the hiragana version is current", async () => {
    const { ask, asked } = scripted();
    expect(await confirmSungLyrics({ ...stale, sungSource: kanji }, ask)).toEqual({ text: oldKana });
    expect(await confirmSungLyrics({ ...stale, language: "en" }, ask)).toEqual({ text: kanji });
    expect(asked).toHaveLength(0);
  });

  it("offers reconvert / kanji / as-is and says that unchanged lines keep their hand-fixed readings", async () => {
    const { ask, asked } = scripted("reconvert");
    const d = await confirmSungLyrics(stale, ask, converted);
    expect(asked[0].choices.map((c) => c.value)).toEqual(["reconvert", "kanji", "asis"]);
    expect(String(asked[0].message)).toContain("変更のない行は右の欄で手直しした読みを残します");
    expect(d?.update?.sungSource).toBe(kanji);
    expect(d?.text).toBe(d?.update?.sungLyrics);
  });

  it("reconverts only the edited lines, keeping the hand-fixed readings of the others", async () => {
    const src = "[Verse]\n街が静かに目を覚ます\n光が差す";
    const fixed = "[Verse]\nまちわしずかにめをさます\nひかりがさす"; // line 2 fixed by hand
    const edited = "[Verse]\n街が静かに目を覚ます\n光が満ちる"; // only line 3 changed
    const conv = async (text: string): Promise<HiraganaResult> => ({ text: text.replace("街が静かに目を覚ます", "まちがしずかにめをさます").replace("光が満ちる", "ひかりがみちる") });
    const { ask } = scripted("reconvert");
    const d = await confirmSungLyrics({ lyrics: edited, sungLyrics: fixed, sungSource: src, language: "ja" }, ask, conv);
    expect(d?.text).toBe("[Verse]\nまちわしずかにめをさます\nひかりがみちる");
  });

  it("says fixes are replaced, and replaces them, when the hiragana pane's lines no longer pair up", async () => {
    const src = "[Verse]\n街が静かに目を覚ます";
    const fixed = "[Verse]\nまちわしずかにめをさます\n（手で足した行）";
    const { ask, asked } = scripted("reconvert");
    const d = await confirmSungLyrics({ lyrics: kanji, sungLyrics: fixed, sungSource: src, language: "ja" }, ask, converted);
    expect(String(asked[0].message)).toContain("手直しした読みは置き換えられます");
    expect(d?.text).toBe((await converted(kanji)).text);
  });

  it("sings the kanji lyrics and drops the hiragana version", async () => {
    const { ask } = scripted("kanji");
    expect(await confirmSungLyrics(stale, ask, converted)).toEqual({ text: kanji, update: { sungLyrics: null, sungSource: null } });
  });

  it("keeps the current hiragana version on request (marks it as belonging to the new text)", async () => {
    const { ask } = scripted("asis");
    expect(await confirmSungLyrics(stale, ask, converted)).toEqual({ text: oldKana, update: { sungLyrics: oldKana, sungSource: kanji } });
  });

  it("falls back to the kanji lyrics when the conversion fails", async () => {
    const { ask, asked } = scripted("reconvert", "kanji");
    expect(await confirmSungLyrics(stale, ask, broken)).toEqual({ text: kanji, update: { sungLyrics: null, sungSource: null } });
    expect(asked[1].title).toBe("ひらがな化に失敗しました");
    const c = scripted("reconvert", null);
    expect(await confirmSungLyrics(stale, c.ask, broken)).toBeNull();
  });

  it("returns null on cancel", async () => {
    const { ask } = scripted(null);
    expect(await confirmSungLyrics(stale, ask, converted)).toBeNull();
  });
});
