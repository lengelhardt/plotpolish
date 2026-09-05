/**
 * Tests for <plotpolish-panel>. Importing "./panel" registers the custom
 * element (registerPanel() runs at module load); each test creates a fresh
 * instance, appends it to document.body, and removes it afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AxesDescription, FigureDescription } from "./backend";
import {
  defaultSettings, FenceError, generateBlock, parseBlock, type StyleSettings,
} from "./block";
import { ELEMENT_TAG, FENCE_START } from "./constants";
import {
  PlotpolishPanel, type ChangeEventDetail, type PanelErrorEventDetail, type RerunNeededEventDetail,
} from "./panel";
import { CONTROLS, GROUPS } from "./schema";
import { MemorySink, type CodeSink } from "./sink";
import { MockBackend } from "./testing/mock-backend";

function ctl(panel: PlotpolishPanel, id: string): HTMLElement {
  // ".row" scopes this to the control's row: change-chips in "Your changes"
  // also carry data-control, and (since .home precedes the categories in the
  // DOM) would otherwise shadow the row in document order.
  return panel.shadowRoot!.querySelector(`.row[data-control="${id}"]`) as HTMLElement;
}

function input(panel: PlotpolishPanel, id: string): HTMLElement {
  return panel.shadowRoot!.querySelector(`#ctl-${id}`) as HTMLElement;
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

  it("creates a category per group, tagged with data-group, in schema order", () => {
    const categories = panel.shadowRoot!.querySelectorAll(".category[data-group]");
    expect(categories.length).toBe(GROUPS.length);
    const ids = Array.from(categories).map((s) => (s as HTMLElement).dataset.group);
    expect(ids).toEqual(GROUPS.map((g) => g.id));
  });

  it("tells the user their own code always wins", () => {
    const note = panel.shadowRoot!.querySelector(".home .note")!;
    expect(note.textContent).toContain("Your own code always wins");
  });
});

describe("shell: collapsed / expanded", () => {
  it("is collapsed by default and shows the bar, not the body", () => {
    expect(panel.open).toBe(false);
    expect(panel.hasAttribute("open")).toBe(false);
    expect((panel.shadowRoot!.querySelector(".bar") as HTMLElement).hidden).toBe(false);
    expect((panel.shadowRoot!.querySelector(".body") as HTMLElement).hidden).toBe(true);
  });

  it("toggle opens the panel and reflects the open attribute", () => {
    panel.toggle();
    expect(panel.open).toBe(true);
    expect(panel.hasAttribute("open")).toBe(true);
    expect((panel.shadowRoot!.querySelector(".bar") as HTMLElement).hidden).toBe(true);
    expect((panel.shadowRoot!.querySelector(".body") as HTMLElement).hidden).toBe(false);
  });

  it("shows chips in schema order once open", () => {
    panel.toggle();
    const chips = Array.from(panel.shadowRoot!.querySelectorAll(".chips .chip")) as HTMLElement[];
    expect(chips.map((c) => c.dataset.group)).toEqual(GROUPS.map((g) => g.id));
  });

  it("showCategory shows that group's rows, hides others, and updates the breadcrumb; Back returns to level one", () => {
    panel.toggle();
    panel.showCategory("text");
    expect(panel.category).toBe("text");

    const crumbLabel = panel.shadowRoot!.querySelector(".crumb-label")!;
    expect(crumbLabel.textContent).toBe("Style › Text");

    const textCat = panel.shadowRoot!.querySelector('.category[data-group="text"]') as HTMLElement;
    const lookCat = panel.shadowRoot!.querySelector('.category[data-group="look"]') as HTMLElement;
    expect(textCat.hidden).toBe(false);
    expect(lookCat.hidden).toBe(true);
    expect((panel.shadowRoot!.querySelector(".home") as HTMLElement).hidden).toBe(true);

    const back = panel.shadowRoot!.querySelector(".back") as HTMLButtonElement;
    expect(back.hidden).toBe(false);
    back.click();

    expect(panel.category).toBeNull();
    expect(crumbLabel.textContent).toBe("Style");
    expect((panel.shadowRoot!.querySelector(".home") as HTMLElement).hidden).toBe(false);
  });

  it("keeps primary rows outside details.more and puts tier=more rows inside it", () => {
    const axesCat = panel.shadowRoot!.querySelector('.category[data-group="axes"]') as HTMLElement;
    const primary = axesCat.querySelector(".primary")!;
    const more = axesCat.querySelector("details.more")!;
    expect(primary.querySelector('[data-control="grid"]')).not.toBeNull();
    expect(primary.querySelector('[data-control="box"]')).not.toBeNull();
    expect(primary.querySelector('[data-control="grid_alpha"]')).toBeNull();
    expect(more.querySelector('[data-control="grid_alpha"]')).not.toBeNull();
    expect(more.querySelector('[data-control="tick_direction"]')).not.toBeNull();
    expect(more.querySelector('[data-control="grid"]')).toBeNull();
  });

  it("has no details.more for Save, which has no tier=more controls", () => {
    const saveCat = panel.shadowRoot!.querySelector('.category[data-group="save"]') as HTMLElement;
    expect(saveCat.querySelector("details.more")).toBeNull();
  });

  it("shows subgroup headings within Axes, for subgroups that have rows in that section", () => {
    const axesCat = panel.shadowRoot!.querySelector('.category[data-group="axes"]') as HTMLElement;
    const headings = Array.from(axesCat.querySelectorAll("h4.subgroup")).map((h) => h.textContent);
    expect(headings).toContain("Grid");
    expect(headings).toContain("Box and axes lines");
    expect(headings).toContain("Tick marks");
    // "Tick marks" has no primary-tier rows, so it must not head the primary section.
    const primaryHeadings = Array.from(axesCat.querySelectorAll(".primary h4.subgroup")).map((h) => h.textContent);
    expect(primaryHeadings).not.toContain("Tick marks");
  });

  it('shows a muted "nothing changed" line at first, and lists "Your changes" chips once something is set', () => {
    const empty = panel.shadowRoot!.querySelector(".changes .muted") as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain("Nothing changed yet");

    const sink = new MemorySink("");
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    change(fs);

    expect(empty.hidden).toBe(true);
    const chip = panel.shadowRoot!.querySelector('.change-chip[data-control="font_size"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("✕");

    chip.click();
    expect(panel.getSettings().rc["font.size"]).toBeUndefined();
    expect(empty.hidden).toBe(false);
  });

  it("shows a style chip in Your changes when style is non-default, and the ✕ resets it", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);

    const chip = panel.shadowRoot!.querySelector('.change-chip[data-control="style"]') as HTMLButtonElement;
    expect(chip.textContent).toBe("Style preset: ggplot ✕");
    chip.click();
    expect(panel.getSettings().style).toBe("default");
  });

  it("Reset <Group> clears only that group's keys, and is disabled when nothing is set", () => {
    const sink = new MemorySink("");
    panel.sink = sink;

    const textCat = panel.shadowRoot!.querySelector('.category[data-group="text"]') as HTMLElement;
    const resetBtn = textCat.querySelector(".reset-category") as HTMLButtonElement;
    expect(resetBtn.textContent).toBe("Reset Text");
    expect(resetBtn.disabled).toBe(true);

    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    change(fs);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "3";
    change(lw);

    expect(resetBtn.disabled).toBe(false);
    resetBtn.click();

    expect(panel.getSettings().rc["font.size"]).toBeUndefined();
    expect(panel.getSettings().rc["lines.linewidth"]).toBe(3);
  });

  it("Reset Look also resets the style preset", async () => {
    const backend = new MockBackend();
    await attachBackend(panel, backend);
    const select = input(panel, "style") as HTMLSelectElement;
    select.value = "ggplot";
    change(select);

    const lookCat = panel.shadowRoot!.querySelector('.category[data-group="look"]') as HTMLElement;
    const resetBtn = lookCat.querySelector(".reset-category") as HTMLButtonElement;
    resetBtn.click();

    expect(panel.getSettings().style).toBe("default");
  });

  it("Esc goes back to level one, then collapses (when collapsible)", () => {
    panel.toggle();
    panel.showCategory("text");

    const body = panel.shadowRoot!.querySelector(".body") as HTMLElement;
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(panel.category).toBeNull();
    expect(panel.open).toBe(true);

    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(panel.open).toBe(false);
  });

  it("renders no bar when features.collapsible is false, and stays open", () => {
    panel.features = { collapsible: false };
    expect(panel.shadowRoot!.querySelector(".bar")).toBeNull();
    expect((panel.shadowRoot!.querySelector(".body") as HTMLElement).hidden).toBe(false);
  });

  it("starts open when features.startOpen is true", () => {
    const p = document.createElement("plotpolish-panel") as PlotpolishPanel;
    p.features = { startOpen: true };
    document.body.append(p);
    expect(p.open).toBe(true);
    p.remove();
  });

  it("only shows chips for groups listed in features.groups", () => {
    panel.features = { groups: ["text"] };
    const chips = Array.from(panel.shadowRoot!.querySelectorAll(".chips .chip")) as HTMLElement[];
    for (const chip of chips) expect(chip.hidden).toBe(chip.dataset.group !== "text");
  });

  it("hides the code details when features.showCode is false", () => {
    panel.features = { showCode: false };
    const details = panel.shadowRoot!.querySelector("details.code") as HTMLDetailsElement;
    expect(details.hidden).toBe(true);
  });
});

describe("legend group visibility", () => {
  it("shows the legend chip before any refresh, and with no backend", () => {
    const chip = panel.shadowRoot!.querySelector('.chip[data-group="legend"]') as HTMLElement;
    expect(chip.hidden).toBe(false);
  });

  it("hides the legend chip after refresh finds no legend and nothing is set", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLegend(null);
    await attachBackend(panel, backend);
    const chip = panel.shadowRoot!.querySelector('.chip[data-group="legend"]') as HTMLElement;
    expect(chip.hidden).toBe(true);
  });

  it("keeps the legend chip shown (with a note) when a legend key is set despite no legend", async () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const backend = new MockBackend();
    backend.figure = figureWithLegend(null);
    await attachBackend(panel, backend);

    const frameon = input(panel, "legend_frameon") as HTMLInputElement;
    frameon.checked = false;
    change(frameon);

    const chip = panel.shadowRoot!.querySelector('.chip[data-group="legend"]') as HTMLElement;
    expect(chip.hidden).toBe(false);

    panel.showCategory("legend");
    const note = panel.shadowRoot!.querySelector('.category[data-group="legend"] > .note') as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("no legend");
  });

  it("shows the legend chip again once the figure is null", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLegend(null);
    await attachBackend(panel, backend);
    backend.figure = null;
    await panel.refresh();
    const chip = panel.shadowRoot!.querySelector('.chip[data-group="legend"]') as HTMLElement;
    expect(chip.hidden).toBe(false);
  });

  it("shows the legend chip when at least one axes has a legend", async () => {
    const backend = new MockBackend();
    backend.figure = figureWithLegend({ frameon: true, framealpha: 0.8, loc: "best", fontsize: 10 });
    await attachBackend(panel, backend);
    const chip = panel.shadowRoot!.querySelector('.chip[data-group="legend"]') as HTMLElement;
    expect(chip.hidden).toBe(false);
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

  it("gives default settings and an empty block for a source without a fence", () => {
    panel.sink = new MemorySink("print('hi')\n");
    expect(panel.getSettings()).toEqual(defaultSettings());
    expect(panel.getBlock()).toBeNull();
  });

  it("flags a fence with two start markers as an error and blocks writes while it persists", () => {
    const src = [
      FENCE_START, FENCE_START, "import matplotlib as mpl",
      "mpl.rcParams.update({", '    "font.size": 12,', "})", "# --- end plot style ---",
      "print('kept')",
    ].join("\n");
    const sink = new MemorySink(src);
    panel.sink = sink;

    expect(panel.currentFenceError).toBeInstanceOf(FenceError);
    const banner = panel.shadowRoot!.querySelector(".banner.error") as HTMLElement;
    expect(banner.hidden).toBe(false);

    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    expect(sink.writes.length).toBe(0);
    expect(panel.currentFenceError).toBeInstanceOf(FenceError);
  });

  it("clicking Replace block rewrites the source into exactly one valid fence and clears the error", () => {
    const src = [
      FENCE_START, FENCE_START, "import matplotlib as mpl",
      "mpl.rcParams.update({", '    "font.size": 12,', "})", "# --- end plot style ---",
      "print('kept')",
    ].join("\n");
    const sink = new MemorySink(src);
    panel.sink = sink;

    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);
    expect(sink.writes.length).toBe(0); // still blocked

    const banner = panel.shadowRoot!.querySelector(".banner.error") as HTMLElement;
    const replaceButton = banner.querySelector("button") as HTMLButtonElement;
    replaceButton.click();

    expect(sink.writes.length).toBe(1);
    expect(panel.currentFenceError).toBeNull();
    expect(banner.hidden).toBe(true);
    const finalSrc = sink.writes[0]!;
    expect(finalSrc.split(FENCE_START).length - 1).toBe(1);
    expect(finalSrc).toContain("print('kept')");
    expect(parseBlock(finalSrc)!.settings.rc).toEqual({ "axes.grid": true });
  });
});

describe("writing", () => {
  const userSrc = "import numpy as np\nimport matplotlib.pyplot as plt\n\nplt.plot([1, 2], [3, 4])\nplt.show()\n";

  it("writes the source once when changing font_size, leaving user lines untouched", () => {
    const sink = new MemorySink(userSrc);
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    change(fs);

    expect(sink.writes.length).toBe(1);
    const src1 = sink.writes[0]!;
    expect(parseBlock(src1)!.settings.rc).toEqual({ "font.size": 14 });
    expect(src1.endsWith(userSrc)).toBe(true);
  });

  it("replaces the fence on a second change; still exactly one fence", () => {
    const sink = new MemorySink(userSrc);
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    change(fs);
    fs.value = "16";
    change(fs);

    expect(sink.writes.length).toBe(2);
    const src2 = sink.writes[1]!;
    expect(src2.split(FENCE_START).length - 1).toBe(1);
    expect(parseBlock(src2)!.settings.rc).toEqual({ "font.size": 16 });
  });

  it("reverting the only set key removes it, and the fence disappears once settings are default", () => {
    const sink = new MemorySink(userSrc);
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    change(fs);

    const revertBtn = ctl(panel, "font_size").querySelector(".revert") as HTMLButtonElement;
    expect(revertBtn.hidden).toBe(false);
    revertBtn.click();

    const last = sink.writes[sink.writes.length - 1]!;
    expect(last).not.toContain(FENCE_START);
    expect(last).toContain("plt.show()");
    expect(panel.getSettings()).toEqual(defaultSettings());
  });

  it("Reset all clears every setting and removes the fence", () => {
    const sink = new MemorySink(userSrc);
    panel.sink = sink;
    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    change(fs);
    const grid = input(panel, "grid") as HTMLInputElement;
    grid.checked = true;
    change(grid);

    const resetButton = panel.shadowRoot!.querySelector(".bar .reset") as HTMLButtonElement;
    resetButton.click();

    expect(panel.getSettings()).toEqual(defaultSettings());
    const last = sink.writes[sink.writes.length - 1]!;
    expect(last).not.toContain(FENCE_START);
  });

  it("writes a pair control as [w, h]", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const inputs = ctl(panel, "figsize").querySelectorAll("input");
    (inputs[0] as HTMLInputElement).value = "8";
    (inputs[1] as HTMLInputElement).value = "5";
    change(inputs[1]!);

    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["figure.figsize"]).toEqual([8, 5]);
  });

  it("writes a segmented enum control as its string value (linestyle --)", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const seg = ctl(panel, "linestyle").querySelector(".segmented") as HTMLElement;
    const btn = seg.querySelector('button[data-value="--"]') as HTMLButtonElement;
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
  });

  it("writes 'figure' when the dpi field is cleared", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const dpi = input(panel, "savefig_dpi") as HTMLInputElement;
    dpi.value = "150";
    change(dpi);
    dpi.value = "";
    change(dpi);

    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["savefig.dpi"]).toBe("figure");
  });

  it("writes the preset colors for a colorcycle preset button and shows swatches", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const list = ctl(panel, "prop_cycle").querySelector(".swatch-list") as HTMLElement;
    const btn = list.querySelector('button[data-preset="okabe-ito"]') as HTMLButtonElement;
    btn.click();

    const expected = CONTROLS.find((c) => c.id === "prop_cycle")!.presets!.find((p) => p.id === "okabe-ito")!.colors;
    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["axes.prop_cycle"]).toEqual(expected);
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    const swatches = btn.querySelectorAll(".swatches i");
    expect(swatches.length).toBe(expected.length);
    expect(Array.from(swatches).map((s) => (s as HTMLElement).title)).toEqual(expected);
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

  it("keeps a range slider and its number field linked for linewidth, and commits on input", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const row = ctl(panel, "linewidth");
    const range = row.querySelector('input[type="range"]') as HTMLInputElement;
    const number = input(panel, "linewidth") as HTMLInputElement;

    range.value = "3";
    fireInput(range);

    expect(number.value).toBe("3");
    expect(panel.getSettings().rc["lines.linewidth"]).toBe(3);
  });
});

describe("legend position", () => {
  it("named option writes the string value", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const select = input(panel, "legend_loc") as HTMLSelectElement;
    select.value = "upper right";
    change(select);

    expect(panel.getSettings().rc["legend.loc"]).toBe("upper right");
    expect((panel.shadowRoot!.querySelector(".legend-xy") as HTMLElement).hidden).toBe(true);
  });

  it("'Custom position…' writes [0.6, 0.2] and reveals the sliders", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const select = input(panel, "legend_loc") as HTMLSelectElement;
    select.value = "__custom__";
    change(select);

    expect(panel.getSettings().rc["legend.loc"]).toEqual([0.6, 0.2]);
    expect(select.value).toBe("__custom__");
    expect((panel.shadowRoot!.querySelector(".legend-xy") as HTMLElement).hidden).toBe(false);
  });

  it("dragging a slider writes [x, y]", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const select = input(panel, "legend_loc") as HTMLSelectElement;
    select.value = "__custom__";
    change(select);

    const xRange = panel.shadowRoot!.querySelector('.legend-xy input[aria-label="Legend x"]') as HTMLInputElement;
    xRange.value = "0.3";
    fireInput(xRange);

    const rc = panel.getSettings().rc["legend.loc"];
    expect(rc).toEqual([0.3, 0.2]);
  });

  it("shows __custom__ selected for an array legend.loc value", () => {
    const settings: StyleSettings = { style: "default", rc: { "legend.loc": [0.4, 0.5] } };
    panel.sink = new MemorySink(generateBlock(settings)!);

    const select = input(panel, "legend_loc") as HTMLSelectElement;
    expect(select.value).toBe("__custom__");
    expect((panel.shadowRoot!.querySelector(".legend-xy") as HTMLElement).hidden).toBe(false);
  });
});

describe("badges", () => {
  it("shows a plain badge for save-category controls and a rerun badge for rerun-category controls", () => {
    panel.sink = new MemorySink("");
    expect(ctl(panel, "savefig_dpi").querySelector(".badge")!.textContent).toBe("applies when saving");
    expect(ctl(panel, "font_family").querySelector(".badge.rerun")!.textContent).toBe("re-run to see");
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

  it("shows the error banner when an external edit makes the fence malformed", () => {
    const src = generateBlock({ style: "default", rc: { "lines.linewidth": 2 } })!;
    const sink = new MemorySink(src);
    panel.sink = sink;

    sink.externalEdit(`${FENCE_START}\n${src}`);
    const banner = panel.shadowRoot!.querySelector(".banner.error") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(panel.currentFenceError).toBeInstanceOf(FenceError);
  });

  it("does not re-trigger a reload loop from the panel's own writes", () => {
    const userSrc = "x = 1\n";
    let sink!: MemorySink;
    sink = new MemorySink(userSrc, (s) => sink.externalEdit(s));
    panel.sink = sink;

    const fs = input(panel, "font_size") as HTMLInputElement;
    fs.value = "14";
    change(fs);

    expect(sink.writes.length).toBe(1);
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
    change(fs);

    expect(sink.received.length).toBe(1);
    expect(sink.received[0]).toBe(generateBlock({ style: "default", rc: { "font.size": 14 } }));
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
    change(fs);
    const resetButton = panel.shadowRoot!.querySelector(".bar .reset") as HTMLButtonElement;
    resetButton.click();

    expect(sink.received[sink.received.length - 1]).toBe("");
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

  it("mentions Live preview in the status line once ready", async () => {
    await attachBackend(panel, backend);
    const status = panel.shadowRoot!.querySelector(".status")!;
    expect(status.textContent).toContain("Live preview");
  });

  it("shows a user badge for keys the mock reports as overridden", async () => {
    backend.overridden = ["axes.grid"];
    await attachBackend(panel, backend);
    expect(ctl(panel, "grid").querySelector(".badge.user")).not.toBeNull();
  });

  it("produces exactly one apply_live call after changing a live control, once settled", async () => {
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "3";
    change(lw);
    await panel.settle();

    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toEqual({ rc: { "lines.linewidth": 3 }, only_defaults: true, previous: { "lines.linewidth": 1.5 } });
  });

  it("coalesces two rapid changes to different controls into one apply_live call", async () => {
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    const ms = input(panel, "markersize") as HTMLInputElement;
    lw.value = "4";
    change(lw);
    ms.value = "10";
    change(ms);
    await panel.settle();

    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toEqual({
      rc: { "lines.linewidth": 4, "lines.markersize": 10 },
      only_defaults: true,
      previous: { "lines.linewidth": 1.5, "lines.markersize": 6 },
    });
  });

  it("does not call apply_live for a rerun-category control, and dispatches rerun-needed", async () => {
    await attachBackend(panel, backend);
    const events: RerunNeededEventDetail[] = [];
    panel.addEventListener("plotpolish-rerun-needed", (e) => events.push((e as CustomEvent<RerunNeededEventDetail>).detail));

    const seg = ctl(panel, "font_family").querySelector(".segmented") as HTMLElement;
    const serifBtn = seg.querySelector('button[data-value="serif"]') as HTMLButtonElement;
    serifBtn.click();
    await panel.settle();

    expect(backend.calls.some((c) => c.fn === "apply_live")).toBe(false);
    const rerunBanner = panel.shadowRoot!.querySelectorAll(".banner.warn")[0] as HTMLElement;
    expect(rerunBanner.hidden).toBe(false);
    expect(events.some((e) => e.keys.includes("font.family"))).toBe(true);
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
    expect(panel.getSettings().rc).toEqual({});
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
    change(lw);
    await panel.settle();
    expect(backend.calls.filter((c) => c.fn === "apply_live").length).toBe(1);

    const styleSelect = input(panel, "style") as HTMLSelectElement;
    styleSelect.value = "ggplot";
    change(styleSelect);
    await flush();
    await panel.settle();

    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    expect(calls.length).toBe(2);
    expect(calls[1]!.args).toEqual({ rc: { "lines.linewidth": 5 }, only_defaults: true, previous: { "lines.linewidth": 5 } });
  });

  it("reverting a key applies the baseline value", async () => {
    backend.rc["lines.linewidth"] = 3;
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "7";
    change(lw);
    await panel.settle();

    const revertBtn = ctl(panel, "linewidth").querySelector(".revert") as HTMLButtonElement;
    revertBtn.click();
    await panel.settle();

    const calls = backend.calls.filter((c) => c.fn === "apply_live");
    const last = calls[calls.length - 1]!;
    expect(last.args).toEqual({ rc: { "lines.linewidth": 3 }, only_defaults: true, previous: { "lines.linewidth": 7 } });
    expect(panel.getSettings().rc["lines.linewidth"]).toBeUndefined();
  });

  it("surfaces a backend error from apply_live in the status and as an event", async () => {
    await attachBackend(panel, backend);
    const events: PanelErrorEventDetail[] = [];
    panel.addEventListener("plotpolish-error", (e) => events.push((e as CustomEvent<PanelErrorEventDetail>).detail));

    backend.failNext = "boom";
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "9";
    change(lw);
    await panel.settle();

    expect(panel.shadowRoot!.querySelector(".status")!.textContent).toContain("Backend error");
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

    expect(panel.shadowRoot!.querySelector(".status")!.textContent).toContain("Backend error");
    expect(events.length).toBe(1);
    expect(events[0]!.context).toBe("refresh");
  });

  it("keeps the panel usable for writing when the interpreter rejects during refresh", async () => {
    backend.rejectWith = new Error("dead");
    panel.backend = backend;
    await panel.refresh();
    expect(panel.shadowRoot!.querySelector(".status")!.textContent).toContain("Backend error");

    const sink = new MemorySink("");
    panel.sink = sink;
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "9";
    change(lw);
    expect(sink.writes.length).toBe(1);
    await panel.settle();
  });

  it("makes no apply_live calls when features.livePreview is false", async () => {
    panel.features = { livePreview: false };
    await attachBackend(panel, backend);
    const lw = input(panel, "linewidth") as HTMLInputElement;
    lw.value = "11";
    change(lw);
    await panel.settle();

    expect(backend.calls.some((c) => c.fn === "apply_live")).toBe(false);
  });
});

describe("fontsize display", () => {
  it("shows the resolved pt value for a relative default, mentioning the name in the title", () => {
    const titleInput = input(panel, "title_size") as HTMLInputElement;
    expect(titleInput.value).toBe("12");
    expect(titleInput.title).toContain("large");
  });

  it("recomputes the display when the base font size changes", () => {
    const fontSizeInput = input(panel, "font_size") as HTMLInputElement;
    fontSizeInput.value = "20";
    change(fontSizeInput);

    const titleInput = input(panel, "title_size") as HTMLInputElement;
    expect(titleInput.value).toBe("24");
  });

  it("never writes axes.titlesize to the generated code for a relative default", () => {
    const fontSizeInput = input(panel, "font_size") as HTMLInputElement;
    fontSizeInput.value = "20";
    change(fontSizeInput);

    const code = panel.shadowRoot!.querySelector("details.code pre")!.textContent;
    expect(code).not.toContain("axes.titlesize");
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
    change(fs);

    expect(events.length).toBe(1);
    expect(events[0]!.settings.rc).toEqual({ "font.size": 14 });
    expect(events[0]!.block).toBe(generateBlock({ style: "default", rc: { "font.size": 14 } }));
    expect(events[0]!.source).toBe(sink.getSource());
  });
});
