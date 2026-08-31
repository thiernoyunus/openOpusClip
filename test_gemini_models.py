"""Small self-check for the shared Gemini model allowlist, defaults, and rates."""

from datetime import date

from gemini_models import DEFAULT_GEMINI_MODEL, GEMINI_MODELS, get_gemini_model, get_gemini_pricing


def test_default_is_supported():
    """The default model remains present in the supported model list."""
    assert DEFAULT_GEMINI_MODEL in GEMINI_MODELS
    assert get_gemini_model() == DEFAULT_GEMINI_MODEL


def test_invalid_model_is_rejected():
    """Retired model names fail validation instead of reaching the API."""
    try:
        get_gemini_model("gemini-2.5-flash")
    except ValueError as error:
        assert "Unsupported Gemini model" in str(error)
    else:
        raise AssertionError("an unsupported Gemini model should be rejected")


def test_introductory_pricing_changes_on_boundary():
    """Gemini 3.6 pricing changes exactly on January 1, 2027."""
    for model in ("gemini-3.6-flash", "gemini-3.7-flash"):
        assert get_gemini_pricing(model, date(2026, 12, 31)) == (0.75, 3.75)
        assert get_gemini_pricing(model, date(2027, 1, 1)) == (1.50, 7.50)


if __name__ == "__main__":
    test_default_is_supported()
    test_invalid_model_is_rejected()
    test_introductory_pricing_changes_on_boundary()
    print("all gemini-model self-checks passed")
