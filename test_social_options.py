"""Self-checks for per-account social posting options (Zernio).

Run: .venv/bin/python test_social_options.py
Covers the trust boundary on YouTube visibility (it arrives straight off the
wire) and the Instagram Reel cover offset.
"""
from fastapi import HTTPException

from app import _youtube_visibility, _instagram_thumb_offset


def test_visibility_defaults_to_public():
    # Missing/empty must behave exactly like it did before the option existed.
    assert _youtube_visibility(None) == "public"
    assert _youtube_visibility("") == "public"


def test_visibility_accepts_the_three_documented_values():
    for v in ("public", "private", "unlisted"):
        assert _youtube_visibility(v) == v


def test_visibility_rejects_anything_else():
    for bad in ("PUBLIC", "hidden", "unlisted ", "public;private", "0", "true"):
        try:
            _youtube_visibility(bad)
        except HTTPException as e:
            assert e.status_code == 400
        else:
            raise AssertionError(f"visibility {bad!r} should have been rejected")


def test_thumb_offset_defaults_to_first_frame():
    assert _instagram_thumb_offset(None) == 0
    assert _instagram_thumb_offset("not a number") == 0
    assert _instagram_thumb_offset(-500) == 0  # clamped, never negative


def test_thumb_offset_passes_through_milliseconds():
    assert _instagram_thumb_offset(2500) == 2500
    assert _instagram_thumb_offset(2500.9) == 2500  # truncated to a whole ms


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all social-options self-checks passed")
