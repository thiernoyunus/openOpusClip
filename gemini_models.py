"""Shared Gemini model choices for the UI and backend request boundary."""

import os


DEFAULT_GEMINI_MODEL = "gemini-3.6-flash"
GEMINI_MODELS = (
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
)

# Image generation is a separate Gemini capability; the text model picker
# cannot be used for it because the selected Flash models return text only.
GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image"

# Current Standard paid-tier USD rates per 1M tokens. Free-tier requests can
# still cost $0; these rates are used only for the app's estimate.
GEMINI_PRICING = {
    "gemini-3.7-flash": (0.75, 3.75),
    "gemini-3.6-flash": (0.75, 3.75),
    "gemini-3.5-flash": (1.50, 9.00),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.1-flash-lite": (0.25, 1.50),
}


def get_gemini_model(model_name=None):
    """Return a supported model from an explicit value or the environment."""
    selected = model_name
    if selected is None:
        selected = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)
    selected = str(selected).strip() or DEFAULT_GEMINI_MODEL
    if selected not in GEMINI_MODELS:
        choices = ", ".join(GEMINI_MODELS)
        raise ValueError(f"Unsupported Gemini model '{selected}'. Choose one of: {choices}")
    return selected
