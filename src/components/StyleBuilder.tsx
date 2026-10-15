// Japanese chips -> English style prompt fragments (YuE2 expects English style text).
// Selection can be controlled by the parent (compose page: AI fill / reset) or kept internally. The tempo
// control always shows the tempo the prompt states (styleView), whoever last wrote the prompt.
// There is no "instrumental" chip: an instrumental needs the official workflow (Vocal notes moved to Ins,
// no sung words), which the compose page's 「インストゥルメンタル版を生成」 runs; a style word alone cannot do it.
import { useMemo, useState } from "react";
import { BPM_MAX, BPM_MIN, BPM_TOKEN, bpmMatch, replaceBpm, styleBpm } from "../lyrics/styleBpm";

export type Group = { key: string; label: string; single?: boolean; items: { ja: string; en: string }[] };

export const GROUPS: Group[] = [
  {
    key: "lang",
    label: "言語",
    single: true,
    items: [
      { ja: "日本語", en: "Japanese" },
      { ja: "英語", en: "English" },
      { ja: "中国語", en: "Mandarin" },
      { ja: "韓国語", en: "Korean" },
    ],
  },
  {
    key: "genre",
    label: "ジャンル",
    items: [
      { ja: "J-POP", en: "J-pop" },
      { ja: "ポップ", en: "pop" },
      { ja: "ロック", en: "rock" },
      { ja: "バラード", en: "ballad" },
      { ja: "R&B", en: "R&B" },
      { ja: "ヒップホップ", en: "hip hop" },
      { ja: "EDM", en: "EDM" },
      { ja: "シティポップ", en: "city pop" },
      { ja: "ジャズ", en: "jazz" },
      { ja: "フォーク", en: "folk" },
      { ja: "アニソン", en: "anime song" },
      { ja: "ボカロ風", en: "vocaloid style" },
      { ja: "ロックバラード", en: "rock ballad" },
      { ja: "ボサノバ", en: "bossa nova" },
      { ja: "メタル", en: "metal" },
      { ja: "ローファイ", en: "lo-fi" },
    ],
  },
  {
    key: "vocal",
    label: "ボーカル",
    single: true,
    items: [
      { ja: "女性ボーカル", en: "female vocal" },
      { ja: "男性ボーカル", en: "male vocal" },
      { ja: "少女の声", en: "young female vocal" },
      { ja: "低音の男性", en: "deep male vocal" },
    ],
  },
  {
    key: "voice",
    label: "声質",
    items: [
      { ja: "透明感", en: "clear" },
      { ja: "パワフル", en: "powerful" },
      { ja: "ささやき", en: "breathy" },
      { ja: "ハスキー", en: "husky" },
      { ja: "エモーショナル", en: "emotional" },
      { ja: "やさしい", en: "gentle" },
    ],
  },
  {
    key: "inst",
    label: "楽器",
    items: [
      { ja: "ピアノ", en: "piano" },
      { ja: "アコギ", en: "acoustic guitar" },
      { ja: "エレキギター", en: "electric guitar" },
      { ja: "シンセ", en: "synth" },
      { ja: "ストリングス", en: "strings" },
      { ja: "ドラム", en: "drums" },
      { ja: "ベース", en: "bass" },
      { ja: "ブラス", en: "brass" },
      { ja: "ローズピアノ", en: "Rhodes piano" },
      { ja: "808", en: "808 bass" },
    ],
  },
  {
    key: "mood",
    label: "雰囲気",
    items: [
      { ja: "明るい", en: "bright" },
      { ja: "切ない", en: "melancholic" },
      { ja: "希望", en: "hopeful" },
      { ja: "エネルギッシュ", en: "energetic" },
      { ja: "落ち着いた", en: "calm" },
      { ja: "ドラマチック", en: "dramatic" },
      { ja: "夜", en: "late night atmosphere" },
      { ja: "夏", en: "summer vibes" },
      { ja: "ノスタルジック", en: "nostalgic" },
    ],
  },
];

export interface StyleSelection {
  /** group key -> selected English values */
  groups: Record<string, string[]>;
  /** 0 = unspecified */
  bpm: number;
}

export const emptySelection = (): StyleSelection => ({ groups: {}, bpm: 0 });

/** English prompt composed from the chips (group order, then BPM). */
export function composeStyle(sel: StyleSelection): string {
  const parts: string[] = [];
  for (const g of GROUPS) for (const en of sel.groups[g.key] ?? []) parts.push(en);
  if (sel.bpm > 0) parts.push(`${sel.bpm} BPM`);
  return parts.join(", ");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string) => new RegExp(`\\b${escapeRe(w)}\\b`, "i");

// Words that make "<language> ... vocal" a regional instrument or genre rather than a language statement
// ("Japanese city pop vocal", "Korean gayageum and vocals"), plus words that start a new phrase ("with").
const NOT_VOCAL_MODIFIER = new Set(
  [
    ...GROUPS.filter((g) => g.key === "genre" || g.key === "inst").flatMap((g) => g.items.flatMap((i) => i.en.toLowerCase().split(/[\s-]+/))),
    ...["koto", "shamisen", "shakuhachi", "taiko", "erhu", "guzheng", "pipa", "gayageum", "haegeum", "flute", "guitar", "guitars"],
    ...["drum", "synths", "orchestra", "orchestral", "enka", "idol", "trap", "lofi"],
    ...["with", "and", "or", "plus", "over", "on", "of", "a", "an", "the", "in", "by", "for", "from", "to"],
  ].filter((w) => w !== "" && w !== "song" && w !== "style"),
);
const VOCAL_HEAD = "vocals?|vocalists?|lyrics|singing|singers?|rap|rapping|rapper|voices?|choir|chorus|harmony|harmonies";

/**
 * Where the token states the language `v`: the index of the language word, or -1. A language statement is the
 * bare language, "sung in / vocals in / lyrics in Japanese", "Japanese-language ..." / "Japanese language", or
 * the language before a vocal head noun with up to three describing words in between, anywhere in the token
 * ("bright Japanese female vocal with reverb", "female Japanese vocals", "Japanese vocal harmonies",
 * "Japanese lyrics"). A regional instrument or genre ("Japanese koto", "nostalgic Japanese city pop with a warm
 * female vocal") is not one (as in abc/instrumental.ts): no genre / instrument word may sit in between.
 */
function languageAt(token: string, v: string): number {
  const t = token.trim();
  if (t.toLowerCase() === v.toLowerCase()) return token.indexOf(t);
  // "Mandarin Chinese" is one language name (swapValue also consumes the " Chinese")
  if (/^mandarin$/i.test(v) && /^mandarin[ -]chinese$/i.test(t)) return token.indexOf(t);
  const lang = escapeRe(v);
  // "sung in Japanese": the language ends the match
  const inLang = new RegExp(`\\b(?:sung|sings|sang|singing|lyrics|vocals?|rap|rapping|rapped) in ${lang}\\b`, "i").exec(token);
  if (inLang) return inLang.index + inLang[0].length - v.length;
  // "Japanese-language lyrics", "Japanese language": the language starts it
  const langWord = new RegExp(`\\b${lang}[- ]language\\b`, "i").exec(token);
  if (langWord) return langWord.index;
  // "bright Japanese female vocal": the language, up to three describing words, a vocal head noun
  const before = new RegExp(`\\b${lang}((?:[ -][^\\s,-]+){0,3}?)[ -](?:${VOCAL_HEAD})\\b`, "gi");
  for (let m = before.exec(token); m; m = before.exec(token)) {
    if (m[1].split(/[ -]/).every((w) => w === "" || !NOT_VOCAL_MODIFIER.has(w.toLowerCase()))) return m.index;
    before.lastIndex = m.index + 1;
  }
  return -1;
}

/**
 * A token that states the single-choice value `v` of group `key`. A language only as a language statement
 * (languageAt). A vocal value names its head noun "vocal", so it counts anywhere in a token ("bright female
 * vocal with reverb").
 */
function statesValue(key: string, token: string, v: string): boolean {
  if (key !== "lang") return wordRe(v).test(token);
  return languageAt(token, v) >= 0;
}

/**
 * The token with its statements of `rival` swapped for `en` (the language word of each statement, not the first
 * occurrence: "Japanese female vocal and Japanese choir" swaps both). "Mandarin Chinese" is one language name.
 */
function swapValue(key: string, token: string, rival: string, en: string): string {
  if (key !== "lang") return token.replace(wordRe(rival), en);
  let out = token;
  // every swap removes one statement of `rival`; the bound only guards against a pathological loop
  for (let n = 0, at = languageAt(out, rival); at >= 0 && n < 16; n++, at = languageAt(out, rival)) {
    let end = at + rival.length;
    if (rival === "Mandarin") end += /^[ -]Chinese\b/i.exec(out.slice(end))?.[0].length ?? 0;
    out = out.slice(0, at) + en + out.slice(end);
  }
  return out;
}

/**
 * The prompt after a chip / tempo change from `prev` to `next`. A prompt that is empty or still exactly the
 * chips' composition is rebuilt from the chips. Otherwise (hand-written or AI-written wording) only whole
 * comma-separated tokens are edited, never substrings ("piano" leaves "Rhodes piano" alone): a removed chip
 * drops the tokens equal to it (ignoring case), an added one is appended when missing, and the tempo
 * replaces or adds the lone tempo token (BPM_TOKEN: any form BPM_RE reads, "96 BPM", "60-70 BPM", "BPM 140",
 * "１４０ＢＰＭ"), or rewrites a tempo written inside wording in place; 「指定なし」 drops the lone tempo tokens.
 * Single-choice groups (language, vocal) never end up with two values: an added value replaces every other
 * value of its group the prompt names, whether the chip was selected or not (the default style of a page
 * already names a language) - a lone token is replaced, a value inside wording is swapped as a word
 * ("bright female vocal" -> "bright male vocal", "Japanese lyrics" -> "English lyrics"). A language word
 * inside an instrument or genre ("Japanese koto") is not a language statement and stays (statesValue).
 */
export function applyChipChange(value: string, prev: StyleSelection, next: StyleSelection): string {
  if (!value.trim() || value === composeStyle(prev)) return composeStyle(next);
  let tokens = value.split(",").map((t) => t.trim()).filter((t) => t !== "");
  // A closing period belongs to the prompt, not to its last token.
  let period = false;
  if (tokens.length && tokens[tokens.length - 1].endsWith(".") && !BPM_TOKEN.test(tokens[tokens.length - 1])) {
    period = true;
    tokens[tokens.length - 1] = tokens[tokens.length - 1].slice(0, -1).trimEnd();
  }
  const lower = (s: string) => s.toLowerCase();
  const insert = (tok: string) => {
    // New chips go before a trailing tempo token (the tempo stays last, as composeStyle writes it).
    const last = tokens.length - 1;
    if (last >= 0 && BPM_TOKEN.test(tokens[last])) tokens.splice(last, 0, tok);
    else tokens.push(tok);
  };
  for (const g of GROUPS) {
    const before = prev.groups[g.key] ?? [];
    const after = next.groups[g.key] ?? [];
    let replacedAt = -1;
    for (const en of before) {
      if (after.includes(en)) continue;
      const at = tokens.findIndex((t) => lower(t) === lower(en));
      if (at >= 0 && replacedAt < 0) replacedAt = at;
      tokens = tokens.filter((t) => lower(t) !== lower(en));
    }
    for (const en of after) {
      if (before.includes(en)) continue;
      if (g.single) {
        // Other values of the group named anywhere in the prompt (longest first: "young female vocal"
        // before "female vocal"; \b keeps "male vocal" out of "female vocal").
        const rivals = g.items
          .map((i) => i.en)
          .filter((o) => lower(o) !== lower(en))
          .sort((a, b) => b.length - a.length);
        let placed = false;
        const out: string[] = [];
        for (const t of tokens) {
          const rival = rivals.find((o) => statesValue(g.key, t, o));
          if (!rival) out.push(t);
          else if (lower(t) === lower(rival)) {
            // a lone rival token: the new value takes the place of the first one
            if (!placed) out.push(en);
            placed = true;
          } else {
            out.push(swapValue(g.key, t, rival, en));
            placed = true;
          }
        }
        // keep one lone token of the value
        tokens = out.filter((t, i) => lower(t) !== lower(en) || out.findIndex((u) => lower(u) === lower(en)) === i);
        if (placed || tokens.some((t) => statesValue(g.key, t, en))) continue;
        // A single-choice value takes the place of the one it replaces.
        if (replacedAt >= 0) tokens.splice(Math.min(replacedAt, tokens.length), 0, en);
        else insert(en);
        continue;
      }
      if (tokens.some((t) => lower(t) === lower(en))) continue;
      insert(en);
    }
  }
  if (prev.bpm !== next.bpm) {
    if (next.bpm > 0) {
      // The tempo statement styleBpm / withStyleBpm read and the slider shows is edited: a lone tempo token, or a
      // tempo inside wording ("upbeat 120 BPM groove") edited in place. It is found in the whole prompt, not token
      // by token ("NN BPM" anywhere wins over an earlier "BPM NN"; a match never spans a comma). Other lone tempo
      // tokens would contradict the tempo just set, so they go.
      const joined = tokens.join(", ");
      const m = bpmMatch(joined);
      const at = m ? joined.slice(0, m.index).split(", ").length - 1 : -1;
      if (at < 0) insert(`${next.bpm} BPM`);
      else {
        const lone = BPM_TOKEN.exec(tokens[at]);
        tokens[at] = lone ? `${next.bpm} BPM${lone[1]}` : replaceBpm(tokens[at], `${next.bpm} BPM`);
        tokens = tokens.filter((t, k) => k === at || !BPM_TOKEN.test(t));
      }
    } else tokens = tokens.filter((t) => !BPM_TOKEN.test(t));
    // (every lone tempo token goes; a tempo inside wording is left alone on 「指定なし」: cutting it out could leave
    // "at" behind - see tempoClearable)
  }
  const out = tokens.join(", ");
  return period && out ? `${out}.` : out;
}

export interface StyleBuilderProps {
  value: string;
  onChange: (v: string) => void;
  /** Controlled chip selection (optional). */
  selection?: StyleSelection;
  onSelectionChange?: (s: StyleSelection) => void;
}

/**
 * The selection as the controls show it: the chips as selected, the tempo as the prompt states it (the page may
 * sync the prompt's tempo with a score's Q:, and a default or AI-written prompt names one the chips never set).
 */
export function styleView(value: string, sel: StyleSelection): StyleSelection {
  return { ...sel, bpm: styleBpm(value) ?? 0 };
}

/**
 * Whether 「指定なし」 on the slider would leave the prompt without a tempo. It does not when the prompt states its
 * tempo inside wording ("upbeat 120 BPM groove"), which applyChipChange leaves alone; the slider then offers no
 * 「指定なし」 end instead of jumping back to the prompt's tempo.
 */
export function tempoClearable(value: string, view: StyleSelection): boolean {
  if (view.bpm <= 0) return true;
  return styleBpm(applyChipChange(value, view, { ...view, bpm: 0 })) === null;
}

/** The slider's leftmost position: 「指定なし」 (no tempo). Every other position is BPM_MIN..BPM_MAX. */
export const BPM_NONE_POSITION = BPM_MIN - 1;

/** Slider position of a tempo (0 = none; a score tempo outside the range sits at the nearest end). */
export function bpmSliderPosition(bpm: number): number {
  return bpm > 0 ? Math.min(BPM_MAX, Math.max(BPM_MIN, bpm)) : BPM_NONE_POSITION;
}

/** Tempo of a slider position (below BPM_MIN = none). */
export function bpmFromSlider(position: number): number {
  return position < BPM_MIN ? 0 : Math.min(BPM_MAX, Math.round(position));
}

/**
 * The prompt 「チップの内容で作り直す」 would write, or null when the button is not offered: no chip is selected (the
 * prompt would shrink to the tempo alone) or the prompt already is that composition.
 */
export function rebuildFromChips(value: string, view: StyleSelection): string | null {
  if (!Object.values(view.groups).some((a) => a.length > 0)) return null;
  const composed = composeStyle(view);
  return composed && value !== composed ? composed : null;
}

export default function StyleBuilder({ value, onChange, selection, onSelectionChange }: StyleBuilderProps) {
  const [internal, setInternal] = useState<StyleSelection>(emptySelection);
  const sel = selection ?? internal;
  const setSel = (s: StyleSelection) => {
    if (selection && onSelectionChange) onSelectionChange(s);
    else setInternal(s);
  };
  const view = useMemo(() => styleView(value, sel), [value, sel]);
  const rebuilt = useMemo(() => rebuildFromChips(value, view), [value, view]);
  const clearable = useMemo(() => tempoClearable(value, view), [value, view]);

  const toggle = (g: Group, en: string) => {
    const cur = view.groups[g.key] ?? [];
    const next = cur.includes(en) ? cur.filter((x) => x !== en) : g.single ? [en] : [...cur, en];
    const s: StyleSelection = { ...view, groups: { ...view.groups, [g.key]: next } };
    setSel(s);
    onChange(applyChipChange(value, view, s));
  };

  const setBpm = (bpm: number) => {
    const s: StyleSelection = { ...view, bpm };
    setSel(s);
    onChange(applyChipChange(value, view, s));
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      {GROUPS.map((g) => (
        <div key={g.key} className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ width: 62, flexShrink: 0 }}>
            {g.label}
          </span>
          <div className="chips">
            {g.items.map((it) => {
              const on = (view.groups[g.key] ?? []).includes(it.en);
              return (
                <button key={it.en} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(g, it.en)}>
                  {it.ja}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <span className="muted" style={{ width: 62, flexShrink: 0 }}>
          テンポ
        </span>
        <input
          type="range"
          min={clearable ? BPM_NONE_POSITION : BPM_MIN}
          max={BPM_MAX}
          step={1}
          value={bpmSliderPosition(view.bpm)}
          onChange={(e) => setBpm(bpmFromSlider(Number(e.target.value)))}
          style={{ width: 200 }}
          aria-label={clearable ? "テンポ（左端は指定なし）" : "テンポ"}
          title={clearable ? `左端は指定なし、${BPM_MIN}〜${BPM_MAX} BPM` : `${BPM_MIN}〜${BPM_MAX} BPM（文中のテンポはプロンプトで直接消してください）`}
        />
        <span className="muted">{view.bpm > 0 ? `${view.bpm} BPM` : "指定なし"}</span>
        {!clearable && <span className="muted">文中のテンポは、下のプロンプトで直接消せます</span>}
      </div>
      <label className="field">
        <span className="lbl">
          <span>スタイルプロンプト（英語、自由に編集できます）</span>
          {rebuilt !== null && (
            <button className="btn sm" onClick={() => onChange(rebuilt)} title="選択中のチップからスタイルプロンプトを作り直します（プロンプトを手で編集した部分は置き換えられます）">
              チップの内容で作り直す
            </button>
          )}
        </span>
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder="例: Japanese, J-pop, bright female vocal, piano, acoustic guitar, light drums, hopeful, 120 BPM" style={{ minHeight: 64 }} />
      </label>
    </div>
  );
}
