#!/usr/bin/env python3
"""Render a tweet as a PNG card. Takes a tweet URL or id on stdin as JSON,
pulls the tweet from twitterapi.io, and draws it with Pillow."""
import json, sys, os, re, io, subprocess
# the python.org build has no CA bundle, so network calls go through curl
def get(url, headers=None, binary=False):
    cmd = ["curl", "-sS", "--fail", "--max-time", "25", url]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise SystemExit((r.stderr.decode() or "request failed").strip())
    return r.stdout if binary else r.stdout.decode()
from PIL import Image, ImageDraw, ImageFont

KEY = os.environ.get("TWITTERAPI_KEY", "")
B = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
R = "/System/Library/Fonts/Supplemental/Arial.ttf"
E = "/System/Library/Fonts/Apple Color Emoji.ttc"

def fetch(tid):
    d = json.loads(get(f"https://api.twitterapi.io/twitter/tweets?tweet_ids={tid}",
                       {"X-API-Key": KEY}))
    ts = d.get("tweets") or []
    if not ts: raise SystemExit("tweet not found")
    return ts[0]

def avatar(url, size):
    try:
        url = re.sub(r"_normal(\.\w+)$", r"_400x400\1", url)
        raw = get(url, binary=True)
        im = Image.open(io.BytesIO(raw)).convert("RGBA").resize((size, size), Image.LANCZOS)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
        im.putalpha(mask)
        return im
    except Exception:
        im = Image.new("RGBA", (size, size), (120, 120, 130, 255))
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
        im.putalpha(mask); return im

def wrap(d, text, font, maxw):
    lines = []
    for para in text.split("\n"):
        if not para.strip(): lines.append(""); continue
        cur = ""
        for w in para.split():
            t = (cur + " " + w).strip()
            if d.textlength(t, font=font) <= maxw or not cur: cur = t
            else: lines.append(cur); cur = w
        lines.append(cur)
    return lines

def main():
    cfg = json.load(sys.stdin)
    tid = str(cfg["tweet"]).rstrip("/").split("/")[-1].split("?")[0]
    t = fetch(tid)
    a = t.get("author", {})
    dark = bool(cfg.get("dark", True))
    W = int(cfg.get("width", 900))
    pad = int(W * 0.055)
    fs = int(W * 0.047)

    ink = "#E7E9EA" if dark else "#0F1419"
    sub = "#71767B" if dark else "#536471"
    bg  = (21, 32, 43, 255) if dark else (255, 255, 255, 255)
    edge = (47, 60, 72, 255) if dark else (207, 217, 222, 255)

    f_name = ImageFont.truetype(B, int(fs * 0.95))
    f_at   = ImageFont.truetype(R, int(fs * 0.9))
    f_body = ImageFont.truetype(R, fs)

    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    text = re.sub(r"https://t\\.co/\\w+", "", t.get("text", ""))
    # Pillow cannot draw Apple Color Emoji inline, so they would come out as boxes
    text = re.sub("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u2B00-\u2BFF]", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    lines = wrap(probe, text, f_body, W - pad * 2)
    lh = int(fs * 1.42)
    av = int(fs * 2.1)
    head_h = av
    body_h = lh * len(lines)
    foot_h = int(fs * 1.5) if cfg.get("metrics", True) else 0
    H = pad * 2 + head_h + int(fs * 0.7) + body_h + foot_h

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=int(W * 0.028), fill=bg,
                        outline=edge, width=2)

    img.alpha_composite(avatar(a.get("profilePicture", ""), av), (pad, pad))
    nx = pad + av + int(fs * 0.5)
    d.text((nx, pad + int(fs * 0.08)), a.get("name", ""), font=f_name, fill=ink)
    if a.get("isBlueVerified"):
        w = d.textlength(a.get("name", ""), font=f_name)
        cx, cy = nx + w + fs * 0.35, pad + fs * 0.52
        d.ellipse([cx - fs*0.28, cy - fs*0.28, cx + fs*0.28, cy + fs*0.28], fill="#1D9BF0")
        d.line([(cx-fs*0.13, cy), (cx-fs*0.03, cy+fs*0.11), (cx+fs*0.15, cy-fs*0.12)],
               fill="white", width=max(2, int(fs*0.07)))
    d.text((nx, pad + int(fs * 1.05)), "@" + str(a.get("userName", "")), font=f_at, fill=sub)

    y = pad + head_h + int(fs * 0.7)
    for ln in lines:
        d.text((pad, y), ln, font=f_body, fill=ink)
        y += lh

    if foot_h:
        n = lambda v: f"{v/1000:.1f}K".replace(".0K", "K") if v and v >= 1000 else str(v or 0)
        d.text((pad, y + int(fs * 0.15)),
               f"{n(t.get('replyCount'))} replies   {n(t.get('retweetCount'))} reposts   "
               f"{n(t.get('likeCount'))} likes", font=f_at, fill=sub)

    out = cfg["out"]
    img.save(out)
    json.dump({"file": out, "width": W, "height": H,
               "text": text[:120], "author": a.get("userName")}, sys.stdout)

main()
