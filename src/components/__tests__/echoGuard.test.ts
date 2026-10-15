import { describe, expect, it } from "vitest";
import { createEchoGuard } from "../echoGuard";

describe("createEchoGuard (ScoreEditor fed back its own output)", () => {
  it("treats the editor's last output as an echo, not as new input", () => {
    const g = createEchoGuard();
    expect(g.isEcho("X:1\nK:C")).toBe(false); // initial load
    g.emit("X:1\nK:G");
    expect(g.isEcho("X:1\nK:G")).toBe(true); // EditPage: setAbc(s) comes back as the prop
    expect(g.isEcho("X:1\nK:G")).toBe(true); // still the same echo (re-render)
  });

  it("loads new input from the parent and forgets the last output", () => {
    const g = createEchoGuard();
    g.emit("A");
    expect(g.isEcho("B")).toBe(false); // e.g. a new generation
    expect(g.isEcho("A")).toBe(false); // the old text brought in again is loaded, not skipped
  });

  it("never treats a value as an echo before anything was emitted", () => {
    const g = createEchoGuard();
    expect(g.isEcho("")).toBe(false);
    expect(g.isEcho("A")).toBe(false);
  });
});
