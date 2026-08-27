/**
 * Tiny assert-based self-check for the face-tracking crop math. No framework.
 * Run: `node remotion/src/lib/reframe.selfcheck.ts` (Node >= 22 strips the types).
 *
 * The thing being guarded: a person who sits still must get a still crop.
 * Detection noise used to leak into both the crop size (read as zoom in/out)
 * and the crop position (read as constant panning).
 */
import assert from "node:assert";
import { smoothedFaceRect, cropForFace, centerCrop } from "./reframe.ts";
import type { FaceTrack } from "./types.ts";

const SRC_W = 1920;
const SRC_H = 1080;
const PANEL_ASPECT = 1080 / 960; // one panel of a 1080x1920 split

/** A face that never moves, but whose detected box wobbles +/-4% every sample. */
const jittery: FaceTrack = {
  id: 0,
  samples: Array.from({ length: 60 }, (_, i) => {
    const wobble = 1 + (i % 2 ? 0.04 : -0.04);
    const w = 0.1 * wobble;
    const h = 0.18 * wobble;
    return { frame: i * 5, x: 0.5 - w / 2, y: 0.3 - h / 2, w, h };
  }),
};

const cropAt = (track: FaceTrack, frame: number) => {
  const face = smoothedFaceRect(track, frame);
  assert.ok(face, `no face at frame ${frame}`);
  return cropForFace(face, PANEL_ASPECT, SRC_W, SRC_H);
};

// 1. Zoom is dead still across the whole track.
const first = cropAt(jittery, 0);
for (let f = 0; f < 300; f += 7) {
  const c = cropAt(jittery, f);
  assert.strictEqual(c.w, first.w, `crop width changed at frame ${f}`);
  assert.strictEqual(c.h, first.h, `crop height changed at frame ${f}`);
}

// 2. Position barely drifts: under 0.5% of the frame across the whole track.
for (let f = 0; f < 300; f += 7) {
  const c = cropAt(jittery, f);
  assert.ok(Math.abs(c.x - first.x) < 0.005, `crop panned at frame ${f}`);
  assert.ok(Math.abs(c.y - first.y) < 0.005, `crop tilted at frame ${f}`);
}

// 3. A real move IS followed (just slowly): walking right across the frame
//    still lands the crop on the right-hand side.
const walking: FaceTrack = {
  id: 1,
  samples: Array.from({ length: 60 }, (_, i) => ({
    frame: i * 5,
    x: 0.1 + (i / 59) * 0.7,
    y: 0.3,
    w: 0.1,
    h: 0.18,
  })),
};
const start = cropAt(walking, 0);
const end = cropAt(walking, 295);
assert.ok(end.x - start.x > 0.3, "crop did not follow a real move");
assert.strictEqual(end.w, start.w, "a lateral move should not change zoom");

// 4. Gaps and misses behave: no samples in reach -> null -> caller center-crops.
assert.strictEqual(smoothedFaceRect(jittery, 100_000), null);
assert.strictEqual(smoothedFaceRect(undefined, 0), null);
const center = centerCrop(PANEL_ASPECT, SRC_W, SRC_H);
assert.ok(center.w > 0 && center.h > 0);

console.log("reframe.selfcheck: ok");
