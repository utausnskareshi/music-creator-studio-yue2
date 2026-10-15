// Unit tests of the E2E driver's pure helpers (no ComfyUI needed; part of `npx vitest run`).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearRunOutputs, missingExpected, missingUploads, normalizeGraph, notRunAfterPass, parseOnly, parseOpt, planRun, promptQueued, resultState, runProblem, sameGraph, staleInputProblem, staleResultProblem, unexpectedArgs, type Scenario, type ScenarioState } from "./driver_lib.mjs";

describe("parseOpt", () => {
  it("treats a flag without a value as absent", () => {
    expect(parseOpt(["run", "--dir", "X"], "dir")).toBe("X");
    expect(parseOpt(["run", "--dir"], "dir", "def")).toBe("def");
    expect(parseOpt(["run", "--dir", "--force"], "dir")).toBeUndefined();
    expect(parseOpt(["run"], "server", "http://127.0.0.1:8198")).toBe("http://127.0.0.1:8198");
  });
});

describe("unexpectedArgs", () => {
  const RUN = { values: ["dir", "server", "only"], flags: ["force", "retry-failed"] };

  it("accepts the known options, each with its value as the next argument", () => {
    expect(unexpectedArgs(["--dir", "X", "--server", "http://127.0.0.1:8198", "--only", "gen_b,gen_a", "--force", "--retry-failed"], RUN)).toEqual([]);
    expect(unexpectedArgs([], RUN)).toEqual([]);
    // a value option without its value: parseOpt reads it as absent (the driver reports a bare --only itself)
    expect(unexpectedArgs(["--only", "--force"], RUN)).toEqual([]);
    expect(unexpectedArgs(["--dir"], RUN)).toEqual([]);
  });

  it("lists a stray word (an unquoted list with spaces), an unknown or --name=value option and a repeated one", () => {
    // `--only gen_b, gen_a` reaches the driver as two arguments: gen_a would be left out without a word
    expect(unexpectedArgs(["--dir", "X", "--only", "gen_b,", "gen_a"], RUN)).toEqual(["gen_a"]);
    expect(unexpectedArgs(["--only=gen_a"], RUN)).toEqual(["--only=gen_a"]);
    expect(unexpectedArgs(["--forse", "--force=yes"], RUN)).toEqual(["--forse", "--force=yes"]);
    expect(unexpectedArgs(["--only", "gen_a", "--only", "gen_b"], RUN)).toEqual(["--only", "gen_b"]);
    expect(unexpectedArgs(["--force", "--force"], RUN)).toEqual(["--force"]);
  });
});

describe("parseOnly", () => {
  const names = ["gen_a", "gen_b", "sep_h1"];

  it("trims the names and lists those the manifest lacks", () => {
    expect(parseOnly(undefined, names)).toEqual({ only: [], unknown: [] });
    expect(parseOnly("gen_b, gen_a,", names)).toEqual({ only: ["gen_b", "gen_a"], unknown: [] });
    // a misspelled name must not turn the run into "nothing to run"
    expect(parseOnly("gen_x, gen_a", names)).toEqual({ only: ["gen_x", "gen_a"], unknown: ["gen_x"] });
    expect(parseOnly(" , ", names)).toEqual({ only: [], unknown: [] });
  });
});

describe("graph comparison", () => {
  const graph = (prefix: string, input = "abc123_song.wav") => ({
    src: { class_type: "LoadAudio", inputs: { audio: input } },
    save: { class_type: "MCS_SaveAudioWav", inputs: { audio: ["src", 0], filename_prefix: prefix } },
  });

  it("ignores the random output prefix only", () => {
    expect(sameGraph(graph("mcs/1a2b3c4d"), graph("mcs/9f8e7d6c"))).toBe(true);
    expect(normalizeGraph(graph("mcs/1a2b3c4d")).save.inputs.filename_prefix).toBe("<prefix>");
    // a content-addressed upload name changes with the upstream audio: the graph is stale
    expect(sameGraph(graph("mcs/a", "abc123_song.wav"), graph("mcs/a", "def456_song.wav"))).toBe(false);
    expect(sameGraph(graph("mcs/a"), { ...graph("mcs/a"), vae: { class_type: "VAEDecodeTiled", inputs: {} } })).toBe(false);
  });
});

describe("planRun", () => {
  const sc = (name: string, repeat_of?: string): Scenario => ({ name, meta: repeat_of ? { repeat_of } : {} });
  const scenarios = [sc("gen_a"), sc("gen_b"), sc("gen_k", "gen_b"), sc("gen_k2", "gen_b"), sc("plan_e"), sc("plan_e2", "plan_e")];
  const states =
    (m: Record<string, ScenarioState>) =>
    (s: Scenario): ScenarioState =>
      m[s.name] ?? "same";

  it("runs new and changed scenarios and the repeats of those, in manifest order", () => {
    const p = planRun(scenarios, { state: states({ gen_a: "none", gen_b: "changed" }) });
    expect(p.todo.map((s) => s.name)).toEqual(["gen_a", "gen_b", "gen_k", "gen_k2"]);
    expect(p.changed).toEqual(["gen_b"]);
    expect(p.dependents).toEqual(["gen_k", "gen_k2"]);
    expect(p.skipped).toEqual(["plan_e", "plan_e2"]);
  });

  it("keeps up-to-date results and runs everything with --force", () => {
    expect(planRun(scenarios, { state: states({}) }).todo).toEqual([]);
    expect(planRun(scenarios, { force: true, state: states({}) }).todo).toHaveLength(scenarios.length);
  });

  it("respects --only and lists the repeats it leaves out", () => {
    const p = planRun(scenarios, { only: ["plan_e"], force: true, state: states({}) });
    expect(p.todo.map((s) => s.name)).toEqual(["plan_e"]);
    expect(p.dependentsSkipped).toEqual(["plan_e2"]);
  });
});

describe("missingExpected", () => {
  it("lists expected scenarios that were not built, with the build's reason", () => {
    const manifest = { scenarios: [{ name: "gen_a" }], expected: ["gen_a", "gen_l", "sep_c"], missing: [{ name: "gen_l", reason: "needs results/tr_g_melody" }, "sep_c"] };
    expect(missingExpected(manifest)).toEqual([
      { name: "gen_l", reason: "needs results/tr_g_melody" },
      { name: "sep_c", reason: null },
    ]);
    expect(missingExpected({ scenarios: [{ name: "gen_a" }] })).toEqual([]);
  });

  it("reads the waits_for of e2e_build_graphs, an empty one as no reason", () => {
    const manifest = {
      scenarios: [],
      expected: ["gen_b_full_plan", "sep_b", "gen_d2_fixture_instrumental"],
      missing: [
        { name: "gen_b_full_plan", waits_for: "" },
        { name: "sep_b", waits_for: "the audio of gen_b_full_plan" },
        { name: "gen_d2_fixture_instrumental", waits_for: "inputs/instrumental.json (tools/e2e ts_steps)" },
      ],
    };
    expect(missingExpected(manifest)).toEqual([
      { name: "gen_b_full_plan", reason: null },
      { name: "sep_b", reason: "the audio of gen_b_full_plan" },
      { name: "gen_d2_fixture_instrumental", reason: "inputs/instrumental.json (tools/e2e ts_steps)" },
    ]);
  });
});

describe("session groups", () => {
  const sep = (name: string, group?: string, repeat_of?: string): Scenario => ({ name, meta: { ...(group ? { session_group: group } : {}), ...(repeat_of ? { repeat_of } : {}) } });
  const scenarios = [sep("sep_h1", "two"), sep("sep_h2", "two"), sep("sep_h3_repeat", "two"), sep("sep_h4"), sep("align_x", undefined, "sep_h1")];
  const states =
    (m: Record<string, ScenarioState>) =>
    (s: Scenario): ScenarioState =>
      m[s.name] ?? "same";

  it("runs every member, in manifest order, when one of them changed", () => {
    const p = planRun(scenarios, { state: states({ sep_h2: "changed" }) });
    expect(p.todo.map((s) => s.name)).toEqual(["sep_h1", "sep_h2", "sep_h3_repeat", "align_x"]);
    expect(p.skipped).toEqual(["sep_h4"]);
  });

  it("follows repeats and groups until nothing changes, and lists members --only leaves out", () => {
    expect(planRun(scenarios, { state: states({ sep_h1: "changed" }) }).todo.map((s) => s.name)).toEqual(["sep_h1", "sep_h2", "sep_h3_repeat", "align_x"]);
    const p = planRun(scenarios, { only: ["sep_h2"], state: states({ sep_h2: "changed" }) });
    expect(p.todo.map((s) => s.name)).toEqual(["sep_h2"]);
    expect(p.dependentsSkipped.sort()).toEqual(["sep_h1", "sep_h3_repeat"]);
    // a group member that is itself the original of a repeat pulls in that repeat too
    const chain = [sep("a", "g"), sep("b", "g"), sep("c", undefined, "b")];
    expect(planRun(chain, { state: states({ a: "none" }) }).todo.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });
});

describe("inputs and stale results", () => {
  it("lists uploads whose file is gone (an upstream scenario ran again after the build)", () => {
    const s: Scenario = { name: "sep_h1", uploads: [{ path: "results/gen_a/files/mcs/old.wav" }, { path: "inputs/x.wav" }] };
    expect(missingUploads(s, (p) => p === "inputs/x.wav")).toEqual(["results/gen_a/files/mcs/old.wav"]);
    expect(missingUploads({ name: "gen_l" }, () => false)).toEqual([]);
  });

  it("fails the check of a result whose input is gone, naming it and the way out (not a raw ENOENT)", () => {
    const s: Scenario = { name: "align_i_en", uploads: [{ path: "results/sep_h1/files/mcs_sep/old_vocals_00001_.wav" }] };
    expect(staleInputProblem(s, () => false)).toBe(
      "stale input (re-made by a later run: results/sep_h1/files/mcs_sep/old_vocals_00001_.wav): rebuild the graphs (cargo test e2e_build_graphs -- --ignored) and run again",
    );
    expect(staleInputProblem(s, () => true)).toBeNull();
    expect(staleInputProblem({ name: "gen_l" }, () => false)).toBeNull();
  });

  it("sorts the scenarios a pass did not run once it is over: a gone input makes an up-to-date or a failed one stale", () => {
    const names = ["gen_x", "sep_h1", "sep_h3_repeat", "align_i_en", "align_j_ja"];
    const plan = { skipped: ["sep_h1", "align_i_en"], failed: ["sep_h3_repeat", "align_j_ja"] };
    // align_i_en / align_j_ja read stems a scenario of the pass re-made; gen_x ran into its gone input itself
    const gone = (n: string) => n.startsWith("align_");
    expect(notRunAfterPass(plan, ["gen_x"], gone, names)).toEqual({ upToDate: ["sep_h1"], failed: ["sep_h3_repeat"], stale: ["gen_x", "align_i_en", "align_j_ja"] });
    expect(notRunAfterPass(plan, [], () => false, names)).toEqual({ upToDate: plan.skipped, failed: plan.failed, stale: [] });
  });

  it("fails the check of a result of an older graph only", () => {
    expect(staleResultProblem("changed")).toMatch(/^stale: /);
    expect(staleResultProblem("same")).toBeNull();
    expect(staleResultProblem("none")).toBeNull();
  });
});

describe("resultState", () => {
  it("does not take a failed re-run for the result of the new graph", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcs-e2e-driver-"));
    try {
      const put = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v));
      const oldGraph = { "1": { class_type: "A", inputs: { filename_prefix: "mcs/aaaa" } } };
      const newGraph = { "1": { class_type: "B", inputs: { filename_prefix: "mcs/bbbb" } } };
      expect(resultState(dir, oldGraph)).toBe("none");
      // a finished run of the old graph
      put("prompt.json", oldGraph);
      put("history.json", { status: { status_str: "success" } });
      put("timing.json", {});
      put("files.json", []);
      mkdirSync(join(dir, "files", "mcs"), { recursive: true });
      writeFileSync(join(dir, "files", "mcs", "a.wav"), "RIFF");
      expect(resultState(dir, { "1": { class_type: "A", inputs: { filename_prefix: "mcs/cccc" } } })).toBe("same");
      expect(resultState(dir, newGraph)).toBe("changed");
      // the re-run of the new graph starts (runScenario) and is rejected by POST /prompt
      clearRunOutputs(dir);
      expect(["history.json", "timing.json", "files.json", "files"].filter((f) => existsSync(join(dir, f)))).toEqual([]);
      put("prompt.json", newGraph);
      put("post_reply.json", { ok: false, status: 400, body: { node_errors: { "1": {} } } });
      expect(resultState(dir, newGraph)).toBe("none");
      expect(resultState(dir, oldGraph)).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes only a finished, successful run with all its files for an up-to-date result", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcs-e2e-driver-"));
    try {
      const put = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v));
      const graph = { "1": { class_type: "A", inputs: { filename_prefix: "mcs/aaaa" } } };
      const finished = () => {
        clearRunOutputs(dir);
        put("prompt.json", graph);
        put("history.json", { status: { status_str: "success" } });
        put("timing.json", {});
        put("files.json", [{ node: "save", filename: "a.wav", local: join(dir, "files", "a.wav") }]);
      };
      finished();
      expect(resultState(dir, graph)).toBe("same");
      // a run that ended in the downloads (an older driver wrote history.json first): no timing.json / files.json
      rmSync(join(dir, "timing.json"));
      rmSync(join(dir, "files.json"));
      expect(resultState(dir, graph)).toBe("none");
      finished();
      put("driver_error.json", { error: "TypeError: fetch failed" });
      expect(resultState(dir, graph)).toBe("none");
      // a download ComfyUI answered with an error status
      finished();
      put("files.json", [{ node: "save", filename: "a.wav", error: "view 500" }]);
      expect(resultState(dir, graph)).toBe("none");
      // a finished run whose execution failed: kept (check reports it), run again with --retry-failed or --force
      finished();
      put("history.json", { status: { status_str: "error" } });
      expect(resultState(dir, graph)).toBe("failed");
      put("history.json", { status: {} });
      expect(resultState(dir, graph)).toBe("failed");
      // a result of another graph stays "changed" (check reports it as stale)
      expect(resultState(dir, { "1": { class_type: "B", inputs: {} } })).toBe("changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a finished run whose execution failed", () => {
  // e2e_build_graphs: sep_h1 / sep_h2 / sep_h3_repeat in one session group; align_i_en reads sep_h1's vocal stem
  // (results/sep_h1/files/...), which a re-run of sep_h1 deletes and saves under a new name (stale_input).
  const graph = (n: string) => ({ save: { class_type: "MCS_SaveAudioWav", inputs: { filename_prefix: `mcs_sep/${n}` } } });
  const sep = (name: string): Scenario => ({ name, kind: "separate", meta: { session_group: "sep_two_songs" } });
  const scenarios: Scenario[] = [sep("sep_h1"), sep("sep_h2"), sep("sep_h3_repeat"), { name: "align_i_en", kind: "align", meta: {} }];

  it("is kept with its session group, so the scenarios built from the group's outputs run; --retry-failed runs the group again", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcs-e2e-driver-"));
    try {
      const finish = (name: string, status: string) => {
        const d = join(dir, name);
        mkdirSync(d, { recursive: true });
        const put = (f: string, v: unknown) => writeFileSync(join(d, f), JSON.stringify(v));
        put("prompt.json", graph(name));
        put("timing.json", {});
        put("files.json", []);
        put("history.json", { status: { status_str: status } });
      };
      finish("sep_h1", "success");
      finish("sep_h2", "success");
      finish("sep_h3_repeat", "error");
      const state = (s: Scenario) => resultState(join(dir, s.name), graph(s.name));
      expect(scenarios.map(state)).toEqual(["same", "same", "failed", "none"]);
      const p = planRun(scenarios, { state });
      expect(p.todo.map((s) => s.name)).toEqual(["align_i_en"]);
      expect(p.dependents).toEqual([]);
      expect(p.failed).toEqual(["sep_h3_repeat"]);
      expect(p.skipped).toEqual(["sep_h1", "sep_h2"]);
      const retry = planRun(scenarios, { retryFailed: true, state });
      expect(retry.todo.map((s) => s.name)).toEqual(["sep_h1", "sep_h2", "sep_h3_repeat", "align_i_en"]);
      expect(retry.retried).toEqual(["sep_h3_repeat"]);
      expect(retry.dependents).toEqual(["sep_h1", "sep_h2"]);
      expect(retry.failed).toEqual([]);
      // --force runs it like any other scenario
      const forced = planRun(scenarios, { force: true, state });
      expect(forced.todo).toHaveLength(4);
      expect(forced.retried).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("promptQueued", () => {
  it("finds a prompt among the running and pending items, and knows no answer that is not a queue", () => {
    const queue = { queue_running: [[1, "a", {}, {}, []]], queue_pending: [[2, "b", {}, {}, []], [3, "c"]] };
    expect(promptQueued(queue, "a")).toBe(true);
    expect(promptQueued(queue, "c")).toBe(true);
    expect(promptQueued(queue, "x")).toBe(false);
    expect(promptQueued({ queue_running: [], queue_pending: [] }, "a")).toBe(false);
    expect(promptQueued("Internal Server Error", "a")).toBeNull();
    expect(promptQueued({}, "a")).toBeNull();
  });
});

describe("runProblem", () => {
  it("names what ended a run that left no finished result", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcs-e2e-driver-"));
    try {
      const put = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v));
      const reset = () => clearRunOutputs(dir);
      expect(runProblem(dir)).toBe("not run");
      // an upload or POST /prompt that failed: only the driver's error
      put("driver_error.json", { error: 'Error: upload x.wav failed: 500 "boom"\n    at runScenario (driver.mjs:165:22)' });
      expect(runProblem(dir)).toBe('driver error: Error: upload x.wav failed: 500 "boom"');
      reset();
      put("post_reply.json", { ok: false, status: 400, body: { error: { message: "Prompt outputs failed validation" }, node_errors: { "3": {} } } });
      expect(runProblem(dir)).toMatch(/^rejected: \{"error"/);
      put("post_reply.json", { ok: true, status: 200, body: { prompt_id: "p", number: 1, node_errors: { "3": { errors: [] } } } });
      expect(runProblem(dir)).toMatch(/^rejected: /);
      // accepted: not "rejected", whatever ended it
      const accepted = { ok: true, status: 200, body: { prompt_id: "p", number: 1, node_errors: {} } };
      put("post_reply.json", accepted);
      expect(runProblem(dir)).toMatch(/^accepted by ComfyUI, but the run ended without a result/);
      put("outcome.json", { timeout: true, wall: 1800.4, ws_lost: false });
      expect(runProblem(dir)).toMatch(/^timeout: no history entry 1800 s after the prompt was queued/);
      put("outcome.json", { error: "server unreachable", wall: 95.2, ws_lost: true });
      expect(runProblem(dir)).toMatch(/^server unreachable \(95 s after the prompt was queued\)/);
      put("outcome.json", { vanished: true, wall: 61, ws_lost: true });
      expect(runProblem(dir)).toMatch(/^the prompt left ComfyUI's queue without a history entry/);
      // a finished run is checked on its own; one an older driver left without timing.json / files.json is not
      reset();
      expect(existsSync(join(dir, "outcome.json"))).toBe(false); // a run's outcome goes with its other outputs
      put("post_reply.json", accepted);
      put("history.json", { status: { status_str: "success" } });
      expect(runProblem(dir)).toMatch(/^incomplete result \(no timing\.json, files\.json\)/);
      put("timing.json", {});
      put("files.json", []);
      expect(runProblem(dir)).toBeNull();
      put("history.json", { status: { status_str: "error" } });
      expect(runProblem(dir)).toBeNull(); // reported from history.json ("execution failed")
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
