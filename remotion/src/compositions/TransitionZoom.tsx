import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { FramingConfig } from "../lib/types";
import { placedRanges } from "../lib/edl";

const PUNCH = 8; // frames each side of a cut boundary for the zoom punch
const MAX_SCALE = 0.12; // extra scale at the boundary (1.0 -> 1.12)

/**
 * Alternative smooth-cut style: instead of dipping to black, the FOOTAGE
 * briefly punches up in scale at each internal cut boundary. Wraps the footage
 * layers (video + b-roll) so captions/text/overlays above are NOT scaled.
 *
 * Only active when transitions.cutCrossfade is on AND cutStyle === 'zoom';
 * otherwise renders children unchanged (no transform).
 */
export const TransitionZoom: React.FC<{
  framing: FramingConfig;
  children: React.ReactNode;
}> = ({ framing, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = framing.transitions;

  if (!t?.cutCrossfade || t.cutStyle !== "zoom") {
    return <>{children}</>;
  }

  const ranges = placedRanges(framing, fps);
  let scale = 1;
  for (let i = 1; i < ranges.length; i++) {
    const boundary = ranges[i].outStart;
    const dist = Math.abs(frame - boundary);
    if (dist < PUNCH) {
      scale = Math.max(scale, 1 + MAX_SCALE * (1 - dist / PUNCH));
    }
  }

  if (scale === 1) {
    return <>{children}</>;
  }

  return (
    <AbsoluteFill
      style={{ transform: `scale(${scale})`, transformOrigin: "50% 50%" }}
    >
      {children}
    </AbsoluteFill>
  );
};
