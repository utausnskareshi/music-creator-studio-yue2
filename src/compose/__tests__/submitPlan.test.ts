import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChoiceRequest } from "../../components/ChoiceDialog";
import { parseAbc } from "../../abc/parse";
import { AcceptedAdvice } from "../scoreAdvice";
import { durationBudget, scoreMarginSeconds, statedAbcTempo } from "../rules";
import { withStyleBpm } from "../../lyrics/styleBpm";
import { COMPOSE_MISMATCH_MESSAGE, NO_WORDS_NOTE, SubmitGuard, draftReplaces, planSubmission, singleClick, type PlanInput } from "../submitPlan";

const fx = (name: string) => readFileSync(join(__dirname, "..", "..", "abc", "__fixtures__", name), "utf8");
const CHORDS = fx("official_score.abc"); // Q:88, chords, native, % verse / % chorus
const MELODY = fx("official_melody.abc"); // Q:88, no chords
const LONG = fx("full_long.abc"); // about 200 s, 8 sung sections
const UNPARSABLE = `${CHORDS}V: Bass\nC4D4E4F4|\n`;
const SUNG = "[Verse]\nあさのひかりが\n[Chorus]\nはしりだそう";

/** An ask() that answers from a script and records the questions. */
function scripted(...answers: (string | null)[]) {
  const asked: ChoiceRequest<string>[] = [];
  const ask = async <T extends string>(r: ChoiceRequest<T>): Promise<T | null> => {
    asked.push(r as ChoiceRequest<string>);
    return (answers.shift() ?? null) as T | null;
  };
  return { ask, asked };
}

function input(p: Partial<PlanInput> = {}): PlanInput {
  return {
    formMode: "full",
    formAbc: "",
    formStyle: "Japanese, J-pop, 88 BPM",
    sung: SUNG,
    formLyrics: true,
    over: {},
    durations: { auto: true, manual: 360, limit: 900, defaultMax: 360, fallbackEstimate: 60 },
    ...p,
  };
}

function deps(ask: ReturnType<typeof scripted>["ask"], acceptedAdvice = new AcceptedAdvice(), estimate = async () => 60) {
  return { ask, acceptedAdvice, estimateDuration: estimate };
}

describe("planSubmission: mode matched to the form's score", () => {
  it("switches Full to Melody without asking when the score has no chords", async () => {
    const { ask, asked } = scripted();
    const plan = await planSubmission(input({ formAbc: MELODY }), deps(ask));
    expect(asked).toHaveLength(0);
    expect(plan?.mode).toBe("melody");
    expect(plan?.formChanges.mode).toBe("melody");
    expect(plan?.notes).toContain("譜面にコードがないため Melody モードに切り替えました");
  });

  it("strips the chords of a chord score in Melody, or switches to Full", async () => {
    const strip = scripted("strip");
    const a = await planSubmission(input({ formMode: "melody", formAbc: CHORDS }), deps(strip.ask));
    expect(strip.asked[0].choices.map((c) => c.value)).toEqual(["strip", "full"]);
    expect(a?.mode).toBe("melody");
    expect(a?.formChanges.abc).toBe(a?.abc);
    expect(parseAbc(a!.abc).chords).toHaveLength(0);
    expect(a?.formChanges.mode).toBeUndefined();

    const full = scripted("full");
    const b = await planSubmission(input({ formMode: "melody", formAbc: CHORDS }), deps(full.ask));
    expect(b?.mode).toBe("full");
    expect(b?.formChanges).toEqual({ mode: "full" });
    expect(b?.abc).toBe(CHORDS);
    // every bar is a whole bar: nothing about bar lines
    expect(strip.asked[0].details).toBeUndefined();
    expect(a?.notes).toEqual(["譜面のコードを削除しました"]);
  });

  it("says before and after a chord strip that the bar lines after a short or long bar move", async () => {
    // a pickup bar: the stripped score is written on the meter's bar grid, so the "C" bar starts on beat 2
    const pickup = CHORDS.replace(/% verse[\s\S]*$/, '% verse\nV: Vocal\nG4|"C"c4B4A4G4|"F"A16|\nV: Ins\nz4|C16|F16|\n');
    const strip = scripted("strip", "send");
    const a = await planSubmission(input({ formMode: "melody", formAbc: pickup }), deps(strip.ask));
    expect(strip.asked[0].title).toBe("コード付きの譜面です");
    expect(strip.asked[0].details).toEqual(["小節の長さが拍子と合わない小節があります（ボーカル 1 小節目・伴奏声部 1 小節目）。コードを削除すると、それより後の小節線は拍子どおりの位置に書き直されます（Full モードでは譜面をそのまま送ります）"]);
    expect(a?.formChanges.abc).toBe(a?.abc);
    expect(a?.notes).toContain("小節の長さが拍子と合わない小節があったため（ボーカル 1 小節目・伴奏声部 1 小節目）、それより後の小節線を拍子どおりの位置に書き直しました（音の時間位置は変わりません）");

    // Full sends the score as written
    const full = scripted("full", "send");
    const b = await planSubmission(input({ formMode: "melody", formAbc: pickup }), deps(full.ask));
    expect(b?.abc).toBe(pickup);
    expect(b?.notes.some((n) => n.includes("小節線"))).toBe(false);
  });

  it("offers only Full for a chord score the parser rejects, then asks about the findings", async () => {
    const { ask, asked } = scripted("full", "send");
    const plan = await planSubmission(input({ formMode: "melody", formAbc: UNPARSABLE }), deps(ask));
    expect(asked[0].choices.map((c) => c.value)).toEqual(["full"]);
    expect(asked[1].title).toBe("譜面の確認");
    expect(asked[1].choices[0].label).toBe("非ネイティブ記法のまま送信");
    expect(plan?.mode).toBe("full");
  });

  it("sends in off mode without a score", async () => {
    const { ask, asked } = scripted();
    const plan = await planSubmission(input({ formMode: "off", formAbc: CHORDS }), deps(ask));
    expect(asked).toHaveLength(0);
    expect(plan?.abc).toBe("");
    expect(plan?.style).toBe("Japanese, J-pop, 88 BPM");
  });
});

describe("planSubmission: callers' scores", () => {
  it("stays silent for the instrumental render (a score without adviseScore)", async () => {
    const { ask, asked } = scripted();
    const plan = await planSubmission(input({ over: { mode: "melody", abc: UNPARSABLE, style: "piano, 88 BPM" } }), deps(ask));
    expect(asked).toHaveLength(0);
    expect(plan?.mode).toBe("melody");
    expect(plan?.formChanges).toEqual({});
  });

  it("asks about the editor's score (adviseScore) but never switches its mode", async () => {
    const { ask, asked } = scripted("send");
    const plan = await planSubmission(input({ over: { mode: "full", abc: LONG, adviseScore: true } }), deps(ask));
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toBe(COMPOSE_MISMATCH_MESSAGE);
    expect(asked[0].choices[0].label).toBe("このまま送信");
    expect(plan?.mode).toBe("full");
    expect(plan?.formChanges.mode).toBeUndefined();
  });
});

describe("planSubmission: style tempo", () => {
  it("rewrites the style to the score's Q: and the form only without a style override", async () => {
    const { ask } = scripted();
    const own = await planSubmission(input({ formAbc: CHORDS, formStyle: "pop, 120 BPM" }), deps(ask));
    expect(own?.style).toBe("pop, 88 BPM");
    expect(own?.formChanges.styleBpm).toBe(88);
    expect(own?.notes).toContain("スタイルの BPM を譜面の Q: に合わせました（88 BPM）");

    const over = await planSubmission(input({ over: { mode: "full", abc: CHORDS, style: "rock" } }), deps(ask));
    expect(over?.style).toBe("rock, 88 BPM");
    expect(over?.formChanges.styleBpm).toBeUndefined();
  });

  it("leaves a style that already names the tempo alone", async () => {
    const { ask } = scripted();
    const plan = await planSubmission(input({ formAbc: CHORDS }), deps(ask));
    expect(plan?.formChanges).toEqual({});
    expect(plan?.notes.some((n) => n.includes("BPM"))).toBe(false);
  });

  it("makes up no tempo when the chords of a score without Q: are stripped", async () => {
    const noQ = CHORDS.replace(/^Q:.*\r?\n/m, "");
    expect(statedAbcTempo(noQ)).toBeNull();
    // the style names a tempo: the stripped score takes it as its Q: and the style stays as it is
    const a = scripted("strip");
    const styled = await planSubmission(input({ formMode: "melody", formAbc: noQ, formStyle: "Japanese, J-pop, 96 BPM" }), deps(a.ask));
    expect(a.asked.map((r) => r.title)).toEqual(["コード付きの譜面です"]);
    expect(styled?.style).toBe("Japanese, J-pop, 96 BPM");
    expect(styled?.formChanges.styleBpm).toBeUndefined();
    expect(styled?.formChanges.abc).toBe(styled?.abc);
    expect(statedAbcTempo(styled!.abc)).toBe(96);
    expect(parseAbc(styled!.abc).chords).toHaveLength(0);
    expect(styled?.notes.some((n) => n.includes("BPM"))).toBe(false);

    // no tempo anywhere: the stripped score still has no Q: (the native check reports it) and the style is left alone
    const b = scripted("strip", "send");
    const plain = await planSubmission(input({ formMode: "melody", formAbc: noQ, formStyle: "Japanese, J-pop" }), deps(b.ask));
    expect(b.asked.map((r) => r.title)).toEqual(["コード付きの譜面です", "譜面の確認"]);
    expect(b.asked[1].details?.some((d) => d.includes("Q:1/4="))).toBe(true);
    expect(plain?.style).toBe("Japanese, J-pop");
    expect(plain?.formChanges.styleBpm).toBeUndefined();
    expect(statedAbcTempo(plain!.abc)).toBeNull();
    expect(parseAbc(plain!.abc).chords).toHaveLength(0);
  });

  it("keeps a Q: the parser reads when the chords are stripped, also a text or C= form", async () => {
    for (const q of ['Q:"Allegro" 1/4=96', "Q:C=96"]) {
      const score = CHORDS.replace(/^Q:.*$/m, q);
      // statedAbcTempo reads the same Q: forms as the parser (rules.ts, g23f1)
      expect(statedAbcTempo(score), q).toBe(96);
      expect(parseAbc(score).bpm, q).toBe(96);
      // the score's 96 is written as its Q: and the style follows it, not the other way round
      const a = scripted("strip", "send");
      const styled = await planSubmission(input({ formMode: "melody", formAbc: score, formStyle: "Japanese, J-pop, 120 BPM" }), deps(a.ask));
      expect(a.asked[0].title, q).toBe("コード付きの譜面です");
      expect(styled?.abc, q).toMatch(/^Q:1\/4=96$/m);
      expect(styled?.style, q).toBe("Japanese, J-pop, 96 BPM");
      expect(styled?.formChanges.styleBpm, q).toBe(96);
      // with no style tempo the Q: is kept too
      const b = scripted("strip", "send");
      const plain = await planSubmission(input({ formMode: "melody", formAbc: score, formStyle: "Japanese, J-pop" }), deps(b.ask));
      expect(plain?.abc, q).toMatch(/^Q:1\/4=96$/m);
      expect(plain?.style, q).toBe("Japanese, J-pop, 96 BPM");
    }
  });

  it("reads no tempo out of a decade after BPM, so the style is not rewritten inside the word", async () => {
    const score = CHORDS.replace(/^Q:.*$/m, "Q:1/4=140");
    let formStyle = "Japanese, energetic high-BPM 90s eurobeat, female vocal";
    const first = await planSubmission(input({ formAbc: score, formStyle }), deps(scripted("send").ask));
    expect(first?.style).toBe("Japanese, energetic high-BPM 90s eurobeat, female vocal, 140 BPM");
    expect(first?.formChanges.styleBpm).toBe(140);
    formStyle = withStyleBpm(formStyle, first!.formChanges.styleBpm!);
    const second = await planSubmission(input({ formAbc: score, formStyle }), deps(scripted("send").ask));
    expect(second?.style).toBe(formStyle);
    expect(second?.formChanges.styleBpm).toBeUndefined();
  });

  it("leaves a number after BPM that is no tempo alone (medium BPM 808 drums, 高BPM 16ビート), also as the Q: of a stripped score", async () => {
    for (const style of [
      "Japanese, trap, medium BPM 808 drums",
      "J-POP, 高BPM 16ビート",
      "Japanese, trap, high BPM 16 beat hats",
      "medium BPM 32 bars",
      "J-POP, 高BPM 16ステップ",
      "high BPM 12 string",
      "rock, BPMが16ビート",
      "rock, BPM: ~16 beat",
      // a percentage or an amount of change after BPM (no Q:1/4=10 for "10%")
      "J-POP, サビでBPMが10%上がる",
      "ロック, BPMは20%遅め",
      "rock, BPM約10%アップ",
      "BPMは20％遅め",
      "rock, BPM 10% up",
      "サビだけBPMが40上がる",
      "サビでBPMを50上げて",
      // also after a hedge (no Q:1/4=50 for "50くらい上げて")
      "サビでBPMを50くらい上げて",
      "サビでBPMを40ほど下げて",
      "BPMを50程度上げて",
      "サビだけBPMが40くらい上がる",
      "BPMが40くらいアップ",
      // the other words of raising or lowering (no Q:1/4=50 for "50落として")
      "サビでBPMを50落として",
      "サビでBPMを40 落とす",
      "BPMを40速くして",
      "BPMを50遅くして",
      "BPMを40増やして",
      "BPMを50減らして",
      "BPMを50ほど落として",
      "BPMを50ぐらい速くして",
      "サビでBPMが50速くなる",
      "BPMが40遅くなる",
      "BPMが50落ちる",
      "BPMを50以上も落として",
      // the hiragana and 引き forms and the verb 落ちる (no Q:1/4=50 for "50あげて"), also after が and a space
      "BPMを50あげて",
      "BPMを50さげて",
      "BPMを50おとして",
      "BPMを50引き上げて",
      "BPMを60引き下げて",
      "BPMを40引上げ",
      "BPMが50落ちて",
      "サビだけBPMが40 上がる",
      // the other hiragana forms and the verbs 遅らせる, 上昇させる and 低下させる (no Q:1/4=50 for "50はやくして")
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
      // in a tag list a verb after a space, or a word after a hedge after a space (no Q:1/4=50 for "BPM 50 上げて")
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
      const full = await planSubmission(input({ formAbc: CHORDS, formStyle: style }), deps(scripted().ask));
      expect(full?.style, style).toBe(`${style}, 88 BPM`);
      expect(full?.formChanges.styleBpm, style).toBe(88);

      // a score without Q:, stripped: no Q:1/4=808 or Q:1/4=16, and the native check reports the missing Q:
      const noQ = CHORDS.replace(/^Q:.*\r?\n/m, "");
      const b = scripted("strip", "send");
      const strip = await planSubmission(input({ formMode: "melody", formAbc: noQ, formStyle: style }), deps(b.ask));
      expect(b.asked.map((r) => r.title), style).toEqual(["コード付きの譜面です", "譜面の確認"]);
      expect(statedAbcTempo(strip!.abc), style).toBeNull();
      expect(strip?.formChanges.abc, style).toBe(strip?.abc);
      expect(strip?.style, style).toBe(style);
    }
  });

  it("replaces the tempo of a space-separated tag list or after a Japanese word instead of adding a second one (J-POP 女性ボーカル BPM120, テンポはBPM120)", async () => {
    for (const [style, synced] of [
      ["J-POP 女性ボーカル BPM120", "J-POP 女性ボーカル 88 BPM"],
      ["ロック　ＢＰＭ１４０", "ロック　88 BPM"],
      ["ロック BPM:140", "ロック 88 BPM"],
      // Japanese puts no space between words: a word attached to BPM makes no modifier
      ["テンポはBPM120", "テンポは88 BPM"],
      ["女性ボーカルBPM120", "女性ボーカル88 BPM"],
      ["J-POP、女性ボーカルBPM128", "J-POP、女性ボーカル88 BPM"],
      // a particle (は, が), 約 or a tilde, brackets or another dash between BPM and its tempo, and BPM spelled with hyphens
      ["J-POP, BPMは140", "J-POP, 88 BPM"],
      ["J-POP, BPMが140", "J-POP, 88 BPM"],
      ["ロック, BPMが140くらいの疾走感", "ロック, 88 BPMくらいの疾走感"],
      // the particles を, も, で or a reading comma, and an "about" word or "of"
      ["J-POP, BPMを140くらいに", "J-POP, 88 BPMくらいに"],
      ["J-POP, BPMも140", "J-POP, 88 BPM"],
      ["J-POP, BPMで140", "J-POP, 88 BPM"],
      ["J-POP, BPMは、140", "J-POP, 88 BPM"],
      ["ロック, BPMはおよそ140", "ロック, 88 BPM"],
      ["rock, BPM around 140", "rock, 88 BPM"],
      ["rock, a BPM of 140", "rock, a 88 BPM"],
      ["rock, BPM [140]", "rock, 88 BPM"],
      ["rock, BPM約140", "rock, 88 BPM"],
      ["rock, BPM: ~140", "rock, 88 BPM"],
      ["ロック, BPM：～140", "ロック, 88 BPM"],
      ["rock, BPM (140)", "rock, 88 BPM"],
      ["rock, BPM ‐ 140", "rock, 88 BPM"],
      ["rock, 140 beats-per-minute", "rock, 88 BPM"],
      // a tempo of 40-299 with a word after it that names beats or bars
      ["J-POP 女性ボーカル BPM128 ビート強め ピアノ", "J-POP 女性ボーカル 88 BPM ビート強め ピアノ"],
      ["hip hop BPM 90 beats", "hip hop 88 BPM beats"],
      ["rock, BPM 120 beat-driven", "rock, 88 BPM beat-driven"],
      // a tempo of 100 or more before a word of raising describes the song (no raise of 100 BPM or more)
      ["J-POP, BPM128 アップな曲調", "J-POP, 88 BPM アップな曲調"],
      ["J-POP BPM140 アップ曲 女性ボーカル", "J-POP 88 BPM アップ曲 女性ボーカル"],
      ["J-POP, BPM 140 上がる曲", "J-POP, 88 BPM 上がる曲"],
      ["J-POP, BPM 140 速くて重い", "J-POP, 88 BPM 速くて重い"],
      // a tempo lowered to, and a word that only starts like a word of lowering
      ["ロック, BPMを140に落として", "ロック, 88 BPMに落として"],
      ["バラード, BPM 70 落ち着いたピアノ", "バラード, 88 BPM 落ち着いたピアノ"],
      // 落ちサビ and 落ち込んだ lower no tempo, and in a tag list a word after a space is a tag of its own
      ["J-POP 女性ボーカル BPM90 落ちサビあり", "J-POP 女性ボーカル 88 BPM 落ちサビあり"],
      ["J-POP 女性ボーカル BPM 90 落ちサビ ピアノ", "J-POP 女性ボーカル 88 BPM 落ちサビ ピアノ"],
      ["バラード, BPM 60 落ち込んだ雰囲気", "バラード, 88 BPM 落ち込んだ雰囲気"],
      ["BPMは90 落ちサビで60", "88 BPM 落ちサビで60"],
      ["バラード BPM 70 遅くて切ない", "バラード 88 BPM 遅くて切ない"],
      ["BPM 95 早くない", "88 BPM 早くない"],
      ["ロック BPM 80 ダウン系", "ロック 88 BPM ダウン系"],
      ["BPM 90 上げ曲", "88 BPM 上げ曲"],
      ["BPM 80 プラスα", "88 BPM プラスα"],
      // はやくち (早口), おちつく and the noun 上昇 raise or lower nothing
      ["ヒップホップ, BPM90はやくちラップ", "ヒップホップ, 88 BPMはやくちラップ"],
      ["バラード, BPMが60おちついた雰囲気", "バラード, 88 BPMおちついた雰囲気"],
      ["J-POP, BPM90上昇感のあるサビ", "J-POP, 88 BPM上昇感のあるサビ"],
      // a form that describes the next word or another form of the verb after a space starts a tag
      ["BPM 90 上がる曲", "88 BPM 上がる曲"],
      ["J-POP BPM 80 落ちる系", "J-POP 88 BPM 落ちる系"],
      ["ロック, BPM 70くらい 落とした感じ", "ロック, 88 BPMくらい 落とした感じ"],
      // an amount after を/も (50ほど高く) is no tempo: the tempo the style states later is synced
      ["サビでBPMを50ほど高く, ロック, BPM 120", "サビでBPMを50ほど高く, ロック, 88 BPM"],
      ["2番からBPMも40低く, バラード, BPM: 90", "2番からBPMも40低く, バラード, 88 BPM"],
      ["Aメロは抑えめ、サビでBPMを40高くして疾走感を出す。BPM 130", "Aメロは抑えめ、サビでBPMを40高くして疾走感を出す。88 BPM"],
    ]) {
      const full = await planSubmission(input({ formAbc: CHORDS, formStyle: style }), deps(scripted().ask));
      expect(full?.style, style).toBe(synced);
      expect(full?.formChanges.styleBpm, style).toBe(88);
      expect(full?.notes, style).toContain("スタイルの BPM を譜面の Q: に合わせました（88 BPM）");
      // the page writes the same text into the style field (ComposePage): the next send leaves it alone
      const formStyle = withStyleBpm(style, full!.formChanges.styleBpm!);
      expect(formStyle, style).toBe(synced);
      const second = await planSubmission(input({ formAbc: CHORDS, formStyle }), deps(scripted().ask));
      expect(second?.style, style).toBe(synced);
      expect(second?.formChanges.styleBpm, style).toBeUndefined();
    }
  });

  it("gives a stripped score without Q: the style's tempo also when a word that names beats follows it (BPM128 ビート強め, BPM 90 beats)", async () => {
    const noQ = CHORDS.replace(/^Q:.*\r?\n/m, "");
    for (const [style, bpm] of [
      ["J-POP 女性ボーカル BPM128 ビート強め ピアノ", 128],
      ["hip hop BPM 90 beats", 90],
      ["ambient, BPM 30", 30],
      // after the particle が or "about" after a colon
      ["ロック, BPMが140くらいの疾走感", 140],
      ["rock, BPM: ~140", 140],
      // after the particles を, も or a reading comma, or an "about" word
      ["J-POP, BPMを140くらいに", 140],
      ["J-POP, BPMも140", 140],
      ["J-POP, BPMは、140", 140],
      ["ロック, BPMはおよそ140", 140],
      ["rock, BPM around 140", 140],
      // a tempo of 100 or more before a word of raising
      ["J-POP, BPM128 アップな曲調", 128],
      ["J-POP, BPM 140 上がる曲", 140],
      ["J-POP, BPM 140 速くて重い", 140],
      // a tempo lowered to, and a word that only starts like a word of lowering
      ["ロック, BPMを140に落として", 140],
      ["ロック, BPMを80まで下げて", 80],
      ["バラード, BPM 70 落ち着いたピアノ", 70],
      // 落ちサビ and 落ち込んだ lower no tempo, and in a tag list a word after a space is a tag of its own
      ["J-POP 女性ボーカル BPM90 落ちサビあり", 90],
      ["J-POP 女性ボーカル BPM 90 落ちサビ ピアノ", 90],
      ["バラード, BPM 60 落ち込んだ雰囲気", 60],
      ["BPMは90 落ちサビで60", 90],
      ["バラード BPM 70 遅くて切ない", 70],
      ["BPM 95 早くない", 95],
      ["ロック BPM 80 ダウン系", 80],
      ["BPM 90 上げ曲", 90],
      ["BPM 80 プラスα", 80],
      // はやくち (早口), おちつく and the noun 上昇 raise or lower nothing
      ["ヒップホップ, BPM90はやくちラップ", 90],
      ["バラード, BPMが60おちついた雰囲気", 60],
      ["J-POP, BPM90上昇感のあるサビ", 90],
      // a form that describes the next word or another form of the verb after a space starts a tag
      ["BPM 90 上がる曲", 90],
      ["J-POP BPM 80 落ちる系", 80],
      ["ロック, BPM 70くらい 落とした感じ", 70],
    ] as const) {
      const a = scripted("strip");
      const strip = await planSubmission(input({ formMode: "melody", formAbc: noQ, formStyle: style }), deps(a.ask));
      expect(a.asked.map((r) => r.title), style).toEqual(["コード付きの譜面です"]);
      expect(statedAbcTempo(strip!.abc), style).toBe(bpm);
      expect(strip?.formChanges.abc, style).toBe(strip?.abc);
      expect(strip?.style, style).toBe(style);
      expect(strip?.formChanges.styleBpm, style).toBeUndefined();
    }
  });

  it("leaves the style alone for a Q: it could not write back as a tempo (Q:1/4=1e21, Q:1/16=1 in a rejected score)", async () => {
    const huge = CHORDS.replace(/^Q:.*$/m, "Q:1/4=1000000000000000000000");
    const tiny = UNPARSABLE.replace(/^Q:.*$/m, "Q:1/16=1");
    expect(statedAbcTempo(huge)).toBe(1e21);
    expect(statedAbcTempo(tiny)).toBeLessThan(0.5);
    for (const score of [huge, tiny]) {
      // (the rejected score is asked about, and at 1/4 of a beat per minute it outlasts any budget)
      const plan = await planSubmission(input({ formAbc: score, formStyle: "pop, 120 BPM" }), deps(scripted("send", "asis").ask));
      expect(plan?.style).toBe("pop, 120 BPM");
      expect(plan?.formChanges.styleBpm).toBeUndefined();
      expect(plan?.notes.some((n) => n.includes("合わせました"))).toBe(false);
    }
  });

  it("syncs the style once to a tempo outside the usual range (Q:1/4=8, Q:1/4=1200), not on every send", async () => {
    for (const q of [8, 1200]) {
      const score = CHORDS.replace(/^Q:.*$/m, `Q:1/4=${q}`);
      let formStyle = "pop, 120 BPM";
      const first = await planSubmission(input({ formAbc: score, formStyle }), deps(scripted().ask));
      expect(first?.style).toBe(`pop, ${q} BPM`);
      expect(first?.formChanges.styleBpm).toBe(q);
      // the page applies the change to the style field as ComposePage does
      formStyle = withStyleBpm(formStyle, first!.formChanges.styleBpm!);
      const second = await planSubmission(input({ formAbc: score, formStyle }), deps(scripted().ask));
      expect(second?.style).toBe(`pop, ${q} BPM`);
      expect(second?.formChanges.styleBpm).toBeUndefined();
      expect(second?.notes.some((n) => n.includes("BPM"))).toBe(false);
    }
  });
});

describe("planSubmission: budget", () => {
  const manual = (manualSec: number, limit = 900) => ({ auto: false, manual: manualSec, limit, defaultMax: 360, fallbackEstimate: 60 });

  it("offers the automatic score margin when a manual limit is shorter than the score", async () => {
    const { ask, asked } = scripted("wider");
    const plan = await planSubmission(input({ over: { mode: "full", abc: LONG, style: "rock, 83 BPM" }, durations: manual(60) }), deps(ask));
    const auto = durationBudget({ auto: true, manual: 0, limit: 900, defaultMax: 60, abc: LONG, lyricEstimate: 0 });
    expect(asked[0].choices.map((c) => c.value)).toEqual(["wider", "asis"]);
    expect(plan?.maxDuration).toBe(auto.seconds);
    expect(plan?.maxDuration).toBe(scoreMarginSeconds(auto.scoreSeconds!));
  });

  it("omits the wider choice when it would not exceed the limit already chosen", async () => {
    const { ask, asked } = scripted("asis");
    const plan = await planSubmission(input({ over: { mode: "full", abc: LONG, style: "rock, 83 BPM" }, durations: manual(150, 150) }), deps(ask));
    expect(asked[0].choices.map((c) => c.value)).toEqual(["asis"]);
    expect(plan?.maxDuration).toBe(150);
  });

  it("falls back to the estimate shown on the page when estimate_duration fails", async () => {
    const { ask } = scripted();
    const failing = async () => {
      throw new Error("x");
    };
    const long = { auto: true, manual: 0, limit: 900, defaultMax: 60, fallbackEstimate: 300 };
    const plan = await planSubmission(input({ durations: long }), deps(ask, new AcceptedAdvice(), failing));
    expect(plan?.maxDuration).toBe(Math.ceil(300 * 1.3 + 15));
  });

  it("keeps the budget of the song being re-rendered as a minimum", async () => {
    const { ask } = scripted();
    const plan = await planSubmission(input({ over: { minMaxDuration: 500 } }), deps(ask));
    expect(plan?.maxDuration).toBe(500);
  });
});

describe("planSubmission: cancels and notes", () => {
  it("returns null at any cancelled dialog", async () => {
    expect(await planSubmission(input({ formMode: "melody", formAbc: CHORDS }), deps(scripted(null).ask))).toBeNull();
    expect(await planSubmission(input({ over: { mode: "full", abc: LONG, adviseScore: true } }), deps(scripted(null).ask))).toBeNull();
    const budgetCancel = input({ over: { mode: "full", abc: LONG, style: "x" }, durations: { auto: false, manual: 60, limit: 900, defaultMax: 360, fallbackEstimate: 60 } });
    expect(await planSubmission(budgetCancel, deps(scripted(null).ask))).toBeNull();
  });

  it("keeps findings accepted in the score dialog even when the budget dialog is cancelled", async () => {
    const memo = new AcceptedAdvice();
    const req = input({ over: { mode: "full", abc: LONG, adviseScore: true }, durations: { auto: false, manual: 60, limit: 900, defaultMax: 360, fallbackEstimate: 60 } });
    const first = scripted("send", null);
    expect(await planSubmission(req, deps(first.ask, memo))).toBeNull();
    expect(first.asked.map((a) => a.title)).toEqual(["譜面の確認", "曲長の上限が譜面の長さより短くなっています"]);
    const second = scripted("asis");
    expect(await planSubmission(req, deps(second.ask, memo))).not.toBeNull();
    expect(second.asked.map((a) => a.title)).toEqual(["曲長の上限が譜面の長さより短くなっています"]);
  });

  it("notes form lyrics without words when no score is sent", async () => {
    const { ask } = scripted();
    const plan = await planSubmission(input({ sung: "[Verse]\n\n[Chorus]\n" }), deps(ask));
    expect(plan?.notes).toContain(NO_WORDS_NOTE);
    const inst = await planSubmission(input({ formLyrics: false, sung: "" }), deps(ask));
    expect(inst?.notes).not.toContain(NO_WORDS_NOTE);
    // decided from what is sung: a hiragana version with words next to an emptied kanji pane is sung, one with only
    // tags next to kanji words is not
    expect((await planSubmission(input({ sung: "[Verse]\nあさのひかり" }), deps(ask)))?.notes).not.toContain(NO_WORDS_NOTE);
    expect((await planSubmission(input({ sung: "[Verse]\n" }), deps(ask)))?.notes).toContain(NO_WORDS_NOTE);
  });

  it("puts the caller's notes first", async () => {
    const { ask } = scripted();
    const plan = await planSubmission(input({ formAbc: MELODY, over: { notes: ["呼び出し元"] } }), deps(ask));
    expect(plan?.notes[0]).toBe("呼び出し元");
  });
});

describe("SubmitGuard", () => {
  it("allows one send at a time and ignores the same button right after an accepted send", () => {
    let now = 0;
    const g = new SubmitGuard(1000, () => now);
    expect(g.begin("generate")).toBe(true);
    expect(g.begin("rerender")).toBe(false);
    g.accepted("generate");
    g.end();
    now = 300;
    expect(g.begin("generate")).toBe(false);
    expect(g.begin("rerender")).toBe(true);
    g.end();
    now = 1000;
    expect(g.begin("generate")).toBe(true);
    g.end();
  });

  it("does not hold back a send that was cancelled", () => {
    const g = new SubmitGuard(1000, () => 0);
    expect(g.begin("cover")).toBe(true);
    g.end();
    expect(g.begin("cover")).toBe(true);
  });

  it("singleClick ignores the second click of a double click, not the keyboard", () => {
    let n = 0;
    const h = singleClick(() => n++);
    h({ detail: 1 });
    h({ detail: 2 });
    h({ detail: 0 });
    expect(n).toBe(2);
  });
});

describe("AI songwriting replace check", () => {
  const base = { lyrics: "DEF", defaultLyrics: "DEF", sungLyrics: null, style: "S", defaultStyle: "S", composedStyle: "" };
  it("asks only when typed lyrics, a hiragana version or a hand-written style would be lost", () => {
    expect(draftReplaces(base)).toEqual({ lyrics: false, style: false, title: false });
    expect(draftReplaces({ ...base, lyrics: "" , style: "", title: "" })).toEqual({ lyrics: false, style: false, title: false });
    expect(draftReplaces({ ...base, lyrics: "私の歌詞" }).lyrics).toBe(true);
    expect(draftReplaces({ ...base, sungLyrics: "わたしの" }).lyrics).toBe(true);
    expect(draftReplaces({ ...base, style: "my own style" }).style).toBe(true);
    // a style built from the chips can be rebuilt: not asked
    expect(draftReplaces({ ...base, style: "Japanese, pop", composedStyle: "Japanese, pop" }).style).toBe(false);
    // a typed title is lost with the draft's title; blank is nothing
    expect(draftReplaces({ ...base, title: "私の曲" }).title).toBe(true);
    expect(draftReplaces({ ...base, title: "  " }).title).toBe(false);
  });

  it("does not ask again for lyrics, a style and a title as the last draft left them", () => {
    const lastDraft = { lyrics: "AI の歌詞", style: "AI style", title: "AI の題" };
    expect(draftReplaces({ ...base, lyrics: "AI の歌詞", style: "AI style", title: "AI の題", lastDraft })).toEqual({ lyrics: false, style: false, title: false });
    expect(draftReplaces({ ...base, lyrics: "AI の歌詞（手直し）", style: "AI style", lastDraft })).toEqual({ lyrics: true, style: false, title: false });
    expect(draftReplaces({ ...base, title: "AI の題（手直し）", lastDraft }).title).toBe(true);
    // a hiragana version made from the draft may hold hand-fixed readings
    expect(draftReplaces({ ...base, lyrics: "AI の歌詞", sungLyrics: "えーあいのかし", lastDraft }).lyrics).toBe(true);
    expect(draftReplaces({ ...base, lyrics: "私の歌詞", lastDraft: { lyrics: "", style: "" } }).lyrics).toBe(true);
    // an older draft record without a title: any typed title counts
    expect(draftReplaces({ ...base, title: "私の曲", lastDraft: { lyrics: "AI の歌詞", style: "AI style" } }).title).toBe(true);
  });
});
