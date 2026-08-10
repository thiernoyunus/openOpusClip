import React, { forwardRef, useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { Player } from '@remotion/player';
import { ShortVideo } from '@remotion-src/compositions/ShortVideo';
import TrackerOverlay from './TrackerOverlay';
import PanelCropOverlay from './PanelCropOverlay';
import CaptionDragOverlay from './CaptionDragOverlay';
import SocialMediaPreview from './SocialMediaPreview';
import { getApiUrl } from '../../config';

export const EDITOR_FPS = 30;

// Framing stores portable RELATIVE /videos/... URLs for uploaded assets
// (overlays, audio, legacy music/broll). Same-origin dev serves them via the
// vite proxy, but with VITE_API_URL on a different origin the Player would
// request them from the dashboard host and 404 — absolutize for playback only
// (never persisted; the render-service does its own resolution for export).
const apiAssetUrl = (url) =>
    typeof url === 'string' && url.startsWith('/videos/') ? getApiUrl(url) : url;
const withPlayableUrls = (framing) => {
    if (!framing) return framing;
    const mapList = (list) =>
        Array.isArray(list) ? list.map((it) => (it && it.url ? { ...it, url: apiAssetUrl(it.url) } : it)) : list;
    return {
        ...framing,
        overlays: mapList(framing.overlays),
        audio: mapList(framing.audio),
        broll: mapList(framing.broll),
        music: framing.music?.url ? { ...framing.music, url: apiAssetUrl(framing.music.url) } : framing.music,
    };
};

/**
 * The preview canvas: a Remotion Player running the exact ShortVideo composition
 * the export uses, fed the live (possibly edited) framing config. The canvas box
 * is sized to the clip's aspect ratio (9:16 / 1:1 / 4:5 / 16:9) and contained
 * within the available area — we pick the binding dimension from the measured
 * area because CSS aspect-ratio + max-* breaks the ratio when the non-bound side
 * is capped.
 */
const EditorCanvas = forwardRef(function EditorCanvas(
    { sourceUrl, framing, subtitles = null, durationInFrames, trackerOn = false, captionScope = 'all', dispatch, platform = null },
    playerRef
) {
    // Output canvas = the clip's aspect ratio (defaults to 9:16 for older clips).
    const outW = framing?.outputWidth ?? 1080;
    const outH = framing?.outputHeight ?? 1920;
    const clipAspect = outW / outH;

    const wrapRef = useRef(null);
    const [avail, setAvail] = useState(null);
    // Editor-only view zoom: Cmd/Ctrl+scroll over the preview scales the whole
    // preview box bigger/smaller in the pane (like zooming an artboard). Purely
    // visual — it never touches the framing or the export, so it lives in local
    // state, not the framing config.
    const [viewZoom, setViewZoom] = useState(1);
    useEffect(() => {
        // Window + capture phase: the Remotion Player swallows wheel events in
        // its own subtree, so an element listener never sees them. Gate to the
        // pane bounds so plain scrolling and the timeline's own Cmd+scroll zoom
        // are untouched. Non-passive so preventDefault stops the browser zoom.
        const onWheel = (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            const el = wrapRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
            e.preventDefault();
            // Store the RAW zoom so slow ticks keep accumulating; the 100%
            // detent is applied only to the displayed transform below (snapping
            // the stored value would trap slow/trackpad scrolls at 100%).
            setViewZoom((z) => Math.min(4, Math.max(0.25, z * Math.exp(-e.deltaY * 0.0015))));
        };
        window.addEventListener('wheel', onWheel, { capture: true, passive: false });
        return () => window.removeEventListener('wheel', onWheel, { capture: true });
    }, []);
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
    const maxPreviewHeight = clipAspect < 1 ? 620 : 520;
    const maxPreviewWidth = clipAspect < 1 ? 420 : 840;
    const boxStyle = heightBound
        ? { height: `min(100%, ${maxPreviewHeight}px)`, width: 'auto', aspectRatio: `${outW} / ${outH}` }
        : { width: `min(100%, ${maxPreviewWidth}px)`, height: 'auto', aspectRatio: `${outW} / ${outH}` };

    // Snap the DISPLAYED zoom to 100% within a small band so it's easy to land
    // on normal — without snapping the stored value (which would trap slow scrolls).
    const shownZoom = Math.abs(viewZoom - 1) < 0.03 ? 1 : viewZoom;

    const inputProps = useMemo(
        () => ({
            videoUrl: '',
            sourceVideoUrl: sourceUrl,
            framing: withPlayableUrls(framing),
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
                style={{ ...boxStyle, transform: shownZoom !== 1 ? `scale(${shownZoom})` : undefined }}
            >
                <Player
                    // Remount when the canvas size changes so the composition
                    // doesn't keep the previous aspect's frame buffer.
                    key={`${outW}x${outH}`}
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
                {trackerOn ? (
                    <TrackerOverlay playerRef={playerRef} framing={framing} dispatch={dispatch} />
                ) : (
                    // Per-tile crop selection — mutually exclusive with the Tracker
                    // (only one full-canvas click layer at a time). No-op unless the
                    // active clip is a multi-panel 9:16 layout.
                    <PanelCropOverlay playerRef={playerRef} framing={framing} dispatch={dispatch} sourceUrl={sourceUrl} />
                )}
                {/* Drag-to-reposition handle for captions. Only the handle itself
                    captures pointer events, so it coexists with the tracker layer. */}
                {subtitles && (
                    <CaptionDragOverlay
                        subtitles={subtitles}
                        dispatch={dispatch}
                        framing={framing}
                        playerRef={playerRef}
                        scope={captionScope}
                        fps={EDITOR_FPS}
                    />
                )}
                {/* Social-media ghost layout. Renders platform chrome (TikTok /
                    YouTube Shorts / Instagram Reels) on top of the existing
                    video frame. The chrome is a sibling of the Player so it
                    tracks the constrained output frame exactly — never
                    resizes the video, never blocks tracker / panel clicks. */}
                <SocialMediaPreview platform={platform} />
            </div>
        </div>
    );
});

export default EditorCanvas;
