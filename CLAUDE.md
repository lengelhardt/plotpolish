# plotpolish — working notes

A browser panel that formats matplotlib figures for physics students by writing
one fenced block of rcParams into their Python file. Framework-free Web
Component plus a single-file Python helper that ships inside the bundle.

## Spelling

**US spelling everywhere** — in code, comments, docstrings, tests, commit
messages, the changelog and the docs. "color", not "colour"; "behavior", not
"behaviour"; "normalize", not "normalise". matplotlib's own API is US-spelled
(`get_color`, `facecolor`, `axes.prop_cycle`'s `color`), so British forms read
as a second vocabulary sitting beside it.

## Rules that are settled — do not reopen

- The tool owns exactly one fenced block and never edits the student's own
  lines.
- The block emits `mpl.style.use` only for a named style, and **never**
  `mpl.style.use("default")`, `mpl.rcdefaults()` or anything else that resets
  rc wholesale. Trinket sets `figure.autolayout` (and, in the worker,
  `figure.figsize`) through rcParams before every run, and the block runs
  mid-program, so a reset there silently changes every figure the student draws.
- `src/schema/controls.json` is the single source of truth for the controls.
  Widgets read their bounds, subgroups and ownership from it; a control that
  hardcodes any of those has a test that fails.
- Two tiny host interfaces only: `FigureBackend.runPython` and
  `CodeSink.getSource`/`setSource`. Nothing is fetched at runtime.

## The promise the tool rests on

Live preview must show what a re-run of the block would draw. That has broken
in nine separate places so far. `python/tests/test_live_matches_rerun.py` is the
harness that checks it: it runs both figures and compares them pixel for pixel,
with the reference computed rather than stored. Cases are generated from
`controls.json` by `src/live-cases.test.ts`, so a new control arrives with a
case. A divergence with no honest fix is pinned per case with its reason, never
hidden by loosening the comparison.

## Testing habits that this project earned the hard way

- **When a test passes, check it would fail without the fix.** Break the
  behavior, watch the test go red, then put it back. Four tests on one branch
  turned out to be green for reasons other than the one in their title, and two
  of them were the only cover for a guard the whole suite passed without.
- **Before fixing one branch of a condition, grep for the others.** Three
  releases in a row shipped a fix that left its sibling untouched.
- **A test that cannot fail is worse than no test.** A case whose settings draw
  the same figure as no settings proves nothing; the harness rejects those
  outright.

## Running things

- `npx vitest run` — 355 tests, ~6s. Also regenerates
  `python/tests/fixtures/live-cases.json` and fails if the committed copy is
  stale; commit the rewrite.
- `cd python && ../.venv310/bin/python -m pytest -q` — and `.venv38` for
  matplotlib 3.8.4. Both must pass; CI runs both.
- `npm run demo` — use `?backend=mock`. Real mode downloads ~25 MB of Pyodide.
- `npx tsc --noEmit` before committing; the tsconfig target is ES2020, so
  `Array.prototype.at` and friends are not available.
