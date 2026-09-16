#!/usr/bin/env python3
"""A name card: a cream rounded tag with the name in heavy type and one line under
it, drawn on a transparent full frame so the renderer can lay it straight over the
picture. Sits lower left, inside the part of the screen Instagram leaves alone."""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

HOME = os.path.expanduser("~")
def pick(*p): return next((x for x in p if os.path.exists(x)), "/System/Library/Fonts/Supplemental/Arial Bold.ttf")
HEAVY = pick(HOME + "/Library/Fonts/MikadoUltra.otf", "/System/Library/Fonts/Supplemental/Arial Black.ttf")
BOLD = pick(HOME + "/Library/Fonts/MikadoBold.otf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf")

def hexrgb(h, a=255): h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4)) + (a,)

def main():
    c = json.load(sys.stdin)
    W, H = c["width"], c["height"]
    name = (c.get("name") or "").strip()[:40]
    role = (c.get("role") or "").strip()[:60]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    short = min(W, H)
    fs_name = int(short * 0.074); fs_role = int(short * 0.04)
    f_name = ImageFont.truetype(HEAVY, fs_name); f_role = ImageFont.truetype(BOLD, fs_role)
    pad_x = int(short * 0.04); pad_y = int(short * 0.028); gap = int(short * 0.01)
    maxw = int(W * 0.78) - pad_x * 2
    while d.textlength(name, font=f_name) > maxw and fs_name > 20:
        fs_name -= 2; f_name = ImageFont.truetype(HEAVY, fs_name)
    while role and d.textlength(role, font=f_role) > maxw and fs_role > 14:
        fs_role -= 1; f_role = ImageFont.truetype(BOLD, fs_role)
    nb = d.textbbox((0, 0), name, font=f_name); rb = d.textbbox((0, 0), role, font=f_role) if role else (0, 0, 0, 0)
    tw = max(nb[2] - nb[0], rb[2] - rb[0]); th = (nb[3] - nb[1]) + ((rb[3] - rb[1]) + gap if role else 0)
    bar = int(short * 0.012)
    cw = tw + pad_x * 2 + bar; ch = th + pad_y * 2
    # lower left, above the strip Instagram fills with the caption
    x0 = int(W * 0.06); y0 = int(H * float(c.get("y", 0.70)))
    y0 = min(y0, int(H * 0.79) - ch)
    r = int(ch * 0.22)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0)); sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([x0 + 4, y0 + 10, x0 + cw + 4, y0 + ch + 10], r, fill=(11, 20, 64, 70))
    img.alpha_composite(shadow)
    d.rounded_rectangle([x0, y0, x0 + cw, y0 + ch], r, fill=hexrgb(c.get("bg", "#FFF8EA")))
    d.rounded_rectangle([x0 + pad_x // 2, y0 + pad_y, x0 + pad_x // 2 + bar, y0 + ch - pad_y], bar // 2, fill=hexrgb(c.get("accent", "#FF7A1A")))
    tx = x0 + pad_x + bar
    d.text((tx, y0 + pad_y - nb[1]), name, font=f_name, fill=hexrgb(c.get("ink", "#0B1440")))
    if role:
        d.text((tx, y0 + pad_y + (nb[3] - nb[1]) + gap - rb[1]), role, font=f_role, fill=hexrgb(c.get("sub", "#2B5BFF")))
    img.save(c["out"])
    print(json.dumps({"ok": True, "box": [x0 / W, y0 / H, cw / W, ch / H]}))

main()
