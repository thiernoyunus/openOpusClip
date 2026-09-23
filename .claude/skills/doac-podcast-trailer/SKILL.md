---
name: doac-podcast-trailer
description: Cut a Diary of a CEO style trailer (60-95 s, 16:9 two-shot, Imran captions) from any full podcast episode. Use when someone sends a podcast video or link and wants a trailer, teaser or intro cut from it.
---

# DOAC Podcast Trailer

Turns one full podcast episode into a 60-95 second trailer. The trailer is built around the episode's one topic: it sells the guest, gives away one useful idea, builds friction, and ends on an unanswered question.

The editing judgment is yours. The scripts do the mechanics.
Read `reference/editorial.md` before choosing anything. It holds the rules that made our best trailer, and the mistakes to avoid.
`reference/plan-format.md` describes the plan file every step reads.

## Defaults (unless the person asks otherwise)
- 16:9, the full two-shot: no zoom and no crop, so both people are always in view.
- 60-95 s, 12-16 bites, ending on 1.2 s of black.
- Imran captions in the lower third, never over a face.
- Finishing: HyperFrames when it's installed (the person can tweak it themselves), otherwise the Python renderer. Both read the same plan and look the same.

## Steps

Work in a folder of its own, e.g. `trailer-<episode>/`. `S` is this skill's folder.

1. **Set up** (once per machine): `bash $S/scripts/setup.sh`
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
6. **Sound**: `python3 $S/scripts/audio.py plan.json`, which writes `audio_mix.wav`. Then run `python3 $S/scripts/check_audio.py plan.json`. It transcribes the mix, so you can "hear" each bite: no stray words from another speaker, and no clipped first or last word. To find a true word boundary where Whisper's times look wrong, run `python3 $S/scripts/edge.py original.mp4 SECONDS`: it re-transcribes 2 s around that point with exact word times.
7. **Finish.** First check the captions without rendering: `python3 $S/scripts/captions.py plan.json`. Then run `npx hyperframes --version`:
   - **Works → HyperFrames** (the person can open it and tweak captions and graphics themselves):
     1. `python3 $S/scripts/hyperframes.py plan.json hf/`
     2. `cd hf && npx hyperframes check`
     3. `npx hyperframes render -w 4 -o ../trailer.mp4`
     4. Tell the person they can run `npx hyperframes preview` in `hf/` to open it in the Studio.
        - Caption look (fonts, sizes, colours, timing): `compositions/captions.html`, `<style id="caption-style">`.
        - Caption words: the same file.
        - Bite order or length: change `plan.json` and re-run `hyperframes.py`. Caption times don't follow a bite that's dragged in the Studio.
     HyperFrames needs Node 22, Chrome and ffprobe. `npx hyperframes doctor` says what's missing, and `npx hyperframes browser ensure` fetches Chrome. With no ffprobe or Chrome download, set `HYPERFRAMES_FFPROBE_PATH` and `HYPERFRAMES_BROWSER_PATH`.
   - **Not installed → Python:** `python3 $S/scripts/render.py plan.json trailer.mp4`. For 9:16, set `"aspect": "9:16"` and run `track.py plan.json` first.
   Both paths read the same plan and give the same picture. The HyperFrames mix comes out about 0.7 dB quieter, because it limits peaks to -1 dB.
8. **Review before sharing**: `python3 $S/scripts/review.py trailer.mp4 plan.json`. It makes a time-labelled sheet and prints the captions exactly as they appear on screen. Look at the sheet, and at 5+ full-size frames (the sheet catches words mid-animation). Check that:
   - in a guest episode, the first voice is the guest's, and the guest's share (printed by `review.py`) is at least 50%, spread through the trailer
   - captions never cover a face
   - the running order reads as one conversation
   - every bite starts and ends on a complete sentence
   - the last line is left unanswered
   - the length is 60-95 s
   Fix the plan and re-run steps 5-7 until it passes.
9. **Deliver** the mp4, plus a short note with a table: each bite's role, speaker, source timestamp and line. Also say what you left out and why.

## When the person gives feedback
Change the plan, not the scripts.

| Feedback | Change |
|----------|--------|
| "Too long" | Cut the weakest bite that isn't the hook, the guest sell or the cliffhanger. |
| "Bad opening" | Pick a new hook from the candidate list. Never open with an answer. |
| "Stay on the topic" | Drop every bite that fails the on-topic test. |
| Caption wording | Use `fix`, `drop` or `big`. |
| Framing | Use `aspect` or per-bite `zoom`. |

Re-run from step 5.
