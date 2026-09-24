"""Shared Gemini model choices for the UI and backend request boundary."""

import os
import re
from datetime import date


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

# Standard paid-tier USD rates per 1M tokens. Each entry is an effective-date
# schedule of (input price, output price); Free Tier requests can still cost $0.
GEMINI_PRICING = {
    "gemini-3.7-flash": (
        (date.min, (0.75, 3.75)),
        (date(2027, 1, 1), (1.50, 7.50)),
    ),
    "gemini-3.6-flash": (
        (date.min, (0.75, 3.75)),
        (date(2027, 1, 1), (1.50, 7.50)),
    ),
    "gemini-3.5-flash": ((date.min, (1.50, 9.00)),),
    "gemini-3.5-flash-lite": ((date.min, (0.30, 2.50)),),
    "gemini-3.1-flash-lite": ((date.min, (0.25, 1.50)),),
}


def get_gemini_model(model_name=None):
    """Return a well-formed model id from an explicit value or the environment."""
    selected = model_name
    if selected is None:
        selected = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)
    selected = str(selected).strip() or DEFAULT_GEMINI_MODEL
    # The dashboard lists Google's live models, so any well-formed id is allowed;
    # GEMINI_MODELS is only the recommended/fallback list.
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", selected):
        raise ValueError(f"Unsupported Gemini model '{selected[:60]}'.")
    return selected


def get_gemini_pricing(model_name=None, as_of=None):
    """Return the effective paid-tier input/output rates for a model and date."""
    pricing_date = as_of or date.today()
    schedule = GEMINI_PRICING.get(model_name, GEMINI_PRICING[DEFAULT_GEMINI_MODEL])
    for effective_date, rates in reversed(schedule):
        if pricing_date >= effective_date:
            return rates
    return schedule[0][1]
