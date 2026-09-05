import { defineConfig } from "vite";

// No @types/node in this project, so resolve the alias with the WHATWG URL API
// (available in Node and typed via lib.dom) instead of node:url.
const SRC_INDEX = decodeURIComponent(new URL("../src/index.ts", import.meta.url).pathname);

// Demo page. It is built against the library's TypeScript *source*, not the
// published dist/, so `npm run demo` always reflects the current src/. The
// "plotpolish" alias below points at src/index.ts; server.fs.allow lets Vite
// read ../python/plotpolish/core.py?raw, which src/backend.ts inlines via a
// `?raw` import (see docs/design.md, "Python helper transport"). The demo
// itself never imports from python/ directly.
export default defineConfig({
  root: "demo",
  base: "./",
  server: {
    fs: {
      allow: [".."],
    },
  },
  resolve: {
    alias: {
      plotpolish: SRC_INDEX,
    },
  },
  build: {
    outDir: "../dist-demo",
    emptyOutDir: true,
  },
});
