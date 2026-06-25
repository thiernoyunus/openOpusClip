# Smart Caption Placement — Plan

Status: PROPOSED (no code yet). Owner decision pending.

## Goal

Today captions have ONE position for the whole video (`SubtitleConfig.position` +
optional global `x,y`, applied to every block in `Subtitles.tsx`). We want
caption position to be **per-clip**, and a **"Smart placement"** mode that
*adapts per shot* — Diary-of-a-CEO style:

- speaker centered → caption at the **bottom**,
- speaker off to one side (wide frames) → caption in the **empty space on the
  other side**,
- it **switches** shot-by-shot based on where the person is framed in that clip.

This also fixes a general editor limitation: when a clip is **split** (manually,
or because a layout boundary / scene change creates a new clip), each piece
should be able to carry its **own** caption position.

## Naming

- The mode is called **"Smart placement"** (chosen). It is adaptive: bottom or
  side depending on the frame — not "always to the side".
- Manual per-clip control is just the caption position control, scoped to the
  selected clip.

## Core architecture: placement lives ON the clip

Add an optional `captionPlacement` to a clip. Because placement travels with the
clip, **split / reorder / duplicate carry it automatically** — exactly the
behavior asked for.

```ts
// captions for a clip: a position preset OR a free x,y (normalized, center-anchored).
// Absent => fall back to the global SubtitleConfig position/x,y (full back-compat).
interface CaptionPlacement {
  position?: "top" | "middle" | "bottom";
  x?: number; // 0..1
  y?: number; // 0..1
}
```

Attach it in two places so the v2→v3 migration carries it through:

- `FramingSegment.captionPlacement?` (remotion/src/lib/types.ts) — what the
  BACKEND writes (it emits v2 `segments`).
- `TimelineClip.captionPlacement?` (types.ts) — what the EDITOR/RENDER consume.
- `framingToClips()` (edl.ts:60) copies it: `captionPlacement: s.captionPlacement`.
- Add both to the zod schemas (`framingSegmentSchema`, `timelineClipSchema`) —
  zod strips unknown keys, so without this the field is dropped on render.

No change to the global `SubtitleConfig` — it stays as the default/fallback.

## Renderer: position the active block per its clip

`remapCaptions()` (edl.ts:297) already loops over `placedClips(framing)` and
knows the owning clip for every caption word. Minimal change:

1. In `remapCaptions`, when pushing each output word, carry the owning clip's
   placement: `{ ...ws.w, startMs, endMs, _placement: p.clip.captionPlacement }`
   (transient field, not persisted).
2. In `Subtitles.tsx` (currently positions the WHOLE layer once, lines ~244-265):
   only ONE block is visible at a time, so position **the active block's
   container** by `block placement ?? global position/x,y`. The block's
   placement = the placement carried on its words (all share one clip normally;
   if a block straddles a clip boundary, use the first word's clip).

Back-compat: clips with no `captionPlacement` → global position, unchanged. All
existing projects render identically.

## Smart placement computation (the adaptive part)

Per clip, decide bottom vs side from where the speaker lands in the FINAL frame.

Inputs per clip: `trackedFaceIds` + `faceTracks` samples (normalized source
face boxes) + the clip's crop (`cameraKeyframes` / `manualCrop`) + output aspect
(outputWidth/Height). Map the face box through the crop into OUTPUT-normalized
coordinates, average over the clip's frames → the speaker's output box.

GOVERNING RULE for every shot: the caption must NEVER sit over a face. Pick the
open area (side / between two heads / bottom) that keeps it clear; the choice
switches shot to shot.

Decision:

- **9:16 (tall):** reframe centers the speaker → **bottom** (no-op). Smart
  placement is effectively a pass-through here; that's expected and correct.
- **16:9 / 1:1 / 4:5 (wide-ish):**
  - face center in middle third horizontally → **bottom-center**;
  - face center in left third → caption on the **right** (x ≈ 0.72, y ≈ 0.5
    vertically centered in the open side), and vice-versa;
  - clamp so the caption block stays on-screen.
- **two faces in frame (split/two-person):** smart mode DECIDES adaptively —
  **between the two heads** when there's a clear gap, otherwise **bottom**. It
  switches per shot like everything else; not locked to one position.

Where it runs: in `assemble_trailer` (main.py), after `process_video_to_vertical`
writes the framing — read the segments + faceTracks + crop, compute placement
per segment, write `captionPlacement` back into each segment (same read-back-and-
inject pattern already used for `subtitles`/`transitions`). Gated on a
`smart_placement` flag.

## Editor: manual = the existing drag, scoped to the clip

Caption dragging already exists (`CaptionDragOverlay.jsx` over the player). Today
a drag writes the GLOBAL `subtitles.x/y`. The ONLY change: a drag writes the
**current clip's** `captionPlacement` (the clip at the playhead) instead of the
global value. No new control or panel — dragging IS the manual control; it just
becomes per-clip.

- An **"Auto-place (Smart placement)"** button runs the face→placement logic
  on the loaded clips (works on normal clips in the editor too, not only
  trailers).

### Reconciling "this clip" vs "all clips"

Two desires: (a) one consistent caption position for the whole video even though
it's cut from many clips, and (b) a different position for a specific clip. Model
= ONE global position + optional per-clip overrides:

- **Default scope = "All clips."** Dragging moves the GLOBAL position →
  everywhere (today's behavior; the "keep it consistent" case). The global is
  `subtitles.x/y` / `subtitles.position`.
- **"This clip" = an override.** A small scope toggle (next to the caption, or
  right-click the clip) switches the drag to write only `clip.captionPlacement`.
  An overridden clip shows a "custom" badge + a **Reset** that clears it back to
  the global.
- **"Apply to all clips" button** promotes the current clip's position to the
  global and clears other overrides — for "I positioned one, now I want it
  everywhere."
- **Smart placement** is the AUTO version of per-clip overrides (fills them from
  faces). Turning it off clears the overrides → back to the global.

Precedence at render: `clip.captionPlacement` (if set) wins, else the global
`subtitles` position/x,y. (Already how the fallback in the renderer section
works.)

## Scope

- **Foundation (model + renderer + manual editor control): GENERAL** — benefits
  every clip/project, not just trailers.
- **Smart auto-pass: trailer-first, non-9:16.** Opt-in via a "Smart placement"
  toggle on the trailer page (and the editor "Auto-place" button). 9:16 stays
  bottom (correct).

## Phasing

- **Phase 1 — foundation (invisible but functional):** `captionPlacement` on
  segment + clip + zod + migration; `remapCaptions` carries it; `Subtitles.tsx`
  positions the active block per clip with global fallback. Renderer honors
  per-clip placement; nothing sets it yet. Files: remotion/src/lib/types.ts,
  edl.ts, compositions/Subtitles.tsx.
- **Phase 2 — editor manual control:** scope the EXISTING caption drag
  (`CaptionDragOverlay`) to the current clip — a drag writes
  `clip.captionPlacement` instead of global `subtitles.x/y`; save/export already
  persist clips[]. Files: dashboard/src/components/editor/CaptionDragOverlay.jsx,
  useEditorState.js (reducer action), CaptionsPanel.jsx (presets → current clip).
- **Phase 3 — Smart placement auto-pass:** face→output mapping + bottom/side
  decision in main.py `assemble_trailer`; `smart_placement` flag through
  app.py `/api/process` (+ `--smart-placement`); a toggle on TrailerPage; and
  the editor "Auto-place" button. Files: main.py, app.py, TrailerPage.jsx,
  editor.

## Risks / open decisions

- Face→output mapping must be correct per layout (`fit`/blur keeps horizontal
  position; `fill`/track centers; `split` = two boxes). This math is the bulk of
  Phase 3.
- Side captions over busy footage → keep the DOAC drop-shadow; optionally a
  subtle scrim behind side-placed captions.
- Block straddling two clips (rare) → assign to first word's clip.
- RESOLVED — two-person shots: smart mode decides between-vs-bottom adaptively
  (it switches; not locked).
- RESOLVED — global `SubtitleConfig.position` stays the default for clips
  without an override.
- RESOLVED — manual control = the existing caption drag, scoped to the current
  clip (no new UI/panel).

## Self-checks

- Phase 1: a framing with two clips, one `captionPlacement:{position:'middle'}`,
  one none → render shows block 1 mid, block 2 at global position; existing
  no-placement projects unchanged (snapshot).
- Phase 3: pure unit test of the face→placement decision: left-third face in
  16:9 → right placement; centered face → bottom; 9:16 → bottom regardless.
