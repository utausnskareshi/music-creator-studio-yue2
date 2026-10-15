import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { HELP, HELP_ORDER } from "../../help";
import type { Page } from "../../store";
import HelpView, { type HelpViewProps } from "../HelpView";
import PageHeader from "../PageHeader";

const noop = () => {};
const render = (page: Page, query = "", input = query) => {
  const props: HelpViewProps = {
    docs: HELP,
    order: HELP_ORDER,
    page,
    input,
    query,
    titleId: "t",
    onInput: noop,
    onCompositionEnd: noop,
    onClear: noop,
    onPage: noop,
    onSection: noop,
    onClose: noop,
  };
  return renderToStaticMarkup(createElement(HelpView, props));
};

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the help view", () => {
  it("shows a page's help as a labelled dialog with the pages, the contents and the tables", () => {
    for (const page of HELP_ORDER) {
      const html = render(page);
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('aria-labelledby="t"');
      expect(html).toContain(`ヘルプ: ${HELP[page].title}`);
      // one entry per page and one per section
      expect(html.match(/class="nav-btn help-nav-item/g)).toHaveLength(HELP_ORDER.length + HELP[page].sections.length);
      expect(html.match(/<section /g)).toHaveLength(HELP[page].sections.length);
      // never a link (it would take the window away from the app)
      expect(html).not.toMatch(/<a[\s>]/);
    }
    const sep = render("separate");
    expect(sep).toContain("<table>");
    expect(sep).toContain("範囲・既定値");
    expect(sep).toContain("<code>separated</code>");
    // the panels are grouped in the contents, and so are the app's own sections in 設定 (once each)
    expect(sep).toContain("画面の各部");
    const settings = render("settings");
    expect(settings.match(/class="help-nav-group">画面の各部</g)).toHaveLength(1);
    expect(settings.match(/class="help-nav-group">アプリ全体</g)).toHaveLength(1);
  });

  it("marks what the search found, counts it, and offers the other pages' help when this page has none", () => {
    const found = render("separate", "ボーカル");
    expect(found).toContain("<mark>ボーカル</mark>");
    expect(found).toMatch(/\d+ 件/);
    const none = render("separate", "存在しない語ｘｙｚ");
    expect(none).toContain("この画面のヘルプには見つかりません");
    expect(none).toContain("どの画面のヘルプにも見つかりません");
    // a blank query filters nothing
    expect(render("separate", "   ")).not.toContain("件<");
  });

  it("keeps the step numbers of the steps a search leaves", () => {
    const html = render("separate", "出力フォルダを開く");
    expect(html).toMatch(/<li value="4">/);
  });
});

describe("the help dialog's source", () => {
  const dialog = read("HelpDialog.tsx");
  const view = read("HelpView.tsx");

  it("joins the questions' stack once per opening and leaves it on close", () => {
    expect(dialog).toMatch(/const \{ id, z \} = joinDialogStack\(takeFocus\);/);
    expect(dialog).toMatch(/helpKeyAction\(e, isOnTopOfStack\(id\)\)/);
    // the focus goes back once React's change is done (so the opener's own focus handler runs), unless something has it
    expect(dialog).toMatch(
      /if \(leaveDialogStack\(id\)\) \{\s*queueMicrotask\(\(\) => \{\s*const active = document\.activeElement;[\s\S]*?if \(active && active !== document\.body\) return;\s*if \(opener && opener\.isConnected\) opener\.focus\(\{ preventScroll: true \}\);\s*if \(!opener \|\| document\.activeElement !== opener\) focusStackTop\(\);/,
    );
    // the opener is read once per opening (StrictMode runs the effect twice in development)
    expect(dialog).toMatch(/if \(openerRef\.current === undefined\) \{[\s\S]*?openerRef\.current = active instanceof HTMLElement && active !== document\.body \? active : null;\s*\}\s*const opener = openerRef\.current;/);
    expect(dialog.match(/addEventListener\("keydown", onKey, \{ capture: true \}\)/g)).toHaveLength(1);
    expect(dialog.match(/removeEventListener\("keydown", onKey, \{ capture: true \}\)/g)).toHaveLength(1);
    // the effect that registers the listener runs once: registered again, it would come after a question's
    const effect = dialog.slice(dialog.indexOf("useLayoutEffect(() => {"), dialog.indexOf("// another page's help"));
    expect(effect.trimEnd()).toMatch(/\}, \[\]\);$/);
  });

  it("handles every key in its window listener (the listener stops them before React's handlers)", () => {
    for (const src of [dialog, view]) {
      expect(src).not.toMatch(/onKeyDown|onKeyUp|autoFocus/);
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });

  it("keeps the focus in the dialog when a page picked in the empty search's list takes its button away", () => {
    expect(dialog).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(paneRef\.current\) paneRef\.current\.scrollTop = 0;\s*if \(modalRef\.current && !modalRef\.current\.contains\(document\.activeElement\)\) paneRef\.current\?\.focus\(\{ preventScroll: true \}\);\s*\}, \[page, query\]\);/,
    );
  });

  it("closes on a deliberate press outside without losing the focus, and on its button without a double click", () => {
    expect(dialog).toMatch(/onMouseDown=\{\(e\) => \{\s*if \(e\.target !== e\.currentTarget\) return;[\s\S]*?e\.preventDefault\(\);\s*cancelOnBackdropPress\(\(\) => closeRef\.current\(\)\)\(e\);/);
    expect(dialog).toMatch(/onClose=\{answerOnPress\(\(\) => closeRef\.current\(\), null\)\}/);
  });
});

describe("the page headers", () => {
  const pages: Record<Page, string> = {
    compose: "ComposePage",
    cover: "CoverPage",
    edit: "EditPage",
    separate: "SeparatePage",
    export: "ExportPage",
    library: "LibraryPage",
    settings: "SettingsPage",
  };

  it("give every sidebar page its title and help button", () => {
    for (const [page, file] of Object.entries(pages)) {
      const src = readFileSync(new URL(`../../pages/${file}.tsx`, import.meta.url), "utf8");
      expect(src.match(/<PageHeader page="/g), file).toHaveLength(1);
      expect(src, file).toContain(`<PageHeader page="${page}"`);
      expect(src, file).not.toContain('className="page-title"');
    }
  });

  it("show the page's name and a button that opens its help", () => {
    const html = renderToStaticMarkup(createElement(PageHeader, { page: "export" }));
    expect(html).toContain('<h1 class="page-title">書き出し</h1>');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-keyshortcuts="F1"');
    expect(html).toContain("ヘルプ");
  });

  it("are served by the shell: one help dialog outside the pages, and F1", () => {
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    expect(app.match(/<HelpDialog \/>/g)).toHaveLength(1);
    expect(app).toMatch(/if \(!isHelpKey\(e\)\) return;\s*e\.preventDefault\(\);\s*if \(anyDialogOpen\(\)\) return;/);
    expect(app).toMatch(/window\.addEventListener\("keydown", onKey, \{ capture: true \}\);/);
    expect(app).toMatch(/useStore\.getState\(\)\.closeHelp\(\);/);
  });
});
