/**
 * Builds the case file the live-vs-re-run harness runs (see
 * python/tests/test_live_matches_rerun.py).
 *
 * The harness has to compare a figure that live preview touched against a
 * figure a re-run of the generated block drew. It therefore needs real blocks,
 * and a Python transcription of generateBlock() would be free to drift from
 * the generator the panel actually uses -- so the blocks are written from HERE,
 * by the real generator, into a committed JSON file that pytest reads.
 *
 * This test regenerates that file and fails if what is on disk is stale, which
 * is what stops the two halves drifting apart. Run `npx vitest run` after
 * changing controls.json (or a program below) and commit the result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateBlock, type StyleSettings } from "./block";
import { CONTROLS, type ControlSpec, type RcValue } from "./schema";

// Relative to the vite root, which is the repo root (see vite.config.ts).
const CASE_FILE = resolve(process.cwd(), "python/tests/fixtures/live-cases.json");

/**
 * Student programs. The block goes at the top: insertionIndex() would put it
 * after the import header, and nothing here reads an rcParam before plotting,
 * so the two placements draw the same figure.
 *
 * Every program is deterministic -- no random data, no timestamps -- because
 * the harness compares two renders byte for byte.
 */
const PROGRAMS: Record<string, string> = {
  basic: [
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "x = np.linspace(0, 10, 50)",
    "fig, ax = plt.subplots()",
    'ax.plot(x, np.sin(x), label="sin")',
    'ax.plot(x, np.cos(x), label="cos")',
    'ax.set_title("Title")',
    'ax.set_xlabel("x")',
    'ax.set_ylabel("y")',
    "ax.legend()",
  ].join("\n"),
  // A line the student styled by hand. Live preview must leave it alone, and
  // so must a re-run -- an explicit lw=3 wins over lines.linewidth either way.
  explicit: [
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "x = np.linspace(0, 10, 50)",
    "fig, ax = plt.subplots()",
    'ax.plot(x, np.sin(x), label="follows the panel")',
    'ax.plot(x, np.cos(x), lw=3, color="#aa3377", label="set in the code")',
    "ax.legend()",
  ].join("\n"),
  // No legend: the legend group's keys have to be harmless when there is none.
  nolegend: [
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "x = np.linspace(0, 10, 50)",
    "fig, ax = plt.subplots()",
    "ax.plot(x, np.sin(x))",
    'ax.set_title("No legend here")',
    'ax.set_xlabel("x")',
    'ax.set_ylabel("y")',
  ].join("\n"),
  // Lines the student coloured from a colormap. Those colours reach the panel as
  // numpy arrays of floats, not hex strings, so the "is this artist still at the
  // value the panel last set?" comparison has to survive a round trip through
  // JSON. Getting that wrong crashed the palette once and, another time, made
  // live preview silently stop applying.
  colormap: [
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "x = np.linspace(0, 10, 50)",
    "fig, ax = plt.subplots()",
    "for i in range(3):",
    '    ax.plot(x, np.sin(x + i), color=plt.cm.viridis(i / 3), label="curve %d" % i)',
    "ax.legend()",
  ].join("\n"),
  // Values big enough that matplotlib factors out an exponent and draws a
  // separate "1e6" label at the end of the axis. That label takes its size from
  // the tick-label rcParam but not from tick_params, so it is easy to leave
  // behind.
  offsets: [
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "x = np.linspace(0, 1e6, 50)",
    "fig, ax = plt.subplots()",
    "ax.plot(x, x * 2.5e6)",
    'ax.set_xlabel("x")',
  ].join("\n"),
  // The student sets their own property cycle, from a colormap. Those colours
  // reach the panel as float arrays; the panel sends back hex. The "is this
  // line still where I left it?" test has to see the two as the same colour.
  cyclecode: [
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "from cycler import cycler",
    "x = np.linspace(0, 10, 50)",
    "plt.rcParams['axes.prop_cycle'] = cycler(color=plt.cm.viridis(np.linspace(0, 1, 3)))",
    "fig, ax = plt.subplots()",
    "for i in range(3):",
    '    ax.plot(x, np.sin(x + i), label="curve %d" % i)',
    "ax.legend()",
  ].join("\n"),
  twoaxes: [
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "x = np.linspace(0, 10, 50)",
    "fig, (a, b) = plt.subplots(1, 2)",
    'a.plot(x, np.sin(x), label="sin")',
    "b.plot(x, np.cos(x))",
    'a.set_title("Left")',
    'b.set_title("Right")',
    'a.set_xlabel("x")',
    "a.legend()",
  ].join("\n"),
};

/**
 * Companion keys a control needs before its own key changes anything the eye
 * can see. Without them the case is vacuous: markersize with no marker, a grid
 * style with the grid off, a minor grid with no minor ticks. The harness
 * rejects a case whose block changes no pixel, so these are load-bearing.
 */
const NEEDS: Record<string, Record<string, RcValue>> = {
  markersize: { "lines.marker": "o" },
  grid_alpha: { "axes.grid": true },
  grid_linestyle: { "axes.grid": true },
  minor_grid: { "axes.grid": true, "xtick.minor.visible": true, "ytick.minor.visible": true },
};

/** A value for `spec` that is genuinely not its default. */
function probeValue(spec: ControlSpec): RcValue | null {
  switch (spec.type) {
    case "bool": {
      const on = spec.onValue ?? true;
      const off = spec.offValue ?? false;
      return rcSame(spec.default, on) ? off : on;
    }
    case "enum": {
      const other = (spec.options ?? []).find((o) => o.value !== spec.default);
      return other ? other.value : null;
    }
    case "number":
    case "fontsize": {
      const lo = spec.min ?? 1;
      const hi = spec.max ?? 10;
      const near = round(lo + 0.75 * (hi - lo));
      return rcSame(spec.default, near) ? round(lo + 0.25 * (hi - lo)) : near;
    }
    case "dpi":
      return 200;
    case "colorcycle":
      return spec.presets?.[1]?.colors ?? null;
    case "linecycle":
      return { color: ["#E69F00", "#56B4E9"], linewidth: [4, 1], linestyle: ["-", ":"] };
    case "legendloc":
      return "lower left";
    default:
      return null;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function rcSame(a: RcValue, b: RcValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Case {
  id: string;
  /** Why this case exists, carried into the pytest failure message. */
  note: string;
  program: string;
  /** Settings applied before the ones under test, to model a change of mind. */
  before: StyleSettings | null;
  /**
   * False when the settings are expected to draw nothing different -- legend
   * keys on a figure with no legend. Such a case still has to run without
   * throwing and still has to match a re-run; it just cannot be asked to prove
   * that anything moved.
   */
  visible: boolean;
  settings: StyleSettings;
  block: string;
  beforeBlock: string | null;
}

function buildCases(): Case[] {
  const cases: Case[] = [];

  // One per live control: the sweep. A key nobody thought to test still gets a
  // case, because the list comes from the schema rather than from a hand-written
  // list that a new control would quietly miss.
  for (const spec of CONTROLS) {
    if (spec.category !== "live" || !spec.keys.length) continue;
    const value = probeValue(spec);
    if (value === null) continue;
    const rc: Record<string, RcValue> = { ...(NEEDS[spec.id] ?? {}) };
    for (const key of spec.keys) rc[key] = value;
    const settings: StyleSettings = { style: "default", rc };
    cases.push({
      id: `sweep:${spec.id}`,
      note: `${spec.label} (${spec.keys.join(", ")}) applied live must draw what the block draws`,
      program: "basic",
      before: null,
      beforeBlock: null,
      visible: true,
      settings,
      block: generateBlock(settings)!,
    });
  }

  // The same sweep against a figure the student styled by hand: only_defaults
  // must leave their line alone, and a re-run leaves it alone too, so the two
  // still have to agree.
  for (const id of ["linewidth", "linestyle", "prop_cycle"]) {
    const spec = CONTROLS.find((c) => c.id === id)!;
    const value = probeValue(spec)!;
    const rc: Record<string, RcValue> = {};
    for (const key of spec.keys) rc[key] = value;
    const settings: StyleSettings = { style: "default", rc };
    cases.push({
      id: `explicit:${id}`,
      note: `${spec.label} must not disturb a line the student styled in their own code`,
      program: "explicit",
      before: null,
      beforeBlock: null,
      visible: true,
      settings,
      block: generateBlock(settings)!,
    });
  }

  // Legend keys against a figure with no legend, and text keys across two axes.
  for (const [program, ids] of Object.entries({
    nolegend: [
      "legend_loc", "legend_frameon", "legend_framealpha", "legend_fontsize",
      "font_size", "title_size", "label_size", "tick_label_size", "font_family",
    ],
    twoaxes: ["font_size", "title_size", "grid", "box", "prop_cycle"],
    offsets: ["font_size", "tick_label_size"],
    cyclecode: ["prop_cycle", "line_cycle", "linewidth"],
  })) {
    for (const id of ids) {
      const spec = CONTROLS.find((c) => c.id === id)!;
      const value = probeValue(spec)!;
      const rc: Record<string, RcValue> = { ...(NEEDS[spec.id] ?? {}) };
      for (const key of spec.keys) rc[key] = value;
      const settings: StyleSettings = { style: "default", rc };
      cases.push({
        id: `${program}:${id}`,
        note: `${spec.label} on the "${program}" figure`,
        program,
        before: null,
        beforeBlock: null,
        visible:
          (program !== "nolegend" || !id.startsWith("legend_")) &&
          !(program === "cyclecode" && id !== "linewidth"),
        settings,
        block: generateBlock(settings)!,
      });
    }
  }

  // Changing your mind. The live figure has already been moved once, so the
  // second apply has to bring it to where a re-run of the SECOND block lands --
  // this is the shape of the revert bug, where the panel's idea of the baseline
  // came from rcParams the block itself had set.
  for (const id of ["linewidth", "grid", "font_size", "prop_cycle"]) {
    const spec = CONTROLS.find((c) => c.id === id)!;
    const value = probeValue(spec)!;
    const first: Record<string, RcValue> = {};
    for (const key of spec.keys) first[key] = value;
    const beforeSettings: StyleSettings = { style: "default", rc: first };

    // ...and then back to nothing at all: the figure must return to what the
    // student's own code draws.
    cases.push({
      id: `revert:${id}`,
      note: `${spec.label} set and then reverted must leave the figure as the code drew it`,
      program: "basic",
      before: beforeSettings,
      beforeBlock: generateBlock(beforeSettings),
      visible: true,
      settings: { style: "default", rc: {} },
      block: "",
    });
  }

  // More than one key at a time. Every case above sends exactly one control's
  // keys, and a whole class of bug only appears when two of them meet: the
  // "(all)" master and the property cycle both drive Line2D.set_linewidth, and
  // for a release the master ran over the lines AFTER the cycler had set them,
  // undoing the per-line values for some lines and not others.
  const both: Record<string, RcValue> = {
    "lines.linewidth": 6,
    "lines.linestyle": "--",
    "axes.prop_cycle": { color: ["#E69F00", "#56B4E9"], linewidth: [2, 4], linestyle: ["-", ":"] },
  };
  cases.push({
    id: "combo:master-and-cycle",
    note: "the (all) masters and the per-line cycle in one apply, on the same lines",
    program: "basic",
    before: null,
    beforeBlock: null,
    visible: true,
    settings: { style: "default", rc: both },
    block: generateBlock({ style: "default", rc: both })!,
  });

  // Everything at once, which is what a student who has been playing for five
  // minutes actually has in their block.
  const everything: Record<string, RcValue> = {};
  for (const spec of CONTROLS) {
    if (spec.category !== "live" || !spec.keys.length) continue;
    const value = probeValue(spec);
    if (value === null) continue;
    for (const key of spec.keys) everything[key] = value;
  }
  everything["lines.marker"] = "o"; // so markersize shows
  for (const program of ["basic", "colormap"]) {
    cases.push({
      id: `combo:everything-${program}`,
      note: `every live key at once on the "${program}" figure`,
      program,
      before: null,
      beforeBlock: null,
      visible: true,
      settings: { style: "default", rc: everything },
      block: generateBlock({ style: "default", rc: everything })!,
    });
  }

  // The palette against colormap-coloured lines, on its own, so a failure names
  // the palette rather than "everything".
  for (const id of ["prop_cycle", "line_cycle", "linewidth"]) {
    const spec = CONTROLS.find((c) => c.id === id)!;
    const value = probeValue(spec)!;
    const rc: Record<string, RcValue> = {};
    for (const key of spec.keys) rc[key] = value;
    cases.push({
      id: `colormap:${id}`,
      note: `${spec.label} on lines the student coloured from a colormap`,
      program: "colormap",
      before: null,
      beforeBlock: null,
      // Every line in that program names its own colour, so a palette changes
      // nothing there -- for either path, which is the point. What must still
      // hold is that the two agree, and that the comparison survives colours
      // that arrive as float arrays rather than hex.
      visible: id !== "prop_cycle",
      settings: { style: "default", rc },
      block: generateBlock({ style: "default", rc })!,
    });
  }

  return cases;
}

describe("live-vs-re-run case file", () => {
  it("is current (regenerate by running vitest, then commit)", () => {
    const cases = buildCases();
    const payload = JSON.stringify({ programs: PROGRAMS, cases }, null, 2) + "\n";
    let onDisk: string | null = null;
    try {
      onDisk = readFileSync(CASE_FILE, "utf8");
    } catch {
      onDisk = null;
    }
    if (onDisk !== payload) {
      writeFileSync(CASE_FILE, payload);
      expect(
        onDisk === null
          ? "python/tests/fixtures/live-cases.json did not exist; it has been written -- commit it"
          : "python/tests/fixtures/live-cases.json was stale; it has been rewritten -- commit it"
      ).toBe("python/tests/fixtures/live-cases.json is up to date");
    }
    expect(cases.length).toBeGreaterThan(20);
  });

  it("gives every live control a case", () => {
    const covered = new Set(buildCases().map((c) => c.id.split(":")[1]));
    const missing = CONTROLS.filter(
      (c) => c.category === "live" && c.keys.length && !covered.has(c.id)
    ).map((c) => c.id);
    expect(missing).toEqual([]);
  });
});
