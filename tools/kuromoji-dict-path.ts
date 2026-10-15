// The file the dev server's kuromoji middleware (vite.config.ts) may serve for a request URL. Kept apart from the
// config so the path rules can be unit-tested (tools/kuromoji-dict-path.unit.test.ts) with either path flavour.
import type path from "node:path";

export const KUROMOJI_DICT_PREFIX = "/kuromoji/dict/";

/**
 * The file under `base` (the dictionary folder) that `url` names, or null: another URL, a malformed escape, and
 * anything that resolves outside the folder or to the folder itself ("..", an encoded "\" or "/", an absolute or
 * other-drive path, a UNC path, a sibling folder such as dict2). Whether the file exists is the caller's check.
 */
export function kuromojiDictFile(p: typeof path, base: string, url: string): string | null {
  const u = url.split("?")[0];
  if (!u.startsWith(KUROMOJI_DICT_PREFIX)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.slice(KUROMOJI_DICT_PREFIX.length));
  } catch {
    return null; // malformed escape
  }
  const file = p.resolve(base, rel);
  return file.startsWith(base + p.sep) ? file : null;
}
