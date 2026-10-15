import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import type { ComponentStatus, DataRootCheck, SetupProgress, SystemCheck } from "../../api";
import { SETUP_STILL_RUNNING, SetupRunFollower, driverLabel, freeSpaceLabel, gpuLabel, isSetupStillRunning, knownFreeBytes, mergeSystemCheck, setupFailureText, withDataRootCheck } from "../SetupWizard";

const WIZARD = fileURLToPath(new URL("../SetupWizard.tsx", import.meta.url));
const LIB_RS = fileURLToPath(new URL("../../../src-tauri/src/lib.rs", import.meta.url));
const SETUP_RS = fileURLToPath(new URL("../../../src-tauri/src/setup.rs", import.meta.url));
const API_TS = fileURLToPath(new URL("../../api.ts", import.meta.url));
const STYLES = fileURLToPath(new URL("../../styles.css", import.meta.url));

const progress = (id: string, phase: SetupProgress["phase"]): SetupProgress => ({ id, phase, downloaded: 0, total: 0, bytesPerSec: 0, message: "" });

function comp(id: string, required: boolean, installed: boolean): ComponentStatus {
  return { id, name: id, description: "", url: "", kind: "file", dest: "", size: 0, sha256: null, required, marker: "", stripRoot: false, installed, installedBytes: 0 };
}

describe("following a setup run (the page may be reloaded while setup_install runs)", () => {
  it("ends its own run with the setupInstall call, not with setup://finished", () => {
    const f = new SetupRunFollower();
    f.started();
    expect(f.progress(progress("comfyui", "download"))).toBe(false);
    // the call's own result settles the run (the event may come before or after it)
    expect(f.finished(null)).toBeNull();
    f.ended();
    // a run's last events (done / error / cancelled) arriving after its call returned do not start another one
    expect(f.progress(progress("comfyui", "done"))).toBe(false);
    expect(f.progress(progress("qwen3_14b", "error"))).toBe(false);
    expect(f.progress(progress("qwen3_14b", "cancelled"))).toBe(false);
    expect(f.finished(null)).toBeNull();
  });

  it("attaches to a run it did not start at its next progress event, and ends it with setup://finished", () => {
    const f = new SetupRunFollower();
    expect(f.progress(progress("yue2_bf16", "download"))).toBe(true);
    // once
    expect(f.progress(progress("yue2_bf16", "verify"))).toBe(false);
    expect(f.finished("ディスクの空きが足りません")).toEqual({ error: "ディスクの空きが足りません" });
    // its end is shown once (the same event heard twice)
    expect(f.finished("ディスクの空きが足りません")).toBeNull();
    expect(f.progress(progress("yue2_bf16", "download"))).toBe(false);
    f.ended();
    expect(f.progress(progress("sheetsage2", "extract"))).toBe(true);
    expect(f.finished(null)).toEqual({ error: null });
  });

  it("follows the run that refused setup_install, or takes its end when that came first", () => {
    const waiting = new SetupRunFollower();
    // the end of an earlier run (before this start) does not end the one that refused it
    expect(waiting.finished(null)).toBeNull();
    waiting.started();
    expect(waiting.refused()).toBeNull();
    expect(waiting.finished(null)).toEqual({ error: null });

    const over = new SetupRunFollower();
    over.started();
    // the running one ended between the refusal and its arrival here
    expect(over.finished("失敗")).toBeNull();
    expect(over.refused()).toEqual({ error: "失敗" });
  });

  it("follows a run that refused 開始 / アプリに戻る (reloaded during a pip step, which reports only its start)", () => {
    const lib = readFileSync(LIB_RS, "utf8");
    const refusal = /const SETUP_STILL_RUNNING: &str = "([^"]+)";/.exec(lib)?.[1];
    expect(refusal, "lib.rs SETUP_STILL_RUNNING").toBeTruthy();
    expect(refusal!.startsWith(SETUP_STILL_RUNNING)).toBe(true);
    expect(isSetupStillRunning(refusal)).toBe(true);
    expect(isSetupStillRunning("セットアップは既に実行中です")).toBe(false);

    // setup_finalize refused: the run goes on, and setup://finished ends it
    const f = new SetupRunFollower();
    f.started();
    expect(f.refused()).toBeNull();
    expect(f.finished(null)).toEqual({ error: null });
    // setup_finalize done: nothing is followed, a run the page did not start is still shown at its next event
    const g = new SetupRunFollower();
    g.started();
    g.ended();
    expect(g.progress(progress("comfyui", "download"))).toBe(true);
  });
});

describe("setup failure text", () => {
  const cs = [comp("comfyui", true, true), comp("ffmpeg", true, true), comp("qwen3_14b", false, false)];

  it("suggests unchecking only when an item of the run failed", () => {
    expect(setupFailureText("qwen3_14b: 404", cs, { qwen3_14b: progress("qwen3_14b", "error") })).toBe(
      "qwen3_14b: 404\n必須コンポーネントは導入済みです。失敗した項目のチェックを外すと次へ進めます。",
    );
    // no item failed (a full disk, an unusable data root): nothing to uncheck
    expect(setupFailureText("ディスクの空きが足りません", cs, {})).toBe("ディスクの空きが足りません");
    expect(setupFailureText("x", cs, { qwen3_14b: progress("qwen3_14b", "download") })).toBe("x");
    // the failed item is installed after all
    expect(setupFailureText("x", [comp("comfyui", true, true), comp("qwen3_14b", false, true)], { qwen3_14b: progress("qwen3_14b", "error") })).toBe("x");
  });

  it("does not suggest it while a required component is missing", () => {
    expect(setupFailureText("comfyui: 404", [comp("comfyui", true, false)], { comfyui: progress("comfyui", "error") })).toBe("comfyui: 404");
  });
});

describe("environment check", () => {
  it("tells a hung nvidia-smi from a missing GPU", () => {
    expect(gpuLabel({ gpuName: "NVIDIA GeForce RTX 5090", driverVersion: "581.15", gpuProbeTimedOut: false })).toBe("NVIDIA GeForce RTX 5090");
    expect(gpuLabel({ gpuName: null, driverVersion: null, gpuProbeTimedOut: false })).toBe("NVIDIA GPU が見つかりません（nvidia-smi 不在）");
    const hung = gpuLabel({ gpuName: null, driverVersion: null, gpuProbeTimedOut: true });
    expect(hung).toContain("GPU 情報を取得できませんでした");
    expect(hung).toContain("nvidia-smi が応答しません");
  });

  it("does not ask for a driver update when the driver version is unknown (hung nvidia-smi)", () => {
    expect(driverLabel({ gpuName: "NVIDIA GeForce RTX 5090", driverVersion: "581.15", driverOk: true, gpuProbeTimedOut: false })).toEqual({ text: "581.15", ok: true, hint: null });
    const hung = driverLabel({ gpuName: null, driverVersion: null, driverOk: false, gpuProbeTimedOut: true });
    expect(hung).toEqual({ text: "不明（nvidia-smi が応答しません）", ok: false, hint: null });
    const update = "580.88 以上が必要です（CUDA 13.0）。NVIDIA ドライバを更新してください。";
    expect(driverLabel({ gpuName: "NVIDIA GeForce RTX 4080", driverVersion: "560.94", driverOk: false, gpuProbeTimedOut: false })).toEqual({ text: "560.94", ok: false, hint: update });
    // no nvidia-smi: as before
    expect(driverLabel({ gpuName: null, driverVersion: null, driverOk: false, gpuProbeTimedOut: false })).toEqual({ text: "-", ok: false, hint: update });
    expect(readFileSync(WIZARD, "utf8")).toContain("const driver = check ? driverLabel(check) : null;");
  });

  // A 再確認 whose nvidia-smi ended with an error (or is gone) keeps the GPU found before (mergeSystemCheck): a real
  // answer with a GPU always has its driver version (setup.rs system_check_with), so a GPU without one is a kept one.
  it("says that a 再確認 got no GPU information when it keeps the GPU found before", () => {
    const label = gpuLabel({ gpuName: "NVIDIA GeForce RTX 5060 Ti", driverVersion: null, gpuProbeTimedOut: false });
    expect(label).toContain("NVIDIA GeForce RTX 5060 Ti");
    expect(label).toContain("再確認では nvidia-smi から GPU 情報を取得できませんでした");
    expect(label).toContain("「再確認」を押してください");
    expect(driverLabel({ gpuName: "NVIDIA GeForce RTX 5060 Ti", driverVersion: null, driverOk: false, gpuProbeTimedOut: false })).toEqual({
      text: "不明（nvidia-smi が GPU 情報を返しませんでした）",
      ok: false,
      hint: null,
    });
    const src = readFileSync(SETUP_RS, "utf8");
    expect(src).toMatch(/sc\.gpu_name = Some\(parts\[0\]\.to_string\(\)\);\s*sc\.driver_version = Some\(parts\[1\]\.to_string\(\)\);/);
  });
});

describe("SetupWizard locations while a setup run goes on", () => {
  const code = readFileSync(WIZARD, "utf8");
  /** The body of the component's `const name = ...` (up to its next const). */
  const fn = (name: string): string => {
    const at = code.indexOf(`\n  const ${name} = `);
    expect(at, name).toBeGreaterThan(-1);
    return code.slice(at, code.indexOf("\n  const ", at + 1));
  };

  it("shows the saved locations when it attaches to a run (step 1 may hold unsaved input)", () => {
    const attach = fn("attach");
    expect(attach).toContain("const saved = useStore.getState().config;");
    expect(attach).toMatch(/setDataRoot\(saved\.dataRoot\);\s*setOutputDir\(saved\.outputDir\);[\s\S]*go\(3\);/);
  });

  it("marks the setup done at the saved locations (where the run installed), not at step 1's fields", () => {
    expect(fn("finish").match(/saveConfig\(\{[^}]*\}\)/)?.[0]).toBe("saveConfig({ ...config, licenseAccepted: true, setupCompleted: true, precision })");
  });

  it("does not move on from a step an attached run has moved the page off", () => {
    expect(fn("go")).toContain("moves.current++;");
    expect(fn("saveLocations")).toMatch(/const at = moves\.current;[\s\S]*await saveConfig[\s\S]*if \(moves\.current === at\) go\(2\);/);
    expect(fn("acceptLicense")).toMatch(/const at = moves\.current;\s*await saveConfig[\s\S]*if \(moves\.current === at\) go\(3\);/);
    expect(fn("skipIfInstalled")).toMatch(/const at = moves\.current;\s*const cs = await api\.setupStatus\(\);\s*if \(moves\.current !== at\) return;/);
  });

  it("shows a run that refuses setup_finalize (開始, アプリに戻る) instead of its refusal as an error", () => {
    const follow = fn("finalizeOrFollow");
    expect(follow).toMatch(/follower\.started\(\);\s*try \{\s*await api\.setupFinalize\(\);\s*follower\.ended\(\);\s*return true;/);
    expect(follow).toMatch(/if \(!isSetupStillRunning\(e\)\) \{\s*follower\.ended\(\);\s*throw e;\s*\}\s*const end = follower\.refused\(\);\s*if \(end\) await settle\(end\.error\);\s*else attach\(\);\s*return false;/);
    expect(fn("finish")).toMatch(/if \(!\(await finalizeOrFollow\(\)\)\) return;/);
    expect(fn("returnToApp")).toMatch(/if \(!\(await finalizeOrFollow\(\)\)\) return;/);
    expect(fn("finish")).not.toContain("api.setupFinalize");
    expect(fn("returnToApp")).not.toContain("api.setupFinalize");
  });

  it("keeps what the refusing run reported before the start (an item that failed)", () => {
    const start = fn("start");
    expect(start).toMatch(/const earlier = progressRef\.current;\s*progressRef\.current = \{\};/);
    expect(start).toMatch(/isSetupAlreadyRunning\(e\)\) \{[\s\S]*progressRef\.current = \{ \.\.\.earlier, \.\.\.progressRef\.current \};[\s\S]*follower\.refused\(\)/);
  });
});

describe("SetupWizard finish step", () => {
  const code = readFileSync(WIZARD, "utf8");
  const step4 = code.slice(code.indexOf("{step === 4 && ("));

  it("is not a dead end when 開始 fails (戻る, アプリに戻る)", () => {
    expect(step4).toMatch(/onClick=\{\(\) => go\(3\)\}>\s*戻る\s*</);
    expect(step4).toContain("{returnButton}");
  });
});

describe("a data root this account cannot use", () => {
  const denied = "データルート C:\\MCSYuE2 にこのアカウントではアクセスできません。…";
  const code = readFileSync(WIZARD, "utf8");
  const step = (n: number) => code.slice(code.indexOf(`{step === ${n} && (`), code.indexOf(`{step === ${n + 1} && (`));
  // the body of the wizard's arrow function `name`
  const fn = (name: string) => {
    const at = code.indexOf(`\n  const ${name} = () => {`);
    return at < 0 ? "" : code.slice(at, code.indexOf("\n  };", at));
  };

  it("has no known free space where Windows tells none (a data root it cannot read), instead of 0 GB and the 40GB hint", () => {
    expect(freeSpaceLabel({ freeDiskGib: null, dataRootError: denied })).toEqual({ text: "不明（データルートにアクセスできません）", hint: null });
    expect(freeSpaceLabel({ freeDiskGib: null, dataRootError: null })).toEqual({ text: "不明", hint: null });
    expect(freeSpaceLabel({ freeDiskGib: 0, dataRootError: null })).toEqual({ text: "0 GB", hint: "40GB 以上を推奨します（データルートのドライブ。次の手順で変更できます）" });
    expect(freeSpaceLabel({ freeDiskGib: 120.4, dataRootError: null })).toEqual({ text: "120 GB", hint: null });
    expect(knownFreeBytes({ freeDiskGib: null })).toBeNull();
    expect(knownFreeBytes({ freeDiskGib: 2 })).toBe(2 * 1024 ** 3);
    expect(knownFreeBytes(null)).toBeNull();
    expect(code).toContain("const freeBytes = knownFreeBytes(check);");
  });

  it("a data root that can be read but not written (a read-only share, コントロールされたフォルダー アクセス) has its free space known", () => {
    expect(freeSpaceLabel({ freeDiskGib: 120.4, dataRootError: denied })).toEqual({ text: "120 GB", hint: null });
    expect(freeSpaceLabel({ freeDiskGib: 12, dataRootError: denied }).hint).toMatch(/^40GB 以上を推奨します/);
  });

  it("is explained at 環境チェック and at the download step, in words true whether or not what is installed can be read", () => {
    expect(code).toContain("const free = check ? freeSpaceLabel(check) : null;");
    expect(step(0)).toMatch(/\{free\?\.text\} \{free\?\.hint && <span className="hint">\{free\.hint\}<\/span>\}/);
    expect(step(0)).toMatch(/<div className="selectable"[^>]*>\{check\.dataRootError\}<\/div>/);
    expect(code).toContain("const rootDenied = check?.dataRootError ?? null;");
    // the message as it is (it names the data root): no 「導入状況を確認できません」 above 導入済み badges
    expect(step(3)).toMatch(/\{rootDenied && !running && !error && <div className="selectable"[^>]*>\{rootDenied\}<\/div>\}/);
    expect(code).not.toContain("導入状況を確認できません");
    // a run's end checks again (the permissions may have been fixed meanwhile, or the run failed on them)
    const settle = code.slice(code.indexOf("\n  const settle = "), code.indexOf("\n  const attach = "));
    expect(settle).toMatch(/const settle = async \(failure: string \| null\) => \{\s*(\/\/[^\n]*\s*)*recheckDataRoot\(\);/);
    // and so does coming (back) to the download step, as its list of components is read again
    const effect = code.slice(code.indexOf("if (step !== 3) return;"), code.indexOf("}, [step]);"));
    expect(effect).toMatch(/if \(step !== 3\) return;\s*(\/\/[^\n]*\s*)*recheckDataRoot\(\);\s*api\s*\.setupStatus\(\)/);
  });

  it("is checked again without touching what 環境チェック found for the GPU (nvidia-smi may time out on any call)", () => {
    const gpu = { gpuName: "NVIDIA GeForce RTX 5060 Ti", driverVersion: "581.15", vramMib: 16311, driverOk: true, gpuProbeTimedOut: false };
    const before: SystemCheck = { ...gpu, freeDiskGib: null, dataRootExists: true, dataRootError: denied };
    const fixed: DataRootCheck = { freeDiskGib: 812.3, dataRootExists: true, dataRootError: null };
    // the permissions fixed: the data root's lines follow, the 16 GB GPU stays (完了 still chooses INT8)
    expect(withDataRootCheck(before, fixed)).toEqual({ ...gpu, freeDiskGib: 812.3, dataRootExists: true, dataRootError: null });
    // every check made for the data root goes through it: after 保存場所, on entering the download step, at a run's end
    expect(code.match(/recheckDataRoot\(\);/g)).toHaveLength(3);
    const saveLocations = code.slice(code.indexOf("\n  const saveLocations = "), code.indexOf("\n  const acceptLicense = "));
    expect(saveLocations).toContain("recheckDataRoot();");
  });

  // A hung driver (after a TDR) keeps nvidia-smi waiting until it is killed: the old line would stay up to half a
  // minute after the permissions were fixed, and every check would leave another nvidia-smi stuck in the driver.
  it("is checked again without nvidia-smi: only 環境チェック (at the start and 再確認) runs it", () => {
    const recheck = fn("recheckDataRoot");
    expect(recheck).toMatch(/api\s*\.dataRootCheck\(\)/);
    expect(recheck).not.toContain("systemCheck");
    // no check yet (it failed, or has not answered): 環境チェック's own brings the data root's lines
    expect(recheck).toMatch(/setCheck\(\(prev\) => prev && withDataRootCheck\(prev, r\)\)/);
    expect(code.match(/api\s*\.systemCheck\(\)/g)).toHaveLength(1);
    expect(fn("checkSystem")).toMatch(/api\s*\.systemCheck\(\)/);
    expect(code.match(/checkSystem\(\);/g)).toHaveLength(1);
    expect(code.slice(code.indexOf("useEffect(() => {\n    clearSetupPrefill();"))).toMatch(/^useEffect\(\(\) => \{\s*clearSetupPrefill\(\);\s*checkSystem\(\);/);
    expect(step(0)).toContain("onClick={checkSystem}");
    // the command returns exactly the data root's fields of the system check
    const rust = /pub struct DataRootCheck \{([\s\S]*?)\n\}/.exec(readFileSync(SETUP_RS, "utf8"))?.[1] ?? "";
    const fields = [...rust.matchAll(/pub (\w+):/g)].map((m) => m[1].replace(/_(\w)/g, (_, c: string) => c.toUpperCase()));
    expect(fields.sort()).toEqual(["dataRootError", "dataRootExists", "freeDiskGib"]);
    expect(readFileSync(API_TS, "utf8")).toContain('export type DataRootCheck = Pick<SystemCheck, "freeDiskGib" | "dataRootExists" | "dataRootError">;');
  });

  // 再確認 may still wait for nvidia-smi when 保存場所 has checked another data root: its answer, about the data root
  // of before, must not replace the newer one's lines.
  // A 再確認 pressed while the first 環境チェック waits for a hung nvidia-smi answers first with the real GPU; the first
  // one answers when its nvidia-smi is killed, with no GPU. Its empty fields must not replace the newer ones: 完了
  // would keep BF16 on a 16 GB GPU instead of choosing INT8.
  it("keeps the GPU of the 環境チェック started last when an earlier one answers after it", () => {
    const gpu = { gpuName: "NVIDIA GeForce RTX 5060 Ti", driverVersion: "581.15", vramMib: 16311, driverOk: true, gpuProbeTimedOut: false };
    const root = { freeDiskGib: 812.3, dataRootExists: true, dataRootError: null };
    const shown: SystemCheck = { ...gpu, ...root };
    const timedOut: SystemCheck = { gpuName: null, driverVersion: null, vramMib: null, driverOk: false, gpuProbeTimedOut: true, ...root };
    // the earlier check, overtaken by the 再確認 that is shown: nothing of it replaces what is shown
    expect(mergeSystemCheck(shown, timedOut, { latest: false, gpuNewer: false, gpuFound: false })).toEqual(shown);
    // a newer 環境チェック replaces the GPU's lines; the data root's only when no data root check started after it
    expect(mergeSystemCheck(timedOut, shown, { latest: true, gpuNewer: true, gpuFound: true })).toEqual(shown);
    const otherRoot: SystemCheck = { ...shown, freeDiskGib: 5, dataRootExists: false };
    expect(mergeSystemCheck(otherRoot, { ...shown, gpuName: "X" }, { latest: false, gpuNewer: true, gpuFound: true })).toEqual({ ...shown, gpuName: "X", freeDiskGib: 5, dataRootExists: false });
    // the first answer is shown as it is
    expect(mergeSystemCheck(null, timedOut, { latest: false, gpuNewer: true, gpuFound: false })).toEqual(timedOut);
    // the other order: a 再確認 that started later but found no GPU (nvidia-smi hung, or ended with an error) does not
    // take away the GPU and VRAM an earlier check found (they do not change while the app runs; 完了 still chooses
    // INT8); its driver lines are shown as it found them (unknown, not the earlier version or its update hint)
    const kept = { gpuName: shown.gpuName, vramMib: shown.vramMib };
    expect(mergeSystemCheck(shown, { ...timedOut, freeDiskGib: 5 }, { latest: true, gpuNewer: true, gpuFound: false })).toEqual({ ...timedOut, ...kept, freeDiskGib: 5 });
    const noGpu: SystemCheck = { ...timedOut, gpuProbeTimedOut: false };
    expect(mergeSystemCheck(shown, noGpu, { latest: true, gpuNewer: true, gpuFound: false })).toEqual({ ...noGpu, ...kept });
    // a newer answer that found a GPU replaces all of its lines
    const other: SystemCheck = { ...shown, gpuName: "NVIDIA GeForce RTX 5090", vramMib: 32607, driverVersion: "590.10" };
    expect(mergeSystemCheck(shown, other, { latest: true, gpuNewer: true, gpuFound: true })).toEqual(other);
    // the GPU line says that 再確認 got no answer, or no GPU information; the driver line is unknown, without the hint
    const label = gpuLabel(mergeSystemCheck(shown, timedOut, { latest: true, gpuNewer: true, gpuFound: false }));
    expect(label).toContain(shown.gpuName!);
    expect(label).toContain("nvidia-smi が応答しませんでした");
    const failed = mergeSystemCheck(shown, noGpu, { latest: true, gpuNewer: true, gpuFound: false });
    expect(gpuLabel(failed)).toContain("nvidia-smi から GPU 情報を取得できませんでした");
    expect(driverLabel(failed).hint).toBeNull();
    expect(driverLabel(mergeSystemCheck(shown, timedOut, { latest: true, gpuNewer: true, gpuFound: false })).text).toBe("不明（nvidia-smi が応答しません）");
    expect(gpuLabel(shown)).toBe(shown.gpuName);
    // the other order of answers: the 再確認 that found none answered first, then the check before it with the GPU.
    // Its GPU and VRAM are taken (they do not change while the app runs: 完了 chooses INT8), the newer driver lines stay
    for (const newer of [noGpu, timedOut]) {
      const merged = mergeSystemCheck(newer, shown, { latest: false, gpuNewer: false, gpuFound: true });
      expect(merged).toEqual({ ...newer, ...kept });
      expect(gpuLabel(merged)).toContain(newer.gpuProbeTimedOut ? "nvidia-smi が応答しませんでした" : "nvidia-smi から GPU 情報を取得できませんでした");
      expect(driverLabel(merged).hint).toBeNull();
    }
    // an older answer without a GPU changes nothing
    expect(mergeSystemCheck(shown, noGpu, { latest: false, gpuNewer: false, gpuFound: false })).toEqual(shown);
  });

  // Three 環境チェック, the last one started finding no GPU, the two before it different GPUs (one swapped while the
  // wizard is open): whatever the order of the answers, the GPU and VRAM shown are those of the last check started
  // that found a GPU, and the driver lines those of the last one started that answered.
  it("shows the GPU of the last 環境チェック started that found one, in any order of answers", () => {
    const root = { freeDiskGib: 812.3, dataRootExists: true, dataRootError: null };
    const a: SystemCheck = { gpuName: "NVIDIA GeForce RTX 5060 Ti", driverVersion: "581.15", vramMib: 16311, driverOk: true, gpuProbeTimedOut: false, ...root };
    const b: SystemCheck = { gpuName: "NVIDIA GeForce RTX 5090", driverVersion: "590.10", vramMib: 32607, driverOk: true, gpuProbeTimedOut: false, ...root };
    const none: SystemCheck = { gpuName: null, driverVersion: null, vramMib: null, driverOk: false, gpuProbeTimedOut: false, ...root };
    const answers = [a, b, none];
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      // checkSystem's bookkeeping (gpuAt, gpuFoundAt) for checks started as 1, 2, 3
      let shown: SystemCheck | null = null;
      let gpuAt = 0;
      let gpuFoundAt = 0;
      for (const i of order) {
        const at = i + 1;
        const c = answers[i];
        const gpuNewer = at > gpuAt;
        if (gpuNewer) gpuAt = at;
        const gpuFound = c.gpuName !== null && at > gpuFoundAt;
        if (gpuFound) gpuFoundAt = at;
        shown = mergeSystemCheck(shown, c, { latest: at === 3, gpuNewer, gpuFound });
      }
      expect({ gpuName: shown!.gpuName, vramMib: shown!.vramMib, driverVersion: shown!.driverVersion }, String(order)).toEqual({ gpuName: b.gpuName, vramMib: b.vramMib, driverVersion: null });
    }
    // the page orders the GPU's lines by the 環境チェック that started them, and takes the GPU and VRAM of the last one
    // started that found a GPU
    const check = fn("checkSystem");
    expect(check).toMatch(/const gpuNewer = at > gpuAt\.current;\s*if \(gpuNewer\) gpuAt\.current = at;/);
    expect(check).toMatch(/const gpuFound = c\.gpuName !== null && at > gpuFoundAt\.current;\s*if \(gpuFound\) gpuFoundAt\.current = at;/);
    expect(check).toMatch(/setCheck\(\(prev\) => mergeSystemCheck\(prev, c, \{ latest, gpuNewer, gpuFound \}\)\);/);
    // a check that fails clears what is shown only when it is the last one started
    expect(check).toMatch(/\.catch\(\(\) => \{\s*if \(checks\.current === at\) setCheck\(null\);\s*\}\)/);
  });

  it("shows the data root of the check started last", () => {
    for (const name of ["checkSystem", "recheckDataRoot"]) expect(fn(name)).toMatch(/const at = \+\+checks\.current;/);
    // a data root check overtaken by a later check is dropped
    expect(fn("recheckDataRoot")).toMatch(/if \(checks\.current === at\) setCheck\(/);
    // 環境チェック overtaken by a data root check brings its GPU and keeps that check's data root
    expect(fn("checkSystem")).toMatch(/const latest = checks\.current === at;/);
    expect(fn("checkSystem")).toMatch(/setCheck\(\(prev\) => mergeSystemCheck\(prev, c, \{ latest, gpuNewer, gpuFound \}\)\);/);
    // shown: the first check's GPU (timed out) and the data root chosen at 保存場所; 再確認 answers with the GPU and the
    // data root of before
    const gpu = { gpuName: "NVIDIA GeForce RTX 5090", driverVersion: "581.15", vramMib: 32607, driverOk: true, gpuProbeTimedOut: false };
    const shown: SystemCheck = { gpuName: null, driverVersion: null, vramMib: null, driverOk: false, gpuProbeTimedOut: true, freeDiskGib: 812.3, dataRootExists: false, dataRootError: null };
    const answer: SystemCheck = { ...gpu, freeDiskGib: null, dataRootExists: true, dataRootError: denied };
    expect(withDataRootCheck(answer, shown)).toEqual({ ...gpu, freeDiskGib: 812.3, dataRootExists: false, dataRootError: null });
  });

  it("and every setup error can be selected and copied (the icacls command)", () => {
    expect(code).toMatch(/const errorLine = error && <div className="selectable" /);
    expect(readFileSync(STYLES, "utf8")).toMatch(/\.selectable \{ user-select: text; \}/);
  });
});
