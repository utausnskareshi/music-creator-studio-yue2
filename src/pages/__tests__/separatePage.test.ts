import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PAGE = fileURLToPath(new URL("../SeparatePage.tsx", import.meta.url));

describe("ボーカル分離 of a song deleted while it runs", () => {
  const code = readFileSync(PAGE, "utf8");
  const run = code.slice(code.indexOf("\n  const run = "), code.indexOf("\n  return ("));

  it("ends as 中止 with a notice, not as a red failure (the user deleted it; the backend keeps no stems)", () => {
    const caught = run.slice(run.indexOf("} catch (e) {"));
    expect(caught).toMatch(/if \(songAtStart && deletedIds\.current\.has\(songAtStart\)\) \{\s*(?:\/\/[^\n]*\n\s*)*setTool\(null\);\s*showToast\("info", noticeFrom\("曲がライブラリから削除されたため、分離を中止しました"/);
    expect(caught.indexOf("deletedIds.current.has(songAtStart)")).toBeLessThan(caught.indexOf('showToast("error"'));
  });

  it("still drops a result that returns after the delete (it came after the backend's last check)", () => {
    expect(run).toMatch(/const r = await api\.separateAudio\([^)]*\);\s*\/\/[^\n]*\n\s*if \(songAtStart && deletedIds\.current\.has\(songAtStart\)\) return;/);
  });
});
