import matplotlib as mpl
import pytest

from stylefence import json_to_rc, rc_to_json, resolve_size


def test_prop_cycle_serialises_to_colour_list():
    cyc = mpl.cycler(color=["#E69F00", "#56B4E9"])
    assert rc_to_json("axes.prop_cycle", cyc) == ["#E69F00", "#56B4E9"]
    back = json_to_rc("axes.prop_cycle", ["#E69F00", "#56B4E9"])
    mpl.rcParams["axes.prop_cycle"] = back
    assert rc_to_json("axes.prop_cycle", mpl.rcParams["axes.prop_cycle"]) == ["#E69F00", "#56B4E9"]


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


def test_figsize_is_plain_floats():
    import numpy as np

    out = rc_to_json("figure.figsize", np.array([6.4, 4.8]))
    assert out == [6.4, 4.8] and all(type(v) is float for v in out)


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
