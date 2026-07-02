# Trailer → DOAC alignment plan

Source material analyzed (from `~/Downloads/doac intro pod`):
- **3 real DOAC intros** (Robert Greene, Roman Yampolskiy/AI-safety, Tara Swart) with full episode transcripts
- **3 OpenShorts trailer outputs** (Ex-Amazon Engineer, Muslim Men & Women, Sheikh Uthman) with their source transcripts
- Deep-research report on DOAC's trailer process (Anthony Smith interviews + opening breakdowns)
- The current `TRAILER_PROMPT_TEMPLATE` (main.py) that produced the test outputs

---

## 1. What the real DOAC intros actually do

Reading the three reference intros as text, every one of them **reads as one coherent script**. You could hand the intro transcript to someone with no video and they'd follow the story. Concretely:

1. **Complete thoughts, not fragments.** Beats are ~4–12 seconds — full clauses and sentences. The AI-safety intro is ~100s with maybe 15 beats. There are NO sub-second word-splinters. The pace comes from *dialogue volleys*, not machine-gun cuts.
2. **Question → Answer pairs are the engine.** Steven's short questions are the connective tissue, and the guest's answer *always follows its question*: "Is stress contagious?" → cortisol answer. "So stress causes belly fat?" → "Belly fat that's really hard to shift." "What is your prediction for 2027?" → identity card, then predictions. Chronology is broken *between* themes, but Q→A adjacency is preserved *within* them.
3. **A narrated identity card, beat 2–3.** Every intro has a third-person credential block right after the hook: "Robert Greene is one of the best-selling authors in history…", "Dr. Roman Yampolskiy is a globally recognized voice on AI safety…", "Dr. Tara Swart. She's a neuroscientist, medical doctor… She's here to teach us how to…". In DOAC this lands with the music swell (`[Music]` marker sits right there in the AI-safety intro).
4. **Hooks are complete and concrete.** Openers are arresting *and* intelligible: the weightlifter-visualization story with the "13% increase in muscle mass" number; "I was convinced we could make safe AI, but… it's not something we can actually do." Specific numbers everywhere (99% unemployment, 8 billion lives, six bestsellers).
5. **Exactly ONE mid-sentence cut — the last one.** "confidence comes from—", "…this is what you should be doing in it. First,—", "It begs the question then, where do I start?" The open loop is the *ending device*, used once. Everything before it is coherent.
6. **Emotional arc = contrast turns**, not a checklist: hook → identity → claim/proof volleys → one vulnerability/stakes turn (Greene's stroke, 99% unemployment) → cliffhanger.
7. Intros run **~60–105s** even for full episodes.

## 2. What our output does instead

All three test intros are **word salad**. Symptoms (visible in `OpenOpusClips test result.txt`):

- Dozens of **sub-second cuts** (0.18s, 0.23s, 0.42s single words) — literally unintelligible splinters: "the / bloodline / of my / business".
- **Mid-sentence starts and ends everywhere**, not just the closer: "my business. They literally brought us into the red" as an opener.
- **Questions without answers, answers without questions** — no adjacency, so nothing lands.
- Credential material gets picked ("He worked for Richard Branson") but chopped into confetti.
- One test opens on rage-bait with broken grammar ("modern Muslim woman, I hate. Why did—") and another sits adjacent to an **in-episode ad read** (the halal-investment sponsor block) that the prompt never told the model to avoid.
- No music, no identity beat, no coherent read-through.

## 3. Root causes

| Cause | Where |
|---|---|
| Prompt demands "RAPID MONTAGE… 2–4s fragments… cut every 2.5–4s… MAY end mid-sentence" — this is the *opposite* of the reference intros and is what shredded the output | `TRAILER_PROMPT_TEMPLATE` |
| Model picks arbitrary start/end from raw word-timing JSON → boundaries land inside phrases; nothing snaps to sentence/clause boundaries or enforces a minimum duration | `get_trailer_moments` (no validation) |
| No Q→A pairing rule, no identity-beat rule, no "assembled text must read coherently" check, no sponsor/ad exclusion | prompt |
| 5 Ps enforced as a rigid checklist encourages scattering many unrelated fragments instead of a few coherent turns | prompt |
| Cuts at exact word timestamps → clipped audio at every joint; no padding, no crossfade | `assemble_trailer` |
| No music bed (the DOAC swell at the identity card is a large part of the feel) | assembly |

The DOAC formula memoized in our research (5 Ps, cut every 2.5–4s) was over-literalized. Anthony Smith's actual described process is **narrative-led, script-first**: read the transcript, write the trailer as a story, then cut. Cuts land on *new emotional information* every ~3–12s, not on a metronome.

**Why the earlier "longer clips" fix failed** (it was tried during the trailer build and reverted): it changed only the duration knob — "pick 5–14s full sentences" — without any coherence machinery. Longer incoherent picks are just slower word salad, and pacing got worse because nothing forced Q→A pairing, an identity beat, or a readable assembled script. The reference transcripts show the fix is *script coherence first*, with duration as a consequence: a coherent 8-beat script naturally lands at 4–10s per beat. Duration rules alone, in either direction, don't produce the DOAC feel.

## 4. The plan

### Phase 1 — Rewrite the selection prompt: script-first (the big lever)

Replace the montage prompt with a two-stage instruction *in one Gemini call*:

1. **Write the trailer script first.** "Draft the cold-open as a script using ONLY verbatim spans from the transcript. Read it back: it must read as one coherent, gripping piece of text a listener can follow with no video."
2. **Then map each script line to timestamps** (start/end from the word timings).

New structural rules (replacing the 2–4s montage block):

- Moments are **complete thoughts**: full clause or sentence(s), typically **3–10s**, hold up to ~15s for a heavy story. For a 60s trailer expect **8–14 moments** (not 15–22).
- **Q→A adjacency:** if you include a host question, the guest's actual answer must be the very next moment.
- **Identity beat required** at position 2–3: the strongest host-spoken line naming the guest and why they matter (from the episode's own intro if available).
- **Opener:** the single most arresting *complete* line — a shocking claim, a number, a confession, or a fascinating question. Must be intelligible with zero context.
- **Exactly one mid-sentence cut: the final moment.** Everything else ends on a sentence/clause boundary.
- **Exclude** sponsor reads, ads, housekeeping ("subscribe", "welcome back"), and crosstalk.
- Keep the 5 Ps but demote them to "emotional arc guidance" (hook → identity → proof → stakes/vulnerability turn → cliffhanger), not a quota.
- Keep `accent_word`/`emotion` per moment (caption pipeline already consumes it).
- Add the assembled script to the JSON output (`script` field) so we can log/QA it.

Also: feed Gemini a **sentence-grouped transcript** (sentences with start/end + word timings kept only for the final boundary refinement) instead of the raw word array — forces sentence-level thinking and cuts tokens massively.

Retune presets: `punchy` ≈ 6–9 moments / 35s, `standard` ≈ 8–14 / 60s, `extended` ≈ 12–18 / 90s.

### Phase 2 — Deterministic validation + boundary snapping (make bad output impossible)

In `get_trailer_moments`, after parsing:

- **Reject/repair any moment < 2.0s** (except the final cliffhanger, min ~1.2s): expand to the enclosing sentence boundaries from the transcript, or drop it.
- **Snap start to a word start and end to a word end**, then pad ±120–200ms, extending into silence (gap to neighboring words) when available.
- Drop overlapping/duplicate moments; verify `accent_word` appears in the span; clamp to video bounds.
- **Coherence gate:** assemble the selected spans' text and log it. Optionally a cheap second Gemini pass: "Does this read as one coherent trailer? If not, return the moment indices to drop/reorder." Retry once on failure.

### Phase 3 — Assembly polish (audio joints)

- **~40ms audio crossfade** (or per-segment micro fade-in/out) at every joint in `assemble_trailer` to kill the clicks and clipped-word feel that exact-timestamp cuts produce.
- Keep hard visual cuts + final fade-to-black (already correct).

### Phase 4 — Music bed (the missing DOAC signature — after 1–3 land)

- One licensed/royalty-free tension bed (minor key, 70–110 BPM) mixed under the dialogue with ducking; swell entering at the identity beat, drop to silence ~200ms before the final cliffhanger line. Start with a single bundled track + volume envelope in the remotion comp; a track picker can come later.

### Phase 5 — Eval loop

- Re-run the same three test videos, paste the assembled `script` text next to the three real DOAC intros, and judge with one question: **"Can you read it and follow it?"** That's the metric that currently fails. Iterate the prompt until all three pass, then check per-moment durations (target median 4–8s) and the ending (single open loop).

### Phase 1b — Hook selection = "the unexpected" (added after 2nd eval)

The first real run opened on *"There's a conspiracy… an actual conspiracy"* (an abstract thesis) while the genuinely arresting line — *"The modern Muslim woman, I hate"* — was buried in the middle. Two causes, both in the prompt:
- The hook rule said "most arresting **claim**," which the model read as "topic-framing sentence."
- The arc guidance listed a "vulnerability turn" in the middle, so the model filed the gut-punch line there instead of at position 1.

Ground truth is the Ant Smith editor breakdown (`~/Downloads/doac intro pod/Meet The Viral Editor Behind Steven Bartlett.pdf`): the hook's theme is **THE UNEXPECTED** — the "did they really just say that?" line that catches a bored scroller off guard (his examples: Simon Cowell welling up, Ramit Sethi yelling "this is driving me insane," "5 BILLION PEOPLE would be DEAD"). It must land emotionally **on its own with zero setup**; if the next line has to explain it, it's not the hook. Fix (done): rewrote THE HOOK rule to demand the single most shocking/taboo/vulnerable **self-contained** line FIRST and explicitly ban opening on a thesis/topic-definition; reframed the arc as Ant's "emotional rollercoaster" with the shock always leading. The PDF also confirms the rest of the system we already encoded: 4 elements (Hook → Lesson → Emotional Rollercoaster → Cliffhanger), transcript-in-a-text-doc script-first workflow, and "don't open on B-roll."

### Phase 1c — Cliffhanger must WITHHOLD, not resolve (added after 3rd eval)

The hook-fixed run opened correctly on "The modern Muslim woman, I hate" but *ended* on "they're afraid to take that risk" — a complete, resolved answer with nothing withheld. The old rule ("cut off mid-thought on a word boundary") was satisfied in letter but missed the mechanic: a cliffhanger cuts right *before* the payoff (the answer/number/name/list) or ends on an unanswered question, leaving a burning gap (per the DOAC breakdown + the user's cliffhanger research: "cut abruptly right before a major revelation"; Annie Jacobsen's "80% of women need—" with the answer withheld). Fix (done): rewrote the final-moment rule to demand a real unresolved cliffhanger — (a) cut before the payoff lands, or (b) end on an open question — with an explicit ban on ending on any resolved/conclusive statement, plus "hunt the transcript for the best withheld-payoff/open-question line and place it last." Also nudged the arc to seed multiple open loops throughout. Pure prompt change; the deterministic refine already supports both forms (open question → sentence boundary; mid-thought cut → final keeps model end).

### Phase 2 — Best-of-3 + flash judge (added after 4th eval)

Prompt-only steering hit its ceiling: even with the hook/cliffhanger rules in place, gemini-2.5-flash complied *inconsistently* run-to-run — one run leaked crosstalk filler ("okay? yeah? exactly, uh") and ended on a resolved label ("Sunken cost fallacy") instead of a cliffhanger. These are instruction-following failures, not boundary bugs. Fix (done): `get_trailer_moments` now samples `TRAILER_CANDIDATES` (=3) selections and a flash **judge** (`_judge_trailer_candidates`, `TRAILER_JUDGE_TEMPLATE`) picks the winner, weighted hardest on the two dims flash fails — a real unresolved cliffhanger and no filler. Deterministic fallback (`_deterministic_best_trailer`: filler-ratio + resolved-ending penalty) covers a judge outage. Each candidate still runs the full validate → verbatim-align → refine pipeline; unusable candidates are skipped, and only all-fail raises. Cost ≈ 4× (~$0.05/trailer, still cents); adds ~3 sequential flash calls of latency. Reused the extracted `_generate_trailer_candidate` / `_trailer_cost` / `_strip_json_fence` helpers (removed the old duplicated cost/parse block). If judge quality proves the bottleneck, next lever is a stronger *judge* model (2.5-pro) rather than more candidates.

### Phase 2b — Single-shot on Gemini 3 Flash (current)

Eval of best-of-3 showed the identity-filler opener and "Sunken cost fallacy" ending persisted *across every run* — a systematic flash bias the judge shared, not variance best-of-N can fix. So we switched selection to `gemini-3-flash-preview` (`TRAILER_MODEL`, env-overridable) and dropped to single-shot (`TRAILER_CANDIDATES=1`; judge auto-skipped). Cost ~$0.06/trailer. Cost logging made model-aware (`_GEMINI_PRICING`). Best-of-N code retained behind the env var. Eval result (98s run): 3 Flash FIXED the filler bug and improved the hook (run-up clause before the punch), but overshot length badly (98s vs 60s target, worse than either 2.5 run) and the cliffhanger shape is right (unanswered question) but delivered via a stuttering/ungrammatical setup line rather than a clean cut. Net: traded one failure class for another, not a clear win yet. Next: one more eval on a DIFFERENT source video to rule out "this transcript is just hard"; if length overshoot repeats, add a deterministic hard cap to `_refine_trailer_moments` (truncate to `max_moments`) rather than more prompt tuning. If 3 Flash still underperforms after that, try `TRAILER_MODEL=gemini-3.5-flash-preview`.

Eval #2 (79s run, different source video — a live panel intro): user caught a real bug — the IDENTITY CARD rule accepted a flat as-spoken roll-call ("to my right I have X, to my left Y...") because it technically "introduces a named guest." Fixed: IDENTITY CARD now requires real dramatic weight (a specific achievement/credential/stakes) and explicitly bans roll-call intros, with "no identity card beats a boring one." Also observed this run: opening hook regressed (dropped into a mid-sentence Arabic-script fragment, not a self-contained shock line) and length overshot again (79s vs 60s, 3rd run in a row over target — confirms a pattern, not a one-off). Cliffhanger was the best yet (clean unresolved either/or question). Open items: (1) length compliance, (2) hook-opener reliability. Length is now a repeat-3x pattern — next step should probably be a deterministic `max_moments` cap in `_refine_trailer_moments` rather than more prompt tuning, pending user decision.

### Phase 2c — Gemini 3.5 Flash (best result yet)

Switched `TRAILER_MODEL` default to `gemini-3.5-flash` (GA, no `-preview` suffix; ~3x the cost of 3-flash, ~$0.17-0.20/trailer at our ~112k-input-token selection call). Eval (59.8s run, same "Muslim Men & Women" video): length hit the 60s target almost exactly (first run in 5 tries to land on target — the systematic overshoot pattern from 2.5/3-flash is gone), hook reliably excellent (run-up-then-punch, reproduced from the best 3-flash run), zero filler/crosstalk, clean credibility beat, and genuinely good argumentative escalation between moments (not just juxtaposition). Only remaining gap: the cliffhanger is a real question but generic/rhetorical rather than a sharp unresolved gap tied to what the trailer set up — narrower miss than prior runs. Current recommendation: keep `gemini-3.5-flash` as the default; the quality jump over 3-flash is real, not marginal, and worth the ~3x cost. Next candidate fix if wanted: sharpen the cliffhanger rule to require the final question specifically reference/pay off something already raised in the trailer, not a generic "what do you think" prompt.

### Sequencing

Phase 1+2 are one PR (`feature/trailer-doac-coherence`) and should fix ~80% of the gap. Phase 3 is a small follow-up PR. Phase 4 only after the script quality is right — music can't save an incoherent cut (the research says exactly this).
