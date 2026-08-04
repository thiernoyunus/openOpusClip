import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { initBundle } from "./bundle.js";
import { executeRender } from "./render-worker.js";

// --- Render status types ---

export type RenderStatus = "queued" | "rendering" | "done" | "error";

export interface RenderJob {
  renderId: string;
  jobId: string;
  clipIndex: number;
  status: RenderStatus;
  progress: number;
  outputUrl?: string;
  error?: string;
}

// In-memory render job map
export const renderJobs = new Map<string, RenderJob>();

// --- Render queue ---
// Each render spins up headless Chrome × RENDER_CONCURRENCY tabs, so unlimited
// parallel renders OOM laptops. Cap concurrent renders; extras wait as "queued".
const MAX_RENDER_JOBS = Math.max(
  1,
  parseInt(process.env.MAX_RENDER_JOBS || "1", 10) || 1
);
let activeRenders = 0;
const renderQueue: Array<() => Promise<void>> = [];

function enqueueRender(task: () => Promise<void>): void {
  renderQueue.push(task);
  drainRenderQueue();
}

function drainRenderQueue(): void {
  while (activeRenders < MAX_RENDER_JOBS && renderQueue.length > 0) {
    const task = renderQueue.shift()!;
    activeRenders++;
    // Promise.resolve().then() converts a synchronous throw into a rejection,
    // so the slot is always released.
    Promise.resolve()
      .then(task)
      .catch((err) => console.error("[render] queue task error:", err))
      .finally(() => {
        activeRenders--;
        drainRenderQueue();
      });
  }
}

// --- Request validation schema ---

const renderRequestSchema = z.object({
  jobId: z.string().min(1),
  clipIndex: z.number().int().min(0),
  props: z.object({
    videoUrl: z.string(),
    durationInFrames: z.number().int().positive(),
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    subtitles: z.any().nullable().optional(),
    hook: z.any().nullable().optional(),
    effects: z.any().nullable().optional(),
    sourceVideoUrl: z.string().nullable().optional(),
    framing: z.any().nullable().optional(),
  }),
});

// --- Express app ---

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = parseInt(process.env.PORT || "3100", 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/output";

// Serve video files from the shared output volume so Remotion can access them via HTTP.
// The CORS header is required: @remotion/media decodes video with WebCodecs, which
// fetches the file from the render page's origin. Without it the fetch is blocked and
// the renderer silently falls back to a much slower decode path.
// Only the local render page needs this, so echo loopback origins rather than
// sending "*" — otherwise any site the user visits could read their videos
// from this port.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

app.use(
  "/output",
  (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && LOOPBACK_ORIGIN.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    next();
  },
  express.static(OUTPUT_DIR)
);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Submit a render job
app.post("/render", (req, res) => {
  const parsed = renderRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  const { jobId, clipIndex, props } = parsed.data;
  const renderId = uuidv4();

  const job: RenderJob = {
    renderId,
    jobId,
    clipIndex,
    status: "queued",
    progress: 0,
  };

  renderJobs.set(renderId, job);

  console.log(
    `[render] Queued render ${renderId} for job=${jobId} clip=${clipIndex}`
  );

  // Resolve video URLs: convert frontend/backend URLs to renderer's own static server
  // The renderer serves /output/* from the shared Docker volume
  const resolveUrl = (url: string): string => {
    const match = url.match(/\/videos\/([^/]+)\/(.+)$/);
    if (!match) return url;
    const resolved = `http://localhost:${PORT}/output/${match[1]}/${match[2]}`;
    console.log(`[render] Resolved video URL: ${url} -> ${resolved}`);
    return resolved;
  };
  const resolvedVideoUrl = resolveUrl(props.videoUrl);
  const resolvedSourceVideoUrl = props.sourceVideoUrl
    ? resolveUrl(props.sourceVideoUrl)
    : null;

  // Nested framing assets (music, b-roll) are also stored as relative
  // /videos/... URLs and must be absolutized for the SSR renderer, otherwise
  // they resolve against the wrong host and are silently dropped on export.
  const resolvedFraming = props.framing
    ? {
        ...props.framing,
        music:
          props.framing.music &&
          typeof props.framing.music === "object" &&
          typeof props.framing.music.url === "string"
            ? { ...props.framing.music, url: resolveUrl(props.framing.music.url) }
            : props.framing.music,
        broll: Array.isArray(props.framing.broll)
          ? props.framing.broll.map((b: { url?: unknown }) =>
              b && typeof b.url === "string" ? { ...b, url: resolveUrl(b.url) } : b
            )
          : props.framing.broll,
        // Generic tracks (supersede music/broll) carry the same relative URLs.
        overlays: Array.isArray(props.framing.overlays)
          ? props.framing.overlays.map((o: { url?: unknown }) =>
              o && typeof o.url === "string" ? { ...o, url: resolveUrl(o.url) } : o
            )
          : props.framing.overlays,
        audio: Array.isArray(props.framing.audio)
          ? props.framing.audio.map((a: { url?: unknown }) =>
              a && typeof a.url === "string" ? { ...a, url: resolveUrl(a.url) } : a
            )
          : props.framing.audio,
      }
    : props.framing;

  // Queued render — runs in background when a slot frees up (MAX_RENDER_JOBS)
  enqueueRender(() =>
    executeRender({
      renderId,
      jobId,
      clipIndex,
      props: {
        videoUrl: resolvedVideoUrl,
        durationInFrames: props.durationInFrames,
        fps: props.fps,
        width: props.width,
        height: props.height,
        subtitles: props.subtitles ?? null,
        hook: props.hook ?? null,
        effects: props.effects ?? null,
        sourceVideoUrl: resolvedSourceVideoUrl,
        framing: resolvedFraming ?? null,
      },
    }).catch((err) => {
      console.error(`[render] Unhandled error for ${renderId}:`, err);
      const existingJob = renderJobs.get(renderId);
      if (existingJob) {
        existingJob.status = "error";
        existingJob.error =
          err instanceof Error ? err.message : "Unknown error";
      }
    })
  );

  res.status(202).json({ renderId, status: "queued" });
});

// Get render status
app.get("/render/:renderId", (req, res) => {
  const { renderId } = req.params;
  const job = renderJobs.get(renderId);

  if (!job) {
    res.status(404).json({ error: "Render not found" });
    return;
  }

  const response: Record<string, unknown> = {
    renderId: job.renderId,
    status: job.status,
  };

  if (job.progress !== undefined) {
    response.progress = job.progress;
  }
  if (job.outputUrl) {
    response.outputUrl = job.outputUrl;
  }
  if (job.error) {
    response.error = job.error;
  }

  res.json(response);
});

// --- Start server ---

async function main() {
  console.log("[render-service] Initializing Remotion bundle...");
  await initBundle();
  console.log("[render-service] Bundle ready.");

  app.listen(PORT, () => {
    console.log(`[render-service] Listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("[render-service] Fatal error during startup:", err);
  process.exit(1);
});
