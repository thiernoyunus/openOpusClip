# OpenShorts export-speed investigation

Date: 2026-08-03
Status: experiment discarded; the normal export path is being restored.

## Goal

Evaluate whether Recordly's "Lightning Export" approach—browser rendering with WebGPU/WebGL and WebCodecs—could make OpenShorts exports substantially faster while still working on Mac, Intel Mac, and Windows.

## What we found from Recordly

- Recordly's fast path combines browser frame rendering, WebCodecs encoding, capability routing, and a native FFmpeg fallback. WebGPU is only one part of that pipeline.
- Its 8-second, 1080x1920, 30 FPS benchmark completed in roughly 4.7 seconds. Average frame rendering was about 0.84 ms; decode, encoding, and finalization made up most of the elapsed time.
- The attempted WebGPU-versus-WebGL comparison was not valid: the requested backend override was ignored, the run reported WebGPU, and GPU features were reported as disabled/software. Therefore no universal WebGPU speed multiplier was established.
- Browser/GPU capabilities vary by computer. A browser route must be optional and capability-gated, with the existing server renderer kept as the fallback.

## OpenShorts baseline

The normal editor path is:

`EditorView.jsx` -> `renderClipOnServer()` -> the render service -> Remotion/headless Chrome -> H.264 output.

OpenShorts already had a limited browser/WebCodecs helper in `dashboard/src/lib/renderInBrowser.js`, but it was not full server-export parity. Advanced captions, effects, filters, nested media, and source URL handling require visual validation before a browser result can replace the server result.

## Changes attempted in this experiment

These were the export-related working-tree changes. They were never committed as a release and are being discarded:

- `dashboard/package.json`, `dashboard/package-lock.json`: pinned Remotion/WebCodecs packages to `4.0.503`.
- `remotion/package.json`, `remotion/package-lock.json`: aligned Remotion packages to `4.0.503`.
- `render-service/package.json`, `render-service/package-lock.json`: aligned the renderer and bundler to `4.0.503`.
- `dashboard/src/lib/renderInBrowser.js`: added browser capability checking, media URL resolution, full editor props, `hardwareAcceleration: 'no-preference'`, and browser download handling.
- `dashboard/src/components/editor/EditorView.jsx`: added an optional browser export path, exact saved-framing handoff, existing-render download handling, cache-busting for framing previews, export confirmation text, and Electron download saving.
- `dashboard/src/components/editor/useEditorState.js`: kept the exact saved framing in editor state after saving.
- `render-service/src/server.ts`: added `Access-Control-Allow-Origin: *` to `/output` media responses so the render page could use native browser video decoding instead of a slower fallback.
- `render-service/src/render-worker.ts`: changed the output setting from CRF 22 to an 8 Mbps bitrate and added `hardwareAcceleration: 'if-possible'`.
- `electron/main.js`, `electron/preload.js`: added direct Downloads-folder saving and a download save IPC bridge.

Important: the optional browser route was guarded by `VITE_FAST_EXPORT=1`. The Electron command used during testing set output/upload directories but did not set that build-time flag. Therefore those tests did not reliably exercise the browser/WebCodecs fast route.

## Test evidence

What passed:

- The dashboard production build completed successfully with Vite.
- ESLint passed for the changed editor files, with only existing warnings.
- `render-service` TypeScript build passed.
- The render server accepted framing updates and queued server renders.

What did not improve or was not proven:

- The user observed no meaningful export-speed improvement.
- A Fit-to-Fill export could appear to use the previous render while the new render was still running; the old file remained in Downloads and a later render could be queued.
- The green completion message and exact framing handoff were implemented but were not proven through a clean, repeatable end-to-end run after every process was restarted.
- No valid before/after benchmark was completed for the CORS change, the server encoder settings, or browser/WebCodecs export.
- No visual-parity fixture suite was completed for captions, effects, or nested media.
- No comparative Intel Mac or Windows test was completed.

## Why the installed app could appear affected

This was a process/data-sharing problem, not source code being copied into the installed application.

- Both development and packaged Electron modes check `http://127.0.0.1:8000/api/config` first. If a backend is already running, the app prints `Backend already responding ... attaching instead of spawning.`
- Both modes use the renderer on port `3100`.
- `electron/main.js` sets the app name to `openOpusClip`, so both modes use the same macOS user-data directory: `~/Library/Application Support/openOpusClip`.
- The source test app was explicitly pointed at the same output and upload directories used by the packaged app.
- If the source backend/renderer was left running, the installed app could attach to that development backend even though its dashboard UI was packaged separately.
- A backend restart clears in-memory job records. The dashboard then sees a saved local project whose job no longer exists and labels it `Expired`; the code's user-facing explanation is “the server restarted before it finished.” This is a project/job status, not evidence that the installed app received the source dashboard code.
- Local artifact evidence supports that distinction: `electron/dist/mac-arm64/openOpusClip.app` is dated 2026-07-26, before this August experiment, and its bundled dashboard does not contain the experiment's `VITE_FAST_EXPORT`, `browser-webcodecs`, or `Saved to Downloads` markers. It was not rebuilt from these changes.

For installed-app testing, all development processes on ports 8000 and 3100 must be stopped first. The source Electron app and the packaged app should not be run against the same live backend during a test.

### Follow-up: signed-app screenshot

The signed app was later checked while running from `/Applications/openOpusClip.app`. Its own packaged Python backend was listening on port 8000 and its packaged renderer was listening on port 3100; no source `npm start` process was involved.

The output folders for the projects shown in the screenshot contain `result.json`, and live checks against the packaged backend returned HTTP 200 with `status: completed` for the known project IDs, including the Arabic practice, Abu Lahya, In Pursuit of Knowledge, and Names of Allah projects. The dashboard still displayed `Expired` because it initializes the Recent projects grid from localStorage. It only rechecks a project when the card is opened, and a one-time stale-status migration may already have run. A previous backend restart therefore left the visual card label stale even though the persisted project and result are available.

This confirms the screenshot is a separate stale-history/UI issue, not evidence that the discarded export experiment was included in the signed app.

## Separate expired-card fix

After the export experiment was reverted, `dashboard/src/App.jsx` received a separate dashboard-only fix. On startup it rechecks saved cards that say `expired`; a real completed, processing, or failed response updates the card, while a real 404 leaves it expired. Opening a previously expired but valid card also updates its saved status. No video files, backend export settings, or WebGPU/WebCodecs code are involved.

Verification completed:

- Dashboard lint: passed with two existing hook-dependency warnings and no errors.
- Dashboard production build: passed with Vite 8.0.14.
- Local arm64 app package: signed with `Developer ID Application: THIERNO YOUNOUSSA DIALLO (257JN3YM2Y)`.
- `codesign --verify --deep --strict`: passed.
- DMG and ZIP artifacts were created under `electron/dist/`.

The installed `/Applications/openOpusClip.app` was not overwritten automatically; installing the new arm64 DMG is the step that puts this dashboard fix into the app you open normally.

### Timeline of the `Expired` label

- **2026-06-13 — commit `1b7237c` (`Fix stale job polling recovery`):** introduced the `JobExpiredError` path, the `Expired` card overlay, and a client-side one-hour `PROCESSING_MAX_AGE` rule. This is when the behavior first entered the project.
- **2026-07-11/12 — commits `3fa17c8`, `46feb7b`, and merge `8170a10`:** removed the one-hour assumption, stopped treating ordinary network failures as proof of expiration, and made server-side projects permanent until deleted.
- **2026-07-12 — commit `030fecc`:** added a one-time migration for cards that had already been saved as `expired` by the old code.
- **Current result:** the signed app has already consumed that one-time migration flag, while its local history still contains the old card labels. The live backend currently returns `completed` for those project IDs, so the screenshot is stale local history rather than a newly introduced export regression.

## Decision

Discard the export-speed experiment. Restore the 13 modified export-related tracked files to their pre-experiment versions. Keep this report and preserve unrelated local work, including `electron/dist-keep/`, `openshorts-site/`, and `posthog-self-driving-report.md`.

The evidence does not justify making WebGPU, browser WebCodecs, the CORS change, or the new encoder settings part of the app. The normal server export path is the known baseline to return to.

## If we revisit this later

1. Add a clear benchmark harness that measures the same clip from export click to completed file.
2. Test server decoding, encoding, and finalization separately.
3. Enable browser export explicitly only in an isolated beta build.
4. Compare output pixels/audio against server exports across representative caption/effect cases.
5. Test Apple Silicon, Intel Mac, and Windows before considering a default route.
6. Keep the server renderer as the automatic fallback and prevent dev and packaged apps from sharing a live backend during testing.
