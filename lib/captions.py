#!/usr/bin/env python3
"""Caption frames. No libass or libfreetype in this ffmpeg, so every style is
drawn here and composited as images. Word-level styles emit several frames per
word to get the pop, which is what makes them read as alive rather than a slab."""
import json, sys, os, random
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fonts

import os as _os
_HOME = _os.path.expanduser("~")
FONTS = {
    "black": "sf:heavy",
    "bold":  "sf:bold",
    "scrawl": next((p for p in ["/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
                               "/System/Library/Fonts/Supplemental/MarkerFelt.ttc"] if _os.path.exists(p)),
                  "sf:bold"),
    "sub":   "sf:semi",
    "reg":   "sf:regular",
}

# per style: font, uppercase, stroke share, active colour, plate, words per card,
# reveal one at a time, pop animation, vertical placement, size multiplier
STYLES = {
  # white marker handwriting across the chest, no plate
  "scrawl":   dict(font="scrawl", upper=False, stroke=0.0, hi=None, plate=False,
                   chunk=3, reveal=False, anim=False, place="under", mult=1.05),
  # thin white line for letterboxed story footage
  "story":    dict(font="sub", upper=False, stroke=0.0, hi=None, plate=False,
                   chunk=6, reveal=False, anim=False, place="middle", mult=0.7),
  # one or two lowercase words, yellow with a black edge, sitting on the
  # seam between the white top panel and the speaker below
  "seam": dict(font="black", upper=False, stroke=.11, hi=None, plate=False,
                   chunk=2, reveal=False, anim=False, place="seam", mult=0.95, color="#F5E31C"),
  # what the reference reels use: small, sentence case, soft shadow, out of the way
  "minimal": dict(font="sub",   upper=False, stroke=0.0,  hi=None,     plate=False,
                  chunk=4, reveal=False, anim=False, place="under",  mult=0.95),
  "plate":   dict(font="black", upper=True,  stroke=.13, hi="#F5D033", plate=False,
                  chunk=3, reveal=True,  anim=True,  place="low",    mult=1.5, hlbox=True),
  "pop":     dict(font="black", upper=True,  stroke=.13, hi="#39E08B", plate=False,
                  chunk=3, reveal=True,  anim=True,  place="middle", mult=1.55, hlbox=True),
  "single":  dict(font="black", upper=True,  stroke=.14, hi=None,     plate=False,
                  chunk=1, reveal=True,  anim=True,  place="middle", mult=2.0),
  # the personal-brand look: sentence case, soft shadow, no stroke, sits high
  "clean":   dict(font="bold",  upper=False, stroke=0.0,  hi=None,     plate=False,
                  chunk=5, reveal=False, anim=False, place="upper",  mult=1.0),
  "karaoke": dict(font="black", upper=True,  stroke=.13, hi="#F5D033", plate=False,
                  chunk=6, reveal=False, anim=False, place="bottom", mult=1.0),
  "outline": dict(font="black", upper=False, stroke=.13, hi=None,     plate=False,
                  chunk=6, reveal=False, anim=False, place="bottom", mult=1.0),
  "box":     dict(font="bold",  upper=False, stroke=0.0, hi=None,     plate=True,
                  chunk=6, reveal=False, anim=False, place="bottom", mult=1.0),
}

def fnt(name, size):
    p = FONTS.get(name, FONTS["bold"])
    return fonts.load(p, size)

def place_y(place, H, block_h, bottom, jitter):
    if place == "seam":   base = H * 0.53 - block_h / 2      # where the white panel meets the speaker
    elif place == "under":  base = H * 0.66 - block_h / 2      # just below the face
    elif place == "upper":  base = H * 0.44 - block_h / 2
    elif place == "middle": base = (H - block_h) / 2
    elif place == "low":  base = H * 0.62 - block_h / 2
    else:                 base = int(H * (1 - bottom)) - block_h
    return base + jitter

def draw(cfg, st, words, active, scale, path, jitter, pos=None):
    W, H = cfg["width"], cfg["height"]
    base = int((cfg.get("size") or H * 0.052) * st["mult"] * float((pos or {}).get("mult", 1.0)))
    stroke = int(base * st["stroke"])
    space = int(base * 0.30)
    maxw = int(W * 0.88)
    fill = st.get("color") or cfg.get("color", "#FFFFFF")
    hi = cfg.get("highlight") or st["hi"]

    toks = [w["text"].upper() if st["upper"] else w["text"] for w in words]
    if st["reveal"]: toks = toks[:active + 1]
    if not toks: toks = [""]

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # the live word can be a size of its own, which is the whole look
    sizes = [int(base * scale) if i == active else base for i in range(len(toks))]
    fonts = [fnt(st["font"], s) for s in sizes]
    widths = [d.textlength(t, font=f) for t, f in zip(toks, fonts)]

    lines, cur, cw = [], [], 0
    for i, t in enumerate(toks):
        if cur and cw + space + widths[i] > maxw:
            lines.append(cur); cur, cw = [], 0
        cur.append(i); cw += widths[i] + (space if len(cur) > 1 else 0)
    if cur: lines.append(cur)

    asc, desc = fnt(st["font"], base).getmetrics()
    lh = asc + desc
    gap = int(base * 0.18)
    block_h = lh * len(lines) + gap * (len(lines) - 1)
    y0 = place_y(st["place"], H, block_h, float(cfg.get("bottom", .14)), jitter)
    xshift = 0
    if pos and "top" in pos:
        # fixed for the whole video: the first line always starts at the same height
        y0 = int(H * float(pos["top"]))
        y0 = max(int(H * .04), min(H - block_h - int(H * .04), y0))
    if pos and "cy" in pos:
        # dynamic mode: this line goes where the face is not
        y0 = int(H * float(pos["cy"]) - block_h / 2)
        y0 = max(int(H * .04), min(H - block_h - int(H * .04), y0))
        cxp = float(pos.get("cx", .5))
        widest = max(sum(widths[i] for i in ln) + space * (len(ln) - 1) for ln in lines)
        xshift = int(W * cxp - W / 2)
        xshift = max(-(W - widest) // 2 + int(W * .03), min((W - widest) // 2 - int(W * .03), xshift))

    if st["plate"]:
        bw = max(sum(widths[i] for i in ln) + space * (len(ln) - 1) for ln in lines)
        x0 = (W - bw) / 2
        px, py = int(base * .55), int(base * .34)
        box = cfg.get("box", "#000000")
        rgb = tuple(int(box[j:j+2], 16) for j in (1, 3, 5))
        a = int(255 * float(cfg.get("boxOpacity", .72)))
        d.rounded_rectangle([x0 - px, y0 - py, x0 + bw + px, y0 + block_h + py],
                            radius=int(base * .26), fill=rgb + (a,))

    for li, ln in enumerate(lines):
        lw = sum(widths[i] for i in ln) + space * (len(ln) - 1)
        x = (W - lw) / 2 + xshift
        y = y0 + li * (lh + gap)
        for i in ln:
            on = (i == active)
            col = fill
            if on and hi:
                if st.get("hlbox"):
                    a2b, d2b = fonts[i].getmetrics()
                    yb = y + (asc - a2b)
                    padx, pady = int(base * .16), int(base * .06)
                    rgb = tuple(int(hi[j:j+2], 16) for j in (1, 3, 5))
                    d.rounded_rectangle(
                        [x - padx, yb + pady, x + widths[i] + padx, yb + a2b + d2b - pady],
                        radius=int(base * .14), fill=rgb + (255,))
                    col = "#141414"      # dark type on the plate, never outlined white
                else:
                    col = hi
            # a bigger word still has to sit on the same baseline
            a2, d2 = fonts[i].getmetrics()
            yy = y + (asc - a2)
            plated = on and hi and st.get("hlbox")
            if stroke and not plated:
                d.text((x, yy), toks[i], font=fonts[i], fill=col,
                       stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
            elif plated:
                d.text((x, yy), toks[i], font=fonts[i], fill=col)
            else:
                if not st["plate"]:
                    # a ring of soft shadow, so the line reads over a dark robe or a
                    # bright wall without needing a box behind it
                    r = max(2, int(base * .035))
                    for dx, dy, a in ((0, r, 170), (0, -r, 90), (r, 0, 110), (-r, 0, 110),
                                      (0, r * 2, 120), (1, 1, 120)):
                        d.text((x + dx, yy + dy), toks[i], font=fonts[i], fill=(0, 0, 0, a))
                d.text((x, yy), toks[i], font=fonts[i], fill=col)
            x += widths[i] + space
    img.save(path)

POP = [(.66, .045), (1.14, .045), (1.0, None)]   # scale, how long it holds

def main():
    cfg = json.load(sys.stdin)
    st = STYLES.get(cfg.get("style", "minimal"), STYLES["minimal"])
    outdir = cfg["outdir"]
    os.makedirs(outdir, exist_ok=True)
    rnd = random.Random(7)
    out, n = [], 0
    for ci, c in enumerate(cfg["captions"]):
        words = c.get("words") or [{"text": c["text"], "start": c["start"], "end": c["end"]}]
        # nudge each card off the last one so it is not pinned to one spot
        jit = rnd.randint(-int(cfg["height"] * .035), int(cfg["height"] * .035)) \
              if cfg.get("drift") else 0
        pos = c.get("pos")
        if not (st["hi"] or st["reveal"]) :
            p = os.path.join(outdir, f"c{n:05d}.png"); n += 1
            draw(cfg, st, words, -1, 1.0, p, jit, pos)
            out.append({"file": p, "start": c["start"], "end": c["end"]})
            continue
        for wi, w in enumerate(words):
            span = max(.08, w["end"] - w["start"])
            steps = POP if (st["anim"] and span > .16) else [(1.0, None)]
            t = w["start"]
            for scale, hold in steps:
                p = os.path.join(outdir, f"c{n:05d}.png"); n += 1
                draw(cfg, st, words, wi, scale, p, jit, pos)
                end = w["end"] if hold is None else min(w["end"], t + hold)
                out.append({"file": p, "start": t, "end": end})
                t = end
    Image.new("RGBA", (cfg["width"], cfg["height"]), (0, 0, 0, 0)).save(
        os.path.join(outdir, "blank.png"))
    json.dump(out, sys.stdout)

main()
