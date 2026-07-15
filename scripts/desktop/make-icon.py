#!/usr/bin/env python3
"""Generate the macOS app icon (icon.png + icon.icns) for OpenShorts.desktop.

Composes a Big Sur-style rounded-square ("squircle") tile with a dark
vertical-gradient background and the OpenShorts logo centered on top, then
builds the full .icns via the native macOS `sips` + `iconutil` pipeline.

Usage:
    /Users/thiernodiallo/Coding/openshorts/.venv/bin/python scripts/desktop/make-icon.py

Outputs:
    electron/build/icon.png   (1024x1024, source PNG)
    electron/build/icon.icns  (macOS icon bundle)
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[2]
LOGO_PATH = REPO_ROOT / "dashboard" / "public" / "logo-openshorts.png"
BUILD_DIR = REPO_ROOT / "electron" / "build"
ICON_PNG = BUILD_DIR / "icon.png"
ICON_ICNS = BUILD_DIR / "icon.icns"

CANVAS_SIZE = 1024
TILE_SIZE = 824
CORNER_RADIUS = 185
LOGO_FRACTION = 0.70  # logo occupies ~70% of the tile

# Supersample factor for antialiasing the rounded-rect mask.
SUPERSAMPLE = 4

# Dark gradient matching the app's dark UI.
GRADIENT_TOP = (0x23, 0x23, 0x32, 255)
GRADIENT_BOTTOM = (0x17, 0x17, 0x1C, 255)


def make_rounded_tile(size: int, radius: int) -> Image.Image:
    """Create a size x size RGBA tile: vertical gradient, rounded corners."""
    hi = size * SUPERSAMPLE
    hi_radius = radius * SUPERSAMPLE

    # Vertical gradient at high resolution.
    gradient = Image.new("RGBA", (1, hi), color=0)
    for y in range(hi):
        t = y / max(hi - 1, 1)
        r = round(GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * t)
        g = round(GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * t)
        b = round(GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * t)
        gradient.putpixel((0, y), (r, g, b, 255))
    gradient = gradient.resize((hi, hi), resample=Image.Resampling.NEAREST)

    # Rounded-rect alpha mask at high resolution, antialiased by downscaling.
    mask_hi = Image.new("L", (hi, hi), 0)
    mask_draw = ImageDraw.Draw(mask_hi)
    mask_draw.rounded_rectangle([0, 0, hi - 1, hi - 1], radius=hi_radius, fill=255)

    tile_hi = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    tile_hi.paste(gradient, (0, 0), mask_hi)

    tile = tile_hi.resize((size, size), resample=Image.Resampling.LANCZOS)
    return tile


def compose_icon() -> Image.Image:
    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))

    tile = make_rounded_tile(TILE_SIZE, CORNER_RADIUS)
    tile_offset = ((CANVAS_SIZE - TILE_SIZE) // 2, (CANVAS_SIZE - TILE_SIZE) // 2)
    canvas.paste(tile, tile_offset, tile)

    logo = Image.open(LOGO_PATH).convert("RGBA")
    max_logo_dim = int(TILE_SIZE * LOGO_FRACTION)
    scale = min(max_logo_dim / logo.width, max_logo_dim / logo.height)
    new_size = (round(logo.width * scale), round(logo.height * scale))
    logo_resized = logo.resize(new_size, resample=Image.Resampling.LANCZOS)

    logo_offset = (
        (CANVAS_SIZE - new_size[0]) // 2,
        (CANVAS_SIZE - new_size[1]) // 2,
    )
    canvas.paste(logo_resized, logo_offset, logo_resized)

    return canvas


def build_icns(png_path: Path, icns_path: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()

        # (filename, pixel size)
        sizes = [
            ("icon_16x16.png", 16),
            ("icon_16x16@2x.png", 32),
            ("icon_32x32.png", 32),
            ("icon_32x32@2x.png", 64),
            ("icon_128x128.png", 128),
            ("icon_128x128@2x.png", 256),
            ("icon_256x256.png", 256),
            ("icon_256x256@2x.png", 512),
            ("icon_512x512.png", 512),
            ("icon_512x512@2x.png", 1024),
        ]

        for filename, px in sizes:
            out_path = iconset / filename
            subprocess.run(
                [
                    "sips",
                    "-z", str(px), str(px),
                    str(png_path),
                    "--out", str(out_path),
                ],
                check=True,
                capture_output=True,
            )

        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(icns_path)],
            check=True,
            capture_output=True,
        )


def main() -> None:
    if not LOGO_PATH.exists():
        print(f"Logo not found: {LOGO_PATH}", file=sys.stderr)
        sys.exit(1)

    for tool in ("sips", "iconutil"):
        if shutil.which(tool) is None:
            print(f"Required tool not found: {tool}", file=sys.stderr)
            sys.exit(1)

    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    icon = compose_icon()
    assert icon.size == (CANVAS_SIZE, CANVAS_SIZE)
    icon.save(ICON_PNG)
    print(f"Wrote {ICON_PNG} ({icon.size[0]}x{icon.size[1]})")

    build_icns(ICON_PNG, ICON_ICNS)
    print(f"Wrote {ICON_ICNS}")


if __name__ == "__main__":
    main()
