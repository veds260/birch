"""One place for type. SF Pro ships with every Mac and is a variable font, so a
"face" here is a weight and a width on it rather than a file. Anything that isn't
an sf: spec is treated as a plain font path."""
import os
from PIL import ImageFont

SF = "/System/Library/Fonts/SFNS.ttf"

def _first(paths):
    return next((p for p in paths if os.path.exists(p)), None)

def _fc(pattern):
    """Ask fontconfig (Linux) for a real file for a pattern like 'sans-serif:bold'."""
    try:
        import subprocess
        out = subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, timeout=5).stdout.decode()
        return out.strip() or None
    except Exception:
        return None

# Windows keeps everything in one folder. Segoe UI Variable is the closest thing it
# has to SF Pro, and every install has Segoe UI Bold and Arial Bold behind it.
WIN_FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
_w = lambda *names: _first([os.path.join(WIN_FONTS, n) for n in names])
WIN_HEAVY = _w("SegUIVar.ttf", "seguivb.ttf", "segoeuib.ttf", "arialbd.ttf", "seguisb.ttf")
WIN_TEXT = _w("SegUIVar.ttf", "segoeui.ttf", "arial.ttf", "tahoma.ttf")

# Macs have SF Pro. Elsewhere, take the heaviest grotesque that is actually installed,
# then let fontconfig pick, then give up on anything fancy.
LINUX_HEAVY = WIN_HEAVY or _first([
    "/usr/share/fonts/truetype/inter/Inter-Black.ttf",
    "/usr/share/fonts/opentype/inter/Inter-Black.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
]) or _fc("sans-serif:bold")
LINUX_TEXT = WIN_TEXT or _first([
    "/usr/share/fonts/truetype/inter/Inter-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
]) or _fc("sans-serif")
FALLBACK = _first(["/System/Library/Fonts/Supplemental/Arial Bold.ttf"]) or LINUX_HEAVY or LINUX_TEXT or ""
# name: (weight 1-1000, width 30-150)
ROLES = {
    "display": (900, 72),    # big words, condensed and heavy
    "heavy":   (860, 88),
    "bold":    (700, 100),
    "semi":    (600, 100),
    "medium":  (510, 100),
    "regular": (400, 100),
}
_cache = {}

def load(spec, size):
    size = max(8, int(size))
    key = (spec, size)
    if key in _cache: return _cache[key]
    if isinstance(spec, str) and spec.startswith("sf:") and not os.path.exists(SF):
        # no SF Pro here, so heavy roles take the bold face and the rest the regular one
        weight = ROLES.get(spec[3:], ROLES["bold"])[0]
        path = (LINUX_HEAVY if weight >= 600 else LINUX_TEXT) or FALLBACK
        f = ImageFont.truetype(path, size) if path else ImageFont.load_default()
        # Segoe UI Variable on Windows is one file for every weight, and its default
        # instance is far too light for a caption, so ask for the weight by name
        try:
            axes = f.get_variation_axes()
            if axes:
                f.set_variation_by_axes([min(max(weight, a["minimum"]), a["maximum"])
                                         if (a.get("name") in (b"Weight", "Weight")) else a["default"]
                                         for a in axes])
        except Exception:
            pass
        _cache[key] = f
        return f
    if isinstance(spec, str) and spec.startswith("sf:") and os.path.exists(SF):
        weight, width = ROLES.get(spec[3:], ROLES["bold"])
        f = ImageFont.truetype(SF, size)
        try: f.set_variation_by_axes([width, min(96, max(17, size / 2)), 400, weight])
        except Exception: pass
    else:
        path = spec if isinstance(spec, str) and os.path.exists(spec) else FALLBACK
        f = ImageFont.truetype(path, size)
    _cache[key] = f
    return f
