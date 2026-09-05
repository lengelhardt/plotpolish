# UX design: a small number of knobs, with drill-down

Status: agreed 2026-09-05 after the first real-Pyodide test. The first panel
showed all twenty-six controls at once and was judged professional but
overwhelming. This document records the redesign and the reasoning; the
control inventory itself lives in `src/schema/controls.json`.

## Principle

The plot must stay visible while a knob is turned, and the student must see
no more than a handful of choices at any one moment. Every knob is reachable
in at most two clicks: category, then control, or category, then "More",
then control. Nothing from the first version is removed; it is tiered.

## Where the panel lives (revised 2026-09-05, after trying the strip)

The first tiered build put the panel in a strip under the figure with a
breadcrumb. In use it wasted screen space (about 400 px tall, two-column
form, every widget far wider than needed) and the breadcrumb made getting
back awkward. Revised decisions:

* **Navigation lives in matplotlib's own toolbar row.** The six category
  tabs sit in one accent-colored pill with a leading "Style" label, to the
  right of matplotlib's buttons, in the space its "Left button pans…" hint
  used. They are always visible, so there is no breadcrumb and no Back.
  Clicking a tab opens its popover; clicking the active tab closes it. The
  pill must be eye-catching: accent background, filled active tab, clearly
  not one of matplotlib's gray buttons.
* **Fallback: a vertical rail** of the same six text tabs on the figure's
  right edge, over the plot margin, about 50 px wide, used when the toolbar
  is too narrow for the pill.
* **Controls open in a draggable popover**, not a sheet or a dock:
  - opens anchored just above the tab that was clicked, with a small caret;
  - a fixed-position layer, so it floats over the plot or anything else and
    nothing in the page shifts;
  - drag by its header, mouse or touch; once dragged the caret goes and it
    becomes a palette: **switching tabs swaps the content in place**; a ⌖
    button or double-clicking the header re-anchors it to the active tab;
  - position remembered for the session;
  - never closes on outside clicks (panning the plot must not dismiss it);
    closes by ✕, Esc, or clicking the active tab;
  - sized to content: about 300 px wide for Look, 320 for Axes, never more
    than 380; about 96 percent opaque with a soft shadow;
  - no resize handles; never more than one popover.
* The host inserts `<plotpolish-panel>` into `div.mpl-toolbar` after the
  format `<select>`, hides `span.mpl-message` and the "Figure 1" title bar,
  and may scale matplotlib's 42 px buttons to about 30 px. WebAgg rebuilds
  the toolbar every run, so the host re-inserts the panel where it already
  calls `refresh()`.

## Drilling down: the widgets (compact budget)

12 px text throughout; one control per 26 px row, label left of widget, 4 px
gap; 8 px popover padding; 22 px header.

| Widget | Use | Size |
| --- | --- | --- |
| switch | on/off | 28 × 16 px |
| segmented pills | two to four choices; glyphs for line styles | 22 px tall, segments ≥ 28 px |
| slider + readout | continuous values | 96 px slider, 32 px value; no separate number box |
| dropdown | long lists (style preset) | 150 px |
| swatch strips | color presets | 64 px strip each, all on one line, names as tooltips only, accent ring on the selected one |
| number pair | figure size | two 52 px boxes |

Per category: primary rows, then a "More ▸" row that expands inline into
the second tier and remembers being open. Nothing else in the popover: no
description sentence, no status line, no banner, no per-category reset
button.

Look, closed:

```
┌ Look ─────────────────────── ⌖ ✕ ┐
│ Preset   [default          ▾] ↻   │
│ Colors   ▪▪▪▪▪▪▪▪ ▪▪▪▪▪▪▪▪ ▪▪▪▪▪▪▪ │
│ More ▸                             │
└────────────────────────────────────┘   about 300 × 96 px
```

Axes with More open: about 320 × 220 px.

## The search tree

Organised by the question a student asks, not by rcParams group. At most six
items on level one. Labels in student words; the rc key appears only in a
tooltip and in the generated block.

| Category | Primary (visible at once) | More |
| --- | --- | --- |
| **Look** | style preset, colors | figure size |
| **Text** | text size (base) | title, axis label, tick label, legend sizes; font |
| **Lines** | line width | line style, marker size |
| **Axes** | grid on/off, box around the plot | grid opacity and style; axes line width; tick direction; minor ticks |
| **Legend** | position, frame | frame opacity |
| **Save** | resolution, transparent background, crop to content | |

Look comes first because the preset changes the most for one click. Figure
size lives under Look because students think of size as part of the overall
look. "Box around the plot" toggles the top and right spines together; the
individual spines are gone from the UI, which is the point. Axes has three
sub-sections, grid, box and tick marks, because it is the only category with
three distinct ideas. Save is last and labelled as applying when saving.

**Legend is hidden when the live figure has no legend**, unless the block
already sets legend keys, in which case it stays with a note. Before the
first run, or with no backend, every category shows.

## Legend position by coordinates

Verified on matplotlib 3.8.4 and 3.10.9: the `legend.loc` rcParam accepts a
pair such as `(0.6, 0.2)`, meaning axes-fraction coordinates of the legend's
lower-left corner, and `Legend.set_loc` accepts the same for live preview.
So the Legend category's position control offers the named locations plus
"Custom position", which reveals two sliders from 0 to 1. The block then
contains `"legend.loc": (0.6, 0.2)`; matplotlib rejects a list there, so it
must be a tuple, and the literal reader gains one grammar rule for a
parenthesised pair of numbers.

Follow-up, not yet built: matplotlib legends are draggable on the WebAgg
canvas. When the Legend category is open the panel can make the legend
draggable, read back where it was dropped, and write that pair into the
block. That is the first concrete step of "pointing at the plot".

## Text strings: deferred to the finishing-block phase

Editing the title, axis labels and legend labels is technically easy for
live preview but crosses design rule 1 as written: those strings must be
applied *after* the student's plotting code, so they need a second owned
block at the end of the file, and for those items the panel would override
the student's own `plt.title(...)`. Three consequences were accepted as the
price of that phase: "your code wins" inverts for those items, legend labels
are addressed by line position and break when a line is added above, and
the block assumes one current axes that is still alive when it runs. All of
which hold in Trinket.

Decision: 0.1 stays rcParams-only and can *show* the current strings
read-only in the Text category; the next phase adds a finishing block with
exactly four things: title, x label, y label, legend labels.

## Later: pointing at the plot

A click on the legend, an axis or a line opens the matching category, using
matplotlib's own hit testing in Python. Feasible on the main-thread path
where the canvas is live; the worker forwards mouse events too, so possible
there with more plumbing. Belongs after the tiered layout has proven itself.

## Feedback (revised)

* **Re-run needed:** a ↻ dot on the affected tab and a small badge beside the
  control. No banner. The `plotpolish-rerun-needed` event lets the host pulse
  its Run button.
* **Changes:** a small dot on any tab whose category has a set value, plus
  the marker on each set control. The "Your changes" chip list from the
  first tiered build is dropped; if students need the full list it returns
  as a "Changes ▾" item in the reset menu.
* **Status** ("Live preview on · matplotlib 3.8.4") becomes a tooltip on the
  pill. Errors show inline: a fence error puts a red mark on the pill and the
  popover shows the message with the "Replace block" button.
* **Reset** is one small "↺ ▾" menu at the end of the pill with
  "Reset <Category>", "Reset all", and "Show code".

## Implementation contract (for the panel shell, v3)

* `<plotpolish-panel>` renders, in order: the tab pill (or rail), the
  popover layer, the reset menu. Properties: `open` (popover visible),
  `category` (active tab id or null), `figureElement` (the host's figure
  container, used to place the rail and to bound re-anchoring),
  `showCategory(id | null)`, `toggle()`. Layout is chosen automatically:
  `layout` attribute reflects "pill" or "rail"; the host may force it.
* Rows keep `.row[data-control=<id>]` and inputs keep `id="ctl-<id>"`; every
  row exists in the DOM at all times and is shown or hidden by category and
  tier, so state syncing stays a single `update()` pass.
* `controls.json` carries the tree unchanged from the tiered build.
* Public API for sink, backend, settings and events is unchanged. US
  spelling everywhere in user-facing text.

## Round three (2026-09-05, after trying the toolbar pill)

Feedback: "looks great", but the pill should be easier to find; the "Style"
label does nothing; dragging was not discoverable; per-line properties for
the two data sets would be really nice; the dpi field showed the word
"figure"; title size seemed to do nothing; ✕ did nothing. Decisions:

* **The pill floats over the plot's top-right corner** (`layout="float"`,
  the default when `figureElement` is set), positioned against the figure
  container's bounding rect with an 8 px inset and re-positioned on
  resize/scroll. Inline `pill` and vertical `rail` remain as host options.
  Maximally discoverable; if it hides a title we will see and adjust.
* **No "Style" label.** The tabs alone are the pill.
* **Drag affordance:** a grip glyph at the left of the popover header, a grab
  cursor, and a "Drag to move" tooltip. Bug fixed: pointer-downs on the
  header's buttons no longer start a drag or capture the pointer, and a drag
  begins only after the pointer moves 4 px, so ✕ and ⌖ receive their clicks.
* **Number fields commit as you type**, debounced like the sliders, so a
  typed title size shows on the plot without Enter or blur.
* **Resolution:** the field shows a number, never the word "figure". 300 dpi
  is plotpolish's opinionated default: `savefig.dpi: 300` is added when the
  block is first created (the first change of anything) unless already set,
  and can be reverted like any value. It affects `plt.savefig()`; the
  toolbar's download button uses the on-screen canvas.
* **Per-line properties through the property cycle.** matplotlib's
  `axes.prop_cycle` can zip color, line width and line style, so
  `mpl.cycler(color=[...], linewidth=[...], linestyle=[...])` means "the
  first line gets these, the second those". The Lines tab gains a "Per line"
  table: one row per line (rows = lines in the live figure, at least 2, at
  most 8, plus an add-row button), each with a color swatch, width and style.
  Live preview applies them to the matching lines. The Look tab's color
  presets write the same key's `color` list. Limits, stated in the tooltip:
  lines are addressed in drawing order, a line whose code passes its own
  `color=`/`lw=` keeps it, and labels are not covered. `axes.prop_cycle`
  therefore becomes a live-category key.
