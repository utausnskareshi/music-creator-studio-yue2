// Per-section Vocal onsets of the score next to the morae of the sung (kana) lyrics for Japanese, the estimated
// syllables for English and the Han characters for Chinese. Advisory: sections far off (ratio below 0.6 or
// above 1.3) are marked; nothing is blocked.
import { useMemo } from "react";
import { parseAbc } from "../abc/parse";
import { hasKanji, hasSungVersion, type LyricsLanguage } from "../lyrics/hiragana";
import { FIT_HIGH, FIT_LOW, countSungJa, countSyllablesEn, countSyllablesZh, sectionFit, type SectionFit } from "../lyrics/mora";

export interface SectionFitTableProps {
  abc: string;
  /** lyrics as written */
  lyrics: string;
  /** hiragana version (null = none) */
  sung: string | null;
  language: LyricsLanguage;
}

export interface SectionFitView extends SectionFit {
  /** the sung text can be counted (Japanese: a hiragana version or kana-only lyrics exist) */
  countable: boolean;
  /** no lyrics at all */
  empty: boolean;
}

/** The table's data, or null when there is nothing to show (another language, no or an unparsable score). */
export function sectionFitView(abc: string, lyrics: string, sung: string | null, language: LyricsLanguage): SectionFitView | null {
  if ((language !== "ja" && language !== "en" && language !== "zh") || !abc.trim()) return null;
  try {
    const score = parseAbc(abc);
    const empty = !lyrics.trim();
    if (language !== "ja") {
      // English / Chinese: the lyrics as written are what is sung, so a count is available whenever there are lyrics.
      return { ...sectionFit(score, empty ? null : lyrics, language === "en" ? countSyllablesEn : countSyllablesZh), countable: !empty, empty };
    }
    // Kana-only lyrics are what is sung even without a separate hiragana version.
    const sungText = hasSungVersion(sung) ? sung : !empty && !hasKanji(lyrics) ? lyrics : null;
    return { ...sectionFit(score, sungText, countSungJa), countable: sungText !== null, empty: empty && sungText === null };
  } catch {
    return null;
  }
}

/** The note under the table: why there are no counts, or how they are counted (`footer`). */
export function sectionFitNote(fit: SectionFitView, footer: string): string {
  if (fit.empty) return "歌詞を入力すると、セクションごとの音数と比較します。";
  if (!fit.countable) return "ひらがな版がないためモーラ数は表示しません（「ひらがな化」すると数えます）。";
  if (!fit.paired) return "譜面の歌うセクションと歌詞のセクションの数が一致しないため、対応付けできません。";
  return footer;
}

export default function SectionFitTable({ abc, lyrics, sung, language }: SectionFitTableProps) {
  const fit = useMemo(() => sectionFitView(abc, lyrics, sung, language), [abc, lyrics, sung, language]);
  if (!fit || fit.rows.length === 0) return null;
  const flagged = fit.rows.filter((r) => r.flag).length;
  const unit = language === "ja" ? "モーラ数" : language === "en" ? "音節数（推定）" : "音節数（漢字数）";
  const footer =
    language === "ja"
      ? `モーラ数（小さい ゃゅょ などは数えず、っ・ー・ん は数える。歌詞中の英語は単語ごとの推定音節数で数える）が音数の ${FIT_LOW} 倍未満または ${FIT_HIGH} 倍を超えるセクションを橙色で示します。1 音に複数モーラを当てることもあるので目安です。`
      : language === "en"
        ? `音節数は単語ごとの母音のまとまりから推定しています（語末の黙字の e は数えません。-ed・-es などで ±1 ずれることがあります）。音数の ${FIT_LOW} 倍未満または ${FIT_HIGH} 倍を超えるセクションを橙色で示します。メリスマ（1 音節を複数の音で歌う）や弱起もあるので目安です。`
        : `音節数は漢字 1 字 = 1 音節で数えています。音数の ${FIT_LOW} 倍未満または ${FIT_HIGH} 倍を超えるセクションを橙色で示します。メリスマや弱起もあるので目安です。`;
  return (
    <details>
      <summary>
        セクションごとの音数と{unit}（参考）{flagged > 0 ? `・差が大きいセクション ${flagged}` : ""}
      </summary>
      <table className="fit-table">
        <thead>
          <tr>
            <th>譜面のセクション</th>
            <th>歌詞</th>
            <th>ボーカルの音数</th>
            <th>{unit}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {fit.rows.map((r, i) => (
            <tr key={i} className={r.flag ? "flag" : undefined}>
              <td>{r.name}</td>
              <td>{r.tag !== null ? `[${r.tag}]` : "—"}</td>
              <td>{r.onsets}</td>
              <td>{r.morae ?? "—"}</td>
              <td>{r.flag === "low" ? "歌詞が少なめ" : r.flag === "high" ? "歌詞が多め" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">{sectionFitNote(fit, footer)}</div>
    </details>
  );
}
