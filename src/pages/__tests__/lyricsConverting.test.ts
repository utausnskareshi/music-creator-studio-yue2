// Guard: while the lyrics editor converts to hiragana (or checks its hiragana version before discarding it), a send
// would sing the text the result is about to replace. Every page that has the editor hears about it (onBusyChange)
// and its generate buttons wait (pages/locks.ts "converting").
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PAGES = fileURLToPath(new URL("..", import.meta.url));

/** Each <LyricsEditor .../> element in `code` (up to its "/>" at the indent it starts at; a prop may hold JSX). */
function editorTags(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^([ \t]*)<LyricsEditor\b/gm)) {
    const end = code.indexOf(`\n${m[1]}/>`, m.index);
    expect(end, "a multi-line <LyricsEditor> closed at its own indent").toBeGreaterThan(m.index);
    out.push(code.slice(m.index, end));
  }
  return out;
}

/** The opening tag of the <button> whose content matches `label` (from `<button` up to the content). */
function buttonAttrs(code: string, label: RegExp): string {
  const at = code.search(label);
  expect(at, `button content ${label}`).toBeGreaterThan(-1);
  return code.slice(code.lastIndexOf("<button", at), at);
}

describe("the lyrics editor's hiragana conversion", () => {
  it("is reported to every page that shows the editor", () => {
    const pages = readdirSync(PAGES).filter((f) => f.endsWith(".tsx"));
    let editors = 0;
    for (const page of pages) {
      for (const tag of editorTags(readFileSync(join(PAGES, page), "utf8"))) {
        editors++;
        expect(tag, page).toMatch(/onBusyChange=\{/);
      }
    }
    // 作曲, カバー, AI 編集
    expect(editors).toBeGreaterThanOrEqual(3);
  });

  it("holds AI 編集's 「この譜面で再生成」 until it ends", () => {
    const code = readFileSync(join(PAGES, "EditPage.tsx"), "utf8");
    const render = buttonAttrs(code, /\{renderLabel\}/);
    expect(render).toMatch(/disabled=\{[^}]*\blyricsConverting\b/);
    expect(render).toMatch(/LOCK_HINT\.converting/);
  });
});
