// The in-app help of a page (the dialog opened by the page's ヘルプ button or F1): data only. Text uses the page's
// own words for its controls, in 「」; `…` marks code (paths, file names, tags). No HTML.
import type { Page } from "../store";

/** One row of a page's control table: a control as the page shows it. */
export interface HelpField {
  /** the control's name as on screen (label, button, heading of a group) */
  name: string;
  /** what it means and does */
  desc: string;
  /** what can be entered or chosen (a range with its unit, the choices) */
  range?: string;
  /** the value it starts with */
  def?: string;
  /** more short notes, one sentence each */
  notes?: string[];
  /**
   * The text the help's tests look for in the page's source (the help stays in step with the screen): `name` by
   * default; another literal part of the label when the screen builds it (e.g. 「自動（既定」); null when the row
   * names no literal text on screen (a group of chips, a computed status line).
   */
  ui?: string | null;
}

export type HelpBlock =
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "steps"; items: string[] }
  /** the controls of one panel: `title` is the panel's heading as on screen */
  | { kind: "fields"; title: string; rows: HelpField[] }
  | { kind: "note"; tone: "tip" | "warn"; text: string }
  | { kind: "faq"; items: { q: string; a: string }[] };

export interface HelpSection {
  /** the section's id in the dialog (lower-case letters, digits and "-"; unique in its page's help) */
  id: string;
  title: string;
  /** a panel of the page (its title is the panel's heading): grouped under 「画面の各部」 in the table of contents */
  panel?: boolean;
  /** another group heading in the table of contents (e.g. 「アプリ全体」), over the consecutive sections that name it */
  group?: string;
  blocks: HelpBlock[];
}

export interface HelpDoc {
  page: Page;
  /** the page's sidebar name (PAGE_LABEL) */
  title: string;
  sections: HelpSection[];
}
