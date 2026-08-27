/**
 * Tiny assert-based self-check for the face-tracking crop math. No framework.
 * Run: `node remotion/src/lib/reframe.selfcheck.ts` (Node >= 22.18 strips the types; 22.6-22.17 need --experimental-strip-types).
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

// 4. A track that spans a scene cut must not blend the two shots' zoom.
//    Wide shot (small face) for the first half, close-up (big face) after.
//    Each clip gets its OWN zoom, and each matches a track holding only its
//    own shot — i.e. the other scene contributes nothing.
const acrossACut: FaceTrack = {
  id: 2,
  samples: Array.from({ length: 80 }, (_, i) => {
    const h = i < 60 ? 0.08 : 0.30; // 60 wide samples, then 20 close-up ones
    return { frame: i * 5, x: 0.5 - 0.05, y: 0.3, w: h * 0.55, h };
  }),
};
const wideOnly: FaceTrack = { id: 3, samples: acrossACut.samples.slice(0, 60) };
const closeOnly: FaceTrack = { id: 4, samples: acrossACut.samples.slice(60) };

const wideClip = { from: 0, to: 300 };
const closeClip = { from: 300, to: 400 };
const cropIn = (t: FaceTrack, frame: number, range?: { from: number; to: number }) => {
  const face = smoothedFaceRect(t, frame, range);
  assert.ok(face, `no face at frame ${frame}`);
  return cropForFace(face, PANEL_ASPECT, SRC_W, SRC_H);
};

const wideCrop = cropIn(acrossACut, 100, wideClip);
const closeCrop = cropIn(acrossACut, 350, closeClip);
assert.notStrictEqual(wideCrop.h, closeCrop.h, "both shots got the same zoom");
// The far edges of each clip are outside the other shot's reach, so the
// per-clip median there must equal a track containing only that shot.
assert.strictEqual(wideCrop.h, cropIn(wideOnly, 100).h, "wide shot pulled in the close-up");
assert.strictEqual(closeCrop.h, cropIn(closeOnly, 390).h, "close-up pulled in the wide shot");

// 4b. POSITION must not blend across the cut either. Subject on the left in
//     scene one, on the right in scene two: the new shot has to open framed on
//     the right, not somewhere between the two.
const movesAtCut: FaceTrack = {
  id: 5,
  samples: Array.from({ length: 80 }, (_, i) => ({
    frame: i * 5,
    x: i < 60 ? 0.12 : 0.72,
    y: 0.3,
    w: 0.1,
    h: 0.18,
  })),
};
const firstFrameOfScene2 = cropIn(movesAtCut, 300, closeClip);
const deepInScene2 = cropIn(movesAtCut, 390, closeClip);
assert.ok(
  Math.abs(firstFrameOfScene2.x - deepInScene2.x) < 0.01,
  "scene two opened framed between the two shots"
);

// 5. The proxy sizer's guarantee: render-service picks the SMALLEST sample in
//    [from-45, to+45) and assumes the renderer never crops tighter than that.
//    Only holds if the median looks at the same samples.
for (const range of [wideClip, closeClip, { from: 0, to: 400 }]) {
  const inWindow = acrossACut.samples.filter(
    (s) => s.frame >= range.from - 45 && s.frame < range.to + 45
  );
  const smallest = Math.min(...inWindow.map((s) => s.h));
  const midFrame = Math.floor((range.from + range.to) / 2);
  const used = smoothedFaceRect(acrossACut, midFrame, range);
  assert.ok(used, "no face mid-clip");
  assert.ok(
    used.h >= smallest,
    `median height ${used.h} is below the proxy's assumed floor ${smallest}`
  );
}

// 6. Gaps and misses behave: no samples in reach -> null -> caller center-crops.
assert.strictEqual(smoothedFaceRect(jittery, 100_000), null);
assert.strictEqual(smoothedFaceRect(undefined, 0), null);
const center = centerCrop(PANEL_ASPECT, SRC_W, SRC_H);
assert.ok(center.w > 0 && center.h > 0);

console.log("reframe.selfcheck: ok");
