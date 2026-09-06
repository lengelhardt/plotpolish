import raw from "./schema/controls.json";

/**
 * axes.prop_cycle with per-line properties. `color` is always present; the
 * optional arrays are zipped with it by matplotlib's cycler, so they must be
 * the same length. A plain `string[]` (colors only) is also accepted for
 * this key.
 */
export interface PropCycleValue {
  color: string[];
  linewidth?: number[];
  linestyle?: string[];
}

/** Value of one rcParam as the panel represents it (JSON-compatible). */
export type RcValue = number | boolean | string | number[] | string[] | PropCycleValue;

export function isPropCycle(v: RcValue | undefined): v is PropCycleValue {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Array.isArray((v as PropCycleValue).color);
}

export type Category = "live" | "save" | "rerun";

export type ControlType =
  | "style"
  | "pair"
  | "dpi"
  | "bool"
  | "enum"
  | "number"
  | "fontsize"
  | "colorcycle"
  | "legendloc"
  | "linecycle"
  /** A button, not a setting: writes no rc key. */
  | "copycode";

/** primary = visible as soon as the category opens; more = under the "More" expander. */
export type Tier = "primary" | "more";

export interface EnumOption {
  value: string;
  label: string;
}

export interface ColorPreset {
  id: string;
  label: string;
  colors: string[];
}

export interface ControlSpec {
  id: string;
  group: string;
  /** Optional sub-heading within the group (see GroupSpec.subgroups). */
  subgroup?: string;
  tier: Tier;
  label: string;
  type: ControlType;
  /** rc keys this control writes. Empty for the style control. */
  keys: string[];
  default: RcValue;
  /** Applied when the block is first created (settings go from empty to non-empty) if the key is unset. */
  panelDefault?: RcValue;
  category: Category;
  help?: string;
  /** bool: values written when on/off, when the key is not a plain boolean
   *  (axes.grid.which is "both"/"major", not true/false). Defaults to true/false. */
  onValue?: RcValue;
  offValue?: RcValue;
  /** linecycle: bounds on the number of per-line rows. */
  minLines?: number;
  maxLines?: number;
  min?: number;
  max?: number;
  step?: number;
  options?: EnumOption[];
  presets?: ColorPreset[];
}

export interface SubgroupSpec {
  id: string;
  label: string;
}

export interface GroupSpec {
  id: string;
  label: string;
  help?: string;
  subgroups?: SubgroupSpec[];
  /** "no-legend": hide this group when the live figure has no legend and no legend key is set. */
  hideWhen?: "no-legend";
}

interface RawSchema {
  groups: GroupSpec[];
  controls: ControlSpec[];
}

const schema = raw as unknown as RawSchema;

export const GROUPS: readonly GroupSpec[] = schema.groups;
export const CONTROLS: readonly ControlSpec[] = schema.controls;

export const CONTROL_BY_ID: ReadonlyMap<string, ControlSpec> = new Map(
  CONTROLS.map((c) => [c.id, c]),
);

/** rc key → the control that owns it. */
export const CONTROL_FOR_KEY: ReadonlyMap<string, ControlSpec> = new Map(
  CONTROLS.flatMap((c) => c.keys.map((k) => [k, c] as [string, ControlSpec])),
);

/** All rc keys the panel knows, in schema order, each once (two controls may share a key). Generated blocks use this order. */
export const RC_KEYS: readonly string[] = [...new Set(CONTROLS.flatMap((c) => c.keys))];

export function categoryOf(key: string): Category | undefined {
  return CONTROL_FOR_KEY.get(key)?.category;
}

export function controlsInGroup(groupId: string, tier?: Tier): ControlSpec[] {
  return CONTROLS.filter((c) => c.group === groupId && (tier === undefined || c.tier === tier));
}

export const GROUP_BY_ID: ReadonlyMap<string, GroupSpec> = new Map(GROUPS.map((g) => [g.id, g]));

/** matplotlib.font_manager.font_scalings */
export const FONT_SCALINGS: Readonly<Record<string, number>> = {
  "xx-small": 0.579,
  "x-small": 0.694,
  small: 0.833,
  medium: 1.0,
  large: 1.2,
  "x-large": 1.44,
  "xx-large": 1.728,
  larger: 1.2,
  smaller: 0.833,
};

export const RELATIVE_SIZES: readonly string[] = [
  "xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large",
];

/** Font size in points; relative names scale `base` the way matplotlib does. */
export function resolveFontSize(value: RcValue, base: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const scale = FONT_SCALINGS[value];
    if (scale !== undefined) return base * scale;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return base;
}

/** Structural equality for RcValues (arrays compared element-wise, numbers with tolerance). */
export function rcEqual(a: RcValue | undefined, b: RcValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (isPropCycle(a) || isPropCycle(b)) {
    const pa = isPropCycle(a) ? a : Array.isArray(a) ? { color: a as string[] } : null;
    const pb = isPropCycle(b) ? b : Array.isArray(b) ? { color: b as string[] } : null;
    if (!pa || !pb) return false;
    return (
      rcEqual(pa.color, pb.color) &&
      rcEqual(pa.linewidth, pb.linewidth) &&
      rcEqual(pa.linestyle, pb.linestyle)
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => rcEqual(v as RcValue, b[i] as RcValue));
  }
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return a === b;
}
