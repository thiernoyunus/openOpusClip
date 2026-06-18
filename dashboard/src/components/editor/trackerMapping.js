import {
    interpolateCrop,
    smoothedFaceRect,
    cropForFace,
    centerCrop,
    panelsForLayout,
} from '../../remotion/compositions/ReframedVideo';

/** Output canvas dimensions for a clip (defaults to 9:16 for older clips). */
function canvasDims(framing) {
    return { w: framing.outputWidth ?? 1080, h: framing.outputHeight ?? 1920 };
}

/**
 * Geometry shared by the Tracker overlay: maps points between canvas space
 * (0..1 over the output composition) and source space (0..1 over the 16:9
 * original), through whatever layout the active segment uses.
 *
 * Every crop the composition renders is constructed with the exact pixel
 * aspect of its panel (cropForFace/centerCrop/cameraman keyframes/manual
 * crops are all aspect-locked), so the mapping is linear — no cover-scale
 * letterboxing to account for.
 */

export function segmentAtSourceFrame(framing, srcFrame) {
    return (
        framing.segments.find((s) => srcFrame >= s.startFrame && srcFrame < s.endFrame) ??
        framing.segments[framing.segments.length - 1] ??
        null
    );
}

/** Normalized panel rects + their pixel aspect for a layout. */
function panelGeometry(layout, framing) {
    const { w, h } = canvasDims(framing);
    return panelsForLayout(layout, 1, 1).map((p) => ({
        ...p,
        aspectPx: (p.width * w) / (p.height * h),
    }));
}

function cropForPanel(framing, segment, panelIdx, panel, srcFrame) {
    const { width: srcW, height: srcH } = framing.source;
    const trackId = segment.trackedFaceIds?.[panelIdx];
    const track = framing.faceTracks.find((t) => t.id === trackId);
    const face = smoothedFaceRect(track, srcFrame);
    return face
        ? cropForFace(face, panel.aspectPx, srcW, srcH)
        : centerCrop(panel.aspectPx, srcW, srcH);
}

function fillCrop(framing, segment, srcFrame) {
    return (
        segment.manualCrop ||
        interpolateCrop(segment.cameraKeyframes, srcFrame) ||
        centerCrop(canvasDims(framing).w / canvasDims(framing).h, framing.source.width, framing.source.height)
    );
}

/** Vertical extent of the sharp foreground in a fit layout (canvas units). */
function fitForeground(framing) {
    const { width: srcW, height: srcH } = framing.source;
    const { w, h } = canvasDims(framing);
    const fgH = (w * (srcH / srcW)) / h;
    return { top: (1 - fgH) / 2, height: fgH };
}

/**
 * Canvas point (0..1) → { src: {x, y} in source space, panelIdx }.
 * Returns null when the point doesn't hit visible source content.
 */
export function canvasToSource(framing, segment, srcFrame, pt) {
    const layout = segment.manualCrop ? 'fill' : segment.layout;

    if (layout === 'fill') {
        const crop = fillCrop(framing, segment, srcFrame);
        return {
            panelIdx: 0,
            src: { x: crop.x + pt.x * crop.w, y: crop.y + pt.y * crop.h },
        };
    }

    if (layout === 'fit') {
        const fg = fitForeground(framing);
        const sy = (pt.y - fg.top) / fg.height;
        if (sy < 0 || sy > 1) return null;
        return { panelIdx: 0, src: { x: pt.x, y: sy } };
    }

    const panels = panelGeometry(layout, framing);
    for (let i = 0; i < panels.length; i++) {
        const p = panels[i];
        if (pt.x < p.left || pt.x > p.left + p.width) continue;
        if (pt.y < p.top || pt.y > p.top + p.height) continue;
        const lx = (pt.x - p.left) / p.width;
        const ly = (pt.y - p.top) / p.height;
        const crop = cropForPanel(framing, segment, i, p, srcFrame);
        return {
            panelIdx: i,
            src: { x: crop.x + lx * crop.w, y: crop.y + ly * crop.h },
        };
    }
    return null;
}

/** Source point (0..1) → canvas point (0..1), or null if not visible. */
export function sourceToCanvas(framing, segment, srcFrame, src) {
    const layout = segment.manualCrop ? 'fill' : segment.layout;

    const within = (v) => v >= 0 && v <= 1;

    if (layout === 'fill') {
        const crop = fillCrop(framing, segment, srcFrame);
        const x = (src.x - crop.x) / crop.w;
        const y = (src.y - crop.y) / crop.h;
        return within(x) && within(y) ? { x, y } : null;
    }

    if (layout === 'fit') {
        const fg = fitForeground(framing);
        return { x: src.x, y: fg.top + src.y * fg.height };
    }

    const panels = panelGeometry(layout, framing);
    for (let i = 0; i < panels.length; i++) {
        const p = panels[i];
        const crop = cropForPanel(framing, segment, i, p, srcFrame);
        const lx = (src.x - crop.x) / crop.w;
        const ly = (src.y - crop.y) / crop.h;
        if (within(lx) && within(ly)) {
            return { x: p.left + lx * p.width, y: p.top + ly * p.height };
        }
    }
    return null;
}

/**
 * Face tracks visible near a source frame, with their current source-space
 * center. Used both to render markers and to resolve a tracker click.
 */
export function facesAtSourceFrame(framing, srcFrame) {
    return framing.faceTracks
        .map((t) => {
            const rect = smoothedFaceRect(t, srcFrame);
            if (!rect) return null;
            return {
                id: t.id,
                center: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
                rect,
            };
        })
        .filter(Boolean);
}

/** Nearest face track to a source-space point (within maxDist), or null. */
export function nearestFace(faces, srcPt, maxDist = 0.2) {
    let best = null;
    let bestDist = maxDist;
    for (const f of faces) {
        const d = Math.hypot(f.center.x - srcPt.x, f.center.y - srcPt.y);
        if (d < bestDist) {
            bestDist = d;
            best = f;
        }
    }
    return best;
}
