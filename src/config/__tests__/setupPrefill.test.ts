import { afterEach, describe, expect, it } from "vitest";
import { clearSetupPrefill, peekSetupPrefill, setSetupPrefill } from "../setupPrefill";

describe("setup prefill", () => {
  afterEach(() => clearSetupPrefill());

  it("is empty until set", () => {
    expect(peekSetupPrefill()).toBeNull();
  });
  it("survives repeated reads and is gone after clear", () => {
    setSetupPrefill({ dataRoot: "D:\\MCS", outputDir: "D:\\Songs" });
    expect(peekSetupPrefill()).toEqual({ dataRoot: "D:\\MCS", outputDir: "D:\\Songs" });
    expect(peekSetupPrefill()).toEqual({ dataRoot: "D:\\MCS", outputDir: "D:\\Songs" });
    clearSetupPrefill();
    expect(peekSetupPrefill()).toBeNull();
  });
  it("is cleared by null and not changed through a returned copy", () => {
    const l = { dataRoot: "D:\\MCS", outputDir: "D:\\Songs" };
    setSetupPrefill(l);
    l.dataRoot = "E:\\other";
    const got = peekSetupPrefill();
    got!.outputDir = "E:\\x";
    expect(peekSetupPrefill()).toEqual({ dataRoot: "D:\\MCS", outputDir: "D:\\Songs" });
    setSetupPrefill(null);
    expect(peekSetupPrefill()).toBeNull();
  });
});
