"""Self-checks for stage-aware processing failure diagnostics.

Run: .venv/bin/python test_pipeline_diagnostics.py
"""
import asyncio
import os
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import app
import main


def _run_job_with_output(job_id, output):
    temp_dir = tempfile.TemporaryDirectory()
    app.jobs[job_id] = {
        "status": "queued",
        "logs": [],
        "cmd": [sys.executable, "-c", output],
        "env": dict(os.environ),
        "output_dir": temp_dir.name,
        "created_at": 0,
    }
    try:
        asyncio.run(app.run_job(job_id, app.jobs[job_id]))
        return app.jobs[job_id], asyncio.run(app.get_status(job_id))
    finally:
        app.jobs.pop(job_id, None)
        temp_dir.cleanup()


def test_parser_accepts_only_allowlisted_markers():
    assert app._parse_pipeline_diagnostic(
        "📍 OPENSHORTS_STAGE:analyze:start"
    ) == {"kind": "stage", "stage": "analyze", "state": "start"}
    assert app._parse_pipeline_diagnostic(
        "📍 OPENSHORTS_FAILURE:analyze:provider_invalid_json:openai:gpt-5.6"
    ) == {
        "kind": "failure",
        "stage": "analyze",
        "code": "provider_invalid_json",
        "provider": "openai",
        "model": "gpt-5.6",
    }
    assert app._parse_pipeline_diagnostic(
        "📍 OPENSHORTS_FAILURE:analyze:gemini_invalid_json"
    ) == {"kind": "failure", "stage": "analyze", "code": "provider_invalid_json"}
    assert app._parse_pipeline_diagnostic(
        "ordinary log OPENSHORTS_FAILURE:analyze:provider_invalid_json"
    ) is None
    assert app._parse_pipeline_diagnostic(
        "📍 OPENSHORTS_FAILURE:analyze:raw_exception_text"
    ) is None
    assert app._parse_pipeline_diagnostic(
        "📍 OPENSHORTS_FAILURE:analyze:provider_invalid_json:open ai:secret"
    ) is None


def test_explicit_failure_marker_survives_job_status():
    job, status = _run_job_with_output(
        "t-diagnostic-explicit",
        "import sys; "
        "print('📍 OPENSHORTS_STAGE:analyze:start', flush=True); "
        "print('📍 OPENSHORTS_FAILURE:analyze:provider_invalid_json:gemini:gemini-2.5-flash', flush=True); "
        "sys.exit(2)",
    )
    assert job["status"] == "failed"
    assert job["current_stage"] is None
    assert job["last_stage"] == "analyze"
    assert job["failure_stage"] == "analyze"
    assert job["failure_code"] == "provider_invalid_json"
    assert job["failure_provider"] == "gemini"
    assert job["failure_model"] == "gemini-2.5-flash"
    assert job["failure_exit_code"] == 2
    assert status["failure_stage"] == "analyze"
    assert status["current_stage"] is None
    assert status["failure_code"] == "provider_invalid_json"
    assert status["failure_provider"] == "gemini"
    assert status["failure_model"] == "gemini-2.5-flash"
    assert status["failure_exit_code"] == 2


def test_missing_failure_marker_uses_last_started_stage():
    job, status = _run_job_with_output(
        "t-diagnostic-fallback",
        "import sys; "
        "print('📍 OPENSHORTS_STAGE:transcribe:start', flush=True); "
        "sys.exit(3)",
    )
    assert job["status"] == "failed"
    assert job["current_stage"] is None
    assert job["failure_stage"] == "transcribe"
    assert job["failure_code"] == "process_exit"
    assert job["failure_exit_code"] == 3
    assert status["failure_stage"] == "transcribe"
    assert status["current_stage"] is None
    assert status["failure_code"] == "process_exit"


def test_model_shape_failure_keeps_invalid_response_code():
    class FakeModels:
        def generate_content(self, **_kwargs):
            return SimpleNamespace(text="[]", usage_metadata=None)

    class FakeClient:
        def __init__(self, api_key):
            assert api_key == "test-key"
            self.models = FakeModels()

    with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}):
        with patch.object(main.genai, "Client", FakeClient):
            try:
                main.get_viral_clips(
                    {"segments": [], "text": ""},
                    10,
                    max_retries=1,
                )
            except main.ClipAnalysisError as exc:
                assert exc.code == "provider_invalid_response"
                assert exc.provider == "gemini"
                assert exc.model == "gemini-2.5-flash"
            else:
                raise AssertionError("Expected ClipAnalysisError")


def test_failure_snapshot_survives_rehydration():
    previous_output_dir = app.OUTPUT_DIR
    with tempfile.TemporaryDirectory() as output_dir:
        app.OUTPUT_DIR = output_dir
        job_id = "t-diagnostic-persisted"
        os.makedirs(os.path.join(output_dir, job_id))
        app.jobs[job_id] = {
            "status": "failed",
            "result": None,
            "failure_stage": "transcribe",
            "failure_code": "transcription_error",
            "failure_provider": "soniox",
            "failure_model": "stt-async-v5",
            "failure_exit_code": 1,
            "created_at": 1,
            "started_at": 2,
            "completed_at": 3,
            "duration_seconds": 1,
        }
        try:
            app._persist_result(job_id)
            app.jobs.pop(job_id)
            snapshot = app._load_persisted_result(job_id)
            assert snapshot["failure_stage"] == "transcribe"
            assert snapshot["failure_code"] == "transcription_error"
            assert snapshot["failure_provider"] == "soniox"
            assert snapshot["failure_model"] == "stt-async-v5"
            assert snapshot["failure_exit_code"] == 1
        finally:
            app.jobs.pop(job_id, None)
            app.OUTPUT_DIR = previous_output_dir


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"  ok  {name}")
    print("test_pipeline_diagnostics: all assertions passed")
