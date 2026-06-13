import type { CaptionWord } from "./types";
import type { FramingConfig } from "./types";

/**
 * EDL (edit decision list) math — the single source of truth for how
 * framing v2's playable content maps onto the output timeline.
 *
 * Playable content = [clipInFrame, clipOutFrame] minus cuts[], all in SOURCE
 * frames. The output timeline is those kept ranges played back-to-back.
 * Preview (Player), export (render-service), captions, text overlays, and the
 * editor timeline all use these functions so durations and positions agree
 * everywhere. Rounding happens PER RANGE via toOutputFrames().
 */

export interface SourceRange {
  startFrame: number;
  endFrame: number; // exclusive
}

/** Normalize v1 configs in place-ish: returns the effective clip bounds/cuts. */
export const clipBounds = (framing: FramingConfig): SourceRange => ({
  startFrame: framing.clipInFrame ?? 0,
  endFrame: framing.clipOutFrame ?? framing.source.durationFrames,
});

const sortedCuts = (framing: FramingConfig): SourceRange[] =>
  [...(framing.cuts ?? [])].sort((a, b) => a.startFrame - b.startFrame);

/** Playable source ranges: [clipIn, clipOut] minus cuts, in order. */
export const keptRanges = (framing: FramingConfig): SourceRange[] => {
  const { startFrame: clipIn, endFrame: clipOut } = clipBounds(framing);
  const ranges: SourceRange[] = [];
  let cursor = clipIn;
  for (const cut of sortedCuts(framing)) {
    const cutStart = Math.max(cut.startFrame, clipIn);
    const cutEnd = Math.min(cut.endFrame, clipOut);
    if (cutEnd <= cursor) continue;
    if (cutStart > cursor) {
      ranges.push({ startFrame: cursor, endFrame: cutStart });
    }
    cursor = Math.max(cursor, cutEnd);
  }
  if (cursor < clipOut) {
    ranges.push({ startFrame: cursor, endFrame: clipOut });
  }
  return ranges;
};

/** Source-frame count -> output-frame count at the composition fps. */
export const toOutputFrames = (
  srcFrames: number,
  srcFps: number,
  fps: number
): number => Math.max(1, Math.round((srcFrames / srcFps) * fps));

/** Total output duration in composition frames. */
export const outputDurationFrames = (
  framing: FramingConfig,
  fps: number
): number =>
  keptRanges(framing).reduce(
    (acc, r) =>
      acc + toOutputFrames(r.endFrame - r.startFrame, framing.source.fps, fps),
    0
  );

/**
 * Kept ranges annotated with their output-timeline position, the shape both
 * the composition (Sequence from/duration) and the timeline UI consume.
 */
export interface PlacedRange extends SourceRange {
  outStart: number; // output frames
  outDuration: number; // output frames
}

export const placedRanges = (
  framing: FramingConfig,
  fps: number
): PlacedRange[] => {
  const out: PlacedRange[] = [];
  let cursor = 0;
  for (const r of keptRanges(framing)) {
    const dur = toOutputFrames(r.endFrame - r.startFrame, framing.source.fps, fps);
    out.push({ ...r, outStart: cursor, outDuration: dur });
    cursor += dur;
  }
  return out;
};

/** Output frame -> source frame (clamped into the last range). */
export const outputToSource = (
  framing: FramingConfig,
  outFrame: number,
  fps: number
): number => {
  const ranges = placedRanges(framing, fps);
  if (ranges.length === 0) return clipBounds(framing).startFrame;
  for (const r of ranges) {
    if (outFrame < r.outStart + r.outDuration) {
      const offset = Math.max(0, outFrame - r.outStart);
      return Math.min(
        r.startFrame + Math.round((offset / fps) * framing.source.fps),
        r.endFrame - 1
      );
    }
  }
  const last = ranges[ranges.length - 1];
  return last.endFrame - 1;
};

/**
 * Source frame -> output frame. Frames inside cuts/outside the clip snap
 * forward to the next kept frame (or the very end), so seeking never fails;
 * pass strict=true to get null for removed content instead.
 */
export const sourceToOutput = (
  framing: FramingConfig,
  srcFrame: number,
  fps: number,
  strict = false
): number | null => {
  const ranges = placedRanges(framing, fps);
  if (ranges.length === 0) return strict ? null : 0;
  for (const r of ranges) {
    if (srcFrame < r.startFrame) {
      return strict ? null : r.outStart; // inside a cut -> snap to next range
    }
    if (srcFrame < r.endFrame) {
      return (
        r.outStart +
        Math.round(((srcFrame - r.startFrame) / framing.source.fps) * fps)
      );
    }
  }
  const last = ranges[ranges.length - 1];
  return strict ? null : last.outStart + last.outDuration - 1;
};

/**
 * Remap caption words (ms relative to clipInFrame, i.e. original clip start)
 * onto the output timeline, dropping words whose midpoint was cut out.
 */
export const remapCaptions = (
  captions: CaptionWord[],
  framing: FramingConfig,
  fps: number
): CaptionWord[] => {
  const srcFps = framing.source.fps;
  const { startFrame: clipIn } = clipBounds(framing);
  const out: CaptionWord[] = [];
  for (const w of captions) {
    const midMs = (w.startMs + w.endMs) / 2;
    const midSrc = clipIn + Math.round((midMs / 1000) * srcFps);
    const startSrc = clipIn + Math.round((w.startMs / 1000) * srcFps);
    const endSrc = clipIn + Math.round((w.endMs / 1000) * srcFps);
    const midOut = sourceToOutput(framing, midSrc, fps, true);
    if (midOut === null) continue; // word removed by a cut
    const startOut = sourceToOutput(framing, startSrc, fps) ?? midOut;
    const endOut = sourceToOutput(framing, endSrc, fps) ?? midOut;
    out.push({
      text: w.text,
      startMs: (startOut / fps) * 1000,
      endMs: Math.max((endOut / fps) * 1000, (startOut / fps) * 1000 + 60),
    });
  }
  return out;
};
