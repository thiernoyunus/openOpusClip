/**
 * Tiny assert-based self-check for the EDL clip math. No framework.
 * Run: `node remotion/src/lib/edl.selfcheck.ts` (Node >= 22 strips the types).
 */
import assert from "node:assert";
import {
  framingToClips,
  keptRanges,
  toOutputFrames,
  placedClips,
  outputDurationFrames,
  outputToSource,
  wordSourceToOutput,
  sourceToOutputAll,
  sourceRangeToOutputWindows,
  remapCaptions,
} from "./edl.ts";
import type { FramingConfig, CaptionWord } from "./types.ts";

const source = { file: "x.mp4", fps: 30, width: 1920, height: 1080, durationFrames: 300 };

// --- Fixture A: v2 (segments + a cut). fps == output fps so frames map 1:1. ---
const v2: FramingConfig = {
  version: 2,
  source,
  faceTracks: [],
  clipInFrame: 0,
  clipOutFrame: 300,
  captionsOriginFrame: 0,
  cuts: [{ startFrame: 100, endFrame: 150 }],
  segments: [
    { id: "seg-0", startFrame: 0, endFrame: 120, layout: "fill", trackedFaceIds: [], cameraKeyframes: [], manualCrop: null },
    { id: "seg-1", startFrame: 120, endFrame: 300, layout: "fit", trackedFaceIds: [], cameraKeyframes: [], manualCrop: null },
  ],
};
const FPS = 30;

// migration: v2 -> clips, split at cut + segment boundaries, source-ordered
const clips = framingToClips(v2);
assert.deepStrictEqual(
  clips.map((c) => [c.sourceStart, c.sourceEnd, c.layout]),
  [[0, 100, "fill"], [150, 300, "fit"]],
  "framingToClips(v2) should drop the cut and split at the segment boundary"
);

// outputDurationFrames == independent sum over kept ranges
const expectedDur = keptRanges(v2).reduce(
  (a, r) => a + toOutputFrames(r.endFrame - r.startFrame, source.fps, FPS),
  0
);
assert.strictEqual(outputDurationFrames(v2, FPS), expectedDur, "duration must equal kept-range sum");
assert.strictEqual(outputDurationFrames(v2, FPS), 250, "100 + 150 kept frames");

// placedClips: back-to-back, no gaps/overlaps, total == duration
const placed = placedClips(v2, FPS);
let cursor = 0;
for (const p of placed) {
  assert.strictEqual(p.outStart, cursor, "no gap/overlap between placed clips");
  cursor += p.outDuration;
}
assert.strictEqual(cursor, outputDurationFrames(v2, FPS), "placed clips sum to total duration");

// outputToSource: out 120 lands inside clip1 (out[100,250) -> source[150,300))
assert.strictEqual(outputToSource(v2, 120, FPS), 170, "out 120 -> source 170");
// a frame inside the cut is removed
assert.deepStrictEqual(sourceToOutputAll(v2, 120, FPS), [], "cut frame maps to no output");
// word mapping uses the midpoint's owning clip; end ON the clip boundary stays in-clip
assert.deepStrictEqual(
  wordSourceToOutput(v2, 90, 100, FPS),
  { outStart: 90, outEnd: 100 },
  "word ending on clip0's boundary maps within clip0 (not snapped past it)"
);
assert.strictEqual(wordSourceToOutput(v2, 110, 130, FPS), null, "word in the cut maps to null");

// captions: keep words in clips, drop the one whose midpoint was cut
const captions: CaptionWord[] = [
  { text: "a", startMs: (10 / 30) * 1000, endMs: (20 / 30) * 1000 }, // mid src 15 -> clip0
  { text: "b", startMs: (110 / 30) * 1000, endMs: (130 / 30) * 1000 }, // mid src 120 -> CUT -> dropped
  { text: "c", startMs: (160 / 30) * 1000, endMs: (180 / 30) * 1000 }, // mid src 170 -> clip1
];
const remapped = remapCaptions(captions, v2, FPS);
assert.deepStrictEqual(remapped.map((w) => w.text), ["a", "c"], "cut word dropped");
// "c" shifts from source 160 -> output 110 (clip1 starts at out 100, source 150)
assert.ok(Math.abs(remapped[1].startMs - (110 / 30) * 1000) < 1, "c remapped onto output timeline");

// sourceRangeToOutputWindows: source [50,200] spans clip0 and clip1
const wins = sourceRangeToOutputWindows(v2, 50, 200, FPS);
assert.deepStrictEqual(
  wins,
  [
    { outStart: 50, outEnd: 100, srcStart: 50, srcEnd: 100 },
    { outStart: 100, outEnd: 150, srcStart: 150, srcEnd: 200 },
  ],
  "overlay/b-roll spanning two clips yields two windows carrying their source overlap"
);

// --- Fixture B: v3 reorder (later source plays first) ---
const reordered: FramingConfig = {
  version: 3,
  source,
  faceTracks: [],
  captionsOriginFrame: 0,
  clips: [
    { id: "x", sourceStart: 150, sourceEnd: 180, layout: "fit", trackedFaceIds: [], cameraKeyframes: [], manualCrop: null },
    { id: "y", sourceStart: 0, sourceEnd: 30, layout: "fill", trackedFaceIds: [], cameraKeyframes: [], manualCrop: null },
  ],
};
const capB: CaptionWord[] = [
  { text: "early", startMs: (5 / 30) * 1000, endMs: (10 / 30) * 1000 }, // src ~7 -> clip y (plays 2nd)
  { text: "late", startMs: (160 / 30) * 1000, endMs: (165 / 30) * 1000 }, // src ~162 -> clip x (plays 1st)
];
const remapB = remapCaptions(capB, reordered, FPS);
assert.deepStrictEqual(remapB.map((w) => w.text), ["late", "early"], "reorder: late source word plays first");

// --- Fixture C: v3 duplicate (same source range twice) ---
const dup: FramingConfig = {
  version: 3,
  source,
  faceTracks: [],
  captionsOriginFrame: 0,
  clips: [
    { id: "a", sourceStart: 0, sourceEnd: 30, layout: "fill", trackedFaceIds: [], cameraKeyframes: [], manualCrop: null },
    { id: "b", sourceStart: 0, sourceEnd: 30, layout: "fill", trackedFaceIds: [], cameraKeyframes: [], manualCrop: null },
  ],
};
const capC: CaptionWord[] = [{ text: "twice", startMs: (10 / 30) * 1000, endMs: (15 / 30) * 1000 }];
const remapC = remapCaptions(capC, dup, FPS);
assert.deepStrictEqual(remapC.map((w) => w.text), ["twice", "twice"], "duplicated clip emits the word twice");
assert.strictEqual(sourceToOutputAll(dup, 10, FPS).length, 2, "duplicated source frame -> two output frames");

console.log("edl.selfcheck: all assertions passed ✓");
