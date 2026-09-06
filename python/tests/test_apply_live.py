import json

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pytest
from matplotlib import ticker
from matplotlib.colors import to_hex

from plotpolish import LIVE_KEYS, RERUN_KEYS, SAVE_KEYS, apply_live, introspect_figure
from plotpolish.core import (
    _gridline, _grid_on, _layout_is_tight, _legend_loc_name, _minor_grid_on,
    _tick_direction, _tick_label_size,
)


def make_figure():
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1], label="default line")
    ax.plot([0, 1], [1, 0], lw=3, label="user line")
    ax.set_title("Title")
    ax.set_xlabel("x")
    ax.legend()
    return fig, ax


def test_no_figure_still_updates_rcparams():
    result = apply_live({"axes.grid": True, "savefig.dpi": 200})
    assert result["has_figure"] is False
    assert sorted(result["applied"]) == ["axes.grid", "savefig.dpi"]
    assert mpl.rcParams["axes.grid"] is True
    assert mpl.rcParams["savefig.dpi"] == 200


def test_grid_toggle_and_rc_baseline_moves():
    fig, ax = make_figure()
    apply_live({"axes.grid": True})
    assert _grid_on(ax.xaxis) and mpl.rcParams["axes.grid"] is True
    apply_live({"axes.grid": False})
    assert not _grid_on(ax.xaxis)


def test_grid_alpha_does_not_turn_grid_on():
    fig, ax = make_figure()
    apply_live({"grid.alpha": 0.3, "grid.linestyle": ":"})
    assert not _grid_on(ax.xaxis)
    gl = ax.xaxis.get_gridlines()[0]
    assert gl.get_alpha() == pytest.approx(0.3)
    assert gl.get_linestyle() == ":"


def test_lines_only_default_lines_follow():
    fig, ax = make_figure()
    default_line, user_line = ax.lines
    apply_live({"lines.linewidth": 4, "lines.linestyle": "--", "lines.markersize": 9})
    assert default_line.get_linewidth() == 4 and default_line.get_linestyle() == "--"
    assert default_line.get_markersize() == 9
    assert user_line.get_linewidth() == 3  # user's lw=3 wins
    assert user_line.get_linestyle() == "--"  # linestyle was at default, so it follows
    assert mpl.rcParams["lines.linewidth"] == 4


def test_only_defaults_false_touches_everything():
    fig, ax = make_figure()
    apply_live({"lines.linewidth": 4}, only_defaults=False)
    assert all(line.get_linewidth() == 4 for line in ax.lines)


def test_second_change_still_follows_after_first():
    fig, ax = make_figure()
    default_line = ax.lines[0]
    apply_live({"lines.linewidth": 4})
    apply_live({"lines.linewidth": 5})
    assert default_line.get_linewidth() == 5


def test_font_size_cascades_to_relative_sizes():
    fig, ax = make_figure()
    ax.set_ylabel("explicit", fontsize=8)
    apply_live({"font.size": 20})
    assert ax.title.get_fontsize() == pytest.approx(24)  # 'large' = 1.2 x 20
    assert ax.xaxis.label.get_fontsize() == pytest.approx(20)
    assert ax.yaxis.label.get_fontsize() == pytest.approx(8)  # user-set, untouched
    assert ax.xaxis.get_ticklabels()[0].get_fontsize() == pytest.approx(20)
    assert ax.get_legend().get_texts()[0].get_fontsize() == pytest.approx(20)
    assert mpl.rcParams["font.size"] == 20


def test_explicit_relative_title_size_resolves_against_new_base():
    fig, ax = make_figure()
    apply_live({"font.size": 10, "axes.titlesize": "x-large"})
    assert ax.title.get_fontsize() == pytest.approx(14.4)
    assert mpl.rcParams["axes.titlesize"] == "x-large"


def test_numeric_sizes():
    fig, ax = make_figure()
    apply_live({"axes.labelsize": 13, "xtick.labelsize": 7, "legend.fontsize": 11.5})
    assert ax.xaxis.label.get_fontsize() == 13
    assert ax.xaxis.get_ticklabels()[0].get_fontsize() == 7
    assert ax.yaxis.get_ticklabels()[0].get_fontsize() == 10
    assert ax.get_legend().get_texts()[0].get_fontsize() == 11.5


def test_spines_and_axes_linewidth():
    fig, ax = make_figure()
    ax.spines["right"].set_visible(False)  # user did this already
    apply_live({"axes.spines.top": False, "axes.spines.right": True, "axes.linewidth": 2})
    assert not ax.spines["top"].get_visible()
    assert not ax.spines["right"].get_visible()  # user's choice respected
    assert ax.spines["left"].get_linewidth() == 2


def test_tick_direction_and_minor_ticks():
    fig, ax = make_figure()
    apply_live({"xtick.direction": "in", "ytick.direction": "inout",
                "xtick.minor.visible": True, "ytick.minor.visible": True})
    assert _tick_direction(ax.xaxis) == "in"
    assert _tick_direction(ax.yaxis) == "inout"
    assert isinstance(ax.xaxis.get_minor_locator(), ticker.AutoMinorLocator)
    apply_live({"xtick.minor.visible": False})
    assert isinstance(ax.xaxis.get_minor_locator(), ticker.NullLocator)
    assert isinstance(ax.yaxis.get_minor_locator(), ticker.AutoMinorLocator)


def test_minor_ticks_skip_log_axes():
    fig, ax = make_figure()
    ax.set_yscale("log")
    before = ax.yaxis.get_minor_locator()
    apply_live({"ytick.minor.visible": True})
    assert ax.yaxis.get_minor_locator() is before


def test_legend_properties():
    fig, ax = make_figure()
    leg = ax.get_legend()
    apply_live({"legend.frameon": False, "legend.framealpha": 0.5, "legend.loc": "upper left"})
    assert leg.get_frame_on() is False
    assert leg.get_frame().get_alpha() == pytest.approx(0.5)
    assert leg._loc == leg.codes["upper left"]


def test_legend_loc_custom_xy_position():
    fig, ax = make_figure()
    leg = ax.get_legend()
    apply_live({"legend.loc": [0.1, 0.9]})
    assert leg._loc == (0.1, 0.9)
    assert mpl.rcParams["legend.loc"] == (0.1, 0.9)
    apply_live({"legend.loc": "upper left"}, previous={"legend.loc": [0.1, 0.9]})
    assert leg._loc == leg.codes["upper left"]
    assert mpl.rcParams["legend.loc"] == "upper left"


def test_legend_loc_xy_user_placement_not_moved():
    fig, ax = make_figure()
    leg = ax.get_legend()
    leg.set_loc((0.5, 0.5))  # user explicitly placed the legend
    apply_live({"legend.loc": "upper right"}, previous={"legend.loc": "best"})
    assert leg._loc == (0.5, 0.5)  # left alone: it wasn't at "best"


def test_save_keys_set_rcparams_only():
    fig, ax = make_figure()
    result = apply_live({"savefig.bbox": "tight", "savefig.transparent": True, "savefig.dpi": "figure"})
    assert sorted(result["applied"]) == sorted(SAVE_KEYS)
    assert mpl.rcParams["savefig.bbox"] == "tight"
    assert mpl.rcParams["savefig.transparent"] is True


def test_unknown_keys_are_reported_and_nothing_is_deferred_today():
    fig, ax = make_figure()
    result = apply_live({"nope.key": 1})
    assert result["deferred"] == list(RERUN_KEYS) == []
    assert result["unknown"] == ["nope.key"]
    assert result["applied"] == []


def test_font_family_applies_to_existing_text_and_future_ticks():
    fig, ax = make_figure()
    ax.set_ylabel("explicit", family="monospace")
    apply_live({"font.family": "serif"})
    assert ax.title.get_fontfamily() == ["serif"]
    assert ax.xaxis.label.get_fontfamily() == ["serif"]
    assert ax.yaxis.label.get_fontfamily() == ["monospace"]  # user's explicit family wins
    assert ax.xaxis.get_ticklabels()[0].get_fontfamily() == ["serif"]
    assert ax.get_legend().get_texts()[0].get_fontfamily() == ["serif"]
    assert mpl.rcParams["font.family"] == ["serif"]
    apply_live({"font.family": "monospace"}, previous={"font.family": "serif"})
    assert ax.title.get_fontfamily() == ["monospace"]


def test_previous_overrides_rcparams_reference():
    fig, ax = make_figure()
    default_line, user_line = ax.lines
    # Simulate a style change moving the baseline without touching the figure.
    mpl.rcParams["lines.linewidth"] = 1.0
    apply_live({"lines.linewidth": 2}, previous={"lines.linewidth": 1.5})
    assert default_line.get_linewidth() == 2  # was 1.5 (the true old default)
    assert user_line.get_linewidth() == 3  # user's lw=3 still wins
    assert mpl.rcParams["lines.linewidth"] == 2


def test_without_previous_moved_baseline_skips_artists():
    fig, ax = make_figure()
    default_line, user_line = ax.lines
    mpl.rcParams["lines.linewidth"] = 1.0
    apply_live({"lines.linewidth": 2})
    assert default_line.get_linewidth() == 1.5  # untouched: looked "user-set"
    assert user_line.get_linewidth() == 3
    assert mpl.rcParams["lines.linewidth"] == 2


def test_previous_for_grid_after_style_change():
    fig, ax = make_figure()
    ax.grid(True)  # figure created under a grid-on style
    mpl.rcParams["axes.grid"] = False  # baseline moved
    apply_live({"axes.grid": False}, previous={"axes.grid": True})
    assert not _grid_on(ax.xaxis)


def test_previous_font_size_base():
    fig, ax = make_figure()
    mpl.rcParams["font.size"] = 14  # baseline moved after the figure was drawn at 10
    apply_live({"font.size": 20}, previous={"font.size": 10, "axes.titlesize": "large"})
    assert ax.title.get_fontsize() == pytest.approx(24)
    assert ax.xaxis.label.get_fontsize() == pytest.approx(20)


def test_previous_ignores_unknown_keys_and_partial_dicts():
    fig, ax = make_figure()
    default_line = ax.lines[0]
    result = apply_live({"lines.linewidth": 4, "axes.grid": True}, previous={"nope": 1})
    assert sorted(result["applied"]) == ["axes.grid", "lines.linewidth"]
    assert default_line.get_linewidth() == 4
    assert _grid_on(ax.xaxis)


def test_prop_cycle_sets_per_line_color_width_style():
    fig, ax = make_figure()
    default_line, user_line = ax.lines  # default_line: no explicit lw; user_line: lw=3
    result = apply_live({"axes.prop_cycle": {
        "color": ["#E69F00", "#56B4E9"],
        "linewidth": [2, 1],
        "linestyle": ["-", "--"],
    }})
    assert "axes.prop_cycle" in result["applied"]
    assert default_line.get_color() == "#E69F00"
    assert default_line.get_linewidth() == 2
    assert default_line.get_linestyle() == "-"
    assert user_line.get_color() == "#56B4E9"
    assert user_line.get_linestyle() == "--"
    assert user_line.get_linewidth() == 3  # user's lw=3 wins, width left alone
    assert mpl.rcParams["axes.prop_cycle"].by_key()["color"] == ["#E69F00", "#56B4E9"]
    assert mpl.rcParams["axes.prop_cycle"].by_key()["linewidth"] == [2.0, 1.0]


def test_prop_cycle_second_call_changing_only_colors_keeps_widths():
    fig, ax = make_figure()
    default_line, user_line = ax.lines
    apply_live({"axes.prop_cycle": {
        "color": ["#E69F00", "#56B4E9"],
        "linewidth": [2, 1],
        "linestyle": ["-", "--"],
    }})
    apply_live({"axes.prop_cycle": {"color": ["#000000", "#FFFFFF"]}})
    assert default_line.get_color() == "#000000"
    assert user_line.get_color() == "#FFFFFF"
    # widths/styles were absent from the second call's value: untouched
    assert default_line.get_linewidth() == 2
    assert user_line.get_linewidth() == 3
    assert default_line.get_linestyle() == "-"
    assert user_line.get_linestyle() == "--"


def test_prop_cycle_previous_with_dict_old_value():
    fig, ax = make_figure()
    default_line, user_line = ax.lines
    # Simulate a style change moving mpl.rcParams without touching the figure:
    # comparing against rcParams as-is would make every line look user-set.
    mpl.rcParams["axes.prop_cycle"] = mpl.cycler(color=["#111111", "#222222"])
    apply_live(
        {"axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"], "linewidth": [2, 1]}},
        previous={"axes.prop_cycle": {
            "color": ["#1f77b4", "#ff7f0e"],
            "linewidth": [1.5, 1.5],
        }},
    )
    assert default_line.get_color() == "#E69F00"
    assert default_line.get_linewidth() == 2
    assert user_line.get_color() == "#56B4E9"
    assert user_line.get_linewidth() == 3  # still user-set, left alone


def test_cycler_wins_over_the_scalar_master_for_linewidth():
    """The "(all)" master must not undo per-line widths.

    matplotlib gives [8, 8] for a cycler of linewidth=[8, 8] even with
    lines.linewidth=2, so live preview has to agree or it stops matching what a
    re-run of the block would draw. Before this, the master marched over every
    line after the cycler had set them -- and because each applier carries its
    own only_defaults guard it undid some lines and not others, so one curve
    would update and another would sit at the master's value.
    """
    fig, ax = make_figure()
    a, b = ax.lines
    apply_live({"axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"], "linewidth": [8, 8]}},
               only_defaults=False)
    assert [a.get_linewidth(), b.get_linewidth()] == [8, 8]

    result = apply_live(
        {"axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"], "linewidth": [8, 8]},
         "lines.linewidth": 2},
        previous={"axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"], "linewidth": [8, 8]},
                  "lines.linewidth": 8},
    )
    assert [a.get_linewidth(), b.get_linewidth()] == [8, 8]
    # The scalar is still recorded, so a re-run and savefig agree with the panel.
    assert "lines.linewidth" in result["applied"]
    assert mpl.rcParams["lines.linewidth"] == 2.0


def test_cycler_wins_over_the_scalar_master_for_linestyle():
    """The same collision existed for linestyle, with the same asymmetry."""
    fig, ax = make_figure()
    a, b = ax.lines
    apply_live({"axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"], "linestyle": ["--", "-"]}},
               only_defaults=False)
    assert [a.get_linestyle(), b.get_linestyle()] == ["--", "-"]

    apply_live(
        {"axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"], "linestyle": ["--", "-"]},
         "lines.linestyle": ":"},
        previous={"axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"], "linestyle": ["--", "-"]},
                  "lines.linestyle": "-"},
    )
    assert [a.get_linestyle(), b.get_linestyle()] == ["--", "-"]
    assert mpl.rcParams["lines.linestyle"] == ":"


def test_scalar_master_still_applies_when_the_cycler_omits_that_property():
    """The master is only overridden for properties the cycler actually carries."""
    fig, ax = make_figure()
    default_line, _user_line = ax.lines
    apply_live({"lines.linewidth": 5, "axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"]}})
    assert default_line.get_linewidth() == 5

    apply_live({"lines.linestyle": "--", "axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"]}})
    assert default_line.get_linestyle() == "--"


def test_prop_cycle_only_defaults_false_forces_everything():
    fig, ax = make_figure()
    default_line, user_line = ax.lines
    apply_live(
        {"axes.prop_cycle": {"color": ["#E69F00", "#56B4E9"], "linewidth": [2, 1]}},
        only_defaults=False,
    )
    assert default_line.get_linewidth() == 2
    assert user_line.get_linewidth() == 1  # forced even though user set lw=3
    assert default_line.get_color() == "#E69F00"
    assert user_line.get_color() == "#56B4E9"


def test_every_live_key_is_dispatched():
    """Every live key reaches a handler rather than being reported unknown.

    Applying defaults to a default figure only proves the dispatch table has an
    entry per key -- every ``only_defaults`` guard passes trivially and a
    handler that did nothing would look identical. That is what
    test_every_live_key_moves_the_figure, at the foot of this file, is for.
    """
    fig, ax = make_figure()
    defaults = {k: mpl.rcParamsDefault[k] for k in LIVE_KEYS}
    from plotpolish import rc_to_json

    payload = {k: rc_to_json(k, v) for k, v in defaults.items()}
    result = apply_live(payload)
    assert sorted(result["applied"]) == sorted(LIVE_KEYS)
    assert result["deferred"] == [] and result["unknown"] == []


def test_a_scalar_alone_still_yields_to_a_cycle_already_in_force():
    """The panel sends deltas, so the cycle is often not in the payload.

    Drag "Line width (all)" and only lines.linewidth arrives, while the block
    still carries a cycler that beats it on a re-run. only_defaults hides this
    while the cycled widths look nothing like the scalar; it stops hiding it as
    soon as one entry equals the scalar's rc value, and then that line moves
    live and springs back on the next run. Raised by Copilot on PR #14; it took
    the matching-entry arrangement to actually reproduce.
    """
    mpl.rcParams["axes.prop_cycle"] = mpl.cycler(color=["#E69F00", "#56B4E9"], linewidth=[1.5, 5])
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1])
    ax.plot([0, 1], [1, 0])
    assert [l.get_linewidth() for l in ax.lines] == [1.5, 5.0]

    apply_live({"lines.linewidth": 7}, previous={"lines.linewidth": 1.5})

    # A re-run would let the cycler win for both lines, so live must too.
    assert [l.get_linewidth() for l in ax.lines] == [1.5, 5.0]
    assert mpl.rcParams["lines.linewidth"] == 7  # still recorded, for savefig


def test_legend_title_follows_the_base_font_size_not_the_legend_size():
    """rcParams["legend.title_fontsize"] is None, which means "use font.size".

    So a re-run draws the legend's title at font.size while the labels beside it
    follow legend.fontsize. Applying legend.fontsize to the title as well left
    the live figure disagreeing with a re-run by a whole font size. The
    live-vs-re-run harness cannot reach this one: every case that would show it
    also trips the legend-frame divergence pinned there.
    """
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1], label="a")
    leg = ax.legend(title="Runs")
    assert leg.get_title().get_fontsize() == 10

    apply_live({"legend.fontsize": 31.5})
    assert leg.get_texts()[0].get_fontsize() == 31.5
    assert leg.get_title().get_fontsize() == 10, "the title does not follow legend.fontsize"

    apply_live({"font.size": 19.5})
    assert leg.get_title().get_fontsize() == 19.5, "the title does follow font.size"
    assert leg.get_texts()[0].get_fontsize() == 31.5  # still its own size


def test_offset_text_follows_the_tick_label_size():
    """The "1e6" at the end of an axis is sized by the tick-label rcParam, but
    tick_params does not touch it, so it used to stay behind at the old size."""
    fig, ax = plt.subplots()
    ax.plot([0, 1e6], [0, 2.5e6])
    fig.canvas.draw()
    assert ax.xaxis.get_offset_text().get_fontsize() == 10

    apply_live({"xtick.labelsize": 17})
    assert ax.xaxis.get_offset_text().get_fontsize() == 17


def test_legend_samples_follow_the_lines_they_stand_for():
    """A legend's swatches are copies made when the legend was built, so walking
    ax.lines leaves them showing the old style while a re-run shows the new."""
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1], label="follows")
    ax.plot([0, 1], [1, 0], lw=3, label="set by hand")
    leg = ax.legend()

    apply_live({"lines.linewidth": 6, "lines.linestyle": "--"})
    samples = leg.get_lines()
    assert samples[0].get_linewidth() == 6 and samples[0].get_linestyle() == "--"
    # only_defaults left the student's line at 3, so its swatch stays at 3 too.
    assert samples[1].get_linewidth() == 3


def test_autolayout_sets_and_clears_the_tight_layout_engine():
    fig, ax = make_figure()
    assert fig.get_layout_engine() is None or type(fig.get_layout_engine()).__name__ != "TightLayoutEngine"
    apply_live({"figure.autolayout": True})
    assert type(fig.get_layout_engine()).__name__ == "TightLayoutEngine"
    assert mpl.rcParams["figure.autolayout"] is True
    apply_live({"figure.autolayout": False})
    assert type(fig.get_layout_engine()).__name__ != "TightLayoutEngine"


def test_autolayout_respects_a_figure_the_user_laid_out():
    fig = plt.figure(layout="constrained")
    fig.add_subplot().plot([0, 1])
    apply_live({"figure.autolayout": True})  # constrained != rc default False, so treated as user-set
    assert type(fig.get_layout_engine()).__name__ == "ConstrainedLayoutEngine"
    apply_live({"figure.autolayout": True}, only_defaults=False)
    assert type(fig.get_layout_engine()).__name__ == "TightLayoutEngine"


def test_marker_applies_to_default_lines_only():
    fig, ax = make_figure()
    ax.plot([0, 1], [2, 2], marker="s", label="user marker")
    apply_live({"lines.marker": "o"})
    markers = [l.get_marker() for l in ax.lines]
    assert markers[0] == "o" and markers[1] == "o"  # both plotted without a marker
    assert markers[2] == "s"  # user's explicit marker wins
    assert mpl.rcParams["lines.marker"] == "o"
    apply_live({"lines.marker": "None"}, previous={"lines.marker": "o"})
    assert ax.lines[0].get_marker() == "None"


def test_prop_cycle_follows_lines_drawn_from_a_colormap():
    """A figure drawn under ``cycler(color=plt.cm.viridis(...))`` follows a palette change.

    The panel's ``previous`` comes back through JSON as hex strings, which
    round the colormap's floats to 8 bits; an exact comparison would then call
    every line user-set and skip it, while a re-run recolors them all.
    """
    rows = plt.cm.viridis(np.linspace(0, 1, 3))
    mpl.rcParams["axes.prop_cycle"] = mpl.cycler(color=rows)
    fig, ax = plt.subplots()
    lines = [ax.plot([0, 1], [i, i])[0] for i in range(3)]
    previous = json.loads(json.dumps(introspect_figure()["rc"]))  # as the panel records it
    apply_live({"axes.prop_cycle": ["#E69F00", "#56B4E9", "#009E73"]}, previous=previous)
    assert [line.get_color() for line in lines] == ["#E69F00", "#56B4E9", "#009E73"]


def test_colors_equal_tolerates_hex_rounding_but_not_a_different_color():
    from plotpolish.core import _colors_equal

    row = plt.cm.viridis(0.0)
    assert _colors_equal(row, to_hex(row))
    assert not _colors_equal("#000000", "#010101")


# --- grid vs. a re-run --------------------------------------------------------
#
# The panel's promise is that live preview shows what a re-run of the block
# would draw, so these compare the live figure against a fresh figure drawn by
# the same plotting code under the rcParams apply_live just set.

MINOR_TICKS = {"xtick.minor.visible": True, "ytick.minor.visible": True}


def figure_under(rc):
    mpl.rcParams.update(rc)
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1])
    return fig


def grid_counts(fig):
    """(major, minor) grid lines the figure actually draws."""
    fig.canvas.draw()
    major = minor = 0
    for ax in fig.axes:
        for axis in (ax.xaxis, ax.yaxis):
            major += sum(1 for t in axis.get_major_ticks() if t.gridline.get_visible())
            minor += sum(1 for t in axis.get_minor_ticks() if t.gridline.get_visible())
    return major, minor


def rerun_grid_counts():
    """What re-running the same plotting code draws under the current rcParams."""
    fig = figure_under({})
    try:
        return grid_counts(fig)
    finally:
        plt.close(fig)


def test_minor_grid_needs_the_grid_on_to_match_a_rerun():
    fig = figure_under(MINOR_TICKS)  # axes.grid is False
    apply_live({"axes.grid.which": "both"})
    live = grid_counts(fig)
    assert live == rerun_grid_counts()
    assert live == (0, 0)  # no grid at all: axes.grid is off


def test_turning_the_grid_off_removes_minor_grid_lines_too():
    fig = figure_under({**MINOR_TICKS, "axes.grid": True, "axes.grid.which": "both"})
    assert grid_counts(fig)[1] > 0
    apply_live({"axes.grid": False})
    assert grid_counts(fig) == rerun_grid_counts() == (0, 0)


def test_turning_the_grid_on_draws_the_minor_grid_the_rc_asks_for():
    fig = figure_under({**MINOR_TICKS, "axes.grid.which": "both"})
    apply_live({"axes.grid": True})
    live = grid_counts(fig)
    assert live == rerun_grid_counts()
    assert live[0] > 0 and live[1] > 0


def test_minor_grid_toggles_while_the_grid_is_on():
    fig = figure_under({**MINOR_TICKS, "axes.grid": True})
    apply_live({"axes.grid.which": "both"})
    assert grid_counts(fig) == rerun_grid_counts()
    assert grid_counts(fig)[1] > 0
    apply_live({"axes.grid.which": "major"})
    assert grid_counts(fig) == rerun_grid_counts()
    assert grid_counts(fig)[1] == 0


@pytest.mark.parametrize("payload", [
    {"axes.grid": True, "axes.grid.which": "both"},
    {"axes.grid.which": "both", "axes.grid": True},
], ids=["grid-first", "which-first"])
def test_grid_and_minor_grid_in_one_call_agree_with_a_rerun(payload):
    fig = figure_under(MINOR_TICKS)
    apply_live(payload)
    live = grid_counts(fig)
    assert live == rerun_grid_counts()
    assert live[1] > 0


def test_minor_grid_set_in_code_is_left_alone():
    """``ax.grid(True, which="both")`` in the user's code survives a re-run, so live keeps it."""
    fig = figure_under(MINOR_TICKS)
    fig.axes[0].grid(True, which="both")
    before = grid_counts(fig)
    assert before[1] > 0
    apply_live({"axes.grid.which": "major"})  # the panel's "off" value
    assert grid_counts(fig) == before


@pytest.mark.xfail(strict=True, reason=(
    "plot(x, y, 'r--') pins marker='None' on the Line2D at creation, so lines.marker never "
    "reaches it on a re-run -- but the artist is indistinguishable from one that merely follows "
    "the rcParam default (identical MarkerStyle, no record of the fmt string), so live preview "
    "adds a marker that a re-run would not. Known limitation; see the session report."))
def test_marker_does_not_reach_a_line_drawn_with_a_format_string():
    fig, ax = plt.subplots()
    (fmt_line,) = ax.plot([0, 1], [0, 1], "r--")
    (kw_line,) = ax.plot([0, 1], [1, 0], color="r", ls="--")
    apply_live({"lines.marker": "o"})
    assert kw_line.get_marker() == "o"  # a re-run gives this line a marker...
    assert fmt_line.get_marker() == "None"  # ...but never this one


# --------------------------------------------------------------------------
# Every live key really moves the figure
# --------------------------------------------------------------------------
#
# One case per LIVE key: a value that is genuinely NOT the rc default, and a
# probe that reads the resulting state back off the artists. The test asserts
# the probe reads something else BEFORE the call, so a value that quietly
# equals the default fails here instead of passing vacuously; and it asserts
# the exact expected state after, so a handler that becomes a no-op fails.
#
# Each case sends ONE key per apply_live() call. That is deliberate: with
# "axes.prop_cycle" in the same payload, apply_live's ``cycled`` set stops
# "lines.linewidth"/"lines.linestyle" from walking the artists at all (see
# ``_CYCLE_MASTERS``), so a combined payload would silently excuse those two
# handlers from doing anything.

def _grid_setup(fig, ax):
    """axes.grid.which only draws a minor grid where a major grid already is."""
    ax.grid(True, which="major")


# key -> {value, probe, expected, setup?}
LIVE_KEY_CASES = {
    # font.size cascades into every text still at a relative size.
    "font.size": {
        "value": 20,
        "probe": lambda fig, ax: ax.title.get_fontsize(),  # 'large' = 1.2 x base
        "expected": 24.0,
    },
    "axes.titlesize": {
        "value": 22,
        "probe": lambda fig, ax: ax.title.get_fontsize(),
        "expected": 22.0,
    },
    "axes.labelsize": {
        "value": 17,
        "probe": lambda fig, ax: ax.xaxis.label.get_fontsize(),
        "expected": 17.0,
    },
    "xtick.labelsize": {
        "value": 7,
        "probe": lambda fig, ax: _tick_label_size(ax.xaxis),
        "expected": 7.0,
    },
    "ytick.labelsize": {
        "value": 7,
        "probe": lambda fig, ax: _tick_label_size(ax.yaxis),
        "expected": 7.0,
    },
    "legend.fontsize": {
        "value": 15,
        "probe": lambda fig, ax: ax.get_legend().get_texts()[0].get_fontsize(),
        "expected": 15.0,
    },
    "font.family": {
        "value": "serif",
        "probe": lambda fig, ax: list(ax.title.get_fontfamily()),
        "expected": ["serif"],
    },
    "figure.autolayout": {
        "value": True,
        "probe": lambda fig, ax: _layout_is_tight(fig),
        "expected": True,
    },
    "axes.grid": {
        "value": True,
        "probe": lambda fig, ax: _grid_on(ax.xaxis),
        "expected": True,
    },
    "axes.grid.which": {
        "setup": _grid_setup,
        "value": "both",
        "probe": lambda fig, ax: _minor_grid_on(ax.xaxis),
        "expected": True,
    },
    "grid.alpha": {
        "value": 0.25,
        "probe": lambda fig, ax: _gridline(ax.xaxis).get_alpha(),
        "expected": 0.25,
    },
    "grid.linestyle": {
        "value": ":",
        "probe": lambda fig, ax: _gridline(ax.xaxis).get_linestyle(),
        "expected": ":",
    },
    "axes.spines.top": {
        "value": False,
        "probe": lambda fig, ax: ax.spines["top"].get_visible(),
        "expected": False,
    },
    "axes.spines.right": {
        "value": False,
        "probe": lambda fig, ax: ax.spines["right"].get_visible(),
        "expected": False,
    },
    "axes.linewidth": {
        "value": 2.5,
        "probe": lambda fig, ax: ax.spines["left"].get_linewidth(),
        "expected": 2.5,
    },
    "xtick.direction": {
        "value": "in",
        "probe": lambda fig, ax: _tick_direction(ax.xaxis),
        "expected": "in",
    },
    "ytick.direction": {
        "value": "in",
        "probe": lambda fig, ax: _tick_direction(ax.yaxis),
        "expected": "in",
    },
    "xtick.minor.visible": {
        "value": True,
        "probe": lambda fig, ax: type(ax.xaxis.get_minor_locator()).__name__,
        "expected": "AutoMinorLocator",
    },
    "ytick.minor.visible": {
        "value": True,
        "probe": lambda fig, ax: type(ax.yaxis.get_minor_locator()).__name__,
        "expected": "AutoMinorLocator",
    },
    "lines.linewidth": {
        "value": 4,
        "probe": lambda fig, ax: ax.lines[0].get_linewidth(),
        "expected": 4.0,
    },
    "lines.linestyle": {
        "value": "--",
        "probe": lambda fig, ax: ax.lines[0].get_linestyle(),
        "expected": "--",
    },
    "lines.marker": {
        "value": "o",
        "probe": lambda fig, ax: ax.lines[0].get_marker(),
        "expected": "o",
    },
    "lines.markersize": {
        "value": 9,
        "probe": lambda fig, ax: ax.lines[0].get_markersize(),
        "expected": 9.0,
    },
    # The cycler carries all three properties it can, and each must land.
    "axes.prop_cycle": {
        "value": {"color": ["#E69F00", "#56B4E9"], "linewidth": [2.5, 4.0],
                  "linestyle": ["--", ":"]},
        "probe": lambda fig, ax: [ax.lines[0].get_color(),
                                  ax.lines[0].get_linewidth(),
                                  ax.lines[0].get_linestyle(),
                                  ax.lines[1].get_color()],
        "expected": ["#E69F00", 2.5, "--", "#56B4E9"],
    },
    "legend.frameon": {
        "value": False,
        "probe": lambda fig, ax: ax.get_legend().get_frame_on(),
        "expected": False,
    },
    "legend.framealpha": {
        "value": 0.25,
        "probe": lambda fig, ax: ax.get_legend().get_frame().get_alpha(),
        "expected": 0.25,
    },
    "legend.loc": {
        "value": "lower left",
        "probe": lambda fig, ax: _legend_loc_name(ax.get_legend()),
        "expected": "lower left",
    },
}


def _probe_matches(actual, expected):
    """Compare probe readings, tolerating float representation."""
    if isinstance(actual, list) and isinstance(expected, list):
        return len(actual) == len(expected) and all(
            _probe_matches(a, e) for a, e in zip(actual, expected)
        )
    if isinstance(expected, float) and isinstance(actual, (int, float)):
        return actual == pytest.approx(expected)
    return actual == expected


def test_every_live_key_has_a_case():
    """A new live key must arrive with a case below, or this test names it."""
    assert sorted(LIVE_KEY_CASES) == sorted(LIVE_KEYS)


@pytest.mark.parametrize("key", LIVE_KEYS)
def test_every_live_key_moves_the_figure(key):
    case = LIVE_KEY_CASES[key]
    fig, ax = make_figure()
    if "setup" in case:
        case["setup"](fig, ax)

    before = case["probe"](fig, ax)
    expected = case["expected"]
    assert before != expected, (
        "%s: the test value is not distinguishable from the figure's starting "
        "state, so this case would pass even with no handler at all" % key
    )

    result = apply_live({key: case["value"]})

    assert result["applied"] == [key]
    assert result["deferred"] == [] and result["unknown"] == []
    after = case["probe"](fig, ax)
    assert _probe_matches(after, expected), (
        "%s: apply_live() left the figure at %r, expected %r" % (key, after, expected)
    )
