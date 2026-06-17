import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  selectComposition,
  renderMedia,
  type X264Preset,
} from "@remotion/renderer";
import { getBundleLocation } from "./bundle.js";
import { renderJobs } from "./server.js";

// --- Render performance tuning (env-overridable) ---
// These knobs trade a little encode time / file size for throughput. Defaults
// are chosen to be safe for a *final* export (not a draft preview).

// Concurrency = number of parallel headless-Chrome tabs capturing frames.
// Remotion defaults to ~half the logical cores; using all cores roughly
// doubles frame throughput on a render-dedicated box. Override via
// RENDER_CONCURRENCY (integer) if the host is shared / memory-constrained.
const RENDER_CONCURRENCY: number = (() => {
  const raw = process.env.RENDER_CONCURRENCY;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Math.max(1, os.cpus().length);
})();

// x264 encoding preset. Remotion's default is "medium". A faster preset cuts
// encode time substantially.
// ponytail: defaulting to "faster" (one step quicker than medium) rather than
// "veryfast" — keeps file size/quality reasonable for a final export while
// still shaving encode time. Bump to "veryfast"/"ultrafast" via env if needed.
const RENDER_X264_PRESET = (process.env.RENDER_X264_PRESET ||
  "faster") as X264Preset;

// JPEG quality for frame capture (1-100). 80 is visually lossless for h264
// output, which recompresses anyway. Tunable via RENDER_JPEG_QUALITY.
const RENDER_JPEG_QUALITY: number = (() => {
  const parsed = parseInt(process.env.RENDER_JPEG_QUALITY || "", 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 100) return parsed;
  return 80;
})();

export interface RenderParams {
  renderId: string;
  jobId: string;
  clipIndex: number;
  props: {
    videoUrl: string;
    durationInFrames: number;
    fps: number;
    width: number;
    height: number;
    subtitles: unknown;
    hook: unknown;
    effects: unknown;
    sourceVideoUrl: string | null;
    framing: unknown;
  };
}

/**
 * Executes a Remotion render in the background.
 * Updates the in-memory render job map with progress and final status.
 */
export async function executeRender(params: RenderParams): Promise<void> {
  const { renderId, jobId, clipIndex, props } = params;
  const job = renderJobs.get(renderId);

  if (!job) {
    console.error(`[render-worker] Job ${renderId} not found in map`);
    return;
  }

  try {
    job.status = "rendering";
    job.progress = 0;

    console.log(
      `[render-worker] Starting render ${renderId} (job=${jobId}, clip=${clipIndex})`
    );

    const bundleLocation = getBundleLocation();

    // Select the composition with the provided input props
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: "ShortVideo",
      inputProps: props,
    });

    // Determine output directory and file path
    const outputDir = process.env.OUTPUT_DIR
      ? path.resolve(process.env.OUTPUT_DIR)
      : path.resolve(import.meta.dirname, "../../output");

    const jobOutputDir = path.join(outputDir, jobId);
    fs.mkdirSync(jobOutputDir, { recursive: true });

    const timestamp = Date.now();
    const outputFileName = `remotion_${clipIndex}_${timestamp}.mp4`;
    const outputLocation = path.join(jobOutputDir, outputFileName);

    console.log(`[render-worker] Output: ${outputLocation}`);
    console.log(
      `[render-worker] Render opts: concurrency=${RENDER_CONCURRENCY}, ` +
        `x264Preset=${RENDER_X264_PRESET}, imageFormat=jpeg(${RENDER_JPEG_QUALITY})`
    );

    // Render the video
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      crf: 22,
      outputLocation,
      // Parallel frame capture across CPU cores (see RENDER_CONCURRENCY above).
      concurrency: RENDER_CONCURRENCY,
      // ponytail: capture frames as JPEG instead of the PNG default. PNG is
      // lossless but slow to encode per-frame; since h264 recompresses the
      // frames anyway, JPEG@80 is the standard speed win with no visible loss.
      imageFormat: "jpeg",
      jpegQuality: RENDER_JPEG_QUALITY,
      // Faster x264 preset than the "medium" default (see RENDER_X264_PRESET).
      x264Preset: RENDER_X264_PRESET,
      onProgress: ({ progress }) => {
        const percent = Math.round(progress * 100);
        job.progress = percent;

        if (percent % 10 === 0) {
          console.log(`[render-worker] ${renderId} progress: ${percent}%`);
        }
      },
    });

    // Success
    job.status = "done";
    job.progress = 100;
    job.outputUrl = outputLocation;

    console.log(`[render-worker] Render ${renderId} completed: ${outputLocation}`);
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);

    console.error(`[render-worker] Render ${renderId} failed:`, err);
  }
}
