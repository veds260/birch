#!/usr/bin/env python3
"""A grayscale person matte video, the same as tools/personmask.swift but with
mediapipe selfie segmentation, so Birch runs on Linux too.

White is the person, black is everything else, at the size and frame rate of the
source, so lib/media.js can trim it alongside the footage and alphamerge it back
over the top. The frames go to ffmpeg over a pipe, because the OpenCV wheels do not
ship an h264 encoder.

The quality argument the Swift tool takes is accepted and ignored: there is one
model here, not three.

usage: mask_fallback.py <in> <out.mov> [quality]
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

from vision_fallback import model, open_video

FFMPEG = os.environ.get('BIRCH_FFMPEG') or 'ffmpeg'


# The multiclass model splits a person into background, hair, skin, clothes and the
# rest. Everything that is not background is the person, and it holds an edge much
# better than the plain selfie model, which melts two people standing close together
# into one blob.
def segmenter():
    from mediapipe.tasks import python as mpp
    from mediapipe.tasks.python import vision as mpv
    opts = mpv.ImageSegmenterOptions(
        base_options=mpp.BaseOptions(model_asset_path=model('selfie_multiclass_256x256.tflite')),
        running_mode=mpv.RunningMode.VIDEO,
        output_category_mask=False,
        output_confidence_masks=True)
    return mpv.ImageSegmenter.create_from_options(opts)


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('usage: mask_fallback.py <in.mp4> <out.mov> [quality]\n')
        sys.exit(2)
    import mediapipe as mp
    src, dst = sys.argv[1], sys.argv[2]
    try:
        os.remove(dst)
    except OSError:
        pass

    cap = open_video(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    ok, first = cap.read()
    if not ok or first is None:
        sys.exit(3)
    # the decoded frame already has the file's rotation applied, so take the size
    # from it rather than from the stream properties
    H, W = first.shape[:2]

    ff = subprocess.Popen(
        [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y',
         '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '%dx%d' % (W, H), '-r', '%.6f' % fps,
         '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'veryfast',
         '-pix_fmt', 'yuv420p', '-b:v', str(W * H * 4), dst],
        stdin=subprocess.PIPE)

    seg = segmenter()
    frame = first
    n, ms = 0, 0
    while True:
        # the model runs at 256x256, so there is nothing to gain from feeding it
        # a 4K frame; the mask is stretched back up after
        small = cv2.resize(frame, (256, 256), interpolation=cv2.INTER_AREA)
        img = mp.Image(image_format=mp.ImageFormat.SRGB,
                       data=np.ascontiguousarray(cv2.cvtColor(small, cv2.COLOR_BGR2RGB)))
        res = seg.segment_for_video(img, ms)
        masks = res.confidence_masks or []
        if len(masks) > 1:
            # class 0 is the background and the rest are parts of a person, so
            # anything the model is sure is not background is the matte
            conf = 1.0 - np.squeeze(masks[0].numpy_view())
        elif masks:
            conf = np.squeeze(masks[0].numpy_view())
        else:
            conf = None
        if conf is None:
            gray = np.zeros((H, W), np.uint8)
        else:
            gray = np.clip(conf * 255.0, 0, 255).astype(np.uint8)
            gray = cv2.resize(gray, (W, H), interpolation=cv2.INTER_LINEAR)
        ff.stdin.write(gray.tobytes())
        n += 1
        ms += max(1, int(round(1000.0 / fps)))
        if n % 60 == 0:
            sys.stderr.write('mask progress %d\n' % n)
            sys.stderr.flush()
        ok, frame = cap.read()
        if not ok or frame is None:
            break

    ff.stdin.close()
    code = ff.wait()
    cap.release()
    if code != 0:
        sys.exit(code)
    print(json.dumps({'frames': n, 'width': W, 'height': H, 'fps': fps}))


if __name__ == '__main__':
    main()
