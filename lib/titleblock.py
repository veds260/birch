#!/usr/bin/env python3
"""The title block the reels actually use: a big coloured headline with a smaller
white line under it, pinned near the top, held static for a whole segment.
Optionally a small stat chip with an eye icon underneath."""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

HOME = os.path.expanduser("~")
def pick(*paths):
    return next((p for p in paths if os.path.exists(p)), None)

FACES = {
  "ultra":     pick(HOME + "/Library/Fonts/MikadoUltra.otf",
                    "/System/Library/Fonts/Supplemental/Impact.ttf"),
  "condensed": pick("/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf",
                    HOME + "/Library/Fonts/MikadoUltra.otf"),
  "rounded":   pick("/System/Library/Fonts/SFCompactRounded.ttf",
                    "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf"),
  "serif":     pick("/System/Library/Fonts/Supplemental/Didot.ttc",
                    "/System/Library/Fonts/Supplemental/Georgia.ttf"),
  "scrawl":    pick("/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
                    "/System/Library/Fonts/Supplemental/MarkerFelt.ttc"),
  "sub":       pick(HOME + "/Library/Fonts/MikadoMedium.otf",
                    "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
}
FALLBACK = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
font = lambda k, s: ImageFont.truetype(FACES.get(k) or FALLBACK, max(8, int(s)))

def wrap(d, text, f, maxw):
    out, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= maxw or not cur: cur = t
        else: out.append(cur); cur = w
    if cur: out.append(cur)
    return out

def shadowed(d, xy, text, f, fill, blur=4):
    x, y = xy
    # a soft drop shadow, which is all these use. No stroke, no plate.
    for dx, dy, a in ((0, blur, 150), (0, blur // 2, 110), (1, 1, 90)):
        d.text((x + dx, y + dy), text, font=f, fill=(0, 0, 0, a))
    d.text((x, y), text, font=f, fill=fill)

def main():
    c = json.load(sys.stdin)
    W, H = c["width"], c["height"]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    head = (c.get("headline") or "").strip()
    sub = (c.get("subline") or "").strip()
    face = c.get("face", "ultra")
    accent = c.get("accent", "#F5E31C")
    hsize = int(c.get("headSize") or H * 0.062)
    ssize = int(c.get("subSize") or hsize * 0.42)
    top = float(c.get("top", 0.06))
    maxw = int(W * 0.88)

    y = int(H * top)
    if head:
        f = font(face, hsize)
        up = c.get("upper", True)
        lines = wrap(d, head.upper() if up else head, f, maxw)
        a, de = f.getmetrics()
        lh = int((a + de) * 0.86)          # tight leading, the way they set it
        for ln in lines:
            tw = d.textlength(ln, font=f)
            shadowed(d, ((W - tw) / 2, y), ln, f, accent, blur=max(3, hsize // 14))
            y += lh
        y += int(hsize * 0.14)

    if sub:
        f2 = font("sub", ssize)
        lines = wrap(d, sub, f2, int(W * 0.80))
        a2, d2 = f2.getmetrics()
        lh2 = int((a2 + d2) * 0.92)
        for ln in lines:
            tw = d.textlength(ln, font=f2)
            shadowed(d, ((W - tw) / 2, y), ln, f2, "#FFFFFF", blur=max(2, ssize // 12))
            y += lh2

    chip = c.get("chip")
    if chip:
        cs = int(ssize * 0.92)
        f3 = font("sub", cs)
        label = str(chip)
        tw = d.textlength(label, font=f3)
        eye_w = int(cs * 1.5)
        pad_x, pad_y = int(cs * 0.5), int(cs * 0.34)
        bw = eye_w + tw + pad_x * 2
        x0 = (W - bw) / 2
        y0 = y + int(cs * 0.5)
        a3, d3 = f3.getmetrics()
        d.rounded_rectangle([x0, y0, x0 + bw, y0 + a3 + d3 + pad_y * 2],
                            radius=int(cs * 0.3), fill=(0, 0, 0, 225))
        cy = y0 + (a3 + d3 + pad_y * 2) / 2
        ex = x0 + pad_x + eye_w * 0.42
        d.ellipse([ex - cs * 0.46, cy - cs * 0.30, ex + cs * 0.46, cy + cs * 0.30],
                  outline="#FFFFFF", width=max(2, int(cs * 0.09)))
        d.ellipse([ex - cs * 0.15, cy - cs * 0.15, ex + cs * 0.15, cy + cs * 0.15],
                  fill="#FFFFFF")
        d.text((x0 + pad_x + eye_w, y0 + pad_y), label, font=f3, fill="#FFFFFF")

    # crop to what was actually drawn, so the block can be dragged around the
    # frame instead of being a full-size layer pinned at the origin
    box = img.getbbox()
    if box:
        pad = int(hsize * 0.10)
        box = (max(0, box[0] - pad), max(0, box[1] - pad),
               min(W, box[2] + pad), min(H, box[3] + pad))
        img = img.crop(box)
    img.save(c["out"])
    json.dump({"file": c["out"], "w": img.width, "h": img.height,
               "frameW": W, "frameH": H,
               "x": (box[0] / W) if box else 0, "y": (box[1] / H) if box else 0,
               "scale": (img.width / W) if box else 1}, sys.stdout)

main()
