"""Listen to the mix the cheap way: transcribe audio_mix.wav and print what is heard in each bite.
usage: check_audio.py plan.json [audio_mix.wav]
Catches stray words from the other speaker at an edge, clipped first/last words, and bites that end mid-thought.
Whisper can mishear very short bites (under ~1.5 s); check those with edge.py or by listening before changing a cut."""
import os, sys
from faster_whisper import WhisperModel
from common import load_plan

plan = load_plan(sys.argv[1])
mix = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "audio_mix.wav")
m = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="cpu", compute_type="int8", cpu_threads=os.cpu_count())
segs, _ = m.transcribe(mix, beam_size=5, word_timestamps=True, condition_on_previous_text=False)
heard = [w for s in segs for w in s.words]
t = 0.0
for b in plan["bites"]:
    d = b["end"] - b["start"]
    ws = " ".join(w.word.strip() for w in heard if t - 0.05 <= w.start < t + d - 0.05)
    print(f"{t:5.1f}s {b.get('id'):>3} {b.get('role', ''):<12} | {ws}")
    t += d
