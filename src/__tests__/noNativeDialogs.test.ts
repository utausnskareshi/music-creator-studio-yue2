// Guard: window.confirm / alert / prompt must not be used. Under tauri-plugin-dialog they are replaced by async
// functions (confirm() returns a Promise, which is always truthy), so `if (!confirm(...)) return` never stops a
// destructive action. Use useChoiceDialog (src/components/ChoiceDialog.tsx) instead.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** A bare or window.-qualified call; other objects' methods (e.g. dialog.confirm()) are not matched. */
const NATIVE_CALL = /(?:^|[^.\w$])(?:window\s*\.\s*)?(confirm|alert|prompt)\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Comments removed (a mention like "window.confirm (OK / Cancel only)" is not a call). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function nativeDialogCalls(code: string): string[] {
  return stripComments(code)
    .split("\n")
    .filter((line) => NATIVE_CALL.test(line))
    .map((line) => line.trim());
}

describe("native dialogs", () => {
  it("detects the patterns it guards against", () => {
    expect(nativeDialogCalls(`if (!confirm("削除しますか？")) return;`)).toHaveLength(1);
    expect(nativeDialogCalls(`window.alert("x")`)).toHaveLength(1);
    expect(nativeDialogCalls(`const v = prompt ("名前")`)).toHaveLength(1);
    expect(nativeDialogCalls(`await dialog.confirm("x"); confirmSung(); buildPrompt(a); const prompt = "p";`)).toHaveLength(0);
    expect(nativeDialogCalls(`// window.confirm (OK / Cancel only)\n/* alert(1) */`)).toHaveLength(0);
  });

  it("are not called anywhere in src", () => {
    const hits: string[] = [];
    const files = sourceFiles(SRC);
    expect(files.some((f) => f.endsWith("App.tsx"))).toBe(true);
    for (const file of files) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      for (const line of nativeDialogCalls(readFileSync(file, "utf8"))) hits.push(`${rel}: ${line}`);
    }
    expect(hits).toEqual([]);
  });
});
