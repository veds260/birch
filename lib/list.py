#!/usr/bin/env python3
"""An accumulating list: one line appears when its word is said and stays.
Emits one full-frame PNG per state, so it becomes a track like the captions."""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

HOME = os.path.expanduser("~")
FACES = {
  "clean":  next((p for p in [HOME + "/Library/Fonts/MikadoMedium.otf",
                              "/System/Library/Fonts/Supplemental/Arial Bold.ttf"] if os.path.exists(p)), None),
  "heavy":  next((p for p in [HOME + "/Library/Fonts/MikadoUltra.otf",
                              "/System/Library/Fonts/Supplemental/Arial Black.ttf"] if os.path.exists(p)), None),
  "scrawl": next((p for p in ["/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
                              "/System/Library/Fonts/Supplemental/MarkerFelt.ttc"] if os.path.exists(p)), None),
}
FALLBACK = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

def shadowed(d, xy, text, f, fill):
    x, y = xy
    for dx, dy, a in ((0, 3, 140), (0, 1, 110), (1, 1, 90)):
        d.text((x + dx, y + dy), text, font=f, fill=(0, 0, 0, a))
    d.text((x, y), text, font=f, fill=fill)

def main():
    c = json.load(sys.stdin)
    W, H = c["width"], c["height"]
    out = c["outdir"]; os.makedirs(out, exist_ok=True)
    size = int(c.get("size") or H * 0.030)
    f = ImageFont.truetype(FACES.get(c.get("face", "clean")) or FALLBACK, size)
    asc, desc = f.getmetrics()
    lh = int((asc + desc) * 1.22)
    x0, y0 = int(W * float(c.get("x", 0.06))), int(H * float(c.get("y", 0.11)))
    numbered = c.get("numbered", True)
    fill = c.get("color", "#FFFFFF")
    look = c.get("look", "plain")            # plain | pills
    lines = c["lines"]
    files = []
    for k in range(1, len(lines) + 1):
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        y = y0
        for i, ln in enumerate(lines[:k]):
            label = (f"{i + 1}.  " if numbered else "") + ln["text"]
            if look == "pills":
                tw = d.textlength(label, font=f)
                px, py = int(size * .7), int(size * .34)
                x = (W - tw) / 2
                d.rounded_rectangle([x - px, y - py, x + tw + px, y + asc + desc + py],
                                    radius=int(size * .55), fill=(255, 255, 255, 240))
                d.text((x, y), label, font=f, fill="#141414")
                y += lh + int(size * .55)
            else:
                shadowed(d, (x0, y), label, f, fill)
                y += lh
        p = os.path.join(out, f"l{k:03d}.png")
        img.save(p)
        files.append(p)
    Image.new("RGBA", (W, H), (0, 0, 0, 0)).save(os.path.join(out, "blank.png"))
    json.dump({"files": files}, sys.stdout)

main()
