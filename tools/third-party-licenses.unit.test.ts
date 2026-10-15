// The installer ships the license texts of the open-source software built into the app (THIRD_PARTY_LICENSES.txt,
// made by tools/third-party-licenses.mjs). It must follow the lockfiles: a dependency added or updated without
// `npm run licenses` would ship without its notice.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { depsFingerprint, recordedFingerprint } from "./third-party-licenses.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const licenses = readFileSync(join(root, "THIRD_PARTY_LICENSES.txt"), "utf8");

describe("THIRD_PARTY_LICENSES.txt", () => {
  it("was made from the current lockfiles (run `npm run licenses` after a dependency changes)", () => {
    expect(recordedFingerprint(licenses), "the dependencies changed: run `npm run licenses`").toBe(depsFingerprint(root));
  });

  it("lists the bundled packages with their texts, kuromoji's dictionary notice (IPADIC) included", () => {
    for (const line of [/^npm {3}react \S+ — MIT/m, /^npm {3}kuromoji \S+ — Apache-2\.0/m, /^npm {3}wavesurfer\.js \S+ — BSD-3-Clause/m, /^crate tauri \S+ — /m])
      expect(licenses).toMatch(line);
    expect(licenses).toContain("Nara Institute of Science and Technology (NAIST)");
    // every package names at least one text
    for (const l of licenses.split("\n").filter((x) => /^(npm {3}|crate )/.test(x))) expect(l, l).toMatch(/\[\d+\]/);
  });

  it("has the notices of code built in from elsewhere, of subfolders, and the MPL-2.0 source location", () => {
    const line = (re: RegExp) => licenses.split("\n").find((l) => re.test(l)) ?? "";
    // the WebView2 loader of Microsoft's SDK is linked into the executable (webview2-com-sys, MSVC)
    expect(line(/^crate webview2-com-sys /)).toMatch(/bundled: \[\d+\] \(Microsoft WebView2 SDK/);
    expect(licenses).toContain("Copyright (C) Microsoft Corporation. All rights reserved.");
    // kuromoji's browser build, which the app ships, holds browserify's process shim and Node's path module
    expect(line(/^npm {3}kuromoji /)).toMatch(/bundled: .*process.*path/);
    expect(licenses).toContain("Copyright (c) 2013 Roman Shtylman");
    expect(line(/^crate ring /)).toContain("(third_party/fiat/LICENSE)");
    expect(line(/^crate regex-syntax /)).toContain("(src/unicode_tables/LICENSE-UNICODE)");
    expect(line(/^crate option-ext /)).toMatch(/source code: https:\/\/crates\.io\/crates\/option-ext\/\S+ — /);
    // the repository's own license file for a crate that ships none, not a text with made-up holders
    for (const name of ["webview2-com", "webview2-com-sys", "lofty", "alloc-stdlib"]) expect(line(new RegExp(`^crate ${name} `))).toContain("the license file of its repository");
  });

  it("is installed next to the app with the app's license and the notices", () => {
    const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    expect(conf.bundle.resources).toMatchObject({
      "../LICENSE": "LICENSE.txt",
      "../THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
      "../THIRD_PARTY_LICENSES.txt": "THIRD_PARTY_LICENSES.txt",
    });
  });
});
