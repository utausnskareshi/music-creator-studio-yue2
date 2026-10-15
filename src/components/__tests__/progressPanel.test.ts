// 「待機中をすべてキャンセル」 says that the song being generated goes on. A song that has just left the queue is still
// listed as 待機中 until its first progress event: the cancel asks the backend to cancel it only while it waits
// (jobs.rs cancel_action queued_only), so its id cannot stop the running job. This test pins the TypeScript side; the
// backend side (cancel_job → JobManager::cancel → cancel_action) is pinned in src-tauri/src/lib.rs
// (cancel_job_hands_queued_only_to_the_job_manager).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("../ProgressPanel.tsx", import.meta.url), "utf8");
const API = readFileSync(new URL("../../api.ts", import.meta.url), "utf8");

describe("「待機中をすべてキャンセル」", () => {
  it("cancels only songs still in the queue", () => {
    const start = SOURCE.indexOf("const cancelQueued = async");
    expect(start).toBeGreaterThan(-1);
    const fn = SOURCE.slice(start, SOURCE.indexOf("\n  };", start));
    expect(fn).toMatch(/await api\.cancelJob\(s\.id, true\);/);
    expect(fn).not.toMatch(/api\.cancelJob\(s\.id\)/);
    expect(API).toMatch(/cancelJob: \(songId: string, queuedOnly = false\) => invoke<void>\("cancel_job", \{ songId, queuedOnly \}\)/);
  });
});
