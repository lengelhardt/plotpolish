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
