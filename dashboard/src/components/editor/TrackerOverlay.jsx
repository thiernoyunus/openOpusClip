import React, { useEffect, useState } from 'react';
import { EDITOR_FPS } from './EditorCanvas';
import { buildFillKeyframes } from './useEditorState';
import { outputToSource } from '../../remotion/lib/edl';
import {
    segmentAtSourceFrame,
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
    const [srcFrame, setSrcFrame] = useState(0);

    useEffect(() => {
        const p = playerRef.current;
        if (!p) return;
        // Output frame -> source frame goes through the EDL (cuts/trim aware)
        const toSrcFrame = (outFrame) => outputToSource(framing, outFrame, EDITOR_FPS);
        // The overlay can mount after the user already seeked — sync first
        setSrcFrame(toSrcFrame(p.getCurrentFrame()));
        const onFrame = (e) => setSrcFrame(toSrcFrame(e.detail.frame));
        p.addEventListener('frameupdate', onFrame);
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [playerRef, framing]);

    const segment = segmentAtSourceFrame(framing, srcFrame);
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
            segmentId: segment.id,
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
