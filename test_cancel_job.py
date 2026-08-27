"""Self-checks for cancelling a running project (DELETE /api/jobs/{id}).

Run: .venv/bin/python test_cancel_job.py

The thing being guarded: clicking delete on a project that is still processing
must actually stop the work. A job spawns ffmpeg/yt-dlp children, so killing
only the direct child would leave those running against a deleted directory.
"""
import os
import subprocess
import sys
import time

import app


def _spawn_tree():
    """A 'job' (parent) that spawns a long-running 'ffmpeg' (child), like main.py."""
    parent = subprocess.Popen(
        [sys.executable, "-c",
         "import subprocess,sys,time;"
         "c=subprocess.Popen([sys.executable,'-c','import time; time.sleep(300)']);"
         "print(c.pid, flush=True); time.sleep(300)"],
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    child_pid = int(parent.stdout.readline().strip())
    return parent, child_pid


def _alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def test_kill_stops_the_whole_process_tree():
    parent, child_pid = _spawn_tree()
    app.jobs["t-tree"] = {"status": "processing", "logs": [], "process": parent}
    try:
        assert app.kill_job_process("t-tree") is True
        assert parent.poll() is not None, "job subprocess survived cancel"
        # The grandchild ('ffmpeg') dies with the group, not just the parent.
        for _ in range(50):
            if not _alive(child_pid):
                break
            time.sleep(0.1)
        assert not _alive(child_pid), "spawned child survived cancel"
    finally:
        app.jobs.pop("t-tree", None)
        for pid in (parent.pid, child_pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass


def test_kill_is_a_noop_for_jobs_with_nothing_running():
    # Queued (no process yet), unknown id, and an already-finished process.
    app.jobs["t-queued"] = {"status": "queued", "logs": []}
    done = subprocess.Popen([sys.executable, "-c", "pass"])
    done.wait()
    app.jobs["t-done"] = {"status": "processing", "logs": [], "process": done}
    try:
        assert app.kill_job_process("t-queued") is False
        assert app.kill_job_process("t-missing") is False
        assert app.kill_job_process("t-done") is False
    finally:
        app.jobs.pop("t-queued", None)
        app.jobs.pop("t-done", None)


def test_a_descendant_that_ignores_sigterm_is_still_killed():
    """main.py can exit on SIGTERM while an ffmpeg child ignores it. Waiting on
    the direct child alone would report success with the descendant alive."""
    parent = subprocess.Popen(
        [sys.executable, "-c",
         "import subprocess,sys,time;"
         # The grandchild installs SIG_IGN for SIGTERM, so only SIGKILL stops it.
         "c=subprocess.Popen([sys.executable,'-c',"
         "'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);"
         "print(1,flush=True);time.sleep(300)'],stdout=subprocess.PIPE);"
         "print(c.pid, flush=True); time.sleep(300)"],
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    child_pid = int(parent.stdout.readline().strip())
    # Let the grandchild install its handler before we signal the group.
    time.sleep(0.5)
    try:
        assert app.kill_process_tree(parent, grace_seconds=2.0) is True
        assert parent.poll() is not None, "job subprocess survived cancel"
        for _ in range(50):
            if not _alive(child_pid):
                break
            time.sleep(0.1)
        assert not _alive(child_pid), "SIGTERM-ignoring descendant survived cancel"
    finally:
        for pid in (parent.pid, child_pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass


def test_a_cancel_during_launch_does_not_orphan_the_process():
    """delete_job can run between Popen and process registration: it finds no
    handle to kill, so run_job must stop its own subprocess."""
    import asyncio

    app.jobs["t-launch"] = {
        "status": "processing", "logs": [], "created_at": time.time(),
        "cmd": [sys.executable, "-c", "import time; time.sleep(300)"],
        "env": dict(os.environ), "output_dir": "/tmp/openshorts-cancel-check",
    }
    launched = {}
    real_popen = subprocess.Popen

    def popen_then_cancel(*a, **kw):
        p = real_popen(*a, **kw)
        launched["process"] = p
        # Simulate the cancel winning the race: the job is gone before the
        # handle is registered, exactly as kill_job_process would have left it.
        app.jobs.pop("t-launch", None)
        return p

    app.subprocess.Popen = popen_then_cancel
    try:
        asyncio.run(app.run_job("t-launch", app.jobs["t-launch"]))
        p = launched["process"]
        assert p.poll() is not None, "subprocess was orphaned by a cancel mid-launch"
    finally:
        app.subprocess.Popen = real_popen
        app.jobs.pop("t-launch", None)
        p = launched.get("process")
        if p is not None:
            try:
                os.kill(p.pid, 9)
            except OSError:
                pass


def test_run_job_records_nothing_after_a_cancel():
    """run_job must not resurrect a job that delete_job already removed."""
    import asyncio

    parent, child_pid = _spawn_tree()
    app.jobs["t-race"] = {
        "status": "processing", "logs": [], "created_at": time.time(),
        "cmd": [sys.executable, "-c", "import time; time.sleep(300)"],
        "env": dict(os.environ), "output_dir": "/tmp/openshorts-cancel-check",
    }

    async def cancel_soon():
        await asyncio.sleep(0.5)
        await asyncio.to_thread(app.kill_job_process, "t-race")
        app.jobs.pop("t-race", None)

    async def go():
        await asyncio.gather(
            app.run_job("t-race", app.jobs["t-race"]),
            cancel_soon(),
        )

    try:
        asyncio.run(go())  # must not raise KeyError
        assert "t-race" not in app.jobs, "cancelled job came back"
    finally:
        app.jobs.pop("t-race", None)
        for pid in (parent.pid, child_pid):
            try:
                os.kill(pid, 9)
            except OSError:
                pass


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"  ok  {name}")
    print("test_cancel_job: all assertions passed")
