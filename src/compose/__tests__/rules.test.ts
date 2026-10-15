import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbc } from "../../abc/parse";
import { withStyleBpm } from "../../lyrics/styleBpm";
import {
  DEFAULT_SAMPLING,
  EDIT_MAX_REPLY_TOKENS,
  EDIT_SYSTEM_PROMPT_TOKENS,
  EXCERPT_RATIO,
  EditConversation,
  editWork,
  editedSinceSent,
  localEditFit,
  localLlmView,
  scoreCutWarning,
  KEEP_MELODY,
  OMITTED_REPLY_NOTE,
  SHORTEN_INTENT,
  clampVariations,
  committedVariations,
  compactEditHistory,
  coverMarginSeconds,
  diffWithContext,
  editHistoryBudget,
  estimateTokens,
  excerptCheck,
  latestReplyIndex,
  lyricMarginSeconds,
  melodyReaskBase,
  otherPianoEdits,
  plannedScoreLoad,
  reaskHistoryBudget,
  replyVerdict,
  recordPianoEdit,
  melodyRelevantLines,
  scoreMarginSeconds,
  styleTempoSync,
  MAX_SEED,
  clampSeed,
  coverMaxDuration,
  durationBudget,
  durationLimits,
  hasSungWords,
  lenientAbcSummary,
  melodyReaskText,
  rawHasChords,
  replaceAbcTempo,
  rerenderLabel,
  rerenderMaxDuration,
  samplingFrom,
  scoreSeconds,
  statedAbcTempo,
  storedMaxDuration,
  storedParams,
  summarizeAbc,
  tagSkeletonFromAbc,
  usedFixedAbc,
  dropRepeatedFields,
  reaskText,
  repeatedFieldsNote,
  worthReask,
  rerenderTitle,
} from "../rules";
import { scoreHasChords } from "../scoreAdvice";

const fx = (name: string) => readFileSync(join(__dirname, "..", "..", "abc", "__fixtures__", name), "utf8");

const SMALL = `X:1
T:
M:4/4
L:1/16
Q:1/4=60
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:C
% verse
V: Vocal
"C"C4D4E4F4|G16|
V: Ins
C,16|G,16|
`;

describe("clampSeed", () => {
  it("keeps integers in [0, 2^53-1] and repairs everything else", () => {
    expect(clampSeed("123")).toBe(123);
    expect(clampSeed(1.9)).toBe(1);
    expect(clampSeed(-5)).toBe(0);
    expect(clampSeed("")).toBe(0);
    expect(clampSeed("-")).toBe(0);
    expect(clampSeed(2 ** 64)).toBe(MAX_SEED);
    // a seed stored as a wrapped negative i64
    expect(clampSeed(-9223372036854775000)).toBe(0);
  });
});

describe("durationLimits", () => {
  it("clamps the configured values", () => {
    expect(durationLimits(null)).toEqual({ limit: 900, defaultMax: 360 });
    expect(durationLimits({ maxDurationLimit: 1200, defaultMaxDuration: 1000 })).toEqual({ limit: 900, defaultMax: 900 });
    expect(durationLimits({ maxDurationLimit: 300, defaultMaxDuration: 360 })).toEqual({ limit: 300, defaultMax: 300 });
  });
});

describe("score length", () => {
  it("measures bars at the Q: tempo", () => {
    const s = parseAbc(SMALL);
    expect(scoreSeconds(s)).toBeCloseTo(8, 5); // 2 bars of 4/4 at 60 BPM
    const sum = summarizeAbc(SMALL)!;
    expect(sum.bars).toBe(2);
    expect(sum.hasChords).toBe(true);
    expect(sum.parseError).toBeNull();
  });

  it("follows meter changes (official example-ins: 4 bars 4/4 + 2 bars 5/8 at 96 BPM)", () => {
    const sum = summarizeAbc(fx("official_example_ins.abc"))!;
    expect(sum.timelineChanges).toBe(true);
    expect(sum.seconds).toBeCloseTo(((4 * 4 + 2 * 2.5) * 60) / 96, 5);
  });

  it("falls back to a lenient reading when the parser rejects the text", () => {
    const bad = SMALL.replace("G16|", "G8-z8|"); // tie into a rest: rejected by parseAbc
    expect(() => parseAbc(bad)).toThrow();
    const sum = summarizeAbc(bad)!;
    expect(sum.parseError).not.toBeNull();
    expect(sum.bars).toBe(2);
    expect(sum.bpm).toBe(60);
    expect(sum.seconds).toBeCloseTo(8, 5);
    expect(sum.hasChords).toBe(true);
    expect(lenientAbcSummary("")).toBeNull();
    // multi-bar rests count as their bars
    expect(lenientAbcSummary(bad.replace("C,16|G,16|", "Z2|"))!.bars).toBe(2);
    // the lenient reader agrees with the parser on real scores
    for (const f of ["full_ja.abc", "full_long.abc", "transcription_l16.abc", "official_example_ins.abc"]) {
      const text = fx(f);
      const exact = summarizeAbc(text)!;
      const loose = lenientAbcSummary(text)!;
      expect(loose.bars).toBe(exact.bars);
      expect(loose.seconds).toBeCloseTo(exact.seconds, 3);
    }
  });

  it("reads chord symbols from raw text, ignoring the header and N", () => {
    expect(rawHasChords(SMALL)).toBe(true);
    expect(rawHasChords(SMALL.replace('"C"', ""))).toBe(false);
    expect(rawHasChords(SMALL.replace('"C"', '"N"'))).toBe(false);
    // quoted strings are read in pairs: the text between two "N" markers is no chord
    expect(rawHasChords(SMALL.replace('"C"C4D4E4F4|G16|', '"N"z16|"N"z16|'))).toBe(false);
    expect(rawHasChords(SMALL.replace('"C"C4D4E4F4|G16|', '"N"z16|"Am"z16|'))).toBe(true);
  });
});

describe("AI 編集 render button label", () => {
  it("uses 作曲's 「この譜面で再生成」 with a score, named after the render mode", () => {
    expect(rerenderLabel(true, "full")).toBe("この譜面で再生成（Full）");
    expect(rerenderLabel(true, "melody")).toBe("この譜面で再生成（Melody）");
  });

  it("says what a render without a score does in the song's own mode", () => {
    expect(rerenderLabel(false, "off")).toBe("再生成（譜面なし・Off）");
    expect(rerenderLabel(false, "melody")).toBe("再生成（譜面を再計画・Melody）");
    expect(rerenderLabel(false, "full")).toBe("再生成（譜面を再計画・Full）");
  });

  it("decides Full / Melody from the parsed score, or from the raw text when it does not parse", () => {
    expect(scoreHasChords(SMALL)).toBe(true);
    expect(scoreHasChords(SMALL.replace('"C"', ""))).toBe(false);
    expect(scoreHasChords("not a score \"C\"")).toBe(rawHasChords("not a score \"C\""));
  });
});

describe("statedAbcTempo", () => {
  it("reads only a Q: the header really has", () => {
    expect(statedAbcTempo(SMALL)).toBe(60);
    expect(statedAbcTempo(SMALL.replace("Q:1/4=60", "Q:3/8=60"))).toBe(90);
    // no Q: -> the parsers assume 120, which is no tempo of the score
    const noQ = SMALL.replace("Q:1/4=60\n", "");
    expect(summarizeAbc(noQ)?.bpm).toBe(120);
    expect(statedAbcTempo(noQ)).toBeNull();
    // a body Q: is no header tempo
    expect(statedAbcTempo(noQ.replace("% verse", "Q:1/4=90\n% verse"))).toBeNull();
    expect(statedAbcTempo("")).toBeNull();
  });

  it("reads a Q: whose tempo follows text as the parser does (the instrumental keeps the score's tempo)", () => {
    for (const q of ['Q:"Allegro" 1/4=140', "Q:C=140", 'Q:1/4=140 "Allegro"']) {
      const text = SMALL.replace("Q:1/4=60", q);
      expect(parseAbc(text).bpm, q).toBe(140);
      expect(statedAbcTempo(text), q).toBe(140);
      expect(lenientAbcSummary(text)!.bpm, q).toBe(140);
    }
    expect(statedAbcTempo(SMALL.replace("Q:1/4=60", 'Q:"Allegro" 3/8=60'))).toBe(90);
    // a Q: without a number states no tempo (the parsers assume 120)
    expect(statedAbcTempo(SMALL.replace("Q:1/4=60", 'Q:"Allegro"'))).toBeNull();
  });
});

describe("melody re-ask", () => {
  it("is recognized as a keep-the-melody instruction", () => {
    expect(KEEP_MELODY.test(melodyReaskText(["Vocal 3 小節目: 音が変わりました"]))).toBe(true);
    expect(KEEP_MELODY.test("サビのコードをジャズ風に。メロディは変えないで")).toBe(true);
    expect(KEEP_MELODY.test("イントロを 4 小節短くして")).toBe(false);
  });

  it("recognizes 旋律 and a bare メロ, but not a section name such as Aメロ", () => {
    for (const s of ["旋律は変えないで、コードだけ変えて", "メロはそのままでテンポを上げて", "メロディーを維持してリハーモナイズ", "keep the melody", "Don't change the melody"]) expect(KEEP_MELODY.test(s), s).toBe(true);
    for (const s of ["Aメロはそのまま、サビを明るく", "Ｂメロは変えずにサビだけ変えて", "サビだけジャズ風に", "イントロを 4 小節短くして"]) expect(KEEP_MELODY.test(s), s).toBe(false);
  });

  it("does not take a melody scoped to one section for the whole song's", () => {
    for (const s of ["サビメロはそのまま、Aメロを明るく", "サビのメロはそのままで", "サビのメロディは変えないで", "2番のメロはそのまま", "イントロのメロディは維持して"]) expect(KEEP_MELODY.test(s), s).toBe(false);
    expect(KEEP_MELODY.test("サビのコードを変えて、メロディはそのまま")).toBe(true);
    // a melody named with its section (…の), 旋律 included
    for (const s of ["Aメロのメロディは変えないで、サビのメロディを高くして", "Ａメロのメロディはそのまま", "サビ前のメロディは維持", "1番目のメロディはそのまま", "サビの旋律はそのまま", "Aメロの旋律は変えないで"])
      expect(KEEP_MELODY.test(s), s).toBe(false);
    for (const s of ["元のメロディはそのまま", "曲全体のメロディは変えないで", "Aメロのコードを変えて、メロディはそのまま"]) expect(KEEP_MELODY.test(s), s).toBe(true);
  });

  it("asks to restore only the vocal notes and the bar grid, not the requested harmony", () => {
    const lines = ["ボーカル: 変更 3 音・追加 0 音・削除 0 音（小節 5, 6）", "伴奏声部: 変更 2 音・追加 0 音・削除 0 音（小節 1）", "コード: 小節 5 で変更", "テンポ: 120 → 128 BPM（音符は拍の位置で比較しています）", "小節数: 8 → 9（曲の長さが変わります）", "調: C → G"];
    expect(melodyRelevantLines(lines)).toEqual([lines[0], lines[4]]);
    const text = melodyReaskText(lines);
    expect(text).toContain(lines[0]);
    expect(text).not.toContain("コード:");
  });

  it("is made against the turn's sent score while the editor holds it or the applied reply", () => {
    const t = { sentAbc: "X:1 old", replyAbc: "X:1 new" };
    expect(melodyReaskBase(t, "X:1 old")).toBe("X:1 old");
    expect(melodyReaskBase({ ...t, applied: true }, "X:1 new")).toBe("X:1 old");
    // not applied, yet the editor holds the reply: a hand edit or another turn (not this turn's apply)
    expect(melodyReaskBase(t, "X:1 new")).toBeNull();
    expect(melodyReaskBase({ ...t, applied: true }, "X:1 edited")).toBeNull();
    expect(melodyReaskBase({ sentAbc: "", replyAbc: "X" }, "")).toBeNull();
  });

  it("accepts the score the apply put there (the tempo dialog's Q: change), not only the raw reply", () => {
    const t = { sentAbc: "X:1 old", replyAbc: "X:1 new Q:120", appliedAbc: "X:1 new Q:96", applied: true };
    expect(melodyReaskBase(t, "X:1 new Q:96")).toBe("X:1 old");
    expect(melodyReaskBase(t, "X:1 new Q:120")).toBeNull();
  });

  it("is offered on the latest reply only (the history's latest instruction is the one it revises)", () => {
    const turns = [
      { role: "user", text: "A" },
      { role: "assistant", reply: {} },
      { role: "user", text: "B" },
      { role: "assistant", reply: {} },
      { role: "user", text: "C" },
      { role: "assistant", error: true },
    ];
    expect(latestReplyIndex(turns)).toBe(3);
    expect(latestReplyIndex(turns.slice(0, 2))).toBe(1);
    expect(latestReplyIndex([{ role: "user" }])).toBe(-1);
  });
});

describe("excerpt check", () => {
  it("re-asks for a much shorter reply unless the instruction asked to shorten", () => {
    expect(EXCERPT_RATIO).toBe(0.7);
    expect(excerptCheck(60, 50, "サビを明るく")).toBeNull();
    expect(excerptCheck(60, 32, "サビを明るく")).toBe("reask");
    expect(excerptCheck(0, 4, "サビを明るく")).toBeNull();
    // shortening wording: no re-ask, only a neutral hint to check the diff
    expect(excerptCheck(60, 32, "間奏を消して1コーラスにまとめて")).toBe("shortened");
    expect(excerptCheck(60, 45, "間奏を消して")).toBeNull();
    // shortening wording, but far below any such request: only a note
    expect(excerptCheck(60, 8, "イントロを削って")).toBe("note");
  });

  it("checks the notation of a shortened reply too", () => {
    const score = (bars: number, extra = "") =>
      `X:1\nT:\nM:4/4\nL:1/32\nQ:1/4=88\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n${extra || "% verse"}\n` +
      Array.from({ length: bars / 4 }, () => `V: Vocal\n${"C32|".repeat(4)}\nV: Ins\nZ4|\n`).join("");
    expect(replyVerdict(40, score(40), "サビを明るく")).toBeNull();
    // a shortening instruction: the bar-count hint only, for native notation
    expect(replyVerdict(40, score(24), "2番をカットして")).toEqual({ kind: "short", bars: 24, level: "shortened" });
    // ... and the native findings (re-ask, confirmation at apply) with the hint kept, for other notation
    const v = replyVerdict(40, score(24, "%%MIDI program 1"), "2番をカットして");
    expect(v).toMatchObject({ kind: "native", bars: 24, shortLevel: "shortened" });
    // an excerpt without a shortening instruction still gets the re-ask for the complete score first
    expect(replyVerdict(40, score(24, "%%MIDI program 1"), "サビを明るく")).toEqual({ kind: "short", bars: 24, level: "reask" });
    expect(replyVerdict(40, "X:1\nK:C\n[[", "x")).toMatchObject({ kind: "parse" });
    expect(replyVerdict(40, "  ", "x")).toBeNull();
  });

  it("still flags a half-length reply to an instruction that removes an instrument", () => {
    // SHORTEN_INTENT matches these (消して, remove), but they remove no bars: the hint is what catches an excerpt
    for (const s of ["ドラムを消して", "リバーブをなくして", "ストリングスを取り除いて", "remove the drums"]) expect(excerptCheck(60, 30, s), s).toBe("shortened");
  });

  it("recognizes shortening instructions and leaves ordinary rewrites alone", () => {
    for (const s of ["間奏を消して", "2番を省略して", "2番を省いて", "間奏は省いて", "2番は省いて", "ブリッジを省いて", "1コーラスにして", "ワンコーラスに", "サビだけにして", "remove the bridge", "trim the intro", "shorten it", "cut the outro", "イントロを 4 小節短くして", "アウトロをなくして"])
      expect(SHORTEN_INTENT.test(s), s).toBe(true);
    for (const s of ["コードをシンプルにまとめて", "装飾音を省いて", "サビだけジャズ風に", "力を抜いた感じに", "スタイルをシティポップ風にして"]) expect(SHORTEN_INTENT.test(s), s).toBe(false);
  });
});

describe("AI-edit history", () => {
  const reply = (abc: string, explanation: string) => JSON.stringify({ abc, style: "", lyrics: "", explanation });
  const ex = (u: string, raw: string, explanation: string) => [
    { role: "user" as const, text: u },
    { role: "assistant" as const, text: explanation, raw, explanation },
  ];

  it("keeps the latest reply verbatim and sends older replies without their score", () => {
    const turns = [...ex("A", reply("X:1 first", "一つ目"), "一つ目"), ...ex("B", reply("X:1 second", "二つ目"), "二つ目")];
    const { messages, dropped } = compactEditHistory(turns, null);
    expect(dropped).toBe(0);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const older = JSON.parse(messages[1].content);
    expect(older.abc).toBe("");
    expect(older.explanation).toBe(`一つ目${OMITTED_REPLY_NOTE}`);
    expect(messages[3].content).toBe(reply("X:1 second", "二つ目"));
  });

  it("leaves out failed exchanges and unanswered instructions", () => {
    const turns = [
      ...ex("A", reply("X:1 a", "a"), "a"),
      { role: "user" as const, text: "B" },
      { role: "assistant" as const, text: "エラー: LLM API エラー 400", error: true },
      { role: "user" as const, text: "C" },
    ];
    const { messages } = compactEditHistory(turns, null);
    expect(messages.map((m) => m.content)).toEqual(["A", reply("X:1 a", "a")]);
  });

  it("drops the oldest exchanges until the history fits the budget", () => {
    const big = "C".repeat(4000);
    const turns = [...ex("A", reply(big, "a"), "a"), ...ex("B", reply(big, "b"), "b"), ...ex("C", reply(big, "c"), "c")];
    const all = compactEditHistory(turns, null).messages;
    const size = (ms: { content: string }[]) => ms.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
    // the older replies are small once compacted: the latest (full score) decides
    const { messages, dropped } = compactEditHistory(turns, size(all.slice(4)));
    expect(dropped).toBe(2);
    expect(messages).toEqual(all.slice(4));
    expect(compactEditHistory(turns, size(all)).dropped).toBe(0);
    expect(compactEditHistory(turns, size(all.slice(4)) - 1)).toEqual({ messages: [], dropped: 3 });
  });

  it("counts ASCII at 1.5 characters per token and other characters at one each", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(2);
    expect(estimateTokens("C2D2E2")).toBe(4);
    expect(estimateTokens("朝の光")).toBe(3);
    expect(estimateTokens("光 C2")).toBe(3);
  });

  it("leaves the reply's reserve intact for a 6 KB score at the default 16k context", () => {
    const abc = "C2D2 E2F2 | ".repeat(550); // about 6 KB
    const lyrics = "朝の光が窓を照らして\n".repeat(40);
    const i = { contextSize: 16384, abc, style: "pop, 120 BPM", lyrics, sung: null, instruction: "サビを明るく" };
    const b = editHistoryBudget(i);
    const reserve = Math.min(8192, estimateTokens(abc) + 3000);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(EDIT_SYSTEM_PROMPT_TOKENS + estimateTokens(abc) + estimateTokens(i.style) + estimateTokens(lyrics) + 200 + estimateTokens(i.instruction) + reserve + b!).toBe(16384);
  });

  it("does not trim the history when the local context size is the model's own (0)", () => {
    const i = { contextSize: 0, abc: "C2D2|", style: "pop", lyrics: "朝", sung: null, instruction: "修正して" };
    expect(editHistoryBudget(i)).toBeNull();
    const turns = [
      { role: "user" as const, text: "a" },
      { role: "assistant" as const, text: "b", raw: JSON.stringify({ abc: "C".repeat(400), style: "", lyrics: "", explanation: "x" }) },
    ];
    expect(compactEditHistory(turns, editHistoryBudget(i)).dropped).toBe(0);
    expect(reaskHistoryBudget(editHistoryBudget(i), { instruction: "x", firstRaw: "y", again: "z" })).toBeNull();
    // a small but known size still trims
    expect(editHistoryBudget({ ...i, contextSize: 4096 })).toBe(0);
  });

  it("gives the automatic re-ask only what is left after the first exchange", () => {
    const raw = JSON.stringify({ abc: "C".repeat(3000), style: "", lyrics: "", explanation: "" });
    const i = { instruction: "サビを明るく", firstRaw: raw, again: "完全な譜面を返してください" };
    expect(reaskHistoryBudget(null, i)).toBeNull();
    expect(reaskHistoryBudget(5000, i)).toBe(5000 - (estimateTokens(i.instruction) + 8) - (estimateTokens(raw) + 8) - estimateTokens(i.again));
    // a long score near the budget: the first exchange alone does not fit, so there is no re-ask
    expect(reaskHistoryBudget(1500, i)!).toBeLessThan(0);
    // the older history is compacted against the reduced budget
    const big = JSON.stringify({ abc: "C".repeat(4500), style: "", lyrics: "", explanation: "a" });
    const turns = [
      { role: "user" as const, text: "A" },
      { role: "assistant" as const, text: "a", raw: big, explanation: "a" },
    ];
    expect(compactEditHistory(turns, 5000).dropped).toBe(0);
    expect(compactEditHistory(turns, reaskHistoryBudget(5000, i)).dropped).toBe(1);
  });

  it("budgets the history from the local context size", () => {
    const abc = "C".repeat(4000);
    const b = editHistoryBudget({ contextSize: 16384, abc, style: "pop", lyrics: "", sung: null, instruction: "サビを明るく" });
    expect(b).toBe(16384 - EDIT_SYSTEM_PROMPT_TOKENS - (estimateTokens(abc) + estimateTokens("pop") + 200) - estimateTokens("サビを明るく") - (estimateTokens(abc) + 3000));
    expect(editHistoryBudget({ contextSize: 4096, abc: "C".repeat(20000), style: "", lyrics: "", sung: null, instruction: "" })).toBe(0);
  });
});

describe("AI-edit pre-check of the local LLM's room", () => {
  const req = (abc: string, p: Partial<{ contextSize: number; thinking: boolean; lyrics: string; sung: string | null }> = {}) => ({
    contextSize: 16384,
    thinking: true,
    abc,
    style: "J-pop, female vocal, 120 BPM",
    lyrics: "",
    sung: null,
    instruction: "イントロを 4 小節短くして",
    ...p,
  });
  // the fixtures repeated to about 6 and 15 minutes (the token estimate only depends on the text's density)
  const tiled = (name: string, seconds: number) => {
    const text = fx(name);
    return text.repeat(Math.ceil(seconds / summarizeAbc(text)!.seconds));
  };

  it("lets a song of the default length through", () => {
    for (const f of ["full_long.abc", "full_ja.abc", "transcription_l16.abc", "plan_l32.abc"]) {
      const lyrics = "朝の光が窓を照らして\n".repeat(40);
      expect(localEditFit(req(tiled(f, 330), { lyrics, sung: "あさのひかりがまどをてらして\n".repeat(40) })), f).toBeNull();
    }
    expect(localEditFit(req(""))).toBeNull();
  });

  it("warns before a 15-minute score whose complete reply cannot fit the 8,192-token output cap", () => {
    const abc = tiled("plan_l32.abc", 900);
    const fit = localEditFit(req(abc))!;
    expect(fit.scoreTokens).toBe(estimateTokens(JSON.stringify(abc)));
    expect(fit.scoreTokens).toBeGreaterThan(EDIT_MAX_REPLY_TOKENS);
    // neither thinking off nor a larger context helps: only a reply without the score (or the cloud) does
    expect(fit.withoutThinkingFits).toBe(false);
    expect(fit.contextBound).toBe(false);
    expect(fit.promptTooLong).toBe(false);
    expect(localEditFit(req(abc, { thinking: false }))).not.toBeNull();
  });

  it("says when turning thinking off or a larger context would make room", () => {
    // about 6,000 tokens of score: fits the cap only without the typical thinking
    const abc = tiled("transcription_l16.abc", 600);
    const fit = localEditFit(req(abc))!;
    expect(fit).not.toBeNull();
    expect(fit.withoutThinkingFits).toBe(true);
    expect(localEditFit(req(abc, { thinking: false }))).toBeNull();
    // at an 8,192 context the prompt leaves too little: a larger context helps
    const small = localEditFit(req(abc, { contextSize: 8192, thinking: false }))!;
    expect(small.contextBound).toBe(true);
    expect(small.room).toBeLessThan(EDIT_MAX_REPLY_TOKENS);
    // the model's own context (0) is not known: only the output cap counts
    expect(localEditFit(req(abc, { contextSize: 0, thinking: false }))).toBeNull();
  });

  it("reports a prompt that alone exceeds the context (the very first request would fail)", () => {
    const abc = tiled("full_ja.abc", 900);
    const lyrics = "朝の光が窓を照らして走り出そう\n".repeat(200);
    const fit = localEditFit(req(abc, { contextSize: 8192, lyrics, sung: "あさのひかりがまどをてらしてはしりだそう\n".repeat(200) }))!;
    expect(fit.promptTooLong).toBe(true);
    expect(fit.room).toBe(0);
  });
});

describe("AI-edit conversation (late, cancelled and replaced requests)", () => {
  it("uses a reply only while its request is pending in the conversation it was sent in", () => {
    const c = new EditConversation();
    const stale = c.begin("r1");
    expect(c.pending).toBe("r1");
    expect(stale()).toBe(false);
    c.end("r1");
    expect(c.pending).toBeNull();
    // ended normally: the reply was used before end(), nothing else changed
    expect(c.gen).toBe(0);
  });

  it("drops the reply of a cancelled request, also when it arrives after the next request started", () => {
    const c = new EditConversation();
    const stale1 = c.begin("r1");
    expect(c.cancel()).toBe("r1");
    expect(stale1()).toBe(true);
    // nothing left to cancel
    expect(c.cancel()).toBeNull();
    c.end("r1");
    const stale2 = c.begin("r2");
    expect(stale1()).toBe(true);
    expect(stale2()).toBe(false);
    // the older request's end does not touch the newer one
    c.end("r1");
    expect(c.pending).toBe("r2");
    expect(stale2()).toBe(false);
  });

  it("drops a reply that arrives after the conversation was reset or another song was loaded", () => {
    const c = new EditConversation();
    const stale = c.begin("r1");
    const gen = c.gen;
    c.restart();
    expect(stale()).toBe(true);
    expect(c.gen).not.toBe(gen);
    // the request itself is still pending (the page cancels it before loading another song)
    expect(c.pending).toBe("r1");
    expect(c.cancel()).toBe("r1");
  });
});

describe("AI-edit apply over edits made after the request was sent", () => {
  const turn = { sentAbc: "X:1 A0", sentStyle: "pop", sentLyrics: "L0" };
  const reply = (abc: string, style = "", lyrics = "") => ({ abc, style, lyrics });
  const now = (abc: string, style = "pop", lyrics = "L0") => ({ abc, style, lyrics });

  it("lists the fields the reply replaces that were edited since it was sent", () => {
    expect(editedSinceSent(turn, reply("X:1 R"), now("X:1 A0"))).toEqual([]);
    // a piano-roll edit while the reply was pending: the reply's score would replace it
    expect(editedSinceSent(turn, reply("X:1 R"), now("X:1 A1"))).toEqual(["譜面"]);
    // a reply without a score leaves the edited score alone
    expect(editedSinceSent(turn, reply("", "rock"), now("X:1 A1"))).toEqual([]);
    expect(editedSinceSent(turn, reply("X:1 R", "rock", "L1"), now("X:1 A1", "pop, piano", "L2"))).toEqual(["譜面", "スタイル", "歌詞"]);
    expect(editedSinceSent(turn, reply("X:1 R"), now("X:1 A0", "pop, piano", "L2"))).toEqual([]);
  });

  it("catches a turn applied while a later request was pending (its reply was made from the older score)", () => {
    // turn N-1 applied R1 after turn N was sent with A0
    expect(editedSinceSent(turn, reply("X:1 R2"), now("X:1 R1"))).toEqual(["譜面"]);
  });

  it("compares a melody re-ask with the score that was in the editor, not the earlier score it was sent against", () => {
    // the re-ask is made against the turn's sent score while the editor holds that turn's applied reply
    const reask = { ...turn, editorAbc: "X:1 R1" };
    expect(editedSinceSent(reask, reply("X:1 R2"), now("X:1 R1"))).toEqual([]);
    expect(editedSinceSent(reask, reply("X:1 R2"), now("X:1 R1 edited"))).toEqual(["譜面"]);
  });
});

describe("AI 編集 work that loading another song would replace", () => {
  it("names the pending request and the unapplied ABC text too", () => {
    expect(editWork({ turns: 0, edited: false, textDirty: false, pending: false })).toEqual([]);
    expect(editWork({ turns: 1, edited: false, textDirty: false, pending: true })).toEqual(["対話 1 件", "AI への依頼（応答待ち）"]);
    expect(editWork({ turns: 0, edited: false, textDirty: true, pending: false })).toEqual(["未反映の ABC テキスト"]);
    expect(editWork({ turns: 3, edited: true, textDirty: true, pending: false })).toEqual(["対話 3 件", "譜面・スタイル・歌詞の変更", "未反映の ABC テキスト"]);
  });
});

describe("AI 編集's planned score of a song rendered without one", () => {
  const running = { id: "s1", status: "running", abc: "" };
  const done = { id: "s1", status: "done", abc: "X:1 planned" };

  it("is loaded into the editor while it is still empty, once", () => {
    expect(plannedScoreLoad(running, done, { abc: "", textDirty: false })).toBe("load");
    // already seen, another song than last time, not finished, or nothing planned
    expect(plannedScoreLoad(done, done, { abc: "", textDirty: false })).toBeNull();
    expect(plannedScoreLoad({ ...running, id: "s0" }, done, { abc: "", textDirty: false })).toBeNull();
    expect(plannedScoreLoad(running, { ...done, status: "running" }, { abc: "", textDirty: false })).toBeNull();
    expect(plannedScoreLoad(running, { ...done, abc: " \n" }, { abc: "", textDirty: false })).toBeNull();
    // a score applied in the meantime stays
    expect(plannedScoreLoad(running, done, { abc: "X:1 mine", textDirty: false })).toBeNull();
  });

  it("does not replace ABC text typed in the empty editor and not applied (it is kept, and the user is told)", () => {
    expect(plannedScoreLoad(running, done, { abc: "", textDirty: true })).toBe("kept");
    // nothing to keep it for: not finished, or a score in the editor anyway
    expect(plannedScoreLoad(running, { ...done, status: "running" }, { abc: "", textDirty: true })).toBeNull();
    expect(plannedScoreLoad(running, done, { abc: "X:1 mine", textDirty: true })).toBeNull();
  });
});

describe("local LLM status", () => {
  const st = (p: Partial<{ alive: boolean; processRunning: boolean; external: boolean; restartRequired: boolean }>) => ({ alive: false, processRunning: false, external: false, restartRequired: false, ...p });

  it("shows this app's server as running while its process runs, also when /health does not answer yet", () => {
    expect(localLlmView(st({ alive: true, processRunning: true }))).toEqual({ label: "稼働中", toggle: "stop" });
    // still loading the model (or a start that ran past its time limit)
    expect(localLlmView(st({ processRunning: true }))).toEqual({ label: "起動中", toggle: "stop" });
    // running with the settings before a change (another port): stoppable, restarted by the next request
    expect(localLlmView(st({ processRunning: true, restartRequired: true }))).toEqual({ label: "稼働中（変更前の設定）", toggle: "stop" });
    expect(localLlmView(st({}))).toEqual({ label: "停止", toggle: "start" });
    // a server this app did not start: no button
    expect(localLlmView(st({ alive: true, external: true }))).toEqual({ label: "稼働中（このアプリが起動していない llama-server）", toggle: null });
  });
});

describe("compose piano-roll edits", () => {
  const e = (abc: string, base = "X:1 A") => ({ title: "曲A", base, abc });

  it("are kept per song across a selection change (a finished job or a new request selects another song)", () => {
    let m = recordPianoEdit({}, "a", e("X:1 A edited"));
    // the selection moved to b: a's edit is still there, listed and reopenable
    expect(m.a.abc).toBe("X:1 A edited");
    expect(otherPianoEdits(m, "b", new Set(["a", "b"]))).toEqual([{ id: "a", title: "曲A", exists: true }]);
    expect(otherPianoEdits(m, "a", new Set(["a", "b"]))).toEqual([]);
    // an edit of b does not replace a's
    m = recordPianoEdit(m, "b", { title: "曲B", base: "X:1 B", abc: "X:1 B edited" });
    expect(Object.keys(m).sort()).toEqual(["a", "b"]);
    // a deleted song's edit can still be copied into the form, but not reopened
    expect(otherPianoEdits(m, "b", new Set(["b"]))).toEqual([{ id: "a", title: "曲A", exists: false }]);
  });

  it("keep the first base and go away when undone back to it", () => {
    let m = recordPianoEdit({}, "a", e("X:1 A1"));
    m = recordPianoEdit(m, "a", e("X:1 A2", "X:1 A1"));
    expect(m.a).toEqual({ title: "曲A", base: "X:1 A", abc: "X:1 A2" });
    expect(recordPianoEdit(m, "a", e("X:1 A"))).toEqual({});
  });
});

describe("style tempo sync", () => {
  it("sets the style's tempo to the score's, with the note", () => {
    expect(styleTempoSync("pop, 120 BPM", 88)).toEqual({ style: "pop, 88 BPM", bpm: 88, note: "スタイルの BPM を譜面の Q: に合わせました（88 BPM）" });
    expect(styleTempoSync("pop", 118.4)?.style).toBe("pop, 118 BPM");
    expect(styleTempoSync("pop, 88 BPM", 88)).toBeNull();
    expect(styleTempoSync("pop", null)).toBeNull();
  });

  it("applied to the field as it is later keeps edits made meanwhile", () => {
    // the one-button instrumental: the style was edited while the score was being planned
    const sync = styleTempoSync("pop", 118)!;
    expect(withStyleBpm("pop, saxophone", sync.bpm)).toBe("pop, saxophone, 118 BPM");
  });
});

describe("margins and small helpers", () => {
  it("share one formula per case", () => {
    expect(scoreMarginSeconds(300)).toBe(355);
    expect(lyricMarginSeconds(300)).toBe(405);
    expect(lyricMarginSeconds(-5)).toBe(15);
    // covers keep their own documented rule (USER_GUIDE: 譜面の長さ × 1.1 + 15 秒)
    expect(coverMarginSeconds(300)).toBe(345);
    expect(coverMaxDuration(400, 900, 360)).toBe(coverMarginSeconds(400));
  });

  it("clamps the variation count", () => {
    expect(clampVariations("3")).toBe(3);
    expect(clampVariations("")).toBe(1);
    expect(clampVariations("0")).toBe(1);
    expect(clampVariations("12")).toBe(8);
    expect(clampVariations("2.7")).toBe(2);
  });

  it("keeps the last variation count when the field is emptied", () => {
    expect(committedVariations("", 4)).toBe(4);
    expect(committedVariations("  ", 4)).toBe(4);
    expect(committedVariations("abc", 3)).toBe(3);
    expect(committedVariations("6", 4)).toBe(6);
    expect(committedVariations("12", 4)).toBe(8);
    expect(committedVariations("0", 4)).toBe(1);
  });

  it("shows a long diff only around its changes", () => {
    const same = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "same" as const, text: `s${i}` }));
    const short = [...same(3), { kind: "add" as const, text: "x" }];
    expect(diffWithContext(short)).toEqual(short);
    const long = [...same(50), { kind: "del" as const, text: "a" }, { kind: "add" as const, text: "b" }, ...same(50)];
    const rows = diffWithContext(long, 2, 60);
    expect(rows).toEqual([{ kind: "gap", skipped: 48 }, long[48], long[49], long[50], long[51], long[52], long[53], { kind: "gap", skipped: 48 }]);
  });
});

describe("durationBudget", () => {
  const base = { auto: true, manual: 120, limit: 900, defaultMax: 360, abc: "", lyricEstimate: 57 };

  it("never goes below the default (planner path), and grows for long lyrics", () => {
    expect(durationBudget(base).seconds).toBe(360);
    expect(durationBudget({ ...base, lyricEstimate: 300 }).seconds).toBe(Math.ceil(300 * 1.3 + 15));
    expect(durationBudget({ ...base, lyricEstimate: 300 }).source).toBe("lyrics");
    expect(durationBudget({ ...base, lyricEstimate: 900 }).seconds).toBe(900);
  });

  it("sizes a fixed score from its length, not from the lyrics box", () => {
    // empty lyrics used to give 41 s; a long score now gets nominal × 1.15 + 10
    const long = fx("full_long.abc");
    const sec = scoreSeconds(parseAbc(long));
    const b = durationBudget({ ...base, abc: long, lyricEstimate: 20 });
    expect(b.scoreSeconds).toBeCloseTo(sec, 5);
    expect(b.seconds).toBe(Math.max(360, Math.ceil(sec * 1.15 + 10)));
    // a short score keeps the default
    expect(durationBudget({ ...base, abc: SMALL }).seconds).toBe(360);
  });

  it("uses the default when the score cannot be read at all", () => {
    expect(durationBudget({ ...base, abc: "garbage" }).seconds).toBe(360);
  });

  it("keeps a manual value and warns when the score is longer", () => {
    const b = durationBudget({ ...base, auto: false, manual: 5, abc: SMALL.replace("Q:1/4=60", "Q:1/4=30") });
    expect(b.seconds).toBe(8);
    expect(b.warning).toContain("超えています");
    expect(durationBudget({ ...base, auto: false, manual: 60, abc: SMALL }).warning).toBeNull();
    expect(durationBudget({ ...base, auto: false, manual: 2000 }).seconds).toBe(900);
  });

  it("respects a lower configured limit", () => {
    expect(durationBudget({ ...base, limit: 200 }).seconds).toBe(200);
  });

  it("calls long lyrics 延長 only when the budget really grew past the default", () => {
    // 曲長の最大値 300 clamps the default to 300: the long lyrics want more, but nothing was extended
    const capped = durationBudget({ ...base, limit: 300, defaultMax: 300, lyricEstimate: 300 });
    expect(capped).toMatchObject({ seconds: 300, source: "default" });
    // a limit above the default still extends for them
    expect(durationBudget({ ...base, limit: 400, defaultMax: 300, lyricEstimate: 300 })).toMatchObject({ seconds: 400, source: "lyrics" });
  });

  it("warns when the configured maximum cuts an automatic budget below a fixed score, without calling it 延長", () => {
    const long = fx("full_long.abc"); // about 3:19
    const cut = durationBudget({ ...base, limit: 180, defaultMax: 180, abc: long });
    expect(cut.seconds).toBe(180);
    // 3:00 is the default, not a budget extended for the score
    expect(cut.source).toBe("default");
    expect(cut.warning).toBe("譜面の長さ（約 3:19）が、設定の「曲長の最大値」（3:00）を超えています。曲の途中で切れる可能性があります");
    expect(scoreCutWarning(199.5, 180)).toBe(cut.warning);
    // a limit that still covers the score (only the margin is cut) extends without a warning
    expect(durationBudget({ ...base, limit: 200, defaultMax: 180, abc: long })).toMatchObject({ seconds: 200, source: "score", warning: null });
    expect(durationBudget({ ...base, limit: 900, defaultMax: 180, abc: long }).warning).toBeNull();
    expect(scoreCutWarning(null, 180)).toBeNull();
    expect(scoreCutWarning(180, 180)).toBeNull();
  });
});

describe("cover / re-render budgets", () => {
  it("never shrink below the default", () => {
    expect(coverMaxDuration(60, 900, 360)).toBe(360);
    expect(coverMaxDuration(400, 900, 360)).toBe(Math.ceil(400 * 1.1 + 15));
    expect(coverMaxDuration(null, 300, 360)).toBe(300);
    expect(rerenderMaxDuration({ stored: 89, lyricEstimate: 57, scoreSec: 70, limit: 900, defaultMax: 360 })).toBe(360);
    expect(rerenderMaxDuration({ stored: 500, lyricEstimate: 57, scoreSec: 70, limit: 900, defaultMax: 360 })).toBe(500);
    expect(rerenderMaxDuration({ stored: null, lyricEstimate: 400, scoreSec: null, limit: 900, defaultMax: 360 })).toBe(Math.ceil(400 * 1.3 + 15));
    expect(rerenderMaxDuration({ stored: null, lyricEstimate: 0, scoreSec: 600, limit: 600, defaultMax: 360 })).toBe(600);
  });
});

describe("lyrics helpers", () => {
  it("detects sung words", () => {
    expect(hasSungWords("")).toBe(false);
    expect(hasSungWords("[Intro]\n\n[Verse]\n")).toBe(false);
    expect(hasSungWords("[Verse]\nla la")).toBe(true);
  });

  it("builds a tag skeleton from section comments", () => {
    expect(tagSkeletonFromAbc(fx("full_long.abc"))).toBe(
      "[Intro]\n\n[Verse]\n\n[Pre-Chorus]\n\n[Chorus]\n\n[Verse]\n\n[Pre-Chorus]\n\n[Chorus]\n\n[Bridge]\n\n[Chorus]\n\n[Outro]\n",
    );
    expect(tagSkeletonFromAbc("% verse\n% verse\n% guitar solo\n")).toBe("[Verse]\n\n[Guitar Solo]\n");
    expect(tagSkeletonFromAbc(SMALL.replace("% verse\n", ""))).toBe("");
  });
});

describe("replaceAbcTempo", () => {
  it("rewrites only the header Q: line", () => {
    const out = replaceAbcTempo(SMALL, 96);
    expect(out).toContain("Q:1/4=96");
    expect(out).not.toContain("Q:1/4=60");
    expect(out.replace("Q:1/4=96", "Q:1/4=60")).toBe(SMALL);
    expect(parseAbc(out).bpm).toBe(96);
  });
  it("inserts Q: before the voices when missing", () => {
    const out = replaceAbcTempo(SMALL.replace("Q:1/4=60\n", ""), 90);
    expect(parseAbc(out).bpm).toBe(90);
  });
  it("inserts Q: before K: when the voices are declared only in the body", () => {
    const text = "X:1\nT:\nM:4/4\nL:1/16\nK:C\nV: Vocal\nC16|\n";
    expect(replaceAbcTempo(text, 90)).toBe("X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=90\nK:C\nV: Vocal\nC16|\n");
  });
});

describe("stored parameters", () => {
  it("reads old and new rows leniently", () => {
    expect(storedParams("")).toEqual({});
    expect(storedParams("{}")).toEqual({});
    expect(storedParams("not json")).toEqual({});
    const p = storedParams(JSON.stringify({ style: "x", lyrics: "", mode: "full", abc: "X:1", seed: 1, maxDuration: 89, temperature: 0.8, steps: 16 }));
    expect(samplingFrom(p, DEFAULT_SAMPLING)).toEqual({ ...DEFAULT_SAMPLING, temperature: 0.8, steps: 16 });
    expect(storedMaxDuration(p)).toBe(89);
    expect(storedMaxDuration({})).toBeNull();
    expect(usedFixedAbc(p, "full")).toBe(true);
    expect(usedFixedAbc({ abc: "" }, "full")).toBe(false);
    expect(usedFixedAbc(p, "off")).toBe(false);
  });
});

describe("the AI edit's automatic re-ask and repeated fields", () => {
  it("re-asks an excerpt, an unparsable score and new native-dialect errors only", () => {
    expect(worthReask(null, true, 0)).toBe(false);
    expect(worthReask({ kind: "short", bars: 8, level: "reask" }, true, 0)).toBe(true);
    expect(worthReask({ kind: "short", bars: 8, level: "note" }, true, 0)).toBe(false);
    expect(worthReask({ kind: "short", bars: 8, level: "shortened" }, true, 0)).toBe(false);
    // a score the parser rejects: re-asked unless the sent score already fails to parse
    expect(worthReask({ kind: "parse", message: "x" }, true, 3)).toBe(true);
    expect(worthReask({ kind: "parse", message: "x" }, false, 0)).toBe(false);
    // native errors: re-asked when the sent score had none, or the reply has more
    const native = (n: number) => ({ kind: "native" as const, errors: Array.from({ length: n }, (_, i) => "e" + i), bars: 24 });
    expect(worthReask(native(1), true, 0)).toBe(true);
    expect(worthReask(native(2), true, 2)).toBe(false);
    expect(worthReask(native(3), true, 2)).toBe(true);
  });

  it("asks for the complete score, names the parse error, and lists at most eight native errors", () => {
    expect(reaskText({ kind: "short", bars: 8, level: "reask" }, 24)).toContain("返された譜面は 8 小節しかありません（元は 24 小節）");
    expect(reaskText({ kind: "parse", message: "行 3: 不正" }, 24)).toContain("返された譜面を解釈できません（行 3: 不正）");
    const t = reaskText({ kind: "native", errors: Array.from({ length: 10 }, (_, i) => "err" + i), bars: 24 }, 24);
    expect(t).toContain("- err7");
    expect(t).not.toContain("err8");
    for (const v of [{ kind: "short" as const, bars: 8, level: "reask" as const }, { kind: "parse" as const, message: "m" }]) expect(reaskText(v, 24)).toContain("X:1 から最後の小節まで");
  });

  it("treats a field returned whole but unchanged as unchanged", () => {
    const sent = { abc: "X:1\nK:C\n", style: "pop, 86 BPM", lyrics: "[Verse]\n空" };
    const reply = { abc: "", style: " pop, 86 BPM ", lyrics: "[Verse]\r\n空\n", explanation: "書き直しました" };
    const r = dropRepeatedFields(reply, sent);
    expect(r.repeated).toEqual(["style", "lyrics"]);
    expect(r.reply).toEqual({ abc: "", style: "", lyrics: "", explanation: "書き直しました" });
    // the reply passed in is not changed
    expect(reply.style).toBe(" pop, 86 BPM ");
    // a changed field stays, an empty one is not "repeated"
    const changed = { abc: "X:1\nK:D\n", style: "rock, 90 BPM", lyrics: "", explanation: "" };
    expect(dropRepeatedFields(changed, sent)).toEqual({ reply: changed, repeated: [] });
    expect(dropRepeatedFields({ ...changed, abc: "X:1\nK:C" }, sent).repeated).toEqual(["abc"]);
    // a score sent from another base than the editor's (the melody re-ask after an apply): never "repeated", since
    // an empty score keeps the editor's and the reply restores the base
    const base = "X:1\nK:C\n|C4|\n";
    expect(dropRepeatedFields({ ...changed, abc: base }, { ...sent, abc: null }).reply.abc).toBe(base);
    // the score's outer whitespace counts (the native check and YuE2 read it): only CRLF and one final line break do not
    expect(dropRepeatedFields({ ...changed, abc: "X:1\r\nK:C\r\n|C4|" }, { ...sent, abc: base }).repeated).toEqual(["abc"]);
    for (const sentAbc of [base + "\n", "\n" + base, " " + base, "X:1\nK:C\n|C4|  \n"]) expect(dropRepeatedFields({ ...changed, abc: base }, { ...sent, abc: sentAbc }).repeated).toEqual([]);
    expect(repeatedFieldsNote(["style", "lyrics"])).toBe("⚠ AI が返したスタイル・歌詞は送った内容と同じで、変更はありませんでした。指示を言い換えてもう一度お試しください。");
  });
});

describe("the title of an AI edit's re-render", () => {
  it("keeps the edited song's current title, and leaves it to the backend without a song", () => {
    const vocal = "[Verse]\n夕暮れの道";
    expect(rerenderTitle({ title: "夕暮れのメロディー", lyrics: vocal }, "[Verse]\n朝焼けの道")).toBe("夕暮れのメロディー");
    expect(rerenderTitle({ title: "  夜（インスト） ", lyrics: "[Intro]\n[Verse]" }, "[Verse]\n\n[Chorus]")).toBe("夜（インスト）");
    expect(rerenderTitle({ title: "   ", lyrics: vocal }, vocal)).toBeUndefined();
    expect(rerenderTitle(null, vocal)).toBeUndefined();
    expect(rerenderTitle(undefined, vocal)).toBeUndefined();
  });

  it("names it anew when the edit turned a vocal song into an instrumental or back", () => {
    expect(rerenderTitle({ title: "夜（インスト）", lyrics: "[Intro]\n[Verse]" }, "[Verse]\n星が降る")).toBeUndefined();
    expect(rerenderTitle({ title: "星が降る", lyrics: "[Verse]\n星が降る" }, "[Verse]\n[Chorus]")).toBeUndefined();
  });
});
