# OpenShorts Video Editor — Execution Plan

> Status: **PHASES 1–6 EXECUTED** (2026-06-12, commits e6663a5..96d133d on `dev`).
> Phase 6 delivered: undo/redo + shortcuts, transcript panel (click-to-seek, live word highlight, word editing), captions tab (presets/position/size/animation/highlight, persisted at framing.subtitles, burned into export), timeline filmstrip + waveform + draggable segment boundaries, and canvas click-to-track with live face markers (trackerMapping.js inverts the layout geometry).
> Still-open backlog: trim/extend clip content (EDL-style source ranges), AI B-roll, music, transitions, text overlay tracks, screenshare/gameplay layouts, auto-three, snap editing, shared composition package, brand templates.
> Notable deviations from plan:
> - Phase 4 manual reframe is a modal over the 16:9 source (Opus's own pattern) instead of canvas drag — avoids inverse-crop math entirely.
> - Click-to-track became per-panel person dropdowns; canvas click-to-track is still open backlog.
> - Phase 5 implemented auto-SPLIT (2 people) only; auto-three is backlog. Kill switch: `AUTO_SPLIT_LAYOUT=false`.
> - Found+fixed during execution: dashboard ESLint was entirely broken (v8/v9 flat-config skew), and render-service @remotion/* was version-skewed vs remotion/ which broke ALL server renders.
> - Dev harness: `/?editorDev=1` (static fixtures in dashboard/public/dev-fixtures/, gitignored) or `/?editorDev=backend` (fixture job in output/dev/) mounts the editor without processing a job.
> Branch: all work on `dev`, one PR per phase.
> Companion docs: [opusclip-reference.md](opusclip-reference.md) (what we're matching), [opus-reference/ui-teardown.md](opus-reference/ui-teardown.md) (visual reference), `https://github.com/thiernoyunus/react-video-editor` (UX reference ONLY — do not vendor; see memory `video-editor-decision`).

---

## 0. The core insight (read this first)

Two user-facing problems are actually **one architecture problem**:

1. **"Edit" button / video editor doesn't exist** — there is nothing to edit. Each clip is a finished, baked 9:16 mp4.
2. **Reframing "gets stuck" with 2+ people** — `analyze_scenes_strategy()` (`main.py:~390-434`) classifies every scene as `TRACK` (1 face → crop-follow) or `GENERAL` (0 or >1.2 avg faces → blurred-background full-width strip). With two people in frame you always get the blurred strip, and there is **no way to change it** because the crop decision is burned into pixels and discarded.

The root cause: **framing is destructive**. In the per-clip loop (`main.py:1071-1103`) the pipeline:
- cuts a 16:9 source clip to `temp_{clip}.mp4` (line 1079),
- bakes the crop via `process_video_to_vertical()` (line 1096),
- **deletes the 16:9 source** (line 1102-1103),
- and never saves the face boxes / crop windows it computed.

**The fix that unlocks everything:** make framing **data, not pixels**.
- Pipeline keeps the 16:9 source clip and writes a `framing.json` per clip (face tracks + per-segment layout + crop keyframes).
- A new Remotion composition (`ReframedVideo`) renders the 9:16 result **live in the browser** from source + framing.json.
- The editor edits framing.json (switch layout, pick how many people show, click-to-track, drag crop).
- Final export re-renders through the existing **render-service** (server-side Remotion) — same composition as preview ⇒ WYSIWYG.

The current FFmpeg-baked output **stays as the default**: users who never open the editor see zero change. The editor is an additive path.

### Decisions already made (do not re-litigate)
| Decision | Choice | Why |
|---|---|---|
| Editor framework | Build on existing Remotion (`@remotion/player` in dashboard, render-service for export) | Already installed & wired; one composition model for preview + export. See memory `video-editor-decision`. |
| react-video-editor repo | UX reference only | Next.js/WebCodecs/paid-license — incompatible stack. |
| Preview render model | Remotion in-browser, from 16:9 source + framing metadata | Live, draggable, Opus-like. |
| Export render model | render-service (`POST /render`) with the same composition | WYSIWYG; service already resolves `/videos/{job}/{file}` to its shared-volume static mount (`render-service/src/server.ts:88-94`). |
| Default pipeline output | Unchanged (FFmpeg bake stays) | Safe rollout; editor output replaces the baked file only when the user saves. |
| Coordinates in framing.json | Normalized 0–1 floats | Resolution-independent; trivially scales in both preview and export. |

---

## 1. Current-state map (file/line references)

### Backend (Python)
| What | Where |
|---|---|
| Per-clip cut + bake + delete-source loop | `main.py:1071-1103` |
| `process_video_to_vertical()` — scene detect → strategy → frame loop → FFmpeg pipe | `main.py:613-783` |
| `analyze_scenes_strategy()` — TRACK vs GENERAL per scene (>1.2 avg faces ⇒ GENERAL) | `main.py:~390-434` |
| `SmoothedCameraman` — smoothed crop box (`get_crop_box`) | `main.py:84-170` |
| `SpeakerTracker` — face IDs, hysteresis, active-speaker pick | `main.py:171-281` |
| `detect_face_candidates()` (MediaPipe), `detect_person_yolo()` fallback | `main.py:~285-348` |
| Job metadata JSON (`{title}_metadata.json` — shorts, transcript; **no framing**) | `main.py:1063-1068` |
| FastAPI server; `/videos` static mount of `OUTPUT_DIR` | `app.py:183` |
| Clip dicts get `video_url = /videos/{job_id}/{filename}` | `app.py:262, 299` |
| Per-clip transcript slicing (pattern to reuse for editor captions) | `app.py:~593-603` |
| Pattern for "endpoint that swaps a clip's video_url after re-render" | `app.py:849-868` (subtitle flow) |

### Frontend (dashboard — Vite + React 18 + **plain JSX** + Tailwind 3.4)
| What | Where |
|---|---|
| Results grid → `ResultCard` (openIndex/setOpenIndex modal pattern) | `dashboard/src/App.jsx:1006-1022` |
| Clip detail modal (where the **Edit** button goes) | `dashboard/src/components/ResultCard.jsx:488+` |
| Remotion Player wrapper | `dashboard/src/components/RemotionPreview.jsx` |
| Compositions + types (browser copy) | `dashboard/src/remotion/compositions/*`, `dashboard/src/remotion/lib/types.ts` |

### Render stack
| What | Where |
|---|---|
| Server-render compositions (**duplicate of dashboard copy — keep in sync!**) | `remotion/src/compositions/*`, `remotion/src/lib/types.ts` |
| Render service: `POST /render {jobId, clipIndex, props}` → 202 `{renderId}`; `GET /render/:renderId` | `render-service/src/server.ts:58-124` |
| URL resolution `/videos/{job}/{file}` → service-local `/output/...` (shared Docker volume) | `render-service/src/server.ts:88-94` |

> ⚠️ **Tech debt rule for every phase:** any change to compositions or `lib/types.ts` must be made in **both** `dashboard/src/remotion/` and `remotion/src/`. Extracting a shared package is backlog (Phase 6).

---

## 2. The framing.json schema (contract between everything)

One file per clip: `output/{job_id}/{title}_clip_{N}.framing.json`. All coordinates normalized 0–1 relative to the **source** clip frame. All times in **frames** at source fps.

```jsonc
{
  "version": 1,
  "source": {
    "file": "MyVideo_clip_1_source.mp4",   // the kept 16:9 cut
    "fps": 29.97,
    "width": 1920,
    "height": 1080,
    "durationFrames": 1843
  },
  "segments": [                            // one per detected scene, ordered, contiguous
    {
      "id": "seg-0",
      "startFrame": 0,
      "endFrame": 412,                     // exclusive
      "layout": "fill",                    // "fill" | "fit" | "split" | "three" | "four"
      "trackedFaceIds": [2],               // face-track ids, one per panel, top→bottom / reading order
      "cameraKeyframes": [                 // fill-layout crop windows (sampled; player interpolates)
        { "frame": 0,  "x": 0.31, "y": 0.0, "w": 0.316, "h": 1.0 },
        { "frame": 30, "x": 0.33, "y": 0.0, "w": 0.316, "h": 1.0 }
      ],
      "manualCrop": null                   // user-dragged static override {x,y,w,h}; wins over keyframes
    }
  ],
  "faceTracks": [                          // every face seen anywhere in the clip
    {
      "id": 2,
      "samples": [ { "frame": 0, "x": 0.42, "y": 0.18, "w": 0.11, "h": 0.20 } ]  // every ~3rd frame
    }
  ]
}
```

Layout semantics (matches Opus, `docs/opusclip-reference.md` §7):
- **fill** — single tracked crop fills 1080×1920 (today's TRACK).
- **fit** — full source width, blurred-background fill top/bottom (today's GENERAL).
- **split** — 2 stacked panels 1080×960, each cropped around one face track.
- **three** — 3 stacked panels 1080×640.
- **four** — 2×2 grid, 540×960 each.

Strategy mapping for generated defaults (Phase 1 keeps output identical): `TRACK → fill`, `GENERAL → fit`. Smarter defaults (2 stable faces → split) are Phase 5 — do not change defaults early.

---

## 3. Phases

Each phase is a standalone PR with its own acceptance test. Don't start a phase until the previous one's acceptance passes.

---

### Phase 1 — Non-destructive pipeline foundation (backend only, zero visible change)

**Goal:** every new job keeps the 16:9 source per clip and writes `framing.json`. Baked output byte-for-byte equivalent in behavior.

1. **Keep the source clip.** In `main.py:1079-1103`: rename `temp_{clip_filename}` → `{video_title}_clip_{i+1}_source.mp4` and **delete the cleanup at 1102-1103**. (The `/videos` static mount at `app.py:183` already serves it.)
2. **Record face tracks for ALL scenes.** Add a small `FaceTrackRecorder` class in `main.py` (near `SpeakerTracker`):
   - input: face boxes from `detect_face_candidates()` every 3rd frame, **in both TRACK and GENERAL scenes** (today GENERAL skips detection — that's why multi-person scenes are un-editable);
   - greedy nearest-center matching to open tracks (reuse the distance logic style of `SpeakerTracker.get_target`, `main.py:197-222`); unmatched face ⇒ new id; track closes after 30 unseen frames;
   - output: `faceTracks` in the schema above (normalize by source width/height).
3. **Record camera keyframes.** In the frame loop (`main.py:685-737`), every 3rd frame in TRACK scenes, append the current `cameraman.get_crop_box()` (normalized) to the active segment's `cameraKeyframes`. Record which track id the `SpeakerTracker` chose into `trackedFaceIds`.
4. **Write the file.** `process_video_to_vertical()` gains an optional `framing_output_path` param; the per-clip loop passes `{clip_final_path%.mp4}.framing.json`. Build `segments` from `scenes` + `scene_strategies` (`main.py:656`), with the strategy mapping table above.
5. **Expose in API.** In `app.py` where clip dicts are assembled (lines 262, 299): add `clip['source_url'] = f"/videos/{job_id}/{source_filename}"` and `clip['framing_url'] = f"/videos/{job_id}/{framing_filename}"` when those files exist (omit otherwise — old jobs must not break).
6. **Disk note:** sources roughly double per-job storage. Acceptable for now; tie into the existing 1-hour job cleanup. Do NOT delete them earlier — the editor needs them.

**Acceptance:** run a 2-person video through `/api/process` (`docker compose up --build`). Verify: baked clips unchanged in look; `*_source.mp4` + `*.framing.json` exist per clip; framing.json validates against §2 (multi-person scenes have ≥2 faceTracks with stable ids); `/api/status/{job}` clips carry `source_url` + `framing_url`.

---

### Phase 2 — `ReframedVideo` Remotion composition (rendering the data)

**Goal:** given `source_url` + framing config as props, Remotion renders the 9:16 result — in the Player and in the render-service identically.

1. **Types.** Add `FramingConfig` (mirror of §2) + zod schemas to `dashboard/src/remotion/lib/types.ts` **and** `remotion/src/lib/types.ts`. Extend `ShortVideoProps` with `framing: FramingConfig | null` and `sourceVideoUrl: string | null` (when present, render reframed source instead of `videoUrl`).
2. **Composition.** New `ReframedVideo.tsx` in both composition dirs:
   - **fill**: `<OffthreadVideo>` (server) / `<Video>` (player) inside an oversized container; per-frame crop = interpolate `cameraKeyframes` with `interpolate()` clamped between keyframe frames; apply as `transform: translate/scale` (GPU-cheap, no canvas).
   - **fit**: two layers — blurred, scaled-to-fill background (`filter: blur(40px)`) + sharp full-width foreground centered.
   - **split/three/four**: N absolutely-positioned panel `<div>`s with `overflow:hidden`; each panel computes its crop window per frame from its face track samples (interpolate between samples, add ~8%-of-height headroom above the face box, clamp to frame edges; smooth with a simple lerp toward target — mirrors `SmoothedCameraman` behavior, `main.py:84-170`). Panel aspect = panel px dims (e.g. split: 1080×960 → 9:8).
   - `manualCrop` set ⇒ static crop, ignore keyframes.
   - Segment boundaries: wrap each segment in `<Sequence from={startFrame} durationInFrames={...}>`.
3. **Wire into `ShortVideo.tsx`** (both copies): if `framing && sourceVideoUrl`, render `<ReframedVideo>` as the base layer; subtitles/hook/effects stack on top unchanged.
4. **Render-service:** extend `renderRequestSchema` (`render-service/src/server.ts`) with the new optional props; resolve `sourceVideoUrl` through the same `/videos/...` → `/output/...` rewrite as `videoUrl` (`server.ts:88-94`).

**Acceptance:** temporary dev harness (a route or storybook-style page rendering `RemotionPreview` with a hand-fed framing.json from Phase 1): fill segment visually matches the baked clip's framing (≈, smoothing differences fine); fit shows blurred bars; hand-editing a segment to `"split"` shows both faces stacked. `npm run lint` passes. A render-service render of the same props produces a matching mp4.

---

### Phase 3 — Editor shell + Edit button (the entry point)

**Goal:** click **Edit** on a clip → full-screen editor: Player canvas, segment timeline, right rail. Read-only is fine; no saving yet.

Layout target = the Opus editor screenshot (`docs/opus-reference/`): top bar (back / title / Save changes / Export), left transcript-ish column (defer), center 9:16 canvas, right tool rail (Layout tab only for now), bottom timeline with per-segment layout chips ("Fit | Split | Fill") over a thumbnail strip.

1. **Files** (new dir `dashboard/src/components/editor/`):
   - `EditorView.jsx` — full-screen overlay (same dark tokens as the rest of the redesign); fetches `framing_url` JSON + builds caption words from the job metadata transcript (reuse the slicing pattern at `app.py:593-603` — simplest: add `GET /api/clips/{job_id}/{clip_index}/captions` returning word-level captions for the clip window); owns editor state.
   - `useEditorState.js` — `useReducer`: `{framing, selectedSegmentIds, dirty}`; actions `SELECT_SEGMENT`, `SET_LAYOUT`, `SET_TRACKED_FACES`, `SET_MANUAL_CROP`, `RESET`.
   - `EditorCanvas.jsx` — `@remotion/player` `<Player ref>` with `ShortVideo` (framing props from state). Controls off; custom play/seek from the timeline.
   - `EditorTimeline.jsx` — horizontal strip; one block per segment, width ∝ duration; chip shows layout name (Opus-style); click = select + seek; shift/cmd-click = multi-select. Playhead synced via `player.addEventListener('frameupdate')`. Thumbnails/waveform = Phase 6.
   - `EditorTopBar.jsx`, `LayoutPanel.jsx` (rail; static in this phase).
2. **Entry point.** In the clip detail modal (`ResultCard.jsx:488+`) add a primary **Edit** button → `onEdit(index)` prop → `App.jsx` sets `editingClip = {clip, index}` and renders `<EditorView>` instead of the grid (pattern identical to existing `viewingResults` toggling). Disable/hide the button when `clip.framing_url` is absent (old jobs) with tooltip "Reprocess to edit".

**Acceptance:** process a video → open a clip → Edit. Canvas plays the **reframed source** matching the baked clip; timeline shows segments with correct layout chips; clicking a segment seeks and highlights; back returns to results intact. Lint passes.

---

### Phase 4 — Layout & people-count editing + persistence + export (the payoff)

**Goal:** the feature the user actually asked for — change framing per segment, including "show 2/3/4 people", save it, export it.

1. **Layout switching.** `LayoutPanel.jsx`: five layout buttons (Fill / Fit / Split / Three / Four). Applies to all selected segments (`SET_LAYOUT`). Disable split/three/four when the segment has fewer concurrent face tracks than panels (compute overlap of track sample ranges with the segment); show "Only N people detected in this scene".
2. **People-count / panel assignment.** When layout is split/three/four: panel list in the rail, each panel = dropdown of available face tracks (thumbnail crops later; "Person 1/2/3" labels now) → `SET_TRACKED_FACES`.
3. **Manual tracker (click-to-track).** "Tracker" toggle (Opus parity): when on, clicking the canvas finds the face track whose box (at current frame) contains/nearest the click → assigns it to the segment's panel (for fill: sets the single tracked id and regenerates `cameraKeyframes` client-side by following that track with headroom — same rule as the composition panels).
4. **Manual reframe.** When a fill/fit segment is selected: draggable/resizable crop rect overlay (locked 9:16 aspect) → `SET_MANUAL_CROP`. Plain pointer-event math; no new deps.
5. **Persist.** Backend `app.py`:
   - `GET /api/clips/{job_id}/{clip_index}/framing` → file contents;
   - `PUT /api/clips/{job_id}/{clip_index}/framing` → validate (jsonschema or pydantic mirror of §2; reject overlapping/non-contiguous segments) and write.
   "Save changes" PUTs and clears `dirty`. Warn on close with unsaved changes.
6. **Export (bake).** "Export" button:
   - `POST render-service /render` with `{jobId, clipIndex, props: {sourceVideoUrl, framing, subtitles?, hook?, durationInFrames, fps, width:1080, height:1920}}`;
   - poll `GET /render/{renderId}`;
   - on done, `POST /api/clips/{job_id}/{clip_index}/apply-render {filename}` (new endpoint; clone the subtitle pattern at `app.py:849-868`) → updates the clip's `video_url` in the in-memory job **and** metadata JSON so results grid + downloads pick up the edited clip.

**Acceptance (the user's scenario, end-to-end):** process a 2-person video → a 2-person scene comes out as blurred `fit` → Edit → select segment → **Split** → both faces stacked live in preview → Save → reopen editor, split persisted → Export → results card now plays the split version. Also verify: three/four disabled on a 2-person scene; tracker click switches the followed person in fill; manual crop drag works and survives save.

---

### Phase 5 — Smarter pipeline defaults (close the loop)

**Goal:** the "stuck" case mostly never happens because defaults are right.

1. In `analyze_scenes_strategy` (`main.py:390-434`), with face-track data now available: scenes with **2 stable concurrent tracks** (each ≥60% of scene duration) default to `split`; 3 → `three`; else current mapping. Bake split/three in the FFmpeg path too **or** (simpler, preferred) bake default output via the render-service so there is exactly one rendering implementation — decide at implementation time based on render-service throughput.
2. Persist the chosen default in framing.json so the editor shows the truth.

**Acceptance:** the same 2-person video now yields split-layout clips by default; editor can still override to fit/fill.

---

### Phase 6 — Backlog (separate ordered list, not this build)

In rough order of value (cross-ref `opusclip-reference.md` §15): trim/extend segment boundaries from the timeline (pull frames from `_source.mp4` beyond clip bounds — source already kept!), caption editing in the editor (word click → edit, styles rail), screenshare/gameplay layouts, timeline thumbnails + waveform, undo/redo, snap + keyboard shortcuts, filler-word/pause removal, transitions, shared composition package (kill the dashboard/remotion duplication), virality score on results page.

---

## 4. Cross-cutting rules

- **Both composition copies, every time:** `dashboard/src/remotion/` and `remotion/src/` (until Phase 6 extraction).
- **Old jobs degrade gracefully:** no `framing_url` ⇒ no Edit button ⇒ everything else works.
- **Lint gate:** `cd dashboard && npm run lint` (strict, `--max-warnings 0`) before every PR.
- **Manual test rig:** `docker compose up --build`; frontend `http://localhost:5175`; use a YouTube video with a 2-person interview segment as the standard fixture.
- **Don't change default output before Phase 5.** Phases 1–4 must leave non-editor users untouched.
