import matplotlib as mpl
import matplotlib.pyplot as plt
import pytest
from matplotlib import ticker

from plotpolish import LIVE_KEYS, RERUN_KEYS, SAVE_KEYS, apply_live
from plotpolish.core import _grid_on, _tick_direction


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


def test_figsize_respects_user_figure_size():
    fig, ax = make_figure()
    apply_live({"figure.figsize": [8, 5]})
    assert list(fig.get_size_inches()) == [8, 5]
    fig2 = plt.figure(figsize=(3, 3))
    apply_live({"figure.figsize": [9, 9]})
    assert list(fig2.get_size_inches()) == [3, 3]
    apply_live({"figure.figsize": [9, 9]}, only_defaults=False)
    assert list(fig2.get_size_inches()) == [9, 9]


def test_save_keys_set_rcparams_only():
    fig, ax = make_figure()
    result = apply_live({"savefig.bbox": "tight", "savefig.transparent": True, "savefig.dpi": "figure"})
    assert sorted(result["applied"]) == sorted(SAVE_KEYS)
    assert mpl.rcParams["savefig.bbox"] == "tight"
    assert mpl.rcParams["savefig.transparent"] is True


def test_rerun_keys_are_deferred_and_untouched():
    fig, ax = make_figure()
    before = mpl.rcParams["font.family"]
    result = apply_live({"font.family": "serif", "nope.key": 1})
    assert sorted(result["deferred"]) == sorted(RERUN_KEYS)
    assert result["unknown"] == ["nope.key"]
    assert result["applied"] == []
    assert mpl.rcParams["font.family"] == before


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


def test_every_live_key_has_a_path():
    fig, ax = make_figure()
    defaults = {k: mpl.rcParamsDefault[k] for k in LIVE_KEYS}
    from plotpolish import rc_to_json

    payload = {k: rc_to_json(k, v) for k, v in defaults.items()}
    result = apply_live(payload)
    assert sorted(result["applied"]) == sorted(LIVE_KEYS)
    assert result["deferred"] == [] and result["unknown"] == []
