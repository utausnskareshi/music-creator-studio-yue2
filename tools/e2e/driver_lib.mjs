// Helpers of tools/e2e_comfy_driver.mjs (argument parsing, which scenarios a `run` must execute, whether a result
// is up to date, why a run left no result, the scenarios a `check` must report as missing). Unit tested in
// driver_lib.unit.test.ts, the driver itself against a fake ComfyUI in driver_fake_comfy.unit.test.ts.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The value after `--<k>` in `args`, or `d` when the flag is absent or has no value (it is the last argument,
 * or the next argument is another flag).
 */
export function parseOpt(args, k, d) {
  const i = args.indexOf(`--${k}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v === undefined || v.startsWith("--") ? d : v;
}

/**
 * The arguments of `args` (those after the command) the driver would not read: a word that is no option's value
 * (`--only gen_b, gen_a` without quotes passes "gen_a" on its own, which would be left out without a word), an
 * unknown option, `--name=value` (parseOpt reads `--name value` only) and a repeated option (parseOpt reads the
 * first). `values`: the options that take a value (read as parseOpt does), `flags`: those that do not.
 */
export function unexpectedArgs(args, { values = [], flags = [] }) {
  const bad = [];
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const k = a.startsWith("--") ? a.slice(2) : null;
    if (k === null || seen.has(k) || !(values.includes(k) || flags.includes(k))) {
      bad.push(a);
      continue;
    }
    seen.add(k);
    if (values.includes(k) && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) i++;
  }
  return bad;
}

/**
 * The scenario names of `--only` (comma-separated, spaces around a name ignored) and those of them that are not in
 * `names` (the manifest's scenarios): an unknown name must not turn the run into "nothing to run".
 */
export function parseOnly(raw, names) {
  const only = (raw ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return { only, unknown: only.filter((n) => !names.includes(n)) };
}

/**
 * The graph with every `filename_prefix` input set to one constant: the builders pick a random output prefix
 * (mcs/<uuid8>) on every build, which says nothing about the graph. Uploaded input names are kept: they are
 * content-addressed, so a changed upstream audio file makes the tool scenario that reads it stale.
 */
export function normalizeGraph(graph) {
  const g = JSON.parse(JSON.stringify(graph ?? null));
  if (g && typeof g === "object") {
    for (const node of Object.values(g)) {
      if (node && typeof node === "object" && node.inputs && typeof node.inputs.filename_prefix === "string") node.inputs.filename_prefix = "<prefix>";
    }
  }
  return g;
}

/** Same graph apart from the output prefixes (see normalizeGraph). */
export function sameGraph(a, b) {
  return JSON.stringify(normalizeGraph(a)) === JSON.stringify(normalizeGraph(b));
}

/**
 * What a run leaves in results/<name>/ besides prompt.json. runScenario removes them before a scenario runs
 * again: a re-run that fails (prompt rejected, timeout, server gone, upload error) must not leave the previous
 * run's outputs next to the new prompt.json, where resultState would take them for the new graph's result.
 * history.json is written last, once the output files, timing.json and files.json are saved; outcome.json says how
 * an accepted prompt ended without a history entry, driver_error.json what the driver failed on.
 */
export const RUN_OUTPUTS = ["history.json", "timing.json", "files.json", "files", "ws_events.json", "progress.json", "post_reply.json", "uploads.json", "outcome.json", "driver_error.json"];

/** Removes the previous run's outputs (RUN_OUTPUTS) from a scenario's result folder. */
export function clearRunOutputs(resultDir) {
  for (const f of RUN_OUTPUTS) rmSync(join(resultDir, f), { recursive: true, force: true });
}

const readJsonIn = (dir, f) => JSON.parse(readFileSync(join(dir, f), "utf8"));

/**
 * The execution status (history.json status_str, "" when it has none) of the run in `resultDir` once the run finished,
 * or null when it did not: a driver error, or not everything saved (an older driver wrote history.json before the
 * downloads, so a download that broke off left it without timing.json / files.json) or downloaded.
 */
function finishedStatus(resultDir) {
  if (existsSync(join(resultDir, "driver_error.json"))) return null;
  try {
    const files = readJsonIn(resultDir, "files.json");
    if (!existsSync(join(resultDir, "timing.json")) || !Array.isArray(files) || files.some((f) => f?.error)) return null;
    return String(readJsonIn(resultDir, "history.json")?.status?.status_str ?? "");
  } catch {
    return null;
  }
}

/**
 * State of the result in `resultDir` for the scenario's current `graph`: "none" (no finished run: also one that ended
 * in a driver error or a failed download, so the next run tries again), "changed" (a result of another graph: the
 * builders changed since), "failed" (a finished run of this graph whose execution failed in ComfyUI: check reports
 * it, and only --retry-failed or --force runs it again - see planRun) or "same" (up to date).
 */
export function resultState(resultDir, graph) {
  if (!existsSync(join(resultDir, "history.json"))) return "none";
  try {
    if (!sameGraph(readJsonIn(resultDir, "prompt.json"), graph)) return "changed";
  } catch {
    return "changed"; // no (readable) prompt.json: the graph of that result is unknown
  }
  const status = finishedStatus(resultDir);
  return status === null ? "none" : status === "success" ? "same" : "failed";
}

/**
 * Whether prompt `id` is in a GET /queue answer (running or pending; items are [number, prompt_id, ...]), or null
 * when the answer is not a queue.
 */
export function promptQueued(queue, id) {
  const lists = [queue?.queue_running, queue?.queue_pending];
  if (!lists.every(Array.isArray)) return null;
  return lists.some((l) => l.some((item) => Array.isArray(item) && item[1] === id));
}

/**
 * The check problem of a scenario whose last run left no finished result, from what it saved (driver_error.json,
 * post_reply.json, outcome.json), or null when the run finished (history.json, timing.json and files.json: its
 * results are checked on their own, a failed execution included).
 */
export function runProblem(resultDir) {
  const has = (f) => existsSync(join(resultDir, f));
  const read = (f) => {
    try {
      return readJsonIn(resultDir, f);
    } catch {
      return null;
    }
  };
  // the first line of the error (its stack follows)
  if (has("driver_error.json")) return `driver error: ${String(read("driver_error.json")?.error ?? "(driver_error.json unreadable)").split("\n")[0]}`;
  if (has("history.json")) {
    const lacking = ["timing.json", "files.json"].filter((f) => !has(f));
    return lacking.length ? `incomplete result (no ${lacking.join(", ")}): its downloads did not finish; run the driver again` : null;
  }
  const post = read("post_reply.json");
  if (!post) return "not run";
  if (!post.ok || Object.keys(post.body?.node_errors ?? {}).length > 0) return `rejected: ${JSON.stringify(post.body).slice(0, 2000)}`;
  const o = read("outcome.json");
  const after = `${Math.round(o?.wall ?? 0)} s after the prompt was queued`;
  if (o?.vanished) return `the prompt left ComfyUI's queue without a history entry (removed from the queue, or ComfyUI restarted; ${after})`;
  if (o?.timeout) return `timeout: no history entry ${after}`;
  if (o?.error) return `${o.error} (${after})`;
  return "accepted by ComfyUI, but the run ended without a result (the driver was stopped while it waited or downloaded)";
}

/** The scenario a repeat scenario repeats (gen_k*, plan_e2/e3), or null. */
export function repeatOf(s) {
  return s?.meta?.expect?.repeat_of ?? s?.meta?.repeat_of ?? null;
}

/**
 * The session group of a scenario (meta.session_group), or null: scenarios that only test something together, in
 * one ComfyUI session and in manifest order (sep_h1 / sep_h2 / sep_h3_repeat: two different songs, then the first
 * again). Two-way, unlike repeat_of: when any member runs, all of them run.
 */
export function sessionGroup(s) {
  const g = s?.meta?.session_group;
  return typeof g === "string" && g !== "" ? g : null;
}

/**
 * Upload paths of a scenario that do not exist (any more): the output of an upstream scenario that ran again after
 * the graphs were built (its files were replaced, under new names). `exists` defaults to fs.existsSync.
 */
export function missingUploads(s, exists = existsSync) {
  return (s?.uploads ?? []).map((u) => u.path).filter((p) => typeof p === "string" && !exists(p));
}

/**
 * The check problem of a scenario whose inputs are gone (missingUploads): an upstream scenario ran again after it
 * (--force, --retry-failed) and saved them under new names, so its result belongs to inputs that no longer exist;
 * or null.
 */
export function staleInputProblem(s, exists = existsSync) {
  const gone = missingUploads(s, exists);
  return gone.length ? `stale input (re-made by a later run: ${gone.join(", ")}): rebuild the graphs (cargo test e2e_build_graphs -- --ignored) and run again` : null;
}

/**
 * The check problem of a result that is not the one of the current graph (resultState "changed": the graphs were
 * rebuilt after it, and `run` was not run or was interrupted since), or null.
 */
export function staleResultProblem(state) {
  return state === "changed" ? "stale: result of an older graph (graphs/<name>.json changed since this run): run the driver again" : null;
}

/**
 * The scenarios `run` executes, in manifest order. `state(s)` is "none" (no result yet), "changed" (a result
 * of another graph: the builders changed since), "failed" (its execution failed) or "same" (up to date). A scenario
 * runs when it has no result, its graph changed, or --force; a repeat scenario also runs when the scenario it repeats
 * runs (its cache and no-progress expectations only hold right after the original, in the same session), and every
 * member of a session group runs when one of them does. Both rules apply until nothing changes. A failed execution
 * runs again by itself only with `retryFailed` (listed in `retried`; otherwise in `failed`): it pulls in its repeats
 * and session group, and a re-run group member re-makes the outputs other scenarios were built from (sep_h1's stems
 * for align_i_en), which would leave those stale on every pass while one member keeps failing. `only` (names) limits
 * everything; a repeat or group member left out by it is listed in `dependentsSkipped`.
 */
export function planRun(scenarios, { only = [], force = false, retryFailed = false, state }) {
  const inScope = (s) => only.length === 0 || only.includes(s.name);
  const run = new Set();
  const states = new Map();
  const changed = [];
  const retried = [];
  const skipped = [];
  const failed = [];
  for (const s of scenarios) {
    if (!inScope(s)) continue;
    const st = state(s);
    states.set(s.name, st);
    if (force || st === "none" || st === "changed" || (st === "failed" && retryFailed)) {
      run.add(s.name);
      if (st === "changed" && !force) changed.push(s.name);
      if (st === "failed" && !force) retried.push(s.name);
    }
  }
  const dependents = [];
  const dependentsSkipped = [];
  // repeats of repeats and session groups: until nothing changes
  const groupRuns = (g) => scenarios.some((o) => sessionGroup(o) === g && run.has(o.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of scenarios) {
      if (run.has(s.name) || dependentsSkipped.includes(s.name)) continue;
      const orig = repeatOf(s);
      const group = sessionGroup(s);
      if (!((orig && run.has(orig)) || (group && groupRuns(group)))) continue;
      if (inScope(s)) {
        run.add(s.name);
        dependents.push(s.name);
        grew = true;
      } else dependentsSkipped.push(s.name);
    }
  }
  for (const s of scenarios) if (inScope(s) && !run.has(s.name)) (states.get(s.name) === "failed" ? failed : skipped).push(s.name);
  return { todo: scenarios.filter((s) => run.has(s.name)), changed, retried, dependents, dependentsSkipped, skipped, failed };
}

/**
 * The in-scope scenarios a `run` pass did not run (planRun's `skipped` and `failed`), sorted once the pass is over: a
 * scenario that ran in it may have re-made their input under a new name. `stale`: those whose input is gone
 * (`inputGone(name)`) and the scenarios of the pass that found theirs gone (`staleInputs`), in manifest order
 * (`names`) - only a rebuild of the graphs helps them; `upToDate` and `failed` (which --retry-failed runs again):
 * the others.
 */
export function notRunAfterPass({ skipped, failed }, staleInputs, inputGone, names) {
  const stale = new Set([...staleInputs, ...[...skipped, ...failed].filter(inputGone)]);
  return { upToDate: skipped.filter((n) => !stale.has(n)), failed: failed.filter((n) => !stale.has(n)), stale: names.filter((n) => stale.has(n)) };
}

/**
 * Scenarios the harness expects (manifest.expected, written by e2e_build_graphs) that were not built, each with
 * the reason the build gave when there is one. manifest.missing holds names or objects { name, waits_for } (what
 * e2e_build_graphs writes; "" = nothing to wait for), also read as reason / waiting_for / waitingFor.
 */
export function missingExpected(manifest) {
  const built = new Set((manifest?.scenarios ?? []).map((s) => s.name));
  const reasons = new Map();
  for (const m of manifest?.missing ?? []) {
    if (typeof m === "string") reasons.set(m, null);
    else if (m && typeof m === "object" && typeof m.name === "string") {
      const reason = [m.reason, m.waits_for, m.waiting_for, m.waitingFor].find((r) => typeof r === "string" && r.trim() !== "");
      reasons.set(m.name, reason ?? null);
    }
  }
  return (manifest?.expected ?? []).filter((n) => typeof n === "string" && !built.has(n)).map((name) => ({ name, reason: reasons.get(name) ?? null }));
}
