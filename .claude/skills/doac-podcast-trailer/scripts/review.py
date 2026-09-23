"""Check a render before sharing it.  usage: review.py trailer.mp4 [plan.json]
Writes trailer_sheet.jpg: 20 frames spread over the whole trailer (last one on the ending), each labelled with its time.
Prints the running order and the captions exactly as they appear on screen (from trailer_captions.json).
Check: captions never cover a face, each bite starts and ends on a full sentence, length is 60-95 s, ends on black."""
import io, json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
from common import load_plan, probe

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
cap = vid.rsplit(".", 1)[0] + "_captions.json"
if os.path.exists(cap):
    print("\ncaptions on screen ([WORD] = huge word)")
    for c in json.load(open(cap)):
        words = c["text"].split()
        roles = c.get("roles", ["lead"] * len(words))
        print(f"{c['s']:5.1f}s  " + " ".join(f"[{w.upper()}]" if r == "big" else w for w, r in zip(words, roles)))
