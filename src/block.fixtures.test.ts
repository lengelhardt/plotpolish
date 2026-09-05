/**
 * Cross-language contract: the golden blocks under python/tests/fixtures/blocks
 * are exactly what generateBlock emits, and parseBlock reads them back.
 * pytest executes the same files on matplotlib 3.8 and 3.10.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateBlock, parseBlock, upsertBlock, type StyleSettings } from "./block";

const DIR = join(__dirname, "..", "python", "tests", "fixtures", "blocks");
const NAMES = readdirSync(DIR).filter((f) => f.endsWith(".py")).map((f) => f.slice(0, -3)).sort();

function load(name: string): { py: string; settings: StyleSettings } {
  const py = readFileSync(join(DIR, `${name}.py`), "utf8").replace(/\n$/, "");
  const settings = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as StyleSettings;
  return { py, settings };
}

describe("golden fixtures", () => {
  it("has fixtures", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(4);
  });

  for (const name of NAMES) {
    describe(name, () => {
      it("generateBlock reproduces the golden block byte for byte", () => {
        const { py, settings } = load(name);
        expect(generateBlock(settings)).toBe(py);
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
        const { settings } = load(name);
        const user = "import numpy as np\nimport matplotlib.pyplot as plt\n\nplt.plot([1, 2], [3, 4])\nplt.show()\n";
        const once = upsertBlock(user, settings);
        const twice = upsertBlock(once, settings);
        expect(twice).toBe(once);
        expect(once.endsWith(user.slice(0))).toBe(true); // user's lines untouched, block above them
        expect(parseBlock(once)!.settings).toEqual(settings);
      });
    });
  }
});
