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
import { RC_KEYS, rcEqual, type PropCycleValue } from "./schema";

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
    rc["axes.prop_cycle"] = ["#111111", "#222222"];
    const block = generateBlock({ style: "default", rc })!;
    const idxCycle = block.indexOf('"axes.prop_cycle"');
    const idxFont = block.indexOf('"font.size"');
    const idxGrid = block.indexOf('"axes.grid"');
    expect(idxCycle).toBeGreaterThan(-1);
    expect(idxFont).toBeGreaterThan(idxCycle);
    expect(idxGrid).toBeGreaterThan(idxFont);
    // sanity check against the schema itself
    expect(RC_KEYS.indexOf("axes.prop_cycle")).toBeLessThan(RC_KEYS.indexOf("font.size"));
    expect(RC_KEYS.indexOf("font.size")).toBeLessThan(RC_KEYS.indexOf("axes.grid"));
  });

  it("emits unknown keys after known keys, in insertion order", () => {
    const rc: StyleSettings["rc"] = {};
    rc["font.size"] = 11;
    rc["zzz.unknown.first"] = 1;
    rc["aaa.unknown.second"] = 2;
    rc["axes.prop_cycle"] = ["#111111"];
    const block = generateBlock({ style: "default", rc })!;
    const keyLines = block.split("\n").filter((l) => /^\s*"/.test(l));
    expect(keyLines[0]).toContain('"axes.prop_cycle"');
    expect(keyLines[1]).toContain('"font.size"');
    expect(keyLines[2]).toContain('"zzz.unknown.first"');
    expect(keyLines[3]).toContain('"aaa.unknown.second"');
  });

  it("emits axes.prop_cycle (string[]) as mpl.cycler(color=[...])", () => {
    const block = generateBlock({ style: "default", rc: { "axes.prop_cycle": ["#111", "#222"] } })!;
    expect(block).toContain('"axes.prop_cycle": mpl.cycler(color=["#111", "#222"]),');
  });

  it("emits axes.prop_cycle (PropCycleValue) with color, linewidth, linestyle in that order", () => {
    const propCycle: PropCycleValue = { color: ["#E69F00", "#56B4E9"], linewidth: [2, 1], linestyle: ["-", "--"] };
    const block = generateBlock({ style: "default", rc: { "axes.prop_cycle": propCycle } });
    expect(block).toBe(
      [
        FENCE_START,
        "import matplotlib as mpl",
        "mpl.rcParams.update({",
        '    "axes.prop_cycle": mpl.cycler(color=["#E69F00", "#56B4E9"], linewidth=[2, 1], linestyle=["-", "--"]),',
        "})",
        FENCE_END,
      ].join("\n"),
    );
  });

  it("emits axes.prop_cycle (PropCycleValue) omitting absent keys", () => {
    const propCycle: PropCycleValue = { color: ["#a"], linestyle: ["-"] };
    const block = generateBlock({ style: "default", rc: { "axes.prop_cycle": propCycle } })!;
    expect(block).toContain('"axes.prop_cycle": mpl.cycler(color=["#a"], linestyle=["-"]),');
  });

  it("emits legend.loc (number[]) as a tuple, not a list", () => {
    const block = generateBlock({ style: "default", rc: { "legend.loc": [0.6, 0.2] } })!;
    expect(block).toContain('"legend.loc": (0.6, 0.2),');
  });

  it("emits a numeric list for a list-valued key (figure.figsize, now an unknown key) as a list", () => {
    const block = generateBlock({ style: "default", rc: { "figure.figsize": [8, 5] } })!;
    expect(block).toContain('"figure.figsize": [8, 5],');
  });
});

// ---------------------------------------------------------------------------
// Host-owned rc keys across mpl.style.use
//
// A style sheet may set the very keys the host sets before every run: 8 of
// matplotlib's 29 styles set figure.figsize, seaborn-v0_8 among them, and it is
// one of the eight curated style buttons. Without the save/restore below, a
// re-run of the block threw the host's pane-fitting figsize away.
// ---------------------------------------------------------------------------

describe("generateBlock preserves host-owned rc keys across a style", () => {
  const HOST = ["figure.autolayout", "figure.figsize"];

  it("saves, applies the style, and puts the host's keys back", () => {
    const block = generateBlock({ style: "seaborn-v0_8", rc: {} }, HOST)!;
    expect(block).toBe(
      [
        FENCE_START,
        "import matplotlib as mpl",
        "# Hold on to the values this page set, so the style below does not replace them.",
        '_plotpolish_host_rc = {k: mpl.rcParams[k] for k in ["figure.autolayout", "figure.figsize"] if k in mpl.rcParams}',
        'mpl.style.use("seaborn-v0_8")',
        "mpl.rcParams.update(_plotpolish_host_rc)",
        "del _plotpolish_host_rc",
        FENCE_END,
      ].join("\n"),
    );
  });

  it("restores before the student's own keys, so a key they set still wins", () => {
    const block = generateBlock({ style: "seaborn-v0_8", rc: { "figure.figsize": [4, 3] } }, HOST)!;
    const lines = splitLines(block);
    const restore = lines.indexOf("mpl.rcParams.update(_plotpolish_host_rc)");
    const student = lines.indexOf("mpl.rcParams.update({");
    // Both present, or the comparison below is -1 < n and proves nothing.
    expect(restore).toBeGreaterThan(-1);
    expect(student).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(student);
  });

  it("emits nothing extra when there is no named style: nothing would reset the keys", () => {
    const settings: StyleSettings = { style: "default", rc: { "font.size": 12 } };
    expect(generateBlock(settings, HOST)).toBe(generateBlock(settings));
    expect(generateBlock(settings, HOST)).not.toContain("_plotpolish_host_rc");
  });

  it("emits nothing extra when the host owns no keys", () => {
    const settings: StyleSettings = { style: "seaborn-v0_8", rc: { "font.size": 12 } };
    expect(generateBlock(settings, [])).toBe(generateBlock(settings));
    expect(generateBlock(settings, [])).not.toContain("_plotpolish_host_rc");
  });

  it("never resets rc wholesale to do it", () => {
    const block = generateBlock({ style: "seaborn-v0_8", rc: { "font.size": 12 } }, HOST)!;
    expect(block).not.toContain('mpl.style.use("default")');
    expect(block).not.toContain("mpl.rcdefaults");
    expect(block).not.toContain("rcParamsDefault");
  });

  it("deletes the name it binds, leaving nothing behind in the student's globals", () => {
    const block = generateBlock({ style: "bmh", rc: {} }, HOST)!;
    expect(block).toContain("del _plotpolish_host_rc");
    // Bound once, read once, deleted once.
    expect(splitLines(block).filter((l) => l.includes("_plotpolish_host_rc"))).toHaveLength(3);
  });

  it("dedupes the host's keys and drops blanks", () => {
    const block = generateBlock({ style: "bmh", rc: {} }, ["figure.figsize", "figure.figsize", ""])!;
    expect(block).toContain('for k in ["figure.figsize"] if k in mpl.rcParams');
  });

  it("round-trips: parseBlock reads a block that carries host keys", () => {
    const settings: StyleSettings = { style: "seaborn-v0_8", rc: { "font.size": 12, "axes.grid": true } };
    const block = generateBlock(settings, HOST)!;
    // Guard: without the save/restore lines this would be an ordinary block and
    // the parse below would prove nothing about them.
    expect(block).toContain("mpl.rcParams.update(_plotpolish_host_rc)");
    const parsed = parseBlock(block)!;
    expect(parsed.settings).toEqual(settings);
    expect(parsed.unknownKeys).toEqual([]);
    expect(parsed.range).toEqual({ start: 0, end: splitLines(block).length - 1 });
  });

  it("upsert with host keys is idempotent and leaves the student's lines alone", () => {
    const settings: StyleSettings = { style: "seaborn-v0_8", rc: { "font.size": 12 } };
    const user = "import matplotlib.pyplot as plt\n\nplt.plot([1, 2])\nplt.show()\n";
    const once = upsertBlock(user, settings, HOST);
    expect(upsertBlock(once, settings, HOST)).toBe(once);
    expect(once.endsWith(user)).toBe(true);
    expect(parseBlock(once)!.settings).toEqual(settings);
  });

  it("regenerating with different host keys replaces the old save line, never stacks them", () => {
    const settings: StyleSettings = { style: "seaborn-v0_8", rc: { "font.size": 12 } };
    const first = upsertBlock("plt.show()\n", settings, HOST);
    const second = upsertBlock(first, settings, ["figure.dpi"]);
    expect(second).toContain('for k in ["figure.dpi"] if k in mpl.rcParams');
    expect(second).not.toContain("figure.autolayout");
    expect(splitLines(second).filter((l) => l.startsWith("_plotpolish_host_rc = "))).toHaveLength(1);
  });

  it("dropping the host keys removes the save/restore lines again", () => {
    const settings: StyleSettings = { style: "seaborn-v0_8", rc: { "font.size": 12 } };
    const withKeys = upsertBlock("plt.show()\n", settings, HOST);
    expect(upsertBlock(withKeys, settings, [])).toBe(upsertBlock("plt.show()\n", settings, []));
  });

  it("replaceFence carries the host keys too", () => {
    const broken = [FENCE_START, "garbage(", FENCE_END, "plt.show()"].join("\n");
    expect(replaceFence(broken, { style: "seaborn-v0_8", rc: {} }, HOST)).toContain(
      "mpl.rcParams.update(_plotpolish_host_rc)",
    );
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
    // figure.figsize left the curated set in round five; it is now kept as an unknown key too.
    expect(parsed.unknownKeys).toEqual(["totally.unknown.key", "figure.figsize"]);
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

  it("reads legend.loc as a tuple back into a number[]", () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      "mpl.rcParams.update({",
      '    "legend.loc": (0.6, 0.2),',
      "})",
    ]);
    const parsed = parseBlock(src)!;
    expect(parsed.settings.rc["legend.loc"]).toEqual([0.6, 0.2]);
  });

  it("parses a tuple for another key to number[] without error (block.ts is not the validator)", () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      "mpl.rcParams.update({",
      '    "lines.linewidth": (1, 2),',
      "})",
    ]);
    const parsed = parseBlock(src)!;
    expect(parsed.settings.rc["lines.linewidth"]).toEqual([1, 2]);
  });

  it("reads a color-only axes.prop_cycle cycler back as string[] (legacy round trip)", () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      "mpl.rcParams.update({",
      '    "axes.prop_cycle": mpl.cycler(color=["#111", "#222"]),',
      "})",
    ]);
    const parsed = parseBlock(src)!;
    expect(parsed.settings.rc["axes.prop_cycle"]).toEqual(["#111", "#222"]);
  });

  it("reads a per-line axes.prop_cycle cycler back as a PropCycleValue", () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      "mpl.rcParams.update({",
      '    "axes.prop_cycle": mpl.cycler(color=["#E69F00", "#56B4E9"], linewidth=[2, 1], linestyle=["-", "--"]),',
      "})",
    ]);
    const parsed = parseBlock(src)!;
    const expected: PropCycleValue = { color: ["#E69F00", "#56B4E9"], linewidth: [2, 1], linestyle: ["-", "--"] };
    expect(parsed.settings.rc["axes.prop_cycle"]).toEqual(expected);
  });

  it('rejects a cycler for axes.prop_cycle that is missing "color"', () => {
    const src = fenceBody([
      "import matplotlib as mpl",
      "mpl.rcParams.update({",
      '    "axes.prop_cycle": mpl.cycler(linestyle=["-", "--"]),',
      "})",
    ]);
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

  it("lands after a parenthesized multi-line __future__ import", () => {
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
// rcEqual (schema.ts) and the PropCycleValue / string[] legacy equivalence
// ---------------------------------------------------------------------------

describe("rcEqual", () => {
  it("treats a colors-only array and an equivalent PropCycleValue as equal", () => {
    expect(rcEqual(["#a"], { color: ["#a"] })).toBe(true);
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
