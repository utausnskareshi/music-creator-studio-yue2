import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import kuromoji, { type IpadicFeatures, type Tokenizer } from "kuromoji";
import {
  alignReading,
  alignmentText,
  detectLanguage,
  hasKanji,
  hiraganaText,
  isSungStale,
  katakanaToHiragana,
  leftoverKanji,
  mergeReconvert,
  particleSound,
  reconvertKeepingFixes,
  sameLyricsText,
  splitLines,
  sungHasHandEdits,
  sungMismatchLines,
  tokenReading,
  type ReadingToken,
} from "../hiragana";

describe("hiragana version staleness", () => {
  const kanji = "[Verse]\n朝の光が窓を照らして\n街が静かに目を覚ます";
  const kana = "[Verse]\nあさのひかりがまどをてらして\nまちがしずかにめをさます";

  it("is not stale right after conversion or after a reuse (source = the kanji text)", () => {
    expect(isSungStale(kanji, kana, kanji)).toBe(false);
    expect(isSungStale(kanji.replace(/\n/g, "\r\n") + "\n", kana, kanji)).toBe(false);
  });

  it("is not stale after reading fixes in the hiragana pane", () => {
    // は/わ style fixes break the kana skeleton, but the kanji text did not change
    expect(isSungStale(kanji, kana.replace("まちが", "まちわ"), kanji)).toBe(false);
  });

  it("is stale when the kanji text changed after conversion", () => {
    expect(isSungStale(kanji.replace("街", "空"), kana, kanji)).toBe(true);
  });

  it("falls back to the furigana check when the source is unknown", () => {
    expect(isSungStale(kanji, kana, null)).toBe(false);
    expect(isSungStale(kanji + "\n新しい行", kana, null)).toBe(true);
    expect(isSungStale(kanji, null, null)).toBe(false);
    expect(isSungStale(kanji, "  ", kanji.replace("街", "空"))).toBe(false);
  });

  it("counts lines that no longer line up", () => {
    expect(sungMismatchLines(kanji, kana)).toBe(0);
    expect(sungMismatchLines(kanji, kana.replace("てらして", "てらす"))).toBe(1);
    expect(sungMismatchLines(kanji + "\n", kana)).toBe(2); // line counts differ: every kanji line
    expect(sameLyricsText("a  \r\nb\n", "a\nb")).toBe(true);
  });
});

describe("alignment text (particles は/へ taken from the kanji line)", () => {
  // the real IPADIC dictionary of the kuromoji package (the same data the app ships in public/kuromoji/dict)
  let tokenize: (line: string) => ReadingToken[] = () => [];
  beforeAll(async () => {
    const dicPath = fileURLToPath(new URL("../../../node_modules/kuromoji/dict/", import.meta.url));
    const tokenizer = await new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) =>
      kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t))),
    );
    tokenize = (line) => tokenizer.tokenize(line);
  }, 60_000);
  const kanji = "[Verse]\n私は東京へ行く\n君は平気な顔\n母の手\n葉が落ちる\n\n[Chorus]\n走り出そう 光の中へ\nここでは言えない";

  it("reads the kanji lyrics as hiragana with the particles as sung", () => {
    // readings are IPADIC's (走り出そう -> はしりでそう is the dictionary's own reading; the romanizer read 君 as kun)
    expect(alignmentText(kanji, kanji, tokenize)).toBe(
      "[Verse]\nわたしわとうきょうえいく\nきみわへいきなかお\nははのて\nはがおちる\n\n[Chorus]\nはしりでそう ひかりのなかえ\nここでわいえない",
    );
  });

  it("reads common lyric kanji and keeps tags, blank lines and Latin text", () => {
    expect(alignmentText("私は君を愛してる", "私は君を愛してる", tokenize)).toBe("わたしわきみをあいしてる");
    // noun suffixes (僕ら, 君たち) belong to the word before them
    expect(alignmentText("僕らは君たちへ", "僕らは君たちへ", tokenize)).toBe("ぼくらわきみたちえ");
    const k = "[Chorus]\n\nLove 君\n今日も明日も";
    expect(alignmentText(k, k, tokenize)).toBe("[Chorus]\n\nLove きみ\nきょうもあしたも");
  });

  it("never reads hiragana words starting with は/へ as particles (hiragana version)", () => {
    // へいき (平気), はは (母), は (葉) stay; only the particles found in the kanji lines change
    const sung = "[Verse]\nわたしはとうきょうへいく\nきみはへいきなかお\nははのて\nはがおちる\n\n[Chorus]\nはしりでそう ひかりのなかへ\nここではいえない";
    expect(alignmentText(sung, kanji, tokenize)).toBe(
      "[Verse]\nわたしわとうきょうえいく\nきみわへいきなかお\nははのて\nはがおちる\n\n[Chorus]\nはしりでそう ひかりのなかえ\nここでわいえない",
    );
  });

  it("keeps hand-fixed readings and maps the particles before and after them", () => {
    // 走り出 fixed by hand (はしりで -> はしりだ): the particle after the fix is still found
    expect(alignmentText("はしりだそう ひかりのなかへ", "走り出そう 光の中へ", tokenize)).toBe("はしりだそう ひかりのなかえ");
    // 私 read as あたし: the particle right after the changed stretch is in the matching suffix
    expect(alignmentText("あたしはとうきょうへいく", "私は東京へ行く", tokenize)).toBe("あたしわとうきょうえいく");
    // particle already fixed by hand
    expect(alignmentText("わたしわとうきょうへいく", "私は東京へ行く", tokenize)).toBe("わたしわとうきょうえいく");
  });

  it("reads particles after dictionary words in hiragana-only lines, not after guessed fragments", () => {
    const same = (line: string) => alignmentText(line, line, tokenize);
    // pronouns, nouns, interjections and verb stems the dictionary knows (2+ characters) fix the boundary
    expect(same("あなたは")).toBe("あなたわ");
    expect(same("きみは")).toBe("きみわ");
    expect(same("ぼくはうたう")).toBe("ぼくわうたう");
    expect(same("ここでは")).toBe("ここでわ");
    expect(same("そらへ")).toBe("そらえ");
    expect(same("うたっては")).toBe("うたってわ");
    // へ inside へいき follows the particle は, so it stays
    expect(same("きみはへいきなかお")).toBe("きみわへいきなかお");
    // noun suffixes belong to the word before them
    expect(same("ぼくらは")).toBe("ぼくらわ");
    expect(same("わたしたちは")).toBe("わたしたちわ");
    // greetings, laughter (は/は/は), one-character fragments (あ/さ/は, み/て/は) and auxiliaries (なみ/だ/は) stay
    for (const line of ["こんにちは", "はは", "ははは", "わはは", "ははのて", "あさは", "みては", "なみだはながれる"]) expect(same(line)).toBe(line);
  });

  it("pairs lyric lines by index and keeps the line structure of the aligned text", () => {
    expect(alignmentText("[Verse]\nきみはへいきなかお\n[Chorus]\nははのて", "[Verse]\n君は平気な顔\n\n[Chorus]\n母の手", tokenize)).toBe(
      "[Verse]\nきみわへいきなかお\n[Chorus]\nははのて",
    );
  });

  it("writes the same pieces for the hiragana version and the alignment text (only は/へ become わ/え)", () => {
    const conv = hiraganaText(kanji, tokenize);
    const aligned = alignmentText(kanji, kanji, tokenize);
    expect(splitLines(conv)).toHaveLength(splitLines(kanji).length);
    expect(conv.length).toBe(aligned.length);
    for (let i = 0; i < conv.length; i++) {
      if (conv[i] !== aligned[i]) expect(`${conv[i]}${aligned[i]}`).toMatch(/^(はわ|へえ)$/);
    }
    expect(conv).toContain("わたしはとうきょうへいく");
  });

  it("leaves kanji the dictionary cannot read in the hiragana version", () => {
    const conv = hiraganaText("[Verse]\n燦めく星\n𠮟られた夜", tokenize);
    expect(conv.startsWith("[Verse]\n")).toBe(true);
    expect(leftoverKanji(conv)).toEqual(["燦", "𠮟"]);
  });
});

describe("tokenReading", () => {
  it("prefers the reading, falls back to the pronunciation and treats * as missing", () => {
    expect(tokenReading({ surface_form: "君", reading: "キミ" })).toBe("きみ");
    expect(tokenReading({ surface_form: "君", reading: "*", pronunciation: "キミ" })).toBe("きみ");
    expect(tokenReading({ surface_form: "燦", reading: "*", pronunciation: "*" })).toBeNull();
    expect(tokenReading({ surface_form: "燦" })).toBeNull();
  });
});

describe("kanji outside the basic plane", () => {
  it("counts supplementary-plane kanji as kanji", () => {
    expect(hasKanji("𠮟")).toBe(true);
    expect(hasKanji("𩸽")).toBe(true);
    expect(hasKanji("ひらがな カタカナ abc")).toBe(false);
    expect(detectLanguage("𠮟")).toBe("zh");
  });

  it("lists the kanji left in the hiragana version once each, skipping tags", () => {
    expect(leftoverKanji("[Verse 燦]\n燦めくほし\n𠮟られた 燦\n\nあさ")).toEqual(["燦", "𠮟"]);
    expect(leftoverKanji("[Chorus]\nあさのひかり")).toEqual([]);
  });
});

describe("mergeReconvert (re-conversion keeps reading fixes of unchanged lines)", () => {
  const source = "[Verse]\n私は歌う\n明日の空\n君の声";
  const sung = "[Verse]\nあたしはうたう\nあすのそら\nきみのこえ"; // 私 -> あたし, 明日 -> あす fixed by hand
  const conv = (s: string) =>
    s.replace("私", "わたし").replace("歌", "うた").replace("明日", "あした").replace("空", "そら").replace("君", "きみ").replace("声", "こえ").replace("夢", "ゆめ").replace("星", "ほし");

  it("keeps the fix of an unchanged line and reconverts an edited one", () => {
    const value = "[Verse]\n私は歌う\n明日の星\n君の声";
    const r = mergeReconvert(value, source, sung, conv(value));
    expect(r).toEqual({ text: "[Verse]\nあたしはうたう\nあしたのほし\nきみのこえ", kept: 1 });
  });

  it("keeps later fixes when a line is inserted or removed", () => {
    const inserted = "[Verse]\n夢の中\n私は歌う\n明日の空\n君の声";
    expect(mergeReconvert(inserted, source, sung, conv(inserted))?.text).toBe("[Verse]\nゆめの中\nあたしはうたう\nあすのそら\nきみのこえ");
    const removed = "[Verse]\n明日の空\n君の声";
    expect(mergeReconvert(removed, source, sung, conv(removed))).toEqual({ text: "[Verse]\nあすのそら\nきみのこえ", kept: 1 });
  });

  it("ignores trailing whitespace and line endings when pairing lines", () => {
    const value = "[Verse]\r\n私は歌う  \r\n明日の空\r\n君の声";
    expect(mergeReconvert(value, source, sung, conv(value).replace(/\r/g, ""))?.kept).toBe(2);
  });

  it("ignores trailing blank lines when counting lines", () => {
    // a stored song whose hiragana version lost (or gained) the final newline
    expect(mergeReconvert(source + "\n", source, sung, conv(source) + "\n")).toEqual({ text: sung + "\n", kept: 2 });
    expect(mergeReconvert(source, source + "\n\n", sung, conv(source))).toEqual({ text: sung, kept: 2 });
    expect(mergeReconvert(source, source, sung + "\n  \n", conv(source))?.text).toBe(sung);
  });

  it("gives up when the hiragana pane no longer has one line per kanji line", () => {
    expect(mergeReconvert(source, source, sung + "\nおまけ", conv(source))).toBeNull();
  });

  it("reconvertKeepingFixes: an AI edit keeps the fixes of the lines it left alone", () => {
    const value = "[Verse]\n私は歌う\n明日の星\n君の声";
    expect(reconvertKeepingFixes(value, source, sung, conv(value))).toEqual({ text: "[Verse]\nあたしはうたう\nあしたのほし\nきみのこえ", kept: 1, merged: true });
    // nothing to pair with: the fresh conversion as it is
    expect(reconvertKeepingFixes(value, null, sung, conv(value))).toEqual({ text: conv(value), kept: 0, merged: false });
    expect(reconvertKeepingFixes(value, source, null, conv(value))).toEqual({ text: conv(value), kept: 0, merged: false });
    expect(reconvertKeepingFixes(value, source, "  \n", conv(value))).toEqual({ text: conv(value), kept: 0, merged: false });
    expect(reconvertKeepingFixes(value, source, sung + "\nおまけ", conv(value))).toEqual({ text: conv(value), kept: 0, merged: false });
  });

  it("detects hand edits against the dictionary conversion", () => {
    expect(sungHasHandEdits(sung, conv(source))).toBe(true);
    expect(sungHasHandEdits(conv(source) + "\n", conv(source))).toBe(false);
    expect(sungHasHandEdits("  ", conv(source))).toBe(false);
    expect(sungHasHandEdits(null, conv(source))).toBe(false);
  });
});

describe("particleSound", () => {
  const tok = (surface_form: string, pos: string, word_type?: string, pos_detail_1?: string): ReadingToken => ({ surface_form, pos, word_type, pos_detail_1 });
  const wa = tok("は", "助詞", "KNOWN", "係助詞");
  it("needs a kanji/katakana/Latin anchor or a dictionary word before the particle", () => {
    expect(particleSound([tok("君", "名詞"), wa], 1)).toBe("わ");
    expect(particleSound([tok("東京", "名詞"), tok("へ", "助詞")], 1)).toBe("え");
    expect(particleSound([tok("東京", "名詞"), tok("で", "助詞"), wa], 2)).toBe("わ");
    expect(particleSound([tok("love", "名詞"), wa], 1)).toBe("わ");
    expect(particleSound([tok("きみ", "名詞", "KNOWN"), wa], 1)).toBe("わ");
    expect(particleSound([tok("きみ", "名詞", "KNOWN"), tok("へ", "助詞", "KNOWN")], 1)).toBe("え");
    expect(particleSound([tok("うたっ", "動詞", "KNOWN"), tok("て", "助詞", "KNOWN"), wa], 2)).toBe("わ");
    // hiragana words need the dictionary: guessed, one-character, particle, auxiliary and symbol tokens do not count
    expect(particleSound([tok("きみ", "名詞"), wa], 1)).toBeNull();
    expect(particleSound([tok("きみ", "名詞", "UNKNOWN"), wa], 1)).toBeNull();
    expect(particleSound([tok("み", "動詞", "KNOWN"), wa], 1)).toBeNull();
    expect(particleSound([tok("なみ", "名詞", "KNOWN"), tok("だ", "助動詞", "KNOWN"), wa], 2)).toBeNull();
    expect(particleSound([tok("♪♪", "記号", "KNOWN"), wa], 1)).toBeNull();
    expect(particleSound([tok("君", "名詞"), wa, tok("へ", "助詞")], 2)).toBeNull();
    expect(particleSound([wa], 0)).toBeNull();
    expect(particleSound([tok("葉", "名詞")], 0)).toBeNull();
  });
  it("looks through noun suffixes", () => {
    const ra = tok("ら", "名詞", "KNOWN", "接尾");
    expect(particleSound([tok("僕", "名詞"), ra, wa], 2)).toBe("わ");
    expect(particleSound([tok("ぼく", "名詞", "KNOWN"), ra, tok("に", "助詞"), wa], 3)).toBe("わ");
    expect(particleSound([tok("あ", "フィラー", "KNOWN"), tok("さ", "名詞", "KNOWN", "接尾"), wa], 2)).toBeNull();
    expect(particleSound([ra, wa], 1)).toBeNull();
  });
});

describe("alignReading (furigana on kanji runs only)", () => {
  it("keeps okurigana plain", () => {
    expect(alignReading("照らして", "てらして")).toEqual([{ text: "照", ruby: "て" }, { text: "らして" }]);
    expect(alignReading("聞こえる", "きこえる")).toEqual([{ text: "聞", ruby: "き" }, { text: "こえる" }]);
    expect(alignReading("呼ん", "よん")).toEqual([{ text: "呼", ruby: "よ" }, { text: "ん" }]);
  });

  it("splits a whole line using kana anchors", () => {
    expect(alignReading("朝の光が窓を照らして", "あさのひかりがまどをてらして")).toEqual([
      { text: "朝", ruby: "あさ" },
      { text: "の" },
      { text: "光", ruby: "ひかり" },
      { text: "が" },
      { text: "窓", ruby: "まど" },
      { text: "を" },
      { text: "照", ruby: "て" },
      { text: "らして" },
    ]);
    expect(alignReading("走り出そう 光の中へ", "はしりだそう ひかりのなかへ")).toEqual([
      { text: "走", ruby: "はし" },
      { text: "り" },
      { text: "出", ruby: "だ" },
      { text: "そう " },
      { text: "光", ruby: "ひかり" },
      { text: "の" },
      { text: "中", ruby: "なか" },
      { text: "へ" },
    ]);
  });

  it("tolerates whitespace and katakana differences", () => {
    expect(alignReading("走り出そう 光の中へ", "はしりだそうひかりのなかへ")).not.toBeNull();
    expect(alignReading("キラキラ光る", "きらきらひかる")).toEqual([{ text: "キラキラ" }, { text: "光", ruby: "ひか" }, { text: "る" }]);
  });

  it("returns null when the reading does not fit the kana skeleton, and plain text without kanji", () => {
    expect(alignReading("照らして", "てらす")).toBeNull();
    expect(alignReading("ひらがなだけ", "ひらがなだけ")).toEqual([{ text: "ひらがなだけ" }]);
  });

  it("marks a kanji run whose reading is still kanji as unread", () => {
    expect(alignReading("燦めく星", "燦めくほし")).toEqual([{ text: "燦", unread: true }, { text: "めく" }, { text: "星", ruby: "ほし" }]);
    expect(alignReading("𠮟られた", "𠮟られた")).toEqual([{ text: "𠮟", unread: true }, { text: "られた" }]);
  });

  it("stays fast on a long line that does not fit (no backtracking blow-up)", () => {
    const t0 = Date.now();
    expect(alignReading("命の".repeat(16) + "夢を見た", "いのちの".repeat(16) + "ゆめをみる")).toBeNull();
    expect(alignReading("君の命の昨日の".repeat(7), "きみのいのちのきのうの".repeat(7) + "x")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    // the same line that fits still aligns
    expect(alignReading("命の".repeat(16) + "夢を見た", "いのちの".repeat(16) + "ゆめをみた")).not.toBeNull();
  });
});

describe("helpers", () => {
  it("converts katakana to hiragana", () => {
    expect(katakanaToHiragana("テラシテー")).toBe("てらしてー");
  });
  it("detects languages", () => {
    expect(detectLanguage("[Verse]\n朝の光が")).toBe("ja");
    expect(detectLanguage("Morning light")).toBe("en");
    expect(detectLanguage("早晨的光")).toBe("zh");
  });
});
