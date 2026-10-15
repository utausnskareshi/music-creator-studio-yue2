// compare.ts (symbolic invariants), consistency.ts (score/lyric sections), edit.ts (editor operations).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbc } from "../parse";
import { serializeAbc } from "../serialize";
import { compareScores } from "../compare";
import { compareSections, sectionOnsetCounts } from "../consistency";
import { moveNotes, transposeChordSymbol, transposeKey, transposeScore } from "../edit";
import { PPQ } from "../model";

const fx = (name: string) => readFileSync(join(__dirname, "..", "__fixtures__", name), "utf8");

function score(vocal: string, ins = "Z|", key = "C", bpm = 88) {
  return (
    `X:1\nT:\nM:4/4\nL:1/32\nQ:1/4=${bpm}\n` +
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n' +
    'V: Ins clef=treble name="Ins Melody" snm="Inst."\n' +
    `K:${key}\n% verse\nV: Vocal\n${vocal}\nV: Ins\n${ins}\n`
  );
}

describe("compareScores", () => {
  it("treats equal-sounding tie spellings as equal", () => {
    const d = compareScores(parseAbc(score("C32|")), parseAbc(score("C16-C16|")));
    expect(d.notesMatch).toBe(true);
    expect(d.lines).toEqual([]);
  });

  it("reports a re-articulation, an onset change and a transposed note", () => {
    expect(compareScores(parseAbc(score("C32|")), parseAbc(score("C16C16|"))).voices.Vocal).toEqual({ changed: 1, added: 1, removed: 0, bars: [1] });
    expect(compareScores(parseAbc(score("C16z16|")), parseAbc(score("z16C16|"))).voices.Vocal).toMatchObject({ added: 1, removed: 1 });
    const d = compareScores(parseAbc(score("C8D8E8F8|", "E32|")), parseAbc(score("C8D8^E8F8|", "E32|")));
    expect(d.notesMatch).toBe(false);
    expect(d.voices.Vocal.changed).toBe(1);
    expect(d.voices.Ins.changed).toBe(0);
    expect(d.lines[0]).toMatch(/^ボーカル: 変更 1 音・追加 0 音・削除 0 音（小節 1）$/);
  });

  it("reports a changed bar count (official: bar grid differs), trailing silent bars included", () => {
    const d = compareScores(parseAbc(score("C32|")), parseAbc(score("C32|Z|", "Z2|")));
    expect(d.voices.Vocal).toEqual({ changed: 0, added: 0, removed: 0, bars: [] });
    expect(d.barCount).toEqual({ from: 1, to: 2 });
    expect(d.notesMatch).toBe(false);
    expect(d.lines).toEqual(["小節数: 1 → 2（曲の長さが変わります）"]);
  });

  it("reports tempo and chord changes on their own lines", () => {
    const d = compareScores(parseAbc(score('"C"C32|')), parseAbc(score('"Am"C32|', "Z|", "C", 80)));
    expect(d.notesMatch).toBe(true);
    expect(d.chordBars).toEqual([1]);
    expect(d.tempo).toEqual({ from: 88, to: 80 });
    expect(d.lines).toEqual(["コード: 小節 1 で変更", "テンポ: 88 → 80 BPM（音符は拍の位置で比較しています）"]);
  });

  it("finds no difference in an unchanged real score", () => {
    const a = parseAbc(fx("full_ja.abc"));
    const d = compareScores(a, parseAbc(serializeAbc(a)));
    expect(d.lines).toEqual([]);
  });
});

describe("compareSections", () => {
  const plan = () => parseAbc(fx("plan_l32.abc"));
  const lyrics = "[Verse 1]\nあいうえお\nかきくけこ\n\n[Chorus]\nさしすせそ\n\n[Outro]\n";

  it("counts vocal onsets per section and carries intro pickups", () => {
    const counts = sectionOnsetCounts(plan());
    expect(counts.map((c) => [c.name, c.onsets, c.sung])).toEqual([
      ["intro", 2, false],
      ["verse", 54, true],
      ["chorus", 41, true],
      ["outro", 0, false],
    ]);
    expect(counts[1].withPickup).toBe(56);
  });

  it("stays quiet when the form matches", () => {
    expect(compareSections(plan(), lyrics)).toEqual([]);
    expect(compareSections(plan(), "")).toEqual([]);
  });

  it("warns on a deleted chorus, a duplicated chorus or an added bridge", () => {
    const text = fx("plan_l32.abc");
    const lines = text.split("\n");
    const chorus = lines.indexOf("% chorus");
    const outro = lines.indexOf("% outro");
    const deleted = [...lines.slice(0, chorus), ...lines.slice(outro)].join("\n");
    expect(compareSections(parseAbc(deleted), lyrics)[0]).toMatch(/数が一致しません/);
    const block = lines.slice(chorus, outro);
    // the chorus ends tied into the outro: untie the first copy so the text stays valid
    const duplicated = [...lines.slice(0, outro), ...block, ...lines.slice(outro)].join("\n").replace("d4c2c4-|", "d4c2c4|");
    expect(compareSections(parseAbc(duplicated), lyrics)[0]).toMatch(/数が一致しません/);
    expect(compareSections(plan(), lyrics + "\n[Bridge]\nたちつてと\n")[0]).toMatch(/数が一致しません/);
  });

  it("only hints at a reordered form and never throws", () => {
    expect(compareSections(plan(), "[Chorus]\nあ\n\n[Verse]\nい\n")[0]).toMatch(/^（参考）/);
    expect(compareSections(plan(), "[Aメロ]\nあ\n\n[サビ]\nい\n")).toEqual([]);
    expect(compareSections(plan(), "[Guitar Solo]\nla la\n\n[Verse]\nあ\n\n[Chorus]\nい\n")).toEqual([]);
  });
});

describe("editor operations", () => {
  it("moves notes without losing them in the serialized score", () => {
    const s = parseAbc("X:1\nM:4/4\nL:1/16\nQ:1/4=100\nK:C\nV: Vocal\nc4d4e4f4|\n");
    const e = s.notes.find((n) => n.pitch === 76)!;
    const moved = moveNotes(s.notes, new Set([e.id]), -PPQ / 2)!;
    const out = serializeAbc({ ...s, notes: moved });
    expect(out).toContain("c4d2e4z2f4|");
    expect(parseAbc(out).notes.map((n) => n.pitch)).toEqual([72, 74, 76, 77]);
    // refuse a move before the start instead of squashing the selection
    expect(moveNotes(s.notes, new Set(s.notes.map((n) => n.id)), -PPQ)).toBeNull();
  });

  it("transposes key and chords with the notes", () => {
    const s = parseAbc(score('"C"c16"G7/B"B16|'));
    const up = transposeScore(s, 1)!;
    expect(up.score.key).toBe("Db");
    expect(up.score.chords.map((c) => c.symbol)).toEqual(["Db", "Ab7/C"]);
    expect(up.score.notes.map((n) => n.pitch)).toEqual([73, 72]);
    expect(serializeAbc(up.score)).toContain('"Db"d16"Ab7/C"c16|');
    expect(transposeKey("Am", -1)).toBe("G#m");
    expect(transposeKey("C", 6)).toBe("F#");
    expect(transposeKey("F", 1)).toBe("Gb");
    expect(transposeKey("Am clef=treble", 2)).toBe("Bm clef=treble");
    expect(transposeChordSymbol("F#m7b5/C#", -1, true)).toBe("Fm7b5/C");
    expect(transposeChordSymbol("N", 1, false)).toBeNull();
  });

  it("leaves chords and key alone for octave shifts and refuses out-of-range notes", () => {
    const s = parseAbc(score('"C"c32|'));
    const r = transposeScore(s, 12)!;
    expect(r.score.key).toBe("C");
    expect(r.score.chords[0].symbol).toBe("C");
    const high = parseAbc(score("c''''32|"));
    expect(transposeScore(high, 12)).toBeNull();
  });
});
