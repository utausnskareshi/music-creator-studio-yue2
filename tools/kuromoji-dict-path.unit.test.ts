// The dev server's kuromoji dictionary middleware must never serve a file outside public/kuromoji/dict.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kuromojiDictFile } from "./kuromoji-dict-path";

describe("kuromojiDictFile", () => {
  const w = path.win32;
  const base = "C:\\repo\\public\\kuromoji\\dict";

  it("maps a dictionary file, with or without a query", () => {
    expect(kuromojiDictFile(w, base, "/kuromoji/dict/base.dat.gz")).toBe("C:\\repo\\public\\kuromoji\\dict\\base.dat.gz");
    expect(kuromojiDictFile(w, base, "/kuromoji/dict/base.dat.gz?import")).toBe("C:\\repo\\public\\kuromoji\\dict\\base.dat.gz");
  });

  it("rejects everything that leaves the folder or is not a file name in it", () => {
    for (const rel of ["../x", "%2E%2E%2Fx", "..%5C..%5Cpackage.json", "C:%5CWindows%5Cwin.ini", "D:%5Cx", "%5C%5Cserver%5Cshare", "", "%E0%A4%A", "../dict2/x"])
      expect(kuromojiDictFile(w, base, `/kuromoji/dict/${rel}`), rel).toBeNull();
    expect(kuromojiDictFile(w, base, "/other/base.dat.gz")).toBeNull();
  });

  it("applies the same rules with POSIX paths", () => {
    const px = path.posix;
    const b = "/repo/public/kuromoji/dict";
    expect(kuromojiDictFile(px, b, "/kuromoji/dict/cc.dat.gz")).toBe("/repo/public/kuromoji/dict/cc.dat.gz");
    for (const rel of ["../x", "%2F..%2F..%2Fetc%2Fpasswd", "../dict2/x"]) expect(kuromojiDictFile(px, b, `/kuromoji/dict/${rel}`), rel).toBeNull();
  });
});
