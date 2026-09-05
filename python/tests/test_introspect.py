import matplotlib as mpl
import matplotlib.pyplot as plt

from stylefence import CURATED_KEYS, current_figure, introspect_figure


def test_no_figure_does_not_create_one():
    assert current_figure() is None
    result = introspect_figure()
    assert result["figure"] is None
    assert result["overridden"] == []
    assert plt.get_fignums() == []
    assert set(result["rc"]) == set(CURATED_KEYS)
    assert set(result["defaults"]) == set(CURATED_KEYS)
    assert result["matplotlib"] == mpl.__version__


def test_rc_reflects_style_but_defaults_do_not():
    plt.style.use("seaborn-v0_8-whitegrid")
    result = introspect_figure()
    assert result["rc"]["axes.grid"] is True
    assert result["defaults"]["axes.grid"] is False


def test_requested_keys_subset():
    result = introspect_figure(keys=["font.size", "not.a.key"])
    assert list(result["rc"]) == ["font.size"]


def test_untouched_figure_has_no_overrides():
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1], label="a")
    ax.set_title("t")
    ax.legend()
    result = introspect_figure()
    assert result["overridden"] == []
    desc = result["figure"]
    assert desc["figsize"] == [6.4, 4.8]
    assert len(desc["axes"]) == 1
    a = desc["axes"][0]
    assert a["grid"] is False
    assert a["spines"]["top"] is True
    assert a["title_size"] == 12.0  # 'large' at 10pt base
    assert a["legend"]["frameon"] is True
    assert a["legend"]["loc"] == "best"
    assert a["n_lines"] == 1


def test_user_code_overrides_are_detected():
    fig, ax = plt.subplots(figsize=(3, 3))
    ax.plot([0, 1], [0, 1], lw=3, ls="--", label="a")
    ax.grid(True)
    ax.spines["top"].set_visible(False)
    ax.tick_params(axis="x", direction="in")
    ax.set_title("t", fontsize=20)
    ax.minorticks_on()
    ax.legend(frameon=False, loc="upper left")
    over = set(introspect_figure()["overridden"])
    assert {
        "figure.figsize", "lines.linewidth", "lines.linestyle", "axes.grid",
        "axes.spines.top", "xtick.direction", "axes.titlesize",
        "xtick.minor.visible", "ytick.minor.visible", "legend.frameon", "legend.loc",
    } <= over
    assert "axes.spines.right" not in over
    assert "ytick.direction" not in over
    assert "lines.markersize" not in over


def test_style_applied_after_creation_counts_as_override():
    fig, ax = plt.subplots()
    mpl.rcParams["axes.grid"] = True  # rc says grid; figure was made without
    assert "axes.grid" in introspect_figure()["overridden"]


def test_result_is_json_serialisable():
    import json

    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1], label="a")
    ax.legend()
    json.dumps(introspect_figure())
