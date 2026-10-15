// E2E harness, TypeScript steps (not part of `npx vitest run`: the repo config only includes
// src/**/__tests__). Run from the repo root with MCS_E2E_DIR set:
//   npx vitest run --config tools/e2e/vitest.config.ts
// 1. inputs/instrumental.json: the instrumental request ComposePage.renderInstrumentalFromAbc builds
//    from src/abc/__fixtures__/full_en.abc (toInstrumental + serializeAbc + instrumentalStyle + tags).
// 2. inputs/align_ja.txt: the Japanese alignment text ExportPage sends (alignmentText with kuromoji) for a song
//    with a hiragana version; inputs/align_ja_kanji.txt: the same for a song without one (the kanji lyrics go
//    out as kuromoji's hiragana reading, toAlignmentReading(lyrics, lyrics)).
// 3. parsed/sync_<scenario>.json: the alignment results through applyAlignment (once they exist), with the
//    song's length as ExportPage passes it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import kuromoji, { type IpadicFeatures, type Tokenizer } from "kuromoji";
import { describe, expect, it } from "vitest";
import { parseAbc } from "../../src/abc/parse";
import { serializeAbc } from "../../src/abc/serialize";
import { hasTimelineChanges } from "../../src/abc/model";
import { instrumentalStyle, lyricTagsFromAbc, toInstrumental } from "../../src/abc/instrumental";
import { validateNativeAbc } from "../../src/abc/native";
import { provenanceParams, statedAbcTempo } from "../../src/compose/rules";
import { styleBpm, styleBpmDiffers, withStyleBpm } from "../../src/lyrics/styleBpm";
import { alignmentText } from "../../src/lyrics/hiragana";
import { applyAlignment, countRejectedAlignments, isConfidentAlignment, plainLyricLines } from "../../src/export/syncedLines";
import type { AlignedLine } from "../../src/api";

const DIR = process.env.MCS_E2E_DIR ?? "";
const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
// Keep in sync with src-tauri/src/e2e/mod.rs (STYLE of gen_d1, LYRICS_JA_*).
const FIXTURE_STYLE = "pop, female vocal, piano, acoustic guitar, 86 BPM";
const LYRICS_JA_SUNG = "[Verse]\nよぞらにひかるほしをみて\nきみのなまえをよんでいる\n\n[Chorus]\nわたしはうたう あしたへむかって\nこのこえがとどくまで\n";
const LYRICS_JA_DISPLAY = "[Verse]\n夜空に光る星を見て\n君の名前を呼んでいる\n\n[Chorus]\n私は歌う 明日へ向かって\nこの声が届くまで\n";

function write(rel: string, text: string) {
  const p = join(DIR, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

describe.skipIf(!DIR)("e2e TypeScript steps", () => {
  it("instrumental request from the fixture (ComposePage.renderInstrumentalFromAbc)", () => {
    const source = readFileSync(repo("src/abc/__fixtures__/full_en.abc"), "utf8");
    const parsed = parseAbc(source);
    expect(hasTimelineChanges(parsed)).toBe(false);
    const styleTempo = styleBpm(FIXTURE_STYLE);
    if (statedAbcTempo(source) === null && styleTempo !== null) parsed.bpm = styleTempo;
    const r = toInstrumental(parsed);
    const transformed = serializeAbc(r.score);
    let base = FIXTURE_STYLE;
    if (styleBpmDiffers(base, r.score.bpm)) base = withStyleBpm(base, r.score.bpm);
    const mode = r.score.chords.length > 0 ? "full" : "melody";
    // provenance as submitWith adds it (provenanceParams of { sourceAbc, instrumentalTransfer }); e2e_build_graphs
    // forwards it into gen_d2's payload
    const provenance = provenanceParams({ sourceAbc: source, instrumentalTransfer: { movedNotes: r.movedNotes, overlaps: r.overlaps } });
    const request = {
      mode,
      abc: transformed,
      lyrics: lyricTagsFromAbc(transformed),
      style: instrumentalStyle(base),
      movedNotes: r.movedNotes,
      overlaps: r.overlaps,
      ...provenance,
    };
    const check = validateNativeAbc(transformed);
    write("inputs/instrumental.json", JSON.stringify({ ...request, nativeCheck: check }, null, 2));
    write("inputs/instrumental.abc", transformed);
    write("inputs/fixture_full_en.abc", source);
    expect(r.movedNotes).toBeGreaterThan(0);
    expect(request.sourceAbc).toBe(source);
    expect(request.instrumentalTransfer).toEqual({ movedNotes: r.movedNotes, overlaps: r.overlaps });
    expect(r.score.notes.every((n) => n.voice === "Ins")).toBe(true);
    expect(parseAbc(transformed).notes.filter((n) => n.voice === "Vocal")).toHaveLength(0);
  });

  it("Japanese alignment text (ExportPage: alignmentText over the sung lines)", async () => {
    const dicPath = repo("node_modules/kuromoji/dict/");
    const tokenizer = await new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) =>
      kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t))),
    );
    const text = alignmentText(LYRICS_JA_SUNG, LYRICS_JA_DISPLAY, (line) => tokenizer.tokenize(line));
    write("inputs/align_ja.txt", text);
    // 私は -> わ, 明日へ -> え; the line structure stays 1:1.
    expect(text.split("\n").length).toBe(LYRICS_JA_SUNG.split("\n").length);
    expect(text).toContain("わたしわうたう あしたえむかって");
    // the kanji lyrics themselves (no hiragana version): kanji go out as kuromoji's reading
    const kanji = alignmentText(LYRICS_JA_DISPLAY, LYRICS_JA_DISPLAY, (line) => tokenizer.tokenize(line));
    write("inputs/align_ja_kanji.txt", kanji);
    expect(kanji.split("\n").length).toBe(LYRICS_JA_DISPLAY.split("\n").length);
    expect(kanji).not.toMatch(/[一-鿿]/);
    expect(kanji).toContain("きみのなまえをよんでいる");
    expect(kanji).toContain("わたしわうたう あしたえむかって");
  }, 120_000);

  it("alignment results through applyAlignment (ExportPage.autoAlign)", () => {
    // ExportPage passes the song's length (selected.duration, ms) as the end for interpolated lines: the song
    // behind an align scenario is the source of the separation it aligns (align -> sep -> generation).
    const manifest = existsSync(join(DIR, "manifest.json")) ? JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) : { scenarios: [] };
    const sourceOf = (name: string): string | undefined => manifest.scenarios.find((x: { name: string }) => x.name === name)?.meta?.source;
    const songDurationMs = (name: string): number | null => {
      const song = sourceOf(sourceOf(name) ?? "");
      const p = song ? join(DIR, "parsed", `${song}.json`) : "";
      const d = p && existsSync(p) ? Number(JSON.parse(readFileSync(p, "utf8")).duration) : 0;
      return d > 0 ? Math.round(d * 1000) : null;
    };
    const cases: [string, string, string][] = [
      ["align_i_en", "[Verse]\nMorning light across the window\nCity waking down below\n\n[Chorus]\nSing it loud and let it go\nHearts are shining, feel the glow\n", ""],
      ["align_i_ja", LYRICS_JA_DISPLAY, LYRICS_JA_SUNG],
      // a song without a hiragana version (lyricsSung null): ExportPage aligns the kanji lyrics themselves
      ["align_i_ja_kanji", LYRICS_JA_DISPLAY, ""],
    ];
    for (const [name, lyrics, sung] of cases) {
      const parsedPath = join(DIR, "parsed", `${name}.json`);
      if (!existsSync(parsedPath)) continue;
      const parsed = JSON.parse(readFileSync(parsedPath, "utf8"));
      const aligned: AlignedLine[] = parsed.lines ?? [];
      const plainCount = (t: string) => t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("[")).length;
      const alignText = sung.trim() && plainCount(sung) === plainCount(lyrics) ? sung : lyrics;
      const plain = plainLyricLines(lyrics);
      const durationMs = songDurationMs(name);
      expect(durationMs).not.toBeNull();
      const lines = applyAlignment(plain, alignText, aligned, durationMs);
      write(`parsed/sync_${name}.json`, JSON.stringify(lines, null, 2));
      expect(lines.length).toBe(plain.length);
      // lines the aligner squeezed into the audio's end (never sung) are estimated, not taken as aligned
      expect(lines.filter((l) => l.src === "aligned").length).toBe(aligned.filter(isConfidentAlignment).length);
      // align_i_en: the 20 s budget ended before the chorus was sung
      if (name === "align_i_en") expect(countRejectedAlignments(plain, alignText, aligned)).toBe(2);
      if (name === "align_i_ja" || name === "align_i_ja_kanji") expect(countRejectedAlignments(plain, alignText, aligned)).toBe(0);
      for (let i = 1; i < lines.length; i++) expect(lines[i].timeMs).toBeGreaterThanOrEqual(lines[i - 1].timeMs);
      // lines estimated after the last aligned one are spread towards the song's end, not stacked on it
      const lastAligned = lines.map((l) => l.src).lastIndexOf("aligned");
      const tail = lastAligned >= 0 ? lines.slice(lastAligned + 1) : [];
      for (let i = 0; i < tail.length; i++) {
        expect(tail[i].timeMs).toBeGreaterThan(i === 0 ? lines[lastAligned].timeMs : tail[i - 1].timeMs);
        expect(tail[i].timeMs).toBeLessThan(durationMs!);
      }
      // ... and none shows while the last aligned line is still sung (its aligner end, when inside the song)
      const sungEnd = lastAligned >= 0 ? lines[lastAligned].endMs : undefined;
      if (tail.length > 0 && sungEnd !== undefined && sungEnd < durationMs!) expect(tail[0].timeMs).toBeGreaterThanOrEqual(sungEnd);
    }
  });
});
