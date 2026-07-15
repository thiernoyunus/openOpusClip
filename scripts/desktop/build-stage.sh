#!/usr/bin/env bash
#
# build-stage.sh — Step A of desktop packaging.
#
# Assembles every runtime ingredient of a self-contained macOS (arm64) OpenShorts
# app into a single `desktop-stage/` folder at the repo root. Each step is
# idempotent and caches large downloads in `.desktop-build-cache/`.
#
# Staged layout (all consumed by scripts/desktop/verify-stage.sh):
#   desktop-stage/
#     dashboard/                 built Vite dashboard (copy of dashboard/dist)
#     backend/                   Python runtime source (app.py, main.py, ...)
#       dashboard/dist/          copy of the built dashboard (app.py mounts this)
#       fonts/                   hook fonts (hooks.py FONT_DIR="fonts", cwd-relative)
#       remotion/public/fonts/   caption/RTL fonts (subtitles.py/_FONTS_DIR, __file__-relative)
#     render-service/dist/       compiled TS renderer (node dist/server.js)
#     render-service/node_modules  prod-only deps (@remotion/renderer + compositor, express; NO bundler)
#     remotion-bundle/           prebuilt Remotion bundle (REMOTION_PREBUILT_BUNDLE)
#     python/                    portable CPython 3.11 (python-build-standalone)
#     bin/                       static ffmpeg + ffprobe (arm64, no Homebrew deps)
#     chrome-headless-shell/     headless Chrome for Remotion rendering
#
set -euo pipefail

# --- 0. Guards ---------------------------------------------------------------

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: this staging pipeline only builds for macOS arm64 (Apple Silicon)." >&2
  echo "       Detected: $(uname -s)/$(uname -m)" >&2
  exit 1
fi

# Repo root = two levels up from this script (scripts/desktop/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STAGE="${REPO_ROOT}/desktop-stage"
CACHE="${REPO_ROOT}/.desktop-build-cache"

mkdir -p "${STAGE}" "${CACHE}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- Pinned artifacts --------------------------------------------------------
# python-build-standalone CPython 3.11 (aarch64-apple-darwin, install_only).
PY_RELEASE="20260623"
PY_VERSION="3.11.15"
PY_TARBALL="cpython-${PY_VERSION}+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${PY_TARBALL}"
PY_SHA256="d2324bfd1a7b9fc44ccd884c3a2505bcab6691dbfd4f8270e10c50aaa4e19506"

# Static ffmpeg/ffprobe (macOS arm64) from ffmpeg.martin-riedl.de.
# Pinned to a resolved versioned build (8.1.2) for reproducibility.
FFMPEG_VER="1783011502_8.1.2"
FFMPEG_URL="https://ffmpeg.martin-riedl.de/download/macos/arm64/${FFMPEG_VER}/ffmpeg.zip"
FFPROBE_URL="https://ffmpeg.martin-riedl.de/download/macos/arm64/${FFMPEG_VER}/ffprobe.zip"
FFMPEG_SHA256="ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c"
FFPROBE_SHA256="c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf"

verify_sha256() {
  # verify_sha256 <file> <expected>
  local file="$1" expected="$2" actual
  actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || die "sha256 mismatch for ${file}: got ${actual}, expected ${expected}"
}

# =============================================================================
log "Staging into: ${STAGE}"

# --- a. Dashboard build ------------------------------------------------------
log "a. Building dashboard (Vite)"
cd "${REPO_ROOT}/dashboard"
[[ -d node_modules ]] || { info "installing dashboard deps..."; npm install; }
# The desktop app always talks to the backend it starts itself on
# 127.0.0.1:8000 — force a relative API base so a VITE_API_URL left over in
# the shell or dashboard/.env can't get baked into the packaged dashboard.
VITE_API_URL= npm run build
rm -rf "${STAGE}/dashboard"
cp -R "${REPO_ROOT}/dashboard/dist" "${STAGE}/dashboard"
info "dashboard -> ${STAGE}/dashboard"

# --- b. Renderer code + prebuilt Remotion bundle -----------------------------
log "b. Building renderer (tsc) + prebuilding Remotion bundle"
cd "${REPO_ROOT}/render-service"
[[ -d node_modules ]] || { info "installing render-service deps..."; npm install; }
# The remotion project needs its own deps installed for bundling.
[[ -d "${REPO_ROOT}/remotion/node_modules" ]] || { info "installing remotion deps..."; (cd "${REPO_ROOT}/remotion" && npm install); }
npm run build
rm -rf "${STAGE}/render-service/dist"
mkdir -p "${STAGE}/render-service"
cp -R "${REPO_ROOT}/render-service/dist" "${STAGE}/render-service/dist"
info "renderer dist -> ${STAGE}/render-service/dist"

# Prebuild the Remotion bundle so the packaged app never imports @remotion/bundler.
rm -rf "${STAGE}/remotion-bundle"
npm run prebundle -- "${STAGE}/remotion-bundle"
[[ -f "${STAGE}/remotion-bundle/index.html" ]] || die "prebundle produced no index.html at ${STAGE}/remotion-bundle"
info "remotion bundle -> ${STAGE}/remotion-bundle"

# --- c. Renderer prod node_modules (no @remotion/bundler) --------------------
# render-service/Dockerfile uses plain `npm install` (installs devDeps), so
# @remotion/bundler now lives in devDependencies: Docker still gets it at
# runtime, but a prod-only `npm ci --omit=dev` here leaves it (and its rspack
# native addon) out of the stage. The packaged renderer only needs
# @remotion/renderer (pure JS + the compositor subprocess) because it runs
# against the prebuilt bundle via REMOTION_PREBUILT_BUNDLE.
log "c. Installing renderer production node_modules (--omit=dev)"
cp "${REPO_ROOT}/render-service/package.json" "${STAGE}/render-service/package.json"
cp "${REPO_ROOT}/render-service/package-lock.json" "${STAGE}/render-service/package-lock.json"
( cd "${STAGE}/render-service" && npm ci --omit=dev )

# Assert the expected shape.
[[ -d "${STAGE}/render-service/node_modules/@remotion/renderer" ]] || die "stage missing @remotion/renderer"
[[ -d "${STAGE}/render-service/node_modules/@remotion/compositor-darwin-arm64" ]] || die "stage missing @remotion/compositor-darwin-arm64"
[[ -d "${STAGE}/render-service/node_modules/express" ]] || die "stage missing express"
[[ ! -d "${STAGE}/render-service/node_modules/@remotion/bundler" ]] || die "stage UNEXPECTEDLY contains @remotion/bundler"
if ls -d "${STAGE}/render-service/node_modules/@rspack"* >/dev/null 2>&1; then
  die "stage UNEXPECTEDLY contains @rspack* (the bundler's native addon)"
fi
info "prod node_modules OK: renderer + compositor + express, no bundler/rspack"

# --- d. Portable Python + pip install requirements ---------------------------
log "d. Staging portable CPython ${PY_VERSION} + pip deps"
PY_CACHED="${CACHE}/${PY_TARBALL}"
if [[ ! -f "${PY_CACHED}" ]]; then
  info "downloading ${PY_TARBALL} ..."
  curl -fsSL "${PY_URL}" -o "${PY_CACHED}.tmp"
  mv "${PY_CACHED}.tmp" "${PY_CACHED}"
fi
verify_sha256 "${PY_CACHED}" "${PY_SHA256}"

if [[ ! -x "${STAGE}/python/bin/python3" ]]; then
  info "extracting Python ..."
  rm -rf "${STAGE}/python"
  # Tarball extracts to a top-level "python/" dir.
  tar -xzf "${PY_CACHED}" -C "${STAGE}"
fi
PYBIN="${STAGE}/python/bin/python3"
[[ -x "${PYBIN}" ]] || die "portable python missing at ${PYBIN}"
info "python: $("${PYBIN}" --version)"

info "pip install -r requirements.txt (torch CPU, mediapipe, etc. — may be slow) ..."
"${PYBIN}" -m pip install --upgrade pip >/dev/null
"${PYBIN}" -m pip install -r "${REPO_ROOT}/requirements.txt"

info "smoke-testing imports ..."
"${PYBIN}" -c "import torch, mediapipe, faster_whisper, cv2, yt_dlp, fastapi, PIL; print('imports-ok')" \
  || die "python import smoke test failed"

# --- e. Backend source -------------------------------------------------------
log "e. Staging backend Python source + fonts"
BACKEND="${STAGE}/backend"
mkdir -p "${BACKEND}"
# Exact set of local modules the app imports (grep-verified in app.py/main.py/etc.).
for f in app.py main.py editor.py hooks.py subtitles.py translate.py \
         transcription.py thumbnail.py s3_uploader.py ffmpeg_utils.py requirements.txt; do
  cp "${REPO_ROOT}/${f}" "${BACKEND}/${f}"
done
# Hook fonts: hooks.py uses FONT_DIR="fonts" relative to cwd (backend runs cwd=backend).
rm -rf "${BACKEND}/fonts"
cp -R "${REPO_ROOT}/fonts" "${BACKEND}/fonts"
# Caption + RTL fonts: subtitles.py/_FONTS_DIR and hooks.py ARABIC_FONT_PATH resolve
# <module dir>/remotion/public/fonts relative to __file__.
mkdir -p "${BACKEND}/remotion/public"
rm -rf "${BACKEND}/remotion/public/fonts"
cp -R "${REPO_ROOT}/remotion/public/fonts" "${BACKEND}/remotion/public/fonts"
# app.py mounts <module dir>/dashboard/dist as the SPA root.
rm -rf "${BACKEND}/dashboard"
mkdir -p "${BACKEND}/dashboard"
cp -R "${STAGE}/dashboard" "${BACKEND}/dashboard/dist"
info "backend -> ${BACKEND} (modules + fonts + dashboard/dist)"

# --- f. Static ffmpeg + ffprobe ----------------------------------------------
log "f. Staging static ffmpeg + ffprobe (arm64)"
mkdir -p "${STAGE}/bin"
FFMPEG_ZIP="${CACHE}/ffmpeg-${FFMPEG_VER}.zip"
FFPROBE_ZIP="${CACHE}/ffprobe-${FFMPEG_VER}.zip"
[[ -f "${FFMPEG_ZIP}" ]]  || curl -fsSL "${FFMPEG_URL}"  -o "${FFMPEG_ZIP}"
[[ -f "${FFPROBE_ZIP}" ]] || curl -fsSL "${FFPROBE_URL}" -o "${FFPROBE_ZIP}"
verify_sha256 "${FFMPEG_ZIP}"  "${FFMPEG_SHA256}"
verify_sha256 "${FFPROBE_ZIP}" "${FFPROBE_SHA256}"
( cd "${STAGE}/bin" && unzip -o -q "${FFMPEG_ZIP}" && unzip -o -q "${FFPROBE_ZIP}" )
chmod +x "${STAGE}/bin/ffmpeg" "${STAGE}/bin/ffprobe"

# Verify: runnable, libx264 present, both encoders work, no Homebrew deps.
"${STAGE}/bin/ffmpeg" -version >/dev/null || die "staged ffmpeg not runnable"
"${STAGE}/bin/ffprobe" -version >/dev/null || die "staged ffprobe not runnable"
"${STAGE}/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q "libx264" || die "staged ffmpeg lacks libx264"
if otool -L "${STAGE}/bin/ffmpeg" | grep -qi "/opt/homebrew"; then
  die "staged ffmpeg links Homebrew dylibs (not self-contained)"
fi
_ff_tmp="$(mktemp -d)"
"${STAGE}/bin/ffmpeg" -hide_banner -y -f lavfi -i testsrc=duration=1:size=320x240:rate=30 \
  -c:v libx264 -pix_fmt yuv420p "${_ff_tmp}/x264.mp4" >/dev/null 2>&1 || die "libx264 test encode failed"
"${STAGE}/bin/ffmpeg" -hide_banner -y -f lavfi -i testsrc=duration=1:size=320x240:rate=30 \
  -c:v h264_videotoolbox -pix_fmt yuv420p "${_ff_tmp}/vt.mp4" >/dev/null 2>&1 || die "h264_videotoolbox test encode failed"
rm -rf "${_ff_tmp}"
info "ffmpeg/ffprobe verified: arm64, libx264 + videotoolbox, no Homebrew deps"

# --- g. chrome-headless-shell ------------------------------------------------
log "g. Staging chrome-headless-shell"
SHELL_SRC="${REPO_ROOT}/render-service/node_modules/.remotion/chrome-headless-shell/mac-arm64"
if [[ ! -f "$(find "${SHELL_SRC}" -name chrome-headless-shell -type f 2>/dev/null | head -1)" ]]; then
  # render-service only depends on remotion as a library (no CLI binary there —
  # `npx remotion` fails with "could not determine executable to run"). The
  # sibling remotion/ project has the real `remotion` package with its CLI,
  # and both projects share the same browser cache convention.
  info "chrome-headless-shell not found; running 'npx remotion browser ensure' (via remotion/) ..."
  ( cd "${REPO_ROOT}/remotion" && npx --yes remotion browser ensure )
  SHELL_SRC="${REPO_ROOT}/remotion/node_modules/.remotion/chrome-headless-shell/mac-arm64"
fi
SHELL_BIN="$(find "${SHELL_SRC}" -name chrome-headless-shell -type f 2>/dev/null | head -1)"
[[ -n "${SHELL_BIN}" ]] || die "chrome-headless-shell binary not found under ${SHELL_SRC}"
rm -rf "${STAGE}/chrome-headless-shell"
cp -R "${SHELL_SRC}" "${STAGE}/chrome-headless-shell"
STAGED_SHELL_BIN="$(find "${STAGE}/chrome-headless-shell" -name chrome-headless-shell -type f | head -1)"
chmod +x "${STAGED_SHELL_BIN}"
info "chrome-headless-shell -> ${STAGED_SHELL_BIN}"

# --- h. Size report ----------------------------------------------------------
log "h. Stage size report"
for d in dashboard backend render-service remotion-bundle python bin chrome-headless-shell; do
  if [[ -e "${STAGE}/${d}" ]]; then
    printf '    %-22s %s\n' "${d}" "$(du -sh "${STAGE}/${d}" | awk '{print $1}')"
  fi
done
printf '    %-22s %s\n' "TOTAL" "$(du -sh "${STAGE}" | awk '{print $1}')"

log "Stage build complete: ${STAGE}"
echo "Next: scripts/desktop/verify-stage.sh"
