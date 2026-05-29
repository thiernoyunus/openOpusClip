#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS=()

cleanup() {
  echo
  echo "Stopping OpenShorts..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}

trap cleanup EXIT INT TERM

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Freeing port $port"
    kill $pids 2>/dev/null || true
    sleep 0.5
    pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

if [ ! -d "$ROOT_DIR/.venv" ]; then
  echo "Missing .venv. Run: python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi

mkdir -p "$ROOT_DIR/output"

stop_port 8000
stop_port 3100
stop_port 5175

echo "Starting backend on http://localhost:8000"
(
  cd "$ROOT_DIR"
  source .venv/bin/activate
  RENDER_SERVICE_URL=http://localhost:3100 uvicorn app:app --host 0.0.0.0 --port 8000
) &
PIDS+=("$!")

sleep 2

echo "Starting renderer on http://localhost:3100"
(
  cd "$ROOT_DIR/render-service"
  OUTPUT_DIR="$ROOT_DIR/output" \
  REMOTION_BUNDLE_PATH="$ROOT_DIR/remotion" \
  PORT=3100 \
  npm run dev
) &
PIDS+=("$!")

sleep 2

echo "Starting dashboard on http://localhost:5175/#app"
(
  cd "$ROOT_DIR/dashboard"
  npm run dev -- --host 0.0.0.0 --port 5175 --strictPort
) &
PIDS+=("$!")

echo
echo "OpenShorts is starting. Open http://localhost:5175/#app"
echo "Press Ctrl+C here to stop everything."

wait
