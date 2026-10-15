#!/usr/bin/env node
// E2E driver for a real ComfyUI: runs the graphs the app's own builders wrote (src-tauri/src/e2e,
// `cargo test e2e_build_graphs -- --ignored`) and checks the outputs.
//
//   node tools/e2e_comfy_driver.mjs run   --dir <e2e dir> [--server http://127.0.0.1:8198] [--only a,b] [--force] [--retry-failed]
//   node tools/e2e_comfy_driver.mjs check --dir <e2e dir> --python <python.exe> --abc-tools <abc_tools.py>
//
// run: for every scenario of <dir>/manifest.json without an up-to-date result, in manifest order and one at a
// time: upload its inputs like client::upload_input (POST /upload/image, type=input, subfolder, overwrite),
// POST /prompt with a client_id and a client-generated prompt_id, follow /ws (progress per node, as
// ws::record_progress keeps it) and /history/<id> until the prompt ends, save the WS events, every output file and
// last /history/<id> under <dir>/results/<name>/. A result is up to date when the run finished (no driver error,
// every file downloaded) and its prompt.json is the graph e2e_build_graphs wrote last (apart from the random output
// prefix): an interrupted run or a failed download is tried again, and after a builder change the changed
// scenarios, the repeat scenarios of those and the other members of their session groups run again by themselves.
// A run whose execution failed in ComfyUI is kept (check reports it) and listed; --retry-failed runs it again (with
// its repeats and session group, whose re-made outputs leave the scenarios built from them stale until the next
// build). --only names must be in the manifest; an argument the driver does not read (an unquoted list with spaces,
// --only=a) is refused. --force re-runs every scenario whose inputs still exist. A scenario whose input is gone
// because the scenario that made it ran again after the build (a separation of a re-rendered song, an alignment of
// a re-made stem; in this pass or an earlier --force / --retry-failed one) is not run, is not taken for up to date
// or for a failed run to retry, is listed with exit code 1 and fails check as "stale input": rebuild the graphs and
// run again (without --force or --retry-failed). The scenarios a pass does not run are listed after it, once the
// scenarios that ran have re-made their outputs. Every request has a timeout, so a server that hangs with its port
// open ends the scenario as "server unreachable" too (and the process ends, although such a server never answers
// the WebSocket close); a prompt that left the queue without a history entry (removed from it, or ComfyUI
// restarted) ends as "vanished".
// check: WAV headers (32-bit float, rate, channels), duration vs budget, peak <= 1.0 and finite samples, the
// status / audio-info JSON, ABC validity with the official abc_tools.py, separation stems (length, not silent),
// alignment timestamps, scenarios the harness expects but did not build, why a run left no result (driver error,
// rejected, timeout, server unreachable, vanished), results of an older graph (a run that was not made or was
// interrupted after the graphs were rebuilt) or of inputs re-made since -> check_report.json (always written; an
// error in one scenario's check is reported as that scenario's problem).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { clearRunOutputs, missingExpected, missingUploads, notRunAfterPass, parseOnly, parseOpt, planRun, promptQueued, resultState as resultStateIn, runProblem, staleInputProblem, staleResultProblem, unexpectedArgs } from "./e2e/driver_lib.mjs";

const USAGE = [
  "usage: node tools/e2e_comfy_driver.mjs run   --dir <e2e dir> [--server http://127.0.0.1:8198] [--only a,b] [--force] [--retry-failed]",
  "       node tools/e2e_comfy_driver.mjs check --dir <e2e dir> --python <python.exe> --abc-tools <abc_tools.py>",
  "       (--dir defaults to MCS_E2E_DIR, --server to MCS_E2E_COMFY)",
].join("\n");
const args = process.argv.slice(2);
const cmd = args[0];
/** The options of each command: those that take a value (the next argument) and the flags. */
const OPTIONS = {
  run: { values: ["dir", "server", "only"], flags: ["force", "retry-failed"] },
  check: { values: ["dir", "python", "abc-tools"], flags: [] },
};
const opt = (k, d) => parseOpt(args, k, d);
const flag = (k) => args.includes(`--${k}`);
const rawDir = opt("dir") ?? process.env.MCS_E2E_DIR;
const DIR = rawDir ? resolve(rawDir) : "";
const SERVER = opt("server", process.env.MCS_E2E_COMFY ?? "http://127.0.0.1:8198").replace(/\/$/, "");
const CLIENT_ID = `mcs-yue2-e2e-${randomUUID().slice(0, 8)}`;
const TIMEOUT_MS = 30 * 60 * 1000;
/** A scenario gives up when the server has not answered for this long (a crash or a stop mid-run). */
const UNREACHABLE_MS = 30 * 1000;
/** Request timeouts: status and polling calls, uploads and POST /prompt (large files, graph validation), downloads. */
const STATUS_TIMEOUT_MS = 15 * 1000;
const SUBMIT_TIMEOUT_MS = 120 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
/** A WebSocket handshake that does not complete in this time fails (the reconnect is tried on the next tick). */
const WS_CONNECT_TIMEOUT_MS = 10 * 1000;
/** After the last scenario: the process ends at the latest this long after closing the WebSocket. */
const WS_CLOSE_GRACE_MS = 5 * 1000;
/** While a prompt has no history entry, the queue is looked up this often (a prompt that left it never gets one). */
const QUEUE_CHECK_MS = 10 * 1000;

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------ run

class Ws {
  constructor() {
    this.messages = [];
    this.open = false;
  }
  /** (Re)connect with the same client id, so ComfyUI sends the events of our prompts to the new socket. */
  connect() {
    return new Promise((res, rej) => {
      const url = `${SERVER.replace(/^http/, "ws")}/ws?clientId=${CLIENT_ID}`;
      const sock = new WebSocket(url);
      this.sock = sock;
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        sock.close();
        rej(new Error(`ws connect timed out: ${url}`));
      }, WS_CONNECT_TIMEOUT_MS);
      sock.onopen = () => {
        clearTimeout(timer);
        opened = true;
        this.open = true;
        res();
      };
      sock.onerror = (e) => (opened ? console.error("ws error", e.message ?? e) : rej(new Error(`ws connect failed: ${url}`)));
      sock.onclose = () => {
        // an older socket closing late does not mark the current one closed
        if (this.sock === sock) this.open = false;
        if (!opened) rej(new Error(`ws connect failed: ${url}`));
      };
      sock.onmessage = (ev) => {
        if (typeof ev.data !== "string") return; // binary previews
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.type === "progress_state" || m.type === "crystools.monitor") return;
        m.t = Date.now();
        this.messages.push(m);
      };
    });
  }
  forPrompt(id) {
    return this.messages.filter((m) => m.data?.prompt_id === id);
  }
  ended(id) {
    return this.forPrompt(id).find((m) => ["execution_success", "execution_error", "execution_interrupted"].includes(m.type));
  }
  close() {
    this.sock?.close();
  }
}

/** One request; it is aborted (and rejects) after `timeoutMs`, which also covers reading the body. */
async function http(method, path, body, headers = {}, timeoutMs = STATUS_TIMEOUT_MS) {
  const r = await fetch(`${SERVER}${path}`, { method, body, headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, ok: r.ok, body: json ?? text };
}

async function upload(u) {
  const data = readFileSync(u.path);
  const form = new FormData();
  form.append("image", new Blob([data]), u.name);
  form.append("type", "input");
  form.append("subfolder", u.subfolder);
  form.append("overwrite", "true");
  const r = await http("POST", "/upload/image", form, {}, SUBMIT_TIMEOUT_MS);
  return { ...r, local: u.path, bytes: data.length };
}

async function vramUsed() {
  try {
    const r = await http("GET", "/system_stats");
    const d = r.body.devices?.[0];
    return d ? d.vram_total - d.vram_free : 0;
  } catch {
    return 0;
  }
}

async function runScenario(ws, s) {
  const out = join(DIR, "results", s.name);
  // An input made by a scenario that ran again after the build is gone (its new output has another name): the
  // scenario is left untouched, its previous result included, until the graphs are rebuilt.
  const missing = missingUploads(s);
  if (missing.length) return { name: s.name, stale_input: missing };
  mkdirSync(out, { recursive: true });
  const prompt = readJson(join(DIR, s.graph));
  // Nothing of the previous run may stay next to the new prompt.json (see RUN_OUTPUTS).
  clearRunOutputs(out);
  writeJson(join(out, "prompt.json"), prompt);
  const uploads = [];
  for (const u of s.uploads ?? []) {
    const r = await upload(u);
    uploads.push(r);
    if (!r.ok) throw new Error(`upload ${u.name} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  writeJson(join(out, "uploads.json"), uploads);
  const promptId = randomUUID();
  const started = Date.now();
  const post = await http("POST", "/prompt", JSON.stringify({ prompt, client_id: CLIENT_ID, prompt_id: promptId }), { "Content-Type": "application/json" }, SUBMIT_TIMEOUT_MS);
  writeJson(join(out, "post_reply.json"), post);
  const nodeErrors = post.body?.node_errors ?? {};
  if (!post.ok || Object.keys(nodeErrors).length > 0) {
    if (post.ok) {
      // The app removes a partially accepted prompt again (client::queue_prompt).
      await http("POST", "/queue", JSON.stringify({ delete: [promptId] }), { "Content-Type": "application/json" });
      await http("POST", "/interrupt", JSON.stringify({ prompt_id: promptId }), { "Content-Type": "application/json" });
    }
    return { name: s.name, rejected: true, status: post.status, body: post.body };
  }
  const id = post.body.prompt_id;
  let peak = 0;
  let entry = null;
  // The socket delivers progress and is the fast path; /history is polled on every tick anyway (ComfyUI writes
  // the entry only when the prompt has finished), so a dropped socket does not leave the prompt unwatched.
  let wsLost = false;
  let lastReply = Date.now();
  let unreachable = false;
  let vanished = false;
  let lastQueueCheck = 0;
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(ws.ended(id) ? 200 : 1000);
    peak = Math.max(peak, await vramUsed());
    if (!ws.open) {
      wsLost = true;
      await ws.connect().catch(() => {}); // retried on the next tick
    }
    let h = null;
    try {
      h = await http("GET", `/history/${id}`);
      lastReply = Date.now();
    } catch {
      if (Date.now() - lastReply > UNREACHABLE_MS) {
        unreachable = true;
        break;
      }
      continue;
    }
    if (h.ok && h.body?.[id]) {
      entry = h.body[id];
      break;
    }
    // A prompt in neither queue list without a history entry was removed from the queue, or ComfyUI restarted in
    // between (both answer /history with {}): it never gets one. Queue first, then history again - ComfyUI writes
    // the entry in the same locked step that takes the prompt off the running list (as client::HistoryWait).
    if (h.ok && Date.now() - lastQueueCheck >= QUEUE_CHECK_MS) {
      lastQueueCheck = Date.now();
      const q = await http("GET", "/queue").catch(() => null);
      if (q?.ok && promptQueued(q.body, id) === false) {
        const again = await http("GET", `/history/${id}`).catch(() => null);
        if (again?.ok && again.body?.[id]) {
          entry = again.body[id];
          break;
        }
        if (again?.ok) {
          vanished = true;
          break;
        }
      }
    }
  }
  const wall = (Date.now() - started) / 1000;
  const events = ws.forPrompt(id);
  writeJson(join(out, "ws_events.json"), events);
  const progress = {};
  for (const m of events) if (m.type === "progress" && m.data.node) progress[m.data.node] = [m.data.value, m.data.max];
  writeJson(join(out, "progress.json"), progress);
  if (!entry) {
    // A prompt still waiting in the queue is removed first (it would run behind the next scenario), then a
    // running one is stopped - as the app does for a rejected prompt (client::queue_prompt).
    const json = { "Content-Type": "application/json" };
    await http("POST", "/queue", JSON.stringify({ delete: [id] }), json).catch(() => {});
    await http("POST", "/interrupt", JSON.stringify({ prompt_id: id }), json).catch(() => {});
    // saved for check (an accepted prompt without a history entry is not "rejected")
    const outcome = unreachable ? { error: "server unreachable" } : vanished ? { vanished: true } : { timeout: true };
    Object.assign(outcome, { wall, ws_lost: wsLost });
    writeJson(join(out, "outcome.json"), outcome);
    return { name: s.name, ...outcome };
  }
  // history.json is written last, once everything else is saved: a download that fails or is cut off leaves no
  // history.json, so the next run tries the scenario again (resultState) and check reports the driver's error.
  const files = [];
  for (const [node, o] of Object.entries(entry.outputs ?? {})) {
    for (const f of [...(o.audio ?? []), ...(o.images ?? [])]) {
      const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type || "output" });
      const r = await fetch(`${SERVER}/view?${q}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!r.ok) {
        files.push({ node, ...f, error: `view ${r.status}` });
        continue;
      }
      const dest = join(out, "files", f.subfolder ?? "", f.filename);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      files.push({ node, ...f, local: dest });
    }
  }
  const cached = events.filter((m) => m.type === "execution_cached").flatMap((m) => m.data.nodes ?? []);
  // ws_lost: the socket dropped while this prompt ran, so ws_events.json / progress.json may miss events
  const timing = { wall_seconds: wall, peak_vram_gib: peak / 2 ** 30, status: entry.status?.status_str, cached_nodes: cached, prompt_id: id, client_id: CLIENT_ID, ws_lost: wsLost };
  writeJson(join(out, "timing.json"), timing);
  writeJson(join(out, "files.json"), files);
  writeJson(join(out, "history.json"), entry);
  return { name: s.name, ...timing };
}

/**
 * "none": no finished result; "changed": the result is of another graph than graphs/<name>.json; "failed": its
 * execution failed; "same": up to date (driver_lib resultState).
 */
function resultState(s) {
  let graph;
  try {
    graph = readJson(join(DIR, s.graph));
  } catch {
    return "changed"; // an unreadable graph: run it, runScenario reports the error
  }
  return resultStateIn(join(DIR, "results", s.name), graph);
}

async function run() {
  const manifest = readJson(join(DIR, "manifest.json"));
  // A misspelled name would leave its scenario out without a word ("nothing to run", or a shorter run).
  const names = manifest.scenarios.map((s) => s.name);
  const { only, unknown } = parseOnly(opt("only"), names);
  if (unknown.length || (flag("only") && !only.length)) {
    const what = unknown.length ? `--only: no scenario ${unknown.join(", ")} in ${join(DIR, "manifest.json")}` : "--only needs scenario names (--only a,b)";
    console.error(`${what} (scenarios: ${names.join(", ")})`);
    process.exitCode = 2;
    return;
  }
  const plan = planRun(manifest.scenarios, { only, force: flag("force"), retryFailed: flag("retry-failed"), state: resultState });
  if (plan.changed.length) console.log(`graph changed, re-running: ${plan.changed.join(", ")}`);
  if (plan.retried.length) console.log(`execution failed last time, retrying: ${plan.retried.join(", ")}`);
  if (plan.dependents.length) console.log(`re-running with the scenario they repeat or their session group: ${plan.dependents.join(", ")}`);
  if (plan.dependentsSkipped.length) console.log(`warning: not re-run (outside --only) although the scenario they repeat or a member of their session group runs: ${plan.dependentsSkipped.join(", ")}`);
  // A scenario whose input is gone is neither up to date nor a failed run to retry, although its graph is unchanged:
  // an upstream scenario ran again after the build (in this pass or an earlier --force / --retry-failed one) and
  // saved it under a new name.
  const byName = new Map(manifest.scenarios.map((s) => [s.name, s]));
  const inputGone = (name) => missingUploads(byName.get(name)).length > 0;
  const staleInputs = []; // scenarios of todo whose input was gone (runScenario)
  /** After the pass (it may re-make their inputs): the in-scope scenarios that did not run, and the way out. */
  const reportNotRun = () => {
    const { upToDate, failed, stale } = notRunAfterPass(plan, staleInputs, inputGone, names);
    if (upToDate.length) console.log(`skipped (up to date): ${upToDate.join(", ")}`);
    if (failed.length) console.log(`not re-run, their execution failed (check reports it; --retry-failed runs them again, with their repeats and session group): ${failed.join(", ")}`);
    if (!stale.length) return;
    console.log(`not run, their input was re-made by a scenario that ran again (results kept): ${stale.join(", ")}`);
    console.log("rebuild the graphs (cargo test e2e_build_graphs -- --ignored), then run again (without --force or --retry-failed)");
    process.exitCode = 1;
  };
  const todo = plan.todo;
  if (!todo.length) {
    console.log("nothing to run");
    return reportNotRun();
  }
  const ws = new Ws();
  try {
    await ws.connect();
  } catch (e) {
    console.error(`${e.message} (is ComfyUI running at ${SERVER}?)`);
    // nothing ran: the scenarios left out are listed as on a pass (their inputs on disk are as they were)
    reportNotRun();
    process.exitCode = 2;
    return;
  }
  try {
    for (const s of todo) {
      if (!ws.open) await ws.connect().catch(() => {}); // the server restarted between scenarios
      process.stdout.write(`${s.name} ... `);
      try {
        const r = await runScenario(ws, s);
        if (r.stale_input) staleInputs.push(s.name);
        console.log(JSON.stringify(r));
      } catch (e) {
        console.log(`ERROR ${e.message}`);
        writeJson(join(DIR, "results", s.name, "driver_error.json"), { error: String(e.stack ?? e) });
      }
    }
  } finally {
    ws.close();
    // A server that hangs with its port open never answers the close frame, and the socket would keep the process
    // alive: end it a little later anyway (unref'd: no wait when the close completes; the delay lets stdout flush).
    setTimeout(() => process.exit(), WS_CLOSE_GRACE_MS).unref();
  }
  reportNotRun();
}

// ------------------------------------------------------------------------------------------ check

/** RIFF/WAVE header and sample statistics (format 3 = IEEE float, 1 = PCM). */
function wavInfo(p) {
  const b = readFileSync(p);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return { error: "not RIFF/WAVE" };
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") data = { off: off + 8, size };
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) return { error: "missing fmt/data chunk" };
  const res = { ...fmt, bytes: b.length, dataBytes: data.size };
  if (fmt.format === 3 && fmt.bits === 32) {
    const n = data.size / 4;
    let peak = 0;
    let nonFinite = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const v = b.readFloatLE(data.off + i * 4);
      if (!Number.isFinite(v)) nonFinite++;
      else {
        if (Math.abs(v) > peak) peak = Math.abs(v);
        sq += v * v;
      }
    }
    res.rms = n ? Math.sqrt(sq / n) : 0;
    res.frames = n / fmt.channels;
    res.seconds = res.frames / fmt.sampleRate;
    res.peak = peak;
    res.nonFinite = nonFinite;
  }
  return res;
}

function textOut(entry, node) {
  const t = entry?.outputs?.[node]?.text;
  return Array.isArray(t) ? t.join("\n") : null;
}

function abcCheck(python, tool, file) {
  // reported as the scenario's problem (not a crash that would lose the whole report)
  if (!python || !tool || !existsSync(tool)) {
    return { ok: false, exit: null, stderr: "ABC not checked: give --python <python.exe> and --abc-tools <abc_tools.py> (an existing file)", summary: null };
  }
  const r = spawnSync(python, [tool, "inspect", file], { encoding: "utf8" });
  if (r.error) return { ok: false, exit: null, stderr: `abc_tools could not run: ${r.error.message}`, summary: null };
  let summary = null;
  try {
    const j = JSON.parse(r.stdout);
    const voices = {};
    for (const [k, v] of Object.entries(j.voices ?? {})) voices[k] = { measures: v.measures, sounding_notes: v.sounding_notes };
    summary = { bpm: j.bpm, unit_length: j.unit_length, nominal_seconds: j.nominal_duration_seconds, voices };
  } catch {
    summary = r.stdout.slice(0, 300);
  }
  return { ok: r.status === 0, exit: r.status, stderr: (r.stderr || "").trim().slice(-600), summary };
}

/** Check one scenario's results, recording into `r` (problems / notes and the measured values). */
function checkScenario(s, r, { python, tool, abcDir }) {
  const res = join(DIR, "results", s.name);
  const bad = (m) => r.problems.push(m);
  // a run that left no finished result: what ended it (driver error, rejected, timeout, server unreachable, ...)
  const problem = runProblem(res);
  if (problem) {
    bad(problem);
    return;
  }
  // old outputs are not reported as if they belonged to the new graph, nor to inputs that were re-made since
  const stale = staleResultProblem(resultState(s)) ?? staleInputProblem(s);
  if (stale) {
    bad(stale);
    return;
  }
  const entry = readJson(join(res, "history.json"));
  const timing = existsSync(join(res, "timing.json")) ? readJson(join(res, "timing.json")) : {};
  r.status = entry.status?.status_str;
  r.wall_seconds = timing.wall_seconds;
  r.peak_vram_gib = timing.peak_vram_gib;
  r.cached_nodes = timing.cached_nodes;
  if (timing.ws_lost) r.notes.push("the WebSocket dropped during this prompt: ws_events / progress may be incomplete (truncation cross-check may be skipped)");
  if (r.status !== "success") {
    const err = (entry.status?.messages ?? []).find((m) => m[0] === "execution_error");
    bad(`execution failed: ${err ? `${err[1].node_type} (${err[1].node_id}): ${err[1].exception_message}` : JSON.stringify(entry.status)}`);
    return;
  }
  const files = existsSync(join(res, "files.json")) ? readJson(join(res, "files.json")) : [];
  r.wavs = {};
  for (const f of files) {
    if (!f.local) {
      bad(`download failed ${f.filename}: ${f.error}`);
      continue;
    }
    const w = wavInfo(f.local);
    r.wavs[f.node] = { file: basename(f.local), ...w };
    if (w.error) bad(`${f.node}: ${w.error}`);
    else {
      if (w.format !== 3 || w.bits !== 32) bad(`${f.node}: not 32-bit float (format ${w.format}, ${w.bits} bit)`);
      if (!(w.peak <= 1.0)) bad(`${f.node}: peak ${w.peak} > 1.0`);
      if (w.nonFinite) bad(`${f.node}: ${w.nonFinite} non-finite samples`);
      if (!(w.seconds > 0)) bad(`${f.node}: empty audio`);
    }
  }
  if (s.kind === "generate") {
    const p = s.meta.params;
    const seconds = parseFloat(textOut(entry, "seconds_preview") ?? "NaN");
    const status = JSON.parse(textOut(entry, "mcs_status") ?? "null");
    const info = JSON.parse(textOut(entry, "info") ?? "null");
    const w = r.wavs.save ?? {};
    r.seconds = seconds;
    r.max_duration = p.maxDuration;
    r.status_json = status;
    r.info = info;
    if (!(seconds > 0 && seconds <= p.maxDuration + 1e-6)) bad(`seconds ${seconds} outside (0, ${p.maxDuration}]`);
    if (w.sampleRate !== 48000) bad(`sample rate ${w.sampleRate}, expected 48000`);
    if (w.channels !== 2) bad(`channels ${w.channels}, expected 2`);
    // The latent covers `seconds`; the VAE output length follows from it (small codec padding allowed).
    if (Math.abs(w.seconds - seconds) > 0.1) bad(`WAV ${w.seconds?.toFixed(3)} s vs semantic ${seconds} s`);
    if (info) {
      if (Math.abs(info.seconds - w.seconds) > 0.002) bad(`audio info ${info.seconds} s vs WAV ${w.seconds} s`);
      if (info.sample_rate !== w.sampleRate || info.channels !== w.channels) bad("audio info rate/channels differ from the WAV");
      if (info.clipped_samples > 0 && !(w.peak <= 1.0)) bad("clipped samples were not clamped");
    }
    if (!status || status.valid !== true) bad(`status json invalid: ${JSON.stringify(status)}`);
    else if (Math.abs(status.seconds - seconds) > 0.0011) bad(`status seconds ${status.seconds} vs ${seconds}`);
    const prog = existsSync(join(res, "progress.json")) ? readJson(join(res, "progress.json")) : {};
    r.progress = prog;
    if (status && prog.music) {
      const byBudget = status.frames >= prog.music[1];
      if (byBudget !== status.truncated) bad(`status truncated=${status.truncated}, frames ${status.frames} of budget ${prog.music[1]}`);
    }
    if (s.meta.expect?.truncated !== undefined && status?.truncated !== s.meta.expect.truncated) bad(`expected truncated=${s.meta.expect.truncated}, got ${status?.truncated}`);
    const abc = s.meta.plans_abc ? textOut(entry, "abc_preview") : p.abc;
    if (abc) {
      const f = join(abcDir, `${s.name}.abc`);
      writeFileSync(f, abc);
      r.abc = abcCheck(python, tool, f);
      if (!r.abc.ok) bad(`abc_tools inspect failed: ${r.abc.stderr}`);
    }
  }
  if (s.kind === "plan" || s.kind === "transcribe") {
    const abc = textOut(entry, "abc_preview") ?? "";
    const f = join(abcDir, `${s.name}.abc`);
    writeFileSync(f, abc);
    r.abc = abcCheck(python, tool, f);
    r.abc_head = abc.split("\n").slice(0, 8).join("\n");
    if (!r.abc.ok) bad(`abc_tools inspect failed: ${r.abc.stderr}`);
    if (s.kind === "transcribe") {
      const hasChords = /"[^"]+"/.test(abc.split("\n").filter((l) => !/^[A-Za-z]:/.test(l)).join("\n"));
      r.has_chords = hasChords;
      if (s.meta.mode === "melody" && hasChords) bad("melody transcription contains chord symbols");
    }
  }
  if (s.kind === "separate") {
    const src = s.uploads[0]?.path ? wavInfo(s.uploads[0].path) : {};
    for (const k of ["save_v", "save_i"]) {
      const w = r.wavs[k];
      if (!w) bad(`${k} missing`);
      else if (Math.abs(w.seconds - src.seconds) > 0.05) bad(`${k} ${w.seconds} s vs source ${src.seconds} s`);
      else if (w.sampleRate !== src.sampleRate) r.notes.push(`${k} is ${w.sampleRate} Hz, source ${src.sampleRate} Hz (resampled by the separator)`);
    }
  }
  if (s.kind === "separate" && r.wavs.save_v && r.wavs.save_i) {
    // Both stems carry sound, except the vocal stem of an instrumental render (expected near silent).
    const instrumentalSource = /instrumental/.test(s.meta.source ?? "");
    if (!(r.wavs.save_i.rms > 1e-4)) bad(`save_i silent (RMS ${r.wavs.save_i.rms})`);
    if (!instrumentalSource && !(r.wavs.save_v.rms > 1e-4)) bad(`save_v silent (RMS ${r.wavs.save_v.rms})`);
    r.vocal_to_instrumental_rms = r.wavs.save_v.rms / Math.max(1e-9, r.wavs.save_i.rms);
    r.notes.push(`vocal/instrumental RMS ${r.vocal_to_instrumental_rms.toFixed(3)}`);
  }
  if (s.kind === "align") {
    const src = wavInfo(s.uploads[0].path);
    let lines = [];
    try {
      lines = JSON.parse(textOut(entry, "align") ?? "[]");
    } catch (e) {
      bad(`alignment JSON: ${e.message}`);
    }
    r.lines = lines.map((l) => ({ index: l.index, line: l.line, start: l.start, end: l.end, words: l.words.length }));
    const expected = s.meta.lyrics.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("[")).length;
    if (lines.length !== expected) bad(`${lines.length} aligned lines, ${expected} lyric lines`);
    let prev = -1;
    for (const l of lines) {
      if (!(l.start >= 0 && l.start <= l.end && l.end <= src.seconds + 0.05)) bad(`line ${l.index} ${l.start}-${l.end} outside 0-${src.seconds}`);
      if (l.start < prev) bad(`line ${l.index} starts before the previous line`);
      prev = l.start;
      let wp = -1;
      for (const w of l.words) {
        if (w.start < wp || w.start > w.end) bad(`line ${l.index} word ${w.text} not monotonic`);
        wp = w.start;
      }
    }
  }
}

function check() {
  const python = opt("python");
  const tool = opt("abc-tools");
  const manifest = readJson(join(DIR, "manifest.json"));
  const report = [];
  const abcDir = join(DIR, "check_abc");
  mkdirSync(abcDir, { recursive: true });
  for (const s of manifest.scenarios) {
    const r = { name: s.name, kind: s.kind, problems: [], notes: [] };
    report.push(r);
    // one scenario's unexpected data (a malformed JSON output, a missing field) must not lose the others' results
    try {
      checkScenario(s, r, { python, tool, abcDir });
    } catch (e) {
      r.problems.push(`check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A scenario the harness expects but never built (its input from an earlier round is missing) fails the check:
  // a partial run must not pass.
  for (const m of missingExpected(manifest)) {
    report.push({ name: m.name, kind: null, problems: [`not built${m.reason ? ` (${m.reason})` : ""}: run the next build + run round`], notes: [] });
  }
  writeJson(join(DIR, "check_report.json"), report);
  for (const r of report) console.log(`${r.problems.length ? "FAIL" : "ok  "} ${r.name}${r.problems.length ? `: ${r.problems.join(" | ")}` : ""}${r.notes.length ? ` (note: ${r.notes.join("; ")})` : ""}`);
  return report.every((r) => !r.problems.length);
}

if (cmd !== "run" && cmd !== "check") {
  console.error(USAGE);
  process.exit(2);
}
// An argument the driver does not read would be ignored without a word (a shorter run than asked for).
const unexpected = unexpectedArgs(args.slice(1), OPTIONS[cmd]);
if (unexpected.length) {
  console.error(`unexpected argument${unexpected.length > 1 ? "s" : ""}: ${unexpected.join(" ")} (an option takes its value as the next argument, given once; a list with spaces must be quoted: --only "a, b")\n${USAGE}`);
  process.exit(2);
}
if (!DIR || !existsSync(DIR) || !statSync(DIR).isDirectory()) {
  console.error(`--dir <e2e dir> (or MCS_E2E_DIR) must name an existing directory${rawDir ? ` (got ${rawDir})` : ""}\n${USAGE}`);
  process.exit(2);
}
if (!existsSync(join(DIR, "manifest.json"))) {
  console.error(`${join(DIR, "manifest.json")} not found: run \`cargo test e2e_build_graphs -- --ignored\` with MCS_E2E_DIR=${DIR} first`);
  process.exit(2);
}
if (cmd === "run") await run();
else process.exit(check() ? 0 : 1);
