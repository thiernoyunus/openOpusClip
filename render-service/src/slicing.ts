import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pure helpers for cutting an export into slices, kept apart from the render
// worker so scripts/slicing.test.ts can check them without a browser.

// The final slice is whatever is left over. A tiny one (a single frame was
// seen) gets a timestamp that steps backwards once stitched, so slice sizes
// are nudged until the leftover is at least this long.
export const MIN_LAST_SLICE_FRAMES = 30;

// Upper bound on slices. The stitch step names every video slice in one
// ffmpeg command line, and Windows caps a command at 32,767 characters, so a
// very long export gets fewer, longer slices instead (120 slices of ~100
// characters each stays well inside it).
export const MAX_SLICES = 120;

// The stitch step writes slice paths into an ffmpeg list as 'path' (audio)
// and joins them with | (video) without escaping, so a folder with an
// apostrophe (e.g. a user called O'Neil) or a | breaks it.
export const isSafeForStitching = (p: string) => !/['|\r\n]/.test(p);

// Make the temporary folder for slices somewhere the stitch step can read.
// Returns null when no candidate works; the export then uses one browser.
export const makeSliceDir = (
  outputDir: string,
  candidates: (string | undefined)[] = [
    os.tmpdir(),
    outputDir,
    process.platform === "win32" ? process.env.PUBLIC : "/tmp",
  ]
): string | null => {
  for (const base of candidates) {
    if (!base || !isSafeForStitching(base)) continue;
    try {
      return fs.mkdtempSync(path.join(base, "openshorts-render-"));
    } catch {
      // not writable, try the next one
    }
  }
  return null;
};

// Pick an equal slice length close to `target` such that the leftover last
// slice is not tiny (see MIN_LAST_SLICE_FRAMES) and there are at most
// MAX_SLICES slices.
export const pickSliceFrames = (total: number, target: number): number => {
  const frames = Math.max(target, Math.ceil(total / MAX_SLICES));
  for (let f = frames; f < frames + MIN_LAST_SLICE_FRAMES * 4; f++) {
    const last = total - (Math.ceil(total / f) - 1) * f;
    if (last >= Math.min(f, MIN_LAST_SLICE_FRAMES)) return f;
  }
  return frames;
};
