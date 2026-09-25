# The plan file (plan.json)

The plan is the whole edit. Both finishing paths read it: `render.py` (Python) and `hyperframes.py` (HyperFrames).
Editorial choices live here and nowhere else, so changing the trailer means editing this file and re-rendering.

```jsonc
{
  "source": "original.mp4",          // relative to the plan file, or absolute
  "transcript": "transcript.json",   // from transcribe.py
  "aspect": "16:9",                  // "16:9" (full two-shot, default) or "9:16" (speaker crop, run track.py)
  "topic": "e-commerce as an asset class",   // the one thing this episode is about (for you, not the renderer)
  "genre": "interrogation / thriller",
  "guest": "Jamal",                  // the main guest (guest episodes and guest plus panel): exactly the label used in the bites' "speaker"; review.py checks their share
  "names": {"Book buyer": "Abu Malik"},   // optional: the name as spoken, for a speaker label that isn't their name (review.py looks for it in the intro)
  "music": "track.mp3",              // optional licensed track, laid quietly under the dialogue; no key = no music
  "music_db": -24,
  "sounds": {"boom": {"heygen": "deep trailer boom"}},   // optional: what sfx.py searches for, or {"boom": "my-boom.wav"}
  "colors": {"red": [237, 41, 57]},   // optional: retune a highlight colour (red, yellow, green, pink, gold, box)
  "bites": [ { ... }, ... ]          // in trailer order
}
```

## Bite keys

| Key | Required | Meaning |
|-----|----------|---------|
| `id` | no | Label shown in logs (defaults to 1, 2, 3...) |
| `role` | yes | Its job in the story: `hook`, `challenge`, `premise`, `sell-guest`, `value`, `pushback`, `stakes`, `admission`, `cliffhanger`... |
| `speaker` | yes | Who is talking. Use one short label per person, identical on every bite, so `review.py` can add up each person's share. Use their name when it's said ("Murad"), else a role ("Host", "Book buyer"). Put descriptions in `notes`, not here |
| `start`, `end` | yes | Source seconds. Start at a sentence start, end after the sentence's last word. `snap.py` refines both |
| `why` | yes | One line: what this bite does for the viewer. If you can't write it, cut the bite |
| `cap_start`, `cap_end` | no | Only caption words spoken inside this window (default: the bite). Use to drop a stray word from the other speaker at an edge |
| `drop` | no | Words to leave out of the captions (e.g. a greeting, a name the transcript mangles) |
| `drop_times` | no | Leave out the word starting at these source times (for one repeated word, "I I") |
| `fix` | no | `{"heard": "correct"}` whole-word caption fixes, also for punctuation: `{"that": "that?"}`. Changes every copy of that word in the bite |
| `introduces` | no | On an intro bite: the `speaker` label of the person it introduces (`"Murad"`). `review.py` checks that everyone who speaks twice has one, and that their name is in it |
| `fix_times` | no | `{"1085.42": "helped"}` replaces just the one word that starts at that source time |
| `auto_big` | no | `false`: blocks in this bite with none of your `big` words get no huge word (instead of an automatic pick) |
| `lock` | no | `true`: `snap.py` leaves this bite's start/end alone (use after placing a cut by hand) |
| `big` | no | Words shown huge (Anton caps). One per caption line is ideal: numbers, the topic word, the emotional word. If missing, the longest non-filler word is picked |
| `accent` | no | Coloured words, any role: `{"not": "red", "money": "box"}`. Colours: `red`, `yellow`, `green`, `pink`, `gold`, `box` (white word on a red box). A list (`["money"]`) picks each colour by meaning. Colour a word in almost every block (see editorial.md, Captions) |
| `auto_accent` | no | `false`: blocks in this bite with no `accent` word stay white (otherwise their big word gets an automatic colour) |
| `gap` | no | Pause (seconds) that starts a new caption block (default 0.5). Raise it if a slow speaker's lines get split |
| `fade_in`, `fade_out` | no | Edge fade in seconds (default 0.025). Use 0.08-0.12 when another voice starts right on top of the last word |
| `boom` | no | `true`: a deep impact that hits on the bite's first frame. Use on 2-4 turns (the hook, the guest reveal, the stakes) |
| `whoosh` | no | `true`: a whoosh that peaks on the cut into this bite. For a change of scene or mood, one or two per trailer |
| `riser` | no | Seconds (or `true` = 2.5): a build that starts that long before this bite and peaks on its first frame. At most one, into the biggest turn |
| `focus_pull` | no | Seconds of blur-to-sharp at the bite start ("perfect imperfection"). 0.4-0.6 on one or two bites |
| `zoom` | no | `[1.0, 1.06]` slow push-in on this bite. Off by default. Don't use unless asked: people want both faces in shot |
| `cx`, `cy` | 9:16 only | Where the speaker sits (0-1). `track.py` fills in `track` from this |

Preview the captions without rendering: `python3 scripts/captions.py plan.json` prints every block, with BIG words in caps and each coloured word followed by its colour, like `[MONEY]<box>`.

Sounds come from HyperFrames' sound library (`sfx.py`): HeyGen's library when signed in, otherwise HyperFrames' bundled free effects. `sounds` changes what is searched for per kind (`heygen` search words, `bundled` file name), or points a kind at your own file.

## Rules the scripts enforce for you
- Captions only ever sit in the lower third, and `review.py` flags any caption that covers a face.
- Every cut gets 25 ms fades, the dialogue is normalised to -14 LUFS, and each sound effect is levelled so dialogue plus effects never go above -1 dB.
- Music (only if you set `music`) drops out just before the last bite, and the video holds on black for 1.2 s after it.
