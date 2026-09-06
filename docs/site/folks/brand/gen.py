#!/usr/bin/env python3
"""Generate the Folks mark: three overlapping heads, one fill, flat.

Geometry lives here once. Everything else (brand SVGs, the inline <symbol>
block, the favicon, the lockup) is emitted from it, so the page, the favicon
and the print file can never drift apart.

  python3 gen.py <brand-dir> brand   → rewrites every SVG in brand/ and emits
                                        ../_symbols.html for the pages' <defs>

Heads (64-frame), back to front:
  back   c(40,27) r19  eyes: two solid triangles pointing at each other (fierce)
  left   c(21,33) r14  eyes: two dashes (steady)
  front  c(31,45) r11  eyes: two dots (curious)
Each nearer head is separated from the one behind it by a gap of GAP units.
Standalone files cut gaps and eyes with a mask (transparent, any background);
inline symbols paint them in a CSS colour so the eyes can be animated.
"""
import sys, os

GAP = 1.6
HEADS = [  # name, cx, cy, r, eye kind
  ("back",  40, 27, 19, "tri"),
  ("left",  21, 33, 14, "dash"),
  ("front", 31, 45, 11, "dot"),
]
EYE_DX = {"back": 5.5, "left": -0.5, "front": 0}  # where each head looks, in frame units

def kind_head_lookup(cx, cy):
  for name, hx, hy, _, _ in HEADS:
    if hx == cx and hy == cy: return name
  return None

def eye_shapes(kind, cx, cy, r, fill):
  """Eye geometry for a head of radius r centred on (cx, cy). Returns (svg, centres)."""
  s = r / 19.0  # scale relative to the back head
  ey = cy - 3 * s
  cx = cx + EYE_DX.get(kind_head_lookup(cx, cy), 0)
  if kind == "tri":
    w, h, gap = 5.6 * s, 5.6 * s, 1.6 * s
    l = f'<path d="M{cx-gap-w:.2f} {ey-h/2:.2f}L{cx-gap:.2f} {ey:.2f}L{cx-gap-w:.2f} {ey+h/2:.2f}Z" fill="{fill}"/>'
    rr = f'<path d="M{cx+gap+w:.2f} {ey-h/2:.2f}L{cx+gap:.2f} {ey:.2f}L{cx+gap+w:.2f} {ey+h/2:.2f}Z" fill="{fill}"/>'
    return l + rr
  if kind == "dash":
    w, h, gap = 5.8 * s, 2.4 * s, 1.4 * s
    return (f'<rect x="{cx-gap-w:.2f}" y="{ey-h/2:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{h/2:.2f}" fill="{fill}"/>'
            f'<rect x="{cx+gap:.2f}" y="{ey-h/2:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{h/2:.2f}" fill="{fill}"/>')
  if kind == "dot":
    rad, gap = 2.3 * s * 1.5, 3.9 * s * 1.5
    return f'<circle cx="{cx-gap:.2f}" cy="{ey:.2f}" r="{rad:.2f}" fill="{fill}"/><circle cx="{cx+gap:.2f}" cy="{ey:.2f}" r="{rad:.2f}" fill="{fill}"/>'
  if kind == "bar":
    w, h, gap = 3.6 * s, 9.5 * s, 1.9 * s
    return (f'<rect x="{cx-gap-w:.2f}" y="{ey-h/2:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{w/2:.2f}" fill="{fill}"/>'
            f'<rect x="{cx+gap:.2f}" y="{ey-h/2:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{w/2:.2f}" fill="{fill}"/>')
  raise ValueError(kind)

def mark_masked(fill="#7A2E86", uid="fm"):
  """Standalone: gaps and eyes are transparent via masks."""
  defs, body = [], []
  for i, (name, cx, cy, r, kind) in enumerate(HEADS):
    cuts = "".join(f'<circle cx="{fcx}" cy="{fcy}" r="{fr + GAP}" fill="#000"/>' for (_, fcx, fcy, fr, _) in HEADS[i+1:])
    cuts += eye_shapes(kind, cx, cy, r, "#000")
    defs.append(f'<mask id="{uid}-{name}"><rect width="64" height="64" fill="#fff"/>{cuts}</mask>')
    body.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" mask="url(#{uid}-{name})"/>')
  return "<defs>" + "".join(defs) + "</defs>" + "".join(body)

def mark_inline(cut="var(--cut, #F7F5F2)", uid="fi", track=True):
  """Inline: gaps and eyes painted in a CSS colour; each eye pair in a movable group."""
  layers = []
  for i, (name, cx, cy, r, kind) in enumerate(HEADS):
    if i > 0:
      layers.append(f'<circle cx="{cx}" cy="{cy}" r="{r + GAP}" fill="{cut}"/>')
    layers.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="currentColor"/>')
    s = r / 19.0
    ey = cy - 3 * s
    rng = f' data-range="{2.4*s:.2f}" data-cx="{cx + EYE_DX[name]:.2f}" data-cy="{ey:.2f}"' if track else ""
    layers.append(f'<g class="eyes eyes-{name}"{rng}>{eye_shapes(kind, cx, cy, r, cut)}</g>')
  return "".join(layers)

def head_single(kind, fill="#7A2E86", uid="fh", cut=None):
  """One head, centred, for persona chips and avatars. cut=None → masked (transparent eyes)."""
  cx, cy, r = 32, 32, 26
  if cut is None:
    return (f'<defs><mask id="{uid}"><rect width="64" height="64" fill="#fff"/>{eye_shapes(kind, cx, cy, r, "#000")}</mask></defs>'
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" mask="url(#{uid})"/>')
  return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="currentColor"/><g class="eyes">{eye_shapes(kind, cx, cy, r, cut)}</g>'

def svg(inner, vb="0 0 64 64", w=64, h=64, label="Folks"):
  return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img" aria-label="{label}">\n  {inner}\n</svg>\n'

PERSONAS = [("ops", "bar", "#7A2E86"), ("docs", "dot", "#F5B31B"), ("data", "dash", "#1B7BE0"), ("sec", "tri", "#F0553B")]

def symbols():
  out = [f'<symbol id="folks-mark" viewBox="0 0 64 64">{mark_inline()}</symbol>']
  for slug, kind, _ in PERSONAS:
    out.append(f'<symbol id="folk-{slug}" viewBox="0 0 64 64">{head_single(kind, cut="var(--cut, #F7F5F2)")}</symbol>')
  return "\n".join(out)

def favicon():
  return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#F7F5F2"/>'
          f'<g transform="translate(3 3) scale(0.9)">{mark_masked(uid="fav")}</g></svg>\n')

def lockup():
  # mark + wordmark placeholder rendered in the page's display face; SVG file uses a system fallback stack
  return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 64" width="200" height="64" role="img" aria-label="Folks">'
          f'<g>{mark_masked(uid="lk")}</g>'
          f'<text x="72" y="45" font-family="Bricolage Grotesque, Avenir Next, Segoe UI, system-ui, sans-serif" font-weight="700" font-size="38" letter-spacing="-1.2" fill="#7A2E86">Folks</text></svg>\n')

if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[2] == "brand":
  b = sys.argv[1]
  open(os.path.join(b, "folks-mark.svg"), "w").write(svg(mark_masked(), label="Folks mark"))
  open(os.path.join(b, "folks-mark-ink.svg"), "w").write(svg(mark_masked("#17141F", "fmi"), label="Folks mark, ink"))
  open(os.path.join(b, "folks-mark-paper.svg"), "w").write(svg(mark_masked("#F7F5F2", "fmp"), label="Folks mark, paper (for dark grounds)"))
  for slug, kind, col in PERSONAS:
    open(os.path.join(b, f"persona-{slug}.svg"), "w").write(svg(head_single(kind, col, f"p-{slug}"), label=f"Folks persona: {slug}"))
  open(os.path.join(b, "folks-lockup.svg"), "w").write(lockup())
  open(os.path.join(b, "favicon.svg"), "w").write(favicon())
  open(os.path.join(b, "..", "_symbols.html"), "w").write(symbols())
  print("brand written")
