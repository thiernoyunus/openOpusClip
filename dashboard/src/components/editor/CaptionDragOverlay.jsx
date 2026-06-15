import React, { useRef, useState } from 'react';

/**
 * Opus-style "drag captions to reposition" layer. Sits absolutely over the
 * Remotion Player inside EditorCanvas. A small handle marks where the caption
 * block sits; dragging it sets a free-form normalized center (x, y) on the
 * subtitle config, overriding the top/middle/bottom preset.
 *
 * Coordinate mapping mirrors TrackerOverlay: pointer client coords are turned
 * into 0..1 fractions of the player's bounding rect, then clamped. On release
 * we dispatch SET_SUBTITLES with x/y at the subtitle-config top level (matching
 * subtitleConfigSchema). Selecting a preset elsewhere clears x/y again.
 *
 * Only the handle captures pointer events, so the rest of the canvas (and the
 * Tracker overlay, when both are mounted) stays interactive.
 */

const clamp01 = (n) => Math.min(1, Math.max(0, n));

// Approximate caption-block center for each preset, used only to seat the
// handle before the user has dragged. Once x/y exist they win exactly.
const PRESET_CENTER = {
    top: { x: 0.5, y: 0.18 },
    middle: { x: 0.5, y: 0.5 },
    bottom: { x: 0.5, y: 0.85 },
};

export default function CaptionDragOverlay({ subtitles, dispatch }) {
    const layerRef = useRef(null);
    // Live position during a drag (null when idle → use committed x/y / preset).
    const [dragPos, setDragPos] = useState(null);

    if (!subtitles) return null;

    const committed =
        typeof subtitles.x === 'number' && typeof subtitles.y === 'number'
            ? { x: subtitles.x, y: subtitles.y }
            : PRESET_CENTER[subtitles.position] ?? PRESET_CENTER.bottom;

    const pos = dragPos ?? committed;

    const pointFromEvent = (e) => {
        const rect = layerRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return null;
        return {
            x: clamp01((e.clientX - rect.left) / rect.width),
            y: clamp01((e.clientY - rect.top) / rect.height),
        };
    };

    const handlePointerDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const pt = pointFromEvent(e);
        if (pt) setDragPos(pt);
    };

    const handlePointerMove = (e) => {
        if (dragPos === null) return;
        const pt = pointFromEvent(e);
        if (pt) setDragPos(pt);
    };

    const commit = (e) => {
        if (dragPos === null) return;
        const pt = pointFromEvent(e) ?? dragPos;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        setDragPos(null);
        dispatch({
            type: 'SET_SUBTITLES',
            subtitles: {
                ...subtitles,
                style: { ...subtitles.style },
                x: Number(pt.x.toFixed(4)),
                y: Number(pt.y.toFixed(4)),
            },
        });
    };

    const dragging = dragPos !== null;

    return (
        // Full-size layer is pointer-events-none so it never blocks the canvas;
        // only the handle below opts back in.
        <div ref={layerRef} className="absolute inset-0 z-20 pointer-events-none" data-caption-drag-overlay>
            <div
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={commit}
                onPointerCancel={commit}
                role="button"
                tabIndex={-1}
                title="Drag to reposition captions"
                className={`absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto cursor-move select-none touch-none rounded-md border-2 px-3 py-2 transition-colors ${
                    dragging
                        ? 'border-viral bg-viral/15'
                        : 'border-dashed border-viral/70 bg-viral/5 hover:bg-viral/15'
                }`}
                style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }}
            >
                <span className="block text-[10px] font-semibold leading-none text-viral whitespace-nowrap">
                    Captions
                </span>
            </div>
        </div>
    );
}
