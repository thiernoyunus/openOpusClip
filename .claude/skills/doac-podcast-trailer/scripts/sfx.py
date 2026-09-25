"""Sound effects from HyperFrames' sound library, placed on the trailer's cuts.
usage: sfx.py plan.json        (after setup.sh and `source ~/.cache/doac-trailer/env.sh`; before hyperframes.py)

Bite keys (see reference/plan-format.md):
  "boom": true      a deep impact that hits on the bite's first frame (2-4 turning points)
  "riser": 2.5      a build that peaks on the bite's first frame, starting that many seconds before it (true = 2.5)
  "whoosh": true    a whoosh that peaks on the cut into the bite (a change of scene or mood)
Signed in to HeyGen (`hyperframes auth login`, or $HEYGEN_API_KEY), every sound is searched in HeyGen's sound library.
Otherwise HyperFrames' bundled, free-to-use effects are used. Plan "sounds" can change what is searched for, per kind:
  "sounds": {"boom": {"heygen": "deep trailer boom", "bundled": "impact-bass-2"}}   or   {"boom": "my-boom.wav"} (your own file)

Writes sfx/ next to the plan: each sound trimmed, levelled and faded as its own .wav, plus sfx.json with where each one
goes on the trailer. hyperframes.py puts each one on the timeline as its own clip (movable, with its own volume);
audio.py --sfx mixes them in for the Python fallback."""
import json, os, subprocess, sys
import numpy as np
from common import load_plan
import captions as C

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
SOUNDS = {   # what to search for when signed in / which bundled effect to use
    "boom": {"heygen": "deep cinematic boom impact", "bundled": "impact-bass-1"},
    "riser": {"heygen": "cinematic tension riser", "bundled": "riser"},
    "whoosh": {"heygen": "cinematic whoosh transition", "bundled": "whoosh"},
}
LEVEL = {"boom": -14, "riser": -21, "whoosh": -20}   # dBFS RMS around each sound's peak; the dialogue sits at -14 LUFS
CEIL = 10 ** (-1 / 20)   # dialogue + effects never go above -1 dB
TAIL = {"boom": 2.5, "riser": 0.3, "whoosh": 0.8}      # seconds kept after the peak


def decode(path):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def peak_time(x):
    """Where the sound hits hardest: the loudest 50 ms."""
    w = int(0.05 * SR)
    env = np.sqrt(np.convolve(x ** 2, np.ones(w) / w, mode="same"))
    return int(np.argmax(env)) / SR, env


def main():
    plan_path = sys.argv[1]
    plan = load_plan(plan_path)
    base = os.path.dirname(os.path.abspath(plan_path))
    outdir = os.path.join(base, "sfx")
    timeline, total = C.place_bites(plan["bites"])
    total += plan.get("end_hold", 1.2)
    cues = []
    for t0, b in timeline:
        t = round(t0 * C.FPS) / C.FPS   # the bite's first frame, as hyperframes.py places it
        for kind in SOUNDS:
            v = b.get(kind)
            if v:
                cues.append((kind, b["id"], t, 2.5 if (kind == "riser" and v is True) else float(v)))
    if not cues:
        json.dump({"mode": "none", "sounds": []}, open(os.path.join(base, "sfx.json"), "w"), indent=1)
        print("no boom / riser / whoosh in the plan: no sound effects")
        return

    kinds = sorted({c[0] for c in cues})
    custom = plan.get("sounds", {})
    want = {k: {**SOUNDS[k], **(custom[k] if isinstance(custom.get(k), dict) else {})} for k in kinds}
    files, notes, mode = {}, [], "own files"
    lib = {k: q for k, q in want.items() if not isinstance(custom.get(k), str)}
    if lib:
        r = subprocess.run(["node", os.path.join(HERE, "sounds.mjs"), outdir, json.dumps(lib)], capture_output=True, text=True)
        try:
            got = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            got = {"mode": "none", "files": {}, "notes": [r.stderr.strip()[-300:] or "sounds.mjs failed"]}
        files.update(got["files"]); notes += got["notes"]; mode = got["mode"]
    for k in kinds:
        if isinstance(custom.get(k), str):
            p = custom[k] if os.path.isabs(custom[k]) else os.path.join(base, custom[k])
            files[k] = p

    # The dialogue track (audio.py, run first) is what each sound lands on: HyperFrames adds the clips up without a
    # limiter, so each sound is turned down just enough that dialogue + effects stay under -1 dB.
    dlg_path = os.path.join(base, "audio_mix.wav")
    if not os.path.exists(dlg_path):
        sys.exit("run audio.py first: sfx.py fits each sound's level to the dialogue track (audio_mix.wav)")
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", dlg_path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    under = np.frombuffer(raw, np.float32).reshape(-1, 2).copy()
    placed = []
    for i, (kind, bid, t, amount) in enumerate(cues):
        if kind not in files or not os.path.exists(files[kind]):
            notes.append(f"{kind} on bite {bid}: no sound found, skipped")
            continue
        x = decode(files[kind])
        pk, env = peak_time(x)
        before = pk if kind == "boom" else min(pk, amount if kind == "riser" else 0.6)
        a = int((pk - before) * SR)
        e = min(len(x), int((pk + TAIL[kind]) * SR))
        y = x[a:e]
        g = 10 ** ((LEVEL[kind] - 20 * np.log10(max(env[int(pk * SR)], 1e-6))) / 20)
        y = y * min(g, 8.0)
        f = min(len(y), int(0.08 * SR)); y[-f:] *= np.linspace(1, 0, f, dtype=np.float32)   # no click at the end
        if kind != "boom":
            f = min(len(y), int(0.02 * SR)); y[:f] *= np.linspace(0, 1, f, dtype=np.float32)
        start = t - before
        if start < 0:   # a sound on the very first bite can't start before the trailer does
            y = y[int(-start * SR):]; start = 0.0
        y = y[: int((total - start) * SR)]
        i0 = int(start * SR); j = min(len(under), i0 + len(y)); y = y[: j - i0]
        seg = under[i0:j]
        lo, hi = 0.0, 1.0
        if np.abs(seg + y[:, None]).max() > CEIL:   # find the loudest level that still fits
            for _ in range(20):
                m = (lo + hi) / 2
                lo, hi = (m, hi) if np.abs(seg + m * y[:, None]).max() <= CEIL else (lo, m)
            y = y * lo
            if lo < 0.5:
                notes.append(f"{kind} on bite {bid}: turned down {20 * np.log10(max(lo, 1e-6)):.0f} dB to fit under loud dialogue")
        under[i0:j] += y[:, None]
        name = f"{i + 1:02d}-{kind}-{bid}.wav".replace("/", "-")
        path = os.path.join(outdir, name)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                        "-ac", "2", "-c:a", "pcm_s16le", path], input=y.astype(np.float32).tobytes(), check=True)
        placed.append({"kind": kind, "bite": bid, "file": path, "start": round(start, 4), "dur": round(len(y) / SR, 4)})
    json.dump({"mode": mode, "sounds": placed, "notes": notes}, open(os.path.join(base, "sfx.json"), "w"), indent=1)
    src = {"heygen": "your HeyGen sound library", "bundled": "HyperFrames' built-in effects"}.get(mode, mode)
    print(f"{len(placed)} sound effects from {src} -> sfx.json")
    for n in notes:
        print("  note:", n)
    if mode == "bundled":
        print("  Tip for the person: sign in to HeyGen (`hyperframes auth login`) to pick from its full sound library.")


if __name__ == "__main__":
    main()
