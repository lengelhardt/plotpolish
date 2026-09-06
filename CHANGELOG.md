# Changelog

All notable changes to plotpolish. The format follows Keep a Changelog; the
project is pre-1.0, so minor versions may change behavior.

## 0.1.3 — 2026-09-05

Two corrections to the 0.1.2 drag fix.

- **A second pointer ending cancelled a drag in progress.** The window-level
  safety net added in 0.1.2 ended *any* live drag on *any* `pointerup`,
  without checking which pointer it belonged to. Lifting a second finger, or a
  stylus ending while a mouse drag was live, dropped the drag out from under
  the user. It now only ends the drag whose `pointerId` actually ended.
- **Removed duplicate `pointercancel` listeners.** 0.1.2 added a
  `pointercancel` handler on the pill grip and popover header on the mistaken
  belief that neither had one. Both already did, routed through the pointerup
  handler, so 0.1.2 left two listeners on each doing the same work. The 0.1.2
  changelog entry has been corrected accordingly: `pointercancel` was handled
  correctly all along, and was never part of the reported bug.

The user-visible fix in 0.1.2 -- the pill grabbing itself on hover after a
missed release -- was real and stands. Only the account of `pointercancel` was
wrong.

## 0.1.2 — 2026-09-05

- The pill could start dragging itself. `pillDragStart` was cleared only by a
  `pointerup` on the grip, an 11px handle at the pill's left edge, so a release
  anywhere else left it standing; the next pointer movement across the grip
  then resumed a drag nobody started. Once that happened the pill appeared to
  move one way but not the other -- a stale drag positions the pill from the
  old anchor, so it jumps away from the cursor, and with no live pointer to
  capture, only the direction chasing it kept delivering events. The drag
  arithmetic was symmetric throughout.
- A `pointermove` with no button held now ends a drag, and a window-level
  `pointerup` catches the release that lands outside the element. Applied to
  the popover header as well, which had the same defect. (This entry
  originally also claimed `pointercancel` had no listener. That was wrong --
  see 0.1.3.)

## 0.1.1 — 2026-09-05

Two panel fixes found by auditing the library against a real host adapter,
before writing that adapter. Both are host-integration bugs that the demo page
never hit; both now have regression tests that fail without the fix.

- `refresh()` cleared the stale/re-run indicators only when a backend was
  attached, so a host that runs the program somewhere the panel cannot
  introspect — Trinket's Web Worker path attaches no backend — left the ↻
  marks on permanently. A completed run is what makes a pending re-run no
  longer pending, whether or not anything can be introspected afterwards.
- `disconnectedCallback` dropped the sink subscription and `connectedCallback`
  never restored it, so re-parenting the element silently stopped it noticing
  edits made outside the panel. Hosts re-parent routinely: WebAgg rebuilds the
  figure's DOM on every run. `connectedCallback` now resubscribes and re-reads
  the source, which may have changed while the element was detached.
- The release workflow now checks the tag against **every** version string in
  the tree (package.json, pyproject.toml, `core.py`, `constants.ts`), not just
  package.json.

## 0.1.0 — 2026-09-05

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
