#!/usr/bin/env python3
"""Who is moving their mouth, the same as tools/talkers.swift but with mediapipe,
so Birch runs on Linux too.

Writes one JSON line per sampled frame, five a second by default:
  {"t": secs, "f": [[x0,y0,x1,y1,mouthOpen], ...]}
The box is fractions of the frame, top-left origin. mouthOpen is the height of the
inner lip opening as a fraction of the face box height, which is the unit Apple's
landmarks come in, so the scoring in lib/talkers.js does not change. It is -1 when
the mouth could not be read.

Two models, not one. The face detector finds everyone, including small faces in a
wide shot, because it is cheap enough to run over overlapping crops. The face mesh
then runs once per face on a tight crop, where it is accurate, instead of once on
the whole frame, where it misses anyone who is not filling it.

usage: lips_fallback.py <in> <out.jsonl> [fps]
"""
import json
import sys

import cv2

from vision_fallback import (open_video, r3, clamp01, detector, landmarker, confirmed,
                             TILES)

MESH_FACES = 6     # how many candidates a frame is allowed to check; the rest go
SWEEP = 1.0        # how often the whole frame gets the full set of crops, seconds


def around(box, pad=0.6):
    """A crop with room around a box, to look for the same face again next frame."""
    w, h = box[2] - box[0], box[3] - box[1]
    return (clamp01(box[0] - pad * w), clamp01(box[1] - pad * h),
            clamp01(box[2] + pad * w), clamp01(box[3] + pad * h))


# Apple's innerLips region sits a little tighter than the mesh's inner ring, so the
# same open mouth reads about 1.6x larger here. Measured across the three test
# clips (1.55, 1.74, 1.58). Dividing it back keeps the numbers in the range
# lib/talkers.js was tuned against.
LIP_SCALE = 1.6


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('usage: lips_fallback.py <in.mp4> <out.jsonl> [fps]\n')
        sys.exit(2)
    src, out_path = sys.argv[1], sys.argv[2]
    fps_want = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0

    cap = open_video(src)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    dur = (count / src_fps) if src_fps > 0 and count > 0 else 0.0

    det = detector()
    lm = landmarker()
    fh = open(out_path, 'w')
    # One walk through the file. grab() pulls a frame without decoding it, so the
    # frames between samples cost almost nothing.
    idx, n, next_t = 0, 0, 0.0
    last_sweep, found = -1e9, []
    while True:
        if not cap.grab():
            break
        t = idx / src_fps
        idx += 1
        if t + 0.001 < next_t:
            continue
        next_t = t + 1.0 / fps_want
        ok, frame = cap.retrieve()
        if not ok or frame is None:
            continue
        # The full set of crops is slow, so it only runs about once a second. In
        # between, the frame is searched whole plus around wherever a face was last
        # time, which is where it still is a fifth of a second later.
        if t - last_sweep >= SWEEP - 0.001 or not found:
            tiles, last_sweep = TILES, t
        else:
            tiles = [(0.0, 0.0, 1.0, 1.0)] + [around(b) for b in found]
        found = []
        faces = []
        for b, amt in confirmed(det, lm, frame, tiles, MESH_FACES):
            found.append(b)
            faces.append([b[0], b[1], b[2], b[3], r3(amt / LIP_SCALE)])
        fh.write(json.dumps({'t': r3(t), 'f': faces}, separators=(',', ':')) + '\n')
        n += 1
        if n % 25 == 0:
            sys.stderr.write('talkers %d\n' % int(t))
            sys.stderr.flush()
    fh.close()
    cap.release()
    print(json.dumps({'frames': n, 'duration': dur}))


if __name__ == '__main__':
    main()
