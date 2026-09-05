/**
 * Tests for the CodeSink implementations: MemorySink (tests/simple hosts) and
 * ClipboardSink (write-only, with an injected clipboard for determinism).
 */
import { describe, expect, it } from "vitest";
import { ClipboardSink, MemorySink } from "./sink";

/** Waits a macrotask, long enough for the clipboard promise chain (which has
 * no artificial delay in these tests) to have settled. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("MemorySink", () => {
  it("returns what it was constructed with, and what was last set", () => {
    const sink = new MemorySink("initial");
    expect(sink.getSource()).toBe("initial");
    sink.setSource("updated");
    expect(sink.getSource()).toBe("updated");
  });

  it("defaults to an empty source", () => {
    const sink = new MemorySink();
    expect(sink.getSource()).toBe("");
  });

  it("records every write, in order", () => {
    const sink = new MemorySink("a");
    sink.setSource("b");
    sink.setSource("c");
    expect(sink.writes).toEqual(["b", "c"]);
  });

  it("calls the onChange callback with the new source on every write", () => {
    const seen: string[] = [];
    const sink = new MemorySink("a", (s) => seen.push(s));
    sink.setSource("b");
    sink.setSource("c");
    expect(seen).toEqual(["b", "c"]);
  });

  it("does not call subscribed listeners on setSource, only on externalEdit", () => {
    const sink = new MemorySink("a");
    let calls = 0;
    sink.subscribe(() => {
      calls++;
    });
    sink.setSource("b");
    expect(calls).toBe(0);
    sink.externalEdit("c");
    expect(calls).toBe(1);
    expect(sink.getSource()).toBe("c");
  });

  it("notifies every subscriber on externalEdit", () => {
    const sink = new MemorySink("a");
    const seenA: string[] = [];
    const seenB: string[] = [];
    sink.subscribe(() => seenA.push(sink.getSource()));
    sink.subscribe(() => seenB.push(sink.getSource()));
    sink.externalEdit("z");
    expect(seenA).toEqual(["z"]);
    expect(seenB).toEqual(["z"]);
  });

  it("stops notifying a listener once unsubscribed", () => {
    const sink = new MemorySink("a");
    let calls = 0;
    const unsubscribe = sink.subscribe(() => {
      calls++;
    });
    sink.externalEdit("b");
    expect(calls).toBe(1);
    unsubscribe();
    sink.externalEdit("c");
    expect(calls).toBe(1);
  });
});

describe("ClipboardSink", () => {
  it("has no readable source (write-only)", () => {
    const sink = new ClipboardSink();
    expect(sink.getSource()).toBeNull();
  });

  it("renders a readonly textarea into the provided container with the block", () => {
    const container = document.createElement("div");
    const sink = new ClipboardSink({ container, clipboard: null });
    sink.setSource("import matplotlib as mpl\n");

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe("import matplotlib as mpl\n");
    expect(textarea!.readOnly).toBe(true);
    expect(textarea!.getAttribute("aria-label")).toBe("Generated plot style block");
    expect(sink.element).toBe(textarea);
  });

  it("reports a successful copy once an injected clipboard's writeText resolves", async () => {
    const writeText = (): Promise<void> => Promise.resolve();
    const copied: [boolean, string][] = [];
    const sink = new ClipboardSink({ clipboard: { writeText }, onCopied: (ok, block) => copied.push([ok, block]) });

    sink.setSource("block-text");
    expect(sink.lastCopied).toBeNull(); // not yet resolved
    await flush();

    expect(sink.lastCopied).toBe(true);
    expect(copied).toEqual([[true, "block-text"]]);
  });

  it("reports a failed copy when the injected clipboard's writeText rejects", async () => {
    const writeText = (): Promise<void> => Promise.reject(new Error("denied"));
    const copied: [boolean, string][] = [];
    const sink = new ClipboardSink({ clipboard: { writeText }, onCopied: (ok, block) => copied.push([ok, block]) });

    sink.setSource("block-text");
    await flush();

    expect(sink.lastCopied).toBe(false);
    expect(copied).toEqual([[false, "block-text"]]);
  });

  it("reports no copy and still shows the block when clipboard is null", () => {
    const container = document.createElement("div");
    const sink = new ClipboardSink({ container, clipboard: null });
    sink.setSource("block-text");

    expect(sink.lastCopied).toBe(false);
    expect(sink.element!.value).toBe("block-text");
  });

  it("shows placeholder text and never calls writeText for an empty block", () => {
    const container = document.createElement("div");
    let writeTextCalls = 0;
    const writeText = (): Promise<void> => {
      writeTextCalls++;
      return Promise.resolve();
    };
    const sink = new ClipboardSink({ container, clipboard: { writeText } });

    sink.setSource("");

    expect(writeTextCalls).toBe(0);
    expect(sink.lastCopied).toBe(false);
    expect(sink.element!.placeholder).toBe("No block: every setting is at its default.");
  });
});
