import React, { forwardRef, useMemo } from 'react';
import { Player } from '@remotion/player';
import { ShortVideo } from '../../remotion/compositions/ShortVideo';
import TrackerOverlay from './TrackerOverlay';
import CaptionDragOverlay from './CaptionDragOverlay';

export const EDITOR_FPS = 30;

/**
 * The 9:16 preview canvas: a Remotion Player running the exact ShortVideo
 * composition the export uses, fed the live (possibly edited) framing config.
 */
const EditorCanvas = forwardRef(function EditorCanvas(
    { sourceUrl, framing, subtitles = null, durationInFrames, trackerOn = false, dispatch },
    playerRef
) {
    const inputProps = useMemo(
        () => ({
            videoUrl: '',
            sourceVideoUrl: sourceUrl,
            framing,
            durationInFrames,
            fps: EDITOR_FPS,
            // Preview renders at full 1080x1920 — the same resolution as export
            // (EditorView.handleExport + the render service). The Player
            // rasterizes at display size regardless of compositionWidth/Height,
            // so a half-res composition saved nothing and only broke WYSIWYG:
            // pixel-sized overlay styles (caption fontSize/stroke/radii,
            // TextOverlay px sizes) occupied twice their relative space.
            width: 1080,
            height: 1920,
            subtitles,
            hook: null,
            effects: null,
        }),
        [sourceUrl, framing, subtitles, durationInFrames]
    );

    return (
        <div className="relative h-full aspect-[9/16] rounded-xl overflow-hidden border border-edge bg-black shadow-2xl">
            {/* PREVIEW renders at the full 1080x1920 export resolution so the
                preview is true WYSIWYG. The CSS width/height:100% scales it to
                fill the canvas. Export resolution matches — see
                EditorView.handleExport. */}
            <Player
                ref={playerRef}
                component={ShortVideo}
                inputProps={inputProps}
                durationInFrames={durationInFrames}
                fps={EDITOR_FPS}
                compositionWidth={1080}
                compositionHeight={1920}
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
    );
});

export default EditorCanvas;
