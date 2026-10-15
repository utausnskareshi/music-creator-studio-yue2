// Writes THIRD_PARTY_LICENSES.txt: the license texts of the open-source software built into the app (the npm
// packages of the user interface and the Rust crates of the executable), which the installer ships next to the app
// (tauri.conf.json bundle.resources). Run `npm run licenses` after a dependency changes; a unit test fails while the
// file does not match the lockfiles (depsFingerprint).
//   node tools/third-party-licenses.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_CRATE = "music-creator-studio-yue2";
/** The header line that records which lockfiles the file was made from. */
export const FINGERPRINT_PREFIX = "Dependencies fingerprint: ";

const nl = (s) => s.replace(/\r\n?/g, "\n");

/**
 * A hash of the dependencies in package-lock.json and src-tauri/Cargo.lock, without the app's own entries (a version
 * bump of the app needs no new license file).
 */
export function depsFingerprint(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const packages = { ...lock.packages };
  delete packages[""];
  const cargo = nl(readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8"))
    .split(/\n(?=\[\[package\]\]\n)/)
    .filter((block) => !block.startsWith(`[[package]]\nname = "${ROOT_CRATE}"\n`))
    .join("\n");
  return createHash("sha256").update(JSON.stringify(packages)).update("\n--\n").update(cargo).digest("hex");
}

/** The fingerprint a generated file records, or null. */
export function recordedFingerprint(text) {
  const line = nl(text)
    .split("\n")
    .find((l) => l.startsWith(FINGERPRINT_PREFIX));
  return line ? line.slice(FINGERPRINT_PREFIX.length).trim() : null;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;
/** Folders whose license files are not about the package's own code (tests, examples, docs, other packages). */
const SKIP_DIR = /^(tests?|benches|examples|fuzz|target|\.github|node_modules|docs?|testdata|test-data|fixtures)$/i;

/** Texts the packages do not ship themselves (see EXTRA), kept next to this script. */
const EXTRA_DIR = join(dirname(fileURLToPath(import.meta.url)), "third-party-licenses");

/**
 * Texts the packages' own files do not give, by "<kind> <name>". `license`: the license file of the repository of a
 * package that ships none (used instead of the standard text). `bundled`: the notices of code a package builds in
 * from elsewhere, with what each covers. Sources of the files in tools/third-party-licenses/:
 * - microsoft-webview2-sdk.txt: the license of the WebView2 SDK (https://www.nuget.org/packages/Microsoft.Web.WebView2),
 *   whose WebView2LoaderStatic.lib webview2-com-sys links into an MSVC build
 * - process-browser-shim.txt: https://unpkg.com/process@0.11.10/LICENSE, the process shim browserify put into
 *   kuromoji's build/kuromoji.js (the app ships that file, tools/copy-kuromoji-dict.mjs)
 * - node-path.txt: the notice of the path module in the same build/kuromoji.js
 * - webview2-rs.txt: https://github.com/wravery/webview2-rs/blob/main/LICENSE
 * - lofty-rs-MIT.txt: https://github.com/Serial-ATA/lofty-rs/blob/main/LICENSE-MIT
 * - rust-alloc-no-stdlib.txt: https://github.com/dropbox/rust-alloc-no-stdlib/blob/master/LICENSE
 */
const EXTRA = {
  "crate alloc-stdlib": { license: "rust-alloc-no-stdlib.txt" },
  "crate lofty": { license: "lofty-rs-MIT.txt" },
  "crate ogg_pager": { license: "lofty-rs-MIT.txt" },
  "crate webview2-com": { license: "webview2-rs.txt" },
  "crate webview2-com-sys": {
    license: "webview2-rs.txt",
    bundled: [{ file: "microsoft-webview2-sdk.txt", what: "Microsoft WebView2 SDK: WebView2LoaderStatic.lib, linked into the executable" }],
  },
  "npm kuromoji": {
    bundled: [
      { file: "process-browser-shim.txt", what: "process, the browser shim of browserify, in build/kuromoji.js" },
      { file: "node-path.txt", what: "the path module of Node.js, in build/kuromoji.js" },
    ],
  },
};

/** License files in a package's subfolders that are about code the app's build leaves out, by "<kind> <name>". */
const NOT_BUILT = {
  // SQLCipher's sources, built only with the bundled-sqlcipher feature (the app builds plain SQLite, public domain)
  "crate libsqlite3-sys": ["sqlcipher/LICENSE"],
};

const extraText = (file) => nl(readFileSync(join(EXTRA_DIR, file), "utf8")).trim();

/** A repository field as a web address (git@host:owner/repo, git://, git+https://, owner/repo shorthand). */
function webUrl(repo) {
  if (!repo) return undefined;
  let u = repo.trim().replace(/^git\+/, "").replace(/\.git$/, "");
  u = u.replace(/^git@([^:]+):/, "https://$1/").replace(/^git:\/\//, "https://");
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = `https://github.com/${u}`;
  return u;
}

/** Author names without their e-mail addresses ("Name <mail>" -> "Name"). */
const authorNames = (authors) => (authors ?? []).map((a) => a.replace(/\s*<[^>]*>\s*/g, "").trim()).filter(Boolean);

// Standard texts for a package that ships no license file: its copyright holders come from its authors.
const MIT_TEXT = (holders) => `MIT License

Copyright (c) ${holders}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const BSD3_TEXT = (holders) => `BSD 3-Clause License

Copyright (c) ${holders}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

/**
 * The license text for a package without a license file: MIT or BSD-3-Clause written out with its authors as the
 * holders, or (Apache-2.0, MPL-2.0) a pointer to the same license's full text elsewhere in the file. null: none.
 */
function fallbackText(p, texts) {
  const ids = (p.license.match(/[A-Za-z0-9.+-]+/g) ?? []).filter((t) => !/^(OR|AND|WITH)$/.test(t));
  const holders = authorNames(p.authors).join(", ") || `the ${p.name} authors`;
  if (ids.includes("MIT")) return { text: MIT_TEXT(holders) };
  if (ids.includes("BSD-3-Clause")) return { text: BSD3_TEXT(holders) };
  const heads = { "Apache-2.0": /^\s*Apache License\s+Version 2\.0/, "MPL-2.0": /^\s*Mozilla Public License,? [Vv]ersion 2\.0/ };
  for (const id of ids) {
    const head = heads[id];
    if (!head) continue;
    for (const [text, n] of texts) if (head.test(text)) return { ref: n };
  }
  return null;
}

/**
 * The license and notice files of a package folder: those at the top, then those of code kept in its subfolders
 * (paths with "/"), each in name order. `key` ("<kind> <name>") leaves out its NOT_BUILT files.
 */
function licenseFiles(dir, key) {
  if (!existsSync(dir)) return [];
  const top = [];
  const nested = [];
  const walk = (sub, depth) => {
    for (const n of readdirSync(join(dir, sub))) {
      const rel = sub ? `${sub}/${n}` : n;
      if (statSync(join(dir, rel)).isDirectory()) {
        if (depth < 6 && !SKIP_DIR.test(n)) walk(rel, depth + 1);
      } else if (LICENSE_FILE.test(n)) (sub ? nested : top).push(rel);
    }
  };
  walk("", 0);
  const byName = (a, b) => a.localeCompare(b, "en");
  const left = NOT_BUILT[key] ?? [];
  return [...top.sort(byName), ...nested.sort(byName)].filter((f) => !left.includes(f));
}

/** The npm packages of the app (not dev-only), from package-lock.json, with their license files. */
function npmPackages(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const out = [];
  for (const [key, p] of Object.entries(lock.packages)) {
    if (!key || p.dev || p.devOptional || p.link) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const dir = join(root, key);
    let license = p.license;
    let repository;
    let authors = [];
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const meta = JSON.parse(readFileSync(pj, "utf8"));
      license ??= typeof meta.license === "string" ? meta.license : meta.license?.type;
      repository = webUrl(typeof meta.repository === "string" ? meta.repository : meta.repository?.url);
      authors = [typeof meta.author === "string" ? meta.author : meta.author?.name].filter(Boolean);
    } else if (p.optional) {
      continue; // an optional package of another platform, not installed
    }
    out.push({ kind: "npm", name, version: p.version, license: license ?? "(not stated)", repository, authors, dir, files: licenseFiles(dir, `npm ${name}`) });
  }
  return out;
}

/**
 * The Rust crates compiled into the Windows executable: the normal dependencies reachable from the app's crate
 * (cargo metadata for x86_64-pc-windows-msvc), without build-only and dev-only ones and without proc-macro crates
 * (they run in the compiler and are not part of the program).
 */
function cratePackages(root) {
  const args = ["metadata", "--format-version", "1", "--locked", "--manifest-path", join(root, "src-tauri", "Cargo.toml"), "--filter-platform", "x86_64-pc-windows-msvc"];
  let json;
  try {
    json = execFileSync("cargo", [...args, "--offline"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    json = execFileSync("cargo", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  }
  const meta = JSON.parse(json);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const isProcMacro = (p) => p.targets.some((t) => t.kind.includes("proc-macro"));
  const seen = new Set();
  const queue = [meta.resolve.root];
  while (queue.length) {
    const id = queue.pop();
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
      const pkg = byId.get(dep.pkg);
      if (!pkg || isProcMacro(pkg) || seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  return [...seen]
    .map((id) => byId.get(id))
    .map((p) => {
      const dir = dirname(p.manifest_path);
      const files = licenseFiles(dir, `crate ${p.name}`);
      if (p.license_file && !files.includes(p.license_file)) files.push(p.license_file);
      return { kind: "crate", name: p.name, version: p.version, license: p.license ?? "(see license file)", repository: webUrl(p.repository ?? undefined), authors: p.authors, dir, files };
    });
}

/** The whole file: a header, one line per package, then each distinct license text once. */
export function render(packages, fingerprint) {
  const texts = new Map(); // text -> number
  const add = (text) => {
    if (!texts.has(text)) texts.set(text, texts.size + 1);
    return `[${texts.get(text)}]`;
  };
  const sorted = [...packages].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
  const refsOf = new Map();
  for (const p of sorted) {
    const extra = EXTRA[`${p.kind} ${p.name}`] ?? {};
    const own = [];
    for (const f of p.files) {
      const text = nl(readFileSync(join(p.dir, f), "utf8")).trim();
      if (text) own.push(f.includes("/") ? `${add(text)} (${f})` : add(text));
    }
    const fromRepo = !own.length && !!extra.license;
    if (fromRepo) own.push(add(extraText(extra.license)));
    const bundled = (extra.bundled ?? []).map((b) => `${add(extraText(b.file))} (${b.what})`);
    refsOf.set(p, { own, bundled, fromRepo });
  }
  // packages without a license file, once every shipped text is known (a pointer may name one of them)
  const lines = [];
  for (const p of sorted) {
    const { own, bundled, fromRepo } = refsOf.get(p);
    let note = fromRepo ? " (the package ships no license file; the license file of its repository)" : "";
    if (!own.length) {
      const f = fallbackText(p, texts);
      if (f?.text) own.push(add(f.text));
      else if (f?.ref) own.push(`[${f.ref}]`);
      note = f ? " (the package ships no license file; standard text of its license)" : " (the package ships no license file; the license named above applies)";
    }
    const where = p.repository ? ` — ${p.repository}` : "";
    // MPL-2.0 §3.2(a): recipients of the executable are told where the source code is
    const source = /\bMPL-/.test(p.license) ? ` — source code: ${p.kind === "npm" ? `https://www.npmjs.com/package/${p.name}/v/${p.version}` : `https://crates.io/crates/${p.name}/${p.version}`}` : "";
    const also = bundled.length ? `; bundled: ${bundled.join(" ")}` : "";
    lines.push(`${p.kind === "npm" ? "npm  " : "crate"} ${p.name} ${p.version} — ${p.license}${where}${source} — ${own.join(" ")}${note}${also}`);
  }
  const out = [
    "Music Creator Studio YuE2 — Third-party software licenses / 第三者のソフトウェアのライセンス",
    "",
    "This file contains the licenses of the open-source software built into Music Creator Studio YuE2: the npm",
    "packages of its user interface and the Rust crates of its executable. Software that the app downloads during",
    "setup (ComfyUI, the models, ffmpeg, llama.cpp and others) is not part of the app; see THIRD_PARTY_NOTICES.md.",
    "Each package line names its license texts by number. A text from a subfolder of the package, and the notice of",
    "code the package builds in from elsewhere (\"bundled:\"), says in parentheses what it covers. The source code of",
    "the MPL-2.0 packages is available at the address on their lines.",
    "",
    "このファイルは、Music Creator Studio YuE2 に組み込まれているオープンソースソフトウェア（画面の npm パッケージと、",
    "実行ファイルの Rust クレート）のライセンスです。セットアップでダウンロードするもの（ComfyUI・モデル・ffmpeg・",
    "llama.cpp など）はアプリに含まれません。それらについては THIRD_PARTY_NOTICES.md を参照してください。",
    "各パッケージの行には、ライセンス文を番号で示します。パッケージのサブフォルダーにあるライセンス文と、パッケージが",
    "他から取り込んだコードの表示（「bundled:」）には、対象を括弧で添えます。MPL-2.0 のパッケージのソースコードは、",
    "その行に示した場所から入手できます。",
    "",
    "Generated by tools/third-party-licenses.mjs (npm run licenses).",
    `${FINGERPRINT_PREFIX}${fingerprint}`,
    "",
    `== Packages (${sorted.length}) ==`,
    "",
    ...lines,
    "",
    `== License texts (${texts.size}) ==`,
  ];
  for (const [text, n] of texts) out.push("", `---- [${n}] ----`, "", text);
  return out.join("\n") + "\n";
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const packages = [...npmPackages(root), ...cratePackages(root)];
  const text = render(packages, depsFingerprint(root));
  const file = join(root, "THIRD_PARTY_LICENSES.txt");
  writeFileSync(file, text, "utf8");
  const missing = packages.filter((p) => p.files.length === 0 && !EXTRA[`${p.kind} ${p.name}`]?.license).map((p) => `${p.name} ${p.version} (${p.license})`);
  console.log(`wrote ${file}: ${packages.length} packages, ${Math.round(text.length / 1024)} KB`);
  if (missing.length) console.log(`standard license text for ${missing.length} package(s) without a license file: ${missing.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
