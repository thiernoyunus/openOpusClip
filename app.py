import os
import uuid
import subprocess
import threading
import json
import shutil
import glob
import time
import asyncio
import sys
from datetime import datetime, timedelta
from dotenv import load_dotenv
from typing import Dict, Optional, List
from urllib.parse import quote, unquote, urlparse
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from s3_uploader import upload_job_artifacts
from transcription import WHISPER_MODELS

load_dotenv()

# Constants
# Overridable so the app can run inside a read-only packaged bundle (e.g. a
# desktop app) where "uploads"/"output" relative to cwd wouldn't be writable.
UPLOAD_DIR = os.getenv("OPENSHORTS_UPLOAD_DIR") or "uploads"
OUTPUT_DIR = os.getenv("OPENSHORTS_OUTPUT_DIR") or "output"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Configuration
# One job at a time by default — safe for laptops. Set higher (e.g. 4-5) on
# servers with plenty of RAM/cores; each job is a full main.py subprocess.
MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "1"))
MAX_FILE_SIZE_MB = 2048  # 2GB limit
# Output projects are kept until the user deletes them by default. Set
# JOB_RETENTION_SECONDS > 0 to auto-purge finished projects older than that many
# seconds (0 / unset = permanent). Raw uploads are transient inputs and still get
# cleaned on their own (shorter) TTL.
JOB_RETENTION_SECONDS = int(os.environ.get("JOB_RETENTION_SECONDS", "0"))
UPLOAD_RETENTION_SECONDS = int(os.environ.get("UPLOAD_RETENTION_SECONDS", "3600"))
# Shared subdirectories that live inside OUTPUT_DIR but are NOT projects (e.g. the
# thumbnail studio's "thumbnails" dir). Never auto-purged or deletable as a job.
RESERVED_OUTPUT_DIRS = {"thumbnails"}
DISABLE_YOUTUBE_URL = os.environ.get("DISABLE_YOUTUBE_URL", "false").lower() in ("1", "true", "yes")

# Application State
job_queue = asyncio.Queue()
jobs: Dict[str, Dict] = {}
thumbnail_sessions: Dict[str, Dict] = {}
publish_jobs: Dict[str, Dict] = {}  # {publish_id: {status, result, error}}
# "Extend a clip" background tasks: {task_id: {status, error?, result?}}. In-memory
# is fine — a task is short-lived and the frontend polls it immediately after start.
extend_tasks: Dict[str, Dict] = {}
extend_tasks_lock = threading.Lock()
# Semester to limit concurrency to MAX_CONCURRENT_JOBS
concurrency_semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)

def _relocate_root_job_artifacts(job_id: str, job_output_dir: str) -> bool:
    """
    Backward-compat rescue:
    If main.py accidentally wrote metadata/clips into OUTPUT_DIR root (e.g. output/<jobid>_...),
    move them into output/<job_id>/ so the API can find and serve them.
    """
    try:
        os.makedirs(job_output_dir, exist_ok=True)
        root = OUTPUT_DIR
        pattern = os.path.join(root, f"{job_id}_*_metadata.json")
        meta_candidates = sorted(glob.glob(pattern), key=lambda p: os.path.getmtime(p), reverse=True)
        if not meta_candidates:
            return False

        # Move the newest metadata and its associated clips.
        metadata_path = meta_candidates[0]
        base_name = os.path.basename(metadata_path).replace("_metadata.json", "")

        # Move metadata
        dest_metadata = os.path.join(job_output_dir, os.path.basename(metadata_path))
        if os.path.abspath(metadata_path) != os.path.abspath(dest_metadata):
            shutil.move(metadata_path, dest_metadata)

        # Move any clips that match the same base_name into the job folder
        clip_pattern = os.path.join(root, f"{base_name}_clip_*.mp4")
        for clip_path in glob.glob(clip_pattern):
            dest_clip = os.path.join(job_output_dir, os.path.basename(clip_path))
            if os.path.abspath(clip_path) != os.path.abspath(dest_clip):
                shutil.move(clip_path, dest_clip)

        # Move framing metadata (editor re-frame data) alongside the clips
        framing_pattern = os.path.join(root, f"{base_name}_clip_*.framing.json")
        for framing_path in glob.glob(framing_pattern):
            dest_framing = os.path.join(job_output_dir, os.path.basename(framing_path))
            if os.path.abspath(framing_path) != os.path.abspath(dest_framing):
                shutil.move(framing_path, dest_framing)

        # Also move any temp_ clips that might remain
        temp_clip_pattern = os.path.join(root, f"temp_{base_name}_clip_*.mp4")
        for clip_path in glob.glob(temp_clip_pattern):
            dest_clip = os.path.join(job_output_dir, os.path.basename(clip_path))
            if os.path.abspath(clip_path) != os.path.abspath(dest_clip):
                shutil.move(clip_path, dest_clip)

        return True
    except Exception:
        return False

def _video_url(job_id: str, filename: str) -> str:
    """Build a /videos/ URL, percent-encoding the filename so a title with
    '?', '&', '#' or spaces (e.g. 'Why ... Hate Each Other?') doesn't truncate
    the path into a 404. job_id is a UUID and needs no encoding."""
    return f"/videos/{job_id}/{quote(filename)}"


def _reencode_url(url):
    """Re-encode the filename segment of a /videos/ URL. Idempotent
    (quote(unquote(...))): fixes legacy raw URLs persisted in result.json and
    leaves already-encoded ones unchanged."""
    if not isinstance(url, str) or not url.startswith("/videos/"):
        return url
    head, _, fname = url.rpartition("/")
    return f"{head}/{quote(unquote(fname))}"


def _normalize_clip_urls(result):
    """Ensure every clip URL is percent-encoded before it goes to the frontend,
    so old jobs whose result.json holds raw '?'/'&' filenames stop 404-ing."""
    if isinstance(result, dict):
        for clip in result.get("clips") or []:
            if isinstance(clip, dict):
                for key in ("video_url", "source_url", "framing_url"):
                    if key in clip:
                        clip[key] = _reencode_url(clip[key])
    return result


def _attach_editor_urls(clip: dict, job_id: str, output_dir: str, base_name: str, clip_number: int) -> None:
    """
    Attach source_url + framing_url to a clip dict when the non-destructive
    editor artifacts exist on disk (new jobs). Old jobs simply don't get the
    keys, and the frontend hides the Edit button.
    """
    source_filename = f"{base_name}_clip_{clip_number}_source.mp4"
    framing_filename = f"{base_name}_clip_{clip_number}.framing.json"
    if os.path.exists(os.path.join(output_dir, source_filename)):
        clip['source_url'] = _video_url(job_id, source_filename)
    if os.path.exists(os.path.join(output_dir, framing_filename)):
        clip['framing_url'] = _video_url(job_id, framing_filename)

def _safe_job_id(job_id: str) -> bool:
    """A job id must be a single, non-reserved path segment (rmtree/IO safety)."""
    return bool(job_id) and job_id not in (".", "..") and job_id not in RESERVED_OUTPUT_DIRS \
        and "/" not in job_id and "\\" not in job_id and os.path.basename(job_id) == job_id

def _persist_result(job_id: str) -> None:
    """Snapshot a job's result to output/<job_id>/result.json so completed (and
    edited) projects survive a server restart — get_status rehydrates from it.
    Best-effort; never raises into the request path."""
    try:
        job = jobs.get(job_id)
        if not job or 'result' not in job or not _safe_job_id(job_id):
            return
        out_dir = os.path.join(OUTPUT_DIR, job_id)
        if not os.path.isdir(out_dir):
            return
        tmp = os.path.join(out_dir, "result.json.tmp")
        with open(tmp, 'w') as f:
            json.dump({"status": job.get('status', 'completed'), "result": job['result']}, f)
        os.replace(tmp, os.path.join(out_dir, "result.json"))
    except Exception:
        pass

def _load_persisted_result(job_id: str):
    """Load a persisted result snapshot from disk, or None."""
    if not _safe_job_id(job_id):
        return None
    path = os.path.join(OUTPUT_DIR, job_id, "result.json")
    try:
        if os.path.isfile(path):
            with open(path) as f:
                return json.load(f)
    except Exception:
        return None
    return None

async def cleanup_jobs():
    """Background task to remove old raw uploads and (optionally) old projects.

    Output projects are kept permanently unless JOB_RETENTION_SECONDS > 0; raw
    uploads are always cleaned on UPLOAD_RETENTION_SECONDS since they're just the
    transient input to a job.
    """
    import time
    if JOB_RETENTION_SECONDS > 0:
        print(f"🧹 Cleanup task started (projects auto-purge after {JOB_RETENTION_SECONDS}s).")
    else:
        print("🧹 Cleanup task started (projects kept until deleted; only raw uploads are pruned).")
    while True:
        try:
            await asyncio.sleep(300) # Check every 5 minutes
            now = time.time()

            # Output projects: only time-purge when a positive retention is set.
            if JOB_RETENTION_SECONDS > 0:
                for job_id in os.listdir(OUTPUT_DIR):
                    if job_id in RESERVED_OUTPUT_DIRS:
                        continue  # shared dir (e.g. thumbnails), not a project
                    job_path = os.path.join(OUTPUT_DIR, job_id)
                    if os.path.isdir(job_path):
                        if now - os.path.getmtime(job_path) > JOB_RETENTION_SECONDS:
                            print(f"🧹 Purging old job: {job_id}")
                            shutil.rmtree(job_path, ignore_errors=True)
                            if job_id in jobs:
                                del jobs[job_id]

                # Cleanup SaaSShorts jobs from memory
                try:
                    saas_expired = [
                        jid for jid, jdata in list(saas_jobs.items())
                        if jdata.get("status") in ("completed", "failed")
                        and jdata.get("output_dir")
                        and os.path.isdir(jdata["output_dir"])
                        and now - os.path.getmtime(jdata["output_dir"]) > JOB_RETENTION_SECONDS
                    ]
                    for jid in saas_expired:
                        del saas_jobs[jid]
                except NameError:
                    pass

            # Cleanup raw uploads (transient inputs) on their own TTL.
            if UPLOAD_RETENTION_SECONDS > 0:
                for filename in os.listdir(UPLOAD_DIR):
                    file_path = os.path.join(UPLOAD_DIR, filename)
                    try:
                        if now - os.path.getmtime(file_path) > UPLOAD_RETENTION_SECONDS:
                             os.remove(file_path)
                    except Exception: pass

        except Exception as e:
            print(f"⚠️ Cleanup error: {e}")

async def process_queue():
    """Background worker to process jobs from the queue with concurrency limit."""
    print(f"🚀 Job Queue Worker started with {MAX_CONCURRENT_JOBS} concurrent slots.")
    while True:
        try:
            # Wait for a job
            job_id = await job_queue.get()
            
            # Acquire semaphore slot (waits if max jobs are running)
            await concurrency_semaphore.acquire()
            print(f"🔄 Acquired slot for job: {job_id}")

            # Process in background task to not block the loop (allowing other slots to fill)
            asyncio.create_task(run_job_wrapper(job_id))
            
        except Exception as e:
            print(f"❌ Queue dispatch error: {e}")
            await asyncio.sleep(1)

async def run_job_wrapper(job_id):
    """Wrapper to run job and release semaphore"""
    try:
        job = jobs.get(job_id)
        if job:
            await run_job(job_id, job)
    except Exception as e:
         print(f"❌ Job wrapper error {job_id}: {e}")
    finally:
        # Always release semaphore and mark queue task done
        concurrency_semaphore.release()
        job_queue.task_done()
        print(f"✅ Released slot for job: {job_id}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start worker and cleanup
    worker_task = asyncio.create_task(process_queue())
    cleanup_task = asyncio.create_task(cleanup_jobs())
    yield
    # Cleanup (optional: cancel worker)

app = FastAPI(lifespan=lifespan)

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files for serving videos
app.mount("/videos", StaticFiles(directory=OUTPUT_DIR), name="videos")

# Mount static files for serving thumbnails
THUMBNAILS_DIR = os.path.join(OUTPUT_DIR, "thumbnails")
os.makedirs(THUMBNAILS_DIR, exist_ok=True)
app.mount("/thumbnails", StaticFiles(directory=THUMBNAILS_DIR), name="thumbnails")

class ProcessRequest(BaseModel):
    url: str

def enqueue_output(out, job_id):
    """Reads output from a subprocess and appends it to jobs logs."""
    try:
        for line in iter(out.readline, b''):
            decoded_line = line.decode('utf-8').strip()
            if decoded_line:
                print(f"📝 [Job Output] {decoded_line}")
                if job_id in jobs:
                    jobs[job_id]['logs'].append(decoded_line)
    except Exception as e:
        print(f"Error reading output for job {job_id}: {e}")
    finally:
        out.close()

async def run_job(job_id, job_data):
    """Executes the subprocess for a specific job."""
    
    cmd = job_data['cmd']
    env = job_data['env']
    output_dir = job_data['output_dir']
    
    jobs[job_id]['status'] = 'processing'
    jobs[job_id]['started_at'] = time.time()
    jobs[job_id]['logs'].append("Job started by worker.")
    print(f"🎬 [run_job] Executing command for {job_id}: {' '.join(cmd)}")
    
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, # Merge stderr to stdout
            env=env,
            cwd=os.getcwd()
        )

        # The subprocess now has its own copy of env; scrub the BYO request keys
        # from the retained in-memory job object (jobs live ~1h) so they aren't
        # held server-side longer than the launch.
        for _secret in ("GEMINI_API_KEY", "SONIOX_API_KEY"):
            env.pop(_secret, None)
        
        # We need to capture logs in a thread because Popen isn't async
        t_log = threading.Thread(target=enqueue_output, args=(process.stdout, job_id))
        t_log.daemon = True
        t_log.start()
        
        # Async wait for process with incremental updates
        start_wait = time.time()
        while process.poll() is None:
            await asyncio.sleep(2)
            
            # Check for partial results every 2 seconds
            # Look for metadata file
            try:
                json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
                if json_files:
                    target_json = json_files[0]
                    # Read metadata (it might be being written to, so simple try/except or just read)
                    # Use a lock or just robust read? json.load might fail if file is partial.
                    # Usually main.py writes it once at start (based on my review).
                    if os.path.getsize(target_json) > 0:
                        with open(target_json, 'r') as f:
                            data = json.load(f)
                            
                        base_name = os.path.basename(target_json).replace('_metadata.json', '')
                        clips = data.get('shorts', [])
                        cost_analysis = data.get('cost_analysis')
                        
                        # Check which clips actually exist on disk
                        ready_clips = []
                        for i, clip in enumerate(clips):
                             clip_filename = f"{base_name}_clip_{i+1}.mp4"
                             clip_path = os.path.join(output_dir, clip_filename)
                             if os.path.exists(clip_path) and os.path.getsize(clip_path) > 0:
                                 # Checking if file is growing? For now assume if it exists and main.py moves it there, it's done.
                                 # main.py writes to temp_... then moves to final name. So presence means ready!
                                 clip['video_url'] = _video_url(job_id, clip_filename)
                                 _attach_editor_urls(clip, job_id, output_dir, base_name, i + 1)
                                 ready_clips.append(clip)
                        
                        if ready_clips:
                             jobs[job_id]['result'] = {'clips': ready_clips, 'cost_analysis': cost_analysis}
            except Exception as e:
                # Ignore read errors during processing
                pass

        returncode = process.returncode
        
        if returncode == 0:
            jobs[job_id]['status'] = 'completed'
            jobs[job_id]['completed_at'] = time.time()
            jobs[job_id]['duration_seconds'] = jobs[job_id]['completed_at'] - jobs[job_id].get('started_at', jobs[job_id]['completed_at'])
            jobs[job_id]['logs'].append(f"Process finished successfully in {jobs[job_id]['duration_seconds']:.1f}s.")
            
            # Start S3 upload in background (silent, non-blocking)
            loop = asyncio.get_event_loop()
            loop.run_in_executor(None, upload_job_artifacts, output_dir, job_id)
            
            # Find result JSON
            json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
            if not json_files:
                # Backward-compat rescue if outputs were written to OUTPUT_DIR root
                if _relocate_root_job_artifacts(job_id, output_dir):
                    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
            if json_files:
                target_json = json_files[0] 
                with open(target_json, 'r') as f:
                    data = json.load(f)
                
                # Enhance result with video URLs
                base_name = os.path.basename(target_json).replace('_metadata.json', '')
                clips = data.get('shorts', [])
                cost_analysis = data.get('cost_analysis')

                for i, clip in enumerate(clips):
                     clip_filename = f"{base_name}_clip_{i+1}.mp4"
                     clip['video_url'] = _video_url(job_id, clip_filename)
                     _attach_editor_urls(clip, job_id, output_dir, base_name, i + 1)

                jobs[job_id]['result'] = {'clips': clips, 'cost_analysis': cost_analysis}
                _persist_result(job_id)  # snapshot so the project survives a restart
            else:
                 jobs[job_id]['status'] = 'failed'
                 jobs[job_id]['completed_at'] = time.time()
                 jobs[job_id]['duration_seconds'] = jobs[job_id]['completed_at'] - jobs[job_id].get('started_at', jobs[job_id]['completed_at'])
                 jobs[job_id]['logs'].append("No metadata file generated.")
        else:
            jobs[job_id]['status'] = 'failed'
            jobs[job_id]['completed_at'] = time.time()
            jobs[job_id]['duration_seconds'] = jobs[job_id]['completed_at'] - jobs[job_id].get('started_at', jobs[job_id]['completed_at'])
            jobs[job_id]['logs'].append(f"Process failed with exit code {returncode}")

    except Exception as e:
        jobs[job_id]['status'] = 'failed'
        jobs[job_id]['completed_at'] = time.time()
        jobs[job_id]['duration_seconds'] = jobs[job_id]['completed_at'] - jobs[job_id].get('started_at', jobs[job_id].get('created_at', jobs[job_id]['completed_at']))
        jobs[job_id]['logs'].append(f"Execution error: {str(e)}")

@app.get("/api/config")
async def get_config():
    return {"youtubeUrlEnabled": not DISABLE_YOUTUBE_URL}

@app.post("/api/process")
async def process_endpoint(
    request: Request,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    acknowledged: Optional[str] = Form(None),
    whisper_model: Optional[str] = Form("base"),
    transcription_engine: Optional[str] = Form("whisper"),
    min_clip_length: Optional[int] = Form(None),
    max_clip_length: Optional[int] = Form(None),
    moment_prompt: Optional[str] = Form(None),
    skip_analysis: Optional[str] = Form(None),
    trim_start: Optional[float] = Form(None),
    trim_end: Optional[float] = Form(None),
    aspect_ratio: Optional[str] = Form("9:16"),
    mode: Optional[str] = Form("normal"),
    trailer_pace: Optional[str] = Form("standard"),
    smart_placement: Optional[str] = Form(None),
):
    api_key = request.headers.get("X-Gemini-Key")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    ack_flag = str(acknowledged).lower() in ("1", "true", "yes")

    # Handle JSON body manually for URL payload
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.json()
        url = body.get("url")
        ack_flag = bool(body.get("acknowledged"))
        whisper_model = body.get("whisper_model", whisper_model)
        transcription_engine = body.get("transcription_engine", transcription_engine)
        min_clip_length = body.get("min_clip_length", min_clip_length)
        max_clip_length = body.get("max_clip_length", max_clip_length)
        moment_prompt = body.get("moment_prompt", moment_prompt)
        skip_analysis = body.get("skip_analysis", skip_analysis)
        trim_start = body.get("trim_start", trim_start)
        trim_end = body.get("trim_end", trim_end)
        aspect_ratio = body.get("aspect_ratio", aspect_ratio)
        mode = body.get("mode", mode)
        trailer_pace = body.get("trailer_pace", trailer_pace)
        smart_placement = body.get("smart_placement", smart_placement)

    skip_flag = str(skip_analysis).lower() in ("1", "true", "yes")
    # Keep in sync with main.ASPECT_PRESETS. Intentionally NOT importing main here:
    # it would pull torch/mediapipe/cv2 into the API process for a 4-key dict.
    allowed_aspect_ratios = {"9:16", "1:1", "4:5", "16:9"}
    if aspect_ratio not in allowed_aspect_ratios:
        aspect_ratio = "9:16"

    # Keep in sync with main.py's --mode choices.
    mode = str(mode or "normal").strip().lower()
    if mode not in {"normal", "trailer"}:
        mode = "normal"

    # Keep in sync with main.TRAILER_PACE_PRESETS keys.
    trailer_pace = str(trailer_pace or "standard").strip().lower()
    if trailer_pace not in {"punchy", "standard", "extended"}:
        trailer_pace = "standard"

    smart_placement_flag = str(smart_placement).lower() in ("1", "true", "yes", "on")

    # Cast first: a JSON body may send a non-string (int/bool) for the engine.
    transcription_engine = str(transcription_engine or "whisper").strip().lower()
    if transcription_engine not in {"whisper", "soniox"}:
        raise HTTPException(status_code=400, detail="Invalid transcription engine")

    soniox_key = request.headers.get("X-Soniox-Key")
    if transcription_engine == "soniox" and not soniox_key:
        raise HTTPException(status_code=400, detail="Missing X-Soniox-Key header")

    if transcription_engine == "whisper":
        if whisper_model not in WHISPER_MODELS:
            raise HTTPException(status_code=400, detail="Invalid Whisper model")
    else:
        # Soniox ignores the Whisper model, but main.py's argparse still validates
        # --whisper-model against its choices — coerce to a valid placeholder so a
        # junk/legacy value can't make the job exit before Soniox runs.
        whisper_model = "base"

    if not url and not file:
        raise HTTPException(status_code=400, detail="Must provide URL or File")

    if not ack_flag:
        raise HTTPException(status_code=400, detail="You must confirm you own the content or have rights to process it.")

    if url and DISABLE_YOUTUBE_URL:
        raise HTTPException(status_code=403, detail="YouTube URL ingest is disabled on this deployment. Please upload a file you own.")

    # Capture attestation context for legal record (IP + timestamp + UA)
    client_ip = request.client.host if request.client else "unknown"
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        client_ip = fwd.split(",")[0].strip()
    user_agent = request.headers.get("user-agent", "")
    attestation = {
        "acknowledged": True,
        "ip": client_ip,
        "user_agent": user_agent,
        "timestamp": time.time(),
        "source": "url" if url else "file",
    }

    job_id = str(uuid.uuid4())
    job_output_dir = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(job_output_dir, exist_ok=True)

    # Prepare Command
    cmd = [sys.executable, "-u", "main.py"] # -u for unbuffered
    env = os.environ.copy()
    env["GEMINI_API_KEY"] = api_key # Override with key from request
    if transcription_engine == "soniox":
        # transcription.resolve_backend() reads WHISPER_BACKEND; Soniox key is
        # bring-your-own and only lives in this subprocess env, never on disk.
        env["WHISPER_BACKEND"] = "soniox"
        env["SONIOX_API_KEY"] = soniox_key

    if url:
        cmd.extend(["-u", url])
    else:
        # Save uploaded file with size limit check
        input_path = os.path.join(UPLOAD_DIR, f"{job_id}_{file.filename}")

        # Read file in chunks to check size
        size = 0
        limit_bytes = MAX_FILE_SIZE_MB * 1024 * 1024

        with open(input_path, "wb") as buffer:
            while content := await file.read(1024 * 1024): # Read 1MB chunks
                size += len(content)
                if size > limit_bytes:
                    os.remove(input_path)
                    shutil.rmtree(job_output_dir)
                    raise HTTPException(status_code=413, detail=f"File too large. Max size {MAX_FILE_SIZE_MB}MB")
                buffer.write(content)

        cmd.extend(["-i", input_path])

    cmd.extend(["--whisper-model", whisper_model])
    # Optional clip controls. subprocess runs a list (no shell), so user text
    # is passed as a single argv entry — no injection risk.
    def _num_arg(flag, val, cast, lo):
        # Tolerate empty strings / junk from form or JSON bodies — just skip the flag.
        if val is None:
            return
        try:
            cmd.extend([flag, str(max(lo, cast(val)))])
        except (ValueError, TypeError):
            pass
    _num_arg("--min-clip-length", min_clip_length, int, 1)
    _num_arg("--max-clip-length", max_clip_length, int, 1)
    if moment_prompt and str(moment_prompt).strip():
        cmd.extend(["--moment-prompt", str(moment_prompt).strip()[:500]])
    if skip_flag:
        cmd.append("--skip-analysis")
    _num_arg("--trim-start", trim_start, float, 0.0)
    _num_arg("--trim-end", trim_end, float, 0.0)
    cmd.extend(["--aspect-ratio", aspect_ratio])
    cmd.extend(["--mode", mode])
    cmd.extend(["--trailer-pace", trailer_pace])
    if smart_placement_flag:
        cmd.append("--smart-placement")
    cmd.extend(["-o", job_output_dir])

    print(f"[attestation] job={job_id} ip={attestation['ip']} source={attestation['source']} ack=true")

    # Enqueue Job
    jobs[job_id] = {
        'status': 'queued',
        'logs': [f"Job {job_id} queued."],
        'cmd': cmd,
        'env': env,
        'output_dir': job_output_dir,
        'attestation': attestation,
        'created_at': time.time(),
    }

    await job_queue.put(job_id)

    return {"job_id": job_id, "status": "queued"}

@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in jobs:
        # Projects persist on disk; rehydrate a finished one whose in-memory
        # state was lost (e.g. server restart) so it stays openable, not "expired".
        # Populate `jobs` (not just return the snapshot) so follow-up edit
        # endpoints — which gate on `job_id in jobs` — keep working on it.
        snap = _load_persisted_result(job_id)
        if snap is None:
            raise HTTPException(status_code=404, detail="Job not found")
        jobs[job_id] = {"status": snap.get("status", "completed"), "logs": [], "result": snap.get("result")}

    job = jobs[job_id]
    now = time.time()
    started_at = job.get('started_at') or job.get('created_at')
    completed_at = job.get('completed_at')
    duration_seconds = job.get('duration_seconds')
    return {
        "status": job['status'],
        "logs": job['logs'],
        "result": _normalize_clip_urls(job.get('result')),
        "created_at": job.get('created_at'),
        "started_at": started_at,
        "completed_at": completed_at,
        "elapsed_seconds": (completed_at or now) - started_at if started_at else None,
        "duration_seconds": duration_seconds,
    }

@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    """Permanently delete a project: its output files + in-memory state. Projects
    are kept until this is called (see cleanup_jobs / JOB_RETENTION_SECONDS)."""
    # rmtree is destructive: only accept a plain, non-reserved single path
    # segment, and verify the resolved path is really inside OUTPUT_DIR.
    if not _safe_job_id(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    out_root = os.path.abspath(OUTPUT_DIR)
    job_path = os.path.abspath(os.path.join(OUTPUT_DIR, job_id))
    if os.path.commonpath([out_root, job_path]) != out_root or job_path == out_root:
        raise HTTPException(status_code=400, detail="Invalid job id")
    # Don't delete a job that's still running — its worker would keep writing
    # (re-creating the dir / crashing on jobs[job_id]). Let it finish first.
    if jobs.get(job_id, {}).get('status') in ('queued', 'processing'):
        raise HTTPException(status_code=409, detail="Project is still processing; try again once it finishes.")
    removed = os.path.isdir(job_path)
    if removed:
        shutil.rmtree(job_path, ignore_errors=True)
    jobs.pop(job_id, None)
    try:
        saas_jobs.pop(job_id, None)
    except NameError:
        pass
    return {"success": True, "removed": removed}

# --- Generate more clips (post-hoc, on a COMPLETED job) ---------------------
def _recover_aspect_ratio(output_dir: str) -> str:
    """Recover the project's output aspect ratio from an existing clip's
    framing.json (outputWidth/outputHeight -> nearest preset). Defaults to
    '9:16' when nothing readable is found — new clips just use the standard.
    Keep the preset ratios in sync with main.ASPECT_PRESETS."""
    presets = {"9:16": 1080 / 1920, "1:1": 1.0, "4:5": 1080 / 1350, "16:9": 1920 / 1080}
    for fp in sorted(glob.glob(os.path.join(output_dir, "*.framing.json"))):
        try:
            with open(fp) as f:
                fr = json.load(f)
            w, h = float(fr["outputWidth"]), float(fr["outputHeight"])
            if w > 0 and h > 0:
                target = w / h
                return min(presets, key=lambda k: abs(presets[k] - target))
        except (OSError, ValueError, KeyError, TypeError, ZeroDivisionError, json.JSONDecodeError):
            continue
    return "9:16"


def _merge_more_clips(job_id: str, output_dir: str, meta_path: str, scratch_dir: str) -> int:
    """Append the clips produced in scratch_dir to a completed job's results.

    All-or-nothing for the metadata: every scratch artifact is verified to
    exist and moved into place BEFORE the metadata is rewritten (atomic
    .tmp + os.replace). A partial failure can therefore never leave the
    metadata pointing at missing files — it raises before touching it, and the
    original clips stay intact and usable. Returns the number of clips added."""
    base_name = os.path.basename(meta_path).replace("_metadata.json", "")

    with open(meta_path) as f:
        data = json.load(f)
    existing = data.get("shorts", [])
    E = len(existing)

    scratch_meta_files = glob.glob(os.path.join(scratch_dir, "*_metadata.json"))
    if not scratch_meta_files:
        raise RuntimeError("more-clips run produced no metadata")
    with open(scratch_meta_files[0]) as f:
        scratch_data = json.load(f)
    scratch_base = os.path.basename(scratch_meta_files[0]).replace("_metadata.json", "")
    new_shorts = scratch_data.get("shorts", [])
    if not new_shorts:
        return 0

    # 1. Plan every rename and verify sources exist FIRST (fail before touching
    #    the live metadata if anything is missing). The final .mp4 is required;
    #    source/framing are best-effort but a fresh run always writes all three.
    moves = []  # (src, dest)
    for i in range(len(new_shorts)):
        src_n, dest_n = i + 1, E + i + 1
        for suffix in (".mp4", "_source.mp4", ".framing.json"):
            src = os.path.join(scratch_dir, f"{scratch_base}_clip_{src_n}{suffix}")
            dest = os.path.join(output_dir, f"{base_name}_clip_{dest_n}{suffix}")
            if not os.path.exists(src):
                if suffix == ".mp4":
                    raise RuntimeError(f"missing new clip file: {os.path.basename(src)}")
                continue
            moves.append((src, dest))

    # 2. Move all artifacts into place, then atomically rewrite the metadata.
    for src, dest in moves:
        shutil.move(src, dest)

    data["shorts"] = existing + new_shorts
    # Sum token cost when both runs reported it in the expected shape.
    ec, nc = data.get("cost_analysis"), scratch_data.get("cost_analysis")
    if isinstance(nc, dict):
        if not isinstance(ec, dict):
            # Legacy/failed original had no cost block — adopt the new run's
            # rather than dropping it on the floor.
            data["cost_analysis"] = nc
        else:
            for k in ("input_tokens", "output_tokens", "input_cost", "output_cost", "total_cost"):
                if k in nc:
                    try:
                        ec[k] = ec.get(k, 0) + nc[k]
                    except TypeError:
                        pass
    tmp = meta_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, meta_path)

    # 3. Rebuild the in-memory result from the full (merged) shorts list, exactly
    #    like run_job's completion path — robust even if the job was resurrected
    #    from disk with a partial/empty in-memory result.
    job = jobs.get(job_id)
    if job is not None:
        clips = []
        for i, clip in enumerate(data["shorts"]):
            clip_filename = f"{base_name}_clip_{i + 1}.mp4"
            clip["video_url"] = _video_url(job_id, clip_filename)
            _attach_editor_urls(clip, job_id, output_dir, base_name, i + 1)
            clips.append(clip)
        job["result"] = {"clips": clips, "cost_analysis": data.get("cost_analysis")}

    return len(new_shorts)


def _more_clips_worker(job_id: str, count, api_key: str):
    """Blocking worker (runs in an executor thread): spawn main.py in more-clips
    mode, stream its logs into the job, then merge the new clips. Always lands
    the job back on 'completed' — a failed run must never damage existing
    results."""
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    original_path = os.path.join(output_dir, "original.mp4")
    scratch_dir = os.path.join(output_dir, f"more_{uuid.uuid4().hex[:8]}")

    def _log(msg):
        j = jobs.get(job_id)
        if j is not None:
            j.setdefault("logs", []).append(msg)
        print(f"📝 [more-clips {job_id}] {msg}")

    try:
        os.makedirs(scratch_dir, exist_ok=True)
        meta_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
        if not meta_files:
            _log("No metadata found; keeping existing clips unchanged.")
            return
        meta_path = meta_files[0]
        with open(meta_path) as f:
            meta = json.load(f)
        transcript = meta.get("transcript")
        # Parse defensively: one malformed clip shouldn't abort the whole run.
        # A range we fail to parse just isn't excluded (the overlap post-filter
        # in main.py is the backstop).
        exclude_ranges = []
        for s in meta.get("shorts", []):
            try:
                exclude_ranges.append([float(s["start"]), float(s["end"])])
            except (KeyError, TypeError, ValueError):
                continue

        transcript_path = os.path.join(scratch_dir, "transcript.json")
        exclude_path = os.path.join(scratch_dir, "exclude_ranges.json")
        with open(transcript_path, "w") as f:
            json.dump(transcript, f)
        with open(exclude_path, "w") as f:
            json.dump(exclude_ranges, f)

        aspect_ratio = _recover_aspect_ratio(output_dir)
        cmd = [
            sys.executable, "-u", "main.py",
            "-i", original_path,
            "-o", scratch_dir,
            "--transcript-file", transcript_path,
            "--exclude-ranges", exclude_path,
            "--aspect-ratio", aspect_ratio,
        ]
        if count:
            cmd += ["--num-clips", str(count)]
        env = os.environ.copy()
        env["GEMINI_API_KEY"] = api_key

        _log(f"Analyzing the transcript for new viral moments (excluding {len(exclude_ranges)} existing range(s))...")
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=os.getcwd())
        # Reuse the run_job log pump: reads the child's merged stdout into logs.
        t_log = threading.Thread(target=enqueue_output, args=(proc.stdout, job_id))
        t_log.daemon = True
        t_log.start()

        deadline = time.time() + 15 * 60  # generous cap; heavy ffmpeg/detection work
        while proc.poll() is None:
            if time.time() > deadline:
                proc.kill()
                proc.wait()  # reap it; a killed-but-unwaited child lingers as a zombie
                _log("More-clips run timed out; existing clips are unchanged.")
                return
            time.sleep(1)
        t_log.join(timeout=5)

        if proc.returncode != 0:
            _log(f"More-clips run failed (exit {proc.returncode}); existing clips are unchanged.")
            return

        added = _merge_more_clips(job_id, output_dir, meta_path, scratch_dir)
        _log(f"Added {added} new clip(s)." if added else "No new clips were added.")
        if added:
            # Back up the appended clips + rewritten metadata, same as run_job's
            # completion path — otherwise the bucket keeps stale metadata that
            # omits the new clips. Fire-and-forget (no-ops when S3 is unset) so
            # the user sees results without waiting on the upload.
            threading.Thread(
                target=upload_job_artifacts, args=(output_dir, job_id), daemon=True
            ).start()
    except Exception as e:
        # The original metadata/result is untouched on any failure (merge is
        # all-or-nothing and raises before rewriting metadata).
        _log(f"More-clips run error: {e}; existing clips are unchanged.")
    finally:
        job = jobs.get(job_id)
        if job is not None:
            job["status"] = "completed"
            job["completed_at"] = time.time()
        _persist_result(job_id)
        shutil.rmtree(scratch_dir, ignore_errors=True)


async def _run_more_clips_task(job_id: str, count, api_key: str):
    # Acquire the SAME asyncio semaphore that gates run_job so a more-clips run
    # counts against MAX_CONCURRENT_JOBS — a semaphore slot (vs. a bare thread)
    # is the right fit here because this is heavy ffmpeg/detection work that
    # must not oversubscribe the machine alongside a normal job. We stay in
    # async land for the gate and offload the blocking subprocess+merge to a
    # thread via run_in_executor.
    async with concurrency_semaphore:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _more_clips_worker, job_id, count, api_key)


@app.post("/api/jobs/{job_id}/more-clips")
async def more_clips(job_id: str, request: Request):
    """Generate additional viral clips for a COMPLETED job from its saved
    transcript, excluding ranges already used, and append them to the results.
    Returns 202 immediately; the frontend polls /api/status as usual."""
    api_key = request.headers.get("X-Gemini-Key")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")
    if not _safe_job_id(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")

    # Optional {"count": int} body, clamped 1..10; omitted => AI decides.
    count = None
    if "application/json" in request.headers.get("content-type", ""):
        try:
            body = await request.json()
            if isinstance(body, dict) and body.get("count") is not None:
                count = max(1, min(10, int(body["count"])))
        except (ValueError, TypeError, json.JSONDecodeError):
            count = None

    output_dir = os.path.join(OUTPUT_DIR, job_id)
    if not os.path.isdir(output_dir):
        raise HTTPException(status_code=404, detail="Job not found")

    if not os.path.isfile(os.path.join(output_dir, "original.mp4")):
        raise HTTPException(status_code=400, detail="The original video is no longer available for this project. Process the video again to generate more clips.")

    meta_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if not meta_files:
        raise HTTPException(status_code=400, detail="This project has no saved clip metadata to build on.")
    try:
        with open(meta_files[0]) as f:
            meta = json.load(f)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read this project's clip metadata.")
    if not meta.get("transcript"):
        raise HTTPException(status_code=400, detail="This project was created before transcripts were saved, so more clips can't be generated. Process the video again.")

    # Reject a second run while one is in flight. Two concurrent workers would
    # both renumber new clips from the same existing count and clobber each
    # other's files/metadata — the frontend button guards one tab, but this is
    # the trust boundary (two tabs, a retry, or a direct API call).
    job = jobs.get(job_id)
    if job is not None and job.get("status") in ("queued", "processing"):
        raise HTTPException(status_code=409, detail="This project is already processing. Wait for it to finish, then try again.")

    # Resurrect / patch the in-memory job (it may be gone after a restart) so it
    # keeps showing the existing clips while the new ones are generated.
    if job is None:
        snap = _load_persisted_result(job_id)
        job = {"status": "completed", "logs": [], "result": (snap or {}).get("result")}
        jobs[job_id] = job
    elif job.get("result") is None:
        snap = _load_persisted_result(job_id)
        if snap:
            job["result"] = snap.get("result")
    job.setdefault("logs", [])
    job["status"] = "processing"
    job["logs"].append("Generating more clips...")

    asyncio.create_task(_run_more_clips_task(job_id, count, api_key))
    return {"status": "processing"}


from editor import VideoEditor
from subtitles import generate_srt, burn_subtitles, generate_srt_from_video
from hooks import add_hook_to_video

class EditRequest(BaseModel):
    job_id: str
    clip_index: int
    api_key: Optional[str] = None
    input_filename: Optional[str] = None

@app.post("/api/edit")
async def edit_clip(
    req: EditRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    # Determine API Key
    final_api_key = req.api_key or x_gemini_key or os.environ.get("GEMINI_API_KEY")
    
    if not final_api_key:
        raise HTTPException(status_code=400, detail="Missing Gemini API Key (Header or Body)")

    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = jobs[req.job_id]
    if 'result' not in job or 'clips' not in job['result']:
        raise HTTPException(status_code=400, detail="Job result not available")
        
    try:
        # Resolve Input Path: Prefer explict input_filename from frontend (chaining edits)
        if req.input_filename:
            # Security: Ensure just a filename, no paths
            safe_name = os.path.basename(unquote(req.input_filename))
            input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_name)
            filename = safe_name
        else:
            # Fallback to original clip
            clip = job['result']['clips'][req.clip_index]
            video_url = clip.get('video_url')
            if not video_url:
                raise HTTPException(status_code=400, detail="Clip video URL not found")
            filename = unquote(video_url.split('/')[-1])
            input_path = os.path.join(OUTPUT_DIR, req.job_id, filename)
        
        if not os.path.exists(input_path):
             raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")

        # Define output path for edited video
        edited_filename = f"edited_{filename}"
        output_path = os.path.join(OUTPUT_DIR, req.job_id, edited_filename)
        
        # Run editing in a thread to avoid blocking main loop
        # Since VideoEditor uses blocking calls (subprocess, API wait)
        def run_edit():
            editor = VideoEditor(api_key=final_api_key)
            
            # SAFE FILE RENAMING STRATEGY (Avoid UnicodeEncodeError in Docker)
            # Create a safe ASCII filename in the same directory
            safe_filename = f"temp_input_{req.job_id}.mp4"
            safe_input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_filename)
            
            # Copy original file to safe path
            # (Copy is safer than rename if something crashes, we keep original)
            shutil.copy(input_path, safe_input_path)
            
            try:
                # 1. Upload (using safe path)
                vid_file = editor.upload_video(safe_input_path)
                
                # 2. Get duration
                import cv2
                cap = cv2.VideoCapture(safe_input_path)
                fps = cap.get(cv2.CAP_PROP_FPS)
                frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                duration = frame_count / fps if fps else 0
                cap.release()
                
                # Load transcript from metadata
                transcript = None
                try:
                    meta_files = glob.glob(os.path.join(OUTPUT_DIR, req.job_id, "*_metadata.json"))
                    if meta_files:
                        with open(meta_files[0], 'r') as f:
                            data = json.load(f)
                            transcript = data.get('transcript')
                except Exception as e:
                    print(f"⚠️ Could not load transcript for editing context: {e}")

                # 3. Get Plan (Filter String)
                filter_data = editor.get_ffmpeg_filter(vid_file, duration, fps=fps, width=width, height=height, transcript=transcript)
                
                # 4. Apply
                # Use safe output name first
                safe_output_path = os.path.join(OUTPUT_DIR, req.job_id, f"temp_output_{req.job_id}.mp4")
                editor.apply_edits(safe_input_path, safe_output_path, filter_data)
                
                # Move result to final destination (rename works even if dest name has unicode if filesystem supports it, 
                # but python might still struggle if locale is broken? No, os.rename usually handles it better than subprocess args)
                # Actually, output_path is defined above: f"edited_{filename}"
                # If filename has unicode, output_path has unicode.
                # Let's hope shutil.move / os.rename works.
                if os.path.exists(safe_output_path):
                    shutil.move(safe_output_path, output_path)
                
                return filter_data
            finally:
                # Cleanup temp safe input
                if os.path.exists(safe_input_path):
                    os.remove(safe_input_path)

        # Run in thread pool
        loop = asyncio.get_event_loop()
        plan = await loop.run_in_executor(None, run_edit)
        
        # Update clip URL in the job result? 
        # Or return new URL and let frontend handle it?
        # Updating job result allows persistence if page refreshes.
        
        new_video_url = _video_url(req.job_id, edited_filename)
        
        # Start a new "edited" clip entry or just update the current one?
        # Let's update the current one's video_url but keep backup?
        # Or return the new URL to the frontend to display.
        
        return {
            "success": True, 
            "new_video_url": new_video_url,
            "edit_plan": plan
        }

    except Exception as e:
        print(f"❌ Edit Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class SubtitleRequest(BaseModel):
    job_id: str
    clip_index: int
    position: str = "bottom" # top, middle, bottom
    font_size: int = 16
    font_name: str = "Verdana"
    font_color: str = "#FFFFFF"
    border_color: str = "#000000"
    border_width: int = 2
    bg_color: str = "#000000"
    bg_opacity: float = 0.0
    input_filename: Optional[str] = None


# --- "Extend a clip": pull an arbitrary section of the full original into a short ---

def _ffprobe_json(path: str) -> dict:
    """Run ffprobe and return the parsed JSON (streams + format), or {} on error."""
    try:
        out = subprocess.check_output([
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_streams", "-show_format", path,
        ], stderr=subprocess.DEVNULL)
        return json.loads(out.decode("utf-8", "replace"))
    except (subprocess.CalledProcessError, OSError, ValueError, json.JSONDecodeError):
        return {}


def _probe_media(path: str) -> dict:
    """Video + audio stream parameters of a media file, for matching an
    extension segment to the clip's editor source before concatenation."""
    info = _ffprobe_json(path)
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), {})
    # fps from "num/den" avg_frame_rate (fall back to r_frame_rate).
    fps = 30.0
    for key in ("avg_frame_rate", "r_frame_rate"):
        rate = v.get(key)
        if rate and "/" in rate:
            num, den = rate.split("/")
            try:
                if float(den) != 0:
                    fps = float(num) / float(den)
                    break
            except ValueError:
                pass
    duration = 0.0
    try:
        duration = float(info.get("format", {}).get("duration") or 0.0)
    except (ValueError, TypeError):
        pass
    return {
        "width": int(v.get("width") or 0),
        "height": int(v.get("height") or 0),
        "fps": fps,
        "pix_fmt": v.get("pix_fmt") or "yuv420p",
        "has_audio": bool(a),
        "audio_rate": int(a.get("sample_rate") or 48000) if a else 48000,
        "audio_channels": int(a.get("channels") or 2) if a else 2,
        "duration": duration,
    }


def _probe_frame_count(path: str, fps: float) -> int:
    """Number of video frames in a file. Prefers the container's nb_frames, then
    an exact decoded count, then duration×fps — so the appended clip's source
    range lands on the real concat boundary."""
    info = _ffprobe_json(path)
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    nb = v.get("nb_frames")
    if nb and str(nb).isdigit() and int(nb) > 0:
        return int(nb)
    # Exact decoded count (slower, but _source clips are short).
    try:
        out = subprocess.check_output([
            "ffprobe", "-v", "quiet", "-select_streams", "v:0",
            "-count_frames", "-show_entries", "stream=nb_read_frames",
            "-of", "default=nokey=1:noprint_wrappers=1", path,
        ], stderr=subprocess.DEVNULL).decode().strip()
        if out.isdigit() and int(out) > 0:
            return int(out)
    except (subprocess.CalledProcessError, OSError):
        pass
    dur = _probe_media(path)["duration"]
    return max(1, round(dur * (fps or 30.0)))


def _clip_caption_origin(output_dir: str, clip_index: int):
    """(captionsOriginFrame, source fps) for a clip, read from its framing.json.
    captionsOriginFrame is the padded-source frame that the clip's absolute start
    maps to — the anchor caption ms are measured against."""
    origin, fps = 0, 30.0
    matches = glob.glob(os.path.join(output_dir, f"*_clip_{clip_index + 1}.framing.json"))
    if matches:
        try:
            with open(matches[0]) as f:
                framing = json.load(f)
            if isinstance(framing, dict):
                origin = framing.get("captionsOriginFrame", framing.get("clipInFrame", 0)) or 0
                fps = (framing.get("source") or {}).get("fps") or 30.0
        except (OSError, json.JSONDecodeError):
            pass
    return int(origin), float(fps)


def _extension_caption_words(ext: dict, transcript: dict, captions_origin: int, src_fps: float):
    """Caption words for one appended section, timed in the SAME ms axis the
    editor uses (relative to captionsOriginFrame). An extension's audio sits at
    padded-source frame `frameOffset`, so a transcript word at absolute time t
    (start_sec ≤ t < end_sec) lands at frame `frameOffset + (t - start_sec)*fps`;
    inverting the editor's frame↔ms formula gives its startMs/endMs, so the word
    highlights exactly when it is spoken in the appended footage."""
    start_sec = float(ext.get("start_sec", 0.0))
    end_sec = float(ext.get("end_sec", 0.0))
    frame_offset = int(ext.get("frameOffset", 0))
    words = []
    for segment in transcript.get("segments", []):
        for w in segment.get("words", []):
            ws, we = w.get("start"), w.get("end")
            if ws is not None and we is not None and we > start_sec and ws < end_sec:
                fs = frame_offset + round((ws - start_sec) * src_fps)
                fe = frame_offset + round((we - start_sec) * src_fps)
                cap = {
                    "text": w.get("word", "").strip(),
                    "startMs": int((fs - captions_origin) / src_fps * 1000),
                    "endMs": int((fe - captions_origin) / src_fps * 1000),
                }
                if w.get("language"):
                    cap["language"] = w["language"]
                words.append(cap)
    return words


class ExtendClipRequest(BaseModel):
    start_sec: float
    end_sec: float


EXTEND_MAX_SECONDS = 120.0


@app.get("/api/source-transcript/{job_id}")
async def get_source_transcript(job_id: str):
    """Full-video transcript (segments with word-level, ABSOLUTE-second timings)
    plus the original duration and whether original.mp4 is available — powers the
    Extend-a-clip picker."""
    if not _safe_job_id(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")
    with open(json_files[0]) as f:
        data = json.load(f)
    transcript = data.get("transcript")
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcript not found in metadata")

    original_path = os.path.join(output_dir, "original.mp4")
    has_original = os.path.exists(original_path)
    duration = 0.0
    if has_original:
        loop = asyncio.get_running_loop()
        duration = (await loop.run_in_executor(None, _probe_media, original_path))["duration"]
    if not duration:
        # Fall back to the last transcript word so the picker still renders a range
        # even if the original probe is momentarily unavailable.
        for segment in transcript.get("segments", []):
            for w in segment.get("words", []):
                duration = max(duration, float(w.get("end", 0.0)))

    segments = []
    for segment in transcript.get("segments", []):
        words = [
            {"text": w.get("word", "").strip(), "start": float(w["start"]), "end": float(w["end"])}
            for w in segment.get("words", [])
            if w.get("start") is not None and w.get("end") is not None
        ]
        if words:
            segments.append({
                "start": words[0]["start"],
                "end": words[-1]["end"],
                "words": words,
            })

    return {
        "hasOriginal": has_original,
        "duration": duration,
        "language": transcript.get("language", "en"),
        "segments": segments,
    }


def _run_extend_task(task_id: str, job_id: str, clip_index: int, start_sec: float, end_sec: float):
    """Cut [start_sec, end_sec) from original.mp4, re-encode it to match the
    clip's editor source exactly, append it to the end of that _source.mp4, and
    record the extension so captions/framing can reference the appended frames.
    Runs in a BackgroundTask; updates extend_tasks[task_id]."""
    def _fail(msg):
        with extend_tasks_lock:
            prev = extend_tasks.get(task_id, {})
            extend_tasks[task_id] = {**prev, "status": "error", "error": msg}

    tmp_paths = []
    try:
        from ffmpeg_utils import video_codec_args  # matches how _source.mp4 was encoded

        output_dir = os.path.join(OUTPUT_DIR, job_id)
        original_path = os.path.join(output_dir, "original.mp4")
        source_matches = glob.glob(os.path.join(output_dir, f"*_clip_{clip_index + 1}_source.mp4"))
        if not source_matches:
            return _fail("Editor source for this clip was not found.")
        source_path = source_matches[0]

        src = _probe_media(source_path)
        width, height, fps = src["width"], src["height"], src["fps"]
        if not width or not height:
            return _fail("Could not read the clip source video parameters.")

        old_frames = _probe_frame_count(source_path, fps)

        # 1. Cut + re-encode the requested section to match the editor source.
        seg_path = os.path.join(output_dir, f".extend_{task_id}_seg.mp4")
        tmp_paths.append(seg_path)
        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}"
        )
        seg_cmd = [
            "ffmpeg", "-y",
            "-ss", str(start_sec), "-to", str(end_sec),
            "-i", original_path,
            "-vf", vf,
            *video_codec_args("intermediate", keyframe_interval=15),
            "-c:a", "aac", "-ar", str(src["audio_rate"]), "-ac", str(src["audio_channels"]),
            seg_path,
        ]
        res = subprocess.run(seg_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if res.returncode != 0 or not os.path.exists(seg_path) or os.path.getsize(seg_path) == 0:
            return _fail("Failed to cut the selected section from the original video.")

        # 2. Concat the segment onto the end of the editor source.
        list_path = os.path.join(output_dir, f".extend_{task_id}_list.txt")
        tmp_paths.append(list_path)
        def _concat_quote(p):
            # ffmpeg concat demuxer: single-quote the path and escape any
            # embedded single quote (paths can carry a video title's apostrophe).
            return os.path.abspath(p).replace("'", "'\\''")
        with open(list_path, "w") as f:
            f.write(f"file '{_concat_quote(source_path)}'\n")
            f.write(f"file '{_concat_quote(seg_path)}'\n")
        combined_path = os.path.join(output_dir, f".extend_{task_id}_out.mp4")
        tmp_paths.append(combined_path)

        def _concat(reencode):
            cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path]
            if reencode:
                cmd += [*video_codec_args("intermediate", keyframe_interval=15), "-c:a", "aac"]
            else:
                cmd += ["-c", "copy"]
            cmd.append(combined_path)
            return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        cat = _concat(reencode=False)
        if cat.returncode != 0 or not os.path.exists(combined_path) or os.path.getsize(combined_path) == 0:
            cat = _concat(reencode=True)
            if cat.returncode != 0 or not os.path.exists(combined_path) or os.path.getsize(combined_path) == 0:
                return _fail("Failed to append the selected section to the clip.")

        # 3. Swap the combined file in for the editor source, atomically.
        os.replace(combined_path, source_path)
        tmp_paths.remove(combined_path)
        new_frames = _probe_frame_count(source_path, fps)
        if new_frames <= old_frames:
            return _fail("The extended source did not grow — nothing was added.")

        # 4. Record the extension + build caption words for the appended range.
        json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
        origin, src_fps = _clip_caption_origin(output_dir, clip_index)
        words = []
        if json_files:
            with open(json_files[0]) as f:
                data = json.load(f)
            transcript = data.get("transcript") or {}
            ext_record = {
                "start_sec": start_sec,
                "end_sec": end_sec,
                "frameOffset": old_frames,
                "frames": new_frames - old_frames,
            }
            shorts = data.get("shorts", [])
            if 0 <= clip_index < len(shorts):
                shorts[clip_index].setdefault("extensions", []).append(ext_record)
                tmp_meta = json_files[0] + ".tmp"
                with open(tmp_meta, "w") as f:
                    json.dump(data, f, indent=2)
                os.replace(tmp_meta, json_files[0])
            words = _extension_caption_words(ext_record, transcript, origin, src_fps)

        # 5. Reframe the appended frames the same way the pipeline framed the
        # original clip (scene detection + face tracking + smoothed camera),
        # via an analysis-only subprocess. On any failure the editor falls
        # back to inserting a plain fill clip, as before.
        analysis = None
        try:
            aspect = "9:16"
            framing_matches = glob.glob(os.path.join(output_dir, f"*_clip_{clip_index + 1}.framing.json"))
            if framing_matches:
                with open(framing_matches[0]) as f:
                    fr = json.load(f)
                aspect = {
                    (1080, 1920): "9:16", (1080, 1080): "1:1",
                    (1080, 1350): "4:5", (1920, 1080): "16:9",
                }.get((fr.get("outputWidth"), fr.get("outputHeight")), "9:16")
            analysis_path = os.path.join(output_dir, f".extend_{task_id}_analysis.json")
            tmp_paths.append(analysis_path)
            cmd = [
                sys.executable, "-u", os.path.join(os.path.dirname(os.path.abspath(__file__)), "main.py"),
                "-i", source_path,
                "--analyze-start", str(old_frames), "--analyze-end", str(new_frames),
                "--aspect-ratio", aspect, "--analysis-out", analysis_path,
            ]
            proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=540)
            if proc.returncode == 0 and os.path.exists(analysis_path):
                with open(analysis_path) as f:
                    analysis = json.load(f)
            else:
                print(
                    f"⚠️ Reframe analysis failed (exit code {proc.returncode}) for job {job_id} "
                    f"clip {clip_index}: {proc.stderr.decode(errors='replace')[-2000:]}"
                )
        except Exception as e:  # noqa: BLE001 — log and fall back to a plain clip
            print(f"⚠️ Reframe analysis raised for job {job_id} clip {clip_index}: {e}")
            analysis = None

        new_clips = None
        if analysis and analysis.get("segments"):
            new_clips = [
                {
                    "sourceStart": max(old_frames, int(seg["startFrame"])),
                    "sourceEnd": min(new_frames, int(seg["endFrame"])),
                    "layout": seg.get("layout", "fill"),
                    "trackedFaceIds": seg.get("trackedFaceIds", []),
                    "cameraKeyframes": seg.get("cameraKeyframes", []),
                    "manualCrop": None,
                }
                for seg in analysis["segments"]
                if min(new_frames, int(seg["endFrame"])) > max(old_frames, int(seg["startFrame"]))
            ] or None

        with extend_tasks_lock:
            prev = extend_tasks.get(task_id, {})
            extend_tasks[task_id] = {
                **prev,
                "status": "done",
                "result": {
                    "newDurationFrames": new_frames,
                    "insertStart": old_frames,
                    "insertEnd": new_frames,
                    "words": words,
                    "clips": new_clips,
                    "faceTracks": (analysis or {}).get("faceTracks") or [],
                    "originalStartSec": start_sec,
                },
            }
    except Exception as e:  # noqa: BLE001 — surface any failure to the poller
        _fail(f"Extend failed: {e}")
    finally:
        for p in tmp_paths:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass


@app.post("/api/clips/{job_id}/{clip_index}/extend")
async def extend_clip(job_id: str, clip_index: int, req: ExtendClipRequest, background_tasks: BackgroundTasks):
    """Kick off appending a section [start_sec, end_sec) of the full original
    video onto the end of this clip's editor source. Returns a task_id to poll."""
    if not _safe_job_id(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    original_path = os.path.join(output_dir, "original.mp4")
    if not os.path.exists(original_path):
        raise HTTPException(
            status_code=409,
            detail="Original video not available for this project — process the video again to enable Extend.",
        )
    start_sec, end_sec = float(req.start_sec), float(req.end_sec)
    loop = asyncio.get_running_loop()
    duration = (await loop.run_in_executor(None, _probe_media, original_path))["duration"] or 0.0
    if not (0 <= start_sec < end_sec):
        raise HTTPException(status_code=422, detail="start_sec must be >= 0 and less than end_sec")
    if duration and end_sec > duration + 0.5:
        raise HTTPException(status_code=422, detail="Selected range extends past the end of the video")
    if end_sec - start_sec > EXTEND_MAX_SECONDS:
        raise HTTPException(status_code=422, detail=f"Selection is too long (max {int(EXTEND_MAX_SECONDS)}s)")
    if not glob.glob(os.path.join(output_dir, f"*_clip_{clip_index + 1}_source.mp4")):
        raise HTTPException(status_code=404, detail="Editor source for this clip was not found")

    task_id = str(uuid.uuid4())
    with extend_tasks_lock:
        # Prune finished tasks older than an hour so this dict can't grow forever.
        now = time.time()
        for tid, t in list(extend_tasks.items()):
            if now - t.get("created_at", 0) > 3600:
                extend_tasks.pop(tid, None)
        extend_tasks[task_id] = {"status": "pending", "created_at": now}
    background_tasks.add_task(_run_extend_task, task_id, job_id, clip_index, start_sec, end_sec)
    return {"task_id": task_id}


@app.get("/api/clips/{job_id}/{clip_index}/extend/{task_id}")
async def extend_clip_status(job_id: str, clip_index: int, task_id: str):
    with extend_tasks_lock:
        task = extend_tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Extend task not found")
    return task


@app.get("/api/clip/{job_id}/{clip_index}/transcript")
async def get_clip_transcript(job_id: str, clip_index: int):
    """Return word-level captions for a specific clip, formatted for Remotion."""
    # No in-memory job check: everything below reads from disk, and the editor
    # must keep working for jobs that survived a backend restart.
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))

    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")

    with open(json_files[0], 'r') as f:
        data = json.load(f)

    transcript = data.get('transcript')
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcript not found in metadata")

    clips = data.get('shorts', [])
    if clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="Clip not found")

    clip_data = clips[clip_index]
    clip_start = clip_data.get('start', 0)
    clip_end = clip_data.get('end', 0)

    # If this clip's framing.json already carries injected captions (Podcast
    # Trailer mode pre-writes retimed DOAC captions whose order/length differ
    # from the original transcript), return THOSE verbatim. The editor edits
    # captions by index into framing.subtitles.captions, so the transcript panel
    # must show the same list — re-deriving from the original transcript would
    # misalign indices and corrupt the captions on edit. Normal clips have no
    # injected subtitles, so they fall through to transcript-derived words.
    framing_files = glob.glob(os.path.join(output_dir, f"*_clip_{clip_index + 1}.framing.json"))
    if framing_files:
        try:
            with open(framing_files[0], 'r') as f:
                framing = json.load(f)
            injected = (framing.get('subtitles') or {}).get('captions')
            if injected:
                return {
                    "captions": injected,
                    "durationSec": clip_end - clip_start,
                    "language": transcript.get('language', 'en'),
                }
        except (OSError, json.JSONDecodeError):
            pass  # fall through to transcript-derived captions

    # Extract words within clip range and convert to CaptionWord format
    captions = []
    for segment in transcript.get('segments', []):
        for word_info in segment.get('words', []):
            if word_info['end'] > clip_start and word_info['start'] < clip_end:
                cap = {
                    "text": word_info.get('word', '').strip(),
                    "startMs": int((max(0, word_info['start'] - clip_start)) * 1000),
                    "endMs": int((max(0, word_info['end'] - clip_start)) * 1000),
                }
                # Soniox emits a per-word language tag (multilingual clips); pass
                # it through when present. Whisper output omits it — harmless.
                if word_info.get('language'):
                    cap["language"] = word_info['language']
                captions.append(cap)

    # Append caption words for any sections the user pulled in via "Extend a clip".
    # These live at the END of the padded _source.mp4, so their timings can't be
    # derived from the clip window above — they're recomputed from the recorded
    # extension frame offsets so a full editor reload keeps captions on the beat.
    extensions = clip_data.get('extensions') or []
    if extensions:
        origin, src_fps = _clip_caption_origin(output_dir, clip_index)
        for ext in extensions:
            captions.extend(_extension_caption_words(ext, transcript, origin, src_fps))

    duration_sec = clip_end - clip_start

    return {
        "captions": captions,
        "durationSec": duration_sec,
        "language": transcript.get('language', 'en'),
    }


# --- Remotion Render Proxy ---
# Default suits running everything on one machine; docker-compose overrides
# this with the container hostname (http://renderer:3100).
RENDER_SERVICE_URL = os.getenv("RENDER_SERVICE_URL", "http://localhost:3100")

@app.post("/api/render")
async def proxy_render(request: Request):
    """Proxy render requests to the Node.js Remotion render service."""
    import httpx
    from fastapi.responses import JSONResponse
    body = await request.json()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{RENDER_SERVICE_URL}/render", json=body)
            # Pass the renderer's status code through — wrapping errors in a
            # 200 would make the editor treat failures as progress forever.
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Render service unavailable: {e}")

@app.get("/api/render/{render_id}")
async def proxy_render_status(render_id: str):
    """Proxy render status polling to the Node.js Remotion render service."""
    import httpx
    from fastapi.responses import JSONResponse
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{RENDER_SERVICE_URL}/render/{render_id}")
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Render service unavailable: {e}")


class EffectsGenerateRequest(BaseModel):
    job_id: str
    clip_index: int
    input_filename: Optional[str] = None

@app.post("/api/effects/generate")
async def generate_effects_config(
    req: EffectsGenerateRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Generate structured EffectsConfig JSON for Remotion rendering via Gemini AI."""
    final_api_key = x_gemini_key or os.environ.get("GEMINI_API_KEY")

    if not final_api_key:
        raise HTTPException(status_code=400, detail="Missing Gemini API Key (Header)")

    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[req.job_id]
    if 'result' not in job or 'clips' not in job['result']:
        raise HTTPException(status_code=400, detail="Job result not available")

    try:
        # Resolve input path
        if req.input_filename:
            safe_name = os.path.basename(unquote(req.input_filename))
            input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_name)
        else:
            clip = job['result']['clips'][req.clip_index]
            video_url = clip.get('video_url')
            if not video_url:
                raise HTTPException(status_code=400, detail="Clip video URL not found")
            filename = unquote(video_url.split('/')[-1])
            input_path = os.path.join(OUTPUT_DIR, req.job_id, filename)

        if not os.path.exists(input_path):
            raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")

        def run_effects_generation():
            editor = VideoEditor(api_key=final_api_key)

            # Create safe ASCII filename to avoid encoding issues
            safe_filename = f"temp_effects_{req.job_id}.mp4"
            safe_input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_filename)
            shutil.copy(input_path, safe_input_path)

            try:
                # Upload video to Gemini
                vid_file = editor.upload_video(safe_input_path)

                # Get video metadata via ffprobe
                probe_cmd = [
                    'ffprobe', '-v', 'error',
                    '-select_streams', 'v:0',
                    '-show_entries', 'stream=width,height,r_frame_rate,duration',
                    '-show_entries', 'format=duration',
                    '-of', 'json',
                    safe_input_path
                ]
                probe_result = subprocess.check_output(probe_cmd).decode().strip()
                probe_data = json.loads(probe_result)

                stream = probe_data.get('streams', [{}])[0]
                width = int(stream.get('width', 1080))
                height = int(stream.get('height', 1920))

                # Parse fps from r_frame_rate (e.g. "30/1")
                r_frame_rate = stream.get('r_frame_rate', '30/1')
                num, den = r_frame_rate.split('/')
                fps = round(int(num) / int(den), 2)

                # Get duration from stream or format
                duration = float(stream.get('duration', 0))
                if duration == 0:
                    duration = float(probe_data.get('format', {}).get('duration', 0))

                # Load transcript from metadata
                transcript = None
                try:
                    meta_files = glob.glob(os.path.join(OUTPUT_DIR, req.job_id, "*_metadata.json"))
                    if meta_files:
                        with open(meta_files[0], 'r') as f:
                            data = json.load(f)
                            transcript = data.get('transcript')
                except Exception as e:
                    print(f"⚠️ Could not load transcript for effects config: {e}")

                # Generate effects config
                effects_config = editor.get_effects_config(
                    vid_file, duration, fps=fps, width=width, height=height, transcript=transcript
                )

                return effects_config
            finally:
                if os.path.exists(safe_input_path):
                    os.remove(safe_input_path)

        loop = asyncio.get_event_loop()
        effects_config = await loop.run_in_executor(None, run_effects_generation)

        if effects_config is None:
            raise HTTPException(status_code=500, detail="Failed to generate effects config from Gemini")

        return {"effects": effects_config}

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Effects Generation Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class CaptionEnhanceRequest(BaseModel):
    words: List[str]

@app.post("/api/captions/enhance")
async def enhance_captions(
    req: CaptionEnhanceRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """AI emoji + keyword highlight pass over caption words (text-only Gemini).

    Returns {"emojis": {index: emoji, ...}, "highlights": [index, ...]} that the
    frontend merges into the subtitle captions by index. No video upload — the
    captions are text, so this is fast and cheap.
    """
    final_api_key = x_gemini_key or os.environ.get("GEMINI_API_KEY")

    if not final_api_key:
        raise HTTPException(status_code=400, detail="Missing Gemini API Key (Header)")

    if not req.words:
        return {"emojis": {}, "highlights": []}

    try:
        def run_enhance():
            editor = VideoEditor(api_key=final_api_key)
            return editor.get_caption_enhancements(req.words)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, run_enhance)
        return result or {"emojis": {}, "highlights": []}
    except Exception as e:
        print(f"❌ Caption Enhancement Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class BrollWord(BaseModel):
    text: str
    startMs: int

class BrollSuggestRequest(BaseModel):
    words: List[BrollWord]

@app.post("/api/broll/suggest")
async def suggest_broll(
    req: BrollSuggestRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """AI b-roll auto-placement pass over caption words (text-only Gemini).

    Returns {"suggestions": [{keyword, startMs, durationMs}, ...]} (up to 3).
    The frontend turns each keyword into a Pexels stock clip and inserts it at
    the suggested moment. No video upload — captions are text, so this is fast.
    """
    final_api_key = x_gemini_key or os.environ.get("GEMINI_API_KEY")

    if not final_api_key:
        raise HTTPException(status_code=400, detail="Missing Gemini API Key (Header)")

    if not req.words:
        return {"suggestions": []}

    try:
        def run_suggest():
            editor = VideoEditor(api_key=final_api_key)
            words = [{"text": w.text, "startMs": w.startMs} for w in req.words]
            return editor.get_broll_suggestions(words)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, run_suggest)
        return {"suggestions": result or []}
    except Exception as e:
        print(f"❌ B-roll Suggestion Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/subtitle")
async def add_subtitles(req: SubtitleRequest):
    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    # Reload job data from disk just in case metadata was updated
    job = jobs[req.job_id]
    
    # We need to access metadata.json to get the transcript
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    
    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")
        
    with open(json_files[0], 'r') as f:
        data = json.load(f)
        
    transcript = data.get('transcript')
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcript not found in metadata. Please process a new video.")
        
    clips = data.get('shorts', [])
    if req.clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="Clip not found")
        
    clip_data = clips[req.clip_index]
    
    # Video Path
    if req.input_filename:
        # Use chained file
        filename = os.path.basename(unquote(req.input_filename))
    else:
        # Fallback to standard naming
        filename = unquote(clip_data.get('video_url', '').split('/')[-1])
        if not filename:
             base_name = os.path.basename(json_files[0]).replace('_metadata.json', '')
             filename = f"{base_name}_clip_{req.clip_index+1}.mp4"
         
    input_path = os.path.join(output_dir, filename)
    if not os.path.exists(input_path):
        # Try looking for edited version if url implied it?
        # Just fail if not found.
        raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")
        
    # Define outputs
    srt_filename = f"subs_{req.clip_index}_{int(time.time())}.srt"
    srt_path = os.path.join(output_dir, srt_filename)
    
    # Output video
    # We create a new file "subtitled_..."
    output_filename = f"subtitled_{filename}"
    output_path = os.path.join(output_dir, output_filename)
    
    try:
        # 1. Generate SRT
        # Check if this is a dubbed video - if so, transcribe it fresh
        is_dubbed = filename.startswith("translated_")

        if is_dubbed:
            print(f"🎙️ Dubbed video detected, transcribing audio for subtitles...")
            def run_transcribe_srt():
                return generate_srt_from_video(input_path, srt_path)

            loop = asyncio.get_event_loop()
            success = await loop.run_in_executor(None, run_transcribe_srt)
        else:
            success = generate_srt(transcript, clip_data['start'], clip_data['end'], srt_path)

        if not success:
             raise HTTPException(status_code=400, detail="No words found for this clip range.")

        # 2. Burn Subtitles
        # Run in thread pool
        def run_burn():
             burn_subtitles(input_path, srt_path, output_path,
                           alignment=req.position, fontsize=req.font_size,
                           font_name=req.font_name, font_color=req.font_color,
                           border_color=req.border_color, border_width=req.border_width,
                           bg_color=req.bg_color, bg_opacity=req.bg_opacity)
        
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, run_burn)
        
    except Exception as e:
        print(f"❌ Subtitle Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
        
    # 3. Update Result and Metadata
    # Update InMemory Jobs
    if req.clip_index < len(job['result']['clips']):
         job['result']['clips'][req.clip_index]['video_url'] = _video_url(req.job_id, output_filename)
         _persist_result(req.job_id)  # keep the on-disk snapshot in sync with edits

    # Update Metadata on Disk (Persistence)
    try:
        if req.clip_index < len(clips):
            clips[req.clip_index]['video_url'] = _video_url(req.job_id, output_filename)
            # Update the main data structure
            data['shorts'] = clips
            
            # Write back
            with open(json_files[0], 'w') as f:
                json.dump(data, f, indent=4)
                print(f"✅ Metadata updated with subtitled video for clip {req.clip_index}")
    except Exception as e:
        print(f"⚠️ Failed to update metadata.json: {e}")
        # Non-critical, but good for persistence

    return {
        "success": True,
        "new_video_url": _video_url(req.job_id, output_filename)
    }

# --- Clip framing (non-destructive editor, docs/video-editor-plan.md §2) ---

FRAMING_LAYOUTS = {"fill", "fit", "split", "three", "four", "screenshare", "gameplay"}

def _find_framing_path(job_id: str, clip_index: int) -> str:
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    matches = glob.glob(os.path.join(output_dir, f"*_clip_{clip_index + 1}.framing.json"))
    if not matches:
        raise HTTPException(status_code=404, detail="Framing data not found for this clip")
    return matches[0]

def _crop_rect_valid(rect) -> bool:
    if not isinstance(rect, dict):
        return False
    for key in ("x", "y", "w", "h"):
        v = rect.get(key)
        if not isinstance(v, (int, float)) or v < 0 or v > 1:
            return False
    return True

def _panel_crops_valid(panel_crops) -> bool:
    """Per-tile crops: null, or a list (max 6) of null-or-crop-rect entries."""
    if panel_crops is None:
        return True
    if not isinstance(panel_crops, list) or len(panel_crops) > 6:
        return False
    return all(pc is None or _crop_rect_valid(pc) for pc in panel_crops)

def _validate_framing_features(framing: dict) -> Optional[str]:
    """Optional feature payloads shared by all framing versions — light shape
    checks (the composition tolerates missing fields, so only reject obviously
    malformed types)."""
    for key in ("textOverlays", "broll"):
        if key in framing and not isinstance(framing[key], list):
            return f"{key} must be a list"
    if len(framing.get("textOverlays", [])) > 5:
        return "at most 5 text overlays are allowed"
    if len(framing.get("broll", [])) > 3:
        return "at most 3 b-roll inserts are allowed"
    music = framing.get("music")
    if music is not None and not isinstance(music, dict):
        return "music must be an object or null"
    transitions = framing.get("transitions")
    if transitions is not None and not isinstance(transitions, dict):
        return "transitions must be an object"
    subtitles = framing.get("subtitles")
    if subtitles is not None and not isinstance(subtitles, dict):
        return "subtitles must be an object or null"
    return None

def _validate_framing_clips(framing: dict, duration: int) -> Optional[str]:
    """v3: the main track is an ordered clips[] list (decoupled from source order)."""
    clips = framing.get("clips")
    if not isinstance(clips, list) or not clips:
        return "clips must be a non-empty list"
    for i, clip in enumerate(clips):
        if not isinstance(clip, dict):
            return f"clips[{i}] must be an object"
        if clip.get("layout") not in FRAMING_LAYOUTS:
            return f"clips[{i}].layout must be one of {sorted(FRAMING_LAYOUTS)}"
        start, end = clip.get("sourceStart"), clip.get("sourceEnd")
        if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int):
            return f"clips[{i}] sourceStart/sourceEnd must be integers"
        if not (0 <= start < end <= duration):
            return f"clips[{i}] source range is out of bounds"
        tracked = clip.get("trackedFaceIds")
        if not isinstance(tracked, list) or not all(isinstance(x, int) and not isinstance(x, bool) for x in tracked):
            return f"clips[{i}].trackedFaceIds must be a list of integers"
        keyframes = clip.get("cameraKeyframes")
        if not isinstance(keyframes, list):
            return f"clips[{i}].cameraKeyframes must be a list"
        for kf in keyframes:
            if not _crop_rect_valid(kf):
                return f"clips[{i}] has an out-of-bounds camera keyframe"
        manual = clip.get("manualCrop")
        if manual is not None and not _crop_rect_valid(manual):
            return f"clips[{i}].manualCrop is out of bounds"
        if not _panel_crops_valid(clip.get("panelCrops")):
            return f"clips[{i}].panelCrops is invalid"
    return None

def _validate_framing(framing: dict) -> Optional[str]:
    """Returns an error message, or None if the framing config is valid."""
    if not isinstance(framing, dict):
        return "Framing must be an object"
    if framing.get("version") not in (1, 2, 3):
        return "Unsupported framing version"
    source = framing.get("source")
    if not isinstance(source, dict):
        return "Missing source"
    for key in ("file", "fps", "width", "height", "durationFrames"):
        if key not in source:
            return f"source.{key} is required"
    duration = source["durationFrames"]
    if isinstance(duration, bool) or not isinstance(duration, int) or duration <= 0:
        return "source.durationFrames must be a positive integer"

    origin = framing.get("captionsOriginFrame")
    if origin is not None and (isinstance(origin, bool) or not isinstance(origin, int) or not (0 <= origin <= duration)):
        return "captionsOriginFrame out of range"
    if not isinstance(framing.get("faceTracks"), list):
        return "faceTracks must be a list"

    # v3: ordered clip list is the source of truth (no contiguity/coverage rules).
    if framing.get("version") == 3 or isinstance(framing.get("clips"), list):
        err = _validate_framing_clips(framing, duration)
        if err:
            return err
        return _validate_framing_features(framing)

    # --- v1/v2: contiguous, source-ordered segments + cuts ---
    clip_in = framing.get("clipInFrame", 0)
    clip_out = framing.get("clipOutFrame", duration)
    if not isinstance(clip_in, int) or not isinstance(clip_out, int):
        return "clipInFrame/clipOutFrame must be integers"
    if not (0 <= clip_in < clip_out <= duration):
        return "clip bounds out of range"
    cuts = framing.get("cuts", [])
    if not isinstance(cuts, list):
        return "cuts must be a list"
    prev_cut_end = clip_in
    kept = clip_out - clip_in
    for i, cut in enumerate(cuts):
        if not isinstance(cut, dict):
            return f"cuts[{i}] must be an object"
        cs, ce = cut.get("startFrame"), cut.get("endFrame")
        if not isinstance(cs, int) or not isinstance(ce, int) or ce <= cs:
            return f"cuts[{i}] has an invalid frame range"
        if cs < prev_cut_end or ce > clip_out:
            return f"cuts[{i}] is out of order or outside the clip bounds"
        prev_cut_end = ce
        kept -= ce - cs
    if kept < 2:
        return "cuts cannot remove the entire clip"

    segments = framing.get("segments")
    if not isinstance(segments, list) or not segments:
        return "segments must be a non-empty list"
    prev_end = clip_in
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            return f"segments[{i}] must be an object"
        if seg.get("layout") not in FRAMING_LAYOUTS:
            return f"segments[{i}].layout must be one of {sorted(FRAMING_LAYOUTS)}"
        start, end = seg.get("startFrame"), seg.get("endFrame")
        if not isinstance(start, int) or not isinstance(end, int) or end <= start:
            return f"segments[{i}] has an invalid frame range"
        if start != prev_end:
            return f"segments[{i}] is not contiguous with the previous segment"
        prev_end = end
        if not isinstance(seg.get("trackedFaceIds"), list):
            return f"segments[{i}].trackedFaceIds must be a list"
        keyframes = seg.get("cameraKeyframes")
        if not isinstance(keyframes, list):
            return f"segments[{i}].cameraKeyframes must be a list"
        for kf in keyframes:
            if not _crop_rect_valid(kf):
                return f"segments[{i}] has an out-of-bounds camera keyframe"
        manual = seg.get("manualCrop")
        if manual is not None and not _crop_rect_valid(manual):
            return f"segments[{i}].manualCrop is out of bounds"
        if not _panel_crops_valid(seg.get("panelCrops")):
            return f"segments[{i}].panelCrops is invalid"
    if prev_end != clip_out:
        return "segments must cover the clip bounds exactly"

    return _validate_framing_features(framing)

@app.get("/api/clips/{job_id}/{clip_index}/framing")
async def get_clip_framing(job_id: str, clip_index: int):
    framing_path = _find_framing_path(job_id, clip_index)
    with open(framing_path, 'r') as f:
        return json.load(f)

@app.put("/api/clips/{job_id}/{clip_index}/framing")
async def save_clip_framing(job_id: str, clip_index: int, request: Request):
    framing_path = _find_framing_path(job_id, clip_index)
    framing = await request.json()
    error = _validate_framing(framing)
    if error:
        raise HTTPException(status_code=422, detail=error)
    with open(framing_path, 'w') as f:
        json.dump(framing, f)
    return {"success": True}

class ApplyRenderRequest(BaseModel):
    job_id: str
    clip_index: int
    filename: str

@app.post("/api/clips/apply-render")
async def apply_render(req: ApplyRenderRequest):
    """
    Promote a render-service output file to be the clip's video. Mirrors the
    subtitle endpoint's bookkeeping: updates the in-memory job (when present)
    and the on-disk metadata so the results grid and downloads pick it up.
    """
    filename = os.path.basename(req.filename)
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    rendered_path = os.path.join(output_dir, filename)
    if not os.path.exists(rendered_path) or os.path.getsize(rendered_path) == 0:
        raise HTTPException(status_code=404, detail=f"Rendered file not found: {filename}")

    new_video_url = _video_url(req.job_id, filename)

    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    if json_files:
        try:
            with open(json_files[0], 'r') as f:
                data = json.load(f)
            clips = data.get('shorts', [])
            if req.clip_index < len(clips):
                clips[req.clip_index]['video_url'] = new_video_url
                data['shorts'] = clips
                with open(json_files[0], 'w') as f:
                    json.dump(data, f, indent=4)
        except Exception as e:
            print(f"⚠️ apply-render: failed to update metadata.json: {e}")

    job = jobs.get(req.job_id)
    if job and 'result' in job and req.clip_index < len(job['result'].get('clips', [])):
        job['result']['clips'][req.clip_index]['video_url'] = new_video_url
        _persist_result(req.job_id)  # keep the on-disk snapshot in sync with edits

    return {"success": True, "new_video_url": new_video_url}

@app.post("/api/clips/{job_id}/{clip_index}/audio")
async def upload_clip_audio(job_id: str, clip_index: int, file: UploadFile = File(...)):
    """Store an uploaded music track in the job dir for the editor (E6)."""
    if not all(c.isalnum() or c in "-_" for c in job_id):
        raise HTTPException(status_code=400, detail="Invalid job ID")
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    if not os.path.isdir(output_dir):
        raise HTTPException(status_code=404, detail="Job not found")
    ext = os.path.splitext(file.filename or "")[1].lower() or ".mp3"
    if ext not in (".mp3", ".m4a", ".wav", ".ogg", ".aac"):
        raise HTTPException(status_code=400, detail="Unsupported audio format")
    filename = f"clip_{clip_index}_music{ext}"
    dest = os.path.join(output_dir, filename)
    with open(dest, "wb") as out:
        out.write(await file.read())
    return {"url": _video_url(job_id, filename)}

# Generic asset upload (B4): the editor's Audio and B-Roll panels post their own
# uploaded sound effects, images, and video clips here. Extension -> kind is the
# authority; the filename is NEVER used on disk (we mint our own), so a crafted
# "../" name can't escape the job dir. Both extension AND content-type are
# validated as a trust boundary.
_ASSET_KIND_BY_EXT = {
    ".mp3": "audio", ".m4a": "audio", ".wav": "audio", ".aac": "audio", ".ogg": "audio",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    ".mp4": "video", ".mov": "video", ".webm": "video",
}
_ASSET_CT_PREFIX = {"audio": "audio/", "image": "image/", "video": "video/"}
# curl and some browsers send a generic/empty content-type; accept those, but
# still reject a positively-wrong major type (e.g. a .mp3 sent as video/mp4).
_ASSET_CT_GENERIC = {"", "application/octet-stream", "binary/octet-stream"}
_ASSET_MAX_BYTES = 200 * 1024 * 1024  # 200 MB

@app.post("/api/clips/{job_id}/{clip_index}/asset")
async def upload_clip_asset(job_id: str, clip_index: int, file: UploadFile = File(...)):
    """Store an uploaded b-roll/SFX asset (audio | image | video) in the job dir."""
    if not all(c.isalnum() or c in "-_" for c in job_id):
        raise HTTPException(status_code=400, detail="Invalid job ID")
    output_dir = os.path.join(OUTPUT_DIR, job_id)
    if not os.path.isdir(output_dir):
        raise HTTPException(status_code=404, detail="Job not found")
    ext = os.path.splitext(file.filename or "")[1].lower()
    kind = _ASSET_KIND_BY_EXT.get(ext)
    if kind is None:
        raise HTTPException(status_code=415, detail="Unsupported asset type")
    ct = (file.content_type or "").lower().split(";")[0].strip()
    if ct not in _ASSET_CT_GENERIC and not ct.startswith(_ASSET_CT_PREFIX[kind]):
        raise HTTPException(status_code=415, detail="Content type does not match file extension")
    filename = f"clip_{clip_index}_asset_{uuid.uuid4().hex[:8]}{ext}"
    dest = os.path.join(output_dir, filename)
    # Stream to disk in chunks, enforcing the cap as we go — reading the whole
    # body first would let an oversized upload exhaust memory before the check.
    written = 0
    try:
        with open(dest, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > _ASSET_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="Asset exceeds the 200MB limit")
                out.write(chunk)
    except HTTPException:
        if os.path.exists(dest):
            os.remove(dest)  # don't leave a truncated asset behind
        raise
    except Exception:
        # Disk full, disconnect, etc. — never leave a half-written asset.
        if os.path.exists(dest):
            os.remove(dest)
        raise
    return {"url": _video_url(job_id, filename), "kind": kind}

class HookRequest(BaseModel):
    job_id: str
    clip_index: int
    text: str
    input_filename: Optional[str] = None
    position: Optional[str] = "top" # top, center, bottom
    size: Optional[str] = "M" # S, M, L

@app.post("/api/hook")
async def add_hook(req: HookRequest):
    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = jobs[req.job_id]
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))
    
    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")
        
    with open(json_files[0], 'r') as f:
        data = json.load(f)
        
    clips = data.get('shorts', [])
    if req.clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="Clip not found")
        
    clip_data = clips[req.clip_index]
    
    # Video Path
    if req.input_filename:
        filename = os.path.basename(unquote(req.input_filename))
    else:
        filename = unquote(clip_data.get('video_url', '').split('/')[-1])
        if not filename:
             base_name = os.path.basename(json_files[0]).replace('_metadata.json', '')
             filename = f"{base_name}_clip_{req.clip_index+1}.mp4"
         
    input_path = os.path.join(output_dir, filename)
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")
        
    # Output video
    output_filename = f"hook_{filename}"
    output_path = os.path.join(output_dir, output_filename)
    
    # Map Size to Scale
    size_map = {"S": 0.8, "M": 1.0, "L": 1.3}
    font_scale = size_map.get(req.size, 1.0)
    
    try:
        # Run in thread pool
        def run_hook():
             add_hook_to_video(input_path, req.text, output_path, position=req.position, font_scale=font_scale)
        
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, run_hook)
        
    except Exception as e:
        print(f"❌ Hook Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
        
    # Update Persistence (Same logic as subtitles)
    # Update InMemory Jobs
    if req.clip_index < len(job['result']['clips']):
         job['result']['clips'][req.clip_index]['video_url'] = _video_url(req.job_id, output_filename)
         _persist_result(req.job_id)  # keep the on-disk snapshot in sync with edits

    # Update Metadata on Disk
    try:
        if req.clip_index < len(clips):
            clips[req.clip_index]['video_url'] = _video_url(req.job_id, output_filename)
            data['shorts'] = clips
            with open(json_files[0], 'w') as f:
                json.dump(data, f, indent=4)
                print(f"✅ Metadata updated with hook video for clip {req.clip_index}")
    except Exception as e:
        print(f"⚠️ Failed to update metadata.json: {e}")

    return {
        "success": True,
        "new_video_url": _video_url(req.job_id, output_filename)
    }

class TranslateRequest(BaseModel):
    job_id: str
    clip_index: int
    target_language: str
    source_language: Optional[str] = None
    input_filename: Optional[str] = None

@app.get("/api/translate/languages")
async def get_languages():
    """Return supported languages for translation."""
    from translate import get_supported_languages
    return {"languages": get_supported_languages()}

@app.post("/api/translate")
async def translate_clip(
    req: TranslateRequest,
    x_elevenlabs_key: Optional[str] = Header(None, alias="X-ElevenLabs-Key")
):
    """Translate a video clip to a different language using ElevenLabs dubbing."""
    if not x_elevenlabs_key:
        raise HTTPException(status_code=400, detail="Missing X-ElevenLabs-Key header")

    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[req.job_id]
    output_dir = os.path.join(OUTPUT_DIR, req.job_id)
    json_files = glob.glob(os.path.join(output_dir, "*_metadata.json"))

    if not json_files:
        raise HTTPException(status_code=404, detail="Metadata not found")

    with open(json_files[0], 'r') as f:
        data = json.load(f)

    clips = data.get('shorts', [])
    if req.clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="Clip not found")

    clip_data = clips[req.clip_index]

    # Video Path
    if req.input_filename:
        filename = os.path.basename(unquote(req.input_filename))
    else:
        filename = unquote(clip_data.get('video_url', '').split('/')[-1])
        if not filename:
             base_name = os.path.basename(json_files[0]).replace('_metadata.json', '')
             filename = f"{base_name}_clip_{req.clip_index+1}.mp4"

    input_path = os.path.join(output_dir, filename)
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail=f"Video file not found: {input_path}")

    # Output video with language suffix
    base, ext = os.path.splitext(filename)
    output_filename = f"translated_{req.target_language}_{base}{ext}"
    output_path = os.path.join(output_dir, output_filename)

    try:
        from translate import translate_video

        # Run translation in thread pool (blocking API calls)
        def run_translate():
            return translate_video(
                video_path=input_path,
                output_path=output_path,
                target_language=req.target_language,
                api_key=x_elevenlabs_key,
                source_language=req.source_language,
            )

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, run_translate)

    except Exception as e:
        print(f"❌ Translation Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    # Update InMemory Jobs
    if req.clip_index < len(job['result']['clips']):
         job['result']['clips'][req.clip_index]['video_url'] = _video_url(req.job_id, output_filename)

    # Update Metadata on Disk
    try:
        if req.clip_index < len(clips):
            clips[req.clip_index]['video_url'] = _video_url(req.job_id, output_filename)
            data['shorts'] = clips
            with open(json_files[0], 'w') as f:
                json.dump(data, f, indent=4)
                print(f"✅ Metadata updated with translated video for clip {req.clip_index}")
    except Exception as e:
        print(f"⚠️ Failed to update metadata.json: {e}")

    return {
        "success": True,
        "new_video_url": _video_url(req.job_id, output_filename)
    }

import httpx
import ssl

# --- Zernio social integration (https://docs.zernio.com) ---
ZERNIO_API = "https://zernio.com/api/v1"


def _zernio_headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


# Zernio uploads sit in temporary storage that expires 7 days after upload; a post that
# publishes after that references expired media and fails silently. Reject far-future
# schedules/reschedules up front with a clear message.
# ponytail: hard 7-day cap. Lift it only by uploading permanent media closer to publish time.
def _reject_if_beyond_media_window(scheduled_date: Optional[str]):
    if not scheduled_date:
        return
    try:
        when = datetime.fromisoformat(scheduled_date.replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"Invalid scheduled date: {scheduled_date}")
    # Compare naively; hours of timezone slop don't matter at a 7-day boundary.
    if when - datetime.now() > timedelta(days=7):
        raise HTTPException(
            status_code=400,
            detail="Zernio can only schedule up to 7 days out (uploaded media expires after that). Pick a sooner time.",
        )


async def _zernio_request(method: str, path: str, api_key: str, params: dict = None, json_body: dict = None):
    """Forward a request to Zernio and return its JSON, mapping errors to HTTP errors."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.request(
            method, f"{ZERNIO_API}{path}",
            headers=_zernio_headers(api_key),
            params={k: v for k, v in (params or {}).items() if v is not None},
            json=json_body,
        )
    if resp.status_code >= 400:
        print(f"❌ Zernio {method} {path} -> {resp.status_code}: {resp.text[:500]}")
        raise HTTPException(status_code=resp.status_code, detail=f"Zernio API error: {resp.text}")
    return resp.json() if resp.text else {}


def _zernio_upload_media(api_key: str, file_path: str, content_type: str) -> str:
    """Upload a local file to Zernio storage (presign + PUT), return its public URL.

    Sync on purpose: called from threads (BackgroundTasks) and from run_in_executor.
    """
    filename = os.path.basename(file_path)
    # A long upload over a flaky link dies with transport errors (TLS "bad record mac",
    # reset connections, read timeouts). Those are retryable; HTTP errors are not.
    # ponytail: 3 fixed-delay tries. Add backoff/resumable uploads only if this still fails.
    size_mb = os.path.getsize(file_path) / 1024 / 1024
    last_err = last_stage = None
    for attempt in range(3):
        stage = "presign"
        try:
            with httpx.Client(timeout=600.0) as client:
                presign = client.post(
                    f"{ZERNIO_API}/media/presign",
                    headers=_zernio_headers(api_key),
                    json={"filename": filename, "contentType": content_type},
                )
                if presign.status_code >= 400:
                    raise HTTPException(status_code=presign.status_code, detail=f"Zernio presign failed: {presign.text}")
                info = presign.json()
                stage = f"upload of {size_mb:.0f}MB to {urlparse(info['uploadUrl']).hostname}"
                with open(file_path, "rb") as f:
                    put = client.put(info["uploadUrl"], content=f, headers={"Content-Type": content_type})  # stream, don't buffer 2GB
                if put.status_code >= 400:
                    raise HTTPException(status_code=put.status_code, detail=f"Zernio media upload failed: {put.text}")
            return info["publicUrl"]
        except (httpx.TransportError, ssl.SSLError) as e:
            last_err, last_stage = e, stage
            print(f"⚠️  Zernio {stage} failed on attempt {attempt + 1}/3 — {type(e).__name__}: {e}")
            time.sleep(2)
    raise HTTPException(
        status_code=502,
        detail=f"Couldn't reach Zernio — {last_stage} failed 3 times ({type(last_err).__name__}: {last_err}). "
               "This is a network problem between you and Zernio, not your API key.",
    )


class SocialAccountTarget(BaseModel):
    accountId: str
    platform: str


class SocialPostRequest(BaseModel):
    job_id: str
    clip_index: int
    api_key: str
    accounts: List[SocialAccountTarget]
    # Optional overrides if frontend wants to edit them
    title: Optional[str] = None
    description: Optional[str] = None
    scheduled_date: Optional[str] = None # ISO-8601 string
    timezone: Optional[str] = "UTC"


@app.post("/api/social/post")
async def post_to_socials(req: SocialPostRequest):
    """Publish or schedule a rendered clip to social accounts via Zernio."""
    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[req.job_id]
    if 'result' not in job or 'clips' not in job['result']:
        raise HTTPException(status_code=400, detail="Job result not available")
    if not req.accounts:
        raise HTTPException(status_code=400, detail="No social accounts selected")

    # Reject far-future schedules before the (potentially large) upload.
    _reject_if_beyond_media_window(req.scheduled_date)

    # Pinterest needs a board id per post, which we don't collect yet — reject clearly
    # so a defaulted-on Pinterest account can't silently fail the whole post.
    # ponytail: drop this guard once the modals collect a board per Pinterest account.
    if any(acc.platform == "pinterest" for acc in req.accounts):
        raise HTTPException(
            status_code=400,
            detail="Pinterest posting isn't supported yet (it needs a board). Deselect the Pinterest account and try again.",
        )

    try:
        clip = job['result']['clips'][req.clip_index]
        # clip['video_url'] is "/videos/{job_id}/{filename}"; file lives in OUTPUT_DIR
        filename = unquote(clip['video_url'].split('/')[-1])
        file_path = os.path.join(OUTPUT_DIR, req.job_id, filename)

        if not os.path.exists(file_path):
             raise HTTPException(status_code=404, detail=f"Video file not found: {file_path}")

        final_title = req.title or clip.get('title') or clip.get('video_title_for_youtube_short') or 'Viral Short'
        final_description = req.description or clip.get('video_description_for_instagram') or clip.get('video_description_for_tiktok') or "Check this out!"

        loop = asyncio.get_running_loop()
        media_url = await loop.run_in_executor(
            None, _zernio_upload_media, req.api_key, file_path, "video/mp4"
        )

        platforms = []
        for acc in req.accounts:
            entry = {"platform": acc.platform, "accountId": acc.accountId}
            if acc.platform == "youtube":
                entry["platformSpecificData"] = {"title": final_title, "visibility": "public"}
            platforms.append(entry)

        post_payload = {
            "title": final_title,
            "content": final_description,
            "platforms": platforms,
            "mediaItems": [{"type": "video", "url": media_url}],
        }
        if req.scheduled_date:
            post_payload["scheduledFor"] = req.scheduled_date
            post_payload["timezone"] = req.timezone or "UTC"
        else:
            post_payload["publishNow"] = True

        print(f"📡 Sending to Zernio for {[a.platform for a in req.accounts]} (scheduled: {bool(req.scheduled_date)})")
        return await _zernio_request("POST", "/posts", req.api_key, json_body=post_payload)

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Social Post Exception: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/social/accounts")
async def get_social_accounts(api_key: str = Header(..., alias="X-Zernio-Key")):
    """List social accounts connected to the user's Zernio workspace."""
    data = await _zernio_request("GET", "/accounts", api_key)
    raw = data.get("accounts", data) if isinstance(data, dict) else data
    accounts = []
    for a in raw if isinstance(raw, list) else []:
        accounts.append({
            "id": a.get("_id"),
            "platform": a.get("platform"),
            "username": a.get("username"),
            "displayName": a.get("displayName") or a.get("username"),
            "profileUrl": a.get("profileUrl"),
            "isActive": a.get("isActive", True),
        })
    return {"accounts": accounts}


@app.get("/api/social/connect/{platform}")
async def get_social_connect_url(platform: str, api_key: str = Header(..., alias="X-Zernio-Key")):
    """Get the OAuth URL to connect a social account of the given platform."""
    # Zernio groups accounts under profiles; use the default (first) profile.
    # A brand-new key has none, so create one on demand rather than dead-ending the connect flow.
    profiles = await _zernio_request("GET", "/profiles", api_key)
    raw = profiles.get("profiles", profiles) if isinstance(profiles, dict) else profiles
    if not isinstance(raw, list) or not raw:
        created = await _zernio_request("POST", "/profiles", api_key, json_body={"name": "OpenShorts"})
        default = created.get("profile", created) if isinstance(created, dict) else created
    else:
        default = next((p for p in raw if p.get("isDefault")), raw[0])
    data = await _zernio_request("GET", f"/connect/{platform}", api_key, params={"profileId": default.get("_id")})
    return {"authUrl": data.get("authUrl")}


@app.get("/api/social/posts")
async def list_social_posts(
    api_key: str = Header(..., alias="X-Zernio-Key"),
    status: Optional[str] = None,
    dateFrom: Optional[str] = None,
    dateTo: Optional[str] = None,
    page: int = 1,
    limit: int = 100,
):
    """List posts (scheduled/published/failed) for the calendar view."""
    return await _zernio_request("GET", "/posts", api_key, params={
        "status": status, "dateFrom": dateFrom, "dateTo": dateTo, "page": page, "limit": limit,
    })


@app.put("/api/social/posts/{post_id}")
async def update_social_post(post_id: str, body: dict, api_key: str = Header(..., alias="X-Zernio-Key")):
    """Update a scheduled post (e.g. reschedule: {scheduledFor, timezone})."""
    # Same media-expiry ceiling as posting — a reschedule past the window would fail at publish.
    _reject_if_beyond_media_window(body.get("scheduledFor"))
    return await _zernio_request("PUT", f"/posts/{post_id}", api_key, json_body=body)


@app.delete("/api/social/posts/{post_id}")
async def delete_social_post(post_id: str, api_key: str = Header(..., alias="X-Zernio-Key")):
    """Delete a scheduled post."""
    return await _zernio_request("DELETE", f"/posts/{post_id}", api_key)


@app.get("/api/social/analytics")
async def get_social_analytics(
    api_key: str = Header(..., alias="X-Zernio-Key"),
    accountId: Optional[str] = None,
    platform: Optional[str] = None,
    postId: Optional[str] = None,
    fromDate: Optional[str] = None,
    toDate: Optional[str] = None,
    sortBy: Optional[str] = None,
    page: int = 1,
    limit: int = 50,
):
    """Per-post + overview analytics from Zernio (filterable by account/platform)."""
    return await _zernio_request("GET", "/analytics", api_key, params={
        "accountId": accountId, "platform": platform, "postId": postId,
        "fromDate": fromDate, "toDate": toDate, "sortBy": sortBy, "page": page, "limit": limit,
    })

# --- Thumbnail Studio Endpoints ---

@app.post("/api/thumbnail/upload")
async def thumbnail_upload(
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
):
    """Upload video and start background Whisper transcription immediately."""
    if not url and not file:
        raise HTTPException(status_code=400, detail="Must provide URL or File")

    session_id = str(uuid.uuid4())
    transcript_event = asyncio.Event()

    # Save file if uploaded directly
    video_path = None
    if file:
        video_path = os.path.join(UPLOAD_DIR, f"thumb_{session_id}_{file.filename}")
        with open(video_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)

    # Initialize session
    thumbnail_sessions[session_id] = {
        "video_path": video_path,
        "transcript_event": transcript_event,
        "transcript_ready": False,
        "transcript": None,
        "transcript_segments": [],
        "video_duration": 0,
        "language": "en",
        "context": "",
        "titles": [],
        "conversation": [],
        "_url": url,  # Store URL for deferred download
    }

    async def run_background_whisper():
        try:
            vpath = video_path
            # Download YouTube video if URL was provided
            if not vpath and url:
                from main import download_youtube_video
                loop = asyncio.get_event_loop()
                vpath, _ = await loop.run_in_executor(None, download_youtube_video, url, UPLOAD_DIR)
                thumbnail_sessions[session_id]["video_path"] = vpath

            from main import transcribe_video
            loop = asyncio.get_event_loop()
            transcript = await loop.run_in_executor(None, transcribe_video, vpath)
            segments = transcript.get("segments", [])
            duration = segments[-1]["end"] if segments else 0

            thumbnail_sessions[session_id].update({
                "transcript_ready": True,
                "transcript": transcript,
                "transcript_segments": segments,
                "video_duration": duration,
                "language": transcript.get("language", "en"),
            })
            print(f"✅ [Thumbnail] Background Whisper complete for session {session_id}")
        except Exception as e:
            print(f"❌ [Thumbnail] Background Whisper failed: {e}")
            thumbnail_sessions[session_id]["transcript_error"] = str(e)
        finally:
            transcript_event.set()

    asyncio.create_task(run_background_whisper())

    return {"session_id": session_id}


@app.post("/api/thumbnail/analyze")
async def thumbnail_analyze(
    request: Request,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    session_id: Optional[str] = Form(None),
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Analyze a video and suggest viral YouTube titles."""
    api_key = x_gemini_key
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    pre_transcript = None

    # Check for pre-existing session with background Whisper
    if session_id and session_id in thumbnail_sessions:
        session = thumbnail_sessions[session_id]

        # Wait for background Whisper to complete
        transcript_event = session.get("transcript_event")
        if transcript_event:
            print(f"⏳ [Thumbnail] Waiting for background Whisper to finish...")
            await transcript_event.wait()

        if session.get("transcript_error"):
            raise HTTPException(status_code=500, detail=f"Transcription failed: {session['transcript_error']}")

        video_path = session["video_path"]
        if not video_path or not os.path.exists(video_path):
            raise HTTPException(status_code=404, detail="Video file not found in session")

        if session.get("transcript_ready"):
            pre_transcript = session["transcript"]
    else:
        # No pre-existing session — need file or URL
        if not url and not file:
            raise HTTPException(status_code=400, detail="Must provide URL, File, or session_id")

        session_id = str(uuid.uuid4())

        if url:
            from main import download_youtube_video
            video_path, _ = download_youtube_video(url, UPLOAD_DIR)
        else:
            video_path = os.path.join(UPLOAD_DIR, f"thumb_{session_id}_{file.filename}")
            with open(video_path, "wb") as buffer:
                content = await file.read()
                buffer.write(content)

    try:
        from thumbnail import analyze_video_for_titles

        # Run analysis in thread pool (skips Whisper if pre_transcript is available)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, analyze_video_for_titles, api_key, video_path, pre_transcript)

        # Store/update session context
        if session_id not in thumbnail_sessions:
            thumbnail_sessions[session_id] = {}

        thumbnail_sessions[session_id].update({
            "context": result.get("transcript_summary", ""),
            "titles": result.get("titles", []),
            "language": result.get("language", "en"),
            "conversation": thumbnail_sessions[session_id].get("conversation", []),
            "video_path": video_path,
            "transcript_segments": result.get("segments", []),
            "video_duration": result.get("video_duration", 0)
        })

        return {
            "session_id": session_id,
            "titles": result.get("titles", []),
            "context": result.get("transcript_summary", ""),
            "language": result.get("language", "en"),
            "recommended": result.get("recommended", [])
        }

    except Exception as e:
        print(f"❌ Thumbnail Analyze Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class ThumbnailTitlesRequest(BaseModel):
    session_id: Optional[str] = None
    message: Optional[str] = None
    title: Optional[str] = None

@app.post("/api/thumbnail/titles")
async def thumbnail_titles(
    req: ThumbnailTitlesRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Refine title suggestions or accept a manual title."""
    api_key = x_gemini_key
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    # Manual title mode - just create a session with the user's title
    if req.title:
        session_id = req.session_id or str(uuid.uuid4())
        if session_id not in thumbnail_sessions:
            thumbnail_sessions[session_id] = {
                "context": "",
                "titles": [req.title],
                "language": "en",
                "conversation": []
            }
        return {"session_id": session_id, "titles": [req.title]}

    # Refinement mode
    if not req.session_id or req.session_id not in thumbnail_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    if not req.message:
        raise HTTPException(status_code=400, detail="Must provide message or title")

    session = thumbnail_sessions[req.session_id]

    # Add user message to conversation history
    session["conversation"].append({"role": "user", "content": req.message})

    try:
        from thumbnail import refine_titles

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            refine_titles,
            api_key,
            session["context"],
            req.message,
            session["conversation"]
        )

        new_titles = result.get("titles", [])
        session["titles"] = new_titles
        session["conversation"].append({"role": "assistant", "content": json.dumps(new_titles)})

        return {"titles": new_titles}

    except Exception as e:
        print(f"❌ Thumbnail Titles Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/thumbnail/generate")
async def thumbnail_generate(
    request: Request,
    session_id: str = Form(...),
    title: str = Form(...),
    extra_prompt: str = Form(""),
    count: int = Form(3),
    face: Optional[UploadFile] = File(None),
    background: Optional[UploadFile] = File(None),
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Generate YouTube thumbnails with Gemini image generation."""
    api_key = x_gemini_key
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    # Clamp count
    count = min(max(1, count), 6)

    # Save optional uploaded images
    face_path = None
    bg_path = None
    thumb_upload_dir = os.path.join(UPLOAD_DIR, f"thumb_{session_id}")
    os.makedirs(thumb_upload_dir, exist_ok=True)

    try:
        from thumbnail import generate_thumbnail

        if face and face.filename:
            face_path = os.path.join(thumb_upload_dir, f"face_{face.filename}")
            with open(face_path, "wb") as f:
                f.write(await face.read())

        if background and background.filename:
            bg_path = os.path.join(thumb_upload_dir, f"bg_{background.filename}")
            with open(bg_path, "wb") as f:
                f.write(await background.read())

        # Get video context from session (transcript summary from analysis step)
        video_context = ""
        if session_id in thumbnail_sessions:
            video_context = thumbnail_sessions[session_id].get("context", "")

        # Run generation in thread pool
        loop = asyncio.get_event_loop()
        thumbnails = await loop.run_in_executor(
            None,
            generate_thumbnail,
            api_key,
            title,
            session_id,
            face_path,
            bg_path,
            extra_prompt,
            count,
            video_context,
            OUTPUT_DIR
        )

        if not thumbnails:
            raise HTTPException(status_code=500, detail="Thumbnail generation failed. Please check your Gemini API key has access to image generation (gemini-3.1-flash-image-preview model).")

        return {"thumbnails": thumbnails}

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Thumbnail Generate Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class ThumbnailDescribeRequest(BaseModel):
    session_id: str
    title: str

@app.post("/api/thumbnail/describe")
async def thumbnail_describe(
    req: ThumbnailDescribeRequest,
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key")
):
    """Generate a YouTube description with chapters from the transcript."""
    api_key = x_gemini_key
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing X-Gemini-Key header")

    if req.session_id not in thumbnail_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = thumbnail_sessions[req.session_id]
    segments = session.get("transcript_segments", [])
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript segments available. Please analyze a video first.")

    try:
        from thumbnail import generate_youtube_description

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            generate_youtube_description,
            api_key,
            req.title,
            segments,
            session.get("language", "en"),
            session.get("video_duration", 0)
        )
        return {"description": result.get("description", "")}

    except Exception as e:
        print(f"❌ Thumbnail Describe Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/thumbnail/publish")
async def thumbnail_publish(
    background_tasks: BackgroundTasks,
    session_id: str = Form(...),
    title: str = Form(...),
    description: str = Form(...),
    thumbnail_url: str = Form(...),
    api_key: str = Form(...),
    account_id: str = Form(...),
):
    """Kick off a background upload to YouTube via Zernio and return immediately."""
    if session_id not in thumbnail_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = thumbnail_sessions[session_id]
    video_path = session.get("video_path")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Original video file not found")

    # Resolve thumbnail path from URL
    thumb_relative = thumbnail_url.lstrip("/")
    if thumb_relative.startswith("thumbnails/"):
        thumb_path = os.path.join(OUTPUT_DIR, thumb_relative)
    else:
        thumb_path = os.path.join(THUMBNAILS_DIR, thumb_relative)

    if not os.path.exists(thumb_path):
        raise HTTPException(status_code=404, detail=f"Thumbnail file not found: {thumb_path}")

    # Generate a unique ID for this publish job so the frontend can poll
    publish_id = str(uuid.uuid4())
    publish_jobs[publish_id] = {"status": "uploading", "result": None, "error": None}

    def do_upload():
        """Runs in a thread via BackgroundTasks — uploads media to Zernio, then creates the post."""
        try:
            print(f"📡 [Thumbnail] Publishing to YouTube via Zernio... (publish_id={publish_id})")
            video_url = _zernio_upload_media(api_key, video_path, "video/mp4")
            thumb_public_url = _zernio_upload_media(api_key, thumb_path, "image/jpeg")

            post_payload = {
                "title": title,
                "content": description,
                "mediaItems": [{"type": "video", "url": video_url, "thumbnail": thumb_public_url}],
                "platforms": [{
                    "platform": "youtube",
                    "accountId": account_id,
                    "platformSpecificData": {"title": title, "visibility": "public"},
                }],
                "publishNow": True,
            }
            with httpx.Client(timeout=600.0) as client:
                response = client.post(f"{ZERNIO_API}/posts", headers=_zernio_headers(api_key), json=post_payload)

            if response.status_code >= 400:
                err = f"Zernio API Error ({response.status_code}): {response.text}"
                print(f"❌ {err}")
                publish_jobs[publish_id]["status"] = "failed"
                publish_jobs[publish_id]["error"] = err
            else:
                print(f"✅ [Thumbnail] Published successfully (publish_id={publish_id})")
                publish_jobs[publish_id]["status"] = "done"
                publish_jobs[publish_id]["result"] = response.json()

        except Exception as e:
            err = str(e)
            print(f"❌ Thumbnail Publish Background Error: {err}")
            publish_jobs[publish_id]["status"] = "failed"
            publish_jobs[publish_id]["error"] = err

    background_tasks.add_task(do_upload)
    return {"publish_id": publish_id, "status": "uploading"}


@app.get("/api/thumbnail/publish/status/{publish_id}")
async def thumbnail_publish_status(publish_id: str):
    """Poll the status of a background publish job."""
    if publish_id not in publish_jobs:
        raise HTTPException(status_code=404, detail="Publish job not found")
    return publish_jobs[publish_id]


# Serve the built dashboard (must be registered last — Starlette matches routes
# in registration order, and a "/" mount would shadow every @app.get route
# defined above it). Hash-based routing (#app, #trailer) means index.html at
# "/" is sufficient; no catch-all fallback route is needed.
_DASHBOARD_DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard", "dist")
if os.path.isdir(_DASHBOARD_DIST):
    app.mount("/", StaticFiles(directory=_DASHBOARD_DIST, html=True), name="dashboard")
else:
    print("🚀 No dashboard/dist found — skipping static UI mount (run `npm run build` in dashboard/ to enable it).")

