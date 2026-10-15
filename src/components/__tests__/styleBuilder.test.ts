import { describe, expect, it } from "vitest";
import { BPM_NONE_POSITION, GROUPS, applyChipChange, bpmFromSlider, bpmSliderPosition, composeStyle, emptySelection, rebuildFromChips, styleView, tempoClearable, type StyleSelection } from "../StyleBuilder";
import { styleBpm, withStyleBpm } from "../../lyrics/styleBpm";

const sel = (groups: Record<string, string[]>, bpm = 0): StyleSelection => ({ groups, bpm });

describe("applyChipChange", () => {
  it("rebuilds from the chips while the prompt is empty or still the chips' composition", () => {
    const prev = sel({ lang: ["Japanese"], inst: ["piano"] }, 120);
    const next = sel({ lang: ["Japanese"], inst: ["piano", "strings"] }, 120);
    expect(applyChipChange("", prev, next)).toBe(composeStyle(next));
    expect(applyChipChange(composeStyle(prev), prev, next)).toBe(composeStyle(next));
  });

  it("edits whole tokens only in hand-written prose", () => {
    const value = "Japanese, city pop, warm female vocal, Rhodes piano, slap bass, light drums, nostalgic, 104 BPM";
    const prev = sel({ lang: ["Japanese"], inst: ["piano"] }, 104);
    // removing "piano" leaves "Rhodes piano" alone
    expect(applyChipChange(value, prev, sel({ lang: ["Japanese"], inst: [] }, 104))).toBe(value);
    // adding a chip appends it before the tempo
    expect(applyChipChange(value, prev, sel({ lang: ["Japanese"], inst: ["piano", "808 bass"] }, 104))).toBe(
      "Japanese, city pop, warm female vocal, Rhodes piano, slap bass, light drums, nostalgic, 808 bass, 104 BPM",
    );
    // a chip already present (any case) is not duplicated
    expect(applyChipChange("japanese, dreamy pads", sel({}), sel({ lang: ["Japanese"] }))).toBe("japanese, dreamy pads");
  });

  it("replaces the previous value of a single-choice group", () => {
    const value = "Japanese, J-pop, female vocal, dreamy pads";
    const prev = sel({ lang: ["Japanese"], vocal: ["female vocal"] });
    expect(applyChipChange(value, prev, sel({ lang: ["English"], vocal: ["female vocal"] }))).toBe("English, J-pop, female vocal, dreamy pads");
    expect(applyChipChange(value, prev, sel({ lang: ["Japanese"], vocal: ["male vocal"] }))).toBe("Japanese, J-pop, male vocal, dreamy pads");
  });

  it("replaces the language / vocal the default style names even when no chip was selected", () => {
    // the default styles of the Cover and Compose pages, with the chips still empty
    const cover = "English, soulful jazz-pop, expressive male vocal, Rhodes piano, upright bass, brushed drums, 88 BPM";
    const compose = "Japanese, J-pop, bright female vocal, piano, acoustic guitar, light drums, hopeful, 120 BPM";
    const e = emptySelection();
    expect(applyChipChange(cover, e, sel({ lang: ["Japanese"] }, 0))).toBe(
      "Japanese, soulful jazz-pop, expressive male vocal, Rhodes piano, upright bass, brushed drums, 88 BPM",
    );
    expect(applyChipChange(compose, e, sel({ lang: ["English"] }, 0))).toBe(
      "English, J-pop, bright female vocal, piano, acoustic guitar, light drums, hopeful, 120 BPM",
    );
    expect(applyChipChange(compose, e, sel({ vocal: ["male vocal"] }, 0))).toBe(
      "Japanese, J-pop, bright male vocal, piano, acoustic guitar, light drums, hopeful, 120 BPM",
    );
    expect(applyChipChange(cover, e, sel({ vocal: ["female vocal"] }, 0))).toBe(
      "English, soulful jazz-pop, expressive female vocal, Rhodes piano, upright bass, brushed drums, 88 BPM",
    );
    // picking the value the style already names changes nothing
    expect(applyChipChange(compose, e, sel({ lang: ["Japanese"] }, 0))).toBe(compose);
  });

  it("resolves longer and shorter values of a single-choice group", () => {
    const e = emptySelection();
    expect(applyChipChange("pop, young female vocal, piano", e, sel({ vocal: ["female vocal"] }))).toBe("pop, female vocal, piano");
    expect(applyChipChange("pop, female vocal, piano", e, sel({ vocal: ["young female vocal"] }))).toBe("pop, young female vocal, piano");
    expect(applyChipChange("pop, deep male vocal, piano", e, sel({ vocal: ["female vocal"] }))).toBe("pop, female vocal, piano");
    // two conflicting languages collapse to the chosen one, in the place of the first
    expect(applyChipChange("Japanese, pop, English", e, sel({ lang: ["Korean"] }))).toBe("Korean, pop");
  });

  it("edits a tempo written inside wording in place", () => {
    const s0 = sel({}, 120);
    expect(applyChipChange("upbeat 120 BPM groove, piano", s0, sel({}, 130))).toBe("upbeat 130 BPM groove, piano");
    expect(applyChipChange("slow ballad at 60-70 BPM", s0, sel({}, 66))).toBe("slow ballad at 66 BPM");
    expect(applyChipChange("upbeat 120 BPM groove, piano", s0, sel({}, 0))).toBe("upbeat 120 BPM groove, piano");
    // the tempo the slider shows (the first one) is the one it edits; a second lone tempo token goes
    const both = "upbeat 120 BPM groove, Japanese, 96 BPM";
    const moved = applyChipChange(both, styleView(both, s0), { ...styleView(both, s0), bpm: 130 });
    expect(moved).toBe("upbeat 130 BPM groove, Japanese");
    expect(styleView(moved, s0).bpm).toBe(130);
    expect(applyChipChange("96 BPM, upbeat 120 BPM groove", sel({}, 96), sel({}, 130))).toBe("130 BPM, upbeat 120 BPM groove");
  });

  it("keeps exactly one tempo token while the slider moves", () => {
    let value = "warm piano pop, rounded bass";
    let s = sel({});
    for (const bpm of [90, 91, 92]) {
      const next = { ...s, bpm };
      value = applyChipChange(value, s, next);
      s = next;
    }
    expect(value).toBe("warm piano pop, rounded bass, 92 BPM");
    value = applyChipChange(value, s, { ...s, bpm: 0 });
    expect(value).toBe("warm piano pop, rounded bass");
  });

  it("keeps a closing period of free prose", () => {
    expect(applyChipChange("Upbeat indie pop with warm vocals.", sel({}), sel({ inst: ["strings"] }))).toBe("Upbeat indie pop with warm vocals, strings.");
  });

  it("has no instrumental chip (instrumentals use the dedicated workflow)", () => {
    expect(GROUPS.flatMap((g) => g.items).some((i) => /instrumental/i.test(i.en))).toBe(false);
    expect(composeStyle(emptySelection())).toBe("");
  });
});

describe("applyChipChange keeps regional instruments and genres", () => {
  const english = sel({ lang: ["English"] });
  for (const prev of [emptySelection(), sel({ lang: ["Japanese"] })]) {
    const from = prev.groups.lang?.length ? "from Japanese" : "from nothing";
    it(`swaps only the language statement (${from})`, () => {
      expect(applyChipChange("Japanese, city pop, Japanese koto, 104 BPM", prev, english)).toBe("English, city pop, Japanese koto, 104 BPM");
      expect(applyChipChange("nostalgic Japanese city pop with a warm female vocal", prev, english)).toBe("nostalgic Japanese city pop with a warm female vocal, English");
      expect(applyChipChange("Korean gayageum, pop", prev, sel({ lang: ["Korean"] }))).toBe("Korean gayageum, pop, Korean");
    });
  }

  it("still swaps language statements inside wording", () => {
    expect(applyChipChange("J-pop, Japanese lyrics, piano", emptySelection(), sel({ lang: ["English"] }))).toBe("J-pop, English lyrics, piano");
    expect(applyChipChange("ballad, sung in Japanese", emptySelection(), sel({ lang: ["English"] }))).toBe("ballad, sung in English");
    expect(applyChipChange("bright female vocal with reverb, pop", emptySelection(), sel({ vocal: ["male vocal"] }))).toBe("bright male vocal with reverb, pop");
  });

  it("recognises common wordings of a language statement", () => {
    const toEnglish = (v: string) => applyChipChange(v, sel({ lang: ["Japanese"] }), sel({ lang: ["English"] }));
    expect(toEnglish("bright Japanese female vocal, J-pop")).toBe("bright English female vocal, J-pop");
    expect(toEnglish("female Japanese vocals, J-pop")).toBe("female English vocals, J-pop");
    expect(toEnglish("Japanese vocal harmonies, pop")).toBe("English vocal harmonies, pop");
    expect(toEnglish("Japanese female vocal with reverb, pop")).toBe("English female vocal with reverb, pop");
    expect(toEnglish("pop, vocals in Japanese")).toBe("pop, vocals in English");
    expect(toEnglish("Japanese-language lyrics, pop")).toBe("English-language lyrics, pop");
    expect(toEnglish("Japanese rap, trap beat")).toBe("English rap, trap beat");
    // the statement's language is swapped, not an earlier regional instrument
    expect(toEnglish("Japanese koto and Japanese female vocal")).toBe("Japanese koto and English female vocal");
    // every statement in a token is swapped, a regional instrument stays
    expect(toEnglish("Japanese female vocal and Japanese choir")).toBe("English female vocal and English choir");
    expect(toEnglish("Japanese koto, Japanese female vocal and Japanese choir")).toBe("Japanese koto, English female vocal and English choir");
    // "Mandarin Chinese" is one language name
    const mandarinToEnglish = (v: string) => applyChipChange(v, sel({ lang: ["Mandarin"] }), sel({ lang: ["English"] }));
    expect(mandarinToEnglish("Mandarin Chinese vocals, ballad")).toBe("English vocals, ballad");
    expect(mandarinToEnglish("Mandarin vocals, Chinese guzheng")).toBe("English vocals, Chinese guzheng");
    expect(mandarinToEnglish("Mandarin Chinese, ballad")).toBe("English, ballad");
    expect(mandarinToEnglish("Mandarin-Chinese, ballad")).toBe("English, ballad");
    // a regional genre / instrument in front of the vocal is not a statement
    expect(toEnglish("Japanese city pop vocal, piano")).toBe("Japanese city pop vocal, piano, English");
    expect(toEnglish("Japanese koto with vocals")).toBe("Japanese koto with vocals, English");
    // the new language already stated: nothing appended
    expect(applyChipChange("pop, bright English female vocal", sel({}), sel({ lang: ["English"] }))).toBe("pop, bright English female vocal");
  });
});

describe("tempo control", () => {
  it("shows the tempo the prompt states, whatever the chips hold", () => {
    expect(styleView("Japanese, J-pop, hopeful, 120 BPM", emptySelection()).bpm).toBe(120);
    expect(styleView("city pop, 96 BPM", sel({ genre: ["city pop"] }, 0))).toEqual(sel({ genre: ["city pop"] }, 96));
    expect(styleView("warm piano pop", sel({}, 100)).bpm).toBe(0);
  });

  it("maps the leftmost slider position to no tempo and keeps the range 40-220", () => {
    expect(bpmFromSlider(BPM_NONE_POSITION)).toBe(0);
    expect(bpmFromSlider(5)).toBe(0);
    expect(bpmFromSlider(40)).toBe(40);
    expect(bpmFromSlider(250)).toBe(220);
    expect(bpmSliderPosition(0)).toBe(BPM_NONE_POSITION);
    expect(bpmSliderPosition(96)).toBe(96);
    expect(bpmSliderPosition(240)).toBe(220); // a fast score tempo sits at the right end
  });

  it("moves only the tempo token of the prompt", () => {
    const value = "Japanese, city pop, warm female vocal, 96 BPM";
    const view = styleView(value, emptySelection());
    expect(applyChipChange(value, view, { ...view, bpm: 104 })).toBe("Japanese, city pop, warm female vocal, 104 BPM");
    expect(applyChipChange(value, view, { ...view, bpm: 0 })).toBe("Japanese, city pop, warm female vocal");
    // "BPM 128 - 64 bars": a smaller number after the dash is no range end (64 counts bars): only "BPM 128" moves
    const bars = "EDM, BPM 128 - 64 bars intro";
    const barsView = styleView(bars, emptySelection());
    expect(barsView.bpm).toBe(128);
    expect(applyChipChange(bars, barsView, { ...barsView, bpm: 137 })).toBe("EDM, 137 BPM - 64 bars intro");
    // a descending pair that ends its item is the tempo token, read and replaced whole; a later statement is left alone
    const dub = "ダブステップ, BPM140〜70, サビはBPM 70のハーフタイム";
    const dubView = styleView(dub, emptySelection());
    expect(dubView.bpm).toBe(140);
    expect(applyChipChange(dub, dubView, { ...dubView, bpm: 150 })).toBe("ダブステップ, 150 BPM, サビはBPM 70のハーフタイム");
    const dnb = "drum and bass, BPM 174-87";
    const dnbView = styleView(dnb, emptySelection());
    expect(applyChipChange(dnb, dnbView, { ...dnbView, bpm: 100 })).toBe("drum and bass, 100 BPM");
    // the slider and the score sync agree, and the synced tempo can still be cleared
    const trap = "trap, 808, BPM 140 - 70";
    const trapView = styleView(trap, emptySelection());
    expect(applyChipChange(trap, trapView, { ...trapView, bpm: 150 })).toBe(withStyleBpm(trap, 150));
    const synced = withStyleBpm(trap, 150);
    expect(tempoClearable(synced, styleView(synced, emptySelection()))).toBe(true);
    // also after two closing periods (the editor strips one): the slider, the sync and a chip read the same tempo
    for (const dots of ["ダブステップ, テンポはBPM140〜70..", "ダブステップ、BPM140〜70。.", "drum and bass, BPM174-87..", "ダブステップ, テンポはBPM140〜70.....", "drum and bass, BPM174-87．．．．．"]) {
      const view = styleView(dots, emptySelection());
      expect(view.bpm, dots).toBe(styleBpm(dots) ?? 0);
      expect(applyChipChange(dots, view, { ...view, bpm: 150 }), dots).toBe(withStyleBpm(dots, 150));
      const chip = applyChipChange(dots, view, { ...view, groups: { genre: ["rock"] } });
      expect(styleView(chip, emptySelection()).bpm, chip).toBe(view.bpm);
    }
  });

  it("reaches 「指定なし」 for a tempo range token", () => {
    for (const value of ["city pop, 60-70 BPM", "city pop, 60〜70 BPM", "city pop, 60 ～ 70 bpm"]) {
      const view = styleView(value, emptySelection());
      expect(view.bpm).toBe(65);
      expect(tempoClearable(value, view)).toBe(true);
      expect(applyChipChange(value, view, { ...view, bpm: 0 })).toBe("city pop");
      // moving the slider replaces the whole range
      expect(applyChipChange(value, view, { ...view, bpm: 90 })).toBe("city pop, 90 BPM");
    }
    expect(applyChipChange("city pop, 60-70 BPM.", sel({}, 65), sel({}, 0))).toBe("city pop");
    // every lone tempo token goes, so the slider does not jump back to a second one
    expect(applyChipChange("city pop, 96 BPM, 100 BPM", sel({}, 96), sel({}, 0))).toBe("city pop");
  });

  it("treats a lone tempo item in any form the tempo sync reads as the tempo token", () => {
    for (const [tempo, bpm] of [
      ["BPM 140", 140],
      ["BPM:140", 140],
      ["bpm=140", 140],
      ["１４０ＢＰＭ", 140],
      ["8 BPM", 8],
      ["1200 BPM", 1200],
      ["BPMは140", 140],
      ["BPMが140", 140],
      ["BPM約140", 140],
      ["BPM: ~140", 140],
      ["BPM：～１４０", 140],
      ["BPM (140)", 140],
      ["ＢＰＭ（１４０）", 140],
      ["140 beats-per-minute", 140],
      // after the particles を, も, で or a reading comma, an "about" word or "of", in square brackets
      ["BPMを140", 140],
      ["BPMも140", 140],
      ["BPMで140", 140],
      ["BPMは、140", 140],
      ["BPMはおよそ140", 140],
      ["BPM around 140", 140],
      ["BPM approx. 140", 140],
      ["BPM of 140", 140],
      ["BPM [140]", 140],
      ["BPM【140】", 140],
    ] as const) {
      const value = `city pop, ${tempo}`;
      const view = styleView(value, emptySelection());
      expect(view.bpm, tempo).toBe(bpm);
      // 「指定なし」 is offered and removes it; the slider replaces it
      expect(tempoClearable(value, view), tempo).toBe(true);
      expect(applyChipChange(value, view, { ...view, bpm: 0 }), tempo).toBe("city pop");
      expect(applyChipChange(value, view, { ...view, bpm: 90 }), tempo).toBe("city pop, 90 BPM");
      // a chip goes before it (the tempo stays last), and its closing period stays its own
      expect(applyChipChange(value, view, { ...view, groups: { mood: ["hopeful"] } }), tempo).toBe(`city pop, hopeful, ${tempo}`);
      expect(applyChipChange(`${value}.`, view, { ...view, bpm: 90 }), tempo).toBe("city pop, 90 BPM.");
    }
    // the second of two lone items goes too
    expect(applyChipChange("city pop, 96 BPM, BPM 100", sel({}, 96), sel({}, 110))).toBe("city pop, 110 BPM");
  });

  it("moves the tempo item the slider shows when the style states two in both forms", () => {
    // styleBpm prefers a "NN BPM" anywhere over an earlier "BPM NN": the slider shows 120 and edits that item
    const value = "BPM 140 rock, 120 BPM";
    const view = styleView(value, emptySelection());
    expect(view.bpm).toBe(120);
    const moved = applyChipChange(value, view, { ...view, bpm: 130 });
    expect(moved).toBe("BPM 140 rock, 130 BPM");
    expect(styleView(moved, emptySelection()).bpm).toBe(130);
  });

  it("shows no tempo for a number after BPM used as a modifier, out of tempo range or below 40 counting a word (medium BPM 808, 高BPM 16ビート)", () => {
    for (const value of [
      "Japanese, trap, medium BPM 808 drums",
      "トラップ, 高BPM 808ベース",
      "ｈｉｇｈ ＢＰＭ ８０８",
      "trap, BPM 808",
      "J-POP, 高BPM 16ビート",
      "Japanese, trap, high BPM 16 beat hats",
      "medium BPM 32 bars",
      "ｈｉｇｈ ＢＰＭ １６ ｂｅａｔ",
      "J-POP, 高BPM 16ステップ",
      "high BPM 12 string",
      "rock, BPMが16ビート",
      "trap, BPM: ~808",
      // a percentage or an amount of change after BPM
      "J-POP, サビでBPMが10%上がる",
      "ロック, BPMは20％遅め",
      "rock, BPM約10%アップ",
      "rock, BPM 10% up",
      "サビだけBPMが40上がる",
      "サビでBPMを50上げて",
      "rock, BPM +10",
      // also after a hedge
      "サビでBPMを50くらい上げて",
      "サビだけBPMが40くらい上がる",
      "BPMを50ほどアップして",
      // the other words of raising or lowering
      "サビでBPMを50落として",
      "BPMを40速くして",
      "BPMを50遅くして",
      "BPMを40増やして",
      "BPMを50減らして",
      "BPMを50ぐらい速くして",
      "サビでBPMが50速くなる",
      "BPMが50落ちる",
      // the hiragana and 引き forms, the verb 落ちる, and after が a space ends no tag
      "BPMを50あげて",
      "BPMを50さげて",
      "BPMを50おとして",
      "BPMを50引き上げて",
      "BPMを60引き下げて",
      "BPMを40引上げ",
      "BPMが50落ちて",
      "サビだけBPMが40 上がる",
      // the other hiragana forms and the verbs 遅らせる, 上昇させる and 低下させる
      "BPMを50引きあげて",
      "BPMを50ひきあげて",
      "BPMを50ひきさげて",
      "BPMを50はやくして",
      "BPMを50おそくして",
      "BPMを50ふやして",
      "BPMを50へらして",
      "BPMを50はやめて",
      "BPMが50おちる",
      "BPMを50遅らせて",
      "BPMを50上昇させて",
      "BPMを60低下させて",
      // in a tag list a verb after a space, or a word after a hedge after a space
      "サビでBPM 50 上げて",
      "サビでBPM 50 アップして",
      "Cメロ BPM 60 下げる",
      "2番から BPM 40 上げる",
      "Cメロで BPM 60 落として",
      "BPM 50 速くして",
      "BPM 50 増やして",
      "BPMは50 上げて",
      "rock, BPM 95.5 落とす",
      "rock, BPM 40-50 落として",
      "BPM 50 くらい上げて",
      "ラスサビで BPM 50 くらい上げて",
      "間奏で BPM 50 ほど落とす",
      "BPM 50 程度アップ",
      "BPM 50くらい 上げて",
      // after を, が or も more words make an amount (高く, 加速, 速めに), also an arrow, a reading comma or brackets before the word
      "サビでBPMを40高くして",
      "サビでBPMを40高める",
      "サビだけBPMを40速めに",
      "サビでBPMを40加速",
      "サビでBPMを40上昇",
      "サビでBPMを40程度、上げて",
      "サビはBPMが50加速",
      "BPMが60低下",
      "BPMが50速い",
      "BPMを60減速",
      "BPMを50位上げて",
      "BPMを50足して",
      "BPMを50増",
      "BPMも40低く",
      "J-POP, サビでBPMが20↑",
      "BPMは20↑",
      "BPM約20↑",
      "BPMを20↓",
      "BPMを20、上げて",
      "BPMを20!上げて",
      "BPMを（20）上げて",
      "BPMを[20]上げて",
      "BPMが【20】アップ",
    ]) {
      const view = styleView(value, emptySelection());
      expect(view.bpm, value).toBe(0);
      expect(bpmSliderPosition(view.bpm), value).toBe(BPM_NONE_POSITION);
      expect(tempoClearable(value, view), value).toBe(true);
      // the slider adds its tempo and leaves the 808 alone
      expect(applyChipChange(value, view, { ...view, bpm: 96 }), value).toBe(`${value}, 96 BPM`);
    }
  });

  it("shows and moves a tempo after a slash tag, on its own line or after a space-separated or attached Japanese tag (ロック/120BPM, ロック BPM120, テンポはBPM120)", () => {
    for (const [value, bpm, moved] of [
      ["ロック/120BPM", 120, "ロック/130 BPM"],
      ["J-POP/女性ボーカル/120BPM", 120, "J-POP/女性ボーカル/130 BPM"],
      ["Rock/120 BPM", 120, "Rock/130 BPM"],
      ["Japanese, J-pop, female vocal\nBPM 140", 140, "Japanese, J-pop, female vocal\n130 BPM"],
      ["J-POP 女性ボーカル BPM120", 120, "J-POP 女性ボーカル 130 BPM"],
      ["ロック　ＢＰＭ１４０", 140, "ロック　130 BPM"],
      ["Japanese, rock BPM: 140", 140, "Japanese, rock 130 BPM"],
      ["テンポはBPM120", 120, "テンポは130 BPM"],
      ["J-POP、女性ボーカルBPM128", 128, "J-POP、女性ボーカル130 BPM"],
      ["ロック, 高BPM 140", 140, "ロック, 高130 BPM"],
      // a particle (は, が), 約 or a tilde, brackets or another dash between BPM and its tempo: a lone tempo item,
      // replaced whole
      ["J-POP, BPMは140", 140, "J-POP, 130 BPM"],
      ["J-POP, BPMが140", 140, "J-POP, 130 BPM"],
      ["rock, BPM約140", 140, "rock, 130 BPM"],
      ["rock, BPM: ~140", 140, "rock, 130 BPM"],
      ["ロック, BPM：～140", 140, "ロック, 130 BPM"],
      ["rock, BPM (140), piano", 140, "rock, 130 BPM, piano"],
      ["rock, BPM ‐ 140", 140, "rock, 130 BPM"],
      ["rock, 140 beats-per-minute", 140, "rock, 130 BPM"],
      // and inside wording, edited in place, also before a word that names beats
      ["ロック BPMは約140", 140, "ロック 130 BPM"],
      ["ロック, BPMが140くらいの疾走感", 140, "ロック, 130 BPMくらいの疾走感"],
      ["J-POP, BPMを140くらいに", 140, "J-POP, 130 BPMくらいに"],
      ["ロック, BPMはだいたい140くらい", 140, "ロック, 130 BPMくらい"],
      ["rock, a BPM of around 140", 140, "rock, a 130 BPM"],
      ["J-POP, BPM140 アップテンポ", 140, "J-POP, 130 BPM アップテンポ"],
      ["J-POP, BPM128 アップな曲調", 128, "J-POP, 130 BPM アップな曲調"],
      ["J-POP, BPM 140 上がる曲", 140, "J-POP, 130 BPM 上がる曲"],
      ["J-POP, BPM 140 速くて重い", 140, "J-POP, 130 BPM 速くて重い"],
      ["ロック, BPMを140に落として", 140, "ロック, 130 BPMに落として"],
      ["バラード, BPM 70 落ち着いたピアノ", 70, "バラード, 130 BPM 落ち着いたピアノ"],
      // 落ちサビ and 落ち込んだ lower no tempo, and in a tag list a word after a space is a tag of its own
      ["J-POP 女性ボーカル BPM90 落ちサビあり", 90, "J-POP 女性ボーカル 130 BPM 落ちサビあり"],
      ["J-POP 女性ボーカル BPM 90 落ちサビ ピアノ", 90, "J-POP 女性ボーカル 130 BPM 落ちサビ ピアノ"],
      ["バラード, BPM 60 落ち込んだ雰囲気", 60, "バラード, 130 BPM 落ち込んだ雰囲気"],
      ["BPMは90 落ちサビで60", 90, "130 BPM 落ちサビで60"],
      ["バラード BPM 70 遅くて切ない", 70, "バラード 130 BPM 遅くて切ない"],
      ["BPM 95 早くない", 95, "130 BPM 早くない"],
      ["ロック BPM 80 ダウン系", 80, "ロック 130 BPM ダウン系"],
      ["BPM 90 上げ曲", 90, "130 BPM 上げ曲"],
      ["BPM 80 プラスα", 80, "130 BPM プラスα"],
      // はやくち (早口), おちつく and the noun 上昇 raise or lower nothing
      ["ヒップホップ, BPM90はやくちラップ", 90, "ヒップホップ, 130 BPMはやくちラップ"],
      ["バラード, BPMが60おちついた雰囲気", 60, "バラード, 130 BPMおちついた雰囲気"],
      ["J-POP, BPM90上昇感のあるサビ", 90, "J-POP, 130 BPM上昇感のあるサビ"],
      // a form that describes the next word or another form of the verb after a space starts a tag
      ["BPM 90 上がる曲", 90, "130 BPM 上がる曲"],
      ["J-POP BPM 80 落ちる系", 80, "J-POP 130 BPM 落ちる系"],
      ["ロック, BPM 70くらい 落とした感じ", 70, "ロック, 130 BPMくらい 落とした感じ"],
      ["J-POP 女性ボーカル BPM128 ビート強め ピアノ", 128, "J-POP 女性ボーカル 130 BPM ビート強め ピアノ"],
      ["hip hop, BPM 90 beats", 90, "hip hop, 130 BPM beats"],
      // a tempo below 40 that ends its item is shown too
      ["ambient, BPM 30", 30, "ambient, 130 BPM"],
    ] as const) {
      const view = styleView(value, emptySelection());
      expect(view.bpm, value).toBe(bpm);
      // the slider edits that tempo in place instead of adding a second one
      expect(applyChipChange(value, view, { ...view, bpm: 130 }), value).toBe(moved);
      expect(styleView(moved, emptySelection()).bpm, value).toBe(130);
    }
  });

  it("offers no 「指定なし」 end while the tempo sits inside wording", () => {
    const value = "upbeat 120 BPM groove, piano";
    const view = styleView(value, emptySelection());
    expect(tempoClearable(value, view)).toBe(false);
    expect(tempoClearable("upbeat 120 BPM groove, 96 BPM", styleView("upbeat 120 BPM groove, 96 BPM", emptySelection()))).toBe(false);
    expect(tempoClearable("piano, 96 BPM", styleView("piano, 96 BPM", emptySelection()))).toBe(true);
    expect(tempoClearable("piano", styleView("piano", emptySelection()))).toBe(true);
  });

  it("offers the rebuild from chips only when a chip is selected", () => {
    const value = "Japanese, J-pop, hopeful, 96 BPM";
    expect(rebuildFromChips(value, styleView(value, emptySelection()))).toBeNull();
    const chips = styleView(value, sel({ genre: ["rock"] }));
    expect(rebuildFromChips(value, chips)).toBe("rock, 96 BPM"); // keeps the prompt's tempo
    expect(rebuildFromChips("rock, 96 BPM", styleView("rock, 96 BPM", sel({ genre: ["rock"] })))).toBeNull();
  });
});
