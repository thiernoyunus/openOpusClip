import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Play, Pause, SkipBack, Scissors, Trash2, Copy, ZoomIn, ZoomOut, Plus, Type, Clapperboard, Music } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { useFilmstrip, useWaveform } from './useMediaStrips';
import { placedClips, outputToSource, clipAtOutputFrame, sourceRangeToOutputWindows } from '@remotion-src/lib/edl';

const FILM_COUNT = 48; // global thumbnails sampled across the source, sliced per clip
const WAVE_BUCKETS = 480;
const MIN_CLIP_LEN = 2; // source frames — mirrors the reducer
const MIN_ITEM_LEN = 2; // source frames — min length for a text/b-roll block
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
        const v = Number(localStorage.getItem('editorTimelineHeight'));
        return clampHeight(Number.isFinite(v) && v ? v : 200);
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
            const now = performance.now();
            if (now - outTickRef.current < 100) return;
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
        const nd = { kind: 'trim', id, edge, startX: e.clientX, deltaSrc: 0 };
        dragRef.current = nd;
        setDrag(nd);
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, []);

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
        const nd = { kind: 'item-pending', lane, itemId, startX: e.clientX, deltaOut: 0 };
        dragRef.current = nd;
        setDrag(nd);
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, []);

    const onItemTrimDown = useCallback((lane, itemId, edge, e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const nd = { kind: 'item-trim', lane, itemId, edge, startX: e.clientX, deltaOut: 0 };
        dragRef.current = nd;
        setDrag(nd);
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, []);

    const onPointerMove = useCallback((e) => {
        const d = dragRef.current;
        if (!d) return;
        if (d.kind === 'scrub') {
            seekToOut(outFrameAtClientX(e.clientX));
            return;
        }
        if (d.kind === 'item-pending' || d.kind === 'item-move') {
            const dxi = e.clientX - d.startX;
            if (d.kind === 'item-pending' && Math.abs(dxi) < 4) return;
            const nd = { ...d, kind: 'item-move', deltaOut: Math.round(dxi / pxPerFrame) };
            dragRef.current = nd;
            setDrag(nd);
            return;
        }
        if (d.kind === 'item-trim') {
            const nd = { ...d, deltaOut: Math.round((e.clientX - d.startX) / pxPerFrame) };
            dragRef.current = nd;
            setDrag(nd);
            return;
        }
        const dx = e.clientX - d.startX;
        if (d.kind === 'trim') {
            const deltaSrc = Math.round((dx / pxPerFrame) * (srcFps / fps));
            const nd = { ...d, deltaSrc };
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
    }, [pxPerFrame, srcFps, fps, framing, seekToOut, outFrameAtClientX]);

    const endDrag = useCallback((e) => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!d) return;
        if (d.kind === 'item-move' || d.kind === 'item-trim') {
            const list = d.lane === 'text' ? framing.textOverlays : framing.broll;
            const item = (list || []).find((x) => x.id === d.itemId);
            if (item) {
                const patch = itemDragPatch(framing, item, d, fps);
                if (patch.startFrame !== item.startFrame || patch.endFrame !== item.endFrame) {
                    dispatch({ type: d.lane === 'text' ? 'UPDATE_TEXT_OVERLAY' : 'UPDATE_BROLL', id: d.itemId, patch });
                }
            }
            return;
        }
        if (d.kind === 'item-pending') {
            // never moved → treat as a click: select the block + open its panel
            setSelectedItem({ lane: d.lane, id: d.itemId });
            onSelectTrackItem?.(d.lane, d.itemId);
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
    }, [framing, fps, dispatch, onSelect, seekToOut, onSelectTrackItem]);

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
            const eff = patchedFrames(item);
            return sourceRangeToOutputWindows(framing, eff.startFrame, eff.endFrame, fps).map((w, wi) => ({ item, w, wi }));
        });
    const textWindows = laneWindows(textItems);
    const brollWindows = laneWindows(brollItems);
    const transitionsOn = !!(framing.transitions?.cutCrossfade || framing.transitions?.cutStyle);
    const musicLabel = framing.music ? decodeURIComponent(framing.music.url.split('/').pop() || 'Music') : null;

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

                    {/* Audio lane (only when music is set) */}
                    {framing.music && (
                        <div className="relative h-[22px] mt-1 mb-1">
                            {/* ponytail: music is one global looped track with no start/end, so the
                                block spans the whole output and isn't draggable — per-track timing
                                lands with the audio[] schema in a later PR. */}
                            <div
                                onPointerDown={(e) => { e.stopPropagation(); setSelectedItem({ lane: 'audio', id: 'music' }); onSelectTrackItem?.('audio', null); }}
                                style={{ width: Math.max(10, trackWidth) }}
                                title={musicLabel}
                                className={`absolute top-0 bottom-0 left-0 rounded border flex items-center px-1.5 text-[10px] overflow-hidden cursor-pointer bg-zinc-600/30 border-zinc-500/40 text-zinc-200 ${
                                    selectedItem?.lane === 'audio' ? 'ring-1 ring-viral border-viral' : ''
                                }`}
                            >
                                <Music size={10} className="mr-1 shrink-0 pointer-events-none" />
                                <span className="truncate pointer-events-none">{musicLabel}</span>
                            </div>
                        </div>
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
