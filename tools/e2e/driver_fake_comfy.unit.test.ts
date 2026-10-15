// The E2E driver itself (tools/e2e_comfy_driver.mjs, run as a child process) against a fake ComfyUI served from this
// process: what a run that did not finish leaves behind, whether the next run takes it up again, what `check` reports,
// and that the process ends. No ComfyUI needed (part of `npx vitest run`).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planRun, resultState, type Scenario } from "./driver_lib.mjs";

const DRIVER = fileURLToPath(new URL("../e2e_comfy_driver.mjs", import.meta.url));

/** A scenario's graph; the fake server tells the scenarios apart by the output prefix. */
const graph = (prefix: string) => ({ save: { class_type: "MCS_SaveAudioWav", inputs: { filename_prefix: prefix } } });
const scenario = (name: string): Scenario => ({ name, kind: "separate", graph: `graphs/${name}.json`, uploads: [], meta: {} });
// sep_dl: finishes, and the download of its output breaks off. sep_gone: leaves the queue without a history entry
// (removed from it, or ComfyUI restarted in between). sep_err: its execution fails in ComfyUI, as with every prefix
// "err…". A prefix "ok…" finishes, and its output downloads.
const SCENARIOS = [scenario("sep_dl"), scenario("sep_gone"), scenario("sep_err")];
const PREFIX: Record<string, string> = { sep_dl: "dl", sep_gone: "gone", sep_err: "err" };

/**
 * ComfyUI's HTTP API and /ws, as far as the driver uses them. `freezeWs`: the socket is opened and then never answered
 * again, also not the close frame (a server that hangs with its port open); otherwise a close frame is answered.
 */
async function fakeComfy({ freezeWs = false } = {}) {
  const requests: string[] = [];
  const prompts = new Map<string, string>(); // prompt_id -> output prefix
  const outputs = new Map<string, string>(); // prompt_id -> output file name of an "ok…" prompt
  const sockets = new Set<Socket>();
  const body = (req: IncomingMessage) =>
    new Promise<string>((res) => {
      let s = "";
      req.on("data", (d) => (s += d));
      req.on("end", () => res(s));
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);
    const text = await body(req);
    const json = (v: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.method === "POST" && url.pathname === "/prompt") {
      const { prompt, prompt_id } = JSON.parse(text);
      const prefix = prompt.save.inputs.filename_prefix;
      // a new name on every run, like separation stems (a new random prefix, the saver's counter)
      outputs.set(prompt_id, `${prefix}_${[...prompts.values()].filter((p) => p === prefix).length + 1}.wav`);
      prompts.set(prompt_id, prefix);
      return json({ prompt_id, number: prompts.size, node_errors: {} });
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.slice("/history/".length);
      const done = { status: { status_str: "success", completed: true, messages: [] }, outputs: { save: { audio: [{ filename: "a.wav", subfolder: "mcs", type: "output" }] } } };
      const error = { node_type: "MCS_SaveAudioWav", node_id: "save", exception_message: "CUDA out of memory" };
      const failed = { status: { status_str: "error", completed: false, messages: [["execution_error", error]] }, outputs: {} };
      const saved = { status: { status_str: "success", completed: true, messages: [] }, outputs: { save: { audio: [{ filename: outputs.get(id), subfolder: "mcs", type: "output" }] } } };
      const prefix = prompts.get(id) ?? "";
      const entry = prefix.startsWith("ok") ? saved : prefix.startsWith("err") ? failed : prefix === "dl" ? done : null;
      return json(entry ? { [id]: entry } : {});
    }
    if (req.method === "GET" && url.pathname === "/queue") return json({ queue_running: [], queue_pending: [] });
    if (url.pathname === "/view") {
      if (url.searchParams.get("filename") !== "a.wav") {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        return res.end(Buffer.from("RIFF fake"));
      }
      req.socket.destroy(); // the connection breaks off during the download
      return;
    }
    return json({});
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    requests.push("WS /ws");
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // the driver sends nothing but the close frame
    socket.on("data", () => {
      if (!freezeWs) socket.end(Buffer.from([0x88, 0x00]));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((res) => {
        for (const s of sockets) s.destroy();
        server.close(() => res());
      }),
  };
}

/** Runs the driver; it is killed after `killAfterMs` (exit code null then). */
function driver(args: string[], killAfterMs = 30_000) {
  return new Promise<{ code: number | null; out: string; err: string; seconds: number }>((res) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [DRIVER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill(), killAfterMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      res({ code, out, err, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

describe("e2e driver against a fake ComfyUI", () => {
  let dir = "";
  let server: Awaited<ReturnType<typeof fakeComfy>> | null = null;
  const result = (name: string, f: string) => join(dir, "results", name, f);
  const state = (s: Scenario) => resultState(join(dir, "results", s.name), JSON.parse(readFileSync(join(dir, s.graph as string), "utf8")));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcs-e2e-fake-"));
    mkdirSync(join(dir, "graphs"));
    for (const s of SCENARIOS) writeFileSync(join(dir, s.graph as string), JSON.stringify(graph(PREFIX[s.name])));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ scenarios: SCENARIOS }));
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not take a run whose download broke off for an up-to-date result, and check names the driver's error", async () => {
    server = await fakeComfy();
    const r = await driver(["run", "--dir", dir, "--server", server.url, "--only", "sep_dl"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/sep_dl \.\.\. ERROR /);
    expect(existsSync(result("sep_dl", "driver_error.json"))).toBe(true);
    // the next run takes it up again
    expect(state(SCENARIOS[0])).toBe("none");
    expect(planRun(SCENARIOS, { only: ["sep_dl"], state }).todo.map((s) => s.name)).toEqual(["sep_dl"]);
    const c = await driver(["check", "--dir", dir]);
    expect(c.code).toBe(1);
    expect(c.out).toMatch(/FAIL sep_dl: driver error: .*fetch failed/);
    expect(c.out).toMatch(/FAIL sep_gone: not run/);
  }, 60_000);

  it("ends a prompt that left the queue without a history entry at once, and check reports it as such", async () => {
    server = await fakeComfy();
    const r = await driver(["run", "--dir", dir, "--server", server.url, "--only", "sep_gone"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/sep_gone \.\.\. \{.*"vanished":true/);
    expect(server.requests).toContain("GET /queue");
    expect(existsSync(result("sep_gone", "history.json"))).toBe(false);
    expect(state(SCENARIOS[1])).toBe("none");
    const c = await driver(["check", "--dir", dir]);
    expect(c.out).toMatch(/FAIL sep_gone: the prompt left ComfyUI's queue without a history entry/);
    expect(c.out).not.toMatch(/rejected/);
  }, 60_000);

  it("exits when the server never answers the WebSocket close", async () => {
    server = await fakeComfy({ freezeWs: true });
    const r = await driver(["run", "--dir", dir, "--server", server.url, "--only", "sep_dl"], 20_000);
    expect(r.out).toMatch(/sep_dl \.\.\. ERROR /);
    expect(r.code).toBe(0); // not killed
    expect(r.seconds).toBeLessThan(20);
  }, 60_000);

  it("refuses --only names the manifest does not have, before contacting the server", async () => {
    server = await fakeComfy();
    for (const only of ["sep_x", "sep_x, sep_dl"]) {
      const r = await driver(["run", "--dir", dir, "--server", server.url, "--only", only]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--only: no scenario sep_x in .*manifest\.json \(scenarios: sep_dl, sep_gone, sep_err\)/);
    }
    const empty = await driver(["run", "--dir", dir, "--server", server.url, "--only", "--force"]);
    expect(empty.code).toBe(2);
    expect(empty.err).toMatch(/--only needs scenario names/);
    expect(server.requests).toEqual([]);
  }, 60_000);

  it("refuses arguments it does not know (an unquoted list with spaces, --only=...), before contacting the server", async () => {
    server = await fakeComfy();
    // `--only sep_dl, sep_gone` typed without quotes: sep_gone arrives as an argument of its own
    const stray = await driver(["run", "--dir", dir, "--server", server.url, "--only", "sep_dl,", "sep_gone"]);
    expect(stray.code).toBe(2);
    expect(stray.err).toMatch(/unexpected argument: sep_gone/);
    expect(stray.err).toMatch(/--only "a, b"/);
    const eq = await driver(["run", "--dir", dir, "--server", server.url, "--only=sep_dl"]);
    expect(eq.code).toBe(2);
    expect(eq.err).toMatch(/unexpected argument: --only=sep_dl/);
    // check takes no run options
    const c = await driver(["check", "--dir", dir, "--only", "sep_dl"]);
    expect(c.code).toBe(2);
    expect(c.err).toMatch(/unexpected arguments: --only sep_dl/);
    expect(server.requests).toEqual([]);
  }, 60_000);

  it("keeps a run whose execution failed: check reports it, only --retry-failed runs it again", async () => {
    server = await fakeComfy();
    const posts = () => server?.requests.filter((r) => r === "POST /prompt").length;
    const first = await driver(["run", "--dir", dir, "--server", server.url, "--only", "sep_err"]);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/sep_err \.\.\. \{.*"status":"error"/);
    expect(state(SCENARIOS[2])).toBe("failed");
    expect(posts()).toBe(1);
    // the next run leaves it as it is (a re-run would also re-run its session group) and says how to retry it
    const again = await driver(["run", "--dir", dir, "--server", server.url, "--only", "sep_err"]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/not re-run, their execution failed .*--retry-failed.*: sep_err/);
    expect(again.out).toMatch(/nothing to run/);
    expect(posts()).toBe(1);
    const c = await driver(["check", "--dir", dir]);
    expect(c.out).toMatch(/FAIL sep_err: execution failed: MCS_SaveAudioWav \(save\): CUDA out of memory/);
    const retry = await driver(["run", "--dir", dir, "--server", server.url, "--only", "sep_err", "--retry-failed"]);
    expect(retry.code).toBe(0);
    expect(retry.out).toMatch(/execution failed last time, retrying: sep_err/);
    expect(posts()).toBe(2);
  }, 60_000);

  it("still lists the scenarios it leaves out when it cannot reach ComfyUI (exit 2)", async () => {
    server = await fakeComfy();
    const first = await driver(["run", "--dir", dir, "--server", server.url, "--only", "sep_err"]);
    expect(first.code).toBe(0);
    expect(state(SCENARIOS[2])).toBe("failed");
    // the server is gone: sep_dl and sep_gone (never run) are to run, sep_err is left out
    const url = server.url;
    await server.close();
    server = null;
    const r = await driver(["run", "--dir", dir, "--server", url]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/is ComfyUI running at/);
    expect(r.out).toMatch(/not re-run, their execution failed .*--retry-failed.*: sep_err/);
  }, 60_000);

  /**
   * e2e_build_graphs: sep_h1 and sep_h3_repeat in one session group; align_i_en reads sep_h1's output file (the
   * stem), which a re-run of sep_h1 saves under a new name. `prefixes`: how each scenario ends (see fakeComfy).
   */
  const alignOfSeparation = (prefixes: Record<string, string>) => {
    const group = (name: string): Scenario => ({ ...scenario(name), meta: { session_group: "sep_two_songs" } });
    const stem = join(dir, "results", "sep_h1", "files", "mcs", "ok_sep_1.wav");
    const align: Scenario = { name: "align_i_en", kind: "align", graph: "graphs/align_i_en.json", uploads: [{ path: stem, name: "v.wav", subfolder: "mcs_e2e" }], meta: { lyrics: "la" } };
    const scenarios = [group("sep_h1"), group("sep_h3_repeat"), align];
    for (const s of scenarios) writeFileSync(join(dir, s.graph as string), JSON.stringify(graph(prefixes[s.name])));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ scenarios }));
    return { scenarios, stem };
  };
  const STALE_LINE = /not run, their input was re-made by a scenario that ran again \(results kept\): align_i_en\n/;
  const REBUILD_LINE = /rebuild the graphs \(cargo test e2e_build_graphs -- --ignored\), then run again \(without --force or --retry-failed\)/;

  it("reports an up-to-date scenario whose input a --retry-failed pass re-made as stale, in run and in check", async () => {
    const { scenarios, stem } = alignOfSeparation({ sep_h1: "ok_sep", sep_h3_repeat: "err", align_i_en: "ok_align" });
    server = await fakeComfy();
    const posts = () => server?.requests.filter((r) => r === "POST /prompt").length;
    const first = await driver(["run", "--dir", dir, "--server", server.url]);
    expect(first.code).toBe(0);
    expect(scenarios.map(state)).toEqual(["same", "failed", "same"]);
    expect(existsSync(stem)).toBe(true);
    // the group runs again and saves sep_h1's output under a new name: align_i_en's input is gone
    const retry = await driver(["run", "--dir", dir, "--server", server.url, "--retry-failed"]);
    expect(posts()).toBe(5);
    expect(existsSync(stem)).toBe(false);
    expect(retry.out).toMatch(STALE_LINE);
    expect(retry.out).toMatch(REBUILD_LINE);
    // the pass that re-makes the input does not call the scenario up to date either
    expect(retry.out).not.toMatch(/skipped \(up to date\):[^\n]*align_i_en/);
    expect(retry.code).toBe(1);
    // and on every later pass, until the graphs are rebuilt: not "up to date"
    const again = await driver(["run", "--dir", dir, "--server", server.url]);
    expect(posts()).toBe(5);
    expect(again.out).toMatch(/skipped \(up to date\): sep_h1\n/);
    expect(again.out).toMatch(/nothing to run/);
    expect(again.out).toMatch(STALE_LINE);
    expect(again.code).toBe(1);
    const c = await driver(["check", "--dir", dir]);
    expect(c.code).toBe(1);
    expect(c.out).toMatch(/FAIL align_i_en: stale input \(re-made by a later run: .*ok_sep_1\.wav\): rebuild the graphs/);
    expect(c.out).not.toMatch(/ENOENT/);
  }, 60_000);

  it("reports a failed scenario whose input a later pass re-made as stale (rebuild, not --retry-failed), in run and in check", async () => {
    const { scenarios, stem } = alignOfSeparation({ sep_h1: "ok_sep", sep_h3_repeat: "ok_sep3", align_i_en: "err_align" });
    server = await fakeComfy();
    const posts = () => server?.requests.filter((r) => r === "POST /prompt").length;
    const first = await driver(["run", "--dir", dir, "--server", server.url]);
    expect(first.code).toBe(0);
    expect(scenarios.map(state)).toEqual(["same", "same", "failed"]);
    // a separation builder change and a rebuild: sep_h1's graph changes, align_i_en's (from the same stem) does not
    writeFileSync(join(dir, "graphs", "sep_h1.json"), JSON.stringify({ ...graph("ok_sep"), note: { class_type: "MCS_Note", inputs: {} } }));
    expect(scenarios.map(state)).toEqual(["changed", "same", "failed"]);
    // the group runs again and saves sep_h1's output under a new name: align_i_en's input is gone
    const changed = await driver(["run", "--dir", dir, "--server", server.url]);
    expect(posts()).toBe(5);
    expect(existsSync(stem)).toBe(false);
    expect(changed.out).toMatch(/graph changed, re-running: sep_h1\n/);
    expect(changed.out).toMatch(STALE_LINE);
    expect(changed.out).toMatch(REBUILD_LINE);
    expect(changed.out).not.toMatch(/--retry-failed runs them again[^\n]*align_i_en/);
    expect(changed.code).toBe(1);
    // and on every later pass, until the graphs are rebuilt
    const again = await driver(["run", "--dir", dir, "--server", server.url]);
    expect(posts()).toBe(5);
    expect(again.out).toMatch(/nothing to run/);
    expect(again.out).toMatch(STALE_LINE);
    expect(again.out).toMatch(REBUILD_LINE);
    expect(again.out).not.toMatch(/not re-run, their execution failed/);
    expect(again.code).toBe(1);
    const c = await driver(["check", "--dir", dir]);
    expect(c.code).toBe(1);
    expect(c.out).toMatch(/FAIL align_i_en: stale input \(re-made by a later run: .*ok_sep_1\.wav\): rebuild the graphs/);
  }, 60_000);
});
