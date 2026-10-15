// Guard: a 「フォルダを開く」 button must say why nothing opened. reveal_path rejects when no folder on the path exists
// any more (an unplugged drive, a gone network share) or Explorer fails; an unhandled rejection only reaches the
// WebView console, so the click silently does nothing. Every call chains .catch (usually an error toast).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

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

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The revealPath(...) calls of `code` that do not chain .catch. */
function unhandledReveals(code: string): string[] {
  const src = stripComments(code);
  const out: string[] = [];
  const call = /\brevealPath\s*\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    if (!/^\s*\.\s*catch\s*\(/.test(src.slice(i))) out.push(src.slice(m.index, i));
  }
  return out;
}

describe("revealPath calls", () => {
  it("detects the pattern it guards against", () => {
    expect(unhandledReveals(`onClick={() => api.revealPath(selected.folder)}`)).toEqual(["revealPath(selected.folder)"]);
    expect(unhandledReveals(`onClick={() => api.revealPath(f(a, b))}`)).toHaveLength(1);
    expect(unhandledReveals(`api.revealPath(p).catch(() => {});`)).toEqual([]);
    expect(unhandledReveals(`api\n  .revealPath(f(x))\n  .catch((e) => showToast("error", String(e)))`)).toEqual([]);
    // the api definition and comments are not calls
    expect(unhandledReveals(`revealPath: (path: string) => invoke<void>("reveal_path", { path }),\n// api.revealPath(x)`)).toEqual([]);
  });

  it("handle the rejection everywhere in src", () => {
    const files = sourceFiles(SRC);
    expect(files.some((f) => f.endsWith("LibraryPage.tsx"))).toBe(true);
    const counts: Record<string, number> = {};
    for (const file of files) {
      const n = unhandledReveals(readFileSync(file, "utf8")).length;
      if (n) counts[relative(SRC, file).replace(/\\/g, "/")] = n;
    }
    expect(counts).toEqual({});
  });
});
