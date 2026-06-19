import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { FramingConfig, TextOverlay } from "../lib/types";
import { sourceRangeToOutputWindows } from "../lib/edl";
import { getFontStack } from "../lib/fonts";

const SIZE_PX: Record<TextOverlay["size"], number> = { S: 44, M: 64, L: 92 };

/**
 * Up to 5 free-positioned text overlays. Overlay times are stored in SOURCE
 * frames and mapped onto the output timeline through the EDL, so they stay
 * anchored to their content across trims/cuts/reorder. A source span can land
 * in several output windows (reordered/duplicated clips), so each overlay is
 * shown in every window the current frame falls into.
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
      {overlays.flatMap((o) => {
        const windows = sourceRangeToOutputWindows(framing, o.startFrame, o.endFrame, fps);
        const visible = windows.some((w) => frame >= w.outStart && frame < w.outEnd);
        if (!visible) return [];
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
