# OpenShorts: Performance, Timeline & Opus-Parity Plan

Written 2026-07-02. Each task is self-contained so a smaller model can implement it
without extra context. Line numbers are from commit `61d45ab` — re-locate by the quoted
code if drifted. Scope per the owner: the app is **AI Clipping + Podcast Trailer**;
everything else (Studio, AI Agent tab) gets hidden, not built on.

**Suggested order:** Track A (perf quick wins) → Track D (IA cleanup) → Track B
(timeline) → Track C (models/emotion) → remaining UX polish. Tasks within a track are
independent unless noted. One task = one branch = one PR (per CLAUDE.md).

### Status (updated 2026-07-02, overnight run)
Shipped as open PRs off `main` — each verified as far as possible without a running job:
- **A1** ✅ PR #47 — VideoToolbox HW encoding (`ffmpeg_utils.py`)
- **A2 + A10** ✅ PR #48 — compact clip prompt + structured JSON output
- **A8** ✅ PR #49 — right-size Gemini models (judge + editor text tasks)
- **A3** ✅ PR #50 — downscale detection + cheaper resizes
- **A7** ✅ PR #51 — cache dubbed-video transcription
- **A6** ✅ PR #52 — cache Gemini Files-API uploads

Not yet done (need a full clipping/trailer job + your eyes to verify safely — do NOT merge blind):
- **A4** (parallelize per-clip loop) & **A9** (fold decode passes) — real risk of corrupt/misordered
  output; must run an end-to-end job to verify. **A5** parallel trailer cuts (the CRF half is
  covered by A1's videotoolbox path).
- **Tracks B, C, D** — all need the running app/editor to verify.

Verify the shipped PRs by running one clipping job + one trailer job; the encoding PRs are the
ones to watch (editor black-flash on the dense-keyframe path). `OPENSHORTS_HWACCEL=0` reverts A1.

---

## Track A — Pipeline performance (speed + cost)

### A1. Hardware-accelerated encoding (videotoolbox) — S effort, biggest speed win
Every encode in the app is `libx264` on CPU. On macOS, `h264_videotoolbox` is 3–10x faster.
- Add a helper in `main.py` (top-level): `def video_codec_args(quality='intermediate')` that
  returns `['-c:v', 'h264_videotoolbox', '-b:v', '8M']` when `platform.system() == 'Darwin'`
  and env `OPENSHORTS_HWACCEL` != '0', else the current libx264 args. Use a higher bitrate
  (`12M`) for `quality='final'`.
- Replace the encoder args at: `main.py:1038` (rawvideo bake pipe — biggest win),
  `main.py:2407` + `main.py:2425` (clip cuts — KEEP the `-g 15 -keyint_min 15 -sc_threshold 0`
  dense-keyframe flags, the editor depends on them), trailer segment cuts `main.py:2095`,
  trailer concat fallback `main.py:2139`, `editor.py:609`, `subtitles.py:227`, `hooks.py:242`.
- Acceptance: run a clipping job end-to-end; output plays, editor still seeks without black
  flashes, job wall time drops. Fallback path (env off) still works.

### A2. Compact the clip-selection prompt — S effort, ~90% Gemini cost cut on long videos
`main.py:1384-1388` sends the transcript text **and** the full per-word JSON (verbose dicts).
The trailer path already solved this with sentence grouping (`main.py:1467-1507`).
- Reuse/adapt the trailer's sentence-grouping to build the clipping prompt: send sentences
  with `[start–end]` ranges instead of `words_json`. If per-word data must stay, compact to
  `[["word",s,e],…]` with times rounded to 2 decimals.
- Update `GEMINI_PROMPT_TEMPLATE` accordingly (search for `words_json` placeholder).
- Also add `config={'response_mime_type': 'application/json'}` to the `get_viral_clips` call
  (`main.py:1394`) — editor.py already does this; it prevents malformed-JSON failures.
- Acceptance: a 30+ min video yields the same-quality clips; log the prompt token estimate
  before/after.

### A3. Downscale detection + cheaper resizes in reframing — S effort, 2–4x framing loop
- In `detect_face_candidates` (`main.py:501`): resize the frame so max dimension ≈ 640 before
  MediaPipe, scale returned boxes back up.
- Replace `cv2.INTER_LANCZOS4` with `cv2.INTER_LINEAR` at output resizes (`main.py:1159`,
  `main.py:633`) and use `INTER_AREA` for the blurred background path in
  `create_general_frame`.
- Acceptance: side-by-side output looks identical; framing stage time drops.

### A4. Parallelize the per-clip loop — M effort, ~Nx for N clips
The loop at `main.py:2382-2468` processes clips sequentially; clips are independent.
- Extract the loop body into a module-level function (it must be picklable) taking
  (clip index, timing, paths, config). Run via `concurrent.futures.ProcessPoolExecutor`
  with `max_workers = min(len(clips), max(1, os.cpu_count() // 4))` (each worker spawns
  ffmpeg + MediaPipe — don't oversubscribe).
- Keep log output readable: prefix lines with `[clip N]`.
- Acceptance: 4-clip job finishes ~2-3x faster; logs/metadata files identical in structure.

### A5. Parallel trailer segment cuts + saner intermediate quality — S effort
- `main.py:2079-2117`: run the per-segment ffmpeg cuts through a
  `ThreadPoolExecutor(max_workers=4)` (ffmpeg releases the GIL; threads are fine).
- Change intermediates from `-crf 12 -preset ultrafast` to `-crf 16 -preset veryfast`
  (or videotoolbox via A1) at `main.py:2095` — CRF 12 + ultrafast makes huge files.
- Acceptance: trailer output unchanged visually; cut phase ~3x faster.

### A6. Cache Gemini Files-API uploads per clip — S effort, big per-edit latency cut
`editor.py:24` re-uploads the whole clip video on every `/api/edit` and
`/api/effects/generate` call. Files API handles live 48h.
- Store `{local_path_mtime: file_handle_name}` in a JSON sidecar next to the clip (or an
  in-memory dict keyed by path+mtime in app.py). Before uploading, look up and verify with
  `client.files.get`; reuse if ACTIVE.
- Acceptance: second edit on the same clip skips the upload (log it).

### A7. Cache dubbed-video transcription — S effort
`app.py:1171-1179` re-runs whisper on a `translated_` file every `/api/subtitle` call.
- After transcribing, write `<video>.transcript.json` next to the file; on the next call,
  load it if present and newer than the video.
- Acceptance: second subtitle call on the same dubbed clip is near-instant.

### A8. Right-size the Gemini models — S effort
- Trailer judge (`main.py:1780`, model at `main.py:137`): the pick-best-index task doesn't
  need `gemini-3.5-flash` ($1.50/M in). Add `TRAILER_JUDGE_MODEL` env defaulting to
  `gemini-2.5-flash`; keep 3.5-flash for the candidate *selection* only.
- `editor.py:290` (caption enhance) and `editor.py:438` (b-roll suggest) are tiny text
  tasks → `gemini-2.5-flash-lite` (or 3.1-flash-lite).
- Acceptance: outputs equivalent; cost log (`main.py:1667` table) shows the drop.

### A9. Fold redundant decode passes — M effort (do after A1–A5)
`process_video_to_vertical` decodes each clip 3x: scene detect (`main.py:1004`), strategy
sampling (`main.py:693`), framing loop (`main.py:1067`).
- Easiest win: run PySceneDetect on a downscaled stream (its `downscale_factor` /
  `frame_skip` options) — don't restructure the pipeline.
- Optional (larger): merge strategy sampling into the framing loop's first pass.
- The redundant unpadded cut (`main.py:2398`) *could* be removed by baking from the padded
  cut with a 3s offset — but note the comment: it doubles as the editor-source fallback.
  If removing, make the fallback logic (`main.py:2432+`) use the padded file.

### A10. Structured-output + misc freebies — S effort
- `response_mime_type='application/json'` (+ optional schema) on `get_trailer_moments`
  (`main.py:1708`) as in A2.
- `/api/edit` copies the input file just to get an ASCII name (`app.py:739`) → `os.link`
  (hardlink) instead of copy.
- Fix stale comment `app.py:31` ("Default to 1" — actual default is 5).

---

## Track B — Full video-editing timeline (b-roll, SFX, multi-track)

Everything lives in `remotion/src` (symlinked into dashboard; **restart render-service
after any remotion/src change** or exports lag the preview). Zod schema strips unknown
keys — every new field MUST be added to `framingConfigSchema` in
`remotion/src/lib/types.ts:655` or it silently disappears from exports.

Current state: `clips[]` main track; `broll[]` (max 3, video-only, full-cover, muted);
`textOverlays[]` (max 5); single `music` track; global `transitions` booleans. None of
these appear on the timeline UI — the timeline (`dashboard/src/components/editor/
EditorTimeline.jsx`) is a single hardcoded clip lane; overlays are edited via right-rail
panels with numeric times.

### B1. Schema: generic `overlays[]` and `audio[]` tracks — M effort, do first
Add to `FramingConfig` (types.ts) + zod schema + `normalizeFraming` defaults
(`dashboard/src/components/editor/useEditorState.js:457`):
```jsonc
"overlays": [{            // supersedes broll; migrate broll[] → overlays on load
  "id": "ov-1", "kind": "video"|"image", "url": "…",
  "startFrame": 120, "endFrame": 240,   // source frames (existing EDL anchoring)
  "anchor": "source"|"output",          // default "source" = current behavior
  "x": 0.5, "y": 0.5, "w": 1, "h": 1,   // normalized; 1×1 = full-cover
  "volume": 0, "z": 0
}],
"audio": [{
  "id": "sfx-1", "role": "sfx"|"music", "url": "…",
  "startFrame": 0, "endFrame": 300,     // OUTPUT-anchored (SFX must not move on reorder)
  "trimBefore": 0, "volume": 0.8, "loop": false,
  "fadeInSec": 0, "fadeOutSec": 0
}]
```
Migrate on load in `normalizeFraming`: `broll[] → overlays[]`, `music → audio[{role:'music'}]`
(keep writing the old fields too until B4 lands, for back-compat).
Acceptance: existing framing JSONs load unchanged; save/reload round-trips the new fields;
an export with the new fields doesn't drop them (zod check).

### B2. Playback layers — M effort (needs B1)
In `remotion/src/compositions/ShortVideo.tsx` (layer stack at :39–87):
- `OverlaysLayer`: for each overlay, source-anchored ones map through
  `sourceRangeToOutputWindows` (`remotion/src/lib/edl.ts:261` — same as BrollLayer.tsx:24);
  output-anchored ones are a plain `<Sequence from={startFrame}>`. Render `<OffthreadVideo>`
  or `<Img>` positioned by normalized x/y/w/h.
- `AudioLayer`: `<Sequence>` + `<Audio src volume trimBefore loop>` per entry; implement
  fades with a frame-interpolated `volume` callback.
- Keep BrollLayer + old music `<Audio>` rendering only when the new arrays are empty.
Acceptance: a hand-edited framing JSON with one image overlay + one SFX plays correctly in
preview AND in an export (restart render-service before testing export).

### B3. Multi-lane timeline UI — L effort, the big lift (needs B1–B2)
Generalize `EditorTimeline.jsx`:
- Extract the lane container (:385–414) into a `Lane` component; render 4 lanes:
  video clips (existing ClipBlock), overlays, text, audio. Vertical scroll if needed.
- New `TrackItem` block for overlay/text/audio entries: positioned on the OUTPUT axis
  (map source-anchored items through `sourceRangeToOutputWindows` for display), draggable
  (move = shift start/end), trim handles on both edges, click-to-select syncs the right-rail
  panel selection.
- Extend the drag state machine (:252–324) with a `lane` + `itemId` dimension; reuse the
  existing reducer actions (ADD/UPDATE/REMOVE for text + broll exist at
  useEditorState.js:266–293; add the same for overlays/audio in B1).
- Perf guard: the playhead re-renders the whole timeline 30x/s because `outFrame` is
  component state (:144,:170). Move the playhead into an isolated child driven by a ref/
  transform before adding lanes.
Acceptance: drag an SFX block along the audio lane, trim a b-roll block, both reflected
in playback immediately; timeline stays smooth during playback.

### B4. Panels + asset upload — M effort (parallel with B3)
- SFX: extend `AudioPanel.jsx` with an SFX list (add/upload/volume/fade) writing `audio[]`.
  Reuse the existing upload endpoint pattern (`/api/clips/{job}/{i}/audio`, AudioPanel.jsx:24);
  add a generic asset upload endpoint in `app.py` accepting audio/image/video, saved next
  to the clip.
- B-roll panel (`BrollPanel.jsx`): support image results + user upload; expose position/size
  presets (full / top-half PiP / corner PiP) mapping to x/y/w/h.
- Music: add start-offset + fade controls (fields exist after B1).
Acceptance: upload an mp3 SFX and a PNG overlay via the panels; both export correctly.

### B5. Editor preview performance — S effort
Preview `Player` renders at full 1080×1920 (`EditorCanvas.jsx:60–65`). Add a draft-quality
toggle (0.5 scale) defaulting to draft during playback, full-res when paused.

---

## Track C — Models & emotion detection

### C1. Model lineup (config changes, S effort each)
| Task | Use | Why |
|---|---|---|
| Clip selection | keep `gemini-2.5-flash` (cheap) or try `gemini-3.1-flash-lite` | $0.10–0.25/M in, 1M ctx |
| Trailer selection | keep `gemini-3.5-flash` (quality matters here) | best coherence judgment |
| Trailer judge | `gemini-2.5-flash` (A8) | pick-an-index task |
| Titles/captions/b-roll suggest | `gemini-2.5-flash-lite` (A8) | trivial tasks |
| Editor video-effect calls | keep `gemini-3-flash-preview`; add upload caching (A6) | video tokens dominate, not model choice |
| Cloud transcription | add **Groq whisper-large-v3-turbo** backend (~$0.04/hr, word timestamps) alongside Soniox (~$0.10/hr) | 5–10x cheaper than most APIs |
| Local transcription | offer `distil-large-v3` in the model list (transcription.py:8) | ~5x faster than large-v3, near-equal WER |

**Do not use video-native Gemini for whole-video analysis**: video ≈ 5,792 tokens/sec at
720p → a 1-hr podcast ≈ $5+ even on flash-lite. **Audio-native input is the viable
upgrade**: ~25 tokens/sec ≈ $0.05/hr — a future "ClipAnything-lite" could send audio + the
transcript for tone-aware selection at negligible cost.

### C2. Emotion detection ("velma modulate" — resolved)
The name is real: **Velma = Modulate's Ensemble Listening Model**, public API since
June 2026, from ~$0.75/hr audio (verify at modulate.ai/api/velma). Hume AI's expression
API is **sunset (dead since June 14, 2026)** — do not use.

Recommended path (M effort, ~1–2 days):
1. Start **local + free** with `emotion2vec+ large` (HuggingFace, runs via FunASR; torch is
   already a dependency through ultralytics).
2. New module `emotion.py`: extract 16kHz mono audio (ffmpeg, same as the Soniox path),
   window into 3s chunks with 1s hop, run emotion2vec+ per chunk → time series of
   `{t, arousal-ish intensity, top emotion}`.
3. Feed it into scoring: (a) clipping — add an "emotional peak" bonus to the Virality
   score components (Hook/Flow/Value/Trend live in the Gemini prompt; pass peak timestamps
   as a hint list in the prompt); (b) trailer — pass peaks to `get_trailer_moments` as
   candidate hot-spots.
4. Gate behind env `EMOTION_SCORING=1` initially. If it proves out and finer intent/
   escalation signal is wanted, swap the backend for the Velma API.

---

## Track D — UX / IA / Opus parity (frontend)

### D1. Focus the navigation — S effort, do first
- Hide the **AI Agent** tab (`App.jsx:1042-1155`, marketing page) and **YouTube Studio**
  (`ThumbnailStudio.jsx` + shortcut row entry `App.jsx:1180`) from the rail. Keep the code.
- Promote **Trailer** to a first-class rail tab.

### D2. Merge TrailerPage into the App shell — M effort
`TrailerPage.jsx` duplicates key-decrypt/submit/poll code from App.jsx and has two known
janks: completion does a full-page `window.location.search` reload into the editor
(TrailerPage.jsx:108-115), and a missing key alert-bounces to `#app` settings (:183-187).
Make it a tab inside App so keys/settings/projects are shared; navigate to the editor via
the existing in-app route instead of a reload. One unified projects grid with a type badge.

### D3. Progress + ETA — M effort, biggest perceived-speed win
No numeric progress anywhere; long jobs feel stalled.
- Backend: emit structured progress lines (`PROGRESS 42`) at stage boundaries in `main.py`
  (download/transcribe/analyze/per-clip N-of-M) — the per-clip loop gives natural fractions.
- Frontend: parse in `lib/projectHistory.js` (phaseFromLogs → also progressFromLogs); show
  a % bar + phase in `ProcessingModal.jsx` and a % pill on project cards in `App.jsx`.
- Upload progress with cancel in `MediaInput.jsx` (use XHR or fetch streams; current fetch
  gives no progress).

### D4. Kill the alert()s + first-run polish — S/M effort
- Replace all `alert()`/`window.confirm()` (key saves, delete, expiry, trailer errors)
  with a small toast component + inline confirm.
- Remember the rights checkbox in localStorage (`MediaInput.jsx:439`, `TrailerPage.jsx:519`).
- Collapse the 4 separate key panels in Settings into one auto-saving panel; single guided
  first-run modal for the Gemini key.
- Hide the transcription-engine/whisper-model pickers behind an "Advanced" disclosure with
  good defaults (Opus never exposes this).

### D5. Finish the token migration — M effort
Stale legacy indigo/glass styling remains in: `ThumbnailStudio.jsx` (skip — hidden by D1),
`Landing.jsx`, `TrailerPage.jsx` (8 hits), `SubtitleModal.jsx`, `KeyInput.jsx`, Settings tab
in `App.jsx`. Restyle to the zinc token set, then delete legacy `primary`/`accent` from
`tailwind.config.js`.

### D6. Results-page parity — M effort
Missing vs Opus: like/dislike per clip, filter, grid/list toggle, regenerate/reprompt.
Start with like/dislike + filter (`ResultCard.jsx`, `App.jsx` results view) — they feed
Schedule Week.

### D7. Graceful expiry — S effort
Jobs expire after 1h; today that's an `alert('This project has expired…')` (`App.jsx:657`).
Show "expires in ~Xm" on cards, auto-collapse expired ones, offer one-click re-run from the
saved source URL.

### Opus feature gaps (backlog, not scheduled)
Already at parity: dark theme, submit card, virality score+sort, full editor (layouts/
EDL/captions/transitions/text/music/b-roll), processing modal, scheduling, dubbing.
Still missing (rough priority): multimodal ClipAnything-style detection (pair with C1
audio-native + C2), brand templates/vocabulary, AI voiceover, extend-a-clip, custom
thumbnails, auto-censor, XML export, more import sources (Drive/Dropbox/Zoom).

---

## Verification checklist (per PR)
- Clipping job end-to-end on a real YouTube URL; trailer job on a podcast video.
- Editor: open a produced clip, trim/split/reorder, export; compare export vs preview.
- `cd dashboard && npm run lint` (strict, 0 warnings).
- After remotion/src changes: restart render-service before testing export.
