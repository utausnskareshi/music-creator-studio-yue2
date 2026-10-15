import { describe, expect, it } from "vitest";
import { LOCK_HINT, lockHint, lockReason } from "../locks";

describe("page locks", () => {
  it("names nothing while nothing runs", () => {
    expect(lockReason({})).toBeNull();
    expect(lockReason({ writing: false, sending: false })).toBeNull();
    expect(lockHint({ aligning: false })).toBeUndefined();
  });

  it("names the running work and its tooltip", () => {
    expect(lockReason({ sending: true })).toBe("sending");
    expect(lockHint({ transcribing: true })).toBe(LOCK_HINT.transcribing);
    expect(lockHint({ llmWaiting: true })).toContain("キャンセル");
  });

  it("names the long-running work first when several overlap", () => {
    // the AI draft (seconds to a minute) over the send it blocks; the planning over the send it ends in
    expect(lockReason({ sending: true, writing: true })).toBe("writing");
    expect(lockReason({ sending: true, planning: true })).toBe("planning");
    expect(lockReason({ exporting: true, aligning: true })).toBe("aligning");
  });

  it("names the lyrics editor's hiragana conversion (a send meanwhile would sing the kanji text)", () => {
    expect(lockReason({ converting: true })).toBe("converting");
    expect(lockHint({ converting: true })).toBe(LOCK_HINT.converting);
    expect(LOCK_HINT.converting).toContain("ひらがな化");
    // a few seconds at most (the first dictionary load): the long-running work it overlaps is named first
    expect(lockReason({ converting: true, transcribing: true })).toBe("transcribing");
    expect(lockReason({ converting: true, planning: true })).toBe("planning");
  });

  it("has a full-sentence tooltip for every reason", () => {
    for (const hint of Object.values(LOCK_HINT)) {
      expect(hint.length).toBeGreaterThan(10);
      expect(["ください", "です", "ません"].some((end) => hint.endsWith(end)), hint).toBe(true);
    }
  });
});
