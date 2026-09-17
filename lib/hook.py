#!/usr/bin/env python3
"""A hook card: the big line that sits over the first seconds of a reel."""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fonts

HOME = os.path.expanduser("~")
FACE = "sf:heavy"

def wrap(d, text, font, maxw):
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=font) <= maxw or not cur: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def main():
    c = json.load(sys.stdin)
    W, H = c["width"], c["height"]
    text = c["text"].strip()
    look = c.get("look", "block")          # block | banner | plain
    accent = c.get("accent", "#F5D033")
    size = c.get("size") or int(H * 0.072)
    top = float(c.get("top", 0.11))

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = fonts.load(FACE, size)
    maxw = int(W * 0.82)
    # a title line keeps the case it was typed in; only the opening hook shouts
    up = c.get("upper", c.get("place") != "upper")
    lines = wrap(d, text.upper() if up else text, font, maxw)
    asc, desc = font.getmetrics()
    lh = asc + desc
    gap = int(size * 0.16)
    block_h = lh * len(lines) + gap * (len(lines) - 1)
    y = int(H * top) if c.get("place") != "upper" else int(H * 0.27 - block_h / 2)
    rgb = tuple(int(accent[j:j+2], 16) for j in (1, 3, 5))

    if look == "banner":
        pad = int(size * 0.42)
        d.rounded_rectangle([int(W * .06), y - pad, int(W * .94), y + block_h + pad],
                            radius=int(size * .28), fill=rgb + (255,))
    for i, ln in enumerate(lines):
        tw = d.textlength(ln, font=font)
        x = (W - tw) / 2
        yy = y + i * (lh + gap)
        if look == "block":
            # each line gets its own tight plate, the way a title card reads
            pad = int(size * .22)
            d.rounded_rectangle([x - pad, yy + int(size * .08),
                                 x + tw + pad, yy + asc + desc - int(size * .08)],
                                radius=int(size * .16), fill=(0, 0, 0, 235))
            d.text((x, yy), ln, font=font, fill="#FFFFFF")
        elif look == "banner":
            d.text((x, yy), ln, font=font, fill="#101010")
        else:
            d.text((x, yy), ln, font=font, fill="#FFFFFF",
                   stroke_width=int(size * .09), stroke_fill=(0, 0, 0, 255))
    img.save(c["out"])
    json.dump({"file": c["out"], "lines": len(lines)}, sys.stdout)

main()
