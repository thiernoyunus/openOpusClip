"""Labelled frame sheets, for working out who is who and who is speaking.
usage: frames.py original.mp4 out.jpg T1 T2 ...          one frame per time
       frames.py original.mp4 out.jpg --burst T1 T2 ...   three frames 0.7 s apart per time (see whose mouth moves)
Times are seconds or mm:ss. Each tile is labelled with its time (works without ffmpeg's drawtext)."""
import io, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

src, out, args = sys.argv[1], sys.argv[2], sys.argv[3:]
burst = "--burst" in args
ts = []
for a in (x for x in args if x != "--burst"):
    t = sum(float(p) * 60 ** i for i, p in enumerate(reversed(a.split(":"))))
    ts += [t, t + 0.7, t + 1.4] if burst else [t]
ims = []
for t in ts:
    b = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", src, "-frames:v", "1", "-vf", "scale=640:-2",
                        "-f", "image2pipe", "-vcodec", "mjpeg", "-"], capture_output=True).stdout
    im = Image.open(io.BytesIO(b)).convert("RGB"); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 200, 34], fill=(0, 0, 0))
    d.text((6, 4), f"{int(t // 60)}:{t % 60:04.1f}", fill=(255, 220, 0), font=ImageFont.load_default(26))
    ims.append(im)
cols = 3; w, h = ims[0].size
sheet = Image.new("RGB", (w * cols, h * ((len(ims) + cols - 1) // cols)))
for i, im in enumerate(ims):
    sheet.paste(im, ((i % cols) * w, (i // cols) * h))
sheet.save(out, quality=85)
print(out)
