/**
 * MockBackend: a FigureBackend that never runs Python. It pulls the dispatch
 * request out of the snippet and answers from in-memory state that mirrors
 * the semantics of python/plotpolish/core.py closely enough for panel tests.
 */

import type { FigureBackend, FigureDescription } from "../backend";
import { RESULT_VARIABLE } from "../constants";
import { CONTROLS, CONTROL_FOR_KEY, RC_KEYS, type RcValue } from "../schema";

export interface MockCall {
  fn: string;
  args: Record<string, unknown>;
}

/** A few fake style sheets, enough to exercise set_style. */
/** Thumbnail data per style. Deliberately distinct so a test can tell them apart. */
const MOCK_PREVIEWS: Record<string, { axes: string; grid: boolean; colors: string[] }> = {
  default: { axes: "#ffffff", grid: false, colors: ["#1f77b4", "#ff7f0e", "#2ca02c"] },
  ggplot: { axes: "#E5E5E5", grid: true, colors: ["#E24A33", "#348ABD", "#988ED5"] },
  "seaborn-v0_8-whitegrid": { axes: "#ffffff", grid: true, colors: ["#4C72B0", "#DD8452", "#55A868"] },
  dark_background: { axes: "#000000", grid: false, colors: ["#8dd3c7", "#feffb3", "#bfbbd9"] },
};

const MOCK_STYLES: Record<string, Record<string, RcValue>> = {
  ggplot: { "axes.grid": true, "axes.linewidth": 1, "font.size": 10 },
  "seaborn-v0_8-whitegrid": { "axes.grid": true, "axes.spines.top": false, "axes.spines.right": false },
  dark_background: { "lines.linewidth": 1.5 },
};

export function schemaDefaults(): Record<string, RcValue> {
  const rc: Record<string, RcValue> = {};
  for (const c of CONTROLS) for (const k of c.keys) rc[k] = clone(c.default);
  return rc;
}

function clone<T extends RcValue>(v: T): T {
  return (Array.isArray(v) ? [...v] : v) as T;
}

export class MockBackend implements FigureBackend {
  readonly calls: MockCall[] = [];
  styles: string[] = ["default", ...Object.keys(MOCK_STYLES).sort()];
  rc: Record<string, RcValue> = schemaDefaults();
  readonly defaults: Record<string, RcValue> = schemaDefaults();
  figure: FigureDescription | null = null;
  overridden: string[] = [];
  /** If set, the next call fails with this message (as the Python side would report). */
  failNext: string | null = null;
  /** If set, runPython rejects (simulating a dead interpreter). */
  rejectWith: Error | null = null;
  /** Artificial latency in ms, to test debouncing/ordering. */
  delay = 0;

  async runPython(code: string): Promise<string> {
    if (this.rejectWith) throw this.rejectWith;
    if (!code.includes("def dispatch(")) throw new Error("snippet does not contain the helper module");
    const m = new RegExp(`${RESULT_VARIABLE} = dispatch\\((.*)\\)\\n${RESULT_VARIABLE}\\n$`).exec(code);
    if (!m) throw new Error("snippet does not end with the dispatch call");
    const request = JSON.parse(JSON.parse(m[1]!) as string) as MockCall;
    this.calls.push(request);
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return JSON.stringify({ ok: false, error, traceback: "Traceback (mock)", version: "mock" });
    }
    return JSON.stringify({ ok: true, result: this.handle(request), version: "mock" });
  }

  private handle({ fn, args }: MockCall): unknown {
    switch (fn) {
      case "list_styles":
        return [...this.styles];
      case "style_previews":
        return this.styles.map((name) => {
          const p = MOCK_PREVIEWS[name] ?? { axes: "#ffffff", grid: false, colors: ["#1f77b4"] };
          return {
            name,
            figure: "#ffffff",
            axes: p.axes,
            grid: p.grid,
            grid_color: "#b0b0b0",
            edge: p.axes === "#000000" ? "#ffffff" : "#333333",
            colors: [...p.colors],
          };
        });
      case "set_style": {
        const keep = (args.keep as string[] | undefined) ?? [];
        const saved = Object.fromEntries(keep.map((k) => [k, this.rc[k]]));
        this.rc = schemaDefaults();
        const name = args.name as string;
        if (name !== "default") {
          const sheet = MOCK_STYLES[name];
          if (!sheet) throw new Error(`OSError: '${name}' is not a valid package style`);
          Object.assign(this.rc, sheet);
        }
        Object.assign(this.rc, saved);
        return { ...this.rc };
      }
      case "save_figure": {
        // A one-pixel PNG: the panel only forwards the bytes, so their content
        // does not matter here, but the shape and the savefig.dpi that produced
        // them do.
        const format = (args.format as string | undefined) ?? "png";
        if (!this.figure) return { has_figure: false, format, data: "", bytes: 0 };
        return {
          has_figure: true,
          format,
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          bytes: 70,
          dpi: this.rc["savefig.dpi"],
        };
      }
      case "introspect_figure": {
        const keys = (args.keys as string[] | undefined) ?? RC_KEYS;
        const pick = (src: Record<string, RcValue>) => Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]));
        return { matplotlib: "mock", rc: pick(this.rc), defaults: pick(this.defaults), figure: this.figure, overridden: [...this.overridden] };
      }
      case "apply_live": {
        const rc = args.rc as Record<string, RcValue>;
        const result = { applied: [] as string[], deferred: [] as string[], unknown: [] as string[], has_figure: this.figure !== null };
        for (const [key, value] of Object.entries(rc)) {
          const cat = CONTROL_FOR_KEY.get(key)?.category;
          if (cat === "live" || cat === "save") {
            this.rc[key] = value;
            result.applied.push(key);
          } else if (cat === "rerun") result.deferred.push(key);
          else result.unknown.push(key);
        }
        return result;
      }
      default:
        throw new Error(`KeyError: '${fn}'`);
    }
  }
}
