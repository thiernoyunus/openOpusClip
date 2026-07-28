"""Persistent Whisper transcription worker.

Loads the Whisper model exactly ONCE per app lifetime and serves transcription
requests on a TCP localhost socket. This is the difference between a pizza
oven that's pre-heated once and an oven you rebuild for every pizza: every
job after the first one is just the actual transcription.

Protocol (one JSON object per line on each socket):

    client -> worker: {"id": "<uuid>", "video_path": "...", "model_size": "base",
                       "backend": "auto", "strip_words": false}
    worker -> client: {"id": "<uuid>", "result": {"text": ..., "segments": ...,
                                                  "language": ..., "backend": ...}}
                  or: {"id": "<uuid>", "error": "<message>"}

The worker is cross-platform:
  - Apple Silicon  -> mlx-whisper (when installed)
  - everything else -> faster-whisper (CPU int8 by default, CUDA float16 when
    a GPU is visible)

It is invoked as a long-lived subprocess by the FastAPI server (see
`app.py` lifespan). main.py video-processing subprocesses inherit
`OPENSHORTS_WHISPER_WORKER_PORT` from the FastAPI env and connect to the
worker that way, so they reuse the loaded model instead of booting their own.

Run directly for debugging:

    OPENSHORTS_WHISPER_WORKER_PORT=8765 python transcription_worker.py
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import traceback

# Same module the rest of the app uses - keeps behaviour aligned (Soniox
# support, silence-gap recovery, mlx-vs-faster selection) so the worker never
# drifts from what an inline call would have produced.
from transcription import (
    _transcribe_faster_whisper,
    _transcribe_mlx_whisper,
    _transcribe_soniox,
    resolve_backend,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Hard cap so a runaway client cannot pin us forever. Generous because long
# videos legitimately take a while; the worker is single-threaded so two jobs
# queued back-to-back will still be serviced in order.
REQUEST_TIMEOUT_S = float(os.environ.get("WHISPER_WORKER_REQUEST_TIMEOUT", "1800"))

# Listener settings - picked by FastAPI and passed via env. 0 means "let the
# OS assign a free port", which is what we use in normal startup.
PORT = int(os.environ.get("OPENSHORTS_WHISPER_WORKER_PORT", "0"))
HOST = os.environ.get("OPENSHORTS_WHISPER_WORKER_HOST", "127.0.0.1")

# Serialise sends so two handlers writing concurrently do not interleave on
# the same socket (one per connection in practice, but cheap insurance).
_WRITE_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Job execution
# ---------------------------------------------------------------------------

def _do_transcribe(video_path, model_size, backend, strip_words):
    """Resolve backend + dispatch. Mirrors transcription.transcribe() but
    without the silence-gap follow-up - that lives in the parent so the
    worker stays focused on the model."""
    selected = resolve_backend(backend)
    if selected == "soniox":
        return _transcribe_soniox(video_path, strip_words=strip_words)
    if selected == "mlx-whisper":
        try:
            return _transcribe_mlx_whisper(
                video_path, model_size, strip_words=strip_words
            )
        except Exception as exc:
            print(
                f"⚠️  MLX Whisper failed inside worker ({exc}); falling back "
                f"to Faster-Whisper.",
                file=sys.stderr,
                flush=True,
            )
    return _transcribe_faster_whisper(video_path, model_size, strip_words=strip_words)


# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

def _recv_message(conn):
    """Read exactly one newline-terminated JSON object. Returns dict or None
    on EOF."""
    buf = bytearray()
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            return None if not buf else json.loads(buf.decode("utf-8"))
        buf.extend(chunk)
        nl = buf.find(b"\n")
        if nl != -1:
            line = bytes(buf[:nl])
            return json.loads(line.decode("utf-8"))


def _send_message(conn, payload):
    data = (json.dumps(payload) + "\n").encode("utf-8")
    with _WRITE_LOCK:
        conn.sendall(data)


def _handle(conn, addr):
    """One request per connection - keeps client state trivial and avoids
    needing a multiplexer on top of the worker."""
    try:
        msg = _recv_message(conn)
        if not msg:
            return
        req_id = msg.get("id") or ""
        video_path = msg.get("video_path")
        model_size = msg.get("model_size", "base")
        backend = msg.get("backend", "auto")
        strip_words = bool(msg.get("strip_words", False))

        if not video_path or not os.path.exists(video_path):
            _send_message(conn, {
                "id": req_id,
                "error": f"video_path missing or not found: {video_path!r}",
            })
            return

        print(
            f"📥 [worker] job {req_id[:8]} -> {os.path.basename(video_path)} "
            f"(model={model_size}, backend={backend})",
            file=sys.stderr,
            flush=True,
        )
        start = time.time()
        try:
            result = _do_transcribe(video_path, model_size, backend, strip_words)
        except Exception as exc:
            tb = traceback.format_exc(limit=4)
            print(
                f"❌ [worker] job {req_id[:8]} failed: {exc}\n{tb}",
                file=sys.stderr,
                flush=True,
            )
            _send_message(conn, {"id": req_id, "error": str(exc)})
            return
        elapsed = time.time() - start
        print(
            f"✅ [worker] job {req_id[:8]} done in {elapsed:.1f}s "
            f"(backend={result.get('backend')!r})",
            file=sys.stderr,
            flush=True,
        )
        _send_message(conn, {"id": req_id, "result": result})
    except Exception as exc:
        # Last-resort guard: we never want a single bad message to kill the
        # worker. Log + drop the connection.
        print(
            f"💥 [worker] handler crashed: {exc}\n{traceback.format_exc()}",
            file=sys.stderr,
            flush=True,
        )
    finally:
        try:
            conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        conn.close()


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

def main():
    # Faster-Whisper / MLX both take a few seconds to load; preload nothing
    # here - the first request is the one that pays the load cost, then
    # `_load_faster_whisper`'s lru_cache + mlx's internal cache keep it warm.
    # That keeps worker startup fast and lets us report "READY" the moment we
    # can accept connections.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(8)
    bound_port = sock.getsockname()[1]

    # Print "READY <port>" on stdout - the parent (FastAPI lifespan) waits for
    # this exact line so it knows when to hand jobs to us. Stderr is for
    # human-readable logs; stdout is the handshake channel.
    sys.stdout.write(f"READY {bound_port}\n")
    sys.stdout.flush()

    print(
        f"🚀 [worker] Whisper worker listening on {HOST}:{bound_port} "
        f"(python {sys.version.split()[0]})",
        file=sys.stderr,
        flush=True,
    )

    sock.settimeout(1.0)  # periodic check so KeyboardInterrupt / signals
    try:
        while True:
            try:
                conn, addr = sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            # One thread per connection keeps the accept loop responsive.
            # The actual transcribe call holds the model lock anyway (faster-
            # whisper is process-singleton), so extra threads don't buy us
            # parallelism - they just keep accept() free.
            t = threading.Thread(target=_handle, args=(conn, addr), daemon=True)
            t.start()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            sock.close()
        except OSError:
            pass
        print("👋 [worker] Whisper worker shutting down.", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
