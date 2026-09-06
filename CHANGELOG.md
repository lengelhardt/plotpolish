# Changelog

All notable changes to plotpolish. The format follows Keep a Changelog; the
project is pre-1.0, so minor versions may change behavior.

## 0.3.1 — 2026-09-06

- **Fixed: the vendored bundle asked every host's users for a sourcemap they
  did not have.** The build emitted `//# sourceMappingURL=plotpolish.iife.js.map`
  into `plotpolish.iife.js`, but the whole point of the IIFE build is that a
  host copies *one* self-contained file and serves it from their own origin —
  so the reference resolved to a `.map` they never copied, and every one of
  their users' devtools took a 404 for it. Found by a reviewer on the first
  host integration, which is exactly where it would show up first.

  `sourcemap: "hidden"` builds the map and publishes it beside the release as
  before, without putting a reference to it in the bundle; anyone debugging a
  vendored copy can attach it by hand, and `minify: false` means the shipped
  bundle is readable JavaScript regardless. `src/iife.test.ts` now asserts the
  bundle carries no `sourceMappingURL`, so it cannot come back.

## 0.3.0 — 2026-09-06

- **Fixed: a per-line width could stick, and then stop responding entirely.**
  Applying a property cycle only ever set the properties the *new* cycle
  carried, so when one went away — reverting the per-line table, resetting the
  category, the "(all)" master taking over — the lines kept wearing it, while a
  re-run of the same block drew them at `lines.linewidth`. The line then sat at
  a width the panel did not believe it had, and `only_defaults` read that as
  student-set and refused to touch the row ever again. Reported as a line stuck
  huge, then stuck small, then never moving. The legend's copies of those lines
  are walked back too.


- **New: "Save PNG" (Save).** The Save category had three settings and no way
  to save, so `savefig.dpi`, `savefig.transparent` and `savefig.bbox` had no
  observable effect anywhere in the tool — the live-vs-re-run harness rejects
  all three as cases that prove nothing, because it compares on-screen renders
  and those keys change what comes out of a file. The button goes through
  matplotlib's own `savefig`, so they apply: at dpi 200 the file really is
  1280x960 rather than the 640x480 a canvas grab would give.

  The `plotpolish-saved` event is cancelable, so a host that cannot let a page
  trigger a download — a sandboxed iframe, which is where this runs — takes the
  bytes and delivers them its own way. That is the trap "Copy code" already
  fell into.

  Button rows no longer repeat their own name in the label column.


- **"Minor grid lines" now turns on the two things it cannot draw without:**
  "Grid" and "Minor tick marks". matplotlib draws a grid line only where a tick
  is, and only when the grid is on at all, so the switch did nothing by itself
  whichever of the two was missing — verified: from a plain figure, one click
  goes from major=0 minor=0 to major=9 minor=29, live and on a re-run alike.
  One click, one write, one apply. Switching the grid lines off leaves both,
  since either is useful by itself — but switching off either of *them* takes
  the grid lines with it, or the switch would be left on and drawing nothing,
  which is the state the whole mechanism exists to prevent. A dependant that
  was never on is left alone, so the block never gains a key the student did
  not touch.


- **The bundle now carries the whole license, not just an identifier.** BSD-3-
  Clause asks a redistribution to reproduce the copyright notice, the list of
  conditions *and* the disclaimer; the banner had only the first of the three.
  It costs 1,746 bytes of a 200 KB bundle (916 gzipped) and means a host that
  vendors plotpolish by curling one file is compliant by serving it, with
  nothing its sync script has to remember. The text is read from `LICENSE` at
  build time rather than retyped, so the two cannot drift, and the SPDX
  identifier stays on the first line. Raised by Copilot on PR #13.

  The release gate that was supposed to protect this could not: it grepped for
  the SPDX line, which vite writes from the same repo two lines earlier, so it
  proved a banner existed and nothing about what was in it. `src/iife.test.ts`
  now compares each bundle's banner against `LICENSE` verbatim.


- **New: an auto-update switch, in the tab pill ("⟳ Auto").** The figure follows every
  change by default; the switch pauses that, and the changes go on being
  written to the block with the "re-run to see" mark the worker path already
  used. It sits in the pill rather than inside a category because a student
  reaches for it when a change is about to be expensive, which is before they
  have opened anything. Turning it back on catches the figure up in one apply.
  It also fires a `plotpolish-auto-update` event, because a host that re-runs
  the program by itself has to stop doing that too — the demo did not, and a
  paused panel marks every change as pending a re-run, which was exactly what
  its auto-re-run was listening for. Pausing made it re-run *more*.

- **The Look category reads top down again.** "Colors" is above "Styles" (it is
  one row; the style grid is five), "Style preset" is just "Styles", and the
  style menu is back beside the label with the names shortened — the sixteen
  seaborn variants read as an indented list under "seaborn" rather than
  repeating the prefix sixteen times. The thumbnails lost their captions, which
  never fitted the 46px cell; the full name is on the tooltip, the accessible
  name and the menu.

- **The tab pill folds rather than cutting.** Collapsing it now animates, and it
  leaves an open category window open — tucking the strip away is for
  reclaiming the figure's corner, not for putting your work away, and closing
  the window lost the student's place every time.


- **New: a regression harness that runs the block and diffs it against the live
  preview** (`python/tests/test_live_matches_rerun.py`). Live preview must show
  what a re-run of the block would draw; that promise had broken in five
  separate places, every one found by eye. The harness runs the student's
  program and applies the settings the way the panel does, then runs the block
  plus the same program from a clean interpreter, and requires the two renders
  to be identical. The reference is computed rather than stored, so there are no
  golden images to refresh and nothing to re-tune when matplotlib moves. Cases
  are built from `controls.json` by the real block generator, so a new control
  arrives with a case; each one has to change at least one pixel or it is
  rejected as proving nothing.

- **Fixed: the legend's swatches never followed the lines.** A legend's sample
  lines are copies taken when it was built, so changing color, width, style,
  marker or the per-line cycle updated the plot and left the swatches behind —
  five controls with one cause. Found by the harness.

- **Fixed: per-line widths applied or not depending on the order keys arrived
  in.** The property cycle's "is this line still where I left it?" test read
  `mpl.rcParams` for its fallback, which the same call had usually already
  overwritten, so it concluded the student had styled every line by hand and
  applied nothing. Found by the harness.

- **Fixed: the axis offset label ("1e6") and the legend title kept their old
  size.** The first is sized by the tick-label rcParam but not by
  `tick_params`; the second follows `font.size`, not `legend.fontsize`.

- **Fixed: resetting one category threw away another's work.** "Colors" (Look)
  and the per-line table (Lines) both write `axes.prop_cycle`, and a reset
  deleted the key outright. Each control now declares in `controls.json` which
  parts of the value it owns, so a reset rewrites the value instead — and the
  reset button no longer offers to undo work the other category did. Restoring
  the palette changes its length, so the surviving per-line arrays are re-zipped
  to match; without that the block would carry a cycler matplotlib refuses.

- **Fixed: a style change did not mark the settings it seeds.** Picking a style
  out of fully-default settings writes `savefig.dpi` and `figure.autolayout`
  into the block. With a backend attached but live preview off — Trinket's
  worker path — nothing applied them and nothing said so.

- **Fixed: sliders ignored their own bounds.** `savefig.dpi` declared 36–1200
  in the schema while the panel hardcoded 72–600; the fontsize and legend x/y
  sliders hardcoded theirs too. They all read the schema now, and a test fails
  if a slider gets its bounds anywhere else. A relative font size that lands
  between steps ("large" at base 12 is 14.4) now puts the thumb on a step the
  slider can hold while the readout keeps the exact value.

- **Fixed: "Minor grid lines" rendered under "Tick marks."** It had no subgroup,
  and the row loop only starts a new heading when the subgroup changes.

- Four tests that passed for the wrong reason were replaced, each verified by
  breaking the behavior and watching the test go red. One of them had been the
  only cover for all nine `isEditing` call sites, and another for the `writing`
  guard — both of which the whole suite passed without.

## 0.2.0 — 2026-09-06

- **New: "Minor grid lines" (Axes → More).** Draws grid lines at the minor
  ticks as well as the major ones, via `axes.grid.which`. It needs Minor ticks
  on — matplotlib draws a minor grid line only where a minor tick exists — and
  the help text says so rather than silently switching a second thing on. This
  is the first control whose key is not a plain boolean, so `bool` controls can
  now declare `onValue`/`offValue` ("both"/"major" here).
- **New: "Copy code" (Save).** Copies the generated block to the clipboard, for
  pasting into a script that has no panel. The async clipboard API is refused
  in some contexts — no user gesture, an insecure origin, an iframe without the
  permission, and Trinket runs the embed in an iframe — so a failure says so
  and points at Show code rather than failing silently.
- **Marker size now tops out at 12 rather than 20.** 20 was past the point of
  being useful.
- **Fixed: the "(all)" master contradicted the table above it.** It read the
  whole property cycle, which spans the palette, while the table shows one row
  per line in the figure — so two rows both plainly reading 8 sat under a
  master insisting they were "mixed". It now reads only the rows the table
  shows, and displays the value they share instead of its own untouched
  scalar, so "mixed" means what it says.

## 0.1.9 — 2026-09-06

- **Fixed: a per-line width or style could stick, updating for one curve but
  not another.** `lines.linewidth` and `axes.prop_cycle`'s `linewidth` both
  drive `Line2D.set_linewidth`, and the scalar "(all)" master ran over every
  line *after* the cycler had set them, undoing the per-line values. Because
  each applier carries its own `only_defaults` guard, it undid them for some
  lines and not others — so one curve would follow the panel while another sat
  at the master's value. `lines.linestyle` had the identical collision with the
  cycler's `linestyle`.

  The rule now matches matplotlib: a cycler carrying `linewidth=[8, 8]` draws
  at 8 even with `lines.linewidth=2`, so when the cycle carries a property the
  scalar sets the rcParam — a re-run and savefig still agree — but does not
  walk the artists. The master is untouched when the cycler omits that
  property, which is the case whenever it is the only thing you have set.

  Swept every other applier for the same collision: on `Line2D` only
  `linewidth` and `linestyle` are written by two keys. `marker` and
  `markersize` have no cycler counterpart, `color` has no scalar master, and
  gridlines are not in `ax.lines`, so `grid.linestyle` is unaffected.

## 0.1.8 — 2026-09-06

- **The bundle now carries its own license notice.** BSD-3-Clause asks binary
  redistributions to reproduce the notice, and hosts vendor plotpolish by
  curling a release asset — which shipped with no license text in it at all, so
  compliance rested on the host going to look for it. Both builds now open with
  a `/*!` banner naming the version, copyright and SPDX identifier, CI fails the
  release if it is missing, and `LICENSE` is attached to the release alongside
  the bundle. This is the same thing Trinket's other vendored files
  (DOMPurify, marked) already do.
- Demo: the sample program plots 40 points rather than 200. Switching on
  markers turned the curves into a solid band, which is the opposite of what a
  marker control is for.

## 0.1.7 — 2026-09-06

- **"Fit labels in figure" is on by default now.** `figure.autolayout` gets a
  `panelDefault` of `true`, so the first change to any control seeds it into
  the block alongside `savefig.dpi`. Enlarging text is the first thing most
  people do, and without autolayout the labels run outside the figure — which
  meant the fix was a switch you had to know to look for. Nothing is written
  to the user's file until they change something, so an untouched panel still
  imposes nothing. (Trinket already forces `figure.autolayout = True` before
  every run, so this changes nothing there; it matters for the demo and any
  host that does not.)
- Release workflow: the sourcemap the bundle already points at is uploaded, so
  a consumer's devtools stop 404ing on it; the tag pattern is `v[0-9]*` rather
  than `v*`, which also matched a tag like `vendor`; and publishing is
  idempotent, so a re-run after a partial failure replaces the assets instead
  of dying on "already exists".
- README says what the project actually is now, rather than "pre-release
  scaffold".

## 0.1.6 — 2026-09-05

- **0.1.5 marked only half of a reset that also resets the style.** Both reset
  flows wrote `if (willResetStyle) noteRerun(["style"]); else if (!canPreview)
  noteRerun(keys);` -- an `else if`, so resetting a Look category that carried
  both a style and rc keys marked the style and left every reverted control
  without an indicator. The two are not alternatives: with no preview both the
  style reset and the reverted keys need a run before they show.

## 0.1.5 — 2026-09-05

- **The reset flows had the same no-preview gap 0.1.4 fixed for changes.**
  `reset()` and `resetCategory()` also branched on
  `client && livePreview` and otherwise did nothing visible: with no backend
  the block was rewritten and neither applied nor marked, so a student hit
  Reset, the figure kept whatever the last run drew, and nothing said why.
  A revert that cannot be previewed is now pending a re-run exactly as a
  change is. `canPreview` is now the only place either condition is spelled
  out.

## 0.1.4 — 2026-09-05

- **With no live preview, changes are now marked "re-run to see".** When a host
  attaches no backend the panel had no way to apply a change *and* no way to
  say so: the student moved a slider, the figure sat there, and nothing
  indicated why. `livePreview` was only ever consulted to decide whether to
  apply; it never marked anything pending. Now a change that cannot be
  previewed raises the same ↻ indicator a style preset does, on the control and
  its tab, and a completed run clears it.

  This is the path Trinket's Web Worker runtime takes -- the program runs off
  the main thread, so there is no interpreter on the page to preview against --
  and it is what the integration plan meant by "the re-run to see path only".
  Found by running that path rather than reading it.

## 0.1.3 — 2026-09-05

Two corrections to the 0.1.2 drag fix.

- **A second pointer ending canceled a drag in progress.** The window-level
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
