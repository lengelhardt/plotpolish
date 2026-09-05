/**
 * Reference FigureBackend over a Pyodide instance the host has already loaded.
 * Trinket's adapter is copied from this. The library never loads Pyodide
 * itself; see demo/ for a page that does (from the official CDN).
 */

import type { FigureBackend } from "../backend";

/** The slice of the Pyodide API this adapter needs; lets tests pass a stub. */
export interface PyodideLike {
  runPython(code: string, options?: { globals?: unknown }): unknown;
  toPy(obj: unknown): { destroy?(): void };
  globals: unknown;
}

export interface PyodideBackendOptions {
  /**
   * Run each snippet in a fresh namespace (default true). Trinket's helpers do
   * the same. Set false only if your interpreter cannot create namespaces.
   */
  isolate?: boolean;
  /** Called with each snippet before it runs; handy for logging. */
  onRun?: (code: string) => void;
}

export class PyodideBackend implements FigureBackend {
  constructor(private readonly pyodide: PyodideLike, private readonly options: PyodideBackendOptions = {}) {}

  async runPython(code: string): Promise<string> {
    this.options.onRun?.(code);
    const isolate = this.options.isolate ?? true;
    let ns: { destroy?(): void } | null = null;
    try {
      let result: unknown;
      if (isolate) {
        // A throwaway dict so the helper's names (mpl, plt, dispatch, …) never
        // land in the user's globals. The helper only *reads* matplotlib's
        // global state, which lives in sys.modules and is shared regardless.
        ns = this.pyodide.toPy({});
        result = this.pyodide.runPython(code, { globals: ns });
      } else {
        result = this.pyodide.runPython(code);
      }
      return toStr(result);
    } finally {
      ns?.destroy?.();
    }
  }
}

function toStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toString?: unknown }).toString === "function") {
    const s = String(value);
    // A PyProxy of a str would have been converted already; anything else is a bug.
    (value as { destroy?: () => void }).destroy?.();
    return s;
  }
  return String(value);
}
