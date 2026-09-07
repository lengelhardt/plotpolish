Golden fenced blocks. Each `<name>.py` is exactly what the TypeScript
generator must emit for the settings in `<name>.json`.

* Vitest asserts `generateBlock(json) === py` and `parseBlock(py)` deep-equals `json`.
* pytest `exec`s each `.py` on matplotlib 3.8 and 3.10 and checks that
  `mpl.rcParams` ends up matching the `.json`.

The `.json` is the `StyleSettings` object, plus an optional `hostRcKeys` array —
the second argument to `generateBlock`, not part of the settings. `parseBlock`
never returns it, so the round-trip assertions compare against the sidecar with
that field removed.

Change a fixture only when you intend to change the block format.

Format rules the fixtures pin down:

* `mpl.style.use(...)` appears **only** for a named style. The block never
  calls `style.use("default")`, because in a persistent interpreter that
  would also wipe rc values the host sets before each run (Trinket:
  `figure.autolayout`, `figure.figsize`). Session leftovers are handled by
  the panel calling `set_style()` between runs instead.
* When there is a named style **and** the host owns rc keys, the block saves
  those keys into `_plotpolish_host_rc`, applies the style, puts them back and
  `del`s the name. A style sheet may set the very keys the host sets before
  every run — 8 of matplotlib's 29 styles set `figure.figsize`, `seaborn-v0_8`
  among them — so without this a re-run discarded Trinket's pane fit. The
  restore lands **before** the block's own `rcParams.update`, so a key the
  student set still wins. With no named style there is nothing to reset and the
  block is byte-identical to one with no host keys (`host_keys` is the fixture).
* `mpl.rcParams.update({...})` appears only when at least one key is set.
* A fully default state (style `"default"`, no keys) produces **no block**:
  the generator removes an existing fence rather than writing an empty one.
