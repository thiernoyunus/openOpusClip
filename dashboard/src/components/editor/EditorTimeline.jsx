import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Play, Pause, SkipBack, Scissors, Trash2, Copy, ZoomIn, ZoomOut, Plus } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { useFilmstrip, useWaveform } from './useMediaStrips';
import { placedClips, outputToSource, clipAtOutputFrame } from '@remotion-src/lib/edl';

const FILM_COUNT = 48; // global thumbnails sampled across the source, sliced per clip
const WAVE_BUCKETS = 480;
const MIN_CLIP_LEN = 2; // source frames — mirrors the reducer
const MIN_PPS = 12;
const MAX_PPS = 320;
const LAYOUT_LABEL = { fill: 'Fill', fit: 'Fit', split: 'Split', three: 'Three', four: 'Four', screenshare: 'Screen', gameplay: 'Gameplay' };

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
 * Output-axis NLE timeline: the main track is the ordered clip list laid
 * end-to-end (playback order). Clips can be selected, split, trimmed, reordered
 * (drag), duplicated and deleted, with zoom + horizontal scroll. The playhead,
 * ruler and seeking all live on the OUTPUT timeline.
 */
export default function EditorTimeline({ framing, playerRef, selectedIds, onSelect, dispatch, sourceUrl }) {
    const [outFrame, setOutFrame] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [pxPerSec, setPxPerSec] = useState(60);
    const [drag, setDrag] = useState(null);
    const trackRef = useRef(null);
    const dragRef = useRef(null);

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

    // Player sync
    useEffect(() => {
        const p = playerRef.current;
        if (!p) return undefined;
        const onF = (e) => setOutFrame(e.detail.frame);
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        p.addEventListener('frameupdate', onF);
        p.addEventListener('play', onPlay);
        p.addEventListener('pause', onPause);
        return () => {
            p.removeEventListener('frameupdate', onF);
            p.removeEventListener('play', onPlay);
            p.removeEventListener('pause', onPause);
        };
    }, [playerRef]);

    // Keep the playhead in view during playback / seeks
    useEffect(() => {
        const el = trackRef.current;
        if (!el) return;
        const x = outFrame * pxPerFrame;
        if (x < el.scrollLeft + 40) el.scrollLeft = Math.max(0, x - 40);
        else if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - el.clientWidth + 40;
    }, [outFrame, pxPerFrame]);

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
        const pc = clipAtOutputFrame(framing, outFrame, fps);
        if (!pc) return;
        dispatch({ type: 'SPLIT_CLIP', clipId: pc.clip.id, sourceFrame: outputToSource(framing, outFrame, fps) });
    }, [framing, outFrame, fps, dispatch]);

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

    const onPointerMove = useCallback((e) => {
        const d = dragRef.current;
        if (!d) return;
        if (d.kind === 'scrub') {
            seekToOut(outFrameAtClientX(e.clientX));
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
            onSelect(d.id, e.shiftKey || e.metaKey || e.ctrlKey);
            const p = placedClips(framing, fps).find((pp) => pp.clip.id === d.id);
            if (p) seekToOut(p.outStart);
        }
    }, [framing, fps, dispatch, onSelect, seekToOut]);

    // Ruler ticks (seconds)
    const secStep = pxPerSec >= 120 ? 1 : pxPerSec >= 48 ? 2 : 5;
    const ticks = [];
    for (let s = 0; s * fps <= totalOut; s += secStep) ticks.push(s);

    const playheadX = outFrame * pxPerFrame;
    const draggingId = drag && (drag.kind === 'move' || drag.kind === 'trim') ? drag.id : null;

    return (
        <div className="border-t border-edge bg-surface px-3 py-2 select-none">
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

            {/* Scrollable track */}
            <div
                ref={trackRef}
                className="relative overflow-x-auto overflow-y-hidden custom-scrollbar rounded-lg border border-edge bg-canvas"
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

                    {/* Playhead (spans ruler + lane) */}
                    <div className="absolute top-0 bottom-0 w-px bg-fg pointer-events-none z-40" style={{ left: playheadX }}>
                        <div className="absolute -top-0.5 -left-[3px] w-[7px] h-[7px] rounded-full bg-fg" />
                    </div>
                </div>
            </div>

            <div className="mt-1 text-[10px] text-zinc-600">
                click a clip to select · drag to reorder · drag edges to trim · ✂ splits at the playhead
            </div>
        </div>
    );
}
