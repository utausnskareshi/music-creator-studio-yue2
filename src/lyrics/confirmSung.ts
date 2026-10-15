// The lyrics to send when the hiragana version may be out of date (the kanji lyrics changed after it was made).
// Shared by the compose, cover and edit pages, which each keep their own sungLyrics / sungSource state.
import type { ChoiceRequest } from "../components/ChoiceDialog";
import { canKeepReadingFixes, effectiveLyrics, hasSungVersion, isSungStale, normalizeNewlines, reconvertKeepingFixes, toHiragana, type HiraganaResult, type LyricsLanguage } from "./hiragana";

export interface SungState {
  lyrics: string;
  sungLyrics: string | null;
  sungSource: string | null;
  language: LyricsLanguage;
}

export interface SungDecision {
  /** the text to send to the model */
  text: string;
  /** new hiragana-version state for the page (absent = unchanged) */
  update?: { sungLyrics: string | null; sungSource: string | null };
}

type Ask = <T extends string>(request: ChoiceRequest<T>) => Promise<T | null>;

const nl = normalizeNewlines;

/**
 * Ask what to sing when the hiragana version is stale. Returns the text to send (and the state to store), or
 * null when the user cancels.
 * - 再度ひらがな化: convert the current kanji lyrics; lines that did not change keep the readings fixed by hand in
 *   the hiragana pane (as the editor's button does), unless the pane's lines no longer pair with the kanji text.
 * - 漢字の歌詞で生成: drop the hiragana version and send the kanji lyrics (also offered when conversion fails).
 * - 今のひらがな版で生成: kept on purpose - after a display-only fix of the kanji text (a typo, punctuation) the
 *   hand-fixed readings are still right, and converting again would throw them away.
 */
export async function confirmSungLyrics(
  st: SungState,
  ask: Ask,
  convert: (text: string) => Promise<HiraganaResult> = toHiragana,
): Promise<SungDecision | null> {
  const current = nl(effectiveLyrics(st.lyrics, st.sungLyrics, st.language));
  if (st.language !== "ja" || !hasSungVersion(st.sungLyrics) || !isSungStale(st.lyrics, st.sungLyrics, st.sungSource)) return { text: current };
  const kanji: SungDecision = { text: nl(st.lyrics), update: { sungLyrics: null, sungSource: null } };
  const asis: SungDecision = { text: current, update: { sungLyrics: st.sungLyrics, sungSource: st.lyrics } };
  const keeps = canKeepReadingFixes(st.sungSource, st.sungLyrics);
  const choice = await ask({
    title: "ひらがな版が古い可能性があります",
    message:
      "左の歌詞（漢字あり）がひらがな化した後に変更されています。生成に使われるのは右のひらがな版なので、このままだと変更した歌詞は歌われません。" +
      (keeps
        ? "再度ひらがな化すると、変更した行は変換し直し、変更のない行は右の欄で手直しした読みを残します。"
        : "再度ひらがな化すると、右の欄で手直しした読みは置き換えられます。"),
    choices: [
      { value: "reconvert", label: "再度ひらがな化して生成", kind: "primary" },
      { value: "kanji", label: "漢字の歌詞で生成（ひらがな版を破棄）" },
      { value: "asis", label: "今のひらがな版で生成" },
    ],
  });
  if (!choice) return null;
  if (choice === "kanji") return kanji;
  if (choice === "asis") return asis;
  try {
    const r = await convert(st.lyrics);
    const m = reconvertKeepingFixes(st.lyrics, st.sungSource, st.sungLyrics, r.text);
    return { text: nl(m.text), update: { sungLyrics: m.text, sungSource: st.lyrics } };
  } catch (e) {
    const fallback = await ask({
      title: "ひらがな化に失敗しました",
      message: `辞書を使った変換ができませんでした（${e instanceof Error ? e.message : String(e)}）。どちらで生成しますか？`,
      choices: [
        { value: "kanji", label: "漢字の歌詞で生成（ひらがな版を破棄）", kind: "primary" },
        { value: "asis", label: "今のひらがな版で生成" },
      ],
    });
    if (fallback === "kanji") return kanji;
    if (fallback === "asis") return asis;
    return null;
  }
}
