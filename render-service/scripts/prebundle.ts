import path from "node:path";
import { bundle } from "@remotion/bundler";

/**
 * Pre-builds the Remotion bundle at build time instead of at server startup.
 * Point the render service at the result via REMOTION_PREBUILT_BUNDLE so it
 * can skip bundling entirely (and avoid needing @remotion/bundler at all) —
 * useful for a read-only packaged app bundle.
 *
 * Uses the same entryPoint resolution and bundle() options as src/bundle.ts.
 *
 * Usage: tsx scripts/prebundle.ts [outDir]
 * outDir falls back to the REMOTION_PREBUILT_BUNDLE env var, then to
 * "dist/remotion-bundle".
 */
async function main(): Promise<void> {
  const outDir =
    process.argv[2] ||
    process.env.REMOTION_PREBUILT_BUNDLE ||
    path.resolve(import.meta.dirname, "../dist/remotion-bundle");

  const remotionRoot = process.env.REMOTION_BUNDLE_PATH
    ? path.resolve(process.env.REMOTION_BUNDLE_PATH)
    : path.resolve(import.meta.dirname, "../../remotion");

  const entryPoint = path.join(remotionRoot, "src", "index.ts");

  console.log(`[prebundle] Bundling Remotion project from: ${entryPoint}`);
  console.log(`[prebundle] Output directory: ${outDir}`);

  const bundleLocation = await bundle({
    entryPoint,
    outDir: path.resolve(outDir),
    onProgress: (progress: number) => {
      if (progress % 10 === 0) {
        console.log(`[prebundle] Progress: ${progress}%`);
      }
    },
  });

  console.log(`[prebundle] Bundle created at: ${bundleLocation}`);
}

main().catch((err) => {
  console.error("[prebundle] Failed:", err);
  process.exit(1);
});
