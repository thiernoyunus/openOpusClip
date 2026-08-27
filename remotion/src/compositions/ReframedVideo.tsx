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

// Pure crop math lives in lib/reframe.ts (no React/remotion imports) so it can
// be self-checked with plain node. Re-exported here: the dashboard editor
// imports these from this module.
export {
  interpolateCrop,
  smoothedFaceRect,
  cropForFace,
  centerCrop,
} from "../lib/reframe";
import {
  interpolateCrop,
  smoothedFaceRect,
  cropForFace,
  centerCrop,
} from "../lib/reframe";

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

// --- rendering ---
// Every <Video> sets `_experimentalInitiallyDrawCachedFrame` so a freshly
// mounted panel paints the last cached frame instead of black. Layout switches
// in the editor Player remount these Videos (different subtree per layout), and
// a fresh @remotion/media Video is black until it decodes — this hides that
// flash. Render/export is unaffected (it's a Player-only first-frame hint).
// ponytail: deliberately NOT reusing elements / decoupling audio here — that
// path froze the live frame loop (see memory: layout-switch-black-flash).

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
        _experimentalInitiallyDrawCachedFrame
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

/** Whole source frame fit (contained) inside a panel — for screen/gameplay capture. */
const ContentPanel: React.FC<{
  src: string;
  panel: PanelRect;
  srcW: number;
  srcH: number;
  trimBefore: number;
}> = ({ src, panel, srcW, srcH, trimBefore }) => {
  const scale = Math.min(panel.width / srcW, panel.height / srcH);
  const videoW = srcW * scale;
  const videoH = srcH * scale;
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
        _experimentalInitiallyDrawCachedFrame
        muted
        trimBefore={trimBefore}
        style={{
          position: "absolute",
          left: (panel.width - videoW) / 2,
          top: (panel.height - videoH) / 2,
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
      {/* Blurred background, cropped to fill the frame.
          ponytail: sized to the canvas with objectFit "cover" rather than laid
          out oversize (height x height*aspect) and centered. Same picture, but
          the blur then covers ~3x fewer pixels — at full size this one filter
          was over half the time of a typical export.
          The 1.3 zoom (was 1.15) is what keeps that cheap: a blur fades out
          where it runs past the edge of its element, and the element is now
          only canvas-sized, so it has to be scaled far enough for that faded
          border to land outside the frame. Below ~1.29 you get dark edges. */}
      <Video
        src={src}
        _experimentalInitiallyDrawCachedFrame
        muted
        trimBefore={trimBefore}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width,
          height,
          objectFit: "cover",
          transform: "scale(1.3)",
          filter: "blur(40px) brightness(0.7)",
        }}
      />
      {/* sharp full-width foreground, vertically centered */}
      <Video
        src={src}
        _experimentalInitiallyDrawCachedFrame
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
  const { source, faceTracks } = framing;

  // Look up tracked faces by id via a Map instead of faceTracks.find() on
  // every playback frame (and once per panel).
  const faceTrackById = React.useMemo(
    () => new Map((faceTracks ?? []).map((t) => [t.id, t])),
    [faceTracks]
  );

  const sourceFrame = Math.min(
    range.startFrame + Math.round(frame * (source.fps / fps)),
    range.endFrame - 1
  );
  const trimBefore = Math.round((range.startFrame / source.fps) * fps);

  // The placed range carries its clip's framing decision (layout/crop/faces);
  // a v3 clip is internally single-layout, so no per-frame segment lookup.
  const segment = range.clip;
  // Zoom is held per clip (see medianFaceSize): a face track can span a scene
  // cut, and the two shots must not average into one wrong crop size.
  const faceRange = { from: range.startFrame, to: range.endFrame };

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

  // Non-9:16 outputs don't need the per-segment layout machinery (fill/split/
  // fit exist to fit a wide scene into a tall frame). Show the source as-is:
  // full frame when the output is as wide as the source (16:9), otherwise a
  // single crop tracking the active speaker (1:1 / 4:5). The segment's original
  // 9:16 layout is left untouched, so switching back to 9:16 restores it.
  const is916 = Math.abs(width / height - 9 / 16) < 0.01;
  if (!is916) {
    const outAspect = width / height;
    const srcAspect = source.width / source.height;
    let crop: CropRect;
    if (outAspect >= srcAspect - 1e-3) {
      crop = { x: 0, y: 0, w: 1, h: 1 }; // full frame — nothing to crop
    } else {
      const trackId = segment.trackedFaceIds?.[0];
      const track = trackId != null ? faceTrackById.get(trackId) : undefined;
      const face = track ? smoothedFaceRect(track, sourceFrame, faceRange) : null;
      crop = face
        ? cropForFace(face, outAspect, source.width, source.height)
        : centerCrop(outAspect, source.width, source.height);
    }
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

  // Multi-panel layouts: split / three / four / screenshare / gameplay.
  // Content panels (screen/gameplay capture) show the whole frame; the first
  // non-content panel carries audio.
  const panels = panelsForLayout(segment.layout, width, height);
  const firstFacePanel = panels.findIndex((p) => !p.content);
  const panelCrops = segment.panelCrops;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {panels.map((panel, i) => {
        // A per-tile manual crop pins this panel to a fixed source region — no
        // tracking, no contain — for both face and content (screen/gameplay) panels.
        const pinned = panelCrops?.[i] ?? null;
        if (panel.content && !pinned) {
          return (
            <ContentPanel
              key={i}
              src={src}
              panel={panel}
              srcW={source.width}
              srcH={source.height}
              trimBefore={trimBefore}
            />
          );
        }
        let crop: CropRect;
        if (pinned) {
          crop = pinned;
        } else {
          const trackId = segment.trackedFaceIds[i];
          const track = trackId != null ? faceTrackById.get(trackId) : undefined;
          const face = smoothedFaceRect(track, sourceFrame, faceRange);
          const panelAspect = panel.width / panel.height;
          crop = face
            ? cropForFace(face, panelAspect, source.width, source.height)
            : centerCrop(panelAspect, source.width, source.height);
        }
        return (
          <CroppedVideo
            key={i}
            src={src}
            crop={crop}
            panel={panel}
            srcW={source.width}
            srcH={source.height}
            muted={i !== firstFacePanel} // first face panel carries audio
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
  // placedRanges walks all clips; memoize so it doesn't re-run every frame.
  const ranges = React.useMemo(() => placedRanges(framing, fps), [framing, fps]);
  // sourceVolume is the v3 field; legacy configs that never passed through the
  // editor still carry it on music.originalVolume.
  const originalVolume = framing.sourceVolume ?? (framing.music ? framing.music.originalVolume : 1);

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
