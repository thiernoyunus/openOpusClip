"""Print word timestamps so you can place cuts.  usage: words.py transcript.json 1107-1126 [2754-2775 ...]
Also: words.py transcript.json --find "investment go to zero"  (lists every match with its time)."""
import json, re, sys
ws = [w for s in json.load(open(sys.argv[1])) for w in s["words"]]
if sys.argv[2] == "--find":
    q = re.sub(r"[^\w ]", "", " ".join(sys.argv[3:]).lower()).split()
    toks = [re.sub(r"[^\w]", "", w["w"].lower()) for w in ws]
    for i in range(len(toks) - len(q) + 1):
        if toks[i:i + len(q)] == q:
            ctx = " ".join(w["w"].strip() for w in ws[max(0, i - 12):i + len(q) + 12])
            print(f"{ws[i]['s']:.2f}  ({int(ws[i]['s'] // 60)}:{ws[i]['s'] % 60:04.1f})  ...{ctx}...")
    sys.exit()
for r in sys.argv[2:]:
    a, b = map(float, r.split("-"))
    print(f"== {r}")
    print(" ".join(f"{w['w'].strip()}[{w['s']:.2f}-{w['e']:.2f}]" for w in ws if a <= w["s"] <= b))
