import type { CaptionWord } from "./types";
import type { FramingConfig, TimelineClip } from "./types";

/**
 * EDL (edit decision list) math — the single source of truth for how the
 * framing's main video track maps onto the output timeline.
 *
 * v3: the main track is an ORDERED list of clips (framing.clips). Array index
 * is the playback order; a clip is a slice of source [sourceStart, sourceEnd).
 * The output timeline is the clips played back-to-back in array order, so a
 * source frame may appear in ZERO, ONE, or MANY output positions
 * (deletion / reorder / duplication). Rounding happens PER CLIP via
 * toOutputFrames(), and every consumer (Player, render-service, captions,
 * overlays, the editor timeline) derives from placedClips() so durations and
 * positions agree everywhere.
 *
 * Back-compat: v1/v2 configs (contiguous source-ordered segments + cuts) are
 * converted to clips on the fly by framingToClips(), so this module works
 * uniformly whether it receives a migrated v3 config or a raw legacy one.
 */

export interface SourceRange {
  startFrame: number;
  endFrame: number; // exclusive
}

// --- Legacy v1/v2 helpers (only used to derive clips from old configs) ---

/** Effective clip bounds for a v1/v2 config. */
export const clipBounds = (framing: FramingConfig): SourceRange => ({
  startFrame: framing.clipInFrame ?? 0,
  endFrame: framing.clipOutFrame ?? framing.source.durationFrames,
});

const sortedCuts = (framing: FramingConfig): SourceRange[] =>
  [...(framing.cuts ?? [])].sort((a, b) => a.startFrame - b.startFrame);

/** v1/v2 playable source ranges: [clipIn, clipOut] minus cuts, in source order. */
export const keptRanges = (framing: FramingConfig): SourceRange[] => {
  const { startFrame: clipIn, endFrame: clipOut } = clipBounds(framing);
  const ranges: SourceRange[] = [];
  let cursor = clipIn;
  for (const cut of sortedCuts(framing)) {
    const cutStart = Math.max(cut.startFrame, clipIn);
    const cutEnd = Math.min(cut.endFrame, clipOut);
    if (cutEnd <= cursor) continue;
    if (cutStart > cursor) ranges.push({ startFrame: cursor, endFrame: cutStart });
    cursor = Math.max(cursor, cutEnd);
  }
  if (cursor < clipOut) ranges.push({ startFrame: cursor, endFrame: clipOut });
  return ranges;
};

/**
 * The main track as an ordered clip list. Returns framing.clips when present
 * (v3); otherwise derives clips from v1/v2 segments + cuts so the kept content
 * and order are preserved exactly (this is also the migration algorithm reused
 * by the editor's normalizeFraming).
 */
export const framingToClips = (framing: FramingConfig): TimelineClip[] => {
  if (Array.isArray(framing.clips) && framing.clips.length > 0) return framing.clips;

  const segments = framing.segments ?? [];
  const clips: TimelineClip[] = [];
  for (const r of keptRanges(framing)) {
    for (const s of segments) {
      const a = Math.max(r.startFrame, s.startFrame);
      const b = Math.min(r.endFrame, s.endFrame);
      if (b <= a) continue;
      clips.push({
        id: `${s.id}__${a}`,
        sourceStart: a,
        sourceEnd: b,
        layout: s.layout,
        trackedFaceIds: [...s.trackedFaceIds],
        cameraKeyframes: s.cameraKeyframes,
        manualCrop: s.manualCrop,
      });
    }
  }
  if (clips.length === 0) {
    // v1 / degenerate: one full-span clip so the editor never shows an empty track.
    const { startFrame, endFrame } = clipBounds(framing);
    const s = segments[0];
    clips.push({
      id: "clip-0",
      sourceStart: startFrame,
      sourceEnd: Math.max(endFrame, startFrame + 1),
      layout: s?.layout ?? "fit",
      trackedFaceIds: s ? [...s.trackedFaceIds] : [],
      cameraKeyframes: s?.cameraKeyframes ?? [],
      manualCrop: s?.manualCrop ?? null,
    });
  }
  return clips;
};

// --- Output-axis math (everything derives from placedClips) ---

/** Source-frame count -> output-frame count at the composition fps. */
export const toOutputFrames = (
  srcFrames: number,
  srcFps: number,
  fps: number
): number => Math.max(1, Math.round((srcFrames / srcFps) * fps));

export interface PlacedClip {
  clipIndex: number; // index in the clip array == playback order
  clip: TimelineClip; // carries the framing props (layout, faces, keyframes, crop)
  sourceStart: number;
  sourceEnd: number; // exclusive
  outStart: number; // output frames
  outDuration: number; // output frames
}

/** Clips placed back-to-back on the output timeline, in array order. */
export const placedClips = (
  framing: FramingConfig,
  fps: number
): PlacedClip[] => {
  const out: PlacedClip[] = [];
  let cursor = 0;
  framingToClips(framing).forEach((clip, i) => {
    const dur = toOutputFrames(
      clip.sourceEnd - clip.sourceStart,
      framing.source.fps,
      fps
    );
    out.push({
      clipIndex: i,
      clip,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      outStart: cursor,
      outDuration: dur,
    });
    cursor += dur;
  });
  return out;
};

/**
 * Kept ranges annotated with their output-timeline position — the shape the
 * composition (Sequence from/duration) and transitions consume. Thin alias over
 * placedClips so those consumers need (almost) no change; `.clip` is added so
 * the framing props travel with each placed range.
 */
export interface PlacedRange extends SourceRange {
  outStart: number; // output frames
  outDuration: number; // output frames
  clip: TimelineClip;
}

export const placedRanges = (
  framing: FramingConfig,
  fps: number
): PlacedRange[] =>
  placedClips(framing, fps).map((p) => ({
    startFrame: p.sourceStart,
    endFrame: p.sourceEnd,
    outStart: p.outStart,
    outDuration: p.outDuration,
    clip: p.clip,
  }));

/** Total output duration in composition frames. */
export const outputDurationFrames = (
  framing: FramingConfig,
  fps: number
): number => placedClips(framing, fps).reduce((acc, p) => acc + p.outDuration, 0);

/** Output frame -> source frame (clamped into the last clip). For seek/scrub. */
export const outputToSource = (
  framing: FramingConfig,
  outFrame: number,
  fps: number
): number => {
  const placed = placedClips(framing, fps);
  if (placed.length === 0) return 0;
  for (const p of placed) {
    if (outFrame < p.outStart + p.outDuration) {
      const offset = Math.max(0, outFrame - p.outStart);
      return Math.min(
        p.sourceStart + Math.round((offset / fps) * framing.source.fps),
        p.sourceEnd - 1
      );
    }
  }
  const last = placed[placed.length - 1];
  return last.sourceEnd - 1;
};

/**
 * Every output frame a source frame is visible at — 0 (deleted), 1, or many
 * (duplicated). Used to decide whether a transcript word is cut, and for
 * placing source-anchored content.
 */
export const sourceToOutputAll = (
  framing: FramingConfig,
  srcFrame: number,
  fps: number
): number[] => {
  const hits: number[] = [];
  for (const p of placedClips(framing, fps)) {
    if (srcFrame >= p.sourceStart && srcFrame < p.sourceEnd) {
      hits.push(
        p.outStart +
          Math.round(((srcFrame - p.sourceStart) / framing.source.fps) * fps)
      );
    }
  }
  return hits;
};

/**
 * Source frame -> a single output frame (the FIRST occurrence). For seek
 * callers (timeline scrub, transcript word-click). Frames in a gap snap forward
 * to the next clip; pass strict=true to get null for removed content instead.
 */
export const sourceToOutput = (
  framing: FramingConfig,
  srcFrame: number,
  fps: number,
  strict = false
): number | null => {
  const placed = placedClips(framing, fps);
  if (placed.length === 0) return strict ? null : 0;
  for (const p of placed) {
    if (srcFrame >= p.sourceStart && srcFrame < p.sourceEnd) {
      return (
        p.outStart +
        Math.round(((srcFrame - p.sourceStart) / framing.source.fps) * fps)
      );
    }
  }
  if (strict) return null;
  for (const p of placed) if (p.sourceStart >= srcFrame) return p.outStart; // next clip
  const last = placed[placed.length - 1];
  return last.outStart + last.outDuration - 1;
};

export interface OutputWindow {
  outStart: number;
  outEnd: number; // exclusive
}

/**
 * The output windows where a source range [sStart, sEnd) is visible — one per
 * intersecting clip (so a range spanning reordered/duplicated clips yields
 * several windows). Used to place source-anchored text overlays and b-roll.
 */
export const sourceRangeToOutputWindows = (
  framing: FramingConfig,
  sStart: number,
  sEnd: number,
  fps: number
): OutputWindow[] => {
  const srcFps = framing.source.fps;
  const wins: OutputWindow[] = [];
  for (const p of placedClips(framing, fps)) {
    const a = Math.max(sStart, p.sourceStart);
    const b = Math.min(sEnd, p.sourceEnd);
    if (b <= a) continue;
    const off = (s: number) =>
      p.outStart + Math.round(((s - p.sourceStart) / srcFps) * fps);
    const outStart = off(a);
    wins.push({ outStart, outEnd: Math.max(off(b), outStart + 1) });
  }
  return wins;
};

/** The clip under the output playhead. For the tracker overlay / active-clip UI. */
export const clipAtOutputFrame = (
  framing: FramingConfig,
  outFrame: number,
  fps: number
): PlacedClip | null => {
  const placed = placedClips(framing, fps);
  for (const p of placed) if (outFrame < p.outStart + p.outDuration) return p;
  return placed[placed.length - 1] ?? null;
};

/**
 * Remap caption words (ms relative to captionsOriginFrame, the original clip
 * start) onto the output timeline. Dual walk: for each placed clip, emit the
 * words whose source MIDPOINT falls inside that clip's range, shifted into that
 * clip's output window. Naturally handles deletion (word in no clip → dropped),
 * duplication (emitted once per occurrence) and reorder (output order).
 */
export const remapCaptions = (
  captions: CaptionWord[] | undefined,
  framing: FramingConfig,
  fps: number
): CaptionWord[] => {
  if (!captions) return [];
  const srcFps = framing.source.fps;
  // Caption ms are relative to the ORIGINAL clip start (captionsOriginFrame),
  // captured once at generation time, so head trims don't shift subtitles.
  const origin = framing.captionsOriginFrame ?? clipBounds(framing).startFrame;
  const wordSrc = captions.map((w) => {
    const startSrc = origin + Math.round((w.startMs / 1000) * srcFps);
    const endSrc = origin + Math.round((w.endMs / 1000) * srcFps);
    return { w, startSrc, endSrc, midSrc: (startSrc + endSrc) / 2 };
  });
  const out: CaptionWord[] = [];
  for (const p of placedClips(framing, fps)) {
    const toOut = (s: number) =>
      p.outStart +
      Math.round(
        ((Math.max(p.sourceStart, Math.min(s, p.sourceEnd)) - p.sourceStart) /
          srcFps) *
          fps
      );
    for (const ws of wordSrc) {
      if (ws.midSrc < p.sourceStart || ws.midSrc >= p.sourceEnd) continue;
      const startOut = toOut(ws.startSrc);
      const endOut = toOut(ws.endSrc);
      out.push({
        // Spread keeps per-word metadata (emoji, highlight, …); only timing is rewritten.
        ...ws.w,
        startMs: (startOut / fps) * 1000,
        endMs: Math.max((endOut / fps) * 1000, (startOut / fps) * 1000 + 60),
      });
    }
  }
  return out;
};
