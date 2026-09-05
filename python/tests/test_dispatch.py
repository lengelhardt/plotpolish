import json

import matplotlib.pyplot as plt

from plotpolish import __version__, dispatch


def call(fn, **args):
    return json.loads(dispatch(json.dumps({"fn": fn, "args": args})))


def test_list_styles_roundtrip():
    out = call("list_styles")
    assert out["ok"] is True and out["result"][0] == "default"
    assert out["version"] == __version__


def test_introspect_and_apply_through_dispatch():
    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1])
    out = call("apply_live", rc={"axes.grid": True})
    assert out["ok"] and out["result"]["applied"] == ["axes.grid"]
    out = call("introspect_figure", keys=["axes.grid"])
    assert out["ok"] and out["result"]["rc"] == {"axes.grid": True}


def test_errors_are_returned_not_raised():
    out = call("no_such_function")
    assert out["ok"] is False
    assert "KeyError" in out["error"]
    assert "traceback" in out
    out = json.loads(dispatch("not json"))
    assert out["ok"] is False


def test_dispatch_never_creates_a_figure():
    call("introspect_figure")
    call("apply_live", rc={"font.size": 11})
    assert plt.get_fignums() == []


def test_set_style_through_dispatch():
    out = call("set_style", name="ggplot", keep=["figure.autolayout"])
    assert out["ok"] and out["result"]["axes.grid"] is True
