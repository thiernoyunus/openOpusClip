import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { FramingConfig, TextOverlay } from "../lib/types";
import { sourceToOutput } from "../lib/edl";
import { getFontStack } from "../lib/fonts";

const SIZE_PX: Record<TextOverlay["size"], number> = { S: 44, M: 64, L: 92 };

/**
 * Up to 5 free-positioned text overlays. Overlay times are stored in SOURCE
 * frames (like cuts) and mapped onto the output timeline through the EDL, so
 * they stay anchored to their content across trims and cuts.
 */
export const TextOverlays: React.FC<{ framing: FramingConfig }> = ({
  framing,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const overlays = framing.textOverlays ?? [];
  if (overlays.length === 0) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {overlays.map((o) => {
        const start = sourceToOutput(framing, o.startFrame, fps, true);
        const end = sourceToOutput(framing, o.endFrame, fps);
        if (start === null || end === null) return null;
        if (frame < start || frame >= end) return null;
        return (
          <div
            key={o.id}
            style={{
              position: "absolute",
              left: `${o.x * 100}%`,
              top: `${o.y * 100}%`,
              transform: "translate(-50%, -50%)",
              maxWidth: "88%",
              textAlign: "center",
              fontFamily: getFontStack("Inter"),
              fontWeight: 800,
              fontSize: SIZE_PX[o.size] || 64,
              lineHeight: 1.15,
              color: o.color,
              padding: o.bg ? "0.2em 0.5em" : 0,
              borderRadius: 12,
              backgroundColor: o.bg ? "rgba(0,0,0,0.55)" : "transparent",
              textShadow: o.bg ? "none" : "0 2px 12px rgba(0,0,0,0.7)",
              whiteSpace: "pre-wrap",
            }}
          >
            {o.text}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
