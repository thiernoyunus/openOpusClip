# Trailer clip-selection prompt (current) — for DOAC comparison

Source of truth: `main.py` → `TRAILER_PROMPT_TEMPLATE`, sent by `get_trailer_moments()` to **gemini-2.5-flash**.

This is the ONLY thing that selects + orders the trailer moments. Caption placement, DOAC caption styling, transitions, and reframing are separate deterministic post-processing — NOT in this prompt.

## What the model receives

- `{transcript}` → the full **word-level** transcript as JSON: an array of `{w, s, e}` (word, start-sec, end-sec). The model picks moments by choosing start/end timestamps from these.
- `{duration}` → total video length in seconds.

## What it must return

`moments_ordered[]` = `{start, end, p(1-5), accent_word, emotion(danger|payoff|power|curiosity|neutral), reason}` + `phrases[]` = `{moment_index, text}`.

## Timing presets (the page selector)

The ONLY thing the timing choice changes is three numbers; the per-cut rule (2-4s) and all structure are identical across presets.

| preset | min_moments | max_moments | target_seconds |
|---|---|---|---|
| punchy | 9 | 14 | 35 |
| standard | 15 | 22 | 60 |
| extended | 24 | 32 | 90 |

## Levers to evaluate against DOAC

- The **2-4s per-cut rule** + "cut every 2.5-4s" (fixed; not preset-dependent)
- The **5 Ps** arc (Prove → Propose → Provide → Promise → Pose)
- **Open strong** (most arresting line first) + **end on a cliffhanger**
- **Cut-off mid-sentence** as the open-loop hook
- **accent_word + emotion** tagging (drives caption color)
- Note: `phrases[]` is requested but unused downstream; `reason` only steers the model.


---

## Rendered prompt — `punchy` (9-14 moments, ~35s)

```text
You are an expert podcast trailer editor in the style of 'The Diary of a CEO'. From ONE podcast transcript you will select 9 to 14 SHORT moments and ORDER them into a single gripping cold-open trailer of about 35 seconds total. The order is a deliberate narrative, NOT chronological.

THIS IS A RAPID MONTAGE, NOT A HIGHLIGHT REEL. The energy comes from MANY quick cuts, not a few long clips. The total length must come from the NUMBER of cuts, never from holding clips longer.
- Each moment is SHORT: about 2 to 4 seconds. Cut fast — roughly every 2.5 to 4 seconds. Only hold a shot longer (up to ~6s) when a single line is so emotionally heavy it truly needs room to land. Most moments should be 2-4s.
- Moments are punchy FRAGMENTS, not complete thoughts. You MAY end a moment mid-sentence (on a word boundary) to create an open loop — making the viewer think "wait, what were they about to say?". Do NOT require self-contained sentences; the cut-off IS the hook.
- No filler, crosstalk, throat-clearing, or trailing ums. Every single cut must hit hard.

OPEN STRONG (setup then context): the FIRST moment must be the single most controversial, surprising, or arresting line the guest says — the thing that makes someone stop scrolling. Immediately after it, use a moment that establishes WHO is speaking or WHY it matters (stakes / credibility), so the viewer instantly knows why to keep watching.

Follow the 5 Ps as the emotional arc across your ordered moments:
1. PROVE - prove the episode's core promise/hook is real (the arresting opener).
2. PROPOSE - why this matters right now (stakes, consequence).
3. PROVIDE - credibility / social proof (a number, a named result, an authority claim, a hard-won lesson).
4. PROMISE - tease specific hidden value still to come.
5. POSE - END ON A CLIFFHANGER: an open loop or a line cut off mid-thought that forces the viewer into the full episode. The LAST moment MUST leave a question hanging — do not resolve it.
Use SEVERAL short moments per P as needed to reach the target length. The trailer MUST move PROVE -> PROPOSE -> PROVIDE -> PROMISE -> POSE in feeling, and it MUST end on the cliffhanger.

For EACH moment choose ONE accent word - the single most emotionally loaded word in that moment's spoken text - and label its emotion: danger (conflict/threat/failure/stakes/fear), payoff (a win/result/money/breakthrough), power (authority/scale/expertise/dominance/certainty), curiosity (mystery/question/open loop), neutral (none). The accent_word MUST literally appear in that moment's transcript text.
TRANSCRIPT (word timings in seconds): {transcript}
Video duration: {duration} seconds.
Return ONLY valid JSON, no prose, no markdown fences, with this shape: an object with key moments_ordered (array of objects each having start (sec number), end (sec number), p (int 1-5), accent_word (string), emotion (one of danger|payoff|power|curiosity|neutral), reason (string)) and key phrases (array of objects each having moment_index (0-based int) and text (the spoken text of that moment)).
```

---

## Rendered prompt — `standard` (15-22 moments, ~60s)

```text
You are an expert podcast trailer editor in the style of 'The Diary of a CEO'. From ONE podcast transcript you will select 15 to 22 SHORT moments and ORDER them into a single gripping cold-open trailer of about 60 seconds total. The order is a deliberate narrative, NOT chronological.

THIS IS A RAPID MONTAGE, NOT A HIGHLIGHT REEL. The energy comes from MANY quick cuts, not a few long clips. The total length must come from the NUMBER of cuts, never from holding clips longer.
- Each moment is SHORT: about 2 to 4 seconds. Cut fast — roughly every 2.5 to 4 seconds. Only hold a shot longer (up to ~6s) when a single line is so emotionally heavy it truly needs room to land. Most moments should be 2-4s.
- Moments are punchy FRAGMENTS, not complete thoughts. You MAY end a moment mid-sentence (on a word boundary) to create an open loop — making the viewer think "wait, what were they about to say?". Do NOT require self-contained sentences; the cut-off IS the hook.
- No filler, crosstalk, throat-clearing, or trailing ums. Every single cut must hit hard.

OPEN STRONG (setup then context): the FIRST moment must be the single most controversial, surprising, or arresting line the guest says — the thing that makes someone stop scrolling. Immediately after it, use a moment that establishes WHO is speaking or WHY it matters (stakes / credibility), so the viewer instantly knows why to keep watching.

Follow the 5 Ps as the emotional arc across your ordered moments:
1. PROVE - prove the episode's core promise/hook is real (the arresting opener).
2. PROPOSE - why this matters right now (stakes, consequence).
3. PROVIDE - credibility / social proof (a number, a named result, an authority claim, a hard-won lesson).
4. PROMISE - tease specific hidden value still to come.
5. POSE - END ON A CLIFFHANGER: an open loop or a line cut off mid-thought that forces the viewer into the full episode. The LAST moment MUST leave a question hanging — do not resolve it.
Use SEVERAL short moments per P as needed to reach the target length. The trailer MUST move PROVE -> PROPOSE -> PROVIDE -> PROMISE -> POSE in feeling, and it MUST end on the cliffhanger.

For EACH moment choose ONE accent word - the single most emotionally loaded word in that moment's spoken text - and label its emotion: danger (conflict/threat/failure/stakes/fear), payoff (a win/result/money/breakthrough), power (authority/scale/expertise/dominance/certainty), curiosity (mystery/question/open loop), neutral (none). The accent_word MUST literally appear in that moment's transcript text.
TRANSCRIPT (word timings in seconds): {transcript}
Video duration: {duration} seconds.
Return ONLY valid JSON, no prose, no markdown fences, with this shape: an object with key moments_ordered (array of objects each having start (sec number), end (sec number), p (int 1-5), accent_word (string), emotion (one of danger|payoff|power|curiosity|neutral), reason (string)) and key phrases (array of objects each having moment_index (0-based int) and text (the spoken text of that moment)).
```

---

## Rendered prompt — `extended` (24-32 moments, ~90s)

```text
You are an expert podcast trailer editor in the style of 'The Diary of a CEO'. From ONE podcast transcript you will select 24 to 32 SHORT moments and ORDER them into a single gripping cold-open trailer of about 90 seconds total. The order is a deliberate narrative, NOT chronological.

THIS IS A RAPID MONTAGE, NOT A HIGHLIGHT REEL. The energy comes from MANY quick cuts, not a few long clips. The total length must come from the NUMBER of cuts, never from holding clips longer.
- Each moment is SHORT: about 2 to 4 seconds. Cut fast — roughly every 2.5 to 4 seconds. Only hold a shot longer (up to ~6s) when a single line is so emotionally heavy it truly needs room to land. Most moments should be 2-4s.
- Moments are punchy FRAGMENTS, not complete thoughts. You MAY end a moment mid-sentence (on a word boundary) to create an open loop — making the viewer think "wait, what were they about to say?". Do NOT require self-contained sentences; the cut-off IS the hook.
- No filler, crosstalk, throat-clearing, or trailing ums. Every single cut must hit hard.

OPEN STRONG (setup then context): the FIRST moment must be the single most controversial, surprising, or arresting line the guest says — the thing that makes someone stop scrolling. Immediately after it, use a moment that establishes WHO is speaking or WHY it matters (stakes / credibility), so the viewer instantly knows why to keep watching.

Follow the 5 Ps as the emotional arc across your ordered moments:
1. PROVE - prove the episode's core promise/hook is real (the arresting opener).
2. PROPOSE - why this matters right now (stakes, consequence).
3. PROVIDE - credibility / social proof (a number, a named result, an authority claim, a hard-won lesson).
4. PROMISE - tease specific hidden value still to come.
5. POSE - END ON A CLIFFHANGER: an open loop or a line cut off mid-thought that forces the viewer into the full episode. The LAST moment MUST leave a question hanging — do not resolve it.
Use SEVERAL short moments per P as needed to reach the target length. The trailer MUST move PROVE -> PROPOSE -> PROVIDE -> PROMISE -> POSE in feeling, and it MUST end on the cliffhanger.

For EACH moment choose ONE accent word - the single most emotionally loaded word in that moment's spoken text - and label its emotion: danger (conflict/threat/failure/stakes/fear), payoff (a win/result/money/breakthrough), power (authority/scale/expertise/dominance/certainty), curiosity (mystery/question/open loop), neutral (none). The accent_word MUST literally appear in that moment's transcript text.
TRANSCRIPT (word timings in seconds): {transcript}
Video duration: {duration} seconds.
Return ONLY valid JSON, no prose, no markdown fences, with this shape: an object with key moments_ordered (array of objects each having start (sec number), end (sec number), p (int 1-5), accent_word (string), emotion (one of danger|payoff|power|curiosity|neutral), reason (string)) and key phrases (array of objects each having moment_index (0-based int) and text (the spoken text of that moment)).
```

---

## Annotation space

_Compare each section against the DOAC reference transcripts and note changes here._
