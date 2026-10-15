import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbc } from "../parse";
import { serializeAbc } from "../serialize";
import { instrumentalStyle, instrumentalTitle, lyricTagsFromAbc, pyTitle, toInstrumental } from "../instrumental";

const fx = (name: string) => readFileSync(join(__dirname, "..", "__fixtures__", name), "utf8");

describe("toInstrumental", () => {
  it("moves all vocal notes into the Ins voice and keeps chords", () => {
    const score = parseAbc(fx("full_en.abc"));
    const vocalCount = score.notes.filter((n) => n.voice === "Vocal").length;
    const r = toInstrumental(score);
    expect(r.movedNotes).toBe(vocalCount);
    expect(r.score.notes.every((n) => n.voice === "Ins")).toBe(true);
    expect(r.score.chords.length).toBe(score.chords.length);
    expect(r.score.sections).toEqual(score.sections);
    // Every former vocal note exists in Ins at the same time/pitch.
    for (const v of score.notes.filter((n) => n.voice === "Vocal")) {
      expect(r.score.notes.some((n) => n.start === v.start && n.pitch === v.pitch && n.duration === v.duration)).toBe(true);
    }
    // Ins stays monophonic.
    const ins = r.score.notes.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < ins.length; i++) expect(ins[i].start).toBeGreaterThanOrEqual(ins[i - 1].start + ins[i - 1].duration);
    // Serializes to a valid score that parses back with no vocal notes.
    const back = parseAbc(serializeAbc(r.score));
    expect(back.notes.filter((n) => n.voice === "Vocal").length).toBe(0);
    expect(back.chords.length).toBe(score.chords.length);
  });

  it("lets vocal notes win over overlapping Ins notes", () => {
    const s = parseAbc("X:1\nM:4/4\nL:1/16\nQ:1/4=100\nK:C\nV: Vocal\nz4 c8 z4|\nV: Ins\nE16|\n");
    const r = toInstrumental(s);
    expect(r.overlaps).toBe(1);
    const ins = r.score.notes.sort((a, b) => a.start - b.start);
    expect(ins.map((n) => [n.start / 64, n.duration / 64, n.pitch])).toEqual([
      [0, 4, 64],
      [4, 8, 72],
      [12, 4, 64],
    ]);
    // the two parts of the split Ins note are separate notes: ids stay unique
    expect(new Set(r.score.notes.map((n) => n.id)).size).toBe(r.score.notes.length);
  });

  it("builds the style like the official prepare()", () => {
    expect(instrumentalStyle("J-pop, piano")).toBe("Instrumental, J-pop, piano, no vocals, no singing, no choir, no spoken words.");
    expect(instrumentalStyle("Instrumental jazz trio")).toBe("Instrumental jazz trio, no vocals, no singing, no choir, no spoken words.");
    expect(instrumentalStyle("Japanese, J-pop, bright female vocal, piano")).toBe("Instrumental, J-pop, piano, no vocals, no singing, no choir, no spoken words.");
    expect(instrumentalStyle("")).toBe("Instrumental, Expressive instrumental music, no vocals, no singing, no choir, no spoken words.");
    // StyleBuilder chip
    expect(instrumentalStyle("J-pop, instrumental, no vocals, piano")).toBe("Instrumental, J-pop, piano, no vocals, no singing, no choir, no spoken words.");
    expect(instrumentalStyle("instrumental, no vocals")).toBe("Instrumental, no vocals, no singing, no choir, no spoken words.");
    expect(instrumentalStyle("lofi hip hop, no instrumental break")).toBe("Instrumental, lofi hip hop, no instrumental break, no vocals, no singing, no choir, no spoken words.");
    expect(instrumentalStyle("piano ballad.")).toBe("Instrumental, piano ballad, no vocals, no singing, no choir, no spoken words.");
    // keeps instrument items that only look vocal-ish
    expect(instrumentalStyle("trap, Japanese koto, male vocal, rap")).toBe("Instrumental, trap, Japanese koto, no vocals, no singing, no choir, no spoken words.");
  });

  it("is idempotent", () => {
    for (const s of ["J-pop, piano", "Japanese, J-pop, bright female vocal, piano, 120 BPM", "", "instrumental, no vocals", "lofi hip hop, no instrumental break"]) {
      const once = instrumentalStyle(s);
      expect(instrumentalStyle(once)).toBe(once);
    }
  });
});

describe("lyricTagsFromAbc", () => {
  it("turns % section labels into [Title] tags like lyric_tags()", () => {
    expect(lyricTagsFromAbc(fx("full_en.abc"))).toBe("[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n");
    expect(lyricTagsFromAbc("X:1\nK:C\nV: Vocal\nZ|\n")).toBe("");
    expect(pyTitle("pre-chorus")).toBe("Pre-Chorus");
    expect(pyTitle("verse2 b")).toBe("Verse2 B");
    expect(pyTitle("2nd CHORUS")).toBe("2Nd Chorus");
  });
});

describe("instrumentalTitle", () => {
  it("marks the song's title once", () => {
    expect(instrumentalTitle(" 春の歌 ")).toBe("春の歌（インスト）");
    expect(instrumentalTitle("春の歌（インスト）")).toBe("春の歌（インスト）");
    expect(instrumentalTitle("  ")).toBeUndefined();
    expect(instrumentalTitle(undefined)).toBeUndefined();
  });

  it("keeps the backend's automatic instrumental titles and fits the mark into the title limit", () => {
    expect(instrumentalTitle("インスト: jazz trio")).toBe("インスト: jazz trio");
    expect(instrumentalTitle("インスト 2026-10-01 12:00")).toBe("インスト 2026-10-01 12:00");
    expect(instrumentalTitle("インストール日記")).toBe("インストール日記（インスト）");
    // the backend keeps REQUESTED_TITLE_MAX_CHARS (60) characters: the mark must not be cut
    const long = instrumentalTitle("あ".repeat(58))!;
    expect(Array.from(long)).toHaveLength(60);
    expect(long).toBe(`${"あ".repeat(54)}（インスト）`);
    expect(instrumentalTitle(long)).toBe(long);
    expect(instrumentalTitle("あ".repeat(54))).toBe(`${"あ".repeat(54)}（インスト）`);
    // counted in code points, as the backend does
    expect(Array.from(instrumentalTitle("🎵".repeat(59))!)).toHaveLength(60);
  });
});
