#!/usr/bin/env python3
"""Keyword moves: a big word the speaker leans on, a word
cloud scattered round the head, a green gradient headline, and an Instagram-style
comment card. One script, `kind` picks."""
import json, sys, os, math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fonts

HOME = os.path.expanduser("~")
def pick(*p): return next((x for x in p if os.path.exists(x)), "/System/Library/Fonts/Supplemental/Arial Bold.ttf")
FACES = {
  "heavy":  "sf:heavy",
  "bold":   "sf:bold",
  "medium": "sf:medium",
  "scrawl": pick("/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf", "/System/Library/Fonts/Supplemental/MarkerFelt.ttc"),
  "sans":   pick("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
}
def hexrgb(h): h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def text_layer(text, font, fill, stroke=0, stroke_fill=(0,0,0,255)):
    d0 = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    x0, y0, x1, y1 = d0.textbbox((0, 0), text, font=font, stroke_width=stroke)
    im = Image.new("RGBA", (x1 - x0 + 4, y1 - y0 + 4), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((-x0 + 2, -y0 + 2), text, font=font, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
    return im

def shadow(im, off=(0, 10), blur=14, alpha=170):
    a = im.split()[3].point(lambda v: min(255, v * alpha // 255))
    sh = Image.new("RGBA", im.size, (0, 0, 0, 0)); sh.putalpha(a)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    out = Image.new("RGBA", (im.width + abs(off[0]) + blur * 2, im.height + abs(off[1]) + blur * 2), (0, 0, 0, 0))
    out.alpha_composite(sh, (blur + max(0, off[0]), blur + max(0, off[1])))
    out.alpha_composite(im, (blur + max(0, -off[0]), blur + max(0, -off[1])))
    return out

def confetti(img, cx, cy, n=42, seed=3, palette=None, reach=None):
    rnd = random.Random(seed); d = ImageDraw.Draw(img)
    palette = palette or ["#F59A23", "#FF5A36", "#2FB4F5", "#F5E31C", "#FFFFFF", "#7C4DFF"]
    reach = reach or img.width * .30
    for _ in range(n):
        ang = rnd.uniform(0, math.tau); dist = rnd.uniform(reach * .45, reach)
        x, y = cx + math.cos(ang) * dist, cy + math.sin(ang) * dist * .75
        w, h = rnd.uniform(8, 26), rnd.uniform(14, 48)
        rot = rnd.uniform(0, 180)
        piece = Image.new("RGBA", (int(w) + 2, int(h) + 2), (0, 0, 0, 0))
        ImageDraw.Draw(piece).rectangle([1, 1, w, h], fill=hexrgb(rnd.choice(palette)) + (235,))
        piece = piece.rotate(rot, expand=True)
        img.alpha_composite(piece, (int(x - piece.width / 2), int(y - piece.height / 2)))

def soft_shadow(im, blur, alpha=150, drop=0.0):
    # a wide soft shadow needs room to fall off, or the blur stops at a hard edge
    pad = int(blur * 3)
    a = im.split()[3].point(lambda v: v * alpha // 255)
    sh = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), (0, 0, 0, 0))
    mask = Image.new("L", sh.size, 0); mask.paste(a, (pad, pad + int(drop)))
    sh.putalpha(mask.filter(ImageFilter.GaussianBlur(blur)))
    sh.alpha_composite(im, (pad, pad))
    return sh

def kind_pop(c, img, W, H):
    # one or two words the speaker leans on. Clean: heavy condensed white with a soft
    # shadow, the way most reels do it. Block: ink on a yellow slab, for louder edits.
    text = c["text"].strip().upper()
    look = c.get("look", "clean")
    role = "display" if look == "clean" else "heavy"
    size = int(c.get("size") or min(H * 0.1, W * 0.2))
    maxw = W * (0.84 if look == "clean" else 0.74)
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    font = fonts.load("sf:" + role, size)
    while size > 24 and probe.textlength(text, font=font) > maxw:
        size = int(size * 0.94); font = fonts.load("sf:" + role, size)
    x0, y0, x1, y1 = probe.textbbox((0, 0), text, font=font)
    tw, th = x1 - x0, y1 - y0
    if look == "block":
        px, py = int(size * 0.22), int(size * 0.14)
        slab = Image.new("RGBA", (tw + px * 2, th + py * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(slab)
        d.rounded_rectangle([0, 0, slab.width - 1, slab.height - 1], radius=int(size * 0.08), fill=hexrgb(c.get("color", "#FFD23F")) + (255,))
        d.text((px - x0, py - y0), text, font=font, fill=(11, 20, 64, 255))
        piece = soft_shadow(slab.rotate(float(c.get("tilt", -2.5)), expand=True, resample=Image.BICUBIC), blur=size * 0.18, alpha=120, drop=size * 0.06)
    else:
        layer = Image.new("RGBA", (tw + 8, th + 8), (0, 0, 0, 0))
        ImageDraw.Draw(layer).text((4 - x0, 4 - y0), text, font=font, fill=hexrgb(c.get("color", "#FFFFFF")) + (255,))
        piece = soft_shadow(layer, blur=size * 0.16, alpha=165, drop=size * 0.05)
    cy = int(H * float(c.get("y", .62)))
    if c.get("burst"): confetti(img, W // 2, cy, seed=int(c.get("seed", 3)), reach=tw * 0.42)
    img.alpha_composite(piece, ((W - piece.width) // 2, max(0, min(H - piece.height, cy - piece.height // 2))))

def kind_cloud(c, img, W, H):
    # words scattered round the head at different sizes and tilts, warm palette
    words = c["words"]; rnd = random.Random(int(c.get("seed", 11)))
    palette = c.get("palette") or ["#F5E31C", "#F59A23", "#FFFFFF", "#FFD36B"]
    spots = [(.18, .12), (.55, .07), (.82, .11), (.12, .28), (.86, .27), (.2, .44), (.84, .44), (.5, .18), (.3, .34), (.7, .35)]
    for i, w in enumerate(words[:10]):
        size = int(H * rnd.uniform(.035, .06)); font = fonts.load(FACES["scrawl"] if c.get("scrawl", True) else FACES["heavy"], size)
        layer = shadow(text_layer(w, font, hexrgb(palette[i % len(palette)]) + (255,)), off=(0, 5), blur=8, alpha=150)
        layer = layer.rotate(rnd.uniform(-14, 14), expand=True, resample=Image.BICUBIC)
        sx, sy = spots[i % len(spots)]
        img.alpha_composite(layer, (int(W * sx - layer.width / 2), int(H * sy - layer.height / 2)))

def gradient_text(text, font, top, bottom):
    mask = text_layer(text, font, (255, 255, 255, 255))
    grad = Image.new("RGBA", mask.size, (0, 0, 0, 0)); gd = ImageDraw.Draw(grad)
    t, b = hexrgb(top), hexrgb(bottom)
    for y in range(mask.height):
        f = y / max(1, mask.height - 1)
        gd.line([(0, y), (mask.width, y)], fill=tuple(int(t[k] + (b[k] - t[k]) * f) for k in range(3)) + (255,))
    grad.putalpha(mask.split()[3])
    return grad

def kind_gradient(c, img, W, H):
    # the green-to-white two-line hook, big line then a lighter second line
    head = c["text"].strip(); sub = (c.get("sub") or "").strip()
    size = int(c.get("size") or H * 0.075)
    font = fonts.load(FACES["scrawl"] if c.get("face") == "scrawl" else FACES["heavy"], size)
    top, bottom = c.get("top", "#2ECC71"), c.get("bottom", "#FFFFFF")
    blocks = [shadow(gradient_text(ln, font, top, bottom), off=(0, 8), blur=12) for ln in head.split("\n")]
    if sub:
        f2 = fonts.load(FACES["bold"], int(size * .55))
        blocks.append(shadow(text_layer(sub, f2, (255, 255, 255, 255)), off=(0, 5), blur=8))
    total = sum(b.height for b in blocks) - int(size * .2) * (len(blocks) - 1)
    y = int(H * float(c.get("y", .62))) - total // 2
    for b in blocks:
        img.alpha_composite(b, ((W - b.width) // 2, y)); y += b.height - int(size * .2)

def kind_comment(c, img, W, H):
    # an Instagram reply card: avatar circle, handle, the comment, "Replying to"
    text = c["text"].strip(); handle = c.get("handle", "someone")
    size = int(H * .026); f = fonts.load(FACES["medium"], size); fb = fonts.load(FACES["bold"], int(size * .95))
    d0 = ImageDraw.Draw(img); maxw = int(W * .62)
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d0.textlength(t, font=f) <= maxw or not cur: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    lh = int(size * 1.35); pad = int(size * .9); av = int(size * 1.6)
    cw = int(W * .76); ch = pad * 2 + lh * len(lines) + int(size * 1.9)
    x0 = int(W * float(c.get("x", .05))); y0 = int(H * float(c.get("y", .62)))
    card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0)); cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([0, 0, cw - 1, ch - 1], radius=int(size * .9), fill=(255, 255, 255, 248))
    cd.ellipse([pad, pad, pad + av, pad + av], fill=(52, 120, 84, 255))
    cd.text((pad + av + int(size * .6), pad + int(av * .15)), handle, font=fb, fill=(20, 20, 20, 255))
    y = pad + av + int(size * .5)
    for ln in lines: cd.text((pad, y), ln, font=f, fill=(24, 24, 24, 255)); y += lh
    cd.text((pad, y + int(size * .2)), "Replying to " + handle, font=fonts.load(FACES["medium"], int(size * .8)), fill=(130, 130, 130, 255))
    img.alpha_composite(shadow(card, off=(0, 10), blur=16, alpha=120), (x0, y0))

def main():
    c = json.load(sys.stdin)
    W, H = c["width"], c["height"]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    {"pop": kind_pop, "cloud": kind_cloud, "gradient": kind_gradient, "comment": kind_comment}[c["kind"]](c, img, W, H)
    box = img.getbbox()
    out = {"file": c["out"], "x": 0, "y": 0, "scale": 1}
    if box and c.get("tight", True):
        pad = int(H * .01)
        box = (max(0, box[0] - pad), max(0, box[1] - pad), min(W, box[2] + pad), min(H, box[3] + pad))
        img = img.crop(box); out.update(x=box[0] / W, y=box[1] / H, scale=img.width / W, ar=img.height / img.width)
    img.save(c["out"]); json.dump(out, sys.stdout)
main()
