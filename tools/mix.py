#!/usr/bin/env python3
"""Lay a music bed and SFX under a finished cut.

Speech is the priority, so the bed is ducked by the voice itself rather than
being pulled down flat: sidechaincompress keyed off the dialogue opens a hole
exactly where words are and lets the bed back up in the gaps.

  python3 tools/mix.py <video> <out> --bed speech --sfx 4.3:riser_short 6.4:impact
"""
import argparse, json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BEDS, SFXDIR = os.path.join(ROOT, "beds"), os.path.join(ROOT, "sound", "sfx")
import shutil
FF = next((p for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] if os.path.exists(p)), shutil.which("ffmpeg") or "ffmpeg")
CFG = json.load(open(os.path.join(ROOT, "refs", "styles.json")))["mix"]

def dur(p):
    r = subprocess.run([FF.replace("ffmpeg", "ffprobe"), "-v", "error", "-show_entries",
        "format=duration", "-of", "csv=p=0", p], capture_output=True, text=True)
    return float(r.stdout.strip())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video"); ap.add_argument("out")
    ap.add_argument("--bed", default="none")
    ap.add_argument("--bed-gain", type=float, default=None)
    ap.add_argument("--sfx", nargs="*", default=[], help="TIME:NAME, e.g. 4.3:riser_short")
    a = ap.parse_args()

    total = dur(a.video)
    ins, filt, mixins = ["-i", a.video], [], []

    if a.bed != "none":
        # the voice, split: one copy to hear, one to key the ducking off
        filt.append("[0:a]aformat=channel_layouts=stereo,asplit=2[vox][key]")
    else:
        filt.append("[0:a]aformat=channel_layouts=stereo[vox]")
    mixins.append("[vox]")

    n = 1
    if a.bed != "none":
        bed = os.path.join(BEDS, a.bed + ".wav")
        if not os.path.exists(bed):
            sys.exit(f"no bed called {a.bed} in {BEDS}")
        ins += ["-stream_loop", "-1", "-i", bed]          # loop to cover the whole cut
        g = a.bed_gain if a.bed_gain is not None else CFG["bgmGainUnderSpeech"]
        filt.append(
            f"[{n}:a]aformat=channel_layouts=stereo,atrim=0:{total:.3f},asetpts=PTS-STARTPTS,"
            f"afade=t=in:d=1.2,afade=t=out:st={max(0, total-1.6):.3f}:d=1.6,"
            f"volume={g}dB[bedraw]")
        # keyed off the dialogue, so the bed breathes in the gaps instead of sitting flat
        filt.append("[bedraw][key]sidechaincompress=threshold=0.055:ratio=5:attack=20:"
                    "release=320:makeup=1[bed]")
        mixins.append("[bed]")
        n += 1

    lead = CFG.get("_sfxLeadMs", 100) / 1000.0
    for i, spec in enumerate(a.sfx):
        t, name = spec.split(":", 1)
        f = os.path.join(SFXDIR, name + ".wav")
        if not os.path.exists(f):
            sys.exit(f"no sfx called {name}")
        at = max(0.0, float(t) - lead)   # transients land before the picture cuts
        ins += ["-i", f]
        filt.append(f"[{n}:a]aformat=channel_layouts=stereo,volume={CFG['sfxPeak']}dB,"
                    f"adelay={int(at*1000)}|{int(at*1000)}[s{i}]")
        mixins.append(f"[s{i}]")
        n += 1

    filt.append("".join(mixins) + f"amix=inputs={len(mixins)}:normalize=0:dropout_transition=0"
                f",alimiter=limit=0.94,loudnorm=I={CFG['speechLUFS']}:TP=-1.5:LRA=11[out]")

    cmd = [FF, "-y", "-v", "error", *ins, "-filter_complex", ";".join(filt),
           "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
           "-shortest", "-movflags", "+faststart", a.out]
    subprocess.run(cmd, check=True)
    print(f"mixed -> {a.out}  bed={a.bed}  sfx={len(a.sfx)}")

if __name__ == "__main__":
    main()
