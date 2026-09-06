import json

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pytest
from matplotlib.colors import to_hex, to_rgba

from plotpolish import json_to_rc, rc_to_json, resolve_size


def test_prop_cycle_serializes_to_color_list():
    cyc = mpl.cycler(color=["#E69F00", "#56B4E9"])
    assert rc_to_json("axes.prop_cycle", cyc) == ["#E69F00", "#56B4E9"]
    back = json_to_rc("axes.prop_cycle", ["#E69F00", "#56B4E9"])
    mpl.rcParams["axes.prop_cycle"] = back
    assert rc_to_json("axes.prop_cycle", mpl.rcParams["axes.prop_cycle"]) == ["#E69F00", "#56B4E9"]


def test_prop_cycle_dict_form_round_trip():
    value = {
        "color": ["#E69F00", "#56B4E9"],
        "linewidth": [2, 1],
        "linestyle": ["-", "--"],
    }
    cyc = json_to_rc("axes.prop_cycle", value)
    assert rc_to_json("axes.prop_cycle", cyc) == {
        "color": ["#E69F00", "#56B4E9"],
        "linewidth": [2.0, 1.0],
        "linestyle": ["-", "--"],
    }
    mpl.rcParams["axes.prop_cycle"] = cyc
    assert rc_to_json("axes.prop_cycle", mpl.rcParams["axes.prop_cycle"]) == {
        "color": ["#E69F00", "#56B4E9"],
        "linewidth": [2.0, 1.0],
        "linestyle": ["-", "--"],
    }


def test_prop_cycle_dict_form_optional_keys_omitted_when_absent():
    cyc = mpl.cycler(color=["#E69F00", "#56B4E9"], linewidth=[2, 1])
    assert rc_to_json("axes.prop_cycle", cyc) == {
        "color": ["#E69F00", "#56B4E9"],
        "linewidth": [2.0, 1.0],
    }


def test_prop_cycle_from_a_colormap_serializes_to_hex():
    """``cycler(color=plt.cm.viridis(np.linspace(0, 1, 4)))`` is an ordinary idiom.

    Its colors are numpy rows, which json.dumps refuses; they must come out
    as hex strings that still name the colors a re-run would draw.
    """
    rows = plt.cm.viridis(np.linspace(0, 1, 4))
    mpl.rcParams["axes.prop_cycle"] = mpl.cycler(color=rows)
    out = rc_to_json("axes.prop_cycle", mpl.rcParams["axes.prop_cycle"])
    json.dumps(out)
    assert out == [to_hex(r) for r in rows]
    assert all(isinstance(c, str) and len(c) == 7 for c in out)
    for got, row in zip(out, rows):
        assert to_rgba(got) == pytest.approx(tuple(row), abs=0.5 / 255)


def test_prop_cycle_dict_form_from_a_colormap_serializes_to_hex():
    rows = plt.cm.viridis(np.linspace(0, 1, 3))
    cyc = mpl.cycler(color=rows) + mpl.cycler(linewidth=np.array([1.0, 2.0, 3.0]))
    out = rc_to_json("axes.prop_cycle", cyc)
    json.dumps(out)
    assert out == {"color": [to_hex(r) for r in rows], "linewidth": [1.0, 2.0, 3.0]}


def test_prop_cycle_tuple_colors_serialize_to_hex_keeping_a_non_opaque_alpha():
    cyc = mpl.cycler(color=[(1, 0, 0), (0, 0, 1, 0.5)])
    out = rc_to_json("axes.prop_cycle", cyc)
    assert out == ["#ff0000", "#0000ff80"]
    mpl.rcParams["axes.prop_cycle"] = json_to_rc("axes.prop_cycle", out)  # matplotlib takes it back
    assert rc_to_json("axes.prop_cycle", mpl.rcParams["axes.prop_cycle"]) == out


def test_prop_cycle_string_colors_are_kept_verbatim():
    cyc = mpl.cycler(color=["red", "#E69F00", "0.5"])
    assert rc_to_json("axes.prop_cycle", cyc) == ["red", "#E69F00", "0.5"]


def test_plain_turns_numpy_arrays_into_lists():
    from plotpolish.core import _plain

    assert _plain(np.array([1.0, 2.0])) == [1.0, 2.0]
    assert _plain(np.array([1.0])) == [1.0]
    assert _plain(np.float64(1.5)) == 1.5
    assert json.dumps(_plain((np.float32(1), np.array([2, 3])))) == "[1.0, [2, 3]]"


def test_prop_cycle_mismatched_lengths_raise_value_error():
    with pytest.raises(ValueError):
        json_to_rc("axes.prop_cycle", {
            "color": ["#E69F00", "#56B4E9"],
            "linewidth": [2],
        })


def test_font_family_list_becomes_first_entry():
    assert rc_to_json("font.family", ["serif", "DejaVu Serif"]) == "serif"
    assert rc_to_json("font.family", "monospace") == "monospace"


def test_savefig_bbox_none_is_standard():
    assert rc_to_json("savefig.bbox", None) == "standard"
    assert rc_to_json("savefig.bbox", "tight") == "tight"
    mpl.rcParams["savefig.bbox"] = json_to_rc("savefig.bbox", "standard")
    assert mpl.rcParams["savefig.bbox"] is None


def test_savefig_dpi_figure_or_number():
    assert rc_to_json("savefig.dpi", "figure") == "figure"
    assert rc_to_json("savefig.dpi", 300.0) == 300.0


def test_legend_loc_xy_round_trip():
    assert rc_to_json("legend.loc", (0.6, 0.2)) == [0.6, 0.2]
    assert rc_to_json("legend.loc", "upper left") == "upper left"
    back = json_to_rc("legend.loc", [0.6, 0.2])
    assert back == (0.6, 0.2)
    assert json_to_rc("legend.loc", "upper left") == "upper left"
    mpl.rcParams["legend.loc"] = back
    assert mpl.rcParams["legend.loc"] == (0.6, 0.2)
    assert rc_to_json("legend.loc", mpl.rcParams["legend.loc"]) == [0.6, 0.2]


@pytest.mark.parametrize("value,base,expected", [
    (12, None, 12.0),
    ("12", None, 12.0),
    ("medium", 10, 10.0),
    ("large", 10, 12.0),
    ("x-large", 10, 14.4),
    ("small", 20, 16.66),
])
def test_resolve_size(value, base, expected):
    assert resolve_size(value, base) == pytest.approx(expected)
