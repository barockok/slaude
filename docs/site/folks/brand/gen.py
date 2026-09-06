#!/usr/bin/env python3
"""Generate the 3D Folk mark. One geometry, one lighting rig, many finishes.

The silhouette (HEAD) is the identity. The finish is a six-colour ramp:
light, base, dark, extrusion side, eye-top, eye-bottom. Everything else is
derived: extrusion as eight stacked copies toward the lower right, a lit face
gradient, a top-left specular, a rim light, a bottom ambient-occlusion band,
recessed eyes with a bevel lip and a glint."""
import sys, os

# Stronger silhouette: wider head, bigger radius, heavy comma tail.
HEAD = ("M22 5H42A17 17 0 0 1 59 22V30A17 17 0 0 1 42 47H29"
        "C25 52.5 18.5 58.5 10.5 61.5C7.5 62.6 6.6 60.8 8.4 58.6"
        "C11.2 55.2 13.8 51 14.8 45.4"
        "A17 17 0 0 1 5 30V22A17 17 0 0 1 22 5Z")

EYES = {
  "bars":   [("rect", dict(x=23, y=18, width=6, height=14, rx=3)), ("rect", dict(x=35, y=18, width=6, height=14, rx=3))],
  "dots":   [("circle", dict(cx=26, cy=25, r=3.8)), ("circle", dict(cx=38, cy=25, r=3.8))],
  "dash":   [("rect", dict(x=21, y=23, width=10, height=4.5, rx=2.25)), ("rect", dict(x=33, y=23, width=10, height=4.5, rx=2.25))],
  "arrows": [("path", dict(d="M21 20.5l9 4.5-9 4.5z")), ("path", dict(d="M43 20.5l-9 4.5 9 4.5z"))],
}

FINISH = {
  # name: (light, base, dark, side, eye_top, eye_bottom)
  "plum":     ("#B565C2", "#7A2E86", "#521C5B", "#33103A", "#1A0A1E", "#3D1445"),
  "ink":      ("#4A4457", "#1E1B26", "#0F0D14", "#06050A", "#000000", "#2A2633"),
  "marigold": ("#FFD46A", "#F5B31B", "#C98600", "#7A5000", "#3A2600", "#6E4A00"),
  "blue":     ("#6FAFF3", "#1B7BE0", "#0F56A6", "#083566", "#041B36", "#0B3A6E"),
  "coral":    ("#FF8F78", "#F0553B", "#B8341F", "#6E1B0E", "#3A0D06", "#6B1A0E"),
}

def el(tag, **a):
  return "<%s %s/>" % (tag, " ".join('%s="%s"' % (k.replace("_","-"), v) for k, v in a.items()))

def eyes_svg(kind, uid, eye_top, eye_bottom, light):
  out = []
  for i, (tag, a) in enumerate(EYES[kind]):
    # bevel lip: a lighter copy nudged down, behind the socket
    b = dict(a); 
    if tag == "rect": b["y"] = a["y"] + 0.9
    elif tag == "circle": b["cy"] = a["cy"] + 0.9
    else: b["transform"] = "translate(0 0.9)"
    out.append(el(tag, fill=light, fill_opacity="0.55", **b))
    out.append(el(tag, fill="url(#%s-eye)" % uid, **a))
    # inner top shadow of the socket
    c = dict(a)
    if tag == "rect": c["height"] = min(a["height"], 4); c["fill"] = "url(#%s-eyeshade)" % uid
    elif tag == "circle": c["r"] = a["r"]; c["fill"] = "url(#%s-eyeshade)" % uid
    else: c["fill"] = "url(#%s-eyeshade)" % uid
    out.append(el(tag, **c))
    # glint
    if tag == "rect":
      out.append(el("ellipse", cx=a["x"]+a["width"]*0.62, cy=a["y"]+2.4, rx=0.9, ry=1.3, fill="#fff", fill_opacity="0.75"))
    elif tag == "circle":
      out.append(el("circle", cx=a["cx"]+1.2, cy=a["cy"]-1.4, r=0.9, fill="#fff", fill_opacity="0.75"))
  return "\n    ".join(out)

def mark(finish="plum", eyes="bars", uid=None, size=64, depth=3.2, standalone=True, ground=True):
  light, base, dark, side, eye_top, eye_bottom = FINISH[finish]
  uid = uid or f"f-{finish}-{eyes}"
  steps = 8
  ext = "\n    ".join(
    f'<path d="{HEAD}" fill="{side}" transform="translate({depth*(i+1)/steps*0.7:.2f} {depth*(i+1)/steps:.2f})"/>'
    for i in range(steps))
  defs = f'''<defs>
    <linearGradient id="{uid}-face" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="{light}"/><stop offset="0.45" stop-color="{base}"/><stop offset="1" stop-color="{dark}"/>
    </linearGradient>
    <radialGradient id="{uid}-spec" cx="0.3" cy="0.18" r="0.55">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="{uid}-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.7"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.08"/><stop offset="1" stop-color="{light}" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="{uid}-ao" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.28"/>
    </linearGradient>
    <linearGradient id="{uid}-eye" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{eye_top}"/><stop offset="1" stop-color="{eye_bottom}"/>
    </linearGradient>
    <linearGradient id="{uid}-eyeshade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="{uid}-clip"><path d="{HEAD}"/></clipPath>
    <filter id="{uid}-soft" x="-20%" y="-20%" width="140%" height="160%"><feGaussianBlur stdDeviation="1.6"/></filter>
  </defs>'''
  groundel = f'<ellipse cx="34" cy="62.2" rx="20" ry="1.8" fill="{side}" fill-opacity="0.28" filter="url(#{uid}-soft)"/>' if ground else ""
  body = f'''{groundel}
    {ext}
    <path d="{HEAD}" fill="url(#{uid}-face)"/>
    <path d="{HEAD}" fill="url(#{uid}-spec)"/>
    <path d="{HEAD}" fill="url(#{uid}-ao)"/>
    <g clip-path="url(#{uid}-clip)"><path d="{HEAD}" fill="none" stroke="url(#{uid}-rim)" stroke-width="2.2"/></g>
    {eyes_svg(eyes, uid, eye_top, eye_bottom, light)}'''
  if not standalone:
    return defs, body
  return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{size}" height="{size}" role="img" aria-label="Folks">
  <title>Folks mark ({finish}, {eyes})</title>
  {defs}
  <g>
    {body}
  </g>
</svg>
'''

# Usage:  python3 gen.py <brand-dir> brand     — rewrite every SVG in brand/ and
#         emit ../_symbols.html (the inline <symbol> block to paste into the pages).

# ---------------------------------------------------------------- emitters
PERSONAS = [("plum","bars","ops"),("marigold","dots","docs"),("blue","dash","data"),("coral","arrows","sec")]

def symbols():
  """<symbol> block for inline use. Gradient ids are namespaced per finish."""
  out = []
  for finish, eyes, _ in PERSONAS + [("ink","bars","ink")]:
    defs, body = mark(finish, eyes, uid=f"f3-{finish}", standalone=False, ground=False)
    out.append(f'<symbol id="folk-{finish}" viewBox="0 0 64 64">{defs}{body}</symbol>')
  return "\n".join(out)

def flat(color="#17141F"):
  return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Folks">
  <title>Folks mark, flat (single colour: print, favicons, monochrome contexts)</title>
  <path fill="{color}" d="{HEAD}"/>
  <rect x="23" y="18" width="6" height="14" rx="3" fill="#F7F5F2"/><rect x="35" y="18" width="6" height="14" rx="3" fill="#F7F5F2"/>
</svg>
'''

def lockup():
  parts = []
  for i, (finish, eyes, _) in enumerate([("blue","dash",0),("marigold","dots",0),("plum","bars",0)]):
    defs, body = mark(finish, eyes, uid=f"lk-{finish}", standalone=False, ground=False)
    sc = [0.72, 0.86, 1.0][i]; tx = [96, 50, 0][i]; ty = [(64-64*sc)/2, (64-64*sc)/2, 0][i]
    parts.append(f'{defs}<g transform="translate({tx} {ty:.1f}) scale({sc})"><path d="{HEAD}" fill="#F7F5F2" transform="translate(-3.5 -3) scale(1.11)"/>{body}</g>')
  return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 176 68" width="176" height="68" role="img" aria-label="Folks">
  <title>Folks lockup: three folks stacked like thread participants</title>
  {"".join(parts)}
</svg>
'''

def favicon():
  defs, body = mark("plum", "bars", uid="fav", standalone=False, ground=False)
  return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{defs}<rect width="64" height="64" rx="14" fill="#F7F5F2"/><g transform="translate(4 3) scale(0.88)">{body}</g></svg>
'''

if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[2] == "brand":  # noqa
  b = sys.argv[1]
  open(os.path.join(b, "folks-mark.svg"), "w").write(mark("plum", "bars", uid="folks"))
  open(os.path.join(b, "folks-mark-ink.svg"), "w").write(mark("ink", "bars", uid="folks-ink"))
  open(os.path.join(b, "folks-mark-flat.svg"), "w").write(flat())
  for finish, eyes, slug in PERSONAS:
    open(os.path.join(b, f"persona-{slug}.svg"), "w").write(mark(finish, eyes, uid=f"p-{slug}"))
  open(os.path.join(b, "folks-lockup.svg"), "w").write(lockup())
  open(os.path.join(b, "favicon.svg"), "w").write(favicon())
  open(os.path.join(b, "..", "_symbols.html"), "w").write(symbols())
  print("brand written")
