#!/usr/bin/env python3
"""Turn a finished square logo image into the macOS app icon.

Unlike make-icon.py (which composes the logo onto a generated tile), this takes
an image that is ALREADY a complete icon design (background + centered mark) and
just gives it the rounded-square macOS shape: resize to 1024, mask the corners
with a Big Sur-style squircle so the corners are transparent, then build the
.icns via the native sips/iconutil pipeline.

Usage: make-icon-from-image.py <source.png> [corner_radius]
  corner_radius defaults to 230 (≈ Apple's 22.4% of 1024).

Run with the repo venv python so Pillow is available.
"""
import os
import subprocess
import sys
import tempfile
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BUILD = os.path.join(REPO, "electron", "build")
SIZE = 1024
SS = 4  # supersample factor for smooth mask edges


def rounded_mask(size, radius):
    """Antialiased rounded-square alpha mask, drawn at SS× then downscaled."""
    big = Image.new("L", (size * SS, size * SS), 0)
    d = ImageDraw.Draw(big)
    d.rounded_rectangle([0, 0, size * SS - 1, size * SS - 1], radius=radius * SS, fill=255)
    return big.resize((size, size), Image.LANCZOS)


def to_square(im):
    """Center-crop to a square if the source isn't already 1:1."""
    w, h = im.size
    if w == h:
        return im
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    return im.crop((left, top, left + side, top + side))


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: make-icon-from-image.py <source.png> [corner_radius]")
    src_path = sys.argv[1]
    radius = int(sys.argv[2]) if len(sys.argv) > 2 else 230
    if not os.path.isfile(src_path):
        sys.exit(f"source image not found: {src_path}")

    src = to_square(Image.open(src_path).convert("RGBA")).resize((SIZE, SIZE), Image.LANCZOS)

    # Mask the corners transparent so it takes the rounded macOS icon shape.
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(src, (0, 0), rounded_mask(SIZE, radius))

    os.makedirs(BUILD, exist_ok=True)
    png_path = os.path.join(BUILD, "icon.png")
    icon.save(png_path)
    print(f"wrote {png_path} ({SIZE}x{SIZE})")

    # Native .icns pipeline: build an .iconset with every size, then iconutil.
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for base in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = base * scale
                name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
                subprocess.run(
                    ["sips", "-z", str(px), str(px), png_path, "--out", os.path.join(iconset, name)],
                    check=True, capture_output=True,
                )
        icns_path = os.path.join(BUILD, "icon.icns")
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns_path], check=True)
        print(f"wrote {icns_path}")


if __name__ == "__main__":
    main()
