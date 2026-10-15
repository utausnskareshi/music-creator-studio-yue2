// Canvas piano-roll editor for the two-voice YuE2 score model.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PPQ, barAtTick, barStartTick, meterAtTick, pitchName, ticksPerBar, ticksPerUnit, type Note, type Score, type VoiceName } from "../abc/model";
import { boxSelect, clampMoveDelta, createNote, dragEndChange, editKeyDuringDrag, moveGesture, resizeGesture } from "../abc/edit";
import { previewNote } from "../abc/synth";

export interface PianoRollChange {
  /**
   * An update in the middle of a drag (move / resize / create): shown right away, but the drag ends with one more
   * onChange without this flag (on mouse up or when the pointer leaves), which is the edit to keep.
   */
  gesture?: boolean;
  /**
   * The drag that sent gesture updates ended where it began (a note grown and shrunk back, a selection moved and
   * brought back): nothing to keep, the editor goes back to the score from before the drag. `next` is that
   * score's notes, for an editor that has nothing to go back to.
   */
  revert?: boolean;
}

export interface PianoRollProps {
  score: Score;
  onChange: (next: Score, opts?: PianoRollChange) => void;
  /** A drag that edits notes begins (before its first onChange). */
  onGestureStart?: () => void;
  /** Editing target voice for newly drawn notes. */
  activeVoice: VoiceName;
  /** Snap grid unit denominator (16 = 1/16). */
  snapUnit: number;
  /** Playback cursor in ticks (null = hidden). */
  cursorTick: number | null;
  onSeek?: (tick: number) => void;
  selected: Set<number>;
  onSelect: (ids: Set<number>) => void;
  height?: number;
  /**
   * Changes when the editor loads another score: a drag in progress is dropped (its drag-start notes belong to the
   * previous score and must never be written into the new one).
   */
  resetKey?: number;
}

const ROW_H = 12;
const KEY_W = 46;
const HEADER_H = 40; // chords + sections + bar numbers
const MIN_PITCH = 36; // C2
const MAX_PITCH = 96; // C7
const COLORS = {
  Vocal: { fill: "#5b8cff", stroke: "#8fb3ff", sel: "#ffd166" },
  Ins: { fill: "#3ccf8e", stroke: "#7fe3b6", sel: "#ffd166" },
};

/** The grid where notes are drawn and edited: right of the keys column and below the header (both hide notes). */
export function inNoteArea(x: number, y: number): boolean {
  return x >= KEY_W && y >= HEADER_H;
}

/**
 * A drag. Note edits keep the notes as they were when the drag started (`base`) and compute every step from
 * them, so a step never builds on the previous one (a neighbour a note passed over comes back). `last`: the notes
 * the last step sent (what the drag's end keeps).
 */
type Drag =
  | { kind: "move"; ids: Set<number>; startX: number; startY: number; base: Note[]; origin: { start: number; pitch: number }[]; dTick: number; dPitch: number; moved: boolean; last?: Note[] }
  | { kind: "resize"; note: Note; startX: number; base: Note[]; duration: number; changed: boolean; last?: Note[] }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "create"; note: Note; startX: number; base: Note[]; duration: number; last?: Note[] };

export default function PianoRoll({ score, onChange, onGestureStart, activeVoice, snapUnit, cursorTick, onSeek, selected, onSelect, height = 360, resetKey = 0 }: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pxPerTick, setPxPerTick] = useState(0.11);
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState((MAX_PITCH - 84) * ROW_H); // start around C5 at top area
  const [drag, setDrag] = useState<Drag | null>(null);
  // The drag as the handlers see it, updated synchronously: React renders mouse moves lazily, so a move and the
  // mouse up that follows in the same input task would otherwise both see the drag of the last render (and the
  // up would drop the last step). The state is kept for drawing and the cursor.
  const dragRef = useRef<Drag | null>(null);
  const setDragNow = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };
  // Another score was loaded: a drag in progress ends without an edit. Done while rendering, so no handler ever
  // sees the old drag together with the new score.
  const [dragKey, setDragKey] = useState(resetKey);
  if (dragKey !== resetKey) {
    setDragKey(resetKey);
    setDrag(null);
    dragRef.current = null;
  }
  const [hover, setHover] = useState<{ tick: number; pitch: number } | null>(null);
  /** the pointer is over a note's resize zone (shown as the ew-resize cursor) */
  const [hoverEdge, setHoverEdge] = useState(false);
  const [width, setWidth] = useState(800);

  const barTicks = ticksPerBar(score);
  const snap = ticksPerUnit(snapUnit);
  const totalTicks = barStartTick(score, Math.max(score.bars, 4)) + barTicks * 2;
  const gridH = (MAX_PITCH - MIN_PITCH + 1) * ROW_H;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Follow the playback cursor: when it leaves the visible area (or passes 85% of it), page the view so the
  // cursor sits at 15% from the left edge. Applies to seeks too, so the cursor is always visible.
  useEffect(() => {
    if (cursorTick === null) return;
    const view = Math.max(50, width - KEY_W);
    setScrollX((s) => {
      const x = cursorTick * pxPerTick - s; // position relative to the grid's left edge
      if (x < 0 || x > view * 0.85) return Math.max(0, cursorTick * pxPerTick - view * 0.15);
      return s;
    });
  }, [cursorTick, pxPerTick, width]);

  const tickToX = useCallback((t: number) => KEY_W + t * pxPerTick - scrollX, [pxPerTick, scrollX]);
  const xToTick = useCallback((x: number) => (x - KEY_W + scrollX) / pxPerTick, [pxPerTick, scrollX]);
  const pitchToY = useCallback((p: number) => HEADER_H + (MAX_PITCH - p) * ROW_H - scrollY, [scrollY]);
  const yToPitch = useCallback((y: number) => MAX_PITCH - Math.floor((y - HEADER_H + scrollY) / ROW_H), [scrollY]);

  const notesById = useMemo(() => new Map(score.notes.map((n) => [n.id, n])), [score.notes]);

  // ---------- drawing ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Reallocate the backing store only when the size or the display scaling changed (assigning width/height
    // clears and reallocates it); dpr is read on every draw, so moving to another monitor is picked up.
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    // The CSS size separately: width and dpr can change together and give the same backing-store size.
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#12141a"; // the full-area fill also clears the previous frame
    ctx.fillRect(0, 0, width, height);

    // rows
    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      const y = pitchToY(p);
      if (y + ROW_H < HEADER_H || y > height) continue;
      const pc = p % 12;
      const black = [1, 3, 6, 8, 10].includes(pc);
      ctx.fillStyle = black ? "#171a22" : "#1b1f28";
      ctx.fillRect(KEY_W, y, width - KEY_W, ROW_H);
      if (pc === 0 || pc === 5) {
        ctx.fillStyle = "#2b3140";
        ctx.fillRect(KEY_W, y + ROW_H - 1, width - KEY_W, 1);
      }
    }
    // vertical grid (bar lengths follow the meter timeline)
    const firstBar = barAtTick(score, Math.max(0, xToTick(KEY_W)));
    const lastBar = barAtTick(score, Math.max(0, xToTick(width))) + 1;
    for (let b = firstBar; b <= lastBar; b++) {
      const bStart = barStartTick(score, b);
      const bEnd = barStartTick(score, b + 1);
      const meter = meterAtTick(score, bStart);
      const beatTicks = PPQ * (4 / meter[1]);
      const bx = tickToX(bStart);
      ctx.fillStyle = "#3a4256";
      ctx.fillRect(bx, HEADER_H, 1, height - HEADER_H);
      for (let k = 1; k < meter[0]; k++) {
        const x = tickToX(bStart + k * beatTicks);
        ctx.fillStyle = "#242a37";
        ctx.fillRect(x, HEADER_H, 1, height - HEADER_H);
      }
      if (pxPerTick * snap > 6) {
        for (let t = bStart; t < bEnd; t += snap) {
          const x = tickToX(t);
          ctx.fillStyle = "#1e2330";
          ctx.fillRect(x, HEADER_H, 1, height - HEADER_H);
        }
      }
    }
    // notes
    for (const n of score.notes) {
      const x = tickToX(n.start);
      const w = Math.max(2, n.duration * pxPerTick - 1);
      const y = pitchToY(n.pitch);
      if (x + w < KEY_W || x > width || y + ROW_H < HEADER_H || y > height) continue;
      const c = COLORS[n.voice];
      const isSel = selected.has(n.id);
      ctx.fillStyle = isSel ? c.sel : c.fill;
      ctx.globalAlpha = n.voice === activeVoice ? 1 : 0.55;
      ctx.fillRect(x, y + 1, w, ROW_H - 2);
      ctx.strokeStyle = isSel ? "#fff" : c.stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 1.5, w - 1, ROW_H - 3);
      ctx.globalAlpha = 1;
    }
    // hover ghost
    if (hover && !drag) {
      const x = tickToX(hover.tick);
      const y = pitchToY(hover.pitch);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.strokeRect(x + 0.5, y + 1.5, snap * pxPerTick - 1, ROW_H - 3);
    }
    // box select
    if (drag?.kind === "box") {
      ctx.fillStyle = "rgba(91,140,255,0.15)";
      ctx.strokeStyle = "rgba(91,140,255,0.8)";
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }
    // header background
    ctx.fillStyle = "#181b23";
    ctx.fillRect(0, 0, width, HEADER_H);
    // sections
    ctx.font = "11px sans-serif";
    for (const s of score.sections) {
      const x = tickToX(barStartTick(score, s.bar));
      if (x < KEY_W - 100 || x > width) continue;
      ctx.fillStyle = "#f2b84b";
      ctx.fillRect(x, 0, 1, height);
      ctx.fillStyle = "#f2b84b";
      ctx.fillText(s.name, x + 4, 11);
    }
    // bar numbers
    ctx.fillStyle = "#6b7385";
    for (let b = firstBar; b <= lastBar; b++) {
      const x = tickToX(barStartTick(score, b));
      if (x < KEY_W) continue;
      ctx.fillText(String(b + 1), x + 3, HEADER_H - 4);
    }
    // chords
    ctx.font = "bold 11px sans-serif";
    for (const c of score.chords) {
      const x = tickToX(c.start);
      if (x < KEY_W - 60 || x > width) continue;
      ctx.fillStyle = "#e6e8ee";
      ctx.fillText(c.symbol, x + 2, 25);
      ctx.fillStyle = "#3a4256";
      ctx.fillRect(x, 14, 1, 14);
    }
    // keys column
    ctx.fillStyle = "#181b23";
    ctx.fillRect(0, HEADER_H, KEY_W, height - HEADER_H);
    ctx.font = "10px sans-serif";
    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      const y = pitchToY(p);
      if (y + ROW_H < HEADER_H || y > height) continue;
      const pc = p % 12;
      const black = [1, 3, 6, 8, 10].includes(pc);
      ctx.fillStyle = black ? "#2a2f3b" : "#e6e8ee";
      ctx.fillRect(0, y + 1, KEY_W - 2, ROW_H - 1);
      if (pc === 0) {
        ctx.fillStyle = "#12141a";
        ctx.fillText(pitchName(p), 4, y + ROW_H - 2);
      }
    }
    ctx.fillStyle = "#181b23";
    ctx.fillRect(0, 0, KEY_W, HEADER_H);
    // cursor
    if (cursorTick !== null) {
      const x = tickToX(cursorTick);
      if (x >= KEY_W && x <= width) {
        ctx.fillStyle = "#ff6b6b";
        ctx.fillRect(x, 0, 2, height);
      }
    }
  }, [score, width, height, pxPerTick, scrollX, scrollY, selected, hover, drag, cursorTick, activeVoice, snap, tickToX, xToTick, pitchToY]);

  // ---------- interaction ----------
  const hitNote = (x: number, y: number): { note: Note; edge: boolean } | null => {
    const tick = xToTick(x);
    const pitch = yToPitch(y);
    // prefer active voice
    const candidates = score.notes.filter((n) => n.pitch === pitch && tick >= n.start && tick < n.start + n.duration);
    const note = candidates.find((n) => n.voice === activeVoice) ?? candidates[0];
    if (!note) return null;
    // The resize zone at the right end grows with the drawn width (at most 6 px, 30 % of the note), so most of
    // a short note still moves it; a note under 4 px always moves (zoom in with Ctrl+wheel to resize it).
    const startX = tickToX(note.start);
    const endX = tickToX(note.start + note.duration);
    const w = endX - startX;
    return { note, edge: w >= 4 && endX - x < Math.min(6, w * 0.3) };
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    if (x < KEY_W) return;
    if (y < HEADER_H) {
      onSeek?.(Math.max(0, Math.round(xToTick(x) / snap) * snap));
      return;
    }
    if (e.button === 2) return;
    const hit = hitNote(x, y);
    if (hit) {
      if (e.altKey) {
        onChange({ ...score, notes: score.notes.filter((n) => n.id !== hit.note.id) });
        if (selected.has(hit.note.id)) {
          const ids = new Set(selected);
          ids.delete(hit.note.id);
          onSelect(ids);
        }
        return;
      }
      let ids: Set<number>;
      if (e.shiftKey || e.ctrlKey) {
        ids = new Set(selected);
        ids.has(hit.note.id) ? ids.delete(hit.note.id) : ids.add(hit.note.id);
      } else if (selected.has(hit.note.id)) {
        ids = new Set(selected);
      } else {
        ids = new Set([hit.note.id]);
      }
      onSelect(ids);
      previewNote(hit.note.pitch, hit.note.voice);
      if (hit.edge) {
        onGestureStart?.();
        setDragNow({ kind: "resize", note: hit.note, startX: x, base: score.notes, duration: hit.note.duration, changed: false });
      } else {
        const moved = new Set([...ids].filter((id) => notesById.has(id)));
        if (moved.size === 0) return; // Shift/Ctrl+click took the last note out of the selection: nothing to drag
        const origin = [...moved].map((id) => notesById.get(id)!);
        onGestureStart?.();
        setDragNow({ kind: "move", ids: moved, startX: x, startY: y, base: score.notes, origin, dTick: 0, dPitch: 0, moved: false });
      }
      return;
    }
    if (e.ctrlKey || e.shiftKey) {
      setDragNow({ kind: "box", x0: x, y0: y, x1: x, y1: y });
      return;
    }
    // create a note on the active voice at the snapped position (a gesture: dragging sets its length)
    const tick = Math.max(0, Math.floor(xToTick(x) / snap) * snap);
    const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, yToPitch(y)));
    const created = createNote(score.notes, activeVoice, tick, pitch, snap);
    onGestureStart?.();
    onChange({ ...score, notes: created.notes }, { gesture: true });
    onSelect(new Set([created.note.id]));
    previewNote(pitch, activeVoice);
    setDragNow({ kind: "create", note: created.note, startX: x, base: score.notes, duration: snap, last: created.notes });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const drag = dragRef.current;
    if (!drag) {
      if (x >= KEY_W && y >= HEADER_H) {
        const tick = Math.max(0, Math.floor(xToTick(x) / snap) * snap);
        const pitch = yToPitch(y);
        // the same object when nothing changed: no re-render, no redraw
        setHover((h) => (h && h.tick === tick && h.pitch === pitch ? h : { tick, pitch }));
        setHoverEdge(hitNote(x, y)?.edge ?? false);
      } else {
        setHover((h) => (h === null ? h : null));
        setHoverEdge(false);
      }
      return;
    }
    if (drag.kind === "move") {
      const rawTick = Math.round((x - drag.startX) / pxPerTick / snap) * snap;
      const rawPitch = -Math.round((y - drag.startY) / ROW_H);
      // one offset for the whole selection, limited so that its spacing and out-of-view pitches are kept
      const { dTick, dPitch } = clampMoveDelta(drag.origin, rawTick, rawPitch, MIN_PITCH, MAX_PITCH);
      if (dTick === drag.dTick && dPitch === drag.dPitch) return; // nothing new to show
      const notes = moveGesture(drag.base, drag.ids, dTick, dPitch);
      setDragNow({ ...drag, dTick, dPitch, moved: true, last: notes });
      onChange({ ...score, notes }, { gesture: true });
    } else if (drag.kind === "resize" || drag.kind === "create") {
      const n = drag.note;
      const duration =
        drag.kind === "resize"
          ? Math.max(snap, n.duration + Math.round((x - drag.startX) / pxPerTick / snap) * snap)
          : Math.max(n.start + snap, Math.round(xToTick(x) / snap) * snap) - n.start;
      if (duration === drag.duration) return;
      const notes = resizeGesture(drag.base, n, duration);
      setDragNow(drag.kind === "resize" ? { ...drag, duration, changed: true, last: notes } : { ...drag, duration, last: notes });
      onChange({ ...score, notes }, { gesture: true });
    } else if (drag.kind === "box") {
      setDragNow({ ...drag, x1: x, y1: y });
    }
  };

  /**
   * End the drag (also when the pointer leaves the canvas): a note drag that sent steps always ends with one
   * onChange without `gesture`, the edit to keep or a revert (see noteDragEnd), so the editor never stays mid-drag.
   */
  const onMouseUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    // ended at once, so a second end in the same batch (mouse up, then leave) does nothing
    setDragNow(null);
    if (drag.kind === "box") {
      const t0 = xToTick(Math.min(drag.x0, drag.x1));
      const t1 = xToTick(Math.max(drag.x0, drag.x1));
      const pHi = yToPitch(Math.min(drag.y0, drag.y1));
      const pLo = yToPitch(Math.max(drag.y0, drag.y1));
      onSelect(boxSelect(score.notes, t0, t1, pLo, pHi, selected));
    } else {
      // the last step is the edit to keep, or the drag ended where it began (dragEndChange)
      const end = dragEndChange(drag);
      if (end) onChange({ ...score, notes: end.notes }, end.revert ? { revert: true } : undefined);
    }
  };

  // Wheel: a native non-passive listener (React's wheel listener is passive, so preventDefault would be ignored
  // and the page would scroll together with the roll). The ref holds the handler of the latest render.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const { x } = local(e);
      const tickAt = xToTick(x);
      const next = Math.max(0.02, Math.min(1.0, pxPerTick * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setPxPerTick(next);
      setScrollX(Math.max(0, tickAt * next - (x - KEY_W)));
      return;
    }
    // WebView2 (Chromium on Windows) turns Shift+wheel into deltaX with deltaY 0; touchpads send deltaX directly.
    const dx = e.shiftKey ? e.deltaX || e.deltaY : e.deltaX;
    const dy = e.shiftKey ? 0 : e.deltaY;
    if (dx) setScrollX((s) => Math.max(0, Math.min(totalTicks * pxPerTick, s + dx)));
    if (dy) setScrollY((s) => Math.max(0, Math.min(gridH - (height - HEADER_H), s + dy)));
  };
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = local(e);
    if (!inNoteArea(x, y)) return; // a hidden note under the header or the keys column is not deleted
    const hit = hitNote(x, y);
    if (hit) {
      const ids = selected.has(hit.note.id) ? selected : new Set([hit.note.id]);
      onChange({ ...score, notes: score.notes.filter((n) => !ids.has(n.id)) });
      onSelect(new Set());
    }
  };

  const resizeCursor = drag ? drag.kind === "resize" || drag.kind === "create" : hoverEdge;
  return (
    <div
      ref={wrapRef}
      className="pianoroll-wrap"
      tabIndex={0}
      onKeyDown={(e) => {
        // an edit key during a note drag would be undone by the drag's next step or its end (editKeyDuringDrag)
        if (editKeyDuringDrag(dragRef.current?.kind ?? null, e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          setHover(null);
          setHoverEdge(false);
          if (dragRef.current) onMouseUp();
        }}
        onContextMenu={onContextMenu}
        style={{ display: "block", cursor: resizeCursor ? "ew-resize" : "crosshair" }}
      />
      <div className="pianoroll-hint muted">
        {"クリック: 音符を追加 · ドラッグ: 移動 · 右端ドラッグ: 長さ · 右クリック / Alt+クリック: 削除 · Shift/Ctrl+クリック: 選択の切り替え · Ctrl+ドラッグ: 範囲選択 · Ctrl+ホイール: ズーム · Shift+ホイール: 横スクロール · "}
        {"Space: 試聴/停止 · Delete: 選択した音符を削除 · ↑↓: 半音（Shift で 1 オクターブ）· ←→: スナップ幅ずつ移動 · Ctrl+Z: 元に戻す · Ctrl+A: 声部の音符をすべて選択"}
        {hover ? ` · ${pitchName(hover.pitch)} @ 小節 ${barAtTick(score, hover.tick) + 1}` : ""}
      </div>
    </div>
  );
}
