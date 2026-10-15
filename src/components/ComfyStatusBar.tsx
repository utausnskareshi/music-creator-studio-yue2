// ComfyUI state at the bottom of the sidebar. Its own component, so the 5 s status poll and every progress event
// re-render only this, not the page.
import { useStore } from "../store";

export default function ComfyStatusBar() {
  const comfy = useStore((s) => s.comfy);
  const busy = useStore((s) => Boolean(s.progress.songId));
  const comfyState = !comfy ? "" : comfy.alive ? (busy ? "busy" : "ok") : comfy.processRunning ? "busy" : "err";
  const vram = comfy && comfy.vramTotal > 0 ? `VRAM ${(comfy.vramUsed / 1024 ** 3).toFixed(1)} / ${(comfy.vramTotal / 1024 ** 3).toFixed(0)} GB` : "";
  return (
    <div className="sidebar-bottom">
      <div>
        <span className={`status-dot ${comfyState}`} />
        ComfyUI {comfy?.alive ? "稼働中" : comfy?.processRunning ? "起動中" : "停止"}
        {comfy?.comfyuiVersion ? ` v${comfy.comfyuiVersion}` : ""}
      </div>
      {vram && <div>{vram}</div>}
      {comfy?.gpuName && (
        <div className="small" title={comfy.gpuName}>
          {comfy.gpuName.replace(/^cuda:\d+ /, "").replace(/ : .*$/, "")}
        </div>
      )}
    </div>
  );
}
