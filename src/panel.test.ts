/**
 * Tests for <plotpolish-panel>. Importing "./panel" registers the custom
 * element (registerPanel() runs at module load); each test creates a fresh
 * instance, appends it to document.body, and removes it afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  return panel.shadowRoot!.querySelector(`[data-control="${id}"]`) as HTMLElement;
}

function input(panel: PlotpolishPanel, id: string): HTMLElement {
  return panel.shadowRoot!.querySelector(`#ctl-${id}`) as HTMLElement;
}

function change(el: Element): void {
  el.dispatchEvent(new Event("change"));
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

  it("creates a section per group, tagged with data-group", () => {
    const sections = panel.shadowRoot!.querySelectorAll("section[data-group]");
    expect(sections.length).toBe(GROUPS.length);
    const ids = Array.from(sections).map((s) => (s as HTMLElement).dataset.group);
    expect(ids).toEqual(GROUPS.map((g) => g.id));
  });

  it("tells the user their own code always wins", () => {
    const note = panel.shadowRoot!.querySelector(".note")!;
    expect(note.textContent).toContain("Your own code always wins");
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

    const resetButton = panel.shadowRoot!.querySelector(".toolbar button") as HTMLButtonElement;
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

  it("writes an enum control as its string value", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const select = input(panel, "linestyle") as HTMLSelectElement;
    select.value = "--";
    change(select);

    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["lines.linestyle"]).toBe("--");
  });

  it("writes a bool control as a boolean", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const checkbox = input(panel, "savefig_transparent") as HTMLInputElement;
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

  it("writes the preset colours for a colorcycle selection and shows swatches", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const select = input(panel, "prop_cycle") as HTMLSelectElement;
    select.value = "okabe-ito";
    change(select);

    const expected = CONTROLS.find((c) => c.id === "prop_cycle")!.presets!.find((p) => p.id === "okabe-ito")!.colors;
    const last = sink.writes[sink.writes.length - 1]!;
    expect(parseBlock(last)!.settings.rc["axes.prop_cycle"]).toEqual(expected);

    const swatches = ctl(panel, "prop_cycle").querySelectorAll(".swatches i");
    expect(swatches.length).toBe(expected.length);
    expect(Array.from(swatches).map((s) => (s as HTMLElement).title)).toEqual(expected);
  });

  it("writes both tick_direction keys from one enum control", () => {
    const sink = new MemorySink("");
    panel.sink = sink;
    const select = input(panel, "tick_direction") as HTMLSelectElement;
    select.value = "in";
    change(select);

    const last = sink.writes[sink.writes.length - 1]!;
    const rc = parseBlock(last)!.settings.rc;
    expect(rc["xtick.direction"]).toBe("in");
    expect(rc["ytick.direction"]).toBe("in");
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
    const resetButton = panel.shadowRoot!.querySelector(".toolbar button") as HTMLButtonElement;
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
    expect(calls[0]!.args).toEqual({ rc: { "lines.linewidth": 3 }, only_defaults: true });
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
    expect(calls[0]!.args).toEqual({ rc: { "lines.linewidth": 4, "lines.markersize": 10 }, only_defaults: true });
  });

  it("does not call apply_live for a rerun-category control, and dispatches rerun-needed", async () => {
    await attachBackend(panel, backend);
    const events: RerunNeededEventDetail[] = [];
    panel.addEventListener("plotpolish-rerun-needed", (e) => events.push((e as CustomEvent<RerunNeededEventDetail>).detail));

    const family = input(panel, "font_family") as HTMLSelectElement;
    family.value = "serif";
    change(family);
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
    expect(calls[1]!.args).toEqual({ rc: { "lines.linewidth": 5 }, only_defaults: true });
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
    expect(last.args).toEqual({ rc: { "lines.linewidth": 3 }, only_defaults: true });
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

  it("hides sections not listed in features.groups", () => {
    panel.features = { groups: ["text"] };
    const sections = panel.shadowRoot!.querySelectorAll("section[data-group]");
    sections.forEach((s) => {
      const el = s as HTMLElement;
      expect(el.hidden).toBe(el.dataset.group !== "text");
    });
  });

  it("hides the code details when features.showCode is false", () => {
    panel.features = { showCode: false };
    const details = panel.shadowRoot!.querySelector("details.code") as HTMLDetailsElement;
    expect(details.hidden).toBe(true);
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
