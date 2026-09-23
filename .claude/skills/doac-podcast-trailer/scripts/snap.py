"""Move every bite's start/end to the quietest point between words, so no cut clips a syllable.
usage: snap.py plan.json [--force]   (edits the plan in place; prints the before/after and the loudness at each cut)
Safe to re-run: bites already snapped (or marked "lock": true after a hand fix) are left alone unless their
start/end changed since. --force re-snaps everything except locked bites.
A cut is clean when its rms is under ~0.01. Higher means the cut lands in speech. Then:
  - look for a nearby sentence start/end with a real pause and move the bite there, or
  - if Whisper's word times look stretched at that edge (a word lasting >0.6 s), re-transcribe a 2 s clip
    around it to find the true boundary, set start/end by hand, and add "lock": true."""
import json, os, subprocess, sys, wave
import numpy as np
from common import load_plan, words

path = sys.argv[1]
force = "--force" in sys.argv
raw = json.load(open(path))
plan = load_plan(path)
wav = os.path.join(os.path.dirname(plan["transcript"]), "audio.wav")
if not os.path.exists(wav):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", plan["source"], "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
w = wave.open(wav); SR = w.getframerate()
A = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
ws = words(plan["transcript"])


def rms(t):
    i = int(t * SR); h = int(0.015 * SR)
    return float(np.sqrt(np.mean(A[max(0, i - h):i + h] ** 2)))


def best(lo, hi):
    ts = np.arange(lo, max(hi, lo + 0.02), 0.01)
    r = np.array([rms(t) for t in ts])
    return float(ts[r.argmin()]), float(r.min())


bites = raw["bites"] if isinstance(raw, dict) else raw
for b in bites:
    if b.get("lock"):
        print(f"{b.get('id')}: locked, left as is"); continue
    if not force and b.get("_snapped") == [b["start"], b["end"]]:
        print(f"{b.get('id')}: already snapped"); continue
    inside = [x for x in ws if b["start"] - 0.05 <= x["s"] < b["end"] - 0.05]
    if not inside:
        print(b.get("id"), "no words inside, skipped"); continue
    prev = [x for x in ws if x["e"] <= inside[0]["s"] + 0.01]
    nxt = [x for x in ws if x["s"] >= inside[-1]["e"] - 0.01 and x is not inside[-1]]
    lo = max(prev[-1]["e"] - 0.1, inside[0]["s"] - 0.35) if prev else inside[0]["s"] - 0.35
    s0, r0 = best(lo, inside[0]["s"] + 0.06)
    e0, r1 = best(inside[-1]["e"] - 0.06, min(inside[-1]["e"] + 0.4, nxt[0]["s"] + 0.1 if nxt else 1e9))
    # never trade a quieter hand-placed cut for a louder one
    c0, c1 = rms(b["start"] + 0.03), rms(b["end"] - 0.03)
    if c0 <= r0: s0, r0 = b["start"] + 0.03, c0
    if c1 <= r1: e0, r1 = b["end"] - 0.03, c1
    flag = "  <-- check" if max(r0, r1) > 0.01 else ""
    print(f"{b.get('id')}: start {b['start']:.2f}->{s0 - 0.03:.2f} (rms {r0:.4f})  end {b['end']:.2f}->{e0 + 0.03:.2f} (rms {r1:.4f}){flag}")
    b["start"], b["end"] = round(s0 - 0.03, 3), round(e0 + 0.03, 3)
    b["_snapped"] = [b["start"], b["end"]]
json.dump(raw, open(path, "w"), indent=1)
