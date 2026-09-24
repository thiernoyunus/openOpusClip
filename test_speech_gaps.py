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


if __name__ == "__main__":
    test_gaps_between_around_and_after_speech()
    print("✓ speech spans become lead-in, pause and tail gaps")
    test_no_speech_is_one_long_gap()
    print("✓ no speech is one long gap")
    test_falls_back_to_volume_check_when_voice_detector_fails()
    print("✓ falls back to the volume check when Silero can't load")
    print("\nAll speech-gap self-checks passed.")
