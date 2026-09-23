# Picking the story

This is the part that makes or breaks the trailer. The scripts only cut what you choose.
It is written from the trailer Yunus called "the absolute best" (a 91 s e-commerce episode cut, v3), from what went wrong in the cuts before it, and from DOAC's lead trailer editor.

## 1. Read the episode before choosing anything
Read all of `transcript.txt`, in chunks. Then write these down, with timestamps:
- **The one topic.** What is this episode actually about? Say it in five words, as if it were the YouTube title. Every bite you pick will be about this. (In v3 it was "Is e-commerce a real asset class?", not "investing" or "business".)
- **Who is who.** The host, the guest(s), any co-hosts, and what makes each worth listening to: exits, money managed, years, famous clients. The transcript has no speaker names. For each voice:
  1. Find a line where the transcript makes the speaker obvious ("Today I have brother X…", "Sam, you…").
  2. Run `frames.py original.mp4 who.jpg --burst MM:SS …` there, and see whose mouth and hands move across the three frames.
  3. Note what they look like (clothes, glasses, seat, camera) so you can recognise them at other timestamps.
  People are often never named, or two share a name. Label them by role ("the host", "Muhammad, the construction partner") and never guess a name.
- **What kind of episode it is.** This decides whose voice carries the trailer:
  - **Guest episode:** the host introduces someone as the guest or the expert ("Today I have…", "he's been in this space since 2018"), and the conversation is about what they know. The trailer is **guest-led** (see the table below).
  - **Panel or regular episode:** the usual hosts or a group discuss a topic, and nobody is brought in as the expert. Share the trailer between the strongest voices.
  Write down which it is, and the guest's name or label, before listing candidates.
- **The premise.** The one or two sentences that tell a stranger what this conversation is. Often in the host's intro.
- **The central question** the episode keeps coming back to.
- **Specific numbers**, such as "$10,000 a month", "quarter of a billion", "three exits". Specific numbers feel true.
- **Friction.** Pushback, disagreement, skeptics, hard questions, the host challenging the guest.
- **Stakes and admissions.** Risks, failures, personal stories ("that's happened to me"), anything said for the first time.
- **Open questions.** Lines that ask something important, where the answer comes later. These are your cliffhanger candidates.
- **What to skip.** Sponsor reads and ads (often shot elsewhere, sometimes with their own burned-in captions), the intro/outro housekeeping, and quotes of other famous people's opinions.

Then list 25-40 candidate lines with timestamps, a role and the speaker for each. In a guest episode, at least half the candidates should be the guest's own lines. Use `words.py transcript.json --find "phrase"` to jump to a line.

## 2. Build the arc
Aim for 60-95 seconds and 12-16 bites. Most bites run 2-15 s.

**Guest episodes are guest-led.** The guest is why people click. DOAC weights the guest at about 50% of what makes an episode work.
- The guest's own voice fills **at least half the trailer's running time**, spread across the whole trailer rather than one run of bites together.
- The guest should own the big moments: the hook claim (or the answer to the challenge in it), the moment of value, the proof or story, and the stakes.
- The host and co-hosts do the job a DOAC host does. They introduce the guest, ask the questions, push back, react, and usually ask the closing question.
- A good rhythm is host question or pushback (short), then the guest's answer (longer), then host reaction or challenge, then the guest again.
- Check with `review.py`, which prints each speaker's share of the running time. If the guest is under 50%, swap host lines for guest lines that make the same point.

This order worked:

Role names are free labels: `hook`, `challenge`, `premise`, `frame`, `sell-guest`, `question`, `value`, `proof`, `twist`, `pushback`, `stakes`, `admission`, `cliffhanger`. They describe the job the bite does.

| Part | Time | What it does |
|------|------|--------------|
| **Hook** | 0-20 s | A bold, specific claim about the topic, then a reaction or challenge from the other side ("what gives you so much confidence?"). It must make you want the answer, and must not give it away. The strongest hook is usually the claim nobody expects from that speaker: the AI expert saying "AI is not going to make you money", or the investor saying "your investment can go to zero". Rank your hook candidates on surprise, specificity and the topic word, and open with the winner. |
| **Frame** | by ~30 s | The premise, in the host's words if possible, so a stranger knows what the conversation is. |
| **Sell the guest** | by ~40 s | Credentials with numbers. It's best when someone else says them (the host introducing them). Everyone who speaks twice or carries the conflict needs to be introduced: a guest, a co-host, a skeptic. Use one short line each ("manages a quarter of a billion", "20 years in construction"). If there's no such line for someone, give their bites to someone else or cut them. An unknown voice arguing carries no weight. |
| **The question** | | The central question, asked out loud. This turns the setup into the debate. |
| **Moment of value** | | One genuinely useful idea given away free (a definition, a rule, a framework). |
| **Conflict** | | Pushback: "Personally, no, not yet", "merciless due diligence". The trailer needs friction. |
| **Stakes** | | Risk, admission, a personal story with a concrete detail ("my Facebook profile gets banned out of nowhere"). |
| **Cliffhanger** | last 2-4 s | A short question or setup that the episode answers and the trailer doesn't. Cut to black right after it. |

## 3. Tests every bite must pass
- **On topic.** Is it about the one topic? A great line about something else still gets cut. v2 lost points because it drifted into general investing talk.
- **Complete sentence.** Start where a sentence starts ("And..." or "But..." is fine), and end after its last word. Never end mid-thought. Check each edge with `words.py transcript.json START-END`.
- **Justified.** You can write its `why` in one line. If you can't, cut it.
- **Bridges.** Read the running order out loud as a script. Each line should follow from the one before, like one conversation. If it jumps, reorder, or add a short bridge line (a question, a "but").
- **Guest share.** In a guest episode, is the guest speaking for at least half the running time, in more than one place? If the guest only speaks once or twice, it's the host's trailer, not the guest's.
- **Doesn't answer its own cliffhanger.** No later bite may resolve the last question.

## 4. Mistakes we've already made
- **Opening with the answer.** An earlier cut opened with "No, your investment can't go to zero", which kills the tension. The same question worked as the last line, left unanswered.
- **Topic drift.** Twelve great lines on five topics feel like a highlight reel, not a trailer.
- **No context.** Without the premise, viewers don't know why the argument matters.
- **Unknown guests.** If nobody says who they are, their claims carry no weight.
- **The guest barely speaks.** The first cut of the AI episode gave the guest one moment (two bites back to back) and the host seven bites. The guest was introduced well, then went quiet. In a guest episode the guest's ideas are the product: let the guest carry it.
- **Zoom and crop on a two-shot podcast.** People want both faces in view. Keep the full frame in 16:9, exactly as each camera shot it. That also holds when four people are on two alternating two-shot cameras.
- **Trusting Whisper's word times at an edge.** Filler words ("Yeah", "I") are sometimes stretched over a second, so a cut placed from `words.py` can clip the next word. `check_audio.py` catches this. When it happens, re-transcribe a 2 s clip around the cut, place the edge by hand, and add `"lock": true`.
- **A great line the episode never resolves.** A bet or challenge that is set up but never settled (e.g. "I'll put you up against my editor") is clickbait as a cliffhanger. Use it only if the episode pays it off.
- **Cuts in the middle of speech.** Run `snap.py` and fix any cut it flags.
- **Stray words from the other speaker** at a bite's edge showing up in captions. Use `cap_start`/`cap_end` or `drop`.

## 5. Captions
- One `big` word per caption line: the number, the topic word, or the emotional word.
- `accent` (gold) goes on the topic word and on the highest-stakes word. Use it 2-4 times in the whole trailer.
- Fix the transcript's mistakes with `fix`: names, brand words, and missing question marks.

## 6. Sound
- `boom` on 2-4 turning points (the hook, the guest reveal, the stakes).
- For a real release, choose a licensed track that fits the genre (thriller, interrogation, rags-to-riches) and set `music` in the plan. The synth pad is only a placeholder.

## From DOAC's lead trailer editor
- Every element must be justified. If it's only there to look cool, cut it.
- Respect the audience: the episode must pay off the hook. No clickbait.
- The hook can be slow and long, if it also establishes who the guest is.
- Treat each trailer as a genre (thriller, rom-com, conspiracy) and cut to it.
- Structure: A (rise) → B (conflict) → C (cliffhanger), cut just before C resolves.
- Reactions work like a laugh track: the host's shock gives the viewer permission to feel it.
- "Perfect imperfection": a focus pull (`focus_pull`) on one or two bites makes it feel raw.
- Specific numbers and exclusives ("I've never told anyone this") pull people in.
