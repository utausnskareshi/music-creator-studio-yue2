// Copy kuromoji's dictionary into public/ so the WebView can load it offline (runs before dev/build).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "kuromoji", "dict");
const dst = join(root, "public", "kuromoji", "dict");
if (!existsSync(src)) {
  console.error("kuromoji dictionary not found; run npm install");
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
// The prebuilt browser bundle is loaded with a <script> tag at runtime (its zlibjs dependency
// breaks when bundled as an ES module), so copy it next to the dictionary.
cpSync(join(root, "node_modules", "kuromoji", "build", "kuromoji.js"), join(root, "public", "kuromoji", "kuromoji.js"));
console.log(`kuromoji dict and browser build copied to ${dirname(dst)}`);
