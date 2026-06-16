import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio, Video } from "@remotion/media";
import type {
  CropRect,
  CameraKeyframe,
  FaceTrack,
  FramingConfig,
  FramingSegment,
} from "../lib/types";
import { placedRanges, type PlacedRange } from "../lib/edl";

/**
 * Non-destructive reframing: renders a 9:16 (or any) canvas from the ORIGINAL
 * 16:9 source clip plus a FramingConfig (face tracks + per-segment layout +
 * crop keyframes). This is the data produced by main.py's framing recorder and
 * edited by the web editor — preview (Player) and export (render-service) run
 * this exact component, so what you see is what you get.
 *
 * Coordinate conventions (see docs/video-editor-plan.md §2):
 * - crops/face boxes are normalized 0-1 relative to the source frame
 * - frame numbers inside FramingConfig are in SOURCE fps; the composition may
 *   run at a different fps, so we convert via sourceFrame()
 */

// --- pure helpers (deterministic per frame: required for server rendering) ---

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Linear interpolation between sampled keyframes, clamped at both ends. */
export const interpolateCrop = (
  keyframes: CameraKeyframe[],
  frame: number
): CropRect | null => {
  if (keyframes.length === 0) return null;
  if (frame <= keyframes[0].frame) return keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (frame >= last.frame) return last;
  // keyframes are sorted by frame; find the surrounding pair
  for (let i = 1; i < keyframes.length; i++) {
    if (keyframes[i].frame >= frame) {
      const a = keyframes[i - 1];
      const b = keyframes[i];
      const t = b.frame === a.frame ? 0 : (frame - a.frame) / (b.frame - a.frame);
      return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        w: lerp(a.w, b.w, t),
        h: lerp(a.h, b.h, t),
      };
    }
  }
  return last;
};

/**
 * Smoothed face rect at a frame: average of samples in a ±12 source-frame
 * window (kills detection jitter). Falls back to the nearest sample within
 * 45 frames so brief detection gaps don't drop the panel.
 */
export const smoothedFaceRect = (
  track: FaceTrack | undefined,
  frame: number
): CropRect | null => {
  if (!track || track.samples.length === 0) return null;
  const windowed = track.samples.filter(
    (s) => Math.abs(s.frame - frame) <= 12
  );
  if (windowed.length > 0) {
    const n = windowed.length;
    return {
      x: windowed.reduce((acc, s) => acc + s.x, 0) / n,
      y: windowed.reduce((acc, s) => acc + s.y, 0) / n,
      w: windowed.reduce((acc, s) => acc + s.w, 0) / n,
      h: windowed.reduce((acc, s) => acc + s.h, 0) / n,
    };
  }
  let nearest = track.samples[0];
  let nearestDist = Math.abs(nearest.frame - frame);
  for (const s of track.samples) {
    const d = Math.abs(s.frame - frame);
    if (d < nearestDist) {
      nearest = s;
      nearestDist = d;
    }
  }
  return nearestDist <= 45 ? nearest : null;
};

/**
 * Build a crop window (normalized) around a face for a panel of the given
 * pixel aspect ratio. The face fills ~35% of the panel height, with headroom:
 * face center sits at 42% from the crop top.
 */
export const cropForFace = (
  face: CropRect,
  panelAspect: number, // panel width / height in px
  srcW: number,
  srcH: number
): CropRect => {
  const faceHpx = face.h * srcH;
  let cropHpx = clamp(faceHpx / 0.35, srcH * 0.3, srcH);
  let cropWpx = cropHpx * panelAspect;
  if (cropWpx > srcW) {
    cropWpx = srcW;
    cropHpx = cropWpx / panelAspect;
  }
  const centerXpx = (face.x + face.w / 2) * srcW;
  const faceCenterYpx = (face.y + face.h / 2) * srcH;
  let topPx = faceCenterYpx - cropHpx * 0.42;
  let leftPx = centerXpx - cropWpx / 2;
  leftPx = clamp(leftPx, 0, srcW - cropWpx);
  topPx = clamp(topPx, 0, srcH - cropHpx);
  return {
    x: leftPx / srcW,
    y: topPx / srcH,
    w: cropWpx / srcW,
    h: cropHpx / srcH,
  };
};

/** Center crop matching the panel aspect — fallback when nothing is tracked. */
export const centerCrop = (
  panelAspect: number,
  srcW: number,
  srcH: number
): CropRect => {
  let cropHpx = srcH;
  let cropWpx = cropHpx * panelAspect;
  if (cropWpx > srcW) {
    cropWpx = srcW;
    cropHpx = cropWpx / panelAspect;
  }
  return {
    x: (srcW - cropWpx) / 2 / srcW,
    y: (srcH - cropHpx) / 2 / srcH,
    w: cropWpx / srcW,
    h: cropHpx / srcH,
  };
};

interface PanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Screen/gameplay capture panel: show the whole frame (contain), not a face crop. */
  content?: boolean;
}

/** Panel grid per layout for a canvas of width x height px. */
export const panelsForLayout = (
  layout: FramingSegment["layout"],
  width: number,
  height: number
): PanelRect[] => {
  switch (layout) {
    case "split":
      return [
        { left: 0, top: 0, width, height: height / 2 },
        { left: 0, top: height / 2, width, height: height / 2 },
      ];
    case "three":
      return [
        { left: 0, top: 0, width, height: height / 3 },
        { left: 0, top: height / 3, width, height: height / 3 },
        { left: 0, top: (2 * height) / 3, width, height: height / 3 },
      ];
    case "four":
      return [
        { left: 0, top: 0, width: width / 2, height: height / 2 },
        { left: width / 2, top: 0, width: width / 2, height: height / 2 },
        { left: 0, top: height / 2, width: width / 2, height: height / 2 },
        { left: width / 2, top: height / 2, width: width / 2, height: height / 2 },
      ];
    case "screenshare":
      // screen capture on top 60%, speaker bottom 40%
      return [
        { left: 0, top: 0, width, height: height * 0.6, content: true },
        { left: 0, top: height * 0.6, width, height: height * 0.4 },
      ];
    case "gameplay":
      // speaker top 30%, gameplay bottom 70%
      return [
        { left: 0, top: 0, width, height: height * 0.3 },
        { left: 0, top: height * 0.3, width, height: height * 0.7, content: true },
      ];
    default:
      return [{ left: 0, top: 0, width, height }];
  }
};

// --- rendering ---------------------------------------------------------------

/** Inner <Video> style that scales+offsets a crop region to cover a panel. */
const cropInner = (
  crop: CropRect,
  panel: PanelRect,
  srcW: number,
  srcH: number
): React.CSSProperties => {
  // Scale the source so the crop region covers the panel, then offset so the
  // crop region is centered in the panel. GPU-cheap (transform only).
  const scale = Math.max(
    panel.width / (crop.w * srcW),
    panel.height / (crop.h * srcH)
  );
  return {
    left: -(crop.x * srcW * scale) + (panel.width - crop.w * srcW * scale) / 2,
    top: -(crop.y * srcH * scale) + (panel.height - crop.h * srcH * scale) / 2,
    width: srcW * scale,
    height: srcH * scale,
  };
};

/** Inner <Video> style fitting the whole source frame inside a panel (contain). */
const containInner = (
  panel: PanelRect,
  srcW: number,
  srcH: number
): React.CSSProperties => {
  const scale = Math.min(panel.width / srcW, panel.height / srcH);
  const videoW = srcW * scale;
  const videoH = srcH * scale;
  return {
    left: (panel.width - videoW) / 2,
    top: (panel.height - videoH) / 2,
    width: videoW,
    height: videoH,
  };
};

interface Layer {
  /**
   * Stable across layouts: the main speaker crop is always "crop-0", so
   * switching fill↔split↔fit↔… keeps the SAME <Video> element mounted instead
   * of remounting it. A freshly mounted @remotion/media Video paints black
   * until it decodes the current frame, which is exactly the black flash seen
   * in the Player on every layout change. (Export/SSR is unaffected — it
   * decodes each frame on demand regardless of mount churn.)
   */
  key: string;
  wrap: React.CSSProperties; // positioned, overflow-hidden panel box
  inner: React.CSSProperties; // the <Video> position/size/transform/filter
}

/**
 * One video layer: an overflow-hidden panel box with a single muted <Video>.
 * All layers are muted — audio is played by a single stable <Audio> in
 * RangeContent so layout switches (which mount/unmount panels) never disturb it.
 */
const VideoLayer: React.FC<{
  src: string;
  layer: Layer;
  trimBefore: number;
}> = ({ src, layer, trimBefore }) => (
  <div
    style={{
      position: "absolute",
      overflow: "hidden",
      backgroundColor: "#000",
      ...layer.wrap,
    }}
  >
    <Video
      src={src}
      muted
      trimBefore={trimBefore}
      style={{
        position: "absolute",
        maxWidth: "none",
        maxHeight: "none",
        ...layer.inner,
      }}
    />
  </div>
);

/**
 * Build the ordered video layers for a segment at a given source frame. Every
 * layout produces a list of {@link Layer}s with stable keys so the Player can
 * reuse video elements across layout switches (see Layer.key).
 */
const buildLayers = (
  segment: FramingSegment | null,
  sourceFrame: number,
  width: number,
  height: number,
  faceTracks: FaceTrack[],
  source: FramingConfig["source"]
): Layer[] => {
  const full: PanelRect = { left: 0, top: 0, width, height };
  const fullWrap = { left: 0, top: 0, width, height };

  // Manual crop wins over everything (when a segment is selected).
  if (segment?.manualCrop) {
    return [
      {
        key: "crop-0",
        wrap: fullWrap,
        inner: cropInner(segment.manualCrop, full, source.width, source.height),
      },
    ];
  }

  // No segment (gap) or explicit "fit": full-width sharp over a blurred cover.
  if (!segment || segment.layout === "fit") {
    const fgHeight = width * (source.height / source.width);
    return [
      {
        key: "fit-bg",
        wrap: fullWrap,
        inner: {
          left: "50%",
          top: "50%",
          height,
          width: height * (source.width / source.height),
          transform: "translate(-50%, -50%) scale(1.15)",
          filter: "blur(40px) brightness(0.7)",
        },
      },
      // Shares "crop-0" so it reuses the same <Video> across fit↔crop layouts.
      {
        key: "crop-0",
        wrap: fullWrap,
        inner: { left: 0, top: (height - fgHeight) / 2, width, height: fgHeight },
      },
    ];
  }

  if (segment.layout === "fill") {
    const crop =
      interpolateCrop(segment.cameraKeyframes, sourceFrame) ??
      centerCrop(width / height, source.width, source.height);
    return [
      {
        key: "crop-0",
        wrap: fullWrap,
        inner: cropInner(crop, full, source.width, source.height),
      },
    ];
  }

  // Multi-panel layouts: split / three / four / screenshare / gameplay.
  // Content panels (screen/gameplay capture) show the whole frame. Keys are
  // namespaced by role so the speaker crop is "crop-0" in every layout and
  // survives the switch.
  const panels = panelsForLayout(segment.layout, width, height);
  let cropIdx = 0;
  let contentIdx = 0;
  return panels.map((panel, panelIndex) => {
    const wrap = {
      left: panel.left,
      top: panel.top,
      width: panel.width,
      height: panel.height,
    };
    if (panel.content) {
      return {
        key: `content-${contentIdx++}`,
        wrap,
        inner: containInner(panel, source.width, source.height),
      };
    }
    const trackId = segment.trackedFaceIds[panelIndex];
    const track = faceTracks.find((t) => t.id === trackId);
    const face = smoothedFaceRect(track, sourceFrame);
    const panelAspect = panel.width / panel.height;
    const crop = face
      ? cropForFace(face, panelAspect, source.width, source.height)
      : centerCrop(panelAspect, source.width, source.height);
    return {
      key: `crop-${cropIdx++}`,
      wrap,
      inner: cropInner(crop, panel, source.width, source.height),
    };
  });
};

/**
 * The framing renderer for one kept EDL range. Runs inside a <Sequence>, so
 * useCurrentFrame() is range-relative; source position = range start + offset.
 * All Videos get trimBefore so the media engine plays the right source region.
 */
const RangeContent: React.FC<{
  src: string;
  framing: FramingConfig;
  range: PlacedRange;
  originalVolume: number;
}> = ({ src, framing, range, originalVolume }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { source, segments, faceTracks } = framing;

  const sourceFrame = Math.min(
    range.startFrame + Math.round(frame * (source.fps / fps)),
    range.endFrame - 1
  );
  const trimBefore = Math.round((range.startFrame / source.fps) * fps);

  const segment =
    segments.find(
      (s) => sourceFrame >= s.startFrame && sourceFrame < s.endFrame
    ) ??
    segments[segments.length - 1] ??
    null;

  const layers = buildLayers(
    segment,
    sourceFrame,
    width,
    height,
    faceTracks,
    source
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {layers.map((layer) => (
        <VideoLayer
          key={layer.key}
          src={src}
          layer={layer}
          trimBefore={trimBefore}
        />
      ))}
      {/* Source audio: ONE stable element for the whole range, decoupled from
          the layout. Every video layer above is muted, so switching layouts —
          which mounts/unmounts video panels — can never re-seek or replay the
          audio (the cause of the "repeated last word" on layout change). */}
      <Audio src={src} trimBefore={trimBefore} volume={originalVolume} />
    </AbsoluteFill>
  );
};

export const ReframedVideo: React.FC<{
  src: string;
  framing: FramingConfig;
}> = ({ src, framing }) => {
  const { fps } = useVideoConfig();
  const ranges = placedRanges(framing, fps);
  const originalVolume = framing.music ? framing.music.originalVolume : 1;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {ranges.map((range) => (
        <Sequence
          key={`${range.startFrame}-${range.outStart}`}
          from={range.outStart}
          durationInFrames={range.outDuration}
          premountFor={30}
        >
          <RangeContent
            src={src}
            framing={framing}
            range={range}
            originalVolume={originalVolume}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
