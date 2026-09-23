"""Caption logic shared by both finishing paths (render.py draws it with PIL, hyperframes.py writes it as HTML).

- place_bites(bites)            output timeline: [(out_start, bite)], total seconds; sets bite["dur"]
- build_blocks(timeline, words) transcript words -> caption blocks (the on-screen groups), in output seconds
- roles(block)                  per word: "lead" (Montserrat), "big" (Anton caps), "tail" (Playfair italic)
- flow_lines(items, maxw, gap)  items [{"r": role, "iw": width}] -> lines; big words own a line
- style numbers (sizes, colours, timing) used by both renderers
"""
import re

# ---- style (both renderers read these) ----
FPS = 30
# accent colours: DOAC colours a word in almost every caption block, picked by what the word means
COLORS = {"red": (237, 41, 57), "yellow": (255, 214, 0), "green": (46, 204, 113), "pink": (255, 79, 163), "gold": (255, 196, 64)}
BOX_RGB = (226, 35, 45)       # "box": a white word on a red box, for the two or three strongest words
BOX_PAD = 0.10                # box padding left, right and above the capitals, as a fraction of the word's font size
BOX_DROP = {"big": 0.10, "lead": 0.26, "tail": 0.26}   # how far the box reaches below the baseline (room for g, y, p)
LEAD_SCALE, TAIL_SCALE = 0.34, 0.58   # font size = BASE * scale
GAP_SCALE = 0.12              # space between words = BASE * GAP_SCALE
TOP_FRAC = {True: 0.64, False: 0.60}    # caption block top, fraction of frame height (wide, tall)
LIMIT_FRAC = {True: 0.94, False: 0.90}  # the block never goes below this
MAXW = {True: 1300, False: 900}         # line width limit in px
ENTER_S, EXIT_S = 0.28, 0.14  # per-word entrance, whole-block exit
ENTER_SCALE = 1.12            # words enter at this scale and settle to 1
ENTER_BLUR = 14               # px (render.py kernel size; Gaussian sigma = half of it)
EXIT_BLUR = 10
RISE = 0.1                    # words rise by BASE * RISE while entering
LINE_BIG, LINE_OTHER = 0.95, 1.08   # line height = font ascent+descent * this


def base(wide):
    return 140 if wide else 150


def big_size(n_letters, base_px):
    """Anton size for a big word with n letters: long words get smaller so they fit."""
    return int(base_px * max(0.55, min(1, 9 / max(n_letters, 1))))


STOP = set("the a an and or but so to of in on at for with from by as is are was were be been being it its this that these those there their they them i you he she we me my your our his her not no do does did have has had just really very about into than then what when where which who how why can could would should will i'm it's don't that's you're".split())
NOBIG = set("question personal people everyone example something because customers".split())


def place_bites(bites):
    timeline, t = [], 0.0
    for b in bites:
        b["dur"] = b["end"] - b["start"]
        timeline.append((t, b))
        t += b["dur"]
    return timeline, t


def clean(w):
    return w.strip()


def core(t):
    return re.sub(r"[^\w$%']", "", t)


def build_blocks(timeline, words_all):
    blocks = []
    for out0, b in timeline:
        # a word may start just before the cut (cap_start earlier than start); it still appears at the cut, never on the previous bite
        ws = [dict(w=clean(x["w"]), s=max(x["s"] - b["start"] + out0, out0), e=x["e"] - b["start"] + out0, src=x["s"])
              for x in words_all if x["s"] >= b.get("cap_start", b["start"]) - 0.05 and x["s"] < b.get("cap_end", b["end"]) - 0.05 and clean(x["w"])]
        merged = []
        for w in ws:
            if merged and (re.match(r"^[-,]\w", w["w"]) or re.match(r"^%[.,?!]?$", w["w"])):   # "e"+"-commerce", "195"+",000", "10"+"%"
                merged[-1]["w"] += w["w"]; merged[-1]["e"] = w["e"]
            else:
                merged.append(w)
        ws = merged
        dt_ = b.get("drop_times", []); dw_ = {re.sub(r"[^\w$%']", "", x).lower() for x in b.get("drop", [])}
        ws = [w for w in ws if not any(abs(w["s"] - (t_ - b["start"] + out0)) < 0.03 for t_ in dt_)
              and re.sub(r"[^\w$%']", "", w["w"]).lower() not in dw_]
        if ws: ws[0]["w"] = ws[0]["w"][0].upper() + ws[0]["w"][1:]
        for t_, v in b.get("fix_times", {}).items():  # fix one word, picked by its source start time
            for w in ws:
                if abs(w["src"] - float(t_)) < 0.03: w["w"] = v
        for k, v in b.get("fix", {}).items():  # transcript corrections
            for w in ws:
                if w["w"].strip(".,?!").lower() == k.lower():
                    w["w"] = re.sub(re.escape(w["w"].strip(".,?!")), v, w["w"])
        cur = []
        for i, w in enumerate(ws):
            cur.append(w)
            text = " ".join(x["w"] for x in cur)
            nxt = ws[i + 1] if i + 1 < len(ws) else None
            # don't strand 1-2 words before a sentence end in their own block
            soon = any(re.search(r"[.?!,]$", x["w"]) for x in ws[i + 1:i + 3]) and len(cur) < 8
            brk = (nxt is None or ((len(cur) >= 6 or len(text) >= 34 or cur[-1]["e"] - cur[0]["s"] > 2.6) and not soon)
                   or re.search(r"[.?!]$", w["w"]) or (re.search(r",$", w["w"]) and len(cur) >= 3)
                   or (nxt and nxt["s"] - w["e"] > b.get("gap", 0.5)))
            if brk:
                end = min(nxt["s"] if nxt else out0 + b["dur"], cur[-1]["e"] + 0.6, out0 + b["dur"])
                blocks.append(dict(words=cur, s=cur[0]["s"], e=end, bite=b))
                cur = []
    return blocks


def roles(block):
    ws = block["words"]; b = block["bite"]
    bigset = {core(x).lower() for x in b.get("big", [])}
    big = [i for i, w in enumerate(ws) if core(w["w"]).lower() in bigset]
    if not big and b.get("auto_big", True):
        best, score = -1, 0
        for i, w in enumerate(ws):
            c = core(w["w"])
            sc = 100 if re.search(r"\d", c) else (len(c) if len(c) >= 6 and c.lower() not in STOP and c.lower() not in NOBIG and not c.lower().endswith("ly") else 0)
            if sc > score: best, score = i, sc
        if best >= 0: big = [best]
    if not big:
        return ["tail" if i == len(ws) - 1 else "lead" for i in range(len(ws))]
    first, last = big[0], big[-1]
    after = len(ws) - 1 - last
    r = []
    for i in range(len(ws)):
        if i in big: r.append("big")
        elif i > last: r.append("tail" if after <= 3 else "lead")
        else: r.append("lead" if i < first else "tail")
    return r


def display_text(w, role):
    """What is shown for a word: big words are upper-cased without trailing punctuation."""
    return w["w"].strip('.,;:!"').upper() if role == "big" else w["w"]


# words whose meaning picks their colour; anything else is yellow
RED_WORDS = set("""not no never nothing nobody zero lose losing lost loss fail failed failing failure hate hated wrong worst
waste wasting wasted risk risky broke broken banned ban scam dead die dying death fear scared afraid stop quit lie lies fake
greed ego debt fired crash war danger dangerous problem problems less can't don't won't isn't aren't shouldn't bad hard
struggle pain poor burning burn replaced replace angry mistake mistakes""".split())
GREEN_WORDS = set("""money millionaire millionaires rich wealth wealthy profit profits profitable win winning won success
successful results growth grow grew more free best better sold selling sales revenue income paid earn earning earned yes
good great solution solutions help works worked working opportunity freedom invest investment asset asset-class""".split())
PINK_WORDS = set("love loved loving heart family wife husband kids children mother father mum mom dad beautiful".split())


def mood(word):
    c = core(word).lower()
    return "red" if c in RED_WORDS else "green" if c in GREEN_WORDS else "pink" if c in PINK_WORDS else "yellow"


def accents(block, rs):
    """Colour name per word (None = white), for one caption block with roles rs.
    A bite's "accent" colours those words in any role: a list picks each colour by meaning, a dict {"word": "red"} sets it
    (red, yellow, green, pink, gold, box). A block with none of them gets one automatic accent on a big word, unless the bite
    has "auto_accent": false: the first big word with a red/green/pink meaning, else the first big word, in yellow."""
    b = block["bite"]
    acc = b.get("accent") or {}
    if isinstance(acc, list): acc = {x: None for x in acc}
    acc = {core(k).lower(): v for k, v in acc.items()}
    out = [(acc[c] or mood(w["w"])) if (c := core(w["w"]).lower()) in acc else None for w in block["words"]]
    if any(out) or not b.get("auto_accent", True): return out
    bigs = [i for i, r in enumerate(rs) if r == "big"]
    if bigs:
        i = next((i for i in bigs if mood(block["words"][i]["w"]) != "yellow"), bigs[0])
        out[i] = mood(block["words"][i]["w"])
    return out


def box_rows(font, role):
    """Where a "box" word's box sits, as (top, height) in px from the top of the word's line (PIL font, text drawn at the
    line top): from BOX_PAD above the capitals to BOX_DROP below the baseline."""
    asc, s = font.getmetrics()[0], font.size
    cap = -font.getbbox("H", anchor="ls")[1]
    return asc - cap - BOX_PAD * s, cap + (BOX_PAD + BOX_DROP[role]) * s


def flow_lines(items, maxw, gap):
    """Greedy line flow. items need "r" (role) and "iw" (ink width). Big words own a line (several big
    words may share one if they fit); a role change starts a new line; long runs wrap at maxw."""
    lines, cur, curw = [], [], 0
    for it in items:
        iw = it["iw"]
        if it["r"] == "big":
            if cur and cur[-1]["r"] == "big" and curw + gap + iw <= maxw:
                cur.append(it); curw += gap + iw
                continue
            if cur: lines.append(cur)
            cur, curw = [it], iw
            continue
        if cur and cur[0]["r"] == "big":
            lines.append(cur); cur, curw = [], 0
        if cur and (curw + gap + iw > maxw or cur[-1]["r"] != it["r"]):
            lines.append(cur); cur, curw = [], 0
        cur.append(it); curw += (gap if len(cur) > 1 else 0) + iw
    if cur: lines.append(cur)
    return lines


if __name__ == "__main__":
    # dry run: print the caption blocks exactly as they will appear, without rendering. usage: captions.py plan.json
    import sys
    from common import load_plan, words
    plan = load_plan(sys.argv[1])
    timeline, total = place_bites(plan["bites"])
    for bl in build_blocks(timeline, words(plan["transcript"])):
        rs = roles(bl)
        cs = accents(bl, rs)
        print(f"{bl['s']:5.1f}s  bite {bl['bite'].get('id'):>3}  " +
              " ".join((f"[{display_text(w, r)}]" if r == "big" else w["w"]) + (f"<{c}>" if c else "") for w, r, c in zip(bl["words"], rs, cs)))
    print(f"total {total:.1f}s   ([WORD] = huge word, <red> = that word's colour)")
