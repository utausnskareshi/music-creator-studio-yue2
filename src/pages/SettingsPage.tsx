import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import { api, type AppConfig, type AppPaths, type ComfyStatus, type ComponentStatus, type LlmStatus } from "../api";
import { useStore } from "../store";
import { useChoiceDialog } from "../components/ChoiceDialog";
import {
  ComfyStopTracker,
  DURATION_DEFAULT_MIN,
  DURATION_LIMIT_MAX,
  DURATION_LIMIT_MIN,
  TESTED_COMFYUI_VERSION,
  apiKeysToSave,
  cleanLocation,
  dataRootWarning,
  freeVramBlock,
  installedPrecisions,
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
} from "../config/rules";
import { setSetupPrefill } from "../config/setupPrefill";
import { localLlmView } from "../compose/rules";
import PageHeader from "../components/PageHeader";

/** Below this much VRAM the local LLM and YuE2 rarely fit together (advisory hint only). */
const SMALL_VRAM_GIB = 12.5;
/** GPU size from the system check, kept across visits of the page (it runs nvidia-smi). */
let cachedVramMib: number | null = null;
/**
 * The 停止 requests sent from this page, so a start they ended is not reported as a failure (module level: the
 * page is rebuilt on every visit while a start may still run).
 */
const comfyStops = new ComfyStopTracker();

type BusyOp = "start" | "stop" | "free" | "bundle" | "repair" | "setup" | "llm" | "save";

/** The same text as the backend's refusal (save_config). */
const SETUP_RERUN_BUSY = "生成・ツールの実行中はセットアップをやり直せません。完了してから実行してください。";
/** The same text as the backend's refusal (comfy_stop). */
const STOP_BUSY = "生成・ツールの実行中は停止できません。先にキャンセルしてください。";

/** This app's own work: a generation running or about to run, or a tool run (転写・分離・整列・譜面の計画). */
function appWorkingOf(generating: boolean, comfy: ComfyStatus | null): boolean {
  return Boolean(generating || comfy?.activeSongId || (comfy?.toolsInFlight ?? 0) > 0);
}

/** ComfyUI's queue holds work (this app's or another client's). */
function queueBusyOf(comfy: ComfyStatus | null): boolean {
  return Boolean(comfy && comfy.queueRunning + comfy.queuePending > 0);
}

/**
 * The local LLM's 状態 as AI 編集 shows it (localLlmView): this app's server counts as running while its process runs,
 * also before /health answers (起動中) or on the port from before a change.
 */
export function llmStatusLabel(llm: LlmStatus | null): string {
  return llm ? localLlmView(llm).label : "停止";
}

export default function SettingsPage() {
  // Only what the page shows: a whole-store subscription would re-render the form on every progress event.
  const { config, saveConfig, comfy, refreshComfy, showToast } = useStore(
    useShallow((s) => ({ config: s.config, saveConfig: s.saveConfig, comfy: s.comfy, refreshComfy: s.refreshComfy, showToast: s.showToast })),
  );
  const generating = useStore((s) => Boolean(s.progress.songId));
  const { ask, dialog } = useChoiceDialog();
  const [draft, setDraft] = useState<AppConfig | null>(config);
  // Port fields as typed (an emptied field stays empty instead of becoming port 0); checked on save.
  const [ports, setPorts] = useState({ comfy: String(config?.comfyPort ?? ""), llm: String(config?.llmPort ?? "") });
  const [vramMib, setVramMib] = useState<number | null>(cachedVramMib);
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [comps, setComps] = useState<ComponentStatus[]>([]);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  // Actions in flight (a ComfyUI start can take minutes; 停止 stays usable meanwhile).
  const [busyOps, setBusyOps] = useState<ReadonlySet<BusyOp>>(new Set());
  const isBusy = (...ops: BusyOp[]) => ops.some((o) => busyOps.has(o));
  useEffect(() => {
    setDraft(config);
    setPorts({ comfy: String(config?.comfyPort ?? ""), llm: String(config?.llmPort ?? "") });
  }, [config]);
  useEffect(() => {
    api.appPaths().then(setPaths).catch(() => {});
    api.setupStatus().then(setComps).catch(() => {});
    api.llmStatus().then(setLlm).catch(() => {});
  }, []);
  // The VRAM hint needs the GPU size only: a running ComfyUI reports it; otherwise ask the system check once per
  // app session (it runs nvidia-smi, off the UI thread; skipped when ComfyUI already knows). The hint belongs to
  // the local LLM settings, so the check waits until that provider is selected.
  const comfyKnowsVram = Boolean(comfy && comfy.vramTotal > 0);
  const localLlm = draft?.llm.provider === "local";
  useEffect(() => {
    if (!localLlm || comfyKnowsVram || vramMib !== null) return;
    api
      .systemCheck()
      .then((c) => {
        cachedVramMib = c.vramMib ?? 0;
        setVramMib(cachedVramMib);
      })
      .catch(() => setVramMib(0));
  }, [comfyKnowsVram, localLlm]);
  if (!draft) return null;

  const withDurations = (d: AppConfig): AppConfig => ({ ...d, ...normalizeDurations(d.maxDurationLimit, d.defaultMaxDuration) });
  const normalizeDraft = () => setDraft(withDurations(draft));
  const installed = installedPrecisions(comps);
  const rootError = locationError(draft.dataRoot, "data");
  const outError = locationError(draft.outputDir, "out");
  const rootWarning = rootError ? null : dataRootWarning(draft.dataRoot);
  // (against the data root being saved with it: the uninstaller and the app's clean-ups use that one)
  const outWarning = outError ? null : outputDirWarning(draft.outputDir, rootError ? "" : draft.dataRoot);
  const missingNodes = comfy?.alive ? (comfy.missingNodes ?? []) : [];
  const expectedVersion = comfy?.expectedComfyuiVersion || TESTED_COMFYUI_VERSION;
  const vramGib = comfy && comfy.vramTotal > 0 ? comfy.vramTotal / 1024 ** 3 : vramMib ? vramMib / 1024 : null;
  const smallVram = vramGib !== null && vramGib < SMALL_VRAM_GIB;
  // This app's generation or tool run is active (the backend refuses to stop ComfyUI then).
  const appWorking = appWorkingOf(generating, comfy);
  // ... or anything is in ComfyUI's queue (the wizard would hide its progress and cancel button).
  const working = appWorking || queueBusyOf(comfy);
  // The configured GGUF may be missing from models/llm: list it anyway so the select shows the real value.
  const localModels = llm?.localModels ?? [];
  const localModelMissing = !localModels.includes(draft.llm.localModel);

  // VAE precision: known only for the ComfyUI this app started (a server started elsewhere, e.g. by another
  // copy of the app or left over from a crash, keeps its own flags and cannot be restarted from here).
  const externalComfy = Boolean(comfy?.alive && !comfy.processRunning);
  const vaeLabel = comfy?.processRunning ? (comfy.vaeFp32Active ? "FP32" : "既定（FP16）") : comfy?.alive ? "不明（アプリが起動していない ComfyUI）" : "-";
  // 「VRAM を解放」 asks the server itself: a stopped or still starting ComfyUI has nothing to free
  const freeVramBlocked = freeVramBlock(comfy);

  /**
   * Save the draft. Resolves to null when saved, else the error (already shown as a toast). `quiet` leaves the
   * success message to the caller.
   */
  const save = async (opts?: { quiet?: boolean }): Promise<string | null> => {
    const comfyPort = Number(ports.comfy.trim() === "" ? NaN : ports.comfy);
    const llmPort = Number(ports.llm.trim() === "" ? NaN : ports.llm);
    const d = withDurations({ ...draft, dataRoot: cleanLocation(draft.dataRoot), outputDir: cleanLocation(draft.outputDir) });
    setDraft(d);
    const invalid = locationError(d.dataRoot, "data") ?? locationError(d.outputDir, "out") ?? portsError(comfyPort, llmPort);
    if (invalid) {
      showToast("error", invalid);
      return invalid;
    }
    try {
      const vaeChanged = Boolean(config && d.vaeFp32 !== config.vaeFp32);
      const comfyPortChanged = Boolean(config && comfyPort !== config.comfyPort);
      const dataRootChanged = Boolean(config && d.dataRoot !== config.dataRoot);
      // ComfyUI launch settings: the backend restarts the ComfyUI it started once it is idle
      const comfyLaunchChanged = vaeChanged || comfyPortChanged || dataRootChanged;
      const llmPortChanged = Boolean(config && llmPort !== config.llmPort);
      await saveConfig({ ...d, comfyPort, llmPort });
      // the component status follows the saved data root: a new root usually needs the setup first
      let dataRootReady: boolean | null = null;
      if (dataRootChanged) {
        const c = await api.setupStatus().catch(() => null);
        if (c) {
          setComps(c);
          dataRootReady = requiredInstalled(c);
        }
      }
      if (comfyLaunchChanged) await refreshComfy().catch(() => {});
      // a changed LLM port (or model settings) restarts the app's llama-server with the next AI request
      api.llmStatus().then(setLlm).catch(() => {});
      const notes = settingsSaveNotes({
        vaeChanged,
        comfyPortChanged,
        dataRootChanged,
        externalComfy,
        comfyProcessRunning: Boolean(comfy?.processRunning),
        dataRootReady,
        llmPortChanged,
        llmProcessRunning: Boolean(llm?.processRunning),
      });
      if (!opts?.quiet) showToast(notes.length ? "info" : "success", ["設定を保存しました", ...notes].join("。"));
      return null;
    } catch (e) {
      showToast("error", String(e));
      return String(e);
    }
  };
  const pick = async (k: "dataRoot" | "outputDir") => {
    const d = await open({ directory: true });
    if (typeof d === "string") setDraft({ ...draft, [k]: cleanLocation(d) });
  };
  /** One backend action at a time per button group; errors become toasts. */
  const run = async (op: BusyOp, f: () => Promise<void>) => {
    if (busyOps.has(op)) return;
    setBusyOps((prev) => new Set(prev).add(op));
    try {
      await f();
    } catch (e) {
      showToast("error", String(e));
    } finally {
      setBusyOps((prev) => {
        const next = new Set(prev);
        next.delete(op);
        return next;
      });
    }
  };
  const busyLabel = (op: BusyOp, idle: string, active: string) => (busyOps.has(op) ? active : idle);

  // Opens the wizard at once (it replaces the whole app). The data root and song folder typed here only
  // pre-fill the wizard's 保存場所 step: config.json keeps the current locations until 「次へ」 there, so
  // 「アプリに戻る」 returns to the working install. Any other unsaved change on this page is dropped.
  /** A fresh status (the page's one is polled every 5 s): true when a generation, a queued item or a tool run is active. */
  const busyNow = async (): Promise<boolean> => {
    await refreshComfy().catch(() => {});
    const s = useStore.getState();
    return appWorkingOf(Boolean(s.progress.songId), s.comfy) || queueBusyOf(s.comfy);
  };
  const rerunSetup = async () => {
    if (!config) return;
    if (await busyNow()) {
      showToast("info", SETUP_RERUN_BUSY);
      return;
    }
    const dataRoot = cleanLocation(draft.dataRoot);
    const outputDir = cleanLocation(draft.outputDir);
    const invalid = locationError(dataRoot, "data") ?? locationError(outputDir, "out");
    if (invalid) {
      showToast("error", invalid);
      return;
    }
    const moved = dataRoot !== config.dataRoot || outputDir !== config.outputDir;
    // Stored locations an older version accepted but saving rejects cannot be kept: those move at once.
    const handOff = moved && !locationError(config.dataRoot, "data") && !locationError(config.outputDir, "out");
    const choice = await ask({
      title: "セットアップをやり直す",
      message: `セットアップウィザードを開きます。導入済みのものはそのまま残り、不足分や任意コンポーネントを追加できます。ダウンロードせずに戻るときは「アプリに戻る」を押してください（ウィザードを開く時点の保存場所のまま戻ります）。${
        handOff
          ? "この画面で変更したデータルート・楽曲の保存先は、ウィザードの「保存場所」に入力された状態で開きます（そこで「次へ」を押すと保存されます）。"
          : moved
            ? "この画面で変更したデータルート・楽曲の保存先を保存してからウィザードを開きます。"
            : ""
      }ほかの未保存の変更は破棄されます。作曲・カバー / 耳コピ・AI 編集・ボーカル分離・書き出しの各画面で入力中の内容もリセットされます。`,
      choices: [{ value: "open", label: "ウィザードを開く", kind: "primary" }],
    });
    if (!choice) return;
    // a tool or a generation may have started while the dialog was open
    if (await busyNow()) {
      showToast("info", SETUP_RERUN_BUSY);
      return;
    }
    setSetupPrefill(handOff ? { dataRoot, outputDir } : null);
    await run("setup", async () => {
      try {
        await saveConfig(handOff ? { ...config, setupCompleted: false } : { ...config, dataRoot, outputDir, setupCompleted: false });
      } catch (e) {
        setSetupPrefill(null);
        throw e;
      }
    });
  };

  const stopComfy = async () => {
    // The backend refuses while this app works (its error toast stays the fallback when this status lags).
    if (appWorking) {
      showToast("info", STOP_BUSY);
      return;
    }
    if (working) {
      // only another client's prompts are queued: the backend stops, and those fail
      const choice = await ask({
        title: "ComfyUI を停止しますか？",
        message: "ComfyUI に別のクライアントから送られた処理が残っています。停止するとそれらの処理は失敗します。",
        choices: [{ value: "stop", label: "停止する", kind: "danger" }],
      });
      if (!choice) return;
    }
    await run("stop", async () => {
      await comfyStops.stop(() => api.comfyStop());
      await refreshComfy();
    });
  };

  const saveLlm = () =>
    run("llm", async () => {
      const saveError = await save({ quiet: true });
      // trimmed; spaces alone never delete a key, and an OpenAI key waits for its Base URL to be saved (apiKeysToSave)
      const keys = apiKeysToSave(anthropicKey, openaiKey, saveError === null);
      const hasKeys = keys.anthropic !== null || keys.openai !== null;
      if (hasKeys) {
        try {
          await api.saveSecrets(keys.anthropic, keys.openai);
          setAnthropicKey("");
          if (!keys.openaiHeld) setOpenaiKey("");
        } catch (e) {
          showToast("error", `API キーを保存できませんでした: ${String(e)}`);
          return;
        } finally {
          api.llmStatus().then(setLlm).catch(() => {});
        }
      }
      const notice = llmSaveNotice({ saveError, keysSaved: hasKeys, openaiHeld: keys.openaiHeld });
      if (notice) showToast(notice.kind, notice.text);
    });

  const deleteKey = async (which: "anthropic" | "openai") => {
    const choice = await ask({
      title: "API キーを削除",
      message: `保存済みの ${which === "anthropic" ? "Anthropic" : "OpenAI 互換 API"} のキーを secrets.json から削除します。`,
      choices: [{ value: "delete", label: "削除する", kind: "danger" }],
    });
    if (!choice) return;
    await run("llm", async () => {
      await (which === "anthropic" ? api.saveSecrets("", null) : api.saveSecrets(null, ""));
      setLlm(await api.llmStatus());
      showToast("success", "API キーを削除しました");
    });
  };

  return (
    <div>
      {dialog}
      <PageHeader page="settings" />
      <div className="grid-compose">
        <div className="stack">
          <div className="panel stack">
            <h3>生成</h3>
            <label className="field">
              <span className="lbl">モデル精度</span>
              <select value={draft.precision} onChange={(e) => setDraft({ ...draft, precision: e.target.value as "bf16" | "int8", precisionExplicit: true })}>
                <option value="bf16" disabled={installed?.bf16 === false && draft.precision !== "bf16"}>
                  BF16（標準、VRAM 約 9〜14GB）{installed?.bf16 === false ? " — 未導入" : ""}
                </option>
                <option value="int8" disabled={installed?.int8 === false && draft.precision !== "int8"}>
                  INT8（省 VRAM。ComfyUI 公式テンプレート既定。音響段・VAE も低精度のため BF16 より音質がわずかに劣る可能性）{installed?.int8 === false ? " — 未導入" : ""}
                </option>
              </select>
              {installed?.[draft.precision] === false && (
                <span className="hint">選択中の精度のチェックポイントが未導入です。「セットアップをやり直す」でダウンロードするか、精度を切り替えてください。</span>
              )}
            </label>
            <label className="field">
              <span className="lbl">VAE デコード方式</span>
              <select value={draft.vaeDecode ?? "auto"} onChange={(e) => setDraft({ ...draft, vaeDecode: e.target.value as AppConfig["vaeDecode"] })}>
                <option value="auto">自動（既定。VRAM に収まる曲は通常、長い曲は分割デコード）</option>
                <option value="plain">通常（ComfyUI 公式テンプレートのノード。VRAM 不足時は ComfyUI が分割に切り替え）</option>
                <option value="tiled">分割（公式ランタイム相当。VRAM を抑え、長い曲でも安定。数秒〜十数秒遅い）</option>
              </select>
              <span className="muted small">分割デコードは通常デコードと聴感上同じ音になります（実測で差は -55 dB 以下、継ぎ目の劣化なし）。</span>
            </label>
            <label className="row">
              <input type="checkbox" checked={draft.vaeFp32} onChange={(e) => setDraft({ ...draft, vaeFp32: e.target.checked })} />
              {/* long label: let it wrap next to the checkbox instead of the whole text dropping below it */}
              <span style={{ flex: "1 1 0", minWidth: 0 }}>VAE を FP32 で実行（公式ランタイム準拠。実測では FP16 との差は聴感上検出できず（-54 dB 以下）、復号が約 2 倍遅く VRAM も約 2 倍必要。アプリが起動した ComfyUI を空き次第再起動して反映します）</span>
            </label>
            <label className="row">
              <input type="checkbox" checked={draft.freeVramAfterGeneration} onChange={(e) => setDraft({ ...draft, freeVramAfterGeneration: e.target.checked })} />
              生成後に VRAM を解放する（次回の生成でモデルを再読み込み、約 10 秒）
            </label>
            <label className="field">
              <span className="lbl">曲長の既定上限（秒）</span>
              <input
                type="number"
                min={DURATION_DEFAULT_MIN}
                max={Number.isFinite(draft.maxDurationLimit) ? draft.maxDurationLimit : DURATION_LIMIT_MAX}
                step={1}
                value={Number.isFinite(draft.defaultMaxDuration) ? draft.defaultMaxDuration : ""}
                onChange={(e) => setDraft({ ...draft, defaultMaxDuration: e.target.valueAsNumber })}
                onBlur={normalizeDraft}
              />
            </label>
            <label className="field">
              {/* 360 is the official YuE figure, not an app bound */}
              <span className="lbl">曲長の最大値（上級、秒。公式上限 360、ComfyUI 拡張 {DURATION_LIMIT_MAX}）</span>
              <input
                type="number"
                min={DURATION_LIMIT_MIN}
                max={DURATION_LIMIT_MAX}
                step={1}
                value={Number.isFinite(draft.maxDurationLimit) ? draft.maxDurationLimit : ""}
                onChange={(e) => setDraft({ ...draft, maxDurationLimit: e.target.valueAsNumber })}
                onBlur={normalizeDraft}
              />
            </label>
          </div>
          <div className="panel stack">
            <h3>場所とポート</h3>
            <label className="field">
              <span className="lbl">データルート（変更後は再セットアップが必要）</span>
              <div className="row">
                <input type="text" value={draft.dataRoot} onChange={(e) => setDraft({ ...draft, dataRoot: e.target.value })} onBlur={() => setDraft({ ...draft, dataRoot: cleanLocation(draft.dataRoot) })} />
                <button className="btn" onClick={() => pick("dataRoot")}>参照</button>
              </div>
              {rootError && <span style={{ color: "var(--danger)" }}>{rootError}</span>}
              {rootWarning && <span className="hint">{rootWarning}</span>}
            </label>
            <label className="field">
              <span className="lbl">楽曲の保存先</span>
              <div className="row">
                <input type="text" value={draft.outputDir} onChange={(e) => setDraft({ ...draft, outputDir: e.target.value })} onBlur={() => setDraft({ ...draft, outputDir: cleanLocation(draft.outputDir) })} />
                <button className="btn" onClick={() => pick("outputDir")}>参照</button>
              </div>
              {outError && <span style={{ color: "var(--danger)" }}>{outError}</span>}
              {outWarning && <span className="hint">{outWarning}</span>}
              <span className="muted small">変更後に生成した曲から新しい保存先に入ります。既存の曲は移動しません（ライブラリからは元の場所のまま使えます）。</span>
            </label>
            <div className="row">
              <label className="field">
                <span className="lbl">ComfyUI ポート</span>
                <input type="number" min={1} max={65535} step={1} value={ports.comfy} onChange={(e) => setPorts({ ...ports, comfy: e.target.value })} />
              </label>
              <label className="field">
                <span className="lbl">LLM ポート</span>
                <input type="number" min={1} max={65535} step={1} value={ports.llm} onChange={(e) => setPorts({ ...ports, llm: e.target.value })} />
              </label>
            </div>
            <span className="muted small">ポートを変更すると、このアプリが起動した ComfyUI は空き次第、ローカル LLM は次の AI リクエストで再起動して反映します。</span>
            <div className="row">
              {/* both save buttons write the same config.json: one save at a time */}
              <button className="btn primary" disabled={Boolean(rootError || outError) || isBusy("save", "llm")} onClick={() => run("save", async () => void (await save()))}>
                {busyLabel("save", "保存", "保存中…")}
              </button>
              <button className="btn" disabled={working || busyOps.size > 0} onClick={rerunSetup} title="セットアップウィザードを開き、不足分や任意コンポーネントを追加します">
                セットアップをやり直す
              </button>
            </div>
            {working && <span className="hint">生成・ツールの実行中はセットアップをやり直せません。完了してから実行してください。</span>}
          </div>
        </div>
        <div className="stack">
          <div className="panel stack">
            <h3>ComfyUI</h3>
            <div className="kv">
              <div className="k">状態</div>
              <div>{comfy?.alive ? `稼働中（v${comfy.comfyuiVersion}, PyTorch ${comfy.pytorchVersion}）` : comfy?.processRunning ? "起動中" : "停止"}</div>
              <div className="k">GPU</div>
              <div>{comfy?.gpuName ?? "-"}</div>
              <div className="k">VRAM</div>
              <div>{comfy && comfy.vramTotal ? `${(comfy.vramUsed / 1024 ** 3).toFixed(2)} / ${(comfy.vramTotal / 1024 ** 3).toFixed(1)} GB` : "-"}</div>
              <div className="k">VAE 精度</div>
              <div>{vaeLabel}</div>
              <div className="k">WAV 保存ノード</div>
              <div>{comfy?.hasWavSaver ? "有効（32bit float）" : "未検出（16bit FLAC で保存）"}</div>
              <div className="k">キュー</div>
              <div>{comfy ? `実行中 ${comfy.queueRunning} / 待機中 ${comfy.queuePending}` : "-"}</div>
              <div className="k">動作確認済み版</div>
              <div>v{expectedVersion}</div>
            </div>
            {comfy?.restartRequired && <div className="hint">ComfyUI の起動設定（VAE 精度・ポート・データルート）の変更を反映するため、ComfyUI が空き次第（生成やツールの実行中なら終わってから）再起動します。</div>}
            {externalComfy && config?.vaeFp32 && (
              <div className="hint">
                このアプリが起動していない ComfyUI が動作中のため、VAE FP32 は反映されません。その ComfyUI（別のアプリや残ったプロセス）を終了してから「起動」を押すか、ポートを変更してください。
              </div>
            )}
            {comfy?.alive && comfy.versionMismatch && (
              <div className="hint">動作確認済みは v{expectedVersion} です（稼働中 v{comfy.comfyuiVersion ?? "?"}）。生成に失敗する場合はこの差が原因の可能性があります。</div>
            )}
            {missingNodes.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <div style={{ color: "var(--danger)" }}>必要なノードが見つかりません: {missingNodes.join(", ")}</div>
                {missingNodes.some(isNativeYue2Node) ? (
                  <div className="hint">ComfyUI 本体に YuE2 ノードがありません（v0.35.0 以降が必要、動作確認済みは v{expectedVersion}）。「セットアップをやり直す」から ComfyUI を確認してください。</div>
                ) : (
                  <div className="row">
                    <button
                      className="btn"
                      disabled={isBusy("repair")}
                      onClick={() =>
                        run("repair", async () => {
                          await api.setupFinalize();
                          showToast("info", "ノードパックを再インストールしました。反映には ComfyUI の再起動（停止 → 起動）が必要です");
                        })
                      }
                    >
                      {busyLabel("repair", "ノードパックを修復", "修復中…")}
                    </button>
                    <span className="hint">再起動しても改善しない場合は、ノードパックの依存ライブラリの読み込みに失敗している可能性があります。「ログを開く」で ComfyUI の起動ログを確認するか、診断バンドルを作成してください。</span>
                  </div>
                )}
              </div>
            )}
            <div className="row">
              {/* From the status, not only this page's own click: the page is rebuilt on every visit, and a start
                  begun before leaving (or by a generation) is still a start. */}
              <button
                className="btn"
                disabled={isBusy("start", "stop") || Boolean(comfy?.processRunning)}
                onClick={() =>
                  run("start", async () => {
                    // false: 停止 was pressed meanwhile (the start then reports 「プロセスが終了しました」, but nothing failed)
                    if (await comfyStops.start(() => api.comfyStart())) await refreshComfy();
                  })
                }
                title={comfy?.processRunning && comfy.alive ? "ComfyUI は稼働中です" : "最大 4 分ほどかかることがあります"}
              >
                {busyOps.has("start") || (comfy?.processRunning && !comfy.alive) ? "起動中…" : "起動"}
              </button>
              <button
                className="btn"
                disabled={isBusy("stop") || appWorking || !comfy?.processRunning}
                onClick={stopComfy}
                title={appWorking ? STOP_BUSY : !comfy?.processRunning ? (comfy?.alive ? "このアプリが起動していない ComfyUI のため停止できません" : "ComfyUI は停止しています") : undefined}
              >
                {busyLabel("stop", "停止", "停止中…")}
              </button>
              <button
                className="btn"
                disabled={isBusy("free") || freeVramBlocked !== null}
                title={freeVramBlocked ?? undefined}
                onClick={() =>
                  run("free", async () => {
                    try {
                      await api.comfyFreeVram();
                    } catch (e) {
                      // e.g. ComfyUI stopped since the last status poll (the backend's error is not translated)
                      showToast("error", `VRAM を解放できませんでした: ${String(e)}`);
                      return;
                    }
                    showToast("info", "VRAM を解放しました");
                  })
                }
              >
                {busyLabel("free", "VRAM を解放", "解放中…")}
              </button>
              {paths && <button className="btn" onClick={() => api.revealPath(paths.comfyLog).catch((e) => showToast("error", String(e)))}>ログを開く</button>}
              <button
                className="btn"
                disabled={isBusy("bundle")}
                title="ログ・設定（API キーは含みません）・環境情報・直近の失敗ジョブ（歌詞・スタイル・譜面を含む）を zip にまとめます。ファイルのパスには Windows のユーザー名が含まれます。公開の場に添付する前に中身を確認してください"
                onClick={() =>
                  run("bundle", async () => {
                    const p = await api.createDiagnosticBundle();
                    showToast("success", `診断バンドルを作成しました: ${p}（直近の失敗ジョブの歌詞・スタイル・譜面と、ユーザー名を含むパスが入っています。公開する前に確認してください）`);
                    api.revealPath(p).catch(() => {});
                  })
                }
              >
                {busyLabel("bundle", "診断バンドルを作成", "作成中…")}
              </button>
            </div>
            {appWorking && <span className="hint">{STOP_BUSY}</span>}
          </div>
          <div className="panel stack">
            <h3>AI 編集（LLM）</h3>
            <label className="field">
              <span className="lbl">プロバイダ</span>
              <select value={draft.llm.provider} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, provider: e.target.value as AppConfig["llm"]["provider"] } })}>
                <option value="local">ローカル（llama.cpp、オフライン）</option>
                <option value="anthropic">Anthropic API（Claude）</option>
                <option value="openai">OpenAI 互換 API</option>
              </select>
            </label>
            {draft.llm.provider === "local" && (
              <>
                <label className="field">
                  <span className="lbl">GGUF モデル（models/llm）</span>
                  <select value={draft.llm.localModel} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, localModel: e.target.value } })}>
                    {localModelMissing && (
                      <option value={draft.llm.localModel}>
                        {draft.llm.localModel}
                        {llm ? "（見つかりません）" : ""}
                      </option>
                    )}
                    {localModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  {llm && localModelMissing && (
                    <span className="hint">
                      設定中のモデルが models/llm にありません。{localModels.length ? "一覧から選び直して「LLM 設定を保存」を押してください。" : "GGUF ファイルを models/llm に置くか、「セットアップをやり直す」で Qwen3-14B を導入してください。"}
                    </span>
                  )}
                </label>
                <label className="field">
                  <span className="lbl">
                    <span>GPU に載せる層数（gpu_layers。99 = 全層、0 = CPU のみ）</span>
                    <span className="mono">{draft.llm.gpuLayers}</span>
                  </span>
                  <input type="range" min={0} max={99} step={1} value={Math.max(0, Math.min(99, draft.llm.gpuLayers))} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, gpuLayers: Number(e.target.value) } })} />
                </label>
                <label className="field">
                  <span className="lbl">コンテキスト長（トークン。AI 編集の会話が長くなって超えたときに増やします。大きいほど VRAM を多く使います）</span>
                  <select value={draft.llm.contextSize} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, contextSize: Number(e.target.value) } })}>
                    {llmContextSizeOptions(draft.llm.contextSize).map((n) => (
                      <option key={n} value={n}>
                        {llmContextSizeLabel(n)}
                      </option>
                    ))}
                  </select>
                </label>
                {smallVram && (
                  <div className="hint">
                    この GPU の VRAM は約 {vramGib!.toFixed(0)} GB です。ローカル LLM と YuE2 を同時に載せると不足しやすいため、GPU に載せる層数を減らすか、より小さいモデル（8B クラスの Q4 GGUF など）を使い、「曲の生成前に LLM を停止」を有効にしてください。
                  </div>
                )}
                <label className="row"><input type="checkbox" checked={draft.llm.thinking} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, thinking: e.target.checked } })} /> 思考モード（Qwen3 thinking。精度向上、応答は遅くなる）</label>
                {draft.llm.thinking && (
                  <label className="row" style={{ marginLeft: 24 }}>
                    <input type="checkbox" checked={draft.llm.limitThinking} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, limitThinking: e.target.checked } })} /> 思考の長さを自動で制限する（既定。歌詞の作成は約 1,000、譜面の編集は約 4,000 トークンで思考を切り上げて回答させます。オフにすると思考が長く続いて精度が上がることがありますが、応答の長さ上限（8,192 トークン）に達して失敗することがあります）
                  </label>
                )}
                <label className="row"><input type="checkbox" checked={draft.llm.unloadBeforeGeneration} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, unloadBeforeGeneration: e.target.checked } })} /> 曲の生成前に LLM を停止して VRAM を解放する</label>
                <div className="muted small">
                  状態: {llmStatusLabel(llm)}
                  {llm?.model ? ` · ${llm.model}` : ""}
                </div>
                {llm?.restartRequired && <div className="hint">LLM の設定が変更されています。次の AI リクエストで新しい設定で再起動します。</div>}
                {llm?.external && (
                  <div className="hint">このアプリが起動していない llama-server が LLM ポートで動作しています（このアプリからは停止・再起動できず、ここでの設定も反映されません）。AI 編集がうまく動かない場合は、そのプロセスを終了するか、LLM ポートを変更してください。</div>
                )}
              </>
            )}
            {draft.llm.provider === "anthropic" && (
              <>
                <label className="field"><span className="lbl">モデル</span><input type="text" value={draft.llm.anthropicModel} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, anthropicModel: e.target.value } })} /></label>
                <label className="field">
                  <span className="lbl">API キー（{llm?.hasAnthropicKey ? "設定済み" : "未設定"}。secrets.json に暗号化せずに保存）</span>
                  <div className="row">
                    <input type="password" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} placeholder="sk-ant-..." />
                    {llm?.hasAnthropicKey && <button className="btn" disabled={isBusy("llm")} onClick={() => deleteKey("anthropic")}>キーを削除</button>}
                  </div>
                </label>
              </>
            )}
            {draft.llm.provider === "openai" && (
              <>
                <label className="field">
                  <span className="lbl">Base URL</span>
                  <input type="text" value={draft.llm.openaiBaseUrl} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, openaiBaseUrl: e.target.value } })} />
                  {isInsecureRemoteUrl(draft.llm.openaiBaseUrl) && <span className="hint">http:// の接続先です。API キーとプロンプトが暗号化されずに送信されます。https:// を使ってください。</span>}
                </label>
                <label className="field"><span className="lbl">モデル</span><input type="text" value={draft.llm.openaiModel} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, openaiModel: e.target.value } })} /></label>
                <label className="field">
                  <span className="lbl">API キー（{llm?.hasOpenaiKey ? "設定済み" : "未設定"}。secrets.json に暗号化せずに保存）</span>
                  <div className="row">
                    <input type="password" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} placeholder="sk-..." />
                    {llm?.hasOpenaiKey && <button className="btn" disabled={isBusy("llm")} onClick={() => deleteKey("openai")}>キーを削除</button>}
                  </div>
                  {llm?.openaiKeyOrigin &&
                    (openaiKeyOriginMismatch(llm.openaiKeyOrigin, draft.llm.openaiBaseUrl) ? (
                      <span className="hint">
                        保存済みのキーは {llm.openaiKeyOrigin} 用です。Base URL の接続先（{urlOrigin(draft.llm.openaiBaseUrl)}）には送信しないため、この接続先のキーを入力し直してください。
                      </span>
                    ) : (
                      <span className="muted small">保存済みのキーは {llm.openaiKeyOrigin} にだけ送信されます。</span>
                    ))}
                </label>
              </>
            )}
            {draft.llm.provider === "anthropic" ? (
              <div className="muted small">temperature は Anthropic API には送信しません（現行の Claude モデルは既定値のみ受け付けます）。</div>
            ) : (
              <label className="field">
                <span className="lbl"><span>temperature</span><span className="mono">{draft.llm.temperature}</span></span>
                <input type="range" min={0} max={1.5} step={0.05} value={draft.llm.temperature} onChange={(e) => setDraft({ ...draft, llm: { ...draft.llm, temperature: Number(e.target.value) } })} />
                {draft.llm.provider === "openai" && <span className="muted small">推論モデル（gpt-5 系など）では無視されます。</span>}
              </label>
            )}
            <div className="row">
              <button className="btn primary" disabled={isBusy("llm", "save")} onClick={saveLlm}>
                {busyLabel("llm", "LLM 設定を保存", "保存中…")}
              </button>
              {(anthropicKey.trim() || openaiKey.trim()) && <span className="muted small">入力した API キーはこのボタンで保存されます。</span>}
            </div>
          </div>
          <div className="panel stack">
            <h3>導入済みコンポーネント</h3>
            {comps.map((c) => (
              <div key={c.id} className="row between small">
                <span>{c.name}</span>
                <span className={`badge ${c.installed ? "done" : ""}`}>{c.installed ? "導入済み" : "未導入"}</span>
              </div>
            ))}
          </div>
          {paths && (
            <div className="panel stack">
              <h3>情報</h3>
              <div className="kv small">
                <div className="k">バージョン</div>
                <div>{paths.appVersion}</div>
                <div className="k">設定ファイル</div>
                <div className="mono" style={{ wordBreak: "break-all" }}>{paths.configPath}</div>
                <div className="k">ログ</div>
                <div className="mono" style={{ wordBreak: "break-all" }}>{paths.logDir}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
