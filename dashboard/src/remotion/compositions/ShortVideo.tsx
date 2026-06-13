import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import type { ShortVideoProps } from "../lib/types";
import { Subtitles } from "./Subtitles";
import { HookOverlay } from "./HookOverlay";
import { VideoEffects } from "./VideoEffects";
import { ReframedVideo } from "./ReframedVideo";
import { remapCaptions } from "../lib/edl";

/**
 * Main composition that layers all post-processing on top of the base video.
 * Uses @remotion/media Video for browser-side rendering compatibility.
 *
 * Base layer is either the pre-baked clip (videoUrl) or, when framing +
 * sourceVideoUrl are provided, a live non-destructive reframe of the original
 * 16:9 source (see ReframedVideo).
 */
export const ShortVideo: React.FC<Record<string, unknown>> = (rawProps) => {
  const { videoUrl, sourceVideoUrl, framing, subtitles, hook, effects } =
    rawProps as unknown as ShortVideoProps;
  const { fps } = useVideoConfig();

  // Caption words are stored in ms relative to the clip start (clipInFrame).
  // With framing v2 EDL cuts, remap them onto the output timeline and drop
  // words whose content was cut out.
  const effectiveSubtitles =
    subtitles && framing
      ? { ...subtitles, captions: remapCaptions(subtitles.captions, framing, fps) }
      : subtitles;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Layer 1: Base video with optional zoom/color effects */}
      <VideoEffects config={effects}>
        {framing && sourceVideoUrl ? (
          <ReframedVideo src={sourceVideoUrl} framing={framing} />
        ) : (
          <Video
            src={videoUrl}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
      </VideoEffects>

      {/* Layer 2: Animated subtitles */}
      {effectiveSubtitles && <Subtitles config={effectiveSubtitles} />}

      {/* Layer 3: Hook text overlay */}
      {hook && <HookOverlay config={hook} />}
    </AbsoluteFill>
  );
};
