// Regression checks after the compliance fixes: advisory dialog memory, AI-edit re-render mode/cfg and tempo
// dialog order, instrumental provenance params, the shared duration bounds and the wizard's precision rule.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChoiceRequest } from "../../components/ChoiceDialog";
import { AcceptedAdvice, NON_NATIVE_MESSAGE, PARSER_FINDING, adviceDecision, confirmScoreAdvice, findingsAcceptedAtApply, scoreFindings } from "../scoreAdvice";
import { UNTAGGED_LYRICS_HINT } from "../../abc/consistency";
import { MAX_DURATION_CAP, OFF_COMPAT_CFG, durationLimits, provenanceParams, rerenderModeAndCfg, tempoDialogDefault } from "../rules";
import { MAX_DURATION_CAP as LIBRARY_CAP } from "../../library/songMeta";
import { DURATION_LIMIT_MAX, wizardMayChoosePrecision } from "../../config/rules";

const hint = `${UNTAGGED_LYRICS_HINT}（公式: 歌詞はセクションタグ付きで書く）。…`;

describe("advisory score dialog", () => {
  it("never opens for the untagged-lyrics hint alone; the hint becomes a note", () => {
    expect(adviceDecision([hint])).toEqual({ ask: false, details: [], notes: [hint] });
    expect(adviceDecision([])).toEqual({ ask: false, details: [], notes: [] });
    const d = adviceDecision(["6〜7 行目は…", hint]);
    expect(d.ask).toBe(true);
    expect(d.details).toEqual(["6〜7 行目は…", hint]);
  });

  it("does not ask again about findings accepted for the same score and sung text", () => {
    const memo = new AcceptedAdvice();
    const issues = ["1〜2 行目は…", "セクションの数が…"];
    expect(adviceDecision(issues, memo.get("X:1", "la")).ask).toBe(true);
    memo.accept("X:1", "la", issues);
    expect(adviceDecision(issues, memo.get("X:1", "la")).ask).toBe(false);
    // other sung text or another score: asked again
    expect(adviceDecision(issues, memo.get("X:1", "lu")).ask).toBe(true);
    expect(adviceDecision(issues, memo.get("X:2", "la")).ask).toBe(true);
    // a new finding is asked even when the old ones were accepted
    expect(adviceDecision([...issues, "新しい指摘"], memo.get("X:1", "la")).ask).toBe(true);
  });

  it("AI edit apply accepts only the findings its dialog showed", () => {
    const official = readFileSync(join(__dirname, "..", "..", "abc", "__fixtures__", "official_score.abc"), "utf8");
    // unparsable reply: the dialog listed only the parser error; the native findings are still asked at render
    const unparsable = `${official}V: Bass\nC4D4E4F4|\n`;
    const all = scoreFindings(unparsable).issues;
    expect(all.some((i) => i.startsWith(PARSER_FINDING))).toBe(true);
    expect(all.some((i) => !i.startsWith(PARSER_FINDING))).toBe(true);
    const memo = new AcceptedAdvice();
    const taken = findingsAcceptedAtApply(unparsable, ["未対応の声部 \"Bass\""], true);
    expect(taken.every((i) => i.startsWith(PARSER_FINDING))).toBe(true);
    memo.accept(unparsable, null, taken);
    const d = adviceDecision(all, memo.get(unparsable, "la"));
    expect(d.ask).toBe(true);
    // native reply: exactly the listed findings of the applied text
    const titled = official.replace(/^T:.*$/m, "T:My Song");
    const shown = scoreFindings(titled).issues;
    expect(shown.length).toBeGreaterThan(0);
    expect(findingsAcceptedAtApply(titled, shown, false)).toEqual(shown);
    expect(findingsAcceptedAtApply(titled, shown.slice(1), false)).toEqual(shown.slice(1));
    expect(findingsAcceptedAtApply(titled, [], false)).toEqual([]);
  });

  it("findings accepted for the score alone (AI edit apply) hold for any sung text", () => {
    const memo = new AcceptedAdvice();
    memo.accept("X:1", null, ["記法の指摘"]);
    expect(adviceDecision(["記法の指摘"], memo.get("X:1", "any")).ask).toBe(false);
    // a section finding that apply never showed is still asked
    expect(adviceDecision(["記法の指摘", "セクションの数が…"], memo.get("X:1", "any")).ask).toBe(true);
  });
});

describe("shared score confirmation (compose, cover, AI edit)", () => {
  const fixture = (name: string) => readFileSync(join(__dirname, "..", "..", "abc", "__fixtures__", name), "utf8");
  const long = fixture("full_long.abc");
  const sung = "[Verse]\nあさ\n[Chorus]\nはしれ";
  function scripted(...answers: (string | null)[]) {
    const asked: ChoiceRequest<string>[] = [];
    const ask = async <T extends string>(r: ChoiceRequest<T>): Promise<T | null> => {
      asked.push(r as ChoiceRequest<string>);
      return (answers.shift() ?? null) as T | null;
    };
    return { ask, asked };
  }

  it("uses the page's own text for a section mismatch and remembers a confirmed send", async () => {
    const memo = new AcceptedAdvice();
    const first = scripted("send");
    const r = await confirmScoreAdvice({ abc: long, sung, findings: scoreFindings(long), accepted: memo, ask: first.ask, mismatchMessage: "ページの文言" });
    expect(r).toEqual({ ok: true, notes: [] });
    expect(first.asked[0].message).toBe("ページの文言");
    expect(first.asked[0].choices[0].label).toBe("このまま送信");
    const again = scripted();
    expect((await confirmScoreAdvice({ abc: long, sung, findings: scoreFindings(long), accepted: memo, ask: again.ask, mismatchMessage: "ページの文言" })).ok).toBe(true);
    expect(again.asked).toHaveLength(0);
  });

  it("reports a cancel, and uses the shared text and parser finding for a non-native score", async () => {
    const bad = `${fixture("official_score.abc")}V: Bass\nC4D4E4F4|\n`;
    const { ask, asked } = scripted(null);
    const r = await confirmScoreAdvice({ abc: bad, sung, findings: scoreFindings(bad), accepted: new AcceptedAdvice(), ask, mismatchMessage: "ページの文言" });
    expect(r.ok).toBe(false);
    expect(asked[0].message).toBe(NON_NATIVE_MESSAGE);
    expect(asked[0].details?.some((d) => d.startsWith(PARSER_FINDING) && d.includes("コードの有無は文字列から判定します"))).toBe(true);
  });

  it("turns the untagged-lyrics hint into a note without a dialog", async () => {
    const score = fixture("official_score.abc");
    const { ask, asked } = scripted();
    const r = await confirmScoreAdvice({ abc: score, sung: "あさのひかり", findings: scoreFindings(score), accepted: new AcceptedAdvice(), ask, mismatchMessage: "x" });
    expect(asked).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.notes.length).toBeGreaterThan(0);
  });
});

describe("AI-edit re-render mode and cfg", () => {
  it("keeps an off song off when there is no score", () => {
    expect(rerenderModeAndCfg({ hasAbc: false, hasChords: false, storedMode: "off", cfgScale: OFF_COMPAT_CFG })).toEqual({ mode: "off", cfgScale: OFF_COMPAT_CFG });
    expect(rerenderModeAndCfg({ hasAbc: false, hasChords: false, storedMode: "melody", cfgScale: 1 }).mode).toBe("melody");
    expect(rerenderModeAndCfg({ hasAbc: false, hasChords: false, storedMode: undefined, cfgScale: 1 }).mode).toBe("full");
  });

  it("follows the score an edit added, without carrying the off-compatible cfg", () => {
    expect(rerenderModeAndCfg({ hasAbc: true, hasChords: true, storedMode: "off", cfgScale: OFF_COMPAT_CFG })).toEqual({ mode: "full", cfgScale: 1.0 });
    expect(rerenderModeAndCfg({ hasAbc: true, hasChords: false, storedMode: "off", cfgScale: 1.5 })).toEqual({ mode: "melody", cfgScale: 1.5 });
    expect(rerenderModeAndCfg({ hasAbc: true, hasChords: false, storedMode: "full", cfgScale: OFF_COMPAT_CFG }).cfgScale).toBe(OFF_COMPAT_CFG);
  });
});

describe("AI-edit tempo dialog order", () => {
  const sentAbc = "X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=120\nK:C\n";
  it("offers following the score first when only Q: changed", () => {
    expect(tempoDialogDefault({ sentAbc, sentStyle: "rock, 120 BPM", replyHasAbc: true, bpm: 128, styleBpm: 120 })).toBe("style");
  });
  it("keeps changing Q: first when the style's tempo changed or there is no baseline", () => {
    expect(tempoDialogDefault({ sentAbc, sentStyle: "rock, 120 BPM", replyHasAbc: false, bpm: 120, styleBpm: 128 })).toBe("abc");
    expect(tempoDialogDefault({ sentAbc, sentStyle: "rock, 120 BPM", replyHasAbc: true, bpm: 128, styleBpm: 132 })).toBe("abc");
    expect(tempoDialogDefault({ sentAbc: "", sentStyle: "", replyHasAbc: true, bpm: 128, styleBpm: 120 })).toBe("abc");
  });
});

describe("instrumental provenance params", () => {
  it("copies only the fields that are set", () => {
    expect(provenanceParams({})).toEqual({});
    const plan = { style: "pop", lyrics: "[Verse]\nla", mode: "full", seed: 5, abcTemperature: 0.7 };
    expect(provenanceParams({ sourceAbc: "X:1", instrumentalTransfer: { movedNotes: 3, overlaps: 1 }, plan })).toEqual({
      sourceAbc: "X:1",
      instrumentalTransfer: { movedNotes: 3, overlaps: 1 },
      plan,
    });
  });
});

describe("duration bounds", () => {
  it("are one value across the pages", () => {
    expect(MAX_DURATION_CAP).toBe(DURATION_LIMIT_MAX);
    expect(LIBRARY_CAP).toBe(DURATION_LIMIT_MAX);
    expect(durationLimits(null)).toEqual({ limit: 900, defaultMax: 360 });
    expect(durationLimits({ maxDurationLimit: 30, defaultMaxDuration: 20 })).toEqual({ limit: 60, defaultMax: 20 });
  });
});

describe("setup wizard precision", () => {
  it("chooses on a first setup, also one resumed after a restart, and keeps an explicit choice", () => {
    expect(wizardMayChoosePrecision({ licenseAccepted: false })).toBe(true);
    // license accepted before the downloads, app closed half way: still a first setup
    expect(wizardMayChoosePrecision({ licenseAccepted: true, precisionExplicit: false })).toBe(true);
    expect(wizardMayChoosePrecision({ licenseAccepted: true, precisionExplicit: true })).toBe(false);
  });
});
