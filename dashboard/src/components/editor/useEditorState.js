import { useReducer } from 'react';
import { cropForFace, smoothedFaceRect } from '../../remotion/compositions/ReframedVideo';

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
        case 'SET_SUBTITLES': {
            // Caption config lives on the framing object (optional key) so it
            // rides the existing save/export paths. null disables captions.
            return withHistory({ ...state.framing, subtitles: action.subtitles });
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
            const start = Math.max(action.startFrame, f.clipInFrame);
            const end = Math.min(action.endFrame, f.clipOutFrame);
            if (end - start < 2) return state;
            // merge with overlapping/adjacent cuts (within 2 frames)
            const merged = [];
            let cur = { startFrame: start, endFrame: end };
            for (const c of [...f.cuts].sort((a, b) => a.startFrame - b.startFrame)) {
                if (c.endFrame >= cur.startFrame - 2 && c.startFrame <= cur.endFrame + 2) {
                    cur = {
                        startFrame: Math.min(cur.startFrame, c.startFrame),
                        endFrame: Math.max(cur.endFrame, c.endFrame),
                    };
                } else {
                    merged.push(c);
                }
            }
            merged.push(cur);
            merged.sort((a, b) => a.startFrame - b.startFrame);
            // never let cuts consume the whole clip
            const kept = f.clipOutFrame - f.clipInFrame - merged.reduce((acc, c) => acc + (c.endFrame - c.startFrame), 0);
            if (kept < 10) return state;
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
export function buildFillKeyframes(framing, segment, trackId) {
    const track = framing.faceTracks.find((t) => t.id === trackId);
    if (!track) return [];
    const { width: srcW, height: srcH } = framing.source;
    const keyframes = [];
    for (let frame = segment.startFrame; frame < segment.endFrame; frame += 3) {
        const face = smoothedFaceRect(track, frame);
        if (!face) continue;
        const crop = cropForFace(face, 9 / 16, srcW, srcH);
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
        clipInFrame: framing.clipInFrame ?? 0,
        clipOutFrame: framing.clipOutFrame ?? framing.source.durationFrames,
        cuts: framing.cuts ?? [],
        subtitles: framing.subtitles ?? null,
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

/** Persist the current caption style+position as the user's default (E9, brand-template slice). */
export function saveDefaultCaptionStyle(position, style) {
    try {
        localStorage.setItem(CAPTION_DEFAULT_KEY, JSON.stringify({ position, style }));
    } catch { /* storage unavailable */ }
}

function loadDefaultCaptionStyle() {
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
// dashboard/src/remotion/lib/captionTemplates.tsx (CAPTION_TEMPLATES) and
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
