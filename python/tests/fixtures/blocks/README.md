Golden fenced blocks. Each `<name>.py` is exactly what the TypeScript
generator must emit for the settings in `<name>.json`.

* Vitest asserts `generateBlock(json) === py` and `parseBlock(py)` deep-equals `json`.
* pytest `exec`s each `.py` on matplotlib 3.8 and 3.10 and checks that
  `mpl.rcParams` ends up matching the `.json`.

Change a fixture only when you intend to change the block format.

Format rules the fixtures pin down:

* `mpl.style.use(...)` appears **only** for a named style. The block never
  calls `style.use("default")`, because in a persistent interpreter that
  would also wipe rc values the host sets before each run (Trinket:
  `figure.autolayout`, `figure.figsize`). Session leftovers are handled by
  the panel calling `set_style()` between runs instead.
* `mpl.rcParams.update({...})` appears only when at least one key is set.
* A fully default state (style `"default"`, no keys) produces **no block**:
  the generator removes an existing fence rather than writing an empty one.
