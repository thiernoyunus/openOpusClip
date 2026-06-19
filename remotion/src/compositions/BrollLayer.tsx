import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import type { FramingConfig } from "../lib/types";
import { sourceRangeToOutputWindows } from "../lib/edl";

/**
 * B-roll inserts: full-canvas stock/AI footage covering the original video
 * during a span. Times stored in SOURCE frames, EDL-mapped onto the output
 * timeline. A source span can land in several disjoint output windows (when the
 * clips it covers are reordered/duplicated/partly cut), so we render one
 * Sequence per window. Muted (the clip's own audio keeps playing underneath).
 */
export const BrollLayer: React.FC<{ framing: FramingConfig }> = ({
  framing,
}) => {
  const { fps } = useVideoConfig();
  const items = framing.broll ?? [];
  if (items.length === 0) return null;

  return (
    <AbsoluteFill>
      {items.flatMap((b) =>
        sourceRangeToOutputWindows(framing, b.startFrame, b.endFrame, fps).map(
          (w, i) => (
            <Sequence
              key={`${b.id}-${i}`}
              from={w.outStart}
              durationInFrames={w.outEnd - w.outStart}
              layout="none"
            >
              <AbsoluteFill style={{ backgroundColor: "#000" }}>
                <Video
                  src={b.url}
                  muted
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              </AbsoluteFill>
            </Sequence>
          )
        )
      )}
    </AbsoluteFill>
  );
};
