import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Play, Pause, SkipBack, X } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { useFilmstrip, useWaveform } from './useMediaStrips';
import { outputDurationFrames, outputToSource, sourceToOutput } from '../../remotion/lib/edl';

const fmt = (frames) => {
    const totalSec = frames / EDITOR_FPS;
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    const cs = Math.floor((totalSec % 1) * 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

const LAYOUT_LABEL = { fill: 'Fill', fit: 'Fit', split: 'Split', three: 'Three', four: 'Four' };

/**
 * Opus-style timeline: layout-chip row per framing segment with draggable
 * boundaries, a thumbnail filmstrip, an audio waveform, scrub-to-seek, and a
 * playhead synced to the Player.
 */
export default function EditorTimeline({ framing, playerRef, selectedIds, onSelect, dispatch, sourceUrl }) {
    const [frame, setFrame] = useState(0);
    const [playing, setPlaying] = useState(false);
    // drag: {kind:'boundary', boundaryIndex, frame} | {kind:'trim', edge:'in'|'out', frame}
    const [drag, setDrag] = useState(null);
    const stripRef = useRef(null);

    const totalSrcFrames = framing.source.durationFrames;
    const clipIn = framing.clipInFrame ?? 0;
    const clipOut = framing.clipOutFrame ?? totalSrcFrames;
    const cuts = framing.cuts ?? [];
    const durationInFrames = outputDurationFrames(framing, EDITOR_FPS);

    const thumbs = useFilmstrip(sourceUrl);
    const peaks = useWaveform(sourceUrl);

    useEffect(() => {
        const p = playerRef.current;
        if (!p) return;
        const onFrame = (e) => setFrame(e.detail.frame);
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        p.addEventListener('frameupdate', onFrame);
        p.addEventListener('play', onPlay);
        p.addEventListener('pause', onPause);
        return () => {
            p.removeEventListener('frameupdate', onFrame);
            p.removeEventListener('play', onPlay);
            p.removeEventListener('pause', onPause);
        };
    }, [playerRef]);

    const togglePlay = useCallback(() => {
        const p = playerRef.current;
        if (!p) return;
        if (p.isPlaying()) p.pause();
        else p.play();
    }, [playerRef]);

    const seekToSourceFrame = useCallback(
        (srcFrame) => {
            const p = playerRef.current;
            if (!p) return;
            p.pause();
            // Map through the EDL: frames inside cuts snap to the next kept frame
            p.seekTo(sourceToOutput(framing, srcFrame, EDITOR_FPS) ?? 0);
        },
        [playerRef, framing]
    );

    const sourceFrameAtClientX = useCallback(
        (clientX) => {
            const rect = stripRef.current.getBoundingClientRect();
            const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            return Math.round(fraction * totalSrcFrames);
        },
        [totalSrcFrames]
    );

    // Dragging (segment boundaries + clip trim handles): live position in
    // local state, single history entry committed to the reducer on release
    const startDrag = (payload) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrag(payload);
        try {
            e.target.setPointerCapture?.(e.pointerId);
        } catch { /* synthetic or already-released pointer */ }
    };
    const onStripPointerMove = (e) => {
        if (!drag) return;
        setDrag((d) => ({ ...d, frame: sourceFrameAtClientX(e.clientX) }));
    };
    const endDrag = () => {
        if (!drag) return;
        if (drag.kind === 'boundary') {
            dispatch({ type: 'SET_BOUNDARY', boundaryIndex: drag.boundaryIndex, frame: drag.frame });
        } else if (drag.kind === 'trim') {
            dispatch({
                type: 'SET_CLIP_BOUNDS',
                ...(drag.edge === 'in' ? { clipInFrame: drag.frame } : { clipOutFrame: drag.frame }),
            });
        }
        setDrag(null);
    };

    const scrubTo = (e) => {
        if (drag) return;
        seekToSourceFrame(sourceFrameAtClientX(e.clientX));
    };

    // Playhead lives on the SOURCE axis (the strips show source content)
    const playheadSrc = outputToSource(framing, frame, EDITOR_FPS);
    const playheadPct = Math.min(100, (playheadSrc / totalSrcFrames) * 100);
    const boundaryPct = (f) => (f / totalSrcFrames) * 100;
    const liveClipIn = drag?.kind === 'trim' && drag.edge === 'in' ? drag.frame : clipIn;
    const liveClipOut = drag?.kind === 'trim' && drag.edge === 'out' ? drag.frame : clipOut;

    return (
        <div className="border-t border-edge bg-surface px-4 py-3 select-none">
            {/* Transport */}
            <div className="flex items-center gap-3 mb-2.5">
                <button
                    onClick={() => seekToSourceFrame(0)}
                    className="w-8 h-8 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors"
                    aria-label="Back to start"
                >
                    <SkipBack size={15} />
                </button>
                <button
                    onClick={togglePlay}
                    className="w-9 h-9 rounded-full bg-fg text-[#18181b] flex items-center justify-center hover:bg-white active:scale-95 transition-all"
                    aria-label={playing ? 'Pause' : 'Play'}
                >
                    {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                </button>
                <span className="text-xs text-muted tabular-nums">
                    {fmt(frame)} <span className="text-zinc-600">/</span> {fmt(durationInFrames)}
                </span>
                <span className="ml-auto text-[11px] text-muted">
                    Click a chip to select · drag chip edges to move boundaries · click strip to seek
                </span>
            </div>

            <div
                ref={stripRef}
                className="relative rounded-lg overflow-hidden border border-edge bg-canvas"
                onPointerMove={onStripPointerMove}
                onPointerUp={endDrag}
                onPointerLeave={endDrag}
            >
                {/* Layout chip row (absolute positions: segments cover [clipIn, clipOut]) */}
                <div className="relative h-7 border-b border-edge">
                    {framing.segments.map((seg) => {
                        const selected = selectedIds.includes(seg.id);
                        return (
                            <button
                                key={seg.id}
                                style={{
                                    left: `${boundaryPct(seg.startFrame)}%`,
                                    width: `${boundaryPct(seg.endFrame - seg.startFrame)}%`,
                                }}
                                onClick={(e) => {
                                    onSelect(seg.id, e.shiftKey || e.metaKey || e.ctrlKey);
                                    seekToSourceFrame(seg.startFrame);
                                }}
                                className={`absolute top-0 h-full border-r border-edge transition-colors text-left overflow-hidden ${
                                    selected ? 'bg-white/20' : 'bg-surface2/40 hover:bg-white/10'
                                }`}
                                title={`${seg.id} · ${LAYOUT_LABEL[seg.layout] || seg.layout}`}
                            >
                                <span
                                    className={`absolute top-1/2 -translate-y-1/2 left-1.5 text-[10px] font-medium px-1.5 py-px rounded truncate max-w-[85%] ${
                                        selected ? 'bg-fg text-[#18181b]' : 'bg-black/50 text-zinc-300'
                                    }`}
                                >
                                    {LAYOUT_LABEL[seg.layout] || seg.layout}
                                </span>
                            </button>
                        );
                    })}

                    {/* Boundary drag handles (between adjacent segments) */}
                    {framing.segments.slice(0, -1).map((seg, i) => {
                        const active = drag?.kind === 'boundary' && drag.boundaryIndex === i;
                        const f = active ? drag.frame : seg.endFrame;
                        return (
                            <div
                                key={`b-${seg.id}`}
                                style={{ left: `${boundaryPct(f)}%` }}
                                onPointerDown={startDrag({ kind: 'boundary', boundaryIndex: i, frame: seg.endFrame })}
                                className="absolute top-0 bottom-0 w-2 -ml-1 cursor-col-resize group z-10"
                            >
                                <div className={`mx-auto w-[3px] h-full rounded ${active ? 'bg-viral' : 'bg-zinc-500 group-hover:bg-fg'}`} />
                            </div>
                        );
                    })}
                </div>

                {/* Filmstrip */}
                <div className="relative h-12 flex bg-black cursor-pointer" onPointerDown={scrubTo}>
                    {thumbs.length === 0 ? (
                        <div className="w-full h-full bg-surface2/30 animate-pulse" />
                    ) : (
                        thumbs.map((src, i) => (
                            <img
                                key={i}
                                src={src}
                                alt=""
                                draggable={false}
                                className="h-full object-cover pointer-events-none"
                                style={{ width: `${100 / thumbs.length}%` }}
                            />
                        ))
                    )}
                </div>

                {/* Waveform */}
                <div className="relative h-8 flex items-center gap-px px-px bg-canvas cursor-pointer" onPointerDown={scrubTo}>
                    {peaks === null ? (
                        <div className="w-full h-3 bg-surface2/30 animate-pulse rounded" />
                    ) : peaks.length === 0 ? (
                        <span className="w-full text-center text-[10px] text-zinc-600">no audio</span>
                    ) : (
                        peaks.map((v, i) => (
                            <div
                                key={i}
                                className="flex-1 bg-zinc-500/80 rounded-sm pointer-events-none"
                                style={{ height: `${Math.max(6, v * 100)}%` }}
                            />
                        ))
                    )}
                </div>

                {/* Removed content: dim everything outside [clipIn, clipOut] */}
                {liveClipIn > 0 && (
                    <div
                        className="absolute top-0 bottom-0 left-0 bg-black/70 pointer-events-none z-10"
                        style={{ width: `${boundaryPct(liveClipIn)}%` }}
                    />
                )}
                {liveClipOut < totalSrcFrames && (
                    <div
                        className="absolute top-0 bottom-0 right-0 bg-black/70 pointer-events-none z-10"
                        style={{ width: `${100 - boundaryPct(liveClipOut)}%` }}
                    />
                )}

                {/* EDL cut bands (click × to restore) */}
                {cuts.map((cut, i) => (
                    <div
                        key={`cut-${cut.startFrame}`}
                        className="absolute top-0 bottom-0 z-10 bg-red-500/25 border-x border-red-400/60 group"
                        style={{
                            left: `${boundaryPct(cut.startFrame)}%`,
                            width: `${boundaryPct(cut.endFrame - cut.startFrame)}%`,
                            backgroundImage:
                                'repeating-linear-gradient(45deg, transparent, transparent 6px, rgba(248,113,113,0.25) 6px, rgba(248,113,113,0.25) 12px)',
                        }}
                        title="Cut content (click × to restore)"
                    >
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                dispatch({ type: 'REMOVE_CUT', index: i });
                            }}
                            className="absolute top-0.5 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-red-500 text-white items-center justify-center hidden group-hover:flex"
                            aria-label="Restore cut content"
                        >
                            <X size={10} />
                        </button>
                    </div>
                ))}

                {/* Clip trim/extend handles */}
                {[
                    { edge: 'in', frame: liveClipIn },
                    { edge: 'out', frame: liveClipOut },
                ].map(({ edge, frame: f }) => (
                    <div
                        key={`trim-${edge}`}
                        style={{ left: `${boundaryPct(f)}%` }}
                        onPointerDown={startDrag({ kind: 'trim', edge, frame: f })}
                        className="absolute top-0 bottom-0 w-3 -ml-1.5 cursor-ew-resize group z-20"
                        title={edge === 'in' ? 'Trim/extend clip start' : 'Trim/extend clip end'}
                    >
                        <div
                            className={`mx-auto w-[5px] h-full rounded ${
                                drag?.kind === 'trim' && drag.edge === edge
                                    ? 'bg-amber-400'
                                    : 'bg-amber-500/70 group-hover:bg-amber-400'
                            }`}
                        />
                    </div>
                ))}

                {/* Drag live guide across all rows */}
                {drag && (
                    <div
                        className="absolute top-0 bottom-0 w-px bg-viral pointer-events-none z-20"
                        style={{ left: `${boundaryPct(drag.frame)}%` }}
                    />
                )}

                {/* Playhead */}
                <div
                    className="absolute top-0 bottom-0 w-px bg-fg pointer-events-none z-20"
                    style={{ left: `${playheadPct}%` }}
                >
                    <div className="absolute -top-0.5 -left-[3px] w-[7px] h-[7px] rounded-full bg-fg" />
                </div>
            </div>
        </div>
    );
}
