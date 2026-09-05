/**
 * Standalone demo page for stylefence. Two backend modes, chosen by the
 * `backend` URL query parameter:
 *
 *   (absent)         -> "pyodide" mode. Pyodide + matplotlib are NOT loaded
 *                        on page load; they are downloaded lazily, only after
 *                        the user clicks Run and confirms the download.
 *   ?backend=mock    -> "mock" mode. Uses MockBackend; Run never executes
 *                        Python and just reports that in the status line.
 *
 * This file imports "stylefence" (aliased in vite.config.ts to ../src/index.ts,
 * i.e. the library source, not dist/) plus MockBackend by relative path,
 * exactly as the task brief allows for a demo page.
 */

import { StylefencePanel, MemorySink, PyodideBackend } from "stylefence";
import type { PanelErrorEventDetail, RerunNeededEventDetail } from "stylefence";
import { MockBackend } from "../src/testing/mock-backend";

// ---------------------------------------------------------------------------
// Minimal Pyodide typing. The project takes no dependency on @types/pyodide;
// this is only the slice this file (and PyodideBackend's PyodideLike) needs.
// ---------------------------------------------------------------------------

interface PyodideInterface {
  runPython(code: string, options?: { globals?: unknown }): unknown;
  runPythonAsync(code: string, options?: { globals?: unknown }): Promise<unknown>;
  loadPackage(names: string | string[]): Promise<unknown>;
  loadPackagesFromImports(code: string): Promise<unknown>;
  toPy(obj: unknown): { destroy?(): void };
  globals: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var loadPyodide: ((options: { indexURL: string }) => Promise<PyodideInterface>) | undefined;
}

/** Pyodide 0.28's patched matplotlib backend renders into this element when set. */
interface PyodideMplDocument extends Document {
  pyodideMplTarget?: HTMLElement;
}

const PYODIDE_VERSION = "v0.28.1";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

const SAMPLE_SOURCE = `import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 2 * np.pi, 200)
y1 = np.sin(x)
y2 = np.cos(x)

plt.plot(x, y1, label="sin(x)")
plt.plot(x, y2, label="cos(x)")
plt.title("Sine and cosine")
plt.xlabel("x (radians)")
plt.ylabel("amplitude")
plt.legend()
plt.show()
`;

function required<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`demo/index.html is missing #${id}`);
  return el as unknown as T;
}

const textarea = required<HTMLTextAreaElement>("source");
const runButton = required<HTMLButtonElement>("run");
const statusEl = required<HTMLElement>("status");
const figureDiv = required<HTMLDivElement>("figure");
const outputPre = required<HTMLPreElement>("output");
const themeToggle = required<HTMLButtonElement>("theme-toggle");
const panel = required<StylefencePanel>("panel");

textarea.value = SAMPLE_SOURCE;

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("status-error", isError);
}

// ---------------------------------------------------------------------------
// Theme toggle: sets the panel's `theme` attribute and a class on <body>.
// ---------------------------------------------------------------------------

let theme: "light" | "dark" = "light";

function applyTheme(): void {
  panel.setAttribute("theme", theme);
  document.body.classList.toggle("theme-dark", theme === "dark");
  themeToggle.textContent = theme === "dark" ? "Light mode" : "Dark mode";
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
}

themeToggle.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  applyTheme();
});

applyTheme();

// ---------------------------------------------------------------------------
// Sink: the textarea is the "editor". The panel reads/writes its value
// through a MemorySink; when the user types, feed the change back into the
// sink so the panel re-parses (guarded so the panel's own writes, which set
// textarea.value directly, do not bounce back in).
// ---------------------------------------------------------------------------

const sink = new MemorySink(textarea.value, (source) => {
  textarea.value = source;
});
panel.sink = sink;

textarea.addEventListener("input", () => {
  if (textarea.value !== sink.getSource()) {
    sink.externalEdit(textarea.value);
  }
});

textarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void run();
  }
});

// ---------------------------------------------------------------------------
// Panel events
// ---------------------------------------------------------------------------

panel.addEventListener("stylefence-rerun-needed", (event) => {
  const detail = (event as CustomEvent<RerunNeededEventDetail>).detail;
  setStatus(`Re-run to see: ${detail.keys.join(", ")}`);
});

panel.addEventListener("stylefence-error", (event) => {
  const detail = (event as CustomEvent<PanelErrorEventDetail>).detail;
  setStatus(detail.error.message, true);
});

// ---------------------------------------------------------------------------
// Backend mode
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const backendMode: "mock" | "pyodide" = params.get("backend") === "mock" ? "mock" : "pyodide";

if (backendMode === "mock") {
  panel.backend = new MockBackend();
  setStatus("Mock mode: no Python runs. Click Run to see the status message.");
} else {
  setStatus("Click Run to load Python (downloads Pyodide + matplotlib from jsDelivr).");
}

// ---------------------------------------------------------------------------
// Pyodide: lazy-loaded only after the user clicks Run.
// ---------------------------------------------------------------------------

let pyodide: PyodideInterface | null = null;
let pyodideLoading: Promise<PyodideInterface> | null = null;

function loadPyodideScript(): Promise<void> {
  if (globalThis.loadPyodide) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${PYODIDE_BASE}pyodide.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load pyodide.js from jsDelivr."));
    document.head.appendChild(script);
  });
}

/** Loads Pyodide + matplotlib on first call; later calls reuse the same instance. */
function ensurePyodide(): Promise<PyodideInterface> {
  if (pyodide) return Promise.resolve(pyodide);
  if (pyodideLoading) return pyodideLoading;

  const proceed = confirm(
    "This demo will download Pyodide and matplotlib from jsDelivr (tens of MB, cached by " +
      "the browser after the first time). Continue?",
  );
  if (!proceed) return Promise.reject(new Error("cancelled"));

  pyodideLoading = (async () => {
    setStatus("Downloading Pyodide...");
    await loadPyodideScript();
    const loader = globalThis.loadPyodide;
    if (!loader) throw new Error("pyodide.js loaded but window.loadPyodide is missing");
    const py = await loader({ indexURL: PYODIDE_BASE });
    setStatus("Downloading matplotlib...");
    await py.loadPackage("matplotlib");
    pyodide = py;
    panel.backend = new PyodideBackend(py);
    setStatus("Python ready.");
    return py;
  })();

  return pyodideLoading.finally(() => {
    pyodideLoading = null;
  });
}

async function runProgram(py: PyodideInterface): Promise<void> {
  const source = textarea.value;
  outputPre.textContent = "";
  setStatus("Running...");
  (document as PyodideMplDocument).pyodideMplTarget = figureDiv;
  try {
    // Pyodide's matplotlib wheel selects its patched, in-browser backend on
    // its own; close any figure left over from a previous run before the
    // user's own imports run.
    await py.runPythonAsync('import matplotlib.pyplot as plt\nplt.close("all")');
    figureDiv.innerHTML = "";
    await py.loadPackagesFromImports(source);
    await py.runPythonAsync(source);
    setStatus("Done.");
    await panel.refresh();
  } catch (err) {
    outputPre.textContent = err instanceof Error ? err.message : String(err);
    setStatus("Error while running the program.", true);
  }
}

async function run(): Promise<void> {
  if (backendMode === "mock") {
    setStatus("(mock mode: no Python)");
    return;
  }
  runButton.disabled = true;
  try {
    const py = await ensurePyodide();
    await runProgram(py);
  } catch (err) {
    if (err instanceof Error && err.message === "cancelled") {
      setStatus("Cancelled.");
    } else {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => void run());
