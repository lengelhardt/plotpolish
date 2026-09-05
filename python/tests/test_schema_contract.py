"""controls.json (owned by the TypeScript side) must agree with the Python tables."""

import json
import math
from pathlib import Path

import matplotlib as mpl
import pytest

from stylefence import CURATED_KEYS, LIVE_KEYS, RERUN_KEYS, SAVE_KEYS, rc_to_json

SCHEMA = json.loads((Path(__file__).resolve().parents[2] / "src" / "schema" / "controls.json").read_text())
CONTROLS = [c for c in SCHEMA["controls"] if c["type"] != "style"]
BY_CATEGORY = {cat: {k for c in CONTROLS if c["category"] == cat for k in c["keys"]} for cat in ("live", "save", "rerun")}


def test_all_schema_keys_exist_in_this_matplotlib():
    for control in CONTROLS:
        for key in control["keys"]:
            assert key in mpl.rcParams, key


def test_schema_keys_match_curated_keys():
    schema_keys = {k for c in CONTROLS for k in c["keys"]}
    assert schema_keys == set(CURATED_KEYS)


def test_categories_match_python_tables():
    assert BY_CATEGORY["live"] == set(LIVE_KEYS)
    assert BY_CATEGORY["save"] == set(SAVE_KEYS)
    assert BY_CATEGORY["rerun"] == set(RERUN_KEYS)


@pytest.mark.parametrize("control", CONTROLS, ids=lambda c: c["id"])
def test_schema_defaults_are_matplotlib_defaults(control):
    for key in control["keys"]:
        actual = rc_to_json(key, mpl.rcParamsDefault[key])
        expected = control["default"]
        if isinstance(expected, list) and isinstance(expected[0], (int, float)):
            assert all(math.isclose(a, e) for a, e in zip(actual, expected)), key
        elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
            assert math.isclose(actual, expected), key
        else:
            assert actual == expected, key


@pytest.mark.parametrize("control", [c for c in CONTROLS if c["type"] == "enum"], ids=lambda c: c["id"])
def test_enum_options_are_accepted_by_matplotlib(control):
    for option in control["options"]:
        for key in control["keys"]:
            mpl.rcParams[key] = option["value"]


def test_colour_presets_are_valid_colours():
    from matplotlib.colors import to_hex

    (control,) = [c for c in CONTROLS if c["type"] == "colorcycle"]
    for preset in control["presets"]:
        assert len(preset["colors"]) >= 7
        assert all(to_hex(c) for c in preset["colors"])
    assert control["default"] == control["presets"][0]["colors"]
    assert control["default"] == rc_to_json("axes.prop_cycle", mpl.rcParamsDefault["axes.prop_cycle"])
