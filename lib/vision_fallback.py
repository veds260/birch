#!/usr/bin/env python3
"""One pass over the video at one frame a second, the same as tools/scenevision.swift
but with mediapipe instead of Apple's Vision, so Birch runs on Linux too.

Writes one JSON line per sampled second:
  {"t": secs, "faces": [[x0,y0,x1,y1], ...], "tags": [], "text": "..."}
Boxes are fractions of the frame with a top-left origin, three decimals, which is
what lib/vision.js already expects.

Two fields the Swift tool writes are missing here on purpose. "look" (the salient
object) is not read anywhere in the JS, and "tags" (scene classification) has no
free equivalent, so it goes out empty rather than made up. "text" only appears when
tesseract is installed.

usage: vision_fallback.py <in> <out.jsonl> [step]
"""
import json
import os
import sys
import urllib.request

import cv2
import numpy as np

# Where the mediapipe model bundles are cached. Same models/ folder whisper uses.
MODEL_DIR = os.environ.get('BIRCH_MP_MODELS') or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'models', 'mediapipe')
MODELS = {
    'blaze_face_short_range.tflite':
        'https://storage.googleapis.com/mediapipe-models/face_detector/'
        'blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    'face_landmarker.task':
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/'
        'face_landmarker/float16/1/face_landmarker.task',
    'selfie_multiclass_256x256.tflite':
        'https://storage.googleapis.com/mediapipe-models/image_segmenter/'
        'selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
}


def model(name):
    """Path to a model bundle, fetched once and kept."""
    path = os.path.join(MODEL_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 10000:
        return path
    os.makedirs(MODEL_DIR, exist_ok=True)
    tmp = path + '.part'
    with urllib.request.urlopen(MODELS[name], timeout=120) as r, open(tmp, 'wb') as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, path)
    return path


def open_video(src):
    """A capture that has already applied the file's rotation metadata, plus the
    size of a real decoded frame. OpenCV reports the unrotated size in the
    properties, so a vertical phone clip lies about its width until you read one."""
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        raise SystemExit(3)
    try:
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
    except Exception:
        pass
    return cap


def r3(v):
    return round(float(v) * 1000.0) / 1000.0


def clamp01(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def detector():
    """Short-range blazeface. It is the only detector the tasks API ships, so small
    faces in a wide shot are found by tiling the frame rather than a better model."""
    from mediapipe.tasks import python as mpp
    from mediapipe.tasks.python import vision as mpv
    # CPU on purpose: the GPU delegate crashes inside mediapipe 1.x on macOS, and
    # blazeface is small enough that the CPU path is fast anyway.
    opts = mpv.FaceDetectorOptions(
        base_options=mpp.BaseOptions(model_asset_path=model('blaze_face_short_range.tflite'),
                                     delegate=mpp.BaseOptions.Delegate.CPU),
        running_mode=mpv.RunningMode.IMAGE,
        min_detection_confidence=0.4)
    return mpv.FaceDetector.create_from_options(opts)


def to_mp_image(bgr):
    import mediapipe as mp
    return mp.Image(image_format=mp.ImageFormat.SRGB,
                    data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


def grid(cols, rows, over=0.12):
    """Overlapping tiles covering the frame, as fractions."""
    out = []
    for r in range(rows):
        for c in range(cols):
            x0 = max(0.0, c / cols - over / cols)
            x1 = min(1.0, (c + 1) / cols + over / cols)
            y0 = max(0.0, r / rows - over / rows)
            y1 = min(1.0, (r + 1) / rows + over / rows)
            out.append((x0, y0, x1, y1))
    return out


# The detector resizes whatever it is given to 128x128, so a face that is a fiftieth
# of a wide shot never survives the full-frame pass. Running it again on overlapping
# crops, each one cut from the full-resolution frame, gets those back. Eleven passes
# of a model this small still cost a few milliseconds.
TILES = [(0.0, 0.0, 1.0, 1.0)] + grid(2, 2) + grid(3, 2)


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


MAX_SIDE = 640          # what each pass is allowed to hand the detector


def faces_in(det, bgr, tiles=None):
    """Boxes as top-left fractions of the whole frame, biggest first. bgr is the
    frame at full resolution: the crops are cut from it before any downscaling, so
    a small face keeps its pixels."""
    h, w = bgr.shape[:2]
    found = []
    for (tx0, ty0, tx1, ty1) in (TILES if tiles is None else tiles):
        x0, y0 = int(tx0 * w), int(ty0 * h)
        x1, y1 = int(tx1 * w), int(ty1 * h)
        crop = bgr[y0:y1, x0:x1]
        ch, cw = crop.shape[:2]
        if ch < 32 or cw < 32:
            continue
        if max(cw, ch) > MAX_SIDE:
            s = MAX_SIDE / max(cw, ch)
            crop = cv2.resize(crop, (max(1, int(cw * s)), max(1, int(ch * s))),
                              interpolation=cv2.INTER_AREA)
        sx, sy = cw / crop.shape[1], ch / crop.shape[0]
        res = det.detect(to_mp_image(np.ascontiguousarray(crop)))
        for d in (res.detections or []):
            bb = d.bounding_box
            box = [clamp01((x0 + bb.origin_x * sx) / w),
                   clamp01((y0 + bb.origin_y * sy) / h),
                   clamp01((x0 + (bb.origin_x + bb.width) * sx) / w),
                   clamp01((y0 + (bb.origin_y + bb.height) * sy) / h)]
            score = d.categories[0].score if d.categories else 0.5
            if box[2] - box[0] <= 0 or box[3] - box[1] <= 0:
                continue
            found.append((score, box))
    # the tiles overlap, so the same face turns up more than once
    found.sort(key=lambda x: -x[0])
    kept = []
    for score, box in found:
        if all(iou(box, k) < 0.35 for k in kept):
            kept.append(box)
    kept.sort(key=lambda b: -((b[2] - b[0]) * (b[3] - b[1])))
    return [[r3(v) for v in b] for b in kept]


# The inner ring of the lips in the 468-point face mesh: the opening between the
# lips rather than the outer edge, which is what Apple's innerLips region is too.
INNER_LIPS = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308,
              324, 318, 402, 317, 14, 87, 178, 88, 95]
MESH_IN = 256      # what a face crop is scaled to before the mesh reads it


def landmarker():
    from mediapipe.tasks import python as mpp
    from mediapipe.tasks.python import vision as mpv
    opts = mpv.FaceLandmarkerOptions(
        base_options=mpp.BaseOptions(model_asset_path=model('face_landmarker.task')),
        running_mode=mpv.RunningMode.IMAGE,
        num_faces=1,                       # one face per crop, by construction
        output_face_blendshapes=False,
        min_face_detection_confidence=0.2,
        min_face_presence_confidence=0.2)
    return mpv.FaceLandmarker.create_from_options(opts)


def mouth_open(lm, bgr, box):
    """Runs the face mesh on a crop around one detected box. Returns how far the
    lips are apart as a fraction of the box height, or -1 when the mesh finds no
    face there at all. The -1 doubles as the second opinion on the detector, which
    on its own will call a capital R on a banner a face."""
    h, w = bgr.shape[:2]
    bw, bh = (box[2] - box[0]) * w, (box[3] - box[1]) * h
    if bw < 12 or bh < 12:
        return -1.0
    cx, cy = (box[0] + box[2]) / 2 * w, (box[1] + box[3]) / 2 * h
    half = max(bw, bh) * 0.85               # room around the face, squared off
    x0, y0 = int(max(0, cx - half)), int(max(0, cy - half))
    x1, y1 = int(min(w, cx + half)), int(min(h, cy + half))
    crop = bgr[y0:y1, x0:x1]
    if crop.shape[0] < 24 or crop.shape[1] < 24:
        return -1.0
    crop = cv2.resize(crop, (MESH_IN, MESH_IN), interpolation=cv2.INTER_AREA)
    faces = lm.detect(to_mp_image(np.ascontiguousarray(crop))).face_landmarks or []
    if not faces:
        return -1.0
    ys = [faces[0][i].y for i in INNER_LIPS if i < len(faces[0])]
    if len(ys) < 3:
        return -1.0
    # crop units back into pixels, then into fractions of the face box
    return (max(ys) - min(ys)) * (y1 - y0) / bh


def confirmed(det, lm, bgr, tiles=None, most=6):
    """Detected boxes the face mesh agrees with, biggest first, each with its mouth
    reading. Anything past `most` is dropped rather than trusted unchecked: it is
    always a small face at the back, never the speaker."""
    out = []
    for box in faces_in(det, bgr, tiles)[:most]:
        amt = mouth_open(lm, bgr, box)
        if amt < 0:
            continue
        out.append((box, amt))
    return out


def ocr_reader():
    """pytesseract, but only if the tesseract binary is actually installed."""
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        return pytesseract
    except Exception:
        return None


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('usage: vision_fallback.py <in.mp4> <out.jsonl> [step]\n')
        sys.exit(2)
    src, out_path = sys.argv[1], sys.argv[2]
    step = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0

    cap = open_video(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    dur = (count / fps) if fps > 0 and count > 0 else 0.0

    det = detector()
    lm = landmarker()
    tess = ocr_reader()
    fh = open(out_path, 'w')
    t, n = 0.0, 0
    while dur <= 0 or t < dur:
        # OpenCV's frame count is not always honest about the tail of a file, so a
        # failed seek gets nudged back a little before the second is given up on
        frame = None
        for back in (0.0, 0.15, 0.4):
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t - back) * 1000.0)
            ok, f = cap.read()
            if ok and f is not None:
                frame = f
                break
        if frame is None:
            break
        rec = {'t': round(t * 100.0) / 100.0,
               'faces': [b for b, _ in confirmed(det, lm, frame, most=8)], 'tags': []}
        if tess is not None:
            try:
                small = frame
                h, w = frame.shape[:2]
                if max(w, h) > 1280:            # OCR does not need more than this
                    s = 1280.0 / max(w, h)
                    small = cv2.resize(frame, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
                words = tess.image_to_string(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)).split()
                if words:
                    rec['text'] = ' '.join(words[:12])
            except Exception:
                pass
        fh.write(json.dumps(rec) + '\n')
        n += 1
        if n % 20 == 0:
            sys.stderr.write('vision %d\n' % n)
            sys.stderr.flush()
        t += step
    fh.close()
    cap.release()
    print(json.dumps({'frames': n, 'duration': dur}))


if __name__ == '__main__':
    main()
