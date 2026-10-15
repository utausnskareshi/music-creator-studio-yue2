// validateNativeAbc must agree with the official abc_tools.py (tests/test_skill_abc_tools.py cases).
// The score() helper and the test inputs are ported from tests/test_skill_abc_tools.py of YuE2
// (https://github.com/multimodal-art-projection/YuE), Copyright (c) 2026 the YuE2 authors, licensed under the
// Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Changes: translated from Python
// unittest to vitest and run against this app's validator. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateNativeAbc } from "../native";
import { validateAbc } from "../parse";

const fx = (name: string) => readFileSync(join(__dirname, "..", "__fixtures__", name), "utf8");

function score(vocal: string, ins = "Z|", meter = "4/4", key = "C", extra = "") {
  return (
    `X:1\nT:\nM:${meter}\nL:1/32\nQ:1/4=88\n` +
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n' +
    'V: Ins clef=treble name="Ins Melody" snm="Inst."\n' +
    `K:${key}\n% verse\nV: Vocal\n${vocal}\nV: Ins\n${ins}\n${extra}`
  );
}

describe("validateNativeAbc", () => {
  it("accepts the official positive cases", () => {
    const good = [
      score("F8C8=F8F8|", "Z|", "4/4", "D"),
      score("^F8f8=F8f8|"),
      score("^F32|F32|", "Z2|"),
      score("^F32-|F8F24|", "Z2|"),
      score('"C"C16-"Am7"C16|'),
      score("^^F16__B16|"),
      score("F32|", "Z|", "4/4", "F#m"),
      score("F16[K:D]F16|", "z16[K:D]z16|"),
      score("C8D8E8|", "Z|", "6/8"),
      score("C32|", "Z|", "4/4", "C", "V: Vocal\nM:3/4\nD24|\nV: Ins\nM:3/4\nZ|\n"),
      score("Z4|", "Z4|"),
      score('"Cmaj7/G"C16"Dbaug"C16|', "E32|"),
    ];
    for (const t of good) expect(validateNativeAbc(t).errors).toEqual([]);
  });

  it("rejects every official bad-input case", () => {
    const bad = [
      score("C16|"),
      score("C48|"),
      score("C32-|"),
      score("C32-|D32|", "Z2|"),
      score("C32-|z32|", "Z2|"),
      score("C32-|=C32|", "Z2|", "4/4", "D").replace("C32-|", "^C32-|"),
      score("z32-|"),
      score("^z32|"),
      score("C10C22|"),
      score("C/2C31|"),
      score("(3C8D8E8|"),
      score("[CEG]32|"),
      score("C16>C16|"),
      score("{C}D32|"),
      score("C32||"),
      score("C32:|"),
      score("Z1|"),
      score("Z5|"),
      score('"C13"C32|'),
      score('"A7alt"C32|'),
      score('C32"C"|'),
      score("C32|", '"C"Z|'),
      score("C16[K:D]C16|"),
      score("C32|").replace("L:1/32", "L:1/3"),
      score("C32|").replace("K:C", "K:Cmix"),
      score("C32|").replace("% verse", "%%MIDI program 1"),
      score("C32|").replace("C32|", "C32|C32|C32|C32|C32|"),
      score("C32|", "Z2|"),
    ];
    expect(bad.length).toBe(28);
    bad.forEach((t, i) => {
      const r = validateNativeAbc(t);
      expect(r.ok, `case ${i}`).toBe(false);
      expect(r.errors.length, `case ${i}`).toBeGreaterThan(0);
    });
  });

  it("names the group, voice and bar in Japanese", () => {
    const r = validateNativeAbc(score("C16|"));
    expect(r.errors[0]).toMatch(/^グループ 1・Vocal・小節 1: 小節の長さ 2 拍が拍子の長さ 4 拍と一致しません$/);
    expect(validateNativeAbc(score("C32-|D32|", "Z2|")).errors[0]).toMatch(/タイで音高が変わっています（60 → 62）/);
    expect(validateNativeAbc(score("C32|", "Z2|")).errors[0]).toMatch(/グループ 1: Vocal と Ins で小節数が異なります/);
  });

  it("keeps checking later bars after an error in one bar", () => {
    const r = validateNativeAbc(score("C16|C10C22|", "Z2|"));
    expect(r.errors.length).toBe(2);
  });

  it("passes the real score files and the official examples", () => {
    for (const name of ["full_en.abc", "full_ja.abc", "full_long.abc", "melody_cover.abc", "official_score.abc", "official_melody.abc", "official_example_ins.abc", "plan_l32.abc", "transcription_l16.abc"]) {
      expect(validateNativeAbc(fx(name)).errors, name).toEqual([]);
    }
  });

  it("warns (only) when L: is coarser than the four-subbeat grid", () => {
    const r = validateNativeAbc(score("C4D4E4|", "Z|", "6/8").replace("L:1/32", "L:1/16"));
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/L:1\/16/);
    expect(validateNativeAbc(fx("official_score.abc")).warnings).toEqual([]);
  });

  it("is not used by parseAbc / validateAbc (advisory only)", () => {
    expect(validateAbc(score("C32|").replace("T:", "T:My Song"))).toBeNull();
    expect(validateNativeAbc(score("C32|").replace("T:", "T:My Song")).ok).toBe(false);
  });
});
