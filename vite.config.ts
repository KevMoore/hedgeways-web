import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { host: true, open: false },
  build: { target: "es2022", assetsInlineLimit: 0 },
});
