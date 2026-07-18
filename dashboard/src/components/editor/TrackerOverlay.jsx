import React, { useEffect, useState } from 'react';
import { EDITOR_FPS } from './EditorCanvas';
import { buildFillKeyframes } from './useEditorState';
import { outputToSource, clipAtOutputFrame } from '@remotion-src/lib/edl';
import {
    canvasToSource,
    sourceToCanvas,
    facesAtSourceFrame,
    nearestFace,
} from './trackerMapping';

/**
 * Opus "Tracker" parity: while enabled, detected people show as markers on
 * the canvas; clicking one makes the active segment follow that person —
 * multi-panel layouts reassign the clicked panel, everything else becomes a
 * tracked fill. Sits absolutely over the Player inside EditorCanvas.
 */
export default function TrackerOverlay({ playerRef, framing, dispatch }) {
    const [outFrame, setOutFrame] = useState(0);

    useEffect(() => {
        const p = playerRef.current;
        if (!p) return;
        // The overlay can mount after the user already seeked — sync first
        setOutFrame(p.getCurrentFrame());
        const onFrame = (e) => setOutFrame(e.detail.frame);
        p.addEventListener('frameupdate', onFrame);
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [playerRef]);

    // Resolve the active clip from the OUTPUT playhead (unambiguous under
    // reorder/duplication), then map to a source frame for face sampling.
    const segment = clipAtOutputFrame(framing, outFrame, EDITOR_FPS)?.clip ?? null;
    const srcFrame = outputToSource(framing, outFrame, EDITOR_FPS);
    const faces = facesAtSourceFrame(framing, srcFrame);

    const markers = segment
        ? faces
              .map((f) => {
                  const pos = sourceToCanvas(framing, segment, srcFrame, f.center);
                  return pos ? { id: f.id, pos } : null;
              })
              .filter(Boolean)
        : [];

    // Plain function on purpose: this component re-renders every player frame,
    // so memoizing the handler buys nothing
    const handleClick = (e) => {
        if (!segment) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pt = {
            x: (e.clientX - rect.left) / rect.width,
            y: (e.clientY - rect.top) / rect.height,
        };
        const hit = canvasToSource(framing, segment, srcFrame, pt);
        if (!hit) return;
        const face = nearestFace(faces, hit.src);
        if (!face) return;
        dispatch({
            type: 'TRACK_PERSON',
            clipId: segment.id,
            panelIdx: hit.panelIdx,
            trackId: face.id,
            cameraKeyframes: buildFillKeyframes(framing, segment, face.id),
        });
    };

    return (
        <div
            onClick={handleClick}
            className="absolute inset-0 z-10 cursor-crosshair"
            data-tracker-overlay
        >
            {markers.map((m) => (
                <div
                    key={m.id}
                    className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                    style={{ left: `${m.pos.x * 100}%`, top: `${m.pos.y * 100}%` }}
                >
                    <div className="w-9 h-9 rounded-full border-2 border-viral bg-viral/15" />
                </div>
            ))}
        </div>
    );
}
