import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  combineChunks,
  openBrowser,
  selectComposition,
  renderMedia,
  type OpenGlRenderer,
  type X264Preset,
} from "@remotion/renderer";
import { getBundleLocation } from "./bundle.js";
import { renderJobs } from "./server.js";
import { ensureSourceProxy } from "./source-proxy.js";

// --- Render performance tuning (env-overridable) ---
// These knobs trade a little encode time / file size for throughput. Defaults
// are chosen to be safe for a *final* export (not a draft preview).

// Concurrency = number of parallel headless-Chrome tabs capturing frames.
// Half the logical cores by default — all-cores roughly doubles throughput on
// a render-dedicated box but starves shared laptops. Set RENDER_CONCURRENCY
// (integer) to raise it on dedicated hardware.
const RENDER_CONCURRENCY: number = (() => {
  const raw = process.env.RENDER_CONCURRENCY;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Math.max(1, Math.floor(os.cpus().length / 2));
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

// Number of separate browsers drawing one export at the same time, each taking
// its own slice of the clip; the slices are stitched afterwards without
// re-encoding. This is the main speed lever: tabs inside ONE browser all funnel
// through that browser's single compositing thread, so adding tabs barely helps
// (measured: 1 tab 27s, 4 tabs 22s), while a second browser gets its own
// (measured: 24s -> 17s for a crop layout, 57s -> 32s for the blurred one, on
// 4 cores). Default: one per ~3 cores, at least 2 on a 4-core machine, max 4.
// RENDER_BROWSERS=1 restores the old single-browser render.
const RENDER_BROWSERS: number = (() => {
  const parsed = parseInt(process.env.RENDER_BROWSERS || "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const cores = os.cpus().length;
  return Math.max(cores >= 4 ? 2 : 1, Math.min(4, Math.floor(cores / 3)));
})();

// The clip is cut into more slices than there are browsers, and each browser
// takes the next unclaimed slice when it finishes one. Some stretches cost far
// more to draw than others (a blurred-background layout is ~2x a plain crop),
// so one-slice-per-browser leaves browsers idle while the unlucky one finishes.
const SLICES_PER_BROWSER = parseInt(process.env.RENDER_SLICES_PER_BROWSER || "", 10) || 3;

// Don't cut slices shorter than this — each has a small fixed cost (page
// load, encoder start) that a very short slice can't win back.
const MIN_FRAMES_PER_SLICE = 90;

// Chrome graphics backend ("angle", "vulkan", "swangle", ...). Unset = let
// Chrome decide.
const RENDER_GL = (process.env.RENDER_GL || null) as OpenGlRenderer | null;

// Pin a specific Chrome/Chromium binary instead of Remotion's downloaded one —
// e.g. a packaged app bundling its own browser. Unset = default behavior.
const RENDER_BROWSER_EXECUTABLE = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;

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

    // Determine output directory and file path
    const outputDir = process.env.OUTPUT_DIR
      ? path.resolve(process.env.OUTPUT_DIR)
      : path.resolve(import.meta.dirname, "../../output");

    // Swap in a right-sized copy of the source when the export can't use all
    // its pixels anyway (see source-proxy.ts). No-op when it already fits.
    const renderProps = props.sourceVideoUrl
      ? {
          ...props,
          sourceVideoUrl: await ensureSourceProxy({
            sourceUrl: props.sourceVideoUrl,
            framing: props.framing,
            outputDir,
          }),
        }
      : props;

    // Select the composition with the provided input props
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: "ShortVideo",
      inputProps: renderProps,
      browserExecutable: RENDER_BROWSER_EXECUTABLE,
    });

    const jobOutputDir = path.join(outputDir, jobId);
    fs.mkdirSync(jobOutputDir, { recursive: true });

    const timestamp = Date.now();
    const outputFileName = `remotion_${clipIndex}_${timestamp}.mp4`;
    const outputLocation = path.join(jobOutputDir, outputFileName);

    const total = composition.durationInFrames;
    const browsers = Math.max(
      1,
      Math.min(RENDER_BROWSERS, Math.floor(total / MIN_FRAMES_PER_SLICE))
    );
    // Tabs per browser: RENDER_CONCURRENCY is the budget for the whole export.
    const tabs = Math.max(1, Math.floor(RENDER_CONCURRENCY / browsers));
    // combineChunks needs equal-length slices (only the last may be shorter).
    const framesPerSlice = Math.max(
      MIN_FRAMES_PER_SLICE,
      Math.ceil(total / (browsers * SLICES_PER_BROWSER))
    );
    const sliceCount = Math.ceil(total / framesPerSlice);

    console.log(`[render-worker] Output: ${outputLocation}`);
    console.log(
      `[render-worker] Render opts: browsers=${browsers}, tabsPerBrowser=${tabs}, ` +
        `slices=${browsers === 1 ? 1 : sliceCount}, x264Preset=${RENDER_X264_PRESET}, ` +
        `gl=${RENDER_GL ?? "default"}, imageFormat=jpeg(${RENDER_JPEG_QUALITY})`
    );

    // Report how many frames are drawn, not Remotion's blended
    // drawing+encoding number. Drawing is nearly all of the wall time and
    // encoding finishes seconds later, so the blended figure crawled to ~80%
    // and then jumped straight to done — it read as if the export had been
    // cut short. Hold at 99% until the file is actually written.
    const drawn: number[] = new Array(sliceCount).fill(0);
    const reportProgress = (slice: number, renderedFrames: number) => {
      drawn[slice] = renderedFrames;
      const done = drawn.reduce((a, b) => a + b, 0);
      const percent =
        total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0;
      if (percent === job.progress) return;
      job.progress = percent;
      if (percent % 10 === 0) {
        console.log(`[render-worker] ${renderId} progress: ${percent}%`);
      }
    };

    const chromiumOptions = RENDER_GL ? { gl: RENDER_GL } : undefined;
    const common = {
      composition,
      serveUrl: bundleLocation,
      inputProps: renderProps,
      crf: 22,
      concurrency: tabs,
      // ponytail: capture frames as JPEG instead of the PNG default. PNG is
      // lossless but slow to encode per-frame; since h264 recompresses the
      // frames anyway, JPEG@80 is the standard speed win with no visible loss.
      imageFormat: "jpeg" as const,
      jpegQuality: RENDER_JPEG_QUALITY,
      // Faster x264 preset than the "medium" default (see RENDER_X264_PRESET).
      x264Preset: RENDER_X264_PRESET,
    };

    if (browsers === 1) {
      await renderMedia({
        ...common,
        codec: "h264",
        outputLocation,
        browserExecutable: RENDER_BROWSER_EXECUTABLE,
        chromiumOptions,
        onProgress: ({ renderedFrames }) => reportProgress(0, renderedFrames),
      });
    } else {
      // Each slice becomes an MPEG-TS video + a separate AAC file — the pair
      // of formats combineChunks can join byte-for-byte, with no re-encode and
      // no audible seam (forSeamlessAacConcatenation cuts the audio on AAC
      // frame boundaries).
      const sliceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openshorts-render-"));
      const videoFiles = Array.from({ length: sliceCount }, (_, i) =>
        path.join(sliceDir, `v${i}.ts`)
      );
      const audioFiles = Array.from({ length: sliceCount }, (_, i) =>
        path.join(sliceDir, `a${i}.aac`)
      );
      let nextSlice = 0;
      let failed = false;
      const runBrowser = async () => {
        const browser = await openBrowser("chrome", {
          browserExecutable: RENDER_BROWSER_EXECUTABLE,
          chromiumOptions,
        });
        try {
          while (!failed && nextSlice < sliceCount) {
            const i = nextSlice++;
            const from = i * framesPerSlice;
            await renderMedia({
              ...common,
              codec: "h264-ts",
              puppeteerInstance: browser,
              frameRange: [from, Math.min(total, from + framesPerSlice) - 1],
              outputLocation: videoFiles[i],
              separateAudioTo: audioFiles[i],
              forSeamlessAacConcatenation: true,
              enforceAudioTrack: true,
              onProgress: ({ renderedFrames }) => reportProgress(i, renderedFrames),
            });
          }
        } catch (err) {
          failed = true; // tell the other browsers to stop picking up slices
          throw err;
        } finally {
          await browser.close({ silent: true });
        }
      };
      try {
        // allSettled, not all: every browser must have stopped before the
        // temp folder is removed, even when one of them fails.
        const results = await Promise.allSettled(
          Array.from({ length: browsers }, runBrowser)
        );
        const rejected = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected"
        );
        if (rejected) throw rejected.reason;

        await combineChunks({
          outputLocation,
          videoFiles,
          audioFiles,
          codec: "h264",
          audioCodec: "aac",
          fps: composition.fps,
          framesPerChunk: framesPerSlice,
          compositionDurationInFrames: total,
          preferLossless: false,
        });
      } finally {
        fs.rmSync(sliceDir, { recursive: true, force: true });
      }
    }

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
