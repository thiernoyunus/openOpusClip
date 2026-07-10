import React from "react";
import { Sequence, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import type { AudioItem, FramingConfig } from "../lib/types";

/**
 * Generic audio track (SFX + music) — supersedes the single `music` field.
 * Always OUTPUT-anchored (startFrame/endFrame are already in composition
 * frames), so a sound effect timed to a moment doesn't drift when clips
 * upstream of it are reordered/trimmed. Fades are implemented with a
 * frame-interpolated volume callback; per Remotion's <Audio>, that callback
 * receives the frame LOCAL to the enclosing Sequence (0..durationInFrames-1).
 */
export const AudioLayer: React.FC<{ framing: FramingConfig }> = ({
  framing,
}) => {
  const { fps } = useVideoConfig();
  const items = framing.audio ?? [];
  if (items.length === 0) return null;

  return (
    <>
      {items.map((item) => {
        const duration = Math.max(1, item.endFrame - item.startFrame);
        return (
          <Sequence
            key={item.id}
            from={item.startFrame}
            durationInFrames={duration}
            layout="none"
          >
            <Audio
              src={item.url}
              trimBefore={item.trimBefore ?? 0}
              loop={item.loop ?? false}
              // "extend": the volume callback's frame keeps counting across loop
              // iterations; the default "repeat" restarts it each loop, which
              // would re-trigger fadeIn / fire fadeOut at every loop seam.
              loopVolumeCurveBehavior="extend"
              volume={makeVolumeCallback(item, duration, fps)}
            />
          </Sequence>
        );
      })}
    </>
  );
};

/** Linear fade-in/fade-out around the item's base volume. */
function makeVolumeCallback(
  item: AudioItem,
  durationInFrames: number,
  fps: number
): (localFrame: number) => number {
  const base = item.volume ?? 1;
  const fadeInFrames = Math.round((item.fadeInSec ?? 0) * fps);
  const fadeOutFrames = Math.round((item.fadeOutSec ?? 0) * fps);
  return (localFrame: number) => {
    let v = base;
    if (fadeInFrames > 0 && localFrame < fadeInFrames) {
      v *= Math.max(0, localFrame / fadeInFrames);
    }
    const framesFromEnd = durationInFrames - localFrame;
    if (fadeOutFrames > 0 && framesFromEnd < fadeOutFrames) {
      v *= Math.max(0, framesFromEnd / fadeOutFrames);
    }
    return Math.max(0, v);
  };
}
