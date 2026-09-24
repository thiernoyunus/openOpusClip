"""Small self-check for the shared Gemini model defaults, id check, and rates."""

from datetime import date

from gemini_models import DEFAULT_GEMINI_MODEL, GEMINI_MODELS, get_gemini_model, get_gemini_pricing


def test_default_is_supported():
    """The default model remains present in the supported model list."""
    assert DEFAULT_GEMINI_MODEL in GEMINI_MODELS
    assert get_gemini_model() == DEFAULT_GEMINI_MODEL


def test_live_model_ids_are_accepted_and_junk_rejected():
    """Any well-formed id from Google's live list works; header junk doesn't."""
    assert get_gemini_model("gemini-3.1-pro-preview") == "gemini-3.1-pro-preview"
    try:
        get_gemini_model("gemini 3; rm -rf")
    except ValueError as error:
        assert "Unsupported Gemini model" in str(error)
    else:
        raise AssertionError("a malformed Gemini model id should be rejected")


def test_introductory_pricing_changes_on_boundary():
    """Gemini 3.6 pricing changes exactly on January 1, 2027."""
    for model in ("gemini-3.6-flash", "gemini-3.7-flash"):
        assert get_gemini_pricing(model, date(2026, 12, 31)) == (0.75, 3.75)
        assert get_gemini_pricing(model, date(2027, 1, 1)) == (1.50, 7.50)


if __name__ == "__main__":
    test_default_is_supported()
    test_live_model_ids_are_accepted_and_junk_rejected()
    test_introductory_pricing_changes_on_boundary()
    print("all gemini-model self-checks passed")
