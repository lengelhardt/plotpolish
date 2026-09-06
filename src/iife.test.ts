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

  // A host vendors this file on its own -- that is the whole point of the IIFE
  // build -- and serves it from its own origin. A `//# sourceMappingURL=`
  // comment would then make every one of that host's users' devtools request a
  // .map they never copied, which is a 404 apiece. The map is still built
  // (`sourcemap: "hidden"`) and still published beside the release, for anyone
  // who wants to attach it by hand.
  it("carries no sourceMappingURL, so a host can vendor it as one file", () => {
    expect(code).not.toContain("sourceMappingURL");
  });

  it("inlines the Python helper, with its dispatch entry point", () => {
    expect(typeof plotpolish.HELPER_SOURCE).toBe("string");
    expect(plotpolish.HELPER_SOURCE as string).toContain("def dispatch(");
  });

  // BSD-3-Clause asks a redistribution to carry the copyright notice, the list
  // of conditions AND the disclaimer. Checking for the SPDX identifier alone
  // proves only that vite wrote a banner two lines earlier in the same repo: it
  // cannot tell a complete notice from a truncated one, which is exactly what
  // this is meant to catch. So compare against LICENSE itself.
  it.each(["dist/plotpolish.js", "dist/plotpolish.iife.js"])(
    "%s opens with the whole license, not just an identifier",
    (file) => {
      const bundle = readFileSync(file, "utf8");
      const banner = bundle.slice(0, bundle.indexOf("*/") + 2);

      expect(banner.split("\n")[0]).toContain("SPDX-License-Identifier: BSD-3-Clause");
      // Strip the comment furniture and what is left must be LICENSE verbatim.
      const carried = banner
        .split("\n")
        .slice(1, -1)
        .map((line) => line.replace(/^ \*( |$)/, ""))
        .join("\n")
        .trim();
      expect(carried).toBe(readFileSync("LICENSE", "utf8").trim());
    }
  );
});
