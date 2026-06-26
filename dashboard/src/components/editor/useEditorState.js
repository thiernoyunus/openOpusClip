import { useReducer } from 'react';
import { cropForFace, smoothedFaceRect } from '@remotion-src/compositions/ReframedVideo';
import { framingToClips } from '@remotion-src/lib/edl';

const HISTORY_LIMIT = 50;
const MIN_CLIP_LEN = 2; // frames — keeps every clip seekable / non-degenerate

// Unique clip ids. A module counter disambiguates clips created in the same
// tick (e.g. a multi-range cut that splits several clips at once).
let _clipSeq = 0;
const newClipId = () => `clip-${Date.now().toString(36)}-${(_clipSeq++).toString(36)}`;

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
            // Applies to every selected clip, or every clip when requested by
            // the global layout menu. Switching layout clears any manual crop
            // because it belongs to the previous framing decision.
            const targetIds = new Set(action.clipIds || state.selectedIds);
            const clips = state.framing.clips.map((c) =>
                action.global || targetIds.has(c.id)
                    ? { ...c, layout: action.layout, manualCrop: null }
                    : c
            );
            return withHistory({ ...state.framing, clips });
        }
        case 'SET_TRACKED_FACES': {
            const clips = state.framing.clips.map((c) =>
                c.id === action.clipId
                    ? {
                          ...c,
                          trackedFaceIds: action.faceIds,
                          // For fill layouts the composition follows cameraKeyframes,
                          // so changing the tracked person supplies regenerated ones
                          ...(action.cameraKeyframes
                              ? { cameraKeyframes: action.cameraKeyframes }
                              : {}),
                      }
                    : c
            );
            return withHistory({ ...state.framing, clips });
        }
        case 'SET_MANUAL_CROP': {
            const clips = state.framing.clips.map((c) =>
                c.id === action.clipId ? { ...c, manualCrop: action.crop } : c
            );
            return withHistory({ ...state.framing, clips });
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
        case 'SET_CLIP_CAPTION_PLACEMENT': {
            // Per-clip caption position override. placement:null clears it (back to
            // the global subtitle position). transient/original mirror SET_SUBTITLES
            // so one drag = one undo step.
            const { clipId, placement } = action;
            const clips = state.framing.clips.map((c) =>
                c.id === clipId ? { ...c, captionPlacement: placement || undefined } : c
            );
            const nextFraming = { ...state.framing, clips };
            if (action.transient) {
                return { ...state, framing: nextFraming, dirty: true };
            }
            if (action.original !== undefined) {
                return {
                    ...state,
                    framing: nextFraming,
                    dirty: true,
                    past: [...state.past.slice(-HISTORY_LIMIT + 1), action.original],
                    future: [],
                };
            }
            return withHistory(nextFraming);
        }
        case 'APPLY_CAPTION_PLACEMENT_TO_ALL': {
            // Promote one placement to the GLOBAL subtitle position and clear every
            // per-clip override, so the whole video uses one consistent position.
            const subs = state.framing.subtitles;
            if (!subs) return state;
            const p = action.placement || {};
            const nextSubs = { ...subs };
            if (typeof p.x === 'number' && typeof p.y === 'number') {
                nextSubs.x = p.x;
                nextSubs.y = p.y;
                // Keep a promoted side caption's narrowed width (else it falls back
                // to the default ~88% and can spill back over the speaker).
                if (typeof p.maxWidthPct === 'number') nextSubs.maxWidthPct = p.maxWidthPct;
                else delete nextSubs.maxWidthPct;
            } else if (p.position) {
                nextSubs.position = p.position;
                delete nextSubs.x;
                delete nextSubs.y;
                delete nextSubs.maxWidthPct;
            }
            const clips = state.framing.clips.map((c) =>
                c.captionPlacement ? { ...c, captionPlacement: undefined } : c
            );
            const nextFraming = { ...state.framing, subtitles: nextSubs, clips };
            // transient/original mirror SET_SUBTITLES so an All-clips DRAG (which
            // both moves the global position AND clears per-clip overrides so the
            // move actually applies everywhere) is one smooth, undoable step.
            if (action.transient) {
                return { ...state, framing: nextFraming, dirty: true };
            }
            if (action.original !== undefined) {
                return {
                    ...state,
                    framing: nextFraming,
                    dirty: true,
                    past: [...state.past.slice(-HISTORY_LIMIT + 1), action.original],
                    future: [],
                };
            }
            return withHistory(nextFraming);
        }
        case 'EDIT_CAPTION_WORD': {
            const subs = state.framing.subtitles;
            if (!subs) return state;
            const patch = action.patch ?? { text: action.text };
            const captions = subs.captions.map((w, i) =>
                i === action.index ? { ...w, ...patch } : w
            );
            return withHistory({
                ...state.framing,
                subtitles: { ...subs, captions },
            });
        }
        case 'SPLIT_CLIP': {
            // Razor split: divide one clip into two adjacent independent clips
            // at a SOURCE frame inside it, so each half can get its own
            // layout/reframe. The clip is identified explicitly (a source frame
            // alone is ambiguous once clips can repeat/reorder).
            const { clipId, sourceFrame } = action;
            const clips = state.framing.clips;
            const idx = clips.findIndex((c) => c.id === clipId);
            if (idx === -1) return state;
            const c = clips[idx];
            if (sourceFrame - c.sourceStart < MIN_CLIP_LEN || c.sourceEnd - sourceFrame < MIN_CLIP_LEN) return state;
            const left = { ...c, sourceEnd: sourceFrame };
            const right = { ...c, sourceStart: sourceFrame, id: newClipId() };
            const next = [...clips.slice(0, idx), left, right, ...clips.slice(idx + 1)];
            return withHistory({ ...state.framing, clips: next });
        }
        case 'SET_CLIP_SOURCE': {
            // Per-clip trim/extend. Later clips ripple automatically (output
            // position is the running cursor in placedClips), so no neighbor edits.
            // Each edge is clamped against the clip's OTHER (original) edge — not
            // against the just-updated one — so the committed value matches the
            // drag preview (which clamps the same way) and one trim never shifts
            // the opposite edge.
            const dur = state.framing.source.durationFrames;
            let changed = false;
            const clips = state.framing.clips.map((c) => {
                if (c.id !== action.id) return c;
                let ss = c.sourceStart;
                let se = c.sourceEnd;
                if (action.sourceStart !== undefined) {
                    ss = Math.max(0, Math.min(action.sourceStart, c.sourceEnd - MIN_CLIP_LEN));
                }
                if (action.sourceEnd !== undefined) {
                    se = Math.min(dur, Math.max(action.sourceEnd, c.sourceStart + MIN_CLIP_LEN));
                }
                if (ss === c.sourceStart && se === c.sourceEnd) return c;
                changed = true;
                return { ...c, sourceStart: ss, sourceEnd: se };
            });
            return changed ? withHistory({ ...state.framing, clips }) : state;
        }
        case 'MOVE_CLIP': {
            // Reorder: array move (playback order == array order).
            const clips = [...state.framing.clips];
            const from = clips.findIndex((c) => c.id === action.id);
            if (from === -1) return state;
            const to = Math.max(0, Math.min(action.toIndex, clips.length - 1));
            if (from === to) return state;
            const [moved] = clips.splice(from, 1);
            clips.splice(to, 0, moved);
            return withHistory({ ...state.framing, clips });
        }
        case 'INSERT_CLIP': {
            // Insert / duplicate a slice of the same source after a given index.
            // action.clip is a TimelineClip without an id (the UI builds it,
            // typically by duplicating a neighbor's source range + framing).
            const clips = [...state.framing.clips];
            const at = Math.max(0, Math.min((action.afterIndex ?? clips.length - 1) + 1, clips.length));
            clips.splice(at, 0, { ...action.clip, id: newClipId() });
            return withHistory({ ...state.framing, clips });
        }
        case 'DELETE_CLIP': {
            // Remove a clip; the gap closes by ripple. Never empty the track.
            if (state.framing.clips.length <= 1) return state;
            const clips = state.framing.clips.filter((c) => c.id !== action.id);
            if (clips.length === state.framing.clips.length) return state;
            return withHistory({ ...state.framing, clips });
        }
        case 'CUT_SOURCE_RANGE': {
            // Remove one or more SOURCE ranges (transcript word-cut / speech
            // cleanup): split the owning clip(s) at the boundaries and drop the
            // covered middles. Batched into ONE history entry.
            const ranges = action.ranges ?? [];
            if (ranges.length === 0) return state;
            const before = totalClipSource(state.framing.clips);
            let clips = state.framing.clips;
            for (const r of ranges) clips = cutRangeFromClips(clips, r.startFrame, r.endFrame);
            if (clips.length === 0) return state; // refuse cutting everything
            if (totalClipSource(clips) === before) return state; // nothing removed
            return withHistory({ ...state.framing, clips });
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
            const clips = state.framing.clips.map((c) => {
                if (c.id !== action.clipId) return c;
                // Multi-panel + screenshare/gameplay reassign the clicked panel
                // in place; only true single-crop layouts convert to a tracked fill
                if (['split', 'three', 'four', 'screenshare', 'gameplay'].includes(c.layout) && !c.manualCrop) {
                    const faceIds = [...(c.trackedFaceIds || [])];
                    // Fill any holes before the assigned panel so the array is
                    // dense — a sparse array serializes holes to null and fails
                    // schema validation.
                    for (let i = 0; i < action.panelIdx; i += 1) {
                        if (faceIds[i] === undefined) {
                            faceIds[i] = c.trackedFaceIds?.[0] ?? action.trackId;
                        }
                    }
                    faceIds[action.panelIdx] = action.trackId;
                    return { ...c, trackedFaceIds: faceIds };
                }
                return {
                    ...c,
                    layout: 'fill',
                    trackedFaceIds: [action.trackId],
                    cameraKeyframes: action.cameraKeyframes || c.cameraKeyframes,
                    manualCrop: null,
                };
            });
            return withHistory({ ...state.framing, clips });
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
 * Face tracks visible inside a clip, sorted by coverage (how much of the clip's
 * source range they span). Used to decide which multi-person layouts are
 * possible and to offer panel assignments. Samples are recorded every ~2 frames.
 */
export function tracksInClip(framing, clip) {
    if (!framing || !clip) return [];
    const len = Math.max(1, clip.sourceEnd - clip.sourceStart);
    return framing.faceTracks
        .map((t) => {
            const inClip = t.samples.filter(
                (s) => s.frame >= clip.sourceStart && s.frame < clip.sourceEnd
            );
            return { id: t.id, coverage: inClip.length / (len / 2) };
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
export function buildFillKeyframes(framing, clip, trackId) {
    const track = framing.faceTracks.find((t) => t.id === trackId);
    if (!track) return [];
    const { width: srcW, height: srcH } = framing.source;
    const keyframes = [];
    for (let frame = clip.sourceStart; frame < clip.sourceEnd; frame += 3) {
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

/** Total source frames covered by the clip list (used to detect no-op cuts). */
function totalClipSource(clips) {
    return clips.reduce((acc, c) => acc + (c.sourceEnd - c.sourceStart), 0);
}

/**
 * Remove a SOURCE range [a, b) from a clip list: split each overlapping clip at
 * the boundaries and drop the covered middle. Preserves order; the first
 * survivor of a split keeps the original id (selection stability), the second
 * gets a fresh one. Clips touched by nothing pass through unchanged.
 */
function cutRangeFromClips(clips, a, b) {
    if (b <= a) return clips;
    const next = [];
    for (const c of clips) {
        const lo = Math.max(c.sourceStart, a);
        const hi = Math.min(c.sourceEnd, b);
        if (hi <= lo) { next.push(c); continue; } // no overlap
        const survivors = [];
        if (lo - c.sourceStart >= MIN_CLIP_LEN) survivors.push({ ...c, sourceEnd: lo });
        if (c.sourceEnd - hi >= MIN_CLIP_LEN) survivors.push({ ...c, sourceStart: hi });
        survivors.forEach((s, i) => next.push(i === 0 ? { ...s, id: c.id } : { ...s, id: newClipId() }));
    }
    return next;
}

/**
 * Upgrade any loaded framing to v3: an ordered clips[] main track. v1/v2
 * (contiguous segments + cuts) are converted via framingToClips so the kept
 * content and order are preserved exactly. Legacy authority (segments, cuts,
 * clip in/out) is dropped to avoid a second source of truth for "what plays".
 */
export function normalizeFraming(framing) {
    // captionsOriginFrame is the immutable caption anchor. New clips carry it;
    // older files predate it, so default to the (pre-trim) clipInFrame so later
    // edits don't shift captions. Computed BEFORE clipInFrame is dropped.
    const captionsOriginFrame = framing.captionsOriginFrame ?? framing.clipInFrame ?? 0;
    const clips =
        Array.isArray(framing.clips) && framing.clips.length > 0
            ? framing.clips
            : framingToClips(framing);

    // Drop legacy fields (segments/cuts/clipIn/clipOut) — clips is authoritative.
    const { segments, cuts, clipInFrame, clipOutFrame, ...rest } = framing;
    void segments; void cuts; void clipInFrame; void clipOutFrame;

    return {
        ...rest,
        version: 3,
        clips,
        captionsOriginFrame,
        // Output canvas dimensions (clip aspect ratio). Older clips predate the
        // field and were all 9:16, so default to 1080x1920.
        outputWidth: framing.outputWidth ?? 1080,
        outputHeight: framing.outputHeight ?? 1920,
        subtitles: framing.subtitles ?? null,
        // True once captions have been explicitly enabled/disabled, so we don't
        // re-auto-enable a clip the user deliberately turned captions off on.
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
        captionAnimation: 'none',
        wordAnimation: 'none',
        emojiAnimation: 'pop-in',
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
