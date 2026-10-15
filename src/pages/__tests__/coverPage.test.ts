import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import type { ChoiceRequest } from "../../components/ChoiceDialog";
import { appliedScoreOk, coverLengthOk, editedDuringTranscription } from "../CoverPage";

/** An ask() that answers from a script and records the questions. */
function scripted(...answers: (string | null)[]) {
  const asked: ChoiceRequest<string>[] = [];
  const ask = async <T extends string>(r: ChoiceRequest<T>): Promise<T | null> => {
    asked.push(r as ChoiceRequest<string>);
    return (answers.shift() ?? null) as T | null;
  };
  return { ask, asked };
}

describe("cover from the applied score", () => {
  it("generates without asking when the editor holds no unapplied ABC text", async () => {
    const { ask, asked } = scripted();
    expect(await appliedScoreOk(false, ask)).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("asks before generating from the applied score while ABC text is not applied (the screen shows another score)", async () => {
    const cancel = scripted(null);
    expect(await appliedScoreOk(true, cancel.ask)).toBe(false);
    expect(cancel.asked).toHaveLength(1);
    expect(cancel.asked[0].title).toBe("未反映の ABC テキスト");
    // the way to use the text is named (the page cannot apply the editor's text itself)
    expect(String(cancel.asked[0].message)).toContain("テキストを譜面に反映");

    const go = scripted("applied");
    expect(await appliedScoreOk(true, go.ask)).toBe(true);
  });
});

describe("cover length against the configured maximum", () => {
  it("generates without asking when the budget holds the score (or the score has no length)", async () => {
    const { ask, asked } = scripted();
    expect(await coverLengthOk(200, 235, ask)).toBe(true);
    expect(await coverLengthOk(235, 235, ask)).toBe(true);
    expect(await coverLengthOk(null, 60, ask)).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("asks as 作曲 and AI 編集 do when the maximum cuts the score off", async () => {
    const cancel = scripted(null);
    expect(await coverLengthOk(500, 300, cancel.ask)).toBe(false);
    expect(cancel.asked).toHaveLength(1);
    expect(cancel.asked[0].title).toBe("曲長の上限が譜面の長さより短くなっています");
    expect(String(cancel.asked[0].message)).toContain("曲の途中で切れる");
    expect(cancel.asked[0].choices.map((c) => c.label)).toEqual(["5:00 のまま生成"]);

    const go = scripted("asis");
    expect(await coverLengthOk(500, 300, go.ask)).toBe(true);
  });
});

describe("transcription result over an edited score", () => {
  const at = (editedAbc: string, scoreDirty = false) => ({ editedAbc, scoreDirty });

  it("replaces the score without asking when nothing was edited while it ran", () => {
    expect(editedDuringTranscription(at("X:1"), at("X:1"))).toBe(false);
    // ABC text left unapplied at the click: the user already agreed to replace it
    expect(editedDuringTranscription(at("X:1", true), at("X:1", true))).toBe(false);
    // the text was applied or reverted meanwhile without changing the score
    expect(editedDuringTranscription(at("X:1", true), at("X:1", false))).toBe(false);
  });

  it("asks when the score was edited while it ran", () => {
    // an applied edit (piano roll, applied text)
    expect(editedDuringTranscription(at("X:1"), at("X:1\nK:C"))).toBe(true);
    // ABC text typed and not applied
    expect(editedDuringTranscription(at("X:1"), at("X:1", true))).toBe(true);
    // unapplied text at the click, then applied: the score changed
    expect(editedDuringTranscription(at("X:1", true), at("X:2", false))).toBe(true);
  });
});

// The page's async guards (no DOM test setup here): read from the source, so removing one fails a test.
const PAGE = readFileSync(new URL("../CoverPage.tsx", import.meta.url), "utf8");

/** The body of the arrow function declared by `decl` (from its first "{" to the matching "}"). */
function body(decl: string): string {
  const at = PAGE.indexOf(decl);
  expect(at, decl).toBeGreaterThan(-1);
  const open = PAGE.indexOf("{", PAGE.indexOf("=>", at));
  let depth = 0;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === "{") depth++;
    else if (PAGE[i] === "}" && --depth === 0) return PAGE.slice(open, i + 1);
  }
  throw new Error(`unbalanced body of ${decl}`);
}

/** The source line of `code` around position `at`. */
const lineAt = (code: string, at: number) => code.slice(code.lastIndexOf("\n", at) + 1, code.indexOf("\n", at));

describe("カバー's guards against late results", () => {
  it("selects a queued cover only while カバー / 耳コピ is shown (a hidden page does not change what the other pages work on)", () => {
    for (const decl of ["const instrumentalCover = async (", "const cover = async ("]) {
      const f = body(decl);
      const calls = Array.from(f.matchAll(/\bselectSong\(/g), (m) => m.index);
      expect(calls, decl).toHaveLength(1);
      expect(calls[0], decl).toBeGreaterThan(f.indexOf("await api.generate("));
      expect(lineAt(f, calls[0]), decl).toMatch(/if \(visibility\.current\.active\) selectSong\(/);
    }
    // and nowhere else
    expect(PAGE.match(/\bselectSong\(/g)).toHaveLength(2);
  });

  it("asks before a transcription replaces a score edited while it ran, and keeps the edit when that is cancelled", () => {
    const transcribe = body("const transcribe = async (");
    const wait = transcribe.indexOf("await api.transcribeAudio(");
    expect(wait).toBeGreaterThan(-1);
    // the editor as it was at the click, after the redo question (what it agreed to replace is not asked about again)
    const atClick = transcribe.indexOf("const atClick = { editedAbc: formNow.current.editedAbc, scoreDirty: formNow.current.scoreDirty };");
    expect(atClick).toBeGreaterThan(transcribe.indexOf('title: "譜面を転写し直します"'));
    expect(atClick).toBeLessThan(wait);
    // against the editor as it is when the result arrives (formNow is set on every render)
    expect(PAGE).toMatch(/\n\s*formNow\.current = \{ abc, editedAbc, scoreDirty \};\n/);
    const late = transcribe.slice(wait);
    const check = late.indexOf("if (editedDuringTranscription(atClick, formNow.current)) {");
    expect(check).toBeGreaterThan(-1);
    // before anything the result writes
    const firstWrite = late.search(/\bset[A-Z]\w*\(/);
    expect(late.slice(firstWrite)).toMatch(/^setAbc\(result\);/);
    expect(check).toBeLessThan(firstWrite);
    const question = late.slice(check, firstWrite);
    expect(question).toContain('title: "転写中に譜面が編集されました"');
    expect(question).toMatch(/if \(!c\) \{\s*showToast\("info", "転写結果は反映しませんでした"\);\s*return;\s*\}/);
  });
});

describe("an instrumental cover of a score with bars shorter or longer than the meter", () => {
  it("says in the toast that the later bar lines were rewritten, naming the bars of the score it was converted from", () => {
    const inst = body("const instrumentalCover = async (");
    expect(inst).toMatch(/\{ score: parsed, irregularBars \} = parseAbcDetailed\(text\)/);
    const moved = inst.indexOf("irregularBarsNotice(irregularBars, true)");
    expect(moved).toBeGreaterThan(inst.indexOf("const notes = "));
    expect(moved).toBeLessThan(inst.indexOf("await api.generate("));
    expect(inst).toMatch(/if \(rebarred\) notes\.push\(rebarred\);/);
    expect(inst).toMatch(/\.\.\.notes\]\.join\("。"\)/);
  });
});
