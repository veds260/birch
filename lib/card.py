#!/usr/bin/env python3
"""A white card: black type on white, either the whole frame or a band, with an
optional numbered list. The text-slide the references cut to."""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

HOME = os.path.expanduser("~")
def pick(*p): return next((x for x in p if os.path.exists(x)), "/System/Library/Fonts/Supplemental/Arial Bold.ttf")
FACES = {
  "heavy": pick(HOME + "/Library/Fonts/MikadoUltra.otf", "/System/Library/Fonts/Supplemental/Arial Black.ttf"),
  "bold":  pick(HOME + "/Library/Fonts/MikadoBold.otf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
  "medium": pick(HOME + "/Library/Fonts/MikadoMedium.otf", "/System/Library/Fonts/Supplemental/Arial.ttf"),
  "serif": pick("/System/Library/Fonts/Supplemental/Georgia Bold.ttf", "/System/Library/Fonts/Supplemental/Georgia.ttf"),
}
def wrap(d, text, f, maxw):
    out, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= maxw or not cur: cur = t
        else: out.append(cur); cur = w
    if cur: out.append(cur)
    return out

def main():
    c = json.load(sys.stdin)
    W, H = c["width"], c["height"]
    band = c.get("band")            # None = full frame; else {"y":0.0-1.0,"h":0.0-1.0}
    bg = c.get("bg", "#FFFFFF"); ink = c.get("ink", "#111111"); accent = c.get("accent", "#E8222A")
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rgb = tuple(int(bg[i:i+2], 16) for i in (1, 3, 5))
    if band:
        y0, h = int(H * float(band.get("y", 0))), int(H * float(band.get("h", 0.3)))
        d.rectangle([0, y0, W, y0 + h], fill=rgb + (255,))
        top, bottom = y0, y0 + h
    else:
        d.rectangle([0, 0, W, H], fill=rgb + (255,)); top, bottom = 0, H
    pad = int(W * 0.08)
    maxw = W - pad * 2
    y = top + int((bottom - top) * float(c.get("top", 0.12)))

    head = (c.get("headline") or "").strip()
    if head:
        f = ImageFont.truetype(FACES.get(c.get("face", "heavy")), int(c.get("headSize") or H * 0.058))
        a, de = f.getmetrics(); lh = int((a + de) * 0.95)
        for ln in wrap(d, head.upper() if c.get("upper", False) else head, f, maxw):
            x = pad if c.get("align", "left") == "left" else (W - d.textlength(ln, font=f)) / 2
            d.text((x, y), ln, font=f, fill=ink); y += lh
        y += int(lh * 0.35)

    lines = c.get("lines") or []
    if lines:
        f = ImageFont.truetype(FACES.get(c.get("listFace", "bold")), int(c.get("listSize") or H * 0.036))
        a, de = f.getmetrics(); lh = int((a + de) * 1.25)
        for i, ln in enumerate(lines):
            label = (f"{i + 1}.  " if c.get("numbered", True) else "")
            for k, part in enumerate(wrap(d, ln, f, maxw - d.textlength(label, font=f))):
                d.text((pad + (0 if k == 0 else d.textlength(label, font=f)), y),
                       (label if k == 0 else "") + part, font=f, fill=ink); y += lh
            y += int(lh * 0.15)

    body = (c.get("body") or "").strip()
    if body:
        f = ImageFont.truetype(FACES.get("medium"), int(c.get("bodySize") or H * 0.03))
        a, de = f.getmetrics(); lh = int((a + de) * 1.3)
        for ln in wrap(d, body, f, maxw):
            d.text((pad, y), ln, font=f, fill=ink); y += lh

    hi = (c.get("highlight") or "").strip()
    if hi:   # one word or phrase in the accent colour, big, the thing the card is about
        f = ImageFont.truetype(FACES["heavy"], int(H * 0.05))
        d.text((pad, y + int(H * 0.02)), hi, font=f, fill=accent)
    img.save(c["out"]); json.dump({"file": c["out"]}, sys.stdout)
main()
