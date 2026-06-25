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
from dotenv import load_dotenv
from typing import Dict, Optional, List
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from s3_uploader import upload_job_artifacts
from transcription import WHISPER_MODELS

load_dotenv()

# Constants
UPLOAD_DIR = "uploads"
OUTPUT_DIR = "output"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Configuration
# Default to 1 if not set, but user can set higher for powerful servers
MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "5"))
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

def _attach_editor_urls(clip: dict, job_id: str, output_dir: str, base_name: str, clip_number: int) -> None:
    """
    Attach source_url + framing_url to a clip dict when the non-destructive
    editor artifacts exist on disk (new jobs). Old jobs simply don't get the
    keys, and the frontend hides the Edit button.
    """
    source_filename = f"{base_name}_clip_{clip_number}_source.mp4"
    framing_filename = f"{base_name}_clip_{clip_number}.framing.json"
    if os.path.exists(os.path.join(output_dir, source_filename)):
        clip['source_url'] = f"/videos/{job_id}/{source_filename}"
    if os.path.exists(os.path.join(output_dir, framing_filename)):
        clip['framing_url'] = f"/videos/{job_id}/{framing_filename}"

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
                                 clip['video_url'] = f"/videos/{job_id}/{clip_filename}"
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
                     clip['video_url'] = f"/videos/{job_id}/{clip_filename}"
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
        "result": job.get('result'),
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
            safe_name = os.path.basename(req.input_filename)
            input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_name)
            filename = safe_name
        else:
            # Fallback to original clip
            clip = job['result']['clips'][req.clip_index]
            filename = clip['video_url'].split('/')[-1]
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
        
        new_video_url = f"/videos/{req.job_id}/{edited_filename}"
        
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

    duration_sec = clip_end - clip_start

    return {
        "captions": captions,
        "durationSec": duration_sec,
        "language": transcript.get('language', 'en'),
    }


# --- Remotion Render Proxy ---
RENDER_SERVICE_URL = os.getenv("RENDER_SERVICE_URL", "http://renderer:3100")

@app.post("/api/render")
async def proxy_render(request: Request):
    """Proxy render requests to the Node.js Remotion render service."""
    import httpx
    body = await request.json()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{RENDER_SERVICE_URL}/render", json=body)
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Render service unavailable: {e}")

@app.get("/api/render/{render_id}")
async def proxy_render_status(render_id: str):
    """Proxy render status polling to the Node.js Remotion render service."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{RENDER_SERVICE_URL}/render/{render_id}")
            return resp.json()
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
            safe_name = os.path.basename(req.input_filename)
            input_path = os.path.join(OUTPUT_DIR, req.job_id, safe_name)
        else:
            clip = job['result']['clips'][req.clip_index]
            filename = clip['video_url'].split('/')[-1]
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
        filename = os.path.basename(req.input_filename)
    else:
        # Fallback to standard naming
        filename = clip_data.get('video_url', '').split('/')[-1]
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
         job['result']['clips'][req.clip_index]['video_url'] = f"/videos/{req.job_id}/{output_filename}"
         _persist_result(req.job_id)  # keep the on-disk snapshot in sync with edits

    # Update Metadata on Disk (Persistence)
    try:
        if req.clip_index < len(clips):
            clips[req.clip_index]['video_url'] = f"/videos/{req.job_id}/{output_filename}"
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
        "new_video_url": f"/videos/{req.job_id}/{output_filename}"
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

    new_video_url = f"/videos/{req.job_id}/{filename}"

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
    return {"url": f"/videos/{job_id}/{filename}"}

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
        filename = os.path.basename(req.input_filename)
    else:
        filename = clip_data.get('video_url', '').split('/')[-1]
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
         job['result']['clips'][req.clip_index]['video_url'] = f"/videos/{req.job_id}/{output_filename}"
         _persist_result(req.job_id)  # keep the on-disk snapshot in sync with edits

    # Update Metadata on Disk
    try:
        if req.clip_index < len(clips):
            clips[req.clip_index]['video_url'] = f"/videos/{req.job_id}/{output_filename}"
            data['shorts'] = clips
            with open(json_files[0], 'w') as f:
                json.dump(data, f, indent=4)
                print(f"✅ Metadata updated with hook video for clip {req.clip_index}")
    except Exception as e:
        print(f"⚠️ Failed to update metadata.json: {e}")

    return {
        "success": True,
        "new_video_url": f"/videos/{req.job_id}/{output_filename}"
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
        filename = os.path.basename(req.input_filename)
    else:
        filename = clip_data.get('video_url', '').split('/')[-1]
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
         job['result']['clips'][req.clip_index]['video_url'] = f"/videos/{req.job_id}/{output_filename}"

    # Update Metadata on Disk
    try:
        if req.clip_index < len(clips):
            clips[req.clip_index]['video_url'] = f"/videos/{req.job_id}/{output_filename}"
            data['shorts'] = clips
            with open(json_files[0], 'w') as f:
                json.dump(data, f, indent=4)
                print(f"✅ Metadata updated with translated video for clip {req.clip_index}")
    except Exception as e:
        print(f"⚠️ Failed to update metadata.json: {e}")

    return {
        "success": True,
        "new_video_url": f"/videos/{req.job_id}/{output_filename}"
    }

class SocialPostRequest(BaseModel):
    job_id: str
    clip_index: int
    api_key: str
    user_id: str
    platforms: List[str] # ["tiktok", "instagram", "youtube"]
    # Optional overrides if frontend wants to edit them
    title: Optional[str] = None
    description: Optional[str] = None
    scheduled_date: Optional[str] = None # ISO-8601 string
    timezone: Optional[str] = "UTC"

import httpx

@app.post("/api/social/post")
async def post_to_socials(req: SocialPostRequest):
    if req.job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job = jobs[req.job_id]
    if 'result' not in job or 'clips' not in job['result']:
        raise HTTPException(status_code=400, detail="Job result not available")
        
    try:
        clip = job['result']['clips'][req.clip_index]
        # Video URL is relative /videos/..., we need absolute file path
        # clip['video_url'] is like "/videos/{job_id}/{filename}"
        # We constructed it as: f"/videos/{job_id}/{clip_filename}"
        # And file is at f"{OUTPUT_DIR}/{job_id}/{clip_filename}"
        
        filename = clip['video_url'].split('/')[-1]
        file_path = os.path.join(OUTPUT_DIR, req.job_id, filename)
        
        if not os.path.exists(file_path):
             raise HTTPException(status_code=404, detail=f"Video file not found: {file_path}")

        # Construct parameters for Upload-Post API
        # Fallbacks
        final_title = req.title or clip.get('title', 'Viral Short')
        final_description = req.description or clip.get('video_description_for_instagram') or clip.get('video_description_for_tiktok') or "Check this out!"
        
        # Prepare form data
        url = "https://api.upload-post.com/api/upload"
        headers = {
            "Authorization": f"Apikey {req.api_key}"
        }
        
        # Prepare data as dict (httpx handles lists for multiple values)
        data_payload = {
            "user": req.user_id,
            "title": final_title,
            "platform[]": req.platforms, # Pass list directly
            "async_upload": "true"  # Enable async upload
        }

        # Add scheduling if present
        if req.scheduled_date:
            data_payload["scheduled_date"] = req.scheduled_date
            if req.timezone:
                data_payload["timezone"] = req.timezone
        
        # Add Platform specifics
        if "tiktok" in req.platforms:
             data_payload["tiktok_title"] = final_description
             
        if "instagram" in req.platforms:
             data_payload["instagram_title"] = final_description
             data_payload["media_type"] = "REELS"

        if "youtube" in req.platforms:
             yt_title = req.title or clip.get('video_title_for_youtube_short', final_title)
             data_payload["youtube_title"] = yt_title
             data_payload["youtube_description"] = final_description
             data_payload["privacyStatus"] = "public"

        # Send File
        # httpx AsyncClient requires async file reading or bytes. 
        # Since we have MAX_FILE_SIZE_MB, reading into memory is safe-ish.
        with open(file_path, "rb") as f:
            file_content = f.read()
            
        files = {
            "video": (filename, file_content, "video/mp4")
        }

        # Switch to synchronous Client to avoid "sync request with AsyncClient" error with multipart/files
        with httpx.Client(timeout=120.0) as client:
            print(f"📡 Sending to Upload-Post for platforms: {req.platforms}")
            response = client.post(url, headers=headers, data=data_payload, files=files)
            
        if response.status_code not in [200, 201, 202]: # Added 201
             print(f"❌ Upload-Post Error: {response.text}")
             raise HTTPException(status_code=response.status_code, detail=f"Vendor API Error: {response.text}")

        return response.json()

    except Exception as e:
        print(f"❌ Social Post Exception: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/social/user")
async def get_social_user(api_key: str = Header(..., alias="X-Upload-Post-Key")):
    """Proxy to fetch user ID from Upload-Post"""
    if not api_key:
         raise HTTPException(status_code=400, detail="Missing X-Upload-Post-Key header")
         
    url = "https://api.upload-post.com/api/uploadposts/users"
    print(f"🔍 Fetching User ID from: {url}")
    headers = {"Authorization": f"Apikey {api_key}"}
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                print(f"❌ Upload-Post User Fetch Error: {resp.text}")
                raise HTTPException(status_code=resp.status_code, detail=f"Failed to fetch user: {resp.text}")
            
            data = resp.json()
            print(f"🔍 Upload-Post User Response: {data}")
            
            user_id = None
            # The structure is {'success': True, 'profiles': [{'username': '...'}, ...]}
            profiles_list = []
            if isinstance(data, dict):
                 raw_profiles = data.get('profiles', [])
                 if isinstance(raw_profiles, list):
                     for p in raw_profiles:
                         username = p.get('username')
                         if username:
                             # Determine connected platforms
                             socials = p.get('social_accounts', {})
                             connected = []
                             # Check typical platforms
                             for platform in ['tiktok', 'instagram', 'youtube']:
                                 account_info = socials.get(platform)
                                 # If it's a dict and typically has data, or just not empty string
                                 if isinstance(account_info, dict):
                                     connected.append(platform)
                             
                             profiles_list.append({
                                 "username": username,
                                 "connected": connected
                             })
            
            if not profiles_list:
                # Fallback if no profiles found
                return {"profiles": [], "error": "No profiles found"}
                
            return {"profiles": profiles_list}
            
            
        except Exception as e:
             raise HTTPException(status_code=500, detail=str(e))

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
            video_context
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
    user_id: str = Form(...),
):
    """Kick off a background upload to YouTube via Upload-Post and return immediately."""
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
        """Runs in a thread via BackgroundTasks — does the actual multipart upload."""
        try:
            upload_url = "https://api.upload-post.com/api/upload"
            headers = {"Authorization": f"Apikey {api_key}"}
            data_payload = {
                "user": user_id,
                "platform[]": ["youtube"],
                "title": title,          # required base field (fallback)
                "async_upload": "true",
                "youtube_title": title,
                "youtube_description": description,
                "privacyStatus": "public",
            }
            video_filename = os.path.basename(video_path)
            thumb_filename = os.path.basename(thumb_path)

            print(f"📡 [Thumbnail] Publishing to YouTube via Upload-Post... (publish_id={publish_id})")
            with open(video_path, "rb") as vf, open(thumb_path, "rb") as tf:
                files = {
                    "video": (video_filename, vf.read(), "video/mp4"),
                    "thumbnail": (thumb_filename, tf.read(), "image/jpeg"),
                }

            # Use a long timeout — video uploads can take several minutes
            with httpx.Client(timeout=600.0) as client:
                response = client.post(upload_url, headers=headers, data=data_payload, files=files)

            if response.status_code not in [200, 201, 202]:
                err = f"Upload-Post API Error ({response.status_code}): {response.text}"
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

