#!/usr/bin/env bash
# Free the OpenShorts dev ports (backend 8000, renderer 3100, dashboard 5175).
# Run this before switching which tool runs the app (e.g. Codex <-> Claude),
# or any time you hit a "port in use" error from an orphaned process.
set -u

for port in 8000 3100 5175; do
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Freeing port $port (PID $pids)"
    kill $pids 2>/dev/null || true
    sleep 0.3
    pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  else
    echo "Port $port already free"
  fi
done

echo "Done. All OpenShorts dev ports are free."
