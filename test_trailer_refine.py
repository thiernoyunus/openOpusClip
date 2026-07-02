"""Self-checks for trailer moment refinement (script-first DOAC trailers).

Run: .venv/bin/python test_trailer_refine.py
Covers the guards that keep trailers watchable — no sub-second cuts, no words
sliced mid-utterance, padding only into silence.
"""
from main import (
    _refine_trailer_moments,
    _build_sentence_transcript,
    _verbatim_align_moments,
    _deterministic_best_trailer,
)


def words_from(spec):
    """spec: list of (word, start, end)."""
    return [{'word': w, 'start': s, 'end': e} for w, s, e in spec]


def test_snaps_to_word_edges():
    words = words_from([
        ("Hello", 1.00, 1.40), ("there", 1.45, 1.90),
        ("this", 3.00, 3.30), ("is", 3.35, 3.55), ("real.", 3.60, 4.20),
    ])
    # AI picked slightly off boundaries (1.12 -> 4.05)
    m = [{'start': 1.12, 'end': 4.05, 'accent_word': 'real', 'emotion': 'power'}]
    out = _refine_trailer_moments(m, words, duration=10.0)
    assert len(out) == 1
    # start padded back toward silence but never before 0, end near last word end
    assert out[0]['start'] <= 1.00 and out[0]['start'] >= 0.0
    assert 4.20 <= out[0]['end'] <= 4.36  # word end 4.20 + pad, capped by duration


def test_drops_unusable_subsecond_fragments():
    words = words_from([("uh", 2.00, 2.30)])  # only a 0.3s fragment exists
    m = [
        {'start': 2.00, 'end': 2.30, 'accent_word': 'uh', 'emotion': 'neutral'},
        {'start': 2.00, 'end': 2.30, 'accent_word': 'uh', 'emotion': 'neutral'},
    ]
    out = _refine_trailer_moments(m, words, duration=5.0)
    # 0.3s is below MIN_FINAL too -> nothing usable survives
    assert len(out) == 0


def test_final_gets_lower_floor_than_nonfinal():
    # A ~1.4s clause: valid as the FINAL open-loop (floor 1.2), but as a
    # non-final it's below MIN_DUR (2.0) and (isolated) can't extend -> dropped.
    words = words_from([
        ("The", 0.0, 0.2), ("answer", 0.25, 0.9), ("is", 0.95, 1.2),
        ("really", 1.25, 1.8), ("simple.", 1.85, 2.6),
        ("But", 5.0, 5.3), ("honestly", 5.35, 6.4),  # isolated ~1.4s cliffhanger
    ])
    m = [
        {'start': 0.0, 'end': 2.6, 'accent_word': 'simple', 'emotion': 'payoff'},
        {'start': 5.0, 'end': 6.4, 'accent_word': 'honestly', 'emotion': 'curiosity'},
    ]
    out = _refine_trailer_moments(m, words, duration=7.0)
    assert len(out) == 2  # short FINAL open-loop survives

    # Same clause NOT last (add a trailing beat) -> the 1.4s one is now dropped.
    m2 = m + [{'start': 0.0, 'end': 2.6, 'accent_word': 'simple', 'emotion': 'payoff'}]
    out2 = _refine_trailer_moments(m2, words, duration=7.0)
    starts2 = [round(o['start'], 1) for o in out2]
    assert 5.0 not in starts2 and 4.9 not in starts2  # the mid 1.4s beat dropped


def test_pad_never_eats_adjacent_word():
    words = words_from([
        ("one", 1.0, 1.4), ("two", 1.42, 1.9),   # back-to-back, no gap
        ("three", 2.5, 3.0), ("four", 3.02, 3.6), ("five", 3.62, 4.6),
    ])
    m = [{'start': 2.5, 'end': 4.6, 'accent_word': 'five', 'emotion': 'neutral'}]
    out = _refine_trailer_moments(m, words, duration=10.0)
    # left pad must not cross into "two" (ends 1.9) -> start >= 1.9
    assert out[0]['start'] >= 1.9


def test_sentence_grouping_splits_on_punct_and_pause():
    words = words_from([
        ("This", 0.0, 0.3), ("is", 0.35, 0.5), ("one.", 0.55, 0.9),
        ("Then", 1.0, 1.3), ("two", 1.35, 1.7), ("here", 1.75, 2.1),
        # big pause before "Later" forces a split even without punctuation
        ("Later", 5.0, 5.4), ("words", 5.45, 5.9),
    ])
    tr = {'segments': [{'words': words}]}
    sents = _build_sentence_transcript(tr)
    assert sents[0]['text'] == "This is one."
    assert sents[0]['i'] == 0 and sents[0]['s'] == 0.0
    assert any(s['text'].startswith("Later") for s in sents)


def test_verbatim_snap_recovers_clipped_start():
    # Real sentence in transcript starts at "We"; the model's timestamps clipped
    # the start to "labour" but its text claims the full line -> snap start back.
    words = words_from([
        ("We", 10.0, 10.2), ("can", 10.22, 10.4), ("just", 10.42, 10.7),
        ("double", 10.72, 11.1), ("our", 11.12, 11.3),
        ("labour", 11.32, 11.7), ("force", 11.72, 12.1),
        ("and", 12.12, 12.3), ("get", 12.32, 12.5),
        ("twice", 12.52, 12.9), ("the", 12.92, 13.1), ("production.", 13.12, 13.8),
    ])
    tr = {'segments': [{'words': words}]}
    sents = _build_sentence_transcript(tr)
    m = [{
        'start': 11.32, 'end': 13.8,  # clipped: starts at "labour"
        'text': 'We can just double our labour force and get twice the production',
        'accent_word': 'production', 'emotion': 'payoff',
    }]
    out = _verbatim_align_moments(m, sents, words)
    assert abs(out[0]['start'] - 10.0) < 0.01  # snapped back to sentence start "We"


def test_verbatim_leaves_good_moment_untouched():
    words = words_from([
        ("This", 0.0, 0.3), ("is", 0.35, 0.5), ("exactly", 0.55, 1.0),
        ("right.", 1.05, 1.5),
    ])
    tr = {'segments': [{'words': words}]}
    sents = _build_sentence_transcript(tr)
    m = [{'start': 0.0, 'end': 1.5, 'text': 'This is exactly right.',
          'accent_word': 'right', 'emotion': 'power'}]
    out = _verbatim_align_moments(m, sents, words)
    assert out[0]['start'] == 0.0 and out[0]['end'] == 1.5  # verbatim -> unchanged


def _cand(script, last_text):
    return {'script': script, 'moments_ordered': [{'text': last_text}]}


def test_sentence_grouping_skips_words_with_missing_timestamps():
    # Bad ASR output can yield words with start/end=None; must not crash and
    # must not corrupt sentence boundaries around the gap.
    words = [
        {'word': 'This', 'start': 0.0, 'end': 0.3},
        {'word': 'is', 'start': 0.35, 'end': 0.5},
        {'word': 'broken', 'start': None, 'end': None},
        {'word': 'one.', 'start': 0.55, 'end': 0.9},
    ]
    tr = {'segments': [{'words': words}]}
    sents = _build_sentence_transcript(tr)  # must not raise
    assert sents[0]['text'] == 'This is one.'


def test_deterministic_pick_prefers_clean_and_cliffhanger():
    # cand0: filler-heavy + resolved ending; cand1: clean + open-question ending.
    cand0 = _cand("Okay yeah exactly uh the money doubles. Sunken cost fallacy.",
                  "Sunken cost fallacy.")
    cand1 = _cand("They plotted to turn us against each other. So where do you even start",
                  "So where do you even start")
    assert _deterministic_best_trailer([cand0, cand1]) == 1
    # order-independent
    assert _deterministic_best_trailer([cand1, cand0]) == 0


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all trailer-refine self-checks passed")
