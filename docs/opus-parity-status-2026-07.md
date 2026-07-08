# Opus Clip vs OpenShorts — Parity Status & Plan (2026-07-07)

Fresh audit of `main` (commit `f46c1ca`) against Opus Clip's live feature set (opus.pro,
help.opus.pro, changelog — checked 2026-07-07). Supersedes the gap tables in
`opusclip-reference.md` §15 and `video-editor-plan-3.md` §1; the task specs in
`performance-and-parity-plan.md` (Tracks B/C/D) are still the implementation reference.

## 1. Where we already match or beat Opus

| Area | Status |
|---|---|
| Clipping pipeline (link → ranked 9:16 clips) | ✅ |
| Virality score 0–100 + Hook/Flow/Value/Trend + sort | ✅ (PR #44/#45) |
| 7 layouts, manual reframe, face/subject tracking | ✅ |
| Editor: NLE timeline (trim/split/reorder), transcript cuts | ✅ (split = `SPLIT_CLIP`) |
| Speech cleanup (fillers + pauses) | ✅ (TranscriptPanel.jsx:369) |
| AI emoji + keyword highlight | ✅ (`/api/captions/enhance`) |
| AI b-roll suggestions (Pexels) | ✅ (`/api/broll/suggest`) |
| Caption templates + animations | ✅ **richer than Opus** |
| Drag captions on canvas | ✅ (CaptionDragOverlay) |
| Social posting, scheduling, calendar, analytics | ✅ Zernio (PR #56) |
| Voice dubbing (30+ languages) | ✅ **Opus core lacks this** |
| Podcast Trailer mode | ✅ **Opus has no equivalent** |
| Arabic/RTL captions, Soniox engine | ✅ |

## 2. Top missing features (ranked by product impact)

| # | Feature | Opus behavior | Effort | Notes |
|---|---|---|---|---|
| 1 | **Prompt-based clipping + reprompt** | Type "find the moments about X"; re-run selection free | S–M | Transcript + prompt → Gemini. Transcript is already cached; a re-run skips download/transcribe. Include **negative prompting** (exclude intros/sponsor reads) — one prompt field. |
| 2 | **Multimodal detection (ClipAnything)** | Visual + audio + sentiment; works on low-dialogue video | M–L | Track C path: audio-native Gemini (~$0.05/hr) + emotion2vec peaks feeding the virality rubric. Do NOT send whole video as video tokens ($5+/hr). |
| 3 | **AI Voiceover / AI Hook (TTS)** | 20+ voices, script → audio track, voiceover preview | M | ElevenLabs already wired in translate.py — add a TTS call + place as audio track (needs #6's `audio[]` or reuse the `music` slot as v1). |
| 4 | **Results-page actions** | Like/dislike, filter, list/grid, regenerate | S–M | D6 spec. Only score-sort + grid exist today. |
| 5 | **Extend / "Add a Section"** | Pull source footage beyond clip bounds | M | We're limited to the baked ±3s pad (`EXTEND_PAD_SECONDS`, main.py:2442). Needs full-source transcript + re-cut. |
| 6 | **Multi-track timeline** (overlays[], audio[], lanes) | Every element is a draggable timeline track | L | Track B1–B4 spec, unstarted. Prereq for SFX + voiceover-as-track. |
| 7 | **Brand template + brand vocabulary** | Logo/fonts/caption preset applied to all clips; taught spellings | M | Nothing exists (E9 slice never built). Vocabulary = word-replace pass on transcript, cheap. |
| 8 | **XML export (Premiere/DaVinci)** | XML + SRT + segments handoff | M | Phase 4 spec in video-editor-plan-3. |
| 9 | **More import sources** | Twitch, Drive, Vimeo, Zoom, Rumble… | S | yt-dlp likely already handles Twitch/Vimeo/etc. — test, relabel the input, whitelist. Drive/Dropbox = direct-download URLs. |
| 10 | **Auto-censor curse words** | Beep/mute + caption asterisks, reversible | M | Word list vs transcript → audio mute ranges + caption mask. |
| 11 | **Custom per-clip thumbnail** | Pick a frame per clip | S | ThumbnailStudio is unrelated (YouTube titles). |
| 12 | **More transitions + auto-transitions** | 6 manual + auto at jump cuts | S–M | We have fade + dip/zoom cut only. |

New-in-2026 Opus features we deliberately skip for now: AI Upscaler, OpusSearch
(archive search), Agent Opus, team/SSO/API/MCP, Android app — wrong scale for this
product; revisit only if asked.

## 3. Have-but-broken / rough edges

1. **Editor sluggish in preview** — Player always renders full 1080×1920
   (EditorCanvas.jsx:22). B5 draft-quality toggle unbuilt.
2. **Layout-switch black flash** — open bug; previous stable-keys fix froze frames and
   was reverted. Needs a new approach.
3. **No progress % / ETA** — jobs look stalled; ProcessingModal just colorizes logs. D3.
4. **27 `alert()`/`confirm()` calls** across the dashboard. D4.
5. **Trailer is a separate page** (`#trailer`, main.jsx:100) with duplicated
   key/submit/poll code; AI Agent + YouTube Studio tabs still visible. D1/D2 unstarted.
6. **1-hour job expiry** surfaces as an alert with no re-run. D7.
7. **Unverified perf work** — A1 (VideoToolbox) merged but needs one end-to-end
   clipping + trailer job watched; A4/A5/A9 sit on unmerged `perf/track-a-*` branches.

## 4. Plan (phased, one branch/PR per item)

**Phase 1 — verify + quick wins (days)**
1. Run one clipping job + one trailer job end-to-end to validate A1 (HW encoding);
   then merge/land A4/A5 from the perf branches if output is clean.
2. #1 Prompt-based clipping + reprompt/regenerate (with negative prompt).
3. #4 Results actions: like/dislike + filter first (feeds scheduling).
4. #9 Import sources: test Twitch/Vimeo/Zoom URLs through yt-dlp, update UI copy.
5. D3 progress bar + D4 kill alerts (biggest daily-feel wins).

**Phase 2 — differentiators (1–2 weeks)**
6. #2 Multimodal detection: emotion2vec peaks (`EMOTION_SCORING=1`) + audio-native
   Gemini hints into the selection prompt (C2 spec).
7. #3 AI Voiceover v1 (ElevenLabs TTS → music-slot audio).
8. #7 Brand template v1 (default caption template + colors + logo watermark) +
   brand vocabulary.
9. Editor preview perf + revisit black flash. NOTE: do NOT use the B5
   "lower compositionWidth/Height" approach from performance-and-parity-plan —
   proven bogus (Player rasterizes at display size; broke px-overlay WYSIWYG,
   reverted in PR #13 fixes). Perf work = profile first; consider gating b-roll/
   transitions layers during scrub instead.

**Phase 3 — editor depth (2+ weeks)**
10. Track B multi-track timeline (B1 schema → B2 playback → B3 lanes → B4 panels);
    move voiceover/SFX onto real audio tracks.
11. #5 Extend beyond pad, #12 transitions, #11 per-clip thumbnails.

### Extend-a-clip design (decided 2026-07-08, audit-verified)

Blockers found: (1) the original full video is NOT retained — URL downloads are
deleted after the clip loop (main.py:2499, app.py never passes --keep-original);
uploads purged by the 1h TTL (app.py:40). Only the ±3s padded `_source.mp4`
survives. (2) One global `framing.source` — no per-clip src; `_validate_framing_clips`
(app.py:1284) and `SET_CLIP_SOURCE` clamp to `source.durationFrames`.

Chosen approach — **append-only source growth**, no schema surgery:
1. Retain the original: move the downloaded/uploaded source into
   `output/{job}/original.mp4` instead of deleting (env-gated size cap later);
   fallback for old jobs = re-download from the source URL in metadata.
2. `POST /api/clips/{job}/{i}/extend {start_sec, end_sec}`: background task
   (BackgroundTasks pattern, app.py:2210) cuts the range from the original with
   the dense-keyframe flags, runs the reframe analysis on just that range, then
   CONCATS it onto the END of the existing `_source.mp4`. New frames occupy
   `[oldDurationFrames, oldDurationFrames+N)` — nothing shifts, captions/overlays/
   cuts keep their coordinates. Update framing `source.durationFrames`, merge
   faceTracks/keyframes (offset by oldDuration), append transcript words.
3. Frontend: "+ Extend a clip" button (TranscriptPanel) → "Add a section from
   transcript" modal (full-source transcript from `_metadata.json` — it already
   stores the whole video's words; needs a new un-clamped GET endpoint) + preview
   player + range steppers. While processing: flashing placeholder block on the
   timeline; on completion INSERT_CLIP with the new source range.
   Full-video preview in the modal streams `original.mp4` via the /videos mount.

**Phase 4 — pro/nice-to-have**
12. #8 XML export, #10 auto-censor, D1/D2 IA cleanup (hide AI Agent/Studio, merge
    Trailer into the shell), D7 graceful expiry.

Verification per PR: checklist at the bottom of `performance-and-parity-plan.md`.
