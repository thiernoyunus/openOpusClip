"""Self-check for persisted YouTube authentication recovery metadata."""

import asyncio
import os
import tempfile

import app


def test_persisted_youtube_failure_keeps_recovery_category():
    """A restarted failed URL job still exposes the sign-in recovery action."""
    original_output_dir = app.OUTPUT_DIR
    original_jobs = dict(app.jobs)
    job_id = "youtube-recovery-self-check"
    try:
        with tempfile.TemporaryDirectory() as output_dir:
            app.OUTPUT_DIR = output_dir
            app.jobs.clear()
            os.makedirs(os.path.join(output_dir, job_id))
            app.jobs[job_id] = {
                "status": "failed",
                "source_type": "youtube_url",
                "failure_code": "youtube_auth_required",
                "failure_stage": "download",
                "logs": [],
            }
            app._persist_result(job_id)
            app.jobs.clear()

            status = asyncio.run(app.get_status(job_id))
            assert status["failure_category"] == "youtube_auth_required"
    finally:
        app.OUTPUT_DIR = original_output_dir
        app.jobs.clear()
        app.jobs.update(original_jobs)


if __name__ == "__main__":
    test_persisted_youtube_failure_keeps_recovery_category()
    print("youtube recovery self-check passed")
