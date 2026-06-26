import React, { useEffect, useMemo, useRef, useState } from 'react';
import { placedClips } from '@remotion-src/lib/edl';

/**
 * Opus-style "drag captions to reposition" layer. Sits absolutely over the
 * Remotion Player inside EditorCanvas. The caption block itself is the drag
 * target (a selection box with corner handles); dragging it sets a free-form
 * normalized center (x, y) on the subtitle config, overriding the
 * top/middle/bottom preset.
 *
 * Movement is live: each pointermove dispatches a *transient* SET_SUBTITLES
 * (no undo-history entry) via rAF, so the real Remotion caption follows the
 * cursor 1:1 and feels smooth. Pointer release commits one history entry.
 *
 * The center is clamped to a reel-safe zone (the centred rect TikTok / Reels /
 * Shorts leave clear of their own UI chrome). While dragging we dim everything
 * outside that zone and show the "Place visual elements within the safe zone"
 * hint, matching Opus.
 *
 * Only the box captures pointer events, so the rest of the canvas (and the
 * Tracker overlay, when both are mounted) stays interactive.
 */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Reel-safe zone as fractions of the 9:16 frame. Asymmetric on purpose: the
// platform UI is not centered. The right edge is inset hard to clear the
// like / comment / share / save action rail; the bottom clears the username +
// caption row; the top clears the progress bar / header. This intentionally
// nudges captions left-of-center, matching Reels / TikTok / Opus.
// ponytail: fixed fractions; lift to per-platform presets if TikTok vs Reels
// vs Shorts ever need different rails.
const SAFE = { left: 0.06, right: 0.8, top: 0.12, bottom: 0.8 };

// The selection box drawn around the caption block, as a fraction of frame.
const BOX_W = 0.62;
const BOX_H = 0.14;

// Approximate caption-block center for each preset, used only to seat the box
// before the user has dragged. Once x/y exist they win exactly.
const PRESET_CENTER = {
    top: { x: 0.5, y: 0.18 },
    middle: { x: 0.5, y: 0.5 },
    bottom: { x: 0.5, y: 0.85 },
};

// The safe zone is a *guide*, not a cage — you can place captions outside it
// on purpose. We only clamp the box center to the frame so it can't be dragged
// fully off-screen.
const clampToFrame = ({ x, y }) => ({
    x: clamp(x, BOX_W / 2, 1 - BOX_W / 2),
    y: clamp(y, BOX_H / 2, 1 - BOX_H / 2),
});

export default function CaptionDragOverlay({ subtitles, dispatch, framing, playerRef, scope = 'all', fps = 30 }) {
    const layerRef = useRef(null);
    const rafRef = useRef(0);
    const latestRef = useRef(null);
    // Latest subtitles, read inside the rAF/commit callbacks so they never act
    // on a stale closure if a re-render lands between scheduling and firing.
    const subtitlesRef = useRef(subtitles);
    // Pre-drag snapshots, captured on pointerdown so the drag is undoable even
    // though the live (transient) updates don't push history themselves.
    const originalRef = useRef(null); // pre-drag subtitles (global scope undo)
    const originalFramingRef = useRef(null); // pre-drag framing (clip scope undo)
    // The drag's scope + target clip, frozen at pointerdown so a frame tick
    // mid-drag can't retarget it.
    const dragScopeRef = useRef('all');
    const dragClipIdRef = useRef(null);
    // The target clip's placement BEFORE the drag, so each move merges onto it
    // (preserving maxWidthPct etc.). Captured at pointerdown — reading live
    // framing would lose those fields after the first transient overwrite.
    const dragBasePlacementRef = useRef(null);
    // Did the pointer actually move? A plain click shouldn't create a history entry.
    const movedRef = useRef(false);
    // Pointer offset between cursor and box center at grab time, so the box
    // doesn't jump its center to the cursor on the first move.
    const grabOffset = useRef({ dx: 0, dy: 0 });
    // Live position during a drag (null when idle → use committed x/y / preset).
    const [dragPos, setDragPos] = useState(null);

    // Track the playhead (output frame) so we know which clip is on screen — the
    // target when scope === 'clip'. Mirrors TrackerOverlay's frame subscription.
    const [outFrame, setOutFrame] = useState(0);
    useEffect(() => {
        const p = playerRef?.current;
        if (!p) return;
        setOutFrame(p.getCurrentFrame());
        const onFrame = (e) => setOutFrame(e.detail.frame);
        p.addEventListener('frameupdate', onFrame);
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [playerRef]);

    const placed = useMemo(() => (framing ? placedClips(framing, fps) : []), [framing, fps]);
    const currentClip = useMemo(
        () => placed.find((p) => outFrame >= p.outStart && outFrame < p.outStart + p.outDuration)?.clip ?? null,
        [placed, outFrame]
    );
    const clipMode = scope === 'clip' && !!currentClip;

    useEffect(() => {
        subtitlesRef.current = subtitles;
    });

    // Cancel a pending frame if we unmount mid-drag.
    useEffect(() => () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
    }, []);

    if (!subtitles) return null;

    // Seat the box from the placement that this scope edits: the clip's override
    // (clip scope, when present) else the global subtitle position/x,y.
    const seat = clipMode ? (currentClip.captionPlacement ?? subtitles) : subtitles;
    const committed =
        typeof seat.x === 'number' && typeof seat.y === 'number'
            ? { x: seat.x, y: seat.y }
            : PRESET_CENTER[seat.position] ?? PRESET_CENTER.bottom;

    const pos = dragPos ?? committed;
    const dragging = dragPos !== null;

    // Dispatch a position update — to the current clip's placement (clip scope)
    // or the global subtitle config — sharing the transient/commit contract.
    const dispatchPos = (x, y, { transient }) => {
        if (dragScopeRef.current === 'clip' && dragClipIdRef.current) {
            const placement = { ...dragBasePlacementRef.current, x, y };
            dispatch(
                transient
                    ? { type: 'SET_CLIP_CAPTION_PLACEMENT', transient: true, clipId: dragClipIdRef.current, placement }
                    : { type: 'SET_CLIP_CAPTION_PLACEMENT', original: originalFramingRef.current, clipId: dragClipIdRef.current, placement }
            );
        } else {
            // All-clips drag: set the global position AND clear per-clip overrides
            // so the move actually applies to every clip — otherwise an overridden
            // (e.g. smart-placed) clip wins at render and wouldn't move. Undo
            // restores the full pre-drag framing. Carry the global maxWidthPct
            // through so a narrowed (promoted) caption keeps its width on a nudge.
            const mw = subtitlesRef.current?.maxWidthPct;
            const placement = typeof mw === 'number' ? { x, y, maxWidthPct: mw } : { x, y };
            dispatch(
                transient
                    ? { type: 'APPLY_CAPTION_PLACEMENT_TO_ALL', transient: true, placement }
                    : { type: 'APPLY_CAPTION_PLACEMENT_TO_ALL', original: originalFramingRef.current, placement }
            );
        }
    };

    // Live update without a history entry, coalesced to one per animation frame.
    const pushTransient = (pt) => {
        latestRef.current = pt;
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            const p = latestRef.current;
            if (!p) return;
            dispatchPos(Number(p.x.toFixed(4)), Number(p.y.toFixed(4)), { transient: true });
        });
    };

    const handlePointerDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = layerRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        originalRef.current = subtitles;
        originalFramingRef.current = framing;
        // Freeze the scope + target clip for the whole drag.
        dragScopeRef.current = clipMode ? 'clip' : 'all';
        dragClipIdRef.current = clipMode ? currentClip.id : null;
        dragBasePlacementRef.current = clipMode ? (currentClip.captionPlacement ?? null) : null;
        movedRef.current = false;
        grabOffset.current = {
            dx: pos.x - (e.clientX - rect.left) / rect.width,
            dy: pos.y - (e.clientY - rect.top) / rect.height,
        };
        setDragPos(pos);
    };

    const handlePointerMove = (e) => {
        if (dragPos === null) return;
        const rect = layerRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        const pt = clampToFrame({
            x: (e.clientX - rect.left) / rect.width + grabOffset.current.dx,
            y: (e.clientY - rect.top) / rect.height + grabOffset.current.dy,
        });
        movedRef.current = true;
        setDragPos(pt);
        pushTransient(pt);
    };

    const commit = (e) => {
        if (dragPos === null) return;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
        const pt = dragPos;
        setDragPos(null);
        // A click with no movement leaves position untouched — no history entry.
        if (!movedRef.current) return;
        // The transient moves already mutated the live state, so the pre-drag
        // snapshot (subtitles or framing, per scope) is what goes onto the undo
        // stack — dispatchPos handles that via its `original`.
        dispatchPos(Number(pt.x.toFixed(4)), Number(pt.y.toFixed(4)), { transient: false });
    };

    return (
        // Full-size layer is pointer-events-none so it never blocks the canvas;
        // only the box below opts back in.
        <div ref={layerRef} className="absolute inset-0 z-20 pointer-events-none" data-caption-drag-overlay>
            {/* Reel safe-zone guide — only while dragging, like Opus. Four dim
                panels around the safe rect + a hint pill. */}
            {dragging && (
                <>
                    <div className="absolute inset-x-0 top-0 bg-black/45" style={{ height: `${SAFE.top * 100}%` }} />
                    <div className="absolute inset-x-0 bottom-0 bg-black/45" style={{ height: `${(1 - SAFE.bottom) * 100}%` }} />
                    <div
                        className="absolute left-0 bg-black/45"
                        style={{ top: `${SAFE.top * 100}%`, height: `${(SAFE.bottom - SAFE.top) * 100}%`, width: `${SAFE.left * 100}%` }}
                    />
                    <div
                        className="absolute right-0 bg-black/45"
                        style={{ top: `${SAFE.top * 100}%`, height: `${(SAFE.bottom - SAFE.top) * 100}%`, width: `${(1 - SAFE.right) * 100}%` }}
                    />
                    <div
                        className="absolute rounded-sm border border-white/40"
                        style={{
                            left: `${SAFE.left * 100}%`,
                            top: `${SAFE.top * 100}%`,
                            width: `${(SAFE.right - SAFE.left) * 100}%`,
                            height: `${(SAFE.bottom - SAFE.top) * 100}%`,
                        }}
                    />
                    <div className="absolute inset-x-0 -bottom-px flex justify-center">
                        <span className="mb-3 rounded-md bg-black/80 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
                            Place visual elements within the safe zone
                        </span>
                    </div>
                </>
            )}

            {/* The caption selection box (drag target) with corner handles. */}
            <div
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={commit}
                onPointerCancel={commit}
                role="button"
                tabIndex={-1}
                title="Drag to reposition captions"
                className="group absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto cursor-move select-none touch-none"
                style={{
                    left: `${pos.x * 100}%`,
                    top: `${pos.y * 100}%`,
                    width: `${BOX_W * 100}%`,
                    height: `${BOX_H * 100}%`,
                }}
            >
                <div
                    className={`h-full w-full rounded-sm border transition-colors ${
                        dragging ? 'border-white' : 'border-white/0 group-hover:border-white/70'
                    }`}
                >
                    {['-top-1 -left-1', '-top-1 -right-1', '-bottom-1 -left-1', '-bottom-1 -right-1'].map((p) => (
                        <span
                            key={p}
                            className={`absolute ${p} h-2.5 w-2.5 rounded-full bg-white shadow transition-opacity ${
                                dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            }`}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
