/// <reference types="vitest/config" />
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import { VERSION } from "./src/constants";

// The whole license, not just an identifier.
//
// BSD-3-Clause asks a redistribution to carry the copyright notice, the list of
// conditions AND the disclaimer -- clause 1 "retains" them in source form,
// clause 2 reproduces them alongside a binary. This build sets `minify: false`,
// so what ships is readable, commented JavaScript, which is the clause-1
// reading whether or not clause 2 also applies; and hosts vendor plotpolish by
// curling one release asset, so anything that lives beside the file rather than
// inside it is one sync script away from being left behind. Carrying the text
// costs ~1.5 KB of a 190 KB bundle and makes every downstream host compliant by
// serving the file, which is the point: the host that gets this wrong would be
// someone else's course infrastructure, not ours.
//
// Read from LICENSE rather than retyped, so the two cannot drift, and resolved
// against this file rather than the working directory, so a tool that runs vite
// from a subdirectory still builds. `/*!` is the form minifiers preserve, and
// the SPDX id stays on the first line where a scanner (and the release gate)
// looks for it.
//
// fileURLToPath, not `.pathname`: on Windows a file: URL's pathname is
// "/C:/..." with a leading slash, which readFileSync cannot open. It also does
// the percent-decoding that decodeURIComponent was here for.
const LICENSE_PATH = fileURLToPath(new URL("./LICENSE", import.meta.url));
const LICENSE_TEXT = readFileSync(LICENSE_PATH, "utf8").trimEnd();
const BANNER = [
  `/*! plotpolish v${VERSION} | SPDX-License-Identifier: BSD-3-Clause | https://github.com/lengelhardt/plotpolish`,
  " *",
  ...LICENSE_TEXT.split("\n").map((line) => (line ? ` * ${line}` : " *")),
  " */",
].join("\n");

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
