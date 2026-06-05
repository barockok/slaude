#!/usr/bin/env python3
# Generate the truecolor half-block logo from the source PNG (crisp at small sizes — generate
# from hi-res, don't downscale the low-res art). Requires Pillow (`pip install Pillow`).
#   python3 gen-logo.py <width> [vsquash] > amartha-logo-small.ansi
# Half-block encoding: each char = 2 vertical pixels (top=fg "▀", bottom=bg). Transparent → space.
import sys, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
img = Image.open(os.path.join(HERE, "amartha-logo.png")).convert("RGBA")
W = int(sys.argv[1]) if len(sys.argv) > 1 else 20
VSQUASH = float(sys.argv[2]) if len(sys.argv) > 2 else 0.80
ar = img.height / img.width
H = int(W * ar * VSQUASH)
H += H % 2
img = img.resize((W, H), Image.LANCZOS)
px = img.load()

def cell(r, g, b, a):
    return (r, g, b) if a > 40 else None

out = []
for y in range(0, H, 2):
    line = ""
    for x in range(W):
        t = cell(*px[x, y]); b = cell(*px[x, y + 1])
        if t is None and b is None: line += " "
        elif t and b: line += f"\x1b[38;2;{t[0]};{t[1]};{t[2]}m\x1b[48;2;{b[0]};{b[1]};{b[2]}m▀\x1b[0m"
        elif t: line += f"\x1b[38;2;{t[0]};{t[1]};{t[2]}m▀\x1b[0m"
        else: line += f"\x1b[38;2;{b[0]};{b[1]};{b[2]}m▄\x1b[0m"
    out.append(line)
print("\n".join(out))
