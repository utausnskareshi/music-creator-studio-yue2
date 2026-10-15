import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { parseAbc, parseAbcDetailed } from "../../abc/parse";
import { serializeAbc } from "../../abc/serialize";
import { toInstrumental } from "../../abc/instrumental";
import { REQUESTED_TITLE_MAX_CHARS } from "../../config/rules";
import { FORM_ABC_KEPT_NOTE, editedTitle, editedWhileWriting, fieldTitle, formAbcAfterRerender, formDiffersFromSong, planningStyleNotes } from "../ComposePage";

const PAGE = readFileSync(new URL("../ComposePage.tsx", import.meta.url), "utf8");
/** The page's source from `from` up to `to`. */
function code(from: string, to: string): string {
  const start = PAGE.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = PAGE.indexOf(to, start);
  expect(end, to).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("作曲 when it opens", () => {
  it("starts without lyrics, the lyrics language set to Japanese", () => {
    expect(PAGE).toContain('const [lyrics, setLyrics] = useState("");');
    expect(PAGE).toContain('const [lyricsLanguage, setLyricsLanguage] = useState<LyricsLanguage>("ja");');
    // no sample lyrics in the page any more, so the AI draft's check has none to treat as untouched
    expect(PAGE).not.toContain("DEFAULT_LYRICS");
    expect(code("const risk = draftReplaces(", "\n")).toContain('defaultLyrics: ""');
  });
});

describe("曲タイトル field", () => {
  it("keeps REQUESTED_TITLE_MAX_CHARS characters counted as the backend counts them (code points)", () => {
    // HTML maxLength counts UTF-16 units: it stopped emoji / 𠮷 titles at 30 characters while the counter said 30 / 60
    expect(fieldTitle("🎵".repeat(REQUESTED_TITLE_MAX_CHARS))).toBe("🎵".repeat(REQUESTED_TITLE_MAX_CHARS));
    expect(Array.from(fieldTitle("𠮷".repeat(REQUESTED_TITLE_MAX_CHARS + 5)))).toHaveLength(REQUESTED_TITLE_MAX_CHARS);
    expect(fieldTitle("あ".repeat(REQUESTED_TITLE_MAX_CHARS))).toBe("あ".repeat(REQUESTED_TITLE_MAX_CHARS));
  });

  it("clips a title set by the page (an AI draft, a renamed library song) instead of showing 72 / 60", () => {
    expect(fieldTitle("あ".repeat(72))).toBe("あ".repeat(REQUESTED_TITLE_MAX_CHARS));
    // no half emoji at the cut
    expect(fieldTitle(`${"x".repeat(REQUESTED_TITLE_MAX_CHARS - 1)}🔥🔥`)).toBe(`${"x".repeat(REQUESTED_TITLE_MAX_CHARS - 1)}🔥`);
  });

  it("is one line, as the backend stores it (a line break becomes a space instead of vanishing from the field)", () => {
    expect(fieldTitle("一行目\n二行目")).toBe("一行目 二行目");
    expect(fieldTitle("a\tb\r\nc")).toBe("a b  c");
    // typing is left alone: spaces at either end stay while the user types
    expect(fieldTitle("夏の ")).toBe("夏の ");
    expect(fieldTitle("")).toBe("");
  });
});

describe("曲タイトル field: typing over the limit", () => {
  const MAX = REQUESTED_TITLE_MAX_CHARS;
  /** a title of `n` distinct Japanese characters (a cut at the wrong place shows) */
  const kana = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(0x3042 + (i % 80))).join("");
  /** `prev` with `text` typed or pasted over [from, to) (caret after it, as the input event leaves it) */
  const edit = (prev: string, from: number, to: number, text: string) => editedTitle(prev, prev.slice(0, from) + text + prev.slice(to), from + text.length);

  it("keeps what was there when one character is typed into a full title (the caret stays)", () => {
    const full = kana(MAX);
    // fieldTitle cut the title's last character and React moved the caret to the end
    expect(edit(full, 10, 10, "ん")).toEqual({ value: full, caret: 10 });
    expect(edit(full, MAX, MAX, "ん")).toEqual({ value: full, caret: MAX });
  });

  it("cuts a paste into the middle of a full title from the pasted text, not from the end of the title", () => {
    const full = kana(MAX);
    expect(edit(full, 20, 20, "0123456789")).toEqual({ value: full, caret: 20 });
    // room for 4 of them: the first 4 go in, the title's end stays
    const t = kana(MAX - 4);
    expect(edit(t, 20, 20, "0123456789")).toEqual({ value: `${t.slice(0, 20)}0123${t.slice(20)}`, caret: 24 });
  });

  it("cuts an IME commit into the middle of a nearly full title (compositionend, against the title it started from)", () => {
    const t = kana(MAX - 5);
    const r = edit(t, 30, 30, "かきくけこさしす");
    expect(r).toEqual({ value: `${t.slice(0, 30)}かきくけこ${t.slice(30)}`, caret: 35 });
    expect(Array.from(r.value)).toHaveLength(MAX);
  });

  it("replaces a selection with as much of the new text as fits", () => {
    const t = kana(MAX - 1);
    // 3 selected characters give way to 6: 4 fit
    expect(edit(t, 5, 8, "ABCDEF")).toEqual({ value: `${t.slice(0, 5)}ABCD${t.slice(8)}`, caret: 9 });
  });

  it("counts and cuts emoji as single characters, never half of one", () => {
    const t = "🎵".repeat(MAX - 1);
    expect(edit(t, 2, 2, "🎶🎶")).toEqual({ value: `🎵🎶${"🎵".repeat(MAX - 2)}`, caret: 4 });
    const full = "🎵".repeat(MAX);
    expect(edit(full, 2, 2, "🎶")).toEqual({ value: full, caret: 2 });
    // 🎶 over a selected 🎵 (they share their first UTF-16 half): whole ones are kept and cut
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const text of ["🎶🎶", "🎶🎶🎶"]) {
      const r = edit(full, 2, 4, text);
      expect(r).toEqual({ value: `🎵🎶${"🎵".repeat(MAX - 2)}`, caret: 4 });
      expect(r.value).not.toMatch(lone);
    }
  });

  it("takes an edit within the limit as it is (a control character becomes a space; the caret stays)", () => {
    expect(edit("夏の", 2, 2, "\t空")).toEqual({ value: "夏の 空", caret: 4 });
    expect(edit("夏の空", 1, 2, "")).toEqual({ value: "夏空", caret: 1 });
  });

  it("still lets a title over the limit get shorter, and takes no edit it cannot place", () => {
    const long = kana(MAX + 3);
    expect(edit(long, 10, 12, "")).toEqual({ value: long.slice(0, 10) + long.slice(12), caret: 10 });
    expect(edit(long, 10, 10, "ん").value).toBe(long);
    // not one insertion before the caret (the text after it is not the old title's end): the title stays
    const full = kana(MAX);
    expect(editedTitle(full, `${full}ん`, 5)).toEqual({ value: full, caret: 5 });
  });
});

describe("AI draft over fields edited while it was written", () => {
  const form = { lyrics: "[Verse]\n夏の", style: "J-pop, 120 BPM", sungLyrics: null as string | null, title: "夏" };
  const none = { lyrics: false, title: false, style: false };

  it("finds nothing when the form was left alone", () => {
    expect(editedWhileWriting(form, { ...form }, false)).toEqual(none);
    expect(editedWhileWriting(form, { ...form }, true)).toEqual(none);
  });

  it("names each field typed into meanwhile", () => {
    expect(editedWhileWriting(form, { ...form, lyrics: "[Verse]\n夏の空" }, false)).toEqual({ ...none, lyrics: true });
    // a reading fixed in the hiragana version counts as the lyrics
    expect(editedWhileWriting(form, { ...form, sungLyrics: "なつの" }, false)).toEqual({ ...none, lyrics: true });
    expect(editedWhileWriting(form, { ...form, title: "夏の終わり" }, false)).toEqual({ ...none, title: true });
    expect(editedWhileWriting(form, { ...form, style: "J-pop, 96 BPM" }, false)).toEqual({ ...none, style: true });
    expect(editedWhileWriting(form, { lyrics: "x", style: "y", sungLyrics: "z", title: "w" }, false)).toEqual({ lyrics: true, title: true, style: true });
  });

  it("ignores the lyrics and the title when only the style is taken", () => {
    expect(editedWhileWriting(form, { ...form, lyrics: "x", sungLyrics: "y", title: "z" }, true)).toEqual(none);
    expect(editedWhileWriting(form, { ...form, title: "z", style: "rock" }, true)).toEqual({ ...none, style: true });
  });

  it("does not count a hiragana version emptied meanwhile (an emptied pane is none: nothing to lose)", () => {
    const withSung = { ...form, sungLyrics: "[Verse]\nなつの" };
    expect(editedWhileWriting(withSung, { ...withSung, sungLyrics: "" }, false)).toEqual(none);
    expect(editedWhileWriting({ ...form, sungLyrics: "" }, { ...form, sungLyrics: "  \n" }, false)).toEqual(none);
    // readings typed into an emptied pane, or a reading fixed, are edits
    expect(editedWhileWriting({ ...form, sungLyrics: "" }, { ...form, sungLyrics: "なつ" }, false)).toEqual({ ...none, lyrics: true });
    expect(editedWhileWriting(withSung, { ...withSung, sungLyrics: "[Verse]\nなつわ" }, false)).toEqual({ ...none, lyrics: true });
  });
});

describe("the note that the piano roll renders the selected song, not the form", () => {
  const song = { style: "J-pop, 120 BPM", lyrics: "[Verse]\n夏の空", lyricsSung: "[Verse]\nなつのそら" };
  const form = { style: song.style, lyrics: song.lyrics, sungLyrics: song.lyricsSung as string | null, language: "ja" as const };

  it("is not shown while the form would sing what the song sang", () => {
    expect(formDiffersFromSong(song, form)).toBe(false);
    // line endings and trailing blanks do not count
    expect(formDiffersFromSong(song, { ...form, sungLyrics: "[Verse]\r\nなつのそら  \n" })).toBe(false);
    // a song sung from its kanji lyrics, and a form without a hiragana version
    expect(formDiffersFromSong({ ...song, lyricsSung: "" }, { ...form, sungLyrics: null })).toBe(false);
    // a form switched to another language sings its lyrics as written, whatever hiragana version is left in it
    const en = { ...song, lyrics: "[Verse]\nsummer sky", lyricsSung: "" };
    expect(formDiffersFromSong(en, { ...form, lyrics: en.lyrics, sungLyrics: "なつの", language: "en" })).toBe(false);
    expect(formDiffersFromSong(en, { ...form, lyrics: en.lyrics, sungLyrics: "なつの", language: "ja" })).toBe(true);
  });

  it("is what the page shows the note from", () => {
    expect(PAGE).toContain("const formDiffers = Boolean(selected && formDiffersFromSong(selected, { style, lyrics, sungLyrics, language: lyricsLanguage }));");
    expect(PAGE).toContain("{selected && formDiffers && (");
  });

  it("is shown when the style, the kanji lyrics or what the form would sing differ", () => {
    expect(formDiffersFromSong(song, { ...form, style: "rock" })).toBe(true);
    expect(formDiffersFromSong(song, { ...form, lyrics: "[Verse]\n夏の海" })).toBe(true);
    // a reading fixed, the hiragana version emptied (the kanji lyrics would be sung), or dropped
    expect(formDiffersFromSong(song, { ...form, sungLyrics: "[Verse]\nなつのうみ" })).toBe(true);
    expect(formDiffersFromSong(song, { ...form, sungLyrics: "" })).toBe(true);
    expect(formDiffersFromSong(song, { ...form, sungLyrics: null })).toBe(true);
  });
});

describe("the form's ABC after 「この譜面で再生成」", () => {
  const song = "X:1\nK:C\nV:Vocal\nC4|";
  const edited = "X:1\nK:C\nV:Vocal\nD4|";
  const otherEdit = "X:1\nK:G\nV:Vocal\nG4|";

  it("takes a copy of the rendered score when that loses nothing", () => {
    expect(formAbcAfterRerender("", edited, [song, null])).toBe(edited);
    expect(formAbcAfterRerender("  \n", edited, [song, null])).toBe(edited);
    // the song's own score (「選択中の曲の譜面を読み込む」), or this very score
    expect(formAbcAfterRerender(song, edited, [song, null])).toBe(edited);
    expect(formAbcAfterRerender(edited, edited, [song, null])).toBe(edited);
    // the score the previous re-render copied there (its new song keeps it)
    expect(formAbcAfterRerender(otherEdit, edited, [song, otherEdit])).toBe(edited);
  });

  it("keeps a score only the form holds (another song's edit loaded with 「ABC 欄に読み込む」, a pasted score)", () => {
    expect(formAbcAfterRerender(otherEdit, edited, [song, null])).toBe(otherEdit);
    expect(formAbcAfterRerender(otherEdit, edited, [undefined, null])).toBe(otherEdit);
  });

  it("is applied once the render was queued, to the field as it is then, and the toast says when it was kept", () => {
    const rerender = code("onRender={(a, hasChords) =>", "onRenderInstrumental=");
    expect(rerender).toMatch(/const kept = \[selected\?\.abc, rerendered\.current\];/);
    expect(rerender).toMatch(/const keepsForm = formAbcAfterRerender\(abc, a, kept\) !== a;/);
    expect(rerender).toMatch(/notes: \[\.\.\.\(req\.notes \?\? \[\]\), \.\.\.\(keepsForm \? \[FORM_ABC_KEPT_NOTE\] : \[\]\)\]/);
    expect(rerender).toMatch(/if \(ok\) \{\s*\/\/[^\n]*\n\s*setAbc\(\(cur\) => formAbcAfterRerender\(cur, a, kept\)\);\s*rerendered\.current = a;/);
    // no other write of the form's ABC
    expect(rerender.match(/setAbc\(/g)).toHaveLength(1);
    expect(FORM_ABC_KEPT_NOTE).toContain("「譜面を指定して生成」の ABC 欄");
  });
});

describe("an instrumental planned from the form", () => {
  it("says when the style was edited while its score was planned (the render keeps the planned style)", () => {
    expect(planningStyleNotes("jazz, saxophone, 90 BPM", "jazz, saxophone, 90 BPM")).toEqual([]);
    expect(planningStyleNotes("jazz, saxophone, 90 BPM ", "jazz, saxophone, 90 BPM")).toEqual([]);
    const [note] = planningStyleNotes("jazz, saxophone, 90 BPM", "rock, electric guitar, 90 BPM");
    expect(note).toMatch(/計画中に変更したスタイル/);
    const generate = code("const generateInstrumental = async", "const selectedRequest");
    expect(generate).toMatch(/notes: planningStyleNotes\(style, formNow\.current\.style\)/);
  });

  it("takes the length settings as they are after the planning (設定 may change the default or the limit meanwhile)", () => {
    const submit = code("const submitWith = async", "const renderInstrumentalFromAbc");
    expect(submit).toMatch(/durations: \{ \.\.\.durationsNow\.current, fallbackEstimate: estimate \}/);
    // not the values of the render it was called from
    expect(submit).not.toMatch(/\b(?:autoDuration|defaultMax|limit)\b|manual: maxDuration/);
    expect(PAGE).toMatch(/durationsNow\.current = \{ auto: autoDuration, manual: maxDuration, limit, defaultMax \};/);
  });
});

describe("the piano roll on 作曲", () => {
  it("knows which song its score belongs to (two variations may have the same score text)", () => {
    const editor = code("<ScoreEditor", "/>");
    expect(editor).toMatch(/loadKey=\{selKey\}/);
  });
});

// The page's async guards (no DOM test setup here): read from the source, so removing one fails a test.
/** The body of the arrow function declared by `decl` (from its first "{" to the matching "}"). */
function body(decl: string): string {
  const at = PAGE.indexOf(decl);
  expect(at, decl).toBeGreaterThan(-1);
  const open = PAGE.indexOf("{", PAGE.indexOf("=>", at));
  let depth = 0;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === "{") depth++;
    else if (PAGE[i] === "}" && --depth === 0) return PAGE.slice(open, i + 1);
  }
  throw new Error(`unbalanced body of ${decl}`);
}

/** The source line of `code` around position `at`. */
const lineAt = (code: string, at: number) => code.slice(code.lastIndexOf("\n", at) + 1, code.indexOf("\n", at));

describe("作曲's guards against late results", () => {
  it("drops an AI draft that arrives after its キャンセル, before it asks or sets anything", () => {
    const write = body("const writeWithAi = async (");
    const wait = write.indexOf("await writeSong(");
    expect(wait).toBeGreaterThan(-1);
    const late = write.slice(wait);
    const firstUse = late.search(/\b(?:editedWhileWriting|ask|showToast|set[A-Z]\w*)\(/);
    expect(firstUse).toBeGreaterThan(-1);
    expect(late.slice(0, firstUse)).toContain("if (writeReq.current !== requestId) return;");
    // キャンセル is what clears the request id
    expect(body("const cancelWriting = (")).toMatch(/writeReq\.current = null;/);
  });

  it("asks before an AI draft replaces what was typed while it was written, and writes nothing when that is cancelled", () => {
    const write = body("const writeWithAi = async (");
    const wait = write.indexOf("await writeSong(");
    // the form as it was at the click (after the replace question), not a later one
    const atClick = write.indexOf("const atClick = { lyrics, style, sungLyrics, title };");
    expect(atClick).toBeGreaterThan(write.indexOf('title: "入力済みの内容を置き換えます"'));
    expect(atClick).toBeLessThan(wait);
    // against the form as it is when the draft arrives (formNow follows every render)
    expect(PAGE).toMatch(/useEffect\(\(\) => \{\s*formNow\.current = \{ lyrics, style, sungLyrics, title \};\s*\}\);/);
    const late = write.slice(wait);
    // the first thing done with a draft that is still wanted, before any question or write
    const firstUse = late.search(/\b(?:editedWhileWriting|ask|showToast|set[A-Z]\w*)\(/);
    expect(late.slice(firstUse)).toMatch(/^editedWhileWriting\(atClick, formNow\.current, styleOnly\)/);
    const firstWrite = late.search(/\bset[A-Z]\w*\(/);
    const meanwhile = late.slice(firstUse, firstWrite);
    expect(meanwhile).toMatch(/if \(meanwhile\.lyrics \|\| meanwhile\.title \|\| meanwhile\.style\) \{/);
    expect(meanwhile).toContain('title: "作成中に編集された内容があります"');
    expect(meanwhile).toContain('if (!c) return showToast("info", "AI の案は反映しませんでした");');
    expect(meanwhile).toContain('if (c === "style") styleOnly = true;');
    // the lyrics and the title only when they are to be replaced (スタイルだけ反映 leaves them as typed)
    expect(late.slice(firstWrite)).toMatch(/^setLyrics\(/);
    expect(late.slice(0, firstWrite)).toMatch(/if \(!styleOnly\) \{\s*$/);
  });

  it("follows a queued song only while 作曲 is shown (a hidden page does not change what the other pages work on)", () => {
    const submit = body("const submitWith = async (");
    const calls = Array.from(submit.matchAll(/\bselectSong\(/g), (m) => m.index);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(submit.indexOf("await api.generate("));
    expect(lineAt(submit, calls[0])).toMatch(/if \(visibility\.current\.active\b[^)]*\) selectSong\(/);
  });
});

describe("an instrumental from a score with bars shorter or longer than the meter", () => {
  const pickup = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal\nV: Ins\nK:C\nV: Vocal\nG4|"C"c4B4A4G4|"F"A16|\nV: Ins\nz4|C16|F16|\n';

  it("is sent with its later bar lines rewritten to the meter's grid", () => {
    expect(parseAbcDetailed(pickup).irregularBars).not.toEqual([]);
    const sent = serializeAbc(toInstrumental(parseAbc(pickup)).score);
    expect(parseAbcDetailed(sent).irregularBars).toEqual([]);
  });

  it("says so in the toast, naming the bars of the score it was converted from (as the Melody chord strip does)", () => {
    const render = body("const renderInstrumentalFromAbc = async (");
    expect(render).toMatch(/\{ score: parsed, irregularBars \} = parseAbcDetailed\(sourceAbc\)/);
    const moved = render.indexOf("irregularBarsNotice(irregularBars, true)");
    expect(moved).toBeGreaterThan(render.indexOf("const notes = "));
    expect(moved).toBeLessThan(render.indexOf("return submitWith("));
    expect(render).toMatch(/if \(rebarred\) notes\.push\(rebarred\);/);
    expect(render).toMatch(/\bnotes,\n/);
  });
});
