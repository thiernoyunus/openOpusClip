"""Self-checks for the voice-based silence pass (transcription.detect_speech_gaps).

Run: .venv/bin/python test_speech_gaps.py

The Silero model and audio decoding are stubbed so this runs without a real
audio file; it checks how speech spans turn into silence gaps.
"""
import sys
import types

import numpy as np

import transcription

SR = 16000


def _stub_silero(speech_spans_s, total_s):
    """Install fake faster_whisper.audio / .vad modules returning fixed spans."""
    audio_mod = types.ModuleType("faster_whisper.audio")
    audio_mod.decode_audio = lambda path, sampling_rate: np.zeros(int(total_s * SR), np.float32)
    vad_mod = types.ModuleType("faster_whisper.vad")
    vad_mod.VadOptions = lambda **kw: kw
    vad_mod.get_speech_timestamps = lambda audio, opts: [
        {"start": int(s * SR), "end": int(e * SR)} for s, e in speech_spans_s
    ]
    sys.modules["faster_whisper.audio"] = audio_mod
    sys.modules["faster_whisper.vad"] = vad_mod


def test_gaps_between_around_and_after_speech():
    _stub_silero([(0.5, 2.0), (2.1, 4.0), (4.6, 9.0)], total_s=10.0)
    gaps = transcription.detect_speech_gaps("unused.mp4")
    # lead-in 0-0.5, the 0.6s pause, the tail 9-10; the 0.1s blip is below 0.15s
    assert gaps == [(0.0, 0.5), (4.0, 4.6), (9.0, 10.0)], gaps


def test_no_speech_is_one_long_gap():
    _stub_silero([], total_s=3.0)
    assert transcription.detect_speech_gaps("unused.mp4") == [(0.0, 3.0)]


def test_falls_back_to_volume_check_when_voice_detector_fails():
    calls = []
    orig_speech, orig_volume = transcription.detect_speech_gaps, transcription.detect_silences

    def broken(path):
        raise ImportError("onnxruntime missing")

    transcription.detect_speech_gaps = broken
    transcription.detect_silences = lambda path: calls.append(path) or [(1.0, 1.5)]
    try:
        result = {"segments": [{"words": [
            {"word": "a", "start": 0.0, "end": 1.2},
            {"word": "b", "start": 1.2, "end": 2.0},
        ]}]}
        transcription._recover_silence_gaps("clip.mp4", result)
    finally:
        transcription.detect_speech_gaps, transcription.detect_silences = orig_speech, orig_volume
    assert calls == ["clip.mp4"]
    words = result["segments"][0]["words"]
    assert words[0]["end"] == 1.0 and words[1]["start"] == 1.5, words


def _gap(words, silences):
    segs = [{"words": [{"word": w, "start": s, "end": e} for w, s, e in words]}]
    transcription._apply_silence_gaps(segs, silences)
    out = segs[0]["words"]
    return round(out[0]["end"], 3), round(out[1]["start"], 3)


def test_soft_word_start_is_not_eaten():
    # Soniox says "so" starts at 1.0; the voice detector only hears it from 1.3
    # (soft onset). The old pass moved "so" to 1.3 and the pause cut removed
    # its first 220ms. The transcript's own gap must be kept as the limit.
    assert _gap([("okay", 0.0, 0.5), ("so", 1.0, 1.5)], [(0.4, 1.3)]) == (0.5, 1.0)


def test_soft_word_end_is_not_eaten():
    # Speaker trails off: detector goes quiet at 0.2, transcript says 0.5.
    assert _gap([("right", 0.0, 0.5), ("and", 1.2, 1.5)], [(0.2, 1.2)]) == (0.5, 1.2)


def test_untranscribed_speech_in_a_gap_is_kept():
    # Transcript leaves 0.5-1.5 empty, but someone talks until 1.1 (a missed
    # "yeah", laughter). Only the truly silent 1.1-1.5 may become the gap.
    assert _gap([("a", 0.0, 0.5), ("b", 1.5, 2.0)], [(1.1, 1.5)]) == (1.1, 1.5)


def test_gap_with_no_silence_is_closed():
    # Detector hears sound through the whole transcript gap: nothing to cut.
    assert _gap([("a", 0.0, 0.5), ("b", 1.5, 2.0)], [(3.0, 4.0)]) == (1.5, 1.5)


def test_touching_whisper_words_still_get_their_pause():
    # Whisper made the words touch; the real pause 1.0-1.6 is recovered.
    assert _gap([("a", 0.0, 1.3), ("b", 1.3, 2.0)], [(1.0, 1.6)]) == (1.0, 1.6)


def test_filler_is_not_grown_over_speech():
    # "um" then untranscribed speech until 1.1. Growing "um" would make
    # "remove fillers" delete that speech, so "hello" covers it instead.
    assert _gap([("um", 0.0, 0.5), ("hello", 1.5, 2.0)], [(1.1, 1.5)]) == (0.5, 0.5)
    # Speech before a filler "um,": "hello" grows up to it, "um," keeps its span.
    assert _gap([("hello", 0.0, 0.5), ("um,", 1.5, 2.0)], [(0.5, 0.9)]) == (1.5, 1.5)


if __name__ == "__main__":
    for t in (test_filler_is_not_grown_over_speech, test_soft_word_start_is_not_eaten, test_soft_word_end_is_not_eaten,
              test_untranscribed_speech_in_a_gap_is_kept, test_gap_with_no_silence_is_closed,
              test_touching_whisper_words_still_get_their_pause):
        t()
        print(f"✓ {t.__name__}")
    test_gaps_between_around_and_after_speech()
    print("✓ speech spans become lead-in, pause and tail gaps")
    test_no_speech_is_one_long_gap()
    print("✓ no speech is one long gap")
    test_falls_back_to_volume_check_when_voice_detector_fails()
    print("✓ falls back to the volume check when Silero can't load")
    print("\nAll speech-gap self-checks passed.")
