# OpenShorts Video Editor — Part 2: Trim/Cuts (EDL), Overlays, Audio, B-Roll

> Status: **in execution** (started 2026-06-12). Part 1 (docs/video-editor-plan.md) is fully shipped: non-destructive framing, layouts, tracker, transcript, captions, timeline strips, export. This doc specs the remaining backlog so ANY model/person can continue cold.
> Branch `dev`, one commit per phase, PR #9 chain. Verify with the dev harness (`/?editorDev=backend`, fixture in `output/dev/` — recreate per §7 if the 1-hour cleanup purged it).

---

## 0. Architecture you must not break (read first)

- **Framing is data.** `output/{job}/{clip}.framing.json` drives everything; the `ReframedVideo` composition renders it identically in the browser Player and the render-service. Editing = mutating framing JSON via the reducer in [useEditorState.js](../dashboard/src/components/editor/useEditorState.js) (with history), saving = `PUT /api/clips/{job}/{i}/framing` (validated in [app.py](../app.py) `_validate_framing`), export = render-service + `apply-render`.
- **Compositions and `lib/*` are DUPLICATED** in `dashboard/src/remotion/` and `remotion/src/`. Every change lands in BOTH (copy the file; `diff` to confirm). Editor JS imports from the dashboard copy.
- **`@remotion/*` versions must match exactly** between `remotion/` and `render-service/`.
- **Lint gate:** `cd dashboard && npm run lint` (0 errors) + `npx vite build` before each commit.
- Composition runs at `EDITOR_FPS = 30`; framing data is in **source fps**. All conversions go through time (`frames / fps * 1000` ms), never through frame counts directly.

## 1. The unifying schema change: framing v2

One mental model for trim/extend/cut: **playable content = `[clipInFrame, clipOutFrame]` minus `cuts[]`** (all in source frames).

```jsonc
{
  "version": 2,
  "source": { "file", "fps", "width", "height", "durationFrames" }, // durationFrames now includes ±3s padding on new jobs
  "clipInFrame": 90,        // where clip content starts in the padded source
  "clipOutFrame": 1342,     // exclusive end. v1 files normalize to 0..durationFrames
  "cuts": [ { "startFrame": 400, "endFrame": 460 } ],  // sorted, non-overlapping, inside [clipIn, clipOut]
  "segments": [...],        // UNCHANGED semantics; MUST stay contiguous and cover exactly [clipInFrame, clipOutFrame]
  "faceTracks": [...],
  "subtitles": {...} | null,        // captions stay in ms relative to clipInFrame (original clip start)
  "textOverlays": [ { "id", "text", "startFrame", "endFrame", "x", "y", "size", "color", "bg" } ],  // §E5
  "music": { "url", "volume", "originalVolume" } | null,             // §E6
  "transitions": { "fadeIn": bool, "fadeOut": bool, "cutCrossfade": bool },  // §E4
  "broll": [ { "id", "url", "startFrame", "endFrame" } ]             // §E8
}
```

- **Trim** = move `clipInFrame`/`clipOutFrame` inward. **Extend** = move them outward into the padding (new jobs are cut with ±3s extra; old files have clipIn=0/clipOut=durationFrames so extend is naturally unavailable).
- **Cut** (incl. transcript-driven deletion) = add a range to `cuts`. **Restore** = remove it.
- Invariant maintained by the reducer, enforced by the validator: segments cover exactly `[clipInFrame, clipOutFrame]`; edge trims stretch/shrink/drop edge segments; cuts clamped inside the clip range; min segment/kept-range length 10 frames.

### lib/edl.ts (NEW, both remotion copies) — single source of EDL math
```ts
keptRanges(framing): {startFrame, endFrame}[]        // [clipIn..clipOut] minus cuts
outputDurationFrames(framing, fps): number            // Σ range durations → comp frames (round per range, sum)
outputToSource(framing, outFrame, fps): number        // walk ranges; clamp to last
sourceToOutput(framing, srcFrame, fps): number|null   // null if inside a cut / outside clip
remapCaptions(captions, framing, fps): CaptionWord[]  // clip-relative ms → output ms; drop words fully cut
```
Round **per range** with the same function everywhere (`Math.round(frames * fps / srcFps)`) so Player duration, Sequence positions, and export agree.

## 2. Phases

### E1 — EDL core (composition + schema + loader + validator + pipeline padding)
1. **lib/edl.ts** as above (+ mirror copy). Add v2 fields to `FramingConfig` in both `lib/types.ts`.
2. **ReframedVideo refactor:** today one `<Video>` plays linearly and only crops change. New top level:
   ```tsx
   keptRanges(framing).map(range => (
     <Sequence from={outStart(range)} durationInFrames={outDur(range)}>
       <RangeContent src framing srcStartFrame={range.startFrame} />
     </Sequence>
   ))
   ```
   `RangeContent` = the existing body, with `sourceFrame = srcStartFrame + round(seqFrame * srcFps / fps)` and every `<Video>`/blur layer getting `startFrom={Math.round(range.startFrame / srcFps * fps)}` (Remotion's startFrom is in composition-fps frames). Audio stays on the first/only unmuted Video per range.
3. **Captions through cuts:** in `ShortVideo.tsx` (both copies), when `framing` is present remap `subtitles.captions` with `remapCaptions` before passing to `Subtitles`. Stored captions remain clip-relative (no migration).
4. **Loader normalization** (`LOAD` in useEditorState): default `clipInFrame=0`, `clipOutFrame=source.durationFrames`, `cuts=[]`, `version=2`, plus defaults for later phases (`textOverlays=[]`, `transitions={...false}`, `music=null`, `broll=[]`).
5. **Validator** (app.py): accept version 2 (and only 2 — the loader always upgrades); check clipIn/clipOut bounds, cuts sorted/non-overlapping/inside clip, segments cover exactly `[clipIn, clipOut]`; ignore/lightly check the new optional keys.
6. **Pipeline padding** (main.py clip loop ~line 1335): keep the existing unpadded cut as bake input (now a temp again, deleted after bake), add a SECOND padded cut (`max(0, start-3)`..`min(duration, end+3)`, same encoder flags) saved as `_source.mp4`. Pass `framing_offset_frames = round((start - pad_start) * src_fps)` and padded duration into `process_video_to_vertical`'s framing writer: shift ALL recorded frame numbers (segments, keyframes, samples) by the offset, set clipIn/clipOut, version 2.
7. **EditorView/export duration:** `durationInFrames = outputDurationFrames(framing, 30)` everywhere (canvas, export props).

**Acceptance:** hand-add a cut to the fixture framing.json → preview duration shrinks, content visibly skips, captions stay in sync after the cut; lint/build green; PUT round-trip passes validation; SSR export of a framing-with-cut matches preview.

### E2 — Timeline: trim handles + cut visualization + EDL playhead
- Timeline x-axis stays **source time** over `[clipInFrame, clipOutFrame]` (chips/filmstrip/waveform unchanged → filmstrip request range = full padded source is fine but VISIBLE window maps clipIn..clipOut; simplest: keep mapping over full source and grey out beyond clip bounds).
- Render `cuts` as hatched/darkened bands across all three strips. Click a band → select the cut (Delete key or × button restores).
- **Trim handles** at the clip's left/right edges (drag inward = trim, outward into padding = extend; reducer action `SET_CLIP_BOUNDS` stretches edge segments, clamps cuts).
- Playhead position = `outputToSource(...)` mapped to the source axis; scrubbing seeks via `sourceToOutput` (clicking inside a cut seeks to the next kept frame).

**Acceptance:** drag right handle inward → duration shrinks & last segment shrinks on save; drag outward (new-job fixture with padding) → extends; cut band visible; scrub across a cut jumps the playhead.

### E3 — Transcript-driven cuts (Opus text-based editing)
- Word selection in TranscriptPanel: click = caret, shift-click = range (store `selStart/selEnd` word indexes). Floating "✂ Cut" button near selection → `ADD_CUT` with `[firstWord.startMs → lastWord.endMs]` converted to source frames (+ clipIn offset).
- Words inside any cut render struck-through + dimmed; clicking a struck word selects its cut; "Restore" button / Delete key removes the cut (`REMOVE_CUT`).
- Reducer: `ADD_CUT` merges overlapping/adjacent cuts; `REMOVE_CUT` by index.

**Acceptance:** select 3 words → Cut → words struck, preview skips them, captions skip them; click struck word → Restore → back to normal. Save/reload persists.

### E4 — Transitions (`framing.transitions`)
- `{fadeIn, fadeOut, cutCrossfade}` toggles (Captions-tab-style switches in a new "Effects" section of the Layout tab or its own tab).
- Composition: fadeIn/out = opacity ramp on first/last 15 output frames (black). cutCrossfade = at each kept-range boundary (i.e., where a cut was removed... boundary between range i and i+1), overlap ranges by 8 frames with opacity cross-ramp: extend range i's Sequence by 8 frames (clamped to source availability) and fade it out over range i+1.
- Keep it deterministic per frame (server rendering requirement).

**Acceptance:** toggling fadeIn shows black→video ramp at 0; a cut boundary with crossfade shows an 8-frame blend instead of a hard jump. Export matches.

### E5 — Text overlay tracks (`framing.textOverlays`)
- New "Text" tab: list + "Add text at playhead" (default 3s duration), fields: text, size (S/M/L), color, bg on/off; start/end "set from playhead" buttons; delete. Max 5 (Opus parity).
- Canvas: overlays draggable to position when Text tab active (store normalized x/y center) — reuse the pointer pattern from ManualCropModal.
- Composition layer `TextOverlays.tsx` (both copies) rendered in ShortVideo above ReframedVideo, below Subtitles: each overlay visible when `sourceToOutput(startFrame)<=frame<sourceToOutput(endFrame)` — store overlay times in SOURCE frames; map through EDL like captions.

**Acceptance:** add overlay → visible/draggable in preview at right times, survives save/reload, burned into export.

### E6 — Music & volume (`framing.music`)
- "Audio" tab: upload music (`POST /api/clips/{job}/{i}/audio` multipart → saves `{clip}_music.{ext}` in job dir, returns `/videos/{job}/...` url), volume slider (0–100), original-audio volume slider (`originalVolume`, default 100), remove.
- Composition: `<Audio src={music.url} volume={v} loop>` in ShortVideo; original volume applied to the unmuted `<Video>`s via `volume` prop.
- render-service: generalize the `/videos/...`→local rewrite to also walk `framing.music.url` and `framing.broll[].url` (server.ts resolveVideoUrl logic → apply to a list of paths).

**Acceptance:** uploaded mp3 audible in preview at chosen volume with original ducked; SSR export contains both tracks mixed.

### E7 — Screenshare & Gameplay layouts
- `panelsForLayout` gains `screenshare` (content 60% top / speaker 40% bottom) and `gameplay` (speaker 30% top / content 70% bottom). "Content" panel uses a **full-frame fit crop** (centerCrop with panel aspect = whole frame visible? No — use `centerCrop` semantics: cover crop of full frame), speaker panel = face-tracked like split. Convention: panel index 0 = content (no face), 1 = speaker (trackedFaceIds[0] if simpler — document the chosen mapping in types).
- LayoutPanel buttons (enabled when ≥1 face). Tracker/people-dropdown panel count must use `panelsForLayout(...).length` and skip the content panel for face assignment.
- trackerMapping panelGeometry already generic — verify forward/inverse still hold.

**Acceptance:** switch a segment to screenshare → full frame top, tracked speaker bottom; gameplay inverse proportions.

### E8 — AI B-Roll (Pexels, `framing.broll`)
- "B-Roll" tab: Pexels API key input (encrypted-localStorage like other keys, `PEXELS_API_KEY`), search box → `https://api.pexels.com/videos/search?query=...&orientation=portrait` client-side, grid of thumbnails, click → insert `{startFrame: playhead, endFrame: +4s}` capped at clip bounds; list with delete; max 3.
- Composition: full-canvas `<Video src={hd file url} muted>` covering during the (EDL-mapped) range, above ReframedVideo, below TextOverlays/Subtitles.
- SSR fetches the https URL directly (no rewrite needed; the walker in E6 leaves absolute non-/videos URLs untouched).

**Acceptance (no key in CI):** without key, tab shows key prompt; with key (manual), search+insert works; fixture-injected broll entry renders in preview+export.

### E9 — Caption style default (brand-template slice)
- "Set as default style" button in CaptionsPanel → saves style+position to localStorage (`openshorts_caption_style_default`); `defaultSubtitleConfig` reads it. Full brand templates (logo, fonts, asset library) stay out of scope — documented for Part 3.

## 3. Verification env
- Backend: `preview_start backend` (uvicorn :8000) · dashboard `preview_start dashboard` (:5175) · renderer: `cd render-service && npx tsx src/server.ts` (:3100, needs `OUTPUT_DIR=$PWD/../output`).
- Harness: `http://localhost:5175/?editorDev=backend`.
- Fixture rebuild (after cleanup purge): copy any 16:9 mp4 → `output/dev/demo_clip_1_source.mp4`, framing JSON v1/v2 alongside as `demo_clip_1.framing.json`, optional `demo_metadata.json` with transcript (see git history of this session, or run the snippet in §7 of memory).
- E2E pipeline check (the real acceptance): process a 2-person YouTube video via the UI with a Gemini key.

## 4. Done so far in Part 2
(keep this list updated as phases land)
- [ ] E1 EDL core
- [ ] E2 timeline trim/cuts
- [ ] E3 transcript cuts
- [ ] E4 transitions
- [ ] E5 text overlays
- [ ] E6 music/volume
- [ ] E7 screenshare/gameplay
- [ ] E8 b-roll
- [ ] E9 caption default
