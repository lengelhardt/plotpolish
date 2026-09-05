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

## Where the panel lives

Options considered:

| Option | For | Against |
| --- | --- | --- |
| Popup or modal in front of the plot | room, focus | hides the plot, so live preview is invisible; modals in iframes clip |
| A tab beside Result / Variables | cheapest in Trinket | hides the plot |
| **Strip docked below the figure toolbar** | plot stays visible, controls sit next to what they change, one button when collapsed, works in every host | takes height from the console while open |
| Side drawer over the console | plot visible, tall | Trinket embeds are too narrow |
| Popover from a toolbar button | on demand, tiny | floats over the canvas; fragile positioning |

**Decision: docked strip below the figure, collapsed to a single "Style"
button by default.** In Trinket's fullscreen there is room below a correctly
sized figure. The panel is position-agnostic, so a later "detach" button can
turn the strip into a draggable palette with a title bar and "dock" can put it
back; the host owns that wrapper and Trinket can ship without it.

## Drilling down: the widgets

* **Level one is a row of category chips**, radio-style, one active. It
  answers "what do you want to change?" in one glance.
* **Level two is one category's controls.** The widget follows the shape of
  the choice: a switch for on/off; segmented buttons for two to four options
  such as tick direction or line style; a slider with a number field for
  continuous values such as line width, text size, opacity; a dropdown only
  for long lists such as style sheets and legend position; a swatch row for
  colour cycles.
* **"More" inside each category** is a closed `<details>` holding the long
  tail. This is the progressive disclosure that fixes "overwhelming" without
  deleting anything.
* **Breadcrumb with Back** at the top of level two, plus Esc.
* **"Your changes" chips on level one**, one per override, each with an ✕.
  The inverse of drilling down: it shows what is set without browsing and
  explains exactly why the block contains what it does.
* **Reset per category and Reset all**, both visible where the choice was made.
* Deferred: a style-sheet gallery of thumbnails (student-friendly but costs
  roughly two hundred kilobytes of bundled images, since Trinket fetches
  nothing at runtime), and a filter box (useful for adults, rarely for
  students).

## The search tree

Organised by the question a student asks, not by rcParams group. At most six
items on level one. Labels in student words; the rc key appears only in a
tooltip and in the generated block.

| Category | Primary (visible at once) | More |
| --- | --- | --- |
| **Look** | style preset, colours | figure size |
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

## Implementation contract (for the panel shell)

* `<plotpolish-panel>` gains `open` (boolean property and attribute) and
  `category` (group id or null). Collapsed: one row with a "Style" toggle, a
  changes summary and Reset all. Expanded, level one: chips and "Your
  changes". Level two: Back, breadcrumb, category reset, primary rows, then
  `<details class="more">`.
* Rows keep `.row[data-control=<id>]` and inputs keep `id="ctl-<id>"`; every
  row exists in the DOM at all times and is shown or hidden by category and
  tier, so state syncing stays a single `update()` pass.
* `controls.json` carries the tree: `groups[].subgroups`, `groups[].hideWhen`,
  `controls[].tier` and `controls[].subgroup`. The panel derives widgets from
  type plus option count; no per-control widget hints.
* Public API, events, sink and backend behaviour are unchanged.
