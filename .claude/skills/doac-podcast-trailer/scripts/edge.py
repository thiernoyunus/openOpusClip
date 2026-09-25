"""Find the true word boundary near a cut when Whisper's word times look stretched.
usage: edge.py original.mp4 SECONDS [WINDOW=2.0]
Re-transcribes WINDOW seconds centred on SECONDS and prints each word with its exact source time."""
import os, subprocess, sys, tempfile
from faster_whisper import WhisperModel

src, t = sys.argv[1], float(sys.argv[2])
win = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
a = max(0, t - win / 2)
wav = os.path.join(tempfile.mkdtemp(), "edge.wav")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{a:.3f}", "-i", src, "-t", f"{win:.3f}", "-ac", "1", "-ar", "16000", wav], check=True)
m = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="cpu", compute_type="int8")
segs, _ = m.transcribe(wav, beam_size=5, word_timestamps=True, condition_on_previous_text=False)
for s in segs:
    for w in s.words:
        print(f"{a + w.start:9.2f} - {a + w.end:9.2f}  {w.word.strip()}")
