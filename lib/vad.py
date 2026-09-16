#!/usr/bin/env python3
"""Adaptive voice-activity detection.

A fixed dB gate (silencedetect=n=-32dB) only finds pauses in clean studio audio.
Real footage carries room tone, traffic, a crowd, so the gaps never dip that low
and nothing gets cut. This measures the noise floor the recording actually has
and puts the gate just above it.
"""
import subprocess, sys, json, math, array

HOP = 0.02  # 20ms frames

def envelope(path, sr=16000):
    raw = subprocess.run(['ffmpeg','-v','quiet','-i',path,'-map','0:a:0','-ac','1',
        '-ar',str(sr),'-f','s16le','-'], capture_output=True).stdout
    pcm = array.array('h'); pcm.frombytes(raw[:len(raw)//2*2])
    n = int(sr*HOP); out = []
    for i in range(0, len(pcm)-n, n):
        s = 0
        for v in pcm[i:i+n]: s += v*v
        rms = math.sqrt(s/n)
        out.append(20*math.log10(rms/32768) if rms > 0 else -90.0)
    return out

def pick_gate(db):
    """Floor and speech level from the recording's own distribution."""
    s = sorted(db)
    p = lambda q: s[max(0, min(len(s)-1, int(len(s)*q)))]
    floor, speech = p(0.10), p(0.90)
    spread = speech - floor
    # A tight spread means heavy background: sit closer to the floor or we would
    # swallow quiet speech. A wide spread means clean audio and we can sit higher.
    frac = 0.22 if spread < 14 else 0.38
    gate = floor + spread*frac
    return max(-55.0, min(-18.0, gate)), floor, speech, spread

def detect(path, min_dur=0.22):
    db = envelope(path)
    if not db: return [], {}
    gate, floor, speech, spread = pick_gate(db)
    spans, run = [], None
    for i, v in enumerate(db):
        if v < gate:
            if run is None: run = i
        else:
            if run is not None and (i-run)*HOP >= min_dur:
                spans.append({'start': round(run*HOP,3), 'end': round(i*HOP,3)})
            run = None
    if run is not None and (len(db)-run)*HOP >= min_dur:
        spans.append({'start': round(run*HOP,3), 'end': round(len(db)*HOP,3)})
    return spans, {'gate': round(gate,1), 'floor': round(floor,1),
                   'speech': round(speech,1), 'spread': round(spread,1),
                   'dead': round(sum(s['end']-s['start'] for s in spans),2)}

if __name__ == '__main__':
    spans, info = detect(sys.argv[1], float(sys.argv[2]) if len(sys.argv)>2 else 0.22)
    print(json.dumps({'silences': spans, 'info': info}))
