#!/usr/bin/env python3
"""Three signature BGM beds, generated locally with MusicGen.

The point of three, not thirty: a profile that reuses the same few beds starts
to sound like itself. These are deliberately plain underscores, not tracks with
opinions, because they sit under speech.
"""
import sys, os, torch, scipy.io.wavfile
from transformers import MusicgenForConditionalGeneration, AutoProcessor

BEDS = {
    "speech":  "warm cinematic underscore, soft felt piano, gentle sustained strings, "
               "hopeful and restrained, no drums, slow, spacious",
    "street":  "mellow lo-fi hip hop bed, dusty muted drums, warm bass, relaxed, "
               "unobtrusive, loopable",
    "drive":   "minimal electronic pulse, soft analog synth bass, steady eighth notes, "
               "modern and clean, restrained, no lead melody",
}
OUT = os.path.expanduser("~/video-desk/beds")
os.makedirs(OUT, exist_ok=True)

dev = "mps" if torch.backends.mps.is_available() else "cpu"
print(f"device: {dev}", flush=True)
proc = AutoProcessor.from_pretrained("facebook/musicgen-small")
model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small").to(dev)
sr = model.config.audio_encoder.sampling_rate
# musicgen runs at 50 tokens/sec of audio
tokens = int(30 * 50)

for name, prompt in BEDS.items():
    dst = os.path.join(OUT, f"{name}.wav")
    if os.path.exists(dst):
        print(f"  {name}: exists, skipping", flush=True); continue
    print(f"  {name}: generating 30s ...", flush=True)
    inp = proc(text=[prompt], padding=True, return_tensors="pt").to(dev)
    with torch.no_grad():
        audio = model.generate(**inp, do_sample=True, guidance_scale=3.0, max_new_tokens=tokens)
    wav = audio[0, 0].cpu().numpy()
    scipy.io.wavfile.write(dst, rate=sr, data=wav)
    print(f"  {name}: wrote {dst} ({len(wav)/sr:.1f}s @ {sr}Hz)", flush=True)
print("done", flush=True)
