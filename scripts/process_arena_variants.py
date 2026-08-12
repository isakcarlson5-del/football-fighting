#!/usr/bin/env python3
"""Build the high-resolution runtime plate for the approved AI arena."""

from pathlib import Path

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "art-source" / "arena" / "world-cup"
OUTPUT_DIR = ROOT / "public" / "art" / "arena" / "world-cup"
TARGET_SIZE = (3072, 2048)
VARIANTS = ("world-cup-modern-ai",)


def build_variant(variant: str) -> None:
    source = SOURCE_DIR / f"{variant}.png"
    output = OUTPUT_DIR / f"{variant}.webp"
    image = Image.open(source).convert("RGB")
    image = image.resize(TARGET_SIZE, Image.Resampling.LANCZOS)
    # A restrained post-scale sharpen restores grass-blade and curb definition
    # after the 2x reconstruction without producing bright halos around seats.
    image = image.filter(ImageFilter.UnsharpMask(radius=1.15, percent=72, threshold=3))
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, "WEBP", quality=96, method=6)
    print(f"{variant}: {image.width}x{image.height} -> {output.relative_to(ROOT)}")


def main() -> None:
    for variant in VARIANTS:
        build_variant(variant)


if __name__ == "__main__":
    main()
