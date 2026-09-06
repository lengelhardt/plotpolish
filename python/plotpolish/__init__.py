"""plotpolish — matplotlib-facing helper for the plotpolish panel.

Everything lives in :mod:`plotpolish.core`, which is a single file so the JS
bundle can inline it verbatim. This package exists so pytest can import it.
"""

from .core import (  # noqa: F401
    CURATED_KEYS,
    LIVE_KEYS,
    RERUN_KEYS,
    SAVE_KEYS,
    TOOL_NAME,
    __version__,
    apply_live,
    current_figure,
    dispatch,
    introspect_figure,
    json_to_rc,
    list_styles,
    rc_to_json,
    resolve_size,
    set_style,
    style_previews,
)

__all__ = [
    "CURATED_KEYS", "LIVE_KEYS", "RERUN_KEYS", "SAVE_KEYS", "TOOL_NAME", "__version__",
    "apply_live", "current_figure", "dispatch", "introspect_figure", "json_to_rc",
    "list_styles", "rc_to_json", "resolve_size", "set_style", "style_previews",
]
