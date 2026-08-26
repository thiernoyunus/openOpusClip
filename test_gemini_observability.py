"""Self-checks for the bounded Gemini latency/retry metadata that augments the
existing cost_analysis dict produced by main.get_viral_clips and
main._generate_trailer_candidate.

Run: .venv/bin/python test_gemini_observability.py

These checks only cover the helper that augments the cost dict. End-to-end
Gemini call timing is not mocked here — the integration would require a fake
google-genai client and is exercised manually against a real API key.
"""
from main import _augment_attempt_metrics


def test_passes_none_through():
    # Matches existing behaviour when usage_metadata was unavailable: no
    # synthetic dict, no zero values, no spurious zero-latency entry.
    assert _augment_attempt_metrics(
        None, latency_ms=842, attempts_used=1, max_retries=3) is None


def test_adds_bounded_numeric_fields_without_altering_existing_shape():
    base = {
        "input_tokens": 1000,
        "output_tokens": 50,
        "input_cost": 0.0001,
        "output_cost": 0.00002,
        "total_cost": 0.00012,
        "model": "gemini-2.5-flash",
    }
    out = _augment_attempt_metrics(
        base, latency_ms=842.7, attempts_used=2, max_retries=3)
    # Existing fields preserved verbatim.
    assert out["input_tokens"] == 1000
    assert out["model"] == "gemini-2.5-flash"
    # New fields: integers (latency rounded at the call site, kept as int here
    # too), no PII, no transcript / prompt / response text leaks.
    assert out["latency_ms"] == 842
    assert out["attempts_used"] == 2
    assert out["max_retries"] == 3
    assert isinstance(out["latency_ms"], int)
    assert isinstance(out["attempts_used"], int)
    assert isinstance(out["max_retries"], int)
    # No new sensitive fields slipped in: only the three bounded numerics.
    assert set(out) == set(base) | {"latency_ms", "attempts_used", "max_retries"}


def test_attempts_used_is_recorded_verbatim_for_diagnostics():
    # The helper doesn't clamp attempts_used to max_retries — a single attempt
    # that fails past the cap is still useful diagnostic truth.
    out = _augment_attempt_metrics(
        {"model": "gemini-2.5-flash"}, latency_ms=10, attempts_used=5, max_retries=3)
    assert out["attempts_used"] == 5
    assert out["max_retries"] == 3


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all gemini-observability self-checks passed")
