"""Build the trailer's dialogue track: the bites with click-free edges, at -14 LUFS, peaks held to -3 dB
(so the sound effects HyperFrames adds on top have room and never clip).
usage: audio.py plan.json [audio_mix.wav] [--sfx]
Sound effects are not mixed in here: sfx.py fetches them and hyperframes.py puts each one on the timeline as its own clip.
--sfx mixes sfx.json's sounds into this file instead (only for the Python fallback, render.py).
Optional plan keys: "music": path to a licensed track, laid quietly under the dialogue; "music_db": its level (default -24).
No music key means no music: there is no placeholder bed. The music always drops out before the last bite.
Bite keys: "fade_in"/"fade_out" (seconds, default 0.025) lengthen a bite's edge fade, e.g. 0.1 when the next speaker
starts right on top of the last word."""
import json, os, subprocess, sys
import numpy as np
from common import load_plan

SR, FPS = 48000, 30
args = [a for a in sys.argv[1:] if a != "--sfx"]
plan = load_plan(args[0])
out = args[1] if len(args) > 1 else os.path.join(os.path.dirname(os.path.abspath(args[0])), "audio_mix.wav")
END_HOLD = plan.get("end_hold", 1.2)


def load(src, a, d, ch=2):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{a:.3f}", "-i", src, "-t", f"{d:.3f}",
                          "-vn", "-ac", str(ch), "-ar", str(SR), "-f", "f32le", "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, ch).copy()


def limit(x, ceiling):
    """Hold every peak under `ceiling` (0.7 = -3 dB) with a smooth gain dip, instead of a hard clip."""
    B = 240   # 5 ms blocks
    n = -(-len(x) // B)
    pk = np.pad(np.abs(x).max(1), (0, n * B - len(x))).reshape(n, B).max(1)
    g = np.minimum(1, ceiling / np.maximum(pk, 1e-9))
    for k in (1, 2, 4):   # reach 20 ms around each peak so the dip starts before it
        g = np.minimum(g, np.minimum(np.r_[g[k:], np.ones(k)], np.r_[np.ones(k), g[:-k]]))
    gs = np.interp(np.arange(len(x)), np.arange(n) * B + B / 2, g)
    return (x * gs[:, None]).astype(np.float32)


parts, marks, t = [], [], 0.0
for b in plan["bites"]:
    d = b["end"] - b["start"]
    n = int(round((t + d) * FPS)) - int(round(t * FPS))   # match the video's frame count exactly
    n = int(round(n / FPS * SR))
    x = load(plan["source"], b["start"], n / SR + 0.1)[:n]
    if len(x) < n: x = np.vstack([x, np.zeros((n - len(x), 2), np.float32)])
    for key, edge in (("fade_in", 0), ("fade_out", 1)):   # 25 ms by default; longer to soften an overlapping voice
        f = max(1, int(b.get(key, 0.025) * SR))
        ramp = np.linspace(0, 1, f, dtype=np.float32)[:, None]
        if edge == 0: x[:f] *= ramp
        else: x[-f:] *= ramp[::-1]
    parts.append(x); marks.append((t, b)); t += n / SR
parts.append(np.zeros((int(END_HOLD * SR), 2), np.float32))
dlg = np.vstack(parts)
N = len(dlg); T = np.arange(N) / SR
rms = np.sqrt(np.mean(dlg[np.abs(dlg).max(1) > 0.01] ** 2))
dlg *= 10 ** (-18 / 20) / max(rms, 1e-6)

last_t = marks[-1][0]
env = np.clip(T / 3, 0, 1) * np.clip((last_t - 0.4 - T) / 0.8, 0, 1)   # fade in; drop out before the cliffhanger
bed = np.zeros(N, np.float32)
if plan.get("music"):
    m = load(plan["music"], 0, N / SR + 1).mean(1)[:N]
    m = np.pad(m, (0, N - len(m)))
    m *= 10 ** (plan.get("music_db", -24) / 20) / max(np.sqrt(np.mean(m ** 2)), 1e-6)
    bed = m * env

hits = np.zeros(N, np.float32)
if "--sfx" in sys.argv:   # Python fallback only: the same sounds hyperframes.py puts on the timeline
    fx = json.load(open(os.path.join(os.path.dirname(os.path.abspath(args[0])), "sfx.json")))
    for s in fx["sounds"]:
        y = load(s["file"], 0, s["dur"] + 0.1, 1)[:, 0]
        i0 = int(s["start"] * SR); j = min(N, i0 + len(y))
        hits[i0:j] += y[: j - i0]

mix = dlg + (bed + hits)[:, None]
mix /= max(1.0, np.abs(mix).max() / 0.97)
raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                      "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", str(SR), "-f", "f32le", "-"],
                     input=mix.astype(np.float32).tobytes(), capture_output=True, check=True).stdout
mix = limit(np.frombuffer(raw, np.float32).reshape(-1, 2).copy(), 0.89 if "--sfx" in sys.argv else 0.7)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                "-c:a", "pcm_s16le", out], input=mix.tobytes(), check=True)
print(f"audio {N / SR:.1f}s -> {out}")
