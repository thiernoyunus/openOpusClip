import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { Video, Audio } from "@remotion/media";
import type { ShortVideoProps } from "../lib/types";
import { Subtitles } from "./Subtitles";
import { HookOverlay } from "./HookOverlay";
import { VideoEffects } from "./VideoEffects";
import { ReframedVideo } from "./ReframedVideo";
import { BrollLayer } from "./BrollLayer";
import { TextOverlays } from "./TextOverlays";
import { TransitionOverlay } from "./TransitionOverlay";
import { TransitionZoom } from "./TransitionZoom";
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
      {/* Layers 1+2: footage (base video + b-roll). When framing exists they
          are wrapped in TransitionZoom so the zoom cut-style scales the
          FOOTAGE only — captions/text/overlays (layers 3+) are not scaled. */}
      {framing ? (
        <TransitionZoom framing={framing}>
          {/* Layer 1: Base video with optional zoom/color effects */}
          <VideoEffects config={effects}>
            {sourceVideoUrl ? (
              <ReframedVideo src={sourceVideoUrl} framing={framing} />
            ) : (
              <Video
                src={videoUrl}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            )}
          </VideoEffects>

          {/* Layer 2: B-roll inserts (cover the base during a span) */}
          <BrollLayer framing={framing} />
        </TransitionZoom>
      ) : (
        // No framing: plain base video, no zoom transition / b-roll.
        <VideoEffects config={effects}>
          <Video
            src={videoUrl}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </VideoEffects>
      )}

      {/* Layer 3: Transitions (fade in/out, smooth cuts) — darkens picture */}
      {framing && <TransitionOverlay framing={framing} />}

      {/* Layer 4: Animated subtitles */}
      {effectiveSubtitles && <Subtitles config={effectiveSubtitles} />}

      {/* Layer 5: Free-positioned text overlays */}
      {framing && <TextOverlays framing={framing} />}

      {/* Layer 6: Hook text overlay */}
      {hook && <HookOverlay config={hook} />}

      {/* Layer 7: Background music */}
      {framing?.music && (
        <Audio src={framing.music.url} volume={framing.music.volume} loop />
      )}
    </AbsoluteFill>
  );
};
