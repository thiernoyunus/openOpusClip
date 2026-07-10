import React from "react";
import { AbsoluteFill, Img, Sequence, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import type { FramingConfig, OverlayItem } from "../lib/types";
import { sourceRangeToOutputWindows } from "../lib/edl";

/**
 * Generic overlay track (video/image) — supersedes BrollLayer (video-only, max
 * 3, always full-cover, muted). Source-anchored items (the default, and the
 * only mode BrollLayer supported) map through `sourceRangeToOutputWindows`
 * exactly like b-roll, so a span spanning a reordered/duplicated/split clip
 * lands in one Sequence per output window and keeps its playback offset.
 * Output-anchored items are placed directly on the output timeline with a
 * plain Sequence, for content tied to a fixed on-screen moment rather than
 * source footage. Rendered in ascending `z` order so higher z paints on top;
 * full-cover defaults (x=0.5,y=0.5,w=1,h=1) render identically to BrollLayer.
 */
export const OverlaysLayer: React.FC<{ framing: FramingConfig }> = ({
  framing,
}) => {
  const { fps } = useVideoConfig();
  const items = framing.overlays ?? [];
  if (items.length === 0) return null;

  const sorted = [...items].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

  return (
    <AbsoluteFill>
      {sorted.flatMap((o) => {
        const x = o.x ?? 0.5;
        const y = o.y ?? 0.5;
        const w = o.w ?? 1;
        const h = o.h ?? 1;
        const boxStyle: React.CSSProperties = {
          position: "absolute",
          left: `${(x - w / 2) * 100}%`,
          top: `${(y - h / 2) * 100}%`,
          width: `${w * 100}%`,
          height: `${h * 100}%`,
          overflow: "hidden",
          // Matches BrollLayer's black backdrop while a full-cover video loads;
          // image overlays (often transparent PNGs) stay see-through.
          backgroundColor: o.kind === "video" ? "#000" : "transparent",
        };

        if ((o.anchor ?? "source") === "output") {
          return [
            <Sequence
              key={o.id}
              from={o.startFrame}
              durationInFrames={Math.max(1, o.endFrame - o.startFrame)}
              layout="none"
            >
              <div style={boxStyle}>
                <OverlayMedia item={o} />
              </div>
            </Sequence>,
          ];
        }

        return sourceRangeToOutputWindows(
          framing,
          o.startFrame,
          o.endFrame,
          fps
        ).map((win, i) => {
          // How much of the overlay has already elapsed at this window's start
          // (output frames), so an overlay spanning a split/reorder continues
          // instead of restarting — same logic as BrollLayer.
          const trimBefore = Math.round(
            ((win.srcStart - o.startFrame) / framing.source.fps) * fps
          );
          return (
            <Sequence
              key={`${o.id}-${i}`}
              from={win.outStart}
              durationInFrames={win.outEnd - win.outStart}
              layout="none"
            >
              <div style={boxStyle}>
                <OverlayMedia item={o} trimBefore={trimBefore} />
              </div>
            </Sequence>
          );
        });
      })}
    </AbsoluteFill>
  );
};

const OverlayMedia: React.FC<{ item: OverlayItem; trimBefore?: number }> = ({
  item,
  trimBefore,
}) => {
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  };
  if (item.kind === "image") {
    return <Img src={item.url} style={style} />;
  }
  const volume = item.volume ?? 0;
  return (
    <Video
      src={item.url}
      trimBefore={trimBefore}
      volume={volume}
      muted={volume === 0}
      style={style}
    />
  );
};
