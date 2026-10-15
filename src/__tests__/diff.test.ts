import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "../diff";

describe("diffLines", () => {
  it("marks identical text as unchanged", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.every((x) => x.kind === "same")).toBe(true);
    expect(d.map((x) => x.text)).toEqual(["a", "b", "c"]);
  });

  it("finds a changed line in the middle (removal before addition)", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  it("finds an inserted and a removed line", () => {
    expect(diffStats(diffLines("a\nc", "a\nb\nc"))).toEqual({ added: 1, removed: 0 });
    expect(diffStats(diffLines("a\nb\nc", "a\nc"))).toEqual({ added: 0, removed: 1 });
  });

  it("treats CRLF like LF", () => {
    expect(diffStats(diffLines("a\r\nb", "a\nb"))).toEqual({ added: 0, removed: 0 });
  });

  it("compares an empty text as one empty line", () => {
    expect(diffLines("", "x")).toEqual([
      { kind: "del", text: "" },
      { kind: "add", text: "x" },
    ]);
    expect(diffLines("", "")).toEqual([{ kind: "same", text: "" }]);
  });

  it("falls back to remove-all / add-all above 4M table cells", () => {
    const a = Array.from({ length: 2001 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 2001 }, (_, i) => `b${i}`).join("\n");
    const d = diffLines(a, b);
    expect(d).toHaveLength(4002);
    expect(d.slice(0, 2001).every((x) => x.kind === "del")).toBe(true);
    expect(d.slice(2001).every((x) => x.kind === "add")).toBe(true);
    expect(diffStats(d)).toEqual({ added: 2001, removed: 2001 });
  });
});
