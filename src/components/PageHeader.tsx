// A page's title row: the page's name, what the page shows next to it, and the button that opens the page's help
// (F1 opens the same help; HelpDialog.tsx).
import type { ReactNode } from "react";
import { useStore, type Page } from "../store";
import { PAGE_LABEL } from "../pages/keepAlive";

export default function PageHeader({ page, children }: { page: Page; children?: ReactNode }) {
  const openHelp = useStore((s) => s.openHelp);
  return (
    <div className="row between page-header">
      <h1 className="page-title">{PAGE_LABEL[page]}</h1>
      <div className="row">
        {children}
        <button type="button" className="btn sm help-btn" aria-haspopup="dialog" aria-keyshortcuts="F1" title="この画面のヘルプ（F1）" onClick={() => openHelp(page)}>
          <span aria-hidden="true">？</span>
          ヘルプ
        </button>
      </div>
    </div>
  );
}
