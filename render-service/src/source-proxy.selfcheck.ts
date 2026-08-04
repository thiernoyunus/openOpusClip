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
    clips: [{ layout: "fill", cameraKeyframes: [{ w: 81 / 256, h: 1 }] }],
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

// Crops are NOT always aspect-locked to their panel, so the narrow axis can be
// the binding one. Sizing on height alone silently starved these of width.
{
  // A full-height but very narrow crop: height says 1920, width says
  // (1080/0.1)/1.778 = 6075. Width must win.
  const r = requiredSourceSize({
    ...base,
    clips: [{ layout: "fill", cameraKeyframes: [{ w: 0.1, h: 1 }] }],
  })!;
  assert.strictEqual(r.height, 6075, `fill/narrow crop -> ${r.height}`);
  assert.ok(r.width >= 10800, `fill/narrow crop width -> ${r.width}`);
}
{
  // Real shape from a saved project: a pinned screenshare tile whose aspect is
  // ~33% off its 1080x768 panel.
  const r = requiredSourceSize({
    ...base,
    clips: [{ layout: "screenshare", panelCrops: [null, { w: 0.25, h: 0.4 }] }],
  })!;
  const byHeight = 768 / 0.4; // 1920
  const byWidth = 1080 / 0.25 / (3840 / 2160); // 2430
  assert.strictEqual(r.height, Math.ceil(Math.max(byHeight, byWidth)), `pinned screenshare tile -> ${r.height}`);
}
{
  // "four" panels are half-width, so the width term uses 540, not 1080.
  const r = requiredSourceSize({
    ...base,
    clips: [{ layout: "four", panelCrops: [{ w: 0.25, h: 0.9 }, null, null, null] }],
  })!;
  const expected = Math.ceil(Math.max(960 / 0.9, 540 / 0.25 / (3840 / 2160)));
  assert.strictEqual(r.height, expected, `four/pinned tile -> ${r.height}`);
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
    segments: [{ layout: "fill", cameraKeyframes: [{ w: 81 / 256, h: 1 }] }],
  })!;
  assert.strictEqual(r.height, 1920, `v2 segments -> ${r.height}`);
}

// The tightest clip in a mixed timeline wins.
{
  const r = requiredSourceSize({
    ...base,
    clips: [
      { layout: "fit" },
      { layout: "fill", cameraKeyframes: [{ w: 81 / 256, h: 1 }] },
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
    clips: [{ layout: "fit", manualCrop: { w: 81 / 512, h: 0.5 } }],
  })!;
  assert.strictEqual(r.height, 3840, `manualCrop -> ${r.height}`);
}

// No source dimensions => no opinion (caller keeps the original).
assert.strictEqual(requiredSourceSize({ clips: [] }), null);

console.log("source-proxy self-check: ok");
