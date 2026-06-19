import React, { forwardRef, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { Player } from '@remotion/player';
import { ShortVideo } from '@remotion-src/compositions/ShortVideo';
import TrackerOverlay from './TrackerOverlay';
import CaptionDragOverlay from './CaptionDragOverlay';

export const EDITOR_FPS = 30;

/**
 * The preview canvas: a Remotion Player running the exact ShortVideo composition
 * the export uses, fed the live (possibly edited) framing config. The canvas box
 * is sized to the clip's aspect ratio (9:16 / 1:1 / 4:5 / 16:9) and contained
 * within the available area — we pick the binding dimension from the measured
 * area because CSS aspect-ratio + max-* breaks the ratio when the non-bound side
 * is capped.
 */
const EditorCanvas = forwardRef(function EditorCanvas(
    { sourceUrl, framing, subtitles = null, durationInFrames, trackerOn = false, dispatch },
    playerRef
) {
    // Output canvas = the clip's aspect ratio (defaults to 9:16 for older clips).
    const outW = framing?.outputWidth ?? 1080;
    const outH = framing?.outputHeight ?? 1920;
    const clipAspect = outW / outH;

    const wrapRef = useRef(null);
    const [avail, setAvail] = useState(null);
    useLayoutEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const update = () => setAvail((prev) => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            return prev && prev.w === w && prev.h === h ? prev : { w, h };
        });
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Height-bound when the area is wider than the clip (clip is relatively
    // taller). Before the first measure, fall back to the clip's orientation.
    const heightBound = avail ? avail.w / avail.h > clipAspect : clipAspect < 1;
    const boxStyle = heightBound
        ? { height: '100%', width: 'auto', aspectRatio: `${outW} / ${outH}` }
        : { width: '100%', height: 'auto', aspectRatio: `${outW} / ${outH}` };

    const inputProps = useMemo(
        () => ({
            videoUrl: '',
            sourceVideoUrl: sourceUrl,
            framing,
            durationInFrames,
            fps: EDITOR_FPS,
            // Preview renders at the full export resolution so it's true WYSIWYG.
            // Pixel-sized overlay styles (caption fontSize/stroke/radii, TextOverlay
            // px) depend on the composition size matching export.
            width: outW,
            height: outH,
            subtitles,
            hook: null,
            effects: null,
        }),
        [sourceUrl, framing, subtitles, durationInFrames, outW, outH]
    );

    return (
        <div ref={wrapRef} className="w-full h-full flex items-center justify-center">
            <div
                className="relative max-w-full max-h-full rounded-xl overflow-hidden border border-edge bg-black shadow-2xl"
                style={boxStyle}
            >
                <Player
                    ref={playerRef}
                    component={ShortVideo}
                    inputProps={inputProps}
                    durationInFrames={durationInFrames}
                    fps={EDITOR_FPS}
                    compositionWidth={outW}
                    compositionHeight={outH}
                    style={{ width: '100%', height: '100%' }}
                    clickToPlay={false}
                    spaceKeyToPlayOrPause={false}
                />
                {trackerOn && (
                    <TrackerOverlay playerRef={playerRef} framing={framing} dispatch={dispatch} />
                )}
                {/* Drag-to-reposition handle for captions. Only the handle itself
                    captures pointer events, so it coexists with the tracker layer. */}
                {subtitles && (
                    <CaptionDragOverlay subtitles={subtitles} dispatch={dispatch} />
                )}
            </div>
        </div>
    );
});

export default EditorCanvas;
