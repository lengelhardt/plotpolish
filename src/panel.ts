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
import {
  HelperClient, backendStallReason,
  type BackendStall, type FigureBackend, type FigureDescription, type StylePreview,
} from "./backend";
import {
  FenceError, defaultSettings, generateBlock, isDefaultSettings, parseBlock, replaceFence, upsertBlock,
  type StyleSettings,
} from "./block";
import { ELEMENT_TAG, EVENT_PREFIX, VERSION } from "./constants";
import {
  CONTROL_BY_ID, CONTROL_FOR_KEY, CONTROLS, GROUPS, GROUP_BY_ID, RELATIVE_SIZES, asPropCycle,
  controlsInGroup, isPropCycle,
  rcEqual, resolveFontSize,
  type ControlSpec, type GroupSpec, type KeyPart, type PropCycleValue, type RcValue,
} from "./schema";
import type { CodeSink } from "./sink";

export interface PanelFeatures {
  /** Apply artist-level equivalents to the retained figure as controls change. */
  livePreview: boolean;
  /** Whether the "Show code" item exists in the reset menu. */
  showCode: boolean;
  /** Group ids to render (see controls.json); null renders all. */
  groups: string[] | null;
  /**
   * What the panel says when it cannot preview -- see `staleAdvice()`. The host
   * supplies it so the wording can be re-tuned, and the glyph swapped for one
   * that matches its own Run button, WITHOUT cutting a plotpolish release.
   *
   * Plain text in all three fields, deliberately: the panel lives in a shadow
   * root, so a host's icon markup (`<i class="fa fa-play">`, which is what
   * Trinket's Run button uses) renders as an EMPTY element -- the document
   * stylesheet that defines `.fa` does not cross the shadow boundary. A Unicode
   * glyph needs no stylesheet and cannot inject markup. `⚠` and `⏳` in
   * `backendTrouble()` are the same choice.
   *
   * Partial objects are fine; anything omitted falls back to DEFAULT_STALE.
   *
   * OPTIONAL, and it has to stay that way: this field and `canRerun` arrived
   * in 0.3.3 as REQUIRED, which broke every typed host that built a complete
   * `PanelFeatures` object out of the three fields that existed before --
   * a compile error in what was advertised as a patch release.
   */
  staleNotice?: Partial<StaleNotice> | null;
  /**
   * Whether the host can service a re-run request. When true, the notice
   * becomes a BUTTON that emits `plotpolish-rerun-requested`; the host listens
   * and triggers its own Run. Default false, deliberately: the panel cannot
   * know whether anything is listening, and a control that says "Re-run" and
   * does nothing is worse than a plain sentence -- which is exactly what the
   * first version of this notice shipped as, and what Larry caught in ten
   * seconds of using it.
   *
   * Optional for the same reason `staleNotice` is.
   */
  canRerun?: boolean;
}

/** The three parts of the "cannot preview" notice, mirroring `backendTrouble()`. */
export interface StaleNotice {
  /** Shown in the pill, in the slot the auto-update switch vacates. */
  glyph: string;
  /** The pill chip's word. Kept to one or two words; the pill is narrow. */
  word: string;
  /** The full sentence, shown above the controls in the popover. */
  sentence: string;
}

/** U+25B6 stands in for a host Run glyph the shadow root cannot reach. */
const DEFAULT_STALE: StaleNotice = {
  glyph: "\u25B6",
  word: "Re-run",
  sentence: "Re-run to update plot.",
};

// `Required<>`, so every read inside the class sees a value and the optional
// public fields cost nothing at the call sites.
const DEFAULT_FEATURES: Required<PanelFeatures> = {
  livePreview: true, showCode: true, groups: null, staleNotice: null, canRerun: false,
};

export interface ChangeEventDetail {
  settings: StyleSettings;
  block: string | null;
  /** The full source after the write, or null for write-only sinks. */
  source: string | null;
}
/**
 * Fired when the student asks for the figure to be saved. Cancelable: a host
 * that cannot let a page trigger a download -- a sandboxed iframe, which is
 * where this tool actually runs -- calls preventDefault() and delivers the
 * bytes its own way.
 */
export interface SavedEventDetail {
  format: string;
  /** base64, as it came back from savefig. */
  data: string;
  bytes: number;
  filename: string;
}

/** Fired when the student turns the figure's auto-update on or off. */
export interface AutoUpdateEventDetail {
  autoUpdate: boolean;
}

/**
 * Fired when the student asks for a re-run from the notice. The panel cannot
 * run anything itself -- it is host-agnostic by design -- so it asks. Only
 * fired when `features.canRerun` is on, so a host that never wired a listener
 * never renders the button that would emit this.
 */
export interface RerunRequestedEventDetail {
  /** rc keys (or "style") waiting on the run, for a host that wants to log it. */
  keys: string[];
}

export interface RerunNeededEventDetail {
  /** rc keys (or "style") whose change needs a re-run to be visible. */
  keys: string[];
  style: string;
}
export interface PanelErrorEventDetail {
  error: Error;
  context: string;
  /**
   * Whether the call was merely refused for now. `"busy"` and `"loading"` are
   * the host declining -- mid-run, or Python not up yet -- which the panel
   * itself shows as a calm wait rather than a fault.
   *
   * `null` means **not a transient refusal**, which is not the same as "a
   * backend fault": this event also fires for failures that never reached the
   * backend at all, such as `context: "write"` when the panel could not write
   * to the source. Read `context` to tell those apart. Only `"busy"` and
   * `"loading"` carry a positive claim.
   *
   * Additive on purpose: a host that ignores this behaves exactly as before,
   * and one that reads it can avoid surfacing a transient refusal as an error.
   * The panel drew that distinction on screen before it drew it in the event,
   * which meant a host doing the obvious thing contradicted the panel's own UX.
   */
  stall: BackendStall | null;
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
  styleThumbs?: HTMLElement;
  styleShowAll?: HTMLButtonElement;
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
  /**
   * True once pointer capture is held. Taken on pointerDOWN, not after the
   * threshold: the pill's grip is its first child and only a few pixels wide,
   * so a leftward drag leaves it before 4px of travel, `pointermove` stops
   * being delivered to the grip, and the drag never starts -- while a
   * rightward drag stays on the grip long enough to capture and then works in
   * both directions. That is the "drag right first to release it" behavior
   * Larry hit on 2026-09-10, and the file already described the shape of it in
   * onPillGripPointerMove's `buttons === 0` comment.
   */
  captured: boolean;
  /** True once past the drag threshold, i.e. this is a drag and not a click. */
  moved: boolean;
}

const APPLY_DEBOUNCE_MS = 60;
const RAIL_WIDTH = 50;
const FLOAT_INSET_PX = 8;

/** How long the tab strip takes to fold away or come back. Matches panel.css. */
const FOLD_MS = 140;
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** Styles shown before "Show all": a spread of the range, not the first eight. */
const CURATED_STYLES: readonly string[] = [
  "default", "ggplot", "seaborn-v0_8", "seaborn-v0_8-colorblind",
  "bmh", "fivethirtyeight", "dark_background", "grayscale",
];

const SHORT_STYLE_NAMES: Readonly<Record<string, string>> = {
  dark_background: "dark bg",
  fivethirtyeight: "538",
  Solarize_Light2: "Solarize",
  "tableau-colorblind10": "tableau",
  "seaborn-v0_8": "seaborn",
};

/**
 * What a style is *called* in the panel. Sixteen of matplotlib's twenty-six
 * styles begin "seaborn-v0_8-", so the shared prefix is two thirds of the menu
 * and none of the information: the variants read as a list under "seaborn"
 * instead. Display only -- `mpl.style.use("seaborn-v0_8-bright")` is what goes
 * into the student's file.
 */
export function shortStyleName(name: string): string {
  const known = SHORT_STYLE_NAMES[name];
  if (known) return known;
  if (name.startsWith("seaborn-v0_8-")) {
    // A leading dash, so the sixteen variants read as an indented list under
    // "seaborn" in the menu rather than repeating the prefix sixteen times.
    return `- ${name.slice("seaborn-v0_8-".length)}`;
  }
  return name;
}

/**
 * A small preview of a style, drawn from its own rc values rather than by
 * rendering matplotlib: background, frame, grid and the first three cycle
 * colors are all the eye needs to tell ggplot from dark_background, and
 * asking Python for 26 rendered PNGs to fill a dropdown would not be.
 */
function styleThumb(preview: StylePreview): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 44 30");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("thumb");

  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", "1.5");
  rect.setAttribute("y", "1.5");
  rect.setAttribute("width", "41");
  rect.setAttribute("height", "27");
  rect.setAttribute("fill", preview.axes || "#ffffff");
  rect.setAttribute("stroke", preview.edge || "#888888");
  svg.append(rect);

  if (preview.grid) {
    for (const y of [9, 15, 21]) {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", "1.5");
      line.setAttribute("x2", "42.5");
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
      line.setAttribute("stroke", preview.grid_color || "#b0b0b0");
      line.setAttribute("stroke-width", "0.8");
      svg.append(line);
    }
  }

  const shapes = ["M4,23 L15,15 L26,18 L40,7", "M4,17 L15,21 L26,9 L40,13", "M4,10 L15,6 L26,23 L40,19"];
  preview.colors.slice(0, shapes.length).forEach((color, i) => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", shapes[i]!);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "1.6");
    svg.append(path);
  });
  return svg;
}

/** The value a bool control writes when switched on: true unless it says otherwise. */
function boolOn(spec: ControlSpec): RcValue {
  return spec.onValue === undefined ? true : spec.onValue;
}
/** ...and when switched off. */
function boolOff(spec: ControlSpec): RcValue {
  return spec.offValue === undefined ? false : spec.offValue;
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
  private _features: Required<PanelFeatures> = { ...DEFAULT_FEATURES };
  /**
   * Whether the figure follows every change, or waits for the next run. The
   * student's switch, not the host's: `features.livePreview` says whether this
   * host CAN preview at all, and this says whether they want it to right now.
   */
  private _autoUpdate = true;

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
  /** Thumbnail data per style, keyed by name. Empty until a backend supplies it. */
  private stylePreviews = new Map<string, StylePreview>();
  private overridden = new Set<string>();
  private unknownKeys: string[] = [];
  private fenceError: FenceError | null = null;
  /** True from a style change until the host calls refresh() after a run. */
  private stale = false;
  private rerunKeys = new Set<string>();
  private backendState: BackendState = "none";
  private backendMessage = "";
  /**
   * Set when the last backend call could not be served for a reason that will
   * pass on its own -- the student's program holds the interpreter, or Python
   * has not started yet. Deliberately NOT `backendState = "error"`: nothing is
   * broken, what the panel knows about the figure is still true, and the next
   * successful call clears it.
   */
  private backendStall: BackendStall | null = null;
  private writing = false;

  private pendingApply: Record<string, RcValue> = {};
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private applyChain: Promise<void> = Promise.resolve();

  private _open = false;
  /** Collapsed: the pill shows only its grip, tucked into the figure's corner. */
  private popResetBtn: HTMLButtonElement | null = null;
  /** "Show all" expands the style strip past the curated eight. */
  private allStylesShown = false;
  private pillCollapsed = false;
  /** Where the pill was dragged to before collapsing, restored on expand. */
  /** Pending "take the folded strip out of layout" timer, if any. */
  private foldTimer: number | null = null;
  private pillPosBeforeCollapse: { x: number; y: number } | null = null;
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
    /** The backend's state in two words, beside the tabs. Hidden while it is fine. */
    stallMark: HTMLElement;
    /** The "cannot preview" chip, in the slot autoBtn vacates. */
    staleMark: HTMLElement;
    staleGlyph: HTMLElement;
    staleWord: HTMLElement;
    /**
     * The clickable variants, shown instead of the inert ones when
     * `features.canRerun`. Built up front and swapped by `hidden` rather than
     * created on demand: an element cannot be both a `role="status"` live
     * region and a control, so there are genuinely two of each, and swapping
     * markup at runtime is how listeners get silently dropped.
     */
    staleBtn: HTMLButtonElement;
    staleBtnGlyph: HTMLElement;
    staleBtnWord: HTMLElement;
    stallGlyph: HTMLElement;
    stallWord: HTMLElement;
    /** The same thing as a sentence, inside the popover. */
    backendNote: HTMLElement;
    /** The "cannot preview" sentence, above the controls in the popover. */
    staleNote: HTMLElement;
    staleNoteBtn: HTMLButtonElement;
    /** Everything in the pill but the grip; folded away when collapsed. */
    pillBody: HTMLElement;
    /** The pill's auto-update switch. */
    autoBtn: HTMLButtonElement;
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
    this.backendStall = null;
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
    // Skip undefined rather than spreading it. Now that `staleNotice` and
    // `canRerun` are optional, `{ ...features, canRerun: undefined }` is a
    // thing a host can hand us -- from an options object with the key absent,
    // say -- and a plain spread would write undefined over the default and
    // strand `_features` off its `Required<>` type.
    const next = { ...this._features } as Record<string, unknown>;
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) next[key] = value;
    }
    this._features = next as unknown as Required<PanelFeatures>;
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
    return generateBlock(this.settings, this.hostRcKeys);
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
        // Fire and forget, and never fail refresh over it: a host whose helper
        // predates style_previews just gets the plain list, and the styles a
        // session offers do not change, so this runs once rather than per run.
        if (!this.stylePreviews.size && this.client) {
          void this.client
            .stylePreviews()
            .then((previews) => {
              for (const p of previews) this.stylePreviews.set(p.name, p);
              this.update();
            })
            .catch(() => {
              /* no thumbnails; the select still works */
            });
        }
        // intro.rc is the interpreter *after the block ran*, so for every key
        // the block sets it holds the block's own value. Adopting it wholesale
        // made "baseline" mean "what you just chose", and reverting a control
        // then applied that same value back: the block lost the key, the figure
        // and the slider did not move, and the revert looked broken.
        //
        // Keep the baseline we already hold for keys the block sets -- from
        // schemaDefaults() for the default style, or from set_style()'s
        // effective values for a preset -- and take intro.rc only for keys the
        // block leaves alone, where it really does describe the environment.
        const defaults = schemaDefaults();
        const fromFigure = { ...defaults, ...intro.rc };
        for (const key of Object.keys(this.settings.rc)) {
          fromFigure[key] = this.baseline[key] ?? defaults[key]!;
        }
        this.baseline = fromFigure;
        this.figureRc = { ...intro.rc };
        this.overridden = new Set(intro.overridden);
        this.figure = intro.figure;
        this.backendState = "ready";
        this.backendMessage = `matplotlib ${intro.matplotlib}${intro.figure ? "" : ", no figure yet"}`;
        this.backendStall = null;
      } catch (e) {
        this.noteBackendFailure(e, "refresh");
      }
    }
    this.update();
  }

  /** Clear every setting. Removes the block from the source. */
  reset(): void {
    const previous = this.settings;
    this.settings = defaultSettings();
    this.writeToSink();
    const keys = Object.keys(previous.rc);
    if (this.canPreview) {
      if (previous.style !== "default") this.applyStyle("default", keys);
      else this.scheduleApply(this.baselineFor(keys));
    }
    this.rerunKeys.clear();
    if (previous.style !== "default") this.noteRerun(["style"]);
    // With no preview the revert cannot be shown either: the figure still
    // carries whatever the last run drew, so the reverted keys are pending a
    // re-run exactly as a fresh change would be. Not an `else`: resetting a
    // style AND reverting rc keys both need a run, and marking only the style
    // would leave every reverted control without an indicator.
    if (!this.canPreview && keys.length) this.noteRerun(keys);
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
      sink.setSource(replaceFence(src, this.settings, this.hostRcKeys));
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
        const block = generateBlock(this.settings, this.hostRcKeys) ?? "";
        sink.setSource(block);
        return null;
      }
      try {
        const next = upsertBlock(src, this.settings, this.hostRcKeys);
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
    let apply: Record<string, RcValue> = {};
    let touched: string[] = spec.keys;
    if (value === undefined) {
      // Reverting one control clears only what that control owns; on a key two
      // controls share, the other one's parts stay. See clearOwned().
      apply = this.clearOwned([spec]).apply;
    } else {
      for (const key of spec.keys) {
        this.settings.rc[key] = (Array.isArray(value) ? [...value] : value) as RcValue;
        apply[key] = this.settings.rc[key]!;
      }
      this.unifyPerLine(spec, apply);
      // Switching this on switches on whatever it cannot work without, in the
      // same write and the same apply. Only on the way on: turning the grid
      // lines off is no reason to take the grid or the tick marks away, since
      // the student may want either on their own.
      if (spec.turnsOn && rcEqual(value, boolOn(spec))) {
        for (const id of spec.turnsOn) {
          const also = CONTROL_BY_ID.get(id);
          if (!also) continue;
          for (const key of also.keys) {
            this.settings.rc[key] = boolOn(also);
            apply[key] = this.settings.rc[key]!;
          }
          touched = [...touched, ...also.keys];
        }
      }
      // ...and off the other way. Switching off something another control
      // cannot work without leaves that one on and dead, which is the state
      // this whole mechanism exists to prevent -- it does not matter which of
      // the two switches the student reached for. A worklist rather than one
      // pass, so a chain of preconditions unwinds completely.
      if (rcEqual(value, boolOff(spec))) {
        const dead = [spec.id];
        for (let i = 0; i < dead.length; i++) {
          for (const other of CONTROLS) {
            if (!other.turnsOn?.includes(dead[i]!)) continue;
            if (dead.includes(other.id)) continue;
            if (!other.keys.some((k) => rcEqual(this.effective(k) as RcValue, boolOn(other)))) continue;
            dead.push(other.id);
            for (const key of other.keys) {
              this.settings.rc[key] = boolOff(other);
              apply[key] = this.settings.rc[key]!;
            }
            touched = [...touched, ...other.keys];
          }
        }
      }
    }
    const seeded = this.seedPanelDefaults(wasDefault);
    this.writeToSink();
    // Without a preview, a change cannot show until the program runs again, so
    // it is pending a re-run for the same reason a style preset always is.
    if (spec.category === "rerun" || !this.canPreview) this.noteRerun(touched);
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

  /**
   * The per-line values for `prop` across the rows the table actually shows,
   * or null when the cycle carries none.
   *
   * The array spans the palette (up to ten entries) while the table shows one
   * row per line in the figure, so the tail belongs to rows the user can
   * neither see nor edit. Reading it reported "mixed" for two rows that both
   * plainly said 8.
   */
  private perLineVisible(prop: "linewidth" | "linestyle"): (number | string)[] | null {
    const cycle = this.effective("axes.prop_cycle");
    if (!isPropCycle(cycle)) return null;
    const arr = cycle[prop] as (number | string)[] | undefined;
    if (!arr || !arr.length) return null;
    const cycleSpec = CONTROLS.find((c) => c.type === "linecycle");
    const visible = cycleSpec ? this.lineCycleRowCount(cycleSpec) : arr.length;
    return arr.slice(0, Math.min(arr.length, Math.max(1, visible)));
  }

  /**
   * Fill the style thumbnail strip. Rebuilt only when the set of names changes,
   * not on every update: this runs on every keystroke that touches the panel.
   */
  private updateStyleThumbs(view: ControlView, names: string[]): void {
    const host = view.styleThumbs;
    if (!host) return;
    const drawable = names.filter((n) => this.stylePreviews.has(n));
    const showAll = view.styleShowAll;
    if (!drawable.length) {
      host.hidden = true;
      if (showAll) showAll.hidden = true;
      return;
    }
    host.hidden = false;

    // Sixteen of matplotlib's twenty-six styles are seaborn variants that
    // differ subtly, so showing every one by default costs six wrapped rows to
    // little effect. The curated set spans the range. The current style is
    // always included, or picking one from the expanded list would make it
    // disappear the moment the list collapsed.
    const curated = drawable.filter(
      (n) => CURATED_STYLES.includes(n) || n === this.settings.style
    );
    const shown = this.allStylesShown || curated.length >= drawable.length ? drawable : curated;

    if (showAll) {
      showAll.hidden = curated.length >= drawable.length;
      showAll.textContent = this.allStylesShown ? "Show fewer" : `Show all ${drawable.length}`;
    }

    if (host.dataset.names !== shown.join("\n")) {
      host.dataset.names = shown.join("\n");
      host.replaceChildren(
        ...shown.map((name) => {
          const btn = el("button", { type: "button", class: "style-thumb", title: name });
          btn.dataset.style = name;
          btn.setAttribute("aria-label", name);
          // No caption: the names did not fit the cell, and the button's
          // title and aria-label already carry the full one.
          btn.append(styleThumb(this.stylePreviews.get(name)!));
          btn.addEventListener("click", () => this.setStyle(name));
          return btn;
        })
      );
      if (showAll) host.append(showAll);
    }
    for (const btn of Array.from(host.querySelectorAll<HTMLButtonElement>("button.style-thumb"))) {
      btn.setAttribute("aria-pressed", String(btn.dataset.style === this.settings.style));
    }
  }

  /** True when the rows the table shows carry per-line values that differ. */
  private perLineMixed(prop: "linewidth" | "linestyle"): boolean {
    const shown = this.perLineVisible(prop);
    return !!shown && shown.length > 1 && shown.some((v) => v !== shown[0]);
  }

  /**
   * The value every shown row shares, or null when they differ or the cycle
   * carries no per-line value. The "(all)" master displays this in preference
   * to its own scalar: with every row reading 8, a master reading 1.5 (the
   * unset scalar's default) contradicts the table right above it.
   */
  private perLineUniform(prop: "linewidth" | "linestyle"): number | string | null {
    const shown = this.perLineVisible(prop);
    if (!shown || !shown.length) return null;
    return shown.some((v) => v !== shown[0]) ? null : shown[0]!;
  }

  private setStyle(name: string): void {
    if (name === this.settings.style) return;
    const wasDefault = isDefaultSettings(this.settings);
    this.settings.style = name;
    const seeded = this.seedPanelDefaults(wasDefault);
    this.writeToSink();
    this.noteRerun(["style"]);
    if (this.client) this.applyStyle(name, []);
    // With a preview, applyStyle() re-applies every current settings.rc entry
    // (the keys seedPanelDefaults just added included) once set_style resolves,
    // so they need no scheduleApply here -- and one scheduled now would race
    // set_style: on a backend slower than the debounce the batch fires first
    // and applyStyle then re-applies the same keys, two round trips for one
    // change. Without a preview nothing applies them at all, so -- exactly as
    // setKeys() does -- they are pending a re-run and have to say so, or the
    // panel silently writes savefig.dpi and figure.autolayout into the
    // student's block with no indicator that the figure does not show them yet.
    if (!this.canPreview) this.applySeeded(seeded);
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
    return !!this.client && this._features.livePreview && this._autoUpdate;
  }

  /** Whether the figure follows every change. Off: changes wait for the next run. */
  get autoUpdate(): boolean {
    return this._autoUpdate;
  }

  set autoUpdate(on: boolean) {
    if (this._autoUpdate === on) return;
    this._autoUpdate = on;
    if (on) {
      // Catch the figure up on everything that was marked while it was off,
      // rather than leaving it showing a state the block no longer describes.
      this.rerunKeys.clear();
      if (this.settings.style !== "default" && this.settings.style !== "") {
        this.noteRerun(["style"]);  // a style still only lands on a re-run
      }
      if (this.canPreview && Object.keys(this.settings.rc).length) {
        this.scheduleApply({ ...this.settings.rc });
      }
    } else if (Object.keys(this.settings.rc).length) {
      // Whatever is in the block is now ahead of the figure, and says so.
      this.noteRerun(Object.keys(this.settings.rc));
    }
    this.emit<AutoUpdateEventDetail>("auto-update", { autoUpdate: on });
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

  /**
   * Clear what `specs` own, and return the keys that changed plus the rc to
   * send to the figure.
   *
   * A control owns its keys outright (the ordinary case) and its keys are
   * deleted. Two controls share `axes.prop_cycle` -- Look's palette and Lines'
   * per-line table -- and controls.json says which parts of that value each
   * one owns. For a shared key the value is REWRITTEN rather than deleted:
   * the owned parts go back to the baseline, the rest stay. Deleting it was
   * how "Reset Lines" silently threw away the palette the user picked under
   * Look, and "Reset Look" threw away the per-line widths.
   */
  private clearOwned(specs: readonly ControlSpec[]): { changed: string[]; apply: Record<string, RcValue> } {
    // key -> the parts these specs own, or null when one of them owns the key outright.
    const owned = new Map<string, KeyPart[] | null>();
    for (const spec of specs) {
      for (const key of spec.keys) {
        if (!(key in this.settings.rc)) continue;
        const parts = spec.owns?.[key];
        if (!parts) { owned.set(key, null); continue; }
        const seen = owned.get(key);
        if (seen === null) continue;
        owned.set(key, [...new Set([...(seen ?? []), ...parts])]);
      }
    }
    const changed: string[] = [];
    const apply: Record<string, RcValue> = {};
    for (const [key, parts] of owned) {
      const before = this.settings.rc[key]!;
      const next = parts === null ? undefined : this.withoutParts(key, before, parts);
      if (next === undefined) delete this.settings.rc[key];
      else this.settings.rc[key] = next;
      if (parts !== null && rcEqual(next, before)) continue;  // nothing of ours was set
      changed.push(key);
      const shown = next ?? this.baseline[key];
      if (shown !== undefined) apply[key] = shown;
    }
    return { changed, apply };
  }

  /**
   * `value` with `parts` put back to the baseline, or undefined when nothing
   * of it survives (so the key should be dropped). Only prop-cycle-shaped
   * values have parts; anything else is owned outright and yields undefined.
   */
  private withoutParts(key: string, value: RcValue, parts: readonly KeyPart[]): RcValue | undefined {
    const cur = asPropCycle(value);
    if (!cur) return undefined;
    const base = asPropCycle(this.baseline[key]) ?? { color: [] };
    const next: PropCycleValue = { color: parts.includes("color") ? [...base.color] : [...cur.color] };
    for (const p of ["linewidth", "linestyle"] as const) {
      const arr = cur[p];
      if (!parts.includes(p) && arr) (next[p] as typeof arr) = [...arr] as never;
    }
    // matplotlib's cycler zips equal-length lists, so a palette that changed
    // length takes the per-line arrays with it (padded with the all-lines value).
    if (next.linewidth) next.linewidth = resizeArray(next.linewidth, next.color.length, this.allLinesWidth());
    if (next.linestyle) next.linestyle = resizeArray(next.linestyle, next.color.length, this.allLinesStyle());
    if (next.linewidth || next.linestyle) return next;
    return rcEqual(next.color, base.color) ? undefined : [...next.color];
  }

  /** Revert every control in `groupId` (and, for "look", the style preset). */
  private resetCategory(groupId: string): void {
    const specs = controlsInGroup(groupId);
    const willResetStyle = groupId === "look" && this.settings.style !== "default" && this.settings.style !== "";
    const { changed, apply } = this.clearOwned(specs);
    // applyStyle() re-applies settings.rc wholesale, so only the keys that are
    // gone from it need their baseline restoring alongside the new style.
    const restoreKeys = changed.filter((k) => !(k in this.settings.rc));
    if (willResetStyle) this.settings.style = "default";
    this.writeToSink();
    if (this.canPreview) {
      if (willResetStyle) this.applyStyle("default", restoreKeys);
      else if (Object.keys(apply).length) this.scheduleApply(apply);
    }
    if (willResetStyle) this.noteRerun(["style"]);
    // See reset(): a revert that cannot be previewed is still pending a re-run,
    // and that is true alongside a style reset, not instead of it.
    if (!this.canPreview && changed.length) this.noteRerun(changed);
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
        this.noteBackendOk();
        this.baseline = { ...schemaDefaults(), ...rc };
        // canPreview, not _features.livePreview: set_style itself is worth
        // doing either way (it moves the baseline and never redraws), but
        // re-applying the overrides on top is a live preview like any other.
        if (this.canPreview) {
          const again = { ...this.baselineFor(restoreKeys), ...this.settings.rc };
          if (Object.keys(again).length) this.scheduleApply(again);
        }
        this.update();
      })
      .catch((e: unknown) => {
        this.noteBackendFailure(e, "set_style");
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
          this.noteBackendOk();
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
          this.noteBackendFailure(e, "apply_live");
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
    this.emit<ChangeEventDetail>("change", { settings: cloneSettings(this.settings), block: generateBlock(this.settings, this.hostRcKeys), source });
  }

  private emitError(error: unknown, context: string, stall: BackendStall | null = null): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.emit<PanelErrorEventDetail>("error", { error: err, context, stall });
  }

  /**
   * The one place every failed backend call lands, so the panel says the same
   * thing whichever call it was. Split two ways on purpose: a stall is the
   * host declining for now (mid-run, or Python not up), which gets a calm
   * notice and leaves `backendState` alone; anything else is a fault and gets
   * the error treatment. It never returns quietly -- the student's change did
   * not reach the figure either way, and until this existed nothing on screen
   * said so.
   */
  private noteBackendFailure(error: unknown, context: string): void {
    const stall = backendStallReason(error);
    if (stall) {
      // A standing fault outranks a transient refusal. backendTrouble() reads
      // backendStall before backendState, so without this guard a helper
      // exception followed by one mid-run refusal downgraded a loud "Preview
      // failed" to a calm "Program running" and the fault stayed invisible
      // until the next success. The event below still reports the stall
      // truthfully -- only what the panel shows is ranked.
      if (this.backendState !== "error") this.backendStall = stall;
    } else {
      this.backendStall = null;
      this.backendState = "error";
      this.backendMessage = error instanceof Error ? error.message : String(error);
    }
    this.emitError(error, context, stall);
  }

  /** The backend answered: whatever it was last showing is over. */
  private noteBackendOk(): void {
    this.backendStall = null;
    if (this.backendState === "error") {
      this.backendState = "ready";
      this.backendMessage = "";
    }
  }

  /** Returns false when a listener canceled it (cancelable events only). */
  private emit<T>(name: string, detail: T, cancelable = false): boolean {
    return this.dispatchEvent(
      new CustomEvent(`${EVENT_PREFIX}-${name}`, { detail, bubbles: true, composed: true, cancelable })
    );
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
    // Collapsed, the tabs are folded to nothing, so the window hangs off the
    // grip instead -- with no caret, because there is no tab left to point at.
    const collapsed = this.pillCollapsed && this._layoutMode !== "rail";
    const rect = (collapsed ? this.ui.pillGrip : tab).getBoundingClientRect();
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
    caret.hidden = collapsed;
    if (collapsed) return;
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
      pointerId: e.pointerId, captured: false, moved: false,
    };
    // Capture on pointerdown, for the same reason the pill's grip does: the
    // header's grip is at its left edge, so a leftward drag can leave the
    // element before the 4px threshold and stop delivering moves. Less
    // reachable here than on the pill -- the whole header row is draggable,
    // not just the dots -- but it is the same bug and the same fix.
    try {
      this.ui.header.setPointerCapture?.(e.pointerId);
      this.dragStart.captured = true;
    } catch {
      /* not every environment supports pointer capture */
    }
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
    if (!start.moved) {
      // Only becomes a DRAG once the pointer clears the threshold, so a plain
      // click on the header background still reads as a click. Capture is
      // already held either way; `moved` is what distinguishes the two.
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      start.moved = true;
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
   * landed anywhere else, a canceled gesture, or a move that arrives with no
   * button held. Leaving `dragStart` set is what let a later hover silently
   * resume the drag without a click.
   */
  private endHeaderDrag(pointerId?: number): void {
    const start = this.dragStart;
    if (!start) return;
    // Released even when the gesture never became a drag: capture is taken on
    // pointerdown now, so a plain click would otherwise leave it held.
    if (start.captured) {
      try {
        this.ui.header.releasePointerCapture?.(pointerId ?? start.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (start.moved) this.ui.popover.classList.remove("dragging");
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
      pointerId: e.pointerId, captured: false, moved: false,
    };
    // Capture NOW, before any movement. Without this the only pointermoves we
    // ever see are the ones that happen to stay over the grip, which biases
    // the gesture to whichever direction keeps the cursor on it. Capturing
    // does not commit to a drag: `moved` still decides whether this becomes a
    // drag or the click that tucks the pill away.
    try {
      this.ui.pillGrip.setPointerCapture?.(e.pointerId);
      this.pillDragStart.captured = true;
    } catch {
      /* not every environment supports pointer capture */
    }
  }

  private onPillGripPointerMove(e: PointerEvent): void {
    const start = this.pillDragStart;
    if (!start) return;
    // A move with no button held means the release happened somewhere we never
    // saw: outside the element, off the window, or a gesture the browser
    // canceled. Without this the stale start survives, and simply hovering the
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
    if (!start.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      start.moved = true;
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
    // A press and release that never cleared the drag threshold is a click,
    // not a drag, so the grip doubles as the collapse toggle. `moved`, NOT
    // `captured`: capture is taken on pointerdown now, so `captured` is true
    // for a plain click too and testing it here suppressed the collapse
    // entirely.
    const wasClick = !!this.pillDragStart && !this.pillDragStart.moved;
    this.endPillDrag(e.pointerId);
    if (wasClick) this.togglePillCollapsed();
  }

  /**
   * Collapse the pill to its grip, tucked into the figure's top-right corner,
   * or expand it again. Collapsing drops any dragged position so it really is
   * in the corner rather than wherever it was left; expanding puts it back.
   */
  private togglePillCollapsed(): void {
    this.pillCollapsed = !this.pillCollapsed;
    if (this.pillCollapsed) {
      this.pillPosBeforeCollapse = this.pillPos;
      this.pillPos = null;
      // The open category stays open. Tucking the strip away is for reclaiming
      // the figure's corner, not for putting your work away, and closing the
      // window lost the student's place every time. Its caret points at a tab
      // that is no longer there, so it is hidden while collapsed.
      if (this._menuOpen) this.closeMenu();
    } else {
      this.pillPos = this.pillPosBeforeCollapse;
      this.pillPosBeforeCollapse = null;
    }
    this.ui.pill.classList.toggle("collapsed", this.pillCollapsed);
    this.ui.pillGrip.title = this.pillCollapsed
      ? "Show the plot style controls"
      : "Drag to move, click to tuck away";
    this.update();
    // After update(), not before: update() re-renders the strip, which would
    // discard an inline width set ahead of it and leave the fold a click behind.
    this.foldPillBody();
    this.measureLayout();
    this.positionFloatPill();
    // The window it left open was anchored to a tab that has just folded away
    // (or come back), so it needs re-hanging either way.
    if (this._open && !this.dragPos) this.positionPopover();
  }

  /**
   * Fold the tab strip away, or unfold it, over FOLD_MS.
   *
   * Both ends are set here rather than in the stylesheet, because the width to
   * animate to is a number CSS cannot know -- and because an inline max-width
   * outranks any rule, so a stylesheet `max-width: 0` could never win against
   * the measured value anyway. A guessed constant is worse than useless: it
   * spends most of the duration above the strip's real width, doing nothing.
   */
  private foldPillBody(): void {
    const body = this.ui.pillBody;
    // Both values are written synchronously, with a forced reflow between them
    // so the transition has a start to interpolate from. Deliberately NOT
    // staged on requestAnimationFrame: rAF does not tick in a backgrounded tab,
    // so a collapse begun just before the student switched tabs would never
    // reach its end state and the strip would be stuck half open. This way the
    // state is always right and the easing is what the browser skips.
    if (this.foldTimer !== null) {
      clearTimeout(this.foldTimer);
      this.foldTimer = null;
    }
    if (this.pillCollapsed) {
      body.style.maxWidth = `${body.scrollWidth}px`;  // measured while open
      void body.offsetWidth;
      body.style.maxWidth = "0px";
      // Then take it out of layout for real. The CSS says visibility: hidden
      // for the fold, but a folded tab that is merely invisible is still
      // focusable and still read out, and this must be true whether or not the
      // transition ran at all.
      this.foldTimer = window.setTimeout(() => {
        this.foldTimer = null;
        if (this.pillCollapsed) body.hidden = true;
      }, FOLD_MS);
      return;
    }
    // Unfolding: the strip measures zero while folded, so lift the limit to
    // read its real width, put it back, and animate to what was measured.
    body.hidden = false;
    body.style.maxWidth = "none";
    const target = body.scrollWidth;
    body.style.maxWidth = "0px";
    void body.offsetWidth;
    body.style.maxWidth = `${target}px`;
    // Then hand the width back to layout, so the strip can still grow when a
    // tab appears or a label changes.
    window.setTimeout(() => {
      if (!this.pillCollapsed) body.style.maxWidth = "";
    }, FOLD_MS + 20);
  }

  /** End a pill drag from any exit path. See endHeaderDrag. */
  private endPillDrag(pointerId?: number): void {
    const start = this.pillDragStart;
    if (!start) return;
    // Capture is now taken on pointerdown, so it has to be released even when
    // the gesture never became a drag -- otherwise a plain click on the grip
    // leaves the pointer captured and the next gesture anywhere on the page
    // is delivered to the grip instead.
    if (start.captured) {
      try {
        this.ui.pillGrip.releasePointerCapture?.(pointerId ?? start.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (start.moved) this.ui.pill.classList.remove("dragging");
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

  /** Show the popover's reset only when the open category has something to reset. */
  private updateGroupReset(): void {
    const btn = this.popResetBtn;
    if (!btn) return;
    const group = this.category;
    const has = !!group && this.groupHasChanges(group);
    btn.hidden = !has;
    if (has) {
      const label = GROUPS.find((g) => g.id === group)?.label ?? group;
      btn.title = `Reset ${label}`;
      btn.setAttribute("aria-label", `Reset ${label}`);
    }
  }

  private groupHasChanges(groupId: string): boolean {
    if (groupId === "look" && this.settings.style !== "" && this.settings.style !== "default") return true;
    return controlsInGroup(groupId).some((c) => this.controlIsSet(c));
  }

  /**
   * Whether this control has something of its own set. For a key two controls
   * share (axes.prop_cycle) "its own" means the parts controls.json gives it:
   * a Look palette must not light up the Lines tab's dot and reset, and a
   * per-line width must not light up Look's.
   */
  private controlIsSet(spec: ControlSpec): boolean {
    return spec.keys.some((key) => {
      const value = this.settings.rc[key];
      if (value === undefined) return false;
      const parts = spec.owns?.[key];
      if (!parts) return true;
      const cur = asPropCycle(value);
      if (!cur) return true;
      const base = asPropCycle(this.baseline[key]);
      return parts.some((p) =>
        p === "color" ? !base || !rcEqual(cur.color, base.color) : cur[p] !== undefined
      );
    });
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
    // The backend's own state, in words, in the pill. Everything about a
    // failed helper call used to live in `pill.title` -- a hover tooltip --
    // so a student whose drag was refused mid-run saw nothing move and
    // nothing change, and read that as the tool having stopped working.
    const stallGlyph = el("span", { class: "glyph" });
    stallGlyph.setAttribute("aria-hidden", "true");
    const stallWord = el("span", { class: "stall-word" });
    const stallMark = el("span", { class: "stall", hidden: true }, stallGlyph, stallWord);
    // role="status" (polite), not role="alert": these follow the student's own
    // action, and the common one -- "your program is still running" -- is not
    // something to interrupt anybody over. Matches the fence banner's
    // role-plus-`hidden` shape.
    stallMark.setAttribute("role", "status");
    stallMark.setAttribute("aria-live", "polite");
    // The "cannot preview" chip, built like stallMark and sitting in the slot
    // autoBtn vacates -- the student loses a control and gains the reason in
    // its place. Not a `backendTrouble` variant: that reports transient faults
    // and waits, and this is a permanent property of the host. It never takes
    // the `bad` treatment and never recolors the shell border, because a state
    // that is true for the whole lab would train the color away.
    const staleGlyph = el("span", { class: "glyph" });
    staleGlyph.setAttribute("aria-hidden", "true");
    const staleWord = el("span", { class: "stale-word" });
    const staleMark = el("span", { class: "stall stale", hidden: true }, staleGlyph, staleWord);
    staleMark.setAttribute("role", "status");
    staleMark.setAttribute("aria-live", "polite");
    // The clickable twin. No role="status" and no aria-live: a control cannot
    // be a live region, and its label already says what it does.
    const staleBtnGlyph = el("span", { class: "glyph" });
    staleBtnGlyph.setAttribute("aria-hidden", "true");
    const staleBtnWord = el("span", { class: "stale-word" });
    const staleBtn = el(
      "button",
      { type: "button", class: "stall stale act", hidden: true },
      staleBtnGlyph, staleBtnWord
    ) as HTMLButtonElement;
    staleBtn.addEventListener("click", () => this.requestRerun());
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

    const pillGrip = el("span", { class: "grip", title: "Drag to move, click to tuck away" }, "⋮⋮");
    pillGrip.addEventListener("pointerdown", (e) => this.onPillGripPointerDown(e as PointerEvent));
    pillGrip.addEventListener("pointermove", (e) => this.onPillGripPointerMove(e as PointerEvent));
    pillGrip.addEventListener("pointerup", (e) => this.onPillGripPointerUp(e as PointerEvent));
    // A canceled gesture (touch interrupted, browser takeover) never sends
    // pointerup, so without this the drag state would be left standing.
    pillGrip.addEventListener("pointercancel", (e) => this.endPillDrag((e as PointerEvent).pointerId));
    pillGrip.addEventListener("dblclick", () => this.reanchorPill());
    // In the pill rather than in a category, because a student reaches for it
    // when a change is about to be expensive -- which is before they have
    // opened anything. Always visible, so it is discoverable without hunting.
    const autoGlyph = el("span", { class: "glyph" }, "\u27F3");
    autoGlyph.setAttribute("aria-hidden", "true");
    const autoBtn = el(
      "button",
      { type: "button", class: "auto-update" },
      autoGlyph,
      el("span", { class: "auto-word" }, "Auto")
    );
    autoBtn.addEventListener("click", () => {
      this.autoUpdate = !this._autoUpdate;
    });
    // Everything but the grip lives in one wrapper, so collapsing is a single
    // grid column going 1fr -> 0fr. Animating each child's max-width instead
    // spends most of the duration above their natural width, doing nothing.
    const pillBody = el("div", { class: "pill-body" }, ...pillTabs, errMark, stallMark, staleMark, staleBtn, autoBtn, menuToggle);
    const pill = el("div", { class: "pill", role: "tablist" }, pillGrip, pillBody);
    const rail = el("div", { class: "rail", role: "tablist", hidden: true }, ...railTabs);

    // --- Popover ---
    const grip = el("span", { class: "grip" }, "⋮⋮");
    const title = el("span", { class: "title" });
    const reanchorBtn = el("button", { type: "button", class: "reanchor", title: "Move back to the tab" }, "⌖");
    const closeBtn = el("button", { type: "button", class: "close" }, "✕");
    closeBtn.setAttribute("aria-label", "Close");
    // One reset per open category, beside its name, shown only when that
    // category has something to reset. A revert on every row was noise: most
    // of them were hidden most of the time, and the ones that showed invited
    // the reader to hunt for which control they belonged to.
    const resetGroupBtn = el("button", { type: "button", class: "reset-group", hidden: true }, "\u21ba");
    resetGroupBtn.addEventListener("click", () => {
      if (this.category) this.resetCategory(this.category);
    });
    // Title and reset travel together on the left. They share a flex: 1 wrapper
    // rather than the title carrying flex itself, so the reset stays beside the
    // name whether or not it is showing, and the pin/close still sit far right.
    const headMain = el("div", { class: "pop-head-main" }, title, resetGroupBtn);
    const header = el(
      "div",
      { class: "pop-head", title: "Drag to move" },
      grip, headMain, reanchorBtn, closeBtn
    );
    this.popResetBtn = resetGroupBtn;
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

    // The full sentence the pill's two words stand for. It sits ABOVE the
    // controls rather than replacing them, unlike the fence banner: a busy
    // backend does not stop the panel writing, so the controls stay usable.
    const backendNote = el("div", { class: "banner stall", hidden: true });
    backendNote.setAttribute("role", "status");
    backendNote.setAttribute("aria-live", "polite");

    // The sentence the chip's word stands for. Above the controls for the same
    // reason backendNote is: the panel still writes its block, so the controls
    // stay usable. This is also the ONLY place the notice is readable in
    // "rail" layout, where the pill is hidden outright (see update()) -- and
    // the student has to open the popover to move a control anyway.
    const staleNote = el("div", { class: "banner stall stale", hidden: true });
    staleNote.setAttribute("role", "status");
    staleNote.setAttribute("aria-live", "polite");
    // The sentence as a control: the comfortable click target of the two, at
    // the full width of the popover.
    const staleNoteBtn = el(
      "button", { type: "button", class: "banner stall stale act", hidden: true }
    ) as HTMLButtonElement;
    staleNoteBtn.addEventListener("click", () => this.requestRerun());

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

    const popBody = el("div", { class: "pop-body" }, banner, backendNote, staleNote, staleNoteBtn, ...groupEls, unknownNote);
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
      pill, pillGrip, pillBody, errMark, stallMark, stallGlyph, stallWord, backendNote,
      staleMark, staleGlyph, staleWord, staleNote,
      staleBtn, staleBtnGlyph, staleBtnWord, staleNoteBtn,
      autoBtn, menuToggle, rail,
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
    // The per-row revert is gone; the popover header carries one reset for the
    // whole category. Kept as a detached element so ControlView's shape and the
    // update path below do not need special-casing per control type.
    const revert = el("button", { type: "button", class: "revert", hidden: true }, "\u21ba");
    revert.setAttribute("aria-label", `Revert ${spec.label}`);
    revert.addEventListener("click", () => this.setKeys(spec, undefined));
    // The per-line table's revert sits at the right end of its label row (not
    // on its own row below the table), so it moves into a small label-row
    // wrapper alongside the label and its badges; every other control keeps
    // the plain label/badges/control layout, with revert inside .control.
    const row = spec.type === "linecycle"
      ? el("div", { class: "row" }, el("div", { class: "control-label-row" }, label, badges), control)
      : el("div", { class: "row" }, label, badges, control);
    row.dataset.control = spec.id;
    if (spec.category === "save") row.title = "Applies when the figure is saved, not on screen.";
    const inputs: (HTMLInputElement | HTMLSelectElement)[] = [];
    let segmented: HTMLElement | undefined;
    let swatchList: HTMLElement | undefined;
    let styleThumbs: HTMLElement | undefined;
    let styleShowAll: HTMLButtonElement | undefined;
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
        // The menu and the thumbnails do different jobs and both earn their
        // place: the menu names every style and is reachable in one keystroke,
        // the thumbnails show what one looks like. The menu sits beside the
        // label, so the grid below it starts at the top of the control.
        const select = el("select", { id, class: "style-select" });
        select.addEventListener("change", () => this.setStyle(select.value));
        inputs.push(select);
        control.append(select);
        // Spans the full row width, under the preset select (see the "row"
        // grid: an unplaced child would otherwise land in the narrow label
        // column), so it reads as a note about the whole control.
        // Thumbnails are populated in update(): the previews arrive from the
        // backend after the first refresh, and a host may never supply them.
        const thumbs = el("div", { class: "style-thumbs" , hidden: true });
        row.append(thumbs);
        styleThumbs = thumbs;
        // Lives inside the thumbnail strip rather than on a row of its own, so
        // it fills the gap the last row leaves instead of claiming new height.
        const showAll = el("button", { type: "button", class: "show-all-styles", hidden: true });
        showAll.addEventListener("click", () => {
          this.allStylesShown = !this.allStylesShown;
          this.update();
        });
        styleShowAll = showAll;
        const note = el("p", { class: "next-run" }, "Applies on the next run.");
        row.append(note);
        nextRunNote = note;
        break;
      }
      case "copycode": {
        // A button, not a setting. The async clipboard API is refused in some
        // contexts (no user gesture, insecure origin, an iframe without the
        // permission), and Trinket runs the embed in an iframe -- so failure
        // is reported rather than swallowed, and the block stays visible via
        // the reset menu's "Show code" either way.
        const button = el("button", { type: "button", id, class: "copy-code" }, spec.label);
        const said = el("span", { class: "copy-said", hidden: true });
        button.addEventListener("click", () => {
          const block = this.getBlock();
          if (!block) {
            said.textContent = "Nothing to copy yet";
            said.hidden = false;
            window.setTimeout(() => { said.hidden = true; }, 2000);
            return;
          }
          const done = (ok: boolean) => {
            said.textContent = ok ? "Copied" : "Copy failed \u2014 use Show code";
            said.hidden = false;
            window.setTimeout(() => { said.hidden = true; }, 2000);
          };
          const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
          if (!clipboard?.writeText) { done(false); return; }
          clipboard.writeText(block).then(() => done(true), () => done(false));
        });
        control.append(button, said);
        break;
      }
      case "savefig": {
        // The only thing in the tool that exercises the Save category. It goes
        // through matplotlib's savefig rather than the on-screen canvas, so
        // savefig.dpi / transparent / bbox actually apply -- a canvas grab
        // gives a screen-resolution PNG and none of them.
        const button = el("button", { type: "button", id, class: "save-fig" }, spec.label);
        const said = el("span", { class: "copy-said", hidden: true });
        const say = (text: string) => {
          said.textContent = text;
          said.hidden = false;
          window.setTimeout(() => { said.hidden = true; }, 2500);
        };
        button.addEventListener("click", () => {
          const client = this.client;
          if (!client) { say("Run your code first"); return; }
          button.disabled = true;
          void client
            .saveFigure("png")
            .then((result) => {
              this.noteBackendOk();
              this.update();
              if (!result.has_figure) { say("No figure to save"); return; }
              const filename = `plot.${result.format}`;
              // The host gets first refusal, because in an iframe a page-driven
              // download is exactly the thing that gets blocked -- the same trap
              // Copy code fell into.
              const handled = !this.emit<SavedEventDetail>(
                "saved",
                { format: result.format, data: result.data, bytes: result.bytes, filename },
                true
              );
              if (handled) { say("Saved"); return; }
              const link = el("a", {
                href: `data:image/${result.format};base64,${result.data}`,
              }) as HTMLAnchorElement;
              link.download = filename;
              link.click();
              say(`Saved ${filename}`);
            })
            .catch((e: unknown) => {
              // Same sink as every other backend call: "Save failed" says the
              // button did nothing, the pill says why (a run in progress reads
              // very differently from a helper that raised).
              this.noteBackendFailure(e, "save_figure");
              this.update();
              say("Save failed");
            })
            .finally(() => { button.disabled = false; });
        });
        control.append(button, said);
        break;
      }
      case "bool": {
        const input = el("input", { type: "checkbox", id, class: "switch" });
        input.addEventListener("change", () =>
          this.setKeys(spec, input.checked ? boolOn(spec) : boolOff(spec))
        );
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
        // Bounds live in controls.json like every other slider's. 6-40pt covers
        // every relative name's resolved size at any base font.size the
        // "Text size" slider allows (6-24pt).
        const range = rangeFromSpec(spec, id);
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
        const range = rangeFromSpec(spec, id);
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
        const xRange = rangeFromSpec(spec, id);
        xRange.setAttribute("aria-label", "Legend x");
        const yRange = rangeFromSpec(spec, "");
        yRange.removeAttribute("id");
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
    // revert is no longer appended anywhere: the category reset in the popover
    // header replaced it. The element stays in the view so updateControl can go
    // on setting `.hidden` without a type-by-type special case.
    // A button says its own name, so repeating it in the label column reads as
    // a stutter -- "Save PNG | [Save PNG]". The label carries the help tooltip,
    // so that moves onto the button rather than being lost with it.
    if (spec.type === "copycode" || spec.type === "savefig") {
      label.hidden = true;
      const button = control.querySelector("button");
      if (button && spec.help) button.title = spec.help;
    }

    const view: ControlView = { spec, row, inputs, badges, revert };
    if (segmented) view.segmented = segmented;
    if (swatchList) view.swatchList = swatchList;
    if (styleThumbs) view.styleThumbs = styleThumbs;
    if (styleShowAll) view.styleShowAll = styleShowAll;
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
        // Unchanged since it was rendered: write back what the color actually
        // was, not the input's sanitized idea of it.
        const untouched = r.color.dataset.rendered !== undefined && r.color.value === r.color.dataset.rendered;
        color.push(untouched ? (r.color.dataset.orig ?? r.color.value) : r.color.value);
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

  /**
   * What the panel has to say about the backend right now, or null when there
   * is nothing to say. Note what is NOT in here: "no backend" and "connecting"
   * are ordinary, and `features.livePreview: false` is a host that never
   * previews, not a host that failed to. None of the three is TROUBLE.
   *
   * `livePreview: false` does now get a message, but through `staleAdvice()`
   * rather than here -- it is a permanent property of the host rather than a
   * fault or a wait, so it takes neither the `bad` treatment nor the shell
   * border. Keep the two apart: a host that can never preview must not report
   * a failure.
   *
   * `bad` separates a fault from a wait. A helper that raised is worth the
   * danger color; a program still running is the most ordinary thing a physics
   * student's animation loop does, and painting that red would teach them to
   * ignore the color by the second lab.
   */
  private backendTrouble(): { glyph: string; word: string; sentence: string; bad: boolean } | null {
    // Only true if the block is being written somewhere; with no sink there is
    // nothing for a re-run to pick up, so the advice would be a lie.
    const saved = this._sink !== null;
    if (this.backendStall === "busy") {
      return {
        glyph: "⏳", word: "Program running", bad: false,
        sentence: "Your program is still running, so the figure did not change."
          + (saved ? " Your settings are saved in your code — run your program again to see them." : ""),
      };
    }
    if (this.backendStall === "loading") {
      return {
        glyph: "⏳", word: "Python starting", bad: false,
        sentence: "Python has not started yet, so the figure did not change."
          + (saved ? " Your settings are saved in your code — run your program once to see them." : ""),
      };
    }
    if (this.backendState === "error") {
      const detail = this.backendMessage.trim().replace(/\.$/, "");
      return {
        glyph: "⚠", word: "Preview failed", bad: true,
        sentence: `Live preview stopped${detail ? `: ${detail}` : ""}.`
          + (saved ? " Your settings are still saved in your code — run your program again to see them." : ""),
      };
    }
    return null;
  }

  /**
   * What to say when this host can never preview, or null when there is
   * nothing to say. Larry's decision, 2026-09-09: on the worker runtime there
   * is no second interpreter to preview against, so the slider appears to do
   * nothing until the student runs. The panel still writes its block, so
   * nothing is lost but the immediacy -- and the harm is a control that looks
   * broken, which a sentence fixes.
   *
   * Two conditions, both required:
   *
   * - `!features.livePreview`. Nothing at all when live updating works, which
   *   is the spec: the notice appears ONLY when it does not. A host that CAN
   *   preview but is momentarily stalled is `backendTrouble()`'s business.
   * - A sink to write to. With `_sink === null` the block goes nowhere, so
   *   there is nothing for a re-run to pick up and "re-run to update" would be
   *   a lie. `backendTrouble()` gates its own re-run advice the same way.
   */
  private staleAdvice(): StaleNotice | null {
    if (this._features.livePreview) return null;
    if (this._sink === null) return null;
    // A sink is not the same as a READABLE sink, which is what the gate above
    // was reaching for and half-wrote. `CodeSink` explicitly allows write-only
    // sinks -- `ClipboardSink.getSource()` returns null by design -- and for
    // one of those the block lands on the clipboard, never in the source, so
    // the next run reads exactly what the last one did. "Re-run to update the
    // plot" is then false in precisely the way `_sink === null` was added to
    // prevent.
    if (this._sink.getSource() === null) return null;
    // A malformed fence stops the panel writing at all ("The panel will not
    // write until this is fixed"), so a re-run has nothing new to pick up
    // either. The fence error already owns the shell: `.error`, the `!` mark
    // and the banner. Two contradictory instructions in one pill is worse than
    // one, and the fence error is the one the student can act on.
    if (this.fenceError !== null) return null;
    return { ...DEFAULT_STALE, ...(this._features.staleNotice ?? {}) };
  }

  /**
   * Ask the host to run the program again. The panel cannot do it itself and
   * must not try to: it is host-agnostic, and "run" means something different
   * in every embed. Trinket's adapter answers this by firing its own
   * `trinket.code.run`.
   *
   * No optimism afterwards: the notice stays exactly as it is. The host clears
   * it by calling `refresh()` when the run actually finishes, which it already
   * does, and which already clears `rerunKeys` and `stale`. Hiding the notice
   * on click would claim a run happened when the host may have declined it --
   * mid-run, say.
   */
  private requestRerun(): void {
    this.emit<RerunRequestedEventDetail>("rerun-requested", { keys: [...this.rerunKeys] });
  }

  // -------------------------------------------------------------------------
  // DOM: sync with state
  // -------------------------------------------------------------------------

  private update(): void {
    const { ui } = this;
    if (!ui) return;

    const trouble = this.backendTrouble();
    // Computed before the title, because the title must not contradict it. A
    // host can attach a working backend and still declare livePreview:false --
    // it wants set_style() and save, not per-control preview -- and then
    // backendState is "ready", so the last arm below reported "Live preview
    // on" while the chip beside it said the opposite. The rail, which has no
    // room for the chip, showed only the wrong half.
    const stale = this.staleAdvice();
    const statusText =
      // A stall leaves backendState at "ready"/"connecting" on purpose (see
      // backendStall), so the tooltip has to come from the trouble or it would
      // cheerfully report "Live preview on" over a refused call.
      trouble && !trouble.bad ? trouble.sentence
      : stale !== null ? stale.sentence
      : this.backendState === "none" ? "No live preview (no backend)"
      : this.backendState === "connecting" ? "Connecting to Python…"
      : this.backendState === "error" ? `Backend error: ${this.backendMessage}`
      : `Live preview on · ${this.backendMessage}`;
    ui.pill.title = statusText;
    ui.rail.title = statusText;

    // Visible, in the pill, without hovering anything.
    ui.stallMark.hidden = trouble === null;
    ui.stallMark.classList.toggle("bad", trouble !== null && trouble.bad);
    if (trouble) {
      ui.stallGlyph.textContent = trouble.glyph;
      ui.stallWord.textContent = trouble.word;
      ui.stallMark.title = trouble.sentence;
    }
    // The rail has no room for the chip and the pill can be folded down to its
    // grip, so the shell itself carries the state too -- the same fallback
    // `.error` already uses for a malformed fence.
    for (const shell of [ui.pill, ui.rail]) {
      shell.classList.toggle("stalled", trouble !== null);
      shell.classList.toggle("bad", trouble !== null && trouble.bad);
    }
    ui.backendNote.hidden = trouble === null;
    ui.backendNote.classList.toggle("bad", trouble !== null && trouble.bad);
    if (trouble) ui.backendNote.textContent = trouble.sentence;
    this.updateGroupReset();
    // Shown whenever the HOST could ever preview, not once a backend has
    // actually attached. On the demo's real path -- and on Trinket -- the
    // interpreter arrives only when the student first runs, so keying this to
    // `this.client` hid the switch for exactly as long as it was useful:
    // before the first run, which is when someone about to start a long
    // computation would reach for it. `features.livePreview` is the host's
    // own declaration, so a worker host that can never preview still hides it.
    ui.autoBtn.hidden = !this._features.livePreview;
    // The chip takes the slot the switch just vacated. Mutually exclusive by
    // construction: both are keyed to `features.livePreview`. (`stale` is
    // computed at the top of update(), beside the title it now feeds.)
    // Exactly one of each pair is ever shown: the button when the host can
    // service a re-run, the inert status element when it cannot.
    const asButton = stale !== null && this._features.canRerun;
    ui.staleMark.hidden = stale === null || asButton;
    ui.staleBtn.hidden = !asButton;
    ui.staleNote.hidden = stale === null || asButton;
    ui.staleNoteBtn.hidden = !asButton;
    // Larry, 2026-09-10: once the student has actually changed something, the
    // button has to escalate -- resting it says "you will need to re-run",
    // pending it says "you have unseen work waiting on a click". `rerunKeys`
    // already tracks exactly this and is already cleared by refresh() when a
    // run completes, so the button drops back on its own. The per-tab and
    // per-control `↻` marks key off the same set.
    const rerunPending = stale !== null && this.rerunKeys.size > 0;
    for (const node of [ui.staleMark, ui.staleBtn, ui.staleNote, ui.staleNoteBtn]) {
      node.classList.toggle("pending", rerunPending);
    }
    // Larry, 2026-09-10: inactive until there is something to see, then active.
    // A real `disabled`, not a muted look over a live control -- pressing it
    // with nothing pending would run the program to redraw an identical
    // figure, and the affordance is meant to READ as progress: dim means
    // nothing is waiting on you, lit means something is. The host's own Run
    // button is still right there for an unconditional run.
    ui.staleBtn.disabled = !rerunPending;
    ui.staleNoteBtn.disabled = !rerunPending;
    if (stale) {
      ui.staleGlyph.textContent = stale.glyph;
      ui.staleWord.textContent = stale.word;
      ui.staleMark.title = stale.sentence;
      ui.staleNote.textContent = stale.sentence;
      ui.staleBtnGlyph.textContent = stale.glyph;
      ui.staleBtnWord.textContent = stale.word;
      ui.staleBtn.title = stale.sentence;
      // The sentence IS the button's label, so it needs no separate title and
      // no aria-label -- both would only repeat it to a screen reader.
      ui.staleNoteBtn.textContent = stale.sentence;
    }
    ui.autoBtn.setAttribute("aria-pressed", String(this._autoUpdate));
    ui.autoBtn.classList.toggle("off", !this._autoUpdate);
    ui.autoBtn.title = this._autoUpdate
      ? "Auto-update is on: the figure follows every change. Click to pause it."
      : "Auto-update is off: changes wait for the next run. Click to resume.";
    ui.autoBtn.setAttribute("aria-label", this._autoUpdate ? "Auto-update on" : "Auto-update off");
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
    const block = generateBlock(this.settings, this.hostRcKeys);
    ui.codePre.textContent = block ?? "# (no block: every setting is at its default)";
    ui.codePre.hidden = !(this._features.showCode && this._codeOpen);

    // Controls.
    for (const view of this.views.values()) this.updateControl(view);
  }

  private updateControl(view: ControlView): void {
    const { spec, row, badges, revert } = view;
    const isSet = this.controlIsSet(spec);
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
          select.replaceChildren(
            ...names.map((n) =>
              el(
                "option",
                { value: n, title: n },
                n === this.settings.style && !this.styles.includes(n)
                  ? `${shortStyleName(n)} (not available here)`
                  : shortStyleName(n)
              )
            )
          );
        }
        select.value = this.settings.style;
        this.updateStyleThumbs(view, names);
        if (view.nextRunNote) view.nextRunNote.classList.toggle("pending", this.rerunKeys.has("style"));
        break;
      }
      case "copycode":
        break;  // a button: no value to reflect
      case "savefig":
        // Needs a live interpreter to save from; says so on click rather than
        // going grey, since "Run your code first" is the actual instruction.
        break;
      case "bool":
        (view.inputs[0] as HTMLInputElement).checked =
          spec.onValue === undefined ? Boolean(value) : value === spec.onValue;
        break;
      case "number": {
        const v = typeof value === "number" ? String(value) : "";
        const isLineMaster = spec.keys.includes("lines.linewidth");
        const mixed = isLineMaster && this.perLineMixed("linewidth");
        const uniform = isLineMaster ? this.perLineUniform("linewidth") : null;
        const shown = uniform === null ? v : String(uniform);
        row.classList.toggle("mixed", mixed);
        if (view.rangeInput) {
          view.rangeInput.value = shown;
          view.rangeInput.title = mixed ? "Set per line below; drag to make every line the same." : "";
          if (view.readout) view.readout.textContent = mixed ? "mixed" : shown;
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
        // A relative size resolves to whatever the scaling gives -- "large" at
        // base 12 is 14.4 -- and a range input cannot hold a value off its step
        // grid: assigning 14.4 to a step-0.5 slider stores 14.5. Put the thumb
        // on the nearest step ourselves and let the readout and title carry the
        // exact value, so the control and the number beside it agree and the
        // block still gets the size the student actually chose.
        if (!editing) input.value = String(snapToStep(resolved, spec));
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
          if (!this.isEditing(r.color)) {
            // <input type="color"> only understands #rrggbb. matplotlib's
            // palettes are full of things it does not: the classic style is
            // ['b','g','r','c','m','y','k'], grayscale is ['0.00','0.40',...],
            // and 'C0'/'tab:blue'/'#abc' are ordinary too. The input silently
            // turns every one of them into #000000. Remember the real value
            // and what the input made of it, so an untouched swatch can be
            // written back as it was rather than as black.
            r.color.dataset.orig = color[i]!;
            r.color.value = color[i]!;
            r.color.dataset.rendered = r.color.value;
          }
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

/** A range input carrying the control's own min/max/step from the schema. */
function rangeFromSpec(spec: ControlSpec, id: string): HTMLInputElement {
  const range = el("input", { type: "range", id });
  if (spec.min !== undefined) range.min = String(spec.min);
  if (spec.max !== undefined) range.max = String(spec.max);
  if (spec.step !== undefined) range.step = String(spec.step);
  return range;
}

/** `n` moved to the nearest value the control's step grid can actually hold. */
function snapToStep(n: number, spec: ControlSpec): number {
  const step = spec.step;
  if (!step) return n;
  const min = spec.min ?? 0;
  return round(min + Math.round((n - min) / step) * step);
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
