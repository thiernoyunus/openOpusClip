import React, { forwardRef, useMemo } from 'react';
import { Player } from '@remotion/player';
import { ShortVideo } from '../../remotion/compositions/ShortVideo';
import TrackerOverlay from './TrackerOverlay';

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
            // Preview renders at half resolution (540x960) for performance —
            // the composition scales everything by compositionWidth/Height, so
            // it looks identical, just with 1/4 the pixels per frame. Export
            // stays at full 1080x1920 (set in EditorView.handleExport + the
            // render service).
            width: 540,
            height: 960,
            subtitles,
            hook: null,
            effects: null,
        }),
        [sourceUrl, framing, subtitles, durationInFrames]
    );

    return (
        <div className="relative h-full aspect-[9/16] rounded-xl overflow-hidden border border-edge bg-black shadow-2xl">
            {/* PREVIEW resolution is 540x960 (half of export's 1080x1920). The
                CSS width/height:100% scales it back up to fill the canvas, so it
                looks the same size but live-renders far fewer pixels per frame.
                Export resolution is unchanged — see EditorView.handleExport. */}
            <Player
                ref={playerRef}
                component={ShortVideo}
                inputProps={inputProps}
                durationInFrames={durationInFrames}
                fps={EDITOR_FPS}
                compositionWidth={540}
                compositionHeight={960}
                style={{ width: '100%', height: '100%' }}
                clickToPlay={false}
                spaceKeyToPlayOrPause={false}
            />
            {trackerOn && (
                <TrackerOverlay playerRef={playerRef} framing={framing} dispatch={dispatch} />
            )}
        </div>
    );
});

export default EditorCanvas;
