// Guard: at the wizard's download step, 「中断」 takes the place of 「ダウンロード開始」 (the same slot of the row, the
// left edge fixed) as soon as the first click starts the download, so the second click of a double click lands on
// 中断. Both buttons ignore that second click (singleClick), or a double click starts the download and aborts it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WIZARD = fileURLToPath(new URL("../SetupWizard.tsx", import.meta.url));

/** The opening tag of the <button> whose text matches `label` (from `<button` up to the text). */
function buttonAttrs(code: string, label: RegExp): string {
  const at = code.search(label);
  expect(at, `button text ${label}`).toBeGreaterThan(-1);
  const open = code.lastIndexOf("<button", at);
  expect(open).toBeGreaterThan(-1);
  return code.slice(open, at);
}

describe("SetupWizard download buttons", () => {
  const code = readFileSync(WIZARD, "utf8");

  it("ignore the second click of a double click", () => {
    expect(buttonAttrs(code, /"中断"\}/)).toMatch(/onClick=\{singleClick\(/);
    // (the button's own text line, not the notice that names it)
    expect(buttonAttrs(code, /^\s*ダウンロード開始\s*$/m)).toMatch(/onClick=\{singleClick\(/);
  });
});
