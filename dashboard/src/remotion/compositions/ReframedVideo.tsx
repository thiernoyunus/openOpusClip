import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
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
    default:
      return [{ left: 0, top: 0, width, height }];
  }
};

// --- rendering ---

const CroppedVideo: React.FC<{
  src: string;
  crop: CropRect;
  panel: PanelRect;
  srcW: number;
  srcH: number;
  muted: boolean;
  trimBefore: number;
  volume?: number;
}> = ({ src, crop, panel, srcW, srcH, muted, trimBefore, volume = 1 }) => {
  // Scale the source so the crop region covers the panel, then offset so the
  // crop region is centered in the panel. GPU-cheap (transform only).
  const scale = Math.max(
    panel.width / (crop.w * srcW),
    panel.height / (crop.h * srcH)
  );
  const videoW = srcW * scale;
  const videoH = srcH * scale;
  const offsetX = -(crop.x * srcW * scale) + (panel.width - crop.w * srcW * scale) / 2;
  const offsetY = -(crop.y * srcH * scale) + (panel.height - crop.h * srcH * scale) / 2;

  return (
    <div
      style={{
        position: "absolute",
        left: panel.left,
        top: panel.top,
        width: panel.width,
        height: panel.height,
        overflow: "hidden",
        backgroundColor: "#000",
      }}
    >
      <Video
        src={src}
        muted={muted}
        volume={volume}
        trimBefore={trimBefore}
        style={{
          position: "absolute",
          left: offsetX,
          top: offsetY,
          width: videoW,
          height: videoH,
          maxWidth: "none",
          maxHeight: "none",
        }}
      />
    </div>
  );
};

const FitFrame: React.FC<{
  src: string;
  width: number;
  height: number;
  srcW: number;
  srcH: number;
  trimBefore: number;
  volume?: number;
}> = ({ src, width, height, srcW, srcH, trimBefore, volume = 1 }) => {
  const fgHeight = width * (srcH / srcW);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* blurred background, scaled to fill */}
      <Video
        src={src}
        muted
        trimBefore={trimBefore}
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          height,
          width: height * (srcW / srcH),
          maxWidth: "none",
          transform: "translate(-50%, -50%) scale(1.15)",
          filter: "blur(40px) brightness(0.7)",
        }}
      />
      {/* sharp full-width foreground, vertically centered */}
      <Video
        src={src}
        volume={volume}
        trimBefore={trimBefore}
        style={{
          position: "absolute",
          left: 0,
          top: (height - fgHeight) / 2,
          width,
          height: fgHeight,
          maxWidth: "none",
        }}
      />
    </AbsoluteFill>
  );
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

  if (!segment) {
    return (
      <FitFrame src={src} width={width} height={height} srcW={source.width} srcH={source.height} trimBefore={trimBefore} volume={originalVolume} />
    );
  }

  // Manual crop always wins, regardless of layout
  if (segment.manualCrop) {
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        <CroppedVideo
          src={src}
          crop={segment.manualCrop}
          panel={{ left: 0, top: 0, width, height }}
          srcW={source.width}
          srcH={source.height}
          muted={false}
          trimBefore={trimBefore}
          volume={originalVolume}
        />
      </AbsoluteFill>
    );
  }

  if (segment.layout === "fit") {
    return (
      <FitFrame src={src} width={width} height={height} srcW={source.width} srcH={source.height} trimBefore={trimBefore} volume={originalVolume} />
    );
  }

  if (segment.layout === "fill") {
    const crop =
      interpolateCrop(segment.cameraKeyframes, sourceFrame) ??
      centerCrop(width / height, source.width, source.height);
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        <CroppedVideo
          src={src}
          crop={crop}
          panel={{ left: 0, top: 0, width, height }}
          srcW={source.width}
          srcH={source.height}
          muted={false}
          trimBefore={trimBefore}
          volume={originalVolume}
        />
      </AbsoluteFill>
    );
  }

  // Multi-panel layouts: split / three / four / screenshare / gameplay
  const panels = panelsForLayout(segment.layout, width, height);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {panels.map((panel, i) => {
        const trackId = segment.trackedFaceIds[i];
        const track = faceTracks.find((t) => t.id === trackId);
        const face = smoothedFaceRect(track, sourceFrame);
        const panelAspect = panel.width / panel.height;
        const crop = face
          ? cropForFace(face, panelAspect, source.width, source.height)
          : centerCrop(panelAspect, source.width, source.height);
        return (
          <CroppedVideo
            key={i}
            src={src}
            crop={crop}
            panel={panel}
            srcW={source.width}
            srcH={source.height}
            muted={i !== 0} // only the first panel carries audio
            trimBefore={trimBefore}
            volume={originalVolume}
          />
        );
      })}
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
