import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChoiceRequest } from "../../components/ChoiceDialog";
import { AcceptedAdvice } from "../scoreAdvice";
import { planSubmission, type PlanInput } from "../submitPlan";

// The automatic budget capped below a fixed score by the configured maximum (rules.ts durationBudget): the send
// asks, as it does for a manual limit, instead of cutting the song off without a word.
const LONG = readFileSync(join(__dirname, "..", "..", "abc", "__fixtures__", "full_long.abc"), "utf8"); // about 3:19

function scripted(...answers: (string | null)[]) {
  const asked: ChoiceRequest<string>[] = [];
  const ask = async <T extends string>(r: ChoiceRequest<T>): Promise<T | null> => {
    asked.push(r as ChoiceRequest<string>);
    return (answers.shift() ?? null) as T | null;
  };
  return { ask, asked };
}

const input = (limit: number, defaultMax: number): PlanInput => ({
  formMode: "full",
  formAbc: "",
  formStyle: "rock, 83 BPM",
  sung: "[Verse]\nあさのひかりが",
  formLyrics: true,
  over: { mode: "full", abc: LONG, style: "rock, 83 BPM" },
  durations: { auto: true, manual: 360, limit, defaultMax, fallbackEstimate: 60 },
});

describe("automatic budget below the score", () => {
  it("asks before sending a score the configured maximum cuts off (only 「そのまま」: there is no room to widen)", async () => {
    const { ask, asked } = scripted("asis");
    const plan = await planSubmission(input(180, 180), { ask, estimateDuration: async () => 60, acceptedAdvice: new AcceptedAdvice() });
    const q = asked.find((r) => r.title === "曲長の上限が譜面の長さより短くなっています");
    expect(q?.message).toContain("曲長の最大値");
    expect(q?.choices.map((c) => c.label)).toEqual(["3:00 のまま生成"]);
    expect(plan?.maxDuration).toBe(180);
  });

  it("does not ask when the maximum leaves room for the score", async () => {
    const { ask, asked } = scripted();
    const plan = await planSubmission(input(900, 180), { ask, estimateDuration: async () => 60, acceptedAdvice: new AcceptedAdvice() });
    expect(asked.map((r) => r.title)).not.toContain("曲長の上限が譜面の長さより短くなっています");
    expect(plan?.maxDuration).toBe(240);
  });
});
