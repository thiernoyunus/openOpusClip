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
    if requested == "soniox":
        return "soniox"
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


# Sentence-ending punctuation that closes a caption segment. Latin + Arabic
# (؟ question, ۔ full stop, ؛ semicolon) so multilingual transcripts split well.
SONIOX_SENTENCE_END = ".?!…؟۔؛"
SONIOX_MODEL = "stt-async-v5"
SONIOX_API_BASE = "https://api.soniox.com/v1"


def _soniox_tokens_to_transcript(tokens):
    """Convert Soniox's flat token list into the canonical transcript shape.
    Pure (no network) so it's unit-testable.

    Soniox v5 returns SUB-WORD tokens: the verbatim transcript is the tokens'
    `text` concatenated with no separator, and a token that STARTS a new word
    carries a leading space (continuations carry none). So we merge sub-tokens
    back into whole words — essential for Arabic, where splitting a word into
    its sub-tokens destroys contextual letter-joining (it renders as isolated
    glyphs). Primary signal is the leading space; we fall back to time-
    contiguity (within-word sub-tokens are gapless, words have a gap) for the
    case where Soniox emits standalone whitespace tokens instead of leading
    spaces. Per-token `language` is kept as an additive optional word field.
    """

    def _finish(cur):
        word = {"word": cur["text"], "start": cur["start"], "end": cur["end"]}
        if cur["confs"]:
            word["probability"] = min(cur["confs"])  # only as confident as the weakest piece
        if cur["langs"]:
            word["language"] = max(set(cur["langs"]), key=cur["langs"].count)
        return word

    def _script(s):
        """Coarse script class for word-boundary detection. 'rtl' for Arabic/
        Hebrew/Syriac/Thaana letters, 'latin' for Latin letters, else None.
        None never forces a boundary, so digits/punctuation always attach."""
        for ch in s:
            o = ord(ch)
            if (0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or
                    0x08A0 <= o <= 0x08FF or 0xFB50 <= o <= 0xFDFF or
                    0xFE70 <= o <= 0xFEFF or 0x0590 <= o <= 0x05FF or
                    0x0700 <= o <= 0x074F or 0x0780 <= o <= 0x07BF):
                return "rtl"
            if ("a" <= ch <= "z" or "A" <= ch <= "Z" or 0x00C0 <= o <= 0x024F):
                return "latin"
        return None

    words = []
    cur = None
    for tok in tokens:
        raw = tok.get("text") or ""
        if raw.strip() == "":
            # Whitespace-only token: a hard word boundary; emits no word.
            if cur is not None:
                words.append(_finish(cur))
                cur = None
            continue
        piece = raw.strip()
        start = (tok.get("start_ms") or 0) / 1000.0
        end = (tok.get("end_ms") or 0) / 1000.0
        conf = tok.get("confidence")
        lang = tok.get("language")
        is_punct = not any(ch.isalnum() for ch in piece)
        if cur is None:
            new_word = True
        elif is_punct:
            new_word = False                      # punctuation attaches to the word, no space
        else:
            # Word boundaries are marked by a leading space on the starting token.
            # But Soniox sometimes drops the space at a LANGUAGE/SCRIPT switch
            # (that's how 'victory.' fused onto 'العاقبة'), so a script flip
            # (Latin<->RTL) also forces a boundary. Language change is a secondary
            # cue, gated on the word's MAJORITY language (what _finish tags) and
            # only when same-script, so a single mis-tagged sub-token can't split
            # a same-script word. Same-script continuations still merge, which
            # preserves Arabic contextual letter-joining.
            cur_script = _script(cur["text"])
            piece_script = _script(piece)
            script_change = (
                cur_script is not None and piece_script is not None
                and cur_script != piece_script
            )
            cur_lang = (max(set(cur["langs"]), key=cur["langs"].count)
                        if cur["langs"] else None)
            lang_change = (
                cur_lang is not None and lang is not None and cur_lang != lang
                and (cur_script is None or piece_script is None
                     or cur_script == piece_script)
            )
            new_word = raw[:1].isspace() or script_change or lang_change

        if new_word and cur is not None:
            words.append(_finish(cur))
            cur = None
        if cur is None:
            cur = {
                "text": piece,
                "start": start,
                "end": end,
                "confs": [conf] if conf is not None else [],
                "langs": [lang] if lang else [],
            }
        else:
            cur["text"] += piece                  # concat sub-word / attach punctuation, no space
            cur["end"] = end                      # extend to the last sub-token's end
            if conf is not None:
                cur["confs"].append(conf)
            if lang:
                cur["langs"].append(lang)
    if cur is not None:
        words.append(_finish(cur))

    # Group whole words into segments on sentence punctuation or a >=0.8s pause.
    segments = []
    current = []
    for i, w in enumerate(words):
        current.append(w)
        ends_sentence = w["word"][-1] in SONIOX_SENTENCE_END
        nxt = words[i + 1] if i + 1 < len(words) else None
        big_pause = nxt is not None and (nxt["start"] - w["end"]) >= 0.8
        if ends_sentence or big_pause or nxt is None:
            segments.append({
                "text": " ".join(x["word"] for x in current),
                "start": current[0]["start"],
                "end": current[-1]["end"],
                "words": current,
            })
            current = []

    langs = [w["language"] for w in words if w.get("language")]
    language = max(set(langs), key=langs.count) if langs else None
    return {
        "text": " ".join(w["word"] for w in words),
        "segments": segments,
        "language": language,
        "backend": f"soniox:{SONIOX_MODEL}",
    }


def _transcribe_soniox(video_path, strip_words=False):
    """Transcribe via Soniox async API (bring-your-own key). Extracts audio,
    uploads it, polls to completion, then maps tokens to the canonical shape.
    Raises on any failure — the caller surfaces it (no silent Whisper fallback).
    `strip_words` is accepted for signature parity; tokens are already trimmed."""
    import tempfile
    import time as _time

    import httpx

    api_key = os.environ.get("SONIOX_API_KEY")
    if not api_key:
        raise RuntimeError("SONIOX_API_KEY is not set — cannot use the Soniox engine.")

    print(f"🎙️  Transcribing with Soniox '{SONIOX_MODEL}'...")

    # Extract audio only (small upload). -vn mirrors detect_silences.
    tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
    tmp.close()
    audio_path = tmp.name
    file_id = None
    transcription_id = None
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-y", "-vn", "-i", video_path,
             "-ac", "1", "-ar", "16000", "-f", "mp3", audio_path],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )

        with httpx.Client(base_url=SONIOX_API_BASE, headers=headers, timeout=300.0) as client:
            with open(audio_path, "rb") as f:
                up = client.post("/files", files={"file": (os.path.basename(audio_path), f, "audio/mpeg")})
            up.raise_for_status()
            file_id = up.json()["id"]

            created = client.post("/transcriptions", json={
                "model": SONIOX_MODEL,
                "file_id": file_id,
                "enable_language_identification": True,
            })
            created.raise_for_status()
            transcription_id = created.json()["id"]

            # Poll until done. Cap the wait so a stuck job fails instead of hanging.
            deadline = _time.time() + 1800  # 30 min
            while True:
                if _time.time() > deadline:
                    raise RuntimeError("Soniox transcription timed out.")
                status_resp = client.get(f"/transcriptions/{transcription_id}")
                status_resp.raise_for_status()
                data = status_resp.json()
                state = data.get("status")
                if state == "completed":
                    break
                if state == "error":
                    raise RuntimeError(f"Soniox transcription failed: {data.get('error_message')}")
                _time.sleep(1.0)

            tr = client.get(f"/transcriptions/{transcription_id}/transcript")
            tr.raise_for_status()
            tokens = tr.json().get("tokens", [])

        # Show the raw token shape (spacing is the word-boundary signal we merge on).
        print(f"   Soniox returned {len(tokens)} raw tokens; first 12: "
              + ", ".join(repr((t.get('text') or '')) for t in tokens[:12]))
        result = _soniox_tokens_to_transcript(tokens)
        print(f"   Detected language '{result['language']}' ({len(result['segments'])} segment(s))")
        return result
    finally:
        # Best-effort cleanup: temp audio + remote file/transcription.
        try:
            os.remove(audio_path)
        except OSError:
            pass
        try:
            with httpx.Client(base_url=SONIOX_API_BASE, headers=headers, timeout=30.0) as c:
                if transcription_id:
                    c.delete(f"/transcriptions/{transcription_id}")
                if file_id:
                    c.delete(f"/files/{file_id}")
        except Exception:
            pass


# Silence detection tuned to the editor's pause thresholds: gaps >= ~180ms show
# as pause chips, >= 400ms are cuttable. Detect a little below 180ms so a real
# pause is never missed; the frontend thresholds do the final filtering.
SILENCE_NOISE_DB = -30
SILENCE_MIN_S = 0.15


def detect_silences(video_path, noise_db=SILENCE_NOISE_DB, min_silence=SILENCE_MIN_S):
    """Silence intervals [(start_s, end_s)] from ffmpeg's silencedetect filter."""
    # -vn: silencedetect only needs the audio stream; decoding video here was
    # ~20x slower for no reason.
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-vn", "-i", video_path,
        "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}",
        "-f", "null", "-",
    ]
    # errors="replace": ffmpeg stderr can carry non-UTF8 bytes (paths/metadata),
    # which would otherwise raise on non-UTF8 default encodings (e.g. Windows).
    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
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
        # Silence falls entirely inside one word's span (prev is nxt): there's a
        # single word token covering it, so we can't split it without inventing a
        # phantom gap (would truncate the word and let cleanup eat real speech).
        # Leave it untouched.
        if prev is not None and nxt is not None and prev is nxt:
            continue
        if prev is not None and prev["end"] > s:
            prev["end"] = max(s, prev["start"])
        if nxt is not None and nxt["start"] < e:
            nxt["start"] = min(e, nxt["end"])


def transcribe(video_path, model_size="base", backend=None, strip_words=False):
    model = normalize_model(model_size)
    selected = resolve_backend(backend)
    result = None
    if selected == "soniox":
        # No silent fallback: if the user picked Soniox, surface its errors.
        result = _transcribe_soniox(video_path, strip_words=strip_words)
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
    assert resolve_backend("soniox") == "soniox"

    # Soniox returns SUB-WORD tokens (leading space = word start). They must
    # merge back into whole words: ms->s, per-word language, segment split on
    # sentence punctuation (Latin '.' and Arabic '؟'), Arabic kept as ONE string.
    tr = _soniox_tokens_to_transcript([
        {"text": "Hello", "start_ms": 0, "end_ms": 500, "confidence": 0.9, "language": "en"},
        {"text": " wor", "start_ms": 520, "end_ms": 760, "confidence": 0.8, "language": "en"},
        {"text": "ld", "start_ms": 760, "end_ms": 1000, "confidence": 0.7, "language": "en"},
        {"text": ".", "start_ms": 1000, "end_ms": 1000, "language": "en"},
        {"text": " مر", "start_ms": 1200, "end_ms": 1400, "language": "ar"},
        {"text": "حبا", "start_ms": 1400, "end_ms": 1600, "language": "ar"},
        {"text": " بك", "start_ms": 1700, "end_ms": 1950, "language": "ar"},
        {"text": "؟", "start_ms": 1950, "end_ms": 1950, "language": "ar"},
    ])
    flat = [w for s in tr["segments"] for w in s["words"]]
    assert [w["word"] for w in flat] == ["Hello", "world.", "مرحبا", "بك؟"], flat
    assert tr["backend"] == "soniox:stt-async-v5"
    assert len(tr["segments"]) == 2, tr["segments"]          # split on '.' then '؟'
    assert flat[0]["start"] == 0.0
    assert flat[1]["start"] == 0.52 and flat[1]["end"] == 1.0  # merged sub-tokens, ms->s
    assert flat[1]["probability"] == 0.7                      # min of sub-token confidences
    assert flat[2]["word"] == "مرحبا" and flat[2]["language"] == "ar"  # Arabic = one string
    assert tr["language"] in {"en", "ar"}

    # A LANGUAGE/SCRIPT switch where Soniox drops the leading space (the real
    # 'victory."العاقبة' fusion) must still split into two words.
    tr2 = _soniox_tokens_to_transcript([
        {"text": "victory", "start_ms": 0, "end_ms": 400, "language": "en"},
        {"text": '."', "start_ms": 400, "end_ms": 400, "language": "en"},
        {"text": "العاق", "start_ms": 420, "end_ms": 700, "language": "ar"},  # NO leading space
        {"text": "بة", "start_ms": 700, "end_ms": 900, "language": "ar"},
    ])
    w2 = [x["word"] for s in tr2["segments"] for x in s["words"]]
    assert w2 == ['victory."', "العاقبة"], w2          # not fused; punctuation kept on English
    # No word mixes Latin and Arabic letters.
    for x in w2:
        has_ar = any(0x0600 <= ord(c) <= 0x06FF for c in x)
        has_lat = any("a" <= c.lower() <= "z" for c in x)
        assert not (has_ar and has_lat), x

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
    # Silence fully inside one word span (prev is nxt) -> leave word untouched,
    # don't invent a phantom gap.
    segs3 = [{"words": [
        {"word": "a", "start": 0.0, "end": 2.0},
        {"word": "b", "start": 2.0, "end": 3.0},
    ]}]
    _apply_silence_gaps(segs3, [(1.0, 1.6)])
    assert segs3[0]["words"][0]["end"] == 2.0 and segs3[0]["words"][1]["start"] == 2.0, segs3


if __name__ == "__main__":
    _self_check()
    print(resolve_backend())
