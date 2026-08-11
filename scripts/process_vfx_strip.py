#!/usr/bin/env python3
"""Normalize a generated six-cell VFX sheet into a transparent game strip."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def alpha_bbox(image: Image.Image, threshold: int = 8) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A").point(lambda value: 255 if value > threshold else 0)
    return alpha.getbbox() or (0, 0, image.width, image.height)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--frames", type=int, default=6)
    parser.add_argument("--band-top", type=int, default=180)
    parser.add_argument("--band-bottom", type=int, default=820)
    parser.add_argument("--padding", type=int, default=10)
    parser.add_argument("--align", choices=("center", "bottom"), default="center")
    args = parser.parse_args()

    source = Image.open(args.input).convert("RGBA")
    frame_width = source.width // args.frames
    band_top = max(0, args.band_top)
    band_bottom = min(source.height, args.band_bottom)
    crops: list[Image.Image] = []
    boxes: list[tuple[int, int, int, int]] = []

    for index in range(args.frames):
        frame = source.crop((index * frame_width, band_top, (index + 1) * frame_width, band_bottom))
        box = alpha_bbox(frame)
        crops.append(frame.crop(box))
        boxes.append(box)

    max_width = max(image.width for image in crops)
    max_height = max(image.height for image in crops)
    target = 256 - args.padding * 2
    scale = min(target / max_width, target / max_height)
    strip = Image.new("RGBA", (256 * args.frames, 256), (0, 0, 0, 0))

    for index, crop in enumerate(crops):
        size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
        resized = crop.resize(size, Image.Resampling.LANCZOS)
        x = index * 256 + (256 - resized.width) // 2
        y = (256 - resized.height) // 2 if args.align == "center" else 256 - args.padding - resized.height
        strip.alpha_composite(resized, (x, y))

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    strip.save(output, optimize=True)
    print(f"Wrote {output} ({strip.width}x{strip.height}), scale={scale:.4f}, boxes={boxes}")


if __name__ == "__main__":
    main()
