/**
 * Cross-language contract: the golden blocks under python/tests/fixtures/blocks
 * are exactly what generateBlock emits, and parseBlock reads them back.
 * pytest executes the same files on matplotlib 3.8 and 3.10.
 */
import { describe, expect, it } from "vitest";
import { generateBlock, parseBlock, upsertBlock, type StyleSettings } from "./block";

// Vite inlines the fixture files; no Node APIs needed, so this suite runs in the
// same browser-like environment as the rest of the tests.
const FILES = import.meta.glob<string>("../python/tests/fixtures/blocks/*.{py,json}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const NAMES = Object.keys(FILES)
  .filter((f) => f.endsWith(".py"))
  .map((f) => f.replace(/^.*\//, "").slice(0, -3))
  .sort();

function file(name: string, ext: string): string {
  const key = Object.keys(FILES).find((f) => f.endsWith(`/${name}.${ext}`));
  if (!key) throw new Error(`missing fixture ${name}.${ext}`);
  return FILES[key]!;
}

/**
 * The sidecar is the StyleSettings, plus an optional `hostRcKeys` naming the rc
 * keys the host owns -- a generator input, not part of the settings, so it is
 * split back out before anything compares against what parseBlock returns.
 */
function load(name: string): { py: string; settings: StyleSettings; hostRcKeys: string[] } {
  const py = file(name, "py").replace(/\n$/, "");
  const { hostRcKeys = [], ...settings } = JSON.parse(file(name, "json")) as StyleSettings & {
    hostRcKeys?: string[];
  };
  return { py, settings, hostRcKeys };
}

describe("golden fixtures", () => {
  it("has fixtures", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(4);
  });

  for (const name of NAMES) {
    describe(name, () => {
      it("generateBlock reproduces the golden block byte for byte", () => {
        const { py, settings, hostRcKeys } = load(name);
        expect(generateBlock(settings, hostRcKeys)).toBe(py);
      });

      it("parseBlock reads the golden block back to the sidecar settings", () => {
        const { py, settings } = load(name);
        const parsed = parseBlock(py);
        expect(parsed).not.toBeNull();
        expect(parsed!.settings).toEqual(settings);
        expect(parsed!.unknownKeys).toEqual([]);
        expect(parsed!.range).toEqual({ start: 0, end: py.split("\n").length - 1 });
      });

      it("upsert into a user file is idempotent", () => {
        const { settings, hostRcKeys } = load(name);
        const user = "import numpy as np\nimport matplotlib.pyplot as plt\n\nplt.plot([1, 2], [3, 4])\nplt.show()\n";
        const once = upsertBlock(user, settings, hostRcKeys);
        const twice = upsertBlock(once, settings, hostRcKeys);
        expect(twice).toBe(once);
        expect(once.endsWith(user.slice(0))).toBe(true); // user's lines untouched, block above them
        expect(parseBlock(once)!.settings).toEqual(settings);
      });
    });
  }
});
