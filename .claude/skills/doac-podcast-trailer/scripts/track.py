"""9:16 only: follow the speaker's face inside each bite so the vertical crop stays on them.
usage: track.py plan.json   (edits the plan in place; needs each bite's "cx": 0-1, which side the speaker sits on)
Adds "track" [[t, cx], ...] with heavy smoothing and a dead zone, so the crop moves like a person on a tripod."""
import json, os, subprocess, sys
import numpy as np, cv2
from common import load_plan, CACHE

path = sys.argv[1]
raw = json.load(open(path)); plan = load_plan(path)
bites = raw["bites"] if isinstance(raw, dict) else raw
det = cv2.FaceDetectorYN.create(os.path.join(CACHE, "yunet.onnx"), "", (640, 360), 0.6)
for b in bites:
    d = b["end"] - b["start"]
    fr = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(b["start"]), "-i", plan["source"], "-t", str(d),
                         "-vf", "fps=10,scale=640:360", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True).stdout
    fr = np.frombuffer(fr, np.uint8).reshape(-1, 360, 640, 3)
    left = b.get("cx", 0.5) < 0.5
    xs = []
    for f in fr:
        _, faces = det.detect(f)
        c = [(x + w / 2) / 640 for x, y, w, h, *_ in (faces if faces is not None else []) if ((x + w / 2) / 640 < 0.5) == left]
        xs.append(c[0] if c else np.nan)
    xs = np.array(xs); ok = ~np.isnan(xs)
    if not ok.any():
        print(b["id"], "no face found on that side; keeping cx"); continue
    idx = np.arange(len(xs)); xs = np.interp(idx, idx[ok], xs[ok])
    k = 15
    sm = np.convolve(np.pad(xs, k, mode="edge"), np.ones(2 * k + 1) / (2 * k + 1), mode="same")[k:-k]
    cam = [float(np.median(xs[:20]))]
    for x in sm[1:]:
        c = cam[-1]
        if abs(x - c) > 0.035: c += (x - c - np.sign(x - c) * 0.035) * 0.15
        cam.append(c)
    b["cx"] = float(np.median(xs)); b["track"] = [[i / 10, round(c, 4)] for i, c in enumerate(cam)]
    print(b["id"], f"face found {ok.mean():.0%} of the time, cx {b['cx']:.2f}")
json.dump(raw, open(path, "w"), indent=1)
