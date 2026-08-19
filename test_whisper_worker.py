"""Self-checks for the persistent Whisper worker (transcription_worker.py).

Run: .venv/bin/python test_whisper_worker.py

Covers:
  - The TCP protocol round-trips a JSON request into a JSON response.
  - Missing-file requests surface as a structured error (not a crash).
  - transcribe() falls back to inline when OPENSHORTS_WHISPER_WORKER_PORT is
    unset (dev / single-process runs).
  - reset_worker_client() lets the client pick up a freshly-restarted worker.

Heavy audio transcription is intentionally NOT exercised here: pulling in
faster-whisper's model load for unit tests would be slow and require a real
audio file. End-to-end smoke is in the PR description.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import transcription
from transcription import (
    _WorkerClient,
    get_worker_client,
    reset_worker_client,
)


ROOT = Path(__file__).resolve().parent


def _start_worker():
    """Boot the worker on an ephemeral port, return (proc, port)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    env = os.environ.copy()
    env["OPENSHORTS_WHISPER_WORKER_PORT"] = str(port)
    env["OPENSHORTS_WHISPER_WORKER_HOST"] = "127.0.0.1"
    proc = subprocess.Popen(
        [sys.executable, "-u", "transcription_worker.py"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        cwd=str(ROOT),
    )
    # Worker prints "READY <port>" once it's listening. Bail fast if it dies.
    deadline = time.time() + 15
    banner = ""
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("Whisper worker exited before announcing READY.")
        banner = line.decode("utf-8").strip()
        if banner.startswith("READY "):
            break
    assert banner.startswith("READY "), banner
    announced = int(banner.split()[1])
    assert announced == port, (announced, port)
    return proc, port


def _stop_worker(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_protocol_round_trip_missing_file_surfaces_as_error():
    """Without Whisper involved, the protocol still round-trips: a request for
    a non-existent file must come back as a structured error (never a hang or
    a crash that would kill the worker)."""
    proc, port = _start_worker()
    try:
        client = _WorkerClient("127.0.0.1", port)
        try:
            client.request("/nonexistent/path/that/should/not/exist.mp4",
                           "base", "auto", False)
        except RuntimeError as exc:
            assert "not found" in str(exc), str(exc)
        else:
            raise AssertionError("expected RuntimeError for missing file")
    finally:
        _stop_worker(proc)


def test_transcribe_falls_back_inline_when_no_worker():
    """No OPENSHORTS_WHISPER_WORKER_PORT -> get_worker_client() returns None,
    so transcribe() will take the inline path. We don't actually transcribe
    anything here (would need Whisper); we only verify the routing."""
    saved = os.environ.pop("OPENSHORTS_WHISPER_WORKER_PORT", None)
    reset_worker_client()
    try:
        assert get_worker_client() is None, "expected inline fallback"
    finally:
        if saved is not None:
            os.environ["OPENSHORTS_WHISPER_WORKER_PORT"] = saved
        reset_worker_client()


def test_client_picks_up_after_restart():
    """After the worker process is killed and a fresh one starts on a new
    port, the client should re-probe and connect on the next call rather
    than holding onto the stale socket."""
    proc_a, port_a = _start_worker()
    _stop_worker(proc_a)

    # First probe caches the negative answer.
    os.environ["OPENSHORTS_WHISPER_WORKER_PORT"] = str(port_a)
    reset_worker_client()
    assert get_worker_client() is None, "client should fail to connect after kill"

    # New worker on a fresh port.
    proc_b, port_b = _start_worker()
    try:
        os.environ["OPENSHORTS_WHISPER_WORKER_PORT"] = str(port_b)
        reset_worker_client()
        client = get_worker_client()
        assert client is not None, "client should reconnect after worker restart"
        assert client.port == port_b
        # And the missing-file path still works on the new worker.
        try:
            client.request("/nope.mp4", "base", "auto", False)
        except RuntimeError:
            pass
        else:
            raise AssertionError("expected error for missing file")
    finally:
        _stop_worker(proc_b)
        reset_worker_client()
        os.environ.pop("OPENSHORTS_WHISPER_WORKER_PORT", None)


def test_transcribe_module_still_has_inline_fallback_intact():
    """Regression guard: the worker path must not have stripped the inline
    backends. We mock the worker as unavailable and verify the dispatch
    logic still resolves correctly."""
    reset_worker_client()
    # resolve_backend is the public seam; it should still behave the same.
    os.environ.pop("OPENSHORTS_WHISPER_WORKER_PORT", None)
    assert transcription.resolve_backend("faster") == "faster-whisper"
    assert transcription.resolve_backend("mlx") == "mlx-whisper"
    assert transcription.normalize_model("turbo") == "large-v3-turbo"


def test_app_lifespan_boots_worker(monkeypatched=False):
    """Smoke-check that app._start_whisper_worker() actually spawns a worker
    subprocess and reads its READY banner. We import app lazily so the test
    stays independent of uvicorn being on the path."""
    import app  # noqa: F401  (imports FastAPI etc.)

    # Don't actually leave a worker running.
    try:
        app._start_whisper_worker()
        proc = app._whisper_worker_proc
        assert proc is not None and proc.poll() is None, "worker not running"
        # Ensure the env var was advertised so subprocesses can see it.
        assert os.environ.get("OPENSHORTS_WHISPER_WORKER_PORT"), "port not exported"
    finally:
        app._stop_whisper_worker()
        assert app._whisper_worker_proc is None
        os.environ.pop("OPENSHORTS_WHISPER_WORKER_PORT", None)


def test_worker_exits_when_job_exceeds_timeout():
    """A job stuck forever (e.g. a hung model download, exactly what caused
    the "processing for 2 hours" report this test guards against) must not
    be able to out-wait every timeout via heartbeats. The worker enforces a
    hard ceiling (REQUEST_TIMEOUT_S) and exits rather than hanging forever,
    so the parent's watchdog (app._watch_whisper_worker) can respawn a clean
    one. We patch _do_transcribe to hang indefinitely and shrink the ceiling
    via the env var so the test itself completes quickly."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    # A worker script that hangs "transcription" forever but has a 1s ceiling.
    hang_script = ROOT / "_hang_worker_for_test.py"
    hang_script.write_text(
        "import sys, time\n"
        "sys.path.insert(0, %r)\n"
        "import transcription_worker as w\n"
        "w._do_transcribe = lambda *a, **k: time.sleep(3600)\n"
        "w.main()\n" % str(ROOT)
    )
    env = os.environ.copy()
    env["OPENSHORTS_WHISPER_WORKER_PORT"] = str(port)
    env["OPENSHORTS_WHISPER_WORKER_HOST"] = "127.0.0.1"
    env["WHISPER_WORKER_REQUEST_TIMEOUT"] = "1"
    proc = subprocess.Popen(
        [sys.executable, "-u", str(hang_script)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        cwd=str(ROOT),
    )
    try:
        deadline = time.time() + 15
        banner = ""
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("worker exited before READY")
            banner = line.decode("utf-8").strip()
            if banner.startswith("READY "):
                break
        assert banner.startswith("READY "), banner

        # Fire a request; a video file just needs to exist for the worker to
        # accept the job (it never actually reads it -- _do_transcribe is
        # mocked to hang).
        with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
            client = _WorkerClient("127.0.0.1", port)
            try:
                client.request(f.name, "tiny", "auto", False)
            except RuntimeError as exc:
                assert "timed out" in str(exc), str(exc)
            else:
                raise AssertionError("expected timeout error, got a result")

        # The worker process must have exited on its own (not just sent an
        # error and kept the stuck thread/lock alive forever).
        assert proc.wait(timeout=5) != 0
    finally:
        _stop_worker(proc)
        hang_script.unlink(missing_ok=True)


if __name__ == "__main__":
    test_protocol_round_trip_missing_file_surfaces_as_error()
    print("✓ protocol round-trip (missing-file error path)")
    test_transcribe_falls_back_inline_when_no_worker()
    print("✓ inline fallback when no worker env var")
    test_client_picks_up_after_restart()
    print("✓ client reconnects after worker restart")
    test_transcribe_module_still_has_inline_fallback_intact()
    print("✓ inline backends intact")
    test_app_lifespan_boots_worker()
    print("✓ app._start_whisper_worker() boots & stops a worker")
    test_worker_exits_when_job_exceeds_timeout()
    print("✓ worker self-exits on a stuck job past its timeout ceiling")
    print("\nAll Whisper worker self-checks passed.")
