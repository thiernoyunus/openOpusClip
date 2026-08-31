"""Small self-check for the shared Gemini model allowlist and defaults."""

from gemini_models import DEFAULT_GEMINI_MODEL, GEMINI_MODELS, get_gemini_model


def test_default_is_supported():
    assert DEFAULT_GEMINI_MODEL in GEMINI_MODELS
    assert get_gemini_model() == DEFAULT_GEMINI_MODEL


def test_invalid_model_is_rejected():
    try:
        get_gemini_model("gemini-2.5-flash")
    except ValueError as error:
        assert "Unsupported Gemini model" in str(error)
    else:
        raise AssertionError("an unsupported Gemini model should be rejected")


if __name__ == "__main__":
    test_default_is_supported()
    test_invalid_model_is_rejected()
    print("all gemini-model self-checks passed")
