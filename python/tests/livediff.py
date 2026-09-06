"""Compare two figures: the one live preview touched, and the one a re-run drew.

The comparison is by pixels, and the reference is COMPUTED rather than stored.
Both figures are rendered in this process, by this matplotlib, with these fonts,
so a byte comparison between them is deterministic -- there is no golden image
to keep up to date and no cross-version tolerance to tune. What changes between
matplotlib versions changes for both figures at once.

Pixels say *that* something is wrong; ``describe`` says *what*, by dumping the
artist properties the panel can influence so a failure names the property
instead of a pixel count.
"""

import numpy as np
from matplotlib.colors import to_hex


def _color(value):
    try:
        return to_hex(value, keep_alpha=True)
    except (ValueError, TypeError):
        return repr(value)


def _line(line):
    return {
        "color": _color(line.get_color()),
        "linewidth": round(float(line.get_linewidth()), 6),
        "linestyle": str(line.get_linestyle()),
        "marker": str(line.get_marker()),
        "markersize": round(float(line.get_markersize()), 6),
        "markerfacecolor": _color(line.get_markerfacecolor()),
        "markeredgecolor": _color(line.get_markeredgecolor()),
        "alpha": line.get_alpha(),
        "visible": line.get_visible(),
    }


def _text(text):
    return {
        "size": round(float(text.get_fontsize()), 6),
        "family": list(text.get_fontfamily()),
        "color": _color(text.get_color()),
        "string": text.get_text(),
        "visible": text.get_visible(),
    }


def _grid_line(line):
    return {
        "color": _color(line.get_color()),
        "linestyle": str(line.get_linestyle()),
        "linewidth": round(float(line.get_linewidth()), 6),
        "alpha": line.get_alpha(),
        "visible": line.get_visible(),
    }


_TICK_PARAMS = ("gridOn", "direction", "labelsize", "left", "right", "top", "bottom")


def _axis(axis):
    return {
        "major": {k: axis.get_tick_params(which="major").get(k) for k in _TICK_PARAMS},
        "minor": {k: axis.get_tick_params(which="minor").get(k) for k in _TICK_PARAMS},
        "minor_locator": type(axis.get_minor_locator()).__name__,
        "n_minor_ticks": len(axis.get_minorticklocs()),
        "gridlines": [_grid_line(g) for g in axis.get_gridlines()[:3]],
        "label": _text(axis.label),
        "ticklabels": [_text(t) for t in axis.get_ticklabels()[:3]],
        # The exponent/offset label: it takes its size from font.size, and a
        # live apply used to leave it behind.
        "offset_text": _text(axis.get_offset_text()),
    }


def _legend(legend):
    if legend is None:
        return None
    return {
        "frameon": legend.get_frame_on(),
        "framealpha": legend.get_frame().get_alpha(),
        "facecolor": _color(legend.get_frame().get_facecolor()),
        "edgecolor": _color(legend.get_frame().get_edgecolor()),
        "texts": [_text(t) for t in legend.get_texts()],
        "title": _text(legend.get_title()),
        # The sample lines beside the labels are COPIES of the plotted lines,
        # not the lines themselves, so walking ax.lines misses them entirely.
        "handles": [_line(h) for h in legend.get_lines()],
        "frame_bbox": [round(v, 3) for v in legend.get_frame().get_bbox().bounds],
    }


def _axes(ax):
    return {
        "title": _text(ax.title),
        "facecolor": _color(ax.get_facecolor()),
        "position": [round(v, 6) for v in ax.get_position().bounds],
        "spines": {
            name: {
                "visible": s.get_visible(),
                "linewidth": round(float(s.get_linewidth()), 6),
                "color": _color(s.get_edgecolor()),
            }
            for name, s in ax.spines.items()
        },
        "lines": [_line(line) for line in ax.lines],
        "xaxis": _axis(ax.xaxis),
        "yaxis": _axis(ax.yaxis),
        "legend": _legend(ax.get_legend()),
    }


def describe(fig):
    """Everything about `fig` the panel is able to change."""
    fig.canvas.draw()
    return {
        "figsize": [round(v, 6) for v in fig.get_size_inches()],
        "dpi": round(float(fig.dpi), 6),
        "facecolor": _color(fig.get_facecolor()),
        "layout_engine": type(fig.get_layout_engine()).__name__ if fig.get_layout_engine() else None,
        "axes": [_axes(a) for a in fig.axes],
    }


def pixels(fig):
    fig.canvas.draw()
    return np.asarray(fig.canvas.buffer_rgba()).copy()


def pixel_diff(a, b):
    """(number of differing pixels, a human-readable note)."""
    if a.shape != b.shape:
        return -1, "the two renders are different sizes: %s vs %s" % (a.shape, b.shape)
    mask = np.abs(a.astype(int) - b.astype(int)).sum(axis=2) > 0
    count = int(mask.sum())
    if not count:
        return 0, ""
    ys, xs = np.nonzero(mask)
    return count, "%d of %d pixels differ, within x[%d..%d] y[%d..%d] of a %dx%d image" % (
        count, mask.size, xs.min(), xs.max(), ys.min(), ys.max(), mask.shape[1], mask.shape[0],
    )


def describe_diff(live, rerun, limit=12):
    """Property paths where the two descriptions disagree, most useful first."""
    out = []

    def walk(a, b, path):
        if len(out) >= limit:
            return
        if isinstance(a, dict) and isinstance(b, dict):
            for key in sorted(set(a) | set(b)):
                if key not in a or key not in b:
                    out.append((path + "." + key, a.get(key, "<absent>"), b.get(key, "<absent>")))
                else:
                    walk(a[key], b[key], path + "." + key)
        elif isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                out.append((path + " (length)", len(a), len(b)))
            for i, (x, y) in enumerate(zip(a, b)):
                walk(x, y, "%s[%d]" % (path, i))
        elif isinstance(a, bool) or isinstance(b, bool):
            if a is not b:
                out.append((path, a, b))
        elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
            if abs(float(a) - float(b)) > 1e-6:
                out.append((path, a, b))
        elif a != b:
            out.append((path, a, b))

    walk(live, rerun, "figure")
    return out


def report(case_id, note, live, rerun, pixel_note):
    lines = ["", "%s -- %s" % (case_id, note), "  " + pixel_note]
    diffs = describe_diff(describe(live), describe(rerun))
    if diffs:
        lines.append("  properties that differ (live vs re-run):")
        for path, a, b in diffs:
            lines.append("    %s" % path)
            lines.append("        live   : %r" % (a,))
            lines.append("        re-run : %r" % (b,))
    else:
        lines.append("  no property in the description differs, so whatever moved is")
        lines.append("  something livediff.describe() does not yet look at -- widen it.")
    return "\n".join(lines)
