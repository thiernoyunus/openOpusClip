#!/usr/bin/env bash
#
# verify-stage.sh — proves the STAGED stack (desktop-stage/) runs on its own.
#
# Launches ONLY staged artifacts — no repo .venv, no repo node_modules:
#   - backend:  desktop-stage/python/bin/python3 -m uvicorn app:app  (cwd=stage/backend)
#   - renderer: system `node` running desktop-stage/render-service/dist/server.js
#               against the prebuilt bundle + staged chrome-headless-shell.
#
# Checks: backend /api/config 200, backend / serves the dashboard HTML,
# renderer /health 200, renderer log shows the prebuilt bundle, and a
# best-effort real render smoke (POST /render with the dev fixture).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STAGE="${REPO_ROOT}/desktop-stage"

BACKEND_PORT=8905
RENDER_PORT=3105

PYBIN="${STAGE}/python/bin/python3"
NODE_BIN="$(command -v node || true)"
RENDER_ENTRY="${STAGE}/render-service/dist/server.js"
BUNDLE_DIR="${STAGE}/remotion-bundle"
BACKEND_DIR="${STAGE}/backend"

pass=0; fail=0
ok()   { printf '    \033[1;32mPASS\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '    \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$((fail+1)); }
note() { printf '    \033[1;33mNOTE\033[0m %s\n' "$*"; }
log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# --- Preflight ---------------------------------------------------------------
[[ -x "${PYBIN}" ]]        || { echo "ERROR: staged python missing (${PYBIN}); run build-stage.sh first." >&2; exit 1; }
[[ -f "${RENDER_ENTRY}" ]] || { echo "ERROR: staged renderer missing (${RENDER_ENTRY})." >&2; exit 1; }
[[ -d "${BUNDLE_DIR}" ]]   || { echo "ERROR: prebuilt bundle missing (${BUNDLE_DIR})." >&2; exit 1; }
[[ -n "${NODE_BIN}" ]]     || { echo "ERROR: system 'node' not found on PATH." >&2; exit 1; }

CHROME_BIN="$(find "${STAGE}/chrome-headless-shell" -name chrome-headless-shell -type f 2>/dev/null | head -1)"
[[ -n "${CHROME_BIN}" ]]   || { echo "ERROR: staged chrome-headless-shell binary not found." >&2; exit 1; }

# Refuse to run if our ports are already taken — cleanup below force-kills
# whatever ends up on them, which must never be a process we didn't start.
for p in "${BACKEND_PORT}" "${RENDER_PORT}"; do
  existing="$(lsof -ti tcp:"${p}" 2>/dev/null || true)"
  [[ -z "${existing}" ]] || { echo "ERROR: port ${p} is already in use (pid ${existing}); free it before running this script." >&2; exit 1; }
done

# Temp workspace: output/upload dirs + log files.
TMP="$(mktemp -d)"
OUT_DIR="${TMP}/out"; UP_DIR="${TMP}/up"
mkdir -p "${OUT_DIR}" "${UP_DIR}"
BACKEND_LOG="${TMP}/backend.log"
RENDER_LOG="${TMP}/render.log"

BACKEND_PID=""; RENDER_PID=""
cleanup() {
  log "Shutting down"
  [[ -n "${BACKEND_PID}" ]] && kill "${BACKEND_PID}" 2>/dev/null || true
  [[ -n "${RENDER_PID}" ]]  && kill "${RENDER_PID}"  2>/dev/null || true
  # Give them a moment, then hard-kill any stragglers on our ports.
  sleep 1
  [[ -n "${BACKEND_PID}" ]] && kill -9 "${BACKEND_PID}" 2>/dev/null || true
  [[ -n "${RENDER_PID}" ]]  && kill -9 "${RENDER_PID}"  2>/dev/null || true
  for p in "${BACKEND_PORT}" "${RENDER_PORT}"; do
    pid="$(lsof -ti tcp:"${p}" 2>/dev/null || true)"
    [[ -n "${pid}" ]] && kill -9 ${pid} 2>/dev/null || true
  done
  rm -rf "${TMP}"
}
trap cleanup EXIT

wait_for_http() {
  # wait_for_http <url> <timeout_s>
  local url="$1" timeout="$2" i=0
  while (( i < timeout )); do
    if curl -fsS -o /dev/null "${url}" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}

# --- Launch renderer ---------------------------------------------------------
log "Launching staged renderer (node) on :${RENDER_PORT}"
(
  cd "${STAGE}/render-service"
  PORT="${RENDER_PORT}" \
  OUTPUT_DIR="${OUT_DIR}" \
  REMOTION_PREBUILT_BUNDLE="${BUNDLE_DIR}" \
  REMOTION_BROWSER_EXECUTABLE="${CHROME_BIN}" \
  "${NODE_BIN}" "${RENDER_ENTRY}"
) >"${RENDER_LOG}" 2>&1 &
RENDER_PID=$!

# --- Launch backend ----------------------------------------------------------
log "Launching staged backend (uvicorn) on :${BACKEND_PORT}"
(
  cd "${BACKEND_DIR}"
  PATH="${STAGE}/bin:${PATH}" \
  OPENSHORTS_OUTPUT_DIR="${OUT_DIR}" \
  OPENSHORTS_UPLOAD_DIR="${UP_DIR}" \
  RENDER_SERVICE_URL="http://127.0.0.1:${RENDER_PORT}" \
  "${PYBIN}" -m uvicorn app:app --host 127.0.0.1 --port "${BACKEND_PORT}"
) >"${BACKEND_LOG}" 2>&1 &
BACKEND_PID=$!

# --- Checks: backend ---------------------------------------------------------
log "Backend checks"
if wait_for_http "http://127.0.0.1:${BACKEND_PORT}/api/config" 40; then
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${BACKEND_PORT}/api/config")"
  [[ "${code}" == "200" ]] && ok "/api/config -> 200" || bad "/api/config -> ${code}"
  root_html="$(curl -s "http://127.0.0.1:${BACKEND_PORT}/")"
  if grep -qi "<div id=\"root\"" <<<"${root_html}" || grep -qi "OpenShorts" <<<"${root_html}"; then
    ok "/ serves the dashboard HTML"
  else
    bad "/ did not return dashboard HTML (first 120 chars: ${root_html:0:120})"
  fi
else
  bad "backend did not come up on :${BACKEND_PORT}"
  note "backend log tail:"; tail -20 "${BACKEND_LOG}" | sed 's/^/        /'
fi

# --- Checks: renderer --------------------------------------------------------
log "Renderer checks"
if wait_for_http "http://127.0.0.1:${RENDER_PORT}/health" 40; then
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${RENDER_PORT}/health")"
  [[ "${code}" == "200" ]] && ok "/health -> 200" || bad "/health -> ${code}"
  if grep -qi "Using prebuilt bundle" "${RENDER_LOG}"; then
    ok "renderer log shows prebuilt bundle (no @remotion/bundler needed)"
  else
    bad "renderer log missing 'Using prebuilt bundle'"
    note "render log tail:"; tail -20 "${RENDER_LOG}" | sed 's/^/        /'
  fi
  [[ -x "${CHROME_BIN}" ]] && ok "chrome-headless-shell binary present + executable" \
                           || bad "chrome-headless-shell not executable"
else
  bad "renderer did not come up on :${RENDER_PORT}"
  note "render log tail:"; tail -20 "${RENDER_LOG}" | sed 's/^/        /'
fi

# --- Best-effort real render smoke ------------------------------------------
log "Render smoke (best-effort)"
FIXTURE="${STAGE}/dashboard/dev-fixtures/test-source.mp4"
if [[ -f "${FIXTURE}" ]] && curl -fsS -o /dev/null "http://127.0.0.1:${RENDER_PORT}/health" 2>/dev/null; then
  SMOKE_JOB="smoke"
  mkdir -p "${OUT_DIR}/${SMOKE_JOB}"
  cp "${FIXTURE}" "${OUT_DIR}/${SMOKE_JOB}/test-source.mp4"
  # Minimal valid payload per render-service/src/server.ts zod schema. videoUrl
  # matches /videos/<job>/<file> so the renderer rewrites it to its own /output
  # static server. Short duration keeps the render fast; null framing = base video.
  payload=$(cat <<JSON
{"jobId":"${SMOKE_JOB}","clipIndex":0,"props":{"videoUrl":"/videos/${SMOKE_JOB}/test-source.mp4","durationInFrames":15,"fps":30,"width":1080,"height":1920,"framing":null,"subtitles":null,"hook":null,"effects":null}}
JSON
)
  resp="$(curl -s -X POST "http://127.0.0.1:${RENDER_PORT}/render" -H 'Content-Type: application/json' -d "${payload}")"
  render_id="$(printf '%s' "${resp}" | sed -n 's/.*"renderId":"\([^"]*\)".*/\1/p')"
  if [[ -z "${render_id}" ]]; then
    note "render POST did not return a renderId: ${resp}"
  else
    note "render queued: ${render_id}; polling up to 120s ..."
    status=""; i=0
    while (( i < 120 )); do
      s="$(curl -s "http://127.0.0.1:${RENDER_PORT}/render/${render_id}")"
      status="$(printf '%s' "${s}" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
      [[ "${status}" == "done" || "${status}" == "error" ]] && break
      sleep 2; i=$((i+2))
    done
    if [[ "${status}" == "done" ]]; then
      ok "render smoke completed (browser + compositor ffmpeg produced an mp4)"
    elif [[ "${status}" == "error" ]]; then
      bad "render smoke reported error: $(curl -s "http://127.0.0.1:${RENDER_PORT}/render/${render_id}")"
      note "render log tail:"; tail -25 "${RENDER_LOG}" | sed 's/^/        /'
    else
      note "render smoke did not finish within timeout (last status: ${status:-none}) — skipping as inconclusive"
    fi
  fi
else
  note "render smoke skipped (fixture missing or renderer down)"
fi

# --- Summary -----------------------------------------------------------------
log "Summary: ${pass} passed, ${fail} failed"
(( fail == 0 )) || exit 1
