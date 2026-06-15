# OpenShorts Video Editor — Part 3: Opus Parity (Performance + AI Features)

> Status: **largely shipped** on branch `editor-opus-parity` (2026-06-15). Parts 1 & 2 (docs/video-editor-plan.md, docs/video-editor-plan-2.md) are on `main`: non-destructive framing, layouts, tracker, manual reframe, transcript, captions/templates, timeline strips, EDL trim/cut, transcript-driven cuts, transitions, text overlays, music, screenshare/gameplay, b-roll (Pexels), export.
>
> ### Implementation status (this doc), branch `editor-opus-parity`
> - **Phase 0** — investigated. The split/cut code is ALREADY on `main` and in the running copy (`~/Documents/openshorts`); its `dist/` build is just stale (Jun 13). No "missing code" — needs a rebuild + the new razor Split makes it discoverable. See §0 note.
> - **Phase 1 (perf)** — DONE, commit `9d06a1c`: 540×960 preview, memoized `<Word>`/binary-search transcript, memoized filmstrip/waveform, `React.memo` panels, cached drag rect.
> - **Phase 2a** — DONE, commit `e5a12d6`: Speech Cleanup (filler/pause→cuts, `ADD_CUTS`) + razor Split (`SPLIT_SEGMENT`).
> - **Phase 2b** — DONE, commit `0cb054e`: AI emoji + keyword highlight (Gemini `get_caption_enhancements` + `POST /api/captions/enhance` + per-word render). Manual emoji picker deferred. AI path NOT runtime-tested (no key in env).
> - **Phase 2c** — DONE, commit `67752de`: drag-to-reposition captions on canvas (`CaptionDragOverlay`, subtitle `x`/`y`).
> - **Phase 3 (transitions)** — DONE, commit `aeae551`: zoom cut-transition (`TransitionZoom`, `cutStyle:'dip'|'zoom'`).
> - **Phase 3 (AI b-roll)** — DONE, commit `1c775c2`: auto-placement (Gemini `get_broll_suggestions` + `POST /api/broll/suggest` + Pexels orchestration). NOT runtime-tested.
> - **Still open**: "Add a Section" (richer extend — needs full-source transcript availability; basic extend already works via timeline trim handles into padding), manual emoji picker, text-overlay radius/width controls, Phase 4 (AI Voiceover, Export to XML).
> - All gates green as a unit: dashboard eslint 0 errors, vite build OK, render-service `tsc --noEmit` clean, both remotion copies byte-identical, python ast clean.
> - **Runtime caveats to verify with live keys**: the two Gemini endpoints (`/api/captions/enhance`, `/api/broll/suggest`) were build/lint/syntax-verified only. The emoji `response_schema` uses `additionalProperties` (a free-form map) which Gemini's structured-output validator may reject — it degrades gracefully to "no enhancements" but should be tested; b-roll uses the safer array-of-objects schema.
> This doc specs the remaining gap to reach Opus Clip parity, ranked by user-felt pain. Written so ANY model/person can continue cold.
> Source of truth for "what Opus does": `help.opus.pro/docs` "Edit Your Clips" article set (read 2026-06-15) + live editor screenshots.

---

## 0. Architecture you must not break (read first)

Same rules as Part 2 — re-read before touching anything:

- **Framing is data.** `output/{job}/{clip}.framing.json` drives everything; `ReframedVideo` renders it identically in the browser Player and the render-service. Editing = mutating framing JSON via the reducer in [useEditorState.js](../dashboard/src/components/editor/useEditorState.js) (with history); save = `PUT /api/clips/{job}/{i}/framing` (validated by `_validate_framing` in [app.py](../app.py)); export = render-service + `apply-render`.
- **Compositions and `lib/*` are DUPLICATED** in `dashboard/src/remotion/` and `remotion/src/`. Every change lands in BOTH copies (`diff` to confirm). Editor JS imports from the dashboard copy.
- **`@remotion/*` versions must match exactly** between `remotion/` and `render-service/`.
- **Lint gate:** `cd dashboard && npm run lint` (0 errors) + `npx vite build` before each commit.
- Composition runs at `EDITOR_FPS = 30`; framing data is in **source fps**. All conversions go through time (`frames / fps * 1000` ms), never frame counts directly. EDL math lives only in `lib/edl.ts`.
- **Two checkouts:** `~/Coding/openshorts` (where code is edited) vs `~/Documents/...` (the copy the user RUNS on port 8000). Edits here are NOT in the running app until synced. See Phase 0.

---

## 1. Gap analysis: Opus "Edit Your Clips" vs OpenShorts (main)

| Opus feature | OpenShorts status | Gap to close |
|---|---|---|
| Change Layout (7 layouts, batch multi-select) | ✅ Have (Fill/Fit/Split/Three/Four/Screenshare/Gameplay) | Multi-select batch-apply is rough (P3) |
| Manual Reframe | ✅ Have (`ManualCropModal`) | — |
| Trim (timeline handles + transcript delete) | ✅ Have (EDL) | UX polish only |
| **Extend / "Add a Section"** | ❌ Missing | Pull more footage from full-source transcript beyond clip bounds (P3) |
| Change caption text/style | ✅ Have — richer than Opus (template engine) | — |
| **Drag caption to reposition on canvas** | ⚠️ Partial (Top/Mid/Bottom only) | Free-drag reposition (P2) |
| **AI Emojis / Keywords** | ❌ Missing | Auto-emoji + manual Add→Emoji + keyword color highlight (P2) |
| **Remove Fillers & Pauses ("Speech cleanup")** | ❌ Missing | Auto-detect filler words + silent gaps → EDL cuts (P2, highest ROI) |
| Add Text-Overlay | ✅ Have (5 overlays) | Box radius/width controls (minor, P3) |
| Add Transition Effects | ⚠️ Partial (fade in/out + dip-to-black cut) | Add cross-zoom / zoom-in / zoom-out + Auto-Transitions (P3) |
| **AI B-Roll** | ⚠️ Partial (Pexels stock, manual insert) | AI-generated b-roll + auto-placement + regen prompt (P3) |
| **AI Voiceover / AI Hook** | ❌ Missing | TTS narration, voice picker (P4) |
| **Export to XML (Premiere/DaVinci)** | ❌ Missing | XML + SRT NLE handoff (P4) |
| Undo/redo, scrubbing, save, HD export | ✅ Have | — |

**We already EXCEED Opus on:** animated caption templates, EDL cut precision, screenshare/gameplay layouts, face-track person-switching.

**Critical reframing of the two complaints:**

1. **"Can't split/cut."** It IS implemented on `main` (commits `9e5bc14` → `ddde28f` → `e007534`): timeline trim handles, segment-boundary drag, transcript word-select → Cut/Restore. `dev` has nothing extra. The user can't do it because the **running copy (`~/Documents`) predates this work** → Phase 0 fixes it. Note: Opus itself has **no razor "split-into-two" tool** — its cut model is identical to ours (delete transcript text / drag timeline ends). So a literal NLE razor is NOT required for parity; if desired it's a small additive on the EDL (split a segment's boundary at the playhead), tracked as optional P3.

2. **"Sluggish."** Real, and not the EDL math. Root causes in Phase 1.

---

## 2. Phases (ranked by user-felt pain)

### Phase 0 — Deploy what already exists (½ day, do first)

**Problem:** split/cut/transcript-cut are on `main` but the running app (`~/Documents`) is stale.

1. Sync the running checkout to current `main` (or repoint the user's run command at `~/Coding/openshorts`). Confirm with the user which directory they actually launch.
2. `docker compose up --build` (or the dashboard `npm run build`) in the running checkout.
3. **Verify in the running app:** open a clip editor → drag a timeline trim handle, drag a segment boundary, select transcript words → "Cut N words" → confirm strike-through + Restore. This closes complaint #1 with zero code.

**Exit:** user can split/cut in their actual app.

---

### Phase 1 — Performance (1–2 days) — closes complaint #2

Symptom: editor feels heavy during playback and on edits. Diagnosis (file refs):

- **Heaviest:** the Remotion `Player` renders the full `ReframedVideo` live in-browser every frame — face-track keyframe interpolation + crop + b-roll + transitions + subtitles + text layers, decoding the 16:9 source. [EditorCanvas.jsx](../dashboard/src/components/editor/EditorCanvas.jsx).
- **No `React.memo` on any panel.** Every playhead `frameupdate` and every tab switch re-renders all six panels with the large `framing` object. [EditorView.jsx](../dashboard/src/components/editor/EditorView.jsx).
- **Transcript O(n) per-frame work.** `activeIndex` linear-scans captions each frame; `cutIndexForWord()` runs per word per render. [TranscriptPanel.jsx](../dashboard/src/components/editor/TranscriptPanel.jsx).

Tasks:

1. **Memoize panels.** Wrap `LayoutPanel`, `CaptionsPanel`, `TextPanel`, `AudioPanel`, `BrollPanel`, `TransitionsPanel`, `TranscriptPanel` in `React.memo`. Ensure props are stable (callbacks already `useCallback`'d in EditorView; audit each).
2. **Decouple the playhead from React state.** The current-frame value that drives the timeline playhead and active-word highlight must NOT trigger panel re-renders. Use a Player `frameupdate` subscription writing to a ref + a tiny dedicated subscriber component (or a context with a selector) so only the playhead marker and the active word re-render — not the whole tree.
3. **Transcript lookups O(log n).** Binary-search the active word by time; precompute a `wordIndex → cutIndex` map once per `cuts` change instead of scanning per word.
4. **Cheaper preview.** Render the Player at reduced resolution (e.g. `compositionWidth/Height` 540×960 for preview, keep export at 1080×1920) — quarter the pixels. Optionally gate non-essential layers (b-roll/transitions) to off during active scrub, re-enable on pause.
5. **Cache `getBoundingClientRect()`** outside the boundary-drag pointer-move loop. [EditorTimeline.jsx](../dashboard/src/components/editor/EditorTimeline.jsx) `sourceFrameAtClientX`.

**Verify:** React DevTools Profiler — panels should NOT appear in the commit list during playback; scrub should stay ~60fps on the playhead.

**Exit:** editor feels responsive; no panel re-renders on playhead movement.

---

### Phase 2 — Signature AI features (highest visibility)

These are the features users associate with Opus. All reuse existing infrastructure.

#### 2a. Remove Fillers & Pauses ("Speech cleanup") — *highest ROI*
- We already have word-level timestamps (transcript API `/api/clip/{job}/{i}/transcript`) and an EDL cut model.
- **Filler detection:** word list (`um, uh, like, you know, so, actually, basically, …`) matched against transcript; each match → a `cut` range covering that word (+ tiny pad). Make the list configurable.
- **Pause detection:** gap between consecutive word `end`→`start` > threshold (e.g. 0.4s) → a `cut` range for the silence.
- **UI:** "Speech cleanup" button (top-left of transcript, matches Opus) → two toggles "Remove filler words" / "Remove pauses". Applying dispatches `ADD_CUT` for each detected range (reuses existing reducer + composition; no new render path).
- **Reversible:** cuts show as struck-through transcript + restore, exactly like manual cuts.

#### 2b. AI Emojis / Keywords
- Gemini pass (`editor.py` already wraps Gemini) over the transcript → returns (a) emoji to insert after specific words, (b) keyword words to highlight.
- **Data:** extend `CaptionWord` / `SubtitleStyle` — per-word optional `emoji` and `highlight: true`. Render in [Subtitles.tsx](../dashboard/src/remotion/compositions/Subtitles.tsx) (BOTH copies).
- **Manual:** caption word toolbar → "Add → Emoji" picker (mirror Opus's Add dropdown).
- **Keyword highlight color:** already have `highlightColor` in `SubtitleStyle`; wire per-word highlight to it.

#### 2c. Drag-to-reposition captions on canvas
- Add free `x`/`y` (normalized) to subtitle config; draggable handle on the canvas overlay (pattern already exists for `TextOverlays`). Keep Top/Mid/Bottom presets as quick-snaps.

**Exit:** speech cleanup, emoji/keyword, and caption drag all working + persisted in framing JSON.

---

### Phase 3 — Catch-up features

1. **More transitions + Auto-Transitions.** Add `crossZoom`, `zoomIn`, `zoomOut` to `transitions` config + [TransitionOverlay.tsx](../dashboard/src/remotion/compositions/TransitionOverlay.tsx) (both copies). "Auto-Transitions" toggle auto-applies a transition at each cut boundary.
2. **AI B-Roll upgrade.** Add auto-placement (analyze transcript → suggest b-roll insert points) and a regeneration prompt on top of existing Pexels search ([BrollPanel.jsx](../dashboard/src/components/editor/BrollPanel.jsx)). AI-generated b-roll is a larger lift (gen-video API) — scope separately.
3. **Extend a clip / "Add a Section".** Requires the full-source transcript (beyond clip bounds). Schema already supports it: trim/extend = move `clipInFrame`/`clipOutFrame`; new jobs are cut with ±3s padding (see Part 2 §1). Add UI to pull additional source ranges back into the clip.
4. **Text-overlay box radius/width controls** (minor parity).
5. *(Optional)* **Razor split** — split a segment at the playhead into two independently-framed segments. Small additive on the EDL; only if users ask.

---

### Phase 4 — Power-user

1. **AI Voiceover / AI Hook.** TTS narration via ElevenLabs (already integrated for dubbing in [translate.py](../translate.py)). Type script → pick voice → generate audio track → place on timeline as an audio layer (reuse `music` layer pattern). Volume + original-audio duck sliders already exist.
2. **Export to XML (Premiere/DaVinci).** Generate an FCP7-style XML referencing the source + the EDL ranges + SRT for captions. Animated captions export as baked overlays (match Opus's documented limitation). Pro-tier gate optional.

---

## 3. Suggested commit/PR cadence
- One PR per phase; one commit per sub-task where sensible (mirrors Part 2's PR-chain discipline).
- Every composition/`lib` change lands in BOTH remotion copies in the same commit.
- Lint + `vite build` green before each commit.

## 4. Open questions for the user
- Which directory is the real "run" target — should we repoint it at `~/Coding/openshorts` permanently to end the sync drift?
- Is a literal razor split (Phase 3 optional) actually wanted, or is the Opus-style transcript/timeline cut sufficient?
- AI Voiceover: ElevenLabs (already wired) acceptable, or prefer another TTS?
