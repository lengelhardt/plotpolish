/**
 * FigureBackend: the host-owned Python interpreter, seen through one method.
 *
 * The library never loads Pyodide or fetches anything. It hands the host a
 * self-contained Python snippet (the helper module inlined verbatim, plus one
 * `dispatch(...)` call) and expects the value of the snippet's last expression
 * back as a string of JSON.
 */

import HELPER_SOURCE from "../python/plotpolish/core.py?raw";
import { RESULT_VARIABLE } from "./constants";
import type { RcValue } from "./schema";

export { HELPER_SOURCE };

export interface FigureBackend {
  /**
   * Execute `code` in a throwaway namespace and resolve with the value of the
   * last expression, converted to a string. If your host captures stdout
   * instead, append `print(__plotpolish_result__)` before running.
   */
  runPython(code: string): Promise<string>;
}

// --- Helper response shapes (mirror python/plotpolish/core.py) -------------

export interface AxesDescription {
  grid: boolean;
  grid_alpha: number | null;
  grid_linestyle: string | null;
  spines: Record<string, boolean>;
  axes_linewidth: number | null;
  tick_direction: { x: string | null; y: string | null };
  minor_ticks: { x: boolean; y: boolean };
  title_size: number;
  label_size: { x: number; y: number };
  tick_label_size: { x: number | null; y: number | null };
  n_lines: number;
  legend: null | {
    frameon: boolean;
    framealpha: number | null;
    /** Named location, or [x, y] axes fractions when placed by coordinates. */
    loc: string | number[] | null;
    fontsize: number | null;
    /** Lower-left corner of the drawn legend box in axes fractions, when known. */
    xy?: [number, number] | null;
  };
}

/** What a style looks like, without rendering it: enough for a thumbnail. */
export interface StylePreview {
  name: string;
  figure: string;
  axes: string;
  grid: boolean;
  grid_color: string;
  edge: string;
  colors: string[];
}

export interface FigureDescription {
  figsize: [number, number];
  dpi: number;
  autolayout?: boolean;
  axes: AxesDescription[];
}

export interface IntrospectResult {
  matplotlib: string;
  rc: Record<string, RcValue>;
  defaults: Record<string, RcValue>;
  figure: FigureDescription | null;
  overridden: string[];
}

/** A figure saved through `fig.savefig`, so the savefig.* rc keys apply. */
export interface SaveResult {
  has_figure: boolean;
  format: string;
  /** base64, because the transport is a JSON string. */
  data: string;
  bytes: number;
  dpi?: number | string;
}

export interface ApplyResult {
  applied: string[];
  deferred: string[];
  unknown: string[];
  has_figure: boolean;
}

type HelperResponse<T> =
  | { ok: true; result: T; version: string }
  | { ok: false; error: string; traceback?: string; version: string };

export class BackendError extends Error {
  readonly traceback: string | undefined;
  readonly fn: string;
  constructor(fn: string, message: string, traceback?: string) {
    super(`${fn}: ${message}`);
    this.name = "BackendError";
    this.fn = fn;
    this.traceback = traceback;
  }
}

/**
 * A transient reason a backend could not answer, as opposed to a failure:
 * "busy" while the student's own program holds the interpreter, "loading"
 * before the interpreter exists at all. Both clear themselves.
 */
export type BackendStall = "busy" | "loading";

// Read off the message, because `FigureBackend` is deliberately one method and
// carries no error codes (see CLAUDE.md: two tiny host interfaces only). The
// two Trinket rejects with, verbatim, are `new Error("A program is running")`
// and `new Error("Python is not loaded yet")`; see docs/trinket-integration.md.
// The neighboring wordings are here because a host is free to phrase its own.
// Anchored on a subject on purpose. A bare /\bnot loaded\b/ also matched real
// faults -- "TypeError: figure is not loaded", "matplotlib backend not loaded
// correctly" -- and explaining a fault away as "Python is starting" is the
// wrong direction to fail in. Helper exceptions were already safe, since a
// BackendError short-circuits below before any pattern runs; these only ever
// see failures the HOST raised, so requiring the interpreter as the subject is
// enough to separate "come back later" from "something broke".
const BUSY_PATTERNS = [/\bprogram is running\b/i, /\balready running\b/i, /\bis busy\b/i];
const LOADING_PATTERNS = [
  /\b(python|interpreter|pyodide)\b[^.!?]*\b(not loaded|not ready|still loading|starting up)\b/i,
  /\b(not loaded|not ready|still loading|starting up)\b[^.!?]*\b(python|interpreter|pyodide)\b/i,
];

/**
 * Classify a rejected `runPython`. Returns null for anything not recognized as
 * transient, which is the safe way round: an unrecognized failure keeps the
 * loud treatment rather than being explained away as "come back later".
 *
 * A `BackendError` is never a stall. It means the interpreter *did* run the
 * snippet and the helper raised (or answered with something unreadable), which
 * is a real fault no amount of waiting fixes.
 */
export function backendStallReason(error: unknown): BackendStall | null {
  if (error instanceof BackendError) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (BUSY_PATTERNS.some((re) => re.test(message))) return "busy";
  if (LOADING_PATTERNS.some((re) => re.test(message))) return "loading";
  return null;
}

/** Python source for one helper call. Exported so hosts can inspect or log it. */
export function buildSnippet(fn: string, args: Record<string, unknown> = {}): string {
  // JSON.stringify twice: the inner call makes the request JSON, the outer
  // turns that into a double-quoted literal Python reads as a str (JSON string
  // escapes are a subset of Python's).
  const payload = JSON.stringify(JSON.stringify({ fn, args }));
  return `${HELPER_SOURCE}\n${RESULT_VARIABLE} = dispatch(${payload})\n${RESULT_VARIABLE}\n`;
}

/** Typed wrapper around a FigureBackend. */
export class HelperClient {
  constructor(readonly backend: FigureBackend) {}

  async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const raw = await this.backend.runPython(buildSnippet(fn, args));
    let parsed: HelperResponse<T>;
    try {
      parsed = JSON.parse(raw) as HelperResponse<T>;
    } catch {
      throw new BackendError(fn, `backend did not return JSON: ${String(raw).slice(0, 200)}`);
    }
    if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
      throw new BackendError(fn, `unexpected response shape: ${String(raw).slice(0, 200)}`);
    }
    if (!parsed.ok) throw new BackendError(fn, parsed.error, parsed.traceback);
    return parsed.result;
  }

  listStyles(): Promise<string[]> {
    return this.call<string[]>("list_styles");
  }

  /** Enough of each style to draw a thumbnail. Same order as `listStyles()`. */
  stylePreviews(): Promise<StylePreview[]> {
    return this.call<StylePreview[]>("style_previews");
  }

  /** Reset the session's rcParams and apply `name`; returns the new effective curated values. */
  setStyle(name: string, keep: string[] = []): Promise<Record<string, RcValue>> {
    return this.call<Record<string, RcValue>>("set_style", { name, keep });
  }

  /**
   * Save the figure the way the student's own savefig would, so the Save
   * category's keys actually apply. A host that grabs the on-screen canvas
   * instead gets a screen-resolution PNG and none of them.
   */
  saveFigure(format = "png"): Promise<SaveResult> {
    return this.call<SaveResult>("save_figure", { format });
  }

  introspect(keys?: string[]): Promise<IntrospectResult> {
    return this.call<IntrospectResult>("introspect_figure", keys ? { keys } : {});
  }

  /**
   * Apply artist-level equivalents. `previous` tells the helper what the
   * retained figure currently sits at for each key, so the "is this artist
   * still at the default?" test does not depend on `mpl.rcParams`, which
   * `set_style` moves without touching the figure.
   */
  applyLive(rc: Record<string, RcValue>, onlyDefaults = true, previous?: Record<string, RcValue>): Promise<ApplyResult> {
    const args: Record<string, unknown> = { rc, only_defaults: onlyDefaults };
    if (previous) args.previous = previous;
    return this.call<ApplyResult>("apply_live", args);
  }
}
