import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dirname needs Node >= 20.11 (the Docker image runs Node 18).
const HERE = path.dirname(fileURLToPath(import.meta.url));

let bundleLocation: string | null = null;

/**
 * Resolves the bundle location on startup and caches it.
 *
 * If REMOTION_PREBUILT_BUNDLE points at an existing directory, that bundle is
 * used as-is (no bundling, no @remotion/bundler import at all — lets a
 * read-only packaged app ship without the bundler dependency). Otherwise
 * bundles the Remotion project fresh, using REMOTION_BUNDLE_PATH to locate
 * the remotion source (default: "../remotion" relative to this service's
 * root).
 */
export async function initBundle(): Promise<void> {
  const prebuilt = process.env.REMOTION_PREBUILT_BUNDLE;
  if (prebuilt) {
    // Fail fast on a bad path — a packaged app may not ship @remotion/bundler,
    // so silently falling through would surface as a confusing import error.
    if (!fs.existsSync(prebuilt)) {
      throw new Error(
        `REMOTION_PREBUILT_BUNDLE is set but the directory does not exist: ${prebuilt}`
      );
    }
    bundleLocation = path.resolve(prebuilt);
    console.log(`[bundle] Using prebuilt bundle at: ${bundleLocation} (skipping bundling)`);
    return;
  }

  const { bundle } = await import("@remotion/bundler");

  const remotionRoot = process.env.REMOTION_BUNDLE_PATH
    ? path.resolve(process.env.REMOTION_BUNDLE_PATH)
    : path.resolve(HERE, "../../remotion");

  const entryPoint = path.join(remotionRoot, "src", "index.ts");

  console.log(`[bundle] Bundling Remotion project from: ${entryPoint}`);

  bundleLocation = await bundle({
    entryPoint,
    onProgress: (progress: number) => {
      if (progress % 10 === 0) {
        console.log(`[bundle] Progress: ${progress}%`);
      }
    },
  });

  console.log(`[bundle] Bundle created at: ${bundleLocation}`);
}

/**
 * Returns the cached bundle location.
 * Throws if initBundle() has not been called yet.
 */
export function getBundleLocation(): string {
  if (!bundleLocation) {
    throw new Error(
      "Bundle not initialized. Call initBundle() before getBundleLocation()."
    );
  }
  return bundleLocation;
}
