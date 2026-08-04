import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RenderInternals } from "@remotion/renderer";

/**
 * Makes a smaller stand-in ("proxy") of the source video when the export can't
 * use all of its pixels anyway.
 *
 * Why: the renderer draws every frame in a headless browser, which decodes the
 * source in software. A 4K source therefore costs ~4x a 1080p one *per frame*,
 * even though the finished short is only 1080x1920 and most layouts shrink the
 * footage further. Handing the renderer a right-sized file is the single
 * biggest export-speed win available.
 *
 * This never trades quality for speed: the proxy is only ever as small as the
 * tightest crop in the timeline can tolerate without upscaling more than the
 * current code already would. If the source is already that small, nothing
 * happens.
 */

/** Crop rect in normalized (0-1) source coordinates. */
interface Crop {
  w: number;
  h: number;
}

interface ClipLike {
  layout?: string;
  manualCrop?: Crop | null;
  cameraKeyframes?: Crop[] | null;
  panelCrops?: (Crop | null)[] | null;
  trackedFaceIds?: number[] | null;
  sourceStart?: number;
  sourceEnd?: number;
  /** v1/v2 framings name the same range fields differently. */
  startFrame?: number;
  endFrame?: number;
}

interface FramingLike {
  source?: { width?: number; height?: number };
  outputWidth?: number;
  outputHeight?: number;
  clips?: ClipLike[];
  /** v1/v2 framings (written by main.py) use `segments`. */
  segments?: ClipLike[];
  faceTracks?: Array<{
    id?: number;
    samples?: Array<{ frame?: number; h?: number }>;
  }> | null;
}

/** One panel of a layout: its height as a fraction of the canvas. */
interface Panel {
  hFrac: number;
  /** Screen/gameplay capture: shows the whole frame, never a face crop. */
  content?: boolean;
}

/**
 * Panel grid per layout, as canvas fractions. Mirrors panelsForLayout() in
 * remotion/src/compositions/ReframedVideo.tsx — keep the two in step.
 */
const panelsForLayout = (layout: string | undefined): Panel[] => {
  switch (layout) {
    case "split":
      return [{ hFrac: 1 / 2 }, { hFrac: 1 / 2 }];
    case "three":
      return [{ hFrac: 1 / 3 }, { hFrac: 1 / 3 }, { hFrac: 1 / 3 }];
    case "four":
      return [
        { hFrac: 1 / 2 },
        { hFrac: 1 / 2 },
        { hFrac: 1 / 2 },
        { hFrac: 1 / 2 },
      ];
    case "screenshare":
      return [{ hFrac: 0.6, content: true }, { hFrac: 0.4 }];
    case "gameplay":
      return [{ hFrac: 0.3 }, { hFrac: 0.7, content: true }];
    default:
      return [{ hFrac: 1 }];
  }
};

/**
 * Fraction of the source height a face crop covers, mirroring cropForFace():
 * the crop is sized from the FACE (face fills ~35% of it), clamped to 30-100%
 * of frame height. Small faces therefore need a *lot* more source than the
 * frame suggests — this is the number that makes or breaks the quality claim.
 */
const faceCropHeight = (
  framing: FramingLike,
  clip: ClipLike,
  panelIndex: number
): number => {
  const trackId = clip.trackedFaceIds?.[panelIndex];
  const track =
    trackId == null
      ? undefined
      : (framing.faceTracks ?? []).find((t) => t.id === trackId);
  // No track: the renderer falls back to a full-height center crop.
  if (!track?.samples?.length) return 1;

  const from = clip.sourceStart ?? clip.startFrame ?? -Infinity;
  const to = clip.sourceEnd ?? clip.endFrame ?? Infinity;
  let smallest = Infinity;
  for (const s of track.samples) {
    const f = s.frame ?? 0;
    if (f < from || f >= to) continue;
    if (typeof s.h === "number" && s.h > 0) smallest = Math.min(smallest, s.h);
  }
  if (!Number.isFinite(smallest)) return 1;

  // cropForFace: clamp(faceH / 0.35, 0.3, 1)
  return Math.max(0.3, Math.min(1, smallest / 0.35));
};

/**
 * Smallest source size that still feeds every crop in the timeline at full
 * resolution — i.e. the size below which the export would start looking softer
 * than it does today. Returns null when the framing doesn't say how big the
 * source is.
 */
export const requiredSourceSize = (
  framing: FramingLike
): { width: number; height: number } | null => {
  const srcW = framing.source?.width;
  const srcH = framing.source?.height;
  if (!srcW || !srcH) return null;

  const outW = framing.outputWidth ?? 1080;
  const outH = framing.outputHeight ?? 1920;
  const srcAspect = srcW / srcH;

  // Every layout draws the whole frame somewhere at no more than canvas width.
  let neededH = outW / srcAspect;

  // Non-9:16 outputs skip the panel machinery entirely: RangeContent draws one
  // full-canvas crop regardless of the clip's layout.
  const is916 = Math.abs(outW / outH - 9 / 16) < 0.01;

  const clips = framing.clips?.length
    ? framing.clips
    : framing.segments ?? [];

  for (const clip of clips) {
    // A manual crop wins over the layout and covers the whole canvas.
    if (clip.manualCrop) {
      neededH = Math.max(neededH, outH / Math.max(clip.manualCrop.h || 1, 0.01));
      continue;
    }

    if (!is916) {
      neededH = Math.max(neededH, outH / faceCropHeight(framing, clip, 0));
      continue;
    }

    if (clip.layout === "fit") continue; // whole frame — the floor covers it

    if (clip.layout === "fill") {
      const cropH = (clip.cameraKeyframes ?? []).reduce(
        (m, c) => Math.min(m, c.h || 1),
        1
      );
      neededH = Math.max(neededH, outH / Math.max(cropH, 0.01));
      continue;
    }

    panelsForLayout(clip.layout).forEach((panel, i) => {
      const pinned = clip.panelCrops?.[i] ?? null;
      // Un-pinned content panels show the whole frame contained in the panel,
      // so they never need more than the floor already guarantees.
      if (panel.content && !pinned) return;
      const cropH = pinned
        ? pinned.h || 1
        : faceCropHeight(framing, clip, i);
      neededH = Math.max(
        neededH,
        (outH * panel.hFrac) / Math.max(cropH, 0.01)
      );
    });
  }

  return {
    width: Math.ceil(neededH * srcAspect),
    height: Math.ceil(neededH),
  };
};

/** ffmpeg needs even dimensions for yuv420p. */
const even = (n: number): number => (n % 2 === 0 ? n : n + 1);

/** Distinguishes concurrent temp files within one process. */
let proxySeq = 0;

const runFfmpeg = async (args: string[]): Promise<void> => {
  const proc = RenderInternals.callFf({
    bin: "ffmpeg",
    args,
    indent: false,
    logLevel: "error",
    binariesDirectory: null,
    cancelSignal: undefined,
  });
  await proc;
};

/**
 * Returns a URL to use in place of `sourceUrl` — either a cached proxy or the
 * original, unchanged. Never throws: a proxy is an optimization, so any failure
 * falls back to the original source.
 */
export async function ensureSourceProxy(opts: {
  sourceUrl: string;
  framing: unknown;
  outputDir: string;
}): Promise<string> {
  const { sourceUrl, framing, outputDir } = opts;
  try {
    const f = framing as FramingLike | null;
    if (!f) return sourceUrl;

    const needed = requiredSourceSize(f);
    const srcW = f.source?.width ?? 0;
    const srcH = f.source?.height ?? 0;
    if (!needed || !srcW || !srcH) return sourceUrl;

    // Under a 15% linear margin the re-encode costs more than it saves.
    if (srcH <= needed.height * 1.15) return sourceUrl;

    const rel = sourceUrl.match(/\/output\/(.+)$/)?.[1];
    if (!rel) return sourceUrl;
    const localPath = path.join(outputDir, decodeURIComponent(rel));
    if (!fs.existsSync(localPath)) return sourceUrl;

    const w = even(needed.width);
    const h = even(needed.height);
    const proxyPath = localPath.replace(/\.mp4$/i, "") + `.proxy${h}.mp4`;

    const fresh =
      fs.existsSync(proxyPath) &&
      fs.statSync(proxyPath).mtimeMs >= fs.statSync(localPath).mtimeMs &&
      fs.statSync(proxyPath).size > 0;

    if (!fresh) {
      const started = Date.now();
      console.log(
        `[source-proxy] ${srcW}x${srcH} -> ${w}x${h}  (${path.basename(localPath)})`
      );
      // Encode to a private temp file and rename into place. Rename is atomic,
      // so a killed render can never leave a half-written proxy that later
      // looks complete, and two renders of the same source can't interleave
      // writes into one file.
      // Keeps the .mp4 suffix — ffmpeg picks the container from the extension.
      const tmpPath = `${proxyPath}.tmp-${process.pid}-${proxySeq++}.mp4`;
      const common = [
        "-y",
        "-i",
        localPath,
        "-vf",
        `scale=${w}:${h}`,
        // 1-second keyframe interval: the renderer decodes from several
        // starting points at once, and a tight GOP makes each seek cheap.
        "-g",
        "30",
        "-c:a",
        "copy",
      ];
      try {
        try {
          if (os.platform() !== "darwin") throw new Error("no videotoolbox");
          await runFfmpeg([
            ...common,
            "-c:v",
            "h264_videotoolbox",
            "-b:v",
            "12M",
            tmpPath,
          ]);
        } catch {
          // No hardware encoder (or it refused this input) — software is
          // slower but always present in the bundled ffmpeg.
          await runFfmpeg([
            ...common,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            tmpPath,
          ]);
        }
        fs.renameSync(tmpPath, proxyPath);
      } finally {
        fs.rmSync(tmpPath, { force: true });
      }
      console.log(
        `[source-proxy] built in ${((Date.now() - started) / 1000).toFixed(1)}s`
      );
    }

    return sourceUrl.replace(/\/output\/.+$/, "") +
      "/output/" +
      path
        .relative(outputDir, proxyPath)
        .split(path.sep)
        .map(encodeURIComponent)
        .join("/");
  } catch (err) {
    console.error("[source-proxy] skipped (falling back to original):", err);
    return sourceUrl;
  }
}
