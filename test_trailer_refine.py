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
    _trailer_brief,
    _trailer_story_problems,
    _trim_lead_ins,
    _select_soundbites,
    _text_is_question,
    _code_ending,
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


def test_retime_boxes_hook_stakes_and_credential_accents():
    words = (_timed("AI will not pay.", 0.0) + _timed("He sold three brands.", 10.0)
             + _timed("My account got banned.", 20.0) + _timed("He founded Liberate Labs.", 30.0)
             + _timed("is it worth it?", 40.0))
    tr = {'segments': [{'words': words}]}
    m = [{'start': 0.0, 'end': 2.0, 'accent_word': 'pay', 'emotion': 'danger'},
         {'start': 10.0, 'end': 12.0, 'accent_word': 'brands', 'emotion': 'power'},
         {'start': 20.0, 'end': 22.0, 'accent_word': 'banned', 'emotion': 'danger'},
         {'start': 30.0, 'end': 32.0, 'accent_word': 'Liberate', 'emotion': 'power'},
         {'start': 40.0, 'end': 42.0, 'accent_word': 'worth', 'emotion': 'curiosity'}]
    caps = retime_captions(tr, m, [0, 60, 120, 180, 240], [60] * 5, 30)
    boxed = {c['text'] for c in caps if c.get('box')}
    assert boxed == {'pay.', 'banned.', 'Liberate'}
    # "three brands" is a count: a win, green and never boxed.
    assert next(c for c in caps if c['text'] == 'brands.')['accentColor'] == '#3EE06E'
    assert caps[-4]['text'] == 'Is'  # a cut that starts lowercase is capitalised


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
    out = _fit_trailer_budget([_mk(0, 20), _mk(30, 32, 4)], ws, 60, max_moment=15)
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


def test_trailer_brief_empty_and_filled():
    assert _trailer_brief('', '') == ''
    b = _trailer_brief("Don't Buy Real Estate", '  open on   Dubai ')
    assert "Don't Buy Real Estate" in b and 'Creator instructions: "open on Dubai"' in b
    assert 'hook lands' in b and 'first ~30' in b
    assert 'Favour soundbites' in _trailer_brief('T', stage='selects')


def said(line, start, sp=None, gap=0.3):
    """Words for a spoken line, 0.3s each, starting at `start`."""
    out, t = [], start
    for w in line.split():
        out.append({'word': w, 'start': round(t, 2), 'end': round(t + 0.25, 2), 'speaker': sp})
        t += gap
    return out


def span(ws):
    return {'start': ws[0]['start'], 'end': ws[-1]['end'] + 0.2}


def test_story_flags_answered_last_question():
    # e-commerce: "Can my investment go to zero?" then the guest answers it.
    hook = said("E-commerce is the new real estate.", 0, '1')
    q = said("Can my investment go to zero?", 10, '2')
    a = said("No, your investment can't go to zero, it's a business.", 20, '1')
    probs = _trailer_story_problems([span(hook), span(q), span(a)], hook + q + a)
    assert len(probs) == 1 and 'answer itself' in probs[0]
    # Ending on the question itself is the open loop.
    assert _trailer_story_problems([span(hook), span(q)], hook + q + a) == []


def test_story_allows_question_plus_guest_lead_in():
    hook = said("E-commerce is the new real estate.", 0, '1')
    last = said("Does it actually help me? So firstly, people need to have a mindset", 10, "2")
    last[5:] = [dict(w, speaker='1') for w in last[5:]]
    assert _trailer_story_problems([span(hook), span(last)], hook + last) == []


def test_story_flags_broken_endings_and_repeats():
    a = said("Give it ten years, everyone and their mother will do it.", 0, '1')
    b = said("everyone and their mother will do it. So what do you know", 10, '2')
    c = said("but in the back end it's like automated 80%,", 20, '1')
    probs = _trailer_story_problems([span(a), span(b), span(c)], a + b + c)
    assert any('Moment 1' in p and 'mid-sentence' in p for p in probs)
    assert any('repeat the same words' in p for p in probs)
    assert any('final moment stops mid-sentence' in p for p in probs)


def test_story_guest_opens_and_carries_half():
    host = said("This man has fifty clients and four meetings a week.", 0, '2')
    guest = said("I have an AI brain?", 10, '1')
    probs = _trailer_story_problems([span(host), span(guest)], host + guest, guest_sp='1')
    assert any('must speak first' in p for p in probs)
    assert any('at least half' in p for p in probs)
    assert _trailer_story_problems([span(host), span(guest)], host + guest) == []


def test_trim_lead_ins_drops_filler_and_false_starts():
    a = said("I'm telling you, I'm not like, actually I have maybe four meetings a week.", 0)
    b = said("Yeah, this is such a good point because I was at Amazon for years.", 10)
    c = said("But give it 10, 20, 30 years, everyone will do it.", 20)
    d = said("No, your investment can't go to zero.", 30)
    out = _trim_lead_ins([span(a), span(b), span(c), span(d)], a + b + c + d)
    assert out[0]['text'].startswith('I have maybe') and out[0]['start'] > a[6]['end'] - 0.01
    assert out[1]['text'].startswith('I was at Amazon')
    assert 'text' not in out[2] and 'text' not in out[3]


class _FakeResponse:
    def __init__(self, text):
        self.text = text
        self.usage_metadata = None


class _FakeClient:
    def __init__(self, text):
        self.models = self
        self._text = text

    def generate_content(self, **kw):
        return _FakeResponse(self._text)


def test_selects_returns_ad_sentences():
    sentences = [{'i': i, 's': i * 20.0, 'e': i * 20.0 + 4, 'text': 'x.'} for i in range(10)]
    reply = json.dumps({'soundbites': [{'from_i': 1, 'to_i': 2, 'role': 'credentials'}],
                        'ads': [{'from_i': 4, 'to_i': 6}, {'from_i': 0, 'to_i': 9}]})
    bites, _, ads = _select_soundbites(_FakeClient(reply), 'm', sentences, '', 20)
    assert bites[0]['role'] == 'credentials'
    assert ads == {4, 5, 6}  # a 3-minute "ad" is a bad tag and is ignored


def _guest_trailer():
    """A clean guest-episode trailer: guest 3 opens, alternates with host 1,
    and ends on the host's question plus the guest's first sentence."""
    lines = [("Four meetings a week, all optional.", 0, '3'),
             ("Are you sure he's the real deal?", 100, '1'),
             ("I was at Amazon for eight years.", 200, '3'),
             ("He runs fifty clients from his phone.", 300, '1'),
             ("The AI alone will not train your people.", 400, '3'),
             ("Do we need engineers like you?", 500, '1'),
             ("Systems thinking is the skill that matters.", 505, '3')]
    per = [said(t, at, sp) for t, at, sp in lines]
    return per, [span(p) for p in per]


def _flat(per):
    return [w for p in per for w in p]


def test_story_guest_trailer_passes_and_bare_question_fails():
    per, ms = _guest_trailer()
    assert _trailer_story_problems(ms, _flat(per), guest_sp='3') == []
    probs = _trailer_story_problems(ms[:-1], _flat(per[:-1]), guest_sp='3')
    assert any('bare question' in p for p in probs)


def test_story_guest_ending_must_be_guests_first_reply():
    per, ms = _guest_trailer()
    host_reply = [dict(w, speaker='1') for w in per[-1]]
    probs = _trailer_story_problems(ms, _flat(per[:-1]) + host_reply, guest_sp='3')
    assert any('not the guest' in p for p in probs)
    skipped = said("Well, let me think.", 502.5, '3')
    probs = _trailer_story_problems(ms, _flat(per) + skipped, guest_sp='3')
    assert any("skips the guest's first words" in p for p in probs)
    no = said("No, you do not need them.", 505, '3')
    probs = _trailer_story_problems(ms[:-1] + [span(no)], _flat(per[:-1]) + no, guest_sp='3')
    assert any('answer itself' in p for p in probs)


def test_story_flags_guest_monologue_run():
    per, ms = _guest_trailer()
    runs = [said("I built this with nothing but a laptop.", 600 + 20 * k, '3') for k in range(3)]
    order = [0, 1, 2] + ['r0', 'r1', 'r2'] + [5, 6]
    pick = lambda k: runs[int(k[1])] if isinstance(k, str) else per[k]
    per2 = [pick(k) for k in order]
    probs = _trailer_story_problems([span(p) for p in per2], _flat(per) + _flat(runs), guest_sp='3')
    assert any('guest moments in a row' in p for p in probs)
    assert any('like a monologue' in p for p in probs)


def test_story_credentials_early_and_challenge_with_question():
    per, ms = _guest_trailer()
    sents = [{'i': 0, 's': 200.0, 'e': 202.5, 'text': 'I was at Amazon for eight years.'},
             {'i': 1, 's': 400.0, 'e': 402.7, 'text': 'The AI alone will not train your people.'},
             {'i': 2, 's': 100.0, 'e': 101.9, 'text': "Are you sure he's the real deal?"},
             {'i': 3, 's': 300.0, 'e': 302.2, 'text': 'He runs fifty clients from his phone.'}]
    early = [{'from_i': 0, 'to_i': 0, 'role': 'credentials'}]
    late = [{'from_i': 1, 'to_i': 1, 'role': 'credentials'}]
    assert _trailer_story_problems(ms, _flat(per), '3', early, sents) == []
    assert any('who the guest is' in p for p in _trailer_story_problems(ms, _flat(per), '3', late, sents))
    # The challenge soundbite is a question (290s) and the line after it (300s):
    # a moment that keeps only the line after it drops the question.
    sents[2].update(s=290.0, e=291.9)
    chal = [{'from_i': 2, 'to_i': 3, 'role': 'challenge'}]
    probs = _trailer_story_problems(ms, _flat(per), '3', chal, sents)
    assert any('Moment 3' in p and 'without its question' in p for p in probs)


def test_story_flags_moment_starting_mid_sentence():
    a = said("E-commerce is the new real estate.", 0, '1')
    b = said("that's literally the proof in the pudding.", 10, '2')
    c = said("So what do you know?", 20, '2')
    probs = _trailer_story_problems([span(a), span(b), span(c)], a + b + c)
    assert any('Moment 1' in p and 'starts mid-sentence' in p for p in probs)
    trimmed = dict(span(b), lead_in_trimmed=True)
    assert _trailer_story_problems([span(a), trimmed, span(c)], a + b + c) == []


def test_budget_keeps_the_ending_question_with_its_reply():
    per, ms = _guest_trailer()
    ms = [dict(m, text=' '.join(w['word'] for w in p), p=3) for m, p in zip(ms, per)]
    out = _fit_trailer_budget(ms, _flat(per), target_seconds=5, slack=1.0, min_keep=4)
    assert out[-2]['text'].endswith('?') and out[-1]['text'].startswith('Systems')


def test_tag_endings_are_statements():
    assert not _text_is_question("It relates to delegation, right?")
    assert not _text_is_question("That's the whole game, you know?")
    assert _text_is_question("Is that right?")
    assert _text_is_question("So what do you know?")


def test_story_guest_reply_must_be_a_claim_not_filler():
    per, ms = _guest_trailer()
    mumble = said("This is, I think, like, related to delegation, right?", 505, '3')
    probs = _trailer_story_problems(ms[:-1] + [span(mumble)], _flat(per[:-1]) + mumble, guest_sp='3')
    assert any('filler, not a claim' in p for p in probs)


def test_code_ending_picks_title_question_and_guests_first_line():
    lines = [("You know what I'm saying?", 0, '1'), ("It is literally the best time.", 3, '3'),
             ("They think, \"Why is he not performing?\"", 50, '1'), ("It is not the tools at all.", 53, '3'),
             ("Do we actually need engineers like you?", 100, '1'),
             ("Systems thinking is the most important skill.", 104, '3')]
    words, sents = [], []
    for i, (t, at, sp) in enumerate(lines):
        w = said(t, at, sp)
        words += w
        sents.append({'i': i, 's': w[0]['start'], 'e': w[-1]['end'], 'text': t, 'sp': sp})
    built = _code_ending([], words, sents, '3', [], 'Ex-Amazon Engineer Running 50 Clients')
    assert built[0]['text'] == 'Do we actually need engineers like you?'
    assert built[1]['text'].startswith('Systems thinking')
    # Nothing clean left once the good exchange is taken.
    assert _code_ending(built, words, sents, '3', [], 'Engineer') is None


def test_story_flags_swearing_and_one_off_third_voice():
    per, ms = _guest_trailer()
    omar = said("Behind the scenes it is a shit show.", 700, '2')
    sents = [{'i': 0, 's': 100.0, 'e': 102.0, 'text': "Are you sure he's the real deal?", 'sp': '1'},
             {'i': 1, 's': 700.0, 'e': 702.0, 'text': 'Behind the scenes it is a shit show.', 'sp': '2'}]
    ms2 = ms[:4] + [span(omar)] + ms[4:]
    probs = _trailer_story_problems(ms2, _flat(per) + omar, '3', [], sents)
    assert any('swearing' in p for p in probs)
    assert any('never introduces' in p for p in probs)


def test_story_prefers_the_hosts_intro_as_credentials():
    per, ms = _guest_trailer()
    sents = [{'i': 0, 's': 200.0, 'e': 202.5, 'text': 'I was at Amazon for eight years.', 'sp': '3'},
             {'i': 1, 's': 900.0, 'e': 903.0, 'text': 'This brother consulted for Y Combinator.', 'sp': '1'},
             {'i': 2, 's': 100.0, 'e': 101.9, 'text': "Are you sure he's the real deal?", 'sp': '1'}]
    creds = [{'from_i': 0, 'to_i': 0, 'role': 'credentials'}, {'from_i': 1, 'to_i': 1, 'role': 'credentials'}]
    probs = _trailer_story_problems(ms, _flat(per), '3', creds, sents)
    assert any("host's introduction" in p for p in probs)


def test_trim_reported_question_to_the_question():
    a = said("Abu Jihad, like are you sure he's the real deal?", 0)
    out = _trim_lead_ins([span(a)], a)
    assert out[0]['text'].startswith("are you sure")


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all trailer-refine self-checks passed")
