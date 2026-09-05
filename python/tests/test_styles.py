import matplotlib.pyplot as plt

import matplotlib as mpl

from plotpolish import CURATED_KEYS, list_styles, set_style


def test_default_is_first_and_unique():
    styles = list_styles()
    assert styles[0] == "default"
    assert styles.count("default") == 1


def test_internal_styles_hidden_and_sorted_case_insensitively():
    styles = list_styles()[1:]
    assert all(not s.startswith("_") for s in styles)
    assert styles == sorted(styles, key=str.lower)
    assert "ggplot" in styles and "seaborn-v0_8-whitegrid" in styles


def test_every_listed_style_is_usable():
    for name in list_styles():
        plt.style.use(name)


def test_set_style_resets_leftovers_then_applies():
    plt.style.use("dark_background")
    mpl.rcParams["lines.linewidth"] = 9
    effective = set_style("ggplot")
    assert mpl.rcParams["axes.facecolor"] == "#E5E5E5"  # ggplot
    assert mpl.rcParams["lines.linewidth"] == 1.5  # leftover cleared
    assert set(effective) == set(CURATED_KEYS)
    assert effective["lines.linewidth"] == 1.5


def test_set_style_default_resets_everything_but_keep():
    plt.style.use("dark_background")
    mpl.rcParams["figure.autolayout"] = True
    set_style("default", keep=["figure.autolayout"])
    assert mpl.rcParams["axes.facecolor"] == "white"
    assert mpl.rcParams["figure.autolayout"] is True
    set_style("default")
    assert mpl.rcParams["figure.autolayout"] is False
