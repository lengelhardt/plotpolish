import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  FenceError,
  findFence,
  generateBlock,
  insertionIndex,
  parseBlock,
  removeBlock,
  replaceFence,
  upsertBlock,
  type StyleSettings,
} from "./block";
import { FENCE_END, FENCE_START } from "./constants";
import { RC_KEYS } from "./schema";

function splitLines(source: string): string[] {
  return source.split(/\r?\n/);
}

/** Wrap body lines in the fence markers, joined with "\n". */
function fenceBody(bodyLines: string[]): string {
  return [FENCE_START, ...bodyLines, FENCE_END].join("\n");
}

/** Run `fn`, expecting it to throw a FenceError, and return that error. */
function captureFenceError(fn: () => unknown): FenceError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FenceError) return e;
    throw e;
  }
  throw new Error("expected a FenceError to be thrown");
}

// ---------------------------------------------------------------------------
// findFence
// ---------------------------------------------------------------------------

describe("findFence", () => {
  it("returns null when there is no fence", () => {
    expect(findFence("import os\nprint(1)\n")).toBeNull();
  });

  it("returns the correct range for a well-formed fence", () => {
    const src = ["before", FENCE_START, "import matplotlib as mpl", FENCE_END, "after"].join("\n");
    expect(findFence(src)).toEqual({ start: 1, end: 3 });
  });

  it("tolerates trailing whitespace after a marker", () => {
    const src = [`${FENCE_START}   `, "code", `${FENCE_END}\t`].join("\n");
    expect(findFence(src)).toEqual({ start: 0, end: 2 });
  });

  it('throws "multiple-start" for two start markers', () => {
    const src = [FENCE_START, FENCE_START].join("\n");
    expect(captureFenceError(() => findFence(src)).kind).toBe("multiple-start");
  });

  it('throws "multiple-end" for two end markers', () => {
    const src = [FENCE_START, FENCE_END, FENCE_END].join("\n");
    expect(captureFenceError(() => findFence(src)).kind).toBe("multiple-end");
  });

  it('throws "unterminated" when there is a start but no end', () => {
    const src = [FENCE_START, "x"].join("\n");
    expect(captureFenceError(() => findFence(src)).kind).toBe("unterminated");
  });

  it('throws "orphan-end" when there is an end but no start', () => {
    const src = ["x", FENCE_END].join("\n");
    expect(captureFenceError(() => findFence(src)).kind).toBe("orphan-end");
  });

  it('throws "out-of-order" when the end precedes the start', () => {
    const src = [FENCE_END, FENCE_START].join("\n");
    expect(captureFenceError(() => findFence(src)).kind).toBe("out-of-order");
  });

  it('throws "indented" for a marker with leading spaces', () => {
    const src = [`   ${FENCE_START}`, "code", FENCE_END].join("\n");
    expect(captureFenceError(() => findFence(src)).kind).toBe("indented");
  });
});

// ---------------------------------------------------------------------------
// generateBlock
// ---------------------------------------------------------------------------

describe("generateBlock", () => {
  it("returns null for default settings", () => {
    expect(generateBlock({ style: "default", rc: {} })).toBeNull();
  });

  it('returns null for style "" with empty rc', () => {
    expect(generateBlock({ style: "", rc: {} })).toBeNull();
  });

  it("emits a style line only when style is not default", () => {
    const withStyle = generateBlock({ style: "bmh", rc: {} })!;
    expect(withStyle).toContain('mpl.style.use("bmh")');
    expect(withStyle).not.toContain("mpl.rcParams.update(");

    const withoutStyleLine = generateBlock({ style: "default", rc: { "font.size": 9 } })!;
    expect(withoutStyleLine).not.toContain("mpl.style.use(");
    expect(withoutStyleLine).toContain("mpl.rcParams.update(");
  });

  it("emits rcParams.update only when rc is non-empty", () => {
    expect(generateBlock({ style: "bmh", rc: {} })).not.toContain("mpl.rcParams.update(");
    expect(generateBlock({ style: "default", rc: { "lines.linewidth": 2 } })).toContain(
      "mpl.rcParams.update(",
    );
  });

  it("emits known keys in schema order regardless of insertion order", () => {
    const rc: StyleSettings["rc"] = {};
    rc["axes.grid"] = true;
    rc["font.size"] = 11;
    rc["figure.figsize"] = [5, 4];
    const block = generateBlock({ style: "default", rc })!;
    const idxFigsize = block.indexOf('"figure.figsize"');
    const idxFont = block.indexOf('"font.size"');
    const idxGrid = block.indexOf('"axes.grid"');
    expect(idxFigsize).toBeGreaterThan(-1);
    expect(idxFont).toBeGreaterThan(idxFigsize);
    expect(idxGrid).toBeGreaterThan(idxFont);
    // sanity check against the schema itself
    expect(RC_KEYS.indexOf("figure.figsize")).toBeLessThan(RC_KEYS.indexOf("font.size"));
    expect(RC_KEYS.indexOf("font.size")).toBeLessThan(RC_KEYS.indexOf("axes.grid"));
  });

  it("emits unknown keys after known keys, in insertion order", () => {
    const rc: StyleSettings["rc"] = {};
    rc["font.size"] = 11;
    rc["zzz.unknown.first"] = 1;
    rc["aaa.unknown.second"] = 2;
    rc["figure.figsize"] = [5, 4];
    const block = generateBlock({ style: "default", rc })!;
    const keyLines = block.split("\n").filter((l) => /^\s*"/.test(l));
    expect(keyLines[0]).toContain('"figure.figsize"');
    expect(keyLines[1]).toContain('"font.size"');
    expect(keyLines[2]).toContain('"zzz.unknown.first"');
    expect(keyLines[3]).toContain('"aaa.unknown.second"');
  });

  it("emits axes.prop_cycle (string[]) as mpl.cycler(color=[...])", () => {
    const block = generateBlock({ style: "default", rc: { "axes.prop_cycle": ["#111", "#222"] } })!;
    expect(block).toContain('"axes.prop_cycle": mpl.cycler(color=["#111", "#222"]),');
  });
});

// ---------------------------------------------------------------------------
// parseBlock
// ---------------------------------------------------------------------------

describe("parseBlock", () => {
  it("returns null when there is no fence", () => {
    expect(parseBlock("import os\nprint(1)\n")).toBeNull();
  });

  it("reads style and rc from a hand-written block", () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      'mpl.style.use("dark_background")',
      "mpl.rcParams.update({",
      '    "lines.linewidth": 3,',
      '    "legend.loc": "lower left",',
      "})",
    ]);
    const parsed = parseBlock(src)!;
    expect(parsed.settings).toEqual({
      style: "dark_background",
      rc: { "lines.linewidth": 3, "legend.loc": "lower left" },
    });
    expect(parsed.unknownKeys).toEqual([]);
    expect(parsed.range).toEqual({ start: 0, end: src.split("\n").length - 1 });
  });

  it("lists rc keys that no control owns in unknownKeys, keeping them in settings.rc", () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      "mpl.rcParams.update({",
      '    "totally.unknown.key": 5,',
      '    "figure.figsize": [6, 4],',
      "})",
    ]);
    const parsed = parseBlock(src)!;
    expect(parsed.unknownKeys).toEqual(["totally.unknown.key"]);
    expect(parsed.settings.rc["totally.unknown.key"]).toBe(5);
    expect(parsed.settings.rc["figure.figsize"]).toEqual([6, 4]);
  });

  it("tolerates blank lines and # comments, including one after the update's })", () => {
    const src = fenceBody([
      "# leading comment",
      "",
      "import matplotlib as mpl",
      "",
      "# style comment",
      'mpl.style.use("bmh")',
      "",
      "mpl.rcParams.update({",
      '    "font.size": 10,',
      "})",
      "# trailing comment after the update block",
    ]);
    const parsed = parseBlock(src)!;
    expect(parsed.settings).toEqual({ style: "bmh", rc: { "font.size": 10 } });
  });

  it("rejects a line that is not import/style/update", () => {
    const src = fenceBody(["import matplotlib as mpl", 'print("hi")']);
    expect(captureFenceError(() => parseBlock(src)).kind).toBe("malformed");
  });

  it('rejects an rc block missing "import matplotlib as mpl"', () => {
    const src = fenceBody(["mpl.rcParams.update({", '    "font.size": 12,', "})"]);
    expect(captureFenceError(() => parseBlock(src)).kind).toBe("malformed");
  });

  it("rejects mpl.cycler used for a key other than axes.prop_cycle", () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      "mpl.rcParams.update({",
      '    "lines.linewidth": mpl.cycler(color=["#fff"]),',
      "})",
    ]);
    expect(captureFenceError(() => parseBlock(src)).kind).toBe("malformed");
  });

  it("rejects junk after the closing ) on the same line", () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      "mpl.rcParams.update({",
      '    "font.size": 12,',
      "}) extra",
    ]);
    expect(captureFenceError(() => parseBlock(src)).kind).toBe("malformed");
  });

  it("rejects a missing closing ) on the update call", () => {
    const src = fenceBody(["import matplotlib as mpl", "mpl.rcParams.update({", '    "font.size": 12,', "}"]);
    expect(captureFenceError(() => parseBlock(src)).kind).toBe("malformed");
  });

  it("rejects a bad style-name expression like mpl.style.use(name)", () => {
    const src = fenceBody(["import matplotlib as mpl", "mpl.style.use(name)"]);
    expect(captureFenceError(() => parseBlock(src)).kind).toBe("malformed");
  });
});

// ---------------------------------------------------------------------------
// insertionIndex
// ---------------------------------------------------------------------------

describe("insertionIndex", () => {
  it("is 0 for a file starting with an import", () => {
    expect(insertionIndex(["import numpy as np", "print(1)"])).toBe(0);
  });

  it("is 0 for an empty file", () => {
    expect(insertionIndex([])).toBe(0);
  });

  it("lands after a shebang", () => {
    expect(insertionIndex(["#!/usr/bin/env python", "import os"])).toBe(1);
  });

  it("lands after a coding comment", () => {
    expect(insertionIndex(["# -*- coding: utf-8 -*-", "import os"])).toBe(1);
  });

  it("lands after leading comment lines", () => {
    expect(insertionIndex(["# comment1", "# comment2", "import os"])).toBe(2);
  });

  it("lands after a one-line docstring", () => {
    expect(insertionIndex(['"""doc"""', "import os"])).toBe(1);
  });

  it("lands after a multi-line docstring", () => {
    expect(insertionIndex(['"""', "multi", "line", "doc", '"""', "import os"])).toBe(5);
  });

  it("lands after a simple __future__ import", () => {
    expect(insertionIndex(["from __future__ import annotations", "import os"])).toBe(1);
  });

  it("lands after a parenthesised multi-line __future__ import", () => {
    expect(
      insertionIndex(["from __future__ import (", "    annotations,", ")", "import os"]),
    ).toBe(3);
  });

  it("lands after both a docstring and a __future__ import", () => {
    expect(
      insertionIndex(['"""doc"""', "from __future__ import annotations", "import os"]),
    ).toBe(2);
  });

  it("skips blank lines between headers, landing right after the last header (not after trailing blanks)", () => {
    const lines = ["# comment", "", "from __future__ import annotations", "", "import os"];
    expect(insertionIndex(lines)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// upsertBlock
// ---------------------------------------------------------------------------

describe("upsertBlock", () => {
  it("inserts at the top of a plain script with a blank line separator", () => {
    const user = "import numpy as np\nprint(1)\n";
    const settings: StyleSettings = { style: "bmh", rc: {} };
    const result = upsertBlock(user, settings);
    const expectedBlock = generateBlock(settings)!;
    expect(result).toBe(`${expectedBlock}\n\n${user}`);
  });

  it("inserts after header lines (shebang + encoding + comment)", () => {
    const header = "#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n# a comment\n";
    const body = "import sys\nsys.exit(0)\n";
    const user = header + body;
    const settings: StyleSettings = { style: "default", rc: { "font.size": 11 } };
    const result = upsertBlock(user, settings);
    const expectedBlock = generateBlock(settings)!;
    expect(result).toBe(`${header}\n${expectedBlock}\n\n${body}`);
  });

  it("replaces an existing fence in place, leaving surrounding lines byte-identical", () => {
    const before = "import numpy as np\n";
    const after = "\nplt.plot([1, 2], [3, 4])\nplt.show()\n";
    const oldSettings: StyleSettings = { style: "bmh", rc: { "font.size": 8 } };
    const newSettings: StyleSettings = { style: "ggplot", rc: { "lines.linewidth": 3 } };
    const oldBlock = generateBlock(oldSettings)!;
    const source = `${before}\n${oldBlock}${after}`;
    const result = upsertBlock(source, newSettings);
    const newBlock = generateBlock(newSettings)!;
    expect(result).toBe(`${before}\n${newBlock}${after}`);
  });

  it("returns the source unchanged for default settings with no existing fence", () => {
    const source = "import os\nprint('hi')\n";
    expect(upsertBlock(source, defaultSettings())).toBe(source);
  });

  it("removes an existing fence (plus one blank line) when settings become default", () => {
    const settings: StyleSettings = { style: "bmh", rc: {} };
    const block = generateBlock(settings)!;
    const source = `${block}\n\nprint('hi')\n`;
    expect(upsertBlock(source, defaultSettings())).toBe("print('hi')\n");
  });

  it("preserves CRLF line endings", () => {
    const settings: StyleSettings = { style: "bmh", rc: {} };
    const source = "import os\r\nprint(1)\r\n";
    const result = upsertBlock(source, settings);
    // every "\n" is part of a "\r\n" pair -- no lone "\n" anywhere
    expect(result.replace(/\r\n/g, "")).not.toContain("\n");
    expect(result).toContain('mpl.style.use("bmh")\r\n');
    expect(result).toContain("import os\r\nprint(1)\r\n");
  });

  it("throws when the existing fence is malformed (e.g. two starts)", () => {
    const source = [FENCE_START, FENCE_START, "x", FENCE_END].join("\n");
    const err = captureFenceError(() => upsertBlock(source, { style: "bmh", rc: {} }));
    expect(err.kind).toBe("multiple-start");
  });
});

// ---------------------------------------------------------------------------
// removeBlock
// ---------------------------------------------------------------------------

describe("removeBlock", () => {
  it("removes the fence and one adjacent blank line", () => {
    const settings: StyleSettings = { style: "bmh", rc: {} };
    const block = generateBlock(settings)!;
    const source = `before\n\n${block}\n\nafter\n`;
    expect(removeBlock(source)).toBe("before\n\nafter\n");
  });

  it("is a no-op when there is no fence", () => {
    const source = "x = 1\ny = 2\n";
    expect(removeBlock(source)).toBe(source);
  });

  it("removing a fence at the very top leaves no leading blank lines", () => {
    const settings: StyleSettings = { style: "bmh", rc: {} };
    const block = generateBlock(settings)!;
    const source = `${block}\n\n\ncode()\n`; // two blank lines after the fence
    const result = removeBlock(source);
    expect(result).toBe("code()\n");
    expect(result.startsWith("\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// replaceFence
// ---------------------------------------------------------------------------

describe("replaceFence", () => {
  it("replaces everything between the first start and the last end, even with stray markers in between", () => {
    const settings: StyleSettings = { style: "bmh", rc: {} };
    const source = [
      "before",
      FENCE_START,
      "garbage1",
      FENCE_START,
      "garbage2",
      FENCE_END,
      "garbage3",
      FENCE_END,
      "after",
    ].join("\n");
    const result = replaceFence(source, settings);
    const newBlock = generateBlock(settings)!;
    expect(result).toBe(`before\n${newBlock}\nafter`);
  });

  it("strips stray markers and inserts normally when there is no coherent pair", () => {
    const settings: StyleSettings = { style: "bmh", rc: {} };
    const source = ["import os", FENCE_END, "print(1)"].join("\n");
    const result = replaceFence(source, settings);
    const cleaned = ["import os", "print(1)"].join("\n");
    expect(result).toBe(upsertBlock(cleaned, settings));
    expect(() => findFence(result)).not.toThrow();
    expect(parseBlock(result)!.settings).toEqual(settings);
  });
});

// ---------------------------------------------------------------------------
// Load-bearing property: upsertBlock never loses, duplicates, or reorders the
// user's own content lines. (Blank-line spacing immediately adjacent to the
// fence is explicitly part of what the fence "owns" -- see the module's own
// header comment -- so it is excluded from this comparison.)
// ---------------------------------------------------------------------------

describe("property: upsertBlock preserves the user's non-fence content lines", () => {
  function nonFenceContentLines(source: string): string[] {
    return splitLines(removeBlock(source))
      .filter((l) => l.trim() !== "")
      .sort();
  }

  const sources = [
    "import numpy as np\nplt.plot(x, y)\nplt.show()\n",
    "#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nimport os\nprint('hi')\n",
    `${generateBlock({ style: "ggplot", rc: { "font.size": 12 } })}\n\nimport sys\nsys.exit(0)\n`,
    '"""Module doc."""\nfrom __future__ import annotations\nimport sys\nsys.exit(0)\n',
    "\n\nx = 1\n",
  ];

  const settingsVariants: StyleSettings[] = [
    defaultSettings(),
    { style: "ggplot", rc: {} },
    { style: "default", rc: { "font.size": 9, "axes.grid": true } },
  ];

  it("keeps the same multiset of non-fence content lines for every source/settings combination", () => {
    for (const source of sources) {
      const before = nonFenceContentLines(source);
      for (const settings of settingsVariants) {
        const result = upsertBlock(source, settings);
        const after = nonFenceContentLines(result);
        expect(after).toEqual(before);
      }
    }
  });
});
