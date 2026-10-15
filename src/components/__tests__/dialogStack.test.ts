import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { BACKDROP_Z, anyDialogOpen, focusStackTop, isOnTopOfStack, joinDialogStack, leaveDialogStack } from "../ChoiceDialog";

const SOURCE = readFileSync(new URL("../ChoiceDialog.tsx", import.meta.url), "utf8");

// The help dialog is not a question, but it is a modal: it joins the questions' stack so that a question opened
// while the help is shown is painted over it and takes Esc, and the help gets the keyboard back after it.
describe("joining the dialog stack of the questions", () => {
  it("shares the ids and the order with the questions", () => {
    expect(anyDialogOpen()).toBe(false);
    const help = joinDialogStack();
    expect(help.z).toBe(BACKDROP_Z);
    expect(isOnTopOfStack(help.id)).toBe(true);
    expect(anyDialogOpen()).toBe(true);
    // a question over the help
    const question = joinDialogStack();
    expect(question.id).not.toBe(help.id);
    expect(question.z).toBe(BACKDROP_Z + 1);
    expect(isOnTopOfStack(help.id)).toBe(false);
    expect(leaveDialogStack(question.id)).toBe(true);
    expect(isOnTopOfStack(help.id)).toBe(true);
    expect(leaveDialogStack(help.id)).toBe(true);
    expect(anyDialogOpen()).toBe(false);
    expect(leaveDialogStack(help.id)).toBe(false);
  });

  it("gives the focus to the dialog left on top", () => {
    const takeFocus = vi.fn();
    const help = joinDialogStack(takeFocus);
    const question = joinDialogStack();
    leaveDialogStack(question.id);
    focusStackTop();
    expect(takeFocus).toHaveBeenCalledOnce();
    leaveDialogStack(help.id);
  });

  it("uses the questions' own counter, and sits before the component (whose source the dialog tests check to the end)", () => {
    expect(SOURCE).toMatch(/export function joinDialogStack\(focus\?: \(\) => void\): \{ id: number; z: number \} \{\s*const id = \+\+dialogSeq;/);
    const at = SOURCE.indexOf("export function joinDialogStack(");
    expect(at).toBeGreaterThan(SOURCE.indexOf("const openDialogs: OpenDialog[] = [];"));
    expect(at).toBeLessThan(SOURCE.indexOf("function ChoiceDialog("));
  });
});
