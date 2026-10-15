// Kanji -> hiragana conversion for singing (kuromoji.js, IPADIC readings). Runs fully offline.
// kuromoji's browser build is loaded with a <script> tag from public/kuromoji/ (its zlibjs
// dependency cannot be bundled as an ES module); only the types are imported here.
import type { IpadicFeatures, Tokenizer } from "kuromoji";

interface KuromojiGlobal {
  builder: (opts: { dicPath: string }) => { build: (cb: (err: Error | null, tokenizer: Tokenizer<IpadicFeatures>) => void) => void };
}

let scriptPromise: Promise<KuromojiGlobal> | null = null;

function loadKuromojiScript(): Promise<KuromojiGlobal> {
  const w = window as unknown as { kuromoji?: KuromojiGlobal };
  if (w.kuromoji) return Promise.resolve(w.kuromoji);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "kuromoji/kuromoji.js";
      s.async = true;
      s.onload = () => (w.kuromoji ? resolve(w.kuromoji) : reject(new Error("kuromoji did not initialize")));
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error("kuromoji.js を読み込めませんでした"));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export type LyricsLanguage = "ja" | "en" | "zh" | "other";

/** A piece of text with an optional furigana reading (only kanji runs carry a reading). */
export interface RubySegment {
  text: string;
  ruby?: string;
  /** a kanji run without a reading: unknown to the dictionary, or still kanji in the hiragana version */
  unread?: boolean;
}

export interface PreviewLine {
  original: string;
  verbatim: boolean;
  segments: RubySegment[];
  /** "sung": readings taken from the edited hiragana line; "dict": dictionary readings (fallback); "none": no kanji */
  source: "sung" | "dict" | "none";
}

export interface HiraganaResult {
  text: string;
}

let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;

/** Lazily build the tokenizer (dictionary ~18 MB, loaded once per app session). */
export function loadTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (!tokenizerPromise) {
    tokenizerPromise = loadKuromojiScript().then(
      (kuromoji) =>
        new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) => {
          // kuromoji swallows dictionary decode errors (they surface as uncaught exceptions), so
          // guard with a timeout instead of waiting forever.
          const timer = window.setTimeout(() => reject(new Error("辞書の読み込みがタイムアウトしました（kuromoji/dict が配信されているか確認してください）")), 90_000);
          kuromoji.builder({ dicPath: "kuromoji/dict/" }).build((err, tokenizer) => {
            window.clearTimeout(timer);
            if (err || !tokenizer) reject(err ?? new Error("tokenizer unavailable"));
            else resolve(tokenizer);
          });
        }),
    );
    tokenizerPromise.catch(() => {
      tokenizerPromise = null;
    });
  }
  return tokenizerPromise;
}

/**
 * Han ideographs as the body of a RegExp character class (use it with the u flag): Extension A, the unified
 * ideographs, the compatibility ideographs and the supplementary planes (Extension B and later: 𠮟, 𩸽).
 * 々〆ヶ are not in it: they count as kanji for Japanese only (KANJI), not as Chinese syllables.
 */
export const HAN = "\\u{3400}-\\u{4DBF}\\u{4E00}-\\u{9FFF}\\u{F900}-\\u{FAFF}\\u{20000}-\\u{3134F}";
const KANJI = new RegExp(`[${HAN}々〆ヶ]`, "u");
const JAPANESE = new RegExp(`[\\u{3040}-\\u{30FF}${HAN}]`, "u");
const HANGUL = /[가-힯]/;
const KANA = /[぀-ヿ]/;

export function hasKanji(s: string): boolean {
  return KANJI.test(s);
}

/** Line endings normalized to "\n". */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** The lines of `s` (CRLF, CR and LF all end a line). */
export function splitLines(s: string): string[] {
  return normalizeNewlines(s).split("\n");
}

/** Katakana -> hiragana (keeps the long-vowel mark and non-katakana characters). */
export function katakanaToHiragana(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    // ァ (30A1) .. ヶ (30F6) map to ぁ (3041) .. ゖ (3096)
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCharCode(code - 0x60);
    else out += ch;
  }
  return out;
}

/** Guess the lyrics language from the script used. */
export function detectLanguage(text: string): LyricsLanguage {
  const body = text.replace(/\[[^\]]*\]/g, "");
  if (KANA.test(body)) return "ja";
  if (HANGUL.test(body)) return "other";
  if (JAPANESE.test(body)) return "zh"; // kanji only, no kana
  return /[A-Za-z]/.test(body) ? "en" : "other";
}

function isVerbatimLine(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("[");
}

/** Split text into maximal runs of kanji and non-kanji characters. */
function kanjiRuns(text: string): { text: string; kanji: boolean }[] {
  const out: { text: string; kanji: boolean }[] = [];
  for (const ch of text) {
    const k = KANJI.test(ch);
    const last = out[out.length - 1];
    if (last && last.kanji === k) last.text += ch;
    else out.push({ text: ch, kanji: k });
  }
  return out;
}

/** One element of the reading pattern: a kanji run's reading, one kana of an anchor, or optional whitespace. */
type ReadingElem = { kind: "group" } | { kind: "lit"; ch: string } | { kind: "ws" };

const WS = /\s/;
// `.` of a JavaScript RegExp (no s flag): everything but the line terminators
const LINE_TERMINATOR = new RegExp("[\n\r\u2028\u2029]");

/**
 * Attach a hiragana reading to the kanji runs of `surface` only (okurigana and other kana stay
 * plain): 照らして + てらして -> [照(て)][らして]. The kana runs of the surface act as anchors inside
 * the reading. Returns null when the reading does not fit the surface's kana skeleton. A kanji run whose
 * reading still holds kanji (燦めく + 燦めくほし: 燦 was never read) is returned without ruby, marked unread.
 *
 * The match is the one of the pattern ^(.+?)anchor(.+?)…$ (a lazy group per kanji run, whitespace inside an
 * anchor as \s*), found by a search that remembers the failed (element, position) pairs, so a long line that
 * does not fit costs O(elements x length²) instead of the backtracking RegExp's exponential time.
 */
export function alignReading(surface: string, reading: string): RubySegment[] | null {
  const runs = kanjiRuns(surface);
  if (!runs.some((r) => r.kanji)) return [{ text: surface }];
  const elems: ReadingElem[] = [];
  for (const r of runs) {
    if (r.kanji) elems.push({ kind: "group" });
    else if (/^\s+$/.test(r.text)) elems.push({ kind: "ws" });
    else {
      let inWs = false;
      for (const ch of katakanaToHiragana(r.text).split("")) {
        if (WS.test(ch)) {
          if (!inWs) elems.push({ kind: "ws" });
          inWs = true;
        } else {
          elems.push({ kind: "lit", ch });
          inWs = false;
        }
      }
    }
  }
  const t = katakanaToHiragana(reading).trim();
  const n = t.length;
  const captures: string[] = [];
  const failed = new Set<number>();
  // index of the kanji group each element belongs to (only read for groups)
  const groupIndex: number[] = [];
  let g = 0;
  for (const e of elems) groupIndex.push(e.kind === "group" ? g++ : -1);
  const match = (e: number, pos: number): boolean => {
    if (e === elems.length) return pos === n;
    const key = e * (n + 1) + pos;
    if (failed.has(key)) return false;
    const el = elems[e];
    let ok = false;
    if (el.kind === "lit") ok = pos < n && t[pos] === el.ch && match(e + 1, pos + 1);
    else if (el.kind === "ws") {
      // greedy \s*: the longest run first, then shorter ones
      let end = pos;
      while (end < n && WS.test(t[end])) end++;
      for (let j = end; j >= pos && !ok; j--) ok = match(e + 1, j);
    } else {
      // lazy (.+?): the shortest reading first
      for (let end = pos + 1; end <= n && !LINE_TERMINATOR.test(t[end - 1]) && !ok; end++) {
        captures[groupIndex[e]] = t.slice(pos, end);
        ok = match(e + 1, end);
      }
    }
    if (!ok) failed.add(key);
    return ok;
  };
  if (!match(0, 0)) return null;
  let k = 0;
  return runs.map((r) => {
    if (!r.kanji) return { text: r.text };
    const ruby = captures[k++];
    return hasKanji(ruby) ? { text: r.text, unread: true } : { text: r.text, ruby };
  });
}

function tokenSegments(surface: string, reading: string | null): RubySegment[] {
  if (!hasKanji(surface)) return [{ text: surface }];
  if (reading === null) return [{ text: surface, unread: true }];
  return alignReading(surface, reading) ?? [{ text: surface, ruby: reading }];
}

/**
 * Furigana preview of `original` (kanji lyrics). When `sung` (the editable hiragana version) has the
 * same number of lines and a line's kana skeleton matches, its readings are shown; otherwise the
 * dictionary readings are used for that line. Cheap enough to run after every edit (debounced).
 */
export async function buildPreview(original: string, sung: string | null): Promise<PreviewLine[]> {
  const oLines = splitLines(original);
  const sLines = sung ? splitLines(sung) : [];
  const sameCount = sLines.length === oLines.length;
  let tokenizer: Tokenizer<IpadicFeatures> | null = null;
  const out: PreviewLine[] = [];
  for (let i = 0; i < oLines.length; i++) {
    const line = oLines[i];
    if (isVerbatimLine(line) || !hasKanji(line)) {
      out.push({ original: line, verbatim: isVerbatimLine(line), segments: [{ text: line }], source: "none" });
      continue;
    }
    if (sameCount) {
      const segs = alignReading(line, sLines[i]);
      if (segs) {
        out.push({ original: line, verbatim: false, segments: segs, source: "sung" });
        continue;
      }
    }
    tokenizer ??= await loadTokenizer();
    const segs: RubySegment[] = [];
    for (const t of tokenizer.tokenize(line)) segs.push(...tokenSegments(t.surface_form, tokenReading(t)));
    out.push({ original: line, verbatim: false, segments: segs, source: "dict" });
  }
  return out;
}

/**
 * Convert every token containing kanji to its hiragana reading. Katakana words, Latin letters,
 * numbers and punctuation are left as they are; section tags and blank lines are copied verbatim.
 * A kanji the dictionary has no reading for is left as it is (see leftoverKanji).
 */
export async function toHiragana(text: string): Promise<HiraganaResult> {
  const tokenizer = await loadTokenizer();
  return { text: hiraganaText(text, (line) => tokenizer.tokenize(line)) };
}

/** toHiragana with the tokenizer passed in (testable without the browser loader). The line structure stays 1:1. */
export function hiraganaText(text: string, tokenize: (line: string) => ReadingToken[]): string {
  return splitLines(text)
    .map((line) => (isVerbatimLine(line) ? line : tokenize(line).map(hiraganaPiece).join("")))
    .join("\n");
}

/**
 * Kanji left in the hiragana version (a word the dictionary has no reading for, such as 燦 or 𠮟, or kanji typed
 * into the hiragana pane later): each character once, in order of appearance. Tags and blank lines are skipped.
 */
export function leftoverKanji(sung: string): string[] {
  const seen = new Set<string>();
  for (const line of splitLines(sung)) {
    if (isVerbatimLine(line)) continue;
    for (const ch of line) if (hasKanji(ch)) seen.add(ch);
  }
  return [...seen];
}

/**
 * Pairs of equal lines (index in `a`, index in `b`) of a longest common subsequence of the two line lists,
 * lines compared without trailing whitespace.
 */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const A = a.map((l) => l.trimEnd());
  const B = b.map((l) => l.trimEnd());
  const w = B.length + 1;
  // len[i * w + j]: LCS length of A[i..] and B[j..]
  const len = new Uint32Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      len[i * w + j] = A[i] === B[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

export interface ReconvertMerge {
  /** the new hiragana version */
  text: string;
  /** lines whose hand-fixed reading was kept (they differ from the fresh conversion) */
  kept: number;
}

/**
 * Re-conversion that keeps reading fixes: `value` is the current kanji text, `source` the kanji text the hiragana
 * version `sung` was made from, `fresh` the dictionary conversion of `value` (one line per line of `value`). A line
 * of `value` that is still in `source` (matched with a line diff, so inserted or removed lines do not shift the
 * rest) keeps its line of `sung`; a new or edited line gets its fresh conversion. Null when `sung` no longer has
 * one line per line of `source` (the hiragana pane was restructured by hand), so lines cannot be paired. Trailing
 * blank lines do not count (a stored song whose two texts differ only in a final newline still pairs); the result
 * ends with the blank lines `value` ends with.
 */
export function mergeReconvert(value: string, source: string, sung: string, fresh: string): ReconvertMerge | null {
  const body = reconvertBody;
  const v = body(value);
  const vLines = v.lines;
  const srcLines = body(source).lines;
  const sungLines = body(sung).lines;
  const freshLines = body(fresh).lines;
  if (sungLines.length !== srcLines.length || freshLines.length !== vLines.length) return null;
  const out = [...freshLines];
  let kept = 0;
  for (const [i, j] of lcsPairs(vLines, srcLines)) {
    out[i] = sungLines[j];
    if (sungLines[j].trimEnd() !== freshLines[i].trimEnd()) kept++;
  }
  return { text: [...out, ...v.tail].join("\n"), kept };
}

/**
 * Hiragana version after something else replaced the kanji lyrics with `value` (an AI edit): the fresh conversion,
 * where the lines that did not change keep their readings from `sung` (mergeReconvert). `merged` is false when the
 * lines cannot be paired (no hiragana version, its source is unknown, or its lines were restructured by hand):
 * every reading is fresh then.
 */
export function reconvertKeepingFixes(value: string, source: string | null, sung: string | null, fresh: string): ReconvertMerge & { merged: boolean } {
  const m = canKeepReadingFixes(source, sung) ? mergeReconvert(value, source!, sung!, fresh) : null;
  return m ? { ...m, merged: true } : { text: fresh, kept: 0, merged: false };
}

/** A text's lines without its trailing blank ones (`lines`), and those (`tail`): what mergeReconvert pairs. */
function reconvertBody(s: string): { lines: string[]; tail: string[] } {
  const lines = splitLines(s);
  let n = lines.length;
  while (n > 0 && !lines[n - 1].trim()) n--;
  return { lines: lines.slice(0, n), tail: lines.slice(n) };
}

/**
 * Whether a reconversion can keep the readings fixed by hand on unchanged lines (reconvertKeepingFixes): the kanji
 * text the hiragana version was made from is known, and the hiragana pane still has its lines one to one. Known
 * before converting, so a dialog can say what will happen.
 */
export function canKeepReadingFixes(source: string | null, sung: string | null): boolean {
  if (source === null || !sung?.trim()) return false;
  return reconvertBody(sung).lines.length === reconvertBody(source).lines.length;
}

/**
 * Whether the hiragana version holds readings fixed by hand: it differs from `reference`, the dictionary conversion
 * of the kanji text it was made from. A blank hiragana version holds none.
 */
export function sungHasHandEdits(sung: string | null, reference: string): boolean {
  if (!sung || !sung.trim()) return false;
  return !sameLyricsText(sung, reference);
}

/**
 * The form holds a hiragana version to sing: one that is not absent (null) and not emptied by hand. A blank pane
 * counts as absent everywhere (the kanji lyrics are sung, as the editor says next to it): what is sent, what an AI
 * edit rebuilds, what the stale check asks about.
 */
export function hasSungVersion(sung: string | null): boolean {
  return sung !== null && sung.trim() !== "";
}

/** The lyrics actually sent to the model: the hiragana version when present for Japanese. */
export function effectiveLyrics(original: string, sung: string | null, language: LyricsLanguage): string {
  if (language === "ja" && hasSungVersion(sung)) return sung as string;
  return original;
}

const normLyrics = (s: string) =>
  splitLines(s)
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();

/** Same lyrics text, ignoring line endings and trailing whitespace. */
export function sameLyricsText(a: string, b: string): boolean {
  return normLyrics(a) === normLyrics(b);
}

/**
 * Kanji lines whose reading cannot be found in the hiragana version (the orange "dict" lines of the furigana
 * preview): every kanji line when the line counts differ, otherwise lines whose kana skeleton does not fit.
 */
export function sungMismatchLines(original: string, sung: string): number {
  const oLines = splitLines(original);
  const sLines = splitLines(sung);
  const sameCount = oLines.length === sLines.length;
  let n = 0;
  oLines.forEach((line, i) => {
    if (isVerbatimLine(line) || !hasKanji(line)) return;
    if (!sameCount || alignReading(line, sLines[i]) === null) n++;
  });
  return n;
}

/**
 * The hiragana version no longer belongs to the kanji lyrics. `sungSource` is the kanji text it was converted
 * from (or loaded with): when known, only a change of the kanji text counts, so reading fixes typed into the
 * hiragana pane are never reported. When unknown, the furigana preview's check is used (lines that no longer
 * line up).
 */
export function isSungStale(original: string, sung: string | null, sungSource: string | null): boolean {
  if (!sung || !sung.trim()) return false;
  if (sungSource !== null) return !sameLyricsText(original, sungSource);
  return sungMismatchLines(original, sung) > 0;
}

/** kuromoji token fields used for the alignment text */
export interface ReadingToken {
  surface_form: string;
  pos?: string;
  /** IPADIC sub-category ("接尾" for the noun suffixes ら・たち …) */
  pos_detail_1?: string;
  /** "KNOWN": a dictionary entry; "UNKNOWN": guessed from the characters */
  word_type?: string;
  reading?: string;
  pronunciation?: string;
}

/** The hiragana reading of a token (its reading, else its pronunciation), or null when the dictionary has none. */
export function tokenReading(t: ReadingToken): string | null {
  const r = t.reading && t.reading !== "*" ? t.reading : t.pronunciation;
  return r && r !== "*" ? katakanaToHiragana(r) : null;
}

// A token that fixes the word boundary before a particle: it holds kanji, katakana, Latin letters or digits …
const ANCHOR = new RegExp(`[${HAN}々〆ヶァ-ヺA-Za-z0-9Ａ-Ｚａ-ｚ０-９]`, "u");
// … or it is a dictionary word of two or more characters that is no particle, auxiliary or symbol itself
// (あなた, きみ, ここ, そら, うたっ). kuromoji segments hiragana-only text by guesswork (きみはへいき ->
// きみ/は/へ/いき, ははは -> は/は/は), so a particle after a one-character token (わ in わはは, み in みては),
// after a word unknown to the dictionary or after another particle is left alone.
const NO_ANCHOR_POS = new Set(["助詞", "助動詞", "記号"]);
// particles that may stand between the anchor and は (東京では, 君には, 東京へは, 朝からは, 歌っては …)
const BEFORE_WA = new Set(["で", "に", "と", "へ", "から", "まで", "より", "て"]);

/** Whether the word boundary after `t` can be trusted (see ANCHOR). */
function anchorsParticle(t: ReadingToken): boolean {
  if (ANCHOR.test(t.surface_form)) return true;
  return t.word_type === "KNOWN" && t.surface_form.length >= 2 && !NO_ANCHOR_POS.has(t.pos ?? "");
}

/**
 * The sung sound of the particle at `i` (は -> わ, へ -> え), or null when the token is no such particle or the
 * word before it cannot be trusted (see ANCHOR). A noun suffix (僕ら, 私たち, 花さん) belongs to the word before
 * it, so that word is checked instead.
 */
export function particleSound(tokens: ReadingToken[], i: number): string | null {
  const t = tokens[i];
  if (t.pos !== "助詞" || (t.surface_form !== "は" && t.surface_form !== "へ")) return null;
  let j = i - 1;
  if (t.surface_form === "は" && j >= 0 && tokens[j].pos === "助詞" && BEFORE_WA.has(tokens[j].surface_form)) j--;
  while (j >= 0 && tokens[j].pos === "名詞" && tokens[j].pos_detail_1 === "接尾") j--;
  if (j < 0 || !anchorsParticle(tokens[j])) return null;
  return t.surface_form === "は" ? "わ" : "え";
}

/** The piece toHiragana writes for a token (kanji tokens become their reading, everything else stays). */
function hiraganaPiece(t: ReadingToken): string {
  return hasKanji(t.surface_form) ? (tokenReading(t) ?? t.surface_form) : t.surface_form;
}

/**
 * One line of the text sent to forced alignment. `tokens` are the kuromoji tokens of the displayed (kanji)
 * line, which kuromoji segments more reliably than the hiragana version; the particles は/へ found there
 * (particleSound) are rewritten as わ/え.
 * - `sung === null`: the kanji line itself is aligned. It is sent as hiragana: each kanji token becomes
 *   kuromoji's reading (君 -> きみ, 愛してる -> あいしてる; the romanizer's own kanji readings are unreliable,
 *   君 -> kun), everything else stays as written (kana, Latin, digits).
 * - `sung`: the hiragana line that was sung. The particles are located in the conversion of the kanji line and
 *   carried over where the sung line still matches it (the text before and after a hand-fixed reading);
 *   inside a hand-edited stretch nothing is changed.
 */
export function alignmentLine(tokens: ReadingToken[], sung: string | null): string {
  if (sung === null) return tokens.map((t, i) => particleSound(tokens, i) ?? hiraganaPiece(t)).join("");
  const pieces = tokens.map(hiraganaPiece);
  const conv = pieces.join("");
  let pre = 0;
  while (pre < conv.length && pre < sung.length && conv[pre] === sung[pre]) pre++;
  let suf = 0;
  while (suf < conv.length - pre && suf < sung.length - pre && conv[conv.length - 1 - suf] === sung[sung.length - 1 - suf]) suf++;
  const out = sung.split("");
  let at = 0;
  tokens.forEach((t, i) => {
    const start = at;
    at += pieces[i].length;
    const sound = particleSound(tokens, i);
    if (!sound) return;
    let pos = -1;
    if (at <= pre) pos = start;
    else if (start >= conv.length - suf) pos = start - conv.length + sung.length;
    if (pos >= 0 && sung[pos] === t.surface_form) out[pos] = sound;
  });
  return out.join("");
}

/**
 * Text for MCS_AlignLyrics (Japanese): `text` (the aligned lyrics: the kanji lyrics or the hiragana version)
 * with the particles は/へ written as sung. The kanji lyrics are sent as their kuromoji reading in hiragana
 * (私は東京へ -> わたしわとうきょうえ, あなたは -> あなたわ); the hiragana version keeps its own readings. The part of speech always comes from
 * `kanji` (the displayed lyrics): the n-th lyric line of `text` is paired with the n-th lyric line of `kanji`.
 * The line structure of `text` stays 1:1 (tags and blank lines verbatim), so aligned line indices still point
 * at the displayed lines.
 */
export async function toAlignmentReading(text: string, kanji: string = text): Promise<string> {
  const tokenizer = await loadTokenizer();
  return alignmentText(text, kanji, (line) => tokenizer.tokenize(line));
}

/** toAlignmentReading with the tokenizer passed in (testable without the browser loader). */
export function alignmentText(text: string, kanji: string, tokenize: (line: string) => ReadingToken[]): string {
  const kanjiLines = splitLines(kanji).filter((l) => !isVerbatimLine(l));
  const own = sameLyricsText(text, kanji);
  let n = 0;
  return splitLines(text)
    .map((line) => {
      if (isVerbatimLine(line)) return line;
      const k = own ? line : kanjiLines[n];
      n++;
      if (k === undefined) return line;
      return alignmentLine(tokenize(k), own ? null : line);
    })
    .join("\n");
}
