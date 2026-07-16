"""Self-checks for speaker diarization plumbing (Soniox -> trailer prompt).

Run: .venv/bin/python test_diarization.py
Covers: speaker labels surviving the token->word merge, segments/sentences
never spanning two voices, and the speaker-context prompt block picking the
right conversation shape (monologue / interview / panel) — or vanishing
entirely when the transcript has no labels (local Whisper).
"""
import re

from transcription import _soniox_tokens_to_transcript
from main import (
    TRAILER_PROMPT_TEMPLATE,
    _build_sentence_transcript,
    _trailer_speaker_context,
)


def tok(text, start_ms, end_ms, speaker=None):
    t = {"text": text, "start_ms": start_ms, "end_ms": end_ms,
         "confidence": 0.95, "language": "en"}
    if speaker is not None:
        t["speaker"] = speaker
    return t


def test_soniox_speaker_carried_and_segments_split():
    tokens = [
        tok("How", 0, 200, "1"), tok(" are", 250, 400, "1"),
        tok(" you", 450, 600, "1"),
        tok(" Great", 700, 950, "2"), tok(" thanks", 1000, 1300, "2"),
    ]
    out = _soniox_tokens_to_transcript(tokens)
    words = [w for seg in out["segments"] for w in seg["words"]]
    assert [w["speaker"] for w in words] == ["1", "1", "1", "2", "2"]
    # no terminal punctuation and no big pause — ONLY the speaker change splits
    assert len(out["segments"]) == 2
    assert out["segments"][0]["speaker"] == "1"
    assert out["segments"][1]["speaker"] == "2"


def test_soniox_no_speaker_means_no_field():
    out = _soniox_tokens_to_transcript([tok("Hello", 0, 300), tok(" world", 350, 600)])
    words = out["segments"][0]["words"]
    assert all("speaker" not in w for w in words)
    assert all("speaker" not in seg for seg in out["segments"])


def test_sentences_split_on_speaker_change_and_carry_sp():
    transcript = {"segments": [{
        "words": [
            {"word": "Why", "start": 0.0, "end": 0.3, "speaker": "1"},
            {"word": "Dubai", "start": 0.35, "end": 0.7, "speaker": "1"},
            {"word": "Because", "start": 0.9, "end": 1.2, "speaker": "2"},
            {"word": "taxes.", "start": 1.25, "end": 1.6, "speaker": "2"},
        ],
    }]}
    sentences = _build_sentence_transcript(transcript)
    assert len(sentences) == 2
    assert sentences[0]["sp"] == "1" and sentences[0]["text"] == "Why Dubai"
    assert sentences[1]["sp"] == "2" and sentences[1]["text"] == "Because taxes."


def test_speaker_context_shapes():
    def sent(sp, text, s, e):
        return {"i": 0, "s": s, "e": e, "text": text, "sp": sp}

    # no labels -> empty block, prompt reads exactly as before
    assert _trailer_speaker_context([{"i": 0, "s": 0, "e": 1, "text": "hi"}]) == ""

    mono = _trailer_speaker_context([sent("1", "I built it alone.", 0, 5)])
    assert "MONOLOGUE" in mono

    duo = _trailer_speaker_context([
        sent("1", "Why did you leave?", 0, 2),
        sent("2", "They shut my bank account and I was facing a life sentence.", 2, 12),
    ])
    assert "INTERVIEW" in duo
    # host (speaker 1) has less talk time and more questions — stats must show it
    assert "speaker 1" in duo and "1 questions asked" in duo

    panel = _trailer_speaker_context([
        sent("1", "Why?", 0, 1), sent("2", "Money.", 1, 4), sent("3", "No — fear.", 4, 8),
    ])
    assert "MULTI-VOICE" in panel and "3 speakers" in panel


def test_speaker_stats_count_non_ascii_questions():
    """Arabic '؟' is a question mark the Soniox segmenter already splits on
    (SONIOX_SENTENCE_END). Counting only ASCII '?' would report 0 questions for
    every speaker, killing host detection on Arabic interviews."""
    def sent(sp, text, s, e):
        return {"i": 0, "s": s, "e": e, "text": text, "sp": sp}

    ar = _trailer_speaker_context([
        sent("1", "لماذا غادرت المملكة المتحدة؟", 0, 2),
        sent("2", "أغلقوا حسابي المصرفي وكنت أواجه السجن المؤبد.", 2, 12),
    ])
    assert "INTERVIEW" in ar
    assert "speaker 1" in ar and "1 questions asked" in ar   # host found
    assert "speaker 2" in ar and "0 questions asked" in ar   # guest asked none

    # every supported question mark counts
    for mark in ("?", "؟", "？"):
        ctx = _trailer_speaker_context([sent("1", f"Why{mark}", 0, 1),
                                        sent("2", "Because.", 1, 5)])
        assert "1 questions asked" in ctx, f"missed question mark {mark!r}"

    # ...and a sentence ENDING in an ASCII semicolon is NOT a question. (A
    # sentence can end mid-clause on the pause/word-cap split, so this is
    # reachable.) ';' is not the Greek U+037E — which NFC-normalizes to it, so
    # matching Greek would flag ordinary English clauses as questions.
    # Assert on speaker 1's OWN stat line — a bare "0 questions asked" substring
    # would match speaker 2's line and pass even when speaker 1 is miscounted.
    semi = _trailer_speaker_context([sent("1", "I left the UK;", 0, 3),
                                     sent("2", "Understood.", 3, 6)])
    assert re.search(r"speaker 1: \d+% of talk time, 0 questions asked", semi), semi


def test_prompt_formats_with_and_without_speaker_block():
    for ctx in ("", "\nSPEAKERS: test block\n"):
        p = TRAILER_PROMPT_TEMPLATE.format(
            transcript="[]", duration=100, min_moments=8, max_moments=14,
            target_seconds=60, speaker_context=ctx)
        assert "RULES FOR MOMENTS:" in p
        assert ("SPEAKERS: test block" in p) == bool(ctx)


if __name__ == "__main__":
    test_soniox_speaker_carried_and_segments_split()
    test_soniox_no_speaker_means_no_field()
    test_sentences_split_on_speaker_change_and_carry_sp()
    test_speaker_context_shapes()
    test_speaker_stats_count_non_ascii_questions()
    test_prompt_formats_with_and_without_speaker_block()
    print("✅ all diarization plumbing checks passed")
