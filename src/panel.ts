/**
 * <stylefence-panel>: the Web Component.
 *
 * State is one StyleSettings ({ style, rc }) plus a baseline of effective rc
 * values pulled from the backend. The panel writes the settings into the
 * user's source through a CodeSink (as one fenced block) and previews them on
 * the retained figure through a FigureBackend. It never renders or edits
 * anything else in the user's code.
 */

import css from "./panel.css?inline";
import { BackendError, HelperClient, type FigureBackend } from "./backend";
import {
  FenceError, defaultSettings, generateBlock, isDefaultSettings, parseBlock, replaceFence, upsertBlock,
  type StyleSettings,
} from "./block";
import { ELEMENT_TAG, EVENT_PREFIX, VERSION } from "./constants";
import {
  CONTROLS, GROUPS, RELATIVE_SIZES, controlsInGroup, rcEqual, resolveFontSize,
  type ControlSpec, type RcValue,
} from "./schema";
import type { CodeSink } from "./sink";

export interface PanelFeatures {
  /** Apply artist-level equivalents to the retained figure as controls change. */
  livePreview: boolean;
  /** Show the generated block, read-only, under the controls. */
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

interface ControlView {
  spec: ControlSpec;
  row: HTMLElement;
  inputs: (HTMLInputElement | HTMLSelectElement)[];
  badges: HTMLElement;
  revert: HTMLButtonElement;
  swatches?: HTMLElement;
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

export class StylefencePanel extends HTMLElement {
  /** rc keys your host sets once at startup; preserved when the panel resets styles. */
  hostRcKeys: string[] = [];

  private _backend: FigureBackend | null = null;
  private client: HelperClient | null = null;
  private _sink: CodeSink | null = null;
  private unsubscribeSink: (() => void) | null = null;
  private _features: PanelFeatures = { ...DEFAULT_FEATURES };

  private settings: StyleSettings = defaultSettings();
  private baseline: Record<string, RcValue> = schemaDefaults();
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

  private readonly root: ShadowRoot;
  private views = new Map<string, ControlView>();
  private ui!: {
    status: HTMLElement;
    fenceBanner: HTMLElement;
    fenceMessage: HTMLElement;
    rerunBanner: HTMLElement;
    rerunText: HTMLElement;
    unknownBanner: HTMLElement;
    code: HTMLDetailsElement;
    codePre: HTMLElement;
    resetButton: HTMLButtonElement;
    sections: Map<string, HTMLElement>;
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
        this.overridden = new Set(intro.overridden);
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
      const restore: Record<string, RcValue> = {};
      for (const key of Object.keys(previous.rc)) {
        const base = this.baseline[key];
        if (base !== undefined) restore[key] = base;
      }
      if (previous.style !== "default") void this.applyStyle("default");
      else this.scheduleApply(restore);
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
    if (this.client) void this.applyStyle(name);
    this.emitChange();
    this.update();
  }

  /** set_style in the session, then put the current overrides back on top. */
  private async applyStyle(name: string): Promise<void> {
    if (!this.client) return;
    this.stale = true;
    try {
      const rc = await this.client.setStyle(name, this.hostRcKeys);
      this.baseline = { ...schemaDefaults(), ...rc };
      if (Object.keys(this.settings.rc).length && this._features.livePreview) {
        this.scheduleApply({ ...this.settings.rc });
      }
    } catch (e) {
      this.backendState = "error";
      this.backendMessage = e instanceof Error ? e.message : String(e);
      this.emitError(e, "set_style");
    }
    this.update();
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
      this.applyChain = this.applyChain
        .then(() => client.applyLive(batch))
        .then((result) => {
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

  /** Resolves when any pending live-apply work has finished. For tests and hosts. */
  async settle(): Promise<void> {
    if (this.applyTimer) {
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
  // DOM: build once
  // -------------------------------------------------------------------------

  private build(): void {
    const style = el("style");
    style.textContent = css;

    const resetButton = el("button", { type: "button", title: "Clear every setting and remove the block" }, "Reset all");
    resetButton.addEventListener("click", () => this.reset());
    const status = el("span", { class: "status" });

    const fenceMessage = el("span");
    const replaceButton = el("button", { type: "button", class: "small" }, "Replace block");
    replaceButton.addEventListener("click", () => this.replaceBlock());
    const fenceBanner = el("div", { class: "banner error", role: "alert", hidden: true }, fenceMessage, replaceButton);

    const rerunText = el("span");
    const rerunBanner = el("div", { class: "banner warn", hidden: true }, rerunText);

    const unknownBanner = el("div", { class: "banner warn", hidden: true });

    const header = el(
      "header",
      {},
      el("h2", {}, "Plot style"),
      el("span", { class: "version" }, `${ELEMENT_TAG} ${VERSION}`),
      el("p", { class: "note" }, "Sets matplotlib defaults for this program. Your own code always wins over these defaults."),
    );

    const panel = el("div", { class: "panel" }, header, el("div", { class: "toolbar" }, resetButton, status), fenceBanner, rerunBanner, unknownBanner);

    const sections = new Map<string, HTMLElement>();
    for (const group of GROUPS) {
      const section = el("section", {}, el("h3", {}, group.label));
      section.dataset.group = group.id;
      for (const spec of controlsInGroup(group.id)) section.append(this.buildControl(spec));
      sections.set(group.id, section);
      panel.append(section);
    }

    const codePre = el("pre");
    const code = el("details", { class: "code" }, el("summary", {}, "Generated block"), codePre);
    panel.append(code);

    this.root.append(style, panel);
    this.ui = { status, fenceBanner, fenceMessage, rerunBanner, rerunText, unknownBanner, code, codePre, resetButton, sections };
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
    let swatches: HTMLElement | undefined;

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
        const input = el("input", { type: "checkbox", id });
        input.addEventListener("change", () => this.setKeys(spec, input.checked));
        inputs.push(input);
        control.append(input);
        break;
      }
      case "number": {
        const input = number();
        input.addEventListener("change", () => {
          const n = Number(input.value);
          if (input.value !== "" && Number.isFinite(n)) this.setKeys(spec, n);
          else this.update();
        });
        inputs.push(input);
        control.append(input);
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
        const select = el("select", { id });
        for (const opt of spec.options ?? []) select.append(el("option", { value: opt.value }, opt.label));
        select.addEventListener("change", () => this.setKeys(spec, select.value));
        inputs.push(select);
        control.append(select);
        break;
      }
      case "colorcycle": {
        swatches = el("span", { class: "swatches" });
        const select = el("select", { id });
        for (const preset of spec.presets ?? []) select.append(el("option", { value: preset.id }, preset.label));
        select.append(el("option", { value: "__custom__", disabled: true }, "Custom (from your file)"));
        select.addEventListener("change", () => {
          const preset = spec.presets?.find((p) => p.id === select.value);
          if (preset) this.setKeys(spec, [...preset.colors]);
        });
        inputs.push(select);
        control.append(swatches, select);
        break;
      }
    }
    control.append(revert);
    const view: ControlView = { spec, row, inputs, badges, revert };
    if (swatches) view.swatches = swatches;
    this.views.set(spec.id, view);
    return row;
  }

  // -------------------------------------------------------------------------
  // DOM: sync with state
  // -------------------------------------------------------------------------

  private update(): void {
    const { ui } = this;
    if (!ui) return;

    // Status line.
    ui.status.classList.toggle("error", this.backendState === "error");
    ui.status.textContent =
      this.backendState === "none" ? "No live preview (no backend)"
      : this.backendState === "connecting" ? "Connecting to Python…"
      : this.backendState === "error" ? `Backend error: ${this.backendMessage}`
      : `Live preview on · ${this.backendMessage}`;
    ui.resetButton.disabled = isDefaultSettings(this.settings) && !this.fenceError;

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

    // Groups visibility.
    for (const [groupId, section] of ui.sections) {
      section.hidden = this._features.groups !== null && !this._features.groups.includes(groupId);
    }

    // Controls.
    for (const view of this.views.values()) this.updateControl(view);

    // Code preview.
    ui.code.hidden = !this._features.showCode;
    const block = generateBlock(this.settings);
    ui.codePre.textContent = block ?? "# (no block: every setting is at its default)";
  }

  private updateControl(view: ControlView): void {
    const { spec, inputs, row, badges, revert } = view;
    const isSet = spec.keys.some((k) => k in this.settings.rc);
    const userOverrides = !this.stale && spec.keys.some((k) => this.overridden.has(k));
    row.classList.toggle("is-set", isSet);
    revert.hidden = !isSet;

    badges.replaceChildren();
    if (spec.category === "save") badges.append(el("span", { class: "badge" }, "applies when saving"));
    if (spec.category === "rerun") badges.append(el("span", { class: "badge rerun" }, "re-run to see"));
    if (userOverrides) badges.append(el("span", { class: "badge user", title: "Your code sets this on the current figure; the default above still applies to anything created afterwards." }, "set in your code"));

    const first = inputs[0];
    if (!first) return;
    const value = spec.type === "style" ? this.settings.style : this.effective(spec.keys[0] ?? "");

    switch (spec.type) {
      case "style": {
        const select = first as HTMLSelectElement;
        const names = this.styles.includes(this.settings.style) ? this.styles : [...this.styles, this.settings.style];
        const current = Array.from(select.options).map((o) => o.value);
        if (current.join("\n") !== names.join("\n")) {
          select.replaceChildren(...names.map((n) => el("option", { value: n }, n === this.settings.style && !this.styles.includes(n) ? `${n} (not available here)` : n)));
        }
        select.value = this.settings.style;
        break;
      }
      case "bool":
        (first as HTMLInputElement).checked = Boolean(value);
        break;
      case "number":
        (first as HTMLInputElement).value = typeof value === "number" ? String(value) : "";
        break;
      case "fontsize": {
        const input = first as HTMLInputElement;
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
        (first as HTMLInputElement).value = typeof value === "number" ? String(value) : "";
        break;
      case "pair": {
        const [w, h] = inputs as HTMLInputElement[];
        if (Array.isArray(value) && value.length === 2 && w && h) {
          w.value = String(value[0]);
          h.value = String(value[1]);
        }
        break;
      }
      case "enum": {
        const select = first as HTMLSelectElement;
        const v = value === undefined ? "" : String(value);
        if (v && !Array.from(select.options).some((o) => o.value === v)) select.append(el("option", { value: v }, `${v} (from style)`));
        select.value = v;
        break;
      }
      case "colorcycle": {
        const select = first as HTMLSelectElement;
        const colors = Array.isArray(value) ? (value as string[]) : [];
        const preset = spec.presets?.find((p) => rcEqual(p.colors, colors));
        select.value = preset ? preset.id : "__custom__";
        view.swatches?.replaceChildren(
          ...colors.slice(0, 10).map((c) => {
            const i = el("i");
            i.style.background = c;
            i.title = c;
            return i;
          }),
        );
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

/** Register the element under `tag` (default "stylefence-panel"). Safe to call twice. */
export function registerPanel(tag: string = ELEMENT_TAG): void {
  if (typeof customElements === "undefined") return;
  if (!customElements.get(tag)) customElements.define(tag, StylefencePanel);
}

registerPanel();

declare global {
  interface HTMLElementTagNameMap {
    "stylefence-panel": StylefencePanel;
  }
}
