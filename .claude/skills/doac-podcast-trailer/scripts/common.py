"""Shared helpers: plan loading, cache paths, source probing."""
import json, os, re, subprocess

CACHE = os.environ.get("DOAC_CACHE", os.path.expanduser("~/.cache/doac-trailer"))
FONTS = os.path.join(CACHE, "fonts")


def load_plan(path):
    """A plan is {"source", "transcript", "aspect", "bites": [...]} (a bare list of bites also works)."""
    p = json.load(open(path))
    if isinstance(p, list):
        p = {"bites": p}
    base = os.path.dirname(os.path.abspath(path))
    for k, d in (("source", "original.mp4"), ("transcript", "transcript.json")):
        v = p.get(k, d)
        p[k] = v if os.path.isabs(v) else os.path.join(base, v)
    p.setdefault("aspect", "16:9")
    for i, b in enumerate(p["bites"], 1):
        b.setdefault("id", str(i))
    return p


def words(transcript):
    return [w for s in json.load(open(transcript)) for w in s["words"]]


def probe(src):
    """(width, height, fps, duration) of the first video stream, via ffmpeg (ffprobe may be missing)."""
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", src], capture_output=True, text=True).stderr
    w, h = map(int, re.search(r"Video:.*?(\d{3,5})x(\d{3,5})", err).groups())
    fps = float(re.search(r"([\d.]+) fps", err).group(1))
    hh, mm, ss = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err).groups()
    return w, h, fps, int(hh) * 3600 + int(mm) * 60 + float(ss)
