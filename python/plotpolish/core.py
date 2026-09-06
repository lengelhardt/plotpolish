"""plotpolish helper — the matplotlib-facing half of the panel.

Design constraints (see docs/design.md):

* This file is inlined **verbatim** into the JavaScript bundle and executed in
  a throwaway namespace by the host, so it must be a single self-contained
  file: no intra-package imports, no reading of data files, no global state.
* Pure functions, JSON-friendly values in and out. Imports are limited to
  ``matplotlib``, ``json`` and the standard library.
* Nothing here ever touches axis labels, titles, limits, scales or
  annotations. Those belong to the user's code. The one per-series exception
  is ``axes.prop_cycle``: its color/linewidth/linestyle are applied to each
  line through the property cycle (see ``_apply_prop_cycle``), but a line
  whose own value was set explicitly and no longer matches the old cycle is
  left alone under ``only_defaults``.
"""

import json
import math
import traceback

import matplotlib as mpl
from matplotlib import pyplot as plt
from matplotlib import ticker as _ticker
from matplotlib.colors import to_rgba as _to_rgba
from matplotlib.font_manager import font_scalings as _FONT_SCALINGS

__version__ = "0.1.2"

TOOL_NAME = "plotpolish"

# rc keys the panel knows about. Kept in sync with src/schema/controls.json by
# python/tests/test_schema_contract.py.
CURATED_KEYS = (
    "figure.autolayout",
    "savefig.dpi",
    "savefig.transparent",
    "savefig.bbox",
    "font.size",
    "font.family",
    "axes.titlesize",
    "axes.labelsize",
    "xtick.labelsize",
    "ytick.labelsize",
    "legend.fontsize",
    "lines.linewidth",
    "lines.linestyle",
    "lines.marker",
    "lines.markersize",
    "axes.prop_cycle",
    "axes.grid",
    "grid.alpha",
    "grid.linestyle",
    "axes.spines.top",
    "axes.spines.right",
    "axes.linewidth",
    "xtick.direction",
    "ytick.direction",
    "xtick.minor.visible",
    "ytick.minor.visible",
    "legend.frameon",
    "legend.loc",
    "legend.framealpha",
)

# Keys that savefig reads at save time. They have no artist-level equivalent,
# but setting the rcParam is an honest "live" apply for them.
SAVE_KEYS = ("savefig.dpi", "savefig.transparent", "savefig.bbox")

# Keys that only take effect when artists are created: need a host re-run. (None today; the style sheet is handled by set_style.)
RERUN_KEYS = ()

_REL_TOL = 1e-6


# --------------------------------------------------------------------------
# Value conversion between rcParams and JSON
# --------------------------------------------------------------------------

def _plain(value):
    """Turn numpy scalars / tuples into plain JSON-serializable Python."""
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            return value.item()
        except (TypeError, ValueError):
            pass
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def rc_to_json(key, value):
    """Serialize one rcParam value the way the panel expects it.

    ``axes.prop_cycle`` is either a plain list of color strings (legacy,
    colors only — the cycler's only key is ``"color"``) or, once per-line
    width/style are involved, a dict ``{"color": [...], "linewidth": [...],
    "linestyle": [...]}`` with ``linewidth``/``linestyle`` present only when
    the cycler actually carries them.
    """
    if key == "axes.prop_cycle":
        items = list(value)
        keys = set(value.keys)
        if keys == {"color"}:
            return [c["color"] for c in items]
        result = {"color": [c["color"] for c in items]} if "color" in keys else {"color": []}
        if "linewidth" in keys:
            result["linewidth"] = [float(c["linewidth"]) for c in items]
        if "linestyle" in keys:
            result["linestyle"] = [str(c["linestyle"]) for c in items]
        return result
    if key == "font.family":
        if isinstance(value, (list, tuple)):
            return str(value[0]) if value else "sans-serif"
        return str(value)
    if key == "savefig.bbox":
        return "standard" if value is None else str(value)
    if key == "savefig.dpi":
        return "figure" if value == "figure" else float(value)
    if key == "legend.loc":
        if isinstance(value, (list, tuple)):
            return [float(value[0]), float(value[1])]
        return value
    value = _plain(value)
    if isinstance(value, float) and value.is_integer():
        return value  # keep floats as floats; JSON will render 1.0 as 1.0
    return value


def json_to_rc(key, value):
    """Inverse of :func:`rc_to_json`: a value that ``mpl.rcParams[key] = …`` accepts."""
    if key == "axes.prop_cycle":
        if isinstance(value, dict):
            kw = {
                k: ([float(x) for x in v] if k == "linewidth" else list(v))
                for k, v in value.items()
                if k in ("color", "linewidth", "linestyle") and v
            }
            lengths = {k: len(v) for k, v in kw.items()}
            if len(set(lengths.values())) > 1:
                raise ValueError(
                    "axes.prop_cycle: color/linewidth/linestyle must all be the same "
                    "length, got %s" % lengths
                )
            return mpl.cycler(**kw)
        return mpl.cycler(color=list(value))
    if key == "legend.loc" and isinstance(value, (list, tuple)):
        return tuple(float(v) for v in value)
    return value


def resolve_size(value, base=None):
    """Font size in points: numbers pass through, relative names scale ``base``."""
    if base is None:
        base = float(mpl.rcParams["font.size"])
    if isinstance(value, str):
        if value in _FONT_SCALINGS:
            return float(base) * float(_FONT_SCALINGS[value])
        return float(value)  # "12" style strings
    return float(value)


def _close(a, b):
    try:
        return math.isclose(float(a), float(b), rel_tol=_REL_TOL, abs_tol=1e-9)
    except (TypeError, ValueError):
        return a == b


# --------------------------------------------------------------------------
# list_styles
# --------------------------------------------------------------------------

def list_styles():
    """Names accepted by ``mpl.style.use``, ``"default"`` first, internals hidden."""
    names = sorted(
        (s for s in plt.style.available if not s.startswith("_")),
        key=str.lower,
    )
    return ["default"] + names


def set_style(name, keep=None):
    """Reset the session's rcParams to library defaults, then apply style ``name``.

    The fenced block deliberately does **not** call ``mpl.style.use("default")``:
    in a long-lived interpreter that would also wipe rc values the host sets
    before each run (Trinket sets ``figure.autolayout`` and a pane-fitting
    ``figure.figsize``). Instead the panel calls this *between* runs when the
    user changes the style dropdown, so leftovers from a previously applied
    style do not survive into the next run. ``keep`` lists rc keys to
    preserve across the reset, for hosts that set them once at startup
    rather than per run.

    Returns the effective values of the curated keys after the change.
    """
    keep = list(keep or [])
    saved = {k: mpl.rcParams[k] for k in keep if k in mpl.rcParams}
    mpl.style.use("default")
    if name and name != "default":
        mpl.style.use(name)
    mpl.rcParams.update(saved)
    return {k: rc_to_json(k, mpl.rcParams[k]) for k in CURATED_KEYS}


# --------------------------------------------------------------------------
# Figure access and description
# --------------------------------------------------------------------------

def current_figure():
    """The most recently created open figure, or ``None`` — never creates one."""
    nums = plt.get_fignums()
    if not nums:
        return None
    return plt.figure(nums[-1])


def _grid_on(axis):
    try:
        params = axis.get_tick_params(which="major")
        if "gridOn" in params:
            return bool(params["gridOn"])
    except Exception:  # pragma: no cover - very old/odd backends
        pass
    lines = axis.get_gridlines()
    return bool(lines and lines[0].get_visible())


def _gridline(axis):
    lines = axis.get_gridlines()
    return lines[0] if lines else None


def _tick_direction(axis):
    ticks = axis.get_major_ticks(numticks=1)
    if ticks and hasattr(ticks[0], "_tickdir"):
        return ticks[0]._tickdir
    return None


def _minor_visible(axis):
    return not isinstance(axis.get_minor_locator(), _ticker.NullLocator)


def _tick_label_size(axis):
    labels = axis.get_ticklabels()
    if labels:
        return float(labels[0].get_fontsize())
    return None


def _legend_loc_name(legend):
    loc = getattr(legend, "_loc", None)
    if isinstance(loc, int):
        for name, code in legend.codes.items():
            if code == loc:
                return name
    if isinstance(loc, (list, tuple)):
        return [float(loc[0]), float(loc[1])]
    return loc if isinstance(loc, str) else None


def _legend_xy(fig, ax, leg):
    """Lower-left corner of the drawn legend box, in axes fractions, or ``None``."""
    try:
        if hasattr(fig.canvas, "get_renderer"):
            renderer = fig.canvas.get_renderer()
        else:
            fig.canvas.draw()
            renderer = None
        if renderer is None:
            return None
        bb = leg.get_window_extent(renderer)
        x, y = ax.transAxes.inverted().transform((bb.x0, bb.y0))
        return [round(float(x), 3), round(float(y), 3)]
    except Exception:
        return None


def _describe_axes(ax, fig):
    leg = ax.get_legend()
    gx = _gridline(ax.xaxis)
    return {
        "grid": _grid_on(ax.xaxis) or _grid_on(ax.yaxis),
        "grid_alpha": None if gx is None else _plain(gx.get_alpha()),
        "grid_linestyle": None if gx is None else gx.get_linestyle(),
        "spines": {name: bool(sp.get_visible()) for name, sp in ax.spines.items()},
        "axes_linewidth": _plain(next(iter(ax.spines.values())).get_linewidth()) if ax.spines else None,
        "tick_direction": {"x": _tick_direction(ax.xaxis), "y": _tick_direction(ax.yaxis)},
        "minor_ticks": {"x": _minor_visible(ax.xaxis), "y": _minor_visible(ax.yaxis)},
        "title_size": float(ax.title.get_fontsize()),
        "label_size": {"x": float(ax.xaxis.label.get_fontsize()), "y": float(ax.yaxis.label.get_fontsize())},
        "tick_label_size": {"x": _tick_label_size(ax.xaxis), "y": _tick_label_size(ax.yaxis)},
        "n_lines": len(ax.lines),
        "legend": None if leg is None else {
            "frameon": bool(leg.get_frame_on()),
            "framealpha": _plain(leg.get_frame().get_alpha()),
            "loc": _legend_loc_name(leg),
            "fontsize": float(leg.get_texts()[0].get_fontsize()) if leg.get_texts() else None,
            "xy": _legend_xy(fig, ax, leg),
        },
    }


def _describe_figure(fig):
    w, h = fig.get_size_inches()
    return {
        "figsize": [float(w), float(h)],
        "dpi": float(fig.dpi),
        "autolayout": _layout_is_tight(fig),
        "axes": [_describe_axes(ax, fig) for ax in fig.axes],
    }


# --------------------------------------------------------------------------
# Override detection: which rc keys does the figure disagree with?
# --------------------------------------------------------------------------

def _find_overrides(fig, rc):
    """rc keys whose effective value differs from what the live figure shows.

    Heuristic: if the figure's artists do not sit at the current rcParam
    value, the user's code (or a style applied after creation) set them.
    A user who explicitly passes the default value is indistinguishable
    from one who did not; that is documented behavior.
    """
    over = set()
    base = float(mpl.rcParams["font.size"])

    def differs(key, actual, expected=None):
        if key == "axes.prop_cycle":
            return  # per-line values vs. the cycle is apply_live's job, not a badge
        if key not in rc or actual is None:
            return
        exp = rc[key] if expected is None else expected
        if isinstance(exp, bool) or isinstance(actual, bool):
            if bool(actual) != bool(exp):
                over.add(key)
        elif isinstance(exp, (list, tuple)) or isinstance(actual, (list, tuple)):
            if not _close_or_equal(actual, exp):
                over.add(key)
        elif isinstance(exp, (int, float)) and not isinstance(exp, bool):
            if not _close(actual, exp):
                over.add(key)
        elif actual != exp:
            over.add(key)

    def size_differs(key, actual):
        if key in rc and actual is not None:
            differs(key, actual, resolve_size(rc[key], base))

    differs("figure.autolayout", _layout_is_tight(fig))

    for ax in fig.axes:
        differs("axes.grid", _grid_on(ax.xaxis) or _grid_on(ax.yaxis))
        gx = _gridline(ax.xaxis)
        if gx is not None:
            differs("grid.alpha", gx.get_alpha() if gx.get_alpha() is not None else 1.0)
            differs("grid.linestyle", gx.get_linestyle())
        for name in ("top", "right"):
            if name in ax.spines:
                differs("axes.spines." + name, ax.spines[name].get_visible())
        for sp in ax.spines.values():
            differs("axes.linewidth", sp.get_linewidth())
        differs("xtick.direction", _tick_direction(ax.xaxis))
        differs("ytick.direction", _tick_direction(ax.yaxis))
        differs("xtick.minor.visible", _minor_visible(ax.xaxis))
        differs("ytick.minor.visible", _minor_visible(ax.yaxis))
        size_differs("axes.titlesize", ax.title.get_fontsize())
        if ax.title.get_text():
            differs("font.family", _family_name(ax.title.get_fontfamily()))
        size_differs("axes.labelsize", ax.xaxis.label.get_fontsize())
        size_differs("axes.labelsize", ax.yaxis.label.get_fontsize())
        size_differs("xtick.labelsize", _tick_label_size(ax.xaxis))
        size_differs("ytick.labelsize", _tick_label_size(ax.yaxis))
        for line in ax.lines:
            differs("lines.linewidth", line.get_linewidth())
            differs("lines.linestyle", line.get_linestyle())
            differs("lines.marker", str(line.get_marker()))
            differs("lines.markersize", line.get_markersize())
        leg = ax.get_legend()
        if leg is not None:
            differs("legend.frameon", leg.get_frame_on())
            alpha = leg.get_frame().get_alpha()
            if alpha is not None:
                differs("legend.framealpha", alpha)
            loc = _legend_loc_name(leg)
            if loc is not None:
                differs("legend.loc", loc)
            if leg.get_texts():
                size_differs("legend.fontsize", leg.get_texts()[0].get_fontsize())
    return sorted(over)


def introspect_figure(keys=None):
    """Effective rc values, defaults, and what the live figure actually shows.

    Returns a JSON-friendly dict::

        {"matplotlib": "3.8.4",
         "rc": {key: value},          # mpl.rcParams, for the requested keys
         "defaults": {key: value},    # mpl.rcParamsDefault, same keys
         "figure": {...} | None,      # artist-level description, if a figure exists
         "overridden": [key, ...]}    # keys the figure disagrees with

    ``rc`` includes whatever style sheet the user's code applied, but nothing
    records *which* one: that is why the fenced block, not introspection, is
    the panel's source of truth for the style name.
    """
    keys = list(keys) if keys else list(CURATED_KEYS)
    rc = {k: rc_to_json(k, mpl.rcParams[k]) for k in keys if k in mpl.rcParams}
    defaults = {k: rc_to_json(k, mpl.rcParamsDefault[k]) for k in keys if k in mpl.rcParamsDefault}
    result = {
        "matplotlib": mpl.__version__,
        "rc": rc,
        "defaults": defaults,
        "figure": None,
        "overridden": [],
    }
    fig = current_figure()
    if fig is not None:
        result["figure"] = _describe_figure(fig)
        result["overridden"] = _find_overrides(fig, rc)
    return result


# --------------------------------------------------------------------------
# apply_live: artist-level equivalents for live preview
# --------------------------------------------------------------------------

def _set_if_default(getter, setter, old, new, only_defaults):
    """Apply ``setter(new)`` unless the artist was deliberately moved off ``old``."""
    if only_defaults:
        current = getter()
        if current is not None and not _close_or_equal(current, old):
            return False
    setter(new)
    return True


def _close_or_equal(a, b):
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_close_or_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return _close(a, b)
    return a == b


def _layout_state(fig):
    """'tight', 'none' (no engine or the placeholder), or 'other' (constrained, compressed, custom)."""
    engine = fig.get_layout_engine()
    if engine is None:
        return "none"
    name = type(engine).__name__
    if name == "TightLayoutEngine":
        return "tight"
    if name == "PlaceHolderLayoutEngine":
        return "none"
    return "other"


def _layout_is_tight(fig):
    return _layout_state(fig) == "tight"


def _apply_autolayout(fig, new, old, only):
    """figure.autolayout: tight_layout on every draw, via the figure's layout engine.

    A figure the user gave another engine (constrained, compressed) is never
    switched under them when only_defaults is set.
    """
    state = _layout_state(fig)
    if only and (state == "other" or (state == "tight") != bool(old)):
        return
    fig.set_layout_engine("tight" if new else "none")


def _family_name(value):
    """First family name of a font.family value (str or list)."""
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else "sans-serif"
    return str(value)


def _apply_font_family(fig, new, old, only):
    """font.family: set on every Text artist that still uses the old family, and on future tick labels."""
    from matplotlib.text import Text
    old_name = _family_name(old)
    new_name = _family_name(new)
    for text in fig.findobj(Text):
        if only and _family_name(text.get_fontfamily()) != old_name:
            continue
        text.set_family(new_name)
    for ax in fig.axes:
        try:
            ax.tick_params(axis="both", which="both", labelfontfamily=new_name)
        except (AttributeError, TypeError, ValueError):  # pragma: no cover - matplotlib < 3.7
            pass


def _apply_grid(fig, new, old, only):
    for ax in fig.axes:
        current = _grid_on(ax.xaxis) or _grid_on(ax.yaxis)
        if only and current != bool(old):
            continue
        ax.grid(bool(new))


def _apply_grid_kw(kw):
    def apply(fig, new, old, only):
        for ax in fig.axes:
            gx = _gridline(ax.xaxis)
            if only and gx is not None:
                current = gx.get_alpha() if kw == "alpha" else gx.get_linestyle()
                if current is not None and not _close_or_equal(current, old):
                    continue
            # tick_params(grid_*) changes gridline properties without turning
            # the grid on, unlike ax.grid(**kwargs).
            ax.tick_params(axis="both", which="both", **{"grid_" + kw: new})
    return apply


def _apply_spine_visible(name):
    def apply(fig, new, old, only):
        for ax in fig.axes:
            sp = ax.spines.get(name)
            if sp is None:
                continue
            if only and sp.get_visible() != bool(old):
                continue
            sp.set_visible(bool(new))
    return apply


def _apply_axes_linewidth(fig, new, old, only):
    for ax in fig.axes:
        for sp in ax.spines.values():
            if only and not _close(sp.get_linewidth(), old):
                continue
            sp.set_linewidth(float(new))


def _apply_tick_direction(axis_name):
    def apply(fig, new, old, only):
        for ax in fig.axes:
            axis = getattr(ax, axis_name + "axis")
            current = _tick_direction(axis)
            if only and current is not None and current != old:
                continue
            ax.tick_params(axis=axis_name, which="both", direction=str(new))
    return apply


def _apply_minor_visible(axis_name):
    def apply(fig, new, old, only):
        for ax in fig.axes:
            axis = getattr(ax, axis_name + "axis")
            if only and _minor_visible(axis) != bool(old):
                continue
            if bool(new):
                if axis.get_scale() != "linear":
                    continue  # leave log/symlog minor ticks to matplotlib
                axis.set_minor_locator(_ticker.AutoMinorLocator())
            else:
                axis.set_minor_locator(_ticker.NullLocator())
    return apply


def _apply_text_size(texts_of):
    """Handler factory for fontsize keys. ``texts_of(ax)`` yields Text artists."""
    def apply(fig, new, old, only, base_old=None, base_new=None):
        old_pts = resolve_size(old, base_old)
        new_pts = resolve_size(new, base_new)
        for ax in fig.axes:
            for text in texts_of(ax):
                if only and not _close(text.get_fontsize(), old_pts):
                    continue
                text.set_fontsize(new_pts)
    return apply


def _apply_tick_label_size(axis_name):
    def apply(fig, new, old, only, base_old=None, base_new=None):
        old_pts = resolve_size(old, base_old)
        new_pts = resolve_size(new, base_new)
        for ax in fig.axes:
            axis = getattr(ax, axis_name + "axis")
            current = _tick_label_size(axis)
            if only and current is not None and not _close(current, old_pts):
                continue
            ax.tick_params(axis=axis_name, which="both", labelsize=new_pts)
    return apply


def _legend_texts(ax):
    leg = ax.get_legend()
    return leg.get_texts() if leg is not None else []


def _colors_equal(a, b):
    """Color equality that treats equivalent spellings (e.g. case) as equal."""
    try:
        return _to_rgba(a) == _to_rgba(b)
    except (ValueError, TypeError):
        return a == b


# axes.prop_cycle property name -> (getter, setter, caster) on a Line2D.
_PROP_CYCLE_ATTRS = {
    "color": ("get_color", "set_color", str),
    "linewidth": ("get_linewidth", "set_linewidth", float),
    "linestyle": ("get_linestyle", "set_linestyle", str),
}


def _cycle_props(value):
    """Normalize an ``axes.prop_cycle`` JSON value to ``{prop: [values, ...]}``.

    ``value`` may be a plain list of colors (legacy), a dict with "color"
    and optionally "linewidth"/"linestyle", or ``None``/empty. Only keys
    that are actually present with a non-empty list survive.
    """
    if not value:
        return {}
    if isinstance(value, (list, tuple)):
        return {"color": list(value)}
    return {k: list(v) for k, v in value.items() if k in _PROP_CYCLE_ATTRS and v}


def _apply_prop_cycle(fig, new, old, only):
    """Apply per-line color/linewidth/linestyle through the property cycle.

    For each axes and each line at index ``i``, the new value for a
    property comes from ``new``'s list at ``i % len(list)``; the old value
    (what the line would already show if it followed the previous cycle)
    comes the same way from ``old``. When ``old`` carries no entry for a
    property — no old cycle at all, or an old cycle that never mentioned
    linewidth/linestyle — the fallback is ``mpl.rcParams``'s current value
    for linewidth/linestyle, and the line's own current color for color
    (which trivially "matches", so a first per-line color change is never
    blocked by ``only_defaults``).
    """
    new_props = _cycle_props(new)
    if not new_props:
        return
    old_props = _cycle_props(old)

    for ax in fig.axes:
        for i, line in enumerate(ax.lines):
            for prop, new_list in new_props.items():
                getter_name, setter_name, caster = _PROP_CYCLE_ATTRS[prop]
                new_val = new_list[i % len(new_list)]
                old_list = old_props.get(prop)
                if old_list:
                    old_val = old_list[i % len(old_list)]
                elif prop == "color":
                    old_val = line.get_color()
                else:
                    old_val = mpl.rcParams["lines." + prop]
                if only:
                    current = getattr(line, getter_name)()
                    matches = (
                        _colors_equal(current, old_val) if prop == "color"
                        else _close_or_equal(current, old_val)
                    )
                    if not matches:
                        continue
                getattr(line, setter_name)(caster(new_val))


def _apply_line_prop(getter_name, setter_name, caster):
    def apply(fig, new, old, only):
        for ax in fig.axes:
            for line in ax.lines:
                current = getattr(line, getter_name)()
                if only and not _close_or_equal(current, old):
                    continue
                getattr(line, setter_name)(caster(new))
    return apply


def _apply_legend_frameon(fig, new, old, only):
    for ax in fig.axes:
        leg = ax.get_legend()
        if leg is None or (only and leg.get_frame_on() != bool(old)):
            continue
        leg.set_frame_on(bool(new))


def _apply_legend_framealpha(fig, new, old, only):
    for ax in fig.axes:
        leg = ax.get_legend()
        if leg is None:
            continue
        current = leg.get_frame().get_alpha()
        if only and current is not None and not _close(current, old):
            continue
        leg.get_frame().set_alpha(float(new))


def _apply_legend_loc(fig, new, old, only):
    for ax in fig.axes:
        leg = ax.get_legend()
        if leg is None:
            continue
        current = _legend_loc_name(leg)
        if only and current is not None and not _close_or_equal(current, old):
            continue
        if hasattr(leg, "set_loc"):
            if isinstance(new, (list, tuple)):
                leg.set_loc(tuple(float(v) for v in new))
            else:
                leg.set_loc(str(new))
        else:  # pragma: no cover - matplotlib < 3.8
            leg._set_loc(leg.codes[str(new)])


_TEXT_SIZE_HANDLERS = {
    "axes.titlesize": _apply_text_size(lambda ax: [ax.title]),
    "axes.labelsize": _apply_text_size(lambda ax: [ax.xaxis.label, ax.yaxis.label]),
    "xtick.labelsize": _apply_tick_label_size("x"),
    "ytick.labelsize": _apply_tick_label_size("y"),
    "legend.fontsize": _apply_text_size(_legend_texts),
}

_LIVE_HANDLERS = {
    "font.family": _apply_font_family,
    "figure.autolayout": _apply_autolayout,
    "axes.grid": _apply_grid,
    "grid.alpha": _apply_grid_kw("alpha"),
    "grid.linestyle": _apply_grid_kw("linestyle"),
    "axes.spines.top": _apply_spine_visible("top"),
    "axes.spines.right": _apply_spine_visible("right"),
    "axes.linewidth": _apply_axes_linewidth,
    "xtick.direction": _apply_tick_direction("x"),
    "ytick.direction": _apply_tick_direction("y"),
    "xtick.minor.visible": _apply_minor_visible("x"),
    "ytick.minor.visible": _apply_minor_visible("y"),
    "lines.linewidth": _apply_line_prop("get_linewidth", "set_linewidth", float),
    "lines.linestyle": _apply_line_prop("get_linestyle", "set_linestyle", str),
    "lines.marker": _apply_line_prop("get_marker", "set_marker", str),
    "lines.markersize": _apply_line_prop("get_markersize", "set_markersize", float),
    "axes.prop_cycle": _apply_prop_cycle,
    "legend.frameon": _apply_legend_frameon,
    "legend.framealpha": _apply_legend_framealpha,
    "legend.loc": _apply_legend_loc,
}

LIVE_KEYS = ("font.size",) + tuple(_TEXT_SIZE_HANDLERS) + tuple(_LIVE_HANDLERS)


def apply_live(rc, only_defaults=True, previous=None):
    """Apply artist-level equivalents of ``rc`` to the live figure.

    ``rc`` maps rc keys to JSON values (as produced by the panel). For every
    key with an artist-level equivalent the retained figure is updated; for
    save-time keys the rcParam is set; re-run-only keys are reported back as
    deferred. ``mpl.rcParams`` is updated for every applied key so that a
    subsequent call compares against the new baseline. ``legend.loc`` is one
    such key whose JSON value may be either a named location string or an
    ``[x, y]`` axes-fraction pair for a custom position.

    With ``only_defaults=True`` (the default) an artist is only changed if it
    currently sits at the old rc value — a line the user drew with ``lw=3``
    is left alone, which mirrors what a re-run of their code would do.

    ``previous``, if given, is a dict mapping rc keys to the JSON values the
    caller believes the retained figure currently sits at (the panel records
    these from the last ``introspect_figure()['rc']`` plus its own successful
    applies). It exists because ``set_style()`` resets/moves ``mpl.rcParams``
    without touching the retained figure: after a style change,
    ``mpl.rcParams[key]`` no longer describes what the figure's artists were
    drawn against, so comparing against it (the ``only_defaults`` default)
    makes every artist look user-set and live preview silently stops
    applying. Passing ``previous`` lets the caller supply the true "old"
    baseline instead. Keys missing from ``previous`` (or omitted entirely)
    fall back to today's behavior of reading ``mpl.rcParams``.
    """
    fig = current_figure()
    result = {"applied": [], "deferred": [], "unknown": [], "has_figure": fig is not None}
    rc = dict(rc or {})

    def old_value(key):
        if isinstance(previous, dict) and key in previous:
            return previous[key]
        return rc_to_json(key, mpl.rcParams[key])

    # font.size first: relative sizes ("large") resolve against it.
    base_old = float(old_value("font.size"))
    base_new = float(rc["font.size"]) if "font.size" in rc else base_old
    if "font.size" in rc:
        if fig is not None and not _close(base_old, base_new):
            for key, handler in _TEXT_SIZE_HANDLERS.items():
                if key in rc:
                    continue  # explicitly set below
                current = old_value(key)
                if isinstance(current, str):  # relative: follows font.size
                    handler(fig, current, current, only_defaults, base_old=base_old, base_new=base_new)
        mpl.rcParams["font.size"] = base_new
        result["applied"].append("font.size")

    for key, value in rc.items():
        if key == "font.size":
            continue
        if key in _TEXT_SIZE_HANDLERS:
            if fig is not None:
                _TEXT_SIZE_HANDLERS[key](fig, value, old_value(key), only_defaults,
                                         base_old=base_old, base_new=base_new)
            mpl.rcParams[key] = value
            result["applied"].append(key)
        elif key in _LIVE_HANDLERS:
            if fig is not None:
                _LIVE_HANDLERS[key](fig, value, old_value(key), only_defaults)
            mpl.rcParams[key] = json_to_rc(key, value)
            result["applied"].append(key)
        elif key in SAVE_KEYS:
            mpl.rcParams[key] = json_to_rc(key, value)
            result["applied"].append(key)
        elif key in RERUN_KEYS or key not in mpl.rcParams:
            (result["deferred"] if key in RERUN_KEYS else result["unknown"]).append(key)
        else:
            result["unknown"].append(key)

    if fig is not None and result["applied"]:
        try:
            fig.canvas.draw_idle()
        except Exception:  # pragma: no cover - headless canvases without draw_idle
            pass
    return result


# --------------------------------------------------------------------------
# JSON entry point used by the JS side
# --------------------------------------------------------------------------

_DISPATCH = {
    "list_styles": lambda args: list_styles(),
    "set_style": lambda args: set_style(**args),
    "introspect_figure": lambda args: introspect_figure(**args),
    "apply_live": lambda args: apply_live(**args),
}


def dispatch(request_json):
    """``{"fn": name, "args": {...}}`` in, ``{"ok": true, "result": …}`` out (as JSON)."""
    try:
        request = json.loads(request_json)
        fn = _DISPATCH[request["fn"]]
        result = fn(request.get("args") or {})
        return json.dumps({"ok": True, "result": result, "version": __version__})
    except Exception as exc:  # noqa: BLE001 - surfaced to the panel as text
        return json.dumps({
            "ok": False,
            "error": "%s: %s" % (type(exc).__name__, exc),
            "traceback": traceback.format_exc(),
            "version": __version__,
        })
