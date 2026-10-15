import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ComponentStatus } from "../../api";
import {
  BF16_MIN_VRAM_MIB,
  ComfyStopTracker,
  DATA_ROOT_MAX_SAFE_LEN,
  DATA_ROOT_OWNED_FOLDERS,
  INT8_MIN_VRAM_MIB,
  apiKeysToSave,
  autoPrecision,
  cleanLocation,
  dataRootWarning,
  defaultSetupSelection,
  freeVramBlock,
  installedPrecisions,
  isCancelledPhase,
  isInsecureRemoteUrl,
  isNativeYue2Node,
  llmContextSizeLabel,
  llmContextSizeOptions,
  llmSaveNotice,
  locationError,
  normalizeDurations,
  openaiKeyOriginMismatch,
  outputDirWarning,
  portsError,
  requiredInstalled,
  settingsSaveNotes,
  urlOrigin,
} from "../rules";

const comp = (id: string, installed: boolean): ComponentStatus => ({
  id,
  name: id,
  description: "",
  url: "",
  kind: "file",
  dest: "",
  size: 0,
  sha256: null,
  required: false,
  marker: "",
  stripRoot: false,
  installed,
  installedBytes: 0,
});

describe("normalizeDurations", () => {
  it("keeps valid values", () => {
    expect(normalizeDurations(900, 360)).toEqual({ maxDurationLimit: 900, defaultMaxDuration: 360 });
    expect(normalizeDurations(600, 8)).toEqual({ maxDurationLimit: 600, defaultMaxDuration: 8 });
  });
  it("clamps the limit to [60, 900]", () => {
    expect(normalizeDurations(0, 30).maxDurationLimit).toBe(60);
    expect(normalizeDurations(3, 30).maxDurationLimit).toBe(60);
    expect(normalizeDurations(5000, 360).maxDurationLimit).toBe(900);
  });
  it("falls back for empty input", () => {
    expect(normalizeDurations(NaN, NaN)).toEqual({ maxDurationLimit: 900, defaultMaxDuration: 360 });
  });
  it("rounds fractional values (u32 config fields)", () => {
    expect(normalizeDurations(300.6, 120.4)).toEqual({ maxDurationLimit: 301, defaultMaxDuration: 120 });
  });
  it("clamps the default into [8, limit], also when the limit is lowered", () => {
    expect(normalizeDurations(300, 360)).toEqual({ maxDurationLimit: 300, defaultMaxDuration: 300 });
    expect(normalizeDurations(20, 360)).toEqual({ maxDurationLimit: 60, defaultMaxDuration: 60 });
    expect(normalizeDurations(900, 2).defaultMaxDuration).toBe(8);
    expect(normalizeDurations(900, 0).defaultMaxDuration).toBe(8);
  });
});

describe("dataRootWarning", () => {
  it("warns for $ or %", () => {
    expect(dataRootWarning("C:\\MCSYuE2")).toBeNull();
    expect(dataRootWarning("D:\\My Music #1\\it's")).toBeNull();
    expect(dataRootWarning("D:\\%USERNAME%\\yue")).not.toBeNull();
    expect(dataRootWarning("D:\\$HOME\\yue")).not.toBeNull();
  });
  it("warns for a long path (Windows long paths off)", () => {
    const at = "D:\\" + "a".repeat(DATA_ROOT_MAX_SAFE_LEN - 3);
    expect(at.length).toBe(DATA_ROOT_MAX_SAFE_LEN);
    expect(dataRootWarning(at)).toBeNull();
    expect(dataRootWarning(at + "b")).toContain("長すぎます");
  });
  it("warns for the profile or a standard user folder itself", () => {
    expect(dataRootWarning("C:\\Users\\me")).toContain("共通フォルダ");
    expect(dataRootWarning("C:\\Users\\me\\Documents\\")).toContain("共通フォルダ");
    expect(dataRootWarning("C:\\Users\\me\\Documents\\MCS")).toBeNull();
    expect(outputDirWarning("C:\\Users\\me\\Music")).toContain("サブフォルダ");
    expect(outputDirWarning("c:/users/me/music")).not.toBeNull();
    expect(outputDirWarning("C:\\Users\\me\\Music\\Music Creator Studio YuE2")).toBeNull();
  });
});

describe("song folder in the data root", () => {
  const root = "C:\\MCSYuE2";

  it("warns for a folder the app owns or one inside it (the uninstaller and the app's clean-ups delete there)", () => {
    expect(outputDirWarning(`${root}\\runtime\\ComfyUI_windows_portable\\ComfyUI\\output`, root)).toContain("（runtime\\ComfyUI_windows_portable）の中です");
    expect(outputDirWarning(`${root}\\comfy_output\\mcs`, root)).toContain("（comfy_output\\mcs）そのものです");
    expect(outputDirWarning(`${root}\\cache\\sep_work\\songs`, root)).toContain("cache\\sep_work");
    // spelled another way: case, '/' separators, a trailing or doubled separator, a UNC root
    expect(outputDirWarning("c:/mcsyue2/Comfy_Output/MCS_sep/", root)).toContain("comfy_output\\mcs_sep");
    expect(outputDirWarning(`${root}\\runtime\\\\llama`, `${root}\\`)).toContain("runtime\\llama");
    expect(outputDirWarning("\\\\nas\\share\\mcs\\comfy_input\\mcs_uploads\\x", "\\\\nas\\share\\mcs")).toContain("comfy_input\\mcs_uploads");
  });

  it("does not warn elsewhere in the data root or for a look-alike name", () => {
    for (const p of [root, `${root}\\songs`, `${root}\\runtime`, `${root}\\runtime\\songs`, `${root}\\comfy_output`, `${root}\\comfy_output\\mcs2`, `${root}\\cache\\sep_work2`, `${root}2\\runtime\\llama`, "D:\\MCSYuE2\\runtime\\llama"]) {
      expect(outputDirWarning(p, root), p).toBeNull();
    }
    // no data root to compare with (an invalid one is not passed)
    expect(outputDirWarning(`${root}\\runtime\\llama`, "")).toBeNull();
    expect(outputDirWarning(`${root}\\runtime\\llama`)).toBeNull();
    // the shell-folder note still applies
    expect(outputDirWarning("C:\\Users\\me\\Music", root)).toContain("サブフォルダ");
  });

  it("is checked against the data root wherever the song folder is chosen (設定 and the setup wizard)", () => {
    const pagesDir = fileURLToPath(new URL("../../pages/", import.meta.url));
    const callers = readdirSync(pagesDir).filter((f) => f.endsWith(".tsx"));
    const calls = callers.flatMap((f) => [...readFileSync(`${pagesDir}${f}`, "utf8").matchAll(/outputDirWarning\(([^()]*)\)/g)].map((m) => ({ f, args: m[1] })));
    expect(new Set(calls.map((c) => c.f))).toEqual(new Set(["SettingsPage.tsx", "SetupWizard.tsx"]));
    // the data root of the same form, unless that one is invalid (no check then)
    for (const c of calls) expect(c.args, c.f).toMatch(/^[\w.]+, rootError \? "" : [\w.]+$/);
  });

  it("knows every folder the uninstaller removes, or deletes the app's files in, with the tools (hooks.nsh McsDeleteDataRoot)", () => {
    const hooks = readFileSync(fileURLToPath(new URL("../../../src-tauri/windows/hooks.nsh", import.meta.url)), "utf8");
    const body = hooks.slice(hooks.indexOf("Function ${UN}McsDeleteDataRoot"));
    const fn = body.slice(0, body.indexOf("FunctionEnd"));
    const removed = [...fn.matchAll(/^\s*!insertmacro McsRMDirR "\$\{UN\}" "\$R0\\(.+)"\s*$/gm)].map((m) => m[1]);
    // comfy_input\mcs_uploads, comfy_output\mcs and mcs_sep: only the app's own files go there (McsDeleteOwnFiles)
    const deletedIn = [...fn.matchAll(/^\s*!insertmacro McsDeleteOwnFiles "\$\{UN\}" "\$R0\\([^"]+)" "\w+"\s*$/gm)].map((m) => m[1]);
    expect(deletedIn.length).toBeGreaterThanOrEqual(3);
    expect(removed.length + deletedIn.length).toBeGreaterThanOrEqual(10);
    expect([...DATA_ROOT_OWNED_FOLDERS].sort()).toEqual([...removed, ...deletedIn].sort());
  });
});

describe("locations", () => {
  it("cleans pasted paths", () => {
    expect(cleanLocation('  "D:\\MCS"  ')).toBe("D:\\MCS");
    expect(cleanLocation("C:\\MCSYuE2 ")).toBe("C:\\MCSYuE2");
    expect(cleanLocation('"')).toBe('"');
  });
  it("accepts absolute folders", () => {
    for (const p of ["C:\\MCSYuE2", "D:/AI/mcs", "C:\\Users\\山田\\Music\\Music Creator Studio YuE2", "\\\\server\\share\\mcs", "D:\\My Music #1\\it's"]) {
      expect(locationError(p, "data")).toBeNull();
    }
  });
  it("rejects what the backend rejects", () => {
    const bad = ["", "  ", "MCSYuE2", "C:MCSYuE2", "\\MCSYuE2", '"C:\\MCSYuE2"', "C:\\a|b", "C:\\a?b", "C:\\a:b", "C:\\MCS \\x", "C:\\MCS.", "C:\\a\\..\\b", "C:\\a\u0007b", "C:\\", "D:", "D:/", "\\\\server\\share", "\\\\server\\share\\"];
    for (const p of bad) expect(locationError(p, "out"), p).not.toBeNull();
    expect(locationError("", "data")).toBe("データルートを指定してください");
    expect(locationError("songs", "out")).toContain("楽曲の保存先には絶対パス");
  });
  it("rejects ';' in the data root only", () => {
    expect(locationError("C:\\a;b", "data")).toContain("「;」");
    expect(locationError("C:\\a;b", "out")).toBeNull();
  });
});

describe("setup wizard", () => {
  const req = (id: string, installed: boolean) => ({ ...comp(id, installed), required: true });
  const DEFAULT_ON = new Set(["qwen3_14b"]);
  it("pre-selects optional downloads only on a first setup", () => {
    const first = [req("comfyui", false), req("ffmpeg", true), comp("qwen3_14b", false), comp("uroman_pip", false)];
    expect([...defaultSetupSelection(first, DEFAULT_ON)]).toEqual(["comfyui", "qwen3_14b"]);
    const rerun = [req("comfyui", true), req("ffmpeg", true), comp("qwen3_14b", false), comp("uroman_pip", false)];
    expect(defaultSetupSelection(rerun, DEFAULT_ON).size).toBe(0);
    expect(requiredInstalled(rerun)).toBe(true);
    expect(requiredInstalled(first)).toBe(false);
    expect(requiredInstalled([])).toBe(false);
  });
  it("tells a cancel from an error", () => {
    expect(isCancelledPhase("cancelled")).toBe(true);
    expect(isCancelledPhase("error")).toBe(false);
  });
});

describe("settings", () => {
  it("validates ports", () => {
    expect(portsError(8199, 8099)).toBeNull();
    expect(portsError(1, 65535)).toBeNull();
    expect(portsError(0, 8099)).toContain("ComfyUI ポート");
    expect(portsError(NaN, 8099)).toContain("ComfyUI ポート");
    expect(portsError(8199, 70000)).toContain("LLM ポート");
    expect(portsError(8199, 8199.5)).toContain("LLM ポート");
    expect(portsError(8199, 8199)).toContain("別の番号");
  });
  it("flags API keys sent over plain http to another machine", () => {
    expect(isInsecureRemoteUrl("http://api.example.com/v1")).toBe(true);
    expect(isInsecureRemoteUrl("http://192.168.1.5:8000/v1")).toBe(true);
    expect(isInsecureRemoteUrl("https://api.openai.com/v1")).toBe(false);
    expect(isInsecureRemoteUrl("http://localhost:11434/v1")).toBe(false);
    expect(isInsecureRemoteUrl("http://127.0.0.1:8080")).toBe(false);
    expect(isInsecureRemoteUrl("http://[::1]:8080")).toBe(false);
    expect(isInsecureRemoteUrl("http://127.10.20.30/v1")).toBe(false);
    // Host names that only start like a loopback address reach another machine.
    expect(isInsecureRemoteUrl("http://127.example.com/v1")).toBe(true);
    expect(isInsecureRemoteUrl("http://127.0.0.1.nip.io/v1")).toBe(true);
    expect(isInsecureRemoteUrl("http://127.0.0.1@example.com/v1")).toBe(true);
  });
  it("keeps the VRAM lines", () => {
    expect(BF16_MIN_VRAM_MIB).toBe(20000);
    expect(INT8_MIN_VRAM_MIB).toBeLessThan(BF16_MIN_VRAM_MIB);
  });
});

describe("precision", () => {
  const both = [comp("yue2_bf16", true), comp("yue2_int8", true)];
  const bf16Only = [comp("yue2_bf16", true), comp("yue2_int8", false)];
  it("reports installed checkpoints", () => {
    expect(installedPrecisions([])).toBeNull();
    expect(installedPrecisions(bf16Only)).toEqual({ bf16: true, int8: false });
  });
  it("picks INT8 below 20 GB only when installed", () => {
    expect(autoPrecision(12000, both, "bf16")).toBe("int8");
    expect(autoPrecision(12000, bf16Only, "bf16")).toBe("bf16");
    expect(autoPrecision(24564, both, "bf16")).toBe("bf16");
    expect(autoPrecision(20000, both, "bf16")).toBe("bf16");
    expect(autoPrecision(null, both, "bf16")).toBe("bf16");
    expect(autoPrecision(12000, [], "bf16")).toBe("bf16");
  });
  it("keeps the current choice otherwise, unless its checkpoint is missing", () => {
    expect(autoPrecision(24564, both, "int8")).toBe("int8");
    expect(autoPrecision(24564, bf16Only, "int8")).toBe("bf16");
    expect(autoPrecision(24564, [comp("yue2_bf16", false), comp("yue2_int8", true)], "bf16")).toBe("int8");
    expect(autoPrecision(24564, [], "int8")).toBe("int8");
  });
  it("keeps an explicit choice on a wizard re-run regardless of VRAM", () => {
    expect(autoPrecision(12000, both, "bf16", false)).toBe("bf16");
    expect(autoPrecision(12000, both, "int8", false)).toBe("int8");
    expect(autoPrecision(12000, [comp("yue2_bf16", false), comp("yue2_int8", true)], "bf16", false)).toBe("int8");
  });
});

describe("isNativeYue2Node", () => {
  it("separates official YuE2 nodes from the app's node pack", () => {
    expect(isNativeYue2Node("YuE2GenerateMusic")).toBe(true);
    expect(isNativeYue2Node("EmptyYuE2LatentAudio")).toBe(true);
    expect(isNativeYue2Node("MCS_SaveAudioWav")).toBe(false);
  });
});

describe("OpenAI key origin", () => {
  it("reduces a Base URL to scheme://host[:port] like the backend", () => {
    expect(urlOrigin("https://api.openai.com/v1")).toBe("https://api.openai.com");
    expect(urlOrigin(" https://api.openai.com:443/v1/ ")).toBe("https://api.openai.com");
    expect(urlOrigin("http://192.168.1.5:1234/v1")).toBe("http://192.168.1.5:1234");
    expect(urlOrigin("HTTP://LocalHost:8080")).toBe("http://localhost:8080");
    expect(urlOrigin("ftp://x/v1")).toBeNull();
    expect(urlOrigin("not a url")).toBeNull();
  });

  it("flags a Base URL the stored key is not sent to", () => {
    expect(openaiKeyOriginMismatch("https://api.openai.com", "https://api.openai.com/v1")).toBe(false);
    expect(openaiKeyOriginMismatch("https://api.openai.com", "http://192.168.1.5:1234/v1")).toBe(true);
    // not bound yet, or a URL the backend rejects anyway: no hint
    expect(openaiKeyOriginMismatch(null, "http://192.168.1.5:1234/v1")).toBe(false);
    expect(openaiKeyOriginMismatch("https://api.openai.com", "")).toBe(false);
  });
});

describe("llmContextSizeOptions", () => {
  it("offers the usual sizes and keeps a hand-set value", () => {
    expect(llmContextSizeOptions(16384)).toEqual([8192, 16384, 24576, 32768]);
    expect(llmContextSizeOptions(40960)).toEqual([8192, 16384, 24576, 32768, 40960]);
    expect(llmContextSizeOptions(4096)).toEqual([4096, 8192, 16384, 24576, 32768]);
    expect(llmContextSizeOptions(Number.NaN)).toEqual([8192, 16384, 24576, 32768]);
    expect(llmContextSizeOptions(-1)).toEqual([8192, 16384, 24576, 32768]);
    // 0 (llama-server takes the size from the model) is shown as it is, not as the first choice
    expect(llmContextSizeOptions(0)).toEqual([0, 8192, 16384, 24576, 32768]);
    expect(llmContextSizeLabel(0)).toBe("0（モデルの設定値）");
    expect(llmContextSizeLabel(16384)).toBe("16,384（既定）");
    expect(llmContextSizeLabel(8192)).toBe("8,192");
  });
});

describe("settingsSaveNotes", () => {
  const none = {
    vaeChanged: false,
    comfyPortChanged: false,
    dataRootChanged: false,
    externalComfy: false,
    comfyProcessRunning: false,
    dataRootReady: null,
    llmPortChanged: false,
    llmProcessRunning: false,
  };
  it("says nothing when nothing takes effect later", () => {
    expect(settingsSaveNotes(none)).toEqual([]);
    // launch settings changed while no ComfyUI of this app runs: applied at the next start
    expect(settingsSaveNotes({ ...none, vaeChanged: true, comfyPortChanged: true })).toEqual([]);
    expect(settingsSaveNotes({ ...none, llmPortChanged: true })).toEqual([]);
  });
  it("announces the restart of this app's ComfyUI", () => {
    expect(settingsSaveNotes({ ...none, vaeChanged: true, comfyProcessRunning: true })[0]).toContain("再起動して反映します");
    expect(settingsSaveNotes({ ...none, dataRootChanged: true, dataRootReady: true, comfyProcessRunning: true })[0]).toContain("再起動して反映します");
    expect(settingsSaveNotes({ ...none, dataRootChanged: true, dataRootReady: null, comfyProcessRunning: true })[0]).toContain("再起動して反映します");
  });
  it("a VAE change cannot reach a ComfyUI started elsewhere unless the port changes too", () => {
    expect(settingsSaveNotes({ ...none, vaeChanged: true, externalComfy: true })[0]).toContain("VAE 精度の変更は反映されません");
    expect(settingsSaveNotes({ ...none, vaeChanged: true, externalComfy: true, comfyPortChanged: true })).toEqual([]);
  });
  it("a data root without the components asks for the setup instead of promising a restart", () => {
    const n = settingsSaveNotes({ ...none, dataRootChanged: true, dataRootReady: false, comfyProcessRunning: true });
    expect(n).toHaveLength(1);
    expect(n[0]).toContain("「セットアップをやり直す」");
    expect(n[0]).toContain("空き次第停止します");
    expect(settingsSaveNotes({ ...none, dataRootChanged: true, dataRootReady: false })[0]).not.toContain("停止");
  });
  it("mentions the LLM port only while this app's llama-server runs", () => {
    expect(settingsSaveNotes({ ...none, llmPortChanged: true, llmProcessRunning: true })).toEqual(["LLM ポートの変更は、次の AI リクエストで LLM を再起動して反映します"]);
  });
});

describe("apiKeysToSave", () => {
  it("trims typed keys; a field of spaces leaves the saved key alone (only キーを削除 deletes)", () => {
    expect(apiKeysToSave(" ", "", true)).toEqual({ anthropic: null, openai: null, openaiHeld: false });
    expect(apiKeysToSave("", " \t ", true)).toEqual({ anthropic: null, openai: null, openaiHeld: false });
    expect(apiKeysToSave("  sk-ant-x ", " sk-y", true)).toEqual({ anthropic: "sk-ant-x", openai: "sk-y", openaiHeld: false });
    expect(apiKeysToSave("", "", true)).toEqual({ anthropic: null, openai: null, openaiHeld: false });
  });

  it("holds an OpenAI-compatible key back while the settings (its Base URL) could not be saved", () => {
    // the backend binds the key to the Base URL of its first request: that would be the old saved one
    expect(apiKeysToSave("", "sk-or-x", false)).toEqual({ anthropic: null, openai: null, openaiHeld: true });
    // the Anthropic key has no Base URL: it is saved as before
    expect(apiKeysToSave("sk-ant-x", "sk-or-x", false)).toEqual({ anthropic: "sk-ant-x", openai: null, openaiHeld: true });
    expect(apiKeysToSave("sk-ant-x", " ", false)).toEqual({ anthropic: "sk-ant-x", openai: null, openaiHeld: false });
  });
});

describe("llmSaveNotice", () => {
  it("reports the save", () => {
    expect(llmSaveNotice({ saveError: null, keysSaved: true, openaiHeld: false })).toEqual({ kind: "success", text: "設定と API キーを保存しました" });
    expect(llmSaveNotice({ saveError: null, keysSaved: false, openaiHeld: false })).toEqual({ kind: "success", text: "設定を保存しました" });
  });

  it("leaves a failed save without keys to save()'s own error", () => {
    expect(llmSaveNotice({ saveError: "ポートが不正", keysSaved: false, openaiHeld: false })).toBeNull();
  });

  it("says which key was saved and which waits for the settings", () => {
    expect(llmSaveNotice({ saveError: "E", keysSaved: true, openaiHeld: false })).toEqual({ kind: "error", text: "API キーは保存しましたが、設定を保存できませんでした: E" });
    const held = llmSaveNotice({ saveError: "E", keysSaved: false, openaiHeld: true });
    expect(held?.kind).toBe("error");
    expect(held?.text).toContain("設定を保存できませんでした: E");
    expect(held?.text).toContain("OpenAI 互換 API のキーはまだ保存していません");
    const both = llmSaveNotice({ saveError: "E", keysSaved: true, openaiHeld: true });
    expect(both?.text).toContain("Anthropic の API キーは保存しましたが");
    expect(both?.text).toContain("OpenAI 互換 API のキーはまだ保存していません");
  });
});

describe("freeVramBlock", () => {
  it("needs a ComfyUI that answers", () => {
    expect(freeVramBlock({ alive: true, processRunning: true })).toBeNull();
    // a ComfyUI started elsewhere answers too
    expect(freeVramBlock({ alive: true, processRunning: false })).toBeNull();
    expect(freeVramBlock({ alive: false, processRunning: false })).toBe("ComfyUI は停止しています");
    expect(freeVramBlock(null)).toBe("ComfyUI は停止しています");
    expect(freeVramBlock({ alive: false, processRunning: true })).toContain("起動中");
  });
});

describe("ComfyStopTracker", () => {
  /** A ComfyUI start that waits until `end` settles it (the backend's start loop). */
  function pendingStart() {
    let end: (err?: Error) => void = () => undefined;
    const call = () => new Promise<void>((resolve, reject) => (end = (err) => (err ? reject(err) : resolve())));
    return { call, end: (err?: Error) => end(err) };
  }
  const DIED = new Error("ComfyUI プロセスが終了しました。ログを確認してください: comfyui.log");

  it("drops the failure of a start that 停止 ended meanwhile", async () => {
    const t = new ComfyStopTracker();
    const s = pendingStart();
    const started = t.start(s.call);
    await t.stop(async () => undefined);
    s.end(DIED);
    await expect(started).resolves.toBe(false);
  });

  it("reports a start that failed by itself, and a successful one", async () => {
    const t = new ComfyStopTracker();
    const s = pendingStart();
    const started = t.start(s.call);
    s.end(DIED);
    await expect(started).rejects.toThrow("プロセスが終了しました");
    // a stop before the start does not hide the start's own failure
    await t.stop(async () => undefined);
    const again = pendingStart();
    const second = t.start(again.call);
    again.end(DIED);
    await expect(second).rejects.toThrow("プロセスが終了しました");
    await expect(t.start(async () => undefined)).resolves.toBe(true);
  });

  it("counts a stop before its reply (the start can fail first) but not a refused one", async () => {
    const t = new ComfyStopTracker();
    const early = pendingStart();
    const startedEarly = t.start(early.call);
    let stopReply: () => void = () => undefined;
    const stopping = t.stop(() => new Promise<void>((r) => (stopReply = r)));
    early.end(DIED); // the start loop sees the process gone before comfy_stop returns
    await expect(startedEarly).resolves.toBe(false);
    stopReply();
    await stopping;

    const s = pendingStart();
    const started = t.start(s.call);
    await expect(t.stop(() => Promise.reject(new Error("生成・ツールの実行中は停止できません。")))).rejects.toThrow("停止できません");
    s.end(DIED);
    await expect(started).rejects.toThrow("プロセスが終了しました");
  });
});
