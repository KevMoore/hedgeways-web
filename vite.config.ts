import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { host: true, open: false },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false, // never ship readable source maps to prod (explicit; also the default)
  },
  // esbuild minify is on by default; additionally strip console/debugger and all
  // comments so the shipped bundle is as small and opaque as practical. (This is
  // obfuscation, not protection — any client JS is recoverable via DevTools.)
  esbuild: {
    drop: ["console", "debugger"],
    legalComments: "none",
  },
});
