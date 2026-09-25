---
name: doac-podcast-trailer
description: Cut a Diary of a CEO style trailer (60-95 s, 16:9 two-shot, DOAC captions) from any full podcast episode. Use when someone sends a podcast video or link and wants a trailer, teaser or intro cut from it.
---

# DOAC Podcast Trailer

Turns one full podcast episode into a 60-95 second trailer. The trailer is built around the episode's one topic: it sells the guest, gives away one useful idea, builds friction, and ends on an unanswered question.

The editing judgment is yours. The scripts do the mechanics.
Read `reference/editorial.md` before choosing anything. It holds the rules that made our best trailer, and the mistakes to avoid.
`reference/examples.md` shows the two approved trailers bite by bite, and why they work.
`reference/plan-format.md` describes the plan file every step reads.

## Defaults (unless the person asks otherwise)
- 16:9, the full two-shot: no zoom and no crop, so both people are always in view.
- 60-95 s, 12-16 bites, ending on 1.2 s of black.
- DOAC captions in the lower third, never over a face, with a coloured word (red, yellow, green, or a red box) in almost every block.
- Finishing: always HyperFrames. `setup.sh` installs it if it's missing, without asking. The person gets a project they can open and tweak themselves. The Python renderer is only a fallback for when HyperFrames can't run.
- No music. Sound effects (boom, whoosh, riser) come from HyperFrames' sound library, never synthesized.

## Steps

Work in a folder of its own, e.g. `trailer-<episode>/`. `S` is this skill's folder.

1. **Set up**: `bash $S/scripts/setup.sh`, then `source ~/.cache/doac-trailer/env.sh` (in every new shell).
   Setup installs everything, HyperFrames included (with Node 22, Chrome and ffprobe if missing), and skips what is already there. Don't ask the person first.
   If it prints `HYPERFRAMES NOT READY`, note the reason: you'll use the Python fallback in step 7 and tell the person why.
2. **Get the episode** as `original.mp4`:
   - Google Drive: `gdown <file-id> -O original.mp4`
   - YouTube: `yt-dlp`
   - Upload: copy the file in.
3. **Transcribe**: `python3 $S/scripts/transcribe.py original.mp4`. This writes `transcript.json`, `transcript.txt` and `audio.wav`, and takes about a quarter of the episode's length. Read the transcript while it finishes.
4. **Pick the story** following `reference/editorial.md`:
   - Name the one topic, and decide whether it's a guest episode (someone brought in as the expert) or a panel/regular one. A guest episode is guest-led: the guest speaks first (their boldest claim cold-opens the trailer) and for at least half of it.
   - Find who is who: `python3 $S/scripts/frames.py original.mp4 who.jpg --burst MM:SS ...` shows three frames per time, so you can see whose mouth moves.
   - List candidate lines.
   - Build the arc.
   - Write `plan.json` with a `role`, `speaker` and `why` on every bite.
   - Use `python3 $S/scripts/words.py transcript.json START-END` to put each start and end on a sentence boundary.
5. **Clean the cuts**: `python3 $S/scripts/snap.py plan.json`. Fix any cut it marks `<-- check` (its header says how), and put `"lock": true` on bites you place by hand. It's safe to re-run: it only touches bites whose times changed, and never makes a cut louder.
6. **Sound**:
   1. `python3 $S/scripts/audio.py plan.json` writes the dialogue track, `audio_mix.wav`.
   2. `python3 $S/scripts/check_audio.py plan.json` transcribes it, so you can "hear" each bite: no stray words from another speaker, and no clipped first or last word. To find a true word boundary where Whisper's times look wrong, run `python3 $S/scripts/edge.py original.mp4 SECONDS`: it re-transcribes 2 s around that point with exact word times.
   3. Put `boom`, `whoosh` and `riser` on the bites that turn the story (`reference/editorial.md`, Sound), then run `python3 $S/scripts/sfx.py plan.json`. It fetches each sound from HyperFrames' sound library (HeyGen's full library if the person is signed in, otherwise HyperFrames' free built-in effects), lines it up on the cut and sets its level so nothing clips.
7. **Finish in HyperFrames.** First check the captions without rendering: `python3 $S/scripts/captions.py plan.json`. Then:
   1. `python3 $S/scripts/hyperframes.py plan.json hf/` builds the project: one clip per bite, the dialogue, each sound effect as its own clip, and the captions.
   2. `cd hf && hyperframes check`
   3. `hyperframes render -w 4 -o ../trailer.mp4`
   The person can open it with `hyperframes preview` in `hf/`:
   - Caption look (fonts, sizes, colours, timing) and words: `compositions/captions.html`, `<style id="caption-style">`.
   - Sound effects: drag, swap or re-level them on the timeline.
   - Bite order or length: change `plan.json` and re-run `hyperframes.py`. Caption times don't follow a bite that's dragged in the Studio.
   `hyperframes doctor` says what's missing if a command fails.
   - **Fallback, only if setup printed `HYPERFRAMES NOT READY`:** `python3 $S/scripts/audio.py plan.json --sfx` (mixes the sound effects in), then `python3 $S/scripts/render.py plan.json trailer.mp4`. For 9:16, set `"aspect": "9:16"` and run `track.py plan.json` first. The picture is the same, but the person gets no project to edit, so tell them why HyperFrames didn't run.
8. **Review before sharing**: `python3 $S/scripts/review.py trailer.mp4 plan.json`. It makes a time-labelled sheet and prints the captions exactly as they appear on screen. Look at the sheet, and at 5+ full-size frames (the sheet catches words mid-animation). Check that:
   - in a guest episode, the first voice is the guest's, and the guest's share (printed by `review.py`) is at least 50%, spread through the trailer
   - captions never cover a face: `review.py` checks every caption block against the faces under it and saves any it flags as `trailer_faces.jpg`. This is very important; fix every one. On 9:16 or zoomed bites it can't check, so look yourself. Also keep captions off anything the viewer needs to see (a product, a screen, a sign).
   - nearly every block has a coloured word
   - the running order reads as one conversation
   - every bite starts and ends on a complete sentence
   - the last line is left unanswered
   - the length is 60-95 s
   Fix the plan and re-run steps 5-7 until it passes.
9. **Deliver**:
   - the mp4
   - `hf/` zipped, so the person can open and tweak it: unzip, then `npx hyperframes preview` inside it
   - a short note with a table: each bite's role, speaker, source timestamp and line. Also say what you left out and why.
   If `sfx.py` said it used the built-in effects, end the note with: "Want more sound effects to pick from? Sign in to HeyGen with `npx hyperframes auth login` and I'll search its full sound library next time."

## When the person gives feedback
Change the plan, not the scripts.

| Feedback | Change |
|----------|--------|
| "Too long" | Cut the weakest bite that isn't the hook, the guest sell or the cliffhanger. |
| "Bad opening" | Pick a new hook from the candidate list. Never open with an answer. |
| "Stay on the topic" | Drop every bite that fails the on-topic test. |
| Caption wording | Use `fix`, `drop` or `big`. |
| Highlights / colours | Use `accent` with a colour per word (`{"not": "red"}`). |
| Framing | Use `aspect` or per-bite `zoom`. |
| Sound effects | Move `boom` / `whoosh` / `riser` to other bites, or change what's searched for with `sounds`. Re-run from step 6.3. |
| Caption over a face | Fewer words per block (`gap`, `drop`), smaller `big` words, or a different bite. |

Re-run from step 5.
