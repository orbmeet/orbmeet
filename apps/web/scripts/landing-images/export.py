"""Writes each rendered PNG as WebP at the widths the landing page's srcset names."""
import sys
from pathlib import Path

from PIL import Image

# Published name → (rendered file, widths).
IMAGES = {
    "hero": ("water", (1000, 1600, 2400)),
    "board": ("board", (900, 1500)),
    "recap": ("recap", (900, 1500)),
    "orb": ("orb", (900, 1500)),
}

source, target = Path(sys.argv[1]), Path(sys.argv[2])
for name, (rendered, widths) in IMAGES.items():
    image = Image.open(source / f"{rendered}.png").convert("RGB")
    for width in widths:
        height = round(image.height * width / image.width)
        image.resize((width, height), Image.LANCZOS).save(target / f"{name}-{width}.webp", quality=82, method=6)
        print(f"{name}-{width}.webp")
