/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Library build. The Python helper is inlined by importing
// ../python/stylefence/core.py?raw, so the bundle carries it verbatim and
// nothing is fetched at runtime.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "stylefence",
    },
    sourcemap: true,
    target: "es2020",
    minify: false,
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
