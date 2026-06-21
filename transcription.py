import importlib.util
import os
import platform
import subprocess
from functools import lru_cache


WHISPER_MODELS = {"tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"}
MLX_MODELS = {
    # mlx-community repos use a -mlx suffix, except large-v3-turbo which doesn't
    model: f"mlx-community/whisper-{model}" + ("" if model == "large-v3-turbo" else "-mlx")
    for model in WHISPER_MODELS
}


def normalize_model(model_size="base"):
    model = (model_size or "base").strip()
    if model == "turbo":
        return "large-v3-turbo"
    if model in WHISPER_MODELS:
        return model
    print(f"⚠️  Unknown Whisper model '{model}', falling back to 'base'.")
    return "base"


def _is_apple_silicon():
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def resolve_backend(backend=None):
    requested = (backend or os.getenv("WHISPER_BACKEND") or "auto").strip().lower()
    if requested in {"faster", "faster_whisper"}:
        return "faster-whisper"
    if requested in {"mlx", "mlx_whisper"}:
        return "mlx-whisper"
    if requested in {"faster-whisper", "mlx-whisper"}:
        return requested

    if _is_apple_silicon() and importlib.util.find_spec("mlx_whisper"):
        return "mlx-whisper"
    return "faster-whisper"


def _faster_whisper_device():
    device = os.getenv("WHISPER_DEVICE")
    compute_type = os.getenv("WHISPER_COMPUTE_TYPE")
    if device and compute_type:
        return device, compute_type

    if device:
        return device, compute_type or ("float16" if device == "cuda" else "int8")

    try:
        import torch

        if torch.cuda.is_available():
            return "cuda", compute_type or "float16"
    except Exception:
        pass
    return "cpu", compute_type or "int8"


@lru_cache(maxsize=4)
def _load_faster_whisper(model_size, device, compute_type):
    from faster_whisper import WhisperModel

    return WhisperModel(model_size, device=device, compute_type=compute_type)


def _word_dict(word, strip=False):
    text = getattr(word, "word", None)
    if text is None and isinstance(word, dict):
        text = word.get("word", word.get("text", ""))
    text = text or ""
    if strip:
        text = text.strip()

    start = getattr(word, "start", None)
    end = getattr(word, "end", None)
    probability = getattr(word, "probability", None)
    if isinstance(word, dict):
        start = word.get("start", start)
        end = word.get("end", end)
        probability = word.get("probability", word.get("prob", probability))

    data = {"word": text, "start": start, "end": end}
    if probability is not None:
        data["probability"] = probability
    return data


def _segment_dict(segment, strip_words=False):
    if isinstance(segment, dict):
        words = segment.get("words") or []
        return {
            "text": segment.get("text", ""),
            "start": segment.get("start", 0.0),
            "end": segment.get("end", 0.0),
            "words": [_word_dict(word, strip=strip_words) for word in words],
        }

    return {
        "text": segment.text,
        "start": segment.start,
        "end": segment.end,
        "words": [_word_dict(word, strip=strip_words) for word in (segment.words or [])],
    }


def _transcribe_faster_whisper(video_path, model_size, strip_words=False):
    device, compute_type = _faster_whisper_device()
    print(f"🎙️  Transcribing with Faster-Whisper '{model_size}' ({device}/{compute_type})...")
    model = _load_faster_whisper(model_size, device, compute_type)
    segments, info = model.transcribe(video_path, word_timestamps=True)

    transcript_segments = []
    full_text = ""
    for segment in segments:
        print(f"   [{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text}")
        seg = _segment_dict(segment, strip_words=strip_words)
        transcript_segments.append(seg)
        full_text += seg["text"] + " "

    language = getattr(info, "language", None)
    probability = getattr(info, "language_probability", None)
    if language and probability is not None:
        print(f"   Detected language '{language}' with probability {probability:.2f}")

    return {
        "text": full_text.strip(),
        "segments": transcript_segments,
        "language": language,
        "backend": f"faster-whisper:{device}:{compute_type}",
    }


def _transcribe_mlx_whisper(video_path, model_size, strip_words=False):
    import mlx_whisper

    repo = MLX_MODELS[model_size]
    print(f"🎙️  Transcribing with MLX Whisper '{repo}'...")
    result = mlx_whisper.transcribe(
        video_path,
        path_or_hf_repo=repo,
        word_timestamps=True,
    )
    segments = [_segment_dict(segment, strip_words=strip_words) for segment in result.get("segments", [])]
    for segment in segments:
        print(f"   [{segment['start']:.2f}s -> {segment['end']:.2f}s] {segment['text']}")
    return {
        "text": result.get("text", "").strip(),
        "segments": segments,
        "language": result.get("language"),
        "backend": "mlx-whisper",
    }


# Silence detection tuned to the editor's pause thresholds: gaps >= ~180ms show
# as pause chips, >= 400ms are cuttable. Detect a little below 180ms so a real
# pause is never missed; the frontend thresholds do the final filtering.
SILENCE_NOISE_DB = -30
SILENCE_MIN_S = 0.15


def detect_silences(video_path, noise_db=SILENCE_NOISE_DB, min_silence=SILENCE_MIN_S):
    """Silence intervals [(start_s, end_s)] from ffmpeg's silencedetect filter."""
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-i", video_path,
        "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    silences = []
    start = None
    for line in proc.stderr.splitlines():
        if "silence_start:" in line:
            try:
                start = float(line.split("silence_start:")[1].split()[0])
            except (ValueError, IndexError):
                start = None
        elif "silence_end:" in line and start is not None:
            try:
                end = float(line.split("silence_end:")[1].split("|")[0].split()[0])
                if end > start:
                    silences.append((start, end))
            except (ValueError, IndexError):
                pass
            start = None
    return silences


def _apply_silence_gaps(segments, silences):
    """Carve real gaps into the word timeline using detected silences. Whisper
    word alignment sets each word's end == the next word's start (no silence),
    so pause/silence editing finds nothing — most visibly on mlx-whisper. For
    each silence [s, e], push the preceding word's end back to s and the
    following word's start forward to e, so a genuine gap appears. Mutates word
    start/end in place; all times in seconds.

    ponytail: O(words * silences) linear scans — fine for clip-length transcripts
    (hundreds of words, tens of silences); switch to a two-pointer merge if it
    ever runs on multi-hour audio.
    """
    words = [
        w
        for seg in segments
        for w in seg.get("words", [])
        if isinstance(w.get("start"), (int, float)) and isinstance(w.get("end"), (int, float))
    ]
    if not words or not silences:
        return
    for s, e in silences:
        # Word spoken just before the silence: the last one starting before s.
        prev = None
        for w in words:
            if w["start"] < s:
                prev = w
            else:
                break
        # Word resuming after the silence: the first one still ending after e.
        nxt = next((w for w in words if w["end"] > e), None)
        if prev is not None and prev["end"] > s:
            prev["end"] = max(s, prev["start"])
        if nxt is not None and nxt is not prev and nxt["start"] < e:
            nxt["start"] = min(e, nxt["end"])


def transcribe(video_path, model_size="base", backend=None, strip_words=False):
    model = normalize_model(model_size)
    selected = resolve_backend(backend)
    result = None
    if selected == "mlx-whisper":
        try:
            result = _transcribe_mlx_whisper(video_path, model, strip_words=strip_words)
        except Exception as exc:
            # ponytail: MLX is optional; faster-whisper remains the portable path.
            print(f"⚠️  MLX Whisper failed ({exc}); falling back to Faster-Whisper.")
    if result is None:
        result = _transcribe_faster_whisper(video_path, model, strip_words=strip_words)

    # Recover real word gaps from the audio so pause/silence editing works
    # regardless of backend. Best-effort: never fail transcription over this.
    try:
        silences = detect_silences(video_path)
        if silences:
            _apply_silence_gaps(result["segments"], silences)
            print(f"   🔇 Recovered {len(silences)} silence gap(s) in word timings.")
    except Exception as exc:
        print(f"⚠️  Silence-gap pass skipped: {exc}")

    return result


def _self_check():
    assert normalize_model("turbo") == "large-v3-turbo"
    assert normalize_model("nope") == "base"
    assert resolve_backend("faster") == "faster-whisper"
    assert resolve_backend("mlx") == "mlx-whisper"

    # Gapless words (end == next start) with a silence inside the boundary should
    # come out with a real gap matching the silence interval.
    segs = [{"words": [
        {"word": "a", "start": 0.0, "end": 1.3},
        {"word": "b", "start": 1.3, "end": 2.0},
    ]}]
    _apply_silence_gaps(segs, [(1.0, 1.6)])
    w = segs[0]["words"]
    assert w[0]["end"] == 1.0 and w[1]["start"] == 1.6, w
    assert round(w[1]["start"] - w[0]["end"], 3) == 0.6  # genuine gap now
    # No silence -> untouched.
    segs2 = [{"words": [{"word": "x", "start": 0.0, "end": 0.5}]}]
    _apply_silence_gaps(segs2, [])
    assert segs2[0]["words"][0]["end"] == 0.5


if __name__ == "__main__":
    _self_check()
    print(resolve_backend())
