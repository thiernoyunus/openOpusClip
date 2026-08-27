import type { CropRect, CameraKeyframe, FaceTrack } from "./types";

// --- pure helpers (deterministic per frame: required for server rendering) ---

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * First index i where items[i].frame >= target (or items.length if none).
 * items must be sorted ascending by .frame — both cameraKeyframes and face
 * track samples are recorded in frame order. Runs every playback frame, so
 * this replaces the old full-array scans with a binary search.
 */
const lowerBoundByFrame = (items: { frame: number }[], target: number): number => {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].frame < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Linear interpolation between sampled keyframes, clamped at both ends. */
export const interpolateCrop = (
  keyframes: CameraKeyframe[],
  frame: number
): CropRect | null => {
  if (keyframes.length === 0) return null;
  if (frame <= keyframes[0].frame) return keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (frame >= last.frame) return last;
  // keyframes are sorted by frame; binary-search the surrounding pair
  const i = lowerBoundByFrame(keyframes, frame);
  const a = keyframes[i - 1];
  const b = keyframes[i];
  const t = b.frame === a.frame ? 0 : (frame - a.frame) / (b.frame - a.frame);
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
  };
};

/**
 * How many source frames each side of the rendered frame get averaged into the
 * face position. Wide on purpose: the crop should sit still while someone talks
 * and only drift when they actually change place.
 * ponytail: a box average is the whole tripod. If a real camera move ever needs
 * to be followed tightly, add a dead-zone hold keyed off track history instead.
 */
const SMOOTH_WINDOW = 36;

/** Sample gap (frames) we'll still reach across before dropping the panel. */
const SAMPLE_REACH = 45;

/**
 * One face size per CLIP, used as that clip's zoom level throughout. Detected
 * face height wobbles a few percent every frame and cropForFace turns that
 * straight into a zoom, so the shot breathes in and out even when nobody
 * moves. Holding the median kills it.
 *
 * Scoped to the clip, and ONLY the clip: FaceTrackRecorder matches faces
 * across scene cuts, so one track can span a wide shot and a close-up. Letting
 * a neighbouring shot into the median mis-frames this clip for its whole
 * duration — and for a clip shorter than 2*SAMPLE_REACH the neighbours would
 * actually outvote it. Samples outside the clip are used only when the clip
 * has none of its own, so a panel still draws instead of vanishing.
 *
 * This stays safe for render-service, which sizes the source proxy from the
 * SMALLEST sample in the WIDER [start-SAMPLE_REACH, end+SAMPLE_REACH) window:
 * that window is a superset of this one, so its min is <= this median and the
 * proxy can never be fed less resolution than the crop consumes. Keep in sync
 * with faceCropHeight() in render-service/src/source-proxy.ts.
 *
 * ponytail: one size per clip means a genuine dolly-in inside a single shot
 * won't be followed. Interpolate between windowed medians if that shows up.
 */
export interface FrameRange {
  from: number;
  to: number; // exclusive
}

const trackSizes = new WeakMap<FaceTrack, Map<string, { w: number; h: number }>>();

const medianFaceSize = (
  track: FaceTrack,
  range?: FrameRange
): { w: number; h: number } => {
  const key = range ? `${range.from}:${range.to}` : "*";
  let byRange = trackSizes.get(track);
  if (!byRange) trackSizes.set(track, (byRange = new Map()));
  const hit = byRange.get(key);
  if (hit) return hit;

  let scoped = track.samples;
  if (range) {
    scoped = track.samples.filter(
      (s) => s.frame >= range.from && s.frame < range.to
    );
    // A clip with no samples of its own still needs a size to draw with:
    // widen to the gap-fallback reach, then give up and use the whole track.
    if (scoped.length === 0) {
      scoped = track.samples.filter(
        (s) => s.frame >= range.from - SAMPLE_REACH && s.frame < range.to + SAMPLE_REACH
      );
    }
    if (scoped.length === 0) scoped = track.samples;
  }
  const mid = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
  const size = {
    w: mid(scoped.map((s) => s.w)),
    h: mid(scoped.map((s) => s.h)),
  };
  byRange.set(key, size);
  return size;
};

/** Face box of the given size centred on (cx, cy). */
const atCenter = (
  cx: number,
  cy: number,
  size: { w: number; h: number }
): CropRect => ({ x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h });

/**
 * Smoothed face rect at a frame: the face CENTER averaged over a
 * +/-SMOOTH_WINDOW source-frame window, at the median SIZE for the same
 * window. `range` is the clip being rendered (omitted = the whole track); both
 * the average and the median stay inside it, because a face track can survive
 * a scene cut and averaging across one would open the new shot framed
 * somewhere between the two positions. Falls back to the nearest sample within
 * SAMPLE_REACH frames — deliberately allowed to reach outside `range` — so a
 * clip that begins in a detection gap still draws a panel.
 */
export const smoothedFaceRect = (
  track: FaceTrack | undefined,
  frame: number,
  range?: FrameRange
): CropRect | null => {
  const samples = track?.samples;
  if (!track || !samples || samples.length === 0) return null;
  const size = medianFaceSize(track, range);
  // samples are sorted by frame; binary-search the window instead of filtering
  // the whole track every playback frame.
  const from = Math.max(frame - SMOOTH_WINDOW, range ? range.from : -Infinity);
  const to = Math.min(frame + SMOOTH_WINDOW, range ? range.to - 1 : Infinity);
  let cx = 0, cy = 0, n = 0;
  for (let i = lowerBoundByFrame(samples, from); i < samples.length; i++) {
    const s = samples[i];
    if (s.frame > to) break;
    cx += s.x + s.w / 2; cy += s.y + s.h / 2;
    n++;
  }
  if (n > 0) return atCenter(cx / n, cy / n, size);
  // No sample in window: nearest sample is one of the two straddling `frame`.
  const j = lowerBoundByFrame(samples, frame);
  let nearest = samples[Math.min(j, samples.length - 1)];
  let nearestDist = Math.abs(nearest.frame - frame);
  if (j > 0 && Math.abs(samples[j - 1].frame - frame) < nearestDist) {
    nearest = samples[j - 1];
    nearestDist = Math.abs(nearest.frame - frame);
  }
  return nearestDist <= SAMPLE_REACH
    ? atCenter(nearest.x + nearest.w / 2, nearest.y + nearest.h / 2, size)
    : null;
};

/**
 * Build a crop window (normalized) around a face for a panel of the given
 * pixel aspect ratio. The face fills ~35% of the panel height, with headroom:
 * face center sits at 42% from the crop top.
 */
export const cropForFace = (
  face: CropRect,
  panelAspect: number, // panel width / height in px
  srcW: number,
  srcH: number
): CropRect => {
  const faceHpx = face.h * srcH;
  let cropHpx = clamp(faceHpx / 0.35, srcH * 0.3, srcH);
  let cropWpx = cropHpx * panelAspect;
  if (cropWpx > srcW) {
    cropWpx = srcW;
    cropHpx = cropWpx / panelAspect;
  }
  const centerXpx = (face.x + face.w / 2) * srcW;
  const faceCenterYpx = (face.y + face.h / 2) * srcH;
  let topPx = faceCenterYpx - cropHpx * 0.42;
  let leftPx = centerXpx - cropWpx / 2;
  leftPx = clamp(leftPx, 0, srcW - cropWpx);
  topPx = clamp(topPx, 0, srcH - cropHpx);
  return {
    x: leftPx / srcW,
    y: topPx / srcH,
    w: cropWpx / srcW,
    h: cropHpx / srcH,
  };
};

/** Center crop matching the panel aspect — fallback when nothing is tracked. */
export const centerCrop = (
  panelAspect: number,
  srcW: number,
  srcH: number
): CropRect => {
  let cropHpx = srcH;
  let cropWpx = cropHpx * panelAspect;
  if (cropWpx > srcW) {
    cropWpx = srcW;
    cropHpx = cropWpx / panelAspect;
  }
  return {
    x: (srcW - cropWpx) / 2 / srcW,
    y: (srcH - cropHpx) / 2 / srcH,
    w: cropWpx / srcW,
    h: cropHpx / srcH,
  };
};
