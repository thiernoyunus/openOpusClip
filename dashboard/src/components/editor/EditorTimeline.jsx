import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
    Play, Pause, SkipBack, SkipForward, Scissors, Trash2, Copy, ZoomIn, ZoomOut, Plus,
    Type, Clapperboard, Music, Volume2, VolumeX, Image as ImageIcon, PanelBottomClose,
    MousePointer2, Undo2, Redo2, Magnet, Lock, Unlock, MoveHorizontal, Captions,
} from 'lucide-react';
import { getApiUrl } from '../../config';
import { EDITOR_FPS } from './EditorCanvas';
import { useFilmstrip, useWaveform } from './useMediaStrips';
import {
    placedClips, outputToSource, clipAtOutputFrame, sourceRangeToOutputRuns, wordSourceToOutput,
} from '@remotion-src/lib/edl';

/*
 * CapCut-style editor timeline.
 *
 * Layout and feel take ideas from the OpenFilm studio timeline
 * (github.com/openfilm/openfilm, MIT licence): a fixed column of track heads
 * outside the scroller, a sticky ruler, snapping measured in screen pixels so it
 * feels the same at every zoom, a blade tool, and a log-scale zoom slider. The
 * code here is our own and works on our own edit list (framing.clips etc.).
 */

const FILM_COUNT = 96; // thumbnails captured across the whole source
const WAVE_BUCKETS = 1600; // waveform peaks across the whole source
const MIN_CLIP_LEN = 2; // source frames — mirrors the reducer
const MIN_ITEM_LEN = 2; // source frames — min length for a text/b-roll block
const MIN_AUDIO_LEN = 2; // OUTPUT frames — min length for an audio block
const SNAP_PX = 8; // snap when a dragged edge is within this many pixels of a candidate
const MIN_PPS = 8;
const MAX_PPS = 600;
const MIN_TL_HEIGHT = 160;
const MAX_TL_HEIGHT = 560;
const DEFAULT_TL_HEIGHT = 270;
const HEAD_W = 118; // track head column
const RULER_H = 26;
const LANE_PAD = 12; // breathing room before frame 0
const RIGHT_PAD = 64;
const ROW_GAP = 4;
const LAYOUT_LABEL = { fill: 'Fill', fit: 'Fit', split: 'Split', three: 'Three', four: 'Four', screenshare: 'Screen', gameplay: 'Gameplay' };

// Palette (CapCut-like dark theme).
const C = {
    bg: '#0e0e10',
    head: '#151518',
    lane: 'rgba(240,240,255,0.035)',
    line: 'rgba(255,255,255,0.07)',
    audio: '#1d6f73',
    audioDim: '#24484b',
    wave: 'rgba(160,240,240,0.75)',
    text: '#a8662c',
    overlay: '#5b4bb3',
    caption: '#3a3a42',
};

const clampHeight = (h) => Math.max(MIN_TL_HEIGHT, Math.min(MAX_TL_HEIGHT, h));
const clampPps = (z) => Math.max(MIN_PPS, Math.min(MAX_PPS, z));
// Log-scale zoom slider: equal slider travel = equal zoom ratio.
const ppsToSlider = (z) => Math.log(z / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS);
const sliderToPps = (v) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v);

const readPref = (key, fallback) => {
    try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
    } catch {
        return fallback;
    }
};
const writePref = (key, v) => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
};

/** Resolve relative asset paths so waveform/filmstrip fetches work. */
const mediaUrl = (url) => {
    if (!url) return url;
    if (/^https?:\/\//i.test(url) || url.startsWith('blob:') || url.startsWith('data:')) return url;
    return getApiUrl(url);
};

const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

/**
 * Apply an in-progress drag to one source-anchored track item (text overlay /
 * b-roll), returning its patched { startFrame, endFrame } in SOURCE frames. The
 * dragged output delta is converted back to source via outputToSource at the
 * item's first output window, so the block follows the cursor on the OUTPUT axis
 * while staying anchored to content. Mirrors the clamp math used at commit.
 */
function itemDragPatch(framing, item, drag, fps) {
    const wins = sourceRangeToOutputRuns(framing, item.startFrame, item.endFrame, fps);
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
 * in OUTPUT frames. Left-trim outward is additionally clamped by how much
 * trimmed-off content actually exists (trimBefore): you can only reveal audio
 * that was previously trimmed away, not invent earlier content.
 */
function audioDragPatch(item, drag, totalOut) {
    const d = drag.deltaOut || 0;
    if (drag.kind === 'item-trim') {
        if (drag.edge === 'in') {
            const contentStart = drag.lane === 'audio' ? item.startFrame - (item.trimBefore || 0) : 0;
            const ns = Math.max(0, contentStart, Math.min(item.startFrame + d, item.endFrame - MIN_AUDIO_LEN));
            return { startFrame: ns, endFrame: item.endFrame };
        }
        const ne = Math.min(totalOut, Math.max(item.endFrame + d, item.startFrame + MIN_AUDIO_LEN));
        return { startFrame: item.startFrame, endFrame: ne };
    }
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
 * Caption words are deliberately not targets: they are closer together than
 * the snap reach, so everything would snap somewhere.
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
        if (item.anchor === 'output') {
            set.add(item.startFrame);
            set.add(item.endFrame);
            continue;
        }
        for (const w of sourceRangeToOutputRuns(framing, item.startFrame, item.endFrame, fps)) {
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
const fmtRuler = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const fmtDur = (frames) => `${(frames / EDITOR_FPS).toFixed(1)}s`;

/** Slice an evenly-spaced strip (peaks) to a source fraction window. */
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
 * Bottom-anchored waveform as one SVG path (cheap to draw, crisp at any zoom).
 * `peaks` are 0..1. Stretches to fill its box.
 */
const Wave = React.memo(function Wave({ peaks, color = C.wave, className = '' }) {
    const d = useMemo(() => {
        if (!peaks || peaks.length === 0) return '';
        let s = '';
        for (let i = 0; i < peaks.length; i++) {
            const h = Math.max(4, peaks[i] * 96);
            s += `M${i} 100V${(100 - h).toFixed(1)}H${i + 0.72}V100Z`;
        }
        return s;
    }, [peaks]);
    if (!d) return null;
    return (
        <svg
            className={`absolute inset-0 w-full h-full pointer-events-none ${className}`}
            viewBox={`0 0 ${peaks.length} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            <path d={d} fill={color} />
        </svg>
    );
});

/**
 * Thumbnails tiled at their natural 16:9 width (not stretched), each tile
 * showing the frame nearest its spot in the source, like CapCut's filmstrip.
 */
const Filmstrip = React.memo(function Filmstrip({ thumbs, s0, s1, width, height }) {
    const tileW = Math.max(24, Math.round(height * (16 / 9)));
    const n = Math.max(1, Math.ceil(width / tileW));
    if (!thumbs || thumbs.length === 0) {
        return <div className="absolute inset-0 bg-gradient-to-b from-zinc-700/60 to-zinc-800/80" />;
    }
    const tiles = [];
    for (let k = 0; k < n; k++) {
        const mid = Math.min(1, (k * tileW + tileW / 2) / width);
        const frac = s0 + mid * (s1 - s0);
        const idx = Math.max(0, Math.min(thumbs.length - 1, Math.floor(frac * thumbs.length)));
        tiles.push(
            <div
                key={k}
                className="absolute top-0 bottom-0 bg-cover bg-center"
                style={{ left: k * tileW, width: tileW, backgroundImage: `url(${thumbs[idx]})` }}
            />
        );
    }
    return <div className="absolute inset-0 overflow-hidden bg-zinc-900">{tiles}</div>;
});

/** White CapCut-style trim handle on a selected block's edge. */
const TrimHandle = ({ edge, onPointerDown, visible, title }) => (
    <div
        onPointerDown={onPointerDown}
        title={title}
        className={`absolute top-0 bottom-0 ${edge === 'in' ? 'left-0' : 'right-0'} w-2 cursor-ew-resize z-20 flex items-center justify-center ${
            visible ? 'bg-white' : 'opacity-0 group-hover:opacity-100 bg-white/80'
        }`}
    >
        <div className="w-[2px] h-3 rounded-full bg-black/60" />
    </div>
);

/**
 * One clip on the main (V1) track. Memoized so the per-frame playhead updates
 * don't re-render every block.
 */
const ClipBlock = React.memo(function ClipBlock({
    clip, left, width, height, selected, dragging, thumbs, totalSrc, outDuration, locked,
    onBodyDown, onTrimDown,
}) {
    const s0 = clip.sourceStart / totalSrc;
    const s1 = clip.sourceEnd / totalSrc;
    return (
        <div
            onPointerDown={locked ? undefined : (e) => onBodyDown(clip.id, e)}
            style={{ left: left + 1, width: Math.max(4, width - 2), top: 0, bottom: 0 }}
            className={`absolute rounded-[5px] overflow-hidden group ${locked ? '' : 'cursor-grab active:cursor-grabbing'} ${
                selected ? 'z-20' : 'z-10'
            } ${dragging ? 'opacity-85 z-30' : ''}`}
        >
            <Filmstrip thumbs={thumbs} s0={s0} s1={s1} width={Math.max(4, width - 2)} height={height} />
            {/* label strip */}
            <div className="absolute top-0 left-0 right-0 h-[18px] bg-gradient-to-b from-black/70 to-transparent pointer-events-none" />
            <div className="absolute top-[3px] left-2.5 right-2.5 flex items-center gap-1.5 text-[10px] leading-none font-medium text-white/95 pointer-events-none whitespace-nowrap overflow-hidden">
                <span className="truncate">{LAYOUT_LABEL[clip.layout] || clip.layout}</span>
                <span className="text-white/65 tabular-nums">{fmtDur(outDuration)}</span>
            </div>
            <div
                className={`absolute inset-0 rounded-[5px] pointer-events-none ${
                    selected ? 'ring-2 ring-inset ring-white' : 'ring-1 ring-inset ring-white/10 group-hover:ring-white/30'
                }`}
            />
            {!locked && ['in', 'out'].map((edge) => (
                <TrimHandle
                    key={edge}
                    edge={edge}
                    visible={selected}
                    title={edge === 'in' ? 'Trim clip start' : 'Trim clip end'}
                    onPointerDown={(e) => onTrimDown(clip.id, edge, e)}
                />
            ))}
        </div>
    );
});

/**
 * The original audio under one main-track clip (A1). Linked to the clip:
 * clicking selects that clip.
 */
const SourceAudioBlock = React.memo(function SourceAudioBlock({ clipId, left, width, peaks, muted, selected, locked, onBodyDown }) {
    return (
        <div
            onPointerDown={locked ? undefined : (e) => onBodyDown(clipId, e)}
            style={{ left: left + 1, width: Math.max(4, width - 2), background: muted ? C.audioDim : C.audio }}
            className={`absolute top-0 bottom-0 rounded-[5px] overflow-hidden group ${locked ? '' : 'cursor-grab active:cursor-grabbing'}`}
        >
            <div className="absolute inset-x-0 bottom-0 top-[16px]">
                <Wave peaks={peaks} color={muted ? 'rgba(255,255,255,0.25)' : C.wave} />
            </div>
            <div
                className={`absolute inset-0 rounded-[5px] pointer-events-none ${
                    selected ? 'ring-2 ring-inset ring-white/80' : 'ring-1 ring-inset ring-white/10'
                }`}
            />
        </div>
    );
});

/**
 * One source-anchored item (text overlay / b-roll / overlay). The FIRST window
 * carries the drag/trim handles; later windows are faded echoes (no interaction).
 */
const LaneBlock = React.memo(function LaneBlock({
    lane, itemId, label, Icon, color, left, width, echo, selected, dragging, locked,
    onBodyDown, onTrimDown, maskLabel = false,
}) {
    const interactive = !echo && !locked;
    return (
        <div
            onPointerDown={interactive ? (e) => onBodyDown(lane, itemId, e) : undefined}
            style={{ left: left + 1, width: Math.max(6, width - 2), background: color }}
            title={maskLabel ? 'Text overlay — drag to move, edges to trim' : `${label} — drag to move, edges to trim`}
            className={`absolute top-0 bottom-0 rounded-[5px] flex items-center px-2.5 text-[10px] text-white overflow-hidden group ${
                echo ? 'opacity-40 pointer-events-none' : interactive ? 'cursor-grab active:cursor-grabbing' : ''
            } ${dragging ? 'opacity-85 z-30' : selected ? 'z-20' : 'z-10'}`}
        >
            {Icon && <Icon size={11} className="mr-1 shrink-0 pointer-events-none opacity-90" />}
            <span className={`truncate pointer-events-none font-medium ${maskLabel ? 'ph-mask' : ''}`}>{label}</span>
            <div
                className={`absolute inset-0 rounded-[5px] pointer-events-none ${
                    selected ? 'ring-2 ring-inset ring-white' : 'ring-1 ring-inset ring-white/15 group-hover:ring-white/35'
                }`}
            />
            {interactive && ['in', 'out'].map((edge) => (
                <TrimHandle
                    key={edge}
                    edge={edge}
                    visible={selected}
                    title={edge === 'in' ? 'Trim start' : 'Trim end'}
                    onPointerDown={(e) => onTrimDown(lane, itemId, edge, e)}
                />
            ))}
        </div>
    );
});

/**
 * One OUTPUT-anchored audio item (music / sfx). Body = move, edges = trim.
 * Fades are drawn as dark ramps at the edges.
 */
const AUDIO_WAVE_BUCKETS = 200;

const AudioBlock = React.memo(function AudioBlock({
    itemId, url, label, Icon, left, width, durFrames, fadeInPx, fadeOutPx, muted, selected, dragging, locked,
    onBodyDown, onTrimDown,
}) {
    const peaks = useWaveform(mediaUrl(url), AUDIO_WAVE_BUCKETS);
    return (
        <div
            onPointerDown={locked ? undefined : (e) => onBodyDown('audio', itemId, e)}
            style={{ left: left + 1, width: Math.max(6, width - 2), background: muted ? C.audioDim : C.audio }}
            title="Audio — drag to move, edges to trim"
            className={`absolute top-0 bottom-0 rounded-[5px] overflow-hidden group ${locked ? '' : 'cursor-grab active:cursor-grabbing'} ${
                dragging ? 'opacity-85 z-30' : selected ? 'z-20' : 'z-10'
            }`}
        >
            <div className="absolute inset-x-0 bottom-0 top-[16px]">
                <Wave peaks={peaks} color={muted ? 'rgba(255,255,255,0.25)' : C.wave} />
            </div>
            {fadeInPx > 0 && (
                <div className="absolute inset-y-0 left-0 pointer-events-none z-[5]" style={{ width: fadeInPx, background: 'linear-gradient(to right, rgba(0,0,0,0.6), transparent)' }} />
            )}
            {fadeOutPx > 0 && (
                <div className="absolute inset-y-0 right-0 pointer-events-none z-[5]" style={{ width: fadeOutPx, background: 'linear-gradient(to left, rgba(0,0,0,0.6), transparent)' }} />
            )}
            <div className="absolute top-[3px] left-2.5 right-2.5 flex items-center gap-1 text-[10px] leading-none font-medium text-white/95 pointer-events-none z-10 whitespace-nowrap overflow-hidden">
                {muted ? <VolumeX size={10} className="shrink-0" /> : Icon && <Icon size={10} className="shrink-0" />}
                <span className="ph-mask truncate">{label}</span>
                <span className="text-white/60 tabular-nums">{fmtDur(durFrames)}</span>
            </div>
            <div
                className={`absolute inset-0 rounded-[5px] pointer-events-none ${
                    selected ? 'ring-2 ring-inset ring-white' : 'ring-1 ring-inset ring-white/10 group-hover:ring-white/30'
                }`}
            />
            {!locked && ['in', 'out'].map((edge) => (
                <TrimHandle
                    key={edge}
                    edge={edge}
                    visible={selected}
                    title={edge === 'in' ? 'Trim start' : 'Trim end'}
                    onPointerDown={(e) => onTrimDown('audio', itemId, edge, e)}
                />
            ))}
        </div>
    );
});

/** Caption phrases (gray chips) on the subtitles track. Click seeks there. */
const CaptionChips = React.memo(function CaptionChips({ groups, pxPerFrame, onPick }) {
    return groups.map((g) => (
        <button
            type="button"
            key={g.key}
            onPointerDown={(e) => { e.stopPropagation(); onPick(g.outStart); }}
            style={{ left: LANE_PAD + g.outStart * pxPerFrame + 1, width: Math.max(4, (g.outEnd - g.outStart) * pxPerFrame - 2), background: C.caption }}
            title={g.text}
            className="absolute top-0 bottom-0 rounded-[4px] px-1.5 text-left text-[10px] text-zinc-200 overflow-hidden whitespace-nowrap hover:brightness-125 ring-1 ring-inset ring-white/[0.06]"
        >
            <span className="ph-mask">{g.text}</span>
        </button>
    ));
});

/**
 * Playhead pieces. Each subscribes to the player's frameupdate itself so
 * per-frame playback re-renders only these, never the lanes.
 * `variant="line"` is the needle through the tracks (and owns auto-scroll);
 * `variant="head"` is the handle drawn in the sticky ruler.
 */
const Playhead = React.memo(function Playhead({ playerRef, pxPerFrame, scrollRef, variant }) {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const p = playerRef.current;
        if (!p) return undefined;
        const onF = (e) => setFrame(e.detail.frame);
        p.addEventListener('frameupdate', onF);
        return () => p.removeEventListener('frameupdate', onF);
    }, [playerRef]);

    useEffect(() => {
        if (variant !== 'line') return;
        const el = scrollRef.current;
        if (!el) return;
        const x = LANE_PAD + frame * pxPerFrame;
        if (x < el.scrollLeft + 40) el.scrollLeft = Math.max(0, x - 40);
        else if (x > el.scrollLeft + el.clientWidth - 56) el.scrollLeft = x - el.clientWidth + 56;
    }, [frame, pxPerFrame, scrollRef, variant]);

    const left = LANE_PAD + frame * pxPerFrame;
    if (variant === 'head') {
        return (
            <div className="absolute top-0 bottom-0 pointer-events-none z-10" style={{ left }}>
                <div className="absolute top-[3px] left-0 -translate-x-1/2 w-[11px] h-[14px] rounded-[3px] bg-white shadow-md" />
                <div className="absolute top-[16px] bottom-0 left-0 w-px bg-white" />
            </div>
        );
    }
    return <div className="absolute top-0 bottom-0 w-px bg-white pointer-events-none z-40 shadow-[0_0_4px_rgba(255,255,255,0.4)]" style={{ left }} />;
});

/** Small square icon button used in the toolbar and track heads. */
const IconBtn = ({ onClick, disabled, active, title, children, danger, className = '' }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        aria-label={title}
        aria-pressed={active}
        className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
            disabled
                ? 'text-zinc-700 cursor-not-allowed'
                : active
                    ? 'bg-[#2c8f96] text-white'
                    : danger
                        ? 'text-zinc-400 hover:text-red-400 hover:bg-white/5'
                        : 'text-zinc-400 hover:text-white hover:bg-white/5'
        } ${className}`}
    >
        {children}
    </button>
);

/** Group caption words into short phrases for the subtitles track. */
function captionGroups(framing, fps) {
    const subs = framing.subtitles;
    if (!subs || !Array.isArray(subs.captions) || subs.captions.length === 0) return [];
    const origin = framing.captionsOriginFrame ?? framing.clipInFrame ?? 0;
    const srcFps = framing.source.fps;
    const groups = [];
    let cur = null;
    const gapMax = Math.round(fps * 0.35);
    subs.captions.forEach((w, i) => {
        if (w.captionHidden) { cur = null; return; }
        const s = origin + Math.round((w.startMs / 1000) * srcFps);
        const e = origin + Math.round((w.endMs / 1000) * srcFps);
        const o = wordSourceToOutput(framing, s, e, fps);
        if (!o || o.outEnd <= o.outStart) { cur = null; return; }
        if (cur && o.outStart >= cur.outEnd && o.outStart - cur.outEnd <= gapMax && cur.n < 5) {
            cur.outEnd = o.outEnd;
            cur.text += ` ${w.text}`;
            cur.n += 1;
        } else {
            cur = { key: `cw-${i}`, outStart: o.outStart, outEnd: o.outEnd, text: w.text, n: 1 };
            groups.push(cur);
        }
    });
    return groups;
}

/**
 * Output-axis NLE timeline, CapCut style: a toolbar (select/blade tools, undo,
 * split, snapping, zoom), a fixed column of track heads (lock / mute), a sticky
 * ruler, and the tracks — captions, text, overlays, the main video (V1), its
 * original audio (A1) and music/SFX (A2). Clips can be selected, split (blade or
 * playhead), trimmed, reordered, duplicated and deleted; zoom with the slider,
 * Ctrl/Cmd + scroll, or fit-to-window.
 */
export default function EditorTimeline({
    framing, playerRef, selectedIds, onSelect, dispatch, sourceUrl, onSelectTrackItem, onExtend,
    canUndo, canRedo,
}) {
    const [outFrame, setOutFrame] = useState(0); // throttled — time display + split enablement only
    const [playing, setPlaying] = useState(false);
    const [pxPerSec, setPxPerSec] = useState(60);
    const [drag, setDrag] = useState(null);
    const [selectedItem, setSelectedItem] = useState(null); // { lane, id }
    const [collapsed, setCollapsed] = useState(false);
    const [tool, setTool] = useState('select'); // 'select' | 'blade'
    const [bladeX, setBladeX] = useState(null); // px in content coords while the blade hovers
    const [snapOn, setSnapOn] = useState(() => readPref('editorTimelineSnap', true));
    const [locked, setLocked] = useState(() => new Set());
    const [timelineHeight, setTimelineHeight] = useState(() => {
        const v = Number(readPref('editorTimelineHeight', DEFAULT_TL_HEIGHT));
        return clampHeight(Number.isFinite(v) && v ? v : DEFAULT_TL_HEIGHT);
    });
    const scrollRef = useRef(null);
    const headsRef = useRef(null);
    const dragRef = useRef(null);
    const resizeRef = useRef(null);
    const outTickRef = useRef(0);
    const activeRef = useRef(false); // last click landed inside the timeline
    const mutedVolumes = useRef({}); // audio volumes to restore on unmute
    const pxPerSecRef = useRef(pxPerSec);
    useEffect(() => { pxPerSecRef.current = pxPerSec; }, [pxPerSec]);
    const pendingScroll = useRef(null); // scrollLeft to apply after a zoom re-renders
    const fittedRef = useRef(false);

    const fps = EDITOR_FPS;
    const srcFps = framing.source.fps;
    const totalSrc = framing.source.durationFrames;
    const pxPerFrame = pxPerSec / fps;

    useEffect(() => writePref('editorTimelineSnap', snapOn), [snapOn]);

    const resolvedSource = mediaUrl(sourceUrl);
    const thumbs = useFilmstrip(resolvedSource, FILM_COUNT);
    const peaks = useWaveform(resolvedSource, WAVE_BUCKETS);

    const liveClips = useMemo(() => applyDrag(framing.clips, drag, totalSrc), [framing.clips, drag, totalSrc]);
    const placed = useMemo(() => placedClips({ ...framing, clips: liveClips }, fps), [framing, liveClips, fps]);
    const totalOut = useMemo(() => placed.reduce((a, p) => a + p.outDuration, 0) || 1, [placed]);
    const trackWidth = totalOut * pxPerFrame;
    const contentWidth = LANE_PAD + trackWidth + RIGHT_PAD;

    // --- Zoom ---
    // Zoom keeping one time under one screen x: the cursor for wheel zoom, the
    // playhead (when visible) for buttons / slider / keys, like CapCut.
    const zoomTo = useCallback((next, anchorClientX = null) => {
        const el = scrollRef.current;
        const z = pxPerSecRef.current;
        next = clampPps(next);
        if (!el || next === z) { setPxPerSec(next); return; }
        const rect = el.getBoundingClientRect();
        let offsetX;
        if (anchorClientX != null) {
            offsetX = anchorClientX - rect.left;
        } else {
            const ph = LANE_PAD + ((playerRef.current?.getCurrentFrame?.() ?? 0) / fps) * z - el.scrollLeft;
            offsetX = ph >= 0 && ph <= el.clientWidth ? ph : 0;
        }
        const t = (el.scrollLeft + offsetX - LANE_PAD) / z;
        pendingScroll.current = Math.max(0, LANE_PAD + t * next - offsetX);
        setPxPerSec(next);
    }, [playerRef, fps]);

    const fitZoom = useCallback(() => {
        const el = scrollRef.current;
        if (!el || totalOut <= 1) return;
        const avail = el.clientWidth - LANE_PAD - RIGHT_PAD;
        const next = clampPps(avail / (totalOut / fps));
        pendingScroll.current = 0;
        setPxPerSec(next);
    }, [totalOut, fps]);

    // Fit the whole short on first open.
    useLayoutEffect(() => {
        if (fittedRef.current || totalOut <= 1 || !scrollRef.current) return;
        fittedRef.current = true;
        fitZoom();
    }, [totalOut, fitZoom]);

    // Cmd/Ctrl + scroll zooms around the cursor. Native non-passive listener
    // because React's onWheel is passive and can't stop the page zoom.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            if (!e.metaKey && !e.ctrlKey) return;
            e.preventDefault();
            zoomTo(pxPerSecRef.current * Math.exp(-e.deltaY * 0.002), e.clientX);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [zoomTo]);

    useLayoutEffect(() => {
        if (pendingScroll.current != null && scrollRef.current) {
            scrollRef.current.scrollLeft = pendingScroll.current;
            pendingScroll.current = null;
        }
    }, [pxPerSec]);

    // Track heads live outside the scroller (no scrollbar under them); keep
    // them aligned with the rows when the tracks scroll vertically.
    const onScroll = useCallback((e) => {
        if (headsRef.current) headsRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`;
    }, []);

    // --- Player sync (throttled readout; the needle has its own subscription) ---
    useEffect(() => {
        const p = playerRef.current;
        if (!p) return undefined;
        const onF = (e) => {
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
        const el = scrollRef.current;
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        const x = clientX - rect.left + el.scrollLeft - LANE_PAD;
        return Math.max(0, Math.min(Math.round(x / pxPerFrame), totalOut - 1));
    }, [pxPerFrame, totalOut]);

    // --- Split / delete / duplicate ---
    const playClip = clipAtOutputFrame(framing, outFrame, fps);
    const srcAtPlayhead = outputToSource(framing, outFrame, fps);
    const canSplit = !!playClip
        && srcAtPlayhead - playClip.clip.sourceStart >= MIN_CLIP_LEN
        && playClip.clip.sourceEnd - srcAtPlayhead >= MIN_CLIP_LEN;

    const splitMainAt = useCallback((f) => {
        const pc = clipAtOutputFrame(framing, f, fps);
        if (!pc) return false;
        dispatch({ type: 'SPLIT_CLIP', clipId: pc.clip.id, sourceFrame: outputToSource(framing, f, fps) });
        return true;
    }, [framing, fps, dispatch]);

    const handleSplit = useCallback(() => {
        // Read the live player frame so the split lands exactly at the playhead.
        // A selected audio block under the playhead is split instead (CapCut).
        const f = Math.round(playerRef.current?.getCurrentFrame() ?? outFrame);
        if (selectedItem?.lane === 'audio') {
            const a = (framing.audio || []).find((x) => x.id === selectedItem.id);
            if (a && f > a.startFrame && f < a.endFrame) {
                dispatch({ type: 'SPLIT_AUDIO', id: a.id, frame: f });
                return;
            }
        }
        splitMainAt(f);
    }, [outFrame, playerRef, selectedItem, framing.audio, dispatch, splitMainAt]);

    const selectedId = selectedIds[0] ?? null;
    const canDeleteClip = selectedId && framing.clips.length > 1 && framing.clips.some((c) => c.id === selectedId);
    const canDeleteItem = selectedItem && (selectedItem.lane === 'audio' || selectedItem.lane === 'overlay');
    const canDelete = canDeleteItem || canDeleteClip;
    const canDuplicate = !!selectedId && framing.clips.some((c) => c.id === selectedId);

    const handleDelete = useCallback(() => {
        if (selectedItem?.lane === 'audio') {
            dispatch({ type: 'REMOVE_AUDIO', id: selectedItem.id });
            setSelectedItem(null);
            return;
        }
        if (selectedItem?.lane === 'overlay') {
            dispatch({ type: 'REMOVE_OVERLAY', id: selectedItem.id });
            setSelectedItem(null);
            return;
        }
        if (selectedId && framing.clips.length > 1) dispatch({ type: 'DELETE_CLIP', id: selectedId });
    }, [selectedItem, selectedId, framing.clips.length, dispatch]);

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

    // --- Mute (real: drives the exported audio) ---
    const sourceMuted = (framing.sourceVolume ?? 1) === 0;
    const audioItems = useMemo(() => framing.audio || [], [framing.audio]);
    const audioMuted = audioItems.length > 0 && audioItems.every((a) => (a.volume ?? 1) === 0);
    const toggleSourceMute = useCallback(() => {
        if (sourceMuted) {
            dispatch({ type: 'SET_SOURCE_VOLUME', volume: mutedVolumes.current.__source || 1 });
        } else {
            mutedVolumes.current.__source = framing.sourceVolume ?? 1;
            dispatch({ type: 'SET_SOURCE_VOLUME', volume: 0 });
        }
    }, [sourceMuted, framing.sourceVolume, dispatch]);
    const toggleAudioMute = useCallback(() => {
        const volumes = {};
        for (const a of audioItems) {
            if (audioMuted) volumes[a.id] = mutedVolumes.current[a.id] || 1;
            else {
                mutedVolumes.current[a.id] = a.volume ?? 1;
                volumes[a.id] = 0;
            }
        }
        dispatch({ type: 'SET_AUDIO_VOLUMES', volumes });
    }, [audioItems, audioMuted, dispatch]);

    const toggleLock = useCallback((id) => {
        setLocked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // --- Blade tool ---
    const bladeFrameAt = useCallback((clientX, altKey) => {
        let f = outFrameAtClientX(clientX);
        if (snapOn !== !!altKey) {
            const playhead = Math.round(playerRef.current?.getCurrentFrame() ?? 0);
            const best = bestSnap([f], [playhead, ...placed.map((p) => p.outStart)], pxPerFrame);
            if (best) f = best.snapFrame;
        }
        return f;
    }, [outFrameAtClientX, snapOn, playerRef, placed, pxPerFrame]);

    const bladeCut = useCallback((laneId, e) => {
        const f = bladeFrameAt(e.clientX, e.altKey);
        if (laneId === 'audio') {
            const a = audioItems.find((x) => f > x.startFrame && f < x.endFrame);
            if (a) dispatch({ type: 'SPLIT_AUDIO', id: a.id, frame: f });
            return;
        }
        if (laneId === 'main' || laneId === 'source') splitMainAt(f);
    }, [bladeFrameAt, audioItems, dispatch, splitMainAt]);

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
        if (!d) {
            if (tool === 'blade') setBladeX(LANE_PAD + bladeFrameAt(e.clientX, e.altKey) * pxPerFrame);
            return;
        }
        if (d.kind === 'scrub') {
            seekToOut(outFrameAtClientX(e.clientX));
            return;
        }
        // Snapping on (magnet) unless Alt is held; Alt snaps when it's off.
        const wantSnap = snapOn !== e.altKey;
        const snapItem = (dd, deltaOut) => {
            if (!wantSnap || !dd.snapFrames) return { deltaOut, snapX: null };
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
                    const p = audioDragPatch(item, { ...dd, deltaOut }, totalOut);
                    edges = dd.kind === 'item-trim' ? [dd.edge === 'in' ? p.startFrame : p.endFrame] : [p.startFrame, p.endFrame];
                } else if (item) {
                    const p = itemDragPatch(framing, item, { ...dd, deltaOut }, fps);
                    const wins = sourceRangeToOutputRuns(framing, p.startFrame, p.endFrame, fps);
                    if (wins.length) {
                        const a = wins[0].outStart;
                        const b = wins[wins.length - 1].outEnd;
                        edges = dd.kind === 'item-trim' ? [dd.edge === 'in' ? a : b] : [a, b];
                    }
                }
            }
            if (!edges) return { deltaOut, snapX: null };
            const best = bestSnap(edges, candidates, pxPerFrame);
            // Snapping onto the playhead draws no guide: the needle is already there.
            return best
                ? { deltaOut: deltaOut + best.gap, snapX: best.snapFrame === playhead ? null : best.snapFrame * pxPerFrame }
                : { deltaOut, snapX: null };
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
            if (wantSnap && d.snapFrames) {
                const lc = applyDrag(framing.clips, { kind: 'trim', id: d.id, edge: d.edge, deltaSrc }, totalSrc);
                const lp = placedClips({ ...framing, clips: lc }, fps).find((p) => p.clip.id === d.id);
                if (lp) {
                    const edge = d.edge === 'in' ? lp.outStart : lp.outStart + lp.outDuration;
                    const playhead = Math.round(playerRef.current?.getCurrentFrame() ?? 0);
                    const best = bestSnap([edge], [...d.snapFrames, playhead], pxPerFrame);
                    if (best) {
                        deltaSrc += Math.round(best.gap * (srcFps / fps));
                        snapX = best.snapFrame === playhead ? null : best.snapFrame * pxPerFrame;
                    }
                }
            }
            const nd = { ...d, deltaSrc, snapX };
            dragRef.current = nd;
            setDrag(nd);
        } else if (d.kind === 'pending' || d.kind === 'move') {
            if (d.kind === 'pending' && Math.abs(dx) < 4) return;
            const el = scrollRef.current;
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left + el.scrollLeft - LANE_PAD;
            const real = placedClips(framing, fps).filter((p) => p.clip.id !== d.id);
            const toIndex = real.filter((p) => (p.outStart + p.outDuration / 2) * pxPerFrame < x).length;
            const nd = { ...d, kind: 'move', toIndex };
            dragRef.current = nd;
            setDrag(nd);
        }
    }, [tool, bladeFrameAt, snapOn, pxPerFrame, srcFps, fps, framing, seekToOut, outFrameAtClientX, totalOut, totalSrc, playerRef]);

    const endDrag = useCallback((e) => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!d) return;
        if (d.kind === 'item-move' || d.kind === 'item-trim') {
            if (d.lane === 'audio') {
                // Trimming the LEFT edge also advances trimBefore so the sound
                // stays put instead of sliding (CapCut behaviour).
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
            // Never moved → a click: select the block + open its panel.
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
            // Never moved → a click: select + move the playhead there.
            setSelectedItem(null);
            onSelect(d.id, e.shiftKey || e.metaKey || e.ctrlKey);
            const f = outFrameAtClientX(e.clientX);
            const p = placedClips(framing, fps).find((pp) => pp.clip.id === d.id);
            if (p) seekToOut(Math.max(p.outStart, Math.min(f, p.outStart + p.outDuration - 1)));
        }
    }, [framing, fps, dispatch, onSelect, seekToOut, onSelectTrackItem, totalOut, outFrameAtClientX]);

    // Click on empty lane space: deselect the lane item and move the playhead.
    const onLaneBackgroundDown = useCallback((laneId, e) => {
        if (e.button !== 0) return;
        if (tool === 'blade') {
            if (locked.has(laneId)) return;
            e.stopPropagation();
            e.preventDefault();
            bladeCut(laneId, e);
            return;
        }
        if (e.target !== e.currentTarget) return;
        setSelectedItem(null);
        seekToOut(outFrameAtClientX(e.clientX));
    }, [tool, locked, bladeCut, seekToOut, outFrameAtClientX]);

    // --- Resizable timeline height ---
    const onResizeDown = useCallback((e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        resizeRef.current = { startY: e.clientY, startH: timelineHeight, latest: timelineHeight };
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, [timelineHeight]);
    const onResizeMove = useCallback((e) => {
        const r = resizeRef.current;
        if (!r) return;
        const h = clampHeight(r.startH + (r.startY - e.clientY));
        r.latest = h;
        setTimelineHeight(h);
    }, []);
    const onResizeUp = useCallback(() => {
        const r = resizeRef.current;
        if (!r) return;
        resizeRef.current = null;
        writePref('editorTimelineHeight', r.latest);
    }, []);

    // Remember whether the last click was inside the timeline, so Delete only
    // removes a main-track clip when the timeline is what you're working in.
    useEffect(() => {
        const onDown = (e) => { activeRef.current = !!e.target.closest?.('[data-tour="editor-timeline"]'); };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, []);

    // --- Keyboard (CapCut keys) ---
    // B blade · A/V select · N snapping · Cmd/Ctrl+B split at playhead ·
    // = / - zoom · Shift+Z fit · Delete removes the selection.
    useEffect(() => {
        const onKey = (e) => {
            if (isTyping(e.target)) return;
            const mod = e.metaKey || e.ctrlKey;
            const k = e.key.toLowerCase();
            if (mod && k === 'b') { e.preventDefault(); handleSplit(); return; }
            if (mod || e.altKey) return;
            if (k === 'b') setTool('blade');
            else if (k === 'a' || k === 'v') { setTool('select'); setBladeX(null); }
            else if (k === 'n') setSnapOn((v) => !v);
            else if (k === '=' || k === '+') zoomTo(pxPerSecRef.current * 1.35);
            else if (k === '-' || k === '_') zoomTo(pxPerSecRef.current / 1.35);
            else if (k === 'z' && e.shiftKey) fitZoom();
            else if (e.key === 'Backspace' || e.key === 'Delete') {
                if (canDeleteItem || (canDeleteClip && activeRef.current)) {
                    e.preventDefault();
                    handleDelete();
                }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [handleSplit, zoomTo, fitZoom, handleDelete, canDeleteItem, canDeleteClip]);

    // --- Ruler ticks ---
    // Pick a labelled step that keeps labels ~90px apart; minor ticks in between.
    const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    const majorSec = STEPS.find((s) => s * pxPerSec >= 90) ?? STEPS[STEPS.length - 1];
    const minorDiv = majorSec === 1 ? (pxPerSec >= 300 ? 10 : 5) : majorSec === 2 || majorSec === 10 ? 4 : majorSec === 15 || majorSec === 30 ? 3 : 5;
    const minorPx = (majorSec * pxPerSec) / minorDiv;
    const labels = [];
    for (let s = 0; s * fps <= totalOut + majorSec * fps; s += majorSec) labels.push(s);

    const draggingId = drag && (drag.kind === 'move' || drag.kind === 'trim') ? drag.id : null;

    // --- Lane items placed on the output axis ---
    const patchedFrames = (item) =>
        drag && drag.itemId === item.id && (drag.kind === 'item-move' || drag.kind === 'item-trim')
            ? itemDragPatch(framing, item, drag, fps)
            : item;
    const laneWindows = (items) =>
        items.flatMap((item) => {
            if (item.anchor === 'output') {
                const eff = drag && drag.itemId === item.id && (drag.kind === 'item-move' || drag.kind === 'item-trim')
                    ? audioDragPatch(item, drag, totalOut)
                    : item;
                return [{ item, w: { outStart: eff.startFrame, outEnd: eff.endFrame }, wi: 0 }];
            }
            const eff = patchedFrames(item);
            return sourceRangeToOutputRuns(framing, eff.startFrame, eff.endFrame, fps).map((w, wi) => ({ item, w, wi }));
        });
    const textWindows = laneWindows(framing.textOverlays || []);
    const brollWindows = laneWindows(framing.broll || []);
    const overlayWindows = laneWindows(framing.overlays || []);
    const transitionsOn = !!(framing.transitions?.cutCrossfade || framing.transitions?.cutStyle);
    const captionChips = useMemo(() => captionGroups(framing, fps), [framing, fps]);

    const audioBlocks = audioItems.map((item) => {
        const eff = drag && drag.itemId === item.id && drag.lane === 'audio' && (drag.kind === 'item-move' || drag.kind === 'item-trim')
            ? audioDragPatch(item, drag, totalOut)
            : item;
        const name = item.url ? decodeURIComponent(item.url.split('/').pop() || '') : '';
        const len = eff.endFrame - eff.startFrame;
        return {
            item,
            left: LANE_PAD + eff.startFrame * pxPerFrame,
            width: Math.max(10, len * pxPerFrame),
            durFrames: len,
            fadeInPx: Math.min((item.fadeInSec || 0) * fps * pxPerFrame, len * pxPerFrame),
            fadeOutPx: Math.min((item.fadeOutSec || 0) * fps * pxPerFrame, len * pxPerFrame),
            label: name || (item.role === 'sfx' ? 'SFX' : 'Music'),
            Icon: item.role === 'sfx' ? Volume2 : Music,
            muted: (item.volume ?? 1) === 0,
        };
    });

    // --- Tracks (top → bottom, CapCut order: captions, text, overlays, main, audio) ---
    const tracks = [];
    if (captionChips.length) tracks.push({ id: 'captions', badge: 'CC', label: 'Captions', h: 26 });
    if (textWindows.length) tracks.push({ id: 'text', badge: 'T1', label: 'Text', h: 30 });
    const vTracks = [];
    if (overlayWindows.length) vTracks.push({ id: 'overlay', label: 'Overlays', h: 34 });
    if (brollWindows.length) vTracks.push({ id: 'broll', label: 'B-roll', h: 34 });
    vTracks.forEach((t, i) => tracks.push({ ...t, badge: `V${vTracks.length - i + 1}` }));
    tracks.push({ id: 'main', badge: 'V1', label: 'Main', h: 62 });
    tracks.push({ id: 'source', badge: 'A1', label: 'Audio', h: 38, mute: true });
    tracks.push({ id: 'audio', badge: 'A2', label: 'Music', h: 38, mute: audioItems.length > 0 });

    const muteState = { source: sourceMuted, audio: audioMuted };
    const muteToggle = { source: toggleSourceMute, audio: toggleAudioMute };

    const blockWidth = (w) => Math.max(12, (w.outEnd - w.outStart) * pxPerFrame);

    const renderLane = (t) => {
        const isLocked = locked.has(t.id);
        switch (t.id) {
            case 'captions':
                return <CaptionChips groups={captionChips} pxPerFrame={pxPerFrame} onPick={(f) => { seekToOut(f); onSelectTrackItem?.('captions'); }} />;
            case 'text':
            case 'overlay':
            case 'broll': {
                const wins = t.id === 'text' ? textWindows : t.id === 'overlay' ? overlayWindows : brollWindows;
                return wins.map(({ item, w, wi }) => (
                    <LaneBlock
                        key={`${item.id}-${wi}`}
                        lane={t.id}
                        itemId={item.id}
                        label={t.id === 'text' ? (item.text || 'Text') : t.id === 'overlay' && item.kind === 'image' ? 'Image' : 'B-roll'}
                        maskLabel={t.id === 'text'}
                        Icon={t.id === 'text' ? Type : t.id === 'overlay' && item.kind === 'image' ? ImageIcon : Clapperboard}
                        color={t.id === 'text' ? C.text : C.overlay}
                        left={LANE_PAD + w.outStart * pxPerFrame}
                        width={blockWidth(w)}
                        echo={wi !== 0}
                        locked={isLocked}
                        selected={selectedItem?.lane === t.id && selectedItem.id === item.id}
                        dragging={drag?.itemId === item.id}
                        onBodyDown={onItemBodyDown}
                        onTrimDown={onItemTrimDown}
                    />
                ));
            }
            case 'main':
                return (
                    <>
                        {placed.map((p) => (
                            <ClipBlock
                                key={p.clip.id}
                                clip={p.clip}
                                left={LANE_PAD + p.outStart * pxPerFrame}
                                width={Math.max(12, p.outDuration * pxPerFrame)}
                                height={t.h}
                                outDuration={p.outDuration}
                                selected={selectedIds.includes(p.clip.id)}
                                dragging={draggingId === p.clip.id}
                                thumbs={thumbs}
                                totalSrc={totalSrc}
                                locked={isLocked}
                                onBodyDown={onBodyDown}
                                onTrimDown={onTrimDown}
                            />
                        ))}
                        {transitionsOn && placed.slice(1).map((p) => (
                            <button
                                type="button"
                                key={`tr-${p.clip.id}`}
                                onPointerDown={(e) => { e.stopPropagation(); onSelectTrackItem?.('transitions', null); }}
                                style={{ left: LANE_PAD + p.outStart * pxPerFrame }}
                                title="Transition — edit in the Transitions tab"
                                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rotate-45 bg-amber-400/90 border border-amber-200 hover:bg-amber-300 z-30"
                            />
                        ))}
                        <button
                            type="button"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => onExtend?.('end')}
                            title="Add a section of the original video after the end"
                            style={{ left: LANE_PAD + trackWidth + 10 }}
                            className="absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-md border border-dashed border-white/20 text-zinc-400 hover:text-white hover:border-white/50 hover:bg-white/5 flex items-center justify-center"
                        >
                            <Plus size={14} />
                        </button>
                    </>
                );
            case 'source':
                return placed.map((p) => (
                    <SourceAudioBlock
                        key={`a1-${p.clip.id}`}
                        clipId={p.clip.id}
                        left={LANE_PAD + p.outStart * pxPerFrame}
                        width={Math.max(12, p.outDuration * pxPerFrame)}
                        peaks={fracSlice(peaks || [], p.clip.sourceStart / totalSrc, p.clip.sourceEnd / totalSrc)}
                        muted={sourceMuted}
                        selected={selectedIds.includes(p.clip.id)}
                        locked={isLocked}
                        onBodyDown={onBodyDown}
                    />
                ));
            case 'audio':
                if (audioBlocks.length === 0) {
                    return (
                        <button
                            type="button"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => onSelectTrackItem?.('audio', null)}
                            style={{ left: LANE_PAD + 1, width: Math.min(180, Math.max(96, trackWidth * 0.3)) }}
                            title="Add music or sound effects"
                            className="absolute top-0 bottom-0 flex items-center justify-center rounded-[5px] border border-dashed border-white/15 text-[10px] text-zinc-400 hover:text-white hover:border-white/35 hover:bg-white/[0.04] px-2"
                        >
                            <Music size={11} className="mr-1 shrink-0" /> Add audio
                        </button>
                    );
                }
                return audioBlocks.map((b) => (
                    <AudioBlock
                        key={b.item.id}
                        itemId={b.item.id}
                        url={b.item.url}
                        label={b.label}
                        Icon={b.Icon}
                        left={b.left}
                        width={b.width}
                        durFrames={b.durFrames}
                        fadeInPx={b.fadeInPx}
                        fadeOutPx={b.fadeOutPx}
                        muted={b.muted}
                        locked={isLocked}
                        selected={selectedItem?.lane === 'audio' && selectedItem.id === b.item.id}
                        dragging={drag?.itemId === b.item.id && drag?.lane === 'audio'}
                        onBodyDown={onItemBodyDown}
                        onTrimDown={onItemTrimDown}
                    />
                ));
            default:
                return null;
        }
    };

    const bladeable = (id) => id === 'main' || id === 'source' || id === 'audio';
    const sliderPct = ppsToSlider(pxPerSec) * 100;

    return (
        <div data-tour="editor-timeline" className="border-t border-white/[0.06] select-none" style={{ background: C.bg }}>
            {/* resize handle */}
            <div
                onPointerDown={onResizeDown}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
                onPointerCancel={onResizeUp}
                title="Drag to resize timeline"
                className="h-1.5 w-full cursor-ns-resize flex items-center justify-center group"
            >
                <div className="w-10 h-0.5 rounded-full bg-white/10 group-hover:bg-white/30 group-hover:w-12 transition-all" />
            </div>

            {/* Toolbar */}
            <div className="relative flex items-center gap-0.5 px-2 h-10 border-b" style={{ borderColor: C.line }}>
                <div className="flex items-center gap-0.5 z-10">
                    <IconBtn title="Select (A)" active={tool === 'select'} onClick={() => { setTool('select'); setBladeX(null); }}>
                        <MousePointer2 size={15} />
                    </IconBtn>
                    <IconBtn title="Blade — click a clip to cut it (B)" active={tool === 'blade'} onClick={() => setTool('blade')}>
                        <Scissors size={15} />
                    </IconBtn>
                    <span className="mx-1.5 h-4 w-px bg-white/10" />
                    <IconBtn title="Undo (Cmd/Ctrl+Z)" disabled={canUndo === false} onClick={() => dispatch({ type: 'UNDO' })}>
                        <Undo2 size={15} />
                    </IconBtn>
                    <IconBtn title="Redo (Shift+Cmd/Ctrl+Z)" disabled={canRedo === false} onClick={() => dispatch({ type: 'REDO' })}>
                        <Redo2 size={15} />
                    </IconBtn>
                    <span className="mx-1.5 h-4 w-px bg-white/10" />
                    <button
                        type="button"
                        onClick={handleSplit}
                        disabled={!canSplit && selectedItem?.lane !== 'audio'}
                        title="Split at playhead (Cmd/Ctrl+B)"
                        className={`h-7 px-2 rounded-md flex items-center gap-1 text-[11px] transition-colors ${
                            canSplit || selectedItem?.lane === 'audio' ? 'text-zinc-300 hover:text-white hover:bg-white/5' : 'text-zinc-700 cursor-not-allowed'
                        }`}
                    >
                        <Scissors size={13} className="rotate-90" /> Split
                    </button>
                    <IconBtn title="Duplicate selected clip" disabled={!canDuplicate} onClick={() => selectedId && duplicateClip(selectedId)}>
                        <Copy size={14} />
                    </IconBtn>
                    <IconBtn title="Delete selection (Delete)" danger disabled={!canDelete} onClick={handleDelete}>
                        <Trash2 size={14} />
                    </IconBtn>
                </div>

                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="flex items-center gap-0.5 pointer-events-auto">
                        <IconBtn title="Back to start" onClick={() => seekToOut(0)}>
                            <SkipBack size={15} />
                        </IconBtn>
                        <button type="button" onClick={togglePlay} className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center hover:bg-zinc-100 active:scale-95 transition-all" aria-label={playing ? 'Pause' : 'Play'}>
                            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} className="ml-0.5" fill="currentColor" />}
                        </button>
                        <IconBtn title="Forward 1s" onClick={() => seekToOut(Math.min(totalOut - 1, outFrame + Math.round(EDITOR_FPS)))}>
                            <SkipForward size={15} />
                        </IconBtn>
                        <span className="text-[12px] text-zinc-200 tabular-nums ml-2 font-medium tracking-tight">
                            {fmt(outFrame)} <span className="text-zinc-600">|</span> <span className="text-zinc-500">{fmt(totalOut)}</span>
                        </span>
                    </div>
                </div>

                <div className="ml-auto flex items-center gap-0.5 z-10">
                    <IconBtn title={snapOn ? 'Snapping on (N)' : 'Snapping off (N)'} active={snapOn} onClick={() => setSnapOn((v) => !v)}>
                        <Magnet size={15} />
                    </IconBtn>
                    <span className="mx-1.5 h-4 w-px bg-white/10" />
                    <IconBtn title="Zoom out (-)" onClick={() => zoomTo(pxPerSec / 1.35)} disabled={pxPerSec <= MIN_PPS}>
                        <ZoomOut size={15} />
                    </IconBtn>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.001}
                        value={ppsToSlider(pxPerSec)}
                        onChange={(e) => zoomTo(sliderToPps(Number(e.target.value)))}
                        className="tl-zoom w-24 h-[3px] cursor-pointer appearance-none rounded-full"
                        style={{ background: `linear-gradient(to right, #43c4cc ${sliderPct}%, rgba(255,255,255,0.15) ${sliderPct}%)` }}
                        aria-label="Timeline zoom"
                    />
                    <IconBtn title="Zoom in (=)" onClick={() => zoomTo(pxPerSec * 1.35)} disabled={pxPerSec >= MAX_PPS}>
                        <ZoomIn size={15} />
                    </IconBtn>
                    <IconBtn title="Fit timeline to window (Shift+Z)" onClick={fitZoom}>
                        <MoveHorizontal size={15} />
                    </IconBtn>
                    <span className="mx-1.5 h-4 w-px bg-white/10" />
                    <IconBtn title={collapsed ? 'Show timeline' : 'Hide timeline'} active={false} onClick={() => setCollapsed((v) => !v)}>
                        <PanelBottomClose size={15} className={collapsed ? 'rotate-180' : ''} />
                    </IconBtn>
                </div>
            </div>

            {/* Body: track heads | scrolling tracks */}
            <div
                className={`flex transition-[height,opacity] duration-200 ${collapsed ? 'pointer-events-none overflow-hidden' : ''}`}
                style={{ height: collapsed ? 0 : timelineHeight, opacity: collapsed ? 0 : 1 }}
            >
                {/* Track heads */}
                <div className="relative shrink-0 overflow-hidden border-r z-20" style={{ width: HEAD_W, background: C.head, borderColor: C.line }}>
                    <div className="relative z-10 border-b" style={{ height: RULER_H, background: C.head, borderColor: C.line }} />
                    <div ref={headsRef} style={{ paddingTop: ROW_GAP }}>
                        {tracks.map((t) => {
                            const isLocked = locked.has(t.id);
                            return (
                                <div key={t.id} className="flex items-center gap-1 pl-2 pr-1" style={{ height: t.h, marginBottom: ROW_GAP }}>
                                    <span
                                        className={`shrink-0 w-[22px] h-[16px] rounded-[3px] text-[9px] font-semibold flex items-center justify-center ${
                                            t.id === 'main' ? 'bg-[#2c8f96] text-white' : 'bg-white/10 text-zinc-300'
                                        }`}
                                    >
                                        {t.badge === 'CC' ? <Captions size={11} /> : t.badge}
                                    </span>
                                    <span className="flex-1 min-w-0 truncate text-[10px] text-zinc-500" title={t.label}>{t.label}</span>
                                    {t.id === 'main' && (
                                        <button
                                            type="button"
                                            onClick={() => onExtend?.('start')}
                                            title="Add a section of the original video before the start"
                                            className="w-5 h-5 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10"
                                        >
                                            <Plus size={12} />
                                        </button>
                                    )}
                                    {t.mute && (
                                        <button
                                            type="button"
                                            onClick={muteToggle[t.id]}
                                            title={muteState[t.id] ? 'Unmute track' : 'Mute track'}
                                            aria-pressed={muteState[t.id]}
                                            className={`w-5 h-5 rounded flex items-center justify-center hover:bg-white/10 ${muteState[t.id] ? 'text-red-400' : 'text-zinc-500 hover:text-white'}`}
                                        >
                                            {muteState[t.id] ? <VolumeX size={12} /> : <Volume2 size={12} />}
                                        </button>
                                    )}
                                    {t.id !== 'captions' && (
                                        <button
                                            type="button"
                                            onClick={() => toggleLock(t.id)}
                                            title={isLocked ? 'Unlock track' : 'Lock track (stops accidental edits)'}
                                            aria-pressed={isLocked}
                                            className={`w-5 h-5 rounded flex items-center justify-center hover:bg-white/10 ${isLocked ? 'text-amber-300' : 'text-zinc-500 hover:text-white'}`}
                                        >
                                            {isLocked ? <Lock size={11} /> : <Unlock size={11} />}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Scrolling tracks */}
                <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    className={`relative flex-1 min-w-0 overflow-auto custom-scrollbar ${tool === 'blade' ? 'cursor-crosshair' : ''}`}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerLeave={(e) => { setBladeX(null); endDrag(e); }}
                >
                    <div className="relative" style={{ width: contentWidth, minWidth: '100%', minHeight: '100%' }}>
                        {/* Ruler (sticky) */}
                        <div
                            className="sticky top-0 z-[45] cursor-pointer border-b"
                            style={{ height: RULER_H, background: C.bg, borderColor: C.line }}
                            onPointerDown={rulerDown}
                        >
                            <div
                                className="absolute bottom-0 h-[6px] pointer-events-none"
                                style={{
                                    left: LANE_PAD,
                                    width: trackWidth + RIGHT_PAD,
                                    backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.18) 0 1px, transparent 1px ${minorPx}px)`,
                                }}
                            />
                            {labels.map((s) => (
                                <div key={s} className="absolute bottom-0 top-[5px] pointer-events-none" style={{ left: LANE_PAD + s * pxPerSec }}>
                                    <div className="absolute bottom-0 left-0 w-px h-[11px] bg-white/35" />
                                    <span className="absolute top-0 left-1 text-[10px] text-zinc-500 tabular-nums leading-none">{fmtRuler(s)}</span>
                                </div>
                            ))}
                            <Playhead variant="head" playerRef={playerRef} pxPerFrame={pxPerFrame} scrollRef={scrollRef} />
                        </div>

                        {/* Rows */}
                        <div style={{ paddingTop: ROW_GAP, paddingBottom: 12 }}>
                            {tracks.map((t) => (
                                <div
                                    key={t.id}
                                    className="relative"
                                    style={{ height: t.h, marginBottom: ROW_GAP, background: C.lane }}
                                    onPointerDownCapture={tool === 'blade' && bladeable(t.id)
                                        ? (e) => { if (!e.target.closest?.('button')) onLaneBackgroundDown(t.id, e); }
                                        : undefined}
                                    onPointerDown={(e) => onLaneBackgroundDown(t.id, e)}
                                >
                                    {renderLane(t)}
                                    {locked.has(t.id) && (
                                        <div
                                            className="absolute inset-0 z-[35] pointer-events-none"
                                            style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(0,0,0,0.35) 0 6px, transparent 6px 12px)' }}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>

                        {drag?.snapX != null && (
                            <div className="absolute top-0 bottom-0 w-px bg-[#43c4cc] z-50 pointer-events-none" style={{ left: LANE_PAD + drag.snapX }} />
                        )}
                        {tool === 'blade' && bladeX != null && !drag && (
                            <div className="absolute bottom-0 w-px z-50 pointer-events-none" style={{ left: bladeX, top: RULER_H, background: 'repeating-linear-gradient(to bottom, #fff 0 4px, transparent 4px 7px)' }} />
                        )}
                        <Playhead variant="line" playerRef={playerRef} pxPerFrame={pxPerFrame} scrollRef={scrollRef} />
                    </div>
                </div>
            </div>
        </div>
    );
}
