// Run with: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_SLICES,
  MIN_LAST_SLICE_FRAMES,
  isSafeForStitching,
  makeSliceDir,
  pickSliceFrames,
} from "../src/slicing.js";

test("slice temp folder never contains an apostrophe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slicing-test-"));
  const quoted = path.join(root, "O'Neil");
  const plain = path.join(root, "plain");
  fs.mkdirSync(quoted);
  fs.mkdirSync(plain);
  try {
    const dir = makeSliceDir("", [quoted, plain]);
    assert.ok(dir && dir.startsWith(plain), `got ${dir}`);
    assert.ok(isSafeForStitching(dir));
    assert.equal(makeSliceDir("", [quoted, "a|b"]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("last slice is never tiny and slices stay under the cap", () => {
  // 361 frames with 8 slices of 90 used to end in a 1-frame slice.
  assert.notEqual(361 % pickSliceFrames(361, 90), 1);
  for (let total = 90; total <= 4000; total++) {
    for (const target of [90, 120, 240, 451]) {
      const f = pickSliceFrames(total, target);
      const slices = Math.ceil(total / f);
      const last = total - (slices - 1) * f;
      assert.ok(f >= target, `total=${total} target=${target}`);
      assert.ok(last >= Math.min(f, MIN_LAST_SLICE_FRAMES, total), `total=${total} f=${f} last=${last}`);
    }
  }
  // 75 minutes at 30fps still fits in MAX_SLICES.
  const long = 75 * 60 * 30;
  assert.ok(Math.ceil(long / pickSliceFrames(long, 240)) <= MAX_SLICES);
});
