// An editor action that waits for a dialog or a file (an import, the question about unapplied ABC text) must not
// land on another song's score: on 作曲 two songs (variations of one fixed score) can have the same score text,
// so selecting the other one loads nothing, and the action would reach the page as an edit of the first song.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { loadCheck, type LoadState } from "../ScoreEditor";
import { irregularBarsNotice, pickAndRead } from "../scoreEditorState";
import { currentScoreAbc } from "../scoreText";
import { parseAbc, parseAbcDetailed } from "../../abc/parse";
import { serializeAbc } from "../../abc/serialize";

const SOURCE = readFileSync(new URL("../ScoreEditor.tsx", import.meta.url), "utf8");
/** The editor's source from `from` up to `to`. */
function code(from: string, to: string): string {
  const start = SOURCE.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = SOURCE.indexOf(to, start);
  expect(end, to).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("an editor action that waits", () => {
  it("still acts while the editor shows the score it started on", () => {
    const state: LoadState = { mounted: true, load: 3, key: "song-1" };
    const isCurrent = loadCheck(() => state);
    expect(isCurrent()).toBe(true);
    // a re-render with the same song and score changes nothing
    state.key = "song-1";
    expect(isCurrent()).toBe(true);
  });

  it("is dropped when another score was loaded, the editor unmounted, or another song took the same score", () => {
    for (const change of [{ load: 4 }, { mounted: false }, { key: "song-2" }, { key: undefined }]) {
      const state: LoadState = { mounted: true, load: 3, key: "song-1" };
      const isCurrent = loadCheck(() => state);
      Object.assign(state, change);
      expect(isCurrent(), JSON.stringify(change)).toBe(false);
    }
  });

  it("drops an import whose file dialog was open while the selection moved to a variation with the same score", async () => {
    const state: LoadState = { mounted: true, load: 1, key: "song-1" };
    const read = vi.fn(async () => [1, 2, 3]);
    const picked = pickAndRead(
      async () => {
        // a variation finishes and is followed: the same score text, so the editor loads nothing
        state.key = "song-2";
        return "C:/scores/a.mid";
      },
      read,
      loadCheck(() => state),
    );
    expect(await picked).toEqual({ kind: "stale" });
    expect(read).not.toHaveBeenCalled();
  });

  it("is how the editor checks after every dialog and file read", () => {
    expect(code("const sameLoad = ", "\n")).toMatch(/loadCheck\(\(\) => \(\{ mounted: mountedRef\.current, load: loadRef\.current, key: loadKeyRef\.current \}\)\)/);
    expect(SOURCE).toMatch(/loadKeyRef\.current = loadKey;/);
    expect(code("const importFile = async", "const importMidi")).toMatch(/const isCurrent = sameLoad\(\);/);
    for (const [from, to] of [
      ["const pendingTextOk = async", "const undo = async"],
      ["const switchTab = async", "const transpose = async"],
    ]) {
      const fn = code(from, to);
      expect(fn, from).toMatch(/const isCurrent = sameLoad\(\);/);
      expect(fn, from).toMatch(/if \(c === null \|\| !isCurrent\(\)\) return/);
    }
    // no check of the load count alone
    expect(SOURCE).not.toMatch(/loadRef\.current !== /);
  });
});

// 「インストゥルメンタル版を生成」 sends what 「この譜面で生成」 sends: the score's text as taken in until it is edited.
// Sending the re-serialized score instead hid the bar lines it moves: 作曲 (renderInstrumentalFromAbc) says when the
// conversion re-bars a score, and finds nothing to say in text that was already re-barred.
describe("「インストゥルメンタル版を生成」", () => {
  const HEAD = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n';
  const PICKUP = `${HEAD}% verse\nV: Vocal\nG4|"C"c4B4A4G4|"F"A16|\nV: Ins\nz4|C16|F16|\n`;

  it("lets 作曲 tell about the bar lines of an unedited score", () => {
    const s = parseAbc(PICKUP);
    const sent = currentScoreAbc({ dirty: false, hasScore: true, source: PICKUP, serialized: () => serializeAbc(s), text: "" });
    expect(sent).toBe(PICKUP);
    expect(irregularBarsNotice(parseAbcDetailed(sent).irregularBars, true)).toContain("小節線を拍子どおりの位置に書き直しました");
    // what it sent before: already re-barred, so nothing to tell
    expect(parseAbcDetailed(serializeAbc(s)).irregularBars).toEqual([]);
    // an edited score is sent as serialized; one that cannot be written sends nothing (the editor says why)
    expect(currentScoreAbc({ dirty: true, hasScore: true, source: PICKUP, serialized: () => "X:1 edited", text: "" })).toBe("X:1 edited");
    expect(currentScoreAbc({ dirty: true, hasScore: true, source: PICKUP, serialized: () => "", text: "" })).toBe("");
  });

  it("is how the editor sends it", () => {
    const fn = code("const renderInstrumental = async", "// Keyboard shortcuts");
    expect(fn).toMatch(/currentScoreAbc\(\{ dirty, hasScore: true, source, serialized: \(\) => serializedOf\(score\), text: "" \}\)/);
    expect(fn).toMatch(/onRenderInstrumental\(abcNow\)/);
    expect(fn).not.toMatch(/onRenderInstrumental\(serialized\)/);
  });
});
