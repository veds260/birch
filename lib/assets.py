#!/usr/bin/env python3
"""Real pictures of the things being talked about. Wikimedia Commons has free
images of companies, people, places and logos, no key needed. Evidence beats
atmosphere: a photo of the actual thing lands where a generated mood shot does not."""
import json, sys, os, subprocess, urllib.parse

UA = "Birch/1.0 (open source video editor; https://birch.video)"

def get(url):
    r = subprocess.run(["curl", "-sS", "--max-time", "20", "-H", f"User-Agent: {UA}", url],
                       capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""

def plain(html):
    import re
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html or "")).strip()[:80]

def search(term, limit=6):
    # the page first, so we get the subject's own image rather than anything named alike
    q = urllib.parse.quote(term)
    url = ("https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search"
           f"&gsrsearch={q}&gsrlimit={limit}&gsrnamespace=6"
           "&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1200")
    try: d = json.loads(get(url) or "{}")
    except Exception: return []
    out = []
    for p in (d.get("query", {}).get("pages") or {}).values():
        ii = (p.get("imageinfo") or [{}])[0]
        u = ii.get("thumburl") or ii.get("url")
        # thumbnail urls carry a tracking query string, so test the path only
        if not u or not u.split("?")[0].lower().endswith((".jpg", ".jpeg", ".png")): continue
        meta = ii.get("extmetadata") or {}
        out.append({"title": p.get("title", "").replace("File:", ""), "url": u,
                    "w": ii.get("thumbwidth") or ii.get("width"), "h": ii.get("thumbheight") or ii.get("height"),
                    "credit": plain(meta.get("Artist", {}).get("value", "")),
                    "licence": meta.get("LicenseShortName", {}).get("value", "")})
    return out

FREE_ENOUGH = ("public domain", "cc0", "cc by", "cc-by", "attribution", "gfdl", "free art")
NOT_FREE = ("fair use", "non-free", "nonfree", "trademark", "all rights reserved")


def free_file(name):
    """Commons metadata for a file, or None when it is not on Commons or not free.

    Wikipedia's own article image is often a non-free logo uploaded under fair use,
    which nobody may put in their video. Only files that live on Commons under a
    free licence come back from here."""
    try:
        m = json.loads(get("https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo"
                           f"&iiprop=extmetadata|url&titles=File:{urllib.parse.quote(name)}") or "{}")
    except Exception:
        return None
    for pg in (m.get("query", {}).get("pages") or {}).values():
        if "missing" in pg:          # not on Commons, so treat it as not free
            return None
        meta = ((pg.get("imageinfo") or [{}])[0]).get("extmetadata") or {}
        licence = (meta.get("LicenseShortName", {}).get("value", "") or "").strip()
        low = licence.lower()
        if any(b in low for b in NOT_FREE):
            return None
        if licence and not any(f in low for f in FREE_ENOUGH):
            return None
        return {"credit": meta.get("Artist", {}).get("value", "") or "", "licence": licence}
    return None


def lead_image(term):
    # the Wikipedia article's own picture: a company's logo, a person's portrait, a
    # place's best-known photo. Far more reliable than whatever a file search ranks first.
    q = urllib.parse.quote(term)
    try:
        d = json.loads(get("https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1"
                           f"&prop=pageimages&piprop=thumbnail|name&pithumbsize=1200&titles={q}") or "{}")
    except Exception: return []
    for p in (d.get("query", {}).get("pages") or {}).values():
        th, name = p.get("thumbnail"), p.get("pageimage")
        if not th or not name: continue
        free = free_file(name)
        if not free:
            return []            # the article's picture is not ours to use
        return [{"title": name, "url": th["source"], "w": th.get("width"), "h": th.get("height"),
                 "credit": free["credit"], "licence": free["licence"]}]
    return []

def main():
    cfg = json.load(sys.stdin)
    term = cfg["term"]
    hits = lead_image(term) or search(term)
    if not hits: 
        json.dump({"found": False, "term": term}, sys.stdout); return
    best = hits[0] if len(hits) == 1 else max(hits, key=lambda h: (h.get("w") or 0) * (h.get("h") or 0))
    out = cfg["out"]
    r = subprocess.run(["curl", "-sSL", "--max-time", "40", "-H", f"User-Agent: {UA}",
                        "-o", out, best["url"]], capture_output=True)
    ok = os.path.exists(out) and os.path.getsize(out) > 8000
    json.dump({"found": ok, "term": term, "file": out if ok else None,
               "title": best["title"], "credit": plain(best["credit"]), "licence": best["licence"],
               "alternatives": len(hits)}, sys.stdout)

main()
