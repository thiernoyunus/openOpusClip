"""
MCP Server for OpenOpusClips

Lets any AI agent (Claude Desktop, Codex, etc.) control the video
processing pipeline through the standard Model Context Protocol.

Start the backend first (python app.py or docker compose up), then
run this server:

    python mcp_server.py

Or add to Claude Desktop config (~/.claude/claude_desktop_config.json):

    {
      "mcpServers": {
        "openopusclips": {
          "command": "python",
          "args": ["/path/to/OpenOpusClips/mcp_server.py"]
        }
      }
    }
"""

import os
import json
import httpx
from mcp.server.mcpserver import MCPServer

mcp = MCPServer(
    name="openopusclips",
    description="Control OpenOpusClips: process videos, generate clips, add effects, post to social media.",
)

API = os.environ.get("OPENSHORTS_API", "http://127.0.0.1:8000")


def _url(path: str) -> str:
    return f"{API}{path}"


def _client(**kw):
    """ponytail: default timeout 120s for slow video processing, caller can override."""
    return httpx.Client(timeout=kw.pop("timeout", 120), **kw)


def _json(r):
    """Return pretty JSON if possible, else plain text."""
    try:
        return json.dumps(r.json(), indent=2)
    except Exception:
        return r.text


# ── Core pipeline ──────────────────────────────────────────────────────


def process_video(
    url: str,
    num_clips: int = 5,
    api_key: str = "",
    language: str = "",
    aspect: str = "9:16",
    caption_style: str = "",
    framing: str = "auto",
) -> str:
    """Submit a YouTube URL for processing into short clips."""
    data = {
        "videoUrl": url,
        "numClips": num_clips,
        "aspectRatio": aspect,
        "framingMode": framing,
    }
    headers = {}
    if api_key:
        headers["X-Gemini-Key"] = api_key
    if language:
        data["language"] = language
    if caption_style:
        data["captionStyle"] = caption_style

    with _client(headers=headers) as c:
        r = c.post(_url("/api/process"), json=data)
        return _json(r)


def upload_and_process(
    file_path: str,
    num_clips: int = 5,
    api_key: str = "",
    language: str = "",
) -> str:
    """Upload a local video file and process it into short clips."""
    data = {
        "numClips": num_clips,
    }
    headers = {}
    if api_key:
        headers["X-Gemini-Key"] = api_key
    if language:
        data["language"] = language

    with _client(headers=headers) as c:
        with open(file_path, "rb") as f:
            r = c.post(
                _url("/api/process"),
                data=data,
                files={"file": (os.path.basename(file_path), f)},
            )
            return _json(r)


def check_status(job_id: str) -> str:
    """Check processing progress for a job. Returns phase, percentage, logs."""
    with _client(timeout=10) as c:
        r = c.get(_url(f"/api/status/{job_id}"))
        return _json(r)


def get_results(job_id: str) -> str:
    """Get finished clips for a completed job. Call after check_status shows done."""
    with _client(timeout=10) as c:
        r = c.get(_url(f"/api/status/{job_id}"))
        data = r.json()
        result = data.get("result")
        if not result:
            return f"Job not finished yet. Status: {data.get('status', 'unknown')}"
        return json.dumps(result, indent=2)


def list_jobs() -> str:
    """List all projects with their status and clip counts."""
    with _client(timeout=10) as c:
        r = c.get(_url("/api/status/all"))
        return _json(r)


def delete_job(job_id: str) -> str:
    """Delete a project and its output files."""
    with _client(timeout=10) as c:
        r = c.delete(_url(f"/api/jobs/{job_id}"))
        return _json(r)


def get_transcript(job_id: str) -> str:
    """Get the full transcript for a processed video."""
    with _client(timeout=10) as c:
        r = c.get(_url(f"/api/source-transcript/{job_id}"))
        return _json(r)


def extend_clip(
    job_id: str,
    clip_index: int,
    start_sec: float,
    end_sec: float,
) -> str:
    """Extend a clip to a longer time range. Use get_transcript first for timestamps."""
    with _client(timeout=10) as c:
        r = c.post(
            _url(f"/api/clips/{job_id}/{clip_index}/extend"),
            json={"startSec": start_sec, "endSec": end_sec},
        )
        return _json(r)


# ── AI features ────────────────────────────────────────────────────────


def generate_effects(
    job_id: str,
    clip_index: int,
    prompt: str,
) -> str:
    """Generate AI visual effects for a clip (e.g. 'add a zoom-in with glitch transition')."""
    with _client(timeout=120) as c:
        r = c.post(
            _url("/api/effects/generate"),
            json={
                "jobId": job_id,
                "clipIndex": clip_index,
                "prompt": prompt,
            },
        )
        return _json(r)


def generate_captions(
    job_id: str,
    clip_index: int,
    style: str = "default",
) -> str:
    """Generate styled captions. style: default, karaoke, bold, minimal, neon, glow."""
    with _client(timeout=120) as c:
        r = c.post(
            _url("/api/captions/enhance"),
            json={
                "jobId": job_id,
                "clipIndex": clip_index,
                "style": style,
            },
        )
        return _json(r)


def suggest_broll(job_id: str, clip_index: int) -> str:
    """Suggest B-roll footage ideas for a clip with timecodes and descriptions."""
    with _client(timeout=120) as c:
        r = c.post(
            _url("/api/broll/suggest"),
            json={
                "jobId": job_id,
                "clipIndex": clip_index,
            },
        )
        return _json(r)


def translate_clip(
    job_id: str,
    clip_index: int,
    target_language: str,
    elevenlabs_key: str = "",
) -> str:
    """Translate clip audio to another language via ElevenLabs AI dubbing."""
    headers = {}
    if elevenlabs_key:
        headers["X-ElevenLabs-Key"] = elevenlabs_key
    with _client(timeout=300) as c:
        r = c.post(
            _url("/api/translate"),
            json={
                "jobId": job_id,
                "clipIndex": clip_index,
                "targetLanguage": target_language,
            },
            headers=headers,
        )
        return _json(r)


def get_translate_languages() -> str:
    """List all supported dubbing languages."""
    with _client(timeout=10) as c:
        r = c.get(_url("/api/translate/languages"))
        return _json(r)


# ── Social posting ─────────────────────────────────────────────────────


def social_post(
    job_id: str,
    clip_index: int,
    platform: str,
    caption: str,
    schedule: str = "",
    zernio_key: str = "",
) -> str:
    """Publish or schedule a clip. platform: tiktok, instagram, youtube."""
    headers = {}
    if zernio_key:
        headers["X-Zernio-Key"] = zernio_key
    data = {
        "jobId": job_id,
        "clipIndex": clip_index,
        "platform": platform,
        "caption": caption,
    }
    if schedule:
        data["scheduledAt"] = schedule
    with _client(timeout=30) as c:
        r = c.post(_url("/api/social/post"), json=data, headers=headers)
        return _json(r)


def social_accounts(zernio_key: str = "") -> str:
    """List connected social media accounts."""
    headers = {}
    if zernio_key:
        headers["X-Zernio-Key"] = zernio_key
    with _client(timeout=10) as c:
        r = c.get(_url("/api/social/accounts"), headers=headers)
        return _json(r)


def social_analytics(zernio_key: str = "") -> str:
    """Get analytics for published posts (views, likes, engagement)."""
    headers = {}
    if zernio_key:
        headers["X-Zernio-Key"] = zernio_key
    with _client(timeout=10) as c:
        r = c.get(_url("/api/social/analytics"), headers=headers)
        return _json(r)


# ── Register tools and run ─────────────────────────────────────────────

mcp.add_tool(process_video)
mcp.add_tool(upload_and_process)
mcp.add_tool(check_status)
mcp.add_tool(get_results)
mcp.add_tool(list_jobs)
mcp.add_tool(delete_job)
mcp.add_tool(get_transcript)
mcp.add_tool(extend_clip)
mcp.add_tool(generate_effects)
mcp.add_tool(generate_captions)
mcp.add_tool(suggest_broll)
mcp.add_tool(translate_clip)
mcp.add_tool(get_translate_languages)
mcp.add_tool(social_post)
mcp.add_tool(social_accounts)
mcp.add_tool(social_analytics)

if __name__ == "__main__":
    mcp.run(transport="stdio")
