import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { FramingConfig } from "../lib/types";
import { placedRanges, outputDurationFrames } from "../lib/edl";

const FADE = 15; // frames for fade in/out
const DIP = 5; // frames each side of a cut boundary for the smooth-cut dip

/**
 * Black overlay driving all three transitions deterministically from the EDL:
 * fade in / fade out at the clip ends, and a short dip-to-black at each
 * internal cut boundary ("smooth cuts"). Rendered above the video, below
 * captions, so it darkens picture but not text.
 */
export const TransitionOverlay: React.FC<{ framing: FramingConfig }> = ({
  framing,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = framing.transitions;
  if (!t || (!t.fadeIn && !t.fadeOut && !t.cutCrossfade)) return null;

  const total = outputDurationFrames(framing, fps);
  let opacity = 0;

  if (t.fadeIn && frame < FADE) {
    opacity = Math.max(opacity, 1 - frame / FADE);
  }
  if (t.fadeOut && frame > total - FADE) {
    opacity = Math.max(opacity, (frame - (total - FADE)) / FADE);
  }
  // Dip-to-black only when smooth cuts are on AND the style is dip (default).
  // The 'zoom' cut style is handled by TransitionZoom instead.
  if (t.cutCrossfade && t.cutStyle !== "zoom") {
    const ranges = placedRanges(framing, fps);
    for (let i = 1; i < ranges.length; i++) {
      const boundary = ranges[i].outStart;
      const dist = Math.abs(frame - boundary);
      if (dist < DIP) opacity = Math.max(opacity, 1 - dist / DIP);
    }
  }

  if (opacity <= 0) return null;
  return (
    <AbsoluteFill
      style={{ backgroundColor: "#000", opacity, pointerEvents: "none" }}
    />
  );
};
