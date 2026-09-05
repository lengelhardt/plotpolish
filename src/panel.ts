/**
 * <plotpolish-panel>: the Web Component.
 *
 * State is one StyleSettings ({ style, rc }) plus a baseline of effective rc
 * values pulled from the backend. The panel writes the settings into the
 * user's source through a CodeSink (as one fenced block) and previews them on
 * the retained figure through a FigureBackend. It never renders or edits
 * anything else in the user's code.
 *
 * The shell is a tiered drill-down (see docs/ux-design.md): collapsed to one
 * bar by default, level one is a row of category chips plus "Your changes",
 * level two is one category's rows (primary, then a "More" details). Every
 * control row exists in the DOM at all times; only its container's `hidden`
 * changes as `open`/`category` change, so `update()` stays a single pass.
 */

import css from "./panel.css?inline";
import { BackendError, HelperClient, type FigureBackend, type FigureDescription } from "./backend";
import {
  FenceError, defaultSettings, generateBlock, isDefaultSettings, parseBlock, replaceFence, upsertBlock,
  type StyleSettings,
} from "./block";
import { ELEMENT_TAG, EVENT_PREFIX, VERSION } from "./constants";
import {
  CONTROLS, GROUPS, GROUP_BY_ID, RELATIVE_SIZES, controlsInGroup, rcEqual, resolveFontSize,
  type ControlSpec, type GroupSpec, type RcValue,
} from "./schema";
import type { CodeSink } from "./sink";

export interface PanelFeatures {
  /** Apply artist-level equivalents to the retained figure as controls change. */
  livePreview: boolean;
  /** Show the generated block, read-only, under the controls. */
  showCode: boolean;
  /** Group ids to render (see controls.json); null renders all. */
  groups: string[] | null;
  /** When false the panel is always open and the collapsed bar is not rendered. */
  collapsible: boolean;
  /** Start expanded instead of collapsed. Only affects the panel's initial state. */
  startOpen: boolean;
}

const DEFAULT_FEATURES: PanelFeatures = {
  livePreview: true, showCode: true, groups: null, collapsible: true, startOpen: false,
};

export interface ChangeEventDetail {
  settings: StyleSettings;
  block: string | null;
  /** The full source after the write, or null for write-only sinks. */
  source: string | null;
}
export interface RerunNeededEventDetail {
  /** rc keys (or "style") whose change needs a re-run to be visible. */
  keys: string[];
  style: string;
}
export interface PanelErrorEventDetail {
  error: Error;
  context: string;
}

type BackendState = "none" | "connecting" | "ready" | "error";

interface LegendXyView {
  wrap: HTMLElement;
  xRange: HTMLInputElement;
  yRange: HTMLInputElement;
  xOut: HTMLElement;
  yOut: HTMLElement;
}

interface ControlView {
  spec: ControlSpec;
  row: HTMLElement;
  inputs: (HTMLInputElement | HTMLSelectElement)[];
  badges: HTMLElement;
  revert: HTMLButtonElement;
  segmented?: HTMLElement;
  swatchList?: HTMLElement;
  legendXy?: LegendXyView;
  rangeInput?: HTMLInputElement;
}

interface CategoryView {
  container: HTMLElement;
  note: HTMLElement;
  resetButton: HTMLButtonElement;
}

const APPLY_DEBOUNCE_MS = 60;

function schemaDefaults(): Record<string, RcValue> {
  const rc: Record<string, RcValue> = {};
  for (const c of CONTROLS) for (const k of c.keys) rc[k] = Array.isArray(c.default) ? [...c.default] as RcValue : c.default;
  return rc;
}

function cloneSettings(s: StyleSettings): StyleSettings {
  const rc: Record<string, RcValue> = {};
  for (const [k, v] of Object.entries(s.rc)) rc[k] = (Array.isArray(v) ? [...v] : v) as RcValue;
  return { style: s.style, rc };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  for (const c of children) node.append(c);
  return node;
}

export class PlotpolishPanel extends HTMLElement {
  /** rc keys your host sets once at startup; preserved when the panel resets styles. */
  hostRcKeys: string[] = [];

  private _backend: FigureBackend | null = null;
  private client: HelperClient | null = null;
  private _sink: CodeSink | null = null;
  private unsubscribeSink: (() => void) | null = null;
  private _features: PanelFeatures = { ...DEFAULT_FEATURES };

  private settings: StyleSettings = defaultSettings();
  private baseline: Record<string, RcValue> = schemaDefaults();
  /**
   * What the retained figure is believed to sit at, per key: the rc values at
   * the last refresh plus every value this panel has since applied. Sent to
   * apply_live as `previous`, because set_style moves mpl.rcParams while the
   * figure stays as it was drawn.
   */
  private figureRc: Record<string, RcValue> = {};
  /** Last-introspected figure description, or null before any refresh / with no figure. */
  private figure: FigureDescription | null = null;
  private styles: string[] = ["default"];
  private overridden = new Set<string>();
  private unknownKeys: string[] = [];
  private fenceError: FenceError | null = null;
  /** True from a style change until the host calls refresh() after a run. */
  private stale = false;
  private rerunKeys = new Set<string>();
  private backendState: BackendState = "none";
  private backendMessage = "";
  private writing = false;

  private pendingApply: Record<string, RcValue> = {};
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private applyChain: Promise<void> = Promise.resolve();

  private _open = false;
  private openInitialized = false;
  private _category: string | null = null;

  private readonly root: ShadowRoot;
  private views = new Map<string, ControlView>();
  private ui!: {
    panelEl: HTMLElement;
    bar: HTMLElement;
    barSummary: HTMLElement;
    barReset: HTMLButtonElement;
    body: HTMLElement;
    crumbBack: HTMLButtonElement;
    crumbLabel: HTMLElement;
    status: HTMLElement;
    headReset: HTMLButtonElement;
    fenceBanner: HTMLElement;
    fenceMessage: HTMLElement;
    rerunBanner: HTMLElement;
    rerunText: HTMLElement;
    unknownBanner: HTMLElement;
    home: HTMLElement;
    chips: Map<string, HTMLButtonElement>;
    changeList: HTMLElement;
    changeEmpty: HTMLElement;
    code: HTMLDetailsElement;
    codePre: HTMLElement;
    categories: Map<string, CategoryView>;
  };

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.build();
  }

  connectedCallback(): void {
    this.update();
  }

  disconnectedCallback(): void {
    this.unsubscribeSink?.();
    this.unsubscribeSink = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get backend(): FigureBackend | null {
    return this._backend;
  }
  set backend(backend: FigureBackend | null) {
    this._backend = backend;
    this.client = backend ? new HelperClient(backend) : null;
    this.backendState = backend ? "connecting" : "none";
    this.backendMessage = "";
    if (!backend) this.figure = null;
    this.update();
    if (backend) void this.refresh();
  }

  get sink(): CodeSink | null {
    return this._sink;
  }
  set sink(sink: CodeSink | null) {
    this.unsubscribeSink?.();
    this.unsubscribeSink = null;
    this._sink = sink;
    if (sink?.subscribe) {
      this.unsubscribeSink = sink.subscribe(() => {
        if (!this.writing) {
          this.loadFromSink();
          this.update();
        }
      });
    }
    this.loadFromSink();
    this.update();
  }

  get features(): PanelFeatures {
    return { ...this._features, groups: this._features.groups ? [...this._features.groups] : null };
  }
  set features(partial: Partial<PanelFeatures>) {
    this._features = { ...this._features, ...partial };
    this.update();
  }

  /** Whether the panel is expanded. Reflected as the `open` attribute. */
  get open(): boolean {
    return this._open;
  }
  set open(value: boolean) {
    this._open = Boolean(value);
    this.openInitialized = true;
    this.toggleAttribute("open", this._open);
    this.update();
  }

  /** The group id shown at level two, or null at level one. Mutate via showCategory(). */
  get category(): string | null {
    return this._category;
  }

  /** Flip between collapsed and expanded. */
  toggle(): void {
    this.open = !this.open;
  }

  /** Go to level two for `id`, or back to level one for null. */
  showCategory(id: string | null): void {
    this._category = id;
    this.update();
  }

  /** A copy of the current settings. */
  getSettings(): StyleSettings {
    return cloneSettings(this.settings);
  }

  /** The block the current settings generate, or null when everything is default. */
  getBlock(): string | null {
    return generateBlock(this.settings);
  }

  get currentFenceError(): FenceError | null {
    return this.fenceError;
  }

  get availableStyles(): string[] {
    return [...this.styles];
  }

  /** Effective value of an rc key: the user's setting, else the baseline from the backend/style. */
  effective(key: string): RcValue | undefined {
    return this.settings.rc[key] ?? this.baseline[key];
  }

  /**
   * Re-read the source and, when a backend is attached, the style list and the
   * live figure. Hosts call this after every run.
   */
  async refresh(): Promise<void> {
    this.loadFromSink();
    if (this.client) {
      try {
        const [styles, intro] = await Promise.all([this.client.listStyles(), this.client.introspect()]);
        this.styles = styles.length ? styles : ["default"];
        this.baseline = { ...schemaDefaults(), ...intro.rc };
        this.figureRc = { ...intro.rc };
        this.overridden = new Set(intro.overridden);
        this.figure = intro.figure;
        this.stale = false;
        this.rerunKeys.clear();
        this.backendState = "ready";
        this.backendMessage = `matplotlib ${intro.matplotlib}${intro.figure ? "" : ", no figure yet"}`;
      } catch (e) {
        this.backendState = "error";
        this.backendMessage = e instanceof Error ? e.message : String(e);
        this.emitError(e, "refresh");
      }
    }
    this.update();
  }

  /** Clear every setting. Removes the block from the source. */
  reset(): void {
    const previous = this.settings;
    this.settings = defaultSettings();
    this.writeToSink();
    if (this.client && this._features.livePreview) {
      const keys = Object.keys(previous.rc);
      if (previous.style !== "default") this.applyStyle("default", keys);
      else this.scheduleApply(this.baselineFor(keys));
    }
    this.rerunKeys.clear();
    if (previous.style !== "default") this.noteRerun(["style"]);
    this.emitChange();
    this.update();
  }

  /** Replace a malformed fence wholesale with the current settings. Explicit user action only. */
  replaceBlock(): void {
    const sink = this._sink;
    if (!sink) return;
    const src = sink.getSource();
    if (src === null) return;
    this.writing = true;
    try {
      sink.setSource(replaceFence(src, this.settings));
    } finally {
      this.writing = false;
    }
    this.loadFromSink();
    this.emitChange();
    this.update();
  }

  // -------------------------------------------------------------------------
  // Source handling
  // -------------------------------------------------------------------------

  private loadFromSink(): void {
    const sink = this._sink;
    if (!sink) return;
    const src = sink.getSource();
    if (src === null) return;
    try {
      const parsed = parseBlock(src);
      this.fenceError = null;
      this.settings = parsed ? parsed.settings : defaultSettings();
      this.unknownKeys = parsed ? parsed.unknownKeys : [];
    } catch (e) {
      if (e instanceof FenceError) {
        this.fenceError = e;
      } else {
        throw e;
      }
    }
  }

  private writeToSink(): string | null {
    const sink = this._sink;
    if (!sink) return null;
    const src = sink.getSource();
    this.writing = true;
    try {
      if (src === null) {
        const block = generateBlock(this.settings) ?? "";
        sink.setSource(block);
        return null;
      }
      try {
        const next = upsertBlock(src, this.settings);
        this.fenceError = null;
        if (next !== src) sink.setSource(next);
        return next;
      } catch (e) {
        if (e instanceof FenceError) {
          this.fenceError = e;
          this.emitError(e, "write");
          return src;
        }
        throw e;
      }
    } finally {
      this.writing = false;
    }
  }

  // -------------------------------------------------------------------------
  // State changes from controls
  // -------------------------------------------------------------------------

  private setKeys(spec: ControlSpec, value: RcValue | undefined): void {
    const apply: Record<string, RcValue> = {};
    for (const key of spec.keys) {
      if (value === undefined) {
        delete this.settings.rc[key];
        const base = this.baseline[key];
        if (base !== undefined) apply[key] = base;
      } else {
        this.settings.rc[key] = (Array.isArray(value) ? [...value] : value) as RcValue;
        apply[key] = this.settings.rc[key]!;
      }
    }
    this.writeToSink();
    if (spec.category === "rerun") this.noteRerun(spec.keys);
    else if (this.client && this._features.livePreview) this.scheduleApply(apply);
    this.emitChange();
    this.update();
  }

  private setStyle(name: string): void {
    if (name === this.settings.style) return;
    this.settings.style = name;
    this.writeToSink();
    this.noteRerun(["style"]);
    if (this.client) this.applyStyle(name, []);
    this.emitChange();
    this.update();
  }

  /** Baseline values for `keys` (what the figure should return to when an override is cleared). */
  private baselineFor(keys: string[]): Record<string, RcValue> {
    const out: Record<string, RcValue> = {};
    for (const key of keys) {
      const base = this.baseline[key];
      if (base !== undefined) out[key] = base;
    }
    return out;
  }

  /** Revert every control in `groupId` (and, for "look", the style preset). */
  private resetCategory(groupId: string): void {
    const specs = controlsInGroup(groupId);
    const keys = specs.flatMap((s) => s.keys).filter((k) => k in this.settings.rc);
    const willResetStyle = groupId === "look" && this.settings.style !== "default" && this.settings.style !== "";
    for (const key of keys) delete this.settings.rc[key];
    if (willResetStyle) this.settings.style = "default";
    this.writeToSink();
    if (this.client && this._features.livePreview) {
      if (willResetStyle) this.applyStyle("default", keys);
      else if (keys.length) this.scheduleApply(this.baselineFor(keys));
    }
    if (willResetStyle) this.noteRerun(["style"]);
    this.emitChange();
    this.update();
  }

  /**
   * set_style in the session (queued behind pending live applies so
   * `settle()` covers it), refresh the baseline, then re-apply the current
   * overrides on top — plus the baseline for `restoreKeys` that were just cleared.
   */
  private applyStyle(name: string, restoreKeys: string[]): void {
    const client = this.client;
    if (!client) return;
    this.stale = true;
    this.applyChain = this.applyChain
      .then(() => client.setStyle(name, this.hostRcKeys))
      .then((rc) => {
        this.baseline = { ...schemaDefaults(), ...rc };
        if (this._features.livePreview) {
          const again = { ...this.baselineFor(restoreKeys), ...this.settings.rc };
          if (Object.keys(again).length) this.scheduleApply(again);
        }
        this.update();
      })
      .catch((e: unknown) => {
        this.backendState = "error";
        this.backendMessage = e instanceof Error ? e.message : String(e);
        this.emitError(e, "set_style");
        this.update();
      });
  }

  private scheduleApply(rc: Record<string, RcValue>): void {
    Object.assign(this.pendingApply, rc);
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      const batch = this.pendingApply;
      this.pendingApply = {};
      if (!Object.keys(batch).length || !this.client) return;
      const client = this.client;
      const previous: Record<string, RcValue> = {};
      for (const key of Object.keys(batch)) {
        const seen = this.figureRc[key];
        if (seen !== undefined) previous[key] = seen;
      }
      this.applyChain = this.applyChain
        .then(() => client.applyLive(batch, true, previous))
        .then((result) => {
          for (const key of result.applied) {
            const value = batch[key];
            if (value !== undefined) this.figureRc[key] = value;
          }
          if (result.deferred.length) this.noteRerun(result.deferred);
          if (this.backendState === "error") {
            this.backendState = "ready";
            this.backendMessage = "";
          }
          this.update();
        })
        .catch((e: unknown) => {
          this.backendState = "error";
          this.backendMessage = e instanceof BackendError ? e.message : String(e);
          this.emitError(e, "apply_live");
          this.update();
        });
    }, APPLY_DEBOUNCE_MS);
  }

  /** Resolves when pending live-apply / set_style work has finished. For tests and hosts. */
  async settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await this.applyChain;
      if (!this.applyTimer) break;
      await new Promise((r) => setTimeout(r, APPLY_DEBOUNCE_MS + 5));
    }
    await this.applyChain;
  }

  private noteRerun(keys: string[]): void {
    for (const k of keys) this.rerunKeys.add(k);
    this.emit<RerunNeededEventDetail>("rerun-needed", { keys: [...this.rerunKeys], style: this.settings.style });
  }

  private emitChange(): void {
    const sink = this._sink;
    const source = sink ? sink.getSource() : null;
    this.emit<ChangeEventDetail>("change", { settings: cloneSettings(this.settings), block: generateBlock(this.settings), source });
  }

  private emitError(error: unknown, context: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.emit<PanelErrorEventDetail>("error", { error: err, context });
  }

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent(`${EVENT_PREFIX}-${name}`, { detail, bubbles: true, composed: true }));
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private handleEscape(): void {
    if (this._category !== null) {
      this.showCategory(null);
      return;
    }
    if (this._features.collapsible && this._open) this.open = false;
  }

  private ensureStartOpen(): void {
    if (this.openInitialized) return;
    this.openInitialized = true;
    if (this._features.startOpen) {
      this._open = true;
      this.toggleAttribute("open", true);
    }
  }

  private isGroupVisible(group: GroupSpec): boolean {
    if (this._features.groups !== null && !this._features.groups.includes(group.id)) return false;
    if (group.hideWhen === "no-legend" && this.noLegendOnFigure()) {
      return controlsInGroup(group.id).some((c) => c.keys.some((k) => k in this.settings.rc));
    }
    return true;
  }

  private noLegendOnFigure(): boolean {
    return this.backendState === "ready" && this.figure !== null && !this.figure.axes.some((a) => a.legend !== null);
  }

  private legendNoteNeeded(group: GroupSpec): boolean {
    if (group.hideWhen !== "no-legend") return false;
    if (!this.noLegendOnFigure()) return false;
    return controlsInGroup(group.id).some((c) => c.keys.some((k) => k in this.settings.rc));
  }

  // -------------------------------------------------------------------------
  // DOM: build once
  // -------------------------------------------------------------------------

  private build(): void {
    const style = el("style");
    style.textContent = css;

    // --- Collapsed bar ---
    const barToggle = el("button", { type: "button", class: "toggle" }, "Style ▸");
    barToggle.setAttribute("aria-expanded", "false");
    barToggle.addEventListener("click", () => this.toggle());
    const barSummary = el("span", { class: "summary" });
    const barReset = el("button", { type: "button", class: "reset", title: "Clear every setting and remove the block" }, "Reset all");
    barReset.addEventListener("click", () => this.reset());
    const bar = el("div", { class: "bar" }, barToggle, barSummary, barReset);

    // --- Expanded head ---
    const headToggle = el("button", { type: "button", class: "toggle" }, "Style ▾");
    headToggle.setAttribute("aria-expanded", "true");
    headToggle.addEventListener("click", () => this.toggle());
    const crumbBack = el("button", { type: "button", class: "back", hidden: true, title: "Back to categories" }, "‹");
    crumbBack.addEventListener("click", () => this.showCategory(null));
    const crumbLabel = el("span", { class: "crumb-label" }, "Style");
    const crumbs = el("div", { class: "crumbs" }, crumbBack, crumbLabel);
    const status = el("span", { class: "status" });
    const headReset = el("button", { type: "button", class: "reset", title: "Clear every setting and remove the block" }, "Reset all");
    headReset.addEventListener("click", () => this.reset());
    const head = el("div", { class: "head" }, headToggle, crumbs, status, headReset);

    const fenceMessage = el("span");
    const replaceButton = el("button", { type: "button", class: "small" }, "Replace block");
    replaceButton.addEventListener("click", () => this.replaceBlock());
    const fenceBanner = el("div", { class: "banner error", role: "alert", hidden: true }, fenceMessage, replaceButton);

    const rerunText = el("span");
    const rerunBanner = el("div", { class: "banner warn", hidden: true }, rerunText);

    const unknownBanner = el("div", { class: "banner warn", hidden: true });

    // --- Level one: home ---
    const chips = new Map<string, HTMLButtonElement>();
    const chipsEl = el("div", { class: "chips" });
    for (const group of GROUPS) {
      const chip = el("button", { type: "button", class: "chip", title: group.help ?? "" }, group.label);
      chip.dataset.group = group.id;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => this.showCategory(group.id));
      chips.set(group.id, chip);
      chipsEl.append(chip);
    }

    const changeList = el("div", { class: "change-list" });
    const changeEmpty = el("p", { class: "muted" }, "Nothing changed yet. Pick a category above.");
    const changes = el("div", { class: "changes" }, el("h4", {}, "Your changes"), changeList, changeEmpty);

    const codePre = el("pre");
    const code = el("details", { class: "code" }, el("summary", {}, "Generated block"), codePre);

    const note = el("p", { class: "note" }, "Sets matplotlib defaults for this program. Your own code always wins over these defaults.");

    const home = el("div", { class: "home" }, note, chipsEl, changes, code);

    // --- Level two: one category per group ---
    const categories = new Map<string, CategoryView>();
    const categoryEls: HTMLElement[] = [];
    for (const group of GROUPS) {
      const catNote = el("p", { class: "note", hidden: true });
      const resetButton = el("button", { type: "button", class: "reset-category" }, `Reset ${group.label}`);
      resetButton.addEventListener("click", () => this.resetCategory(group.id));

      const primary = el("div", { class: "primary" });
      this.appendRowsWithHeadings(primary, group, controlsInGroup(group.id, "primary"));

      const children: (Node | string)[] = [catNote, resetButton, primary];
      const moreSpecs = controlsInGroup(group.id, "more");
      if (moreSpecs.length) {
        const moreRows = el("div", { class: "more-rows" });
        this.appendRowsWithHeadings(moreRows, group, moreSpecs);
        children.push(el("details", { class: "more" }, el("summary", {}, "More"), moreRows));
      }

      const container = el("div", { class: "category", hidden: true }, ...children);
      container.dataset.group = group.id;
      categories.set(group.id, { container, note: catNote, resetButton });
      categoryEls.push(container);
    }

    const body = el("div", { class: "body" }, head, fenceBanner, rerunBanner, unknownBanner, home, ...categoryEls);

    const panelEl = el("div", { class: "panel" }, bar, body);
    panelEl.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.handleEscape();
    });

    this.root.append(style, panelEl);
    this.ui = {
      panelEl, bar, barSummary, barReset,
      body, crumbBack, crumbLabel, status, headReset,
      fenceBanner, fenceMessage, rerunBanner, rerunText, unknownBanner,
      home, chips, changeList, changeEmpty, code, codePre, categories,
    };
  }

  /** Append `specs`' rows into `container`, inserting an h4.subgroup heading before the first row of each subgroup. */
  private appendRowsWithHeadings(container: HTMLElement, group: GroupSpec, specs: ControlSpec[]): void {
    let lastSubgroup: string | undefined;
    for (const spec of specs) {
      if (group.subgroups && spec.subgroup && spec.subgroup !== lastSubgroup) {
        const sg = group.subgroups.find((s) => s.id === spec.subgroup);
        if (sg) container.append(el("h4", { class: "subgroup" }, sg.label));
        lastSubgroup = spec.subgroup;
      }
      container.append(this.buildControl(spec));
    }
  }

  private buildControl(spec: ControlSpec): HTMLElement {
    const id = `ctl-${spec.id}`;
    const label = el("label", { htmlFor: id, title: spec.help ?? "" }, spec.label);
    const badges = el("div", { class: "badges" });
    const control = el("div", { class: "control" });
    const revert = el("button", { type: "button", class: "revert", title: "Back to the style's default", hidden: true }, "↺");
    revert.setAttribute("aria-label", `Revert ${spec.label}`);
    revert.addEventListener("click", () => this.setKeys(spec, undefined));
    const row = el("div", { class: "row" }, label, badges, control);
    row.dataset.control = spec.id;
    const inputs: (HTMLInputElement | HTMLSelectElement)[] = [];
    let segmented: HTMLElement | undefined;
    let swatchList: HTMLElement | undefined;
    let legendXy: LegendXyView | undefined;
    let rangeInput: HTMLInputElement | undefined;

    const number = (extra: Partial<HTMLInputElement> = {}) => {
      const input = el("input", { type: "number", id, ...extra });
      if (spec.min !== undefined) input.min = String(spec.min);
      if (spec.max !== undefined) input.max = String(spec.max);
      if (spec.step !== undefined) input.step = String(spec.step);
      return input;
    };

    switch (spec.type) {
      case "style": {
        const select = el("select", { id });
        select.addEventListener("change", () => this.setStyle(select.value));
        inputs.push(select);
        control.append(select);
        break;
      }
      case "bool": {
        const input = el("input", { type: "checkbox", id, class: "switch" });
        input.addEventListener("change", () => this.setKeys(spec, input.checked));
        inputs.push(input);
        control.append(input);
        break;
      }
      case "number": {
        if (spec.min !== undefined && spec.max !== undefined) {
          const range = el("input", { type: "range" });
          range.min = String(spec.min);
          range.max = String(spec.max);
          if (spec.step !== undefined) range.step = String(spec.step);
          const numberInput = number();
          range.addEventListener("input", () => {
            numberInput.value = range.value;
            const n = Number(range.value);
            if (Number.isFinite(n)) this.setKeys(spec, n);
          });
          numberInput.addEventListener("change", () => {
            const n = Number(numberInput.value);
            if (numberInput.value !== "" && Number.isFinite(n)) {
              range.value = numberInput.value;
              this.setKeys(spec, n);
            } else this.update();
          });
          rangeInput = range;
          inputs.push(numberInput);
          control.append(el("span", { class: "range-number" }, range, numberInput));
        } else {
          const input = number();
          input.addEventListener("change", () => {
            const n = Number(input.value);
            if (input.value !== "" && Number.isFinite(n)) this.setKeys(spec, n);
            else this.update();
          });
          inputs.push(input);
          control.append(input);
        }
        break;
      }
      case "fontsize": {
        const input = number({ step: "0.5", min: "1" });
        input.addEventListener("change", () => {
          const n = Number(input.value);
          if (input.value !== "" && Number.isFinite(n) && n > 0) this.setKeys(spec, n);
          else this.update();
        });
        inputs.push(input);
        control.append(input);
        break;
      }
      case "dpi": {
        const input = number({ placeholder: "figure" });
        input.addEventListener("change", () => {
          if (input.value === "") this.setKeys(spec, "figure");
          else {
            const n = Number(input.value);
            if (Number.isFinite(n) && n > 0) this.setKeys(spec, n);
            else this.update();
          }
        });
        inputs.push(input);
        control.append(input);
        break;
      }
      case "pair": {
        const w = number({ id, class: "wide" } as Partial<HTMLInputElement>);
        const h = number({ class: "wide" } as Partial<HTMLInputElement>);
        h.setAttribute("aria-label", `${spec.label} height`);
        const commit = () => {
          const a = Number(w.value);
          const b = Number(h.value);
          if (w.value !== "" && h.value !== "" && Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) this.setKeys(spec, [a, b]);
          else this.update();
        };
        w.addEventListener("change", commit);
        h.addEventListener("change", commit);
        inputs.push(w, h);
        control.append(el("span", { class: "pair" }, w, el("span", {}, "×"), h));
        break;
      }
      case "enum": {
        if ((spec.options?.length ?? 0) <= 4) {
          const group = el("div", { class: "segmented", id });
          group.setAttribute("role", "radiogroup");
          for (const opt of spec.options ?? []) {
            const btn = el("button", { type: "button" }, opt.label);
            btn.dataset.value = opt.value;
            btn.setAttribute("aria-pressed", "false");
            btn.addEventListener("click", () => this.setKeys(spec, opt.value));
            group.append(btn);
          }
          segmented = group;
          control.append(group);
        } else {
          const select = el("select", { id });
          for (const opt of spec.options ?? []) select.append(el("option", { value: opt.value }, opt.label));
          select.addEventListener("change", () => this.setKeys(spec, select.value));
          inputs.push(select);
          control.append(select);
        }
        break;
      }
      case "colorcycle": {
        const list = el("div", { class: "swatch-list", id });
        for (const preset of spec.presets ?? []) {
          const btn = el("button", { type: "button", class: "preset" });
          btn.dataset.preset = preset.id;
          btn.setAttribute("aria-pressed", "false");
          const sw = el("span", { class: "swatches" });
          for (const c of preset.colors) {
            const i = el("i");
            i.style.background = c;
            i.title = c;
            sw.append(i);
          }
          btn.append(sw, el("span", { class: "preset-label" }, preset.label));
          btn.addEventListener("click", () => this.setKeys(spec, [...preset.colors]));
          list.append(btn);
        }
        const customBtn = el("button", { type: "button", class: "preset custom", disabled: true, hidden: true }, "Custom (from your file)");
        customBtn.setAttribute("aria-pressed", "true");
        list.append(customBtn);
        swatchList = list;
        control.append(list);
        break;
      }
      case "legendloc": {
        const select = el("select", { id });
        for (const opt of spec.options ?? []) select.append(el("option", { value: opt.value }, opt.label));
        select.append(el("option", { value: "__custom__" }, "Custom position…"));
        select.addEventListener("change", () => {
          if (select.value === "__custom__") this.setKeys(spec, [0.6, 0.2]);
          else this.setKeys(spec, select.value);
        });
        inputs.push(select);

        const xRange = el("input", { type: "range", min: "0", max: "1", step: "0.01" });
        xRange.setAttribute("aria-label", "Legend x");
        const yRange = el("input", { type: "range", min: "0", max: "1", step: "0.01" });
        yRange.setAttribute("aria-label", "Legend y");
        const xOut = el("span", { class: "readout" });
        const yOut = el("span", { class: "readout" });
        const commitXy = () => {
          xOut.textContent = xRange.value;
          yOut.textContent = yRange.value;
          const x = Number(xRange.value);
          const y = Number(yRange.value);
          if (Number.isFinite(x) && Number.isFinite(y)) this.setKeys(spec, [x, y]);
        };
        xRange.addEventListener("input", commitXy);
        yRange.addEventListener("input", commitXy);
        const xyWrap = el(
          "div",
          { class: "legend-xy", hidden: true },
          el("label", {}, "x", xRange, xOut),
          el("label", {}, "y", yRange, yOut),
        );
        legendXy = { wrap: xyWrap, xRange, yRange, xOut, yOut };
        control.append(select, xyWrap);
        break;
      }
    }
    control.append(revert);
    const view: ControlView = { spec, row, inputs, badges, revert };
    if (segmented) view.segmented = segmented;
    if (swatchList) view.swatchList = swatchList;
    if (legendXy) view.legendXy = legendXy;
    if (rangeInput) view.rangeInput = rangeInput;
    this.views.set(spec.id, view);
    return row;
  }

  // -------------------------------------------------------------------------
  // DOM: sync with state
  // -------------------------------------------------------------------------

  private update(): void {
    const { ui } = this;
    if (!ui) return;
    this.ensureStartOpen();

    // Collapsed bar / expanded body.
    if (this._features.collapsible) {
      if (!ui.bar.isConnected) ui.panelEl.insertBefore(ui.bar, ui.body);
      ui.bar.hidden = this._open;
      ui.body.hidden = !this._open;
    } else {
      if (ui.bar.isConnected) ui.bar.remove();
      ui.body.hidden = false;
    }

    const changeCount = Object.keys(this.settings.rc).length + (this.settings.style && this.settings.style !== "default" ? 1 : 0);
    ui.barSummary.textContent = changeCount === 0 ? "Default look" : `${changeCount} change${changeCount === 1 ? "" : "s"}`;

    const resetDisabled = isDefaultSettings(this.settings) && !this.fenceError;
    ui.barReset.disabled = resetDisabled;
    ui.headReset.disabled = resetDisabled;

    // Breadcrumb.
    const group = this._category ? GROUP_BY_ID.get(this._category) : undefined;
    ui.crumbLabel.textContent = group ? `Style › ${group.label}` : "Style";
    ui.crumbBack.hidden = this._category === null;

    // Status line.
    ui.status.classList.toggle("error", this.backendState === "error");
    ui.status.textContent =
      this.backendState === "none" ? "No live preview (no backend)"
      : this.backendState === "connecting" ? "Connecting to Python…"
      : this.backendState === "error" ? `Backend error: ${this.backendMessage}`
      : `Live preview on · ${this.backendMessage}`;

    // Banners.
    ui.fenceBanner.hidden = !this.fenceError;
    if (this.fenceError) {
      ui.fenceMessage.textContent = `${this.fenceError.message} The panel will not write until this is fixed. `;
    }
    ui.rerunBanner.hidden = this.rerunKeys.size === 0;
    if (this.rerunKeys.size) {
      const names = [...this.rerunKeys].map((k) => (k === "style" ? "style sheet" : labelForKey(k))).join(", ");
      ui.rerunText.textContent = `Re-run your program to see: ${names}.`;
    }
    ui.unknownBanner.hidden = this.unknownKeys.length === 0;
    if (this.unknownKeys.length) {
      ui.unknownBanner.textContent = `The block also sets ${this.unknownKeys.join(", ")}, which this panel has no control for. They are kept as they are.`;
    }

    // Level one / two visibility.
    ui.home.hidden = this._category !== null;
    for (const g of GROUPS) {
      const chip = ui.chips.get(g.id)!;
      chip.hidden = !this.isGroupVisible(g);
      chip.setAttribute("aria-pressed", String(this._category === g.id));

      const cat = ui.categories.get(g.id)!;
      cat.container.hidden = this._category !== g.id;
      const noteNeeded = this.legendNoteNeeded(g);
      cat.note.hidden = !noteNeeded;
      if (noteNeeded) cat.note.textContent = "The current plot has no legend.";
      const hasSet =
        controlsInGroup(g.id).some((c) => c.keys.some((k) => k in this.settings.rc)) ||
        (g.id === "look" && this.settings.style !== "" && this.settings.style !== "default");
      cat.resetButton.disabled = !hasSet;
    }

    this.renderChanges();

    // Controls.
    for (const view of this.views.values()) this.updateControl(view);

    // Code preview (bottom of level one).
    ui.code.hidden = !this._features.showCode;
    const block = generateBlock(this.settings);
    ui.codePre.textContent = block ?? "# (no block: every setting is at its default)";
  }

  private renderChanges(): void {
    const { changeList, changeEmpty } = this.ui;
    const chips: HTMLButtonElement[] = [];
    if (this.settings.style && this.settings.style !== "default") {
      const btn = el("button", { type: "button", class: "change-chip" }, `Style preset: ${this.settings.style} ✕`);
      btn.dataset.control = "style";
      btn.addEventListener("click", () => this.setStyle("default"));
      chips.push(btn);
    }
    for (const spec of CONTROLS) {
      if (spec.keys.length && spec.keys.some((k) => k in this.settings.rc)) {
        const value = this.settings.rc[spec.keys[0]!];
        const btn = el("button", { type: "button", class: "change-chip" }, `${spec.label}: ${this.formatShortValue(spec, value)} ✕`);
        btn.dataset.control = spec.id;
        btn.addEventListener("click", () => this.setKeys(spec, undefined));
        chips.push(btn);
      }
    }
    changeList.replaceChildren(...chips);
    changeList.hidden = chips.length === 0;
    changeEmpty.hidden = chips.length !== 0;
  }

  private formatShortValue(spec: ControlSpec, value: RcValue | undefined): string {
    if (value === undefined) return "";
    switch (spec.type) {
      case "bool":
        return value ? "On" : "Off";
      case "enum": {
        const opt = spec.options?.find((o) => o.value === value);
        return opt ? opt.label : String(value);
      }
      case "pair": {
        const arr = value as number[];
        return `${arr[0] ?? ""} × ${arr[1] ?? ""}`;
      }
      case "colorcycle": {
        const colors = value as string[];
        const preset = spec.presets?.find((p) => rcEqual(p.colors, colors));
        return preset ? preset.label : "Custom colors";
      }
      case "legendloc": {
        if (Array.isArray(value)) {
          const arr = value as number[];
          return `Custom (${arr[0] ?? ""}, ${arr[1] ?? ""})`;
        }
        const opt = spec.options?.find((o) => o.value === value);
        return opt ? opt.label : String(value);
      }
      case "dpi":
        return value === "figure" ? "figure" : String(value);
      default:
        return String(value);
    }
  }

  private updateControl(view: ControlView): void {
    const { spec, row, badges, revert } = view;
    const isSet = spec.keys.some((k) => k in this.settings.rc);
    const userOverrides = !this.stale && spec.keys.some((k) => this.overridden.has(k));
    row.classList.toggle("is-set", isSet);
    revert.hidden = !isSet;

    badges.replaceChildren();
    if (spec.category === "save") badges.append(el("span", { class: "badge" }, "applies when saving"));
    if (spec.category === "rerun") badges.append(el("span", { class: "badge rerun" }, "re-run to see"));
    if (userOverrides) badges.append(el("span", { class: "badge user", title: "Your code sets this on the current figure; the default above still applies to anything created afterwards." }, "set in your code"));

    const value = spec.type === "style" ? this.settings.style : this.effective(spec.keys[0] ?? "");

    switch (spec.type) {
      case "style": {
        const select = view.inputs[0] as HTMLSelectElement;
        const names = this.styles.includes(this.settings.style) ? this.styles : [...this.styles, this.settings.style];
        const current = Array.from(select.options).map((o) => o.value);
        if (current.join("\n") !== names.join("\n")) {
          select.replaceChildren(...names.map((n) => el("option", { value: n }, n === this.settings.style && !this.styles.includes(n) ? `${n} (not available here)` : n)));
        }
        select.value = this.settings.style;
        break;
      }
      case "bool":
        (view.inputs[0] as HTMLInputElement).checked = Boolean(value);
        break;
      case "number": {
        const input = view.inputs[0] as HTMLInputElement;
        const v = typeof value === "number" ? String(value) : "";
        input.value = v;
        if (view.rangeInput && v !== "") view.rangeInput.value = v;
        break;
      }
      case "fontsize": {
        const input = view.inputs[0] as HTMLInputElement;
        const base = this.effective("font.size");
        const baseN = typeof base === "number" ? base : 10;
        if (typeof value === "number") {
          input.value = String(value);
          input.title = "";
        } else if (typeof value === "string" && RELATIVE_SIZES.includes(value)) {
          input.value = String(round(resolveFontSize(value, baseN)));
          input.title = `"${value}" = ${round(resolveFontSize(value, baseN))} pt at base ${baseN} pt`;
        } else {
          input.value = value === undefined ? "" : String(value);
        }
        break;
      }
      case "dpi":
        (view.inputs[0] as HTMLInputElement).value = typeof value === "number" ? String(value) : "";
        break;
      case "pair": {
        const [w, h] = view.inputs as HTMLInputElement[];
        if (Array.isArray(value) && value.length === 2 && w && h) {
          w.value = String(value[0]);
          h.value = String(value[1]);
        }
        break;
      }
      case "enum": {
        const v = value === undefined ? "" : String(value);
        if (view.segmented) {
          for (const btn of Array.from(view.segmented.children) as HTMLButtonElement[]) {
            btn.setAttribute("aria-pressed", String(btn.dataset.value === v));
          }
        } else {
          const select = view.inputs[0] as HTMLSelectElement;
          if (v && !Array.from(select.options).some((o) => o.value === v)) select.append(el("option", { value: v }, `${v} (from style)`));
          select.value = v;
        }
        break;
      }
      case "colorcycle": {
        const colors = Array.isArray(value) ? (value as string[]) : [];
        const preset = spec.presets?.find((p) => rcEqual(p.colors, colors));
        const list = view.swatchList!;
        for (const btn of Array.from(list.querySelectorAll<HTMLButtonElement>("button.preset[data-preset]"))) {
          btn.setAttribute("aria-pressed", String(btn.dataset.preset === preset?.id));
        }
        const customBtn = list.querySelector<HTMLButtonElement>("button.preset.custom")!;
        customBtn.hidden = Boolean(preset);
        break;
      }
      case "legendloc": {
        const select = view.inputs[0] as HTMLSelectElement;
        const xy = view.legendXy!;
        if (Array.isArray(value)) {
          select.value = "__custom__";
          xy.wrap.hidden = false;
          const arr = value as number[];
          const x = String(arr[0] ?? 0);
          const y = String(arr[1] ?? 0);
          xy.xRange.value = x;
          xy.yRange.value = y;
          xy.xOut.textContent = x;
          xy.yOut.textContent = y;
        } else {
          xy.wrap.hidden = true;
          select.value = value === undefined ? "best" : String(value);
        }
        break;
      }
    }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function labelForKey(key: string): string {
  for (const c of CONTROLS) if (c.keys.includes(key)) return c.label.toLowerCase();
  return key;
}

/** Register the element under `tag` (default "plotpolish-panel"). Safe to call twice. */
export function registerPanel(tag: string = ELEMENT_TAG): void {
  if (typeof customElements === "undefined") return;
  if (!customElements.get(tag)) customElements.define(tag, PlotpolishPanel);
}

registerPanel();

declare global {
  interface HTMLElementTagNameMap {
    "plotpolish-panel": PlotpolishPanel;
  }
}
