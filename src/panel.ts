/**
 * <plotpolish-panel>: the Web Component.
 *
 * State is one StyleSettings ({ style, rc }) plus a baseline of effective rc
 * values pulled from the backend. The panel writes the settings into the
 * user's source through a CodeSink (as one fenced block) and previews them on
 * the retained figure through a FigureBackend. It never renders or edits
 * anything else in the user's code.
 *
 * The shell (see docs/ux-design.md, "v3") is an inline-flex tab pill (or a
 * vertical rail fallback) that lives in the host's toolbar row, plus two
 * fixed-position layers that escape any overflow clipping: a draggable
 * popover for the active category's controls, and a small reset menu. Every
 * control row and every category's container exists in the DOM at all times;
 * only `hidden` and a handful of classes change as state changes, so
 * `update()` stays a single pass.
 */

import css from "./panel.css?inline";
import { BackendError, HelperClient, type FigureBackend, type FigureDescription } from "./backend";
import {
  FenceError, defaultSettings, generateBlock, isDefaultSettings, parseBlock, replaceFence, upsertBlock,
  type StyleSettings,
} from "./block";
import { ELEMENT_TAG, EVENT_PREFIX, VERSION } from "./constants";
import {
  CONTROL_FOR_KEY, CONTROLS, GROUPS, GROUP_BY_ID, RELATIVE_SIZES, controlsInGroup, isPropCycle, rcEqual,
  resolveFontSize,
  type ControlSpec, type GroupSpec, type PropCycleValue, type RcValue,
} from "./schema";
import type { CodeSink } from "./sink";

export interface PanelFeatures {
  /** Apply artist-level equivalents to the retained figure as controls change. */
  livePreview: boolean;
  /** Whether the "Show code" item exists in the reset menu. */
  showCode: boolean;
  /** Group ids to render (see controls.json); null renders all. */
  groups: string[] | null;
}

const DEFAULT_FEATURES: PanelFeatures = { livePreview: true, showCode: true, groups: null };

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
type LayoutMode = "pill" | "rail" | "float";

function parseLayoutAttr(value: string | null): LayoutMode {
  return value === "rail" ? "rail" : value === "float" ? "float" : "pill";
}

interface LegendLocView {
  xRange: HTMLInputElement;
  yRange: HTMLInputElement;
  xOut: HTMLElement;
  yOut: HTMLElement;
  snap: HTMLSelectElement;
}

interface LineRowView {
  row: HTMLElement;
  color: HTMLInputElement;
  width: HTMLInputElement;
  styleSeg: HTMLElement;
}

interface ControlView {
  spec: ControlSpec;
  row: HTMLElement;
  inputs: (HTMLInputElement | HTMLSelectElement)[];
  badges: HTMLElement;
  revert: HTMLButtonElement;
  segmented?: HTMLElement;
  swatchList?: HTMLElement;
  legendLoc?: LegendLocView;
  rangeInput?: HTMLInputElement;
  readout?: HTMLElement;
  /** pair: the width/height sub-rows' own readouts, in input order. */
  pairOuts?: HTMLElement[];
  lineRows?: LineRowView[];
  addLineBtn?: HTMLButtonElement;
  /** style: the "Applies on the next run." note under the preset select. */
  nextRunNote?: HTMLElement;
}

interface GroupView {
  container: HTMLElement;
  note: HTMLElement;
  primaryRows: HTMLElement;
  moreRows?: HTMLElement;
  moreButton?: HTMLButtonElement;
}

interface TabView {
  /** [pill button, rail button] — both exist at all times; layout decides which is visible. */
  buttons: HTMLButtonElement[];
  dots: HTMLElement[];
  reruns: HTMLElement[];
}

interface DragStart {
  x: number;
  y: number;
  left: number;
  top: number;
  pointerId: number;
  /** True once the pointer has moved past the drag threshold and capture began. */
  captured: boolean;
}

const APPLY_DEBOUNCE_MS = 60;
const RAIL_WIDTH = 50;
const FLOAT_INSET_PX = 8;
/** Pixels the pointer must move before a header pointerdown becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

/** matplotlib line-style glyphs, used on the compact segmented control. */
const LINESTYLE_GLYPHS: Readonly<Record<string, string>> = { "-": "―", "--": "– –", "-.": "–·", ":": "···" };
const LINESTYLE_LABELS: Readonly<Record<string, string>> = { "-": "Solid", "--": "Dashed", "-.": "Dash-dot", ":": "Dotted" };
const LINESTYLE_VALUES: readonly string[] = ["-", "--", "-.", ":"];

/**
 * Representative lower-left corner (axes fractions) for each named legend
 * location, used to seed the x/y sliders when a named string is in effect
 * and the live figure has not reported where it actually drew the legend.
 */
const LEGEND_FALLBACK_XY: Readonly<Record<string, readonly [number, number]>> = {
  best: [0.75, 0.75],
  "upper right": [0.75, 0.75],
  "upper left": [0.05, 0.75],
  "lower left": [0.05, 0.05],
  "lower right": [0.75, 0.05],
  right: [0.75, 0.45],
  "center right": [0.75, 0.45],
  "center left": [0.05, 0.45],
  "lower center": [0.4, 0.05],
  "upper center": [0.4, 0.75],
  center: [0.4, 0.45],
};

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

/** Cycle or truncate `arr` to exactly `len` entries (matplotlib's cycler semantics). */
/** Truncate or pad `arr` to `len`, padding with `fill` (never by cycling: a per-line pattern must not repeat). */
function resizeArray<T>(arr: readonly T[], len: number, fill: T): T[] {
  const out: T[] = [];
  for (let i = 0; i < len; i++) out.push(i < arr.length ? arr[i]! : fill);
  return out;
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

  static get observedAttributes(): string[] {
    return ["layout"];
  }

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
  private _category: string | null = null;
  private _menuOpen = false;
  private _codeOpen = false;
  private _layoutMode: LayoutMode = "pill";
  private _layoutForced = false;
  private _settingLayoutAttr = false;
  private _figureElement: HTMLElement | null = null;
  private moreOpen = new Map<string, boolean>();
  private dragPos: { x: number; y: number } | null = null;
  private dragStart: DragStart | null = null;
  /** The pill's own dragged position, session-only; while set it overrides the top-right float anchor. */
  private pillPos: { x: number; y: number } | null = null;
  private pillDragStart: DragStart | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private docClickHandler: ((e: Event) => void) | null = null;

  private readonly root: ShadowRoot;
  private views = new Map<string, ControlView>();
  private tabViews = new Map<string, TabView>();
  private ui!: {
    pill: HTMLElement;
    pillGrip: HTMLElement;
    errMark: HTMLElement;
    menuToggle: HTMLButtonElement;
    rail: HTMLElement;
    popover: HTMLElement;
    header: HTMLElement;
    title: HTMLElement;
    reanchorBtn: HTMLButtonElement;
    closeBtn: HTMLButtonElement;
    caret: HTMLElement;
    popBody: HTMLElement;
    banner: HTMLElement;
    fenceMessage: HTMLElement;
    unknownNote: HTMLElement;
    menu: HTMLElement;
    resetCategoryItem: HTMLButtonElement;
    resetAllItem: HTMLButtonElement;
    showCodeItem: HTMLButtonElement;
    codePre: HTMLElement;
    groups: Map<string, GroupView>;
  };

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.build();
  }

  connectedCallback(): void {
    // Re-parenting runs disconnected -> connected, which dropped the sink
    // subscription; restore it and re-read the source, which may have changed
    // while the element was detached.
    this.subscribeSink();
    this.loadFromSink();
    this.update();
    this.measureLayout();
    this.positionRail();
    this.positionFloatPill();
    this.docClickHandler = (e: Event) => {
      if (!this._menuOpen) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.includes(this.ui.menu) || path.includes(this.ui.menuToggle)) return;
      this.closeMenu();
    };
    document.addEventListener("click", this.docClickHandler, true);
    this.setupResizeObservers();
    window.addEventListener("resize", this.onWindowReflow);
    window.addEventListener("scroll", this.onWindowReflow, true);
    window.addEventListener("pointerup", this.onWindowPointerEnd);
    window.addEventListener("pointercancel", this.onWindowPointerEnd);
  }

  disconnectedCallback(): void {
    this.unsubscribeSink?.();
    this.unsubscribeSink = null;
    if (this.docClickHandler) {
      document.removeEventListener("click", this.docClickHandler, true);
      this.docClickHandler = null;
    }
    this.teardownResizeObservers();
    window.removeEventListener("resize", this.onWindowReflow);
    window.removeEventListener("scroll", this.onWindowReflow, true);
    window.removeEventListener("pointerup", this.onWindowPointerEnd);
    window.removeEventListener("pointercancel", this.onWindowPointerEnd);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== "layout" || this._settingLayoutAttr || newValue === oldValue) return;
    if (newValue === null) {
      // Attribute removed: back to automatic detection (float when a figure is known).
      this._layoutForced = false;
      this.measureLayout();
      this.positionRail();
      this.positionFloatPill();
      return;
    }
    this._layoutForced = true;
    const mode = parseLayoutAttr(newValue);
    if (mode !== this._layoutMode) {
      this._layoutMode = mode;
      this.positionRail();
      this.positionFloatPill();
      this.update();
    }
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
    this._sink = sink;
    this.subscribeSink();
    this.loadFromSink();
    this.update();
  }

  /**
   * (Re)attach the sink's change listener. Called both when the sink is set and
   * from connectedCallback, because disconnectedCallback drops the subscription
   * and a host may re-parent the element -- WebAgg rebuilds the figure's DOM on
   * every run, so a panel mounted in that subtree is moved routinely. Without
   * this, the panel stops noticing edits made outside it after the first move.
   */
  private subscribeSink(): void {
    this.unsubscribeSink?.();
    this.unsubscribeSink = null;
    const sink = this._sink;
    if (!sink?.subscribe) return;
    this.unsubscribeSink = sink.subscribe(() => {
      if (!this.writing) {
        this.loadFromSink();
        this.update();
      }
    });
  }

  get features(): PanelFeatures {
    return { ...this._features, groups: this._features.groups ? [...this._features.groups] : null };
  }
  set features(partial: Partial<PanelFeatures>) {
    this._features = { ...this._features, ...partial };
    this.update();
  }

  /** The host's figure container: bounds the rail's position and its ResizeObserver. */
  get figureElement(): HTMLElement | null {
    return this._figureElement;
  }
  set figureElement(value: HTMLElement | null) {
    this._figureElement = value;
    this.teardownResizeObservers();
    this.setupResizeObservers();
    this.measureLayout();
    this.positionRail();
    this.positionFloatPill();
    this.update();
  }

  /**
   * "pill", "rail" or "float" (the pill as a fixed layer over `figureElement`'s
   * top-right corner). Reflected as the `layout` attribute; set it to force one.
   */
  get layout(): LayoutMode {
    return this._layoutMode;
  }
  set layout(value: LayoutMode) {
    this._layoutForced = true;
    this.setLayoutMode(parseLayoutAttr(value));
  }

  /** Whether the popover is visible. Reflected as the `open` attribute. */
  get open(): boolean {
    return this._open;
  }
  set open(value: boolean) {
    const next = Boolean(value);
    if (next === this._open) return;
    if (next) this.showCategory(this._category ?? this.firstVisibleGroupId());
    else {
      this._open = false;
      this.reflectOpenAttr();
      this.update();
    }
  }

  /** The group id shown in the popover, or null when closed. Mutate via showCategory(). */
  get category(): string | null {
    return this._category;
  }

  /** Open the popover if closed (on the last/first category), or close it if open. */
  toggle(): void {
    this.open = !this._open;
  }

  /** Show `id`'s controls in the popover (opening it), or close the popover for null. */
  showCategory(id: string | null): void {
    const wasOpen = this._open;
    const changed = this._category !== id;
    this._category = id;
    this._open = id !== null;
    this.reflectOpenAttr();
    this.update();
    if (this._open && (!wasOpen || changed)) {
      if (this.dragPos) this.applyDragPosition();
      else this.positionPopover();
    }
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
    // A run has just completed, so nothing is pending a re-run any more. This
    // is true whether or not a backend is attached: on a host that runs the
    // program off the main thread there is no client to introspect with, and
    // leaving the marks set would strand them on permanently.
    this.stale = false;
    this.rerunKeys.clear();
    if (this.client) {
      try {
        const [styles, intro] = await Promise.all([this.client.listStyles(), this.client.introspect()]);
        this.styles = styles.length ? styles : ["default"];
        this.baseline = { ...schemaDefaults(), ...intro.rc };
        this.figureRc = { ...intro.rc };
        this.overridden = new Set(intro.overridden);
        this.figure = intro.figure;
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

  /** Resolves when pending live-apply / set_style work has finished. For tests and hosts. */
  async settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await this.applyChain;
      if (!this.applyTimer) break;
      await new Promise((r) => setTimeout(r, APPLY_DEBOUNCE_MS + 5));
    }
    await this.applyChain;
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
    const wasDefault = isDefaultSettings(this.settings);
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
    if (value !== undefined) this.unifyPerLine(spec, apply);
    const seeded = this.seedPanelDefaults(wasDefault);
    this.writeToSink();
    // Without a preview, a change cannot show until the program runs again, so
    // it is pending a re-run for the same reason a style preset always is.
    if (spec.category === "rerun" || !this.canPreview) this.noteRerun(spec.keys);
    else this.scheduleApply(apply);
    this.applySeeded(seeded);
    this.emitChange();
    this.update();
  }

  /**
   * "Line width (all)" and "Line style (all)" are masters over the per-line
   * table. Setting one drops the matching per-line array from
   * axes.prop_cycle, so every row follows it and the block stays short, and
   * previews the new value on every line (the lines currently sit at their
   * per-line values, so the preview carries an explicit array of the master).
   */
  private unifyPerLine(spec: ControlSpec, apply: Record<string, RcValue>): void {
    const prop = spec.keys.includes("lines.linewidth") ? "linewidth" : spec.keys.includes("lines.linestyle") ? "linestyle" : null;
    if (!prop) return;
    const cycle = this.settings.rc["axes.prop_cycle"];
    if (!isPropCycle(cycle) || !cycle[prop]) return;
    const n = cycle[prop]!.length;
    const rest: PropCycleValue = { color: [...cycle.color] };
    if (prop !== "linewidth" && cycle.linewidth) rest.linewidth = [...cycle.linewidth];
    if (prop !== "linestyle" && cycle.linestyle) rest.linestyle = [...cycle.linestyle];
    this.settings.rc["axes.prop_cycle"] = rest.linewidth || rest.linestyle ? rest : [...rest.color];
    const master = this.settings.rc[spec.keys[0]!];
    const preview: PropCycleValue = { color: [...rest.color] };
    if (rest.linewidth) preview.linewidth = [...rest.linewidth];
    if (rest.linestyle) preview.linestyle = [...rest.linestyle];
    if (prop === "linewidth" && typeof master === "number") preview.linewidth = Array<number>(n).fill(master);
    if (prop === "linestyle" && typeof master === "string") preview.linestyle = Array<string>(n).fill(master);
    apply["axes.prop_cycle"] = preview;
  }

  /** True when the effective property cycle carries per-line values for `prop` that differ between lines. */
  private perLineMixed(prop: "linewidth" | "linestyle"): boolean {
    const cycle = this.effective("axes.prop_cycle");
    if (!isPropCycle(cycle)) return false;
    const arr = cycle[prop] as (number | string)[] | undefined;
    if (!arr || arr.length < 2) return false;
    return arr.some((v) => v !== arr[0]);
  }

  private setStyle(name: string): void {
    if (name === this.settings.style) return;
    const wasDefault = isDefaultSettings(this.settings);
    this.settings.style = name;
    // applyStyle() re-applies every current settings.rc entry (including
    // whatever seedPanelDefaults just added) once set_style resolves, so no
    // separate scheduleApply is needed here.
    this.seedPanelDefaults(wasDefault);
    this.writeToSink();
    this.noteRerun(["style"]);
    if (this.client) this.applyStyle(name, []);
    this.emitChange();
    this.update();
  }

  /**
   * When settings go from fully default to non-default (and only then), set
   * every panelDefault control's keys to their panelDefault, provided none of
   * that control's keys are already set (e.g. by the very change that just
   * made settings non-default). Returns the keys that were seeded.
   */
  private seedPanelDefaults(wasDefault: boolean): string[] {
    if (!wasDefault || isDefaultSettings(this.settings)) return [];
    const seeded: string[] = [];
    for (const c of CONTROLS) {
      const def = c.panelDefault;
      if (def === undefined) continue;
      if (c.keys.some((k) => k in this.settings.rc)) continue;
      for (const key of c.keys) {
        this.settings.rc[key] = (Array.isArray(def) ? [...def] : def) as RcValue;
        seeded.push(key);
      }
    }
    return seeded;
  }

  /** Live-apply (or note-rerun) keys seedPanelDefaults just added, alongside whatever triggered the change. */
  private applySeeded(seeded: string[]): void {
    if (!seeded.length) return;
    const rerunKeys: string[] = [];
    const apply: Record<string, RcValue> = {};
    for (const key of seeded) {
      const ctrl = CONTROL_FOR_KEY.get(key);
      if (ctrl?.category === "rerun" || !this.canPreview) rerunKeys.push(key);
      else apply[key] = this.settings.rc[key]!;
    }
    if (rerunKeys.length) this.noteRerun(rerunKeys);
    if (Object.keys(apply).length && this.canPreview) this.scheduleApply(apply);
  }

  /**
   * Whether a change can be shown on the figure now, or only after a re-run.
   * False when the host attached no backend at all -- Trinket's Web Worker path
   * runs the program off the main thread, so there is nothing here to preview
   * against -- or when the host turned live preview off explicitly.
   */
  private get canPreview(): boolean {
    return !!this.client && this._features.livePreview;
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
      // A named (string) legend.loc moves the legend to wherever matplotlib
      // decides to draw it, so the x/y sliders need the live figure's own
      // idea of where that landed; re-introspect just for this case.
      const legendLocIsNamed = typeof batch["legend.loc"] === "string";
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
          if (legendLocIsNamed) {
            return client.introspect().then((intro) => {
              this.figure = intro.figure;
              this.update();
            });
          }
          return undefined;
        })
        .catch((e: unknown) => {
          this.backendState = "error";
          this.backendMessage = e instanceof BackendError ? e.message : String(e);
          this.emitError(e, "apply_live");
          this.update();
        });
    }, APPLY_DEBOUNCE_MS);
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
  // Navigation: tabs, popover, menu, layout
  // -------------------------------------------------------------------------

  private firstVisibleGroupId(): string | null {
    for (const g of GROUPS) if (this.isGroupVisible(g)) return g.id;
    return null;
  }

  private handleTabClick(id: string): void {
    if (this._open && this._category === id) this.showCategory(null);
    else this.showCategory(id);
  }

  private reflectOpenAttr(): void {
    this.toggleAttribute("open", this._open);
  }

  private handleEscape(): void {
    if (this._menuOpen) {
      this.closeMenu();
      return;
    }
    if (this._open) this.showCategory(null);
  }

  private activeTabButton(tabView: TabView): HTMLButtonElement | undefined {
    const idx = this._layoutMode === "rail" ? 1 : 0;
    return tabView.buttons[idx] ?? tabView.buttons[0];
  }

  private positionPopover(): void {
    if (!this._category) return;
    const tabView = this.tabViews.get(this._category);
    const tab = tabView && this.activeTabButton(tabView);
    if (!tab) return;
    const { popover, caret } = this.ui;
    const rect = tab.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const width = popRect.width || 260;
    const height = popRect.height || 96;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    let left = rect.left;
    // Open below the tab when the pill floats over the plot (it sits at the
    // top of the figure) or when there is no room above; otherwise above.
    const roomAbove = rect.top - 6 - height >= 4;
    const below = this._layoutMode === "float" || !roomAbove;
    let top = below ? rect.bottom + 6 : rect.top - 6 - height;
    if (vw > 0) left = Math.max(4, Math.min(left, vw - width - 4));
    if (vh > 0) top = Math.max(4, Math.min(top, vh - height - 4));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.classList.toggle("below", below);
    caret.hidden = false;
    const center = rect.left + rect.width / 2 - left;
    caret.style.left = `${Math.max(8, Math.min(center, Math.max(8, width - 16)))}px`;
  }

  private applyDragPosition(): void {
    if (!this.dragPos) return;
    this.ui.popover.style.left = `${this.dragPos.x}px`;
    this.ui.popover.style.top = `${this.dragPos.y}px`;
    this.ui.caret.hidden = true;
  }

  private reanchor(): void {
    this.dragPos = null;
    this.ui.popover.classList.remove("dragging");
    this.positionPopover();
  }

  private onHeaderPointerDown(e: PointerEvent): void {
    // Buttons in the header (✕, ⌖) must receive their own click; do not start
    // a drag or capture the pointer when the press lands on one of them.
    const target = e.target as HTMLElement | null;
    if (target?.closest("button")) return;
    const rect = this.ui.popover.getBoundingClientRect();
    this.dragStart = {
      x: e.clientX ?? 0, y: e.clientY ?? 0, left: rect.left, top: rect.top,
      pointerId: e.pointerId, captured: false,
    };
  }

  private onHeaderPointerMove(e: PointerEvent): void {
    const start = this.dragStart;
    if (!start) return;
    // See onPillGripPointerMove: a move with no button held means we missed the
    // release, and a stale start would let a later hover resume the drag.
    if (e.buttons === 0) {
      this.endHeaderDrag();
      return;
    }
    const dx = (e.clientX ?? 0) - start.x;
    const dy = (e.clientY ?? 0) - start.y;
    if (!start.captured) {
      // Only becomes a drag once the pointer clears the threshold, so a plain
      // click (e.g. on the header background) never captures the pointer.
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      start.captured = true;
      try {
        this.ui.header.setPointerCapture?.(start.pointerId);
      } catch {
        /* not every environment supports pointer capture */
      }
    }
    let left = start.left + dx;
    let top = start.top + dy;
    const headerRect = this.ui.header.getBoundingClientRect();
    const hw = headerRect.width || 200;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    // Clamp so at least 40px of the header stays within the viewport.
    if (vw > 0) left = Math.max(40 - hw, Math.min(left, vw - 40));
    if (vh > 0) top = Math.max(0, Math.min(top, vh - 40));
    this.dragPos = { x: left, y: top };
    this.ui.popover.classList.add("dragging");
    this.ui.popover.style.left = `${left}px`;
    this.ui.popover.style.top = `${top}px`;
    this.ui.caret.hidden = true;
  }

  private onHeaderPointerUp(e: PointerEvent): void {
    this.endHeaderDrag(e.pointerId);
  }

  /**
   * End a popover drag from any exit path: a pointerup on the header, one that
   * landed anywhere else, a cancelled gesture, or a move that arrives with no
   * button held. Leaving `dragStart` set is what let a later hover silently
   * resume the drag without a click.
   */
  private endHeaderDrag(pointerId?: number): void {
    const start = this.dragStart;
    if (!start) return;
    if (start.captured) {
      try {
        this.ui.header.releasePointerCapture?.(pointerId ?? start.pointerId);
      } catch {
        /* ignore */
      }
      this.ui.popover.classList.remove("dragging");
    }
    this.dragStart = null;
  }

  private toggleMore(groupId: string): void {
    this.moreOpen.set(groupId, !(this.moreOpen.get(groupId) ?? false));
    this.update();
  }

  private toggleMenu(): void {
    this._menuOpen = !this._menuOpen;
    this.update();
    if (this._menuOpen) this.positionMenu();
  }

  private closeMenu(): void {
    if (!this._menuOpen) return;
    this._menuOpen = false;
    this.update();
  }

  private positionMenu(): void {
    const rect = this.ui.menuToggle.getBoundingClientRect();
    this.ui.menu.style.left = `${rect.left}px`;
    this.ui.menu.style.top = `${rect.bottom + 4}px`;
  }

  /**
   * A release anywhere ends any drag in progress. The element's own pointerup
   * handles the normal case and runs first (this is a bubble-phase listener);
   * this catches the release that lands outside the grip or header entirely,
   * which is the common way to finish a drag and the way the state used to be
   * left standing.
   */
  private onWindowPointerEnd = (e: Event): void => {
    // Only end the drag belonging to the pointer that actually ended. A second
    // finger lifting, or a stylus ending while a mouse drag is live, must not
    // cancel someone's drag out from under them. pointerId is undefined only
    // for synthetic events that never carried one; treat those as a match so
    // the safety net still works.
    const id = (e as PointerEvent).pointerId;
    const matches = (startId: number): boolean => id === undefined || id === startId;
    if (this.pillDragStart && matches(this.pillDragStart.pointerId)) this.endPillDrag(id);
    if (this.dragStart && matches(this.dragStart.pointerId)) this.endHeaderDrag(id);
  };

  private onWindowReflow = (): void => {
    this.measureLayout();
    this.positionRail();
    this.positionFloatPill();
    if (this._open && !this.dragPos) this.positionPopover();
    if (this._menuOpen) this.positionMenu();
  };

  private setupResizeObservers(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => this.onWindowReflow());
    if (this.parentElement) this.resizeObserver.observe(this.parentElement);
    if (this._figureElement) this.resizeObserver.observe(this._figureElement);
  }

  private teardownResizeObservers(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /**
   * Auto-detect the layout (unless the host has forced `layout`): "float" is
   * the default once `figureElement` is set and has a real size; with no
   * figure element, or one with zero size (not yet laid out), it falls back
   * to the inline "pill". Auto "rail" is no longer chosen: floating over the
   * figure replaces the old too-narrow-toolbar fallback, which "rail" now
   * serves only as a host-forced option.
   */
  private measureLayout(): void {
    if (this._layoutForced) return;
    if (!this._figureElement) {
      this.setLayoutMode("pill");
      return;
    }
    const rect = this._figureElement.getBoundingClientRect();
    this.setLayoutMode(rect.width > 0 && rect.height > 0 ? "float" : "pill");
  }

  private setLayoutMode(mode: LayoutMode): void {
    if (this._layoutMode === mode) {
      this.reflectLayoutAttr();
      return;
    }
    this._layoutMode = mode;
    this.reflectLayoutAttr();
    this.positionRail();
    this.positionFloatPill();
    this.update();
  }

  private reflectLayoutAttr(): void {
    this._settingLayoutAttr = true;
    this.setAttribute("layout", this._layoutMode);
    this._settingLayoutAttr = false;
  }

  private positionRail(): void {
    const rail = this.ui?.rail;
    if (!rail || this._layoutMode !== "rail" || !this._figureElement) return;
    const rect = this._figureElement.getBoundingClientRect();
    rail.style.position = "fixed";
    rail.style.top = `${rect.top}px`;
    rail.style.left = `${Math.max(0, rect.right - RAIL_WIDTH)}px`;
    rail.style.width = `${RAIL_WIDTH}px`;
  }

  /**
   * Position the pill as a fixed layer 8px inset from `figureElement`'s
   * bounding rect (top-right corner). With no figure element the inset is
   * measured from the viewport, so a host-forced "float" still renders
   * sensibly. While the pill has been dragged (`pillPos` set), that position
   * wins instead and reflows (resize/scroll) must not snap it back.
   */
  private positionFloatPill(): void {
    const pill = this.ui?.pill;
    if (!pill) return;
    if (this.pillPos) {
      pill.style.left = `${this.pillPos.x}px`;
      pill.style.top = `${this.pillPos.y}px`;
      pill.style.right = "";
      return;
    }
    if (this._layoutMode !== "float") {
      pill.style.top = "";
      pill.style.right = "";
      return;
    }
    const rect = this._figureElement?.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const top = (rect?.top ?? 0) + FLOAT_INSET_PX;
    const right = Math.max(0, vw - (rect?.right ?? vw)) + FLOAT_INSET_PX;
    pill.style.top = `${top}px`;
    pill.style.right = `${right}px`;
  }

  private onPillGripPointerDown(e: PointerEvent): void {
    // Never starts a drag from a tab or the reset menu's button; those must
    // still receive their own click.
    const target = e.target as HTMLElement | null;
    if (target?.closest("button")) return;
    const rect = this.ui.pill.getBoundingClientRect();
    this.pillDragStart = {
      x: e.clientX ?? 0, y: e.clientY ?? 0, left: rect.left, top: rect.top,
      pointerId: e.pointerId, captured: false,
    };
  }

  private onPillGripPointerMove(e: PointerEvent): void {
    const start = this.pillDragStart;
    if (!start) return;
    // A move with no button held means the release happened somewhere we never
    // saw: outside the element, off the window, or a gesture the browser
    // cancelled. Without this the stale start survives, and simply hovering the
    // grip later resumes the drag with no click -- and because the pill then
    // jumps away from the cursor, only the direction that chases it keeps
    // delivering moves, so it appears to drag one way but not the other.
    // Strict === 0: synthetic events in tests leave `buttons` undefined.
    if (e.buttons === 0) {
      this.endPillDrag();
      return;
    }
    const dx = (e.clientX ?? 0) - start.x;
    const dy = (e.clientY ?? 0) - start.y;
    if (!start.captured) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      start.captured = true;
      try {
        this.ui.pillGrip.setPointerCapture?.(start.pointerId);
      } catch {
        /* not every environment supports pointer capture */
      }
      // Freeze the pill as a fixed-position element at its current rect, even
      // when it started out inline (layout="pill") in the toolbar row.
      this.ui.pill.style.position = "fixed";
      this.ui.pill.style.right = "";
    }
    let left = start.left + dx;
    let top = start.top + dy;
    const pillRect = this.ui.pill.getBoundingClientRect();
    const pw = pillRect.width || 100;
    const ph = pillRect.height || 26;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    // Clamp so at least 40px of the pill stays within the viewport.
    if (vw > 0) left = Math.max(40 - pw, Math.min(left, vw - 40));
    if (vh > 0) top = Math.max(40 - ph, Math.min(top, vh - 40));
    this.pillPos = { x: left, y: top };
    this.ui.pill.classList.add("dragging");
    this.ui.pill.style.left = `${left}px`;
    this.ui.pill.style.top = `${top}px`;
    // The pill moved: the open popover follows its tab, unless it was itself dragged.
    if (this._open && !this.dragPos) this.positionPopover();
  }

  private onPillGripPointerUp(e: PointerEvent): void {
    this.endPillDrag(e.pointerId);
  }

  /** End a pill drag from any exit path. See endHeaderDrag. */
  private endPillDrag(pointerId?: number): void {
    const start = this.pillDragStart;
    if (!start) return;
    if (start.captured) {
      try {
        this.ui.pillGrip.releasePointerCapture?.(pointerId ?? start.pointerId);
      } catch {
        /* ignore */
      }
      this.ui.pill.classList.remove("dragging");
    }
    this.pillDragStart = null;
  }

  /** Double-clicking the pill's grip: drop `pillPos` and re-anchor to the figure's top-right (or back inline). */
  private reanchorPill(): void {
    this.pillPos = null;
    this.ui.pill.classList.remove("dragging");
    this.ui.pill.style.position = "";
    this.ui.pill.style.left = "";
    this.positionFloatPill();
    if (this._open && !this.dragPos) this.positionPopover();
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

  /**
   * Where to put the x/y sliders while `legend.loc` is a named string: the
   * lower-left corner matplotlib actually drew the legend at, from the last
   * introspection (first axes with a legend and a known `xy`), or else a
   * representative corner for that name.
   */
  private legendXyForName(name: string): readonly [number, number] {
    const axesWithXy = this.figure?.axes.find((a) => a.legend !== null && a.legend.xy);
    const xy = axesWithXy?.legend?.xy;
    if (xy) return xy;
    return LEGEND_FALLBACK_XY[name] ?? LEGEND_FALLBACK_XY.center!;
  }

  private legendNoteNeeded(group: GroupSpec): boolean {
    if (group.hideWhen !== "no-legend") return false;
    if (!this.noLegendOnFigure()) return false;
    return controlsInGroup(group.id).some((c) => c.keys.some((k) => k in this.settings.rc));
  }

  private groupHasChanges(groupId: string): boolean {
    if (groupId === "look" && this.settings.style !== "" && this.settings.style !== "default") return true;
    return controlsInGroup(groupId).some((c) => c.keys.some((k) => k in this.settings.rc));
  }

  private groupHasRerunPending(groupId: string): boolean {
    if (groupId === "look" && this.rerunKeys.has("style")) return true;
    return controlsInGroup(groupId).some((c) => c.keys.some((k) => this.rerunKeys.has(k)));
  }

  // -------------------------------------------------------------------------
  // DOM: build once
  // -------------------------------------------------------------------------

  private buildTabButton(group: GroupSpec): { btn: HTMLButtonElement; dot: HTMLElement; rerun: HTMLElement } {
    const dot = el("span", { class: "dot", hidden: true });
    const rerun = el("span", { class: "rerun", hidden: true }, "↻");
    const btn = el("button", { type: "button", class: "tab", title: group.help ?? "" }, group.label, dot, rerun);
    btn.dataset.group = group.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.addEventListener("click", () => this.handleTabClick(group.id));
    return { btn, dot, rerun };
  }

  private build(): void {
    const style = el("style");
    style.textContent = css;

    // --- Tab pill + rail ---
    const errMark = el("span", { class: "err", hidden: true, title: "There is a problem with the generated block." }, "!");
    const menuToggle = el("button", { type: "button", class: "menu-toggle", title: "Reset menu" }, "↺ ▾");
    menuToggle.setAttribute("aria-haspopup", "menu");
    menuToggle.addEventListener("click", () => this.toggleMenu());

    const pillTabs: HTMLButtonElement[] = [];
    const railTabs: HTMLButtonElement[] = [];
    for (const group of GROUPS) {
      const pillTab = this.buildTabButton(group);
      const railTab = this.buildTabButton(group);
      this.tabViews.set(group.id, {
        buttons: [pillTab.btn, railTab.btn],
        dots: [pillTab.dot, railTab.dot],
        reruns: [pillTab.rerun, railTab.rerun],
      });
      pillTabs.push(pillTab.btn);
      railTabs.push(railTab.btn);
    }

    const pillGrip = el("span", { class: "grip", title: "Drag to move" }, "⋮⋮");
    pillGrip.addEventListener("pointerdown", (e) => this.onPillGripPointerDown(e as PointerEvent));
    pillGrip.addEventListener("pointermove", (e) => this.onPillGripPointerMove(e as PointerEvent));
    pillGrip.addEventListener("pointerup", (e) => this.onPillGripPointerUp(e as PointerEvent));
    // A cancelled gesture (touch interrupted, browser takeover) never sends
    // pointerup, so without this the drag state would be left standing.
    pillGrip.addEventListener("pointercancel", (e) => this.endPillDrag((e as PointerEvent).pointerId));
    pillGrip.addEventListener("dblclick", () => this.reanchorPill());
    const pill = el("div", { class: "pill", role: "tablist" }, pillGrip, ...pillTabs, errMark, menuToggle);
    const rail = el("div", { class: "rail", role: "tablist", hidden: true }, ...railTabs);

    // --- Popover ---
    const grip = el("span", { class: "grip" }, "⋮⋮");
    const title = el("span", { class: "title" });
    const reanchorBtn = el("button", { type: "button", class: "reanchor", title: "Move back to the tab" }, "⌖");
    const closeBtn = el("button", { type: "button", class: "close" }, "✕");
    closeBtn.setAttribute("aria-label", "Close");
    const header = el("div", { class: "pop-head", title: "Drag to move" }, grip, title, reanchorBtn, closeBtn);
    header.addEventListener("pointerdown", (e) => this.onHeaderPointerDown(e as PointerEvent));
    header.addEventListener("pointermove", (e) => this.onHeaderPointerMove(e as PointerEvent));
    header.addEventListener("pointerup", (e) => this.onHeaderPointerUp(e as PointerEvent));
    header.addEventListener("pointercancel", (e) => this.endHeaderDrag((e as PointerEvent).pointerId));
    header.addEventListener("dblclick", () => this.reanchor());
    reanchorBtn.addEventListener("click", () => this.reanchor());
    closeBtn.addEventListener("click", () => this.showCategory(null));

    const caret = el("div", { class: "caret" });

    const fenceMessage = el("span");
    const replaceButton = el("button", { type: "button", class: "small" }, "Replace block");
    replaceButton.addEventListener("click", () => this.replaceBlock());
    const banner = el("div", { class: "banner error", role: "alert", hidden: true }, fenceMessage, replaceButton);

    const unknownNote = el("p", { class: "unknown-note muted", hidden: true });

    const groupViews = new Map<string, GroupView>();
    const groupEls: HTMLElement[] = [];
    for (const group of GROUPS) {
      const note = el("p", { class: "note", hidden: true });
      const primaryRows = el("div", { class: "rows primary" });
      this.appendRows(primaryRows, group, controlsInGroup(group.id, "primary"), false);

      const children: (Node | string)[] = [note, primaryRows];
      const moreSpecs = controlsInGroup(group.id, "more");
      let moreButton: HTMLButtonElement | undefined;
      let moreRows: HTMLElement | undefined;
      if (moreSpecs.length) {
        moreRows = el("div", { class: "rows more", hidden: true });
        this.appendRows(moreRows, group, moreSpecs, true);
        moreButton = el("button", { type: "button", class: "more" }, "More ▸");
        moreButton.addEventListener("click", () => this.toggleMore(group.id));
        children.push(moreButton, moreRows);
      }
      const container = el("div", { class: "group", hidden: true }, ...children);
      container.dataset.group = group.id;
      groupViews.set(group.id, { container, note, primaryRows, moreRows, moreButton });
      groupEls.push(container);
    }

    const popBody = el("div", { class: "pop-body" }, banner, ...groupEls, unknownNote);
    const popover = el("div", { class: "popover", role: "dialog", hidden: true }, header, caret, popBody);

    // --- Reset menu ---
    const resetCategoryItem = el("button", { type: "button", class: "menu-item", role: "menuitem" });
    resetCategoryItem.dataset.action = "reset-category";
    resetCategoryItem.addEventListener("click", () => {
      if (this._category) this.resetCategory(this._category);
      this.closeMenu();
    });
    const resetAllItem = el("button", { type: "button", class: "menu-item", role: "menuitem" }, "Reset all");
    resetAllItem.dataset.action = "reset-all";
    resetAllItem.addEventListener("click", () => {
      this.reset();
      this.closeMenu();
    });
    const showCodeItem = el("button", { type: "button", class: "menu-item", role: "menuitem" }, "Show code");
    showCodeItem.dataset.action = "show-code";
    const codePre = el("pre", { class: "code", hidden: true });
    showCodeItem.addEventListener("click", () => {
      this._codeOpen = !this._codeOpen;
      this.update();
    });
    const menu = el("div", { class: "menu", role: "menu", hidden: true }, resetCategoryItem, resetAllItem, showCodeItem, codePre);

    this.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.handleEscape();
    });

    this.root.append(style, pill, rail, popover, menu);
    this.ui = {
      pill, pillGrip, errMark, menuToggle, rail,
      popover, header, title, reanchorBtn, closeBtn, caret, popBody, banner, fenceMessage, unknownNote,
      menu, resetCategoryItem, resetAllItem, showCodeItem, codePre,
      groups: groupViews,
    };
  }

  /** Append `specs`' rows into `container`; with `withHeadings`, insert a `.subhead` before each subgroup's first row. */
  private appendRows(container: HTMLElement, group: GroupSpec, specs: ControlSpec[], withHeadings: boolean): void {
    let lastSubgroup: string | undefined;
    for (const spec of specs) {
      if (withHeadings && group.subgroups && spec.subgroup && spec.subgroup !== lastSubgroup) {
        const sg = group.subgroups.find((s) => s.id === spec.subgroup);
        if (sg) container.append(el("p", { class: "subhead" }, sg.label));
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
    // The per-line table's revert sits at the right end of its label row (not
    // on its own row below the table), so it moves into a small label-row
    // wrapper alongside the label and its badges; every other control keeps
    // the plain label/badges/control layout, with revert inside .control.
    const row = spec.type === "linecycle"
      ? el("div", { class: "row" }, el("div", { class: "control-label-row" }, label, badges, revert), control)
      : el("div", { class: "row" }, label, badges, control);
    row.dataset.control = spec.id;
    if (spec.category === "save") row.title = "Applies when the figure is saved, not on screen.";
    const inputs: (HTMLInputElement | HTMLSelectElement)[] = [];
    let segmented: HTMLElement | undefined;
    let swatchList: HTMLElement | undefined;
    let legendLoc: LegendLocView | undefined;
    let rangeInput: HTMLInputElement | undefined;
    let readout: HTMLElement | undefined;
    let pairOuts: HTMLElement[] | undefined;
    let lineRowsView: LineRowView[] | undefined;
    let addLineBtnView: HTMLButtonElement | undefined;
    let nextRunNote: HTMLElement | undefined;

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
        // Spans the full row width, under the preset select (see the "row"
        // grid: an unplaced child would otherwise land in the narrow label
        // column), so it reads as a note about the whole control.
        const note = el("p", { class: "next-run" }, "Applies on the next run.");
        row.append(note);
        nextRunNote = note;
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
          const range = el("input", { type: "range", id });
          range.min = String(spec.min);
          range.max = String(spec.max);
          if (spec.step !== undefined) range.step = String(spec.step);
          const out = el("span", { class: "readout" });
          range.addEventListener("input", () => {
            out.textContent = range.value;
            const n = Number(range.value);
            if (Number.isFinite(n)) this.setKeys(spec, n);
          });
          rangeInput = range;
          readout = out;
          inputs.push(range);
          control.append(range, out);
        } else {
          const input = number({ id });
          const commit = () => {
            const n = Number(input.value);
            if (input.value !== "" && Number.isFinite(n)) this.setKeys(spec, n);
            else this.update();
          };
          input.addEventListener("input", commit);
          input.addEventListener("change", commit);
          input.addEventListener("blur", () => this.update());
          inputs.push(input);
          control.append(input);
        }
        break;
      }
      case "fontsize": {
        // 6-40pt covers every relative name's resolved size at any base
        // font.size the "Text size" slider allows (6-24pt).
        const range = el("input", { type: "range", id, min: "6", max: "40", step: "0.5" });
        const out = el("span", { class: "readout" });
        const commit = () => {
          const n = Number(range.value);
          if (Number.isFinite(n)) this.setKeys(spec, n);
        };
        range.addEventListener("input", commit);
        range.addEventListener("change", commit);
        rangeInput = range;
        readout = out;
        inputs.push(range);
        control.append(range, out);
        break;
      }
      case "dpi": {
        const range = el("input", { type: "range", id, min: "72", max: "600", step: "1" });
        const out = el("span", { class: "readout" });
        const commit = () => {
          const n = Number(range.value);
          if (Number.isFinite(n)) this.setKeys(spec, n);
        };
        range.addEventListener("input", commit);
        range.addEventListener("change", commit);
        rangeInput = range;
        readout = out;
        inputs.push(range);
        control.append(range, out);
        break;
      }
      case "pair": {
        const w = el("input", { type: "range", id, min: "3", max: "10", step: "0.1" });
        const h = el("input", { type: "range", min: "2", max: "7.5", step: "0.1" });
        h.setAttribute("aria-label", `${spec.label} height`);
        const wOut = el("span", { class: "readout" });
        const hOut = el("span", { class: "readout" });
        const commit = () => {
          const a = Number(w.value);
          const b = Number(h.value);
          if (Number.isFinite(a) && Number.isFinite(b)) this.setKeys(spec, [a, b]);
        };
        w.addEventListener("input", commit);
        h.addEventListener("input", commit);
        w.addEventListener("change", commit);
        h.addEventListener("change", commit);
        inputs.push(w, h);
        control.append(
          el(
            "div", { class: "pair-rows" },
            el("div", { class: "pair-row" }, el("span", { class: "pair-label" }, "Width"), w, wOut),
            el("div", { class: "pair-row" }, el("span", { class: "pair-label" }, "Height"), h, hOut),
          ),
        );
        pairOuts = [wOut, hOut];
        break;
      }
      case "enum": {
        const useGlyphs = spec.keys.includes("lines.linestyle") || spec.keys.includes("grid.linestyle");
        if ((spec.options?.length ?? 0) <= 4) {
          const group = el("div", { class: "segmented", id });
          group.setAttribute("role", "radiogroup");
          for (const opt of spec.options ?? []) {
            const glyph = useGlyphs ? LINESTYLE_GLYPHS[opt.value] : undefined;
            const btn = el("button", { type: "button", title: glyph ? opt.label : "" }, glyph ?? opt.label);
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
          const btn = el("button", { type: "button", class: "preset", title: preset.label });
          btn.dataset.preset = preset.id;
          btn.setAttribute("aria-pressed", "false");
          const sw = el("span", { class: "swatches" });
          for (const c of preset.colors) {
            const i = el("i");
            i.style.background = c;
            i.title = c;
            sw.append(i);
          }
          btn.append(sw);
          btn.addEventListener("click", () => {
            // Preserve any existing per-line width/style arrays, resized
            // (cycled/truncated) to the preset's color count.
            const current = this.effective(spec.keys[0]!);
            if (isPropCycle(current) && (current.linewidth || current.linestyle)) {
              const len = preset.colors.length;
              const next: PropCycleValue = { color: [...preset.colors] };
              if (current.linewidth) next.linewidth = resizeArray(current.linewidth, len, this.allLinesWidth());
              if (current.linestyle) next.linestyle = resizeArray(current.linestyle, len, this.allLinesStyle());
              this.setKeys(spec, next);
            } else {
              this.setKeys(spec, [...preset.colors]);
            }
          });
          list.append(btn);
        }
        swatchList = list;
        control.append(list);
        break;
      }
      case "linecycle": {
        const table = el("div", { class: "linecycle", id });
        // Index and swatch columns get no heading text (an empty cell each);
        // only Width and Style have one, over their own columns.
        const head = el(
          "div", { class: "line-row line-head" },
          el("span", {}), el("span", {}), el("span", {}, "Width"), el("span", {}, "Style"),
        );
        table.append(head);
        const maxLines = spec.maxLines ?? 8;
        const lineRows: LineRowView[] = [];
        for (let i = 0; i < maxLines; i++) {
          const idx = el("span", { class: "line-index" }, String(i + 1));
          const color = el("input", { type: "color", class: "line-color" });
          color.setAttribute("aria-label", `Line ${i + 1} color`);
          const width = el("input", { type: "number", class: "line-width", min: "0.25", max: "8", step: "0.25" });
          width.setAttribute("aria-label", `Line ${i + 1} width`);
          const seg = el("div", { class: "segmented line-style" });
          seg.setAttribute("role", "radiogroup");
          seg.setAttribute("aria-label", `Line ${i + 1} style`);
          for (const styleVal of LINESTYLE_VALUES) {
            const btn = el("button", { type: "button", title: LINESTYLE_LABELS[styleVal]! }, LINESTYLE_GLYPHS[styleVal]!);
            btn.dataset.value = styleVal;
            btn.setAttribute("aria-pressed", "false");
            btn.addEventListener("click", () => {
              for (const b of Array.from(seg.children) as HTMLButtonElement[]) {
                b.setAttribute("aria-pressed", String(b.dataset.value === styleVal));
              }
              this.commitLineCycle(spec);
            });
            seg.append(btn);
          }
          const commit = () => this.commitLineCycle(spec);
          color.addEventListener("input", commit);
          width.addEventListener("input", commit);
          width.addEventListener("change", commit);
          width.addEventListener("blur", () => this.update());
          const rowEl = el("div", { class: "line-row" }, idx, color, width, seg);
          table.append(rowEl);
          lineRows.push({ row: rowEl, color, width, styleSeg: seg });
        }
        const addBtn = el("button", { type: "button", class: "add-line" }, "+ line");
        addBtn.addEventListener("click", () => this.addLineRow(spec));
        table.append(addBtn);
        control.append(table);
        lineRowsView = lineRows;
        addLineBtnView = addBtn;
        break;
      }
      case "legendloc": {
        // Sliders first (see docs/ux-design.md, "Round five"): the x/y range
        // keeps this control's id, so it is what `#ctl-legend_loc` finds.
        const xRange = el("input", { type: "range", id, min: "0", max: "1", step: "0.01" });
        xRange.setAttribute("aria-label", "Legend x");
        const yRange = el("input", { type: "range", min: "0", max: "1", step: "0.01" });
        yRange.setAttribute("aria-label", "Legend y");
        const xOut = el("span", { class: "readout" });
        const yOut = el("span", { class: "readout" });
        const commitXy = () => {
          const x = round(Number(xRange.value));
          const y = round(Number(yRange.value));
          xOut.textContent = x.toFixed(2);
          yOut.textContent = y.toFixed(2);
          if (Number.isFinite(x) && Number.isFinite(y)) this.setKeys(spec, [x, y]);
        };
        xRange.addEventListener("input", commitXy);
        yRange.addEventListener("input", commitXy);
        inputs.push(xRange, yRange);

        // "Snap to": a first "Custom" option (shown selected for an array
        // value; never itself chosen to mean anything) plus the named
        // locations from the schema.
        const snap = el("select", { class: "snap" });
        snap.append(el("option", { value: "__custom__" }, "Custom"));
        for (const opt of spec.options ?? []) snap.append(el("option", { value: opt.value }, opt.label));
        snap.addEventListener("change", () => {
          if (snap.value !== "__custom__") this.setKeys(spec, snap.value);
        });
        inputs.push(snap);

        const xyRows = el(
          "div",
          { class: "legend-xy" },
          el("div", { class: "legend-xy-row" }, el("span", { class: "legend-label" }, "x"), xRange, xOut),
          el("div", { class: "legend-xy-row" }, el("span", { class: "legend-label" }, "y"), yRange, yOut),
        );
        const snapRow = el("div", { class: "legend-snap" }, el("span", { class: "snap-label" }, "Snap to"), snap);
        legendLoc = { xRange, yRange, xOut, yOut, snap };
        control.append(xyRows, snapRow);
        break;
      }
    }
    // The per-line table's revert already lives in the label row (see `row`
    // above); every other control keeps it at the end of .control.
    if (spec.type !== "linecycle") control.append(revert);
    const view: ControlView = { spec, row, inputs, badges, revert };
    if (segmented) view.segmented = segmented;
    if (swatchList) view.swatchList = swatchList;
    if (legendLoc) view.legendLoc = legendLoc;
    if (rangeInput) view.rangeInput = rangeInput;
    if (readout) view.readout = readout;
    if (pairOuts) view.pairOuts = pairOuts;
    if (lineRowsView) view.lineRows = lineRowsView;
    if (addLineBtnView) view.addLineBtn = addLineBtnView;
    if (nextRunNote) view.nextRunNote = nextRunNote;
    this.views.set(spec.id, view);
    return row;
  }

  // -------------------------------------------------------------------------
  // Per-line ("linecycle") helpers
  // -------------------------------------------------------------------------

  /** Number of per-line rows to show: schema bounds, the live figure's line count, and the current value's array length. */
  /** Rows the user added with "+ line" this session, beyond what the figure and settings imply. */
  private extraLineRows = 0;

  /**
   * Rows shown: the lines in the live figure, any row whose width or style
   * was set explicitly, and rows the user added, within [minLines, maxLines].
   * The color palette's length is deliberately NOT a row count: a ten-color
   * preset does not mean ten lines.
   */
  private lineCycleRowCount(spec: ControlSpec): number {
    const minLines = spec.minLines ?? 2;
    const maxLines = spec.maxLines ?? 8;
    const value = this.settings.rc[spec.keys[0]!];
    const figLines = this.figure && this.figure.axes.length ? Math.max(...this.figure.axes.map((a) => a.n_lines)) : 0;
    let explicit = 0;
    if (isPropCycle(value)) {
      const allWidth = this.allLinesWidth();
      const allStyle = this.allLinesStyle();
      value.linewidth?.forEach((w, i) => { if (Math.abs(w - allWidth) > 1e-9) explicit = Math.max(explicit, i + 1); });
      value.linestyle?.forEach((st, i) => { if (st !== allStyle) explicit = Math.max(explicit, i + 1); });
    }
    return Math.min(maxLines, Math.max(minLines, figLines, explicit, this.extraLineRows));
  }

  /** Per-row color/width/style for rows [0, rowCount), from the effective prop_cycle plus the all-lines defaults. */
  private lineRowValues(spec: ControlSpec, rowCount: number): { color: string[]; width: number[]; style: string[] } {
    const value = this.effective(spec.keys[0]!);
    const valueColors = isPropCycle(value) ? value.color : Array.isArray(value) ? (value as string[]) : [];
    const widths = isPropCycle(value) ? value.linewidth : undefined;
    const styles = isPropCycle(value) ? value.linestyle : undefined;
    const fallbackColors = (CONTROL_FOR_KEY.get("axes.prop_cycle")?.default as string[] | undefined) ?? ["#1f77b4"];
    const palette = valueColors.length ? valueColors : fallbackColors;
    const allWidth = this.allLinesWidth();
    const allStyle = this.allLinesStyle();
    const color: string[] = [];
    const width: number[] = [];
    const style: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      color.push(palette[i % palette.length]!);
      width.push(widths?.[i] ?? allWidth);
      style.push(styles?.[i] ?? allStyle);
    }
    return { color, width, style };
  }

  private allLinesWidth(): number {
    const v = this.effective("lines.linewidth");
    return typeof v === "number" ? v : 1.5;
  }

  private allLinesStyle(): string {
    const v = this.effective("lines.linestyle");
    return typeof v === "string" ? v : "-";
  }

  /**
   * Read the visible rows and write the property cycle. The arrays span the
   * whole effective palette (cycler zips equal-length arrays), so colors for
   * lines beyond the table are preserved; those entries carry the all-lines
   * width and style.
   */
  private commitLineCycle(spec: ControlSpec): void {
    const rowCount = this.lineCycleRowCount(spec);
    const rows = this.views.get(spec.id)!.lineRows!;
    const palette = this.lineRowValues(spec, rowCount).color.length ? this.effectivePalette(spec) : [];
    const length = Math.max(rowCount, palette.length);
    const fallbackWidth = this.allLinesWidth();
    const fallbackStyle = this.allLinesStyle();
    const color: string[] = [];
    const width: number[] = [];
    const style: string[] = [];
    for (let i = 0; i < length; i++) {
      if (i < rowCount) {
        const r = rows[i]!;
        color.push(r.color.value);
        const w = Number(r.width.value);
        width.push(Number.isFinite(w) && w > 0 ? w : fallbackWidth);
        const activeBtn = Array.from(r.styleSeg.children).find(
          (b) => (b as HTMLButtonElement).getAttribute("aria-pressed") === "true",
        ) as HTMLButtonElement | undefined;
        style.push(activeBtn?.dataset.value ?? fallbackStyle);
      } else {
        color.push(palette[i % palette.length]!);
        width.push(fallbackWidth);
        style.push(fallbackStyle);
      }
    }
    this.setKeys(spec, this.buildPropCycleValue(color, width, style));
  }

  /** The effective color list for axes.prop_cycle (user value, baseline, or matplotlib's default). */
  private effectivePalette(spec: ControlSpec): string[] {
    const value = this.effective(spec.keys[0]!);
    const colors = isPropCycle(value) ? value.color : Array.isArray(value) ? (value as string[]) : [];
    if (colors.length) return [...colors];
    return [...((CONTROL_FOR_KEY.get("axes.prop_cycle")?.default as string[] | undefined) ?? ["#1f77b4"])];
  }

  /** "+ line": reveal one more row (nothing is written until the row is edited). */
  private addLineRow(spec: ControlSpec): void {
    const maxLines = spec.maxLines ?? 8;
    const current = this.lineCycleRowCount(spec);
    if (current >= maxLines) return;
    this.extraLineRows = current + 1;
    this.update();
  }

  /** width/linestyle are included only when at least one row differs from the all-lines default, so the block stays short. */
  private buildPropCycleValue(color: string[], width: number[], style: string[]): RcValue {
    const fallbackWidth = this.allLinesWidth();
    const fallbackStyle = this.allLinesStyle();
    const widthDiffers = width.some((w) => Math.abs(w - fallbackWidth) > 1e-9);
    const styleDiffers = style.some((s) => s !== fallbackStyle);
    if (!widthDiffers && !styleDiffers) return color;
    const value: PropCycleValue = { color };
    if (widthDiffers) value.linewidth = width;
    if (styleDiffers) value.linestyle = style;
    return value;
  }

  /** Whether `input` is the shadow root's currently-focused element (so update() must not overwrite its value mid-edit). */
  private isEditing(input: HTMLElement): boolean {
    return this.root.activeElement === input;
  }

  // -------------------------------------------------------------------------
  // DOM: sync with state
  // -------------------------------------------------------------------------

  private update(): void {
    const { ui } = this;
    if (!ui) return;

    const statusText =
      this.backendState === "none" ? "No live preview (no backend)"
      : this.backendState === "connecting" ? "Connecting to Python…"
      : this.backendState === "error" ? `Backend error: ${this.backendMessage}`
      : `Live preview on · ${this.backendMessage}`;
    ui.pill.title = statusText;
    ui.rail.title = statusText;
    ui.pill.classList.toggle("error", Boolean(this.fenceError));
    ui.rail.classList.toggle("error", Boolean(this.fenceError));
    ui.errMark.hidden = !this.fenceError;

    ui.pill.hidden = this._layoutMode === "rail";
    ui.rail.hidden = this._layoutMode !== "rail";
    ui.pill.classList.toggle("float", this._layoutMode === "float");

    for (const g of GROUPS) {
      const tabView = this.tabViews.get(g.id)!;
      const visible = this.isGroupVisible(g);
      const hasChanges = this.groupHasChanges(g.id);
      const hasRerun = this.groupHasRerunPending(g.id);
      for (const btn of tabView.buttons) {
        btn.hidden = !visible;
        btn.setAttribute("aria-selected", String(this._category === g.id));
      }
      for (const dot of tabView.dots) dot.hidden = !hasChanges;
      for (const r of tabView.reruns) r.hidden = !hasRerun;
    }

    // Popover.
    ui.popover.hidden = !this._open;
    const activeGroup = this._category ? GROUP_BY_ID.get(this._category) : undefined;
    ui.title.textContent = activeGroup ? activeGroup.label : "";

    ui.banner.hidden = !this.fenceError;
    if (this.fenceError) {
      ui.fenceMessage.textContent = `${this.fenceError.message} The panel will not write until this is fixed.`;
    }

    for (const g of GROUPS) {
      const view = ui.groups.get(g.id)!;
      view.container.hidden = this._category !== g.id || Boolean(this.fenceError);
      const noteNeeded = this.legendNoteNeeded(g);
      view.note.hidden = !noteNeeded;
      if (noteNeeded) view.note.textContent = "The current plot has no legend.";
      if (view.moreRows && view.moreButton) {
        const isOpen = this.moreOpen.get(g.id) ?? false;
        view.moreRows.hidden = !isOpen;
        view.moreButton.textContent = isOpen ? "More ▾" : "More ▸";
      }
    }

    ui.unknownNote.hidden = this.unknownKeys.length === 0;
    if (this.unknownKeys.length) {
      ui.unknownNote.textContent = `The block also sets ${this.unknownKeys.join(", ")}, which this panel has no control for. They are kept as they are.`;
    }

    // Reset menu.
    ui.menu.hidden = !this._menuOpen;
    const activeHasChanges = this._category !== null && this.groupHasChanges(this._category);
    ui.resetCategoryItem.hidden = !activeHasChanges;
    if (activeHasChanges && activeGroup) ui.resetCategoryItem.textContent = `Reset ${activeGroup.label}`;
    ui.resetAllItem.disabled = isDefaultSettings(this.settings) && !this.fenceError;
    ui.showCodeItem.hidden = !this._features.showCode;
    const block = generateBlock(this.settings);
    ui.codePre.textContent = block ?? "# (no block: every setting is at its default)";
    ui.codePre.hidden = !(this._features.showCode && this._codeOpen);

    // Controls.
    for (const view of this.views.values()) this.updateControl(view);
  }

  private updateControl(view: ControlView): void {
    const { spec, row, badges, revert } = view;
    const isSet = spec.keys.some((k) => k in this.settings.rc);
    const userOverrides = !this.stale && spec.keys.some((k) => this.overridden.has(k));
    const relevantRerunKeys = spec.id === "style" ? ["style"] : spec.keys;
    const rerunPending =
      (spec.category === "rerun" || !this.canPreview) &&
      relevantRerunKeys.some((k) => this.rerunKeys.has(k));
    row.classList.toggle("is-set", isSet);
    revert.hidden = !isSet;

    badges.replaceChildren();
    if (rerunPending) badges.append(el("span", { class: "badge rerun", title: "Re-run your program to see this change." }, "↻"));
    if (userOverrides) {
      badges.append(el("span", {
        class: "badge user",
        title: "Your code sets this on the current figure; the default above still applies to anything created afterwards.",
      }));
    }

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
        if (view.nextRunNote) view.nextRunNote.classList.toggle("pending", this.rerunKeys.has("style"));
        break;
      }
      case "bool":
        (view.inputs[0] as HTMLInputElement).checked = Boolean(value);
        break;
      case "number": {
        const v = typeof value === "number" ? String(value) : "";
        const mixed = spec.keys.includes("lines.linewidth") && this.perLineMixed("linewidth");
        row.classList.toggle("mixed", mixed);
        if (view.rangeInput) {
          view.rangeInput.value = v;
          view.rangeInput.title = mixed ? "Set per line below; drag to make every line the same." : "";
          if (view.readout) view.readout.textContent = mixed ? "mixed" : v;
        } else if (view.inputs[0] && !this.isEditing(view.inputs[0])) {
          (view.inputs[0] as HTMLInputElement).value = v;
        }
        break;
      }
      case "fontsize": {
        const input = view.inputs[0] as HTMLInputElement;
        // A range being dragged is the active element; the readout and title
        // must still follow the value. Only the slider position is left alone.
        const editing = this.isEditing(input);
        const base = this.effective("font.size");
        const baseN = typeof base === "number" ? base : 10;
        let resolved: number;
        if (typeof value === "number") {
          resolved = value;
          input.title = "";
        } else if (typeof value === "string" && RELATIVE_SIZES.includes(value)) {
          resolved = round(resolveFontSize(value, baseN));
          input.title = `"${value}" = ${resolved} pt at base ${baseN} pt`;
        } else {
          resolved = baseN;
          input.title = "";
        }
        if (!editing) input.value = String(resolved);
        if (view.readout) view.readout.textContent = String(resolved);
        break;
      }
      case "dpi": {
        const input = view.inputs[0] as HTMLInputElement;
        const editing = this.isEditing(input);
        let resolved: number;
        if (typeof value === "number") {
          resolved = value;
          input.title = "";
        } else {
          // The default ("figure") or an explicit "figure": show the live
          // figure's own dpi instead of the word "figure".
          resolved = this.figure?.dpi ?? 100;
          input.title = "Figure's own dpi (matplotlib default)";
        }
        if (!editing) input.value = String(resolved);
        if (view.readout) view.readout.textContent = String(resolved);
        break;
      }
      case "pair": {
        const [w, h] = view.inputs as HTMLInputElement[];
        if (Array.isArray(value) && value.length === 2 && w && h) {
          if (!this.isEditing(w)) w.value = String(value[0]);
          if (!this.isEditing(h)) h.value = String(value[1]);
        }
        if (view.pairOuts) {
          view.pairOuts[0]!.textContent = w?.value ?? "";
          view.pairOuts[1]!.textContent = h?.value ?? "";
        }
        break;
      }
      case "enum": {
        const v = value === undefined ? "" : String(value);
        const mixed = spec.keys.includes("lines.linestyle") && this.perLineMixed("linestyle");
        row.classList.toggle("mixed", mixed);
        if (view.segmented) {
          view.segmented.title = mixed ? "Set per line below; pick one to make every line the same." : "";
          for (const btn of Array.from(view.segmented.children) as HTMLButtonElement[]) {
            btn.setAttribute("aria-pressed", String(!mixed && btn.dataset.value === v));
          }
        } else {
          const select = view.inputs[0] as HTMLSelectElement;
          if (v && !Array.from(select.options).some((o) => o.value === v)) select.append(el("option", { value: v }, `${v} (from style)`));
          select.value = v;
        }
        break;
      }
      case "colorcycle": {
        const colors = isPropCycle(value) ? value.color : Array.isArray(value) ? (value as string[]) : [];
        const preset = spec.presets?.find((p) => rcEqual(p.colors, colors));
        const list = view.swatchList!;
        for (const btn of Array.from(list.querySelectorAll<HTMLButtonElement>("button.preset[data-preset]"))) {
          btn.setAttribute("aria-pressed", String(btn.dataset.preset === preset?.id));
        }
        list.title = preset ? "" : "Custom colors (from your file)";
        break;
      }
      case "linecycle": {
        const rowCount = this.lineCycleRowCount(spec);
        const maxLines = spec.maxLines ?? 8;
        const { color, width, style } = this.lineRowValues(spec, rowCount);
        const rows = view.lineRows!;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i]!;
          const visible = i < rowCount;
          r.row.hidden = !visible;
          if (!visible) continue;
          if (!this.isEditing(r.color)) r.color.value = color[i]!;
          if (!this.isEditing(r.width)) r.width.value = String(width[i]);
          for (const b of Array.from(r.styleSeg.children) as HTMLButtonElement[]) {
            b.setAttribute("aria-pressed", String(b.dataset.value === style[i]));
          }
        }
        if (view.addLineBtn) view.addLineBtn.hidden = rowCount >= maxLines;
        break;
      }
      case "legendloc": {
        const { xRange, yRange, xOut, yOut, snap } = view.legendLoc!;
        let x: number;
        let y: number;
        if (Array.isArray(value)) {
          snap.value = "__custom__";
          const arr = value as number[];
          x = arr[0] ?? 0;
          y = arr[1] ?? 0;
        } else {
          const name = value === undefined ? "best" : String(value);
          if (!Array.from(snap.options).some((o) => o.value === name)) {
            snap.append(el("option", { value: name }, `${name} (from style)`));
          }
          snap.value = name;
          [x, y] = this.legendXyForName(name);
        }
        const xs = x.toFixed(2);
        const ys = y.toFixed(2);
        if (!this.isEditing(xRange)) xRange.value = xs;
        if (!this.isEditing(yRange)) yRange.value = ys;
        xOut.textContent = xs;
        yOut.textContent = ys;
        break;
      }
    }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
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
