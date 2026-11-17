/**
 * Export speed benchmark. Sends one clip to a RUNNING render service, exactly
 * like the app's Export button does, and prints how long it took.
 *
 *   node scripts/bench-export.mjs <job>/<file.mp4> [seconds] [layouts]
 *
 * <job>/<file.mp4> is relative to the service's OUTPUT_DIR. `layouts` is one or
 * two of fill,fit,split,... (default "fill,fit": half the clip each).
 * RENDER_URL overrides the service address (default http://127.0.0.1:3100).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const [rel, secondsArg, layoutsArg] = process.argv.slice(2);
const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!rel || !OUTPUT_DIR) {
  console.error("usage: OUTPUT_DIR=<service output dir> node scripts/bench-export.mjs <job>/<file.mp4> [seconds] [layouts]");
  process.exit(1);
}
const base = process.env.RENDER_URL || "http://127.0.0.1:3100";
const seconds = Number(secondsArg || 20);
const layouts = (layoutsArg || "fill,fit").split(",");

const probe = JSON.parse(
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,r_frame_rate", "-of", "json", path.join(OUTPUT_DIR, rel)]).toString()
).streams[0];
const [n, d] = probe.r_frame_rate.split("/").map(Number);
const srcFps = n / d;
const total = Math.round(seconds * srcFps);
const half = Math.round(total / 2);

const clip = (id, a, b, layout) => ({
  id, sourceStart: a, sourceEnd: b, layout,
  trackedFaceIds: [], cameraKeyframes: [], manualCrop: null,
});
const words = "this is a benchmark of the export path with captions on screen the whole time".split(" ");
const captions = Array.from({ length: Math.floor(seconds * 3) }, (_, i) => ({
  text: words[i % words.length], startMs: i * 333, endMs: i * 333 + 320,
}));

const body = {
  jobId: rel.split("/")[0],
  clipIndex: 0,
  props: {
    videoUrl: "", durationInFrames: seconds * 30, fps: 30, width: 1080, height: 1920,
    hook: null, effects: null,
    sourceVideoUrl: `/videos/${rel}`,
    subtitles: {
      captions, position: "bottom",
      style: { fontFamily: "Arial", fontSize: 52, fontColor: "#FFFFFF", highlightColor: "#FFDD00",
        borderColor: "#000000", borderWidth: 3, bgColor: "#000000", bgOpacity: 0, animation: "pop" },
    },
    framing: {
      version: 3,
      source: { file: path.basename(rel), fps: srcFps, width: probe.width, height: probe.height, durationFrames: total },
      faceTracks: [],
      clips: layouts.length === 1
        ? [clip("a", 0, total, layouts[0])]
        : [clip("a", 0, half, layouts[0]), clip("b", half, total, layouts[1])],
    },
  },
};

const t0 = Date.now();
const res = await fetch(`${base}/render`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
if (!res.ok) throw new Error(`render service said ${res.status}: ${await res.text()}`);
const { renderId } = await res.json();
for (;;) {
  await new Promise((r) => setTimeout(r, 250));
  const s = await (await fetch(`${base}/render/${renderId}`)).json();
  if (s.status === "error") throw new Error(s.error);
  if (s.status === "done") {
    const secs = (Date.now() - t0) / 1000;
    console.log(`${secs.toFixed(1)}s to export ${seconds}s of video [${layouts}] = ${(seconds / secs).toFixed(2)}x realtime -> ${s.outputUrl}`);
    break;
  }
}
