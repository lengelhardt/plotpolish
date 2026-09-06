# Trinket integration plan

Status: **Phase 1 starting.** plotpolish v0.1.0 is released; the Trinket
worktree exists (`feature/plot-style`, off `origin/main`) and its stack has
been verified running clean. No Trinket code has been written yet. The adapter
itself will live in the Trinket repo; this plan says what it has to do and
what plotpolish had to change to make that possible.

The "Survey findings" section records what two read-only surveys of
`picup-trinket-oss` established. **Those surveys were taken against a
different branch and their line numbers ran ~300 high** — the corrected table
under that heading is authoritative, and the "Corrections to the adapter
design" subsection lists three findings that invalidate parts of the prose
above it. Read both before following any design section here.

"Local development setup" describes how to bring the environment up, and the
Docker traps that are worth knowing before you lose an hour to one.

## Goal and non-goals

Goal: a "Plot style" panel in the Python3/Pyodide embed, behind a feature
flag, that writes the fenced block into the student's program and previews
live on the retained figure, on **both** of Trinket's matplotlib runtimes.

Non-goals for the first Trinket release: per-artist editing, any change to
how Trinket runs programs, any change to the block format.

## What plotpolish needs from the host

| Need | Trinket answer | Status |
| --- | --- | --- |
| A `CodeSink` over the editor: `getSource()`, `setSource()`, `subscribe()` | Ace, via Trinket's `codeEditor` widget: `editor.getAllFiles()[mainFile]`; writes through the main file's Ace session; change fan-out by wrapping `api.triggerChange` | plan |
| A `FigureBackend.runPython(code) → Promise<string>` running a ~600-line snippet in a throwaway namespace and returning the last expression as a string | main thread: `pyodide.runPython(code, {globals: pyodide.toPy({})})`, Trinket's own helper idiom; worker: new `plotpolish-run` / `plotpolish-result` messages mirroring `snapshot` | plan |
| `panel.refresh()` after every run | `finishRun()` in pyodide.js, the one completion point for both runtimes | plan |
| A redraw after `apply_live` on the worker path | `canvas.draw()` + `manager.refresh_all()` over `_trinket_managers`, run in the worker's user globals | plan |
| A place in the UI | a "Plot style" tab beside Variables, wired locally in pyodide.js like `variablesTab` | plan |
| A feature flag | `features.plotStyle`: `config/default.yaml` → `base.html` `trinket.config` → `plotStyleEnabled()` | plan |
| A single self-contained script served from Trinket's origin under its CSP | `dist/plotpolish.iife.js` exposing `window.plotpolish` | **done in plotpolish** |

## Interplay already settled on the plotpolish side

* **`figure.autolayout` and the worker's `figure.figsize`.** Trinket sets both
  via rcParams before every run (`MATPLOTLIB_SETUP_CODE`, `MPL_SETUP`). The
  block therefore never calls `mpl.style.use("default")`; a style switch is
  applied between runs with `set_style()`, and the next run's setup restores
  Trinket's values. Nothing for the adapter to do. If Trinket ever moves
  those settings out of the per-run setup, pass them as `panel.hostRcKeys`.
* **Persistent interpreter.** rcParams and open figures survive between runs
  on the main thread; `set_style()` handles style leftovers, and the block is
  self-contained so a fresh interpreter (Clear memory, or the proposed
  clear-before-every-run default) needs nothing.
* **Figure introspection** targets `plt.get_fignums()[-1]` and never creates
  a figure. `plt.close("all")` at the start of each run is fine: the panel
  only introspects after a run, on `refresh()`.
* **Live preview honesty.** `apply_live` compares artists against what the
  panel believes the figure sits at (`previous`), so Trinket's per-run rc
  changes do not confuse it as long as `refresh()` is called after each run.

## Adapter design (to be written in the Trinket repo)

### Sink

The editor is **Ace** (`public/js/plugins/code-editor.js`, a jQuery UI
widget), not Monaco. Three same-named APIs coexist and only one is right:

* `api.getValue()` returns a JSON string of *all files*. Never use it for source.
* Widget-level `editor.getValue()/setValue()` act on whichever **tab is
  active**, which may not be `main.py`.
* The Run button reads `editor.getAllFiles()[mainFile]` (pyodide.js 3201-3202).
  That is `getSource()`.

```js
function trinketSink(api) {
  const editor = api.getEditor();          // pyodide.js 3661
  const main = api.getMainFile();          // "main.py", pyodide.js 3671
  return {
    getSource: () => editor.getAllFiles()[main] ?? "",
    setSource: (s) => writeMainFile(editor, main, s),
    subscribe: (fn) => addChangeListener(fn),
  };
}
```

Two things Trinket needs to grow for this:

* **A way to reach the main file's Ace session** regardless of the active
  tab, e.g. a `getFile(name)` accessor on the widget. Writing through the Ace
  session (`session.replace(fullRange, text)`) keeps the undo stack, so
  Cmd-Z undoes the panel's write; the textarea fallback editor exposes the
  same `setValue` shape and simply loses undo.
* **Change fan-out.** `editor.change(cb)` is single-owner (code-editor.js
  2356-2361): a second call would overwrite Trinket's own
  `api.triggerChange` listener and silently break the paste/undo/tab paths
  that call `_onChange()` directly. Wrap `api.triggerChange` (or the one call
  site at pyodide.js 3589) to fan out to plotpolish instead.

While the panel writes, the wrapped listener fires; `MemorySink` in this repo
shows the re-entrancy guard the adapter needs (the panel also ignores its own
writes via its `writing` flag).

### Backend, main thread

```js
const mainBackend = {
  runPython(code) {
    if (!pyodide || !pyodideReady) return Promise.reject(new Error("Python is not loaded yet"));
    if (running) return Promise.reject(new Error("A program is running"));
    const ns = pyodide.toPy({});
    try { return Promise.resolve(String(pyodide.runPython(code, { globals: ns }))); }
    finally { ns.destroy(); }
  },
};
```

Identical to `PyodideBackend` in this repo and to Trinket's own
`snapshotVariables()` idiom (pyodide.js 1642-1655). The `running` check is
plotpolish's own policy: Trinket does not serialize helper calls against a
program suspended at an `await`, and a synchronous `runPython` at that point
would interleave with the student's program.

### Backend, worker

One request/response pair, modelled on `snapshot` → `snapshot-result`:

* page → worker `{ type: "plotpolish-run", id, code }`
* worker → page `{ type: "plotpolish-result", id, json }`, or the existing
  `{ type: "error", id, traceback }`

Worker handler: `ns = pyodide.toPy({})`, `json = pyodide.runPython(msg.code,
{ globals: ns })`, `ns.destroy()`, post. Page side: a `plotpolishRun(code)`
method on `worker-client.js` using the same `pending[id] = resolve`
correlation as `snapshot()`. The worker backend's `runPython` rejects while
`workerClient.isRunning()`.

After each successful `apply_live` the adapter sends one more
`plotpolish-run` whose code runs in the worker's **user** globals (a second
message flag, or a separate `plotpolish-pump` type) to redraw:

```python
for _m in _trinket_managers.values():
    _m.canvas.draw(); _m.refresh_all()
```

That is the pump `_trinket_show` uses; `draw_idle()` does nothing on Agg.
Hook it to the panel's `plotpolish-change` event, debounced.

### Refresh after run

`finishRun(serializedCode, err)` (pyodide.js 3087-3115) is the single
completion point for both runtimes. Inside it, after the Variables-explorer
snapshot: read `window.__trinketRuntime`, set `panel.backend` to the matching
backend (it can change between runs), then `panel.refresh()`. On the worker
path, `finishRun` runs after `MPL_FLUSH` has shown unshown figures, so the
newest figure is attached and introspectable.

### UI

Per docs/ux-design.md (rounds three to five): the panel renders a small
pill of six category tabs that **floats over the figure's top-right
corner**, and its controls open in a draggable fixed-position popover, so
nothing in Trinket's layout moves. After each run, in the `finishRun` hook,
append `<plotpolish-panel>` anywhere inside the figure pane (it is a
fixed-position layer; the WebAgg toolbar row works and survives the
toolbar's rebuild if re-appended) and set `panel.figureElement` to the
figure container so the pill and popover can position themselves. Hide
`span.mpl-message` and the `ui-dialog-titlebar` to reclaim space. No tab in
`#outputTabs` is needed; the `features.plotStyle` flag gates the insertion.
Optionally listen for `plotpolish-rerun-needed` and re-run the program, as
the demo does, so a style-sheet change shows without a click.

Trinket's embed has no CSS custom properties and no dark mode; everything is
hard-coded light. Set `theme="light"` explicitly so the panel does not
follow a student's OS dark preference on a light page.

### Vendoring

Trinket has two vendoring generations. The modern one, used for KaTeX and
the VPython worker assets, is: Dockerfile `ARG <NAME>_VERSION` +
`ARG <NAME>_SHA256`, `curl` of a pinned **GitHub release asset**,
`sha256sum -c`, copy into `public/components/<name>/`; a
`scripts/sync-<name>.sh` that parses the same ARGs for local dev, wired into
`npm run setup-vendor`; a section in `COMPONENTS.md`. Nothing in
`public/components/` is npm-sourced today, so an npm-dependency copy step
would be a new pattern. Use the release-asset pattern.

Consequences for plotpolish: **publish GitHub releases with
`plotpolish.iife.js` and its sha256 as assets** (a release workflow in this
repo, Phase 3). Trinket then loads it with
`<script src="{{ '/components/plotpolish/plotpolish.iife.js' | cachePrefix }}">`,
or lazily the way `ensureKatex()` injects KaTeX on first use (pyodide.js
1177-1210). If lazily injected, add `components/plotpolish` to
`scripts/deploy-hosting.sh` `RUNNER_PATHS` (line 74) or a CDN-fronted deploy
404s, exactly as documented for KaTeX. The CSP's `script-src 'self'`
already covers same-origin `/components/...` paths; no policy change.

## Phases

0. **Spike (this document).** Surveys, IIFE build, plan. Done when the *survey*
   sections below are filled and the risks list is reviewed.
1. **Main thread behind the flag.** `getFile(name)` accessor on the editor
   widget, change fan-out, sink, main-thread backend with the `running`
   guard, `finishRun` hook, tab UI, locally vendored bundle for dev. Worker
   programs show the panel with live preview disabled
   (`features.livePreview = false`) and the "re-run to see" path only.

   **Do not vendor the dev bundle through `public/components`.** Both compose
   stacks mask that directory with a volume that shadows the host tree and
   survives `up`, so dropping `plotpolish.iife.js` into
   `public/components/plotpolish/` on the host leaves it 404ing with nothing
   in the app log to say why. The usual `-V` (`--renew-anon-volumes`) escape
   does *not* rescue this on the self-host stack: `make mongo` declares
   `public_components` as a **named** volume (docker-compose.yml:16 and 174),
   which `-V` never touches, and `down -v` would take `mongodb_data` and
   `garage_data` — the local database — with it. `-V` only helps the gcr
   stack, whose volumes are anonymous (docker-compose.gcr.yml:43-47). The
   trap is recorded on main in scripts/setup-glowscript.sh:2-9 and
   GETTING_STARTED.md:218-227 (the COMPONENTS.md write-up of it is
   sympy-branch-only).

   **Use `public/js/vendor/` for local dev instead.** It sits inside the plain
   bind mount (`.:/usr/local/node/trinket`) with no volume over it, Trinket
   already tracks vendored files there (`marked-modern.js`, `purify.min.js`),
   and routeParser serves `/js/...` exactly as it serves `/components/...`, so
   `<script src="{{ '/js/vendor/plotpolish.iife.js' | cachePrefix }}">` is
   live on save with no volume surgery at all. `docker compose cp` into the
   running container is the fallback. Phase 3 can still move to the
   release-asset pattern under `public/components/`.
2. **Worker path.** Protocol addition, worker backend, redraw pump.
3. **Deploy.** plotpolish: **done** — `.github/workflows/release.yml` fires on
   `v*` tags and attaches `plotpolish.iife.js` + its sha256; v0.1.0 is
   published and the built asset is byte-for-byte reproducible. Trinket:
   Dockerfile ARGs, `sync-plotpolish.sh`, `setup-vendor`, `RUNNER_PATHS`,
   `COMPONENTS.md`, flag default.

   **Blocker to settle first: plotpolish is a private repo.** The release-asset
   pattern is an unauthenticated `curl` inside a Docker build, which 404s
   against a private repo's assets. Before this phase, either make plotpolish
   public, thread a token through every place Trinket images are built, or
   vendor the bundle another way. Making it public around the classroom trial
   is the cheapest of the three.

## Local development setup

Verified end to end on 2026-09-05 by actually running it.

The work happens in a **git worktree** so the Trinket checkout's own branch is
never disturbed:

```
git -C picup-trinket-oss worktree add -b feature/plot-style \
    ../picup-trinket-plotstyle origin/main
```

`.env` and `config/local.yaml` are gitignored, so they do **not** appear in a
new worktree — copy both from the original checkout by hand. Add the dev flag
to the worktree's `config/local.yaml`:

```yaml
features:
  plotStyle: true    # false in config/default.yaml; on here for dev only
```

Bring it up with `make mongo` (self-host shape: mongo + redis + garage S3),
app on <http://localhost:3000>; stop with `make down-mongo`. A healthy start
logs `DB: mongoose mongodb:27017/trinket ✓` and `Server started on port:
3000`, and `/version` reports the worktree's branch — `build-info.sh` runs on
the host, so it stamps correctly from a worktree.

Docker facts that cost time to learn:

* **`docker-compose.yml` hardcodes `container_name`** (`trinket`, `garage`,
  `garage-init`, `redis`, `mongodb` at lines 12, 110, 133, 155, 163). Compose
  does not namespace those by project, so **two checkouts can never run the
  mongo stack at the same time**, whatever `COMPOSE_PROJECT_NAME` says. The
  gcr stack coexists happily — different names, port 3001.
* **`docker compose down` acts on the whole project, not the compose file.**
  Both compose files in a checkout share the directory-derived project name,
  so a plain `docker compose down` there also stops `trinket-gcr`. Restore it
  with `docker compose -f docker-compose.gcr.yml up -d app`, or be surgical
  with `docker compose stop <service>`.
* **A worktree is its own compose project**, so its volumes start empty —
  including `mongodb_data`, meaning no account and no trinkets. The named
  volumes do seed from the image, though: `/components/src-min-noconflict/
  theme-github.js` returns 200 on a first run with no vendoring step.

## Survey findings

*Filled in from the two survey reports.*

> **Re-keyed 2026-09-05.** The original surveys were taken while the checkout
> sat on `feature/sympy-math-output`, which inserts ~300 lines into
> `pyodide.js` above `finishRun`. Every line number below the "Front-end" and
> "Runtime" headings therefore ran high. The table here is the corrected set,
> verified directly against `origin/main` (66d7edc); prefer it over any
> number quoted in the prose.
>
> | What | origin/main | previously quoted |
> | --- | --- | --- |
> | `finishRun()` | pyodide.js:2790 | 3087 |
> | source read, `editor.getAllFiles()` | pyodide.js:2904 | 3199 |
> | `editor.change(...)` fan-out | pyodide.js:3292 | 3589 |
> | `getEditor()` / `getMainFile()` | pyodide.js:3364 / 3373 | 3661 / 3671 |
> | `variableExplorerEnabled()` | pyodide.js:1344 | — |
> | `stepDebuggerEnabled()` | pyodide.js:1405 | — |
> | editor widget instantiation | pyodide.js:3129 | 3426 |
> | `base.html` flag emission | base.html:41-44 | — |
> | `getFile(fileName)` | code-editor.js:2174 | — |
>
> Also branch-only, and therefore **not available to copy from**:
> `ensureKatex()`, `mathOutputEnabled()`, `scripts/sync-katex.sh`, and the
> `COMPONENTS.md` write-up of the volume-shadowing trap. On `origin/main` that
> trap is recorded instead in `scripts/setup-glowscript.sh:2-9` and
> `GETTING_STARTED.md:218-227`.

### Corrections to the adapter design

Three things the first survey got wrong, each of which would have cost a
debugging session:

* **`getFile(fileName)` already exists** (code-editor.js:2174) and returns the
  file's *text*. Use it for `getSource()`. The session-returning accessor this
  plan proposed under the same name would have silently shadowed it — give
  that one a different name.
* **`finishRun()` is not the only completion point.** Step-through recording
  (`runStepThrough`, pyodide.js:1870-1950, finishing via `recordingDone()`)
  and the REPL both bypass it, and both can create or close figures. With
  `stepDebugger: true` — the local dev default — the panel can therefore go
  stale after a recording unless `recordingDone()` is hooked too.
* **`editor.change(cb)` is single-owner** (`this._onChange = cb`), so calling
  it again replaces Trinket's own listener rather than adding to it. Wrap
  `api.triggerChange`; do not re-register. Hooking Ace's per-file session
  `change` directly is not equivalent — it misses files added later, upload,
  rename, tab close/restore, hide/show and comment edits, all of which notify
  only through the widget-level `_onChange`.

### Front-end

* **Editor is Ace 1.2.6 (Trinket fork)**, self-hosted from the legacy
  components tarball, as a plain script defining `window.ace`, wrapped by
  `$.widget('trinket.codeEditor')` in `public/js/plugins/code-editor.js` and
  instantiated at pyodide.js 3426. A `linedtextarea` fallback with the same
  `getValue/setValue/change` surface exists in the same file, selected by
  `disableAceEditor` / `aceOff`. No separate mobile editor.
* **Reading source:** `editor.getAllFiles()[mainFile]` (pyodide.js 3199-3202,
  with a comment warning against `api.getValue()`). Accessors already on the
  public `api`: `getEditor()`, `getMainFile()` (3661-3673).
* **Change hook** `editor.change(cb)` is single-owner (code-editor.js
  2356-2361); Trinket's only listener is `api.triggerChange` (pyodide.js 3589).
* **Layout** (pyodide.html 391-467): `#editor` | `#dragbar` | `#codeOutput`
  containing `#outputTabs` (Result, Instructions, Variables), `#outputContainer`
  (`#graphic`, `#output-dragbar`, `#console-output`) and sibling panels
  `#variables-wrap`, instructions. Two splitters: editor↔output (embed.js
  2001-2045) and graphic↔console (pyodide.js 3598-3624); neither needs to
  know about a new sibling panel.
* **Feature flags:** `config/default.yaml` `features:` (lines 10-18) →
  `lib/views/embed/base.html` 22-46 emits `trinket.config.<flag>` →
  `<flag>Enabled()` helpers in pyodide.js (1638, 1149). Template gates use
  `config.features.<flag>`.
* **CSP:** `config/default.yaml` 569-597, `script-src 'self' {origin}
  'unsafe-inline' 'unsafe-eval' {cdn}` with cdnjs and jsDelivr as the only CDN
  origins, meant to shrink, not grow.
* **Theming:** none. No CSS variables, no dark mode, hard-coded light colors
  in `public/css/embed/embed.css` and inline styles.

### Runtime

All references are to `picup-trinket-oss` at the survey date.

**Main thread (`public/js/embed/pyodide.js`).**
* Interpreter: `var pyodide`, readiness `pyodideReady` (lines 85-87), set at the
  end of `ensurePyodide()` (628-766). Adapter precondition: `pyodide && pyodideReady`.
* Run flow: `runCode()` (1319) → `startRun()` (3161) → runtime chosen per run
  (3204-3216) → `syncFilesToFS()` → `loadPackagesFromImports` (3256) →
  `MATPLOTLIB_SETUP_CODE` (39-46, run at 3262) → `runProgram()` (1288-1312).
* **Completion chokepoint: `finishRun(serializedCode, err)` (3087-3115)**, called
  from the worker path (3073) and the main-thread success, cancel and error
  paths (3295, 3300, 3311). It sets `running = false` and re-snapshots the
  Variables explorer. `panel.refresh()` goes here, after that snapshot.
* Helper idiom (1642-1655, 1669-1687): `ns = pyodide.toPy({...})`,
  `pyodide.runPython(HELPER, { globals: ns })` returning a JSON string,
  `ns.destroy()` in `finally`. `PyodideBackend` in this repo is the same shape.
  Documented as a deliberate, reusable pattern in
  `docs/design/variable-explorer-mvp.md` and `pyodide-debugger-mvp.md`.
* Concurrency: `running` (line 88) is the run flag, but `expandNode()` calls
  `pyodide.runPython` with no guard, so nothing in Trinket serializes helper
  calls against a program suspended at an `await`. The adapter must reject
  `runPython` while `running` is true; the panel then shows the backend error
  and keeps writing the block.

**Worker (`public/js/embed/pyodide-worker.js`).**
* Persistent across ordinary runs; discarded only for VPython runs, Stop on a
  VPython run, and Clear memory (`discardWorker()`, 3005/3153/3722 in pyodide.js).
* Protocol today: page→worker `init`, `run`, `snapshot`, `mpl-event`,
  `stdin-reply`, `scene-event`; worker→page `ready`, `stdout`/`stderr`,
  `input-request`, `figure` (kinds `png`/`assets`/`new`/`json`/`text`),
  `scene-ops`, `snapshot-result`, `done`, `error` (dispatch at 583-653).
* **Request/response precedent: `snapshot` → `snapshot-result`** (588-603),
  correlated by id in `worker-client.js` (`pending[id] = resolve`). The
  plotpolish addition mirrors it exactly:
  page→worker `{ type: "plotpolish-run", id, code }`; worker runs `code` with
  `pyodide.runPython(code, { globals: pyodide.toPy({}) })` and posts
  `{ type: "plotpolish-result", id, json }` or the existing `error` shape.
* Figures: `MPL_SETUP` (338-441) uses Agg, re-asserts `figure.autolayout` and
  a pane-fitting `figure.figsize`, and patches `plt.show` (`_trinket_show`) to
  attach a `FigureManagerWebAgg` per figure, `canvas.draw()` then
  `manager.refresh_all()`. `MPL_FLUSH` (445-449) shows unshown figures at the
  end of a run. The only redraw pump is `manager.refresh_all()`, reached from
  `_trinket_show` and from `_trinket_mpl_event` (420-438).
* **Redraw after `apply_live`:** run a second, tiny snippet in the worker's
  *user* globals (where `_trinket_managers` lives):
  `for _m in _trinket_managers.values(): _m.canvas.draw(); _m.refresh_all()`.
  `draw_idle()` is not enough on Agg; `_trinket_show` says so at 409-417.
* Worker figures are **never closed** (no `close()` anywhere in the file), so
  `plt.get_fignums()` grows across runs and `MPL_FLUSH` re-announces old
  figures. plotpolish introspects `get_fignums()[-1]`, the newest, which is
  the right one; the accumulation is a Trinket issue worth a separate ticket.

**Which runtime.** Chosen on every `startRun()` by `runtimeRouter.chooseRuntime`
from the program text (VPython detection), site flags `workerEnabled` /
`workerVPython`, `?runtime=` and the trinket's stored setting; published as
`window.__trinketRuntime` (3215-3216). It can change between runs, so the
adapter sets `panel.backend` (main-thread or worker backend) inside the
`finishRun` hook, not once at load.

**rcParams and Clear memory.** `MATPLOTLIB_SETUP_CODE` resets only
`figure.autolayout` and closes figures; other rcParams a student's code set
persist for the page's lifetime. Clear memory on the main thread clears
`globals()` but not `sys.modules`, so rcParams survive it too; on the worker
it discards the interpreter. The "clear before every run" default is
recommended but not implemented. plotpolish's `set_style()` covers the
leftover-style case; leftover rcParams from student code remain Trinket's
concern and are unchanged by the panel.

**Figure retention.** Main thread: figures stay open until the next run's
`close("all")`, so introspection after `finishRun` works. Worker: figures are
never closed. The survey could not confirm from Trinket's code that the
patched WebAgg backend repaints on `draw_idle()`; the plotpolish demo against
Pyodide 0.28.1 confirms it does (grid and line width changed on the canvas
without a re-run).

## Risks

1. **Wrong-editor assumptions.** Anything written against Monaco is wrong;
   Ace's session API is the target, and the textarea fallback must keep
   working with plain `setValue`.
2. **Clobbering Trinket's change listener.** A second `editor.change()`
   call breaks paste, undo and tab-restore change notifications for the
   whole embed. Fan out through `api.triggerChange` instead.
3. **Helper calls during a suspended run.** Trinket does not guard against
   `runPython` while a program awaits `input()`/`rate()`. The adapter must
   reject while `running` / `workerClient.isRunning()`; the panel already
   surfaces backend errors without losing state.
4. **Runtime switches between runs.** Set `panel.backend` inside the
   `finishRun` hook from `window.__trinketRuntime`, never once at load.
5. **Worker figures accumulate** (never closed) and are re-announced on each
   `MPL_FLUSH`. plotpolish uses the newest figure so it works, but this is a
   Trinket bug to file separately; it also means introspection sees
   `n_figures > 1` routinely on the worker.
6. **Clear memory does not reset rcParams on the main thread.** Leftover
   rcParams from a student's own code persist across runs regardless of the
   panel; `set_style()` covers the panel's own style changes only.
7. **Release plumbing is on the critical path.** The Dockerfile pattern needs
   a GitHub release asset with a sha256; until plotpolish publishes releases,
   local dev can only vendor by copying `dist/` by hand.
8. **Lazy-load and CDN hosting.** If the bundle is injected on first use, it
   must be listed in `deploy-hosting.sh` `RUNNER_PATHS` or it 404s behind
   the CDN.
9. **Two access paths the surveys could not read** (`component()` URL
   construction, the CSP middleware) live in `lib/util`/`lib/controllers`,
   outside the surveyed paths. Confirm before Phase 3.
