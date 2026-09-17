#!/usr/bin/env python3
"""Real pictures of the things being talked about. Wikimedia Commons has free
images of companies, people, places and logos, no key needed. Evidence beats
atmosphere: a photo of the actual thing lands where a generated mood shot does not."""
import json, sys, os, subprocess, urllib.parse

UA = "VideoDesk/1.0 (local editing tool)"

def get(url):
    r = subprocess.run(["curl", "-sS", "--max-time", "20", "-H", f"User-Agent: {UA}", url],
                       capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""

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
                    "credit": (meta.get("Artist", {}).get("value", "") or "")[:120],
                    "licence": meta.get("LicenseShortName", {}).get("value", "")})
    return out

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
        credit, licence = "", ""
        try:
            m = json.loads(get("https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo"
                               f"&iiprop=extmetadata&titles=File:{urllib.parse.quote(name)}") or "{}")
            for pg in (m.get("query", {}).get("pages") or {}).values():
                meta = ((pg.get("imageinfo") or [{}])[0]).get("extmetadata") or {}
                credit = meta.get("Artist", {}).get("value", "") or ""
                licence = meta.get("LicenseShortName", {}).get("value", "") or ""
        except Exception: pass
        return [{"title": name, "url": th["source"], "w": th.get("width"), "h": th.get("height"), "credit": credit, "licence": licence}]
    return []

def plain(html):
    import re
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html or "")).strip()[:80]

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
