import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, Plus, Minus, X } from 'lucide-react';
import { getApiUrl } from '../../config';

const fmt = (t) => {
    const s = Math.max(0, Math.round(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const MAX_LEN = 120;

function Stepper({ label, value, edge, onStep }) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted w-10">{label}</span>
            <button
                type="button"
                onClick={() => onStep(edge, -0.5)}
                className="size-6 rounded-md border border-edge bg-surface2 text-zinc-300 hover:text-fg hover:bg-white/10 flex items-center justify-center"
            >
                <Minus size={12} />
            </button>
            <span className="text-sm text-fg tabular-nums w-14 text-center">{fmt(value)}</span>
            <button
                type="button"
                onClick={() => onStep(edge, 0.5)}
                className="size-6 rounded-md border border-edge bg-surface2 text-zinc-300 hover:text-fg hover:bg-white/10 flex items-center justify-center"
            >
                <Plus size={12} />
            </button>
        </div>
    );
}

/**
 * "Extend a clip" picker (Opus-style). Pulls an arbitrary contiguous section of
 * the FULL original video into the current short. Left: the full-source
 * transcript grouped by segment — click a segment to start a selection, click
 * another to extend it (contiguous range). Right: a preview of the original
 * seeking to the selection start, with ±0.5s steppers and an Add button.
 */
export default function ExtendClipModal({ jobId, onClose, onAdd }) {
    const [data, setData] = useState(null); // { hasOriginal, duration, segments }
    const [loadError, setLoadError] = useState(null);
    const [range, setRange] = useState(null); // { anchor, focus } segment indices
    const [bounds, setBounds] = useState(null); // { start, end } fine-tuned seconds
    const videoRef = useRef(null);

    const originalUrl = getApiUrl(`/videos/${jobId}/original.mp4`);

    useEffect(() => {
        let cancelled = false;
        fetch(getApiUrl(`/api/source-transcript/${jobId}`))
            .then((res) => {
                if (!res.ok) throw new Error(`Could not load the source transcript (${res.status}).`);
                return res.json();
            })
            .then((d) => { if (!cancelled) setData(d); })
            .catch((e) => { if (!cancelled) setLoadError(e.message); });
        return () => { cancelled = true; };
    }, [jobId]);

    const segments = data?.segments || [];
    const selRange = useMemo(
        () => (range ? { lo: Math.min(range.anchor, range.focus), hi: Math.max(range.anchor, range.focus) } : null),
        [range]
    );

    // Selection seconds: fine-tuned bounds override the segment edges.
    const start = bounds ? bounds.start : selRange ? segments[selRange.lo]?.start ?? 0 : 0;
    const end = bounds ? bounds.end : selRange ? segments[selRange.hi]?.end ?? 0 : 0;
    const len = Math.max(0, end - start);
    const tooLong = len > MAX_LEN;

    // Seek the preview to the selection start whenever it changes.
    useEffect(() => {
        if (selRange && videoRef.current) {
            try { videoRef.current.currentTime = start; } catch { /* not ready yet */ }
        }
    }, [start, selRange]);

    const onSegmentClick = (i, e) => {
        setBounds(null);
        if (e.shiftKey && range) setRange({ anchor: range.anchor, focus: i });
        else setRange({ anchor: i, focus: i });
    };

    const step = (edge, delta) => {
        const dur = data?.duration || Infinity;
        setBounds((prev) => {
            const b = prev || { start, end };
            if (edge === 'start') return { start: Math.max(0, Math.min(b.start + delta, b.end - 0.5)), end: b.end };
            return { start: b.start, end: Math.max(b.start + 0.5, Math.min(b.end + delta, dur)) };
        });
    };

    const canAdd = data?.hasOriginal && selRange && len >= 0.5 && !tooLong;

    return (
        <div
            className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center px-4"
            onMouseDown={onClose}
        >
            <div
                className="w-[900px] max-w-[calc(100vw-32px)] h-[600px] max-h-[calc(100vh-64px)] rounded-xl border border-edge bg-surface shadow-2xl flex flex-col overflow-hidden"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between h-12 px-4 border-b border-edge shrink-0">
                    <div>
                        <h2 className="text-sm font-medium text-fg">Extend a clip</h2>
                        <p className="text-[11px] text-muted">Pull a section of the original video into this short.</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="size-8 rounded-md text-muted hover:text-fg hover:bg-white/5 flex items-center justify-center"
                        aria-label="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                {loadError ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted p-8 text-center">
                        <AlertCircle size={24} className="text-red-400" />
                        <p className="text-sm max-w-sm">{loadError}</p>
                    </div>
                ) : !data ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted">
                        <Loader2 size={24} className="animate-spin" />
                        <p className="text-sm">Loading original transcript…</p>
                    </div>
                ) : !data.hasOriginal ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted p-8 text-center">
                        <AlertCircle size={24} className="text-amber-400" />
                        <p className="text-sm max-w-sm">
                            Original video not available for this project — process the video again to enable Extend.
                        </p>
                    </div>
                ) : (
                    <div className="flex-1 flex min-h-0">
                        {/* Left: source transcript, grouped by segment */}
                        <div className="w-1/2 border-r border-edge flex flex-col min-h-0">
                            <div className="px-4 py-2 text-[11px] text-muted border-b border-edge shrink-0">
                                Click a segment to start a selection · Shift-click another to extend
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-1">
                                {segments.map((seg, i) => {
                                    const inSel = selRange && i >= selRange.lo && i <= selRange.hi;
                                    return (
                                        <button
                                            key={i}
                                            type="button"
                                            onClick={(e) => onSegmentClick(i, e)}
                                            className={`w-full text-left rounded-md px-2.5 py-1.5 transition-colors ${
                                                inSel ? 'bg-lime-300/20 border border-lime-300/40' : 'hover:bg-white/5 border border-transparent'
                                            }`}
                                        >
                                            <span className="text-[10px] tabular-nums text-zinc-500 mr-2">[{fmt(seg.start)}]</span>
                                            <span className="text-xs text-zinc-300">
                                                {seg.words.map((w) => w.text).join(' ')}
                                            </span>
                                        </button>
                                    );
                                })}
                                {segments.length === 0 && (
                                    <p className="text-xs text-muted p-2">No transcript available.</p>
                                )}
                            </div>
                        </div>

                        {/* Right: preview + selection readout */}
                        <div className="w-1/2 flex flex-col min-h-0">
                            <div className="flex-1 min-h-0 bg-black flex items-center justify-center p-3">
                                <video
                                    ref={videoRef}
                                    src={originalUrl}
                                    controls
                                    className="max-w-full max-h-full rounded-md"
                                />
                            </div>
                            <div className="shrink-0 border-t border-edge p-4 space-y-3">
                                {selRange ? (
                                    <>
                                        <Stepper label="Start" value={start} edge="start" onStep={step} />
                                        <Stepper label="End" value={end} edge="end" onStep={step} />
                                        <div className={`text-[11px] ${tooLong ? 'text-red-400' : 'text-muted'}`}>
                                            {tooLong
                                                ? `Selection is ${Math.round(len)}s — max ${MAX_LEN}s.`
                                                : `Selected ${len.toFixed(1)}s`}
                                        </div>
                                    </>
                                ) : (
                                    <p className="text-[11px] text-muted">Select one or more segments to choose a section.</p>
                                )}
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        disabled={!canAdd}
                                        onClick={() => onAdd(start, end)}
                                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-viral/15 border border-viral/40 text-sm text-viral hover:bg-viral/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <Plus size={14} /> Add to clip
                                    </button>
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="text-[12px] text-muted hover:text-fg px-3 py-2"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
