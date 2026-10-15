// The help dialog's content: header with the search box, the list of pages and the table of contents on the left,
// the help on the right. Display only (HelpDialog.tsx owns the state, the keyboard and the dialog stack), so it can
// be rendered on its own in tests. No links: text is shown as text (a link would take the window away from the app).
import { Fragment, useMemo, type RefObject } from "react";
import type { Page } from "../store";
import { countDoc, filterDoc, markInline, otherPageCounts, type ShownBlock } from "../help/search";
import type { HelpDoc } from "../help/types";

export interface HelpViewProps {
  docs: Record<Page, HelpDoc>;
  /** the pages in the sidebar's order */
  order: readonly Page[];
  /** the page whose help is shown */
  page: Page;
  /** the search box's text (it may hold an unconverted IME text) */
  input: string;
  /** what the help is filtered with (the box's text once converted) */
  query: string;
  titleId: string;
  onInput: (text: string, composing: boolean) => void;
  onCompositionEnd: (text: string) => void;
  onClear: () => void;
  onPage: (p: Page) => void;
  onSection: (id: string) => void;
  onClose: (e: { detail: number }) => void;
  modalRef?: RefObject<HTMLDivElement | null>;
  searchRef?: RefObject<HTMLInputElement | null>;
  paneRef?: RefObject<HTMLDivElement | null>;
}

/** Text with its code pieces and search marks. */
export function Inline({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {markInline(text, terms).map((p, i) => {
        const t = p.mark ? <mark>{p.text}</mark> : p.text;
        return p.code ? <code key={i}>{t}</code> : <Fragment key={i}>{t}</Fragment>;
      })}
    </>
  );
}

function Block({ block, terms, sectionTitle }: { block: ShownBlock; terms: readonly string[]; sectionTitle: string }) {
  switch (block.kind) {
    case "text":
      return (
        <p className="help-text">
          <Inline text={block.text} terms={terms} />
        </p>
      );
    case "list":
      return (
        <ul className="help-list">
          {block.items.map((t, i) => (
            <li key={i}>
              <Inline text={t} terms={terms} />
            </li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <ol className="help-list">
          {block.items.map((t, i) => (
            <li key={i} value={block.numbers[i]}>
              <Inline text={t} terms={terms} />
            </li>
          ))}
        </ol>
      );
    case "note":
      return (
        <div className={`help-note ${block.tone}`}>
          <span className="help-note-label">{block.tone === "warn" ? "注意" : "ヒント"}</span>
          <span>
            <Inline text={block.text} terms={terms} />
          </span>
        </div>
      );
    case "faq":
      return (
        <dl className="help-faq">
          {block.items.map((it, i) => (
            <Fragment key={i}>
              <dt>
                <Inline text={it.q} terms={terms} />
              </dt>
              <dd>
                <Inline text={it.a} terms={terms} />
              </dd>
            </Fragment>
          ))}
        </dl>
      );
    case "fields": {
      const values = block.rows.some((r) => r.range || r.def);
      return (
        <div className="help-fields">
          {/* a part of the panel (e.g. 詳細パラメータ) gets its own heading; the panel's own table has the section's */}
          {block.title !== sectionTitle && (
            <h4>
              <Inline text={block.title} terms={terms} />
            </h4>
          )}
          <table>
            <thead>
              <tr>
                <th className="help-col-name">項目</th>
                <th>説明</th>
                {values && <th className="help-col-values">範囲・既定値</th>}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row" className="help-col-name">
                    <Inline text={r.name} terms={terms} />
                  </th>
                  <td>
                    <Inline text={r.desc} terms={terms} />
                    {r.notes && r.notes.length > 0 && (
                      <ul className="help-notes">
                        {r.notes.map((n, j) => (
                          <li key={j}>
                            <Inline text={n} terms={terms} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  {values && (
                    <td className="help-col-values">
                      {r.range && (
                        <div>
                          <span className="help-value-label">範囲</span>
                          <Inline text={r.range} terms={terms} />
                        </div>
                      )}
                      {r.def && (
                        <div>
                          <span className="help-value-label">既定</span>
                          <Inline text={r.def} terms={terms} />
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}

export default function HelpView(props: HelpViewProps) {
  const { docs, order, page, input, query, titleId } = props;
  const doc = docs[page];
  const shown = useMemo(() => filterDoc(doc, query), [doc, query]);
  const searching = shown.terms.length > 0;
  // matches per page, for the list of pages while searching
  const counts = useMemo(() => (searching ? Object.fromEntries(order.map((p) => [p, countDoc(docs[p], query)])) : null) as Record<Page, number> | null, [docs, order, query, searching]);
  const others = useMemo(() => otherPageCounts(docs, order, page, query), [docs, order, page, query]);
  // the table of contents' group of each section (the page's panels, the app's own sections in 設定 …)
  const groupOf = (s: { panel?: boolean; group?: string }) => (s.panel ? "画面の各部" : s.group);
  return (
    <div className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={props.modalRef}>
      <div className="help-head">
        <h2 id={titleId} className="help-title">
          ヘルプ: {doc.title}
        </h2>
        <div className="help-search">
          <input
            ref={props.searchRef}
            type="text"
            value={input}
            placeholder="ヘルプ内を検索（例: シード、BPM、VRAM）"
            aria-label="ヘルプ内を検索"
            onChange={(e) => props.onInput(e.target.value, (e.nativeEvent as InputEvent).isComposing === true)}
            onCompositionEnd={(e) => props.onCompositionEnd(e.currentTarget.value)}
          />
          {input && (
            <button type="button" className="btn sm" onClick={props.onClear}>
              検索を消す
            </button>
          )}
          <span className="muted small help-hits" aria-live="polite">
            {searching ? `${shown.hits} 件` : ""}
          </span>
        </div>
        <button type="button" className="btn sm" onClick={props.onClose} title="閉じる（Esc）">
          閉じる
        </button>
      </div>
      <div className="help-body">
        <nav className="help-nav" aria-label="ヘルプの目次">
          <div className="help-nav-label">画面</div>
          {order.map((p) => (
            <button
              key={p}
              type="button"
              className={`nav-btn help-nav-item ${p === page ? "active" : ""}`}
              aria-current={p === page ? "true" : undefined}
              onClick={() => props.onPage(p)}
            >
              <span className="grow">{docs[p].title}</span>
              {counts && counts[p] > 0 && <span className="help-count">{counts[p]}</span>}
            </button>
          ))}
          {shown.sections.length > 0 && <div className="help-nav-label">この画面のヘルプ</div>}
          {shown.sections.map((s, i) => {
            const group = groupOf(s.section);
            const opens = group !== undefined && (i === 0 || groupOf(shown.sections[i - 1].section) !== group);
            return (
              <Fragment key={s.section.id}>
                {opens && <div className="help-nav-group">{group}</div>}
                <button type="button" className={`nav-btn help-nav-item ${group !== undefined ? "help-nav-panel" : ""}`} onClick={() => props.onSection(s.section.id)}>
                  {s.section.title}
                </button>
              </Fragment>
            );
          })}
        </nav>
        <div className="help-pane" ref={props.paneRef} tabIndex={0} aria-label={`${doc.title}のヘルプ`}>
          {shown.sections.length === 0 ? (
            <div className="help-empty">
              <p>「{query.trim()}」は、この画面のヘルプには見つかりません。</p>
              {others.length > 0 ? (
                <>
                  <p>見つかったほかの画面のヘルプ:</p>
                  <div className="row">
                    {others.map((o) => (
                      <button key={o.page} type="button" className="btn sm" onClick={() => props.onPage(o.page)}>
                        {o.title}（{o.hits} 件）
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p>どの画面のヘルプにも見つかりません。別の言葉で探してください。</p>
              )}
            </div>
          ) : (
            shown.sections.map((s) => (
              <section key={s.section.id} className="help-section" data-section={s.section.id}>
                <h3>
                  <Inline text={s.section.title} terms={shown.terms} />
                </h3>
                {s.blocks.map((b, i) => (
                  <Block key={i} block={b} terms={shown.terms} sectionTitle={s.section.title} />
                ))}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
