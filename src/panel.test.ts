/**
 * Tests for <plotpolish-panel> (v3 shell: tab pill/rail, draggable popover,
 * reset menu — see docs/ux-design.md). Importing "./panel" registers the
 * custom element (registerPanel() runs at module load); each test creates a
 * fresh instance, appends it to document.body, and removes it afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AxesDescription, FigureDescription } from "./backend";
import {
  defaultSettings, FenceError, generateBlock, parseBlock, type StyleSettings,
} from "./block";
import { ELEMENT_TAG, FENCE_START } from "./constants";
import {
  PlotpolishPanel, shortStyleName, type AutoUpdateEventDetail, type ChangeEventDetail,
  type PanelErrorEventDetail, type RerunNeededEventDetail, type SavedEventDetail,
} from "./panel";
import { CONTROLS, GROUPS, isPropCycle, type PropCycleValue } from "./schema";
import { MemorySink, type CodeSink } from "./sink";
import { MockBackend } from "./testing/mock-backend";
import { readFileSync } from "fs";

/**
 * Every control's panelDefault, keyed by rc key: what plotpolish seeds into a
 * block the first time it is created. Derived from the schema on purpose --
 * these were written out longhand as `"savefig.dpi": 300`, so adding a second
 * panelDefault broke sixteen unrelated expectations at once. Spread this into
 * an expected `rc` instead of naming the seeded keys.
 */
const SEEDED: Record<string, unknown> = Object.fromEntries(
  CONTROLS.flatMap((c) =>
    c.panelDefault === undefined ? [] : c.keys.map((k) => [k, c.panelDefault as unknown])
  )
);

/** What those same keys sat at before seeding — the `previous` an apply carries. */
const SEEDED_BEFORE: Record<string, unknown> = Object.fromEntries(
  CONTROLS.flatMap((c) =>
    c.panelDefault === undefined ? [] : c.keys.map((k) => [k, c.default as unknown])
  )
);

// ".row" scopes control lookups to the control's row (badges and other
// elements never carry a bare data-control that isn't a row).
function ctl(panel: PlotpolishPanel, id: string): HTMLElement {
  return panel.shadowRoot!.querySelector(`.row[data-control="${id}"]`) as HTMLElement;
}

function input(panel: PlotpolishPanel, id: string): HTMLElement {
  return panel.shadowRoot!.querySelector(`#ctl-${id}`) as HTMLElement;
}

function pillTab(panel: PlotpolishPanel, groupId: string): HTMLButtonElement {
  return panel.shadowRoot!.querySelector(`.pill button.tab[data-group="${groupId}"]`) as HTMLButtonElement;
}

function railTab(panel: PlotpolishPanel, groupId: string): HTMLButtonElement {
  return panel.shadowRoot!.querySelector(`.rail button.tab[data-group="${groupId}"]`) as HTMLButtonElement;
}

function group(panel: PlotpolishPanel, groupId: string): HTMLElement {
  return panel.shadowRoot!.querySelector(`.group[data-group="${groupId}"]`) as HTMLElement;
}

function menuItem(panel: PlotpolishPanel, action: string): HTMLButtonElement {
  return panel.shadowRoot!.querySelector(`.menu-item[data-action="${action}"]`) as HTMLButtonElement;
}

function openTab(panel: PlotpolishPanel, groupId: string): void {
  pillTab(panel, groupId).click();
}

function tabDot(panel: PlotpolishPanel, groupId: string): HTMLElement {
  return pillTab(panel, groupId).querySelector(".dot") as HTMLElement;
}

/** The popover's one reset, beside the open category's name. */
function groupReset(panel: PlotpolishPanel): HTMLButtonElement {
  return panel.shadowRoot!.querySelector(".pop-head .reset-group") as HTMLButtonElement;
}

function tabRerun(panel: PlotpolishPanel, groupId: string): HTMLElement {
  return pillTab(panel, groupId).querySelector(".rerun") as HTMLElement;
}

function openMenu(panel: PlotpolishPanel): void {
  (panel.shadowRoot!.querySelector("button.menu-toggle") as HTMLButtonElement).click();
}

function change(el: Element): void {
  el.dispatchEvent(new Event("change"));
}

function fireInput(el: Element): void {
  el.dispatchEvent(new Event("input"));
}

/** Waits a macrotask, long enough for every pending microtask (mock backend
 * promise chains included, since MockBackend has no artificial delay by
 * default) to have settled. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function attachBackend(panel: PlotpolishPanel, backend: MockBackend): Promise<void> {
  panel.backend = backend;
  await panel.refresh();
}

const AXES_BASE: Omit<AxesDescription, "legend"> = {
  grid: false,
  grid_alpha: null,
  grid_linestyle: null,
  spines: { top: true, right: true, left: true, bottom: true },
  axes_linewidth: null,
  tick_direction: { x: null, y: null },
  minor_ticks: { x: false, y: false },
  title_size: 12,
  label_size: { x: 10, y: 10 },
  tick_label_size: { x: null, y: null },
  n_lines: 1,
};

function figureWithLegend(legend: AxesDescription["legend"]): FigureDescription {
  return { figsize: [6.4, 4.8], dpi: 100, axes: [{ ...AXES_BASE, legend }] };
}

function figureWithLines(n: number): FigureDescription {
  return { figsize: [6.4, 4.8], dpi: 100, axes: [{ ...AXES_BASE, n_lines: n, legend: null }] };
}

let panel: PlotpolishPanel;

beforeEach(() => {
  panel = document.createElement("plotpolish-panel");
  document.body.append(panel);
});

afterEach(() => {
  panel.remove();
});

describe("registration and rendering", () => {
  it("registers the custom element", () => {
    expect(customElements.get(ELEMENT_TAG)).toBeDefined();
    expect(panel).toBeInstanceOf(PlotpolishPanel);
  });

  it("creates one row per control", () => {
    const rows = panel.shadowRoot!.querySelectorAll(".row");
    expect(rows.length).toBe(CONTROLS.length);
  });

  it("has no figsize control (figure size was removed from the panel)", () => {
    expect(ctl(panel, "figsize")).toBeNull();
  });

  it("creates a group per schema group, tagged with data-group, in schema order", () => {
    const groups = panel.shadowRoot!.querySelectorAll(".group[data-group]");
    expect(groups.length).toBe(GROUPS.length);
    const ids = Array.from(groups).map((g) => (g as HTMLElement).dataset.group);
    expect(ids).toEqual(GROUPS.map((g) => g.id));
  });

  it("renders the pill with one tab per group in schema order, and no 'Style' label", () => {
    expect(panel.shadowRoot!.querySelector(".pill .label")).toBeNull();
    expect(panel.shadowRoot!.querySelector(".pill")!.textContent).not.toContain("Style");
    const tabs = Array.from(panel.shadowRoot!.querySelectorAll(".pill button.tab")) as HTMLElement[];
    expect(tabs.map((t) => t.dataset.group)).toEqual(GROUPS.map((g) => g.id));
  });

  it("starts closed, with no active category", () => {
    expect(panel.open).toBe(false);
    expect(panel.category).toBeNull();
    expect(panel.hasAttribute("open")).toBe(false);
    expect((panel.shadowRoot!.querySelector(".popover") as HTMLElement).hidden).toBe(true);
  });
});

describe("tab pill: opening and closing the popover", () => {
  it("clicking a tab opens the popover on that category", () => {
    openTab(panel, "text");
    expect(panel.category).toBe("text");
    expect(panel.open).toBe(true);
    expect(panel.hasAttribute("open")).toBe(true);
    expect((panel.shadowRoot!.querySelector(".popover") as HTMLElement).hidden).toBe(false);
    expect(pillTab(panel, "text").getAttribute("aria-selected")).toBe("true");
  });

  it("clicking the active tab again closes the popover", () => {
    openTab(panel, "text");
    openTab(panel, "text");
    expect(panel.open).toBe(false);
    expect((panel.shadowRoot!.querySelector(".popover") as HTMLElement).hidden).toBe(true);
  });

  it("shows only the active group's rows; switching tabs swaps which group is visible", () => {
    openTab(panel, "text");
    expect(group(panel, "text").hidden).toBe(false);
    expect(group(panel, "look").hidden).toBe(true);

    openTab(panel, "look");
    expect(panel.category).toBe("look");
    expect(group(panel, "look").hidden).toBe(false);
    expect(group(panel, "text").hidden).toBe(true);
    expect(pillTab(panel, "text").getAttribute("aria-selected")).toBe("false");
    expect(pillTab(panel, "look").getAttribute("aria-selected")).toBe("true");
  });

  it("the close button closes the popover", () => {
    openTab(panel, "text");
    (panel.shadowRoot!.querySelector(".close") as HTMLButtonElement).click();
    expect(panel.open).toBe(false);
    expect(panel.category).toBeNull();
  });

  it("Esc closes the popover", () => {
    openTab(panel, "text");
    const popover = panel.shadowRoot!.querySelector(".popover") as HTMLElement;
    popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(panel.open).toBe(false);
    expect((panel.shadowRoot!.querySelector(".popover") as HTMLElement).hidden).toBe(true);
  });

  it("showCategory(null) closes; toggle() flips open state", () => {
    panel.showCategory("axes");
    expect(panel.open).toBe(true);
    panel.showCategory(null);
    expect(panel.open).toBe(false);
    expect(panel.category).toBeNull();

    panel.showCategory("axes");
    panel.toggle();
    expect(panel.open).toBe(false);
    panel.toggle();
    expect(panel.open).toBe(true);
    expect(panel.category).toBe("axes");
  });
});

describe("primary vs more tiers", () => {
  it("keeps primary rows outside .rows.more and puts tier=more rows inside it", () => {
    const axesGroup = group(panel, "axes");
    const primary = axesGroup.querySelector(".rows.primary")!;
    const more = axesGroup.querySelector(".rows.more")!;
    expect(primary.querySelector('[data-control="grid"]')).not.toBeNull();
    expect(primary.querySelector('[data-control="box"]')).not.toBeNull();
    expect(primary.querySelector('[data-control="grid_alpha"]')).toBeNull();
    expect(more.querySelector('[data-control="grid_alpha"]')).not.toBeNull();
    expect(more.querySelector('[data-control="tick_direction"]')).not.toBeNull();
    expect(more.querySelector('[data-control="grid"]')).toBeNull();
  });

  it("has no .rows.more for Save, which has no tier=more controls", () => {
    const saveGroup = group(panel, "save");
    expect(saveGroup.querySelector(".rows.more")).toBeNull();
    expect(saveGroup.querySelector("button.more")).toBeNull();
  });

  it("shows subgroup headings only within .rows.more, for subgroups that have rows there", () => {
    const axesGroup = group(panel, "axes");
    const moreHeadings = Array.from(axesGroup.querySelectorAll(".rows.more .subhead")).map((h) => h.textContent);
    expect(moreHeadings).toContain("Grid");
    expect(moreHeadings).toContain("Box and axes lines");
    expect(moreHeadings).toContain("Tick marks");
    expect(axesGroup.querySelectorAll(".rows.primary .subhead").length).toBe(0);
  });

  it("the More button toggles text and visibility, and remembers open/closed per group", () => {
    openTab(panel, "axes");
    const axesGroup = group(panel, "axes");
    const moreBtn = axesGroup.querySelector("button.more") as HTMLButtonElement;
    const moreRows = axesGroup.querySelector(".rows.more") as HTMLElement;
    expect(moreBtn.textContent).toBe("More ▸");
    expect(moreRows.hidden).toBe(true);

    moreBtn.click();
    expect(moreBtn.textContent).toBe("More ▾");
    expect(moreRows.hidden).toBe(false);

    // Switch away and back: Axes remembers it was left open.
    openTab(panel, "text");
    openTab(panel, "axes");
    expect(moreRows.hidden).toBe(false);
    expect(moreBtn.textContent).toBe("More ▾");

    // Text's own More is independently closed.
    openTab(panel, "text");
    const textMoreRows = group(panel, "text").querySelector(".rows.more") as HTMLElement;
    expect(textMoreRows.hidden).toBe(true);
  });
});

describe("legend group visibility", () => {
  it("shows the legend tab before any refresh, and with no backend", () => {
    expect(pillTab(panel, "legend").hidden).toBe(false);
  });

  it("hides the legend tab after refresh finds no legend and nothing is set", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLegend(null);
    await attachBackend(panel, backend);
    expect(pillTab(panel, "legend").hidden).toBe(true);
  });

  it("keeps the legend tab shown (with a note) when a legend key is set despite no legend", async () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const backend = new MockBackend();
    backend.figure = figureWithLegend(null);
    await attachBackend(panel, backend);

    const frameon = input(panel, "legend_frameon") as HTMLInputElement;
    frameon.checked = false;
    change(frameon);

    expect(pillTab(panel, "legend").hidden).toBe(false);

    openTab(panel, "legend");
    const note = group(panel, "legend").querySelector(".note") as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("no legend");
  });

  it("shows the legend tab again once the figure is null", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLegend(null);
    await attachBackend(panel, backend);
    backend.figure = null;
    await panel.refresh();
    expect(pillTab(panel, "legend").hidden).toBe(false);
  });

  it("shows the legend tab when at least one axes has a legend", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLegend({ frameon: true, framealpha: 0.8, loc: "best", fontsize: 10 });
    await attachBackend(panel, backend);
    expect(pillTab(panel, "legend").hidden).toBe(false);
  });
});

describe("loading from a sink", () => {
  it("populates settings, the style select, inputs and is-set rows from a valid fence", () => {
    const settings: StyleSettings = { style: "ggplot", rc: { "font.size": 12, "axes.grid": true } };
    const block = generateBlock(settings)!;
    panel.sink = new MemorySink(block);

    expect(panel.getSettings()).toEqual(settings);
    expect((input(panel, "style") as HTMLSelectElement).value).toBe("ggplot");
    expect((input(panel, "font_size") as HTMLInputElement).value).toBe("12");
    expect((input(panel, "grid") as HTMLInputElement).checked).toBe(true);
    expect(ctl(panel, "font_size").classList.contains("is-set")).toBe(true);
    expect(ctl(panel, "grid").classList.contains("is-set")).toBe(true);
  });

  it("keeps its sink subscription across a disconnect and reconnect", () => {
    const sink = new MemorySink("print('hi')\n");
    panel.sink = sink;
    expect(panel.getBlock()).toBeNull();

    // WebAgg rebuilds the figure's whole DOM on every run, so a panel mounted
    // in that subtree gets moved routinely, and a move fires disconnected then
    // connected -- which is what drops the sink subscription. Do the two halves
    // explicitly rather than relying on a bare re-parent: the spec says moving
    // a node runs both callbacks, but leaning on that would make this test quietly
    // stop proving anything under a DOM implementation that skips them.
    // Assert the starting state too. Without this, a fixture change that left
    // the panel detached would make remove() a no-op and the test would still
    // pass -- proving nothing, which is the failure mode this test exists to
    // avoid in the first place.
    expect(panel.isConnected).toBe(true);

    const newHost = document.createElement("div");
    document.body.append(newHost);

    panel.remove();
    expect(panel.isConnected).toBe(false);
    newHost.append(panel);
    expect(panel.isConnected).toBe(true);

    const settings: StyleSettings = { style: "ggplot", rc: { "font.size": 12 } };
    sink.externalEdit(generateBlock(settings)!);

    expect(panel.getSettings()).toEqual(settings);
    newHost.remove();
  });

  it("keeps its sink subscription across a bare re-parent", () => {
    // The form the demo's mountPanel() actually uses: insert the same element
    // somewhere else without removing it first.
    const sink = new MemorySink("print('hi')\n");
    panel.sink = sink;

    // A move, not a first attachment: assert the panel already has a different
    // parent, or this silently becomes a plain append and exercises nothing.
    const oldHost = panel.parentElement;
    expect(oldHost).not.toBeNull();

    const newHost = document.createElement("div");
    document.body.append(newHost);
    expect(newHost).not.toBe(oldHost);
    newHost.append(panel);
    expect(panel.parentElement).toBe(newHost);

    const settings: StyleSettings = { style: "ggplot", rc: { "font.size": 14 } };
    sink.externalEdit(generateBlock(settings)!);

    expect(panel.getSettings()).toEqual(settings);
    newHost.remove();
  });

  it("gives default settings and an empty block for a source without a fence", () => {
    panel.sink = new MemorySink("print('hi')\n");
    expect(panel.getSettings()).toEqual(defaultSettings());
    expect(panel.getBlock()).toBeNull();
  });

  it("flags a fence with two start markers as an error, marks the pill, and blocks writes while it persists", () => {
    const src = [
      FENCE_START, FENCE_START, "import matplotlib as mpl",
      "mpl.rcParams.update({", '    "font.size": 12,', "})", "# --- end plot style ---",
      "print('kept')",
    ].join("\n");
    const sink = new MemorySink(src);
    panel.sink = sink;

    expect(panel.currentFenceError).toBeInstanceOf(FenceError);
    expect(panel.shadowRoot!.querySelector(".pill")!.classList.contains("error")).toBe(true);
    expect((panel.shadowRoot!.querySelector(".pill .err") as HTMLElement).hidden).toBe(false);

    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    expect(sink.writes.length).toBe(0);
    expect(panel.currentFenceError).toBeInstanceOf(FenceError);
  });

  it("shows the error banner (replacing the group's rows) inside the popover, with a working Replace block button", () => {
    const src = [
      FENCE_START, FENCE_START, "import matplotlib as mpl",
      "mpl.rcParams.update({", '    "font.size": 12,', "})", "# --- end plot style ---",
      "print('kept')",
    ].join("\n");
    const sink = new MemorySink(src);
    panel.sink = sink;
    openTab(panel, "text");

    const banner = panel.shadowRoot!.querySelector(".banner.error") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(group(panel, "text").hidden).toBe(true); // replaced by the banner

    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);
    expect(sink.writes.length).toBe(0); // still blocked

    const replaceButton = banner.querySelector("button") as HTMLButtonElement;
    replaceButton.click();

    expect(sink.writes.length).toBe(1);
    expect(panel.currentFenceError).toBeNull();
    expect(banner.hidden).toBe(true);
    expect(panel.shadowRoot!.querySelector(".pill")!.classList.contains("error")).toBe(false);
    const finalSrc = sink.writes[0]!;
    expect(finalSrc.split(FENCE_START).length - 1).toBe(1);
    expect(finalSrc).toContain("print('kept')");
    // The first change out of fully-default settings also seeds savefig.dpi (see "panelDefault seeding" below).
    expect(parseBlock(finalSrc)!.settings.rc).toEqual({ "axes.grid": true, ...SEEDED });
  });
});

describe("writing", () => {
  const userSrc = "import numpy as np\nimport matplotlib.pyplot as plt\n\nplt.plot([1, 2], [3, 4])\nplt.show()\n";

  it("writes the source once when changing font_size (range control), leaving user lines untouched", () => {
    const sink = new MemorySink(userSrc);
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    expect(fs.type).toBe("range");
    fs.value = "14";
    fireInput(fs);

    expect(sink.writes.length).toBe(1);
    const src1 = sink.writes[0]!;
    // The first change out of fully-default settings also seeds savefig.dpi (see "panelDefault seeding" below).
    expect(parseBlock(src1)!.settings.rc).toEqual({ "font.size": 14, ...SEEDED });
    expect(src1.endsWith(userSrc)).toBe(true);
    expect(ctl(panel, "font_size").querySelector(".readout")!.textContent).toBe("14");
  });

  it("replaces the fence on a second change; still exactly one fence", () => {
    const sink = new MemorySink(userSrc);
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);
    fs.value = "16";
    fireInput(fs);

    expect(sink.writes.length).toBe(2);
    const src2 = sink.writes[1]!;
    expect(src2.split(FENCE_START).length - 1).toBe(1);
    expect(parseBlock(src2)!.settings.rc).toEqual({ "font.size": 16, ...SEEDED });
  });

  it("reverting the only user-set key leaves the seeded defaults; reverting those too empties the fence", () => {
    const sink = new MemorySink(userSrc);
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);
    expect(panel.getSettings().rc).toEqual({ "font.size": 14, ...SEEDED });

    // One reset per category, in the popover header. Text holds font.size and
    // the seeded figure.autolayout; savefig.dpi is the Save category's.
    openTab(panel, "text");
    expect(groupReset(panel).hidden).toBe(false);
    groupReset(panel).click();
    expect(panel.getSettings().rc).toEqual({ "savefig.dpi": 300 });
    expect(sink.writes[sink.writes.length - 1]).toContain(FENCE_START);

    // The last category's keys have to go before the fence can be removed.
    openTab(panel, "save");
    groupReset(panel).click();

    const last = sink.writes[sink.writes.length - 1]!;
    expect(last).not.toContain(FENCE_START);
    expect(last).toContain("plt.show()");
    expect(panel.getSettings()).toEqual(defaultSettings());
  });

  it("Reset all (from the reset menu) clears every setting and removes the fence", () => {
    const sink = new MemorySink(userSrc);
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);
    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    openMenu(panel);
    menuItem(panel, "reset-all").click();

    expect(panel.getSettings()).toEqual(defaultSettings());
    const last = sink.writes[sink.writes.length - 1]!;
    expect(last).not.toContain(FENCE_START);
  });

  it("writes a segmented enum control as its string value, and shows a glyph label with the name in the title (linestyle --)", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const seg = ctl(panel, "linestyle").querySelector(".segmented") as HTMLElement;
    const btn = seg.querySelector('button[data-value="--"]') as HTMLButtonElement;
    expect(btn.textContent).toBe("– –");
    expect(btn.title).toBe("Dashed");
    btn.click();

    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["lines.linestyle"]).toBe("--");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("writes a bool control (switch) as a boolean", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const checkbox = input(panel, "savefig_transparent") as HTMLInputElement;
    expect(checkbox.classList.contains("switch")).toBe(true);
    checkbox.checked = true;
    change(checkbox);

    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["savefig.transparent"]).toBe(true);
    expect(ctl(panel, "savefig_transparent").title).toBe("Applies when the figure is saved, not on screen.");
  });

  it("dpi is a range (no number box, nothing to clear); reverting is the only way back to 'figure'", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const dpi = input(panel, "savefig_dpi") as HTMLInputElement;
    expect(dpi.type).toBe("range");
    dpi.value = "150";
    change(dpi);
    expect(panel.getSettings().rc["savefig.dpi"]).toBe(150);

    openTab(panel, "save");
    groupReset(panel).click();

    expect(panel.getSettings().rc["savefig.dpi"]).toBeUndefined();
  });

  it("writes the preset colors for a colorcycle preset button and renders one small swatch per color", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const list = ctl(panel, "prop_cycle").querySelector(".swatch-list") as HTMLElement;
    const btn = list.querySelector('button[data-preset="okabe-ito"]') as HTMLButtonElement;
    expect(btn.title).toBe("Colorblind-safe (Okabe–Ito)");
    btn.click();

    const expected = CONTROLS.find((c) => c.id === "prop_cycle")!.presets!.find((p) => p.id === "okabe-ito")!.colors;
    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["axes.prop_cycle"]).toEqual(expected);
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    const swatches = btn.querySelectorAll(".swatches i");
    expect(swatches.length).toBe(expected.length);
    expect(Array.from(swatches).map((s) => (s as HTMLElement).title)).toEqual(expected);
    expect(list.title).toBe("");
  });

  it("marks the swatch list as custom (no preset pressed, title set) for colors matching no preset", () => {
    const settings: StyleSettings = { style: "default", rc: { "axes.prop_cycle": ["#111111", "#222222"] } };
    panel.sink = new MemorySink(generateBlock(settings)!);
    const list = ctl(panel, "prop_cycle").querySelector(".swatch-list") as HTMLElement;
    expect(Array.from(list.querySelectorAll("button.preset")).every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(list.title).toBe("Custom colors (from your file)");
  });

  it("writes both tick_direction keys from one segmented control", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const seg = ctl(panel, "tick_direction").querySelector(".segmented") as HTMLElement;
    const btn = seg.querySelector('button[data-value="in"]') as HTMLButtonElement;
    btn.click();

    const last = sink.writes[sink.writes.length - 1]!;
    const rc = parseBlock(last)!.settings.rc;
    expect(rc["xtick.direction"]).toBe("in");
    expect(rc["ytick.direction"]).toBe("in");
  });

  it("linewidth is a single range input (no separate number box) with a readout, committing on 'input'", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const row = ctl(panel, "linewidth");
    const range = input(panel, "linewidth") as HTMLInputElement;
    expect(range.type).toBe("range");
    expect(row.querySelectorAll('input[type="number"]').length).toBe(0);

    range.value = "3";
    fireInput(range);

    expect(row.querySelector(".readout")!.textContent).toBe("3");
    expect(panel.getSettings().rc["lines.linewidth"]).toBe(3);
  });
});

describe("legend position", () => {
  // The x slider keeps id="ctl-legend_loc" (see docs/ux-design.md, "Round
  // five"), so `input(panel, "legend_loc")` finds it directly.
  function xRangeEl(p: PlotpolishPanel): HTMLInputElement {
    return input(p, "legend_loc") as HTMLInputElement;
  }
  function yRangeEl(p: PlotpolishPanel): HTMLInputElement {
    return ctl(p, "legend_loc").querySelector('input[aria-label="Legend y"]') as HTMLInputElement;
  }
  function snapSelect(p: PlotpolishPanel): HTMLSelectElement {
    return ctl(p, "legend_loc").querySelector("select.snap") as HTMLSelectElement;
  }

  it("shows x and y sliders with readouts by default, plus a 'Snap to' select", () => {
    const xRange = xRangeEl(panel);
    const yRange = yRangeEl(panel);
    expect(xRange.type).toBe("range");
    expect(xRange.min).toBe("0");
    expect(xRange.max).toBe("1");
    expect(xRange.step).toBe("0.01");
    expect(xRange.getAttribute("aria-label")).toBe("Legend x");
    expect(yRange.type).toBe("range");
    expect(yRange.getAttribute("aria-label")).toBe("Legend y");
    expect(ctl(panel, "legend_loc").querySelectorAll(".readout").length).toBe(2);
    expect(snapSelect(panel)).not.toBeNull();
  });

  it("falls back to a named location's representative corner when there is no figure", () => {
    // Default value is "best", which falls back to the same corner as "upper right".
    expect(xRangeEl(panel).value).toBe("0.75");
    expect(yRangeEl(panel).value).toBe("0.75");
    expect(snapSelect(panel).value).toBe("best");
  });

  it("seeds the sliders from the live figure's legend xy for a named value", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLegend({ frameon: true, framealpha: 0.8, loc: "best", fontsize: 10, xy: [0.62, 0.18] });
    await attachBackend(panel, backend);

    expect(xRangeEl(panel).value).toBe("0.62");
    expect(yRangeEl(panel).value).toBe("0.18");
    const readouts = ctl(panel, "legend_loc").querySelectorAll(".readout");
    expect(readouts[0]!.textContent).toBe("0.62");
    expect(readouts[1]!.textContent).toBe("0.18");
    expect(snapSelect(panel).value).toBe("best");
  });

  it("moving the x slider writes [x, y] as numbers", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const xRange = xRangeEl(panel);
    xRange.value = "0.3";
    fireInput(xRange);

    expect(panel.getSettings().rc["legend.loc"]).toEqual([0.3, 0.75]);
  });

  it("the snap select shows 'Custom' for an array value, and the name for a string", () => {
    panel.sink = new MemorySink(generateBlock({ style: "default", rc: { "legend.loc": [0.4, 0.5] } })!);
    expect(snapSelect(panel).value).toBe("__custom__");

    panel.sink = new MemorySink(generateBlock({ style: "default", rc: { "legend.loc": "lower left" } })!);
    expect(snapSelect(panel).value).toBe("lower left");
  });

  it("choosing a named location writes the string and re-introspects once, so the sliders follow the resulting position after settle()", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    const introspectsBefore = backend.calls.filter((c) => c.fn === "introspect_figure").length;

    const select = snapSelect(panel);
    select.value = "upper left";
    change(select);
    // Where the mock reports the legend landed, as of the extra
    // introspect_figure call the panel makes once apply_live resolves.
    backend.figure = figureWithLegend({ frameon: true, framealpha: 0.8, loc: "upper left", fontsize: 10, xy: [0.05, 0.75] });
    await panel.settle();

    expect(panel.getSettings().rc["legend.loc"]).toBe("upper left");
    const introspectsAfter = backend.calls.filter((c) => c.fn === "introspect_figure").length;
    expect(introspectsAfter).toBe(introspectsBefore + 1);
    expect(xRangeEl(panel).value).toBe("0.05");
    expect(yRangeEl(panel).value).toBe("0.75");
  });
});

describe("rerun indicators", () => {
  it("shows a ↻ badge on the control and on its tab only once the change is pending, not always", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);

    // font_family is live now: no ↻ anywhere, and apply_live carries it.
    expect(ctl(panel, "font_family").querySelector(".badge.rerun")).toBeNull();
    expect(tabRerun(panel, "text").hidden).toBe(true);

    const seg = ctl(panel, "font_family").querySelector(".segmented") as HTMLElement;
    const serifBtn = seg.querySelector('button[data-value="serif"]') as HTMLButtonElement;
    serifBtn.click();
    await panel.settle();

    expect(ctl(panel, "font_family").querySelector(".badge.rerun")).toBeNull();
    expect(tabRerun(panel, "text").hidden).toBe(true);
    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    expect(calls.length).toBe(1);
    expect((calls[0]!.args as { rc: Record<string, unknown> }).rc["font.family"]).toBe("serif");

    // The style control remains the one re-run-only knob.
    const style = ctl(panel, "style").querySelector("select") as HTMLSelectElement;
    style.value = "ggplot";
    style.dispatchEvent(new Event("change"));
    expect(tabRerun(panel, "look").hidden).toBe(false);
    await panel.refresh();
    expect(tabRerun(panel, "look").hidden).toBe(true);
  });

  it("clears the ↻ marks on refresh even when no backend is attached", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);

    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);
    expect(tabRerun(panel, "look").hidden).toBe(false);

    // A host may hand the panel a runtime it cannot introspect -- Trinket's
    // worker path attaches no backend at all. Dropping the backend does not
    // refresh on its own, so the marks are still up here.
    panel.backend = null;
    expect(tabRerun(panel, "look").hidden).toBe(false);

    // refresh() is what the host calls after a run completes, and a completed
    // run is exactly what makes a pending re-run no longer pending. Without a
    // backend there is nothing to introspect, but the marks must still clear
    // or they stay on the tab permanently.
    await panel.refresh();
    expect(tabRerun(panel, "look").hidden).toBe(true);
  });

  it("with no backend, an ordinary change is marked pending a re-run", async () => {
    // Trinket's Web Worker path attaches no backend: the program runs off the
    // main thread, so there is nothing here to preview against. Every change is
    // therefore "re-run to see", not just the style preset -- without this the
    // student changes a setting, the figure does not move, and nothing says why.
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    panel.backend = null;

    expect(tabRerun(panel, "text").hidden).toBe(true);

    const size = input(panel, "font_size") as HTMLInputElement;
    size.value = "16";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    change(size);

    expect(tabRerun(panel, "text").hidden).toBe(false);
    expect(ctl(panel, "font_size").querySelector(".badge.rerun")).not.toBeNull();

    // And a completed run clears it, with still no backend attached.
    await panel.refresh();
    expect(tabRerun(panel, "text").hidden).toBe(true);
  });

  it("with no backend, Reset all marks the reverted keys pending a re-run", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);

    const size = input(panel, "font_size") as HTMLInputElement;
    size.value = "16";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    change(size);
    await panel.settle();
    await panel.refresh();
    expect(tabRerun(panel, "text").hidden).toBe(true);

    // The host drops to a runtime it cannot introspect, then the student resets.
    panel.backend = null;
    panel.reset();

    // The block is empty now, but the figure still carries what the last run
    // drew, so the revert is pending a re-run just as a change would be.
    expect(tabRerun(panel, "text").hidden).toBe(false);
    await panel.refresh();
    expect(tabRerun(panel, "text").hidden).toBe(true);
  });

  it("with no backend, resetting a style AND rc keys marks both, not just the style", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);

    // A non-default style plus a Look rc key, so the reset has both to undo.
    const style = input(panel, "style") as HTMLSelectElement;
    style.value = "ggplot";
    change(style);
    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);
    await panel.settle();
    await panel.refresh();
    expect(tabRerun(panel, "look").hidden).toBe(true);

    panel.backend = null;
    panel.reset();

    // The style is pending, and so is the reverted grid key. Marking only the
    // style would leave the reverted control with no indicator at all.
    expect(tabRerun(panel, "look").hidden).toBe(false);
    expect(ctl(panel, "grid").querySelector(".badge.rerun")).not.toBeNull();
  });

  it("with no backend, resetting one category marks that category pending", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);

    const size = input(panel, "font_size") as HTMLInputElement;
    size.value = "16";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    change(size);
    await panel.settle();
    await panel.refresh();

    // The Reset <Category> item only appears for the *active* category.
    panel.backend = null;
    openTab(panel, "text");
    openMenu(panel);
    const item = menuItem(panel, "reset-category");
    expect(item.hidden).toBe(false);
    item.click();

    expect(tabRerun(panel, "text").hidden).toBe(false);
  });

  it("with a backend and live preview, an ordinary change is applied, not marked", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);

    const size = input(panel, "font_size") as HTMLInputElement;
    size.value = "16";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    change(size);
    await panel.settle();

    expect(tabRerun(panel, "text").hidden).toBe(true);
    expect(backend.calls.filter((c) => c.fn === "apply_live").length).toBeGreaterThan(0);
  });

  it("a style change shows ↻ on the Look tab and on the style control", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    expect(tabRerun(panel, "look").hidden).toBe(true);

    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);

    expect(tabRerun(panel, "look").hidden).toBe(false);
    expect(ctl(panel, "style").querySelector(".badge.rerun")).not.toBeNull();
  });
});

describe("style preset needs a run", () => {
  it("shows a muted note under the preset that turns .pending while the change is unapplied, cleared by refresh()", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    const note = ctl(panel, "style").querySelector("p.next-run") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toBe("Applies on the next run.");
    expect(note.classList.contains("pending")).toBe(false);

    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);
    expect(note.classList.contains("pending")).toBe(true);

    await panel.refresh();
    expect(note.classList.contains("pending")).toBe(false);
  });
});

describe("change dot on tabs", () => {
  it("shows a dot on a tab once a control in its group is set", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    expect(tabDot(panel, "text").hidden).toBe(true);

    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);

    expect(tabDot(panel, "text").hidden).toBe(false);
  });

  it("shows a dot on Look for a non-default style", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    expect(tabDot(panel, "look").hidden).toBe(true);
    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);
    expect(tabDot(panel, "look").hidden).toBe(false);
  });
});

describe("reset menu", () => {
  it("Reset <Category> is hidden until the active category has changes, then clears only that group's keys", () => {
    const sink = new MemorySink("");
    panel.sink = sink;

    openTab(panel, "text");
    openMenu(panel);
    expect(menuItem(panel, "reset-category").hidden).toBe(true);

    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "3";
    fireInput(lw);

    openMenu(panel);
    const item = menuItem(panel, "reset-category");
    expect(item.hidden).toBe(false);
    expect(item.textContent).toBe("Reset Text");
    item.click();

    expect(panel.getSettings().rc["font.size"]).toBeUndefined();
    expect(panel.getSettings().rc["lines.linewidth"]).toBe(3);
  });

  it("Reset Look also resets the style preset", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);

    openTab(panel, "look");
    openMenu(panel);
    menuItem(panel, "reset-category").click();

    expect(panel.getSettings().style).toBe("default");
  });

  it("Reset all is disabled when settings are default, enabled once something is set", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    openMenu(panel);
    expect(menuItem(panel, "reset-all").disabled).toBe(true);

    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    openMenu(panel);
    expect(menuItem(panel, "reset-all").disabled).toBe(false);
  });

  it("Show code toggles the generated block into view inside the menu", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    openMenu(panel);
    const pre = panel.shadowRoot!.querySelector("pre.code") as HTMLElement;
    expect(pre.hidden).toBe(true);
    expect(pre.textContent).toBe("# (no block: every setting is at its default)");

    menuItem(panel, "show-code").click();
    expect(pre.hidden).toBe(false);

    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);
    expect(pre.textContent).toContain("axes.grid");

    menuItem(panel, "show-code").click();
    expect(pre.hidden).toBe(true);
  });

  it("hides the 'Show code' item entirely when features.showCode is false", () => {
    panel.features = { showCode: false };
    openMenu(panel);
    expect(menuItem(panel, "show-code").hidden).toBe(true);
  });

  it("only shows tabs for groups listed in features.groups", () => {
    panel.features = { groups: ["text"] };
    for (const g of GROUPS) expect(pillTab(panel, g.id).hidden).toBe(g.id !== "text");
  });
});

describe("draggable popover", () => {
  it("dragging the header by pointer events moves the popover and hides the caret", () => {
    openTab(panel, "text");
    const popover = panel.shadowRoot!.querySelector(".popover") as HTMLElement;
    const caret = panel.shadowRoot!.querySelector(".caret") as HTMLElement;
    const header = panel.shadowRoot!.querySelector(".pop-head") as HTMLElement;
    expect(caret.hidden).toBe(false);

    header.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 100, clientY: 100, pointerId: 1 }));
    header.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 140, clientY: 130, pointerId: 1 }));
    header.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 140, clientY: 130, pointerId: 1 }));

    expect(popover.style.left).not.toBe("");
    expect(popover.style.top).not.toBe("");
    expect(caret.hidden).toBe(true);

    const leftAfterDrag = popover.style.left;
    const topAfterDrag = popover.style.top;

    // Switching tabs swaps content in place: position is unchanged.
    openTab(panel, "look");
    expect(popover.style.left).toBe(leftAfterDrag);
    expect(popover.style.top).toBe(topAfterDrag);
    expect(caret.hidden).toBe(true);
    expect(group(panel, "look").hidden).toBe(false);
    expect(group(panel, "text").hidden).toBe(true);

    // Re-anchor via the ⌖ button restores the caret.
    (panel.shadowRoot!.querySelector(".reanchor") as HTMLButtonElement).click();
    expect(caret.hidden).toBe(false);
    expect(popover.classList.contains("dragging")).toBe(false);
  });

  it("double-clicking the header also re-anchors", () => {
    openTab(panel, "text");
    const header = panel.shadowRoot!.querySelector(".pop-head") as HTMLElement;
    const caret = panel.shadowRoot!.querySelector(".caret") as HTMLElement;

    header.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1 }));
    header.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 50, clientY: 50, pointerId: 1 }));
    header.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 50, clientY: 50, pointerId: 1 }));
    expect(caret.hidden).toBe(true);

    header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(caret.hidden).toBe(false);
  });

  it("a pointerdown on the ✕ button does not start a drag, and the click still closes", () => {
    openTab(panel, "text");
    const popover = panel.shadowRoot!.querySelector(".popover") as HTMLElement;
    const closeBtn = panel.shadowRoot!.querySelector(".close") as HTMLButtonElement;
    const leftBefore = popover.style.left; // already anchored by positionPopover() when the tab opened

    closeBtn.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { clientX: 10, clientY: 10, pointerId: 1 }));
    closeBtn.dispatchEvent(Object.assign(new Event("pointermove", { bubbles: true }), { clientX: 60, clientY: 60, pointerId: 1 }));
    expect(popover.classList.contains("dragging")).toBe(false);
    expect(popover.style.left).toBe(leftBefore);

    closeBtn.click();
    expect(panel.open).toBe(false);
  });

  it("a move under the 4px threshold does not start a drag; a bigger move does", () => {
    openTab(panel, "text");
    const popover = panel.shadowRoot!.querySelector(".popover") as HTMLElement;
    const caret = panel.shadowRoot!.querySelector(".caret") as HTMLElement;
    const header = panel.shadowRoot!.querySelector(".pop-head") as HTMLElement;
    const leftBefore = popover.style.left; // already anchored by positionPopover() when the tab opened

    header.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1 }));
    header.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 3, clientY: 0, pointerId: 1 }));
    expect(popover.style.left).toBe(leftBefore);
    expect(popover.classList.contains("dragging")).toBe(false);
    expect(caret.hidden).toBe(false);

    header.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 10, clientY: 0, pointerId: 1 }));
    expect(popover.style.left).not.toBe(leftBefore);
    expect(popover.classList.contains("dragging")).toBe(true);
    expect(caret.hidden).toBe(true);

    header.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 10, clientY: 0, pointerId: 1 }));
    expect(popover.classList.contains("dragging")).toBe(false);
  });

  it("shows a grip glyph and a 'Drag to move' title on the header", () => {
    openTab(panel, "text");
    const header = panel.shadowRoot!.querySelector(".pop-head") as HTMLElement;
    expect(header.title).toBe("Drag to move");
    expect(header.querySelector(".grip")).not.toBeNull();
  });
});

describe("draggable pill", () => {
  function pill(p: PlotpolishPanel): HTMLElement {
    return p.shadowRoot!.querySelector(".pill") as HTMLElement;
  }
  function pillGrip(p: PlotpolishPanel): HTMLElement {
    return p.shadowRoot!.querySelector(".pill .grip") as HTMLElement;
  }

  it("shows a grip glyph at the left of the pill, whose title names both of its jobs", () => {
    const grip = pillGrip(panel);
    expect(grip).not.toBeNull();
    // The grip drags the pill and, on a click that never becomes a drag,
    // collapses it. A title naming only one of those hides the other.
    expect(grip.title).toBe("Drag to move, click to tuck away");
    expect(pill(panel).firstElementChild).toBe(grip);
  });

  it("a click on the grip collapses the pill to the grip alone, and again expands it", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    openTab(panel, "text");
    const grip = pillGrip(panel);
    const popover = panel.shadowRoot!.querySelector(".popover") as HTMLElement;
    expect(popover.hidden).toBe(false);

    // Press and release without clearing the drag threshold: a click.
    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 10, clientY: 10, pointerId: 1, buttons: 0 }));

    expect(pill(panel).classList.contains("collapsed")).toBe(true);
    // The open window stays open. Tucking the strip away is for reclaiming the
    // figure's corner, not for putting your work away -- closing it lost the
    // student's place every time. The caret goes, because the tab it pointed
    // at has folded up.
    expect(popover.hidden).toBe(false);
    expect(panel.category).toBe("text");
    expect((panel.shadowRoot!.querySelector(".caret") as HTMLElement).hidden).toBe(true);

    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 10, clientY: 10, pointerId: 1, buttons: 0 }));
    expect(pill(panel).classList.contains("collapsed")).toBe(false);
    expect(popover.hidden).toBe(false);
    expect((panel.shadowRoot!.querySelector(".caret") as HTMLElement).hidden).toBe(false);
  });

  it("folds the strip to a measured width rather than hiding it outright", async () => {
    // The fold animates an inline max-width, because the width to animate to is
    // a number CSS cannot know (and an inline value outranks any rule, so the
    // stylesheet could not own the other end either).
    //
    // What this does NOT cover, because happy-dom has no compositor: that the
    // end state is reached without a frame ever being painted. Staging the
    // second write on requestAnimationFrame passes this test and still leaves a
    // collapse begun just before the student switched tabs stuck half open, so
    // foldPillBody() writes both values synchronously on purpose. Its comment
    // is the guard there, not this test.
    const body = panel.shadowRoot!.querySelector(".pill-body") as HTMLElement;
    const grip = pillGrip(panel);
    const click = () => {
      grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 }));
      grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 10, clientY: 10, pointerId: 1, buttons: 0 }));
    };
    expect(body).not.toBeNull();

    click();
    expect(pill(panel).classList.contains("collapsed")).toBe(true);
    expect(body.style.maxWidth).toBe("0px");

    // ...and once the fold has finished, the strip is out of layout entirely,
    // so a folded tab is not merely invisible but unfocusable and unread.
    await new Promise((r) => setTimeout(r, 200));
    expect(body.hidden).toBe(true);

    click();
    expect(pill(panel).classList.contains("collapsed")).toBe(false);
    expect(body.hidden).toBe(false);
    // Back to a width, not to zero and not to "none": a measured target.
    expect(body.style.maxWidth).toMatch(/^\d+px$/);
  });

  it("a drag of the grip moves the pill without collapsing it", () => {
    const grip = pillGrip(panel);
    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 40, clientY: 30, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 40, clientY: 30, pointerId: 1, buttons: 0 }));

    expect(pill(panel).classList.contains("dragging")).toBe(false);
    expect(pill(panel).classList.contains("collapsed")).toBe(false);
    expect(pill(panel).style.left).not.toBe("");
  });

  it("collapsing tucks the pill back into the corner, and expanding restores where it was dragged to", () => {
    const grip = pillGrip(panel);
    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 60, clientY: 40, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 60, clientY: 40, pointerId: 1, buttons: 0 }));
    const dragged = pill(panel).style.left;
    expect(dragged).not.toBe("");

    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 60, clientY: 40, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 60, clientY: 40, pointerId: 1, buttons: 0 }));
    expect(pill(panel).classList.contains("collapsed")).toBe(true);

    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 60, clientY: 40, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 60, clientY: 40, pointerId: 1, buttons: 0 }));
    expect(pill(panel).style.left).toBe(dragged);
  });

  it("a pointerdown on a tab button does not start a drag", () => {
    const tab = pillTab(panel, "text");
    const before = pill(panel).style.left;

    tab.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { clientX: 10, clientY: 10, pointerId: 1 }));
    tab.dispatchEvent(Object.assign(new Event("pointermove", { bubbles: true }), { clientX: 60, clientY: 60, pointerId: 1 }));

    expect(pill(panel).classList.contains("dragging")).toBe(false);
    expect(pill(panel).style.left).toBe(before);
    // The tab itself still works normally.
    tab.click();
    expect(panel.category).toBe("text");
  });

  it("a hover after a release that missed the grip does not resume the drag", () => {
    const grip = pillGrip(panel);
    const before = pill(panel).style.left;

    // Press the grip, then release somewhere the grip never sees -- the common
    // case when a drag ends outside the pill, or the pointer leaves the window.
    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 }));
    document.body.dispatchEvent(
      Object.assign(new Event("pointerup", { bubbles: true }), { clientX: 200, clientY: 200, pointerId: 1, buttons: 0 })
    );

    // Now merely move over the grip with no button held. This must do nothing:
    // before the fix the stale start made it silently grab and drag the pill.
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 90, clientY: 90, pointerId: 1, buttons: 0 }));

    expect(pill(panel).classList.contains("dragging")).toBe(false);
    expect(pill(panel).style.left).toBe(before);
  });

  it("pointercancel ends a drag, and a later hover does not resume it", () => {
    const grip = pillGrip(panel);

    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 30, clientY: 20, pointerId: 1, buttons: 1 }));
    expect(pill(panel).classList.contains("dragging")).toBe(true);
    const moved = pill(panel).style.left;

    // A canceled gesture never sends pointerup.
    grip.dispatchEvent(Object.assign(new Event("pointercancel"), { clientX: 30, clientY: 20, pointerId: 1, buttons: 0 }));
    expect(pill(panel).classList.contains("dragging")).toBe(false);

    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 300, clientY: 300, pointerId: 1, buttons: 0 }));
    expect(pill(panel).style.left).toBe(moved);
  });

  it("a held drag still moves the pill in both directions", () => {
    const grip = pillGrip(panel);
    const px = () => parseFloat(pill(panel).style.left || "0");

    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 100, clientY: 100, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 160, clientY: 100, pointerId: 1, buttons: 1 }));
    const right = px();
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 40, clientY: 100, pointerId: 1, buttons: 1 }));
    const left = px();

    expect(left).toBeLessThan(right);
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 40, clientY: 100, pointerId: 1, buttons: 0 }));
    expect(pill(panel).classList.contains("dragging")).toBe(false);
  });

  it("a second pointer ending does not cancel a drag in progress", () => {
    const grip = pillGrip(panel);

    // Pointer 1 is dragging the pill.
    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 30, clientY: 20, pointerId: 1, buttons: 1 }));
    expect(pill(panel).classList.contains("dragging")).toBe(true);
    const during = pill(panel).style.left;

    // An unrelated pointer 2 ends somewhere on the page -- a second finger
    // lifting, or a stylus. The window-level safety net must ignore it.
    window.dispatchEvent(
      Object.assign(new Event("pointerup", { bubbles: true }), { clientX: 500, clientY: 500, pointerId: 2, buttons: 0 })
    );
    expect(pill(panel).classList.contains("dragging")).toBe(true);

    // Pointer 1 keeps dragging normally.
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 80, clientY: 20, pointerId: 1, buttons: 1 }));
    expect(pill(panel).style.left).not.toBe(during);

    // And its own release still ends it.
    window.dispatchEvent(
      Object.assign(new Event("pointerup", { bubbles: true }), { clientX: 80, clientY: 20, pointerId: 1, buttons: 0 })
    );
    expect(pill(panel).classList.contains("dragging")).toBe(false);
  });

  it("a move under 4px does not start a drag; a grip drag of >= 4px sets inline left/top and '.dragging'", () => {
    const grip = pillGrip(panel);

    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 2, clientY: 0, pointerId: 1 }));
    expect(pill(panel).classList.contains("dragging")).toBe(false);

    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 30, clientY: 20, pointerId: 1 }));
    expect(pill(panel).classList.contains("dragging")).toBe(true);
    expect(pill(panel).style.left).not.toBe("");
    expect(pill(panel).style.top).not.toBe("");

    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 30, clientY: 20, pointerId: 1 }));
    expect(pill(panel).classList.contains("dragging")).toBe(false);
    // The dragged position sticks after pointerup.
    expect(pill(panel).style.left).not.toBe("");
  });

  it("double-clicking the grip clears the dragged position and re-anchors", () => {
    const grip = pillGrip(panel);
    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 50, clientY: 50, pointerId: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 50, clientY: 50, pointerId: 1 }));
    expect(pill(panel).style.left).not.toBe("");

    grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(pill(panel).style.left).toBe("");
    expect(pill(panel).classList.contains("dragging")).toBe(false);
  });

  it("re-anchors the open popover to its tab after the pill moves, unless the popover itself was dragged", () => {
    const tab = pillTab(panel, "text");
    const rectA = { top: 40, left: 40, right: 100, bottom: 62, width: 60, height: 22, x: 40, y: 40, toJSON: () => ({}) } as DOMRect;
    tab.getBoundingClientRect = () => rectA;
    openTab(panel, "text");
    const popover = panel.shadowRoot!.querySelector(".popover") as HTMLElement;
    const leftBefore = popover.style.left;

    // Simulate the tab moving along with the dragged pill.
    const rectB = { top: 200, left: 300, right: 360, bottom: 222, width: 60, height: 22, x: 300, y: 200, toJSON: () => ({}) } as DOMRect;
    tab.getBoundingClientRect = () => rectB;

    const grip = pillGrip(panel);
    grip.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 0, clientY: 0, pointerId: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 120, clientY: 40, pointerId: 1 }));
    grip.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 120, clientY: 40, pointerId: 1 }));

    expect(popover.style.left).not.toBe(leftBefore);
  });
});

describe("layout: pill / rail / float", () => {
  it("renders the pill by default and keeps the rail hidden", () => {
    expect((panel.shadowRoot!.querySelector(".pill") as HTMLElement).hidden).toBe(false);
    expect((panel.shadowRoot!.querySelector(".rail") as HTMLElement).hidden).toBe(true);
    expect(panel.layout).toBe("pill");
  });

  it("falls back to 'pill' when figureElement is null", () => {
    panel.figureElement = null;
    expect(panel.layout).toBe("pill");
    expect((panel.shadowRoot!.querySelector(".pill") as HTMLElement).classList.contains("float")).toBe(false);
  });

  it("chooses 'float' automatically once figureElement is set and has a real size", () => {
    // happy-dom's getBoundingClientRect() is always zero-size, so give the
    // figure element a real rect to exercise the auto-detection itself.
    const fig = document.createElement("div");
    document.body.append(fig);
    fig.getBoundingClientRect = () =>
      ({ top: 40, left: 10, right: 410, bottom: 340, width: 400, height: 300, x: 10, y: 40, toJSON() {} }) as DOMRect;
    try {
      panel.figureElement = fig;
      expect(panel.layout).toBe("float");
      expect((panel.shadowRoot!.querySelector(".pill") as HTMLElement).classList.contains("float")).toBe(true);
      expect((panel.shadowRoot!.querySelector(".pill") as HTMLElement).hidden).toBe(false);
    } finally {
      fig.remove();
    }
  });

  it("the explicit layout='float' attribute path renders .pill with the float class and fixed positioning styles", () => {
    panel.setAttribute("layout", "float");
    expect(panel.layout).toBe("float");
    const pill = panel.shadowRoot!.querySelector(".pill") as HTMLElement;
    expect(pill.hidden).toBe(false);
    expect(pill.classList.contains("float")).toBe(true);
    expect(pill.style.top).not.toBe("");
    expect(pill.style.right).not.toBe("");
  });

  it("forcing layout='rail' renders the rail with one tab per visible group, and hides the pill", () => {
    panel.setAttribute("layout", "rail");
    expect(panel.layout).toBe("rail");
    expect((panel.shadowRoot!.querySelector(".rail") as HTMLElement).hidden).toBe(false);
    expect((panel.shadowRoot!.querySelector(".pill") as HTMLElement).hidden).toBe(true);
    const tabs = Array.from(panel.shadowRoot!.querySelectorAll(".rail button.tab")) as HTMLElement[];
    expect(tabs.map((t) => t.dataset.group)).toEqual(GROUPS.map((g) => g.id));

    railTab(panel, "text").click();
    expect(panel.category).toBe("text");
  });

  it("setting the layout property forces the mode and reflects the attribute", () => {
    panel.layout = "rail";
    expect(panel.getAttribute("layout")).toBe("rail");
    panel.layout = "float";
    expect(panel.getAttribute("layout")).toBe("float");
    panel.layout = "pill";
    expect(panel.getAttribute("layout")).toBe("pill");
  });
});

describe("backend", () => {
  let backend: MockBackend;

  beforeEach(() => {
    backend = new MockBackend();
  });

  it("lists mock styles with default first after refresh", async () => {
    await attachBackend(panel, backend);
    const select = input(panel, "style") as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => o.value);
    expect(opts[0]).toBe("default");
    expect(opts).toEqual(["default", "dark_background", "ggplot", "seaborn-v0_8-whitegrid"]);
  });

  it("follows the backend's rc for the baseline while settings stay empty", async () => {
    backend.rc["lines.linewidth"] = 2.5;
    await attachBackend(panel, backend);
    expect((input(panel, "linewidth") as HTMLInputElement).value).toBe("2.5");
    expect(panel.getSettings().rc).toEqual({});
  });

  it("mentions Live preview in the pill's tooltip once ready", async () => {
    await attachBackend(panel, backend);
    expect(panel.shadowRoot!.querySelector(".pill")!.getAttribute("title")).toContain("Live preview");
  });

  it("shows a user-override badge (a small dot) for keys the mock reports as overridden", async () => {
    backend.overridden = ["axes.grid"];
    await attachBackend(panel, backend);
    const badge = ctl(panel, "grid").querySelector(".badge.user");
    expect(badge).not.toBeNull();
    expect((badge as HTMLElement).title).toContain("Your code sets this");
  });

  it("produces exactly one apply_live call after changing a live control, once settled", async () => {
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "3";
    fireInput(lw);
    await panel.settle();

    // The first change out of fully-default settings coalesces with the seeded panelDefaults into the same call.
    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toEqual({
      rc: { "lines.linewidth": 3, ...SEEDED },
      only_defaults: true,
      previous: { "lines.linewidth": 1.5, ...SEEDED_BEFORE },
    });
  });

  it("coalesces two rapid changes to different controls into one apply_live call", async () => {
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    const ms = input(panel, "markersize") as HTMLInputElement;
    lw.value = "4";
    fireInput(lw);
    ms.value = "10";
    fireInput(ms);
    await panel.settle();

    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toEqual({
      rc: { "lines.linewidth": 4, "lines.markersize": 10, ...SEEDED },
      only_defaults: true,
      previous: { "lines.linewidth": 1.5, "lines.markersize": 6, ...SEEDED_BEFORE },
    });
  });

  it("live-applies the seeded savefig.dpi together with the triggering live control", async () => {
    await attachBackend(panel, backend);

    const seg = ctl(panel, "font_family").querySelector(".segmented") as HTMLElement;
    const serifBtn = seg.querySelector('button[data-value="serif"]') as HTMLButtonElement;
    serifBtn.click();
    await panel.settle();

    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    expect(calls.length).toBe(1);
    const rc = (calls[0]!.args as { rc: Record<string, unknown> }).rc;
    expect(rc["font.family"]).toBe("serif");
    expect(rc["savefig.dpi"]).toBe(300);
  });

  it("set_style passes hostRcKeys, updates the baseline, dispatches rerun-needed, and stays stale until refresh", async () => {
    backend.overridden = ["axes.grid"];
    await attachBackend(panel, backend);
    panel.hostRcKeys = ["figure.autolayout"];
    const events: RerunNeededEventDetail[] = [];
    panel.addEventListener("plotpolish-rerun-needed", (e) => events.push((e as CustomEvent<RerunNeededEventDetail>).detail));

    const styleSelect = input(panel, "style") as HTMLSelectElement;
    styleSelect.value = "ggplot";
    change(styleSelect);

    // Stale immediately: the user-override badge hides even though it was set before the change.
    expect(ctl(panel, "grid").querySelector(".badge.user")).toBeNull();

    await flush();
    const setStyleCall = backend.calls.find((c) => c.fn === "set_style");
    expect(setStyleCall!.args).toEqual({ name: "ggplot", keep: ["figure.autolayout"] });
    expect((input(panel, "grid") as HTMLInputElement).checked).toBe(true);
    // The style change is itself a default -> non-default transition, so it also seeds savefig.dpi.
    expect(panel.getSettings().rc).toEqual({ ...SEEDED });
    expect(events.some((e) => e.keys.includes("style") && e.style === "ggplot")).toBe(true);

    // Still stale after the style call resolves; only refresh() clears it.
    expect(ctl(panel, "grid").querySelector(".badge.user")).toBeNull();
    await panel.refresh();
    expect(ctl(panel, "grid").querySelector(".badge.user")).not.toBeNull();
  });

  it("re-applies existing rc overrides on top of the new style", async () => {
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "5";
    fireInput(lw);
    await panel.settle();
    expect(backend.calls.filter((c) => c.fn === "apply_live").length).toBe(1);

    const styleSelect = input(panel, "style") as HTMLSelectElement;
    styleSelect.value = "ggplot";
    change(styleSelect);
    await flush();
    await panel.settle();

    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    expect(calls.length).toBe(2);
    // The first apply_live already carried the seeded savefig.dpi; the style change re-applies both.
    expect(calls[1]!.args).toEqual({
      rc: { "lines.linewidth": 5, ...SEEDED },
      only_defaults: true,
      previous: { "lines.linewidth": 5, ...SEEDED },
    });
  });

  it("reverting a key applies the baseline value", async () => {
    backend.rc["lines.linewidth"] = 3;
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "7";
    fireInput(lw);
    await panel.settle();

    openTab(panel, "lines");
    groupReset(panel).click();
    await panel.settle();

    // Resetting the category puts the figure back to the baseline value the
    // student's own code established (3), not to the schema default.
    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    const last = calls[calls.length - 1]!;
    expect((last.args as { rc: Record<string, unknown> }).rc["lines.linewidth"]).toBe(3);
    expect(panel.getSettings().rc["lines.linewidth"]).toBeUndefined();
  });

  it("surfaces a backend error from apply_live in the pill's tooltip and as an event", async () => {
    await attachBackend(panel, backend);
    const events: PanelErrorEventDetail[] = [];
    panel.addEventListener("plotpolish-error", (e) => events.push((e as CustomEvent<PanelErrorEventDetail>).detail));

    backend.failNext = "boom";
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "9";
    fireInput(lw);
    await panel.settle();

    expect(panel.shadowRoot!.querySelector(".pill")!.getAttribute("title")).toContain("Backend error");
    expect(events.length).toBe(1);
    expect(events[0]!.context).toBe("apply_live");
    expect(events[0]!.error.message).toContain("boom");
  });

  it("surfaces a backend error from refresh", async () => {
    await attachBackend(panel, backend); // clean baseline
    const events: PanelErrorEventDetail[] = [];
    panel.addEventListener("plotpolish-error", (e) => events.push((e as CustomEvent<PanelErrorEventDetail>).detail));

    backend.failNext = "boom2";
    await panel.refresh();

    expect(panel.shadowRoot!.querySelector(".pill")!.getAttribute("title")).toContain("Backend error");
    expect(events.length).toBe(1);
    expect(events[0]!.context).toBe("refresh");
  });

  it("keeps the panel usable for writing when the interpreter rejects during refresh", async () => {
    backend.rejectWith = new Error("dead");
    panel.backend = backend;
    await panel.refresh();
    expect(panel.shadowRoot!.querySelector(".pill")!.getAttribute("title")).toContain("Backend error");

    const sink = new MemorySink("");
    panel.sink = sink;
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "9";
    fireInput(lw);
    expect(sink.writes.length).toBe(1);
    await panel.settle();
  });

  it("makes no apply_live calls when features.livePreview is false", async () => {
    panel.features = { livePreview: false };
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "11";
    fireInput(lw);
    await panel.settle();

    expect(backend.calls.some((c) => c.fn === "apply_live")).toBe(false);
  });
});

/**
 * A backend that cannot answer used to change nothing on screen: everything it
 * had to say lived in `pill.title`, a hover tooltip, and the visible error
 * affordances (`.pill.error`, the `!` mark) were wired to the FENCE error
 * alone. On Trinket the concrete failure is a program that plots and then keeps
 * computing: the host rejects every helper call with "A program is running",
 * the student drags a slider, the figure sits still, and nothing anywhere says
 * why.
 *
 * The split these tests hold to: a wait is quiet, a fault is loud, and neither
 * is the malformed-fence treatment.
 */
describe("backend trouble is visible in the panel", () => {
  let backend: MockBackend;
  let sink: MemorySink;

  beforeEach(() => {
    backend = new MockBackend();
    backend.figure = figureWithLines(1);
    sink = new MemorySink("");
  });

  const chip = (): HTMLElement => panel.shadowRoot!.querySelector(".pill .stall") as HTMLElement;
  const word = (): string | null => (chip().querySelector(".stall-word") as HTMLElement).textContent;
  const note = (): HTMLElement => panel.shadowRoot!.querySelector(".pop-body .banner.stall") as HTMLElement;
  const shell = (): HTMLElement => panel.shadowRoot!.querySelector(".pill") as HTMLElement;
  const fenceMark = (): HTMLElement => panel.shadowRoot!.querySelector(".pill .err") as HTMLElement;

  async function dragSlider(value: string): Promise<void> {
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = value;
    fireInput(lw);
    await panel.settle();
  }

  async function attachAndOpen(): Promise<void> {
    panel.sink = sink;
    await attachBackend(panel, backend);
    openTab(panel, "lines");
  }

  it("has both affordances in the DOM, hidden, while the backend is answering", async () => {
    // Guards every "hidden === true" below from passing because the element is
    // missing rather than because it is quiet.
    await attachAndOpen();
    await dragSlider("5");

    expect(chip()).not.toBeNull();
    expect(note()).not.toBeNull();
    expect(chip().hidden).toBe(true);
    expect(note().hidden).toBe(true);
    expect(shell().classList.contains("stalled")).toBe(false);
    expect(shell().classList.contains("bad")).toBe(false);
  });

  it("says a program is running, in words, when the host refuses a live apply mid-run", async () => {
    await attachAndOpen();
    backend.rejectWith = new Error("A program is running");

    await dragSlider("7");

    expect(chip().hidden).toBe(false);
    expect(word()).toBe("Program running");
    expect(note().hidden).toBe(false);
    expect(note().textContent).toContain("still running");
    expect(note().textContent).toContain("run your program again");
    // The block was still written, which is what makes that advice true.
    expect(sink.writes.length).toBeGreaterThan(0);
  });

  it("keeps a busy backend calm: no danger color, and none of the fence treatment", async () => {
    await attachAndOpen();
    backend.rejectWith = new Error("A program is running");
    await dragSlider("7");

    expect(chip().classList.contains("bad")).toBe(false);
    expect(note().classList.contains("bad")).toBe(false);
    expect(shell().classList.contains("stalled")).toBe(true);
    expect(shell().classList.contains("bad")).toBe(false);
    // `.pill.error` and the `!` mark stay the malformed fence's alone.
    expect(shell().classList.contains("error")).toBe(false);
    expect(fenceMark().hidden).toBe(true);
  });

  // Copilot on #20: `.pill.stalled` and `.pill.error` are both `.pill.X`, so at
  // equal specificity the later rule wins, and the muted stalled border would
  // have overridden the fence's danger border wherever both applied.
  //
  // Reaching both took a correction. A control change cannot do it: a fence
  // error hides the group containers (`update()`), so there is no slider to
  // drag. The host's own recovery path can — Trinket calls refresh() from
  // finishRun, which needs no control, so a refused refresh sets the stall
  // while the malformed block is still setting the fence error.
  it("keeps the fence treatment when the backend is stalled at the same time", async () => {
    await attachAndOpen();
    sink.setSource("# --- plot style (generated by plotpolish; edit above, not here) ---\nnot python at all\n# --- end plot style ---\n");
    backend.rejectWith = new Error("A program is running");
    await panel.refresh();

    expect(shell().classList.contains("error")).toBe(true);
    expect(shell().classList.contains("stalled")).toBe(true);
    expect(fenceMark().hidden).toBe(false);
  });

  // The case above proves the two states co-occur, which is what makes the CSS
  // guard necessary -- but it cannot prove the guard works: the bug is cascade
  // order and both classes are present either way. A rendered assertion is not
  // available either, since happy-dom leaves border-color empty when the value
  // is a var(). So pin the guard in the stylesheet itself, which does go red if
  // someone drops it.
  it("guards the stalled border against overriding the fence's, in the stylesheet", () => {
    // Read from disk rather than the `?inline` import, which vitest resolves to
    // an empty string -- an assertion against that would pass for the wrong
    // reason. src/iife.test.ts reads a build artifact the same way.
    const css = readFileSync("src/panel.css", "utf8");
    expect(css).toMatch(/\.pill\.stalled:not\(\.error\)/);
    expect(css).toMatch(/\.rail\.stalled:not\(\.error\)/);
  });

  it("says Python is starting when the interpreter is not up yet", async () => {
    panel.sink = sink;
    backend.rejectWith = new Error("Python is not loaded yet");
    panel.backend = backend;
    await panel.refresh();

    expect(chip().hidden).toBe(false);
    expect(word()).toBe("Python starting");
    expect(chip().classList.contains("bad")).toBe(false);
    expect(note().textContent).toContain("has not started yet");
  });

  it("takes the danger treatment when the helper itself raises", async () => {
    await attachAndOpen();
    backend.failNext = "ValueError: negative linewidth";

    await dragSlider("9");

    expect(chip().hidden).toBe(false);
    expect(word()).toBe("Preview failed");
    expect(chip().classList.contains("bad")).toBe(true);
    expect(note().hidden).toBe(false);
    expect(note().textContent).toContain("negative linewidth");
    expect(shell().classList.contains("stalled")).toBe(true);
    expect(shell().classList.contains("bad")).toBe(true);
  });

  it("leaves the open category's controls in place, unlike the fence banner", async () => {
    // A stalled backend does not stop the panel writing, so taking the controls
    // away (which a malformed fence does) would be wrong.
    await attachAndOpen();
    backend.rejectWith = new Error("A program is running");
    await dragSlider("7");

    expect(group(panel, "lines").hidden).toBe(false);
  });

  it("clears as soon as the next change gets through", async () => {
    await attachAndOpen();
    backend.rejectWith = new Error("A program is running");
    await dragSlider("7");
    expect(chip().hidden).toBe(false);

    backend.rejectWith = null;
    await dragSlider("8");

    expect(chip().hidden).toBe(true);
    expect(note().hidden).toBe(true);
    expect(shell().classList.contains("stalled")).toBe(false);
  });

  it("clears on the refresh the host runs when the program finishes", async () => {
    // Trinket's actual recovery path: finishRun -> panel.refresh().
    await attachAndOpen();
    backend.rejectWith = new Error("A program is running");
    await dragSlider("7");
    expect(chip().hidden).toBe(false);

    backend.rejectWith = null;
    await panel.refresh();

    expect(chip().hidden).toBe(true);
    expect(shell().classList.contains("stalled")).toBe(false);
  });

  it("clears a helper fault too, once a call succeeds", async () => {
    await attachAndOpen();
    backend.failNext = "boom";
    await dragSlider("7");
    expect(chip().classList.contains("bad")).toBe(true);

    await dragSlider("8");

    expect(chip().hidden).toBe(true);
    expect(shell().classList.contains("bad")).toBe(false);
    expect(shell().classList.contains("stalled")).toBe(false);
  });

  it("covers the set_style path, not just apply_live", async () => {
    await attachAndOpen();
    backend.rejectWith = new Error("A program is running");

    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);
    await panel.settle();

    expect(chip().hidden).toBe(false);
    expect(word()).toBe("Program running");
  });

  it("covers the Save path, so a refused save says why and not just that it failed", async () => {
    panel.sink = sink;
    await attachBackend(panel, backend);
    openTab(panel, "save");
    backend.rejectWith = new Error("A program is running");

    (input(panel, "save_png") as HTMLButtonElement).click();
    await flush();

    expect((ctl(panel, "save_png").querySelector(".copy-said") as HTMLElement).textContent).toBe("Save failed");
    expect(chip().hidden).toBe(false);
    expect(word()).toBe("Program running");
  });

  it("stops the tooltip claiming live preview is on while calls are being refused", async () => {
    await attachAndOpen();
    expect(shell().getAttribute("title")).toContain("Live preview on");

    backend.rejectWith = new Error("A program is running");
    await dragSlider("7");

    expect(shell().getAttribute("title")).not.toContain("Live preview on");
    expect(shell().getAttribute("title")).toContain("still running");
  });

  it("stays silent when the host declares it can never preview", async () => {
    // features.livePreview: false is a worker host that cannot preview at all.
    // Nothing failed, so nothing is shown.
    panel.features = { livePreview: false };
    await attachAndOpen();
    await dragSlider("6");

    expect(chip().hidden).toBe(true);
    expect(note().hidden).toBe(true);
    expect(shell().classList.contains("stalled")).toBe(false);
  });

  it("stays silent with no backend attached at all", () => {
    panel.sink = sink;
    expect(chip().hidden).toBe(true);
    expect(note().hidden).toBe(true);
    expect(shell().classList.contains("stalled")).toBe(false);
  });

  it("announces politely, and hides the glyph from the reader", async () => {
    expect(chip().getAttribute("role")).toBe("status");
    expect(chip().getAttribute("aria-live")).toBe("polite");
    expect(note().getAttribute("role")).toBe("status");
    expect(note().getAttribute("aria-live")).toBe("polite");
    expect((chip().querySelector(".glyph") as HTMLElement).getAttribute("aria-hidden")).toBe("true");

    // The word carries the meaning, so a reader that skips the glyph still
    // gets the whole message.
    await attachAndOpen();
    backend.rejectWith = new Error("A program is running");
    await dragSlider("7");
    expect(word()).toBe("Program running");
  });

  it("carries the state on the rail too, where there is no room for the chip", async () => {
    panel.setAttribute("layout", "rail");
    await attachAndOpen();
    backend.rejectWith = new Error("A program is running");
    await dragSlider("7");

    const rail = panel.shadowRoot!.querySelector(".rail") as HTMLElement;
    expect(rail.hidden).toBe(false);
    expect(rail.classList.contains("stalled")).toBe(true);
    expect(rail.classList.contains("bad")).toBe(false);
    expect(rail.classList.contains("error")).toBe(false);
  });
});

describe("fontsize display", () => {
  it("is a range input (6-40, step 0.5), with a readout showing the resolved pt value for a relative default, mentioning the name in the title", () => {
    const titleInput = input(panel, "title_size") as HTMLInputElement;
    expect(titleInput.type).toBe("range");
    expect(titleInput.min).toBe("6");
    expect(titleInput.max).toBe("40");
    expect(titleInput.step).toBe("0.5");
    expect(titleInput.value).toBe("12");
    expect(titleInput.title).toContain("large");
    expect(ctl(panel, "title_size").querySelector(".readout")!.textContent).toBe("12");
  });

  it("recomputes the display and readout when the base font size changes", () => {
    const fontSizeInput = input(panel, "font_size") as HTMLInputElement;
    fontSizeInput.value = "20";
    fireInput(fontSizeInput);

    const titleInput = input(panel, "title_size") as HTMLInputElement;
    expect(titleInput.value).toBe("24");
    expect(ctl(panel, "title_size").querySelector(".readout")!.textContent).toBe("24");
  });

  it("never writes axes.titlesize to the generated code for a relative default", () => {
    const fontSizeInput = input(panel, "font_size") as HTMLInputElement;
    fontSizeInput.value = "20";
    fireInput(fontSizeInput);

    openMenu(panel);
    menuItem(panel, "show-code").click();
    const code = panel.shadowRoot!.querySelector("pre.code")!.textContent;
    expect(code).not.toContain("axes.titlesize");
  });
});

describe("commit as you type", () => {
  it("a fontsize field commits on 'input' without waiting for 'change'", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const titleInput = input(panel, "title_size") as HTMLInputElement;
    titleInput.value = "20";
    fireInput(titleInput);
    expect(panel.getSettings().rc["axes.titlesize"]).toBe(20);
    expect(ctl(panel, "title_size").querySelector(".readout")!.textContent).toBe("20");
  });

  it("a dpi field commits on 'input'", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const dpiInput = input(panel, "savefig_dpi") as HTMLInputElement;
    dpiInput.value = "150";
    fireInput(dpiInput);
    expect(panel.getSettings().rc["savefig.dpi"]).toBe(150);
    expect(ctl(panel, "savefig_dpi").querySelector(".readout")!.textContent).toBe("150");
  });

  // update() rewrites every control from state on each change, so it has to
  // leave alone whatever the user is in the middle of. `isEditing` is what
  // stops it, and it guards nine places: the fontsize and dpi sliders, the
  // figure-size pair, the per-line color swatch and width cell, and the
  // legend x/y sliders. These three cover the three shapes -- a typed field, a
  // dragged slider, and a slider moved by a sibling control -- and each one
  // fails with the guard removed. The test they replace drove `title_size`
  // with the string "6.0", which no browser can produce: that control is an
  // <input type="range">, so the value is sanitized to a step boundary on
  // assignment and cannot be typed into at all.
  it("does not clobber a focused field's in-progress text (e.g. a trailing decimal point)", async () => {
    await attachBackend(panel, new MockBackend());
    panel.sink = new MemorySink("");
    openTab(panel, "lines");

    // The per-line width cell is the panel's one free-text field.
    const cell = panel.shadowRoot!.querySelectorAll<HTMLInputElement>("input.line-width")[0]!;
    expect(cell.type).toBe("number");
    cell.focus();
    cell.value = "3.0";
    fireInput(cell);

    const cycle = panel.getSettings().rc["axes.prop_cycle"];
    expect(isPropCycle(cycle) && cycle.linewidth?.[0]).toBe(3);
    // update() ran and would write String(3) -- "3" -- over the trailing zero
    // the user has not finished typing past.
    expect(cell.value).toBe("3.0");
    cell.blur();
  });

  it("leaves a focused slider where the user is holding it, while the readout still follows", () => {
    panel.sink = new MemorySink("");
    const titleInput = input(panel, "title_size") as HTMLInputElement;
    expect(titleInput.value).toBe("12"); // "large" at base 10

    titleInput.focus();
    const fontSizeInput = input(panel, "font_size") as HTMLInputElement;
    fontSizeInput.value = "20";
    fireInput(fontSizeInput);

    // "large" now resolves to 24. The unfocused case (asserted by the test
    // above this describe block) moves the slider; the focused one must not,
    // or the thumb jumps out from under the pointer mid-drag.
    expect(titleInput.value).toBe("12");
    // But the guard skips the slider position ONLY. Everything that tells the
    // user what the value actually is has to keep up.
    expect(ctl(panel, "title_size").querySelector(".readout")!.textContent).toBe("24");
    expect(titleInput.title).toContain("24");
    titleInput.blur();
  });

  it("leaves a focused legend x slider alone when the named location moves it", async () => {
    await attachBackend(panel, new MockBackend());
    panel.sink = new MemorySink("");
    openTab(panel, "legend");

    const xRange = input(panel, "legend_loc") as HTMLInputElement;
    const snap = ctl(panel, "legend_loc").querySelector("select.snap") as HTMLSelectElement;
    const xOut = ctl(panel, "legend_loc").querySelector(".readout") as HTMLElement;
    const before = xRange.value;

    xRange.focus();
    snap.value = "lower left";
    change(snap);

    expect(panel.getSettings().rc["legend.loc"]).toBe("lower left");
    expect(xRange.value).toBe(before); // held by the user, so left where it is
    expect(xOut.textContent).not.toBe(before); // the readout still reports the truth
    xRange.blur();
  });
});

describe("resolution (dpi) field", () => {
  it("is a range input (72-600), with no placeholder, showing the fallback dpi (100) instead of the word 'figure'", () => {
    const dpiInput = input(panel, "savefig_dpi") as HTMLInputElement;
    expect(dpiInput.type).toBe("range");
    expect(dpiInput.min).toBe("72");
    expect(dpiInput.max).toBe("600");
    expect(dpiInput.value).toBe("100");
    expect(dpiInput.title).toBe("Figure's own dpi (matplotlib default)");
    expect(dpiInput.placeholder).toBe("");
    expect(ctl(panel, "savefig_dpi").querySelector(".readout")!.textContent).toBe("100");
  });

  it("shows the mock figure's own dpi once introspected", async () => {
    const backend = new MockBackend();
    backend.figure = { figsize: [6.4, 4.8], dpi: 144, axes: [{ ...AXES_BASE, legend: null }] };
    await attachBackend(panel, backend);
    const dpiInput = input(panel, "savefig_dpi") as HTMLInputElement;
    expect(dpiInput.value).toBe("144");
    expect(dpiInput.title).toBe("Figure's own dpi (matplotlib default)");
    expect(ctl(panel, "savefig_dpi").querySelector(".readout")!.textContent).toBe("144");
  });

  it("shows the plain number with no special title once dpi is explicitly set", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const dpiInput = input(panel, "savefig_dpi") as HTMLInputElement;
    dpiInput.value = "150";
    change(dpiInput);
    expect(dpiInput.value).toBe("150");
    expect(dpiInput.title).toBe("");
    expect(ctl(panel, "savefig_dpi").querySelector(".readout")!.textContent).toBe("150");
  });
});

describe("panelDefault seeding", () => {
  it("the first change out of fully-default settings also sets savefig.dpi to its panelDefault", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    expect(panel.getSettings().rc).toEqual({ "axes.grid": true, ...SEEDED });
    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["savefig.dpi"]).toBe(300);
  });

  it("does not re-seed once non-default, and reverting the seeded key removes only it", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    openTab(panel, "save");
    groupReset(panel).click();
    // Reverting one seeded key removes only that one; the others stay.
    const { "savefig.dpi": _dropped, ...stillSeeded } = SEEDED;
    expect(panel.getSettings().rc).toEqual({ "axes.grid": true, ...stillSeeded });

    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "3";
    fireInput(lw);
    expect(panel.getSettings().rc["savefig.dpi"]).toBeUndefined();
  });

  it("turns 'Fit labels in figure' on with the first change, so enlarging text does not clip", () => {
    const sink = new MemorySink("");
    panel.sink = sink;

    // Nothing set yet: no block, so nothing is imposed on the user's file.
    expect(panel.getBlock()).toBeNull();
    expect((input(panel, "autolayout") as HTMLInputElement).checked).toBe(false);

    // Enlarging text is the first thing most people do, and without autolayout
    // the labels run outside the figure. Seeding it on the first change means
    // the plot stays inside its edges without the student finding the switch.
    const size = input(panel, "font_size") as HTMLInputElement;
    size.value = "18";
    fireInput(size);

    expect(panel.getSettings().rc["figure.autolayout"]).toBe(true);
    expect((input(panel, "autolayout") as HTMLInputElement).checked).toBe(true);
    expect(panel.getBlock()).toContain("figure.autolayout");
  });

  it("does not seed when loading settings from an existing fence", () => {
    const settings: StyleSettings = { style: "default", rc: { "axes.grid": true } };
    panel.sink = new MemorySink(generateBlock(settings)!);
    expect(panel.getSettings().rc).toEqual({ "axes.grid": true });
  });

  it("emits exactly one plotpolish-change event for the combined write", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const events: ChangeEventDetail[] = [];
    panel.addEventListener("plotpolish-change", (e) => events.push((e as CustomEvent<ChangeEventDetail>).detail));

    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    expect(events.length).toBe(1);
    expect(events[0]!.settings.rc).toEqual({ "axes.grid": true, ...SEEDED });
  });

  it("a style change also seeds savefig.dpi", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);
    expect(panel.getSettings().rc).toEqual({ ...SEEDED });
  });

  // A style change seeds the same keys a control change does, so it owes the
  // user the same indicator. setKeys() decides that with `canPreview`
  // (a client AND live preview); setStyle() used to decide it with
  // `this.client` alone, and then threw away what seedPanelDefaults returned --
  // so with preview off the panel wrote savefig.dpi and figure.autolayout into
  // the student's block and said nothing about the figure not showing them.
  describe("and the seeded keys are marked when they cannot be previewed", () => {
    const SEEDED_KEYS = Object.keys(SEEDED);
    const SEEDED_IDS = CONTROLS.filter((c) => c.panelDefault !== undefined).map((c) => c.id);

    function rerunBadged(p: PlotpolishPanel, id: string): boolean {
      return !!ctl(p, id).querySelector(".badge.rerun");
    }
    /** The style select only offers what the backend listed, so add the option first. */
    function pickStyle(p: PlotpolishPanel, name: string): void {
      const select = input(p, "style") as HTMLSelectElement;
      if (!Array.from(select.options).some((o) => o.value === name)) {
        const opt = document.createElement("option");
        opt.value = name;
        select.append(opt);
      }
      select.value = name;
      change(select);
    }

    it("with a backend but live preview off: pending a re-run, and no apply_live", async () => {
      const backend = new MockBackend();
      panel.features = { livePreview: false };
      panel.sink = new MemorySink("");
      await attachBackend(panel, backend);
      const events: RerunNeededEventDetail[] = [];
      panel.addEventListener("plotpolish-rerun-needed", (e) =>
        events.push((e as CustomEvent<RerunNeededEventDetail>).detail)
      );

      pickStyle(panel, "ggplot");
      await panel.settle();

      for (const key of SEEDED_KEYS) expect(events[events.length - 1]!.keys).toContain(key);
      for (const id of SEEDED_IDS) expect(rerunBadged(panel, id)).toBe(true);
      expect(backend.calls.some((c) => c.fn === "apply_live")).toBe(false);
      // set_style still runs: the baseline follows the preset even with no preview.
      expect(backend.calls.some((c) => c.fn === "set_style")).toBe(true);
    });

    it("with no backend at all: the same, matching what setKeys does in that state", () => {
      panel.sink = new MemorySink("");
      const events: RerunNeededEventDetail[] = [];
      panel.addEventListener("plotpolish-rerun-needed", (e) =>
        events.push((e as CustomEvent<RerunNeededEventDetail>).detail)
      );

      pickStyle(panel, "ggplot");

      for (const key of SEEDED_KEYS) expect(panel.getSettings().rc[key]).toBeDefined();
      for (const key of SEEDED_KEYS) expect(events[events.length - 1]!.keys).toContain(key);
      for (const id of SEEDED_IDS) expect(rerunBadged(panel, id)).toBe(true);
    });

    it("with live preview on: applyStyle applies them, so no mark and exactly one apply_live", async () => {
      const backend = new MockBackend();
      panel.sink = new MemorySink("");
      await attachBackend(panel, backend);
      const events: RerunNeededEventDetail[] = [];
      panel.addEventListener("plotpolish-rerun-needed", (e) =>
        events.push((e as CustomEvent<RerunNeededEventDetail>).detail)
      );

      pickStyle(panel, "ggplot");
      await panel.settle();

      for (const key of SEEDED_KEYS) expect(events[events.length - 1]!.keys).not.toContain(key);
      for (const id of SEEDED_IDS) expect(rerunBadged(panel, id)).toBe(false);
      const applies = backend.calls.filter((c) => c.fn === "apply_live");
      expect(applies.length).toBe(1);
      const rc = (applies[0]!.args as { rc: Record<string, unknown> }).rc;
      for (const key of SEEDED_KEYS) expect(rc[key]).toBeDefined();
    });

    it("a backend slower than the debounce still gets exactly one apply_live", async () => {
      // Guards the shape of the fix rather than the bug. Scheduling the seeded
      // keys up front races set_style: on a real interpreter the batch fires
      // first and applyStyle then re-applies the same keys, two round trips
      // for one change.
      const backend = new MockBackend();
      panel.sink = new MemorySink("");
      await attachBackend(panel, backend);
      backend.delay = 100; // > APPLY_DEBOUNCE_MS
      backend.calls.length = 0;

      pickStyle(panel, "ggplot");
      await panel.settle();
      await new Promise((r) => setTimeout(r, 400));
      await panel.settle();

      expect(backend.calls.filter((c) => c.fn === "apply_live").length).toBe(1);
    });
  });
});

describe("colors the color input cannot represent", () => {
  it("does not rewrite a named palette to black when an unrelated cell is edited", async () => {
    // The classic style's palette is named colors; <input type="color"> turns
    // every one of them into #000000. Editing a width must not drag the whole
    // palette to black in the student's file.
    const backend = new MockBackend();
    backend.rc["axes.prop_cycle"] = ["b", "g", "r", "c"];
    await attachBackend(panel, backend);
    openTab(panel, "lines");

    const widths = Array.from(
      panel.shadowRoot!.querySelectorAll<HTMLInputElement>("input.line-width")
    );
    widths[0]!.value = "4";
    fireInput(widths[0]!);

    const cycle = panel.getSettings().rc["axes.prop_cycle"] as { color: string[] };
    expect(cycle.color.slice(0, 4)).toEqual(["b", "g", "r", "c"]);
    expect(panel.getBlock()).not.toContain("#000000");
  });

  it("still takes a color the student actually picks", async () => {
    const backend = new MockBackend();
    backend.rc["axes.prop_cycle"] = ["b", "g", "r", "c"];
    await attachBackend(panel, backend);
    openTab(panel, "lines");

    const colors = Array.from(
      panel.shadowRoot!.querySelectorAll<HTMLInputElement>("input.line-color")
    );
    colors[1]!.value = "#ff8800";
    fireInput(colors[1]!);

    // With only colors set, the cycle is written as a plain color array;
    // once widths or styles join it becomes the dict form.
    const value = panel.getSettings().rc["axes.prop_cycle"];
    const written = Array.isArray(value) ? (value as string[]) : (value as { color: string[] }).color;
    expect(written[0]).toBe("b");
    expect(written[1]).toBe("#ff8800");
  });
});

describe("one reset per category", () => {
  it("is hidden until the open category has something to reset, and names it", () => {
    panel.sink = new MemorySink("");
    openTab(panel, "text");
    expect(groupReset(panel).hidden).toBe(true);

    const size = input(panel, "font_size") as HTMLInputElement;
    size.value = "18";
    fireInput(size);

    expect(groupReset(panel).hidden).toBe(false);
    expect(groupReset(panel).title).toBe("Reset Text");
  });

  it("resets only the open category, leaving the others alone", () => {
    panel.sink = new MemorySink("");
    openTab(panel, "text");
    const size = input(panel, "font_size") as HTMLInputElement;
    size.value = "18";
    fireInput(size);

    openTab(panel, "axes");
    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    // Reset Axes: the grid goes, the font size stays.
    expect(groupReset(panel).title).toBe("Reset Axes");
    groupReset(panel).click();
    expect(panel.getSettings().rc["axes.grid"]).toBeUndefined();
    expect(panel.getSettings().rc["font.size"]).toBe(18);

    // And with nothing left in Axes, its reset goes away again.
    expect(groupReset(panel).hidden).toBe(true);
  });

  it("follows the category as you switch tabs", () => {
    panel.sink = new MemorySink("");
    openTab(panel, "text");
    const size = input(panel, "font_size") as HTMLInputElement;
    size.value = "18";
    fireInput(size);
    expect(groupReset(panel).hidden).toBe(false);

    // Lines has no changes, so the reset is not offered there.
    openTab(panel, "lines");
    expect(groupReset(panel).hidden).toBe(true);

    openTab(panel, "text");
    expect(groupReset(panel).hidden).toBe(false);
  });
});

describe("style thumbnails", () => {
  it("draws one thumbnail per style once the backend supplies previews", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    await panel.settle();
    openTab(panel, "look");

    const host = panel.shadowRoot!.querySelector(".style-thumbs") as HTMLElement;
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("button.style-thumb"));
    expect(host.hidden).toBe(false);
    // Curated by default: the seaborn variant is behind "Show all".
    expect(buttons.map((b) => b.dataset.style)).toEqual(["default", "dark_background", "ggplot"]);

    const showAll = panel.shadowRoot!.querySelector(".show-all-styles") as HTMLButtonElement;
    expect(showAll.hidden).toBe(false);
    expect(showAll.textContent).toBe("Show all 4");
    showAll.click();
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>("button.style-thumb")).map((b) => b.dataset.style)
    ).toEqual(backend.styles);
    // The current style is marked, so the strip says which one is in force.
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.style))
      .toEqual(["default"]);
  });

  it("draws each style from its own colors, so they are distinguishable", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    await panel.settle();
    openTab(panel, "look");

    const host = panel.shadowRoot!.querySelector(".style-thumbs") as HTMLElement;
    const dark = host.querySelector('button[data-style="dark_background"] rect') as SVGRectElement;
    const ggplot = host.querySelector('button[data-style="ggplot"] rect') as SVGRectElement;
    expect(dark.getAttribute("fill")).toBe("#000000");
    expect(ggplot.getAttribute("fill")).toBe("#E5E5E5");
    // ggplot has a grid; dark_background does not.
    expect(host.querySelectorAll('button[data-style="ggplot"] line').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('button[data-style="dark_background"] line').length).toBe(0);
  });

  it("carries the full name on the thumbnail rather than a caption under it", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    await panel.settle();
    openTab(panel, "look");
    const host = panel.shadowRoot!.querySelector(".style-thumbs") as HTMLElement;

    const dark = host.querySelector('button[data-style="dark_background"]') as HTMLElement;
    // The captions are gone: they did not fit the cell. The tooltip and the
    // accessible name carry the real name instead, and so does the menu.
    expect(dark.querySelector(".style-name")).toBeNull();
    expect(dark.title).toBe("dark_background");
    expect(dark.getAttribute("aria-label")).toBe("dark_background");

    (dark as HTMLButtonElement).click();
    expect(panel.getSettings().style).toBe("dark_background");
    expect(panel.getBlock()).toContain('mpl.style.use("dark_background")');
  });

  it("offers every style in a menu beside the label, abbreviated but titled in full", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    openTab(panel, "look");
    const select = input(panel, "style") as HTMLSelectElement;
    expect(select.hidden).toBe(false);

    const byValue = new Map(Array.from(select.options).map((o) => [o.value, o]));
    expect(byValue.get("seaborn-v0_8-whitegrid")!.textContent).toBe("- whitegrid");
    expect(byValue.get("seaborn-v0_8-whitegrid")!.title).toBe("seaborn-v0_8-whitegrid");
    expect(byValue.get("dark_background")!.textContent).toBe("dark bg");

    select.value = "ggplot";
    change(select);
    expect(panel.getSettings().style).toBe("ggplot");
  });

  it("indents the seaborn variants under seaborn rather than repeating the prefix", () => {
    // Sixteen of matplotlib's twenty-six styles begin "seaborn-v0_8-", which is
    // two thirds of the menu and none of the information. Display only: the
    // block still carries the name matplotlib knows.
    expect(shortStyleName("seaborn-v0_8")).toBe("seaborn");
    expect(shortStyleName("seaborn-v0_8-bright")).toBe("- bright");
    expect(shortStyleName("seaborn-v0_8-dark")).toBe("- dark");
    expect(shortStyleName("seaborn-v0_8-dark-palette")).toBe("- dark-palette");
    expect(shortStyleName("seaborn-v0_8-colorblind")).toBe("- colorblind");
    expect(shortStyleName("dark_background")).toBe("dark bg");
    expect(shortStyleName("fivethirtyeight")).toBe("538");
    expect(shortStyleName("Solarize_Light2")).toBe("Solarize");
    expect(shortStyleName("tableau-colorblind10")).toBe("tableau");
    // Anything unrecognized is left exactly as matplotlib names it.
    expect(shortStyleName("ggplot")).toBe("ggplot");
  });

  it("clicking a thumbnail selects that style", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    await panel.settle();
    openTab(panel, "look");

    const host = panel.shadowRoot!.querySelector(".style-thumbs") as HTMLElement;
    (host.querySelector('button[data-style="ggplot"]') as HTMLButtonElement).click();
    expect(panel.getSettings().style).toBe("ggplot");
    expect((input(panel, "style") as HTMLSelectElement).value).toBe("ggplot");
  });

  it("stays hidden when the host supplies no previews", () => {
    // No backend at all: the select still works, the strip simply is not there.
    panel.sink = new MemorySink("");
    openTab(panel, "look");
    const host = panel.shadowRoot!.querySelector(".style-thumbs") as HTMLElement;
    expect(host.hidden).toBe(true);
  });
});

describe("the (all) master vs the per-line table", () => {
  function widthCells(p: PlotpolishPanel): HTMLInputElement[] {
    return Array.from(p.shadowRoot!.querySelectorAll<HTMLInputElement>("input.line-width"));
  }
  function masterReadout(p: PlotpolishPanel): string {
    return ctl(p, "linewidth").querySelector(".readout")!.textContent ?? "";
  }
  function setCell(cells: HTMLInputElement[], i: number, value: string): void {
    cells[i]!.value = value;
    fireInput(cells[i]!);
  }

  it("reads the value every shown row shares, not its own unset scalar", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    openTab(panel, "lines");

    const cells = widthCells(panel);
    setCell(cells, 0, "8");
    // One row changed: the rows genuinely differ, so the master says so.
    expect(masterReadout(panel)).toBe("mixed");

    setCell(widthCells(panel), 1, "8");
    // Both shown rows are 8 now. Reporting "mixed" (from palette entries the
    // table never shows) or "1.5" (the untouched scalar) would both contradict
    // the table directly above it.
    expect(masterReadout(panel)).toBe("8");
  });

  it("says mixed only when the rows the table shows actually differ", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    openTab(panel, "lines");

    const cells = widthCells(panel);
    setCell(cells, 0, "8");
    setCell(widthCells(panel), 1, "8");
    expect(masterReadout(panel)).toBe("8");

    setCell(widthCells(panel), 1, "3");
    expect(masterReadout(panel)).toBe("mixed");
    expect(ctl(panel, "linewidth").closest(".row")?.classList.contains("mixed") ?? true).toBe(true);
  });
});

describe("minor grid lines", () => {
  it("writes axes.grid.which as both/major rather than a boolean", () => {
    panel.sink = new MemorySink("");
    openTab(panel, "axes");
    const toggle = input(panel, "minor_grid") as HTMLInputElement;

    toggle.checked = true;
    change(toggle);
    expect(panel.getSettings().rc["axes.grid.which"]).toBe("both");
    expect(panel.getBlock()).toContain('"axes.grid.which": "both"');

    toggle.checked = false;
    change(toggle);
    expect(panel.getSettings().rc["axes.grid.which"]).toBe("major");
  });

  it("turns the Grid and the minor tick marks on with it, because it cannot draw without either", () => {
    // matplotlib puts a minor grid line only where a minor tick is, so asking
    // for the grid lines is asking for whatever it takes to see them. The ticks
    // are matplotlib's business, not a second decision for the student.
    panel.sink = new MemorySink("");
    openTab(panel, "axes");
    expect(panel.getSettings().rc["xtick.minor.visible"]).toBeUndefined();

    const grid = input(panel, "minor_grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    expect(panel.getSettings().rc["axes.grid.which"]).toBe("both");
    expect(panel.getSettings().rc["xtick.minor.visible"]).toBe(true);
    expect(panel.getSettings().rc["ytick.minor.visible"]).toBe(true);
    // ...and the Grid toggle, without which nothing draws at all: verified in
    // matplotlib, axes.grid off gives major=0 minor=0 however the rest is set.
    expect(panel.getSettings().rc["axes.grid"]).toBe(true);
    expect((input(panel, "minor_ticks") as HTMLInputElement).checked).toBe(true);
    expect((input(panel, "grid") as HTMLInputElement).checked).toBe(true);
    // One write, so the student gets one undo and one re-run, not three.
    expect(panel.getBlock()).toContain('"xtick.minor.visible": True');
    expect(panel.getBlock()).toContain('"axes.grid": True');
  });

  it("sends both in a single apply, so the figure never shows a half state", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    panel.sink = new MemorySink("");
    openTab(panel, "axes");
    backend.calls.length = 0;

    const grid = input(panel, "minor_grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);
    await panel.settle();

    const applied = backend.calls.filter((c) => c.fn === "apply_live");
    expect(applied.length).toBe(1);
    const rc = (applied[0]!.args as { rc: Record<string, unknown> }).rc;
    expect(rc["axes.grid.which"]).toBe("both");
    expect(rc["xtick.minor.visible"]).toBe(true);
    expect(rc["axes.grid"]).toBe(true);
  });

  it("leaves the Grid and the tick marks alone when it is switched off again", () => {
    // Only on the way on. A student may want either on their own, and taking
    // them away would be a change they did not ask for.
    panel.sink = new MemorySink("");
    openTab(panel, "axes");
    const grid = input(panel, "minor_grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);
    grid.checked = false;
    change(grid);

    expect(panel.getSettings().rc["axes.grid.which"]).toBe("major");
    expect(panel.getSettings().rc["xtick.minor.visible"]).toBe(true);
    expect(panel.getSettings().rc["axes.grid"]).toBe(true);
  });

  it("goes off when the minor tick marks do, rather than staying on and dead", () => {
    // The state this whole mechanism exists to prevent does not care which
    // switch the student reached for: a minor grid with no minor ticks draws
    // nothing whether they turned the grid lines on first or the ticks off after.
    panel.sink = new MemorySink("");
    openTab(panel, "axes");
    const grid = input(panel, "minor_grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);
    expect(panel.getSettings().rc["axes.grid.which"]).toBe("both");

    const ticks = input(panel, "minor_ticks") as HTMLInputElement;
    ticks.checked = false;
    change(ticks);

    expect(panel.getSettings().rc["xtick.minor.visible"]).toBe(false);
    expect(panel.getSettings().rc["axes.grid.which"]).toBe("major");
    expect((input(panel, "minor_grid") as HTMLInputElement).checked).toBe(false);
    // The Grid toggle is not a casualty: it works perfectly well on its own.
    expect(panel.getSettings().rc["axes.grid"]).toBe(true);
  });

  it("goes off when the Grid toggle does, for the same reason", () => {
    panel.sink = new MemorySink("");
    openTab(panel, "axes");
    const grid = input(panel, "minor_grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    const major = input(panel, "grid") as HTMLInputElement;
    major.checked = false;
    change(major);

    expect(panel.getSettings().rc["axes.grid"]).toBe(false);
    expect(panel.getSettings().rc["axes.grid.which"]).toBe("major");
    // The tick marks stay: nothing depends on them being off.
    expect(panel.getSettings().rc["xtick.minor.visible"]).toBe(true);
  });

  it("does not switch off a dependant that was never on", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    panel.sink = new MemorySink("");
    openTab(panel, "axes");

    const ticks = input(panel, "minor_ticks") as HTMLInputElement;
    ticks.checked = true;
    change(ticks);
    ticks.checked = false;
    change(ticks);

    // minor_grid was never on, so it is left unset rather than written as
    // "major" -- the block should not gain a key the student never touched.
    expect(panel.getSettings().rc["axes.grid.which"]).toBeUndefined();
  });

  it("reflects the enum back into the checkbox, rather than coercing it", () => {
    panel.sink = new MemorySink(generateBlock({ style: "default", rc: { "axes.grid.which": "both" } })!);
    openTab(panel, "axes");
    expect((input(panel, "minor_grid") as HTMLInputElement).checked).toBe(true);

    // "major" is a non-empty string: Boolean("major") would be true.
    panel.sink = new MemorySink(generateBlock({ style: "default", rc: { "axes.grid.which": "major" } })!);
    openTab(panel, "axes");
    expect((input(panel, "minor_grid") as HTMLInputElement).checked).toBe(false);
  });
});

describe("linecycle (Per line)", () => {
  function visibleLineRows(p: PlotpolishPanel): HTMLElement[] {
    return Array.from(ctl(p, "line_cycle").querySelectorAll<HTMLElement>(".line-row:not(.line-head)")).filter((r) => !r.hidden);
  }

  it("shows a tooltip on the label from the control's help text", () => {
    const label = ctl(panel, "line_cycle").querySelector("label")!;
    expect(label.getAttribute("title")).toBe(CONTROLS.find((c) => c.id === "line_cycle")!.help);
  });

  it("the label row (label and badges) sits on one line, separate from the table", () => {
    const row = ctl(panel, "line_cycle");
    const labelRow = row.querySelector(".control-label-row")!;
    expect(labelRow.querySelector("label")).not.toBeNull();
    expect(labelRow.querySelector(".badges")).not.toBeNull();
    // No per-row revert anywhere: one reset per category lives in the popover
    // header instead, so a row carries only what describes the control.
    expect(row.querySelector(".revert")).toBeNull();
  });

  it("the header row has no 'COLOR' heading, and has 'Width' and 'Style' over their columns", () => {
    const head = ctl(panel, "line_cycle").querySelector(".line-head")!;
    const cells = Array.from(head.children).map((c) => c.textContent);
    expect(cells).toEqual(["", "", "Width", "Style"]);
    expect(head.textContent).not.toContain("COLOR");
    expect(head.textContent).not.toContain("Color");
  });

  it("width cells are number inputs with the line-width class (spinners hidden via CSS) and the style control is not stretched", () => {
    const rows = visibleLineRows(panel);
    const width = rows[0]!.querySelector("input.line-width") as HTMLInputElement;
    expect(width.type).toBe("number");
    expect(width.classList.contains("line-width")).toBe(true);
    const seg = rows[0]!.querySelector(".segmented.line-style") as HTMLElement;
    expect(seg).not.toBeNull();
  });

  it("renders minLines (2) rows with no figure", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    expect(visibleLineRows(panel).length).toBe(2);
  });

  it("renders N rows when the mock figure reports N lines", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLines(3);
    const sink = new MemorySink("");
    panel.sink = sink;
    await attachBackend(panel, backend);
    expect(visibleLineRows(panel).length).toBe(3);
  });

  it("editing row 2's width writes linewidth for every row, with no linestyle", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLines(3);
    const sink = new MemorySink("");
    panel.sink = sink;
    await attachBackend(panel, backend);

    const rows = visibleLineRows(panel);
    const widthInput = rows[1]!.querySelector(".line-width") as HTMLInputElement;
    widthInput.value = "3";
    fireInput(widthInput);

    // Arrays span the whole palette so later lines keep their colors; entries beyond the rows hold the all-lines width.
    const defaultColors = CONTROLS.find((c) => c.id === "prop_cycle")!.default as string[];
    const rc = panel.getSettings().rc["axes.prop_cycle"];
    expect(rc).toEqual({ color: defaultColors, linewidth: [1.5, 3, ...Array<number>(defaultColors.length - 2).fill(1.5)] });
    expect(visibleLineRows(panel).length).toBe(3); // still three rows: the palette length is not a row count
  });

  it("choosing a line style adds linestyle for every row", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLines(2);
    const sink = new MemorySink("");
    panel.sink = sink;
    await attachBackend(panel, backend);

    const rows = visibleLineRows(panel);
    const seg = rows[0]!.querySelector(".segmented.line-style") as HTMLElement;
    const dashedBtn = seg.querySelector('button[data-value="--"]') as HTMLButtonElement;
    dashedBtn.click();

    const defaultColors = CONTROLS.find((c) => c.id === "prop_cycle")!.default as string[];
    const rc = panel.getSettings().rc["axes.prop_cycle"];
    expect(rc).toEqual({ color: defaultColors, linestyle: ["--", ...Array<string>(defaultColors.length - 1).fill("-")] });
  });

  it("choosing a Look preset afterwards keeps the linewidth array, resized to the preset's color count", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLines(3);
    const sink = new MemorySink("");
    panel.sink = sink;
    await attachBackend(panel, backend);

    const rows = visibleLineRows(panel);
    const widthInput = rows[1]!.querySelector(".line-width") as HTMLInputElement;
    widthInput.value = "3";
    fireInput(widthInput);

    const list = ctl(panel, "prop_cycle").querySelector(".swatch-list") as HTMLElement;
    const presetBtn = list.querySelector('button[data-preset="okabe-ito"]') as HTMLButtonElement;
    presetBtn.click();

    const preset = CONTROLS.find((c) => c.id === "prop_cycle")!.presets!.find((p) => p.id === "okabe-ito")!;
    const rc = panel.getSettings().rc["axes.prop_cycle"];
    // Truncated to the preset's 8 colors; the per-line pattern is never cycled.
    expect(rc).toEqual({ color: preset.colors, linewidth: [1.5, 3, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5] });
    expect(visibleLineRows(panel).length).toBe(3);
    // A PropCycleValue whose `color` matches the preset still shows the preset as pressed (rcEqual on `.color` alone).
    expect(presetBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("choosing a color preset does not change the number of rows (a 7-color palette is not 7 lines)", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLines(2);
    const sink = new MemorySink("");
    panel.sink = sink;
    await attachBackend(panel, backend);
    expect(visibleLineRows(panel).length).toBe(2);
    const list = ctl(panel, "prop_cycle").querySelector(".swatch-list") as HTMLElement;
    (list.querySelector('button[data-preset="tol-bright"]') as HTMLButtonElement).click();
    expect(visibleLineRows(panel).length).toBe(2);
    const rc = panel.getSettings().rc["axes.prop_cycle"];
    expect(Array.isArray(rc) && rc.length).toBe(7); // the palette itself is kept whole
  });

  it("'+ line' adds a row, up to maxLines", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const addBtn = ctl(panel, "line_cycle").querySelector("button.add-line") as HTMLButtonElement;
    expect(visibleLineRows(panel).length).toBe(2);

    addBtn.click();
    expect(visibleLineRows(panel).length).toBe(3);

    const maxLines = CONTROLS.find((c) => c.id === "line_cycle")!.maxLines!;
    while (visibleLineRows(panel).length < maxLines) addBtn.click();
    expect(visibleLineRows(panel).length).toBe(maxLines);
    expect(addBtn.hidden).toBe(true);
  });
});

describe("events", () => {
  it("dispatches plotpolish-change with settings, block and source", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const events: ChangeEventDetail[] = [];
    panel.addEventListener("plotpolish-change", (e) => events.push((e as CustomEvent<ChangeEventDetail>).detail));

    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);

    // panelDefault seeding folds into the same write: exactly one event, settings already contain savefig.dpi.
    expect(events.length).toBe(1);
    expect(events[0]!.settings.rc).toEqual({ "font.size": 14, ...SEEDED });
    expect(events[0]!.block).toBe(generateBlock({ style: "default", rc: { "font.size": 14, ...SEEDED } }));
    expect(events[0]!.source).toBe(sink.getSource());
  });
});

describe("write-only sink", () => {
  it("receives just the generated block text on setSource", () => {
    class WriteOnlySink implements CodeSink {
      received: string[] = [];
      getSource(): string | null {
        return null;
      }
      setSource(source: string): void {
        this.received.push(source);
      }
    }
    const sink = new WriteOnlySink();
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);

    expect(sink.received.length).toBe(1);
    expect(sink.received[0]).toBe(generateBlock({ style: "default", rc: { "font.size": 14, ...SEEDED } }));
  });

  it("sends an empty string once settings return to default", () => {
    class WriteOnlySink implements CodeSink {
      received: string[] = [];
      getSource(): string | null {
        return null;
      }
      setSource(source: string): void {
        this.received.push(source);
      }
    }
    const sink = new WriteOnlySink();
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);
    openMenu(panel);
    menuItem(panel, "reset-all").click();

    expect(sink.received[sink.received.length - 1]).toBe("");
  });
});

describe("sink subscribe", () => {
  it("updates panel state on an external edit with a different fence", () => {
    const srcA = generateBlock({ style: "default", rc: { "lines.linewidth": 2 } })!;
    const sink = new MemorySink(srcA);
    panel.sink = sink;
    expect(panel.getSettings().rc).toEqual({ "lines.linewidth": 2 });

    const srcB = generateBlock({ style: "default", rc: { "lines.linewidth": 5 } })!;
    sink.externalEdit(srcB);
    expect(panel.getSettings().rc).toEqual({ "lines.linewidth": 5 });
  });

  it("shows the error mark when an external edit makes the fence malformed", () => {
    const src = generateBlock({ style: "default", rc: { "lines.linewidth": 2 } })!;
    const sink = new MemorySink(src);
    panel.sink = sink;

    sink.externalEdit(`${FENCE_START}\n${src}`);
    expect(panel.shadowRoot!.querySelector(".pill")!.classList.contains("error")).toBe(true);
    expect(panel.currentFenceError).toBeInstanceOf(FenceError);
  });

  /**
   * A sink that behaves like the editors the panel actually runs against (Ace,
   * in Trinket): replacing the document notifies subscribers, and the document
   * is momentarily EMPTY partway through, because setValue() drops every line
   * and then inserts the new ones, firing a change at each step.
   *
   * MemorySink cannot stand in here. Its setSource() never notifies
   * subscribers (see sink.test.ts, "does not call subscribed listeners on
   * setSource, only on externalEdit"), and externalEdit() publishes the whole
   * new document before notifying -- so re-parsing round-trips to the settings
   * the panel just wrote, and nothing the `writing` guard prevents is visible.
   */
  class EditorSink implements CodeSink {
    private source: string;
    private listeners = new Set<() => void>();
    private inWrite = false;
    readonly writes: string[] = [];
    /** getSource() calls made from inside the panel's own setSource(). */
    readonly readsDuringWrite: string[] = [];
    /** Panel state sampled at each notification the panel's own write raised. */
    readonly snapshotsDuringWrite: unknown[] = [];

    constructor(initial: string, private readonly sample: () => unknown = () => null) {
      this.source = initial;
    }

    getSource(): string {
      if (this.inWrite) this.readsDuringWrite.push(this.source);
      return this.source;
    }

    setSource(source: string): void {
      this.writes.push(source);
      // Stop an unbounded write -> notify -> write cascade, so a regression
      // fails these assertions instead of hanging the suite.
      if (this.writes.length > 10) throw new Error("runaway write loop");
      const outer = this.inWrite;
      this.inWrite = true;
      try {
        this.source = "";      // Ace: remove every line, fire a change
        this.notify();
        this.source = source;  // Ace: insert the new lines, fire a change
        this.notify();
      } finally {
        this.inWrite = outer;
      }
    }

    /** An edit made outside the panel (the user typing in the editor). */
    externalEdit(source: string): void {
      this.source = source;
      this.notify();
    }

    subscribe(listener: () => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    private notify(): void {
      // Sample BEFORE the listeners run, so a listener that clobbers panel
      // state against the half-applied document shows up in the NEXT snapshot.
      if (this.inWrite) this.snapshotsDuringWrite.push(this.sample());
      for (const l of [...this.listeners]) l();
    }
  }

  it("does not re-trigger a reload loop from the panel's own writes", () => {
    const sink = new EditorSink("x = 1\n", () => panel.getSettings().rc["font.size"]);
    panel.sink = sink;

    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    fireInput(fs);

    // The panel's own state is never replaced by the editor's half-applied
    // document: it holds font.size 14 across both of the write's changes.
    expect(sink.snapshotsDuringWrite).toEqual([14, 14]);
    expect(sink.readsDuringWrite).toEqual([]); // it never re-read mid-write
    expect(sink.writes.length).toBe(1);        // one write, no cascade
    expect(panel.getSettings().rc["font.size"]).toBe(14);

    // An edit from outside is still picked up: the guard is only about the
    // panel's own writes, not about ignoring the sink.
    sink.externalEdit(generateBlock({ style: "default", rc: { "font.size": 20 } })!);
    expect(panel.getSettings().rc["font.size"]).toBe(20);
  });

  it("does not re-trigger a reload loop from Replace block", () => {
    const src = [
      FENCE_START, FENCE_START, "import matplotlib as mpl",
      "mpl.rcParams.update({", '    "font.size": 12,', "})", "# --- end plot style ---",
      "print('kept')",
    ].join("\n");
    const sink = new EditorSink(src, () => panel.currentFenceError !== null);
    panel.sink = sink;
    expect(panel.currentFenceError).toBeInstanceOf(FenceError);
    openTab(panel, "text");

    const banner = panel.shadowRoot!.querySelector(".banner.error") as HTMLElement;
    (banner.querySelector("button") as HTMLButtonElement).click();

    // replaceBlock() clears the fence error from its own reload afterwards --
    // never from a reload triggered against its own half-written document.
    expect(sink.snapshotsDuringWrite).toEqual([true, true]);
    expect(sink.readsDuringWrite).toEqual([]);
    expect(sink.writes.length).toBe(1);
    expect(panel.currentFenceError).toBeNull();
    expect(sink.writes[0]).toContain("print('kept')");
  });
});


describe("layout attribute removal", () => {
  it("returns to automatic detection when the host removes the layout attribute", async () => {
    const panel = document.createElement("plotpolish-panel") as PlotpolishPanel;
    document.body.append(panel);
    const fig = document.createElement("div");
    fig.getBoundingClientRect = () => ({ x: 10, y: 10, width: 640, height: 480, top: 10, left: 10, right: 650, bottom: 490, toJSON: () => ({}) }) as DOMRect;
    document.body.append(fig);
    panel.figureElement = fig;
    expect(panel.layout).toBe("float");
    panel.setAttribute("layout", "pill");
    await Promise.resolve();
    expect(panel.layout).toBe("pill"); // forced by the host
    panel.removeAttribute("layout");
    await Promise.resolve();
    expect(panel.layout).toBe("float"); // back to automatic
    expect(panel.getAttribute("layout")).toBe("float");
    panel.remove();
    fig.remove();
  });
});


describe("all-lines width and style are masters over the per-line table", () => {
  function setup(): PlotpolishPanel {
    const p = document.createElement("plotpolish-panel") as PlotpolishPanel;
    document.body.append(p);
    p.sink = new MemorySink("import matplotlib.pyplot as plt\nplt.plot([1, 2])\n");
    p.showCategory("lines");
    p.open = true;
    return p;
  }
  function lineRows(p: PlotpolishPanel): HTMLElement[] {
    return Array.from(p.shadowRoot!.querySelectorAll<HTMLElement>('[data-control="line_cycle"] .line-row:not(.line-head)')).filter((r) => !r.hidden);
  }

  it("shows 'mixed' on Line width (all) once per-line widths differ, and unifies them when dragged", () => {
    const p = setup();
    const w2 = lineRows(p)[1]!.querySelector("input.line-width") as HTMLInputElement;
    w2.value = "3";
    w2.dispatchEvent(new Event("input", { bubbles: true }));
    const cycle = p.getSettings().rc["axes.prop_cycle"];
    const cycleWidths = isPropCycle(cycle) ? cycle.linewidth! : [];
    expect(cycleWidths.slice(0, 2)).toEqual([1.5, 3]);
    expect(cycleWidths.slice(2).every((w) => w === 1.5)).toBe(true);

    const row = p.shadowRoot!.querySelector('.row[data-control="linewidth"]') as HTMLElement;
    expect(row.classList.contains("mixed")).toBe(true);
    expect(row.querySelector(".readout")!.textContent).toBe("mixed");

    const range = row.querySelector('input[type="range"]') as HTMLInputElement;
    range.value = "2";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    const after = p.getSettings();
    expect(after.rc["lines.linewidth"]).toBe(2);
    expect(Array.isArray(after.rc["axes.prop_cycle"])).toBe(true); // collapsed back to colors only
    expect(row.classList.contains("mixed")).toBe(false);
    expect(row.querySelector(".readout")!.textContent).toBe("2");
    const widths = lineRows(p).map((r) => (r.querySelector("input.line-width") as HTMLInputElement).value);
    expect(widths).toEqual(["2", "2"]);
    p.remove();
  });

  it("does the same for Line style (all)", () => {
    const p = setup();
    const seg = lineRows(p)[0]!.querySelector(".segmented.line-style") as HTMLElement;
    (seg.querySelector('button[data-value="--"]') as HTMLButtonElement).click();
    const cycle = p.getSettings().rc["axes.prop_cycle"];
    const styles = isPropCycle(cycle) ? cycle.linestyle! : [];
    expect(styles.slice(0, 2)).toEqual(["--", "-"]);

    const row = p.shadowRoot!.querySelector('.row[data-control="linestyle"]') as HTMLElement;
    expect(row.classList.contains("mixed")).toBe(true);
    const pressed = Array.from(row.querySelectorAll('.segmented button[aria-pressed="true"]'));
    expect(pressed).toHaveLength(0);

    (row.querySelector('.segmented button[data-value="-."]') as HTMLButtonElement).click();
    const after = p.getSettings();
    expect(after.rc["lines.linestyle"]).toBe("-.");
    expect(Array.isArray(after.rc["axes.prop_cycle"])).toBe(true);
    expect(row.classList.contains("mixed")).toBe(false);
    p.remove();
  });
});


describe("every slider keeps its readout in sync while being dragged", () => {
  it("readout follows the value for each range input in every category, even when the range has focus", () => {
    const p = document.createElement("plotpolish-panel") as PlotpolishPanel;
    document.body.append(p);
    p.sink = new MemorySink("import matplotlib.pyplot as plt\n");
    p.open = true;
    let checked = 0;
    for (const group of GROUPS) {
      p.showCategory(group.id);
      const container = p.shadowRoot!.querySelector(`.group[data-group="${group.id}"]`) as HTMLElement;
      // Open "More" so the second tier's sliders are exercised too.
      const more = container.querySelector("button.more") as HTMLButtonElement | null;
      if (more && more.textContent!.includes("▸")) more.click();
      for (const range of Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'))) {
        const readout = (range.nextElementSibling?.classList.contains("readout")
          ? range.nextElementSibling
          : range.closest(".row")!.querySelector(".readout")) as HTMLElement | null;
        if (!readout) continue;
        const min = Number(range.min || 0);
        const step = Number(range.step || 1);
        const target = Number((min + 3 * step).toFixed(4));
        range.focus();
        range.value = String(target);
        range.dispatchEvent(new Event("input", { bubbles: true }));
        expect(Number(readout.textContent), `${group.id}: ${range.getAttribute("aria-label") ?? range.id}`).toBeCloseTo(target, 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
    p.remove();
  });
});

describe("two controls, one key: axes.prop_cycle", () => {
  // "Colors" (Look) and the per-line table (Lines) both write axes.prop_cycle.
  // Each declares in controls.json which parts of the value it owns, so a
  // category reset rewrites the key rather than deleting it and throwing the
  // other category's work away.
  const OKABE = CONTROLS.find((c) => c.id === "prop_cycle")!.presets!.find((p) => p.id === "okabe-ito")!;
  const DEFAULT_PALETTE = CONTROLS.find((c) => c.id === "prop_cycle")!.default as string[];

  function widthCells(p: PlotpolishPanel): HTMLInputElement[] {
    return Array.from(p.shadowRoot!.querySelectorAll<HTMLInputElement>("input.line-width"));
  }
  function setWidth(p: PlotpolishPanel, i: number, value: string): void {
    const cell = widthCells(p)[i]!;
    cell.value = value;
    fireInput(cell);
  }
  function pickPalette(p: PlotpolishPanel, id: string): void {
    (ctl(p, "prop_cycle").querySelector(`button.preset[data-preset="${id}"]`) as HTMLButtonElement).click();
  }
  function cycle(p: PlotpolishPanel): PropCycleValue | string[] | undefined {
    return p.getSettings().rc["axes.prop_cycle"] as PropCycleValue | string[] | undefined;
  }
  async function ready(p: PlotpolishPanel): Promise<MockBackend> {
    const backend = new MockBackend();
    await attachBackend(p, backend);
    p.sink = new MemorySink("");
    return backend;
  }

  it("Reset Lines keeps the palette chosen under Look", async () => {
    await ready(panel);
    openTab(panel, "look");
    pickPalette(panel, "okabe-ito");
    openTab(panel, "lines");
    setWidth(panel, 0, "8");

    groupReset(panel).click();

    // The per-line widths are gone; the colors the other category owns are not.
    const after = cycle(panel);
    expect(isPropCycle(after)).toBe(false);
    expect(after).toEqual(OKABE.colors);
  });

  it("Reset Look keeps the per-line widths, re-zipped to the palette it restores", async () => {
    await ready(panel);
    openTab(panel, "look");
    pickPalette(panel, "okabe-ito"); // eight colors
    openTab(panel, "lines");
    setWidth(panel, 1, "3");

    openTab(panel, "look");
    groupReset(panel).click();

    const after = cycle(panel);
    expect(isPropCycle(after)).toBe(true);
    const value = after as PropCycleValue;
    expect(value.color).toEqual(DEFAULT_PALETTE); // ten colors
    expect(value.linewidth![1]).toBe(3);
    // mpl.cycler zips equal-length lists, so the widths had to follow the
    // palette from eight entries to ten rather than be left short.
    expect(value.linewidth!.length).toBe(value.color.length);
  });

  it("a category's reset does not light up for the other category's work", async () => {
    await ready(panel);
    openTab(panel, "look");
    pickPalette(panel, "okabe-ito");
    openTab(panel, "lines");
    expect(groupReset(panel).hidden).toBe(true); // Lines owns nothing yet

    setWidth(panel, 0, "8");
    expect(groupReset(panel).hidden).toBe(false);
  });

  it("...and the same the other way round", async () => {
    await ready(panel);
    openTab(panel, "lines");
    setWidth(panel, 0, "8");
    openTab(panel, "look");
    expect(groupReset(panel).hidden).toBe(true); // Look owns no color change yet

    pickPalette(panel, "okabe-ito");
    expect(groupReset(panel).hidden).toBe(false);
  });

  it("reverting one control clears only its own parts", async () => {
    await ready(panel);
    openTab(panel, "look");
    pickPalette(panel, "okabe-ito");
    openTab(panel, "lines");
    setWidth(panel, 0, "8");

    // "Line width (all)" is a master over the table: setting it drops the
    // per-line widths and leaves the palette alone.
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "5";
    fireInput(lw);
    expect(cycle(panel)).toEqual(OKABE.colors);
  });

  it("Reset all still clears the whole key", async () => {
    await ready(panel);
    openTab(panel, "look");
    pickPalette(panel, "okabe-ito");
    openTab(panel, "lines");
    setWidth(panel, 0, "8");

    panel.reset();
    expect(cycle(panel)).toBeUndefined();
    expect(panel.getBlock()).toBeNull();
  });

  it("previews the rewritten cycle, not the baseline, so the figure matches the block", async () => {
    const backend = await ready(panel);
    openTab(panel, "look");
    pickPalette(panel, "okabe-ito");
    openTab(panel, "lines");
    setWidth(panel, 0, "8");
    await panel.settle();
    backend.calls.length = 0;

    groupReset(panel).click();
    await panel.settle();

    const applied = backend.calls.filter((c) => c.fn === "apply_live");
    expect(applied.length).toBe(1);
    const rc = (applied[0]!.args as { rc: Record<string, unknown> }).rc;
    // Sending the baseline palette here would repaint the lines with matplotlib
    // defaults while the block still says Okabe-Ito.
    expect(rc["axes.prop_cycle"]).toEqual(OKABE.colors);
  });
});

describe("the widgets agree with the schema that describes them", () => {
  // controls.json calls itself the single source of truth. It only is if the
  // rendering reads it: savefig_dpi carried min 36 / max 1200 for three
  // releases while the panel hardcoded 72-600, so the schema's numbers were
  // decoration and nothing noticed.
  it("renders every control's own min, max and step", () => {
    for (const spec of CONTROLS) {
      if (spec.min === undefined && spec.max === undefined) continue;
      const el = input(panel, spec.id) as HTMLInputElement;
      expect(el, spec.id).not.toBeNull();
      if (spec.min !== undefined) expect(`${spec.id}.min=${el.min}`).toBe(`${spec.id}.min=${spec.min}`);
      if (spec.max !== undefined) expect(`${spec.id}.max=${el.max}`).toBe(`${spec.id}.max=${spec.max}`);
      if (spec.step !== undefined) expect(`${spec.id}.step=${el.step}`).toBe(`${spec.id}.step=${spec.step}`);
    }
  });

  it("gives every slider its bounds in the schema rather than in the code", () => {
    const hardcoded = CONTROLS.filter((spec) => {
      const el = input(panel, spec.id) as HTMLInputElement | null;
      return el?.type === "range" && (spec.min === undefined || spec.max === undefined);
    });
    expect(hardcoded.map((c) => c.id)).toEqual([]);
  });

  // The row loop emits a subheading when spec.subgroup changes, so a control
  // with no subgroup lands under whichever heading came last -- "Minor grid
  // lines" spent a release under "Tick marks" -- and a subgroup interrupted by
  // another one would get a second heading.
  it("gives every control in a subgrouped group a subgroup, listed contiguously", () => {
    for (const g of GROUPS) {
      if (!g.subgroups) continue;
      const inGroup = CONTROLS.filter((c) => c.group === g.id);
      expect(inGroup.filter((c) => !c.subgroup).map((c) => c.id)).toEqual([]);

      const order = inGroup.map((c) => c.subgroup!);
      const runs = order.filter((sg, i) => i === 0 || sg !== order[i - 1]);
      expect(runs).toEqual([...new Set(order)]); // no subgroup appears twice
      expect(inGroup.map((c) => c.subgroup)).toEqual(
        inGroup.map((c) => g.subgroups!.find((sg) => sg.id === c.subgroup)?.id)
      ); // and every one names a subgroup the group declares
    }
  });

  it("renders each subgroup's rows under its own heading", () => {
    const seen: Record<string, string> = {};
    for (const g of GROUPS) {
      if (!g.subgroups) continue;
      const container = group(panel, g.id);
      let head = "";
      const walk = (node: HTMLElement): void => {
        for (const child of Array.from(node.children) as HTMLElement[]) {
          if (child.classList.contains("subhead")) head = child.textContent ?? "";
          else if (child.classList.contains("row") && child.dataset.control) seen[child.dataset.control] = head;
          else walk(child);
        }
      };
      walk(container);
    }
    // Primary-tier rows sit above the headings, so only the "More" rows carry one.
    expect(seen["minor_grid"]).toBe("Grid");
    expect(seen["grid_alpha"]).toBe("Grid");
    expect(seen["axes_linewidth"]).toBe("Box and axes lines");
    expect(seen["minor_ticks"]).toBe("Tick marks");
  });

  it("puts the fontsize thumb on a step the slider can hold, and the exact size beside it", () => {
    panel.sink = new MemorySink("");
    const fontSize = input(panel, "font_size") as HTMLInputElement;
    fontSize.value = "12";
    fireInput(fontSize);

    // "large" is 1.2 x base = 14.4, which a step-0.5 range cannot hold: a
    // browser stores 14.5. Say 14.5 ourselves rather than letting the element
    // silently disagree with the readout.
    const title = input(panel, "title_size") as HTMLInputElement;
    expect(title.value).toBe("14.5");
    expect(ctl(panel, "title_size").querySelector(".readout")!.textContent).toBe("14.4");
    expect(title.title).toContain("14.4");
    // And the block gets the exact size, not the snapped one.
    expect(panel.getSettings().rc["axes.titlesize"]).toBeUndefined();
    expect(panel.getBlock()).not.toContain("14.5");
  });
});

describe("auto-update: the student's own pause switch", () => {
  function autoBtn(p: PlotpolishPanel): HTMLButtonElement {
    return p.shadowRoot!.querySelector(".pill button.auto-update") as HTMLButtonElement;
  }

  it("sits in the pill, on by default, and says which way it is", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    // In the pill, not inside a category: a student reaches for it when a
    // change is about to be expensive, which is before they open anything.
    expect(autoBtn(panel)).not.toBeNull();
    expect(autoBtn(panel).hidden).toBe(false);
    expect(panel.autoUpdate).toBe(true);
    expect(autoBtn(panel).getAttribute("aria-pressed")).toBe("true");
    expect(autoBtn(panel).title).toContain("on");

    autoBtn(panel).click();
    expect(panel.autoUpdate).toBe(false);
    expect(autoBtn(panel).getAttribute("aria-pressed")).toBe("false");
    expect(autoBtn(panel).title).toContain("off");
  });

  it("is there before the interpreter is, and hidden only when the host says never", async () => {
    // The backend arrives when the student first runs, so keying this to the
    // backend hid it for exactly as long as it was useful: someone about to
    // start a long computation reaches for this BEFORE running, not after.
    expect(autoBtn(panel).hidden).toBe(false);
    expect(panel.autoUpdate).toBe(true);

    panel.features = { livePreview: false };
    expect(autoBtn(panel).hidden).toBe(true); // the host declared it cannot preview
    await attachBackend(panel, new MockBackend());
    expect(autoBtn(panel).hidden).toBe(true); // ...and a backend does not change that
  });

  it("announces the change, so a host can stop its own auto-re-run too", async () => {
    // The demo (and Trinket) re-run the program when the panel reports keys
    // pending a re-run. A paused panel marks EVERY change that way, so without
    // this event pausing made the host re-run more, not less -- the opposite of
    // what the student asked for, on the host where it matters most.
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    const seen: boolean[] = [];
    panel.addEventListener("plotpolish-auto-update", (e) =>
      seen.push((e as CustomEvent<AutoUpdateEventDetail>).detail.autoUpdate)
    );

    autoBtn(panel).click();
    expect(seen).toEqual([false]);
    autoBtn(panel).click();
    expect(seen).toEqual([false, true]);
  });

  it("shows a word, not just a glyph, and shouts when it is off", async () => {
    await attachBackend(panel, new MockBackend());
    const btn = autoBtn(panel);
    expect(btn.textContent).toContain("Auto");
    expect(btn.querySelector(".glyph")).not.toBeNull();
    expect(btn.querySelector(".glyph")!.getAttribute("aria-hidden")).toBe("true");

    expect(btn.classList.contains("off")).toBe(false);
    btn.click();
    // "off" is the state a student needs to notice: it is why the figure
    // stopped following them.
    expect(btn.classList.contains("off")).toBe(true);
  });

  it("remembers a pause made before the interpreter arrived", async () => {
    // Pausing on a blank page has to still be in force once Pyodide finishes
    // loading, or the setting is lost at precisely the moment it starts to matter.
    autoBtn(panel).click();
    expect(panel.autoUpdate).toBe(false);

    const backend = new MockBackend();
    await attachBackend(panel, backend);
    panel.sink = new MemorySink("");
    backend.calls.length = 0;

    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "5";
    fireInput(lw);
    await panel.settle();

    expect(panel.autoUpdate).toBe(false);
    expect(backend.calls.some((c) => c.fn === "apply_live")).toBe(false);
    expect(ctl(panel, "linewidth").querySelector(".badge.rerun")).not.toBeNull();
  });

  it("stops applying and marks the changes instead", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    panel.sink = new MemorySink("");
    autoBtn(panel).click();
    backend.calls.length = 0;

    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "5";
    fireInput(lw);
    await panel.settle();

    expect(backend.calls.some((c) => c.fn === "apply_live")).toBe(false);
    // The block still gets it -- pausing the preview is not pausing the tool.
    expect(panel.getSettings().rc["lines.linewidth"]).toBe(5);
    expect(ctl(panel, "linewidth").querySelector(".badge.rerun")).not.toBeNull();
  });

  it("catches the figure up when it is switched back on", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    panel.sink = new MemorySink("");
    autoBtn(panel).click();

    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "5";
    fireInput(lw);
    (input(panel, "grid") as HTMLInputElement).checked = true;
    change(input(panel, "grid"));
    await panel.settle();
    backend.calls.length = 0;

    autoBtn(panel).click();
    await panel.settle();

    const applied = backend.calls.filter((c) => c.fn === "apply_live");
    expect(applied.length).toBe(1);
    const rc = (applied[0]!.args as { rc: Record<string, unknown> }).rc;
    expect(rc["lines.linewidth"]).toBe(5);
    expect(rc["axes.grid"]).toBe(true);
    // ...and the marks go, because the figure is no longer behind.
    expect(ctl(panel, "linewidth").querySelector(".badge.rerun")).toBeNull();
  });

  it("still reports a style as pending after catching up, because a style needs the run", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    panel.sink = new MemorySink("");
    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);
    await panel.settle();

    autoBtn(panel).click();
    autoBtn(panel).click();
    await panel.settle();
    expect(ctl(panel, "style").querySelector(".badge.rerun")).not.toBeNull();
  });

  it("does not re-apply the overrides a style change would, while paused", async () => {
    // applyStyle used to read features.livePreview directly rather than
    // canPreview. With only a host-level flag those were the same condition;
    // with a switch the student can throw, they are not.
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    panel.sink = new MemorySink("");
    autoBtn(panel).click();
    backend.calls.length = 0;

    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);
    await panel.settle();

    // set_style still runs: it moves the baseline and never redraws.
    expect(backend.calls.some((c) => c.fn === "set_style")).toBe(true);
    expect(backend.calls.some((c) => c.fn === "apply_live")).toBe(false);
  });
});

describe("Save PNG", () => {
  function saveBtn(p: PlotpolishPanel): HTMLButtonElement {
    return input(p, "save_png") as HTMLButtonElement;
  }
  function said(p: PlotpolishPanel): string {
    return (ctl(p, "save_png").querySelector(".copy-said") as HTMLElement).textContent ?? "";
  }

  it("saves through matplotlib's savefig, not the on-screen canvas", async () => {
    // The Save category's three keys change what comes out of a FILE. Nothing
    // in the tool produced one, so they had no observable effect at all -- and
    // a host that grabs the canvas instead (Trinket's worker figure does) gets
    // a screen-resolution PNG and none of them.
    const backend = new MockBackend();
    backend.figure = figureWithLines(2);
    await attachBackend(panel, backend);
    openTab(panel, "save");
    backend.calls.length = 0;

    const saved: SavedEventDetail[] = [];
    panel.addEventListener("plotpolish-saved", (e) =>
      saved.push((e as CustomEvent<SavedEventDetail>).detail)
    );

    saveBtn(panel).click();
    await flush();

    expect(backend.calls.map((c) => c.fn)).toContain("save_figure");
    expect(saved.length).toBe(1);
    expect(saved[0]!.format).toBe("png");
    expect(saved[0]!.filename).toBe("plot.png");
    expect(saved[0]!.bytes).toBeGreaterThan(0);
  });

  it("lets a host take the bytes instead, for an iframe that blocks downloads", async () => {
    // Trinket runs the embed in an iframe, which is exactly where a page-driven
    // download gets refused -- the trap Copy code already fell into. The event
    // is cancelable so the host can deliver the file its own way.
    const backend = new MockBackend();
    backend.figure = figureWithLines(1);
    await attachBackend(panel, backend);
    openTab(panel, "save");

    let handled = false;
    panel.addEventListener("plotpolish-saved", (e) => {
      handled = true;
      e.preventDefault();
    });

    saveBtn(panel).click();
    await flush();
    expect(handled).toBe(true);
    expect(said(panel)).toBe("Saved");
  });

  it("says what to do when there is no interpreter, rather than failing quietly", () => {
    openTab(panel, "save");
    saveBtn(panel).click();
    expect(said(panel)).toBe("Run your code first");
  });

  it("says so when the interpreter has no figure", async () => {
    const backend = new MockBackend();
    backend.figure = null;
    await attachBackend(panel, backend);
    openTab(panel, "save");

    saveBtn(panel).click();
    await flush();
    expect(said(panel)).toBe("No figure to save");
  });

  it("reports a backend failure instead of swallowing it", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLines(1);
    await attachBackend(panel, backend);
    openTab(panel, "save");
    const errors: PanelErrorEventDetail[] = [];
    panel.addEventListener("plotpolish-error", (e) =>
      errors.push((e as CustomEvent<PanelErrorEventDetail>).detail)
    );

    backend.failNext = "no space left on device";
    saveBtn(panel).click();
    await flush();

    expect(said(panel)).toBe("Save failed");
    expect(errors.map((e) => e.context)).toContain("save_figure");
    expect(saveBtn(panel).disabled).toBe(false); // usable again
  });
});
