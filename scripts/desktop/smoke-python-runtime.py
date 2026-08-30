#!/usr/bin/env python3
"""Exercise the Python paths that the packaged desktop app depends on.

Import-only checks miss optional native dependencies that are loaded lazily.
In particular, faster-whisper imports its VAD module without importing
onnxruntime; the real failure only appears when the VAD model is created.
"""

import argparse
import importlib.util
import os
import tempfile


parser = argparse.ArgumentParser()
parser.add_argument(
    "--skip-mediapipe-inference",
    action="store_true",
    help="Import MediaPipe but skip its native inference pass under Rosetta.",
)
args = parser.parse_args()

# app.py creates its writable directories at import time. Keep this check
# isolated from the checkout and from a real user's output directory.
smoke_tmp = tempfile.TemporaryDirectory(prefix="openopusclip-runtime-smoke-")
os.environ["OPENSHORTS_UPLOAD_DIR"] = os.path.join(smoke_tmp.name, "uploads")
os.environ["OPENSHORTS_OUTPUT_DIR"] = os.path.join(smoke_tmp.name, "output")
# A packaged app's Resources directory is read-only after signing. Never let a
# verification run create or rewrite __pycache__ files inside that bundle.
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import numpy as np
import torch
import torchvision
import mediapipe
import faster_whisper
import ctranslate2
import av
import cv2
import yt_dlp
import fastapi
import PIL
import scenedetect
import boto3
import httpx
import keyring
import mcp
from google import genai
from dotenv import load_dotenv
from pydantic import BaseModel
import onnxruntime
from ultralytics import YOLO
from faster_whisper.vad import get_vad_model

# Import every local backend module that the desktop stage copies. This catches
# a missing third-party dependency even when that feature is not part of the
# first request made after launch. mcp_server.py remains a separate developer
# process and is intentionally not part of the desktop bundle.
import app
import editor
import main
import thumbnail
import transcription_worker
import transcription
import ffmpeg_utils
import s3_uploader

# Apple Silicon uses MLX Whisper first and only falls back to Faster-Whisper on
# failure, so check that optional native backend when this stage includes it.
if importlib.util.find_spec("mlx_whisper"):
    import mlx_whisper

# Importing faster_whisper.vad alone does not load onnxruntime. Constructing
# and running the bundled Silero model is the smallest check of the exact path
# used by model.transcribe(..., vad_filter=True).
vad = get_vad_model()
vad(np.zeros(512, dtype=np.float32))

if not args.skip_mediapipe_inference:
    detector = mediapipe.solutions.face_detection.FaceDetection(
        model_selection=1,
        min_detection_confidence=0.5,
    )
    detector.process(np.zeros((480, 640, 3), dtype=np.uint8))
    detector.close()

print("python-runtime-ok")
