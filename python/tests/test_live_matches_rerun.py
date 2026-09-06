"""The promise the whole tool rests on: live preview shows what a re-run draws.

Every setting the panel calls ``live`` is applied to the retained figure by
``apply_live``, artist by artist, and the student is told nothing more is
needed. If a re-run of the generated block would draw something else, the panel
has lied -- and it has lied five separate times in this project's history, each
time in a different key, each time found by eye rather than by a test.

So: run the student's program, apply the settings the way the panel does, and
render. Then run the block plus the same program from a clean interpreter, and
render. The two images must be identical. The reference is computed rather than
stored, so there are no golden PNGs to refresh and no cross-version tolerance to
tune (see livediff).

The cases come from src/live-cases.test.ts, which writes them with the REAL
block generator -- a Python transcription of it would be free to drift from what
the panel actually writes. Adding a control to controls.json adds a case here
automatically; that vitest test fails if the committed case file is stale.

Out of scope, deliberately: a style change. The panel marks it "applies on the
next run" and shows the student a re-run badge, so the live figure is *supposed*
to differ until they run. This file is about the settings the panel claims to
have already shown them.
"""

import json
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import pytest

from plotpolish import apply_live, introspect_figure

from livediff import pixel_diff, pixels, report

CASES = json.loads((Path(__file__).parent / "fixtures" / "live-cases.json").read_text())
PROGRAMS = CASES["programs"]
SCHEMA = json.loads((Path(__file__).resolve().parents[2] / "src" / "schema" / "controls.json").read_text())
DEFAULTS = {key: c["default"] for c in SCHEMA["controls"] for key in c["keys"]}

# What Trinket sets through rcParams before every run. The block runs
# mid-program, so both paths start from here.
HOST_RC = {"figure.autolayout": False}

# Divergences with no honest fix, each pinned as narrowly as it can be. Widening
# the comparison to accommodate one of these would hide the next real bug, so
# they are listed by case id instead.
KNOWN_DIVERGENCES = {
    "sweep:font_size": "legend frame metrics",
    "twoaxes:font_size": "legend frame metrics",
    "sweep:legend_fontsize": "legend frame metrics",
    # These two also carry figure.autolayout, so the frame's wrong size drags
    # the axes position with it through the tight-layout engine.
    "combo:everything-basic": "legend frame metrics",
    "combo:everything-colormap": "legend frame metrics",
    "cyclecode:prop_cycle": "student's own prop_cycle",
    "cyclecode:line_cycle": "student's own prop_cycle",
}

# Found by this harness, and not yet decided. When the student's own code sets
# axes.prop_cycle -- `plt.rcParams['axes.prop_cycle'] = cycler(...)` -- it runs
# AFTER the block and wins, so a re-run keeps their colors. Live preview
# repaints the lines with the panel's palette anyway, because the only_defaults
# test compares each line against what the panel last saw the figure at, and
# what it last saw IS the student's cycle. The panel cannot tell "the student
# chose this" from "the default gave this" without comparing the figure against
# its own block, which is what the "set in your code" badge does for other keys.
# Whether the fix is that badge, or not previewing the key at all, is a design
# question; pinned here so the harness stays green and the finding stays visible.
STUDENT_CYCLE_NOTE = (
    "the student's code sets axes.prop_cycle after the block, so a re-run keeps "
    "their colors while live preview repaints with the panel's palette"
)

# A legend's padding, handle length and label spacing are multiples of the font
# size *as it was when the legend was built*, baked into the packed boxes. Growing
# the text artists grows the frame a little; a re-run builds the whole legend at
# the new size and gets a frame half as wide again. Rebuilding it here would mean
# calling ax.legend() afresh and throwing away whatever the student passed to
# their own ax.legend(...) call -- loc, ncol, title, their own fontsize -- so
# there is no honest fix, the same conclusion as the format-string marker case.
# Pinned per case rather than by loosening the comparison, and every text-size
# key also has a "nolegend:" case above where it IS compared strictly.
LEGEND_FRAME_NOTE = (
    "the legend frame's padding and handle length are fixed to the font size the "
    "legend was built at; only a re-run rebuilds them"
)


def fresh():
    plt.close("all")
    mpl.rcdefaults()
    mpl.rcParams.update(HOST_RC)


def run(source):
    exec(compile(source, "<case>", "exec"), {})
    nums = plt.get_fignums()
    assert nums, "the program drew no figure"
    return plt.figure(nums[-1])


def live_figure(case):
    """The figure the student is looking at while they use the panel.

    Mirrors what the panel does: it records what the figure sits at right after
    the run, sends that as ``previous``, and updates its record from each
    successful apply. Clearing a control applies the baseline value back rather
    than deleting anything from the figure.
    """
    fresh()
    fig = run(PROGRAMS[case["program"]])
    previous = introspect_figure()["rc"]

    steps = []
    if case["before"]:
        steps.append(dict(case["before"]["rc"]))
    wanted = dict(case["settings"]["rc"])
    for key in (case["before"] or {"rc": {}})["rc"]:
        wanted.setdefault(key, DEFAULTS[key])  # reverted: back to the baseline
    if case["delta"]:
        # Only the keys that changed reach the interpreter, which is what the
        # panel really sends; the rest are still in the block and still in
        # force on the next run.
        wanted = {key: wanted[key] for key in case["delta"]}
    steps.append(wanted)

    for step in steps:
        if not step:
            continue
        result = apply_live(step, only_defaults=True, previous=previous)
        assert not result["unknown"], (case["id"], "unknown keys", result["unknown"])
        previous = dict(previous)
        for key in result["applied"]:
            previous[key] = step[key]
    return fig


def rerun_figure(case):
    """The figure the student gets the next time they run their program."""
    fresh()
    block = case["block"]
    return run((block + "\n" if block else "") + PROGRAMS[case["program"]])


def unstyled_figure(case):
    fresh()
    return run(PROGRAMS[case["program"]])


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: c["id"])
def test_live_preview_matches_a_rerun(case):
    live = pixels(live_figure(case))
    rerun = pixels(rerun_figure(case))
    count, note = pixel_diff(live, rerun)
    if case["id"] in KNOWN_DIVERGENCES:
        note_for_case = (
            STUDENT_CYCLE_NOTE if case["id"].startswith("cyclecode:") else LEGEND_FRAME_NOTE
        )
        pytest.xfail("%s: %s" % (case["id"], note_for_case))
    if count:
        # Re-render for the description; the arrays above are already consumed.
        pytest.fail(report(case["id"], case["note"], live_figure(case), rerun_figure(case), note))


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: c["id"])
def test_the_case_would_notice_if_nothing_happened(case):
    """A case whose settings draw the same figure as no settings proves nothing.

    This is the trap the rest of the suite kept falling into: markersize with no
    marker set, a grid style with the grid off, a minor grid with no minor
    ticks. Such a case passes the comparison above while exercising nothing.
    """
    if not case["visible"]:
        pytest.skip("%s: these settings are expected to draw nothing on this figure" % case["id"])
    plain = pixels(unstyled_figure(case))
    if case["before"]:
        # A revert case ends where it started on purpose; what has to be
        # non-trivial is the state it reverts FROM.
        moved = pixels(rerun_figure({**case, "block": case["beforeBlock"] or ""}))
        count, _ = pixel_diff(plain, moved)
        assert count, "%s: the state being reverted never changed the figure" % case["id"]
        return
    count, _ = pixel_diff(plain, pixels(rerun_figure(case)))
    assert count, (
        "%s: the block draws exactly what the program draws without it, so this "
        "case would pass even with apply_live doing nothing at all" % case["id"]
    )
