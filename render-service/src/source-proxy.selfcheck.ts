/**
 * Self-check for the proxy sizing rule. Run with:
 *   npx tsx src/source-proxy.selfcheck.ts
 *
 * The rule must never ask for fewer pixels than a crop actually consumes —
 * that would make exports softer than they are today. Every case below is one
 * where an earlier version of this file got that wrong.
 */
import assert from "node:assert";
import { requiredSourceSize } from "./source-proxy.js";

const base = {
  source: { width: 3840, height: 2160 },
  outputWidth: 1080,
  outputHeight: 1920,
};

/** A face track whose smallest sampled face is `h` of the frame height. */
const track = (id: number, h: number) => ({
  id,
  samples: [{ frame: 0, h }, { frame: 100, h: h + 0.05 }],
});

// Whole frame only ("fit"): needs just enough to draw the frame at canvas width.
{
  const r = requiredSourceSize({ ...base, clips: [{ layout: "fit" }] })!;
  assert.strictEqual(r.height, 608, `fit -> ${r.height}`);
}

// Full-height 9:16 crop out of a 16:9 frame needs the full canvas height.
{
  const r = requiredSourceSize({
    ...base,
    clips: [{ layout: "fill", cameraKeyframes: [{ w: 0.3164, h: 1 }] }],
  })!;
  assert.strictEqual(r.height, 1920, `fill/full-height -> ${r.height}`);
  assert.strictEqual(r.width, 3414, `fill/full-height width -> ${r.width}`);
}

// A "fill" clip zoomed into half the frame height needs twice the source.
{
  const r = requiredSourceSize({
    ...base,
    clips: [{ layout: "fill", cameraKeyframes: [{ w: 0.16, h: 0.5 }] }],
  })!;
  assert.strictEqual(r.height, 3840, `fill/zoomed -> ${r.height}`);
}

// Face panels are sized from the FACE, not the frame. A small tracked face
// makes the crop window small, so the source requirement goes UP, not down.
// (Assuming a full-height crop here is what silently softened real exports.)
{
  const small = requiredSourceSize({
    ...base,
    faceTracks: [track(0, 0.098)], // cropForFace clamps to 0.3 of frame height
    clips: [{ layout: "screenshare", trackedFaceIds: [null as never, 0] }],
  })!;
  assert.strictEqual(small.height, 2560, `screenshare/small face -> ${small.height}`); // 0.4*1920 / 0.3

  const big = requiredSourceSize({
    ...base,
    faceTracks: [track(0, 0.5)], // 0.5/0.35 > 1 -> full-height crop
    clips: [{ layout: "screenshare", trackedFaceIds: [null as never, 0] }],
  })!;
  assert.strictEqual(big.height, 768, `screenshare/big face -> ${big.height}`);
}

// No face track at all -> renderer center-crops full height.
{
  const r = requiredSourceSize({ ...base, clips: [{ layout: "split" }] })!;
  assert.strictEqual(r.height, 960, `split/untracked -> ${r.height}`);
}

// A pinned per-tile crop overrides tracking and can be very tight.
{
  const r = requiredSourceSize({
    ...base,
    clips: [{ layout: "split", panelCrops: [{ w: 0.2, h: 0.2 }, null] }],
  })!;
  assert.strictEqual(r.height, 4800, `split/pinned tile -> ${r.height}`); // 960 / 0.2
}

// Non-9:16 output ignores the layout and draws one full-canvas face crop.
{
  const r = requiredSourceSize({
    ...base,
    outputHeight: 1080, // 1:1
    faceTracks: [track(0, 0.098)],
    clips: [{ layout: "fit", trackedFaceIds: [0] }],
  })!;
  assert.strictEqual(r.height, 3600, `1:1 output -> ${r.height}`); // 1080 / 0.3
}

// v1/v2 framings store the timeline under `segments`, not `clips`.
{
  const r = requiredSourceSize({
    ...base,
    segments: [{ layout: "fill", cameraKeyframes: [{ w: 0.3164, h: 1 }] }],
  })!;
  assert.strictEqual(r.height, 1920, `v2 segments -> ${r.height}`);
}

// The tightest clip in a mixed timeline wins.
{
  const r = requiredSourceSize({
    ...base,
    clips: [
      { layout: "fit" },
      { layout: "fill", cameraKeyframes: [{ w: 0.3164, h: 1 }] },
    ],
  })!;
  assert.strictEqual(r.height, 1920, `mixed -> ${r.height}`);
}

// Unknown layouts must fall back to the conservative full-canvas requirement.
{
  const r = requiredSourceSize({ ...base, clips: [{ layout: "brand-new" }] })!;
  assert.strictEqual(r.height, 1920, `unknown layout -> ${r.height}`);
}

// A manual crop always covers the whole canvas regardless of layout.
{
  const r = requiredSourceSize({
    ...base,
    clips: [{ layout: "fit", manualCrop: { w: 0.3164, h: 0.5 } }],
  })!;
  assert.strictEqual(r.height, 3840, `manualCrop -> ${r.height}`);
}

// No source dimensions => no opinion (caller keeps the original).
assert.strictEqual(requiredSourceSize({ clips: [] }), null);

console.log("source-proxy self-check: ok");
