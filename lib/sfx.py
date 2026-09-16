#!/usr/bin/env python3
"""A starter SFX kit made from scratch with ffmpeg: noise, sines and filters, shaped
the way sound designers shape them. Nothing sampled, nothing owned by anyone."""
import subprocess, os, sys
OUT = os.path.join(os.path.dirname(__file__), "..", "sound", "sfx")
os.makedirs(OUT, exist_ok=True)
import shutil
FF = next((p for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] if os.path.exists(p)), shutil.which("ffmpeg") or "ffmpeg")

def make(name, src, filt, dur):
    out = os.path.join(OUT, name + ".wav")
    cmd = [FF, "-y", "-loglevel", "error", "-f", "lavfi", "-i", src, "-t", str(dur),
           "-af", filt + ",alimiter=limit=0.95", "-ar", "48000", "-ac", "2", out]
    subprocess.run(cmd, check=True); return out

kit = {
  # a whoosh is filtered noise whose centre frequency sweeps up then the tail falls away
  "whoosh":  ("anoisesrc=color=pink:amplitude=0.6:seed=7",
              "highpass=f=300,lowpass=f=2600,afade=t=in:d=0.08,afade=t=out:st=0.22:d=0.3,volume=1.6", 0.55),
  # a thud is a low sine that drops in pitch and dies fast, with a click of noise on top
  "thud":    ("aevalsrc='0.9*sin(2*PI*(70-40*t)*t)*exp(-9*t)+0.15*random(0)*exp(-60*t)'",
              "lowpass=f=180,volume=2.2", 0.45),
  # a click is two milliseconds of noise
  "click":   ("anoisesrc=color=white:amplitude=0.8:seed=3",
              "highpass=f=1500,afade=t=out:st=0:d=0.02,volume=1.2", 0.03),
  # a pop is a short sine chirp with a fast decay
  "pop":     ("aevalsrc='sin(2*PI*(520+900*exp(-30*t))*t)*exp(-22*t)'",
              "volume=1.4", 0.2),
  # a riser is noise with the lowpass opening over a second, then a hard stop
  "riser":   ("anoisesrc=color=pink:amplitude=0.5:seed=11",
              "lowpass=f=400,afade=t=in:d=0.9,volume=1.5", 1.1),
  # a paper rip is crackly noise, gated so it tears rather than hisses
  "paper":   ("anoisesrc=color=brown:amplitude=0.9:seed=5",
              "highpass=f=900,lowpass=f=6000,tremolo=f=38:d=0.9,afade=t=out:st=0.1:d=0.18,volume=2.0", 0.3),
  # a ding is a sine at 1.2k with a long tail and a little octave on top
  "ding":    ("aevalsrc='0.7*sin(2*PI*1180*t)*exp(-4*t)+0.25*sin(2*PI*2360*t)*exp(-7*t)'",
              "volume=1.1", 0.9),
  # a swoosh is a whoosh reversed, for things leaving the frame
  "swoosh":  ("anoisesrc=color=pink:amplitude=0.6:seed=9",
              "highpass=f=400,lowpass=f=3000,afade=t=in:d=0.3,afade=t=out:st=0.32:d=0.08,volume=1.5", 0.42),
  # a soft bass hit under a big word
  "hit":     ("aevalsrc='sin(2*PI*55*t)*exp(-5*t)+0.3*sin(2*PI*110*t)*exp(-8*t)'",
              "lowpass=f=220,volume=2.4", 0.7),

  # --- the reveal family. A cut lands harder when something leads into it. ---

  # a long riser: noise opening from 200Hz to 9k over two seconds, gaining as it goes,
  # so it pulls the ear forward and leaves a hole for the cut to land in
  "riser_long": ("anoisesrc=color=pink:amplitude=0.55:seed=21",
              "asendcmd='0.0 lowpass frequency 260; 0.4 lowpass frequency 700; "
              "0.8 lowpass frequency 1500; 1.2 lowpass frequency 3200; "
              "1.6 lowpass frequency 6000; 1.9 lowpass frequency 9000',"
              "highpass=f=180,lowpass=f=260,afade=t=in:d=1.2:curve=exp,"
              "volume='0.22+0.78*t/2':eval=frame", 2.0),
  # a short riser for a quick cut, same shape in half a second
  "riser_short": ("anoisesrc=color=pink:amplitude=0.55:seed=23",
              "asendcmd='0.0 lowpass frequency 420; 0.15 lowpass frequency 1100; "
              "0.3 lowpass frequency 2600; 0.45 lowpass frequency 5200; "
              "0.56 lowpass frequency 8500',"
              "highpass=f=240,lowpass=f=420,afade=t=in:d=0.36:curve=exp,"
              "volume='0.3+0.7*t/0.6':eval=frame", 0.6),
  # a tonal riser: a sine sweeping up an octave, cleaner than noise under speech
  "riser_tone": ("aevalsrc='0.5*sin(2*PI*(220*exp(1.1*t))*t)'",
              "highpass=f=180,afade=t=in:d=0.8,afade=t=out:st=1.15:d=0.1,volume=1.2", 1.25),
  # the impact the riser resolves into: sub sine plus a short noise body
  "impact":  ("aevalsrc='0.95*sin(2*PI*(58-26*t)*t)*exp(-6*t)+0.3*random(0)*exp(-26*t)'",
              "lowpass=f=320,volume=2.6", 1.0),
  # a sub drop with no click, for landing on a dark frame
  "subdrop": ("aevalsrc='sin(2*PI*(80-58*t)*t)*exp(-3.2*t)'",
              "lowpass=f=130,volume=2.8", 1.2),
  # reverse cymbal, the classic pull into a beat
  "reverse": ("anoisesrc=color=white:amplitude=0.5:seed=29",
              "highpass=f=2200,afade=t=in:d=1.05:curve=exp,afade=t=out:st=1.08:d=0.06,"
              "volume='0.2+0.8*t':eval=frame", 1.15),
  # a tape stop, for an abrupt end
  "tapestop": ("aevalsrc='0.6*sin(2*PI*(330-300*t)*t)*exp(-2.2*t)'",
              "lowpass=f=1800,volume=1.6", 0.9),
  # a soft transition whoosh with more air than the short one
  "whoosh_soft": ("anoisesrc=color=brown:amplitude=0.7:seed=31",
              "highpass=f=200,lowpass=f=1800,afade=t=in:d=0.3,afade=t=out:st=0.5:d=0.4,"
              "volume=1.3", 0.95),
}
for n, (src, filt, dur) in kit.items():
    make(n, src, filt, dur); print("made", n)
