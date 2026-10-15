// Where a "% name" section label lands: at the bar of the voice whose music it introduces, and never after the
// last music (a label there would be written back as an extra silent bar).
import { describe, expect, it } from "vitest";
import { parseAbc } from "../parse";
import { serializeAbc } from "../serialize";
import { compareScores } from "../compare";
import { recomputeBars } from "../model";
import { editedBars } from "../edit";
import { validateNativeAbc } from "../native";

const HEAD = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n';

/** What the editor's commit writes for a parsed score (ScoreEditor.commit with rebase). */
const committed = (text: string) => {
  const s = parseAbc(text);
  s.bars = editedBars(s.bars, s);
  return { s, out: serializeAbc(s) };
};

describe("section labels in a voice-at-a-time layout", () => {
  // all of the Vocal part first, then all of the Ins part (standard ABC allows it; not the native layout)
  const vocal = "C4D4E4F4|G16|\n% chorus\nA16|G16|";
  const ins = "C,16|G,,16|\n% chorus\nF,,16|C,16|";

  it("labels in both parts land on their own bars, once", () => {
    const text = `${HEAD}V: Vocal\n% verse\n${vocal}\nV: Ins\n% verse\n${ins}\n`;
    const s = parseAbc(text);
    // were verse@0, chorus@2, verse@4, chorus@4: the Ins labels took the bar Vocal had reached
    expect(s.sections).toEqual([
      { name: "verse", bar: 0 },
      { name: "chorus", bar: 2 },
    ]);
    expect(s.bars).toBe(4);
    expect(recomputeBars(s)).toBe(4);
    const { s: c, out } = committed(text);
    expect(c.bars).toBe(4); // no phantom 5th bar
    expect(out.match(/^% /gm)).toEqual(["% ", "% "]);
    expect(validateNativeAbc(out).ok).toBe(true);
  });

  it("labels only in the Ins part still mark the music", () => {
    const text = `${HEAD}V: Vocal\n${vocal.replace("% chorus\n", "")}\nV: Ins\n% verse\n${ins}\n`;
    expect(parseAbc(text).sections).toEqual([
      { name: "verse", bar: 0 },
      { name: "chorus", bar: 2 },
    ]);
  });

  it("a label written before the V: line of the part it introduces", () => {
    const text = `${HEAD}% verse\nV: Vocal\n${vocal}\n% verse\nV: Ins\n${ins}\n`;
    expect(parseAbc(text).sections).toEqual([
      { name: "verse", bar: 0 },
      { name: "chorus", bar: 2 },
    ]);
  });

  it("the native interleaved layout is unchanged", () => {
    const text = `${HEAD}% verse\nV: Vocal\nC4D4E4F4|G16|\nV: Ins\nC,16|G,,16|\n% chorus\nV: Vocal\nA16|G16|\nV: Ins\nF,,16|C,16|\n`;
    const s = parseAbc(text);
    expect(s.sections).toEqual([
      { name: "verse", bar: 0 },
      { name: "chorus", bar: 2 },
    ]);
    expect(serializeAbc(s)).toBe(text);
  });
});

describe("a section label after the last music", () => {
  const body = "% verse\nV: Vocal\nC4D4E4F4|G4A4B4c4|\nV: Ins\nZ|Z|\n";

  it("is dropped instead of adding a silent bar", () => {
    const plain = parseAbc(HEAD + body);
    const s = parseAbc(HEAD + body + "% end\n");
    expect(s.sections).toEqual([{ name: "verse", bar: 0 }]);
    expect(recomputeBars(s)).toBe(2);
    const { s: c, out } = committed(HEAD + body + "% end\n");
    expect(c.bars).toBe(2);
    expect(out).not.toContain("% end");
    expect(out).toBe(serializeAbc(plain));
    // no false 小節数 2 → 3
    expect(compareScores(plain, s).lines).toEqual([]);
  });

  // The voice written last is shorter than the other: its end is inside the song, not after it.
  it("is dropped when the voice written last is shorter (voice-at-a-time)", () => {
    const text = `${HEAD}% verse\nV: Vocal\nC16|D16|E16|F16|\n% chorus\nG16|A16|\nV: Ins\nC,16|D,16|\n`;
    const s = parseAbc(text + "% end\n");
    // was verse@0, end@2, chorus@4: the write-back cut the verse in two with a "% end" group
    expect(s.sections).toEqual([
      { name: "verse", bar: 0 },
      { name: "chorus", bar: 4 },
    ]);
    expect(committed(text + "% end\n").out).toBe(committed(text).out);
  });

  it("is dropped when the last Ins line is a bar short (native layout)", () => {
    const text = `${HEAD}% verse\nV: Vocal\nC16|D16|\nV: Ins\nC,16|D,16|\n% chorus\nV: Vocal\nE16|F16|\nV: Ins\nE,16|\n`;
    const s = parseAbc(text + "% end\n");
    // was verse@0, chorus@2, end@3: the last Vocal bar was split off into a "% end" group
    expect(s.sections).toEqual([
      { name: "verse", bar: 0 },
      { name: "chorus", bar: 2 },
    ]);
    expect(s.bars).toBe(4);
    // labels followed only by a V: line with no music are dropped too
    expect(parseAbc(text + "% end\n\n% fin\nV: Vocal\n").sections).toEqual(s.sections);
    const { out } = committed(text + "% end\n");
    expect(out).toBe(committed(text).out);
    expect(out).not.toContain("% end");
  });

  it("a label before trailing silent bars is kept", () => {
    const s = parseAbc(HEAD + "% verse\nV: Vocal\nC16|\nV: Ins\nC16|\n% outro\nV: Vocal\nZ|\nV: Ins\nZ|\n");
    expect(s.sections).toEqual([
      { name: "verse", bar: 0 },
      { name: "outro", bar: 1 },
    ]);
    expect(serializeAbc(s)).toContain("% outro\nV: Vocal\nZ|\nV: Ins\nZ|\n");
  });
});
