/**
 * The panel must tell apply_live what the retained figure sits at (`previous`),
 * independently of mpl.rcParams, because set_style moves rcParams without
 * redrawing anything. Regression test for the reset-after-style-change bug
 * seen in the real Pyodide demo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateBlock } from "./block";
import type { PlotpolishPanel } from "./panel";
import "./panel";
import { MemorySink } from "./sink";
import { MockBackend } from "./testing/mock-backend";

function change(panel: PlotpolishPanel, id: string, value: string | boolean): void {
  const input = panel.shadowRoot!.querySelector<HTMLInputElement | HTMLSelectElement>(`#ctl-${id}`)!;
  if (typeof value === "boolean") (input as HTMLInputElement).checked = value;
  else input.value = value;
  input.dispatchEvent(new Event("change"));
}

function applyCalls(backend: MockBackend) {
  return backend.calls.filter((c) => c.fn === "apply_live").map((c) => c.args as { rc: Record<string, unknown>; previous?: Record<string, unknown> });
}

describe("figure baseline (`previous`) tracking", () => {
  let panel: PlotpolishPanel;
  let backend: MockBackend;
  let sink: MemorySink;

  beforeEach(async () => {
    panel = document.createElement("plotpolish-panel") as PlotpolishPanel;
    document.body.append(panel);
    sink = new MemorySink("import matplotlib.pyplot as plt\nplt.plot([1, 2])\n");
    backend = new MockBackend();
    panel.sink = sink;
    panel.backend = backend;
    await panel.refresh();
    backend.calls.length = 0;
  });

  afterEach(() => panel.remove());

  it("sends the last-introspected value as previous on the first apply", async () => {
    change(panel, "linewidth", "3");
    await panel.settle();
    const [call] = applyCalls(backend);
    expect(call!.rc).toEqual({ "lines.linewidth": 3 });
    expect(call!.previous).toEqual({ "lines.linewidth": 1.5 });
  });

  it("advances previous to what it last applied", async () => {
    change(panel, "linewidth", "3");
    await panel.settle();
    change(panel, "linewidth", "4");
    await panel.settle();
    expect(applyCalls(backend)[1]!.previous).toEqual({ "lines.linewidth": 3 });
  });

  it("keeps previous at the figure's values after a style change moves the baseline", async () => {
    change(panel, "style", "ggplot"); // mock ggplot: axes.grid true
    await panel.settle();
    expect(panel.effective("axes.grid")).toBe(true); // new baseline
    change(panel, "grid", false);
    await panel.settle();
    const calls = applyCalls(backend);
    const call = calls[calls.length - 1]!;
    expect(call.rc).toEqual({ "axes.grid": false });
    expect(call.previous).toEqual({ "axes.grid": false }); // the figure was drawn with grid off
  });

  it("reset after a style change restores artists using their applied values as previous", async () => {
    change(panel, "linewidth", "3");
    await panel.settle();
    change(panel, "style", "ggplot");
    await panel.settle();
    backend.calls.length = 0;
    panel.shadowRoot!.querySelector<HTMLButtonElement>(".toolbar button")!.click();
    await panel.settle();
    expect(backend.calls.map((c) => c.fn)).toEqual(["set_style", "apply_live"]);
    const restore = applyCalls(backend)[0]!;
    expect(restore.rc).toEqual({ "lines.linewidth": 1.5 }); // target: default baseline
    expect(restore.previous).toEqual({ "lines.linewidth": 3 }); // reference: what the figure has
    expect(panel.getSettings()).toEqual({ style: "default", rc: {} });
    expect(sink.getSource()).not.toContain("plot style");
    expect(generateBlock(panel.getSettings())).toBeNull();
  });

  it("refresh after a run resets previous to the new introspection", async () => {
    change(panel, "linewidth", "3");
    await panel.settle();
    backend.rc["lines.linewidth"] = 2; // the re-run's effective value
    await panel.refresh();
    backend.calls.length = 0;
    change(panel, "linewidth", "4");
    await panel.settle();
    expect(applyCalls(backend)[0]!.previous).toEqual({ "lines.linewidth": 2 });
  });
});
