import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { lookAtSelection, sourcePick } from "../../export/form";
import { selectionLoad } from "../keepAlive";
import { loadableSelection } from "../ExportPage";

const PAGE = fileURLToPath(new URL("../ExportPage.tsx", import.meta.url));
const code = readFileSync(PAGE, "utf8");

/** The body of the component's `const name = ...` (up to its next const at the same depth). */
const fn = (name: string): string => {
  const at = code.indexOf(`\n  const ${name} = `);
  expect(at, name).toBeGreaterThan(-1);
  return code.slice(at, code.indexOf("\n  const ", at + 1));
};

describe("「音声ファイルを選択」", () => {
  it("attaches the first file to times typed while no audio was chosen (they were not set against any audio)", () => {
    expect(sourcePick({ current: "", picked: "C:\\Music\\a.wav", timed: true })).toBe("attach");
    expect(sourcePick({ current: "", picked: "C:\\Music\\a.wav", timed: false })).toBe("attach");
    // with an audio: another file asks before its timings are reset, the source itself is kept
    expect(sourcePick({ current: "C:\\Music\\a.wav", picked: "C:\\Music\\b.wav", timed: true })).toBe("ask");
    expect(sourcePick({ current: "C:\\Music\\a.wav", picked: "C:\\Music\\b.wav", timed: false })).toBe("switch");
    expect(sourcePick({ current: "C:\\Music\\a.wav", picked: "c:/music/A.wav", timed: true })).toBe("keep");
  });

  it("keeps the typed times when it attaches the first file", () => {
    const pick = fn("pickSource");
    expect(pick).toMatch(/if \(pick !== "attach"\) \{\s*setLines\(\(ls\) => resetTimings\(ls\)\);/);
  });

  it("reads the source again when it is picked again (a file rewritten in place: its length and the tap player)", () => {
    const pick = fn("pickSource");
    // not a silent no-op any more
    expect(pick).not.toMatch(/if \(pick === "keep"\) return;/);
    // the player is remounted; the timings, lyrics and library link stay (no changeSource / resetTimings)
    const keep = pick.slice(pick.indexOf('if (pick === "keep") {'), pick.indexOf("} else {"));
    expect(keep).toContain("setTapUrl(null);");
    expect(keep).not.toContain("changeSource");
    expect(keep).not.toContain("resetTimings");
    // the length and the player's URL are read for every pick, the kept source included
    const tail = pick.slice(pick.indexOf("} else {"));
    expect(tail).toMatch(/const cur = sourceRef\.current;[\s\S]*api\s*\.audioDuration\(cur\)[\s\S]*api\s*\.fileUrl\(cur\)/);
  });
});

describe("the library selection around an export", () => {
  it("is not followed from the click on 書き出す on (its question and the save dialog), not only once the file is written", () => {
    expect(code).toMatch(/const doExport = \(\) =>\s*exportOnce\.run\(async \(\) => \{\s*setExportRunning\(true\);\s*try \{\s*await writeExport\(\);\s*\} finally \{\s*setExportRunning\(false\);/);
    expect(code).toContain("lookAtSelection(seen, { active, exporting: exportRunning, targetId: target?.id ?? null })");
    expect(code).toContain("}, [active, exportRunning, selected?.id, selectedDone]);");
  });

  it("keeps the result of the file just written: a song selected or finished meanwhile is not loaded over it", () => {
    const song = (id: string, status: "done" | "running") => ({ id, status });
    // A is loaded and exported; B is selected in ライブラリ meanwhile (the page does not look while it exports)
    let seen = lookAtSelection("A", { active: true, exporting: true, targetId: "B" }).seen;
    expect(seen).toBe("A");
    // the result is shown: the selection at that moment counts as seen
    seen = loadableSelection([song("A", "done"), song("B", "done")], "B");
    const look = lookAtSelection(seen, { active: true, exporting: false, targetId: "B" });
    expect(look).toEqual({ look: true, seen: "B" });
    expect(selectionLoad({ active: true, selectedId: "B", loadedId: "A", seenId: seen, hasWork: false, keepable: true })).toBe("none");
    // a selected song still rendering at the end of the export: its completion afterwards is new to the page
    expect(loadableSelection([song("S", "running")], "S")).toBeNull();
    expect(loadableSelection([song("A", "done")], null)).toBeNull();
    expect(loadableSelection([song("A", "done")], "gone")).toBeNull();

    const write = fn("writeExport");
    expect(write).toMatch(/if \(sourceRef\.current === req\.source\) \{\s*setResult\(r\);[\s\S]*seenSel\.current = loadableSelection\(st\.songs, st\.selectedSongId\);\s*\}/);
  });
});

describe("automatic timing of a song deleted while it runs", () => {
  it("ends as 中止 with a notice, not as a red failure (the user deleted it; the backend keeps no stems)", () => {
    const align = fn("autoAlign");
    const caught = align.slice(align.indexOf("} catch (e) {"));
    expect(caught).toMatch(/if \(songId !== null && deletedIds\.current\.has\(songId\)\) \{\s*(?:\/\/[^\n]*\n\s*)*setTool\(null\);\s*showToast\("info", noticeFrom\("曲がライブラリから削除されたため、タイミングの自動検出を中止しました"/);
    expect(caught.indexOf("deletedIds.current.has(songId)")).toBeLessThan(caught.indexOf('showToast("error"'));
  });
});

describe("a line's time field", () => {
  it("starts its edit on the first key when it got the focus without onFocus (a dialog gave it back while React ignored the event)", () => {
    // else the typed time would be dropped on Enter: commit() needs the text the edit started from
    expect(code).toMatch(/onChange=\{\(e\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(shown\.current === null\) shown\.current = formatLrcTime\(timeMs\);\s*setDraft\(e\.target\.value\);/);
  });
});
