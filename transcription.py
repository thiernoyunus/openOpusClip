import importlib.util
import os
import platform
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


def transcribe(video_path, model_size="base", backend=None, strip_words=False):
    model = normalize_model(model_size)
    selected = resolve_backend(backend)
    if selected == "mlx-whisper":
        try:
            return _transcribe_mlx_whisper(video_path, model, strip_words=strip_words)
        except Exception as exc:
            # ponytail: MLX is optional; faster-whisper remains the portable path.
            print(f"⚠️  MLX Whisper failed ({exc}); falling back to Faster-Whisper.")
    return _transcribe_faster_whisper(video_path, model, strip_words=strip_words)


def _self_check():
    assert normalize_model("turbo") == "large-v3-turbo"
    assert normalize_model("nope") == "base"
    assert resolve_backend("faster") == "faster-whisper"
    assert resolve_backend("mlx") == "mlx-whisper"


if __name__ == "__main__":
    _self_check()
    print(resolve_backend())
