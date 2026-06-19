import time
import cv2
import scenedetect
import subprocess
import argparse
import re
import sys
from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector
import torch
import os
import shutil
import tempfile
import numpy as np
from tqdm import tqdm
import yt_dlp
# import whisper (replaced by faster_whisper inside function)
from google import genai
from dotenv import load_dotenv
import json

import warnings
warnings.filterwarnings("ignore", category=UserWarning, module='google.protobuf')

# Load environment variables
load_dotenv()

# --- Constants ---
ASPECT_RATIO = 9 / 16

# Supported output aspect ratios -> (width, height). 1080-class for quality.
ASPECT_PRESETS = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
    "16:9": (1920, 1080),
}

GEMINI_PROMPT_TEMPLATE = """
You are a senior short-form video editor. Read the ENTIRE transcript and word-level timestamps to choose the 3–15 MOST VIRAL moments for TikTok/IG Reels/YouTube Shorts. Each clip must be between {min_len} and {max_len} seconds long.
{user_focus}
⚠️ FFMPEG TIME CONTRACT — STRICT REQUIREMENTS:
- Return timestamps in ABSOLUTE SECONDS from the start of the video (usable in: ffmpeg -ss <start> -to <end> -i <input> ...).
- Only NUMBERS with decimal point, up to 3 decimals (examples: 0, 1.250, 17.350).
- Ensure 0 ≤ start < end ≤ VIDEO_DURATION_SECONDS.
- Each clip between {min_len} and {max_len} s (inclusive).
- Prefer starting 0.2–0.4 s BEFORE the hook and ending 0.2–0.4 s AFTER the payoff.
- Use silence moments for natural cuts; never cut in the middle of a word or phrase.
- STRICTLY FORBIDDEN to use time formats other than absolute seconds.

VIDEO_DURATION_SECONDS: {video_duration}

TRANSCRIPT_TEXT (raw):
{transcript_text}

WORDS_JSON (array of {{w, s, e}} where s/e are seconds):
{words_json}

STRICT EXCLUSIONS:
- No generic intros/outros or purely sponsorship segments unless they contain the hook.
- No clips < {min_len} s or > {max_len} s.

OUTPUT — RETURN ONLY VALID JSON (no markdown, no comments). Order clips by predicted performance (best to worst). In the descriptions, ALWAYS include a CTA like "Follow me and comment X and I'll send you the workflow" (especially if discussing an n8n workflow):
{{
  "shorts": [
    {{
      "start": <number in seconds, e.g., 12.340>,
      "end": <number in seconds, e.g., 37.900>,
      "video_description_for_tiktok": "<description for TikTok oriented to get views>",
      "video_description_for_instagram": "<description for Instagram oriented to get views>",
      "video_title_for_youtube_short": "<title for YouTube Short oriented to get views 100 chars max>",
      "viral_hook_text": "<SHORT punchy text overlay (max 10 words). MUST BE IN THE SAME LANGUAGE AS THE VIDEO TRANSCRIPT. Examples: 'POV: You realized...', 'Did you know?', 'Stop doing this!'>"
    }}
  ]
}}
"""

ENABLE_YOLO_FALLBACK = os.environ.get("ENABLE_YOLO_FALLBACK", "false").lower() in ("1", "true", "yes")
# Stable two-person scenes default to the stacked SPLIT layout (Opus-style)
AUTO_SPLIT_LAYOUT = os.environ.get("AUTO_SPLIT_LAYOUT", "true").lower() in ("1", "true", "yes")
_yolo_model = None
_face_detection = None


def get_face_detection():
    """Initialize MediaPipe only when video framing actually needs it."""
    global _face_detection
    if _face_detection is None:
        import mediapipe as mp
        mp_face_detection = mp.solutions.face_detection
        _face_detection = mp_face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)
    return _face_detection

class SmoothedCameraman:
    """
    Handles smooth camera movement.
    Simplified Logic: "Heavy Tripod"
    Only moves if the subject leaves the center safe zone.
    Moves slowly and linearly.
    """
    def __init__(self, output_width, output_height, video_width, video_height):
        self.output_width = output_width
        self.output_height = output_height
        self.video_width = video_width
        self.video_height = video_height
        
        # Initial State
        self.current_center_x = video_width / 2
        self.target_center_x = video_width / 2
        
        # Calculate crop dimensions once, from the requested output aspect.
        aspect = self.output_width / self.output_height
        self.crop_height = video_height
        self.crop_width = int(self.crop_height * aspect)
        if self.crop_width > video_width:
             self.crop_width = video_width
             self.crop_height = int(self.crop_width / aspect)
             
        # Safe Zone: 20% of the video width
        # As long as the target is within this zone relative to current center, DO NOT MOVE.
        self.safe_zone_radius = self.crop_width * 0.25

    def update_target(self, face_box):
        """
        Updates the target center based on detected face/person.
        """
        if face_box:
            x, y, w, h = face_box
            self.target_center_x = x + w / 2
    
    def get_crop_box(self, force_snap=False):
        """
        Returns the (x1, y1, x2, y2) for the current frame.
        """
        if force_snap:
            self.current_center_x = self.target_center_x
        else:
            diff = self.target_center_x - self.current_center_x
            
            # SIMPLIFIED LOGIC:
            # 1. Is the target outside the safe zone?
            if abs(diff) > self.safe_zone_radius:
                # 2. If yes, move towards it slowly (Linear Speed)
                # Determine direction
                direction = 1 if diff > 0 else -1
                
                # Speed: 2 pixels per frame (Slow pan)
                # If the distance is HUGE (scene change or fast movement), speed up slightly
                if abs(diff) > self.crop_width * 0.5:
                    speed = 15.0 # Fast re-frame
                else:
                    speed = 3.0  # Slow, steady pan
                
                self.current_center_x += direction * speed
                
                # Check if we overshot (prevent oscillation)
                new_diff = self.target_center_x - self.current_center_x
                if (direction == 1 and new_diff < 0) or (direction == -1 and new_diff > 0):
                    self.current_center_x = self.target_center_x
            
            # If inside safe zone, DO NOTHING (Stationary Camera)
                
        # Clamp center
        half_crop = self.crop_width / 2
        
        if self.current_center_x - half_crop < 0:
            self.current_center_x = half_crop
        if self.current_center_x + half_crop > self.video_width:
            self.current_center_x = self.video_width - half_crop
            
        x1 = int(self.current_center_x - half_crop)
        x2 = int(self.current_center_x + half_crop)
        
        x1 = max(0, x1)
        x2 = min(self.video_width, x2)
        
        y1 = 0
        y2 = self.video_height
        
        return x1, y1, x2, y2

class SpeakerTracker:
    """
    Tracks speakers over time to prevent rapid switching and handle temporary obstructions.
    """
    def __init__(self, stabilization_frames=15, cooldown_frames=30):
        self.active_speaker_id = None
        self.speaker_scores = {}  # {id: score}
        self.last_seen = {}       # {id: frame_number}
        self.locked_counter = 0   # How long we've been locked on current speaker
        
        # Hyperparameters
        self.stabilization_threshold = stabilization_frames # Frames needed to confirm a new speaker
        self.switch_cooldown = cooldown_frames              # Minimum frames before switching again
        self.last_switch_frame = -1000
        
        # ID tracking
        self.next_id = 0
        self.known_faces = [] # [{'id': 0, 'center': x, 'last_frame': 123}]

    def get_target(self, face_candidates, frame_number, width):
        """
        Decides which face to focus on.
        face_candidates: list of {'box': [x,y,w,h], 'score': float}
        """
        current_candidates = []
        
        # 1. Match faces to known IDs (simple distance tracking)
        for face in face_candidates:
            x, y, w, h = face['box']
            center_x = x + w / 2
            
            best_match_id = -1
            min_dist = width * 0.15 # Reduced matching radius to avoid jumping in groups
            
            # Try to match with known faces seen recently
            for kf in self.known_faces:
                if frame_number - kf['last_frame'] > 30: # Forgot faces older than 1s (was 2s)
                    continue
                    
                dist = abs(center_x - kf['center'])
                if dist < min_dist:
                    min_dist = dist
                    best_match_id = kf['id']
            
            # If no match, assign new ID
            if best_match_id == -1:
                best_match_id = self.next_id
                self.next_id += 1
            
            # Update known face
            self.known_faces = [kf for kf in self.known_faces if kf['id'] != best_match_id]
            self.known_faces.append({'id': best_match_id, 'center': center_x, 'last_frame': frame_number})
            
            current_candidates.append({
                'id': best_match_id,
                'box': face['box'],
                'score': face['score']
            })

        # 2. Update Scores with decay
        for pid in list(self.speaker_scores.keys()):
             self.speaker_scores[pid] *= 0.85 # Faster decay (was 0.9)
             if self.speaker_scores[pid] < 0.1:
                 del self.speaker_scores[pid]

        # Add new scores
        for cand in current_candidates:
            pid = cand['id']
            # Score is purely based on size (proximity) now that we don't have mouth
            raw_score = cand['score'] / (width * width * 0.05)
            self.speaker_scores[pid] = self.speaker_scores.get(pid, 0) + raw_score

        # 3. Determine Best Speaker
        if not current_candidates:
            # If no one found, maintain last active speaker if cooldown allows
            # to avoid black screen or jump to 0,0
            return None 
            
        best_candidate = None
        max_score = -1
        
        for cand in current_candidates:
            pid = cand['id']
            total_score = self.speaker_scores.get(pid, 0)
            
            # Hysteresis: HUGE Bonus for current active speaker
            if pid == self.active_speaker_id:
                total_score *= 3.0 # Sticky factor
                
            if total_score > max_score:
                max_score = total_score
                best_candidate = cand

        # 4. Decide Switch
        if best_candidate:
            target_id = best_candidate['id']
            
            if target_id == self.active_speaker_id:
                self.locked_counter += 1
                return best_candidate['box']
            
            # New person
            if frame_number - self.last_switch_frame < self.switch_cooldown:
                old_cand = next((c for c in current_candidates if c['id'] == self.active_speaker_id), None)
                if old_cand:
                    return old_cand['box']
            
            self.active_speaker_id = target_id
            self.last_switch_frame = frame_number
            self.locked_counter = 0
            return best_candidate['box']
            
        return None

class FaceTrackRecorder:
    """
    Records normalized face tracks across the whole clip so the editor can
    re-frame later (framing.json). Independent of SpeakerTracker: it tracks
    EVERY face in EVERY scene (including GENERAL scenes, which SpeakerTracker
    never sees) and assigns its own stable ids via greedy nearest-center
    matching. Purely observational — never influences the baked output.
    """
    def __init__(self, video_width, video_height, max_gap_frames=30):
        self.video_width = video_width
        self.video_height = video_height
        self.max_gap_frames = max_gap_frames
        self.tracks = {}  # id -> {'samples': [...], 'last_frame': int, 'last_cx': float, 'last_cy': float}
        self.next_id = 0

    def add(self, frame_number, candidates):
        """
        Match candidates to open tracks and record a sample for each.
        Returns recorder track ids aligned 1:1 with `candidates`.
        """
        ids = []
        claimed = set()
        for cand in candidates:
            x, y, w, h = cand['box']
            cx = x + w / 2
            cy = y + h / 2

            best_id = None
            best_dist = self.video_width * 0.15  # same matching radius as SpeakerTracker
            for tid, tr in self.tracks.items():
                if tid in claimed:
                    continue
                if frame_number - tr['last_frame'] > self.max_gap_frames:
                    continue
                dist = ((cx - tr['last_cx']) ** 2 + (cy - tr['last_cy']) ** 2) ** 0.5
                if dist < best_dist:
                    best_dist = dist
                    best_id = tid

            if best_id is None:
                best_id = self.next_id
                self.next_id += 1
                self.tracks[best_id] = {'samples': [], 'last_frame': frame_number, 'last_cx': cx, 'last_cy': cy}

            claimed.add(best_id)
            tr = self.tracks[best_id]
            tr['last_frame'] = frame_number
            tr['last_cx'] = cx
            tr['last_cy'] = cy
            tr['samples'].append({
                'frame': frame_number,
                'x': round(max(0.0, x / self.video_width), 4),
                'y': round(max(0.0, y / self.video_height), 4),
                'w': round(min(1.0, w / self.video_width), 4),
                'h': round(min(1.0, h / self.video_height), 4),
            })
            ids.append(best_id)
        return ids

    def to_face_tracks(self):
        """Serializable faceTracks list for framing.json (drops single-sample noise tracks)."""
        out = []
        for tid in sorted(self.tracks.keys()):
            samples = self.tracks[tid]['samples']
            if len(samples) < 2:
                continue
            out.append({'id': tid, 'samples': samples})
        return out

def detect_face_candidates(frame):
    """
    Returns list of all detected faces using lightweight FaceDetection.
    """
    height, width, _ = frame.shape
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = get_face_detection().process(rgb_frame)
    
    candidates = []
    
    if not results.detections:
        return []
        
    for detection in results.detections:
        bboxC = detection.location_data.relative_bounding_box
        x = int(bboxC.xmin * width)
        y = int(bboxC.ymin * height)
        w = int(bboxC.width * width)
        h = int(bboxC.height * height)
        
        candidates.append({
            'box': [x, y, w, h],
            'score': w * h # Area as score
        })
            
    return candidates

def detect_person_yolo(frame):
    """
    Fallback: Detect largest person using YOLO when face detection fails.
    Returns [x, y, w, h] of the person's 'upper body' approximation.
    """
    if not ENABLE_YOLO_FALLBACK:
        return None

    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO
        _yolo_model = YOLO('yolov8n.pt')

    results = _yolo_model(frame, verbose=False, classes=[0]) # class 0 is person
    
    if not results:
        return None
        
    best_box = None
    max_area = 0
    
    for result in results:
        boxes = result.boxes
        for box in boxes:
            x1, y1, x2, y2 = [int(i) for i in box.xyxy[0]]
            w = x2 - x1
            h = y2 - y1
            area = w * h
            
            if area > max_area:
                max_area = area
                # Focus on the top 40% of the person (head/chest) for framing
                # This approximates where the face is if we can't detect it directly
                face_h = int(h * 0.4)
                best_box = [x1, y1, w, face_h]
                
    return best_box

class SplitCameraman:
    """
    Two smoothed panel crops for the stacked SPLIT layout (each panel is
    output_width x output_height/2). Slot 0 follows the leftmost face, slot 1
    the rightmost — stable for two-person interviews where people keep their
    side of the frame. Crop math mirrors ReframedVideo.tsx cropForFace so the
    baked output matches the editor preview.
    """
    def __init__(self, video_width, video_height, panel_aspect):
        self.vw = video_width
        self.vh = video_height
        self.panel_aspect = panel_aspect  # panel pixel width / height
        self.slots = [None, None]  # {cx, cy, ch} in source pixels

    def _target_for_face(self, box):
        x, y, w, h = box
        ch = min(max(h / 0.35, self.vh * 0.3), self.vh)
        cw = ch * self.panel_aspect
        if cw > self.vw:
            cw = self.vw
            ch = cw / self.panel_aspect
        return {'cx': x + w / 2, 'cy': y + h / 2, 'ch': ch}

    def update(self, ordered_faces, force_snap=False):
        """ordered_faces: up to 2 face boxes sorted left-to-right."""
        for i in range(2):
            if i >= len(ordered_faces):
                continue  # face missing this frame: keep last crop (sticky)
            target = self._target_for_face(ordered_faces[i]['box'])
            slot = self.slots[i]
            if slot is None or force_snap:
                self.slots[i] = target
            else:
                a = 0.12  # smoothing factor per processed frame
                slot['cx'] += (target['cx'] - slot['cx']) * a
                slot['cy'] += (target['cy'] - slot['cy']) * a
                slot['ch'] += (target['ch'] - slot['ch']) * a

    def get_crops(self):
        """Pixel rects [(x1, y1, x2, y2), ...] for both panels."""
        crops = []
        for slot in self.slots:
            if slot is None:
                # No face seen yet: center crop
                ch = self.vh
                cw = min(ch * self.panel_aspect, self.vw)
                ch = cw / self.panel_aspect
                cx, cy = self.vw / 2, self.vh / 2
            else:
                ch = slot['ch']
                cw = ch * self.panel_aspect
                cx, cy = slot['cx'], slot['cy']
            # face center sits at 42% from the crop top (headroom)
            x1 = max(0, min(cx - cw / 2, self.vw - cw))
            y1 = max(0, min(cy - 0.42 * ch, self.vh - ch))
            crops.append((int(x1), int(y1), int(x1 + cw), int(y1 + ch)))
        return crops

def compose_split_frame(frame, crops, output_width, output_height):
    """Stack two panel crops vertically into the output frame."""
    panel_h = output_height // 2
    panels = []
    for (x1, y1, x2, y2) in crops:
        if x2 > x1 and y2 > y1:
            cropped = frame[y1:y2, x1:x2]
        else:
            cropped = frame
        panels.append(cv2.resize(cropped, (output_width, panel_h), interpolation=cv2.INTER_LANCZOS4))
    stacked = cv2.vconcat(panels)
    if stacked.shape[0] != output_height:
        stacked = cv2.resize(stacked, (output_width, output_height), interpolation=cv2.INTER_LANCZOS4)
    return stacked

def create_general_frame(frame, output_width, output_height):
    """
    Creates a 'General Shot' frame: 
    - Background: Blurred zoom of original
    - Foreground: Original video scaled to fit width, centered vertically.
    """
    orig_h, orig_w = frame.shape[:2]
    
    # 1. Background (Fill Height)
    # Crop center to aspect ratio
    bg_scale = output_height / orig_h
    bg_w = int(orig_w * bg_scale)
    bg_resized = cv2.resize(frame, (bg_w, output_height), interpolation=cv2.INTER_LANCZOS4)
    
    # Crop center of background
    start_x = (bg_w - output_width) // 2
    if start_x < 0: start_x = 0
    background = bg_resized[:, start_x:start_x+output_width]
    if background.shape[1] != output_width:
        background = cv2.resize(background, (output_width, output_height), interpolation=cv2.INTER_LANCZOS4)
        
    # Blur background
    background = cv2.GaussianBlur(background, (51, 51), 0)
    
    # 2. Foreground — CONTAIN within the output (fit width normally, but fall back
    # to fitting height when the source is narrower than the target, e.g. a
    # portrait/square upload with a 16:9 output — otherwise fg_h > output_height
    # gives a negative offset and a NumPy broadcast error).
    scale = min(output_width / orig_w, output_height / orig_h)
    fg_w = int(orig_w * scale)
    fg_h = int(orig_h * scale)
    foreground = cv2.resize(frame, (fg_w, fg_h), interpolation=cv2.INTER_LANCZOS4)

    # 3. Overlay (centered both axes over the blurred background)
    y_offset = (output_height - fg_h) // 2
    x_offset = (output_width - fg_w) // 2

    # Clone background to avoid modifying it
    final_frame = background.copy()
    final_frame[y_offset:y_offset+fg_h, x_offset:x_offset+fg_w] = foreground

    return final_frame

def analyze_scenes_strategy(video_path, scenes):
    """
    Analyzes each scene to determine if it should be TRACK (Single person) or GENERAL (Group/Wide).
    Returns list of strategies corresponding to scenes.
    """
    cap = cv2.VideoCapture(video_path)
    strategies = []
    
    if not cap.isOpened():
        return ['TRACK'] * len(scenes)
        
    for start, end in tqdm(scenes, desc="   Analyzing Scenes"):
        # Sample 3 frames (start, middle, end)
        frames_to_check = [
            start.get_frames() + 5,
            int((start.get_frames() + end.get_frames()) / 2),
            end.get_frames() - 5
        ]
        
        face_counts = []
        for f_idx in frames_to_check:
            cap.set(cv2.CAP_PROP_POS_FRAMES, f_idx)
            ret, frame = cap.read()
            if not ret: continue
            
            # Detect faces
            candidates = detect_face_candidates(frame)
            face_counts.append(len(candidates))
            
        # Decision Logic
        if not face_counts:
            avg_faces = 0
        else:
            avg_faces = sum(face_counts) / len(face_counts)

        # Strategy:
        # 0 faces -> GENERAL (Landscape/B-roll)
        # 1 face -> TRACK
        # exactly 2 faces in EVERY sampled frame -> SPLIT (stacked two-shot)
        # > 1.2 faces otherwise -> GENERAL (Group)

        if (
            AUTO_SPLIT_LAYOUT
            and face_counts
            and all(c == 2 for c in face_counts)
        ):
            strategies.append('SPLIT')
        elif avg_faces > 1.2 or avg_faces < 0.5:
            strategies.append('GENERAL')
        else:
            strategies.append('TRACK')

    cap.release()
    return strategies

def detect_scenes(video_path):
    video = open_video(video_path)
    scene_manager = SceneManager()
    scene_manager.add_detector(ContentDetector())
    scene_manager.detect_scenes(video=video)
    scene_list = scene_manager.get_scene_list()
    fps = video.frame_rate
    return scene_list, fps

def get_video_resolution(video_path):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise IOError(f"Could not open video file {video_path}")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    return width, height


def sanitize_filename(filename):
    """Remove invalid characters from filename."""
    filename = re.sub(r'[<>:"/\\|?*#]', '', filename)
    filename = filename.replace(' ', '_')
    return filename[:100]


def download_youtube_video(url, output_dir="."):
    """
    Downloads a YouTube video using yt-dlp.
    Returns the path to the downloaded video and the video title.
    """
    print(f"🔍 Debug: yt-dlp version: {yt_dlp.version.__version__}")
    print("📥 Downloading video from YouTube...")
    step_start_time = time.time()

    cookies_path = os.path.join(tempfile.gettempdir(), f"openshorts_youtube_cookies_{os.getpid()}_{int(time.time())}.txt")
    cookies_env = os.environ.get("YOUTUBE_COOKIES")
    if cookies_env:
        print("🍪 Found YOUTUBE_COOKIES env var, creating cookies file...")
        try:
            with open(cookies_path, 'w') as f:
                f.write(cookies_env)
            if os.path.exists(cookies_path):
                 print(f"   Debug: Cookies file created. Size: {os.path.getsize(cookies_path)} bytes")
        except Exception as e:
            print(f"⚠️ Failed to write cookies file: {e}")
            cookies_path = None
    else:
        cookies_path = None
        print("⚠️ YOUTUBE_COOKIES env var not found.")

    cookies_from_browser = os.environ.get("YOUTUBE_COOKIES_FROM_BROWSER")
    if cookies_from_browser and cookies_path:
        print("⚠️ Both YOUTUBE_COOKIES and YOUTUBE_COOKIES_FROM_BROWSER are set. Using YOUTUBE_COOKIES.")

    node_path = shutil.which("node")
    js_runtimes = {"deno": {}}
    if node_path:
        js_runtimes["node"] = {"path": node_path}
        print(f"🧩 yt-dlp JavaScript runtime enabled: node ({node_path})")
    else:
        print("⚠️ Node.js was not found on PATH. YouTube may hide some high-quality formats.")

    # YouTube throttles streams whose `n` signature challenge isn't solved, which
    # truncates large downloads ("X bytes read, Y more expected. Giving up..."),
    # not a 429 ban. yt-dlp's EJS remote solver fixes it, but it needs a JS
    # runtime (node) to execute the downloaded solver. Override the component
    # spec — or disable it (empty) — with YTDLP_REMOTE_COMPONENTS.
    remote_components = set()
    if node_path:
        rc_env = os.environ.get("YTDLP_REMOTE_COMPONENTS", "ejs:github")
        remote_components = {c.strip() for c in rc_env.split(",") if c.strip()}
        if remote_components:
            print(f"🔓 yt-dlp n-challenge solver enabled: {', '.join(sorted(remote_components))}")
    elif os.environ.get("YTDLP_REMOTE_COMPONENTS"):
        print("⚠️ YTDLP_REMOTE_COMPONENTS is set but no JS runtime (node) was found; the n-challenge solver can't run.")

    # Let yt-dlp use its current default YouTube clients. Forcing older clients
    # can hide high-quality formats and fall back to 360p format 18.
    _COMMON_YDL_OPTS = {
        'quiet': False,
        'verbose': True,
        'no_warnings': False,
        'cookiefile': cookies_path if cookies_path else None,
        'cookiesfrombrowser': (cookies_from_browser,) if cookies_from_browser and not cookies_path else None,
        'socket_timeout': 30,
        'retries': 10,
        'fragment_retries': 10,
        'nocheckcertificate': True,
        'cachedir': False,
        'js_runtimes': js_runtimes,
        'remote_components': remote_components,
        'http_headers': {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/120.0.0.0 Safari/537.36'
            ),
        },
    }

    with yt_dlp.YoutubeDL(_COMMON_YDL_OPTS) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
            video_title = info.get('title', 'youtube_video')
            sanitized_title = sanitize_filename(video_title)
        except Exception as e:
            # Force print to stderr/stdout immediately so it's captured before crash
            import sys
            import traceback
            
            # Print minimal error first to ensure something gets out
            print("🚨 YOUTUBE DOWNLOAD ERROR 🚨", file=sys.stderr)
            
            error_msg = f"""
            
❌ ================================================================= ❌
❌ FATAL ERROR: YOUTUBE DOWNLOAD FAILED
❌ ================================================================= ❌
            
REASON: YouTube has blocked the download request (Error 429/Unavailable).
        This is likely a temporary IP ban on this server.

👇 SOLUTION FOR USER 👇
---------------------------------------------------------------------
1. Download the video manually to your computer.
2. Use the 'Upload Video' tab in this app to process it.
---------------------------------------------------------------------

Technical Details: {str(e)}
            """
            # Print to both streams to ensure capture
            print(error_msg, file=sys.stdout)
            print(error_msg, file=sys.stderr)
            
            # Force flush
            sys.stdout.flush()
            sys.stderr.flush()
            
            # Wait a split second to allow buffer to drain before raising
            time.sleep(0.5)
            
            raise e
    
    output_template = os.path.join(output_dir, f'{sanitized_title}.%(ext)s')
    expected_file = os.path.join(output_dir, f'{sanitized_title}.mp4')
    if os.path.exists(expected_file):
        os.remove(expected_file)
        print(f"🗑️  Removed existing file to re-download with H.264 codec")
    
    ydl_opts = {
        **_COMMON_YDL_OPTS,
        'format': (
            'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/'
            'bestvideo[height<=1080]+bestaudio/'
            'best[height<=1080]/best'
        ),
        'format_sort': ['res:1080', 'fps', 'vcodec', 'acodec'],
        'outtmpl': output_template,
        'merge_output_format': 'mp4',
        'overwrites': True,
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            requested = info.get("requested_downloads") or info.get("requested_formats") or []
            if requested:
                selected = ", ".join(
                    f"{fmt.get('format_id', '?')} {fmt.get('resolution') or fmt.get('height') or 'audio'} {fmt.get('ext', '')}"
                    for fmt in requested
                )
                print(f"🎞️  Selected YouTube formats: {selected}")
            else:
                print(f"🎞️  Selected YouTube format: {info.get('format_id', 'unknown')} {info.get('resolution', '')}")
    finally:
        if cookies_env and cookies_path and os.path.exists(cookies_path):
            os.remove(cookies_path)
    
    downloaded_file = os.path.join(output_dir, f'{sanitized_title}.mp4')
    
    if not os.path.exists(downloaded_file):
        for f in os.listdir(output_dir):
            if f.startswith(sanitized_title) and f.endswith('.mp4'):
                downloaded_file = os.path.join(output_dir, f)
                break
    
    step_end_time = time.time()
    print(f"✅ Video downloaded in {step_end_time - step_start_time:.2f}s: {downloaded_file}")
    
    return downloaded_file, sanitized_title

def process_video_to_vertical(input_video, final_output_video, framing_output_path=None,
                              framing_source_override=None, aspect_ratio="9:16"):
    """
    Core logic to convert horizontal video to vertical using scene detection and Active Speaker Tracking (MediaPipe).

    When framing_output_path is provided, also writes a framing.json describing
    every framing decision (face tracks, per-segment layout, crop keyframes) in
    normalized coordinates, so the web editor can re-frame non-destructively.
    The baked output is identical either way.
    """
    script_start_time = time.time()
    
    # Define temporary file paths based on the output name
    base_name = os.path.splitext(final_output_video)[0]
    temp_video_output = f"{base_name}_temp_video.mp4"
    temp_audio_output = f"{base_name}_temp_audio.aac"
    
    # Clean up previous temp files if they exist
    if os.path.exists(temp_video_output): os.remove(temp_video_output)
    if os.path.exists(temp_audio_output): os.remove(temp_audio_output)
    if os.path.exists(final_output_video): os.remove(final_output_video)

    print(f"🎬 Processing clip: {input_video}")
    print("   Step 1: Detecting scenes...")
    scenes, fps = detect_scenes(input_video)
    
    if not scenes:
        print("   ❌ No scenes were detected. Using full video as one scene.")
        # If scene detection fails or finds nothing, treat whole video as one scene
        cap = cv2.VideoCapture(input_video)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        from scenedetect import FrameTimecode
        scenes = [(FrameTimecode(0, fps), FrameTimecode(total_frames, fps))]

    print(f"   ✅ Found {len(scenes)} scenes.")

    print("\n   🧠 Step 2: Preparing Active Tracking...")
    original_width, original_height = get_video_resolution(input_video)
    
    # Output dimensions from the requested aspect ratio (default vertical 9:16).
    OUTPUT_WIDTH, OUTPUT_HEIGHT = ASPECT_PRESETS.get(aspect_ratio, ASPECT_PRESETS["9:16"])

    # Initialize Cameraman
    cameraman = SmoothedCameraman(OUTPUT_WIDTH, OUTPUT_HEIGHT, original_width, original_height)
    
    # --- New Strategy: Per-Scene Analysis ---
    print("\n   🤖 Step 3: Analyzing Scenes for Strategy (Single vs Group)...")
    scene_strategies = analyze_scenes_strategy(input_video, scenes)
    # scene_strategies is a list of 'TRACK' or 'General' corresponding to scenes
    
    print("\n   ✂️ Step 4: Processing video frames...")
    
    command = [
        'ffmpeg', '-y', '-f', 'rawvideo', '-vcodec', 'rawvideo',
        '-s', f'{OUTPUT_WIDTH}x{OUTPUT_HEIGHT}', '-pix_fmt', 'bgr24',
        '-r', str(fps), '-i', '-',
        '-vf', 'unsharp=5:5:1.5,eq=brightness=0.06:contrast=1.1:saturation=1.15',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-an', temp_video_output
    ]

    ffmpeg_process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    cap = cv2.VideoCapture(input_video)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    frame_number = 0
    current_scene_index = 0
    pipe_broke = False  # set if FFmpeg dies mid-stream (write hits a closed pipe)

    # Pre-calculate scene boundaries
    scene_boundaries = []
    for s_start, s_end in scenes:
        scene_boundaries.append((s_start.get_frames(), s_end.get_frames()))

    # Global tracker for single-person shots
    speaker_tracker = SpeakerTracker(cooldown_frames=30)

    # Framing recording (editor metadata) — observational only
    face_recorder = FaceTrackRecorder(original_width, original_height) if framing_output_path else None
    segment_votes = {}      # scene_index -> {recorder_track_id: vote_count}
    segment_keyframes = {}  # scene_index -> [normalized crop keyframes]
    split_votes = {}        # scene_index -> {(panel_idx, recorder_track_id): vote_count}

    # Cameraman for stacked two-person SPLIT scenes (panels are W x H/2)
    split_cameraman = SplitCameraman(original_width, original_height, OUTPUT_WIDTH / (OUTPUT_HEIGHT / 2))

    with tqdm(total=total_frames, desc="   Processing", file=sys.stdout) as pbar:
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            # Update Scene Index
            if current_scene_index < len(scene_boundaries):
                start_f, end_f = scene_boundaries[current_scene_index]
                if frame_number >= end_f and current_scene_index < len(scene_boundaries) - 1:
                    current_scene_index += 1
            
            # Determine Strategy for current frame based on scene
            current_strategy = scene_strategies[current_scene_index] if current_scene_index < len(scene_strategies) else 'TRACK'

            # Snap cameras on scene change to avoid panning from previous scene position
            is_scene_start = (frame_number == scene_boundaries[current_scene_index][0])

            # Apply Strategy
            if current_strategy == 'GENERAL':
                # "Plano General" -> Blur Background + Fit Width
                output_frame = create_general_frame(frame, OUTPUT_WIDTH, OUTPUT_HEIGHT)

                # Reset cameraman/tracker so they don't drift while inactive
                cameraman.current_center_x = original_width / 2
                cameraman.target_center_x = original_width / 2

                # Record face tracks even in GENERAL scenes (multi-person scenes
                # land here — the editor needs these tracks to offer split/three/four).
                # Recorder only; never feeds speaker_tracker, so baked output is untouched.
                if face_recorder is not None and frame_number % 2 == 0:
                    face_recorder.add(frame_number, detect_face_candidates(frame))

            elif current_strategy == 'SPLIT':
                # Stable two-person scene -> stacked panels, one per face
                if frame_number % 2 == 0:
                    candidates = detect_face_candidates(frame)
                    rec_ids = face_recorder.add(frame_number, candidates) if face_recorder is not None else []
                    # Two most prominent faces, ordered left -> right
                    top2 = sorted(candidates, key=lambda c: -c['score'])[:2]
                    ordered = sorted(top2, key=lambda c: c['box'][0])
                    split_cameraman.update(ordered, force_snap=is_scene_start)
                    # Record which recorder track each panel follows
                    if face_recorder is not None:
                        for panel_idx, face in enumerate(ordered):
                            for ci, cand in enumerate(candidates):
                                if cand['box'] == face['box']:
                                    votes = split_votes.setdefault(current_scene_index, {})
                                    key = (panel_idx, rec_ids[ci])
                                    votes[key] = votes.get(key, 0) + 1
                                    break

                output_frame = compose_split_frame(frame, split_cameraman.get_crops(), OUTPUT_WIDTH, OUTPUT_HEIGHT)

            else:
                # "Single Speaker" -> Track & Crop

                # Detect every 2nd frame for performance
                if frame_number % 2 == 0:
                    candidates = detect_face_candidates(frame)
                    rec_ids = face_recorder.add(frame_number, candidates) if face_recorder is not None else []
                    target_box = speaker_tracker.get_target(candidates, frame_number, original_width)
                    if target_box:
                        cameraman.update_target(target_box)
                        # Vote: which recorder track is the active speaker in this scene?
                        # get_target always returns a box from `candidates`, so identity-match it.
                        if face_recorder is not None:
                            for ci, cand in enumerate(candidates):
                                if cand['box'] == target_box:
                                    votes = segment_votes.setdefault(current_scene_index, {})
                                    votes[rec_ids[ci]] = votes.get(rec_ids[ci], 0) + 1
                                    break
                    else:
                        person_box = detect_person_yolo(frame)
                        if person_box:
                            cameraman.update_target(person_box)

                x1, y1, x2, y2 = cameraman.get_crop_box(force_snap=is_scene_start)

                # Record the smoothed crop window as a keyframe (every 3rd frame)
                if face_recorder is not None and (frame_number % 3 == 0 or is_scene_start):
                    segment_keyframes.setdefault(current_scene_index, []).append({
                        'frame': frame_number,
                        'x': round(x1 / original_width, 4),
                        'y': round(y1 / original_height, 4),
                        'w': round((x2 - x1) / original_width, 4),
                        'h': round((y2 - y1) / original_height, 4),
                    })
                
                # Crop
                if y2 > y1 and x2 > x1:
                    cropped = frame[y1:y2, x1:x2]
                    output_frame = cv2.resize(cropped, (OUTPUT_WIDTH, OUTPUT_HEIGHT), interpolation=cv2.INTER_LANCZOS4)
                else:
                    output_frame = cv2.resize(frame, (OUTPUT_WIDTH, OUTPUT_HEIGHT), interpolation=cv2.INTER_LANCZOS4)

            # Guard against any wrong-sized/typed frame desyncing the raw stream.
            if output_frame.shape[0] != OUTPUT_HEIGHT or output_frame.shape[1] != OUTPUT_WIDTH:
                output_frame = cv2.resize(output_frame, (OUTPUT_WIDTH, OUTPUT_HEIGHT), interpolation=cv2.INTER_LANCZOS4)
            if output_frame.dtype != np.uint8:
                output_frame = output_frame.astype(np.uint8)

            # If FFmpeg already died, stop and surface ITS error below instead of
            # letting an opaque BrokenPipeError bubble up with no context.
            try:
                ffmpeg_process.stdin.write(np.ascontiguousarray(output_frame).tobytes())
            except BrokenPipeError:
                pipe_broke = True
                break

            frame_number += 1
            pbar.update(1)

    try:
        ffmpeg_process.stdin.close()
    except BrokenPipeError:
        pass
    stderr_output = ffmpeg_process.stderr.read().decode(errors="replace")
    ffmpeg_process.wait()
    cap.release()

    if pipe_broke or ffmpeg_process.returncode != 0:
        print(f"\n   ❌ FFmpeg frame processing failed (exit code {ffmpeg_process.returncode}).")
        print("   FFmpeg stderr:\n" + (stderr_output.strip() or "(empty)"))
        # Raise with the real cause so it lands in the job log, instead of a bare
        # BrokenPipeError that hides why FFmpeg exited.
        raise RuntimeError(
            "FFmpeg encoder exited early during frame processing. "
            "Cause (FFmpeg stderr):\n" + (stderr_output.strip()[-2000:] or "(no stderr captured)")
        )

    print("\n   🔊 Step 5: Extracting audio...")
    audio_extract_command = [
        'ffmpeg', '-y', '-i', input_video, '-vn', '-acodec', 'copy', temp_audio_output
    ]
    try:
        subprocess.run(audio_extract_command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError:
        print("\n   ❌ Audio extraction failed (maybe no audio?). Proceeding without audio.")
        pass

    print("\n   ✨ Step 6: Merging...")
    if os.path.exists(temp_audio_output):
        merge_command = [
            'ffmpeg', '-y', '-i', temp_video_output, '-i', temp_audio_output,
            '-c:v', 'copy', '-c:a', 'copy', final_output_video
        ]
    else:
         merge_command = [
            'ffmpeg', '-y', '-i', temp_video_output,
            '-c:v', 'copy', final_output_video
        ]
        
    try:
        subprocess.run(merge_command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        print(f"   ✅ Clip saved to {final_output_video}")
    except subprocess.CalledProcessError as e:
        print("\n   ❌ Final merge failed.")
        print("   Stderr:", e.stderr.decode())
        return False

    # Clean up temp files
    if os.path.exists(temp_video_output): os.remove(temp_video_output)
    if os.path.exists(temp_audio_output): os.remove(temp_audio_output)

    # Write framing metadata for the web editor (schema v2:
    # docs/video-editor-plan-2.md §1). The analysis above ran on the UNPADDED
    # clip; when the kept _source.mp4 is a padded cut (framing_source_override),
    # shift every recorded frame number by the padding offset so coordinates
    # are in padded-source frames, and record the clip bounds for trim/extend.
    if framing_output_path:
        offset = framing_source_override['offsetFrames'] if framing_source_override else 0
        segments_out = []
        for i, (s_f, e_f) in enumerate(scene_boundaries):
            strategy = scene_strategies[i] if i < len(scene_strategies) else 'TRACK'
            if strategy == 'SPLIT':
                layout = 'split'
                # Per panel: the recorder track it followed most often
                votes = split_votes.get(i, {})
                tracked = []
                for panel_idx in range(2):
                    panel_votes = {tid: n for (p, tid), n in votes.items() if p == panel_idx}
                    if panel_votes:
                        tracked.append(max(panel_votes, key=panel_votes.get))
            elif strategy == 'GENERAL':
                layout = 'fit'
                tracked = []
            else:
                layout = 'fill'
                votes = segment_votes.get(i, {})
                tracked = [max(votes, key=votes.get)] if votes else []
            segments_out.append({
                'id': f'seg-{i}',
                'startFrame': s_f + offset,
                'endFrame': e_f + offset,
                'layout': layout,
                'trackedFaceIds': tracked,
                'cameraKeyframes': [
                    {**kf, 'frame': kf['frame'] + offset}
                    for kf in segment_keyframes.get(i, [])
                ],
                'manualCrop': None,
            })
        face_tracks_out = face_recorder.to_face_tracks()
        if offset:
            face_tracks_out = [
                {
                    'id': t['id'],
                    'samples': [{**s, 'frame': s['frame'] + offset} for s in t['samples']],
                }
                for t in face_tracks_out
            ]
        framing_data = {
            'version': 2,
            'source': {
                'file': framing_source_override['file'] if framing_source_override else os.path.basename(input_video),
                'fps': float(fps),
                'width': original_width,
                'height': original_height,
                'durationFrames': framing_source_override['durationFrames'] if framing_source_override else total_frames,
            },
            'outputWidth': OUTPUT_WIDTH,
            'outputHeight': OUTPUT_HEIGHT,
            'clipInFrame': offset,
            'clipOutFrame': offset + total_frames,
            # Immutable caption origin: word ms are relative to the original clip
            # start (== this initial clipInFrame). Recorded separately so trimming
            # the head later doesn't shift the subtitles.
            'captionsOriginFrame': offset,
            'cuts': [],
            'segments': segments_out,
            'faceTracks': face_tracks_out,
        }
        if framing_source_override:
            # ffmpeg -ss seeking isn't frame-exact; keep bounds inside the
            # actual padded file so the editor/validator never see overflow
            padded_dur = framing_source_override['durationFrames']
            framing_data['clipOutFrame'] = min(framing_data['clipOutFrame'], padded_dur)
            if segments_out:
                segments_out[-1]['endFrame'] = framing_data['clipOutFrame']
        with open(framing_output_path, 'w') as f:
            json.dump(framing_data, f)
        print(f"   🎯 Framing metadata saved to {framing_output_path}")

    return True

WHISPER_MODELS = {"tiny", "base", "small", "medium", "large-v3"}

def transcribe_video(video_path, whisper_model="base"):
    if whisper_model not in WHISPER_MODELS:
        print(f"⚠️  Unknown Whisper model '{whisper_model}', falling back to 'base'.")
        whisper_model = "base"

    print(f"🎙️  Transcribing video with Faster-Whisper model '{whisper_model}' (CPU Optimized)...")
    from faster_whisper import WhisperModel
    
    # Run on CPU with INT8 quantization for speed
    model = WhisperModel(whisper_model, device="cpu", compute_type="int8")
    
    segments, info = model.transcribe(video_path, word_timestamps=True)
    
    print(f"   Detected language '{info.language}' with probability {info.language_probability:.2f}")
    
    # Convert to openai-whisper compatible format
    transcript_segments = []
    full_text = ""
    
    for segment in segments:
        # Print progress to keep user informed (and prevent timeouts feeling)
        print(f"   [{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text}")
        
        seg_dict = {
            'text': segment.text,
            'start': segment.start,
            'end': segment.end,
            'words': []
        }
        
        if segment.words:
            for word in segment.words:
                seg_dict['words'].append({
                    'word': word.word,
                    'start': word.start,
                    'end': word.end,
                    'probability': word.probability
                })
        
        transcript_segments.append(seg_dict)
        full_text += segment.text + " "
        
    return {
        'text': full_text.strip(),
        'segments': transcript_segments,
        'language': info.language
    }

class ClipAnalysisError(Exception):
    """Raised when Gemini cannot produce viral clip selections."""

def is_retryable_gemini_error(error):
    error_text = str(error).lower()
    retryable_markers = [
        "503",
        "unavailable",
        "high demand",
        "429",
        "resource_exhausted",
        "rate limit",
        "temporarily",
        "timeout",
    ]
    return any(marker in error_text for marker in retryable_markers)

def get_gemini_retry_delay(error, fallback_seconds):
    """Use Gemini's suggested retry delay when the API includes one."""
    error_text = str(error)
    patterns = [
        r"'retryDelay':\s*'(\d+(?:\.\d+)?)s'",
        r'"retryDelay":\s*"(\d+(?:\.\d+)?)s"',
        r"retry in (\d+(?:\.\d+)?)s",
    ]
    for pattern in patterns:
        match = re.search(pattern, error_text, re.IGNORECASE)
        if match:
            return min(120, max(1, int(float(match.group(1))) + 1))
    return fallback_seconds

def get_viral_clips(transcript_result, video_duration, max_retries=3,
                    min_clip_length=15, max_clip_length=60, moment_prompt=""):
    print("🤖  Analyzing with Gemini...")
    
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("❌ Error: GEMINI_API_KEY not found in environment variables.")
        raise ClipAnalysisError("GEMINI_API_KEY is missing.")


    client = genai.Client(api_key=api_key)
    
    # We use gemini-2.5-flash as requested.
    model_name = 'gemini-2.5-flash' 
    
    print(f"🤖  Initializing Gemini with model: {model_name}")

    # Extract words
    words = []
    for segment in transcript_result['segments']:
        for word in segment.get('words', []):
            words.append({
                'w': word['word'],
                's': word['start'],
                'e': word['end']
            })

    user_focus = ""
    if moment_prompt and moment_prompt.strip():
        user_focus = (
            "\n🎯 USER FOCUS — PRIORITISE moments that match this request "
            "(they must still be genuinely engaging/clippable):\n"
            f"\"{moment_prompt.strip()}\"\n"
        )

    prompt = GEMINI_PROMPT_TEMPLATE.format(
        video_duration=video_duration,
        transcript_text=json.dumps(transcript_result['text']),
        words_json=json.dumps(words),
        min_len=min_clip_length,
        max_len=max_clip_length,
        user_focus=user_focus,
    )

    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt
            )
        
            # --- Cost Calculation ---
            try:
                usage = response.usage_metadata
                if usage:
                    # Gemini 2.5 Flash Pricing (Dec 2025)
                    # Input: $0.10 per 1M tokens
                    # Output: $0.40 per 1M tokens

                    input_price_per_million = 0.10
                    output_price_per_million = 0.40

                    prompt_tokens = usage.prompt_token_count
                    output_tokens = usage.candidates_token_count

                    input_cost = (prompt_tokens / 1_000_000) * input_price_per_million
                    output_cost = (output_tokens / 1_000_000) * output_price_per_million
                    total_cost = input_cost + output_cost

                    cost_analysis = {
                        "input_tokens": prompt_tokens,
                        "output_tokens": output_tokens,
                        "input_cost": input_cost,
                        "output_cost": output_cost,
                        "total_cost": total_cost,
                        "model": model_name
                    }

                    print(f"💰 Token Usage ({model_name}):")
                    print(f"   - Input Tokens: {prompt_tokens} (${input_cost:.6f})")
                    print(f"   - Output Tokens: {output_tokens} (${output_cost:.6f})")
                    print(f"   - Total Estimated Cost: ${total_cost:.6f}")

            except Exception as e:
                print(f"⚠️ Could not calculate cost: {e}")
                cost_analysis = None
            # ------------------------

            # Clean response if it contains markdown code blocks
            text = response.text.strip()
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

            result_json = json.loads(text)
            if cost_analysis:
                result_json['cost_analysis'] = cost_analysis

            return result_json
        except Exception as e:
            last_error = e
            print(f"❌ Gemini attempt {attempt}/{max_retries} failed: {e}")
            if not is_retryable_gemini_error(e):
                break
            if attempt < max_retries:
                fallback_wait = min(60, 5 * (2 ** (attempt - 1)))
                wait_seconds = get_gemini_retry_delay(e, fallback_wait)
                print(f"⏳ Gemini retry {attempt + 1}/{max_retries} in {wait_seconds}s...")
                time.sleep(wait_seconds)

    raise ClipAnalysisError(
        "Gemini could not identify clips after retrying. "
        f"Last error: {last_error}"
    )

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="AutoCrop-Vertical with Viral Clip Detection.")
    
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument('-i', '--input', type=str, help="Path to the input video file.")
    input_group.add_argument('-u', '--url', type=str, help="YouTube URL to download and process.")
    
    parser.add_argument('-o', '--output', type=str, help="Output directory for the generated clip artifacts (mp4 + source + framing/metadata json). Don't-clip mode also writes editable clip artifacts here, not a single file.")
    parser.add_argument('--keep-original', action='store_true', help="Keep the downloaded YouTube video.")
    parser.add_argument('--skip-analysis', action='store_true', help="Skip AI viral detection; process the whole video (or --trim range) as one clip.")
    parser.add_argument('--whisper-model', choices=sorted(WHISPER_MODELS), default='base', help="Faster-Whisper model to use for transcription.")
    parser.add_argument('--min-clip-length', type=int, default=15, help="Minimum clip length in seconds (AI mode).")
    parser.add_argument('--max-clip-length', type=int, default=60, help="Maximum clip length in seconds (AI mode).")
    parser.add_argument('--moment-prompt', type=str, default="", help="Free-text instruction: what moments the AI should prioritise.")
    parser.add_argument('--trim-start', type=float, default=None, help="Don't-clip mode: start of the range to process (seconds).")
    parser.add_argument('--trim-end', type=float, default=None, help="Don't-clip mode: end of the range to process (seconds).")
    parser.add_argument('--aspect-ratio', choices=sorted(ASPECT_PRESETS), default='9:16', help="Output aspect ratio.")
    
    args = parser.parse_args()

    script_start_time = time.time()
    
    def _ensure_dir(path: str) -> str:
        """Create directory if missing and return the same path."""
        if path:
            os.makedirs(path, exist_ok=True)
        return path
    
    # 1. Get Input Video
    if args.url:
        # For multi-clip runs, treat --output as an OUTPUT DIRECTORY (create it if needed).
        # For whole-video runs (--skip-analysis), --output can be a file path.
        if args.output and not args.skip_analysis:
            output_dir = _ensure_dir(args.output)
        else:
            # If output is a directory, use it; if it's a filename, use its directory; else default "."
            if args.output and os.path.isdir(args.output):
                output_dir = args.output
            elif args.output and not os.path.isdir(args.output):
                output_dir = os.path.dirname(args.output) or "."
            else:
                output_dir = "."
        
        input_video, video_title = download_youtube_video(args.url, output_dir)
    else:
        input_video = args.input
        video_title = os.path.splitext(os.path.basename(input_video))[0]
        
        if args.output and not args.skip_analysis:
            # For multi-clip runs, treat --output as an OUTPUT DIRECTORY (create it if needed).
            output_dir = _ensure_dir(args.output)
        else:
            # If output is a directory, use it; if it's a filename, use its directory; else default to input dir.
            if args.output and os.path.isdir(args.output):
                output_dir = args.output
            elif args.output and not os.path.isdir(args.output):
                output_dir = os.path.dirname(args.output) or os.path.dirname(input_video)
            else:
                output_dir = os.path.dirname(input_video)

    if not os.path.exists(input_video):
        print(f"❌ Input file not found: {input_video}")
        exit(1)

    # 2. Transcribe (captions need word-level timestamps in BOTH modes)
    transcript = transcribe_video(input_video, args.whisper_model)

    # Get duration (guard against a corrupt/unreadable video reporting fps 0)
    cap = cv2.VideoCapture(input_video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps if fps > 0 else 0.0
    cap.release()

    # 3. Pick moments: AI viral detection, or one synthetic moment ("Don't clip")
    if args.skip_analysis:
        seg_start = max(0.0, float(args.trim_start)) if args.trim_start is not None else 0.0
        seg_end = min(duration, float(args.trim_end)) if args.trim_end is not None else duration
        if seg_end <= seg_start:
            seg_start, seg_end = 0.0, duration
        print(f"⏩ Don't-clip mode: processing {seg_start:.1f}s–{seg_end:.1f}s as a single clip.")
        clips_data = {'shorts': [{
            'start': seg_start,
            'end': seg_end,
            'video_description_for_tiktok': '',
            'video_description_for_instagram': '',
            'video_title_for_youtube_short': video_title,
            'viral_hook_text': '',
        }]}
    else:
        # 4. Gemini Analysis
        try:
            clips_data = get_viral_clips(
                transcript, duration,
                min_clip_length=args.min_clip_length,
                max_clip_length=args.max_clip_length,
                moment_prompt=args.moment_prompt or "",
            )
        except ClipAnalysisError as e:
            print(f"❌ Clip detection failed: {e}")
            print("🛑 Stopping job. Not converting the whole video as a fallback.")
            sys.exit(2)

    if not clips_data or 'shorts' not in clips_data:
        print("❌ Gemini response did not include any shorts.")
        print("🛑 Stopping job. Not converting the whole video as a fallback.")
        sys.exit(2)
    else:
        print(f"🔥 Found {len(clips_data['shorts'])} viral clips!")

        # Save metadata
        clips_data['transcript'] = transcript # Save full transcript for subtitles
        metadata_file = os.path.join(output_dir, f"{video_title}_metadata.json")
        with open(metadata_file, 'w') as f:
            json.dump(clips_data, f, indent=2)
        print(f"   Saved metadata to {metadata_file}")

        # 5. Process each clip
        for i, clip in enumerate(clips_data['shorts']):
            start = clip['start']
            end = clip['end']
            print(f"\n🎬 Processing Clip {i+1}: {start}s - {end}s")
            print(f"   Title: {clip.get('video_title_for_youtube_short', 'No Title')}")

            # Cut clip
            clip_filename = f"{video_title}_clip_{i+1}.mp4"
            # 16:9 source is KEPT with ±3s padding — the web editor re-frames
            # from it and can trim/extend within the padding (framing v2 EDL)
            clip_cut_path = os.path.join(output_dir, f"temp_{video_title}_clip_{i+1}.mp4")
            clip_source_path = os.path.join(output_dir, f"{video_title}_clip_{i+1}_source.mp4")
            clip_final_path = os.path.join(output_dir, clip_filename)
            clip_framing_path = os.path.join(output_dir, f"{video_title}_clip_{i+1}.framing.json")

            # Unpadded cut: the bake input (re-encoding for frame precision)
            cut_command = [
                'ffmpeg', '-y',
                '-ss', str(start),
                '-to', str(end),
                '-i', input_video,
                # Dense keyframes (every 0.5s @30fps) so the web editor's
                # seeks decode fast — long GOPs cause a multi-second black
                # flash on layout switch in the live preview. Negligible
                # size cost; this cut also serves as the editor-source fallback.
                '-c:v', 'libx264', '-crf', '12', '-preset', 'ultrafast',
                '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
                '-c:a', 'aac',
                clip_cut_path
            ]
            subprocess.run(cut_command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

            # Padded cut: the editor's source (extend headroom on both sides)
            EXTEND_PAD_SECONDS = 3.0
            pad_start = max(0.0, start - EXTEND_PAD_SECONDS)
            pad_end = min(duration, end + EXTEND_PAD_SECONDS)
            padded_cut_command = [
                'ffmpeg', '-y',
                '-ss', str(pad_start),
                '-to', str(pad_end),
                '-i', input_video,
                # Dense keyframes so the editor (which seeks this padded
                # source constantly) repaints fast after a layout switch.
                '-c:v', 'libx264', '-crf', '12', '-preset', 'ultrafast',
                '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
                '-c:a', 'aac',
                clip_source_path
            ]
            padded_result = subprocess.run(padded_cut_command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

            # If the padded cut failed, fall back to keeping the unpadded
            # cut as the editor source (no extend headroom, offset 0) so a
            # valid _source.mp4 always exists for the framing coordinates.
            if (padded_result.returncode != 0 or not os.path.exists(clip_source_path) or os.path.getsize(clip_source_path) == 0) and os.path.exists(clip_cut_path):
                print(f"   ⚠️  Padded source cut failed for clip {i+1}; using unpadded cut as editor source.")
                shutil.copyfile(clip_cut_path, clip_source_path)
                pad_start = start  # offset collapses to 0

            framing_source_override = None
            if os.path.exists(clip_source_path):
                src_cap = cv2.VideoCapture(clip_source_path)
                if src_cap.isOpened():
                    padded_frames = int(src_cap.get(cv2.CAP_PROP_FRAME_COUNT))
                    src_fps = src_cap.get(cv2.CAP_PROP_FPS) or 30.0
                    src_cap.release()
                    framing_source_override = {
                        'file': os.path.basename(clip_source_path),
                        'durationFrames': padded_frames,
                        'offsetFrames': int(round((start - pad_start) * src_fps)),
                    }
                else:
                    src_cap.release()

            # Process vertical (bakes from the unpadded cut; framing.json is
            # written in padded-source coordinates via the override)
            success = process_video_to_vertical(
                clip_cut_path, clip_final_path,
                framing_output_path=clip_framing_path,
                framing_source_override=framing_source_override,
                aspect_ratio=args.aspect_ratio,
            )

            if os.path.exists(clip_cut_path):
                os.remove(clip_cut_path)

            if success:
                print(f"   ✅ Clip {i+1} ready: {clip_final_path}")

    # Clean up original if requested
    if args.url and not args.keep_original and os.path.exists(input_video):
        os.remove(input_video)
        print(f"🗑️  Cleaned up downloaded video.")

    total_time = time.time() - script_start_time
    print(f"\n⏱️  Total execution time: {total_time:.2f}s")
