// The help must say what the pages show: these tests fail when a page's help names a label the page no longer has,
// misses a panel, or when the help and the page's sources disagree on a value they both state.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELP, HELP_ORDER } from "..";
import { PAGE_LABEL } from "../../pages/keepAlive";
import type { Page } from "../../store";
import { plainText } from "../inline";
import { foldWithMap, helpKey } from "../search";
import type { HelpBlock, HelpDoc } from "../types";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Comments removed (a label must be on screen, not only mentioned in a comment). */
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SCORE = ["components/ScoreEditor.tsx", "components/PianoRoll.tsx", "components/scoreEditorState.ts", "abc/model.ts"];
const LYRICS = ["components/LyricsEditor.tsx", "components/SectionFitTable.tsx", "lyrics/sectionTags.ts"];
const TOOL = ["components/ToolCancelButton.tsx", "components/toolRun.ts"];

/** The files whose text a page shows: the page and the components it renders (for each page's help). */
const SOURCES: Record<Page, string[]> = {
  compose: ["pages/ComposePage.tsx", ...LYRICS, "components/StyleBuilder.tsx", ...SCORE, "components/Player.tsx", "components/ProgressPanel.tsx", ...TOOL, "compose/rules.ts", "library/songMeta.ts", "store.ts"],
  cover: ["pages/CoverPage.tsx", ...LYRICS, "components/StyleBuilder.tsx", ...SCORE, "components/Player.tsx", "components/ProgressPanel.tsx", ...TOOL, "compose/rules.ts", "library/songMeta.ts", "store.ts"],
  edit: ["pages/EditPage.tsx", ...LYRICS, ...SCORE, "components/Player.tsx", "components/ProgressPanel.tsx", "compose/rules.ts", "pages/keepAlive.ts", "store.ts"],
  separate: ["pages/SeparatePage.tsx", "components/Player.tsx", ...TOOL],
  export: ["pages/ExportPage.tsx", "components/Player.tsx", ...TOOL, "export/form.ts", "export/syncedLines.ts", "pages/keepAlive.ts"],
  library: ["pages/LibraryPage.tsx", "components/Player.tsx", "library/songMeta.ts"],
  settings: ["pages/SettingsPage.tsx", "config/rules.ts", "compose/rules.ts"],
};

/** The files whose panels (h3) and collapsible parts (summary) a page shows. */
const PANEL_SOURCES: Record<Page, string[]> = {
  compose: ["pages/ComposePage.tsx", "components/ProgressPanel.tsx"],
  cover: ["pages/CoverPage.tsx", "components/ProgressPanel.tsx"],
  edit: ["pages/EditPage.tsx", "components/ProgressPanel.tsx"],
  separate: ["pages/SeparatePage.tsx"],
  export: ["pages/ExportPage.tsx"],
  library: ["pages/LibraryPage.tsx"],
  settings: ["pages/SettingsPage.tsx"],
};

const sourceText = (page: Page) => SOURCES[page].map((f) => stripComments(read(f))).join("\n");

/** The pages checked: all, or the one named by HELP_PAGE (while writing one page's help). */
const PAGES: readonly Page[] = process.env.HELP_PAGE ? [process.env.HELP_PAGE as Page] : HELP_ORDER;

/** Every string of a block, as written (with its code marks). */
function blockStrings(b: HelpBlock): string[] {
  switch (b.kind) {
    case "text":
    case "note":
      return [b.text];
    case "list":
    case "steps":
      return b.items;
    case "fields":
      return [b.title, ...b.rows.flatMap((r) => [r.name, r.desc, r.range ?? "", r.def ?? "", ...(r.notes ?? [])])].filter(Boolean);
    case "faq":
      return b.items.flatMap((it) => [it.q, it.a]);
  }
}

const docStrings = (doc: HelpDoc): string[] => [doc.title, ...doc.sections.flatMap((s) => [s.title, ...s.blocks.flatMap(blockStrings)])];

/** The doc as one text (code marks removed), to look things up in. */
const docText = (doc: HelpDoc) => docStrings(doc).map(plainText).join("\n");

describe("the help of every page", () => {
  it("has a help for each sidebar page, in the sidebar's order, named as the sidebar names it", () => {
    expect(HELP_ORDER).toEqual(Object.keys(PAGE_LABEL));
    for (const page of PAGES) {
      expect(HELP[page].page).toBe(page);
      expect(HELP[page].title).toBe(PAGE_LABEL[page]);
    }
  });

  it("has sections with unique ids, and no empty section, block or row", () => {
    for (const page of PAGES) {
      const ids = HELP[page].sections.map((s) => s.id);
      expect(new Set(ids).size, page).toBe(ids.length);
      for (const s of HELP[page].sections) {
        expect(s.id, `${page}`).toMatch(/^[a-z0-9-]+$/);
        expect(s.title.trim(), `${page}/${s.id}`).not.toBe("");
        expect(s.blocks.length, `${page}/${s.id}`).toBeGreaterThan(0);
        for (const b of s.blocks) {
          for (const t of blockStrings(b)) expect(t.trim(), `${page}/${s.id}`).not.toBe("");
          if (b.kind === "list" || b.kind === "steps" || b.kind === "faq") expect(b.items.length, `${page}/${s.id}`).toBeGreaterThan(0);
          if (b.kind === "fields") expect(b.rows.length, `${page}/${s.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("starts with what the page is for and how to use it", () => {
    for (const page of PAGES) expect(HELP[page].sections.slice(0, 2).map((s) => s.id), page).toEqual(["overview", "workflow"]);
  });

  it.skipIf(!PAGES.includes("settings"))("has the app's own sections in the help of 設定", () => {
    const ids = HELP.settings.sections.map((s) => s.id);
    for (const id of ["about", "requirements", "limits", "troubleshooting", "install", "uninstall"]) {
      expect(ids).toContain(id);
      // listed together under one heading in the table of contents
      expect(HELP.settings.sections.find((s) => s.id === id)?.group).toBe("アプリ全体");
    }
  });

  it("names only labels that the page shows (the help is changed with the screen)", () => {
    for (const page of PAGES) {
      const src = sourceText(page);
      for (const s of HELP[page].sections)
        for (const b of s.blocks) {
          if (b.kind !== "fields") continue;
          for (const r of b.rows) {
            if (r.ui === null) continue;
            const needle = r.ui ?? r.name;
            expect(src.includes(needle), `${page}: 「${needle}」 is not in ${SOURCES[page].join(", ")}`).toBe(true);
          }
        }
    }
  });

  it("covers every panel of the page and every collapsible part", () => {
    for (const page of PAGES) {
      const doc = HELP[page];
      const panels = new Set([...doc.sections.filter((s) => s.panel).map((s) => s.title), ...doc.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "fields" ? [b.title] : [])))]);
      const text = docText(doc);
      for (const file of PANEL_SOURCES[page]) {
        const code = stripComments(read(file));
        for (const m of code.matchAll(/<h3[^>]*>([^<{]+)<\/h3>/g)) expect(panels.has(m[1].trim()), `${page}: panel 「${m[1].trim()}」 (${file}) has no table in the help`).toBe(true);
        for (const m of code.matchAll(/<summary[^>]*>([^<{]+)/g)) {
          const name = m[1].split(/[（(]/)[0].trim();
          if (name) expect(text.includes(name), `${page}: 「${name}」 (${file}) is not in the help`).toBe(true);
        }
      }
    }
  });

  it("searches its text as it is shown (the search marks map back to every character)", () => {
    for (const page of PAGES)
      for (const t of docStrings(HELP[page])) {
        const plain = plainText(t);
        expect(foldWithMap(plain).key, `${page}: ${plain}`).toBe(helpKey(plain));
      }
  });

  it("closes every code mark", () => {
    for (const page of PAGES) for (const t of docStrings(HELP[page])) expect((t.match(/`/g) ?? []).length % 2, `${page}: ${t}`).toBe(0);
  });
});
