"""Check a render before sharing it.  usage: review.py trailer.mp4 [plan.json]
Writes trailer_sheet.jpg: 20 frames spread over the whole trailer (last one on the ending), each labelled with its time.
Prints the running order and the captions exactly as they appear on screen (from trailer_captions.json).
With the plan, it also checks every caption block against the faces under it (trailer_faces.jpg shows any it flags).
Check: captions never cover a face, each bite starts and ends on a full sentence, length is 60-95 s, ends on black."""
import io, json, os, subprocess, sys
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont
from common import load_plan, probe, words, CACHE
import captions as C


def grab(src, t, w, h):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", src, "-frames:v", "1", "-vf", f"scale={w}:{h}",
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3) if len(raw) == w * h * 3 else None


def face_check(vid, plan):
    """Captions must never cover a face. For each caption block, compare a trailer frame (with captions) to the same
    source frame (without), so the difference is exactly the caption; then find the faces in the source frame."""
    W, H = 960, 540
    det = cv2.FaceDetectorYN.create(os.path.join(CACHE, "yunet.onnx"), "", (W, H), 0.8)   # real faces score ~0.9; hands ~0.5-0.7
    timeline, _ = C.place_bites(plan["bites"])
    blocks = C.build_blocks(timeline, words(plan["transcript"]))
    wide = plan.get("aspect", "16:9") != "9:16"
    flagged, skipped, checked = [], 0, 0
    for bl in blocks:
        for t in (bl["s"] + (bl["e"] - bl["s"]) * 0.6, bl["e"] - 0.2):   # most words on screen, before the exit
            t0, b = [(a, b) for a, b in timeline if a <= t][-1]
            if not wide or b.get("zoom") or t < bl["s"]:
                skipped += not wide or bool(b.get("zoom")); continue
            fr, src = grab(vid, t, W, H), grab(plan["source"], b["start"] + t - t0, W, H)
            if fr is None or src is None: continue
            checked += 1
            cap = cv2.dilate((np.abs(fr.astype(int) - src.astype(int)).max(2) > 60).astype(np.uint8), np.ones((5, 5), np.uint8))
            cap[: int(H * (C.TOP_FRAC[wide] - 0.04))] = 0   # captions only live in the caption zone; ignore motion elsewhere
            cap[int(H * (C.LIMIT_FRAC[wide] + 0.02)):] = 0
            _, faces = det.detect(src)
            for f in faces if faces is not None else []:
                x, y, w, h = (int(v) for v in f[:4])
                x0, y0 = max(0, x), max(0, y)
                cover = cap[y0:y + h, x0:x + w].mean() if w > 0 and h > 0 else 0
                if cover > 0.02:
                    im = fr.copy(); cv2.rectangle(im, (x, y), (x + w, y + h), (0, 0, 255), 3)
                    flagged.append((t, bl, cover, im)); break
            else:
                continue
            break
    print(f"\nfaces vs captions: {checked} frames checked" + (f", {skipped} skipped (9:16 / zoom: check those by eye)" if skipped else ""))
    if not flagged:
        print("  ok: no caption covers a face")
        return
    for t, bl, cover, _ in flagged:
        print(f"  {t:5.1f}s  covers {cover:.0%} of a face: \"{' '.join(w['w'] for w in bl['words'])}\"  <-- fix")
    sheet = np.vstack([im for *_, im in flagged[:6]])
    out = vid.rsplit(".", 1)[0] + "_faces.jpg"
    cv2.imwrite(out, sheet)
    print(f"  see {out}. Fix: fewer words per block (lower `gap`, `drop` filler), smaller `big` words, or a different bite")


vid = sys.argv[1]
_, _, _, dur = probe(vid)
ts = [dur * (i + 0.5) / 20 for i in range(19)] + [dur - 0.3]
tiles = []
for t in ts:
    b = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", vid, "-frames:v", "1", "-vf", "scale=480:-2",
                        "-f", "image2pipe", "-vcodec", "mjpeg", "-"], capture_output=True).stdout
    im = Image.open(io.BytesIO(b)).convert("RGB"); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 92, 26], fill=(0, 0, 0)); d.text((6, 3), f"{t:5.1f}s", fill=(255, 220, 0), font=ImageFont.load_default(20))
    tiles.append(im)
w, h = tiles[0].size
sheet = Image.new("RGB", (w * 4, h * 5))
for i, im in enumerate(tiles):
    sheet.paste(im, ((i % 4) * w, (i // 4) * h))
out = vid.rsplit(".", 1)[0] + "_sheet.jpg"
sheet.save(out, quality=85)
print(f"length {dur:.1f}s   sheet: {out}")
if len(sys.argv) > 2:
    plan = load_plan(sys.argv[2]); t = 0
    print("\nrunning order")
    for b in plan["bites"]:
        d = b["end"] - b["start"]
        print(f"{t:5.1f}s {b['id']:>3} {b.get('role', ''):<12} {b.get('speaker', '')[:18]:<18} {d:4.1f}s  src {int(b['start'] // 60)}:{b['start'] % 60:04.1f}")
        t += d
    share = {}
    for b in plan["bites"]:
        share[b.get("speaker", "?")] = share.get(b.get("speaker", "?"), 0) + b["end"] - b["start"]
    print("\nspeaking time by speaker (in a guest episode the guest should be 50% or more)")
    for k, v in sorted(share.items(), key=lambda kv: -kv[1]):
        print(f"  {v / t:4.0%}  {v:5.1f}s  {k}")
    g = plan.get("guest")
    if g:
        gs = share.get(g, 0) / t
        print(f"  guest '{g}': {gs:.0%}" + ("  <-- under 50%: give the guest more of the trailer" if gs < 0.5 else "  ok"))
    face_check(vid, plan)
cap = vid.rsplit(".", 1)[0] + "_captions.json"   # render.py writes this; for a HyperFrames render, rebuild from the plan
shown = json.load(open(cap)) if os.path.exists(cap) else []
if not shown and len(sys.argv) > 2:
    blocks = C.build_blocks(C.place_bites(plan["bites"])[0], words(plan["transcript"]))
    shown = [dict(s=bl["s"], text=" ".join(w["w"] for w in bl["words"]), roles=C.roles(bl)) for bl in blocks]
if shown:
    print("\ncaptions on screen ([WORD] = huge word)")
    for c in shown:
        ws = c["text"].split()
        rs = c.get("roles", ["lead"] * len(ws))
        print(f"{c['s']:5.1f}s  " + " ".join(f"[{w.upper()}]" if r == "big" else w for w, r in zip(ws, rs)))
