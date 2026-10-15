import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, formatBytes, isSetupAlreadyRunning, isSetupCancelled, type ComponentStatus, type DataRootCheck, type SetupProgress, type SystemCheck } from "../api";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import {
  BF16_MIN_VRAM_MIB,
  INT8_MIN_VRAM_MIB,
  autoPrecision,
  cleanLocation,
  dataRootWarning,
  defaultSetupSelection,
  isCancelledPhase,
  locationError,
  outputDirWarning,
  requiredInstalled,
  wizardMayChoosePrecision,
} from "../config/rules";
import { clearSetupPrefill, peekSetupPrefill } from "../config/setupPrefill";
import { singleClick } from "../compose/submitPlan";

type Step = 0 | 1 | 2 | 3 | 4;
const STEPS = ["環境チェック", "保存場所", "ライセンス", "ダウンロード", "完了"];

const OPTIONAL_DEFAULT_ON = new Set(["yue2_int8", "llama_server", "llama_cudart", "qwen3_14b"]);

/** Progress phases of a component still being worked on (a run's last events are done / error / cancelled). */
const WORKING_PHASES: ReadonlySet<string> = new Set(["download", "verify", "extract"]);

/** Start of the error setup_finalize is refused with while a setup run goes on (lib.rs SETUP_STILL_RUNNING). */
export const SETUP_STILL_RUNNING = "セットアップ（ダウンロード・展開）がまだ実行中です";

/** setup_finalize was refused because a setup run goes on (one the page may not have seen, see finalizeOrFollow). */
export function isSetupStillRunning(e: unknown): boolean {
  return String(e).trim().startsWith(SETUP_STILL_RUNNING);
}

/**
 * The setup_install run the wizard follows, and what each event means for it. "own": the run start() sent; its call
 * settles it. "attached": a run the page did not start: the page was reloaded while it ran (the backend keeps
 * running it, the call went with the old page), so only setup://finished tells its end.
 */
export class SetupRunFollower {
  // "ending": the attached run's end is being shown (a repeated setup://finished does not show it again)
  private run: "none" | "own" | "attached" | "ending" = "none";
  private heard = 0;
  private heardAtStart = 0;
  private lastError: string | null = null;

  /**
   * start() sends setup_install, or 開始 / アプリに戻る send setup_finalize (refused while a run goes on: refused();
   * ended() once it was not).
   */
  started(): void {
    this.run = "own";
    this.heardAtStart = this.heard;
  }

  /** A setup://progress event; true when it shows a run the wizard does not follow yet, which it now follows. */
  progress(p: SetupProgress): boolean {
    if (this.run !== "none" || !WORKING_PHASES.has(p.phase)) return false;
    this.run = "attached";
    return true;
  }

  /**
   * setup_install or setup_finalize was refused because a run goes on: that one is followed now. Returns its end
   * when it came meanwhile (the run ended between the refusal and its arrival), else null: setup://finished will
   * tell it.
   */
  refused(): { error: string | null } | null {
    if (this.heard !== this.heardAtStart) return { error: this.lastError };
    this.run = "attached";
    return null;
  }

  /** A setup://finished event; returns the end to show when it ends the attached run. */
  finished(error: string | null): { error: string | null } | null {
    this.heard++;
    this.lastError = error;
    if (this.run !== "attached") return null;
    this.run = "ending";
    return { error };
  }

  /** The followed run's end is shown. */
  ended(): void {
    this.run = "none";
  }
}

/**
 * What a failed setup run shows. The hint to uncheck the failed items comes only when one of them is still missing
 * and reported an error in this run: no unchecking gets past a full disk or an unusable data root.
 */
export function setupFailureText(failure: string, comps: ComponentStatus[], progress: Record<string, SetupProgress>): string {
  const itemFailed = comps.some((c) => !c.installed && progress[c.id]?.phase === "error");
  return requiredInstalled(comps) && itemFailed ? `${failure}\n必須コンポーネントは導入済みです。失敗した項目のチェックを外すと次へ進めます。` : failure;
}

/**
 * A GPU an earlier check found, kept by a 再確認 that found none (mergeSystemCheck): an answer of nvidia-smi always has
 * the GPU's driver version with its name (setup.rs system_check_with).
 */
const keptGpu = (check: Pick<SystemCheck, "gpuName" | "driverVersion">) => check.gpuName != null && check.driverVersion === null;

/** The environment check's GPU line: a hung nvidia-smi (killed after its timeout) is not a missing GPU. */
export function gpuLabel(check: Pick<SystemCheck, "gpuName" | "driverVersion" | "gpuProbeTimedOut">): string {
  // the 再確認 got no answer of nvidia-smi (it hung), or one without a GPU (it ended with an error, or is gone)
  if (keptGpu(check))
    return `${check.gpuName}（再確認では nvidia-smi ${check.gpuProbeTimedOut ? "が応答しませんでした" : "から GPU 情報を取得できませんでした"}。ドライバの再起動または PC の再起動を試してから「再確認」を押してください）`;
  if (check.gpuName != null) return check.gpuName;
  return check.gpuProbeTimedOut
    ? "GPU 情報を取得できませんでした（nvidia-smi が応答しません。ドライバの再起動または PC の再起動を試してから「再確認」を押してください）"
    : "NVIDIA GPU が見つかりません（nvidia-smi 不在）";
}

/**
 * The environment check's driver line: the version, OK or the update hint. A hung nvidia-smi tells no version, nor a
 * 再確認 that kept the GPU found before: it is unknown, not too old (the GPU line says what to do).
 */
export function driverLabel(check: Pick<SystemCheck, "gpuName" | "driverVersion" | "driverOk" | "gpuProbeTimedOut">): { text: string; ok: boolean; hint: string | null } {
  if (check.driverOk) return { text: check.driverVersion ?? "-", ok: true, hint: null };
  if (check.gpuProbeTimedOut) return { text: "不明（nvidia-smi が応答しません）", ok: false, hint: null };
  if (keptGpu(check)) return { text: "不明（nvidia-smi が GPU 情報を返しませんでした）", ok: false, hint: null };
  return { text: check.driverVersion ?? "-", ok: false, hint: "580.88 以上が必要です（CUDA 13.0）。NVIDIA ドライバを更新してください。" };
}

/**
 * The environment check's free-space line. Windows tells no free space for a data root this account cannot read: it
 * is unknown then, not 0 GB (the data root line says why). One it can read but not write has its free space known.
 */
export function freeSpaceLabel(check: Pick<SystemCheck, "freeDiskGib" | "dataRootError">): { text: string; hint: string | null } {
  if (check.freeDiskGib === null) return { text: check.dataRootError ? "不明（データルートにアクセスできません）" : "不明", hint: null };
  return { text: `${check.freeDiskGib.toFixed(0)} GB`, hint: check.freeDiskGib < 40 ? "40GB 以上を推奨します（データルートのドライブ。次の手順で変更できます）" : null };
}

/**
 * `check` with the data root's fields of `root`: a check made again for the data root alone (after 保存場所, on
 * entering the download step, when a run ends; no nvidia-smi) replaces only those. The GPU's stay as 環境チェック
 * showed them: nvidia-smi may time out on any call, and its empty fields would keep BF16 on a 16 GB GPU at 完了
 * instead of choosing INT8. The other way round for 環境チェック's answer when a data root check started after it.
 */
export function withDataRootCheck(check: SystemCheck, root: DataRootCheck): SystemCheck {
  return { ...check, freeDiskGib: root.freeDiskGib, dataRootExists: root.dataRootExists, dataRootError: root.dataRootError };
}

/**
 * 環境チェック's answer `c` merged into what is shown (`prev`): its data root's lines only when it is the check started
 * last (`latest`; a data root check started after it is newer), its GPU's only when no 環境チェック started after it
 * has answered (`gpuNewer`): a 再確認 that waited for a hung nvidia-smi until it was killed must not replace the GPU a
 * later 再確認 found (its empty fields would keep BF16 on a 16 GB GPU at 完了). The GPU and VRAM shown are those of the
 * last 環境チェック started that found a GPU (`gpuFound`: `c` is it): one that found none (nvidia-smi hung or ended with
 * an error) keeps the GPU an earlier one found, whatever the order of the answers, and shows its own driver lines
 * (unknown, not the earlier version or its update hint).
 */
export function mergeSystemCheck(prev: SystemCheck | null, c: SystemCheck, o: { latest: boolean; gpuNewer: boolean; gpuFound: boolean }): SystemCheck {
  if (!prev) return c;
  const lines = o.gpuNewer ? c : prev;
  const found = o.gpuFound ? c : prev;
  const gpu = found.gpuName !== null ? { ...lines, gpuName: found.gpuName, vramMib: found.vramMib } : lines;
  return withDataRootCheck(gpu, o.latest ? c : prev);
}

/** Free bytes on the data root's drive, null when unknown (no check yet, or Windows tells none). */
export function knownFreeBytes(check: Pick<SystemCheck, "freeDiskGib"> | null): number | null {
  return check && check.freeDiskGib !== null ? check.freeDiskGib * 1024 ** 3 : null;
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

export default function SetupWizard() {
  const { config, saveConfig, showToast } = useStore(useShallow((s) => ({ config: s.config, saveConfig: s.saveConfig, showToast: s.showToast })));
  const [step, setStep] = useState<Step>(0);
  const [check, setCheck] = useState<SystemCheck | null>(null);
  // Locations typed in Settings before 「セットアップをやり直す」: step 1 starts with them, config.json keeps
  // the working install's until 「次へ」 there.
  const [prefill] = useState(() => peekSetupPrefill());
  const [dataRoot, setDataRoot] = useState(prefill?.dataRoot ?? config?.dataRoot ?? "C:\\MCSYuE2");
  const [outputDir, setOutputDir] = useState(prefill?.outputDir ?? config?.outputDir ?? "");
  const [agree, setAgree] = useState(false);
  const [comps, setComps] = useState<ComponentStatus[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, SetupProgress>>({});
  // the same, for code after an await (the failure text reads the phases the run reported)
  const progressRef = useRef<Record<string, SetupProgress>>({});
  const [running, setRunning] = useState(false);
  // The setup_install run shown: start()'s own, or one the wizard attached to after a reload of the page.
  const [follower] = useState(() => new SetupRunFollower());
  // Saving a step, finishing or returning to the app (one request at a time).
  const [busy, setBusy] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Neutral outcome (a cancelled download), shown instead of an error.
  const [notice, setNotice] = useState<string | null>(null);
  // Captured at mount: acceptLicense() sets the flag during the wizard. A precision the user chose in Settings
  // is kept on a re-run (only a missing checkpoint switches it); a first setup resumed after a restart still
  // gets the automatic choice.
  const [firstSetup] = useState(() => wizardMayChoosePrecision(config));
  // The locations the wizard started with (restored by 「アプリに戻る」 after a changed step 1).
  const [initial] = useState(() => (config ? { dataRoot: config.dataRoot, outputDir: config.outputDir, licenseAccepted: config.licenseAccepted } : null));
  // A re-run (from Settings, or after an interrupted re-run): license accepted and every required component
  // installed when the wizard opened. Such a run can go back to the app without walking through all steps.
  const [canReturn, setCanReturn] = useState(false);

  // Checks started, 環境チェック's and the data root's alone: the data root's lines come from the one started last
  // (再確認 may still wait for nvidia-smi when 保存場所 has checked another data root).
  const checks = useRef(0);
  /** The 環境チェック whose GPU lines are shown: one that answers after a later one keeps them (mergeSystemCheck). */
  const gpuAt = useRef(0);
  /** The 環境チェック whose GPU and VRAM are shown: the last one started that found a GPU (mergeSystemCheck). */
  const gpuFoundAt = useRef(0);
  /** 環境チェック (at the start and 再確認): the GPU via nvidia-smi, and the data root. */
  const checkSystem = () => {
    const at = ++checks.current;
    api
      .systemCheck()
      .then((c) => {
        const latest = checks.current === at;
        const gpuNewer = at > gpuAt.current;
        if (gpuNewer) gpuAt.current = at;
        const gpuFound = c.gpuName !== null && at > gpuFoundAt.current;
        if (gpuFound) gpuFoundAt.current = at;
        setCheck((prev) => mergeSystemCheck(prev, c, { latest, gpuNewer, gpuFound }));
      })
      .catch(() => {
        if (checks.current === at) setCheck(null);
      });
  };

  useEffect(() => {
    clearSetupPrefill();
    checkSystem();
    if (initial?.licenseAccepted) api.setupStatus().then((cs) => setCanReturn(requiredInstalled(cs))).catch(() => {});
  }, []);

  // The setup events reach the wizard on every step: a run the page did not start (it was reloaded while the run
  // went on) is shown from its next progress event on. The refs hold the handlers of the latest render.
  const onSetupProgress = useRef<(p: SetupProgress) => void>(() => {});
  const onSetupFinished = useRef<(error: string | null) => void>(() => {});
  useEffect(() => {
    const un = [api.onSetupProgress((p) => onSetupProgress.current(p)), api.onSetupFinished((f) => onSetupFinished.current(f.error))];
    return () => {
      for (const u of un) u.then((f) => f());
    };
  }, []);

  // The data root's lines of the check, made again without nvidia-smi (withDataRootCheck). Before 環境チェック has
  // answered there is nothing to add them to: its own answer brings them.
  const recheckDataRoot = () => {
    const at = ++checks.current;
    api
      .dataRootCheck()
      .then((r) => {
        if (checks.current === at) setCheck((prev) => prev && withDataRootCheck(prev, r));
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (step !== 3) return;
    // The data root's access may have changed since the check (fixed with the command its message gives): the
    // download step says whether the setup can use it.
    recheckDataRoot();
    api
      .setupStatus()
      .then((cs) => {
        setComps(cs);
        setSelected(defaultSetupSelection(cs, OPTIONAL_DEFAULT_ON));
      })
      .catch((e) => setError(String(e)));
  }, [step]);

  // Counts the page's moves: a step action moves on after its await only when nothing moved the page meanwhile (a
  // setup run the page attached to has shown step 3).
  const moves = useRef(0);
  const go = (s: Step) => {
    moves.current++;
    setError(null);
    setNotice(null);
    setStep(s);
  };

  const rootError = locationError(dataRoot, "data");
  const outError = locationError(outputDir, "out");
  const rootWarning = rootError ? null : dataRootWarning(dataRoot);
  // as 設定 shows it: a folder of the data root the app manages is checked against step 1's data root
  const outWarning = outError ? null : outputDirWarning(outputDir, rootError ? "" : dataRoot);
  const driver = check ? driverLabel(check) : null;
  const free = check ? freeSpaceLabel(check) : null;
  // The saved data root exists but this account cannot use it (ダウンロード開始 would fail with this message; it
  // names the data root and the ways out).
  const rootDenied = check?.dataRootError ?? null;
  const totalSelectedBytes = useMemo(() => comps.filter((c) => selected.has(c.id)).reduce((a, c) => a + c.size, 0), [comps, selected]);
  const freeBytes = knownFreeBytes(check);
  const requiredDone = requiredInstalled(comps);

  const plannedPrecision = config ? autoPrecision(check?.vramMib, comps, config.precision, firstSetup) : null;

  const pickDir = async (which: "data" | "out") => {
    const dir = await open({ directory: true, multiple: false, title: which === "data" ? "データルートを選択" : "楽曲の保存先を選択" });
    if (typeof dir === "string") (which === "data" ? setDataRoot : setOutputDir)(cleanLocation(dir));
  };

  /** Run one step action; its error stays on the step (a toast is not shown while the wizard is open). */
  const act = async (f: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveLocations = () =>
    act(async () => {
      if (!config) return;
      const at = moves.current;
      const d = cleanLocation(dataRoot);
      const o = cleanLocation(outputDir);
      setDataRoot(d);
      setOutputDir(o);
      await saveConfig({ ...config, dataRoot: d, outputDir: o });
      // Free space of the drive the chosen data root is on.
      recheckDataRoot();
      if (moves.current === at) go(2);
    });

  const acceptLicense = () =>
    act(async () => {
      if (!config) return;
      const at = moves.current;
      await saveConfig({ ...config, dataRoot, outputDir, licenseAccepted: true });
      if (moves.current === at) go(3);
    });

  const skipIfInstalled = () =>
    act(async () => {
      // Everything required already present (e.g. reinstall): go straight to finish.
      const at = moves.current;
      const cs = await api.setupStatus();
      if (moves.current !== at) return;
      if (requiredInstalled(cs)) {
        setComps(cs);
        go(4);
      } else {
        go(3);
      }
    });

  const refreshComps = async () => {
    const cs = await api.setupStatus();
    setComps(cs);
    // Installed ones cannot be selected; keep the rest of the user's choice for a retry.
    setSelected((prev) => new Set([...prev].filter((id) => !cs.find((c) => c.id === id)?.installed)));
    return cs;
  };

  /** The end of the run shown (start()'s own or an attached one): `failure` is what it failed with, null on success. */
  const settle = async (failure: string | null) => {
    // The data root's access may have changed (fixed meanwhile, or the run failed on it): the download step shows it.
    recheckDataRoot();
    setNotice(null);
    try {
      if (failure === null) {
        const cs = await refreshComps();
        const missingRequired = cs.filter((c) => c.required && !c.installed);
        if (missingRequired.length) {
          setError(`必須コンポーネントが未導入です: ${missingRequired.map((c) => c.name).join(", ")}`);
        } else {
          go(4);
        }
      } else {
        const cs = await refreshComps().catch(() => comps);
        if (cancelRef.current || isSetupCancelled(failure)) {
          setNotice("中断しました。もう一度「ダウンロード開始」を押すと、ダウンロード済みの分から再開します。");
        } else {
          setError(setupFailureText(failure, cs, progressRef.current));
        }
      }
    } catch (e) {
      // the component status could not be read after the run
      setError(String(e));
    } finally {
      follower.ended();
      setRunning(false);
      setCancelRequested(false);
    }
  };

  /** Show a run the page did not start (it goes on after a reload): step 3 with 中断, until setup://finished. */
  const attach = () => {
    // The run installs into the saved locations (save_config refuses to move them while it runs): step 1's unsaved
    // input goes, or 開始 would mark the setup done at a data root where nothing is installed.
    const saved = useStore.getState().config;
    if (saved) {
      setDataRoot(saved.dataRoot);
      setOutputDir(saved.outputDir);
    }
    setRunning(true);
    go(3);
    setNotice("画面を再読み込みする前に始めたセットアップが続いています。完了するまで、ここに進み具合を表示します（「中断」で止められます）。");
  };

  onSetupProgress.current = (p) => {
    progressRef.current = { ...progressRef.current, [p.id]: p };
    setProgress(progressRef.current);
    if (follower.progress(p)) {
      cancelRef.current = false;
      setCancelRequested(false);
      attach();
    }
  };
  onSetupFinished.current = (error) => {
    const end = follower.finished(error);
    if (end) void settle(end.error);
  };

  const start = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    cancelRef.current = false;
    setCancelRequested(false);
    // this run's bars only (the failure text reads the phases it reports)
    const earlier = progressRef.current;
    progressRef.current = {};
    setProgress({});
    follower.started();
    let failure: string | null = null;
    try {
      await api.setupInstall(Array.from(selected));
    } catch (e) {
      if (isSetupAlreadyRunning(e)) {
        // The page was reloaded while a run went on (the backend keeps it): show that one, or its end when it came
        // meanwhile. What it reported before this start (an item that failed) is its own again.
        progressRef.current = { ...earlier, ...progressRef.current };
        setProgress(progressRef.current);
        const end = follower.refused();
        if (end) await settle(end.error);
        else attach();
        return;
      }
      failure = String(e);
    }
    await settle(failure);
  };

  const cancel = () => {
    cancelRef.current = true;
    setCancelRequested(true);
    api.setupCancel().catch(() => {});
  };

  /**
   * setup_finalize; false when it was refused because a setup run goes on. That run is shown then (step 3 with 中断,
   * until its end): the page may not have seen it, e.g. after a reload during a pip step, which reports only its start.
   */
  const finalizeOrFollow = async (): Promise<boolean> => {
    follower.started();
    try {
      await api.setupFinalize();
      follower.ended();
      return true;
    } catch (e) {
      if (!isSetupStillRunning(e)) {
        follower.ended();
        throw e;
      }
      const end = follower.refused();
      if (end) await settle(end.error);
      else attach();
      return false;
    }
  };

  const finish = () =>
    act(async () => {
      if (!config) return;
      if (!(await finalizeOrFollow())) return;
      const cs = await api.setupStatus().catch(() => comps);
      const precision = autoPrecision(check?.vramMib, cs, config.precision, firstSetup);
      // The saved locations, where setup_install installed (not step 1's fields: they are saved by its 次へ).
      await saveConfig({ ...config, licenseAccepted: true, setupCompleted: true, precision });
      showToast("success", "セットアップが完了しました");
    });

  /**
   * Re-run (or a resumed setup whose required parts are all installed): back to the app without downloading,
   * with the locations the wizard started with and the same precision choice as finish().
   */
  const returnToApp = () =>
    act(async () => {
      if (!config || !initial) return;
      const restored = { ...config, dataRoot: initial.dataRoot, outputDir: initial.outputDir };
      if (config.dataRoot !== initial.dataRoot || config.outputDir !== initial.outputDir) await saveConfig({ ...restored, setupCompleted: false });
      // Idempotent (folders, extra_model_paths.yaml, node pack): whatever this run changed is consistent again.
      if (!(await finalizeOrFollow())) return;
      const cs = await api.setupStatus().catch(() => comps);
      const precision = autoPrecision(check?.vramMib, cs, config.precision, firstSetup);
      await saveConfig({ ...restored, setupCompleted: true, precision });
    });

  const returnButton = canReturn && !running && (
    <button className="btn" disabled={busy} onClick={returnToApp} title="何もダウンロードせずに、セットアップを始める前の状態でアプリに戻ります">
      アプリに戻る
    </button>
  );
  // selectable: an error may hold a command to copy (an inaccessible data root)
  const errorLine = error && <div className="selectable" style={{ color: "var(--danger)", whiteSpace: "pre-wrap" }}>{error}</div>;

  return (
    <div className="page wizard-page">
      <div className="wizard">
        <h1 className="page-title">Music Creator Studio YuE2 初回セットアップ</h1>
        <p className="page-desc">ComfyUI と YuE2 モデルをダウンロードして、ローカル生成環境を構築します。合計で約 20〜30GB のディスク容量が必要です。</p>
        <div className="steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`step ${i === step ? "on" : ""} ${i < step ? "done" : ""}`}>
              {i + 1}. {s}
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="panel stack">
            <h3>環境チェック</h3>
            {!check ? (
              <div className="muted">確認中…</div>
            ) : (
              <div className="kv">
                <div className="k">GPU</div>
                <div>{gpuLabel(check)}</div>
                <div className="k">VRAM</div>
                <div>
                  {check.vramMib
                    ? `${(check.vramMib / 1024).toFixed(1)} GB ${check.vramMib >= BF16_MIN_VRAM_MIB ? "（BF16 フルモデル可）" : check.vramMib >= INT8_MIN_VRAM_MIB ? "（INT8 モデル推奨。音質は BF16 が上の可能性）" : "（不足の可能性）"}`
                    : "-"}
                </div>
                <div className="k">ドライバ</div>
                <div>
                  {driver?.text} {driver?.ok ? <span style={{ color: "var(--success)" }}>OK</span> : driver?.hint && <span className="hint">{driver.hint}</span>}
                </div>
                <div className="k">空き容量</div>
                <div>
                  {free?.text} {free?.hint && <span className="hint">{free.hint}</span>}
                </div>
                {check.dataRootError && (
                  <>
                    <div className="k">データルート</div>
                    <div className="selectable" style={{ color: "var(--danger)", whiteSpace: "pre-wrap" }}>{check.dataRootError}</div>
                  </>
                )}
              </div>
            )}
            <div className="row">
              <button className="btn primary" disabled={!check} onClick={() => go(1)}>
                次へ
              </button>
              <button className="btn" onClick={checkSystem}>
                再確認
              </button>
              {returnButton}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="panel stack">
            <h3>保存場所</h3>
            <label className="field">
              <span className="lbl">データルート（ComfyUI・モデル・ツール。例: C:\MCSYuE2。短いパス（約 80 文字以内）を推奨）</span>
              <div className="row">
                <input type="text" value={dataRoot} onChange={(e) => setDataRoot(e.target.value)} onBlur={() => setDataRoot(cleanLocation(dataRoot))} />
                <button className="btn" onClick={() => pickDir("data")}>
                  参照
                </button>
              </div>
              {rootError && <span style={{ color: "var(--danger)" }}>{rootError}</span>}
              {rootWarning && <span className="hint">{rootWarning}</span>}
            </label>
            <label className="field">
              <span className="lbl">生成した楽曲の保存先</span>
              <div className="row">
                <input type="text" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} onBlur={() => setOutputDir(cleanLocation(outputDir))} />
                <button className="btn" onClick={() => pickDir("out")}>
                  参照
                </button>
              </div>
              {outError && <span style={{ color: "var(--danger)" }}>{outError}</span>}
              {outWarning && <span className="hint">{outWarning}</span>}
            </label>
            <div className="muted">アンインストール時には、これらのフォルダ内のこのアプリが作成したファイルを削除するかどうかを確認します（既定は「いいえ」。ほかのファイルは削除しません）。</div>
            {prefill && config && (prefill.dataRoot !== config.dataRoot || prefill.outputDir !== config.outputDir) && (
              <div className="hint">設定画面で入力した保存場所を表示しています。「次へ」を押すと保存されます。</div>
            )}
            {errorLine}
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => go(0)}>
                戻る
              </button>
              <button className="btn primary" disabled={busy || Boolean(rootError || outError)} onClick={saveLocations}>
                次へ
              </button>
              {returnButton}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="panel stack">
            <h3>ライセンスの確認</h3>
            <div className="license">
              <p>
                <b>YuE2 モデルの重み</b>（YuE2-3B / YuE2-Vae。m-a-p 作成、Comfy-Org 配布）は <b>CC BY-NC 4.0</b> に「個人クリエイター許諾（2026-09-16）」が付加されたライセンスです。個人のクリエイター・ミュージシャンは生成物をロイヤリティなしで公開・収益化できますが、法人としての利用には別途商用ライセンスが必要です（連絡先はモデルカードを参照）。
                この許諾は<b>責任ある利用が条件</b>です。モデルや生成物を違法・有害・欺瞞的な目的（詐欺、嫌がらせ、なりすまし等）に使わないこと、入力・出力と利用に責任を持ち、必要な権利と同意を得ていることが求められます。
                詳細: <ExtLink href="https://github.com/multimodal-art-projection/YuE/blob/main/MODEL_LICENSE">MODEL_LICENSE</ExtLink> ・ <ExtLink href="https://huggingface.co/m-a-p/YuE2-3B">YuE2-3B モデルカード</ExtLink>
              </p>
              <p>
                <b>SheetSage2</b>（m-a-p/SheetSage2。Comfy-Org 経由で配布、カバー / 耳コピ用の必須コンポーネント）はモデルカード上 <b>CC BY-NC 4.0</b> です。YuE2 の MODEL_LICENSE の個人クリエイター許諾が明示的に対象とするのは YuE2-3B / YuE2-Vae の重みのみのため、商用目的で使う前に <ExtLink href="https://huggingface.co/m-a-p/SheetSage2">SheetSage2 のモデルカード</ExtLink>を確認してください。
              </p>
              <p>
                任意コンポーネント: <b>MMS 強制アライメントモデル</b>（Meta MMS_FA、torchaudio 経由。同期歌詞用）は CC BY-NC 4.0、<b>ボーカル分離モデル</b>（BS-Roformer。MelBand-Roformer・Demucs は初回使用時に取得）は配布元（UVR model_repo など）の条件に従います。ボーカル分離のライブラリ <b>audio-separator</b>（onnxruntime・audioread を含む）は MIT で、そのほかの依存ライブラリはそれぞれのライセンスです（Demucs の処理が使う diffq-fixed は CC BY-NC 4.0）。歌詞のローマ字化のライブラリ <b>pykakasi</b> は GPL-3.0、<b>pypinyin</b> は MIT、<b>uroman</b> は MIT 形式のライセンス（利用を公表するときは謝辞の記載が条件）です。
              </p>
              <p>
                <b>ComfyUI</b> は GPL-3.0、<b>ffmpeg</b>（BtbN ビルド）は GPL-3.0、<b>llama.cpp</b> は MIT（GPU 用の CUDA ランタイム DLL は NVIDIA の CUDA Toolkit EULA、同梱の OpenMP ランタイムは Apache-2.0 WITH LLVM-exception）、<b>7-Zip (7zr.exe)</b> は LGPL、<b>Qwen3</b> モデルは Apache-2.0 です。これらは本アプリとは別に、それぞれのライセンスのもとでダウンロードされ、別プロセスとして実行されます。
              </p>
              <p>本アプリ（Music Creator Studio YuE2）本体は Apache-2.0 で公開されています。生成した音楽の権利と責任は利用者に帰属します。</p>
            </div>
            <label className="row">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              上記のライセンス条件を理解し、同意します
            </label>
            {errorLine}
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => go(1)}>
                戻る
              </button>
              <button className="btn primary" disabled={!agree || busy} onClick={acceptLicense}>
                同意して次へ
              </button>
              <button className="btn" disabled={!agree || busy} onClick={skipIfInstalled} title="既に導入済みの環境がある場合">
                導入済みを確認してスキップ
              </button>
              {returnButton}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="panel stack">
            <h3>ダウンロードするコンポーネント</h3>
            <div>
              {comps.map((c) => {
                const p = progress[c.id];
                const pct = p && p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;
                return (
                  <div key={c.id} className="comp">
                    <input
                      type="checkbox"
                      checked={c.installed || selected.has(c.id)}
                      disabled={c.installed || running || c.required}
                      onChange={(e) => {
                        const s = new Set(selected);
                        e.target.checked ? s.add(c.id) : s.delete(c.id);
                        setSelected(s);
                      }}
                    />
                    <div>
                      <div className="name">
                        {c.name} {c.required && <span className="badge">必須</span>} {c.installed && <span className="badge done">導入済み</span>}
                      </div>
                      <div className="desc">{c.description}</div>
                      {p && !c.installed && (
                        <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                          <div className={`progress-bar ${p.phase === "extract" || p.phase === "verify" ? "indeterminate" : ""}`}>
                            <div style={{ width: `${p.phase === "done" ? 100 : pct}%` }} />
                          </div>
                          <div className="muted">
                            {p.phase === "download" && `${formatBytes(p.downloaded)} / ${p.total ? formatBytes(p.total) : "?"} ${p.bytesPerSec > 0 ? `(${formatBytes(p.bytesPerSec)}/s)` : ""}`}
                            {p.phase === "verify" && "SHA256 を検証中…"}
                            {p.phase === "extract" && p.message}
                            {p.phase === "done" && "完了"}
                            {isCancelledPhase(p.phase) && p.message}
                            {p.phase === "error" && <span style={{ color: "var(--danger)" }}>{p.message}</span>}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="muted" style={{ textAlign: "right" }}>
                      {c.size ? formatBytes(c.size) : ""}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="muted">
              選択中の合計: 約 {formatBytes(totalSelectedBytes)}（サイズ不明のものを除く）
              {freeBytes !== null && `。データルートのドライブの空き: 約 ${formatBytes(freeBytes)}`}。ダウンロードは中断しても再開できます。
            </div>
            {freeBytes !== null && freeBytes > 0 && totalSelectedBytes > freeBytes && (
              <div className="hint">空き容量が足りない可能性があります（展開にはさらに容量が必要です）。項目を減らすか、空きを増やしてください。</div>
            )}
            {notice && <div className="muted">{notice}</div>}
            {/* before ダウンロード開始 fails on it (where the data root cannot be read, every component also looks not
                installed; one that can be read shows what is installed). A failed run shows the same message as its error. */}
            {rootDenied && !running && !error && <div className="selectable" style={{ color: "var(--danger)", whiteSpace: "pre-wrap" }}>{rootDenied}</div>}
            {errorLine}
            <div className="row">
              <button className="btn" disabled={running} onClick={() => go(2)}>
                戻る
              </button>
              {/* 中断 replaces ダウンロード開始 under the cursor at the first click: both ignore a double click's second */}
              {running ? (
                <button className="btn danger" disabled={cancelRequested} onClick={singleClick(cancel)}>
                  {cancelRequested ? "中断しています…" : "中断"}
                </button>
              ) : selected.size > 0 ? (
                <button className="btn primary" onClick={singleClick(() => void start())}>
                  ダウンロード開始
                </button>
              ) : (
                <button className="btn primary" onClick={() => go(4)} disabled={comps.length === 0 || !requiredDone}>
                  次へ
                </button>
              )}
              {returnButton}
            </div>
            {cancelRequested && <div className="muted">pip でのインストールの途中は、そのステップが終わってから中断します。ダウンロード・確認・展開はすぐに止まります（展開を途中で止めた場合は、次回ダウンロード済みのファイルを確認し直してから展開をやり直します）。</div>}
          </div>
        )}

        {step === 4 && (
          <div className="panel stack">
            <h3>完了</h3>
            <p>必要なコンポーネントが揃いました。「開始」を押すとアプリが利用可能になります。初回の生成時に ComfyUI が自動で起動します（約 10〜40 秒）。</p>
            {plannedPrecision && (
              <div className="muted">
                モデル精度: {plannedPrecision === "int8" ? "INT8（省 VRAM）" : "BF16（標準）"}
                {plannedPrecision !== config?.precision ? "（VRAM と導入済みモデルから自動選択）" : ""}。設定画面で変更できます。
              </div>
            )}
            {errorLine}
            {/* 戻る / アプリに戻る: a failed 開始 (setup_finalize) is not a dead end */}
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => go(3)}>
                戻る
              </button>
              <button className="btn primary big" disabled={busy} onClick={finish}>
                {busy ? "準備中…" : "開始"}
              </button>
              {returnButton}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
