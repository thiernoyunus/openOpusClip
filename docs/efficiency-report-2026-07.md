# OpenShorts Efficiency Report

**Date:** 2026-07-11  
**Branch audited:** `main` (post #63 B4, post #64 aspect)  
**Repo:** `/Users/thiernodiallo/Coding/openshorts` (GitHub: `thiernoyunus/openOpusClip`)  
**Audience:** anyone who wants to make this app faster, lighter, and easier to run on a normal computer  
**Method:** full-stack read-only audit — Python pipeline, Remotion export, dashboard editor, install/runtime footprint — cross-checked against live code and `docs/performance-and-parity-plan.md`

---

## 0. North-star goal (own this)

### Product goal (open source)

Anyone can:

1. Clone the repo  
2. Install on a **normal laptop** (8–16 GB RAM, no NVIDIA GPU, macOS / Windows / Linux)  
3. Start the app  
4. Process a short video and edit a clip **without the machine freezing**

…without needing a workstation or a cloud GPU.

### Engineering goal (measurable)

| Metric | Today (rough, defaults) | Target (12 weeks of focused work) |
|--------|-------------------------|-----------------------------------|
| Comfortable laptop job | Often thrash/swap with multi-job defaults | **1 job at a time** is smooth by default |
| 10-min podcast → clips wall time | Dominated by Whisper + multi-pass reframe + encodes | **~30–50% faster** on same hardware |
| Peak RAM during one job | Can exceed 8 GB with workers | **≤6 GB** for “lite” path |
| Editor preview while playing | Full 1080×1920 composition + multi-decoders | **≥24 fps** interactive scrub on mid laptop |
| Fresh install disk (venv + 3 node trees) | Measured here: **~3.5 GB** deps alone (`.venv` 2.1G + remotion 847M + render 385M + dashboard 168M); repo checkout larger | **≤2.5 GB** optional “lite” extras (no torch/YOLO) |
| Concurrent jobs default | **5** | **1** local / env-tunable for servers |
| Render concurrency default | **all CPUs** per export | **half CPUs**, max 1–2 exports at once |

### Success definition

- A contributor with 16 GB RAM can run `start-local.sh`, process a **3-minute local upload**, open the editor, switch layouts, and export **without force-quitting Chrome or the terminal**.  
- A power user can still turn knobs up for a beefy machine.  
- Every recommendation below has a file, a proposed change, effort, risk, and acceptance check — nothing left hanging.

---

## 1. What the app does (efficiency lens)

```
┌──────────────┐     ┌────────────────────┐     ┌─────────────────┐
│  Dashboard   │────▶│  FastAPI (app.py)  │────▶│ main.py job     │
│  Vite :5175  │     │  queue :8000       │     │ subprocess      │
└──────┬───────┘     └────────────────────┘     └────────┬────────┘
       │                                                  │
       │ editor preview (Player)                          │ Whisper → Gemini
       │                                                  │ → cut clips
       │                                                  │ → reframe bake
       ▼                                                  ▼
┌──────────────────┐                            disk: output/<job>/
│ Remotion Player  │                            .mp4 + framing.json
│ full export res  │
└────────┬─────────┘
         │ export
         ▼
┌──────────────────┐
│ render-service   │  Chromium × N cores → h264
│ :3100            │
└──────────────────┘
```

**Where time and RAM actually go on a typical job**

1. **Transcribe whole source** (Whisper / MLX) — CPU + model RAM  
2. **Gemini** picks viral moments — network + $  
3. **Per clip:** two re-encodes (unpadded bake input + padded editor source)  
4. **Vertical bake:** scene detect + strategy pass + **Python frame loop** (MediaPipe + OpenCV) + rawvideo pipe into ffmpeg  
5. **Editor:** full-res Remotion preview + browser filmstrip/waveform of the source  
6. **Export:** headless Chrome captures every frame at full resolution  

Track A already shipped several wins (VideoToolbox on Mac, face downscale, parallel clips, Gemini/transcript caches). The remaining pain is **defaults that oversubscribe laptops**, **multi-pass decode/encode**, **Python pixel bake**, and **preview = export cost**.

---

## 2. What is already good (do not redo)

| Optimization | Where | Notes |
|--------------|--------|--------|
| macOS VideoToolbox encode | `ffmpeg_utils.py` | 3–10× vs libx264; `OPENSHORTS_HWACCEL=0` disables |
| Face detect max-dim 640 | `main.py` `detect_face_candidates` | Shipped A3 |
| Cheaper resizes (LINEAR/AREA) | bake + GENERAL | Shipped A3 |
| Parallel clips | `OPENSHORTS_CLIP_WORKERS` | Default `min(4, cpu//4)` |
| Parallel trailer segment cuts | `main.py` ThreadPool | A5-ish shipped |
| Thread-local MediaPipe | `main.py` | Safe under clip threads |
| YOLO off by default | `ENABLE_YOLO_FALLBACK=false` | Avoids torch path at runtime (still **installed**) |
| Gemini Files upload cache | `editor.py` | A6 |
| Dubbed transcript cache | `subtitles.py` | A7 |
| Compact Gemini word arrays + JSON mime | `main.py` | Partial A2 |
| Render JPEG@80 + x264 `faster` | `render-worker.ts` | Already tuned encode knobs |
| Timeline playhead isolated | `EditorTimeline.jsx` | Good pattern |
| Dense keyframes for editor seek | `-g 15` on sources | Intentional quality tradeoff |

Plan status in `docs/performance-and-parity-plan.md` is slightly **stale** (it still says A4/A5 not verified; parallel clip workers and trailer cuts are in code).

---

## 3. Measured install footprint (this machine)

| Path | Disk |
|------|------|
| `.venv` | **2.1 GB** |
| `remotion/node_modules` | **847 MB** |
| `render-service/node_modules` | **385 MB** |
| `dashboard/node_modules` | **168 MB** |
| Working tree total (incl. output/, models, etc.) | **~16 GB** observed |

Three separate Node trees + a CPU **PyTorch** venv is the open-source “why is clone so heavy?” answer.

---

## 4. Priority roadmap (pick up and run)

Ordered for **impact × safety × open-source laptop value**.

### Phase 0 — “Stop thrashing” (1–3 days) — **do first**

These change defaults and docs. Low code risk. Highest OSS win.

| ID | Change | Effort | Acceptance |
|----|--------|--------|------------|
| **E0.1** | Default `MAX_CONCURRENT_JOBS=1` (keep env override for servers). Fix stale comment “Default to 1”. | S | Two jobs queue; only one `main.py` at a time |
| **E0.2** | Default `OPENSHORTS_CLIP_WORKERS=1` for local (or auto: 1 if RAM unknown; opt-in parallel). Document that 5 jobs × N workers multiplies RAM. | S | One-clip-at-a-time by default |
| **E0.3** | Default `RENDER_CONCURRENCY = max(1, cpus//2)` and **global render job semaphore** (1–2 concurrent exports). | S | Two exports cannot launch all-cores×2 Chrome |
| **E0.4** | Document **lite mode** in README + expand `.env.example` with all perf knobs. | S | New contributor finds knobs in one place |
| **E0.5** | README install: add `cd remotion && npm install` (export needs it). | S | Fresh clone export works |
| **E0.6** | Optional `JOB_RETENTION_SECONDS=86400` example for dev disk hygiene (default can stay permanent for product). | S | Docs match reality |

**Lite env block (ship in `.env.example`):**

```bash
# --- Laptop / contributor lite defaults ---
MAX_CONCURRENT_JOBS=1
OPENSHORTS_CLIP_WORKERS=1
OPENSHORTS_KEEP_ORIGINAL=0          # set 1 only if testing Extend
OPENSHORTS_HWACCEL=1                # Mac VideoToolbox; ignored elsewhere today
ENABLE_YOLO_FALLBACK=false
RENDER_CONCURRENCY=2
RENDER_X264_PRESET=veryfast
# JOB_RETENTION_SECONDS=86400       # uncomment on small disks
```

---

### Phase 1 — Pipeline speed (1–2 weeks)

| ID | Change | Severity | Est. win | Effort | Risk | Primary files |
|----|--------|----------|----------|--------|------|---------------|
| **E1.1** | GENERAL blur: blur **downscaled** plate then upscale (not 51×51 at 1080×1920) | P1 | 5–20× cheaper GENERAL frames | S | slight look change | `main.py` `create_general_frame` |
| **E1.2** | Face detect every **5–10** frames (hold/smooth crop); keep keyframes sparse | P0 | 1.5–3× framing CPU | S–M | fast speaker switch lag | `main.py` bake loop ~1172–1196 |
| **E1.3** | PySceneDetect `downscale` / `frame_skip` | P2 | 2–4× scene stage | S | soft-cut miss | `main.py` `detect_scenes` |
| **E1.4** | Dense `-g 15` **only** on editor `_source.mp4`, not on bake intermediate cut | P2 | 20–40% cut CPU/size | S | black flash if wrong file | `main.py` `process_one_clip` |
| **E1.5** | Single padded cut + bake with offset (remove dual re-encode) | P0 | ~1.5–2× cut phase | M | editor source fallback | `main.py` ~2492–2528 |
| **E1.6** | Fold strategy sampling into bake first frames (A9) | P0 | ~30% framing stage | M | strategy quality | `analyze_scenes_strategy` + bake |
| **E1.7** | Cross-platform HW encode: NVENC / QSV / AMF detect in `video_codec_args` | P1 | 3–10× encode off-Mac | M | quality variance | `ffmpeg_utils.py` |
| **E1.8** | Persist full-job transcript sidecar (path+mtime) | P1 | skip re-Whisper on retry | M | stale transcript | `transcription.py`, `main.py` |
| **E1.9** | `os.link` instead of `shutil.copy` for edit ASCII-name path | P2 | disk/latency | S | Unicode paths | `app.py` ~744 |
| **E1.10** | Sentence-level Gemini for long sources (finish A2) | P2 | cost + latency | M | cut boundary quality | `main.py` prompts |

**Deep (Phase 1.5 / later):** replace Python raw BGR pipe bake with ffmpeg crop/zoompan or GPU path (`process_video_to_vertical` ~1041–1248). **Largest remaining wall-time win**, effort **L**, risk framing parity.

#### Python bake cost (why it hurts)

Every output frame today approximately:

1. Decode full source frame in OpenCV  
2. MediaPipe (every 2nd frame, already downscaled to 640)  
3. Crop/compose in NumPy  
4. Resize to 1080×1920  
5. `tobytes()` → ~6.2 MB/frame into ffmpeg rawvideo (~180 MB/s at 30 fps)  
6. ffmpeg applies `unsharp` + `eq` then encodes  

That design is correct for experimentation; it is **not** what you want as the only path for open-source laptops.

---

### Phase 2 — Editor & preview (1–2 weeks)

| ID | Change | Severity | Est. win | Effort | Risk | Primary files |
|----|--------|----------|----------|--------|------|---------------|
| **E2.1** | **Half-res preview** (e.g. 540×960) with `previewScale` for captions/text; export full res | P0 | 2–4× smoother preview | M | caption px drift | `EditorCanvas.jsx`, caption styles |
| **E2.2** | Server or FFmpeg filmstrip once per source (stop 64× seek + base64 in browser) | P0 | load spike gone | M | CORS / cache | `useMediaStrips.js`, optional API |
| **E2.3** | Server peak file or worker decode for waveform; canvas bars not 640 DOM divs | P1 | RAM + jank | M | look | `useMediaStrips.js`, `EditorTimeline.jsx` |
| **E2.4** | Cap multi-panel preview to 1 decoder + CSS crops; disable Fit blur in preview | P0 | 2–4× multi-layout | L | black-flash history | `ReframedVideo.tsx` |
| **E2.5** | Caption drag: visual-only until pointerup (don’t push full framing into Player every rAF) | P1 | drag FPS | M | preview lag | `CaptionDragOverlay.jsx` |
| **E2.6** | Throttle transcript `frameupdate` to 5–10 Hz; shared playhead store | P1 | fewer React trees | S–M | highlight lag | `TranscriptPanel.jsx` |
| **E2.7** | `HISTORY_LIMIT` 50 → 15–20; optional strip samples in undo snapshots | P1 | heap | S | shorter undo | `useEditorState.js` |
| **E2.8** | Binary-search face samples / camera keyframes (`smoothedFaceRect`, `interpolateCrop`) | P1 | 5–20% composition cost | S–M | low | `ReframedVideo.tsx` |
| **E2.9** | Memo `placedRanges` / caption blocks | P2 | small–medium | S | stale memo | `ReframedVideo.tsx`, `Subtitles.tsx` |
| **E2.10** | Lazy-load `@remotion/web-renderer` / GSAP / studio routes | P2 | bundle | S–M | import paths | `dashboard` |

---

### Phase 3 — Export & Remotion (1 week)

| ID | Change | Severity | Est. win | Effort | Risk | Primary files |
|----|--------|----------|----------|--------|------|---------------|
| **E3.1** | Global render queue (max 1–2 jobs) | P0 | stop OOM | S | queue wait | `render-service/src/server.ts` |
| **E3.2** | Safer `RENDER_CONCURRENCY` default | P0 | RAM | S | slightly slower single job | `render-worker.ts` |
| **E3.3** | Prebuild Remotion bundle in Docker image / cache dir | P2 | cold start | M | stale bundle | `bundle.ts`, Dockerfile |
| **E3.4** | Pass `browserExecutable` + timeouts explicitly | P2 | first-frame reliability | S–M | env-specific | `render-worker.ts` |
| **E3.5** | Optional OffthreadVideo **export-only** path | P1 | often large FPS gain | L | parity | remotion compositions |
| **E3.6** | Pin Remotion versions across dashboard / remotion / render-service | P3 | fewer skew bugs | S | bump pain | three `package.json` |

---

### Phase 4 — Open-source install & packaging (ongoing)

| ID | Change | Effort | Why |
|----|--------|--------|-----|
| **E4.1** | Optional extras: `requirements-lite.txt` without torch/ultralytics when YOLO off | M | Cuts multi-GB venv |
| **E4.2** | Monorepo or workspace: one Remotion dependency graph | L | −duplicate node_modules |
| **E4.3** | Compose profile `lite`: backend + frontend only; `full` adds renderer | S | Pipeline-only contributors |
| **E4.4** | Compose memory limits + `shm_size` for Chromium | S | Docker laptop safety |
| **E4.5** | Windows `start-local.ps1` twin of bash script | M | Windows contributors |
| **E4.6** | Offline demo mode: fixture job + no Gemini (process cached framing) | M | “clone and click” without keys |
| **E4.7** | Document Node version matrix (Docker Node 18 vs yt-dlp preferring ≥22) | S | Avoid silent download failures |

---

## 5. Detailed findings by subsystem

### 5.1 Python pipeline (`main.py`, `transcription.py`, `ffmpeg_utils.py`, `app.py`)

#### Hot path: `process_video_to_vertical`

- Scene detect → full decode (`detect_scenes`)  
- Strategy analysis → more seeks/samples (`analyze_scenes_strategy`)  
- Full bake loop → MediaPipe every 2nd frame + rawvideo pipe  
- Encode with optional `unsharp`/`eq` filters always on  

**Evidence anchors**

| Topic | Location |
|-------|----------|
| Face downscale 640 | `main.py` `detect_face_candidates` ~511–528 |
| Detect every 2nd frame | bake loop ~1167–1196 |
| GENERAL blur 51×51 | `create_general_frame` ~683 |
| Clip parallel workers | ~2578–2590 |
| Dual cut encode | `process_one_clip` ~2492–2528 |
| HW encode Mac-only | `ffmpeg_utils.py` ~14–32 |
| Job concurrency default 5 | `app.py` ~33 |
| Job retention default permanent | `app.py` ~39 (`JOB_RETENTION_SECONDS=0`) |
| YOLO optional | `ENABLE_YOLO_FALLBACK` ~196 |
| `import torch` at module import | `main.py` line 11 — heavy import even when YOLO unused |

#### Clip processing multiplication

For each short:

1. Unpadded cut (re-encode, dense keyframes)  
2. Padded ±3s editor source (re-encode, dense keyframes)  
3. Full vertical bake (decode + detect + re-encode)  

Plus optional: keep full `original.mp4` (`OPENSHORTS_KEEP_ORIGINAL` default **on**).

#### Transcription

- Always full-source before clipping (`main` ~2399–2400)  
- Default model `base`  
- MLX on Apple Silicon when available; else faster-whisper CPU  
- Model loaded **inside job subprocess** → no cross-job cache  
- Silence pass does extra audio work (`transcription.py`)  

#### App orchestration

- Each job = full `main.py` subprocess  
- `MAX_CONCURRENT_JOBS=5` default is **server-shaped**  
- Combined with clip workers, one machine can run:  
  `5 jobs × ~2–4 workers × (ffmpeg + MediaPipe + frames)`  

That is the #1 reason “it works on my M-series Mac with 32 GB and dies on a 16 GB Windows laptop.”

---

### 5.2 Remotion + render-service

| Issue | Evidence | Impact |
|-------|----------|--------|
| Preview composition = export pixels | `EditorCanvas.jsx` compositionWidth/Height = outW/outH | CPU/GPU for a box that is only ~420×620 CSS |
| Multi-panel N× `<Video>` same source | `ReframedVideo.tsx` FitFrame + panels | Multiple decoders |
| FitFrame double video + CSS blur | FitFrame ~300–345 | GPU thrash |
| Export: all-core concurrency | `RENDER_CONCURRENCY = os.cpus().length` | RAM spike |
| No job semaphore | `server.ts` fire-and-forget | N exports × N cores |
| Face smooth O(samples)/frame | `smoothedFaceRect` | CPU on long tracks |
| Dense camera keyframes linear search | `interpolateCrop` | CPU + huge framing JSON |
| Captions regroup every frame | `Subtitles.tsx` | CPU when captions on |
| Bundle every process start | `bundle.ts` `initBundle` | Cold start |
| No OffthreadVideo | intentional `@remotion/media` for browser | Export may leave FPS on table |
| Version skew | dashboard 4.0.447 vs render 4.0.468 | subtle bugs |

**Export knobs already good:** JPEG frame capture @80, x264 preset `faster`, CRF 22 — keep; just **cap concurrency**.

---

### 5.3 Dashboard editor

| Issue | Evidence | Impact |
|-------|----------|--------|
| Filmstrip: 64 seeks + progressive base64 | `useMediaStrips.js` `useFilmstrip`, timeline count 64 | Open-editor spike |
| Waveform: full `fetch` + `decodeAudioData` | `useWaveform` | RAM = whole media audio |
| Waveform UI = hundreds of DOM divs | `EditorTimeline.jsx` | Drag jank |
| Per-audio-block re-decode | `AudioBlock` + `useWaveform` | N× audio decode |
| 2–4 `frameupdate` React subscribers | Transcript, CaptionDrag, Tracker, Playhead | 30 Hz re-renders |
| Caption drag → full framing → Player | `CaptionDragOverlay` rAF dispatch | Heaviest interactive path |
| Undo history 50 framing roots | `HISTORY_LIMIT = 50` | Heap with dense faceTracks |
| Results grid many `<video>` | `ResultCard` | Session memory |

**Already good:** isolated playhead, throttled timeline time readout, memoized clip blocks/words.

---

### 5.4 Install & “run on any computer”

| Barrier | Detail |
|---------|--------|
| ML-sized pip install | torch + torchvision + ultralytics even when YOLO off |
| Triple npm install | dashboard + remotion + render-service |
| README omits remotion install | Export fails mysteriously |
| Scripts are bash + `lsof` | No Windows first-class starter |
| HW encode Mac-only | Windows/Linux always software x264 |
| Gemini required for AI path | No offline demo |
| Docker 3 services unlimited | No memory caps |
| Docs vs code | Plan says A4 not done; code has workers. Job cleanup “1 hour” in old docs vs permanent default |

---

## 6. Recommended “lite mode” for contributors (use today)

No code required — set env before `start-local.sh`:

```bash
export MAX_CONCURRENT_JOBS=1
export OPENSHORTS_CLIP_WORKERS=1
export OPENSHORTS_KEEP_ORIGINAL=0
export ENABLE_YOLO_FALLBACK=false
export RENDER_CONCURRENCY=2
export RENDER_X264_PRESET=veryfast
# Mac only helps:
export OPENSHORTS_HWACCEL=1
```

**Workflow tips**

1. Prefer **short local uploads** (1–3 min) over long YouTube while developing.  
2. Whisper: keep **base** or try **tiny** for draft.  
3. Skip renderer process if you only test the pipeline (export needs `:3100`).  
4. Prefer **native** over Docker on 8 GB machines.  
5. Install remotion deps: `cd remotion && npm install`.  
6. Put Gemini key in Settings; leave ElevenLabs/Zernio empty unless needed.

---

## 7. Implementation playbooks (copy-paste tickets)

### Ticket E0.1 — Default one job at a time

**Files:** `app.py`  
**Change:** `MAX_CONCURRENT_JOBS` default `"5"` → `"1"`. Update comment.  
**Docs:** README “Server deploy” section: set `MAX_CONCURRENT_JOBS=4` for multi-core servers.  
**Test:** Start two jobs; logs show second waits for slot.  
**Rollback:** env override.

### Ticket E1.1 — Cheap GENERAL blur

**Files:** `main.py` `create_general_frame`  
**Change:** Resize background to ~1/4 size → `GaussianBlur` small kernel → upscale to output.  
**Test:** Side-by-side GENERAL scene; visual parity within acceptable blur softness.  
**Benchmark:** time `process_video_to_vertical` on a multi-person clip before/after.

### Ticket E1.2 — Detect every N frames

**Files:** `main.py` bake loop  
**Change:** `DETECT_EVERY = int(os.environ.get("OPENSHORTS_DETECT_EVERY", "5"))`; only call `detect_face_candidates` when `frame_number % DETECT_EVERY == 0`; cameraman continues smooth.  
**Test:** talking-head + rapid two-person switch; track should not jump wildly.  
**Benchmark:** framing stage seconds.

### Ticket E2.1 — Half-res preview

**Files:** `EditorCanvas.jsx`, caption/text overlay sizing  
**Change:**  
```js
const PREVIEW_SCALE = 0.5;
const compW = Math.round(outW * PREVIEW_SCALE);
const compH = Math.round(outH * PREVIEW_SCALE);
// pass previewScale in inputProps; multiply fontSize/stroke by 1/PREVIEW_SCALE? 
// Better: store caption positions normalized; sizes in % of height
```  
**Export path:** unchanged full `outW/outH`.  
**Test:** caption position matches export; drag still works.  
**Benchmark:** Chrome Performance while playing 30s.

### Ticket E3.1 — Render job semaphore

**Files:** `render-service/src/server.ts`  
**Change:** queue with `MAX_RENDER_JOBS` (default 1); when slot free, run `executeRender`.  
**Test:** fire 3 exports; only 1–2 run; others stay `queued`.  

---

## 8. How to measure (so PRs prove wins)

Add a simple timing log standard (even stderr is fine):

```
[perf] stage=transcribe seconds=...
[perf] stage=gemini_clips seconds=...
[perf] stage=clip_cut index=1 seconds=...
[perf] stage=reframe index=1 seconds=... frames=... detect_calls=...
[perf] stage=job_total seconds=...
```

**Baseline recipe (repeatable)**

1. Fixed 3-minute local 1080p interview file (commit a sample under `testdata/` if license allows).  
2. `MAX_CONCURRENT_JOBS=1 OPENSHORTS_CLIP_WORKERS=1`  
3. Same Whisper model, same Gemini model.  
4. Record: wall time, peak RSS (`/usr/bin/time -l` on Mac, `/usr/bin/time -v` on Linux), output folder size.  
5. For editor: Chrome Performance — record play 10s; note Scripting + Rendering + GPU.  

**Do not merge “perf” PRs without before/after numbers on that recipe.**

---

## 9. Risk register

| Risk | Mitigation |
|------|------------|
| Removing dual cut breaks editor Extend / seek | Keep padded source path tests; dense keyframes only on `_source` |
| Half-res preview caption mismatch | Normalized layout units; golden screenshot export vs preview |
| Multi-Video collapse causes black flash | Known issue in comments; feature-flag preview path |
| Aggressive job concurrency=1 hurts multi-user deploy | Document server env; separate “prod” compose |
| Dropping torch breaks YOLO fallback | Keep full requirements as `requirements-ml.txt`; lite default |
| HW encode quality variance | Per-encoder bitrate/CRF tables + visual QA clip |

---

## 10. Suggested 12-week plan

| Weeks | Focus | Outcome |
|-------|--------|---------|
| 1 | Phase 0 defaults + docs + `.env.example` | Laptops stop melting on first day |
| 2–3 | E1.1–E1.4 + measuring harness | Visible job time drop |
| 4–5 | E1.5–E1.7 | Cuts + encode for Windows/Linux |
| 6–7 | E2.1–E2.3 | Editor feels usable |
| 8–9 | E2.4–E2.8 + E3.1–E3.2 | Preview + export stable under load |
| 10–11 | E4 lite requirements + compose profiles | Smaller install |
| 12 | Benchmark doc + optional deep bake rewrite spike | Decision: ffmpeg-native bake vs keep Python |

---

## 11. Relationship to existing plan

`docs/performance-and-parity-plan.md` **Track A** is the ancestor of much of this work:

| Plan item | Status in code (2026-07-11) | This report |
|-----------|----------------------------|-------------|
| A1 VideoToolbox | ✅ shipped | Extend to NVENC/QSV (E1.7) |
| A2 compact prompt | ⚠️ partial | Finish sentence path (E1.10) |
| A3 face downscale | ✅ | Detect every N frames next (E1.2) |
| A4 parallel clips | ✅ ThreadPool in code | Cap defaults for laptops (E0.2) |
| A5 trailer parallel cuts | ✅ | Keep |
| A6/A7/A8 caches & models | ✅ | Keep |
| A9 fold decode passes | ❌ still open | E1.3 + E1.6 |
| A10 hardlink edit copy | ❌ | E1.9 |
| Track B timeline | mostly ✅ via #61–#63 | Perf guards E2.* |

This report **does not replace** the parity plan; it **re-prioritizes for open-source laptop efficiency** and adds editor/render/install work the old Track A under-covered.

---

## 12. Explicit non-goals (for now)

- Rewriting the whole product in Rust/Go  
- Cloud-only GPU farm as the only supported path  
- Dropping Remotion (preview/export parity is a product feature)  
- Perfect pixel-identical GENERAL blur after cheap blur  
- Making 64 GB of concurrent jobs the default  

---

## 13. One-page “if you only do five things”

1. **Default concurrency to 1** for jobs, clips, and render jobs.  
2. **Half-resolution editor preview.**  
3. **Stop dual re-encode** (one padded cut + offset bake).  
4. **Cheap GENERAL blur + detect every N frames.**  
5. **Lite install docs** + optional requirements without torch + remotion install step.  

Those five move the product from “works on a beefy Mac” toward “anyone can run it.”

---

## 14. Appendix — env knobs inventory

| Variable | Default (code) | Lite suggestion |
|----------|----------------|-----------------|
| `MAX_CONCURRENT_JOBS` | 5 | 1 |
| `OPENSHORTS_CLIP_WORKERS` | auto `min(4,cpu//4)` | 1 |
| `OPENSHORTS_HWACCEL` | on (Mac) | on |
| `OPENSHORTS_KEEP_ORIGINAL` | on | off unless Extend |
| `ENABLE_YOLO_FALLBACK` | false | false |
| `JOB_RETENTION_SECONDS` | 0 (keep forever) | 86400 for dev |
| `UPLOAD_RETENTION_SECONDS` | 3600 | 3600 |
| `RENDER_CONCURRENCY` | all CPUs | 2 |
| `RENDER_X264_PRESET` | faster | veryfast |
| `RENDER_JPEG_QUALITY` | 80 | 80 |
| Whisper model CLI/UI | base | tiny/base |
| `YTDLP_CONCURRENT_FRAGMENTS` | 5 | 3 on weak nets |

---

## 15. Appendix — evidence index (start reading here)

| Area | Start file |
|------|------------|
| Job queue | `app.py` ~33–56, ~240–258 |
| Codec selection | `ffmpeg_utils.py` |
| Face + bake | `main.py` `detect_face_candidates`, `process_video_to_vertical`, `create_general_frame` |
| Parallel clips | `main.py` ~2578–2603 |
| Transcription | `transcription.py` |
| Preview Player | `dashboard/src/components/editor/EditorCanvas.jsx` |
| Timeline strips | `dashboard/src/components/editor/useMediaStrips.js` |
| Timeline UI | `dashboard/src/components/editor/EditorTimeline.jsx` |
| Reframe composition | `remotion/src/compositions/ReframedVideo.tsx` |
| Export worker | `render-service/src/render-worker.ts` |
| Export server | `render-service/src/server.ts` |
| Prior plan | `docs/performance-and-parity-plan.md` |
| Local start | `start-local.sh`, `docker-compose.yml`, `README.md` |

---

## 16. Residual unknowns (measure next)

1. Exact wall-time split on a fixed 10-min podcast (Whisper % / Gemini % / cuts % / bake %).  
2. Peak RSS with lite env vs current defaults.  
3. Whether multiple `@remotion/media` Videos share demuxer state in current version.  
4. Real faceTrack sample counts on worst production framing.json.  
5. Whether `PUPPETEER_EXECUTABLE_PATH` alone is enough without `browserExecutable` in Remotion 4.0.468.  
6. Minimum viable install without torch (YOLO always off) — prove MediaPipe/OpenCV still resolve.

---

**End of report.**  
Next action for implementers: open tickets **E0.1–E0.6** as one PR (“laptop-safe defaults + docs”), then **E1.1 + E1.2** as the first pipeline speed PR with the baseline recipe numbers attached.
