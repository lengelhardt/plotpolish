/**
 * Smoke test for the IIFE bundle (dist/plotpolish.iife.js), built for hosts
 * that load scripts with a plain <script> tag and no bundler. This test
 * depends on a build artifact rather than source, so it is run separately
 * via `npm run test:dist` (which builds first) and is skipped — not failed —
 * when dist/ hasn't been built yet, so the default `npm test` stays green.
 */

import { existsSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// Resolved relative to the process cwd, which is the repo root for every
// script that runs this file (`npm test`, `npm run test:dist`, `vitest`).
const distPath = "dist/plotpolish.iife.js";
const hasDist = existsSync(distPath);

describe("IIFE bundle (dist/plotpolish.iife.js)", () => {
  if (!hasDist) {
    it.skip("dist/plotpolish.iife.js not found — run `npm run build` first", () => {});
    return;
  }

  const code = readFileSync(distPath, "utf8");
  // Evaluate the bundle as a classic (non-module) script would run on a
  // plain-script host: no imports, nothing fetched, just a global assigned.
  new Function(code)();
  const plotpolish = (globalThis as unknown as { plotpolish: Record<string, unknown> }).plotpolish;

  it("defines globalThis.plotpolish.PlotpolishPanel as a function", () => {
    expect(plotpolish).toBeDefined();
    expect(typeof plotpolish.PlotpolishPanel).toBe("function");
  });

  it("registers the <plotpolish-panel> custom element as a side effect", () => {
    expect(customElements.get("plotpolish-panel")).toBeDefined();
  });

  it("inlines the Python helper, with its dispatch entry point", () => {
    expect(typeof plotpolish.HELPER_SOURCE).toBe("string");
    expect(plotpolish.HELPER_SOURCE as string).toContain("def dispatch(");
  });
});
