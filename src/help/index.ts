// The help of every sidebar page (HelpDialog.tsx), in the sidebar's order. When a page's controls, labels or panels
// change, change its help too: src/help/__tests__/content.test.ts fails when the help names a label the page no
// longer has, or misses a panel.
import type { Page } from "../store";
import type { HelpDoc } from "./types";
import { composeHelp } from "./content/compose";
import { coverHelp } from "./content/cover";
import { editHelp } from "./content/edit";
import { separateHelp } from "./content/separate";
import { exportHelp } from "./content/export";
import { libraryHelp } from "./content/library";
import { settingsHelp } from "./content/settings";

export const HELP_ORDER: readonly Page[] = ["compose", "cover", "edit", "separate", "export", "library", "settings"];

export const HELP: Record<Page, HelpDoc> = {
  compose: composeHelp,
  cover: coverHelp,
  edit: editHelp,
  separate: separateHelp,
  export: exportHelp,
  library: libraryHelp,
  settings: settingsHelp,
};
