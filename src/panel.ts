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
  CONTROLS, GROUPS, GROUP_BY_ID, RELATIVE_SIZES, controlsInGroup, rcEqual, resolveFontSize,
  type ControlSpec, type GroupSpec, type RcValue,
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
type LayoutMode = "pill" | "rail";

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
  readout?: HTMLElement;
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
}

const APPLY_DEBOUNCE_MS = 60;
const RAIL_WIDTH = 50;

/** matplotlib line-style glyphs, used on the compact segmented control. */
const LINESTYLE_GLYPHS: Readonly<Record<string, string>> = { "-": "―", "--": "– –", "-.": "–·", ":": "···" };

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
  private resizeObserver: ResizeObserver | null = null;
  private docClickHandler: ((e: Event) => void) | null = null;

  private readonly root: ShadowRoot;
  private views = new Map<string, ControlView>();
  private tabViews = new Map<string, TabView>();
  private ui!: {
    pill: HTMLElement;
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
    this.update();
    this.measureLayout();
    this.positionRail();
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
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== "layout" || this._settingLayoutAttr || newValue === oldValue) return;
    this._layoutForced = true;
    const mode: LayoutMode = newValue === "rail" ? "rail" : "pill";
    if (mode !== this._layoutMode) {
      this._layoutMode = mode;
      this.positionRail();
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
    this.update();
  }

  /** "pill" or "rail". Reflected as the `layout` attribute; set it to force one or the other. */
  get layout(): LayoutMode {
    return this._layoutMode;
  }
  set layout(value: LayoutMode) {
    this._layoutForced = true;
    this.setLayoutMode(value === "rail" ? "rail" : "pill");
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
    let top = rect.top - 6 - height;
    if (vw > 0) left = Math.max(4, Math.min(left, vw - width - 4));
    if (vh > 0) top = Math.max(4, Math.min(top, vh - height - 4));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
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
    const header = this.ui.header;
    try {
      header.setPointerCapture?.(e.pointerId);
    } catch {
      /* not every environment supports pointer capture */
    }
    const rect = this.ui.popover.getBoundingClientRect();
    this.dragStart = { x: e.clientX ?? 0, y: e.clientY ?? 0, left: rect.left, top: rect.top };
  }

  private onHeaderPointerMove(e: PointerEvent): void {
    if (!this.dragStart) return;
    const dx = (e.clientX ?? 0) - this.dragStart.x;
    const dy = (e.clientY ?? 0) - this.dragStart.y;
    let left = this.dragStart.left + dx;
    let top = this.dragStart.top + dy;
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
    if (!this.dragStart) return;
    try {
      this.ui.header.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    this.dragStart = null;
    this.ui.popover.classList.remove("dragging");
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

  private onWindowReflow = (): void => {
    this.measureLayout();
    this.positionRail();
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

  /** Auto-detect pill vs rail (unless the host has forced `layout`). */
  private measureLayout(): void {
    if (this._layoutForced) return;
    if (!this._figureElement || !this.parentElement) {
      this.setLayoutMode("pill");
      return;
    }
    const parent = this.parentElement;
    const pillWidth = this.ui.pill.scrollWidth;
    let siblingWidth = 0;
    for (const child of Array.from(parent.children)) {
      if (child === this) continue;
      siblingWidth += (child as HTMLElement).getBoundingClientRect().width;
    }
    const available = parent.clientWidth - siblingWidth;
    const overflow = pillWidth > 0 && (pillWidth > available || pillWidth > parent.clientWidth);
    this.setLayoutMode(overflow ? "rail" : "pill");
  }

  private setLayoutMode(mode: LayoutMode): void {
    if (this._layoutMode === mode) {
      this.reflectLayoutAttr();
      return;
    }
    this._layoutMode = mode;
    this.reflectLayoutAttr();
    this.positionRail();
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
    const pillLabel = el("span", { class: "label" }, "Style");
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

    const pill = el("div", { class: "pill", role: "tablist" }, pillLabel, ...pillTabs, errMark, menuToggle);
    const rail = el("div", { class: "rail", role: "tablist", hidden: true }, ...railTabs);

    // --- Popover ---
    const title = el("span", { class: "title" });
    const reanchorBtn = el("button", { type: "button", class: "reanchor", title: "Move back to the tab" }, "⌖");
    const closeBtn = el("button", { type: "button", class: "close" }, "✕");
    closeBtn.setAttribute("aria-label", "Close");
    const header = el("div", { class: "pop-head" }, title, reanchorBtn, closeBtn);
    header.addEventListener("pointerdown", (e) => this.onHeaderPointerDown(e as PointerEvent));
    header.addEventListener("pointermove", (e) => this.onHeaderPointerMove(e as PointerEvent));
    header.addEventListener("pointerup", (e) => this.onHeaderPointerUp(e as PointerEvent));
    header.addEventListener("pointercancel", (e) => this.onHeaderPointerUp(e as PointerEvent));
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
      pill, errMark, menuToggle, rail,
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
    const row = el("div", { class: "row" }, label, badges, control);
    row.dataset.control = spec.id;
    if (spec.category === "save") row.title = "Applies when the figure is saved, not on screen.";
    const inputs: (HTMLInputElement | HTMLSelectElement)[] = [];
    let segmented: HTMLElement | undefined;
    let swatchList: HTMLElement | undefined;
    let legendXy: LegendXyView | undefined;
    let rangeInput: HTMLInputElement | undefined;
    let readout: HTMLElement | undefined;

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
        const input = number({ id, step: "0.5", min: "1" });
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
        const input = number({ id, placeholder: "figure" });
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
          btn.addEventListener("click", () => this.setKeys(spec, [...preset.colors]));
          list.append(btn);
        }
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
    if (readout) view.readout = readout;
    this.views.set(spec.id, view);
    return row;
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
    const rerunPending = spec.category === "rerun" && relevantRerunKeys.some((k) => this.rerunKeys.has(k));
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
        break;
      }
      case "bool":
        (view.inputs[0] as HTMLInputElement).checked = Boolean(value);
        break;
      case "number": {
        const v = typeof value === "number" ? String(value) : "";
        if (view.rangeInput) {
          view.rangeInput.value = v;
          if (view.readout) view.readout.textContent = v;
        } else if (view.inputs[0]) {
          (view.inputs[0] as HTMLInputElement).value = v;
        }
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
        list.title = preset ? "" : "Custom colors (from your file)";
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
