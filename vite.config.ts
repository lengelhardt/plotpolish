/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Library build. The Python helper is inlined by importing
// ../python/plotpolish/core.py?raw, so the bundle carries it verbatim and
// nothing is fetched at runtime.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es", "iife"],
      name: "plotpolish",
      fileName: (format) => (format === "iife" ? "plotpolish.iife.js" : "plotpolish.js"),
    },
    sourcemap: true,
    target: "es2020",
    minify: false,
    rollupOptions: {
      output: {
        extend: true,
      },
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
