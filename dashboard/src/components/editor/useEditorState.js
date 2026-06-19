import { useReducer } from 'react';
import { cropForFace, smoothedFaceRect } from '@remotion-src/compositions/ReframedVideo';

const HISTORY_LIMIT = 50;

/**
 * Editor state: the framing config being edited (docs/video-editor-plan.md §2),
 * the selected segment ids, a dirty flag for unsaved changes, and an
 * undo/redo history of framing snapshots (framing is immutable, so snapshots
 * are cheap references).
 */
export const editorReducer = (state, action) => {
    // Mutating actions snapshot the current framing for undo
    const withHistory = (framing) => ({
        ...state,
        framing,
        dirty: true,
        past: [...state.past.slice(-HISTORY_LIMIT + 1), state.framing],
        future: [],
    });

    switch (action.type) {
        case 'LOAD':
            return {
                framing: normalizeFraming(action.framing),
                selectedIds: [],
                dirty: false,
                past: [],
                future: [],
            };
        case 'SELECT': {
            const { id, multi } = action;
            if (!multi) return { ...state, selectedIds: [id] };
            const has = state.selectedIds.includes(id);
            return {
                ...state,
                selectedIds: has
                    ? state.selectedIds.filter((s) => s !== id)
                    : [...state.selectedIds, id],
            };
        }
        case 'SET_LAYOUT': {
            // Applies to every selected segment; switching layout clears any
            // manual crop (it belongs to the previous framing decision)
            const segments = state.framing.segments.map((s) =>
                state.selectedIds.includes(s.id)
                    ? { ...s, layout: action.layout, manualCrop: null }
                    : s
            );
            return withHistory({ ...state.framing, segments });
        }
        case 'SET_TRACKED_FACES': {
            const segments = state.framing.segments.map((s) =>
                s.id === action.segmentId
                    ? {
                          ...s,
                          trackedFaceIds: action.faceIds,
                          // For fill layouts the composition follows cameraKeyframes,
                          // so changing the tracked person supplies regenerated ones
                          ...(action.cameraKeyframes
                              ? { cameraKeyframes: action.cameraKeyframes }
                              : {}),
                      }
                    : s
            );
            return withHistory({ ...state.framing, segments });
        }
        case 'SET_MANUAL_CROP': {
            const segments = state.framing.segments.map((s) =>
                s.id === action.segmentId ? { ...s, manualCrop: action.crop } : s
            );
            return withHistory({ ...state.framing, segments });
        }
        case 'SET_ASPECT': {
            // Change the clip's output ratio and re-derive aspect-locked crops:
            // fill keyframes are regenerated from the face track at the new aspect,
            // manual crops are re-cropped around their center. Panel/fit layouts
            // recompute from face tracks/source at render time, so they pass through.
            const { outputWidth, outputHeight } = action;
            const aspect = outputWidth / outputHeight;
            const { width: srcW, height: srcH } = state.framing.source;
            const segments = state.framing.segments.map((s) => {
                let { cameraKeyframes, manualCrop } = s;
                if (manualCrop) {
                    manualCrop = recropToAspect(manualCrop, aspect, srcW, srcH);
                } else if (s.layout === 'fill' && cameraKeyframes?.length) {
                    const trackId = s.trackedFaceIds?.[0];
                    if (trackId != null) {
                        cameraKeyframes = buildFillKeyframes(state.framing, s, trackId, aspect);
                    }
                }
                return { ...s, cameraKeyframes, manualCrop };
            });
            return withHistory({ ...state.framing, outputWidth, outputHeight, segments });
        }
        case 'SET_SUBTITLES': {
            // Caption config lives on the framing object (optional key) so it
            // rides the existing save/export paths. null disables captions.
            // transient: live drag updates skip history so one drag = one undo
            // step (committed on pointer release).
            if (action.transient) {
                return { ...state, framing: { ...state.framing, subtitles: action.subtitles, captionsInitialized: true }, dirty: true };
            }
            // Committing a drag: the transient moves already advanced
            // framing.subtitles, so snapshot the pre-drag state (action.original)
            // onto the undo stack instead of the current (already-moved) one.
            if (action.original !== undefined) {
                return {
                    ...state,
                    framing: { ...state.framing, subtitles: action.subtitles, captionsInitialized: true },
                    dirty: true,
                    past: [...state.past.slice(-HISTORY_LIMIT + 1), { ...state.framing, subtitles: action.original }],
                    future: [],
                };
            }
            return withHistory({ ...state.framing, subtitles: action.subtitles, captionsInitialized: true });
        }
        case 'EDIT_CAPTION_WORD': {
            const subs = state.framing.subtitles;
            if (!subs) return state;
            const captions = subs.captions.map((w, i) =>
                i === action.index ? { ...w, text: action.text } : w
            );
            return withHistory({
                ...state.framing,
                subtitles: { ...subs, captions },
            });
        }
        case 'SET_BOUNDARY': {
            // Move the shared boundary between segment[i] and segment[i+1];
            // contiguity is preserved by construction
            const { boundaryIndex, frame } = action;
            const segs = state.framing.segments;
            const left = segs[boundaryIndex];
            const right = segs[boundaryIndex + 1];
            if (!left || !right) return state;
            const MIN_LEN = 10; // frames
            const clamped = Math.max(
                left.startFrame + MIN_LEN,
                Math.min(frame, right.endFrame - MIN_LEN)
            );
            if (clamped === left.endFrame) return state;
            const segments = segs.map((s, i) => {
                if (i === boundaryIndex) return { ...s, endFrame: clamped };
                if (i === boundaryIndex + 1) return { ...s, startFrame: clamped };
                return s;
            });
            return withHistory({ ...state.framing, segments });
        }
        case 'SPLIT_SEGMENT': {
            // Razor split: divide the segment under the playhead into two
            // independent halves so each can get its own layout/reframe. The
            // frame is a SOURCE frame and must fall strictly inside a segment.
            const { frame } = action;
            const MIN_LEN = 10; // frames
            const segs = state.framing.segments;
            const idx = segs.findIndex((s) => s.startFrame < frame && frame < s.endFrame);
            if (idx === -1) return state;
            const seg = segs[idx];
            if (frame - seg.startFrame < MIN_LEN || seg.endFrame - frame < MIN_LEN) return state;
            const left = { ...seg, endFrame: frame };
            const right = { ...seg, startFrame: frame, id: `${seg.id}-s${Date.now().toString(36)}` };
            const segments = [...segs.slice(0, idx), left, right, ...segs.slice(idx + 1)];
            return withHistory({ ...state.framing, segments });
        }
        case 'SET_CLIP_BOUNDS': {
            // Trim (inward) or extend (outward into the padded source).
            // Invariant: segments always cover exactly [clipIn, clipOut].
            const f = state.framing;
            const MIN_CLIP = 10;
            let clipIn = action.clipInFrame ?? f.clipInFrame;
            let clipOut = action.clipOutFrame ?? f.clipOutFrame;
            clipIn = Math.max(0, Math.min(clipIn, f.source.durationFrames - MIN_CLIP));
            clipOut = Math.max(clipIn + MIN_CLIP, Math.min(clipOut, f.source.durationFrames));
            if (clipIn === f.clipInFrame && clipOut === f.clipOutFrame) return state;
            const segments = fitSegmentsToBounds(f.segments, clipIn, clipOut);
            const cuts = f.cuts
                .map((c) => ({
                    startFrame: Math.max(c.startFrame, clipIn),
                    endFrame: Math.min(c.endFrame, clipOut),
                }))
                .filter((c) => c.endFrame - c.startFrame > 0);
            return withHistory({ ...f, clipInFrame: clipIn, clipOutFrame: clipOut, segments, cuts });
        }
        case 'ADD_CUT': {
            const f = state.framing;
            const merged = mergeCuts(f.cuts, [{ startFrame: action.startFrame, endFrame: action.endFrame }], f.clipInFrame, f.clipOutFrame);
            if (merged === null) return state;
            return withHistory({ ...f, cuts: merged });
        }
        case 'ADD_CUTS': {
            // Apply many cuts in ONE history entry (e.g. speech cleanup).
            const f = state.framing;
            const merged = mergeCuts(f.cuts, action.cuts ?? [], f.clipInFrame, f.clipOutFrame);
            if (merged === null) return state;
            return withHistory({ ...f, cuts: merged });
        }
        case 'REMOVE_CUT': {
            const cuts = state.framing.cuts.filter((_, i) => i !== action.index);
            if (cuts.length === state.framing.cuts.length) return state;
            return withHistory({ ...state.framing, cuts });
        }
        case 'SET_TRANSITIONS':
            return withHistory({ ...state.framing, transitions: { ...state.framing.transitions, ...action.patch } });
        case 'SET_MUSIC':
            return withHistory({ ...state.framing, music: action.music });
        case 'ADD_TEXT_OVERLAY': {
            if ((state.framing.textOverlays || []).length >= 5) return state;
            return withHistory({
                ...state.framing,
                textOverlays: [...(state.framing.textOverlays || []), action.overlay],
            });
        }
        case 'UPDATE_TEXT_OVERLAY':
            return withHistory({
                ...state.framing,
                textOverlays: state.framing.textOverlays.map((o) =>
                    o.id === action.id ? { ...o, ...action.patch } : o
                ),
            });
        case 'REMOVE_TEXT_OVERLAY':
            return withHistory({
                ...state.framing,
                textOverlays: state.framing.textOverlays.filter((o) => o.id !== action.id),
            });
        case 'ADD_BROLL': {
            if ((state.framing.broll || []).length >= 3) return state;
            return withHistory({ ...state.framing, broll: [...(state.framing.broll || []), action.item] });
        }
        case 'REMOVE_BROLL':
            return withHistory({
                ...state.framing,
                broll: state.framing.broll.filter((b) => b.id !== action.id),
            });
        case 'TRACK_PERSON': {
            // Tracker click: in multi-panel layouts, reassign the clicked
            // panel; otherwise (fill/fit/manual) become a fill that follows
            // the clicked person
            const segments = state.framing.segments.map((s) => {
                if (s.id !== action.segmentId) return s;
                // Multi-panel + screenshare/gameplay reassign the clicked panel
                // in place; only true single-crop layouts convert to a tracked fill
                if (['split', 'three', 'four', 'screenshare', 'gameplay'].includes(s.layout) && !s.manualCrop) {
                    const faceIds = [...(s.trackedFaceIds || [])];
                    // Fill any holes before the assigned panel so the array is
                    // dense — a sparse array serializes holes to null and fails
                    // schema validation.
                    for (let i = 0; i < action.panelIdx; i += 1) {
                        if (faceIds[i] === undefined) {
                            faceIds[i] = s.trackedFaceIds?.[0] ?? action.trackId;
                        }
                    }
                    faceIds[action.panelIdx] = action.trackId;
                    return { ...s, trackedFaceIds: faceIds };
                }
                return {
                    ...s,
                    layout: 'fill',
                    trackedFaceIds: [action.trackId],
                    cameraKeyframes: action.cameraKeyframes || s.cameraKeyframes,
                    manualCrop: null,
                };
            });
            return withHistory({ ...state.framing, segments });
        }
        case 'UNDO': {
            if (state.past.length === 0) return state;
            const previous = state.past[state.past.length - 1];
            return {
                ...state,
                framing: previous,
                dirty: true,
                past: state.past.slice(0, -1),
                future: [state.framing, ...state.future],
            };
        }
        case 'REDO': {
            if (state.future.length === 0) return state;
            const [next, ...rest] = state.future;
            return {
                ...state,
                framing: next,
                dirty: true,
                past: [...state.past, state.framing],
                future: rest,
            };
        }
        case 'MARK_SAVED':
            return { ...state, dirty: false };
        default:
            return state;
    }
};

export default function useEditorState() {
    return useReducer(editorReducer, {
        framing: null,
        selectedIds: [],
        dirty: false,
        past: [],
        future: [],
    });
}

/**
 * Face tracks visible inside a segment, sorted by coverage (how much of the
 * segment they span). Used to decide which multi-person layouts are possible
 * and to offer panel assignments. Samples are recorded every ~2 source frames.
 */
export function tracksInSegment(framing, segment) {
    if (!framing || !segment) return [];
    const segLen = Math.max(1, segment.endFrame - segment.startFrame);
    return framing.faceTracks
        .map((t) => {
            const inSeg = t.samples.filter(
                (s) => s.frame >= segment.startFrame && s.frame < segment.endFrame
            );
            return { id: t.id, coverage: inSeg.length / (segLen / 2) };
        })
        .filter((t) => t.coverage > 0.1)
        .sort((a, b) => b.coverage - a.coverage);
}

/** Panels per layout — keep in sync with ReframedVideo.tsx panelsForLayout. */
export const LAYOUT_PANELS = { fill: 1, fit: 1, split: 2, three: 3, four: 4, screenshare: 1, gameplay: 1 };

/**
 * Absolute panel indices that hold a tracked face (the rest are content/screen
 * capture panels). Must match panelsForLayout in ReframedVideo.tsx.
 */
export const FACE_PANEL_INDICES = {
    fill: [0],
    fit: [],
    split: [0, 1],
    three: [0, 1, 2],
    four: [0, 1, 2, 3],
    screenshare: [1], // panel 0 = screen, panel 1 = speaker
    gameplay: [0], // panel 0 = speaker, panel 1 = gameplay
};

/**
 * Regenerate fill-layout camera keyframes by following one face track through
 * a segment (used when the user picks a different person to track). Mirrors
 * the pipeline's output shape; smoothing comes from smoothedFaceRect.
 */
export function buildFillKeyframes(framing, segment, trackId, aspect) {
    const track = framing.faceTracks.find((t) => t.id === trackId);
    if (!track) return [];
    const { width: srcW, height: srcH } = framing.source;
    // Crop aspect follows the clip's output ratio (defaults to 9:16).
    const ar = aspect ?? (framing.outputWidth ?? 1080) / (framing.outputHeight ?? 1920);
    const keyframes = [];
    for (let frame = segment.startFrame; frame < segment.endFrame; frame += 3) {
        const face = smoothedFaceRect(track, frame);
        if (!face) continue;
        const crop = cropForFace(face, ar, srcW, srcH);
        keyframes.push({
            frame,
            x: Number(crop.x.toFixed(4)),
            y: Number(crop.y.toFixed(4)),
            w: Number(crop.w.toFixed(4)),
            h: Number(crop.h.toFixed(4)),
        });
    }
    return keyframes;
}

/**
 * Fold one or more new cut ranges into the existing cut list. Clamps each
 * addition to [clipIn, clipOut], drops ranges shorter than 2 frames, merges
 * any cuts that overlap or sit within 2 frames of each other, and refuses
 * (returns null) if the result would leave fewer than 10 kept frames so a cut
 * can never consume the whole clip. Shared by ADD_CUT and ADD_CUTS so both
 * paths use identical merge/clamp logic.
 */
function mergeCuts(existing, additions, clipIn, clipOut) {
    const clamped = (additions ?? [])
        .map((c) => ({
            startFrame: Math.max(c.startFrame, clipIn),
            endFrame: Math.min(c.endFrame, clipOut),
        }))
        .filter((c) => c.endFrame - c.startFrame >= 2);
    if (clamped.length === 0) return null;
    const merged = [];
    let cur = null;
    for (const c of [...existing, ...clamped].sort((a, b) => a.startFrame - b.startFrame)) {
        if (cur && c.startFrame <= cur.endFrame + 2) {
            cur.endFrame = Math.max(cur.endFrame, c.endFrame);
        } else {
            if (cur) merged.push(cur);
            cur = { startFrame: c.startFrame, endFrame: c.endFrame };
        }
    }
    if (cur) merged.push(cur);
    // never let cuts consume the whole clip
    const kept = clipOut - clipIn - merged.reduce((acc, c) => acc + (c.endFrame - c.startFrame), 0);
    if (kept < 10) return null;
    return merged;
}

/**
 * Re-fit segments to new clip bounds: drop segments fully outside, clamp the
 * survivors, stretch the edges so coverage is exactly [clipIn, clipOut].
 */
function fitSegmentsToBounds(segments, clipIn, clipOut) {
    let segs = segments
        .filter((s) => s.endFrame > clipIn && s.startFrame < clipOut)
        .map((s) => ({
            ...s,
            startFrame: Math.max(s.startFrame, clipIn),
            endFrame: Math.min(s.endFrame, clipOut),
        }));
    if (segs.length === 0) {
        segs = [{
            id: 'seg-trim',
            startFrame: clipIn,
            endFrame: clipOut,
            layout: 'fit',
            trackedFaceIds: [],
            cameraKeyframes: [],
            manualCrop: null,
        }];
    } else {
        segs[0] = { ...segs[0], startFrame: clipIn };
        segs[segs.length - 1] = { ...segs[segs.length - 1], endFrame: clipOut };
    }
    return segs;
}

/**
 * Upgrade any loaded framing (v1 or partial v2) to a fully-populated v2 shape
 * so the reducer, composition, and validator can assume the EDL fields exist.
 */
export function normalizeFraming(framing) {
    return {
        ...framing,
        version: 2,
        // Output canvas dimensions (clip aspect ratio). Older clips predate the
        // field and were all 9:16, so default to 1080x1920.
        outputWidth: framing.outputWidth ?? 1080,
        outputHeight: framing.outputHeight ?? 1920,
        clipInFrame: framing.clipInFrame ?? 0,
        clipOutFrame: framing.clipOutFrame ?? framing.source.durationFrames,
        // Pin the caption origin at load time. New clips already carry it from
        // the backend; older files predate the field, so default to the current
        // (not-yet-trimmed) clipInFrame so subsequent trims don't shift captions.
        captionsOriginFrame: framing.captionsOriginFrame ?? framing.clipInFrame ?? 0,
        cuts: framing.cuts ?? [],
        subtitles: framing.subtitles ?? null,
        // True once captions have been explicitly enabled/disabled (by the user
        // or the upload-time auto-enable), so we don't re-auto-enable a clip the
        // user deliberately turned captions off on.
        captionsInitialized: framing.captionsInitialized ?? false,
        textOverlays: framing.textOverlays ?? [],
        music: framing.music ?? null,
        transitions: framing.transitions ?? { fadeIn: false, fadeOut: false, cutCrossfade: false },
        broll: framing.broll ?? [],
    };
}

const CAPTION_DEFAULT_KEY = 'openshorts_caption_style_default';

const BUILTIN_CAPTION_STYLE = {
    position: 'bottom',
    style: {
        template: 'classic-pop',
        fontFamily: 'Inter',
        fontSize: 56,
        fontColor: '#FFFFFF',
        highlightColor: '#FFDD00',
        borderColor: '#000000',
        borderWidth: 3,
        bgColor: '#000000',
        bgOpacity: 0,
        animation: 'pop',
    },
};

/**
 * Persist the current caption style+position as the user's default (E9, brand-template slice).
 * `enabled` records intent for new clips: true = auto-enable captions on first open,
 * false = "No caption", undefined = never chosen (legacy / no auto-enable).
 */
export function saveDefaultCaptionStyle(position, style, enabled = true) {
    try {
        localStorage.setItem(CAPTION_DEFAULT_KEY, JSON.stringify({ position, style, enabled }));
    } catch { /* storage unavailable */ }
}

export function loadDefaultCaptionStyle() {
    try {
        const raw = localStorage.getItem(CAPTION_DEFAULT_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return BUILTIN_CAPTION_STYLE;
}

/** Default caption styling for newly enabled captions (user default or built-in). */
export function defaultSubtitleConfig(captions) {
    const { position, style } = loadDefaultCaptionStyle();
    return { captions, position, style };
}

// Caption styles are now defined as templates in
// remotion/src/lib/captionTemplates.tsx (CAPTION_TEMPLATES) and
// surfaced by CaptionsPanel — the old CAPTION_PRESETS list lived here.

/** Center crop with a given pixel aspect, in normalized coords. */
export function centerCropRect(panelAspect, srcW, srcH) {
    let cropHpx = srcH;
    let cropWpx = cropHpx * panelAspect;
    if (cropWpx > srcW) {
        cropWpx = srcW;
        cropHpx = cropWpx / panelAspect;
    }
    return {
        x: (srcW - cropWpx) / 2 / srcW,
        y: (srcH - cropHpx) / 2 / srcH,
        w: cropWpx / srcW,
        h: cropHpx / srcH,
    };
}

/**
 * Re-crop an existing normalized crop to a new aspect, preserving its center.
 * Keeps vertical coverage (the crop's height) and adjusts width for the new
 * aspect — used when switching a clip's aspect ratio so manual crops follow.
 */
export function recropToAspect(crop, aspect, srcW, srcH) {
    const cxPx = (crop.x + crop.w / 2) * srcW;
    const cyPx = (crop.y + crop.h / 2) * srcH;
    let cropHpx = crop.h * srcH;
    let cropWpx = cropHpx * aspect;
    if (cropWpx > srcW) { cropWpx = srcW; cropHpx = cropWpx / aspect; }
    if (cropHpx > srcH) { cropHpx = srcH; cropWpx = cropHpx * aspect; }
    const leftPx = Math.min(Math.max(cxPx - cropWpx / 2, 0), srcW - cropWpx);
    const topPx = Math.min(Math.max(cyPx - cropHpx / 2, 0), srcH - cropHpx);
    return { x: leftPx / srcW, y: topPx / srcH, w: cropWpx / srcW, h: cropHpx / srcH };
}
