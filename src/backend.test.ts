/**
 * Tests for backend.ts (buildSnippet, HelperClient, BackendError) and the
 * reference adapters/pyodide.ts adapter, using stubs/mocks rather than a real
 * interpreter.
 */
import { describe, expect, it, vi } from "vitest";
import { PyodideBackend, type PyodideLike } from "./adapters/pyodide";
import {
  BackendError, backendStallReason, buildSnippet, HELPER_SOURCE, HelperClient, type FigureBackend,
} from "./backend";
import { RESULT_VARIABLE } from "./constants";
import { MockBackend } from "./testing/mock-backend";

describe("buildSnippet", () => {
  it("embeds the helper source verbatim and ends with the result variable", () => {
    const snippet = buildSnippet("list_styles", {});
    expect(snippet).toContain(HELPER_SOURCE);
    expect(snippet.endsWith(`${RESULT_VARIABLE}\n`)).toBe(true);
  });

  it("wraps a double-encoded JSON payload in a double-quoted Python string literal", () => {
    const snippet = buildSnippet("set_style", { name: "ggplot", keep: ["a"] });
    const prefix = `${HELPER_SOURCE}\n${RESULT_VARIABLE} = dispatch(`;
    const suffix = `)\n${RESULT_VARIABLE}\n`;
    expect(snippet.startsWith(prefix)).toBe(true);
    expect(snippet.endsWith(suffix)).toBe(true);

    const payload = snippet.slice(prefix.length, snippet.length - suffix.length);
    // The payload itself must be a valid (double-quoted) JSON string literal...
    expect(payload.startsWith('"')).toBe(true);
    const innerJson = JSON.parse(payload) as string;
    // ...whose contents are themselves JSON: the {fn, args} request.
    const request = JSON.parse(innerJson) as { fn: string; args: unknown };
    expect(request).toEqual({ fn: "set_style", args: { name: "ggplot", keep: ["a"] } });
  });
});

describe("backendStallReason", () => {
  // The two Trinket actually rejects with, verbatim (docs/trinket-integration.md
  // writes them without the period; the panel must not care either way).
  it.each([
    "A program is running",
    "A program is running.",
    "a program is running",
    "Error: A program is running",
  ])("reads %o as busy", (message) => {
    expect(backendStallReason(new Error(message))).toBe("busy");
  });

  it.each([
    "Python is not loaded yet",
    "Python is not loaded yet.",
    "The interpreter is not ready",
  ])("reads %o as loading", (message) => {
    expect(backendStallReason(new Error(message))).toBe("loading");
  });

  it("never calls a helper exception a stall, however its message reads", () => {
    // The interpreter DID run the snippet; waiting fixes nothing. A helper that
    // raised while echoing the student's own text back must not be explained
    // away as "come back in a moment".
    expect(backendStallReason(new BackendError("apply_live", "A program is running"))).toBeNull();
    expect(backendStallReason(new BackendError("introspect_figure", "Python is not loaded yet"))).toBeNull();
  });

  it("returns null for an unrecognized failure, so it keeps the loud treatment", () => {
    expect(backendStallReason(new Error("dead"))).toBeNull();
    expect(backendStallReason(new Error("RuntimeError: no display"))).toBeNull();
    expect(backendStallReason("some string")).toBeNull();
    expect(backendStallReason(undefined)).toBeNull();
  });
});

describe("HelperClient error handling", () => {
  it("throws a BackendError mentioning 'did not return JSON' for a non-JSON response", async () => {
    const backend: FigureBackend = { runPython: async () => "not json at all" };
    const client = new HelperClient(backend);
    await expect(client.listStyles()).rejects.toThrow(BackendError);
    await expect(client.listStyles()).rejects.toThrow(/did not return JSON/);
  });

  it("throws a BackendError carrying the Python error and traceback when ok is false", async () => {
    const backend: FigureBackend = {
      runPython: async () =>
        JSON.stringify({ ok: false, error: "boom", traceback: "Traceback (most recent call last)...", version: "x" }),
    };
    const client = new HelperClient(backend);
    await expect(client.call("some_fn", {})).rejects.toThrow("some_fn: boom");
    await expect(client.call("some_fn", {})).rejects.toMatchObject({
      name: "BackendError",
      fn: "some_fn",
      traceback: "Traceback (most recent call last)...",
    });
  });
});

describe("HelperClient typed methods", () => {
  it("listStyles sends list_styles with no args", async () => {
    const backend = new MockBackend();
    const client = new HelperClient(backend);
    await client.listStyles();
    expect(backend.calls[backend.calls.length - 1]).toEqual({ fn: "list_styles", args: {} });
  });

  it("setStyle sends set_style with name and keep", async () => {
    const backend = new MockBackend();
    const client = new HelperClient(backend);
    await client.setStyle("ggplot", ["figure.autolayout"]);
    expect(backend.calls[backend.calls.length - 1]).toEqual({
      fn: "set_style",
      args: { name: "ggplot", keep: ["figure.autolayout"] },
    });
  });

  it("setStyle defaults keep to an empty array", async () => {
    const backend = new MockBackend();
    const client = new HelperClient(backend);
    await client.setStyle("ggplot");
    expect(backend.calls[backend.calls.length - 1]).toEqual({ fn: "set_style", args: { name: "ggplot", keep: [] } });
  });

  it("introspect sends {} with no keys, and {keys} with keys", async () => {
    const backend = new MockBackend();
    const client = new HelperClient(backend);
    await client.introspect();
    expect(backend.calls[backend.calls.length - 1]).toEqual({ fn: "introspect_figure", args: {} });
    await client.introspect(["font.size"]);
    expect(backend.calls[backend.calls.length - 1]).toEqual({ fn: "introspect_figure", args: { keys: ["font.size"] } });
  });

  it("applyLive sends only_defaults true by default, and false when asked", async () => {
    const backend = new MockBackend();
    const client = new HelperClient(backend);
    await client.applyLive({ "lines.linewidth": 2 });
    expect(backend.calls[backend.calls.length - 1]).toEqual({
      fn: "apply_live",
      args: { rc: { "lines.linewidth": 2 }, only_defaults: true },
    });
    await client.applyLive({ "lines.linewidth": 2 }, false);
    expect(backend.calls[backend.calls.length - 1]).toEqual({
      fn: "apply_live",
      args: { rc: { "lines.linewidth": 2 }, only_defaults: false },
    });
  });
});

describe("PyodideBackend", () => {
  it("runs isolated by default: toPy({}) namespace passed as globals, destroyed afterwards", async () => {
    const destroy = vi.fn();
    const toPy = vi.fn(() => ({ destroy }));
    const runPython = vi.fn((_code: string, _options?: { globals?: unknown }) => "result");
    const pyodide: PyodideLike = { runPython, toPy, globals: {} };
    const backend = new PyodideBackend(pyodide);

    const result = await backend.runPython("print(1)");

    expect(result).toBe("result");
    expect(toPy).toHaveBeenCalledWith({});
    expect(runPython).toHaveBeenCalledTimes(1);
    const call = runPython.mock.calls[0]!;
    expect(call[0]).toBe("print(1)");
    expect(call[1]).toEqual({ globals: { destroy } });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("still destroys the namespace when runPython throws", async () => {
    const destroy = vi.fn();
    const toPy = vi.fn(() => ({ destroy }));
    const runPython = vi.fn(() => {
      throw new Error("boom");
    });
    const pyodide: PyodideLike = { runPython, toPy, globals: {} };
    const backend = new PyodideBackend(pyodide);

    await expect(backend.runPython("bad")).rejects.toThrow("boom");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("with isolate:false calls runPython(code) alone and never creates a namespace", async () => {
    const toPy = vi.fn();
    const runPython = vi.fn(() => "ok");
    const pyodide: PyodideLike = { runPython, toPy, globals: {} };
    const backend = new PyodideBackend(pyodide, { isolate: false });

    await backend.runPython("print(1)");

    expect(toPy).not.toHaveBeenCalled();
    expect(runPython).toHaveBeenCalledWith("print(1)");
    expect(runPython.mock.calls[0]!.length).toBe(1);
  });

  it("returns a string result as-is", async () => {
    const pyodide: PyodideLike = { runPython: () => "hello", toPy: () => ({}), globals: {} };
    const backend = new PyodideBackend(pyodide);
    const result = await backend.runPython("x");
    expect(result).toBe("hello");
  });

  it("calls onRun with the snippet before executing it", async () => {
    const seen: string[] = [];
    const pyodide: PyodideLike = { runPython: () => "ok", toPy: () => ({}), globals: {} };
    const backend = new PyodideBackend(pyodide, { onRun: (code) => seen.push(code) });
    await backend.runPython("print(2)");
    expect(seen).toEqual(["print(2)"]);
  });
});
