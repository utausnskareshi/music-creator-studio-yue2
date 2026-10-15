import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, statSync } from "node:fs";
import path, { resolve } from "node:path";
import process from "node:process";
import { kuromojiDictFile } from "./tools/kuromoji-dict-path";
const host = process.env.TAURI_DEV_HOST;

/**
 * Serve kuromoji's gzipped dictionary files as opaque binaries during development. Vite's static
 * server adds `Content-Encoding: gzip` to *.gz files, so the WebView would decompress them before
 * kuromoji runs its own gunzip ("invalid file signature"). Production (Tauri asset protocol) does not
 * add the header, so this is dev-only. Only regular files inside public/kuromoji/dict are served (this middleware
 * runs before Vite's own file-system guards); anything else goes on to Vite.
 */
function kuromojiDictPlugin(): Plugin {
  return {
    name: "mcs-kuromoji-dict",
    configureServer(server) {
      const base = resolve(server.config.publicDir, "kuromoji", "dict");
      server.middlewares.use((req, res, next) => {
        // "..", an absolute path, a malformed escape or the folder itself: on to Vite (tools/kuromoji-dict-path.ts)
        const file = kuromojiDictFile(path, base, req.url ?? "");
        if (!file) return next();
        let size: number;
        try {
          const st = statSync(file);
          if (!st.isFile()) return next();
          size = st.size;
        } catch {
          return next();
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", String(size));
        res.setHeader("Cache-Control", "no-cache");
        const stream = createReadStream(file);
        stream.on("error", (e) => {
          // an unhandled stream error would end the dev server
          if (res.headersSent) res.destroy(e);
          else next(e);
        });
        stream.pipe(res);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), kuromojiDictPlugin()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
