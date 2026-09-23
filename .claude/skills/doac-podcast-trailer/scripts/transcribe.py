"""Transcribe an episode with word timestamps.  usage: transcribe.py original.mp4 [transcript.json]
Writes transcript.json ([{start,end,text,words:[{w,s,e}]}]), transcript.txt (one line per segment, [mm:ss]),
and audio.wav (16 kHz mono, reused by snap.py). Takes roughly a quarter of the episode's length on 4 CPUs."""
import json, os, subprocess, sys, time
from faster_whisper import WhisperModel

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else "transcript.json"
wav = os.path.join(os.path.dirname(os.path.abspath(out)), "audio.wav")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], check=True)
t = time.time()
m = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="cpu", compute_type="int8", cpu_threads=os.cpu_count())
segs, _ = m.transcribe(wav, beam_size=1, word_timestamps=True, vad_filter=True, condition_on_previous_text=False)
res = []
for s in segs:
    res.append({"start": s.start, "end": s.end, "text": s.text.strip(),
                "words": [{"w": w.word, "s": w.start, "e": w.end} for w in s.words]})
    print(f"\r{s.end / 60:.1f} min", end="", flush=True)
json.dump(res, open(out, "w"))
with open(out.replace(".json", ".txt"), "w") as f:
    for s in res:
        f.write(f"[{int(s['start'] // 60):02d}:{s['start'] % 60:05.2f}] {s['text']}\n")
print(f"\ndone in {time.time() - t:.0f}s, {len(res)} segments")
