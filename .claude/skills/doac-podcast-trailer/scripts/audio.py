"""Build the trailer's audio: dialogue bites with click-free edges, a quiet music bed, sub booms.
usage: audio.py plan.json [audio_mix.wav]
Optional plan keys: "music": path to a licensed track (used instead of the synth pad), "music_db": its level (default -24).
Bite keys: "boom": true puts a sub hit at the start of that bite. "fade_in"/"fade_out" (seconds, default 0.025)
lengthen a bite's edge fade, e.g. 0.1 when the next speaker starts right on top of the last word. The bed always drops out before the last bite."""
import os, subprocess, sys
import numpy as np
from common import load_plan

SR, FPS = 48000, 30
plan = load_plan(sys.argv[1])
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "audio_mix.wav")
END_HOLD = plan.get("end_hold", 1.2)


def load(src, a, d, ch=2):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{a:.3f}", "-i", src, "-t", f"{d:.3f}",
                          "-vn", "-ac", str(ch), "-ar", str(SR), "-f", "f32le", "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, ch).copy()


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
if plan.get("music"):
    m = load(plan["music"], 0, N / SR + 1).mean(1)[:N]
    m = np.pad(m, (0, N - len(m)))
    m *= 10 ** (plan.get("music_db", -24) / 20) / max(np.sqrt(np.mean(m ** 2)), 1e-6)
    bed = m * env
else:  # placeholder: slow detuned minor pad (A2 C3 E3 A3)
    bed = np.zeros(N, np.float32)
    for fz, a in ((110, 1), (130.81, .7), (164.81, .6), (220, .35)):
        for det in (-0.6, 0.6):
            bed += a * np.sin(2 * np.pi * (fz + det) * T + det)
    bed *= (0.55 + 0.45 * np.sin(2 * np.pi * T / 7.5) ** 2) * env * 10 ** (-33 / 20) / 3

hits = np.zeros(N, np.float32)
rng = np.random.default_rng(1)
for t0, b in marks:
    if not b.get("boom"): continue
    i0 = int(t0 * SR); L = int(1.8 * SR); tt = np.arange(L) / SR
    s = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-tt * 9)) / SR) * np.exp(-tt * 2.2)
    s += rng.normal(0, 1, L) * np.exp(-tt * 40) * 0.25
    j = min(N, i0 + L)
    hits[i0:j] += (s * 10 ** (-12 / 20))[: j - i0].astype(np.float32)

mix = dlg + (bed + hits)[:, None]
mix /= max(1.0, np.abs(mix).max() / 0.97)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", str(SR), out], input=mix.astype(np.float32).tobytes(), check=True)
print(f"audio {N / SR:.1f}s -> {out}")
