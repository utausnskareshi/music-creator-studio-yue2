import { describe, expect, it } from "vitest";
import { BPM_RE, BPM_TOKEN, styleBpm, styleBpmDiffers, withStyleBpm } from "../styleBpm";
import { styleTempoSync } from "../../compose/rules";

describe("style tempo", () => {
  it("reads the first NN BPM", () => {
    expect(styleBpm("Japanese, J-pop, hopeful, 120 BPM")).toBe(120);
    expect(styleBpm("relaxed 88bpm groove")).toBe(88);
    expect(styleBpm("warm piano pop")).toBeNull();
    // a whole number, never the tail of a longer one
    expect(styleBpm("1120 BPM")).toBe(1120);
    expect(styleBpm("v120 BPM")).toBeNull();
  });

  it("reads the tempo written after BPM and in full-width characters, and replaces it in place", () => {
    for (const s of [
      "Japanese, rock, BPM 140",
      "Japanese, rock, BPM:140",
      "Japanese, rock, BPM140",
      "Japanese, rock, bpm=140",
      "Japanese, rock, BPM：140",
      "Japanese, rock, １４０ BPM",
      "Japanese, rock, 140ＢＰＭ",
      "Japanese, rock, ＢＰＭ １４０",
      "Japanese, rock, １４０ｂｐｍ",
      // the full-width equals sign and a dash a full-width IME types, and a hyphenated "140-BPM"
      "Japanese, rock, BPM＝140",
      "Japanese, rock, ＢＰＭ＝１４０",
      "Japanese, rock, BPM-140",
      "Japanese, rock, BPM – 140",
      "Japanese, rock, 140-BPM",
      "Japanese, rock, １４０－ＢＰＭ",
      // BPM spelled out
      "Japanese, rock, 140 beats per minute",
      "Japanese, rock, 140 Beats Per Minute",
      "Japanese, rock, beats per minute: 140",
    ]) {
      expect(styleBpm(s), s).toBe(140);
      expect(withStyleBpm(s, 100), s).toBe("Japanese, rock, 100 BPM");
      expect(styleBpmDiffers(s, 140), s).toBe(false);
      // the score's tempo replaces the style's instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 100)?.style, s).toBe("Japanese, rock, 100 BPM");
      expect(styleTempoSync(s, 140), s).toBeNull();
    }
    expect(styleBpm("ballad, BPM 60-70, piano")).toBe(65);
    expect(withStyleBpm("ballad, BPM 60〜70, piano", 64)).toBe("ballad, 64 BPM, piano");
    expect(styleBpm("ballad, ６０－７０ BPM")).toBe(65);
    expect(styleBpm("high BPM energy")).toBeNull();
    expect(styleBpm("120 BPMs of fun")).toBeNull();
    expect(styleBpm("120 beats per bar")).toBeNull();
    expect(styleBpm("120 beats per minutes")).toBeNull();
    // a hyphen joins a tempo of two digits or more to BPM, not a label digit
    expect(styleBpm("a 2-BPM drop")).toBeNull();
    expect(styleBpm("Vol.2-BPM 120")).toBe(120);
    expect(withStyleBpm("Vol.2-BPM 120", 88)).toBe("Vol.2-88 BPM");
    // nor the end of a label of more digits ("Vol.12", "TR-808"); the high end of a range does join
    expect(styleBpm("Vol.12-BPM 120")).toBe(120);
    expect(withStyleBpm("Vol.12-BPM 120", 88)).toBe("Vol.12-88 BPM");
    expect(styleBpm("trap, TR-808-BPM")).toBeNull();
    expect(styleTempoSync("trap, TR-808-BPM", 88)?.style).toBe("trap, TR-808-BPM, 88 BPM");
    expect(styleBpm("ballad, 60-70-BPM")).toBe(65);
    expect(withStyleBpm("ballad, 60-70-BPM", 64)).toBe("ballad, 64 BPM");
  });

  it("reads back every tempo it writes, so a score's tempo is synced once (Q:1/4=8, Q:1/4=1200)", () => {
    for (const b of [1, 8, 9, 10, 300, 999, 1000, 1200, 12000]) {
      const once = styleTempoSync("pop, 120 BPM", b);
      expect(once?.style, String(b)).toBe(`pop, ${b} BPM`);
      expect(styleBpm(once!.style), String(b)).toBe(b);
      expect(styleTempoSync(once!.style, b), String(b)).toBeNull();
      expect(styleTempoSync("pop", b)?.style, String(b)).toBe(`pop, ${b} BPM`);
      expect(styleTempoSync(`pop, ${b} BPM`, b), String(b)).toBeNull();
    }
    // a decimal tempo is one number ("5 BPM" is not read out of "96.5 BPM")
    expect(styleBpm("pop, 96.5 BPM")).toBe(97);
    expect(withStyleBpm("pop, 96.5 BPM", 90)).toBe("pop, 90 BPM");
    // "0 BPM" is no tempo (a score without Q: never takes it), but the sync still replaces it in place
    expect(styleBpm("pop, 0 BPM")).toBeNull();
    expect(styleTempoSync("pop, 0 BPM", 96)?.style).toBe("pop, 96 BPM");
  });

  it("does not sync to a tempo it could not write back as a whole number (Q: far below 1 or beyond safe integers)", () => {
    // "0 BPM" is read as no tempo, and 1e21 would be written "1e+21 BPM": the sync would repeat on every send
    for (const b of [0.4, 0.25, 1e21, 2 ** 53]) {
      expect(styleBpmDiffers("pop, 120 BPM", b), String(b)).toBe(false);
      expect(styleTempoSync("pop, 120 BPM", b), String(b)).toBeNull();
      expect(styleTempoSync("pop", b), String(b)).toBeNull();
    }
    // the largest whole number it writes in digits is still read back
    const max = Number.MAX_SAFE_INTEGER;
    expect(styleTempoSync("pop, 120 BPM", max)?.style).toBe(`pop, ${max} BPM`);
    expect(styleTempoSync(`pop, ${max} BPM`, max)).toBeNull();
  });

  it("reads no tempo out of a decade, a meter or a label number next to BPM", () => {
    for (const s of [
      "Japanese, energetic high-BPM 90s eurobeat, female vocal",
      "high-BPM 2000s trance",
      "low BPM 2step garage",
      "low BPM 2 step garage",
      "slow BPM 12/8 shuffle",
      "fast BPM 96.5x",
      // a decade written with 年, and a number joined to a word by a dash
      "高BPM 90年代",
      "ロック BPM 90年代",
      "slow BPM 12-string guitar",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      // the score's tempo is added once, the words stay as they are
      expect(styleTempoSync(s, 140)?.style, s).toBe(`${s}, 140 BPM`);
      expect(styleTempoSync(`${s}, 140 BPM`, 140), s).toBeNull();
    }
    // a meter or a label digit before a dash is not the low end of a range
    expect(styleBpm("4/4 - 120 BPM")).toBe(120);
    expect(withStyleBpm("4/4 - 120 BPM", 96)).toBe("4/4 - 96 BPM");
    expect(styleBpm("Track 1 – 120 BPM")).toBe(120);
    expect(styleBpm("12/16 - 120 BPM")).toBe(120);
    // the number after a slash belongs to the meter: never read or rewritten as a tempo
    expect(styleBpm("shuffle, 12/8 BPM")).toBeNull();
    expect(styleTempoSync("shuffle, 12/8 BPM", 96)?.style).toBe("shuffle, 12/8 BPM, 96 BPM");
    expect(styleBpm("rock, 4/4-BPM 120")).toBe(120);
    expect(withStyleBpm("rock, 4/4-BPM 120", 96)).toBe("rock, 4/4-96 BPM");
    expect(styleBpm("shuffle, １２／８ BPM")).toBeNull();
    expect(styleBpm("rock, BPM 120/140")).toBeNull();
    // a decade after a reversed tempo is not the high end of a range
    expect(styleBpm("rock, BPM 120 - 80s style")).toBe(120);
    expect(withStyleBpm("rock, BPM 120 - 80s style", 128)).toBe("rock, 128 BPM - 80s style");
    expect(styleBpm("ballad, BPM 60 - 70, piano")).toBe(65);
    // a single tempo before BPM keeps any length
    expect(styleBpm("pop, 1200 BPM")).toBe(1200);
  });

  it("reads the tempo of a tag after or before a slash (ロック/120BPM): only a slash next to a number marks a meter", () => {
    for (const [s, synced] of [
      ["ロック/120BPM", "ロック/88 BPM"],
      ["J-POP/女性ボーカル/120BPM", "J-POP/女性ボーカル/88 BPM"],
      ["Rock/120 BPM", "Rock/88 BPM"],
      ["pop／120BPM", "pop／88 BPM"],
      ["ロック/１２０ＢＰＭ/女性ボーカル", "ロック/88 BPM/女性ボーカル"],
      ["ロック/BPM120", "ロック/88 BPM"],
      ["ロック/BPM120/女性ボーカル", "ロック/88 BPM/女性ボーカル"],
      ["rock, BPM 120/ballad", "rock, 88 BPM/ballad"],
      ["city pop/60-70 BPM", "city pop/88 BPM"],
    ]) {
      expect(styleBpm(s), s).toBe(s.includes("60-70") ? 65 : 120);
      // the score's tempo replaces it instead of being added as a second one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
  });

  it("reads BPM NN that starts a new line (a line break starts an item, as a comma does)", () => {
    for (const [s, synced] of [
      ["Japanese, J-pop, female vocal\nBPM 140", "Japanese, J-pop, female vocal\n88 BPM"],
      ["rock\r\nBPM 140", "rock\r\n88 BPM"],
      ["rock \n ＢＰＭ＝１４０", "rock \n 88 BPM"],
    ]) {
      expect(styleBpm(s), s).toBe(140);
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(s, 140), s).toBeNull();
    }
    // a Latin word dashed to BPM on that line still makes it a modifier, and 808 is no tempo
    expect(styleBpm("rock\nslow-BPM 140")).toBeNull();
    expect(styleBpm("rock\nmedium BPM 808 drums")).toBeNull();
  });

  it("reads BPM NN after a word and spaces: a tag of a space-separated list, also with a colon (J-POP 女性ボーカル BPM120)", () => {
    for (const [s, bpm, synced] of [
      ["J-POP 女性ボーカル BPM120", 120, "J-POP 女性ボーカル 88 BPM"],
      ["J-POP　女性ボーカル　BPM120", 120, "J-POP　女性ボーカル　88 BPM"],
      ["ロック　ＢＰＭ１４０", 140, "ロック　88 BPM"],
      ["ロック BPM:140", 140, "ロック 88 BPM"],
      ["rock bpm: 140", 140, "rock 88 BPM"],
      ["テンポは BPM120", 120, "テンポは 88 BPM"],
      ["速いテンポ BPM120", 120, "速いテンポ 88 BPM"],
      ["Japanese rock BPM 140", 140, "Japanese rock 88 BPM"],
      ["upbeat pop BPM 128", 128, "upbeat pop 88 BPM"],
      ["ballad, 80s BPM 70", 70, "ballad, 80s 88 BPM"],
      ["rock\nｈｉｇｈ　ＢＰＭ １４０", 140, "rock\nｈｉｇｈ　88 BPM"],
      // a word and spaces before BPM make no modifier: a number of 10-299 after it is the tempo
      ["Japanese, trap, medium BPM 120 drums", 120, "Japanese, trap, medium 88 BPM drums"],
      ["high BPM 170", 170, "high 88 BPM"],
      ["slow BPM 140 feel", 140, "slow 88 BPM feel"],
      ["ｓｌｏｗ ＢＰＭ １４０", 140, "ｓｌｏｗ 88 BPM"],
      ["uptempo BPM 120", 120, "uptempo 88 BPM"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      // the score's tempo replaces it instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
  });

  it("reads BPM NN after a Japanese word attached to BPM: Japanese puts no spaces between words (テンポはBPM120)", () => {
    for (const [s, bpm, synced] of [
      ["テンポはBPM120", 120, "テンポは88 BPM"],
      ["女性ボーカルBPM120", 120, "女性ボーカル88 BPM"],
      ["J-POP、女性ボーカルBPM128", 128, "J-POP、女性ボーカル88 BPM"],
      ["ロックBPM120", 120, "ロック88 BPM"],
      ["速めのBPM140", 140, "速めの88 BPM"],
      ["ゆったりBPM70", 70, "ゆったり88 BPM"],
      ["テンポ速めBPM 120", 120, "テンポ速め88 BPM"],
      ["低めのBPM 120", 120, "低めの88 BPM"],
      ["高BPM 140", 140, "高88 BPM"],
      ["80年代BPM120", 120, "80年代88 BPM"],
      ["ロック、ＢＰＭ１４０", 140, "ロック、88 BPM"],
      ["rock\n高BPM 140", 140, "rock\n高88 BPM"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      // the score's tempo replaces it instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
  });

  it("reads no tempo out of a meter, a decimal or a decade right after a BPM that starts its item", () => {
    // no word before BPM: the guard after the number is what keeps these out
    for (const s of ["rock, BPM 12/8 shuffle", "rock, BPM 12／8 shuffle", "rock, BPM 96.5x", "rock, BPM 90s", "rock, BPM 90年代", "rock, BPM 12-string"]) {
      expect(styleBpm(s), s).toBeNull();
      expect(styleTempoSync(s, 140)?.style, s).toBe(`${s}, 140 BPM`);
      expect(styleTempoSync(`${s}, 140 BPM`, 140), s).toBeNull();
    }
  });

  it("prefers NN BPM anywhere over BPM NN, and reads no tempo after BPM used as a modifier (low-BPM 808)", () => {
    const s = "Japanese, dark trap, low-BPM 808 bass, 70 BPM";
    expect(styleBpm(s)).toBe(70);
    expect(withStyleBpm(s, 96)).toBe("Japanese, dark trap, low-BPM 808 bass, 96 BPM");
    expect(styleTempoSync(s, 70)).toBeNull();
    expect(styleTempoSync(s, 96)?.style).toBe("Japanese, dark trap, low-BPM 808 bass, 96 BPM");
    // the slider looks for the tempo item by item: the "808" item holds none
    expect(BPM_RE.test("low-BPM 808 bass")).toBe(false);
    for (const t of ["Japanese, trap, high BPM 808 drums", "trap, High-BPM 808 cowbell", "slow-BPM 140 feel"]) {
      expect(styleBpm(t), t).toBeNull();
      expect(styleTempoSync(t, 70)?.style, t).toBe(`${t}, 70 BPM`);
    }
    // BPM starting its item: read when the style states no NN BPM
    expect(styleBpm("trap, BPM 808, 70 BPM")).toBe(70);
    expect(withStyleBpm("trap, BPM 808, 70 BPM", 96)).toBe("trap, BPM 808, 96 BPM");
    expect(styleBpm("rock, BPM 140, 4/4 - 120 BPM")).toBe(120);
    expect(styleBpm("slow, BPM 70")).toBe(70);
    expect(styleBpm("Tempo: BPM 96")).toBe(96);
    expect(styleBpm("piano （BPM 96）")).toBe(96);
    expect(styleBpm("ロック、ＢＰＭ１４０")).toBe(140);
    // a number before a dash is no word that makes BPM a modifier, nor a word before a spaced dash (a separator)
    expect(styleBpm("4/4 - BPM 120")).toBe(120);
    expect(styleBpm("Track 1 – BPM 120")).toBe(120);
    for (const t of ["rock - BPM 120", "rock — BPM 120", "ロック － BPM 120"]) {
      expect(styleBpm(t), t).toBe(120);
      expect(withStyleBpm(t, 88), t).toBe(t.replace("BPM 120", "88 BPM"));
    }
    // "tempo" / "テンポ" labels the tempo after it
    for (const t of ["Tempo BPM 120", "rock, tempo BPM 120", "テンポ BPM 120", "ロック、テンポBPM120", "ロック、テンポ ＢＰＭ １２０"]) {
      expect(styleBpm(t), t).toBe(120);
      expect(styleTempoSync(t, 88)?.style, t).toBe(t.replace(/(?:BPM 120|BPM120|ＢＰＭ １２０)$/, "88 BPM"));
    }
    // a Latin word attached or dashed to BPM makes it a modifier ("uptempo" and "tempos" are such words, not the label)
    for (const t of ["uptempoBPM 120", "ｕｐｔｅｍｐｏＢＰＭ １２０", "tempos-BPM 120"]) expect(styleBpm(t), t).toBeNull();
    // the label dashed to BPM, also in full-width letters
    for (const t of ["tempo-BPM 120", "Ｔｅｍｐｏ－ＢＰＭ １２０"]) {
      expect(styleBpm(t), t).toBe(120);
      expect(withStyleBpm(t, 88), t).toBe(t.replace(/(?:BPM 120|ＢＰＭ １２０)$/, "88 BPM"));
    }
    // a decimal tempo after BPM is one number, replaced whole
    expect(styleBpm("rock, BPM 96.5")).toBe(97);
    expect(withStyleBpm("rock, BPM 96.5", 90)).toBe("rock, 90 BPM");
  });

  it("reads BPM NN only as a tempo of 10-299 and not after a Latin word dashed to BPM (medium BPM 808, low-BPM 120)", () => {
    for (const s of [
      "Japanese, trap, medium BPM 808 drums",
      "moderate-BPM 808 bass",
      "steady BPM 808 groove",
      "low–BPM 808",
      "low－BPM 808",
      "高BPM 808ベース",
      "低めのBPM 808",
      "ｈｉｇｈ ＢＰＭ ８０８",
      "ｈｉｇｈ　ＢＰＭ ８０８",
      // a Latin word dashed to BPM makes it a modifier whatever the number
      "Japanese, trap, low-BPM 120 bass",
      "ｓｌｏｗ－ＢＰＭ １４０",
      // BPM starting its item, but no tempo after it
      "trap, BPM 808",
      "trap, BPM 909 cowbell",
      "trap, ＢＰＭ ８０８",
      "trap, BPM 300",
      // nor a range with an end out of 10-299 (not read in part: "88 BPM-300")
      "rock, BPM 100-300",
      "rock, BPM 60～1000",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      // the score's tempo is added once and the number stays as the user wrote it
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
      expect(styleTempoSync(`${s}, 88 BPM`, 88), s).toBeNull();
    }
    expect(styleBpm("trap, BPM 10")).toBe(10);
    expect(styleBpm("trap, BPM 299")).toBe(299);
    expect(styleBpm("ballad, BPM 60-70")).toBe(65);
  });

  it("reads no tempo out of a number below 40 with a word after it, which counts that word (高BPM 16ビート, high BPM 16 step, medium BPM 32 bars)", () => {
    for (const s of [
      "J-POP, 高BPM 16ビート",
      "Japanese, trap, high BPM 16 beat hats",
      "medium BPM 32 bars",
      "rock, BPM 16 beats",
      "blues, BPM 12 bar shuffle",
      "prog, BPM 16 measures",
      "chiptune, high BPM 16 bit",
      "ロック, BPM 32小節",
      "高BPM 16分ハイハット",
      "高BPM 12拍",
      "高BPM 16ビット",
      "高BPM 16-ビート",
      "rock, BPMは16ビート",
      // whatever the word is: no list of counters to miss one
      "高BPM 16ステップ",
      "high BPM 16 step sequencer",
      "high BPM 16 notes",
      "high BPM 12 string",
      "trap, BPM 32 hi-hats",
      "high BPM 16.5 step",
      "rock, BPM 16-32 bars",
      "ambient, BPM 30 drone",
      // full-width letters and digits, and the ideographic space
      "ｈｉｇｈ ＢＰＭ １６ ｂｅａｔ",
      "ｍｅｄｉｕｍ　ＢＰＭ　３２　ＢＡＲＳ",
      "高ＢＰＭ １６ビート",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      // the score's tempo is added once and the words stay as the user wrote them
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
      expect(styleTempoSync(`${s}, 88 BPM`, 88), s).toBeNull();
    }
    // the tempo of the same style is still read wherever it is stated
    expect(styleBpm("J-POP, 高BPM 16ビート, 120 BPM")).toBe(120);
    expect(styleBpm("J-POP, 16ビート, BPM 120")).toBe(120);
    // a number below 40 that ends its item (a comma, a line break, a slash or the end) is the tempo stated
    for (const [s, bpm] of [
      ["ambient, BPM 30", 30],
      ["ambient, BPM 30, drone", 30],
      ["ambient, BPM 30\ndrone", 30],
      ["ambient, BPM 30/drone", 30],
      ["ambient, BPM 39.5", 40],
      ["ambient, ＢＰＭ ３０", 30],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleTempoSync(s, 88)?.style, s).toBe(s.replace(/(?:BPM 30|BPM 39\.5|ＢＰＭ ３０)/, "88 BPM"));
    }
    // a word after a number of 40-299 leaves it the tempo, and so does a separate item after it
    for (const [s, bpm] of [
      ["Japanese, trap, medium BPM 120 drums", 120],
      ["high BPM 140 ロック", 140],
      ["rock, BPM 120 beatbox", 120],
      ["rock, BPM 120 - beat driven", 120],
      ["rock, BPM 120, 16 beat", 120],
      ["rock, BPM 120\nbars of noise", 120],
      ["Beatles風, BPM 120 Beatles", 120],
      ["J-POP BPM140 分厚いベース", 140],
      ["J-POP BPM140分厚いベース", 140],
      ["ピアノ, BPM 140 分散和音", 140],
      ["ライブ, BPM 140 拍手", 140],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
  });

  it("reads a tempo of 40-299 after BPM whatever word follows it, also one that names beats or bars (BPM128 ビート強め, BPM 90 beats)", () => {
    for (const [s, bpm, synced] of [
      ["J-POP 女性ボーカル BPM128 ビート強め ピアノ", 128, "J-POP 女性ボーカル 88 BPM ビート強め ピアノ"],
      ["J-POP 女性ボーカル BPM140 ビートロック", 140, "J-POP 女性ボーカル 88 BPM ビートロック"],
      ["ロック　ＢＰＭ１４０　ビート感強め", 140, "ロック　88 BPM　ビート感強め"],
      ["BPM 140 ビート感", 140, "88 BPM ビート感"],
      ["BPM 140 ビートが効いた", 140, "88 BPM ビートが効いた"],
      ["hip hop BPM 90 beats", 90, "hip hop 88 BPM beats"],
      ["lofi BPM 80 beats chill", 80, "lofi 88 BPM beats chill"],
      ["drum and bass BPM 174 beats", 174, "drum and bass 88 BPM beats"],
      ["rock, BPM 120 beat-driven", 120, "rock, 88 BPM beat-driven"],
      ["chiptune BPM 150 bit music", 150, "chiptune 88 BPM bit music"],
      ["シティポップ BPM 100 小節ごとに転調", 100, "シティポップ 88 BPM 小節ごとに転調"],
      ["ロック BPM140ビート", 140, "ロック 88 BPMビート"],
      ["ballad, BPM 40 bars", 40, "ballad, 88 BPM bars"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      // the score's tempo replaces it instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
  });

  it("reads the tempo after a Japanese particle, 約, ≒, a tilde, brackets and other dashes after BPM (BPMは140, BPMが140, BPM約140, BPM: ~140, BPM (140), BPM ‐ 140)", () => {
    for (const [s, bpm, synced] of [
      ["J-POP, BPMは140", 140, "J-POP, 88 BPM"],
      ["J-POP, BPM は 140", 140, "J-POP, 88 BPM"],
      ["rock, BPM約140", 140, "rock, 88 BPM"],
      ["rock, BPMは約140", 140, "rock, 88 BPM"],
      ["rock, BPM: 約140", 140, "rock, 88 BPM"],
      ["rock, BPM≒140", 140, "rock, 88 BPM"],
      ["rock, BPM ≈ 140", 140, "rock, 88 BPM"],
      ["rock, BPM (140)", 140, "rock, 88 BPM"],
      ["rock, BPM(140), piano", 140, "rock, 88 BPM, piano"],
      ["rock, BPM（１４０）", 140, "rock, 88 BPM"],
      ["rock, ＢＰＭ（約１４０）", 140, "rock, 88 BPM"],
      ["ballad, BPM (60-70)", 65, "ballad, 88 BPM"],
      // the particle が, also in a clause that modifies a noun, edited in place
      ["J-POP, BPMが140", 140, "J-POP, 88 BPM"],
      ["ロック, BPMが140くらいの疾走感", 140, "ロック, 88 BPMくらいの疾走感"],
      ["rock, BPMが約140", 140, "rock, 88 BPM"],
      ["ロック　ＢＰＭが１４０", 140, "ロック　88 BPM"],
      // a tilde, ≒ or ≈ ("about") after a colon or an equals sign, as 約 is
      ["rock, BPM: ~140", 140, "rock, 88 BPM"],
      ["ロック, BPM：～140", 140, "ロック, 88 BPM"],
      ["rock, BPM: ~ 140, piano", 140, "rock, 88 BPM, piano"],
      ["rock, bpm=≈140", 140, "rock, 88 BPM"],
      ["rock, BPM＝≒１４０", 140, "rock, 88 BPM"],
      ["rock, BPMは～140", 140, "rock, 88 BPM"],
      ["rock, BPM (~140)", 140, "rock, 88 BPM"],
      ["ballad, BPM: ~60-70", 65, "ballad, 88 BPM"],
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash, U+2015 horizontal bar, U+2212 minus sign
      ["rock, BPM ‐ 140", 140, "rock, 88 BPM"],
      ["rock, BPM‑140", 140, "rock, 88 BPM"],
      ["rock, BPM ‒ 140", 140, "rock, 88 BPM"],
      ["rock, BPM ― 140", 140, "rock, 88 BPM"],
      ["rock, BPM − 140", 140, "rock, 88 BPM"],
      ["rock, 140‐BPM", 140, "rock, 88 BPM"],
      ["ballad, 60‐70 BPM", 65, "ballad, 88 BPM"],
      // BPM spelled out with hyphens
      ["rock, 140 beats-per-minute", 140, "rock, 88 BPM"],
      ["rock, 140 beats‐per‐minute", 140, "rock, 88 BPM"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      // the score's tempo replaces it instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
    // the new dashes join a Latin modifier word to BPM as the hyphen does
    for (const s of ["low‐BPM 120 bass", "slow‑BPM 140"]) expect(styleBpm(s), s).toBeNull();
    // a bracket holds the tempo alone, and an unclosed one holds none
    for (const s of ["rock, BPM (16 beat)", "rock, BPM (140", "rock, BPM (808)"]) expect(styleBpm(s), s).toBeNull();
    // after が or "about" a count, a decade, a drum machine or a Latin modifier word is still no tempo
    for (const s of ["rock, BPMが16ビート", "rock, BPMが90年代", "BPMが速い", "rock, BPM: ~16 beat", "trap, BPM: ~808", "rock, BPM: ~90s", "low-BPM: ~120 bass"]) {
      expect(styleBpm(s), s).toBeNull();
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
    }
  });

  it("reads the tempo after the particles を, も, で and a reading comma, after an 'about' word or 'of', in square brackets, and a number joined to BPM by a figure dash or a minus sign (BPMを140くらいに, BPMは、140, BPMはおよそ140, BPM around 140, a BPM of 140)", () => {
    for (const [s, bpm, synced] of [
      ["J-POP, BPMを140くらいに", 140, "J-POP, 88 BPMくらいに"],
      ["J-POP, BPMを140に", 140, "J-POP, 88 BPMに"],
      ["ロック, BPMを140に上げて", 140, "ロック, 88 BPMに上げて"],
      ["J-POP, BPMも140", 140, "J-POP, 88 BPM"],
      ["J-POP, BPMで140", 140, "J-POP, 88 BPM"],
      ["J-POP, BPM を 140 くらいに", 140, "J-POP, 88 BPM くらいに"],
      ["J-POP, BPMは、140", 140, "J-POP, 88 BPM"],
      ["J-POP, BPMは，140", 140, "J-POP, 88 BPM"],
      ["J-POP, BPMが、140", 140, "J-POP, 88 BPM"],
      ["ＪＰＯＰ、ＢＰＭを１４０に", 140, "ＪＰＯＰ、88 BPMに"],
      // "about" in Japanese, also after a particle or a colon
      ["ロック, BPMはおよそ140", 140, "ロック, 88 BPM"],
      ["ロック, BPMは大体140", 140, "ロック, 88 BPM"],
      ["ロック, BPMはだいたい140くらい", 140, "ロック, 88 BPMくらい"],
      ["ロック, BPM：およそ140", 140, "ロック, 88 BPM"],
      ["ロック, BPMはおおよそ140", 140, "ロック, 88 BPM"],
      ["ロック, BPMを約140に", 140, "ロック, 88 BPMに"],
      ["ロック, BPMは、およそ140", 140, "ロック, 88 BPM"],
      ["ロック, BPM（およそ140）", 140, "ロック, 88 BPM"],
      // "about" in English, also after a colon, and "of"
      ["rock, BPM around 140", 140, "rock, 88 BPM"],
      ["rock, BPM about 140", 140, "rock, 88 BPM"],
      ["rock, BPM approximately 140", 140, "rock, 88 BPM"],
      ["rock, BPM approx. 140", 140, "rock, 88 BPM"],
      ["rock, BPM approx 140", 140, "rock, 88 BPM"],
      ["rock, BPM roughly 140", 140, "rock, 88 BPM"],
      ["rock, BPM: around 140", 140, "rock, 88 BPM"],
      ["rock, BPM Around 140, piano", 140, "rock, 88 BPM, piano"],
      ["rock, a BPM of 140", 140, "rock, a 88 BPM"],
      ["rock, BPM of around 140", 140, "rock, 88 BPM"],
      ["rock, BPM (about 140)", 140, "rock, 88 BPM"],
      ["ballad, BPM around 60-70", 65, "ballad, 88 BPM"],
      // square brackets, and a figure dash or a minus sign joining the number to BPM
      ["rock, BPM [140]", 140, "rock, 88 BPM"],
      ["rock, BPM【140】", 140, "rock, 88 BPM"],
      ["rock, ＢＰＭ［１４０］", 140, "rock, 88 BPM"],
      ["rock, 140‒BPM", 140, "rock, 88 BPM"],
      ["rock, 140−BPM", 140, "rock, 88 BPM"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      // the score's tempo replaces it instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
    // after them a count, a decade, a meter, a drum machine or a Latin modifier word is still no tempo, and an
    // English "about" word is a word of its own
    for (const s of [
      "rock, BPMを16ビートに",
      "J-POP, 高BPMで16ビート",
      "rock, BPMも90年代",
      "trap, BPMで808",
      "rock, BPMを12/8に",
      "rock, BPMを2倍に",
      "rock, BPMは、16ビート",
      "rock, BPM around 16 bars",
      "rock, BPM roughly 16 beat",
      "rock, BPM about 90s",
      "trap, BPM of 808",
      "rock, BPM of 16 bars",
      "low-BPM around 120 bass",
      "rock, BPM abouts 140",
      "rock, BPM often 140",
      "rock, BPM、140",
      "rock, BPM [140",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
      expect(styleTempoSync(`${s}, 88 BPM`, 88), s).toBeNull();
    }
  });

  it("reads no tempo out of a percentage or an amount of change after BPM (BPMが10%アップ, BPM +10, BPMを50上げて, BPMを50くらい上げて, BPM 2倍), but a tempo of 100 or more before a word of raising (BPM128 アップな曲調)", () => {
    for (const s of [
      "J-POP, サビでBPMが10%上がる",
      "ロック, BPMは20%遅め",
      "rock, BPM約10%アップ",
      "BPMが50%増し",
      "BPMは20％遅め",
      "BPMが10％上がる",
      "rock, BPMを20%上げて",
      "rock, BPM 10% up",
      "rock, BPM 10 % faster",
      "rock, BPM: ~15%",
      "rock, BPM around 10% faster",
      "rock, BPM 10-20%",
      "rock, BPM 100%",
      "rock, BPM 12.5%",
      "rock, BPM (10%)",
      "rock, BPM 50 percent faster",
      "サビでBPMを50パーセント上げる",
      // a sign, or a word of raising or lowering right after the number: an amount of change
      "rock, BPM +10",
      "rock, BPM＋10",
      "サビでBPMを10上げて",
      "サビでBPMを50上げて",
      "サビだけBPMが40上がる",
      "サビでBPMを40下げる",
      "サビでBPMが60下がる",
      "サビでBPMを 50 上げる",
      "BPMが50アップ",
      "BPMを40ダウンして",
      "BPMを50アップ！",
      // also after a hedge between the number and the word
      "サビでBPMを50くらい上げて",
      "サビでBPMを40ほど下げて",
      "BPMを50くらいアップ",
      "BPMを50ほどアップして",
      "BPMを50程度上げて",
      "BPMを50ぐらい上げる",
      "BPMを50程上げて",
      "BPMを20前後下げて",
      "サビでBPMを10だけ上げる",
      "BPMを10ずつ上げていく",
      "サビだけBPMが40くらい上がる",
      "BPMが40くらいアップ",
      "サビでBPMを 50 くらい 上げて",
      "サビでＢＰＭを５０くらい上げて",
      "サビでBPMを99上げて",
      "rock, BPM 95.5アップ",
      // a multiple is never a tempo of 10-299
      "BPM 2倍",
      "BPMを2倍に",
      "BPMを1.5倍",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      expect(styleBpmDiffers(s, 88), s).toBe(true);
      // the score's tempo is added once and the wording stays as the user wrote it
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
      expect(styleTempoSync(`${s}, 88 BPM`, 88), s).toBeNull();
      expect(BPM_TOKEN.test(s), s).toBe(false);
    }
    // a tempo with a percentage elsewhere, a tempo raised to, and アップ / ダウン starting a longer word are still read
    for (const [s, bpm] of [
      ["rock, BPM 140, 10% swing", 140],
      ["rock, BPM 140 10% swing", 140],
      ["ロック, BPMを140に上げて", 140],
      ["ロック, BPMを140まで上げる", 140],
      ["J-POP, BPM140 アップテンポ", 140],
      ["J-POP, BPM140アップテンポ", 140],
      ["J-POP, BPM 140 アップビート", 140],
      ["lofi, BPM 80 ダウンテンポ", 80],
      ["ロック, BPMが140くらいの疾走感", 140],
      ["rock, 10% swing, 120 BPM", 120],
      ["rock, BPM 120 percussion", 120],
      ["J-POP, BPM 140 上品なピアノ", 140],
      // a hedge before a word that is no word of raising or lowering
      ["J-POP, BPMを140くらいに", 140],
      ["J-POP, BPMは140くらい速め", 140],
      ["J-POP, BPMを90くらいに上げて", 90],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
    // a raise or drop of 100 BPM or more is no realistic amount: after a tempo of 100 or more a word of raising or
    // lowering describes the song, and the score's tempo replaces it instead of being added as a second one
    for (const [s, bpm, synced] of [
      ["J-POP, BPM128 アップな曲調", 128, "J-POP, 88 BPM アップな曲調"],
      ["J-POP BPM140 アップ曲 女性ボーカル", 140, "J-POP 88 BPM アップ曲 女性ボーカル"],
      ["J-POP, BPM 140 上がる曲", 140, "J-POP, 88 BPM 上がる曲"],
      ["J-POP, BPM 140 アップめ", 140, "J-POP, 88 BPM アップめ"],
      ["ロック, BPM 100 アップな曲", 100, "ロック, 88 BPM アップな曲"],
      ["ロック, BPMは150くらい上がる感じ", 150, "ロック, 88 BPMくらい上がる感じ"],
      ["ロック, ＢＰＭ１２８アップな曲調", 128, "ロック, 88 BPMアップな曲調"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
  });

  it("reads no tempo out of an amount before the other words of raising or lowering (BPMを50落として, BPMが50速くなる, BPMを40増やして, BPMを50以上も落として), but a tempo raised or lowered to (BPMを140に落として)", () => {
    for (const s of [
      "サビでBPMを50落として",
      "サビでBPMを40 落とす",
      "BPMが50落ちる",
      "BPMを40速くして",
      "BPMを50遅くして",
      "BPMを40早くして",
      "サビでBPMが50速くなる",
      "BPMが40遅くなる",
      "サビはBPMを50速く",
      "BPMを40速めて",
      "BPMを40早める",
      "BPMを40増やして",
      "BPMを50増しで",
      "BPMを50減らして",
      "BPMを50プラスして",
      "BPMを50マイナス",
      // also after a hedge, or two
      "BPMを50ほど落として",
      "BPMを50ぐらい速くして",
      "BPMを50以上落として",
      "BPMを40以下ずつ下げて",
      "BPMを50も上げて",
      "BPMを50以上も落として",
      "BPMを50くらいずつ上げて",
      "サビでBPMを 50 ほど 落として",
      "サビでＢＰＭを５０落として",
      "rock, BPM 95.5 落とす",
      "rock, BPM 40-50 落として",
      "rock, BPM 95.5落とす",
      "rock, BPM 40-50落として",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      expect(styleBpmDiffers(s, 88), s).toBe(true);
      // the score's tempo is added once and the wording stays as the user wrote it
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
      expect(styleTempoSync(`${s}, 88 BPM`, 88), s).toBeNull();
      expect(BPM_TOKEN.test(s), s).toBe(false);
    }
    // a tempo raised or lowered to, a word that only starts like a word of raising or lowering (落ち着いた,
    // マイナスワン), a hedge before another word, and 速め / 早め as "fastish"
    for (const [s, bpm] of [
      ["ロック, BPMを140に落として", 140],
      ["ロック, BPMを80に落として", 80],
      ["ロック, BPMを80まで下げて", 80],
      ["ロック, BPMを50以下に落として", 50],
      ["バラード, BPM 70 落ち着いたピアノ", 70],
      ["バラード, BPM 70 落ちついたピアノ", 70],
      ["カラオケ, BPM 90 マイナスワン音源", 90],
      ["rock, BPM 90 プラスチックな音", 90],
      ["J-POP, BPM 90 速めの曲", 90],
      ["J-POP, BPM 90 早めに展開", 90],
      ["rap, BPM 90 早口", 90],
      ["J-POP, BPM 90以上", 90],
      ["J-POP, BPM 80 もっと上げて", 80],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
    // after a tempo of 100 or more they describe the song, and the score's tempo replaces it
    for (const [s, bpm, synced] of [
      ["J-POP, BPM 140 速くて重い", 140, "J-POP, 88 BPM 速くて重い"],
      ["ロック, BPM 120 落ち着かない感じ", 120, "ロック, 88 BPM 落ち着かない感じ"],
      ["ロック, BPMは150くらい遅く感じる", 150, "ロック, 88 BPMくらい遅く感じる"],
      ["J-POP, BPM128 増し増し", 128, "J-POP, 88 BPM 増し増し"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
  });

  it("reads 落ち only as the verb 落ちる (BPM90 落ちサビ, BPM 60 落ち込んだ), the hiragana and 引き forms as words of raising or lowering (BPMを50あげて, BPMを50引き上げて), and a word after a space in a tag list as a tag of its own (BPM 70 遅くて切ない)", () => {
    for (const [s, bpm, synced] of [
      // 落ちサビ (a quiet chorus) and 落ち込んだ (gloomy) lower no tempo, attached to the number or not
      ["J-POP 女性ボーカル BPM90 落ちサビあり", 90, "J-POP 女性ボーカル 88 BPM 落ちサビあり"],
      ["J-POP 女性ボーカル BPM 90 落ちサビ ピアノ", 90, "J-POP 女性ボーカル 88 BPM 落ちサビ ピアノ"],
      ["バラード, BPM 60 落ち込んだ雰囲気", 60, "バラード, 88 BPM 落ち込んだ雰囲気"],
      ["BPMは90 落ちサビで60", 90, "88 BPM 落ちサビで60"],
      ["J-POP, BPM90落ちサビ", 90, "J-POP, 88 BPM落ちサビ"],
      ["J-POP, BPMは90落ちサビあり", 90, "J-POP, 88 BPM落ちサビあり"],
      ["バラード, BPM 60落ち込んだ雰囲気", 60, "バラード, 88 BPM落ち込んだ雰囲気"],
      ["バラード, BPMが60落ち着いた雰囲気", 60, "バラード, 88 BPM落ち着いた雰囲気"],
      // おとなしい is no おとす
      ["J-POP, BPM 70おとなしい曲", 70, "J-POP, 88 BPMおとなしい曲"],
      ["J-POP, BPMは70おとなしめ", 70, "J-POP, 88 BPMおとなしめ"],
      // in a tag list a space starts a new tag: the number before it is a tempo, unless the word is a verb or comes
      // after a hedge (BPM 50 上げて, BPM 50 くらい上げて: below)
      ["バラード BPM 70 遅くて切ない", 70, "バラード 88 BPM 遅くて切ない"],
      ["BPM 95 早くない", 95, "88 BPM 早くない"],
      ["ロック BPM 80 ダウン系", 80, "ロック 88 BPM ダウン系"],
      ["BPM 90 上げ曲", 90, "88 BPM 上げ曲"],
      ["BPM 80 プラスα", 80, "88 BPM プラスα"],
      ["J-POP, BPM 80 アップ!", 80, "J-POP, 88 BPM アップ!"],
      ["J-POP, BPM:90 あげあげ", 90, "J-POP, 88 BPM あげあげ"],
      ["ロック, BPM 70くらい 落とした感じ", 70, "ロック, 88 BPMくらい 落とした感じ"],
      ["rock, BPM 95.5 アップ", 96, "rock, 88 BPM アップ"],
      // は (and で) states the tempo: a space after it ends the statement as it ends a tag
      ["バラード, BPMは70 遅くて切ない", 70, "バラード, 88 BPM 遅くて切ない"],
      ["ロック, BPMで80 ダウン系", 80, "ロック, 88 BPM ダウン系"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      // the score's tempo replaces it instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
    for (const s of [
      // the verb 落ちる, the hiragana forms and 引き上げる / 引き下げる after an amount
      "BPMが50落ちて",
      "BPMが50落ちた",
      "BPMを50あげて",
      "BPMを50さげて",
      "BPMを50おとして",
      "BPMを50おとす",
      "BPMを50引き上げて",
      "BPMを60引き下げて",
      "BPMを40引上げ",
      "BPMを50引下げて",
      "BPMが50あがる",
      "BPMが50さがる",
      "BPMを50くらいあげて",
      "サビでＢＰＭを５０あげて",
      // after を, が or も BPM is the object or subject of the verb that follows, and a space ends no tag
      "サビでBPMを 50 あげて",
      "サビだけBPMが40 上がる",
      "BPMが50 落ちる",
      "BPMも50 上げて",
      "BPMを、50 上げて",
      "BPMを約50 上げて",
      // in a tag list a word attached to the number, or to a hedge attached to it, is still an amount
      "サビでBPM50アップ",
      "rock, BPM 50くらい上げて",
      "rock, BPM: 50上げ",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      expect(styleBpmDiffers(s, 88), s).toBe(true);
      // the score's tempo is added once and the wording stays as the user wrote it
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
      expect(styleTempoSync(`${s}, 88 BPM`, 88), s).toBeNull();
      expect(BPM_TOKEN.test(s), s).toBe(false);
    }
  });

  it("reads no tempo out of an amount before the other hiragana forms (BPMを50ひきあげて, BPMを50はやくして, BPMが50おちる) and the verbs 遅らせる, 上昇させる and 低下させる, but before a word that only starts like one (BPM90はやくちラップ, BPM90上昇感)", () => {
    for (const s of [
      // the hiragana forms of 引き上げる, 引き下げる, 速く, 遅く, 速める, 増やす, 減らす and 落ちる
      "BPMを50引きあげて",
      "BPMを50ひきあげて",
      "BPMを50ひきさげて",
      "BPMを50はやくして",
      "BPMを50おそくして",
      "BPMを50ふやして",
      "BPMを50へらして",
      "BPMを50はやめて",
      "BPMが50おちる",
      "BPMを50くらいおそくして",
      "サビでＢＰＭを５０はやくして",
      "サビでBPMを 50 ひきあげて",
      "BPMも40 はやめて",
      "rock, BPM 50ひきさげ",
      // 遅らせる and the verbs of 上昇, 低下, 増加, 減少, 加速 and 減速
      "BPMを50遅らせて",
      "BPMを50上昇させて",
      "BPMを60低下させて",
      "BPMを50増加させて",
      "BPMを50減少させて",
      "BPMを50加速させて",
      "BPMを50減速して",
      "BPMが50上昇する",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      expect(styleBpmDiffers(s, 88), s).toBe(true);
      // the score's tempo is added once and the wording stays as the user wrote it
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
      expect(styleTempoSync(`${s}, 88 BPM`, 88), s).toBeNull();
      expect(BPM_TOKEN.test(s), s).toBe(false);
    }
    for (const [s, bpm, synced] of [
      // はやくち (早口), はやめの (早めの), ふやける, へらへら, おちつく, おちサビ and the nouns 上昇 and 加速 lower or raise nothing
      ["ヒップホップ, BPM90はやくちラップ", 90, "ヒップホップ, 88 BPMはやくちラップ"],
      ["J-POP, BPM90はやめのテンポ", 90, "J-POP, 88 BPMはやめのテンポ"],
      ["lo-fi, BPM80ふやけた音色", 80, "lo-fi, 88 BPMふやけた音色"],
      ["コミックソング, BPM90へらへらした歌声", 90, "コミックソング, 88 BPMへらへらした歌声"],
      ["バラード, BPMが60おちついた雰囲気", 60, "バラード, 88 BPMおちついた雰囲気"],
      ["J-POP, BPMは90おちサビあり", 90, "J-POP, 88 BPMおちサビあり"],
      ["J-POP, BPM90上昇感のあるサビ", 90, "J-POP, 88 BPM上昇感のあるサビ"],
      ["EDM, BPM 90加速感", 90, "EDM, 88 BPM加速感"],
      // in a tag list a word after a space is a tag of its own, in hiragana too
      ["バラード BPM 60 おそくて切ない", 60, "バラード 88 BPM おそくて切ない"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      // the score's tempo replaces it instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
  });

  it("reads no tempo out of an amount after a space in a tag list when a hedge comes first or the word is a verb (サビでBPM 50 上げて, Cメロ BPM 60 下げる, BPM 50 くらい上げて), but a tag after a space (BPM 90 上がる曲, BPM 70 落とした感じ)", () => {
    for (const s of [
      // a verb (the て form, a する or させる form, or a dictionary form that ends the word) after a space: a half-width
      // space between Japanese and a number (和欧間スペース) separates no tags
      "サビでBPM 50 上げて",
      "サビでBPM 50 アップして",
      "Cメロ BPM 60 下げる",
      "2番から BPM 40 上げる",
      "Cメロで BPM 60 落として",
      "BPM 50 速くして",
      "BPM 50 増やして",
      "BPMは50 上げて",
      "BPMで50 上げて",
      "BPM: 50 上げて",
      "BPM　５０　上げて",
      "BPM 50 あげて",
      "BPM 50 引き上げて",
      "BPM 50 上がって",
      "BPM 50 遅くなって",
      "BPM 50 落ちる、ピアノ",
      "BPM 50 アップする",
      "後半 BPM 50 加速させる",
      "rock, BPM 95.5 落とす",
      "rock, BPM 40-50 落として",
      // a hedge starts no tag: after a hedge after a space, any word of raising or lowering is an amount
      "BPM 50 くらい上げて",
      "ラスサビで BPM 50 くらい上げて",
      "間奏で BPM 50 ほど落とす",
      "BPM 50 程度アップ",
      "BPM 50 ほど アップ",
      "BPM 50 くらい 上げて",
      // a verb after a space after a hedge attached to the number
      "BPM 50くらい 上げて",
      "BPM 50くらい ほど 上げて",
    ]) {
      expect(styleBpm(s), s).toBeNull();
      expect(styleBpmDiffers(s, 88), s).toBe(true);
      // the score's tempo is added once and the wording stays as the user wrote it
      expect(styleTempoSync(s, 88)?.style, s).toBe(`${s}, 88 BPM`);
      expect(styleTempoSync(`${s}, 88 BPM`, 88), s).toBeNull();
      expect(BPM_TOKEN.test(s), s).toBe(false);
    }
    for (const [s, bpm, synced] of [
      // a form that describes the next word, another form of the verb or an adjective after a space starts a tag
      ["BPM 90 上がる曲", 90, "88 BPM 上がる曲"],
      ["J-POP BPM 80 落ちる系", 80, "J-POP 88 BPM 落ちる系"],
      ["EDM BPM 90 加速するサビ", 90, "EDM 88 BPM 加速するサビ"],
      ["BPM 70 落とした感じ", 70, "88 BPM 落とした感じ"],
      ["BPM 85 下げ気味", 85, "88 BPM 下げ気味"],
      ["J-POP BPM 90 早くて明るい", 90, "J-POP 88 BPM 早くて明るい"],
      ["ロック, BPM 70くらい 落とした感じ", 70, "ロック, 88 BPMくらい 落とした感じ"],
      // a comma ends the item: the verb after it is no amount
      ["J-POP, BPM 90, 上げていく展開", 90, "J-POP, 88 BPM, 上げていく展開"],
      // a bare アップ after a space is a tag ("BPM 80 アップ!"), so this one names 50: a known ambiguity
      ["サビで BPM 50 アップ", 50, "サビで 88 BPM アップ"],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
      expect(styleBpmDiffers(s, bpm), s).toBe(false);
      // the score's tempo replaces it instead of being added as a second, contradicting one
      expect(styleTempoSync(s, 88)?.style, s).toBe(synced);
      expect(styleTempoSync(synced, 88), s).toBeNull();
    }
    // 808/909 and decades stay unread
    for (const s of ["medium BPM 808 drums", "trap, BPM 909", "BPMを808", "BPMで808", "BPMも 909", "BPMを90年代", "BPM 90年代 アップ"]) {
      expect(styleBpm(s), s).toBeNull();
    }
  });

  it("recognises a lone tempo item with its closing period", () => {
    for (const t of ["96 BPM", "60-70 BPM", "60〜70 bpm", "BPM 140", "BPM:140", "ＢＰＭ＝１４０", "BPM-140", "140-BPM", "１４０ＢＰＭ", "8 BPM", "1200 BPM", "140 beats per minute", "BPMは140", "BPMが140", "BPM約140", "BPM: ~140", "BPM：～１４０", "BPM (~140)", "BPM (140)", "BPM ‐ 140", "140 beats-per-minute", "BPM 30", "BPMを140", "BPMも140", "BPMで140", "BPMは、140", "BPMはおよそ140", "BPM around 140", "BPM approx. 140", "BPM of 140", "BPM [140]", "BPM【140】", "140−BPM"]) {
      expect(BPM_TOKEN.exec(t)?.[1], t).toBe("");
      expect(BPM_TOKEN.exec(`${t}.`)?.[1], t).toBe(".");
    }
    for (const t of ["upbeat 120 BPM groove", "warm piano", "BPM", "high BPM energy", "high-BPM 90s", "BPM 12/8", "4/4 - 120 BPM", "low-BPM 808", "BPM 808", "BPM 100-300", "BPM 12-string", "BPM 90年代", "medium BPM 120", "高BPM 140", "TR-808-BPM", "BPM (140", "BPM (16 beat)", "BPM 16 step", "BPM 128 beats", "BPMを140に", "BPMが10%アップ", "BPM 10%", "BPMを50上げて", "BPM +10", "a BPM of 140"]) expect(BPM_TOKEN.test(t), t).toBe(false);
  });

  it("replaces or appends the tempo without touching other words", () => {
    expect(withStyleBpm("Japanese, J-pop, hopeful, 120 BPM", 96)).toBe("Japanese, J-pop, hopeful, 96 BPM");
    expect(withStyleBpm("English, soulful jazz-pop, 88 BPM, brushed drums", 104.4)).toBe("English, soulful jazz-pop, 104 BPM, brushed drums");
    expect(withStyleBpm("warm piano pop", 90)).toBe("warm piano pop, 90 BPM");
    expect(withStyleBpm("warm piano pop, ", 90)).toBe("warm piano pop, 90 BPM");
    expect(withStyleBpm("Upbeat indie pop with warm female vocals.", 110)).toBe("Upbeat indie pop with warm female vocals, 110 BPM.");
    expect(withStyleBpm("", 80)).toBe("80 BPM");
  });

  it("treats a tempo range as one statement", () => {
    expect(withStyleBpm("slow ballad at 60-70 BPM", 96)).toBe("slow ballad at 96 BPM");
    expect(withStyleBpm("ballad, 60 ~ 70 bpm, piano", 64)).toBe("ballad, 64 BPM, piano");
    expect(styleBpm("slow ballad at 60-70 BPM")).toBe(65);
  });

  it("reads ranges written with Japanese wave dashes and the em dash", () => {
    expect(styleBpm("city pop, 60〜70 BPM")).toBe(65);
    expect(withStyleBpm("city pop, 60〜70 BPM", 96)).toBe("city pop, 96 BPM");
    expect(withStyleBpm("ballad, 60～70bpm", 64)).toBe("ballad, 64 BPM");
    expect(styleBpm("ballad, 80—90 BPM")).toBe(85);
  });

  it("compares with a score tempo", () => {
    expect(styleBpmDiffers("pop, 120 BPM", 120)).toBe(false);
    expect(styleBpmDiffers("pop, 120 BPM", 96)).toBe(true);
    expect(styleBpmDiffers("pop", 96)).toBe(true);
  });

  // After を, が or も (CLAUSE_LEAD) BPM is the object or subject of what follows, and a space ends no tag: a bare
  // change word after the space still makes the number an amount. After the others (TAG_LEAD) the same space starts a
  // new tag and the number is the tempo.
  it("reads a clause after を/が/も differently from a tag list", () => {
    for (const s of ["サビでBPMを50 アップ", "BPMが50 アップ", "BPMも50 ダウン", "BPMを50 上げ", "バラード, BPMが70 遅くて切ない"]) {
      expect(styleBpm(s), s).toBeNull();
    }
    for (const [s, bpm] of [["ロック BPM 80 アップ!", 80], ["BPMは70 遅くて切ない", 70], ["BPMで80 ダウン系", 80]] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
  });

  it("reads no tempo out of an amount after を/が/も before 高く, 加速, 速めに, an arrow, a reading comma or brackets, and reads the tempo stated later (サビでBPMを50ほど高く, ロック, BPM 120)", () => {
    for (const s of ["BPMを30、足して", "BPMを50、引いて", "BPMが50、高くなる", "BPM（50）上げて", "サビでBPM（20）上げて", "BPM［50］ 上げて", "サビでBPMを40高くして","サビでBPMを40高める","サビだけBPMを40速めに","サビでBPMを40加速","サビでBPMを40上昇","サビでBPMを40程度、上げて","サビはBPMが50加速","BPMが60低下","BPMが50速い","BPMを60減速","BPMを50位上げて","BPMを50足して","BPMを50増","BPMも40低く","J-POP, サビでBPMが20↑","BPMは20↑","BPM約20↑","BPMを20↓","BPMを20、上げて","BPMを20!上げて","BPMを（20）上げて","BPMを[20]上げて","BPMが【20】アップ"]) {
      expect(styleBpm(s), s).toBeNull();
    }
    for (const [s, bpm] of [
      ["サビでBPMを50ほど高く, ロック, BPM 120", 120],
      ["2番からBPMも40低く, バラード, BPM: 90", 90],
      ["Aメロは抑えめ、サビでBPMを40高くして疾走感を出す。BPM 130", 130],
      // a tempo before a word that only describes it, or before a particle
      ["バラード, BPMが60おちついた雰囲気", 60],
      ["BPMが60低めのバラード", 60],
      ["BPMが90上昇感", 90],
      ["BPMが90の曲", 90],
      ["BPMが90、ミドルテンポ", 90],
      ["BPMが90位", 90],
      ["BPMを（90）くらいに", 90],
      // after a reading comma or an exclamation mark only a verb makes an amount: a descriptive tag after it names the
      // tempo before it (and a tempo stated later is not read instead)
      ["バラード、BPMが66、遅い", 66],
      ["R&B、BPMが75、遅くて甘い", 75],
      ["J-POP、女性ボーカル、BPMが90、高く伸びるサビ", 90],
      ["BPMが95、速いビート", 95],
      ["BPMも70、遅い", 70],
      ["BPMが85、アップ", 85],
      ["BPMが65、落ちる系", 65],
      ["BPMが90、加速するサビ", 90],
      ["BPMが70、遅いテンポ。サビはBPM 140", 70],
      // after a comma the verb forms of 高く, 低く, 足す and 引く make an amount too (the tempo stated later is read)
      ["サビでBPMを40程度、高くして, ロック, BPM 120", 120],
      ["サビでBPMを40、低くする。BPM 130", 130],
      // a tempo of 100 or more in brackets is no amount
      ["BPM（140）上げて", 140],
      // in a tag list a word after the brackets is a tag of its own
      ["BPM（80）ダウン系", 80],
      ["BPM【90】上がる曲", 90],
      ["BPM(70)遅くて切ない", 70],
      // an arrow after a tempo of 40 or more in a tag list names it (90 and up)
      ["BPM 90↑", 90],
      ["BPM 140↑", 140],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
  });

  // Every verb form that makes an amount after a reading comma, and the same verbs in their polite forms (上げます,
  // 高くします, 足しました), which never describe the word after them: after a comma, after spaces in a tag list and after
  // brackets. In a tag list the brackets keep the rules of the number without them, also after a hedge (くらい, 程度).
  it("reads no tempo out of an amount before any verb form after a comma, a polite verb, or a hedge after brackets", () => {
    for (const s of [
      // after a comma: the verbs of 足す, 引く, 高める and 高くなる (and the reading of 高くなるサビ below)
      "BPMを30、足す", "BPMを50、引く", "BPMを50、高める", "サビでBPMを40、高めて", "BPMが50、高くなって", "BPMが40、低くなって",
      // polite forms, after a comma, without one, after spaces in a tag list and after brackets
      "サビでBPMを20、上げます", "サビでBPMを40、高くします", "BPMを30、足します", "サビでBPMを40程度、高めます", "BPMが20、上がりました",
      "BPMを50、落としましょう", "BPMを40、アップします", "BPMを50、引きます", "BPMを50上げます", "BPM 50 上げます", "Cメロ BPM 60 下げました",
      "BPM 50 速くします", "BPM（50）上げます",
      // a hedge after brackets in a tag list, as without them ("BPM 50くらい上げて", "BPM 50 くらい上げて")
      "BPM（50）くらい上げて", "サビでBPM（20）くらい上げて", "ラスサビで BPM【50】程度アップ", "BPM［60］ほど落として", "BPMは（50）くらい上げて",
      "BPM（50） くらいアップ", "BPM（50）くらい 上げて",
    ]) {
      expect(styleBpm(s), s).toBeNull();
    }
    for (const [s, bpm] of [
      // a form that describes the word after it still names the tempo
      ["BPMが90、高くなるサビ", 90],
      ["BPMが70、落とした感じ", 70],
      // after brackets: the tempo raised to, a tag after a hedge, a tempo of 100 or more, a bare word
      ["BPM（90）くらいに上げて", 90],
      ["ロック, BPM（70）くらい 落とした感じ", 70],
      ["BPM（140）くらい上げて", 140],
      ["BPM（50）アップ", 50],
      // a polite verb after a tempo of 100 or more
      ["BPM 140 上げます", 140],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
  });

  // Every polite and volitional form of these verbs, also where the start of the word decides (attached to the
  // number, after a hedge, after を/が/も, after brackets in a clause): 速めます, 高めます and 引きます as 速めて, 高めて
  // and 引いて; the verb 増す in all its forms (増し is a word of change); the hedges 近く, ばかり, 強 and 弱.
  it("reads no tempo out of an amount before any polite or volitional verb form, 増す, or after 近く, ばかり, 強 or 弱", () => {
    for (const s of [
      "BPM 50早めます", "BPM 50くらい早めます", "BPM（50）くらい早めます", "ラスサビでBPMを45早めます", "BPMを（50）高めます",
      "サビでBPMを40程度高めます", "落ちサビでBPMを60引きます", "BPMが 50 引きました", "BPM 50はやめました",
      "BPM 50 上げよう", "BPMを50、下げよう", "BPM（50）落とそう", "BPM 50 速めよう", "BPM 50速めよう", "サビでBPMを40高めよう",
      "BPMを50足そう", "BPMを50引こう", "BPMを50、高くしよう", "BPM 50 アップしよう",
      "BPM 50 増して", "BPMを50、増して", "BPM 50 増す", "BPM 50 増します", "BPM 50 増そう",
      "サビでBPMを60近く落として", "BPMを50ばかり上げて", "BPM 50強アップ", "BPM（50）弱上げて", "BPM 50 近く上げて",
      // every volitional form after spaces, attached, after a hedge and after a comma
      "BPM 50 上がろう", "BPM 50 落ちよう", "BPM 50 遅らせよう", "BPM 50 増やそう", "BPM 50 減らそう", "BPM 50 速くしよう",
      "BPM 50 加速させよう", "BPM 50増す", "BPMを50増そう", "BPM 50くらい増そう", "BPMを50、足そう", "BPMを50、引こう", "BPMを50、高めよう",
      // in hiragana, and 〜くなろう
      "J-POP, サビでBPMを50ふやそう", "大サビでBPMを45おとそう", "ラスサビはBPMを40へらそう", "BPMが50落ちよう", "BPMを（50）おとそう",
      "BPM（50）くらいおとそう", "サビで BPM 50 速くなろう", "BPMを50、高くなろう",
      // the polite negative and the imperative
      "サビでBPMを50、上げませんか", "BPM 50速めませんか", "BPMを50高めませんか", "BPM 50 上げません", "BPM 50 上げろ", "BPMを50、上げろ",
      "BPM 50 落とせ", "BPM 50おとせ", "BPM 50 速くしろ", "BPM 50速めろ", "BPMを50高めろ", "BPMを50足せ", "BPMを50引け", "BPMを50、ふやせ",
    ]) {
      expect(styleBpm(s), s).toBeNull();
    }
    for (const [s, bpm] of [
      // ちょっと and あまり are adverbs too: no hedge
      ["BPM 90 ちょっと上がる曲", 90],
      ["BPMが90あまり速くない", 90],
      ["BPM 90近くアップテンポ", 90],
      ["BPM 80強めのビート", 80],
      ["BPM 90 増し増しのベース", 90],
      // words that only start like those forms
      ["BPM 90 おとそのある正月", 90],
      ["BPM 90 へらへら笑う", 90],
      ["BPM 90 ふやけた音", 90],
      ["BPM 90強め・しっとり", 90],
      ["BPM 80ばかりの曲", 80],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
  });

  // An imperative only where it ends its word: a potential, negative or past form that starts like one (上がれる,
  // 落とせない, 増やせる, 速くなれる, 引けを取らない, 引け目) describes what follows, and the number before it is the
  // tempo. The imperatives with よ, せよ and なさい make an amount. A range of amounts is no tempo, nor is its first end.
  it("reads the tempo before a potential or negative form, and none out of a range of amounts or 〜よ, 〜せよ, 〜なさい", () => {
    for (const [s, bpm] of [
      ["ロック BPM 90 上がれるサビ", 90],
      ["J-POP 女性ボーカル BPM 95 上がれる曲", 95],
      ["バラード BPM 70 落とせない想い", 70],
      ["BPM 80 増やせるコーラス", 80],
      ["BPM 75 速くなれる曲", 75],
      ["BPM 75 下がれない坂道", 75],
      ["J-POP BPM 90 上がれた夏", 90],
      ["BPM 90くらい 上がれる曲", 90],
      ["バラード BPM（70）上がれるサビ", 70],
      ["バラード BPMが70、上がれるサビ", 70],
      ["BPMも85、落とせないグルーヴ", 85],
      ["BPMが90、引けを取らない疾走感", 90],
      ["BPMが90引けを取らない疾走感", 90],
      ["BPMが90引け目を感じる", 90],
      ["BPMが90、足せない", 90],
      ["BPM 90 上がれるサビ、間奏はBPM 120", 90],
      ["BPM 80 - 90 上がれる曲", 85],
      ["J-POP, BPM 70 - 80 上がれるサビ", 75],
      // after a range of amounts the tempo stated later is read
      ["BPMを40 - 50上げて。BPM 120", 120],
      ["サビで BPM 50 - 60 アップして、BPM 128", 128],
      // a first end of 100 or more is no amount, nor is a count or a tag after a spaced dash
      ["deep house - BPM 124 - 55% swing", 124],
      ["BPM 120 - 140 上げて", 130],
      ["BPM 85 - 95 上がる曲", 90],
      ["BPM 140 - 16ビート", 140],
      ["rock, BPM 120 - 90年代風", 120],
      ["rock, BPM 120 - 80s style", 120],
      ["ballad, BPM 60 - 70, piano", 65],
      ["サビでBPMを40減速せよ。BPM 120", 120],
      ["BPM 140 上げよ", 140],
      ["BPMが90高めよりのキー", 90],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
    for (const s of [
      "BPM 50 上げろよ", "BPM 50 上げろって", "BPM 50 上げろー", "BPM 50 上げろや", "BPMを50引け", "BPMを50、足せ", "BPMを50、引けよ", "BPM 50 上がれ!",
      "BPM 50 - 60 上げて", "BPM 50 – 60 上げて", "BPM ５０ － ６０ 上げて", "BPM 90 - 99 上げて", "BPMを40 〜 50 上げて", "BPMを40 ～ 60 くらい上げて",
      "BPM 50 〜 60 落とせ", "rock, BPM 40 - 50 落として",
      "BPMを50加速せよ", "BPM 50 上げよ", "BPM 50 アップせよ", "BPM（50）上げよ", "BPM 50 上げなさい", "BPMを50、上げなさい",
      "BPMを50速めなさい", "BPMを50高めなさい", "BPMを50落ちなさい", "BPM 50速めなさい", "BPMを50、高めよ", "BPMを50高くせよ",
    ]) {
      expect(styleBpm(s), s).toBeNull();
    }
    expect(withStyleBpm("J-POP, BPM 70 - 80 上がれるサビ", 120)).toBe("J-POP, 120 BPM 上がれるサビ");
  });

  // The quotative と and a full-size drawn-out え / お end an imperative too (上げろと, 上がれええ); a sentence-final よ / ぞ /
  // ね ends a dictionary form (上げるよ) and a 〜よ imperative (速めよー); 〜せず / 〜せぬ are negatives, not 〜せよ. A line
  // break ends an item as a comma does: no range, range guard or "NN BPM" across it. "BPM NN - NN" with a smaller second
  // number is no range: the first number alone ("BPM 128 - 64 bars intro").
  it("ends imperatives and items where Japanese and lines do, and reads no descending range", () => {
    for (const s of [
      "サビは BPM 50 上げろと言わんばかりの盛り上がり", "J-POP, BPM 50 上げろと", "BPM 60 落とせと", "BPMを50、上げろと", "BPMを50引けと",
      "BPM 50 上がれえええ", "BPM 50 上げろお",
      "BPMを50速めよー", "BPMを50高めよっ", "BPM 50速めよっ", "BPMが50落ちよー",
      "BPM 50 上げるよ", "BPMを50、上げるよ", "BPM 50 上げるぞ", "BPM 50 上げるね", "BPMを50、足すよ",
    ]) {
      expect(styleBpm(s), s).toBeNull();
    }
    for (const [s, bpm] of [
      ["rock, BPMが約50、下げろと, BPM 128", 128],
      ["サビで BPM 50 上げろおお、BPM 90 のロック", 90],
      ["サビで BPM 40 上げろと指示、テンポは BPM 95", 95],
      ["BPMが90速めよりのテンポ", 90],
      ["BPM 90 上がるような曲", 90],
      ["BPM90減速せずに駆け抜ける", 90],
      ["BPM90加速せず淡々と", 90],
      ["BPMが90加速せず一定、アウトロは BPM 60", 90],
      ["BPM 80減速せぬまま", 80],
      ["- lo-fi hip hop\n- BPM 85\n- 60% swing\n- vinyl crackle", 85],
      ["- BPM 92\n- 20%スウィング\n- サビは BPM 100", 92],
      ["BPM 85\r\n- 58% swing", 85],
      ["- Genre: lo-fi hip hop\n- BPM 85\n- 60% swing\n- Chorus: double-time feel, BPM 170", 85],
      ["Genre: trap\nDrums: TR-808\nBPM: 140\nMood: dark", 140],
      ["Instruments: piano, strings, 808\nBPM 140", 140],
      ["Key: A minor, capo 2\nBPM 100", 100],
      ["Tempo: BPM 90\n- 64 bars, then breakdown", 90],
      ["テンポ: BPM 90\n- 60秒のイントロ", 90],
      ["Tempo: BPM 60\n- 90 bars, then breakdown", 60],
      ["EDM, BPM 128 - 64 bars intro", 128],
      ["lo-fi - BPM 90 - 45 sec intro", 90],
      ["BPM 90 - 64 bars", 90],
      // an ascending range is still one
      ["BPM 120 - 130", 125],
      ["city pop, 60 ～ 70 bpm", 65],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
    expect(withStyleBpm("Genre: trap\nDrums: TR-808\nBPM: 140\nMood: dark", 137)).toBe("Genre: trap\nDrums: TR-808\n137 BPM\nMood: dark");
    expect(withStyleBpm("EDM, BPM 128 - 64 bars intro", 137)).toBe("EDM, 137 BPM - 64 bars intro");
    expect(withStyleBpm("Tempo: BPM 90\n- 64 bars, then breakdown", 137)).toBe("Tempo: 137 BPM\n- 64 bars, then breakdown");
  });

  // A descending "BPM NN - NN" is read where BPM_RE found it, never at a later statement. One that ends its item (spaced
  // or not) is its first number, replaced whole; one followed by more words is its first number alone where that can
  // stand alone ("BPM 128 - 64 bars"), else no tempo ("BPM 140-70 half-time"). 〜せず and 〜せぬ are the only negatives
  // of 〜せる: 加速せねば, 加速せざる, 加速せい and 加速せしめる are amounts.
  it("reads a descending pair at its own place, whole when it ends its item", () => {
    for (const [s, bpm] of [
      ["J-POP, BPM 150〜140, アウトロは BPM 80", 150],
      ["J-POP, BPM 150〜140", 150],
      ["ballad, BPM 80~70 rit., outro BPM 60", null],
      ["trance, BPM 140-138, breakdown BPM 70", 140],
      ["EDM, BPM 128-64 bars intro, outro BPM 90", null],
      // (a number below 40 that ends its item is a tempo, as "trap, BPM 30")
      ["BPM 30 - 20, outro BPM 90", 30],
      ["ダブステップ, BPM140〜70, サビはBPM 70のハーフタイム", 140],
      ["dubstep, BPM 140-70 half-time, サビはBPM 70", null],
      ["BPM 140-70に落として", null],
      ["drum and bass, BPM174-87", 174],
      ["trap, 808, BPM 140 - 70", 140],
    ] as const) {
      expect(styleBpm(s), s).toBe(bpm);
    }
    expect(withStyleBpm("J-POP, BPM 150〜140, アウトロは BPM 80", 137)).toBe("J-POP, 137 BPM, アウトロは BPM 80");
    expect(withStyleBpm("ダブステップ, BPM140〜70, サビはBPM 70のハーフタイム", 140)).toBe("ダブステップ, 140 BPM, サビはBPM 70のハーフタイム");
    expect(withStyleBpm("drum and bass, BPM174-87, intro BPM 87 half-time", 174)).toBe("drum and bass, 174 BPM, intro BPM 87 half-time");
    expect(withStyleBpm("drum and bass, BPM 174-87", 174)).toBe("drum and bass, 174 BPM");
    expect(withStyleBpm("trap, 808, BPM 140 - 70", 150)).toBe("trap, 808, 150 BPM");
    expect(withStyleBpm("drum and bass, BPM 174 - 87, rolling bass", 172)).toBe("drum and bass, 172 BPM, rolling bass");
    // a later statement is never rewritten for an earlier one that is no tempo
    expect(withStyleBpm("dubstep, BPM 140-70 half-time, サビはBPM 70", 140)).toBe("dubstep, BPM 140-70 half-time, サビはBPM 70, 140 BPM");
    for (const s of ["サビでBPMを50加速せねばならない", "BPMを50上昇せねばならない", "BPMを50減速せざるを得ない展開", "サビはBPM50加速せい", "BPMを50加速せしめる", "BPMを50低下せしめよ"]) {
      expect(styleBpm(s), s).toBeNull();
    }
    expect(styleBpm("BPM90減速せずに駆け抜ける")).toBe(90);
    expect(styleBpm("BPM 80減速せぬまま")).toBe(80);
  });

  it("ends a descending pair's item after any run of spaces and periods, in linear time", () => {
    // (the style editor strips one closing period before it looks for the tempo token: both must read the same)
    for (const s of ["ダブステップ, テンポはBPM140〜70..", "ダブステップ, テンポはBPM140〜70.", "ダブステップ、BPM140〜70。.", "ダブステップ, BPM 140 - 70 . .", "BPM140〜70...", "BPM140〜70．．, rock", "BPM140〜70..........", "BPM140〜70．．．．．, rock", "BPM140〜70" + ". 。．".repeat(40)]) {
      expect(styleBpm(s), s).toBe(140);
    }
    expect(withStyleBpm("ダブステップ, テンポはBPM140〜70..", 150)).toBe("ダブステップ, テンポは150 BPM..");
    expect(withStyleBpm("drum and bass, BPM174-87..", 150)).toBe("drum and bass, 150 BPM..");
    // followed by more words, the pair is still no tempo
    expect(styleBpm("ダブステップ, BPM140〜70.. half-time")).toBeNull();
    // runs of spaces, of periods and of both (31 characters first: an exponential variant fails there, not hangs)
    for (const length of [31, 100_000]) {
      for (const run of [" ", "\t", "　", ".", "。", "．", ". ", " 。", "　．", ".。．"]) {
        // (words follow: the first number, as in "EDM, BPM 128 - 64 bars intro")
        const s = "trap, BPM 140 - 70" + run.repeat(Math.ceil(length / run.length)) + "x";
        const t0 = performance.now();
        expect(styleBpm(s), JSON.stringify(run)).toBe(140);
        expect(performance.now() - t0, `${JSON.stringify(run)} × ${length}`).toBeLessThan(1000);
      }
    }
  });
});
