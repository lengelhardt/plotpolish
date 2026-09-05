# Changelog

All notable changes to plotpolish. The format follows Keep a Changelog; the
project is pre-1.0, so minor versions may change behavior.

## Unreleased (0.1.0 in progress)

First working version, built and reviewed in one day (2026-09-05) against
Pyodide 0.28.1 with matplotlib 3.8.4, and tested against matplotlib 3.10 too.

- Fenced, regenerated style block at the top of the user's file; the tool
  never edits the user's own lines. Generator and parser in TypeScript; golden
  fixtures executed by pytest on both matplotlib versions.
- Python helper shipped inside the JS bundle: `list_styles`, `set_style`,
  `introspect_figure`, `apply_live` (with a `previous` baseline so live
  preview keeps working after style changes).
- `<plotpolish-panel>`: a floating, draggable pill of six category tabs over
  the figure's top-right corner; controls in a draggable popover; primary
  and "More" tiers; sliders with readouts; per-line color/width/style via the
  property cycle; legend position by sliders seeded from the drawn legend;
  fit-labels switch; marker style; re-run and change indicators on tabs;
  reset menu with Show code.
- `FigureBackend` and `CodeSink` interfaces with `PyodideBackend`,
  `MemorySink`, `ClipboardSink`, and a `MockBackend` for tests.
- ES module and IIFE (`window.plotpolish`) builds; nothing fetched at runtime.
- Demo page with a mock mode and a real Pyodide mode that re-runs on
  re-run-only changes.
- Docs: design notes, UX design rounds one to five, Trinket integration plan.
