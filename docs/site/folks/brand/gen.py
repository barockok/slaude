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

# Size ladder. Tested pixel-by-pixel (docs/site/folks/README.md, "Small sizes"):
#   full  (3 heads) reads down to 24 px      → mark, lockup, hero, nav
#   small (2 heads) reads at 20–23 px        → compact avatars, list icons
#   tiny  (1 head)  reads at 16 px           → favicon, tab, 16 px UI
# Every tier is fitted so the union of its heads fills the 64-frame with a
# 1.5-unit margin; wasted margin was the first thing that killed the 24 px read.
GAP = 2.4
EYE_SCALE = 1.45
TIERS = {
  "full":  [("back", 41, 26, 18.5, "tri"), ("left", 20, 34, 14, "dash"), ("front", 31, 46.5, 11.5, "dot")],
  "small": [("back", 38, 27, 21, "tri"), ("front", 25, 43, 15, "dot")],
  "tiny":  [("front", 32, 32, 28, "dot")],
}
EYE_DX_BY_TIER = {"full": {"back": 5.0, "left": -0.5, "front": 0}, "small": {"back": 6.0, "front": 0}, "tiny": {"front": 0}}

def fit(heads, margin=1.5):
  """Scale and centre a head list so its bounding box fills the frame."""
  xs = [cx - r for _, cx, _, r, _ in heads] + [cx + r for _, cx, _, r, _ in heads]
  ys = [cy - r for _, _, cy, r, _ in heads] + [cy + r for _, _, cy, r, _ in heads]
  w, h = max(xs) - min(xs), max(ys) - min(ys)
  k = (64 - 2 * margin) / max(w, h)
  ox, oy = min(xs) + w / 2, min(ys) + h / 2
  return [(n, round(32 + (cx - ox) * k, 2), round(32 + (cy - oy) * k, 2), round(r * k, 2), kind) for n, cx, cy, r, kind in heads]

HEADS = fit(TIERS["full"])
EYE_DX = dict(EYE_DX_BY_TIER["full"])

def use_tier(name):
  global HEADS, EYE_DX
  HEADS = fit(TIERS[name])
  EYE_DX = dict(EYE_DX_BY_TIER[name])

def kind_head_lookup(cx, cy):
  for name, hx, hy, _, _ in HEADS:
    if hx == cx and hy == cy: return name
  return None

def eye_shapes(kind, cx, cy, r, fill):
  """Eye geometry for a head of radius r centred on (cx, cy). Returns (svg, centres)."""
  s0 = r / 19.0  # scale relative to a 19-unit head
  ey = cy - 3 * s0
  s = s0 * EYE_SCALE
  cx = cx + EYE_DX.get(kind_head_lookup(cx, cy), 0) * s0
  if kind == "tri":
    w, h, gap = 5.6 * s, 5.4 * s, 1.6 * s
    l = f'<path d="M{cx-gap-w:.2f} {ey-h/2:.2f}L{cx-gap:.2f} {ey:.2f}L{cx-gap-w:.2f} {ey+h/2:.2f}Z" fill="{fill}"/>'
    rr = f'<path d="M{cx+gap+w:.2f} {ey-h/2:.2f}L{cx+gap:.2f} {ey:.2f}L{cx+gap+w:.2f} {ey+h/2:.2f}Z" fill="{fill}"/>'
    return l + rr
  if kind == "dash":
    w, h, gap = 5.8 * s, 2.6 * s, 1.4 * s
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
  cx, cy, r = 32, 32, 28.5
  if cut is None:
    return (f'<defs><mask id="{uid}"><rect width="64" height="64" fill="#fff"/>{eye_shapes(kind, cx, cy, r, "#000")}</mask></defs>'
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" mask="url(#{uid})"/>')
  return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="currentColor"/><g class="eyes">{eye_shapes(kind, cx, cy, r, cut)}</g>'

def svg(inner, vb="0 0 64 64", w=64, h=64, label="Folks"):
  return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img" aria-label="{label}">\n  {inner}\n</svg>\n'

PERSONAS = [("ops", "bar", "#7A2E86"), ("docs", "dot", "#F5B31B"), ("data", "dash", "#1B7BE0"), ("sec", "tri", "#F0553B")]

def symbols():
  use_tier("full")
  out = [f'<symbol id="folks-mark" viewBox="0 0 64 64">{mark_inline()}</symbol>']
  use_tier("small")
  out.append(f'<symbol id="folks-mark-small" viewBox="0 0 64 64">{mark_inline(track=False)}</symbol>')
  use_tier("full")
  for slug, kind, _ in PERSONAS:
    out.append(f'<symbol id="folk-{slug}" viewBox="0 0 64 64">{head_single(kind, cut="var(--cut, #F7F5F2)")}</symbol>')
  return "\n".join(out)

def favicon():
  """Tabs render at 16–32 px: the one-head tier, no tile (a tile steals pixels)."""
  use_tier("tiny")
  out = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{mark_masked(uid="fav")}</svg>\n'
  use_tier("full")
  return out

def lockup():
  # mark + wordmark placeholder rendered in the page's display face; SVG file uses a system fallback stack
  return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 64" width="200" height="64" role="img" aria-label="Folks">'
          f'<g>{mark_masked(uid="lk")}</g>'
          f'<text x="72" y="45" font-family="Bricolage Grotesque, Avenir Next, Segoe UI, system-ui, sans-serif" font-weight="700" font-size="38" letter-spacing="-1.2" fill="#7A2E86">Folks</text></svg>\n')

if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[2] == "brand":
  b = sys.argv[1]
  use_tier("full")
  open(os.path.join(b, "folks-mark.svg"), "w").write(svg(mark_masked(), label="Folks mark"))
  open(os.path.join(b, "folks-mark-ink.svg"), "w").write(svg(mark_masked("#17141F", "fmi"), label="Folks mark, ink"))
  open(os.path.join(b, "folks-mark-paper.svg"), "w").write(svg(mark_masked("#F7F5F2", "fmp"), label="Folks mark, paper (for dark grounds)"))
  use_tier("small")
  open(os.path.join(b, "folks-mark-small.svg"), "w").write(svg(mark_masked(uid="fms"), label="Folks mark, small (20–23 px)"))
  use_tier("tiny")
  open(os.path.join(b, "folks-mark-tiny.svg"), "w").write(svg(mark_masked(uid="fmt"), label="Folks mark, tiny (16 px)"))
  use_tier("full")
  for slug, kind, col in PERSONAS:
    open(os.path.join(b, f"persona-{slug}.svg"), "w").write(svg(head_single(kind, col, f"p-{slug}"), label=f"Folks persona: {slug}"))
  open(os.path.join(b, "folks-lockup.svg"), "w").write(lockup())
  open(os.path.join(b, "favicon.svg"), "w").write(favicon())
  open(os.path.join(b, "..", "_symbols.html"), "w").write(symbols())
  print("brand written")
