import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Play, Pause, SkipBack, Scissors, Trash2, Copy, ZoomIn, ZoomOut, Plus, Type, Clapperboard, Music, Volume2, Image as ImageIcon } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { useFilmstrip, useWaveform } from './useMediaStrips';
import { placedClips, outputToSource, clipAtOutputFrame, sourceRangeToOutputWindows } from '@remotion-src/lib/edl';

const FILM_COUNT = 48; // global thumbnails sampled across the source, sliced per clip
const WAVE_BUCKETS = 480;
const MIN_CLIP_LEN = 2; // source frames — mirrors the reducer
const MIN_ITEM_LEN = 2; // source frames — min length for a text/b-roll block
const MIN_AUDIO_LEN = 2; // OUTPUT frames — min length for an audio block
const SNAP_PX = 8; // snap when a dragged edge is within this many pixels of a candidate
const MIN_PPS = 12;
const MAX_PPS = 320;
const MIN_TL_HEIGHT = 140;
const MAX_TL_HEIGHT = 420;
const LAYOUT_LABEL = { fill: 'Fill', fit: 'Fit', split: 'Split', three: 'Three', four: 'Four', screenshare: 'Screen', gameplay: 'Gameplay' };

const clampHeight = (h) => Math.max(MIN_TL_HEIGHT, Math.min(MAX_TL_HEIGHT, h));

/**
 * Apply an in-progress drag to one source-anchored track item (text overlay /
 * b-roll), returning its patched { startFrame, endFrame } in SOURCE frames. The
 * dragged output delta is converted back to source via outputToSource at the
 * item's first output window, so the block follows the cursor on the OUTPUT axis
 * while staying anchored to content. Mirrors the clamp math used at commit.
 */
function itemDragPatch(framing, item, drag, fps) {
    const wins = sourceRangeToOutputWindows(framing, item.startFrame, item.endFrame, fps);
    if (wins.length === 0) return { startFrame: item.startFrame, endFrame: item.endFrame };
    const w = wins[0];
    const d = drag.deltaOut || 0;
    const dur = framing.source.durationFrames;
    if (drag.kind === 'item-trim') {
        if (drag.edge === 'in') {
            let ns = outputToSource(framing, Math.max(0, w.outStart + d), fps);
            ns = Math.max(0, Math.min(ns, item.endFrame - MIN_ITEM_LEN));
            return { startFrame: ns, endFrame: item.endFrame };
        }
        let ne = outputToSource(framing, Math.max(0, w.outEnd + d), fps);
        ne = Math.min(dur, Math.max(ne, item.startFrame + MIN_ITEM_LEN));
        return { startFrame: item.startFrame, endFrame: ne };
    }
    // item-move: shift both edges by the same source delta, preserving length.
    const len = item.endFrame - item.startFrame;
    const nsStart = outputToSource(framing, Math.max(0, w.outStart + d), fps);
    let start = item.startFrame + (nsStart - w.srcStart);
    start = Math.max(0, Math.min(start, dur - len));
    return { startFrame: start, endFrame: start + len };
}

/**
 * Apply an in-progress drag to one OUTPUT-anchored item (audio block, or an
 * overlay with anchor:'output'), returning its patched { startFrame, endFrame }
 * in OUTPUT frames. No source mapping — the drag delta is already in output
 * frames — so this is a small direct clamp helper (simpler than itemDragPatch).
 * Mirrors the commit math. Left-trim outward is additionally clamped by how
 * much trimmed-off content actually exists (trimBefore): you can only reveal
 * audio that was previously trimmed away, not invent earlier content.
 */
function audioDragPatch(item, drag, totalOut) {
    const d = drag.deltaOut || 0;
    if (drag.kind === 'item-trim') {
        if (drag.edge === 'in') {
            // Audio only: can't reveal content earlier than the file provides
            // (trimBefore is all that's been trimmed off). Overlays (images /
            // restarting video) have no content-start bound.
            const contentStart = drag.lane === 'audio' ? item.startFrame - (item.trimBefore || 0) : 0;
            const ns = Math.max(0, contentStart, Math.min(item.startFrame + d, item.endFrame - MIN_AUDIO_LEN));
            return { startFrame: ns, endFrame: item.endFrame };
        }
        const ne = Math.min(totalOut, Math.max(item.endFrame + d, item.startFrame + MIN_AUDIO_LEN));
        return { startFrame: item.startFrame, endFrame: ne };
    }
    // item-move: shift both edges, preserve length, clamp into [0, totalOut].
    const len = item.endFrame - item.startFrame;
    const start = Math.max(0, Math.min(item.startFrame + d, totalOut - len));
    return { startFrame: start, endFrame: start + len };
}

/**
 * Nearest snap candidate to any of the dragged edges, within SNAP_PX. Returns
 * { gap, snapFrame } where gap (output frames) is what to add to the drag delta
 * so the closest edge lands exactly on the candidate, or null if nothing snaps.
 */
function bestSnap(edgeFrames, candidates, pxPerFrame) {
    let best = null;
    for (const ef of edgeFrames) {
        for (const c of candidates) {
            const dpx = Math.abs(c - ef) * pxPerFrame;
            if (dpx <= SNAP_PX && (!best || dpx < best.dpx)) {
                best = { dpx, gap: c - ef, snapFrame: c };
            }
        }
    }
    return best;
}

/**
 * Static snap targets for a drag, built ONCE at drag start (the playhead frame
 * is added live on each move). Candidates: frame 0, end of timeline, every
 * placed clip boundary, and every OTHER lane item's output-window edges.
 */
function buildSnapCandidates(framing, fps, excludeId) {
    const placed = placedClips(framing, fps);
    const totalOut = placed.reduce((a, p) => a + p.outDuration, 0);
    const set = new Set([0, totalOut]);
    for (const p of placed) {
        set.add(p.outStart);
        set.add(p.outStart + p.outDuration);
    }
    for (const item of [...(framing.textOverlays || []), ...(framing.broll || []), ...(framing.overlays || [])]) {
        if (item.id === excludeId) continue;
        for (const w of sourceRangeToOutputWindows(framing, item.startFrame, item.endFrame, fps)) {
            set.add(w.outStart);
            set.add(w.outEnd);
        }
    }
    for (const a of (framing.audio || [])) {
        if (a.id === excludeId) continue;
        set.add(a.startFrame);
        set.add(a.endFrame);
    }
    return [...set];
}

const fmt = (frames) => {
    const totalSec = frames / EDITOR_FPS;
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    const cs = Math.floor((totalSec % 1) * 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

/** Slice an evenly-spaced strip (thumbs/peaks) to a source fraction window. */
const fracSlice = (arr, s0, s1) => {
    if (!arr || arr.length === 0) return arr || [];
    const n = arr.length;
    const a = Math.max(0, Math.floor(s0 * n));
    const b = Math.min(n, Math.max(a + 1, Math.ceil(s1 * n)));
    return arr.slice(a, b);
};

/**
 * Apply an in-progress drag to the clip list so the live layout (positions +
 * ripple) can be computed from placedClips without mutating the real state.
 */
function applyDrag(clips, drag, totalSrc) {
    if (!drag) return clips;
    if (drag.kind === 'trim') {
        return clips.map((c) => {
            if (c.id !== drag.id) return c;
            if (drag.edge === 'in') {
                const ss = Math.max(0, Math.min(c.sourceStart + drag.deltaSrc, c.sourceEnd - MIN_CLIP_LEN));
                return { ...c, sourceStart: ss };
            }
            const se = Math.min(totalSrc, Math.max(c.sourceEnd + drag.deltaSrc, c.sourceStart + MIN_CLIP_LEN));
            return { ...c, sourceEnd: se };
        });
    }
    if (drag.kind === 'move') {
        const from = clips.findIndex((c) => c.id === drag.id);
        if (from === -1) return clips;
        const to = Math.max(0, Math.min(drag.toIndex, clips.length - 1));
        if (to === from) return clips;
        const next = [...clips];
        const [m] = next.splice(from, 1);
        next.splice(to, 0, m);
        return next;
    }
    return clips;
}

/**
 * One clip on the track. Memoized so the per-frame playhead updates (which
 * re-render the parent) don't re-render every block — only props change them
 * (zoom, selection, a drag affecting this clip, or the thumbnails arriving).
 */
const ClipBlock = React.memo(function ClipBlock({
    clip, left, width, selected, dragging, thumbs, peaks, totalSrc,
    onBodyDown, onTrimDown, onDuplicate, onDelete,
}) {
    const s0 = clip.sourceStart / totalSrc;
    const s1 = clip.sourceEnd / totalSrc;
    const clipThumbs = useMemo(() => fracSlice(thumbs, s0, s1), [thumbs, s0, s1]);
    const clipPeaks = useMemo(() => fracSlice(peaks, s0, s1), [peaks, s0, s1]);

    return (
        <div
            onPointerDown={(e) => onBodyDown(clip.id, e)}
            style={{ left, width }}
            className={`absolute top-0 bottom-0 rounded-md overflow-hidden border cursor-grab active:cursor-grabbing group ${
                selected ? 'border-viral ring-1 ring-viral' : 'border-edge hover:border-white/40'
            } ${dragging ? 'opacity-80 z-30' : 'z-10'}`}
        >
            {/* Thumbnails */}
            <div className="absolute inset-0 flex bg-black pointer-events-none">
                {clipThumbs.length === 0 ? (
                    <div className="w-full h-full bg-surface2/30" />
                ) : (
                    clipThumbs.map((src, i) => (
                        <img key={i} src={src} alt="" draggable={false} className="h-full object-cover" style={{ width: `${100 / clipThumbs.length}%` }} />
                    ))
                )}
            </div>
            {/* Waveform along the bottom */}
            <div className="absolute left-0 right-0 bottom-0 h-5 flex items-end gap-px px-px bg-black/40 pointer-events-none">
                {(clipPeaks || []).map((v, i) => (
                    <div key={i} className="flex-1 bg-zinc-300/70 rounded-sm" style={{ height: `${Math.max(8, v * 100)}%` }} />
                ))}
            </div>
            {/* Layout label */}
            <span className="absolute top-1 left-1.5 text-[10px] font-medium px-1.5 py-px rounded bg-black/60 text-zinc-100 pointer-events-none">
                {LAYOUT_LABEL[clip.layout] || clip.layout}
            </span>
            {/* Hover toolbar: duplicate / delete */}
            <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onDuplicate(clip.id); }}
                    title="Duplicate clip"
                    className="w-5 h-5 rounded bg-black/60 text-zinc-200 hover:text-white flex items-center justify-center"
                >
                    <Copy size={11} />
                </button>
                <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
                    title="Delete clip"
                    className="w-5 h-5 rounded bg-black/60 text-zinc-200 hover:text-red-400 flex items-center justify-center"
                >
                    <Trash2 size={11} />
                </button>
            </div>
            {/* Trim handles */}
            {['in', 'out'].map((edge) => (
                <div
                    key={edge}
                    onPointerDown={(e) => onTrimDown(clip.id, edge, e)}
                    className={`absolute top-0 bottom-0 ${edge === 'in' ? 'left-0' : 'right-0'} w-2 cursor-ew-resize bg-amber-400/0 hover:bg-amber-400/40`}
                    title={edge === 'in' ? 'Trim clip start' : 'Trim clip end'}
                >
                    <div className="mx-auto w-[3px] h-full bg-amber-400/70 opacity-0 group-hover:opacity-100" />
                </div>
            ))}
        </div>
    );
});

/**
 * One source-anchored item (text overlay / b-roll) on a compact lane. Positioned
 * on the OUTPUT axis via one of its output windows. The FIRST window carries the
 * drag/trim handles; later windows are 50%-opacity echoes (no interaction).
 */
const LaneBlock = React.memo(function LaneBlock({
    lane, itemId, label, Icon, colorClass, left, width, echo, selected, dragging,
    onBodyDown, onTrimDown,
}) {
    return (
        <div
            onPointerDown={echo ? undefined : (e) => onBodyDown(lane, itemId, e)}
            style={{ left, width }}
            title={label}
            className={`absolute top-0 bottom-0 rounded border flex items-center px-1.5 text-[10px] overflow-hidden group ${colorClass} ${
                echo ? 'opacity-50 pointer-events-none' : 'cursor-grab active:cursor-grabbing'
            } ${selected ? 'ring-1 ring-viral border-viral' : ''} ${dragging ? 'opacity-80 z-30' : 'z-10'}`}
        >
            {Icon && <Icon size={10} className="mr-1 shrink-0 pointer-events-none" />}
            <span className="truncate pointer-events-none">{label}</span>
            {!echo && ['in', 'out'].map((edge) => (
                <div
                    key={edge}
                    onPointerDown={(e) => onTrimDown(lane, itemId, edge, e)}
                    className={`absolute top-0 bottom-0 ${edge === 'in' ? 'left-0' : 'right-0'} w-1.5 cursor-ew-resize hover:bg-white/40`}
                    title={edge === 'in' ? 'Trim start' : 'Trim end'}
                />
            ))}
        </div>
    );
});

/**
 * One OUTPUT-anchored audio item (music / sfx) on the audio lane. Positioned
 * directly from its output frames (no source-window mapping, no echoes). Body =
 * move, edges = trim. When fadeInSec/fadeOutSec > 0 a subtle triangular gradient
 * ramp is drawn inside the corresponding edge (pure CSS, no library).
 */
const AUDIO_WAVE_BUCKETS = 80;

const AudioBlock = React.memo(function AudioBlock({
    itemId, url, label, Icon, colorClass, left, width, fadeInPx, fadeOutPx, selected, dragging,
    onBodyDown, onTrimDown,
}) {
    // Mini waveform decoded from the audio file itself (same hook as ClipBlock).
    const peaks = useWaveform(url, AUDIO_WAVE_BUCKETS);
    return (
        <div
            onPointerDown={(e) => onBodyDown('audio', itemId, e)}
            style={{ left, width }}
            title={label}
            className={`absolute top-0 bottom-0 rounded border flex items-center px-1.5 text-[10px] overflow-hidden cursor-grab active:cursor-grabbing group ${colorClass} ${
                selected ? 'ring-1 ring-viral border-viral' : ''
            } ${dragging ? 'opacity-80 z-30' : 'z-10'}`}
        >
            {/* Waveform along the bottom, behind the label (1px bars). */}
            {peaks && peaks.length > 0 && (
                <div className="absolute left-0 right-0 bottom-0 h-2/3 flex items-end gap-px px-px pointer-events-none opacity-60">
                    {peaks.map((v, i) => (
                        <div key={i} className="flex-1 bg-current rounded-sm" style={{ height: `${Math.max(6, v * 100)}%` }} />
                    ))}
                </div>
            )}
            {fadeInPx > 0 && (
                <div
                    className="absolute inset-y-0 left-0 pointer-events-none"
                    style={{ width: fadeInPx, background: 'linear-gradient(to right bottom, transparent 50%, rgba(255,255,255,0.18) 50%)' }}
                />
            )}
            {fadeOutPx > 0 && (
                <div
                    className="absolute inset-y-0 right-0 pointer-events-none"
                    style={{ width: fadeOutPx, background: 'linear-gradient(to left bottom, transparent 50%, rgba(255,255,255,0.18) 50%)' }}
                />
            )}
            {Icon && <Icon size={10} className="mr-1 shrink-0 pointer-events-none relative z-10" />}
            <span className="truncate pointer-events-none relative z-10">{label}</span>
            {['in', 'out'].map((edge) => (
                <div
                    key={edge}
                    onPointerDown={(e) => onTrimDown('audio', itemId, edge, e)}
                    className={`absolute top-0 bottom-0 ${edge === 'in' ? 'left-0' : 'right-0'} w-1.5 cursor-ew-resize hover:bg-white/40 z-20`}
                    title={edge === 'in' ? 'Trim start' : 'Trim end'}
                />
            ))}
        </div>
    );
});

/**
 * The playhead line + head. Subscribes to the player's frameupdate event itself
 * and owns the "keep in view" auto-scroll, so per-frame playback updates
 * re-render ONLY this component — never the lanes/panels tree.
 */
const Playhead = React.memo(function Playhead({ playerRef, pxPerFrame, trackRef }) {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const p = playerRef.current;
        if (!p) return undefined;
        const onF = (e) => setFrame(e.detail.frame);
        p.addEventListener('frameupdate', onF);
        return () => p.removeEventListener('frameupdate', onF);
    }, [playerRef]);

    // Keep the playhead in view during playback / seeks.
    useEffect(() => {
        const el = trackRef.current;
        if (!el) return;
        const x = frame * pxPerFrame;
        if (x < el.scrollLeft + 40) el.scrollLeft = Math.max(0, x - 40);
        else if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - el.clientWidth + 40;
    }, [frame, pxPerFrame, trackRef]);

    return (
        <div className="absolute top-0 bottom-0 w-px bg-fg pointer-events-none z-40" style={{ left: frame * pxPerFrame }}>
            <div className="absolute -top-0.5 -left-[3px] w-[7px] h-[7px] rounded-full bg-fg" />
        </div>
    );
});

/**
 * Output-axis NLE timeline: the main track is the ordered clip list laid
 * end-to-end (playback order). Clips can be selected, split, trimmed, reordered
 * (drag), duplicated and deleted, with zoom + horizontal scroll. Compact lanes
 * above (text, b-roll) and below (audio) show the source-anchored tracks. The
 * playhead, ruler and seeking all live on the OUTPUT timeline.
 */
export default function EditorTimeline({ framing, playerRef, selectedIds, onSelect, dispatch, sourceUrl, onSelectTrackItem }) {
    const [outFrame, setOutFrame] = useState(0); // throttled — time display + split enablement only
    const [playing, setPlaying] = useState(false);
    const [pxPerSec, setPxPerSec] = useState(60);
    const [drag, setDrag] = useState(null);
    const [selectedItem, setSelectedItem] = useState(null); // { lane, id } — highlights a lane block
    const [timelineHeight, setTimelineHeight] = useState(() => {
        try {
            const v = Number(localStorage.getItem('editorTimelineHeight'));
            return clampHeight(Number.isFinite(v) && v ? v : 200);
        } catch {
            return 200; // localStorage can throw in strict-privacy / sandboxed contexts
        }
    });
    const trackRef = useRef(null);
    const dragRef = useRef(null);
    const resizeRef = useRef(null);
    const outTickRef = useRef(0);

    const fps = EDITOR_FPS;
    const srcFps = framing.source.fps;
    const totalSrc = framing.source.durationFrames;
    const pxPerFrame = pxPerSec / fps;

    // Global strips from the source video, sliced per clip by source fraction.
    const thumbs = useFilmstrip(sourceUrl, FILM_COUNT);
    const peaks = useWaveform(sourceUrl, WAVE_BUCKETS);

    // Live layout: clips with any in-progress drag applied, placed end-to-end.
    const liveClips = useMemo(() => applyDrag(framing.clips, drag, totalSrc), [framing.clips, drag, totalSrc]);
    const placed = useMemo(() => placedClips({ ...framing, clips: liveClips }, fps), [framing, liveClips, fps]);
    const totalOut = useMemo(() => placed.reduce((a, p) => a + p.outDuration, 0) || 1, [placed]);
    const trackWidth = totalOut * pxPerFrame;

    // Player sync. The precise per-frame playhead + auto-scroll live in the
    // <Playhead> child (its own subscription) so playback doesn't re-render the
    // lanes. Here we only keep a THROTTLED outFrame (~10/s) for the time readout
    // and the split-enabled check — coarse is fine and memoized lanes bail out.
    useEffect(() => {
        const p = playerRef.current;
        if (!p) return undefined;
        const onF = (e) => {
            // Throttle only during playback; when paused (manual scrub/seek) let
            // every update through so the time display + split stay exact.
            const now = performance.now();
            if (p.isPlaying?.() && now - outTickRef.current < 100) return;
            outTickRef.current = now;
            setOutFrame(e.detail.frame);
        };
        const onPlay = () => setPlaying(true);
        const onPause = () => { setPlaying(false); setOutFrame(p.getCurrentFrame()); };
        p.addEventListener('frameupdate', onF);
        p.addEventListener('play', onPlay);
        p.addEventListener('pause', onPause);
        return () => {
            p.removeEventListener('frameupdate', onF);
            p.removeEventListener('play', onPlay);
            p.removeEventListener('pause', onPause);
        };
    }, [playerRef]);

    const seekToOut = useCallback((out) => {
        const p = playerRef.current;
        if (!p) return;
        p.pause();
        p.seekTo(Math.max(0, Math.min(Math.round(out), totalOut - 1)));
    }, [playerRef, totalOut]);

    const togglePlay = useCallback(() => {
        const p = playerRef.current;
        if (!p) return;
        if (p.isPlaying()) p.pause();
        else p.play();
    }, [playerRef]);

    const outFrameAtClientX = useCallback((clientX) => {
        const el = trackRef.current;
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        const x = clientX - rect.left + el.scrollLeft;
        return Math.max(0, Math.min(Math.round(x / pxPerFrame), totalOut - 1));
    }, [pxPerFrame, totalOut]);

    // --- Split / delete / duplicate ---
    const playClip = clipAtOutputFrame(framing, outFrame, fps);
    const srcAtPlayhead = outputToSource(framing, outFrame, fps);
    const canSplit = !!playClip
        && srcAtPlayhead - playClip.clip.sourceStart >= MIN_CLIP_LEN
        && playClip.clip.sourceEnd - srcAtPlayhead >= MIN_CLIP_LEN;
    const handleSplit = useCallback(() => {
        // Read the live player frame (not the throttled state) so the split lands
        // exactly at the playhead.
        const f = Math.round(playerRef.current?.getCurrentFrame() ?? outFrame);
        const pc = clipAtOutputFrame(framing, f, fps);
        if (!pc) return;
        dispatch({ type: 'SPLIT_CLIP', clipId: pc.clip.id, sourceFrame: outputToSource(framing, f, fps) });
    }, [framing, outFrame, fps, dispatch, playerRef]);

    const selectedId = selectedIds[0] ?? null;
    const canDelete = selectedId && framing.clips.length > 1;
    const handleDelete = useCallback((id) => {
        if (framing.clips.length <= 1) return;
        dispatch({ type: 'DELETE_CLIP', id });
    }, [framing.clips.length, dispatch]);

    const duplicateClip = useCallback((id) => {
        const idx = framing.clips.findIndex((c) => c.id === id);
        if (idx === -1) return;
        const c = framing.clips[idx];
        dispatch({
            type: 'INSERT_CLIP',
            afterIndex: idx,
            clip: {
                sourceStart: c.sourceStart,
                sourceEnd: c.sourceEnd,
                layout: c.layout,
                trackedFaceIds: [...c.trackedFaceIds],
                cameraKeyframes: c.cameraKeyframes,
                manualCrop: c.manualCrop,
            },
        });
    }, [framing.clips, dispatch]);

    // --- Drag (trim / reorder) + ruler scrub ---
    const onBodyDown = useCallback((id, e) => {
        if (e.button !== 0) return;
        const nd = { kind: 'pending', id, startX: e.clientX };
        dragRef.current = nd;
        setDrag(nd);
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, []);

    const onTrimDown = useCallback((id, edge, e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const nd = { kind: 'trim', id, edge, startX: e.clientX, deltaSrc: 0, snapFrames: buildSnapCandidates(framing, fps, id), snapX: null };
        dragRef.current = nd;
        setDrag(nd);
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, [framing, fps]);

    const rulerDown = useCallback((e) => {
        if (e.button !== 0) return;
        seekToOut(outFrameAtClientX(e.clientX));
        const nd = { kind: 'scrub' };
        dragRef.current = nd;
        setDrag(nd);
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, [seekToOut, outFrameAtClientX]);

    // --- Lane item drag (text / b-roll) ---
    const onItemBodyDown = useCallback((lane, itemId, e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const nd = { kind: 'item-pending', lane, itemId, startX: e.clientX, deltaOut: 0, snapFrames: buildSnapCandidates(framing, fps, itemId), snapX: null };
        dragRef.current = nd;
        setDrag(nd);
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, [framing, fps]);

    const onItemTrimDown = useCallback((lane, itemId, edge, e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const nd = { kind: 'item-trim', lane, itemId, edge, startX: e.clientX, deltaOut: 0, snapFrames: buildSnapCandidates(framing, fps, itemId), snapX: null };
        dragRef.current = nd;
        setDrag(nd);
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, [framing, fps]);

    const onPointerMove = useCallback((e) => {
        const d = dragRef.current;
        if (!d) return;
        if (d.kind === 'scrub') {
            seekToOut(outFrameAtClientX(e.clientX));
            return;
        }
        // Snap a lane-item drag (text / overlay / broll / audio). Hold Alt to
        // disable. Edges are the block's live output-window edges; candidates are
        // the static set stashed at drag start plus the CURRENT playhead frame.
        const snapItem = (dd, deltaOut) => {
            if (e.altKey || !dd.snapFrames) return { deltaOut, snapX: null };
            const playhead = Math.round(playerRef.current?.getCurrentFrame() ?? 0);
            const candidates = [...dd.snapFrames, playhead];
            let edges = null;
            if (dd.lane === 'audio') {
                const item = (framing.audio || []).find((a) => a.id === dd.itemId);
                if (item) {
                    const p = audioDragPatch(item, { ...dd, deltaOut }, totalOut);
                    edges = dd.kind === 'item-trim' ? [dd.edge === 'in' ? p.startFrame : p.endFrame] : [p.startFrame, p.endFrame];
                }
            } else {
                const list = dd.lane === 'text' ? framing.textOverlays : dd.lane === 'overlay' ? framing.overlays : framing.broll;
                const item = (list || []).find((x) => x.id === dd.itemId);
                if (item && item.anchor === 'output') {
                    // Output-anchored overlay: frames are already output frames.
                    const p = audioDragPatch(item, { ...dd, deltaOut }, totalOut);
                    edges = dd.kind === 'item-trim' ? [dd.edge === 'in' ? p.startFrame : p.endFrame] : [p.startFrame, p.endFrame];
                } else if (item) {
                    const p = itemDragPatch(framing, item, { ...dd, deltaOut }, fps);
                    const wins = sourceRangeToOutputWindows(framing, p.startFrame, p.endFrame, fps);
                    if (wins.length) {
                        const a = wins[0].outStart;
                        const b = wins[wins.length - 1].outEnd;
                        edges = dd.kind === 'item-trim' ? [dd.edge === 'in' ? a : b] : [a, b];
                    }
                }
            }
            if (!edges) return { deltaOut, snapX: null };
            const best = bestSnap(edges, candidates, pxPerFrame);
            return best ? { deltaOut: deltaOut + best.gap, snapX: best.snapFrame * pxPerFrame } : { deltaOut, snapX: null };
        };

        if (d.kind === 'item-pending' || d.kind === 'item-move') {
            const dxi = e.clientX - d.startX;
            if (d.kind === 'item-pending' && Math.abs(dxi) < 4) return;
            const snapped = snapItem(d, Math.round(dxi / pxPerFrame));
            const nd = { ...d, kind: 'item-move', deltaOut: snapped.deltaOut, snapX: snapped.snapX };
            dragRef.current = nd;
            setDrag(nd);
            return;
        }
        if (d.kind === 'item-trim') {
            const snapped = snapItem(d, Math.round((e.clientX - d.startX) / pxPerFrame));
            const nd = { ...d, deltaOut: snapped.deltaOut, snapX: snapped.snapX };
            dragRef.current = nd;
            setDrag(nd);
            return;
        }
        const dx = e.clientX - d.startX;
        if (d.kind === 'trim') {
            let deltaSrc = Math.round((dx / pxPerFrame) * (srcFps / fps));
            let snapX = null;
            if (!e.altKey && d.snapFrames) {
                const liveClips = applyDrag(framing.clips, { kind: 'trim', id: d.id, edge: d.edge, deltaSrc }, totalSrc);
                const lp = placedClips({ ...framing, clips: liveClips }, fps).find((p) => p.clip.id === d.id);
                if (lp) {
                    const edge = d.edge === 'in' ? lp.outStart : lp.outStart + lp.outDuration;
                    const playhead = Math.round(playerRef.current?.getCurrentFrame() ?? 0);
                    const best = bestSnap([edge], [...d.snapFrames, playhead], pxPerFrame);
                    if (best) { deltaSrc += Math.round(best.gap * (srcFps / fps)); snapX = best.snapFrame * pxPerFrame; }
                }
            }
            const nd = { ...d, deltaSrc, snapX };
            dragRef.current = nd;
            setDrag(nd);
        } else if (d.kind === 'pending' || d.kind === 'move') {
            if (d.kind === 'pending' && Math.abs(dx) < 4) return;
            const el = trackRef.current;
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left + el.scrollLeft;
            const real = placedClips(framing, fps).filter((p) => p.clip.id !== d.id);
            const toIndex = real.filter((p) => (p.outStart + p.outDuration / 2) * pxPerFrame < x).length;
            const nd = { ...d, kind: 'move', toIndex };
            dragRef.current = nd;
            setDrag(nd);
        }
    }, [pxPerFrame, srcFps, fps, framing, seekToOut, outFrameAtClientX, totalOut, totalSrc, playerRef]);

    const endDrag = useCallback((e) => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!d) return;
        if (d.kind === 'item-move' || d.kind === 'item-trim') {
            if (d.lane === 'audio') {
                // OUTPUT-anchored: direct patch in output frames. Trimming the LEFT
                // edge also advances trimBefore by the same amount so the audio
                // content stays put instead of sliding (CapCut behaviour).
                const item = (framing.audio || []).find((a) => a.id === d.itemId);
                if (item) {
                    const p = audioDragPatch(item, d, totalOut);
                    if (p.startFrame !== item.startFrame || p.endFrame !== item.endFrame) {
                        const patch = { startFrame: p.startFrame, endFrame: p.endFrame };
                        if (d.kind === 'item-trim' && d.edge === 'in') {
                            patch.trimBefore = Math.max(0, (item.trimBefore || 0) + (p.startFrame - item.startFrame));
                        }
                        dispatch({ type: 'UPDATE_AUDIO', id: d.itemId, patch });
                    }
                }
                return;
            }
            const list = d.lane === 'text' ? framing.textOverlays : d.lane === 'overlay' ? framing.overlays : framing.broll;
            const item = (list || []).find((x) => x.id === d.itemId);
            if (item) {
                // anchor:'output' overlays commit in output frames directly —
                // running them through the source mapping would corrupt them.
                const patch = item.anchor === 'output'
                    ? audioDragPatch(item, d, totalOut)
                    : itemDragPatch(framing, item, d, fps);
                if (patch.startFrame !== item.startFrame || patch.endFrame !== item.endFrame) {
                    const type = d.lane === 'text' ? 'UPDATE_TEXT_OVERLAY' : d.lane === 'overlay' ? 'UPDATE_OVERLAY' : 'UPDATE_BROLL';
                    dispatch({ type, id: d.itemId, patch });
                }
            }
            return;
        }
        if (d.kind === 'item-pending') {
            // never moved → treat as a click: select the block + open its panel.
            // Overlays edit through the B-roll panel (until B4 splits them out).
            setSelectedItem({ lane: d.lane, id: d.itemId });
            onSelectTrackItem?.(d.lane === 'overlay' ? 'broll' : d.lane, d.itemId);
            return;
        }
        if (d.kind === 'trim') {
            const clip = framing.clips.find((c) => c.id === d.id);
            if (clip && d.deltaSrc) {
                dispatch(d.edge === 'in'
                    ? { type: 'SET_CLIP_SOURCE', id: d.id, sourceStart: clip.sourceStart + d.deltaSrc }
                    : { type: 'SET_CLIP_SOURCE', id: d.id, sourceEnd: clip.sourceEnd + d.deltaSrc });
            }
        } else if (d.kind === 'move') {
            dispatch({ type: 'MOVE_CLIP', id: d.id, toIndex: d.toIndex });
        } else if (d.kind === 'pending') {
            // never moved → treat as a click: select + seek to the clip start
            setSelectedItem(null);
            onSelect(d.id, e.shiftKey || e.metaKey || e.ctrlKey);
            const p = placedClips(framing, fps).find((pp) => pp.clip.id === d.id);
            if (p) seekToOut(p.outStart);
        }
    }, [framing, fps, dispatch, onSelect, seekToOut, onSelectTrackItem, totalOut]);

    // --- Resizable timeline height (drag handle above the track) ---
    const onResizeDown = useCallback((e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        resizeRef.current = { startY: e.clientY, startH: timelineHeight, latest: timelineHeight };
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, [timelineHeight]);

    const onResizeMove = useCallback((e) => {
        const r = resizeRef.current;
        if (!r) return;
        const h = clampHeight(r.startH + (r.startY - e.clientY)); // drag up = taller
        r.latest = h;
        setTimelineHeight(h);
    }, []);

    const onResizeUp = useCallback(() => {
        const r = resizeRef.current;
        if (!r) return;
        resizeRef.current = null;
        try { localStorage.setItem('editorTimelineHeight', String(r.latest)); } catch { /* ignore */ }
    }, []);

    // --- Delete key: remove the selected audio / overlay block (new generic
    // tracks only — legacy broll/text keep panel-only deletion). Ignored while
    // typing in a field. ---
    useEffect(() => {
        const onKey = (e) => {
            if (e.key !== 'Backspace' && e.key !== 'Delete') return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            if (!selectedItem) return;
            if (selectedItem.lane === 'audio') {
                e.preventDefault();
                dispatch({ type: 'REMOVE_AUDIO', id: selectedItem.id });
                setSelectedItem(null);
            } else if (selectedItem.lane === 'overlay') {
                e.preventDefault();
                dispatch({ type: 'REMOVE_OVERLAY', id: selectedItem.id });
                setSelectedItem(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selectedItem, dispatch]);

    // Ruler ticks (seconds)
    const secStep = pxPerSec >= 120 ? 1 : pxPerSec >= 48 ? 2 : 5;
    const ticks = [];
    for (let s = 0; s * fps <= totalOut; s += secStep) ticks.push(s);

    const draggingId = drag && (drag.kind === 'move' || drag.kind === 'trim') ? drag.id : null;

    // Source-anchored track items placed on the output axis. The item being
    // dragged uses its patched frames so the block follows the cursor live.
    const textItems = framing.textOverlays || [];
    const brollItems = framing.broll || [];
    const patchedFrames = (item) =>
        drag && drag.itemId === item.id && (drag.kind === 'item-move' || drag.kind === 'item-trim')
            ? itemDragPatch(framing, item, drag, fps)
            : item;
    const laneWindows = (items) =>
        items.flatMap((item) => {
            // anchor:'output' items live directly on the output axis — no source
            // mapping (and never echo). Their live drag uses the direct
            // output-frame patch, same as audio blocks.
            if (item.anchor === 'output') {
                const eff = drag && drag.itemId === item.id && (drag.kind === 'item-move' || drag.kind === 'item-trim')
                    ? audioDragPatch(item, drag, totalOut)
                    : item;
                return [{ item, w: { outStart: eff.startFrame, outEnd: eff.endFrame }, wi: 0 }];
            }
            const eff = patchedFrames(item);
            return sourceRangeToOutputWindows(framing, eff.startFrame, eff.endFrame, fps).map((w, wi) => ({ item, w, wi }));
        });
    const overlayItems = framing.overlays || [];
    const textWindows = laneWindows(textItems);
    const brollWindows = laneWindows(brollItems);
    const overlayWindows = laneWindows(overlayItems);
    const transitionsOn = !!(framing.transitions?.cutCrossfade || framing.transitions?.cutStyle);

    // OUTPUT-anchored audio blocks. The dragged item uses its patched frames so
    // the block follows the cursor live (in output frames, no source mapping).
    const audioItems = framing.audio || [];
    const audioBlocks = audioItems.map((item) => {
        const eff = drag && drag.itemId === item.id && drag.lane === 'audio' && (drag.kind === 'item-move' || drag.kind === 'item-trim')
            ? audioDragPatch(item, drag, totalOut)
            : item;
        const name = item.url ? decodeURIComponent(item.url.split('/').pop() || '') : '';
        return {
            item,
            left: eff.startFrame * pxPerFrame,
            width: Math.max(10, (eff.endFrame - eff.startFrame) * pxPerFrame),
            fadeInPx: Math.min((item.fadeInSec || 0) * fps * pxPerFrame, (eff.endFrame - eff.startFrame) * pxPerFrame),
            fadeOutPx: Math.min((item.fadeOutSec || 0) * fps * pxPerFrame, (eff.endFrame - eff.startFrame) * pxPerFrame),
            label: item.role === 'sfx' ? (name || 'SFX') : (name || 'Music'),
            Icon: item.role === 'sfx' ? Volume2 : Music,
            colorClass: item.role === 'sfx'
                ? 'bg-sky-500/20 border-sky-500/40 text-sky-100'
                : 'bg-cyan-500/20 border-cyan-500/40 text-cyan-100',
        };
    });
    const showAudioEmpty = audioItems.length === 0;

    return (
        <div className="border-t border-edge bg-surface select-none">
            {/* Resize handle — drag up/down to change the timeline height */}
            <div
                onPointerDown={onResizeDown}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
                onPointerCancel={onResizeUp}
                title="Drag to resize timeline"
                className="h-1.5 w-full cursor-ns-resize flex items-center justify-center group"
            >
                <div className="w-10 h-[3px] rounded-full bg-edge group-hover:bg-white/40 transition-colors" />
            </div>

            <div className="px-3 pb-2 pt-0.5">
            {/* Transport */}
            <div className="flex items-center gap-2.5 mb-2">
                <button onClick={() => seekToOut(0)} className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors" aria-label="Back to start">
                    <SkipBack size={14} />
                </button>
                <button onClick={togglePlay} className="w-8 h-8 rounded-full bg-fg text-[#18181b] flex items-center justify-center hover:bg-white active:scale-95 transition-all" aria-label={playing ? 'Pause' : 'Play'}>
                    {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
                </button>
                <button onClick={handleSplit} disabled={!canSplit} title="Split clip at playhead" className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${canSplit ? 'text-muted hover:text-fg hover:bg-white/5' : 'text-zinc-700 cursor-not-allowed'}`}>
                    <Scissors size={14} />
                </button>
                <button onClick={() => selectedId && handleDelete(selectedId)} disabled={!canDelete} title="Delete selected clip" className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${canDelete ? 'text-muted hover:text-red-400 hover:bg-white/5' : 'text-zinc-700 cursor-not-allowed'}`}>
                    <Trash2 size={14} />
                </button>
                <span className="text-[11px] text-muted tabular-nums ml-1">
                    {fmt(outFrame)} <span className="text-zinc-600">/</span> {fmt(totalOut)}
                </span>

                {/* Zoom */}
                <div className="ml-auto flex items-center gap-1.5">
                    <button onClick={() => setPxPerSec((z) => Math.max(MIN_PPS, Math.round(z / 1.4)))} className="w-6 h-6 rounded flex items-center justify-center text-muted hover:text-fg hover:bg-white/5" aria-label="Zoom out">
                        <ZoomOut size={13} />
                    </button>
                    <input type="range" min={MIN_PPS} max={MAX_PPS} value={pxPerSec} onChange={(e) => setPxPerSec(Number(e.target.value))} className="w-24 accent-viral" aria-label="Timeline zoom" />
                    <button onClick={() => setPxPerSec((z) => Math.min(MAX_PPS, Math.round(z * 1.4)))} className="w-6 h-6 rounded flex items-center justify-center text-muted hover:text-fg hover:bg-white/5" aria-label="Zoom in">
                        <ZoomIn size={13} />
                    </button>
                </div>
            </div>

            {/* Scrollable track (both axes: horizontal timeline, vertical lanes) */}
            <div
                ref={trackRef}
                style={{ height: timelineHeight }}
                className="relative overflow-auto custom-scrollbar rounded-lg border border-edge bg-canvas"
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerLeave={endDrag}
            >
                <div className="relative" style={{ width: trackWidth, minWidth: '100%' }}>
                    {/* Ruler */}
                    <div className="relative h-5 border-b border-edge cursor-pointer" onPointerDown={rulerDown}>
                        {ticks.map((s) => (
                            <span key={s} className="absolute top-0 text-[9px] text-zinc-500 tabular-nums pl-1 border-l border-edge h-full" style={{ left: s * pxPerSec }}>
                                {s}
                            </span>
                        ))}
                    </div>

                    {/* Text lane (only when non-empty) */}
                    {textWindows.length > 0 && (
                        <div className="relative h-[22px] mt-1">
                            {textWindows.map(({ item, w, wi }) => (
                                <LaneBlock
                                    key={`${item.id}-${wi}`}
                                    lane="text"
                                    itemId={item.id}
                                    label={item.text || 'Text'}
                                    Icon={Type}
                                    colorClass="bg-emerald-500/20 border-emerald-500/40 text-emerald-100"
                                    left={w.outStart * pxPerFrame}
                                    width={Math.max(10, (w.outEnd - w.outStart) * pxPerFrame)}
                                    echo={wi !== 0}
                                    selected={selectedItem?.lane === 'text' && selectedItem.id === item.id}
                                    dragging={drag?.itemId === item.id}
                                    onBodyDown={onItemBodyDown}
                                    onTrimDown={onItemTrimDown}
                                />
                            ))}
                        </div>
                    )}

                    {/* B-roll lane (only when non-empty) */}
                    {brollWindows.length > 0 && (
                        <div className="relative h-[22px] mt-1">
                            {brollWindows.map(({ item, w, wi }) => (
                                <LaneBlock
                                    key={`${item.id}-${wi}`}
                                    lane="broll"
                                    itemId={item.id}
                                    label="B-roll"
                                    Icon={Clapperboard}
                                    colorClass="bg-purple-500/20 border-purple-500/40 text-purple-100"
                                    left={w.outStart * pxPerFrame}
                                    width={Math.max(10, (w.outEnd - w.outStart) * pxPerFrame)}
                                    echo={wi !== 0}
                                    selected={selectedItem?.lane === 'broll' && selectedItem.id === item.id}
                                    dragging={drag?.itemId === item.id}
                                    onBodyDown={onItemBodyDown}
                                    onTrimDown={onItemTrimDown}
                                />
                            ))}
                        </div>
                    )}

                    {/* Overlays lane — image / b-roll video overlays (source-anchored,
                        same drag/echo model as the legacy b-roll lane). Only when non-empty. */}
                    {overlayWindows.length > 0 && (
                        <div className="relative h-[22px] mt-1">
                            {overlayWindows.map(({ item, w, wi }) => (
                                <LaneBlock
                                    key={`${item.id}-${wi}`}
                                    lane="overlay"
                                    itemId={item.id}
                                    label={item.kind === 'image' ? 'Image' : 'B-roll'}
                                    Icon={item.kind === 'image' ? ImageIcon : Clapperboard}
                                    colorClass="bg-purple-500/20 border-purple-500/40 text-purple-100"
                                    left={w.outStart * pxPerFrame}
                                    width={Math.max(10, (w.outEnd - w.outStart) * pxPerFrame)}
                                    echo={wi !== 0}
                                    selected={selectedItem?.lane === 'overlay' && selectedItem.id === item.id}
                                    dragging={drag?.itemId === item.id}
                                    onBodyDown={onItemBodyDown}
                                    onTrimDown={onItemTrimDown}
                                />
                            ))}
                        </div>
                    )}

                    {/* Clip lane */}
                    <div className="relative h-16 mt-1 mb-1">
                        {placed.map((p) => (
                            <ClipBlock
                                key={p.clip.id}
                                clip={p.clip}
                                left={p.outStart * pxPerFrame}
                                width={Math.max(10, p.outDuration * pxPerFrame)}
                                selected={selectedIds.includes(p.clip.id)}
                                dragging={draggingId === p.clip.id}
                                thumbs={thumbs}
                                peaks={peaks}
                                totalSrc={totalSrc}
                                onBodyDown={onBodyDown}
                                onTrimDown={onTrimDown}
                                onDuplicate={duplicateClip}
                                onDelete={handleDelete}
                            />
                        ))}

                        {/* Transition markers at internal clip boundaries (global config → edit in Transitions tab) */}
                        {transitionsOn && placed.slice(1).map((p) => (
                            <button
                                key={`tr-${p.clip.id}`}
                                onPointerDown={(e) => { e.stopPropagation(); onSelectTrackItem?.('transitions', null); }}
                                style={{ left: p.outStart * pxPerFrame }}
                                title="Transition — edit in the Transitions tab"
                                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rotate-45 bg-amber-400/80 border border-amber-300 hover:bg-amber-300 z-20"
                            />
                        ))}

                        {/* Add-clip at the end (duplicates the last clip) */}
                        <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => framing.clips.length && duplicateClip(framing.clips[framing.clips.length - 1].id)}
                            title="Add a clip (duplicates the last clip)"
                            className="absolute top-0 bottom-0 w-9 flex items-center justify-center rounded-md border border-dashed border-edge text-muted hover:text-fg hover:border-white/40 hover:bg-white/5 z-20"
                            style={{ left: trackWidth + 6 }}
                        >
                            <Plus size={16} />
                        </button>
                    </div>

                    {/* Audio lane v2 — one OUTPUT-anchored block per framing.audio[] item. */}
                    {audioBlocks.length > 0 && (
                        <div className="relative h-[22px] mt-1 mb-1">
                            {audioBlocks.map((b) => (
                                <AudioBlock
                                    key={b.item.id}
                                    itemId={b.item.id}
                                    url={b.item.url}
                                    label={b.label}
                                    Icon={b.Icon}
                                    colorClass={b.colorClass}
                                    left={b.left}
                                    width={b.width}
                                    fadeInPx={b.fadeInPx}
                                    fadeOutPx={b.fadeOutPx}
                                    selected={selectedItem?.lane === 'audio' && selectedItem.id === b.item.id}
                                    dragging={drag?.itemId === b.item.id && drag?.lane === 'audio'}
                                    onBodyDown={onItemBodyDown}
                                    onTrimDown={onItemTrimDown}
                                />
                            ))}
                        </div>
                    )}

                    {/* Empty-state affordance — CapCut's "+ Add audio" strip, shown
                        only when there are no audio[] items. */}
                    {showAudioEmpty && (
                        <div className="relative h-[22px] mt-1 mb-1">
                            <button
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={() => onSelectTrackItem?.('audio', null)}
                                style={{ width: Math.max(10, trackWidth) }}
                                title="Add audio"
                                className="absolute top-0 bottom-0 left-0 flex items-center justify-center rounded border border-dashed border-edge text-[10px] text-muted hover:text-fg hover:border-white/40 hover:bg-white/5"
                            >
                                <Music size={10} className="mr-1" /> Add audio
                            </button>
                        </div>
                    )}

                    {/* Snap guide line — single vertical white line at the snapped edge,
                        spanning the ruler through every lane. */}
                    {drag?.snapX != null && (
                        <div className="absolute top-0 bottom-0 w-px bg-white z-50 pointer-events-none" style={{ left: drag.snapX }} />
                    )}

                    {/* Playhead (spans ruler + all lanes; owns its own frame subscription) */}
                    <Playhead playerRef={playerRef} pxPerFrame={pxPerFrame} trackRef={trackRef} />
                </div>
            </div>

            <div className="mt-1 text-[10px] text-zinc-600">
                click a clip to select · drag to reorder · drag edges to trim · ✂ splits at the playhead
            </div>
            </div>
        </div>
    );
}
