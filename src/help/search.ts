// The help's search: which items of a page's help match the words typed, and where to mark them. Text is compared
// as the library search compares it (searchKey: NFKC, lower case, katakana as hiragana), so ＢＰＭ, bpm, ｻｸﾗ and さくら
// find each other. Every whitespace-separated word must be in the same item (a paragraph, a list item, a step, a
// row of a control table, a question with its answer).
import { searchKey } from "../library/songMeta";
import type { Page } from "../store";
import { inlineSegments, plainText } from "./inline";
import type { HelpBlock, HelpDoc, HelpField, HelpSection } from "./types";

/** The search form of a text: searchKey, with the wave dash 〜 as the tilde that the IME's full-width ～ becomes. */
export function helpKey(text: string): string {
  return searchKey(text).replace(/〜/g, "~");
}

/** The search words of a query, each in search form (none for a blank query). */
export function queryTerms(query: string): string[] {
  return helpKey(query).split(/\s+/).filter(Boolean);
}

export interface Folded {
  /** the text in search form */
  key: string;
  /** for each UTF-16 unit of `key`: where its source character starts and ends in the text */
  starts: number[];
  ends: number[];
}

/**
 * The search form of a text, built one character (code point) at a time so that every unit of it maps back to
 * the character it came from (㌔ becomes きろ: both point at ㌔). For the help's own text this equals helpKey of the
 * whole text (a test checks it): its text has no half-width kana with voiced marks or combining marks, which NFKC
 * would join across characters.
 */
export function foldWithMap(text: string): Folded {
  let key = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = helpKey(ch);
    key += f;
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    i += ch.length;
  }
  return { key, starts, ends };
}

/** Where the words (search form) occur in `text`: [start, end) of whole characters, sorted, touching ones merged. */
export function markRanges(text: string, terms: readonly string[]): [number, number][] {
  if (!text || !terms.length) return [];
  const f = foldWithMap(text);
  const found: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    for (let at = f.key.indexOf(t); at >= 0; at = f.key.indexOf(t, at + 1)) found.push([f.starts[at], f.ends[at + t.length - 1]]);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const r of found) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export interface MarkedPiece {
  text: string;
  code: boolean;
  mark: boolean;
}

/** The text in pieces to show: code or not, marked where a word was found (a match may run into or out of code). */
export function markInline(text: string, terms: readonly string[]): MarkedPiece[] {
  const segments = inlineSegments(text);
  const marked: boolean[] = [];
  const plain = segments.map((s) => s.text).join("");
  for (let k = 0; k < plain.length; k++) marked.push(false);
  for (const [a, b] of markRanges(plain, terms)) for (let k = a; k < b; k++) marked[k] = true;
  const out: MarkedPiece[] = [];
  let pos = 0;
  for (const s of segments) {
    let start = 0;
    for (let k = 1; k <= s.text.length; k++) {
      if (k === s.text.length || marked[pos + k] !== marked[pos + start]) {
        out.push({ text: s.text.slice(start, k), code: s.code, mark: marked[pos + start] });
        start = k;
      }
    }
    pos += s.text.length;
  }
  return out;
}

/** A block as shown: steps keep their numbers when some are left out. */
export type ShownBlock = Exclude<HelpBlock, { kind: "steps" }> | { kind: "steps"; items: string[]; numbers: number[] };

export interface ShownSection {
  section: HelpSection;
  /** the section's title matched: all of it is shown */
  titleHit: boolean;
  blocks: ShownBlock[];
}

export interface FilteredDoc {
  terms: string[];
  /** matching items (a section title, or a table's panel name shown as its own heading, counts as one) */
  hits: number;
  sections: ShownSection[];
}

const matchesAll = (text: string, terms: readonly string[]): boolean => {
  const key = helpKey(plainText(text));
  return terms.every((t) => key.includes(t));
};

const rowText = (r: HelpField): string => [r.name, r.desc, r.range ?? "", r.def ?? "", ...(r.notes ?? [])].join(" ");

function shownWhole(b: HelpBlock): ShownBlock {
  return b.kind === "steps" ? { kind: "steps", items: b.items, numbers: b.items.map((_, i) => i + 1) } : b;
}

/** The part of `b` that matches (null: nothing) and the number of matching items in it. A table titled as its section
 * (`sectionTitle`) has no heading of its own on screen (HelpView): its title counts once, with the section's. */
function filterBlock(b: HelpBlock, terms: readonly string[], sectionTitle: string): { block: ShownBlock | null; hits: number } {
  switch (b.kind) {
    case "text":
    case "note":
      return matchesAll(b.text, terms) ? { block: b, hits: 1 } : { block: null, hits: 0 };
    case "list": {
      const items = b.items.filter((t) => matchesAll(t, terms));
      return { block: items.length ? { kind: "list", items } : null, hits: items.length };
    }
    case "steps": {
      const numbers = b.items.map((t, i) => (matchesAll(t, terms) ? i + 1 : 0)).filter((n) => n > 0);
      return { block: numbers.length ? { kind: "steps", items: numbers.map((n) => b.items[n - 1]), numbers } : null, hits: numbers.length };
    }
    case "fields": {
      const rows = b.rows.filter((r) => matchesAll(rowText(r), terms));
      // the panel's name matched: its whole table
      if (matchesAll(b.title, terms)) return { block: b, hits: (b.title !== sectionTitle ? 1 : 0) + rows.length };
      return { block: rows.length ? { ...b, rows } : null, hits: rows.length };
    }
    case "faq": {
      const items = b.items.filter((it) => matchesAll(`${it.q} ${it.a}`, terms));
      return { block: items.length ? { kind: "faq", items } : null, hits: items.length };
    }
  }
}

/** The help of a page as shown for `query`: all of it for a blank query, else only what matches. */
export function filterDoc(doc: HelpDoc, query: string): FilteredDoc {
  const terms = queryTerms(query);
  if (!terms.length) return { terms, hits: 0, sections: doc.sections.map((s) => ({ section: s, titleHit: false, blocks: s.blocks.map(shownWhole) })) };
  let hits = 0;
  const sections: ShownSection[] = [];
  for (const s of doc.sections) {
    const titleHit = matchesAll(s.title, terms);
    const blocks: ShownBlock[] = [];
    let n = titleHit ? 1 : 0;
    for (const b of s.blocks) {
      const r = filterBlock(b, terms, s.title);
      n += r.hits;
      if (titleHit) blocks.push(shownWhole(b));
      else if (r.block) blocks.push(r.block);
    }
    if (titleHit || blocks.length) {
      sections.push({ section: s, titleHit, blocks });
      hits += n;
    }
  }
  return { terms, hits, sections };
}

/** Matching items in a page's help. */
export function countDoc(doc: HelpDoc, query: string): number {
  return filterDoc(doc, query).hits;
}

/** The other pages whose help has matches for `query`, in `order` (none for a blank query). */
export function otherPageCounts(docs: Partial<Record<Page, HelpDoc>>, order: readonly Page[], current: Page, query: string): { page: Page; title: string; hits: number }[] {
  if (!queryTerms(query).length) return [];
  const out: { page: Page; title: string; hits: number }[] = [];
  for (const p of order) {
    const d = docs[p];
    if (p === current || !d) continue;
    const hits = countDoc(d, query);
    if (hits > 0) out.push({ page: p, title: d.title, hits });
  }
  return out;
}
