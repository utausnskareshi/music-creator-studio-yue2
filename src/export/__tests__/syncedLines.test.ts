import { describe, expect, it } from "vitest";
import type { AlignedLine } from "../../api";
import {
  applyAlignment,
  clampLineIndex,
  countPlaceholders,
  countRejectedAlignments,
  countUnromanizedLines,
  emptyAlignmentMessage,
  finalizeSynced,
  followTimeDraft,
  formatLrcTime,
  interpolateMissing,
  isNonLyricLine,
  isConfidentAlignment,
  linesOutOfDate,
  lyricsForTags,
  lyricsLineIndex,
  needsUroman,
  parseLrcTime,
  peakFromSongJson,
  placeholderLines,
  plainLyricLines,
  rebuildLines,
  refreshInterpolated,
  resetTimings,
  setLineTime,
  syncDefault,
  timeFieldCommit,
  type TimedLine,
} from "../syncedLines";

const al = (index: number, line: string, start: number): AlignedLine => ({ index, line, start, end: start + 1, words: [] });

describe("placeholder lines", () => {
  it("strips tags and marks every line as placeholder", () => {
    const plain = plainLyricLines("[Verse]\nあ\n\n い \n[Chorus]\nう");
    expect(plain).toEqual(["あ", "い", "う"]);
    const lines = placeholderLines(plain);
    expect(lines.map((l) => [l.timeMs, l.src])).toEqual([
      [0, "placeholder"],
      [4000, "placeholder"],
      [8000, "placeholder"],
    ]);
    expect(syncDefault(lines)).toBe(false);
    expect(syncDefault([])).toBe(false);
  });
});

describe("applyAlignment", () => {
  const lyrics = "[Verse]\none\ntwo\nthree\nfour\n[Chorus]\nfive";
  const plain = plainLyricLines(lyrics);

  it("marks only matched lines as aligned and interpolates the rest", () => {
    // The node skipped "two" and "four" (no romanizable tokens).
    const aligned = [al(1, "one", 10), al(3, "three", 20), al(6, "five", 40)];
    const lines = applyAlignment(plain, lyrics, aligned, 60_000);
    // an estimated line starts where the aligned line before it was heard to end (one second after its start here)
    expect(lines.map((l) => [l.text, l.timeMs, l.src])).toEqual([
      ["one", 10_000, "aligned"],
      ["two", 11_000, "interpolated"],
      ["three", 20_000, "aligned"],
      ["four", 21_000, "interpolated"],
      ["five", 40_000, "aligned"],
    ]);
    expect(countPlaceholders(lines)).toBe(0);
    expect(syncDefault(lines)).toBe(true);
  });

  it("fills lines before the first and after the last anchor", () => {
    const aligned = [al(3, "three", 30)];
    const lines = applyAlignment(plain, lyrics, aligned, 50_000);
    // before: spread between 0 and 30 s over indexes -1..2
    expect(lines[0].timeMs).toBe(10_000);
    expect(lines[1].timeMs).toBe(20_000);
    expect(lines[2].src).toBe("aligned");
    // after: from the end of the sung line (31 s) toward the song end
    expect(lines[3].timeMs).toBe(31_000);
    expect(lines[4].timeMs).toBe(40_500);
    expect(lines.every((l, i) => i === 0 || l.timeMs >= lines[i - 1].timeMs)).toBe(true);
  });

  it("does not show an estimated line while the aligned line before it is still sung (E2E align_i_en)", () => {
    const plain2 = ["a", "b", "City waking down below", "Sing it loud and let it go", "tail"];
    const aligned: AlignedLine[] = [
      { index: 0, line: "a", start: 2, end: 6, words: [] },
      { index: 1, line: "b", start: 8, end: 12, words: [] },
      { index: 2, line: "City waking down below", start: 14.3, end: 18.0, words: [] },
    ];
    const lines = applyAlignment(plain2, plain2.join("\n"), aligned, 20_000);
    expect(lines.slice(3).map((l) => [l.timeMs, l.src])).toEqual([
      [18_000, "interpolated"],
      [19_000, "interpolated"],
    ]);
    // a tap on another line keeps that bound; a time set by hand on the aligned line drops it
    const tapped = setLineTime(lines, 0, 1_500, "tapped", 20_000);
    expect(tapped[3].timeMs).toBe(18_000);
    const typed = setLineTime(lines, 2, 14_000, "manual", 20_000);
    expect(typed[2].endMs).toBeUndefined();
    expect(typed[3].timeMs).toBeCloseTo(16_000, -1);
    // the sung end is not exported
    expect(finalizeSynced(lines).synced[2]).toEqual({ timeMs: 14_300, text: "City waking down below" });
  });

  it("ignores a sung end at or past the song end", () => {
    const aligned: AlignedLine[] = [{ index: 1, line: "one", start: 10, end: 70, words: [] }];
    const lines = applyAlignment(plain, lyrics, aligned, 60_000);
    // spread from the start as before (0 is a placeholder-less estimate before the anchor)
    expect(lines[1].timeMs).toBe(20_000);
  });

  it("without the song end the trailing lines sit at the last anchor", () => {
    const lines = applyAlignment(plain, lyrics, [al(1, "one", 5)], null);
    expect(lines.slice(1).map((l) => l.timeMs)).toEqual([5000, 5000, 5000, 5000]);
  });

  it("falls back to matching by text", () => {
    const lines = applyAlignment(["x", "y"], "x\ny", [al(99, "y", 3)], null);
    expect(lines[1]).toMatchObject({ timeMs: 3000, src: "aligned" });
    expect(lines[0].src).toBe("interpolated");
  });

  it("leaves placeholders when nothing was aligned", () => {
    const lines = applyAlignment(plain, lyrics, [], 60_000);
    expect(lines.every((l) => l.src === "placeholder")).toBe(true);
  });
});

describe("rebuildLines", () => {
  it("keeps real times only for matching text, in order", () => {
    const old: TimedLine[] = [
      { text: "a", timeMs: 1000, src: "tapped" },
      { text: "b", timeMs: 2000, src: "aligned" },
      { text: "c", timeMs: 9000, src: "interpolated" },
      { text: "d", timeMs: 4000, src: "manual" },
    ];
    // "x" inserted, "b" edited to "B", "c" was only interpolated.
    const lines = rebuildLines(["a", "x", "B", "c", "d"], old, null);
    expect(lines.map((l) => [l.text, l.src])).toEqual([
      ["a", "tapped"],
      ["x", "interpolated"],
      ["B", "interpolated"],
      ["c", "interpolated"],
      ["d", "manual"],
    ]);
    expect(lines[0].timeMs).toBe(1000);
    expect(lines[4].timeMs).toBe(4000);
    expect(lines[1].timeMs).toBe(1750);
  });

  it("does not copy times by index", () => {
    const old = placeholderLines(["a", "b"]);
    const lines = rebuildLines(["b", "a"], old, null);
    expect(lines.every((l) => l.src === "placeholder")).toBe(true);
  });
});

describe("finalizeSynced", () => {
  it("keeps lyric order, clamps backwards times and strips src", () => {
    const lines: TimedLine[] = [
      { text: "a", timeMs: 1000, src: "aligned" },
      { text: "b", timeMs: 500, src: "manual" },
      { text: "c", timeMs: 3000, src: "tapped" },
    ];
    const { synced, clamped } = finalizeSynced(lines);
    expect(synced).toEqual([
      { timeMs: 1000, text: "a" },
      { timeMs: 1000, text: "b" },
      { timeMs: 3000, text: "c" },
    ]);
    expect(clamped).toBe(1);
    expect(Object.keys(synced[0])).toEqual(["timeMs", "text"]);
  });

  it("interpolation keeps times monotonic when anchors are", () => {
    const lines = interpolateMissing(
      [
        { text: "a", timeMs: 0, src: "placeholder" },
        { text: "b", timeMs: 12_000, src: "tapped" },
        { text: "c", timeMs: 0, src: "placeholder" },
        { text: "d", timeMs: 0, src: "placeholder" },
        { text: "e", timeMs: 20_000, src: "aligned" },
      ],
      30_000,
    );
    expect(lines.map((l) => l.timeMs)).toEqual([6000, 12_000, 14_667, 17_333, 20_000]);
    expect(finalizeSynced(lines).clamped).toBe(0);
  });
});

describe("editing times", () => {
  const base: TimedLine[] = [
    { text: "a", timeMs: 0, src: "aligned" },
    { text: "b", timeMs: 5000, src: "interpolated" },
    { text: "c", timeMs: 10_000, src: "aligned" },
    { text: "d", timeMs: 15_000, src: "interpolated" },
    { text: "e", timeMs: 20_000, src: "aligned" },
  ];

  it("a tap re-estimates the interpolated neighbours and never moves anchors", () => {
    const next = setLineTime(base, 2, 4000, "tapped", 30_000);
    expect(next.map((l) => l.src)).toEqual(["aligned", "interpolated", "tapped", "interpolated", "aligned"]);
    expect(next.map((l) => l.timeMs)).toEqual([0, 2000, 4000, 12_000, 20_000]);
    expect(finalizeSynced(next).clamped).toBe(0);
    expect(base[2].timeMs).toBe(10_000); // input not mutated
  });

  it("a typed time is 'manual'; placeholders stay placeholders", () => {
    const lines = placeholderLines(["a", "b", "c"]);
    const next = setLineTime(lines, 1, 7000, "manual", 30_000);
    expect(next.map((l) => l.src)).toEqual(["placeholder", "manual", "placeholder"]);
    expect(next.map((l) => l.timeMs)).toEqual([0, 7000, 8000]);
    expect(syncDefault(next)).toBe(false);
    expect(refreshInterpolated(lines, 30_000)).toBe(lines);
  });

  it("switching the audio file drops every time", () => {
    const next = resetTimings(base);
    expect(next.map((l) => l.text)).toEqual(["a", "b", "c", "d", "e"]);
    expect(countPlaceholders(next)).toBe(5);
    expect(syncDefault(next)).toBe(false);
  });
});

describe("helpers", () => {
  it("explains empty alignment results", () => {
    const hint = "「設定 → セットアップをやり直す」で「多言語ローマ字化（uroman）」を導入すると対応できます";
    const unsupported = `この文字体系は自動整列に未対応です。${hint}（それまではタップ同期を使ってください）`;
    expect(emptyAlignmentMessage("other", "사랑해")).toBe(unsupported);
    expect(emptyAlignmentMessage("en", "사랑해")).toBe(unsupported);
    expect(emptyAlignmentMessage("ja", "[Verse]\n사랑해")).toBe(unsupported);
    expect(emptyAlignmentMessage("zh", "こんにちは")).toBe(unsupported);
    // with uroman installed the script is not the cause
    expect(emptyAlignmentMessage("other", "사랑해", true)).toBe("整列結果が空でした（ボーカル分離の結果を確認してください）");
    // Latin text is aligned whatever the language setting
    expect(emptyAlignmentMessage("en", "hello")).toBe("整列結果が空でした");
    expect(emptyAlignmentMessage("other", "hello")).toBe("整列結果が空でした");
    // ja / zh have romanizers: an empty result points at the romanizer or the vocals, not the script.
    const romanizer = "整列結果が空でした（ローマ字化ライブラリ（pykakasi / pypinyin）の導入状況と、ボーカル分離の結果を確認してください）";
    expect(emptyAlignmentMessage("ja", "[Verse]\nこんにちは")).toBe(romanizer);
    expect(emptyAlignmentMessage("ja", "カタカナ\n漢字")).toBe(romanizer);
    expect(emptyAlignmentMessage("zh", "我爱你")).toBe(romanizer);
  });

  it("tells the scripts only uroman romanizes and counts the lines the node skipped for them", () => {
    expect(needsUroman("en", "Morning light")).toBe(false);
    expect(needsUroman("other", "Hola amigos")).toBe(false);
    expect(needsUroman("en", "사랑해")).toBe(true);
    expect(needsUroman("other", "Привет")).toBe(true);
    expect(needsUroman("ja", "君は")).toBe(false);
    expect(needsUroman("ja", "きみは")).toBe(false);
    expect(needsUroman("ja", "안녕")).toBe(true);
    expect(needsUroman("zh", "我爱你")).toBe(false);
    expect(needsUroman("zh", "こんにちは")).toBe(true);
    expect(needsUroman("en", "123 ♪")).toBe(false); // no letters: nothing to romanize
    const plain = ["Morning light", "사랑해", "♪♪", "Привет"];
    const text = plain.join("\n");
    expect(countUnromanizedLines(plain, text, [al(0, "Morning light", 1)], "en")).toBe(2);
    expect(countUnromanizedLines(plain, text, [al(0, "Morning light", 1), al(1, "사랑해", 2), al(3, "Привет", 3)], "en")).toBe(0);
  });

  it("reads the peak from song.json", () => {
    const json = JSON.stringify({ info: JSON.stringify({ seconds: 10, peak: 1.005 }) });
    expect(peakFromSongJson(json)).toBe(1.005);
    expect(peakFromSongJson(JSON.stringify({ info: { peak: 0.8 } }))).toBe(0.8);
    expect(peakFromSongJson(JSON.stringify({ info: null }))).toBeNull();
    expect(peakFromSongJson("not json")).toBeNull();
  });
});

describe("alignment confidence (E2E align_i_en: the budget ended before the chorus was sung)", () => {
  // MCS_AlignLyrics output on the 20 s vocals of a cut-off song (real ComfyUI v0.37.0 run)
  const w = (text: string, start: number, end: number, score: number) => ({ text, start, end, score });
  const lyrics = "[Verse]\nMorning light across the window\nCity waking down below\n\n[Chorus]\nSing it loud and let it go\nHearts are shining, feel the glow";
  const aligned: AlignedLine[] = [
    { index: 1, line: "Morning light across the window", start: 9.6, end: 13.9, words: [w("Morning", 9.6, 10.62, 0.481), w("light", 10.8, 11.42, 0.248), w("across", 11.48, 12.52, 0.402), w("the", 12.54, 12.66, 0.051), w("window", 13.14, 13.9, 0.527)] },
    { index: 2, line: "City waking down below", start: 14.3, end: 18, words: [w("City", 14.3, 15.06, 0.115), w("waking", 15.48, 16.52, 0.352), w("down", 16.68, 17.1, 0.298), w("below", 17.26, 18, 0.289)] },
    { index: 5, line: "Sing it loud and let it go", start: 18.12, end: 18.54, words: [w("Sing", 18.12, 18.2, 0.006), w("it", 18.2, 18.24, 0.007), w("loud", 18.24, 18.32, 0.006), w("and", 18.32, 18.38, 0.011), w("let", 18.38, 18.44, 0.011), w("it", 18.44, 18.48, 0.015), w("go", 18.48, 18.54, 0.004)] },
    { index: 6, line: "Hearts are shining, feel the glow", start: 18.54, end: 19.98, words: [w("Hearts", 18.54, 18.72, 0.013), w("are", 18.72, 18.94, 0.014), w("shining,", 18.98, 19.5, 0.18), w("feel", 19.64, 19.84, 0.094), w("the", 19.84, 19.9, 0.007), w("glow", 19.9, 19.98, 0.012)] },
  ];

  it("keeps the sung lines and estimates the unsung ones", () => {
    const plain = plainLyricLines(lyrics);
    const lines = applyAlignment(plain, lyrics, aligned, 20000);
    expect(lines.map((l) => l.src)).toEqual(["aligned", "aligned", "interpolated", "interpolated"]);
    expect(lines[0].timeMs).toBe(9600);
    expect(countRejectedAlignments(plain, lyrics, aligned)).toBe(2);
    expect(isConfidentAlignment(aligned[0])).toBe(true);
    expect(isConfidentAlignment(aligned[2])).toBe(false);
    expect(isConfidentAlignment(aligned[3])).toBe(false);
  });

  it("accepts single-token lines with good scores and older output without word scores", () => {
    expect(isConfidentAlignment({ index: 0, line: "あさのひかり", start: 1, end: 3, words: [{ text: "asanohikari", start: 1, end: 3, score: 0.49 }] })).toBe(true);
    expect(isConfidentAlignment(al(0, "x", 1))).toBe(true);
    // 3+ words crammed into a fraction of a second
    const fast = { index: 0, line: "a b c d", start: 1, end: 1.2, words: ["a", "b", "c", "d"].map((t, i) => ({ text: t, start: 1 + i * 0.05, end: 1.05 + i * 0.05, score: 0.5 })) };
    expect(isConfidentAlignment(fast)).toBe(false);
  });

  it("allows fast Mandarin lines (one word per character) up to the syllable ceiling", () => {
    const zh = (chars: string, dur: number) => ({
      index: 0,
      line: chars,
      start: 10,
      end: 10 + dur,
      words: [...chars].map((c, i) => ({ text: c, start: 10 + (i * dur) / chars.length, end: 10 + ((i + 1) * dur) / chars.length, score: 0.4 })),
    });
    // 10 characters in 1 s: 10 syllables a second, a fast but real chorus
    expect(isConfidentAlignment(zh("我们一起走向明天的路", 1))).toBe(true);
    // crammed: 10 characters in 0.5 s
    expect(isConfidentAlignment(zh("我们一起走向明天的路", 0.5))).toBe(false);
    // a Latin word in a Chinese line comes back one letter per word and keeps the syllable ceiling:
    // 10 hanzi + "baby" (14 words) in 1.2 s is 11.7 a second
    expect(isConfidentAlignment(zh("我们一起走向明天的路baby", 1.2))).toBe(true);
    expect(isConfidentAlignment(zh("我们一起走向明天的路baby", 0.6))).toBe(false);
    // single letters alone are not a Chinese line
    expect(isConfidentAlignment(zh("abcdefghij", 1))).toBe(false);
    // words that are not single characters keep the word ceiling
    const en = { ...zh("abcdefghij", 1), words: "we walk into the light of the new day now".split(" ").map((t, i) => ({ text: t, start: 10 + i * 0.1, end: 10.1 + i * 0.1, score: 0.4 })) };
    expect(isConfidentAlignment(en)).toBe(false);
  });

  it("allows a fast chant of one-syllable words (the node splits Latin phrases per word) up to the syllable ceiling", () => {
    const line = (text: string, dur: number) => {
      const w = text.split(" ");
      return { index: 0, line: text, start: 10, end: 10 + dur, words: w.map((t, i) => ({ text: t, start: 10 + (i * dur) / w.length, end: 10 + ((i + 1) * dur) / w.length, score: 0.4 })) };
    };
    // 8 words in 0.8 s: 10 a second, sixteenth notes at 150 BPM (a Japanese song's chant, or an English one)
    expect(isConfidentAlignment(line("La la la la la la la la", 0.8))).toBe(true);
    expect(isConfidentAlignment(line("oh, oh, oh, oh, oh, oh, oh, oh", 0.8))).toBe(true);
    // crammed: 16 a second
    expect(isConfidentAlignment(line("La la la la la la la la", 0.5))).toBe(false);
    // longer words keep the word ceiling (over 9 a second)
    expect(isConfidentAlignment(line("forever together always forever together always forever together always", 0.95))).toBe(false);
    // a repeated short word is a chant too, and "yeah" is a vocable although it has 4 letters
    expect(isConfidentAlignment(line("no no no no no no no no", 0.8))).toBe(true);
    expect(isConfidentAlignment(line("Yeah, yeah, yeah", 0.3))).toBe(true);
    // ordinary lines of short words are not chants: 10 a second is over the word ceiling (a cut-off line crammed in)
    expect(isConfidentAlignment(line("let it go", 0.3))).toBe(false);
    expect(isConfidentAlignment(line("you and me all", 0.4))).toBe(false);
    expect(isConfidentAlignment(line("all for you", 0.3))).toBe(false);
    expect(isConfidentAlignment(line("let it go let it go", 0.6))).toBe(false);
    // at a singable speed they still count
    expect(isConfidentAlignment(line("let it go", 0.6))).toBe(true);
  });
});

describe("rebuildLines after taps", () => {
  it("keeps the unmatched lines as placeholders after a single tap", () => {
    const plain = ["a", "b", "c", "d", "e"];
    const tapped = setLineTime(placeholderLines(plain), 0, 1500, "tapped", 60000);
    expect(countPlaceholders(tapped)).toBe(4);
    const rebuilt = rebuildLines(plain, tapped, 60000);
    expect(countPlaceholders(rebuilt)).toBe(4);
    expect(syncDefault(rebuilt)).toBe(false);
    expect(rebuilt[0]).toEqual({ text: "a", timeMs: 1500, src: "tapped" });
  });

  it("still estimates an edited line after a full alignment", () => {
    const plain = ["a", "b", "c", "d", "e"];
    const aligned = applyAlignment(plain, plain.join("\n"), [al(0, "a", 1), al(4, "e", 9)], 20000);
    expect(countPlaceholders(aligned)).toBe(0);
    const rebuilt = rebuildLines(["a", "b", "X", "d", "e"], aligned, 20000);
    expect(rebuilt[2].src).toBe("interpolated");
    expect(countPlaceholders(rebuilt)).toBe(0);
    expect([rebuilt[0].src, rebuilt[4].src]).toEqual(["aligned", "aligned"]);
  });
});

describe("line rules shared with the alignment node", () => {
  it("plainLyricLines(t)[i] is the line at lyricsLineIndex(t, i) (tags, blank lines, CRLF)", () => {
    const text = "[Verse]\r\n  one \r\n\r\n[Chorus]\r\ntwo\r\n   \r\n three\r\n[Outro]";
    const plain = plainLyricLines(text);
    expect(plain).toEqual(["one", "two", "three"]);
    const raw = text.replace(/\r\n/g, "\n").split("\n");
    plain.forEach((t, i) => expect(raw[lyricsLineIndex(text, i)].trim()).toBe(t));
    expect(lyricsLineIndex(text, 3)).toBe(-1);
    expect(isNonLyricLine("")).toBe(true);
    expect(isNonLyricLine("[Verse 2]")).toBe(true);
    expect(isNonLyricLine("hello [x]")).toBe(false);
  });

  it("keeps blank lines (stanzas) in the tag lyrics and drops the section tags", () => {
    expect(lyricsForTags("[Verse]\r\na\r\nb\r\n\r\n[Chorus]\r\nc\r\n")).toBe("a\nb\n\nc");
  });

  it("notices lyrics edited without rebuilding the lines", () => {
    const lines = placeholderLines(["a", "b"]);
    expect(linesOutOfDate("[Verse]\na\n\nb", lines)).toBe(false);
    expect(linesOutOfDate("a\nB", lines)).toBe(true);
    expect(linesOutOfDate("a\nb\nc", lines)).toBe(true);
    expect(linesOutOfDate("", [])).toBe(false);
  });
});

describe("parseLrcTime", () => {
  it("reads m:ss(.fff) with a decimal fraction", () => {
    expect(parseLrcTime("00:12.34")).toBe(12_340);
    expect(parseLrcTime("0:5")).toBe(5000);
    expect(parseLrcTime("1:02.5")).toBe(62_500);
    expect(parseLrcTime("01:02.345")).toBe(62_345);
    expect(parseLrcTime(" 3:04,5 ")).toBe(184_500);
  });

  it("reads plain seconds and IME full-width input", () => {
    expect(parseLrcTime("75.5")).toBe(75_500);
    expect(parseLrcTime("７")).toBe(7000);
    expect(parseLrcTime("０１：２３．４５")).toBe(83_450);
  });

  it("rejects what is not a time", () => {
    for (const bad of ["00:60.00", "", "abc", "1:", ":30", "00:0400", "1:2:3", "-1", "01:23.4567"]) {
      expect(parseLrcTime(bad), bad).toBeNull();
    }
  });
});

describe("time field", () => {
  it("formats times as mm:ss.cc and reads them back", () => {
    expect(formatLrcTime(0)).toBe("00:00.00");
    expect(formatLrcTime(12_345)).toBe("00:12.35");
    expect(formatLrcTime(83_450)).toBe("01:23.45");
    expect(formatLrcTime(59_999)).toBe("01:00.00");
    expect(parseLrcTime(formatLrcTime(754_320))).toBe(754_320);
  });

  it("commits only text the user changed", () => {
    // focused and left, or the same time retyped in another form: nothing (not re-marked manual)
    expect(timeFieldCommit("00:08.00", "00:08.00")).toEqual({ kind: "none" });
    expect(timeFieldCommit("8", "00:08.00")).toEqual({ kind: "none" });
    expect(timeFieldCommit("00:12.34", "00:08.00")).toEqual({ kind: "commit", ms: 12_340 });
    expect(timeFieldCommit("00:08.0x", "00:08.00")).toEqual({ kind: "invalid" });
  });

  it("an untouched draft follows a time changed from outside, typed text is kept", () => {
    // automatic timing finished while the field was focused: leaving it keeps the aligned time
    const shown = "00:08.00";
    const next = "00:12.34";
    const draft = followTimeDraft(shown, shown, next);
    expect(draft).toBe(next);
    expect(timeFieldCommit(draft!, next)).toEqual({ kind: "none" });
    // the user had typed a time: it stays and is committed on leaving the field
    const typed = followTimeDraft("00:09.50", shown, next);
    expect(typed).toBe("00:09.50");
    expect(timeFieldCommit(typed!, next)).toEqual({ kind: "commit", ms: 9500 });
    expect(followTimeDraft(null, shown, next)).toBeNull();
  });
});

describe("clampLineIndex", () => {
  it("keeps the tap position on an existing line", () => {
    expect(clampLineIndex(26, 10)).toBe(9);
    expect(clampLineIndex(3, 10)).toBe(3);
    expect(clampLineIndex(-1, 10)).toBe(0);
    expect(clampLineIndex(5, 0)).toBe(0);
    expect(clampLineIndex(Number.NaN, 4)).toBe(0);
  });
});
