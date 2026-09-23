"""Turn the plan into a HyperFrames project you can preview, tweak and render.
usage: hyperframes.py plan.json outdir/        (run audio.py first; it writes audio_mix.wav next to the plan)

  cd outdir && npx hyperframes preview      live Studio: scrub, retime clips, edit caption text and style
  cd outdir && npx hyperframes render -o trailer.mp4

What it writes:
  index.html              the edit: one muted <video> per bite, the soundtrack, and the captions layer
  compositions/captions.html   every caption as HTML text (a block per phrase with data-start/data-duration,
                          a span per word with data-at), plus the caption style block
  assets/clips/NN-*.mp4   each bite pre-cut from the source (frame-accurate, 30 fps, muted)
  assets/audio_mix.wav    the soundtrack from audio.py (dialogue, bed, booms, -14 LUFS)
  assets/fonts/           Montserrat, Anton, Playfair Display (from ~/.cache/doac-trailer/fonts)
  assets/vendor/          GSAP (the animation library HyperFrames drives), so nothing loads from the network

The caption look (fonts, colours, sizes, shadow, placement, animation timing) lives in one block at the top of
compositions/captions.html: <style id="caption-style">. Caption grouping and roles come from captions.py, the same code render.py
uses, so both paths show the same words in the same blocks. 16:9 bites are the untouched full frame; 9:16 and
per-bite "zoom" framing are baked into the clip with render.py's crop maths.
"""
import html, json, math, os, re, shutil, subprocess, sys
from common import load_plan, words, probe, FONTS
import captions as C

from PIL import ImageFont   # font metrics, so caption lines break exactly where render.py breaks them


def frames(t):
    return int(round(t * C.FPS))


def secs(n_frames):
    """Frame n's time, rounded down to 0.1 ms: a clip must already be on screen at exactly n/30 s."""
    return f"{math.floor(n_frames / C.FPS * 1e4) / 1e4:.4f}"


def num(x):
    return f"{x:.3f}"


# ---------- clips ----------
def cut_plain(src, b, n, sw, sh, out):
    """Full frame, no crop: the same ffmpeg decode render.py uses (input seek, scale, 30 fps), encoded."""
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{b['start']:.3f}", "-i", src, "-t", f"{b['dur'] + 0.5:.3f}",
                    "-vf", f"scale={sw}:{sh}", "-r", str(C.FPS), "-frames:v", str(n), "-an",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-g", "15", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", out], check=True)


def cut_reframed(src, b, n, sw, sh, W, H, out):
    """9:16 speaker crop or a zoom: render.py's per-frame crop maths, baked into the clip."""
    import numpy as np, cv2
    dec = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", f"{b['start']:.3f}", "-i", src, "-t", f"{b['dur'] + 0.5:.3f}",
                            "-vf", f"scale={sw}:{sh}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-r", str(C.FPS), "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
                            "-r", str(C.FPS), "-i", "-", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-g", "15",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    shots = b.get("shots") or [[0, b.get("cx", 0.5)]]
    cy = b.get("cy", 0.5)
    z0, z1 = b.get("zoom", (1.0, 1.0))
    last = None
    for k in range(n):
        raw = dec.stdout.read(sw * sh * 3)
        img = np.frombuffer(raw, np.uint8).reshape(sh, sw, 3) if len(raw) == sw * sh * 3 else last
        last = img
        lt = k / C.FPS
        if "track" in b:
            tr = b["track"]; cx = float(np.interp(lt, [p[0] for p in tr], [p[1] for p in tr]))
        else:
            cx = [s[1] for s in shots if s[0] <= lt][-1]
        zp = lt / b["dur"]; zp = zp * zp * (3 - 2 * zp)
        z = z0 + (z1 - z0) * zp
        ch = sh / z; cw = ch * W / H
        x0 = min(max(cx * sw - cw / 2, 0), sw - cw)
        y0 = min(max(cy * sh - ch / 2, 0), sh - ch)
        s = W / cw
        M = np.float32([[s, 0, -x0 * s], [0, s, -y0 * s]])
        enc.stdin.write(cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE).tobytes())
    dec.kill(); enc.stdin.close(); enc.wait()


# ---------- caption lines (same line breaks as render.py) ----------
class Measure:
    """Ink widths with the fonts render.py uses, so lines break in the same places."""
    def __init__(self, base_px):
        self.base = base_px; self.big = {}
        self.lead = ImageFont.truetype(f"{FONTS}/Montserrat.ttf", int(base_px * C.LEAD_SCALE)); self.lead.set_variation_by_name("ExtraBold")
        self.tail = ImageFont.truetype(f"{FONTS}/PlayfairDisplay-Italic.ttf", int(base_px * C.TAIL_SCALE)); self.tail.set_variation_by_name("SemiBold Italic")

    def width(self, text, role):
        if role == "big":
            size = C.big_size(len(re.sub(r"\W", "", text)), self.base)
            if size not in self.big: self.big[size] = ImageFont.truetype(f"{FONTS}/Anton-Regular.ttf", size)
            f = self.big[size]
        else:
            f = self.lead if role == "lead" else self.tail
        l, _, r, _ = f.getbbox(text)
        return r - l

    def overhang(self, text, role):
        """How far the letters stick out of the word's box, (left, right) px. render.py spaces words by their ink,
        CSS by their box, so italic words (which lean out of their box, like the tail of an f) need more room."""
        f = self.lead if role == "lead" else self.tail if role == "tail" else None
        if f is None: return 0.0, 0.0
        l, _, r, _ = f.getbbox(text)
        return -l, r - f.getlength(text)

    def learn(self, blocks):
        """Average overhang per role: goes into the role's word gap; words far from it get their own margin."""
        self.mean = {}
        for role in ("lead", "tail"):
            o = [self.overhang(w["w"], r) for bl in blocks for w, r in zip(bl["words"], C.roles(bl)) if r == role] or [(0, 0)]
            self.mean[role] = (sum(x[0] for x in o) / len(o), sum(x[1] for x in o) / len(o))


def block_html(i, bl, measure, wide, prev_end):
    """One caption block: a timed group, its lines, and one span per word (data-at = when the word appears)."""
    rs = C.roles(bl)
    items = []
    for w, r in zip(bl["words"], rs):
        shown = C.display_text(w, r)
        items.append(dict(w=w, r=r, shown=shown, iw=measure.width(shown, r)))
    lines = C.flow_lines(items, C.MAXW[wide], int(measure.base * C.GAP_SCALE))
    start = max(bl["s"] - 0.01, prev_end)       # render.py shows a block from 10 ms before its first word
    out = [f'    <div id="cap-{i:03d}" class="clip caption-group" data-start="{num(start)}" data-duration="{num(bl["e"] - start)}" data-track-index="0">'
           f'<div class="caption-block">']
    for ln in lines:
        spans = []
        for it in ln:
            cls = ["caption-word", it["r"]]
            if C.is_accent(bl, it["w"], it["r"]): cls.append("accent")
            style = ""
            if it["r"] in measure.mean:
                (ol, orr), (ml, mr) = measure.overhang(it["w"]["w"], it["r"]), measure.mean[it["r"]]
                m = [f"margin-{side}: {round(d)}px" for side, d in (("left", ol - ml), ("right", orr - mr)) if abs(d) >= 3]
                if m: style = f' style="{"; ".join(m)}"'
            if it["r"] == "big":
                fit = C.big_size(len(re.sub(r"\W", "", it["shown"])), measure.base) / measure.base
                if fit < 1: style = f' style="--fit: {fit:.4f}"'
                text = it["w"]["w"].strip('.,;:!"')     # CSS upper-cases big words, so the text stays easy to edit
            else:
                text = it["shown"]
            spans.append(f'<span class="{" ".join(cls)}" data-at="{num(it["w"]["s"])}"{style}>{html.escape(text)}</span>')
        out.append(f'      <div class="caption-line {ln[0]["r"]}">{" ".join(spans)}</div>')
    out[-1] += "</div></div>"
    return "\n".join(out)


# ---------- files ----------
CAPTIONS = """<!-- Captions for the DOAC trailer (made by hyperframes.py; regenerating overwrites this file).
     Each .caption-group is one caption block: data-start / data-duration in seconds on the trailer timeline.
     Each .caption-word appears at its data-at time. Word roles: lead (small bold), big (huge caps), tail (italic);
     .accent = gold. Edit the words freely; restyle everything in the CAPTION STYLE block below. -->
<template>
  <!-- ======================= CAPTION STYLE: fonts, colours, sizes, placement, motion ======================= -->
  <style id="caption-style">
    @font-face { font-family: "Montserrat"; src: url("assets/fonts/Montserrat.ttf") format("truetype"); font-weight: 100 900; }
    @font-face { font-family: "Anton"; src: url("assets/fonts/Anton-Regular.ttf") format("truetype"); }
    @font-face { font-family: "Playfair Display"; src: url("assets/fonts/PlayfairDisplay-Italic.ttf") format("truetype"); font-style: italic; font-weight: 400 900; }
    #captions-root {
      /* type: size in px at %(W)dx%(H)d; line = the font's own height (x font size); after = space under each line */
      --cap-lead-font: "Montserrat", sans-serif;   --cap-lead-weight: 800;  --cap-lead-size: %(lead)spx;  --cap-lead-line: %(lead_line)s;  --cap-lead-after: %(lead_after)sem;
      --cap-big-font: "Anton", sans-serif;         --cap-big-weight: 400;   --cap-big-size: %(big)spx;  --cap-big-line: %(big_line)s;  --cap-big-after: %(big_after)sem;
      --cap-tail-font: "Playfair Display", serif;  --cap-tail-weight: 600;  --cap-tail-size: %(tail)spx;  --cap-tail-line: %(tail_line)s;  --cap-tail-after: %(tail_after)sem;
      --cap-lead-gap: %(lead_gap)spx;  --cap-big-gap: %(gap)spx;  --cap-tail-gap: %(tail_gap)spx;   /* space between words */
      --cap-max-width: %(maxw)spx;
      /* colour */
      --cap-color: #ffffff;
      --cap-accent: rgb(%(accent)s);   /* gold, for the big words listed in a bite's "accent" */
      --cap-shadow: 0 0 3px rgba(0, 0, 0, 0.8), 0 2px 10px rgba(0, 0, 0, 1), 0 0 30px rgba(0, 0, 0, 0.8);   /* soft, hugs the letters; no box */
      /* placement: lower third, below the faces */
      --cap-top: %(top)spx;       /* top of each block (%(top_pct)s%% of the frame height) */
      --cap-bottom: %(limit)spx;  /* a tall block is pushed up so it never goes below this */
      /* motion (seconds / px), read by the script at the bottom */
      --cap-enter: %(enter)s;         /* each word fades in, rises, sharpens and settles over this long */
      --cap-enter-scale: %(escale)s;  /* ...from this scale to 1 */
      --cap-enter-rise: %(rise)s;     /* ...from this many px lower */
      --cap-enter-blur: %(eblur)s;     /* ...from this blur */
      --cap-exit: %(exit)s;           /* the block fades and blurs out over its last this-many seconds */
      --cap-exit-blur: %(xblur)s;
      position: absolute; inset: 0; width: %(W)dpx; height: %(H)dpx; pointer-events: none;
    }
    .caption-group { position: absolute; left: 0; top: 0; width: 100%%; height: var(--cap-bottom);
                     display: flex; flex-direction: column; align-items: center; }
    .caption-group::before { content: ""; flex: 0 1 var(--cap-top); min-height: 0; }
    .caption-block { flex: none; display: flex; flex-direction: column; align-items: center; }
    .caption-line { display: flex; justify-content: center; align-items: baseline;
                    max-width: var(--cap-max-width); white-space: nowrap; }
    .caption-line.lead { column-gap: var(--cap-lead-gap); }
    .caption-line.big  { column-gap: var(--cap-big-gap); }
    .caption-line.tail { column-gap: var(--cap-tail-gap); }
    .caption-word { display: inline-block; color: var(--cap-color); text-shadow: var(--cap-shadow); transform-origin: 50%% 50%%; }
    .caption-word.lead { font-family: var(--cap-lead-font); font-weight: var(--cap-lead-weight); font-size: var(--cap-lead-size);
                         line-height: var(--cap-lead-line); margin-bottom: var(--cap-lead-after); }
    .caption-word.big  { font-family: var(--cap-big-font); font-weight: var(--cap-big-weight); font-size: calc(var(--cap-big-size) * var(--fit, 1));
                         line-height: var(--cap-big-line); margin-bottom: var(--cap-big-after); text-transform: uppercase; }
    .caption-word.tail { font-family: var(--cap-tail-font); font-style: italic; font-weight: var(--cap-tail-weight);
                         font-size: var(--cap-tail-size); line-height: var(--cap-tail-line); margin-bottom: var(--cap-tail-after); }
    .caption-word.accent { color: var(--cap-accent); }
  </style>
  <!-- ======================= end of caption style ======================= -->

  <div id="captions-root" data-composition-id="captions" data-width="%(W)d" data-height="%(H)d">
%(caps)s
  </div>

  <script>
    (() => {
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      const root = document.getElementById("captions-root");
      const css = getComputedStyle(root);
      const v = (name) => parseFloat(css.getPropertyValue(name));
      const ENTER = v("--cap-enter"), SCALE = v("--cap-enter-scale"), RISE = v("--cap-enter-rise"), BLUR = v("--cap-enter-blur");
      const EXIT = v("--cap-exit"), EXIT_BLUR = v("--cap-exit-blur");
      root.querySelectorAll(".caption-group").forEach((group) => {
        const start = parseFloat(group.dataset.start), end = start + parseFloat(group.dataset.duration);
        const block = group.querySelector(".caption-block");
        group.querySelectorAll(".caption-word").forEach((word) => {
          tl.fromTo(word, { opacity: 0, scale: SCALE, y: RISE, filter: `blur(${BLUR}px)` },
                          { opacity: 1, scale: 1, y: 0, filter: "blur(0px)", duration: ENTER, ease: "power2.out" }, parseFloat(word.dataset.at));
        });
        if (end - start > 0.31) {   // blocks shorter than 0.3 s just cut
          tl.fromTo(block, { opacity: 1 }, { opacity: 0, duration: EXIT, ease: "power1.in", immediateRender: false }, end - EXIT);
          tl.fromTo(block, { filter: "blur(0px)" }, { filter: `blur(${EXIT_BLUR}px)`, duration: EXIT, ease: "none", immediateRender: false }, end - EXIT);
        }
        tl.set(block, { opacity: 0, visibility: "hidden" }, end);   // hard stop at the block's end
      });
      tl.set({}, {}, %(total)s);
      window.__timelines["captions"] = tl;
    })();
  </script>
</template>
"""

INDEX = """<!doctype html>
<!-- DOAC trailer from %(plan)s, made by hyperframes.py (regenerating overwrites this project's html).
     Preview / tweak:  npx hyperframes preview        Render:  npx hyperframes render -o trailer.mp4
     Bites are muted clips cut from the episode; all sound is the soundtrack (audio.py's mix).
     Captions and their style: compositions/captions.html -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=%(W)d, height=%(H)d" />
    <script src="%(gsap)s"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: %(W)dpx; height: %(H)dpx; overflow: hidden; background: #000; }
      #root { position: relative; width: %(W)dpx; height: %(H)dpx; overflow: hidden; background: #000; }
      .shot { position: absolute; inset: 0; }
      .bite { position: absolute; inset: 0; width: 100%%; height: 100%%; object-fit: cover; }
      #captions { position: absolute; inset: 0; z-index: 10; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="%(total)s" data-width="%(W)d" data-height="%(H)d">
      <!-- ============ BITES, in trailer order: one clip each (start/duration in seconds on the trailer) ============ -->
%(bites)s

      <!-- ============ SOUNDTRACK: dialogue + music bed + booms at -14 LUFS, from audio.py ============ -->
      <audio id="soundtrack" src="assets/audio_mix.wav" data-start="0" data-duration="%(total)s" data-track-index="2" data-volume="1"></audio>

      <!-- ============ CAPTIONS: text, timing and style live in compositions/captions.html ============ -->
      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-track-kind="captions"
           data-start="0" data-duration="%(total)s" data-track-index="1" data-width="%(W)d" data-height="%(H)d"></div>
      <!-- the last %(hold)s s are black -->
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      // focus pull: a bite with data-focus-pull="0.5" starts soft and sharpens over that many seconds
      document.querySelectorAll(".shot[data-focus-pull]").forEach((shot) => {
        const t0 = parseFloat(shot.querySelector("video").dataset.start), d = parseFloat(shot.dataset.focusPull);
        tl.fromTo(shot, { filter: "blur(9px)" }, { filter: "blur(0px)", duration: d, ease: "power1.out", immediateRender: false }, t0);
      });
      tl.set({}, {}, %(total)s);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
"""


GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"


def vendor_gsap(outdir):
    """A local copy of GSAP, so preview and render work offline (and behind proxies Chrome doesn't trust).
    Falls back to the CDN link HyperFrames' own templates use."""
    rel = "assets/vendor/gsap.min.js"
    path = os.path.join(outdir, rel)
    if not os.path.exists(path):
        try:
            import urllib.request
            data = urllib.request.urlopen(GSAP_URL, timeout=30).read()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "wb").write(data)
        except Exception as e:
            print(f"(could not download GSAP, using the CDN link: {e})")
            return GSAP_URL
    return rel


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    plan_path, outdir = sys.argv[1], sys.argv[2]
    plan = load_plan(plan_path)
    wide = plan["aspect"] == "16:9"
    W, H = (1920, 1080) if wide else (1080, 1920)
    base_px = C.base(wide)
    audio = plan.get("audio", os.path.join(os.path.dirname(os.path.abspath(plan_path)), "audio_mix.wav"))
    if not os.path.exists(audio):
        sys.exit(f"no soundtrack at {audio}: run audio.py {plan_path} first")
    for f in ("Montserrat.ttf", "Anton-Regular.ttf", "PlayfairDisplay-Italic.ttf"):
        if not os.path.exists(f"{FONTS}/{f}"):
            sys.exit(f"missing font {FONTS}/{f}: run setup.sh")
    src = plan["source"]
    sw0, sh0, _, _ = probe(src)
    sh = min(sh0, 1080); sw = int(round(sw0 * sh / sh0 / 2)) * 2   # render.py's decode size
    hold = plan.get("end_hold", 1.2)

    for d in ("assets/clips", "assets/fonts", "compositions"):
        os.makedirs(os.path.join(outdir, d), exist_ok=True)
    shutil.copy(audio, os.path.join(outdir, "assets/audio_mix.wav"))
    for f in ("Montserrat.ttf", "Anton-Regular.ttf", "PlayfairDisplay-Italic.ttf"):
        shutil.copy(f"{FONTS}/{f}", os.path.join(outdir, "assets/fonts", f))

    timeline, total = C.place_bites(plan["bites"])
    blocks = C.build_blocks(timeline, words(plan["transcript"]))

    # bites: frame-exact, as in render.py (bite k covers frames round(out0*30) up to round(out1*30))
    cache_path = os.path.join(outdir, "assets/clips/.cuts.json")   # skip re-cutting unchanged bites
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    keep, bite_html = {}, []
    for k, (out0, b) in enumerate(timeline, 1):
        f0, f1 = frames(out0), frames(out0 + b["dur"])
        slug = re.sub(r"[^a-z0-9]+", "-", str(b.get("role", "")).lower()).strip("-")[:24] or "bite"
        name = f"{k:02d}-{slug}.mp4"
        path = os.path.join(outdir, "assets/clips", name)
        key = json.dumps([src, b["start"], f1 - f0, wide, b.get("zoom"), b.get("track"), b.get("shots"), b.get("cx"), b.get("cy")])
        if not (os.path.exists(path) and cache.get(name) == key):
            print(f"cut {name}  src {b['start']:.2f}-{b['end']:.2f}  {f1 - f0} frames", flush=True)
            if wide and list(b.get("zoom", (1.0, 1.0))) == [1.0, 1.0]:
                cut_plain(src, b, f1 - f0, sw, sh, path)
            else:
                cut_reframed(src, b, f1 - f0, sw, sh, W, H, path)
        keep[name] = key
        fp = b.get("focus_pull", 0)
        pull = f' data-focus-pull="{fp}"' if fp else ""
        label = " / ".join(str(x) for x in (b["id"], b.get("role"), b.get("speaker")) if x)
        comment = html.escape(f"{label}: source {b['start']:.2f}-{b['end']:.2f}".replace("--", "-"))
        bite_html.append(
            f'      <!-- {comment} -->\n'
            f'      <div class="shot"{pull}><video id="bite-{k:02d}" class="bite" src="assets/clips/{name}" data-start="{secs(f0)}"'
            f' data-duration="{float(secs(f1)) - float(secs(f0)):.4f}" data-media-start="0" data-track-index="0" muted playsinline></video></div>')
    for f in os.listdir(os.path.join(outdir, "assets/clips")):   # clips of bites no longer in the plan
        if f.endswith(".mp4") and f not in keep:
            os.remove(os.path.join(outdir, "assets/clips", f))
    json.dump(keep, open(cache_path, "w"), indent=1)

    measure = Measure(base_px)
    measure.learn(blocks)
    nfr = frames(total) + int(hold * C.FPS)

    def line_ratio(f, px, k, var=None):
        """render.py stacks lines (ascent + descent) * k apart with the text at the top of each line:
        in CSS that is line-height = (ascent + descent) and a (k - 1) share of it as space after."""
        font = ImageFont.truetype(f"{FONTS}/{f}", px)
        if var: font.set_variation_by_name(var)
        a = sum(font.getmetrics()) / px
        return f"{a:.4f}", f"{a * (k - 1):.4f}"

    lead_px, tail_px = int(base_px * C.LEAD_SCALE), int(base_px * C.TAIL_SCALE)
    gap = int(base_px * C.GAP_SCALE)

    def role_gap(role):   # the CSS gap that gives render.py's gap between the letters, on average
        return f"{round((gap + sum(measure.mean[role])) * 2) / 2:g}"
    captions = CAPTIONS % dict(
        W=W, H=H, lead=lead_px, big=base_px, tail=tail_px,
        **dict(zip(("lead_line", "lead_after"), line_ratio("Montserrat.ttf", lead_px, C.LINE_OTHER, "ExtraBold"))),
        **dict(zip(("tail_line", "tail_after"), line_ratio("PlayfairDisplay-Italic.ttf", tail_px, C.LINE_OTHER, "SemiBold Italic"))),
        **dict(zip(("big_line", "big_after"), line_ratio("Anton-Regular.ttf", base_px, C.LINE_BIG))),
        accent=", ".join(str(c) for c in plan.get("accent_rgb", C.ACCENT_RGB)),
        top=int(H * C.TOP_FRAC[wide]), top_pct=round(C.TOP_FRAC[wide] * 100), limit=f"{H * C.LIMIT_FRAC[wide]:g}",
        maxw=C.MAXW[wide], gap=gap, lead_gap=role_gap("lead"), tail_gap=role_gap("tail"),
        enter=C.ENTER_S, escale=C.ENTER_SCALE, rise=f"{base_px * C.RISE:g}",
        eblur=f"{C.ENTER_BLUR / 2:g}", exit=C.EXIT_S, xblur=f"{C.EXIT_BLUR / 2:g}",   # render.py blur sigma = px / 2
        caps="\n".join(block_html(i, bl, measure, wide, blocks[i - 2]["e"] if i > 1 else 0) for i, bl in enumerate(blocks, 1)),
        total=secs(nfr))
    open(os.path.join(outdir, "compositions/captions.html"), "w").write(captions)
    open(os.path.join(outdir, "index.html"), "w").write(INDEX % dict(
        gsap=vendor_gsap(outdir), plan=html.escape(os.path.basename(plan_path)), W=W, H=H, total=secs(nfr), hold=hold, bites="\n".join(bite_html)))

    # project files, as `hyperframes init` writes them
    name = re.sub(r"[^a-z0-9-]+", "-", os.path.basename(os.path.abspath(outdir)).lower())
    files = {
        "hyperframes.json": {"$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
                             "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
                             "paths": {"blocks": "compositions", "components": "compositions/components", "assets": "assets"},
                             "media": {"autoProxy": True}},
        "meta.json": {"id": name, "name": name},
        "package.json": {"name": name, "private": True, "type": "module",
                         "scripts": {"dev": "npx --yes hyperframes preview", "check": "npx --yes hyperframes check",
                                     "render": "npx --yes hyperframes render -o trailer.mp4"}},
    }
    for f, data in files.items():
        p = os.path.join(outdir, f)
        if not os.path.exists(p):
            json.dump(data, open(p, "w"), indent=2)
    print(f"{len(timeline)} bites, {len(blocks)} caption blocks, {nfr / C.FPS:.2f}s -> {outdir}")


if __name__ == "__main__":
    main()
