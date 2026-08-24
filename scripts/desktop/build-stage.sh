#!/usr/bin/env bash
#
# build-stage.sh — Step A of desktop packaging.
#
# Assembles every runtime ingredient of a self-contained macOS OpenShorts
# app into a single `desktop-stage/` folder at the repo root. Each step is
# idempotent and caches large downloads in `.desktop-build-cache/`.
#
# Staged layout (all consumed by scripts/desktop/verify-stage.sh):
#   desktop-stage/
#     dashboard/                 built Vite dashboard (copy of dashboard/dist)
#     backend/                   Python runtime source (app.py, main.py, ...)
#       dashboard/dist/          copy of the built dashboard (app.py mounts this)
#     render-service/dist/       compiled TS renderer (node dist/server.js)
#     render-service/node_modules  prod-only deps (@remotion/renderer + compositor, express; NO bundler)
#     remotion-bundle/           prebuilt Remotion bundle (REMOTION_PREBUILT_BUNDLE)
#     python/                    portable CPython 3.11 (python-build-standalone)
#     bin/                       static ffmpeg + ffprobe (target arch, no Homebrew deps)
#     chrome-headless-shell/     headless Chrome for Remotion rendering
#
set -euo pipefail

# --- 0. Guards ---------------------------------------------------------------

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: this staging pipeline only builds on macOS. Detected: $(uname -s)" >&2
  exit 1
fi

# Target architecture. Defaults to the host arch, normalized to
# electron-builder's naming (arm64 | x64), and overridable with --arch so an
# Apple Silicon machine can cross-build the Intel stage.
case "$(uname -m)" in
  arm64)  TARGET_ARCH="arm64" ;;
  x86_64) TARGET_ARCH="x64" ;;
  *) echo "ERROR: unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      [[ $# -ge 2 ]] || { echo "ERROR: --arch requires a value (arm64|x64)" >&2; exit 1; }
      TARGET_ARCH="$2"; shift 2 ;;
    --arch=*) TARGET_ARCH="${1#*=}"; shift ;;
    -h|--help) echo "usage: $(basename "$0") [--arch arm64|x64]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ "${TARGET_ARCH}" == "arm64" || "${TARGET_ARCH}" == "x64" ]] \
  || { echo "ERROR: --arch must be arm64 or x64 (got: ${TARGET_ARCH})" >&2; exit 1; }

# Per-arch naming used by the pinned downloads below.
#
# Windows is NOT built here. It lives in scripts/desktop/build-stage.ps1 as a
# separate script rather than a --platform flag on this one, because almost
# nothing about the pipeline survived the crossing: different Python layout
# (python\python.exe, no bin/), different ffmpeg source, no otool/file/Rosetta,
# no codesigning, and a bundled node.exe that macOS does not need. Sharing one
# script would have meant an `if` around nearly every line. The two are kept in
# step by hand — if you change what gets staged here (a new backend module, a
# new font folder, a different prune list), make the same change there.
if [[ "${TARGET_ARCH}" == "arm64" ]]; then
  PY_ARCH="aarch64"        # python-build-standalone triple
  FF_ARCH="arm64"          # ffmpeg.martin-riedl.de path segment
  CHROME_ARCH="mac-arm64"  # remotion browser cache dir
  STAGE_SUFFIX=""
else
  PY_ARCH="x86_64"
  FF_ARCH="amd64"
  CHROME_ARCH="mac-x64"
  STAGE_SUFFIX="-x64"
fi

# Running the staged x64 CPython (for pip install + the import smoke test) on an
# Apple Silicon host needs Rosetta 2. Emulate only when host and target differ.
#
# `command` is a harmless no-op prefix rather than an empty array: macOS ships
# bash 3.2, where "${EMULATE[@]}" on an empty array is an "unbound variable"
# error under `set -u`, which would break every native build.
EMULATE=(command)
# Explicit flag for "is this a cross build?" — clearer than counting EMULATE's
# elements, and immune to the no-op prefix above.
CROSS_BUILD=0
if [[ "${TARGET_ARCH}" == "x64" && "$(uname -m)" == "arm64" ]]; then
  /usr/bin/pgrep -q oahd \
    || { echo "ERROR: cross-building x64 needs Rosetta 2. Install it with: softwareupdate --install-rosetta" >&2; exit 1; }
  EMULATE=(arch -x86_64)
  CROSS_BUILD=1

  # Some pure-Python deps have no macOS Intel wheel anymore and are built from
  # source instead (notably `cryptography`, a transitive google-genai dep whose
  # macOS wheels are arm64-only from 46.0.4 on). Those builds need a Rust
  # toolchain that can target x86_64 — Homebrew's `rust` only ships the host
  # standard library, so prefer a rustup toolchain when one is present.
  # Put a toolchain that CAN target x86_64 ahead of anything else on PATH.
  # `~/.cargo/bin` is only populated by rustup's own installer, so also look
  # directly inside the rustup toolchain dir (brew's rustup doesn't create the
  # shims). Homebrew's `rust` must not win here: cargo shells out to whichever
  # rustc it finds first, and brew's ships only the host standard library.
  export RUSTUP_HOME="${RUSTUP_HOME:-${HOME}/.rustup}"
  export CARGO_HOME="${CARGO_HOME:-${HOME}/.cargo}"
  for _rust_bin in \
    "${CARGO_HOME}/bin" \
    "${RUSTUP_HOME}"/toolchains/stable-*/bin
  do
    if [[ -x "${_rust_bin}/rustc" ]] \
       && "${_rust_bin}/rustc" --print target-libdir --target x86_64-apple-darwin >/dev/null 2>&1; then
      export PATH="${_rust_bin}:${PATH}"
      # log helpers aren't defined yet at this point in the script.
      printf '    rust toolchain for x86_64: %s\n' "${_rust_bin}"
      break
    fi
  done

  # Not fatal: the x64 pip install runs with --only-binary=:all: plus a
  # constraints file precisely so nothing has to be compiled. This is only a
  # heads-up for the day a new dep has no Intel wheel.
  if ! rustc --print target-libdir --target x86_64-apple-darwin >/dev/null 2>&1; then
    printf '    NOTE: no rustc here can target x86_64-apple-darwin. Fine while every\n'
    printf '          Intel dep ships a wheel; if one ever needs compiling, run:\n'
    printf '            brew install rustup && rustup toolchain install stable --profile minimal\n'
    printf '            rustup target add x86_64-apple-darwin\n'
  fi
fi

# Repo root = two levels up from this script (scripts/desktop/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STAGE="${REPO_ROOT}/desktop-stage${STAGE_SUFFIX}"
CACHE="${REPO_ROOT}/.desktop-build-cache"

mkdir -p "${STAGE}" "${CACHE}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- Pinned artifacts --------------------------------------------------------
# python-build-standalone CPython 3.11 (install_only), per target arch.
PY_RELEASE="20260623"
PY_VERSION="3.11.15"
PY_TARBALL="cpython-${PY_VERSION}+${PY_RELEASE}-${PY_ARCH}-apple-darwin-install_only.tar.gz"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${PY_TARBALL}"

# Static ffmpeg/ffprobe from ffmpeg.martin-riedl.de, pinned to a resolved
# versioned build (8.1.2) per arch. NOTE: the arm64 and amd64 builds of the same
# ffmpeg version carry DIFFERENT build ids, so the version segment is per-arch.
if [[ "${TARGET_ARCH}" == "arm64" ]]; then
  PY_SHA256="d2324bfd1a7b9fc44ccd884c3a2505bcab6691dbfd4f8270e10c50aaa4e19506"
  FFMPEG_VER="1783011502_8.1.2"
  FFMPEG_SHA256="ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c"
  FFPROBE_SHA256="c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf"
else
  PY_SHA256="38f3c18a4ccbd6faa09243c45c85d8e09b5a7b345e02f174346cf72ebf901f87"
  FFMPEG_VER="1783018342_8.1.2"
  FFMPEG_SHA256="a52ef43883f44c219766d4b3bdde4e635b35465d0b704c01c3a0566b59775df9"
  FFPROBE_SHA256="5408ca588c8c72b0dde3afe676d0a7acf25ef97e55ae6eba5c7bede1cda42695"
fi
FFMPEG_URL="https://ffmpeg.martin-riedl.de/download/macos/${FF_ARCH}/${FFMPEG_VER}/ffmpeg.zip"
FFPROBE_URL="https://ffmpeg.martin-riedl.de/download/macos/${FF_ARCH}/${FFMPEG_VER}/ffprobe.zip"

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
# Wipe first: npm ci prunes packages but can leave empty scope dirs (e.g. an
# @rspack/ husk from an interrupted run), which false-positive the guard below.
rm -rf "${STAGE}/render-service/node_modules"
# --cpu forces npm to resolve the TARGET arch's optional native addon
# (@remotion/compositor-darwin-<arch>) instead of the host's, which is what
# makes cross-building the Intel stage from Apple Silicon possible.
( cd "${STAGE}/render-service" && npm ci --omit=dev --cpu="${TARGET_ARCH}" --os=darwin )

# npm resolves optional native addons for the host when --cpu is unsupported by
# the local npm, so verify we actually got the target's compositor and not the
# host's. A wrong-arch compositor fails only at render time on the user's Mac.
if [[ -d "${STAGE}/render-service/node_modules/@remotion/compositor-darwin-${TARGET_ARCH}" ]]; then
  _comp_bin="$(find "${STAGE}/render-service/node_modules/@remotion/compositor-darwin-${TARGET_ARCH}" -type f -name 'compositor*' -perm -u+x -print -quit 2>/dev/null)"
  if [[ -n "${_comp_bin}" ]]; then
    _want_macho="x86_64"; [[ "${TARGET_ARCH}" == "arm64" ]] && _want_macho="arm64"
    file "${_comp_bin}" | grep -q "${_want_macho}" \
      || die "staged compositor is not ${_want_macho}: $(file "${_comp_bin}")"
    info "compositor binary verified: ${_want_macho}"
  fi
fi

# Assert the expected shape.
[[ -d "${STAGE}/render-service/node_modules/@remotion/renderer" ]] || die "stage missing @remotion/renderer"
[[ -d "${STAGE}/render-service/node_modules/@remotion/compositor-darwin-${TARGET_ARCH}" ]] || die "stage missing @remotion/compositor-darwin-${TARGET_ARCH}"
[[ -d "${STAGE}/render-service/node_modules/express" ]] || die "stage missing express"
[[ ! -d "${STAGE}/render-service/node_modules/@remotion/bundler" ]] || die "stage UNEXPECTEDLY contains @remotion/bundler"
# Content check, not existence: npm 10 pre-creates EMPTY scope dirs for
# dev-omitted packages (e.g. @rspack/), which is harmless.
if [[ -n "$(find "${STAGE}/render-service/node_modules" -maxdepth 3 -path '*/@rspack/*' -type f -print -quit 2>/dev/null)" ]]; then
  die "stage UNEXPECTEDLY contains @rspack files (the bundler's native addon)"
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
# The staged interpreter is built for TARGET_ARCH, so on a cross build every
# invocation of it has to go through Rosetta (EMULATE is empty for native builds).
info "python: $("${EMULATE[@]}" "${PYBIN}" --version)"
_py_macho="x86_64"; [[ "${TARGET_ARCH}" == "arm64" ]] && _py_macho="arm64"
file "${STAGE}/python/bin/python3.11" 2>/dev/null | grep -q "${_py_macho}" \
  || die "staged python is not ${_py_macho}: $(file "${STAGE}/python/bin/python3.11" 2>/dev/null)"

info "pip install -r requirements.txt (torch CPU, mediapipe, etc. — may be slow) ..."
"${EMULATE[@]}" "${PYBIN}" -m pip install --upgrade pip >/dev/null
# --only-binary=:all: is deliberate on the Intel stage: a source build here would
# silently pull in a native toolchain (Rust + OpenSSL) and could produce an
# arm64-tainted artifact. Failing loudly on a missing wheel is safer.
PIP_ARGS=(-r "${REPO_ROOT}/requirements.txt")
if [[ "${TARGET_ARCH}" == "x64" ]]; then
  PIP_ARGS+=(--constraint "${SCRIPT_DIR}/constraints-macos-x64.txt" --only-binary=:all:)
  info "using macOS x64 pip constraints (see scripts/desktop/constraints-macos-x64.txt)"
fi
"${EMULATE[@]}" "${PYBIN}" -m pip install "${PIP_ARGS[@]}"

# Prune packages that pip pulls in as declared dependencies but this app never
# actually executes. Each one below was verified by removing it and re-running
# the real code paths (see the smoke test right after): jax/jaxlib are only used
# by mediapipe's unrelated LLM weight-conversion tools, onnxruntime only by a
# faster-whisper VAD backend we don't select, polars/networkx/sympy only by
# ultralytics training and torch compile paths the app never enters.
#
# This is a size/build-time win, not a correctness one: ~670 MB out of the stage
# means that much less to copy, sign, and compress into the DMG.
#
# torchvision is deliberately NOT pruned: ultralytics reads its version metadata
# at import time and raises PackageNotFoundError without it.
#
# functorch is deliberately NOT pruned either. On Apple Silicon it is an empty
# compatibility shim, but the Intel build resolves to an older torch whose
# libtorch_global_deps.dylib links @loader_path/../../functorch/.dylibs/
# libiomp5.dylib — so removing it makes `import torch` fail outright with a
# dlopen error. Same prune, harmless on one arch and fatal on the other.
#
# __pycache__ is also deliberately NOT pruned, even though it is ~310 MB and
# 13k files. Inside a signed .app those files cannot be regenerated (the bundle
# is read-only and writing into it would break the code signature), so removing
# them makes every app launch recompile from source instead.
log "d2. Pruning unused Python packages"
SITE="${STAGE}/python/lib/python3.11/site-packages"
_pruned_before="$(du -sk "${STAGE}/python" | awk '{print $1}')"
for _pkg in jax jaxlib sympy mpmath onnxruntime polars _polars_runtime_32 \
            polars_runtime_32 networkx isympy.py; do
  for _match in "${SITE}/${_pkg}" "${SITE}/${_pkg}-"*.dist-info; do
    [[ -e "${_match}" ]] && rm -rf "${_match}"
  done
  # The glob above often matches nothing, which would otherwise trip `set -e`.
  true
done
_pruned_after="$(du -sk "${STAGE}/python" | awk '{print $1}')"
info "python runtime: $(( _pruned_before / 1024 )) MB -> $(( _pruned_after / 1024 )) MB"

info "smoke-testing imports ..."
# Runs AFTER the prune on purpose: this is what catches an over-aggressive prune.
# ultralytics + the faster-whisper VAD + a real mediapipe face detection pass are
# included because those are the paths that actually broke when tested.
#
# The live mediapipe inference runs only on a native build: it initialises a GPU
# context, which Rosetta cannot reach — same reason the videotoolbox encode above
# is skipped when cross-building. On a cross build we still import everything,
# which is what actually catches an over-aggressive prune.
if [[ "${CROSS_BUILD}" -eq 0 ]]; then
  _SMOKE_INFER="fd = mediapipe.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5); fd.process(np.zeros((480, 640, 3), dtype=np.uint8))"
else
  _SMOKE_INFER="pass  # skipped: GPU inference is unavailable under Rosetta"
  note_mp="mediapipe: imported but not run (cross build under Rosetta)"
fi
"${EMULATE[@]}" "${PYBIN}" - <<SMOKE || die "python import smoke test failed"
import numpy as np
import torch, mediapipe, faster_whisper, cv2, yt_dlp, fastapi, PIL
import scenedetect, boto3
from ultralytics import YOLO
from faster_whisper.vad import get_speech_timestamps
${_SMOKE_INFER}
print('imports-ok')
SMOKE
[[ -n "${note_mp:-}" ]] && info "${note_mp}"

# --- e. Backend source -------------------------------------------------------
log "e. Staging backend Python source"
BACKEND="${STAGE}/backend"
# Refresh the whole generated backend tree so deleted source modules cannot
# survive a rebuild and end up inside a new installer.
rm -rf "${BACKEND}"
mkdir -p "${BACKEND}"
# Exact set of local modules the app imports (grep-verified in app.py/main.py/etc.).
for f in app.py main.py editor.py \
         transcription.py transcription_worker.py thumbnail.py s3_uploader.py ffmpeg_utils.py requirements.txt; do
  cp "${REPO_ROOT}/${f}" "${BACKEND}/${f}"
done
# app.py mounts <module dir>/dashboard/dist as the SPA root.
rm -rf "${BACKEND}/dashboard"
mkdir -p "${BACKEND}/dashboard"
cp -R "${STAGE}/dashboard" "${BACKEND}/dashboard/dist"
info "backend -> ${BACKEND} (modules + dashboard/dist)"

# --- f. Static ffmpeg + ffprobe ----------------------------------------------
log "f. Staging static ffmpeg + ffprobe (${TARGET_ARCH})"
mkdir -p "${STAGE}/bin"
# Cache key includes the arch: the two builds share a version string but not a
# build id, and an arch-blind key would serve the wrong binary from cache.
FFMPEG_ZIP="${CACHE}/ffmpeg-${FF_ARCH}-${FFMPEG_VER}.zip"
FFPROBE_ZIP="${CACHE}/ffprobe-${FF_ARCH}-${FFMPEG_VER}.zip"
[[ -f "${FFMPEG_ZIP}" ]]  || curl -fsSL "${FFMPEG_URL}"  -o "${FFMPEG_ZIP}"
[[ -f "${FFPROBE_ZIP}" ]] || curl -fsSL "${FFPROBE_URL}" -o "${FFPROBE_ZIP}"
verify_sha256 "${FFMPEG_ZIP}"  "${FFMPEG_SHA256}"
verify_sha256 "${FFPROBE_ZIP}" "${FFPROBE_SHA256}"
( cd "${STAGE}/bin" && unzip -o -q "${FFMPEG_ZIP}" && unzip -o -q "${FFPROBE_ZIP}" )
chmod +x "${STAGE}/bin/ffmpeg" "${STAGE}/bin/ffprobe"

# Confirm the staged binaries are actually the target arch before trusting the
# functional checks below (a wrong-arch ffmpeg would still "work" under Rosetta
# here while failing to launch natively on the user's Intel Mac).
_ff_macho="x86_64"; [[ "${TARGET_ARCH}" == "arm64" ]] && _ff_macho="arm64"
file "${STAGE}/bin/ffmpeg"  | grep -q "${_ff_macho}" || die "staged ffmpeg is not ${_ff_macho}: $(file "${STAGE}/bin/ffmpeg")"
file "${STAGE}/bin/ffprobe" | grep -q "${_ff_macho}" || die "staged ffprobe is not ${_ff_macho}: $(file "${STAGE}/bin/ffprobe")"

# Verify: runnable, libx264 present, both encoders work, no Homebrew deps.
"${EMULATE[@]}" "${STAGE}/bin/ffmpeg" -version >/dev/null || die "staged ffmpeg not runnable"
"${EMULATE[@]}" "${STAGE}/bin/ffprobe" -version >/dev/null || die "staged ffprobe not runnable"
"${EMULATE[@]}" "${STAGE}/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q "libx264" || die "staged ffmpeg lacks libx264"
if otool -L "${STAGE}/bin/ffmpeg" | grep -qi "/opt/homebrew"; then
  die "staged ffmpeg links Homebrew dylibs (not self-contained)"
fi
_ff_tmp="$(mktemp -d)"
"${EMULATE[@]}" "${STAGE}/bin/ffmpeg" -hide_banner -y -f lavfi -i testsrc=duration=1:size=320x240:rate=30 \
  -c:v libx264 -pix_fmt yuv420p "${_ff_tmp}/x264.mp4" >/dev/null 2>&1 || die "libx264 test encode failed"
# videotoolbox is hardware-backed. Under Rosetta on an Apple Silicon host the
# x64 encoder can't reach the media engine, so a failure here says nothing about
# the real Intel machine — verify the encoder is COMPILED IN and leave the
# runtime check to a native host.
if [[ "${CROSS_BUILD}" -eq 0 ]]; then
  "${STAGE}/bin/ffmpeg" -hide_banner -y -f lavfi -i testsrc=duration=1:size=320x240:rate=30 \
    -c:v h264_videotoolbox -pix_fmt yuv420p "${_ff_tmp}/vt.mp4" >/dev/null 2>&1 || die "h264_videotoolbox test encode failed"
else
  "${EMULATE[@]}" "${STAGE}/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q "h264_videotoolbox" \
    || die "staged ffmpeg lacks h264_videotoolbox"
  note_vt="videotoolbox: present but not test-encoded (cross build under Rosetta)"
fi
rm -rf "${_ff_tmp}"
info "ffmpeg/ffprobe verified: ${TARGET_ARCH}, libx264 + videotoolbox, no Homebrew deps"
[[ -n "${note_vt:-}" ]] && info "${note_vt}"

# --- g. chrome-headless-shell ------------------------------------------------
log "g. Staging chrome-headless-shell"
# `remotion browser ensure` only ever fetches the HOST's browser, so it can
# stage the target's browser only on a native build. For a cross build we fetch
# the same pinned Chrome-for-Testing version Remotion expects, read straight
# from the installed renderer so the two can never drift.
CHROME_VERSION="$(node -p "require('${REPO_ROOT}/remotion/node_modules/@remotion/renderer/dist/browser/get-chrome-download-url.js').TESTED_VERSION" 2>/dev/null || true)"
[[ -n "${CHROME_VERSION}" ]] || die "could not read Remotion's pinned Chrome version (TESTED_VERSION)"
info "Remotion pins Chrome ${CHROME_VERSION}"

if [[ "${CROSS_BUILD}" -eq 0 ]]; then
  # Native: let the CLI resolve + validate the cached browser (it re-downloads a
  # stale one, which a presence-only check would happily stage).
  info "ensuring chrome-headless-shell via remotion/ CLI ..."
  ( cd "${REPO_ROOT}/remotion" && npx --yes remotion browser ensure )
  SHELL_SRC="${REPO_ROOT}/remotion/node_modules/.remotion/chrome-headless-shell/${CHROME_ARCH}"
  SHELL_BIN="$(find "${SHELL_SRC}" -name chrome-headless-shell -type f 2>/dev/null | head -1)"
  [[ -n "${SHELL_BIN}" ]] || die "chrome-headless-shell binary not found under ${SHELL_SRC}"
  rm -rf "${STAGE}/chrome-headless-shell"
  cp -R "${SHELL_SRC}" "${STAGE}/chrome-headless-shell"
else
  # Cross build: download the target arch's browser at Remotion's pinned version.
  CHROME_ZIP="${CACHE}/chrome-headless-shell-${CHROME_ARCH}-${CHROME_VERSION}.zip"
  if [[ ! -f "${CHROME_ZIP}" ]]; then
    info "downloading chrome-headless-shell ${CHROME_VERSION} (${CHROME_ARCH}) ..."
    curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${CHROME_ARCH}/chrome-headless-shell-${CHROME_ARCH}.zip" \
      -o "${CHROME_ZIP}.tmp" || die "chrome-headless-shell download failed for ${CHROME_ARCH} ${CHROME_VERSION}"
    mv "${CHROME_ZIP}.tmp" "${CHROME_ZIP}"
  fi
  rm -rf "${STAGE}/chrome-headless-shell"
  mkdir -p "${STAGE}/chrome-headless-shell"
  # The zip contains a chrome-headless-shell-<platform>/ top level, which matches
  # the layout main.js expects under the staged dir.
  ( cd "${STAGE}/chrome-headless-shell" && unzip -o -q "${CHROME_ZIP}" )
fi

STAGED_SHELL_BIN="$(find "${STAGE}/chrome-headless-shell" -name chrome-headless-shell -type f | head -1)"
[[ -n "${STAGED_SHELL_BIN}" ]] || die "staged chrome-headless-shell binary not found"
chmod +x "${STAGED_SHELL_BIN}"
_cr_macho="x86_64"; [[ "${TARGET_ARCH}" == "arm64" ]] && _cr_macho="arm64"
file "${STAGED_SHELL_BIN}" | grep -q "${_cr_macho}" \
  || die "staged chrome-headless-shell is not ${_cr_macho}: $(file "${STAGED_SHELL_BIN}")"
info "chrome-headless-shell -> ${STAGED_SHELL_BIN}"

# --- h. Size report ----------------------------------------------------------
log "h. Stage size report"
for d in dashboard backend render-service remotion-bundle python bin chrome-headless-shell; do
  if [[ -e "${STAGE}/${d}" ]]; then
    printf '    %-22s %s\n' "${d}" "$(du -sh "${STAGE}/${d}" | awk '{print $1}')"
  fi
done
printf '    %-22s %s\n' "TOTAL" "$(du -sh "${STAGE}" | awk '{print $1}')"

log "Stage build complete: ${STAGE} (${TARGET_ARCH})"
if [[ "${CROSS_BUILD}" -eq 0 ]]; then
  echo "Next: scripts/desktop/verify-stage.sh"
else
  echo "Next: package with electron-builder --mac dir --${TARGET_ARCH}"
  echo "NOTE: verify-stage.sh runs the staged backend directly, so it only works"
  echo "      on a native host. Verify this x64 stage on an Intel Mac."
fi
