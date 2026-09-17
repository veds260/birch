"""One place for type. SF Pro ships with every Mac and is a variable font, so a
"face" here is a weight and a width on it rather than a file. Anything that isn't
an sf: spec is treated as a plain font path."""
import os
from PIL import ImageFont

SF = "/System/Library/Fonts/SFNS.ttf"
FALLBACK = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
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
