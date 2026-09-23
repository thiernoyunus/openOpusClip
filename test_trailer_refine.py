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
    _resolve_moment_bounds,
    _complete_thought_bounds,
    _soundbite_transcript,
    retime_captions,
    save_transcript,
    _fit_trailer_budget,
    _trailer_length_problems,
)
import json
import os
import tempfile


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
    assert 4.20 <= out[0]["end"] <= 4.50  # word end 4.20 + tail pad


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


# --- complete-thought cuts (the "ends mid-sentence" fix) ---------------------

def _timed(text, start=0.0, step=0.3, speaker=None):
    """Words for a sentence string, back to back, `step` seconds each."""
    out, t = [], start
    for tok in text.split():
        w = {'word': tok, 'start': round(t, 2), 'end': round(t + step - 0.02, 2)}
        if speaker is not None:
            w['speaker'] = speaker
        out.append(w)
        t += step
    return out


def test_long_sentence_splits_at_clause_and_marks_more():
    # 24 words, one comma after word 19: the old builder cut blindly at word 22.
    text = ("I spent ten years building that company from nothing and every single "
            "night I lay awake thinking about payroll, because one bad month would sink us all.")
    words = _timed(text)
    sents = _build_sentence_transcript({'segments': [{'words': words}]})
    assert len(sents) == 2
    assert sents[0]['text'].endswith('payroll,') and sents[0].get('more') == 1
    assert sents[1]['text'].endswith('all.') and 'more' not in sents[1]


def test_indices_resolve_to_sentence_edges_and_absorb_continuations():
    words = (_timed("Nobody tells you this.", 0.0)
             + _timed("I spent ten years building that company from nothing and every single "
                      "night I lay awake thinking about payroll, because one bad month would sink us all.", 2.0)
             + _timed("So what did you do?", 12.0))
    sents = _build_sentence_transcript({'segments': [{'words': words}]})
    # model picked only the first piece of the run-on sentence (index 1)
    moments = [{'from_i': 1, 'to_i': 1, 'text': ''}, {'from_i': 3, 'to_i': 3, 'text': 'So what did you do?'}]
    out = _resolve_moment_bounds(moments, sents, words)
    assert out[0]['start'] == sents[1]['s']
    assert out[0]['end'] == sents[2]['e']  # widened through "...sink us all."


def test_final_cliffhanger_cuts_after_its_kept_words():
    words = _timed("And the number one reason men fail is they never ask for help.", 5.0)
    sents = _build_sentence_transcript({'segments': [{'words': words}]})
    m = [{'from_i': 0, 'to_i': 0, 'text': 'and the number one reason men fail is'}]
    out = _resolve_moment_bounds(m, sents, words)
    is_word = next(w for w in words if w['word'] == 'is')
    assert abs(out[0]['end'] - is_word['end']) < 1e-6


def test_bad_indices_drop_moment_but_timestamp_moments_survive():
    words = _timed("One two three.", 0.0)
    sents = _build_sentence_transcript({'segments': [{'words': words}]})
    out = _resolve_moment_bounds(
        [{'from_i': 99, 'to_i': 99}, {'start': 0.0, 'end': 0.9}], sents, words)
    assert len(out) == 1 and out[0]['start'] == 0.0


def test_complete_thought_extends_mid_sentence_end():
    words = (_timed("I lost everything that year because I trusted the wrong people.", 0.0)
             + _timed("Then it got worse.", 6.0))
    because = next(w for w in words if w['word'] == 'because')
    # a moment that stops on "because" (mid-sentence), then a second moment
    m = [{'start': 0.0, 'end': because['end']}, {'start': 6.0, 'end': 7.2}]
    out = _complete_thought_bounds(m, words)
    people = next(w for w in words if w['word'] == 'people.')
    assert abs(out[0]['end'] - people['end']) < 1e-6


def test_complete_thought_pulls_start_back_to_sentence_start():
    words = _timed("That was it. We can just double our labour force overnight.", 0.0)
    labour = next(w for w in words if w['word'] == 'labour')
    we = next(w for w in words if w['word'] == 'We')
    m = [{'start': labour['start'], 'end': words[-1]['end']}, {'start': 0.0, 'end': 0.8}]
    out = _complete_thought_bounds(m, words)
    assert abs(out[0]['start'] - we['start']) < 1e-6


def test_complete_thought_leaves_final_cliffhanger_end_alone():
    words = _timed("And the number one reason men fail is they never ask for help.", 0.0)
    is_word = next(w for w in words if w['word'] == 'is')
    m = [{'start': 0.0, 'end': is_word['end']}]
    out = _complete_thought_bounds(m, words)
    assert abs(out[0]['end'] - is_word['end']) < 1e-6


def test_complete_thought_stops_at_speaker_change():
    words = _timed("So what happened next", 0.0, speaker='1') + _timed("I walked out.", 1.3, speaker='2')
    m = [{'start': 0.0, 'end': words[1]['end']}, {'start': 1.3, 'end': 2.2}]
    out = _complete_thought_bounds(m, words)
    assert abs(out[0]['end'] - words[3]['end']) < 1e-6  # "next", not into speaker 2


def test_complete_thought_never_replays_another_moments_words():
    words = _timed("I lost everything that year because I trusted the wrong people.", 0.0)
    because = next(w for w in words if w['word'] == 'because')
    i_word = words[words.index(because) + 1]
    # moment 1 plays "I trusted the wrong people." — moment 0 must not extend into it
    m = [{'start': 0.0, 'end': because['end']}, {'start': i_word['start'], 'end': words[-1]['end']}]
    out = _complete_thought_bounds(m, words)
    assert out[0]['end'] == because['end']


def test_soundbite_transcript_keeps_whole_sentences_and_roles():
    sents = [
        {'i': 0, 's': 0, 'e': 1, 'text': 'a'},
        {'i': 1, 's': 1, 'e': 2, 'text': 'b,', 'more': 1},
        {'i': 2, 's': 2, 'e': 3, 'text': 'c.'},
        {'i': 3, 's': 3, 'e': 4, 'text': 'd.'},
    ]
    out = _soundbite_transcript(sents, [{'from_i': 2, 'to_i': 2, 'role': 'hook'}])
    assert [s['i'] for s in out] == [1, 2] and all(s['role'] == 'hook' for s in out)


def test_retime_flags_power_words_for_big_captions():
    words = _timed("The market will crash by 2030.", 10.0)
    tr = {'segments': [{'words': words}]}
    m = [{'start': 10.0, 'end': 12.0, 'accent_word': 'crash', 'emotion': 'danger',
          'power_words': ['2030', 'market']}]
    caps = retime_captions(tr, m, [0], [60], 30)
    flagged = {c['text'] for c in caps if c.get('highlight')}
    assert flagged == {'market', 'crash', '2030.'}
    assert next(c for c in caps if c['text'] == 'crash')['accentColor'] == '#FF2B2B'


def test_save_transcript_writes_json_and_speaker_turns():
    transcript = {'segments': [
        {'start': 0.0, 'end': 2.0, 'text': 'Welcome back.', 'speaker': '1'},
        {'start': 2.0, 'end': 4.0, 'text': 'Great to have you.', 'speaker': '1'},
        {'start': 65.0, 'end': 67.0, 'text': 'Thanks for having me.', 'speaker': '2'},
    ]}
    with tempfile.TemporaryDirectory() as d:
        path = save_transcript(transcript, d, 'Ep')
        with open(path) as f:
            assert json.load(f) == transcript
        with open(os.path.join(d, 'Ep_speakers.txt')) as f:
            assert f.read() == ("[0:00:00] Speaker 1: Welcome back. Great to have you.\n\n"
                                "[0:01:05] Speaker 2: Thanks for having me.\n\n")


def _mk(start, end, p=3, text='A line.'):
    return {'start': start, 'end': end, 'p': p, 'text': text}


def test_budget_drops_middle_moments_keeps_hook_and_cliffhanger():
    moments = [_mk(0, 10, 1, 'Hook.'), _mk(20, 32), _mk(40, 50, 2),
               _mk(60, 74), _mk(80, 90), _mk(100, 112), _mk(120, 122, 4, 'So the answer is')]
    out = _fit_trailer_budget(moments, [], 60)
    total = sum(m['end'] - m['start'] for m in out)
    assert total <= 72
    assert out[0]['text'] == 'Hook.' and out[-1]['text'] == 'So the answer is'


def test_budget_drops_question_with_its_answer():
    moments = [_mk(0, 30, 1), _mk(40, 44, 3, 'Why?'), _mk(50, 80, 3, 'Because.'),
               _mk(90, 100, 2), _mk(110, 120, 2), _mk(130, 132, 4)]
    out = _fit_trailer_budget(moments, [], 60)
    texts = [m['text'] for m in out]
    assert 'Why?' not in texts and 'Because.' not in texts


def test_budget_trims_long_moment_to_last_sentence_end():
    ws = words_from([('One', 0.0, 0.5), ('thing.', 0.5, 4.0), ('Two', 4.2, 4.6),
                     ('things.', 4.6, 12.0), ('Three', 12.2, 13.0), ('more', 13.0, 20.0)])
    out = _fit_trailer_budget([_mk(0, 20), _mk(30, 32, 4)], ws, 60)
    assert 12.0 <= out[0]['end'] <= 12.2


def test_budget_keeps_answer_when_question_is_same_voice():
    ws = words_from([('Right?', 40.0, 44.0), ('Because.', 50.0, 80.0)])
    for w in ws:
        w['speaker'] = '1'
    moments = [_mk(0, 30, 1), _mk(40, 44, 3, 'Right?'), _mk(50, 80, 3, 'Because.'),
               _mk(90, 100, 2), _mk(110, 120, 2), _mk(130, 132, 4)]
    texts = [m['text'] for m in _fit_trailer_budget(moments, ws, 60)]
    assert 'Right?' in texts and 'Because.' not in texts


def test_pause_mid_sentence_marks_more():
    tr = {'segments': [{'words': [
        {'word': "it's", 'start': 0.0, 'end': 0.3}, {'word': 'purely', 'start': 0.3, 'end': 0.8},
        {'word': 'selfless', 'start': 2.5, 'end': 3.0}, {'word': 'mission.', 'start': 3.0, 'end': 3.5},
        {'word': 'Done.', 'start': 6.0, 'end': 6.5}]}]}
    sents = _build_sentence_transcript(tr)
    assert sents[0]['text'] == "it's purely" and sents[0].get('more') == 1
    assert sents[1].get('more') is None


def test_length_problems_flags_monologue_and_total():
    probs = _trailer_length_problems([_mk(0, 65, 1), _mk(70, 75, 3), _mk(80, 82, 4)], 60)
    assert len(probs) == 1 and 'Moment 0' in probs[0]
    probs = _trailer_length_problems([_mk(0, 15), _mk(20, 35), _mk(40, 55), _mk(60, 75),
                                      _mk(80, 95), _mk(100, 102)], 60)
    assert probs[-1].startswith('The trailer runs')


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all trailer-refine self-checks passed")
