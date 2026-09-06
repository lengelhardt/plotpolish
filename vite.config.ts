/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { VERSION } from "./src/constants";

// BSD-3-Clause clause 2 asks that binary redistributions reproduce the notice.
// Hosts vendor the bundle by curling a release asset, so the notice has to
// travel inside the file itself rather than depend on them fetching LICENSE.
// The `/*!` form is the convention minifiers preserve.
const BANNER =
  `/*! plotpolish v${VERSION} | (c) 2026 Larry Engelhardt and plotpolish contributors` +
  ` | SPDX-License-Identifier: BSD-3-Clause | https://github.com/lengelhardt/plotpolish */`;

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
        banner: BANNER,
      },
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
