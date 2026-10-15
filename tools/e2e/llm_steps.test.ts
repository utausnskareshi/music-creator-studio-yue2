// LLM end-to-end harness, TypeScript steps (src-tauri/src/e2e/llm_e2e.rs has the flow). Run from the repo root with
// MCS_LLM_E2E_DIR set:
//   npx vitest run --config tools/e2e/vitest.config.ts
// 1. inputs/llm_cases.json: the draft requests the compose page sends (songwriter.ts systemPrompt / songSchema and
//    writeSong's user message) for several briefs, languages, lengths and thinking settings, and AI edit
//    instructions on the fixture score (src/abc/__fixtures__/full_en.abc).
// 2. results/report.json, once results exist: every reply checked with the page's own code (parseSongDraft for a
//    draft; replyVerdict, validateNativeAbc and compareScores as EditPage uses them for an edit). "fail" is what the
//    app would show as an error (no reply, a reply the page cannot read); "warn" is a reply the page accepts that
//    does not do what was asked (wrong length, language, a melody changed against the instruction, ...).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareScores } from "../../src/abc/compare";
import { validateNativeAbc } from "../../src/abc/native";
import { parseAbc } from "../../src/abc/parse";
import { dropRepeatedFields, reaskText, replyVerdict, statedAbcTempo, worthReask } from "../../src/compose/rules";
import { parseSongDraft, songSchema, systemPrompt, userMessage, type SongLength } from "../../src/lyrics/songwriter";
import type { LyricsLanguage } from "../../src/lyrics/hiragana";
import { BPM_MAX, BPM_MIN, styleBpm } from "../../src/lyrics/styleBpm";

const DIR = process.env.MCS_LLM_E2E_DIR ?? "";
const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
// Keep in sync with src-tauri/src/e2e/mod.rs (the style of gen_d1, LYRICS_FIXTURE_EN).
const FIXTURE_STYLE = "pop, female vocal, piano, acoustic guitar, 86 BPM";
const FIXTURE_LYRICS =
  "[Intro]\n\n[Verse]\nWalking down the empty road tonight\nStars are falling\nEvery step I take is leading home\nTo you\nSummer rain is washing all the lights\nSoftly calling\nEvery dream I had is coming true\nFor you\n\n[Chorus]\nHold me close and never let me go\nStay with me\nWe will sing until the morning light is here\nShining bright\nHold me close and never let me go\nStay with me\nAll the stars above\nAre shining on\n\n[Outro]\nHome\n";

interface DraftCase {
  name: string;
  brief: string;
  lang: LyricsLanguage;
  length: SongLength;
  settings?: Record<string, unknown>;
}
const DRAFTS: DraftCase[] = [
  // the brief that failed four times in a row before the draft's JSON fields kept the page's order, three times
  { name: "d_ja_std_love_1", brief: "女性ボーカルで切ないラブソング", lang: "ja", length: "standard" },
  { name: "d_ja_std_love_2", brief: "女性ボーカルで切ないラブソング", lang: "ja", length: "standard" },
  { name: "d_ja_std_love_3", brief: "女性ボーカルで切ないラブソング", lang: "ja", length: "standard" },
  { name: "d_ja_short", brief: "夏の海で友達とはしゃぐ明るいポップス", lang: "ja", length: "short" },
  { name: "d_ja_short_2", brief: "女性ボーカルで切ないラブソング", lang: "ja", length: "short" },
  { name: "d_ja_short_3", brief: "冬の朝に聴きたい、温かいアコースティックな曲", lang: "ja", length: "short" },
  { name: "d_en_short", brief: "ドライブ中に聴きたい爽快なロック", lang: "en", length: "short" },
  { name: "d_ja_long", brief: "夢を追いかける若者を応援する、疾走感のあるロック", lang: "ja", length: "long" },
  { name: "d_en_std", brief: "失恋から立ち直る、希望に満ちたアンセム", lang: "en", length: "standard" },
  { name: "d_zh_std", brief: "故郷を思う静かなバラード", lang: "zh", length: "standard" },
  { name: "d_zh_short", brief: "春の公園を散歩する明るい曲", lang: "zh", length: "short" },
  { name: "d_other_es", brief: "スペイン語で歌う、情熱的なラテンのダンス曲", lang: "other", length: "short" },
  { name: "d_instrumental_ask", brief: "歌なしの、ピアノだけの穏やかなインスト曲", lang: "ja", length: "short" },
  { name: "d_ja_std_nothink", brief: "女性ボーカルで切ないラブソング", lang: "ja", length: "standard", settings: { thinking: false } },
  { name: "d_ja_std_uncapped", brief: "女性ボーカルで切ないラブソング", lang: "ja", length: "standard", settings: { limitThinking: false } },
];

interface EditCase {
  name: string;
  instruction: string;
}
const EDITS: EditCase[] = [
  { name: "e_tempo_up", instruction: "テンポを 8 上げて" },
  { name: "e_reharm_keep_melody", instruction: "サビのコードをジャズ風にリハーモナイズして。メロディは変えないで" },
  { name: "e_style_brighter", instruction: "スタイルをもっと明るい雰囲気にして。譜面と歌詞は変えないで" },
  { name: "e_rewrite_chorus_lyrics", instruction: "サビの歌詞をもっと前向きな内容に書き直して。譜面は変えないで" },
  { name: "e_add_bridge", instruction: "サビの後にブリッジを 4 小節追加して、歌詞も付けて" },
];

function write(rel: string, text: string) {
  const p = join(DIR, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

type Finding = { level: "fail" | "warn" | "info"; text: string };
interface CaseReport {
  name: string;
  kind: string;
  status: "pass" | "warn" | "fail";
  attempts?: number;
  seconds?: number;
  completionTokens?: number;
  findings: Finding[];
  summary?: Record<string, unknown>;
}

/** Lyric lines (not tags, not blank). */
const lyricLines = (lyrics: string) => lyrics.split("\n").map((l) => l.trim()).filter((l) => l && !/^\[.*\]$/.test(l));
const tags = (lyrics: string) => (lyrics.match(/^\[[^\]]+\]$/gm) ?? []).map((t) => t.toLowerCase());
const LINE_RANGE: Record<SongLength, [number, number]> = { short: [6, 14], standard: [18, 40], long: [26, 52] };

function checkDraft(c: DraftCase, r: Record<string, any>): CaseReport {
  const rep: CaseReport = { name: c.name, kind: "draft", status: "pass", attempts: r.attempts, seconds: r.seconds, completionTokens: r.completionTokens, findings: [] };
  const add = (level: Finding["level"], text: string) => rep.findings.push({ level, text });
  if (!r.ok) {
    add("fail", `request failed: ${r.error}`);
  } else {
    try {
      const d = parseSongDraft(r.content, { seconds: r.seconds, provider: "local", attempts: r.attempts, language: c.lang });
      const lines = lyricLines(d.lyrics);
      const t = tags(d.lyrics);
      const bpm = styleBpm(d.style);
      rep.summary = { title: d.title, lines: lines.length, tags: t, style: d.style, bpm, chips: d.selection.groups, explanation: d.explanation };
      if (!d.title) add("warn", "no title");
      const [lo, hi] = LINE_RANGE[c.length];
      if (lines.length < lo || lines.length > hi) add("warn", `${lines.length} lyric lines for "${c.length}" (expected about ${lo}-${hi})`);
      // the short structure is one verse and one chorus
      if (c.length === "short" && t.length > 3) add("warn", `${t.length} sections for "short": ${t.join(" ")}`);
      const word = { ja: "japanese", en: "english", zh: "mandarin", other: "" }[c.lang];
      const first = d.style.split(",")[0].trim().toLowerCase();
      if (word && first !== word) add("warn", `the style starts with "${first}" (expected ${word})`);
      if (!t.some((x) => x.includes("verse")) || !t.some((x) => x.includes("chorus"))) add("warn", `sections ${t.join(" ")}`);
      if (bpm === null) add("warn", `the style names no tempo: ${d.style}`);
      else if (bpm < BPM_MIN || bpm > BPM_MAX) add("warn", `tempo ${bpm} outside ${BPM_MIN}-${BPM_MAX}`);
      if (!d.selection.groups.genre?.length) add("warn", "no chips selected (the reply's selections were unusable)");
      const text = lines.join("");
      const kana = /[ぁ-ヿ]/.test(text);
      const han = /[一-鿿]/.test(text);
      const latin = (text.match(/[A-Za-z]/g) ?? []).length / Math.max(1, text.replace(/\s/g, "").length);
      const lang = d.selection.groups.lang?.[0];
      if (c.lang === "ja" && (!kana || lang !== "Japanese")) add("warn", `Japanese asked: kana ${kana}, language chip ${lang}`);
      if (c.lang === "en" && (latin < 0.8 || lang !== "English")) add("warn", `English asked: latin share ${latin.toFixed(2)}, language chip ${lang}`);
      if (c.lang === "zh" && (!han || kana || lang !== "Mandarin")) add("warn", `Mandarin asked: han ${han}, kana ${kana}, language chip ${lang}`);
      if (c.lang === "other" && latin < 0.8) add("warn", `Spanish asked: latin share ${latin.toFixed(2)}`);
      if (c.lang === "other" && lang) add("warn", `a language chip (${lang}) for Spanish lyrics (the page keeps it: the style starts with ${lang})`);
      if (c.lang === "other" && !/^spanish\b/i.test(d.style)) add("warn", `the style does not start with Spanish: ${d.style}`);
      if (c.name === "d_instrumental_ask" && !/インストゥルメンタル版を生成/.test(d.explanation)) add("warn", `the explanation does not point to 「インストゥルメンタル版を生成」: ${d.explanation}`);
      if (r.attempts > 1) add("info", "answered on the second try (the first ran to the length limit)");
    } catch (e) {
      add("fail", `the page cannot read the reply: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  rep.status = rep.findings.some((f) => f.level === "fail") ? "fail" : rep.findings.some((f) => f.level === "warn") ? "warn" : "pass";
  return rep;
}


type EditFields = { abc: string; style: string; lyrics: string; explanation: string };
const SENT = (source: string) => ({ abc: source, style: FIXTURE_STYLE, lyrics: FIXTURE_LYRICS });
const reaskName = (c: EditCase) => `${c.name}__reask`;

/** The first reply's verdict and whether the edit page re-asks it (EditPage: worthReask with the sent score's own state). */
function firstVerdict(c: EditCase, reply: EditFields, source: string) {
  const bars = parseAbc(source).bars;
  const verdict = replyVerdict(bars, reply.abc, c.instruction);
  return { bars, verdict, reask: worthReask(verdict, true, validateNativeAbc(source).errors.length) };
}

function checkEdit(c: EditCase, r: Record<string, any>, source: string, reask: Record<string, any> | null): CaseReport {
  const rep: CaseReport = { name: c.name, kind: "edit", status: "pass", attempts: r.attempts, seconds: r.seconds, completionTokens: r.completionTokens, findings: [] };
  const add = (level: Finding["level"], text: string) => rep.findings.push({ level, text });
  if (!r.ok) add("fail", `request failed: ${r.error}`);
  else if (r.parseError) add("fail", `the page cannot read the reply: ${r.parseError}`);
  else {
    const first = r.reply as EditFields;
    const f = firstVerdict(c, first, source);
    let reply = first;
    let verdict = f.verdict;
    const summary: Record<string, unknown> = { firstVerdict: f.verdict };
    rep.summary = summary;
    if (f.reask) {
      if (!reask) add("info", "the page would re-ask: its reply is not there yet (run e2e_llm_run again)");
      // a re-ask answers one first reply (e2e_llm_run records it): one built from an earlier reply is not this one's
      else if (reask.basedOn !== r.content) add("info", "the page would re-ask: the stored re-ask was built from an earlier first reply (run e2e_llm_run again)");
      else if (!reask.ok || reask.parseError) add("warn", `the re-ask failed (the page keeps the first reply): ${reask.error ?? reask.parseError}`);
      else {
        const second = reask.reply as EditFields;
        const v2 = replyVerdict(f.bars, second.abc, c.instruction);
        summary.reaskVerdict = v2;
        // EditPage: a re-ask that came back without a score is worse than the first reply
        if (second.abc.trim() || !first.abc.trim()) {
          reply = second;
          verdict = v2;
        }
        add("info", `re-asked once (${(reask.seconds ?? 0).toFixed(0)} s)`);
      }
    }
    const dropped = dropRepeatedFields(reply, SENT(source));
    reply = dropped.reply;
    if (dropped.repeated.includes("abc")) verdict = null;
    summary.changed = { abc: Boolean(reply.abc.trim()), style: Boolean(reply.style.trim()), lyrics: Boolean(reply.lyrics.trim()) };
    summary.repeated = dropped.repeated;
    summary.explanation = reply.explanation;
    if (verdict) add("warn", `the score the page offers still has findings: ${JSON.stringify(verdict).slice(0, 300)}`);
    let diff: ReturnType<typeof compareScores> | null = null;
    if (reply.abc.trim() && (!verdict || verdict.kind !== "parse")) {
      diff = compareScores(parseAbc(source), parseAbc(reply.abc));
      summary.diff = diff.lines;
    }
    const replyBpm = reply.style.trim() ? styleBpm(reply.style) : null;
    const replyQ = reply.abc.trim() ? statedAbcTempo(reply.abc) : null;
    switch (c.name) {
      case "e_tempo_up":
        if (replyQ !== 94) add("warn", `Q: ${replyQ} (expected 94)`);
        if (replyBpm !== 94) add("warn", `style tempo ${replyBpm} (expected 94; the prompt asks to change both)`);
        break;
      case "e_reharm_keep_melody":
        if (!diff) add("warn", "no score to apply");
        else {
          const v = diff.voices.Vocal;
          if (v.changed || v.added || v.removed || diff.barCount) add("warn", `the vocal melody changed: ${diff.lines.join(" / ")}`);
          if (!diff.chordBars.length) add("warn", "no chord changed");
        }
        break;
      case "e_style_brighter":
        if (!reply.style.trim()) add("warn", "the style did not change");
        if (reply.abc.trim() || reply.lyrics.trim()) add("warn", "the score or the lyrics came back changed");
        if (replyBpm !== null && replyBpm !== 86 && !reply.abc.trim()) add("warn", `the style tempo changed to ${replyBpm} without the score`);
        break;
      case "e_rewrite_chorus_lyrics":
        if (!reply.lyrics.trim()) add("warn", `the lyrics did not change${dropped.repeated.includes("lyrics") ? " (returned unchanged; the page now says so)" : ""}`);
        if (reply.abc.trim()) add("warn", "the score came back changed");
        if (reply.lyrics.trim() && tags(reply.lyrics).join() !== tags(FIXTURE_LYRICS).join()) add("warn", `sections changed: ${tags(reply.lyrics).join(" ")}`);
        break;
      case "e_add_bridge":
        if (!diff) add("warn", "no score to apply");
        else if (!diff.barCount || diff.barCount.to <= diff.barCount.from) add("warn", `bars ${JSON.stringify(diff.barCount)}`);
        if (!/\[bridge\]/i.test(reply.lyrics)) add("warn", "no [Bridge] in the lyrics");
        break;
    }
    if (reply.abc.trim()) {
      const nat = validateNativeAbc(reply.abc);
      if (!nat.ok) summary.nativeErrors = nat.errors.slice(0, 8);
    }
    if (r.attempts > 1) add("info", "answered on the second try");
  }
  rep.status = rep.findings.some((f) => f.level === "fail") ? "fail" : rep.findings.some((f) => f.level === "warn") ? "warn" : "pass";
  return rep;
}

describe.skipIf(!DIR)("LLM e2e TypeScript steps", () => {
  const source = readFileSync(repo("src/abc/__fixtures__/full_en.abc"), "utf8");

  it("writes the cases (the requests the pages send)", () => {
    const cases = [
      ...DRAFTS.map((c) => ({ name: c.name, kind: "draft", settings: c.settings ?? {}, system: systemPrompt(c.lang, c.length), user: userMessage(c.brief, c.length), schema: songSchema(c.lang) })),
      ...EDITS.map((c) => ({ name: c.name, kind: "edit", settings: {}, ...SENT(source), sungLyrics: null, history: [], instruction: c.instruction })),
    ];
    write("inputs/llm_cases.json", JSON.stringify(cases, null, 1));
    // the draft schema is sent in the page's order (title first, explanation last)
    expect(Object.keys(songSchema("ja").properties)).toEqual(["title", "lyrics", "style", "selections", "explanation"]);
  });

  const resultsDir = join(DIR, "results");
  it.skipIf(!DIR || !existsSync(resultsDir))("checks the results with the pages' own code", () => {
    const reports: CaseReport[] = [];
    const missing: string[] = [];
    const read = (name: string, required = true) => {
      const p = join(resultsDir, `${name}.json`);
      if (!existsSync(p)) {
        if (required) missing.push(name);
        return null;
      }
      return JSON.parse(readFileSync(p, "utf8"));
    };
    for (const c of DRAFTS) {
      const r = read(c.name);
      if (r) reports.push(checkDraft(c, r));
    }
    // the edit page's automatic re-asks (one per reply that gets one), sent by the next e2e_llm_run
    const reasks: unknown[] = [];
    for (const c of EDITS) {
      const r = read(c.name);
      if (!r) continue;
      if (r.ok && !r.parseError) {
        const f = firstVerdict(c, r.reply, source);
        if (f.reask && f.verdict) {
          reasks.push({ name: reaskName(c), kind: "edit", settings: {}, ...SENT(source), sungLyrics: null, history: [{ role: "user", content: c.instruction }, { role: "assistant", content: r.content }], instruction: reaskText(f.verdict, f.bars) });
        }
      }
      reports.push(checkEdit(c, r, source, read(reaskName(c), false)));
    }
    write("inputs/llm_cases_reask.json", JSON.stringify(reasks, null, 1));
    const known = new Set([...DRAFTS.map((c) => c.name), ...EDITS.map((c) => c.name), ...EDITS.map(reaskName)].map((n) => `${n}.json`));
    const unknown = readdirSync(resultsDir).filter((f) => f.endsWith(".json") && f !== "report.json" && !known.has(f));
    const report = {
      cases: reports,
      missing,
      unknown,
      reasksWritten: reasks.length,
      counts: { pass: reports.filter((r) => r.status === "pass").length, warn: reports.filter((r) => r.status === "warn").length, fail: reports.filter((r) => r.status === "fail").length },
    };
    write("results/report.json", JSON.stringify(report, null, 1));
    expect(missing, "cases without a result (run e2e_llm_run)").toEqual([]);
    expect(reports.filter((r) => r.status === "fail").map((r) => `${r.name}: ${r.findings.map((f) => f.text).join("; ")}`)).toEqual([]);
  });
});
