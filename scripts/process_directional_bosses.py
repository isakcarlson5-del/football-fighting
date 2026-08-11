#!/usr/bin/env python3
"""Normalize generated boss direction grids and the Matchday Wipeout VFX.

The source grids remain untouched. This script writes solid-green intermediate
strips; the imagegen chroma-key helper then produces the transparent runtime
assets. Every boss pose is a concrete generated frame, never interpolation.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "art-source" / "enemies" / "directional-v2"
VFX_SOURCE = ROOT / "art-source" / "vfx" / "matchday-wipeout-grid-src.png"
KEY_ROOT = ROOT / "work" / "directional-v2-key"

DIRECTIONS = ("n", "ne", "e", "se", "s", "sw", "w", "nw")
BOSSES = ("boss-drumboss", "boss-official", "boss-captain")
# Directional run poses can extend both legs and boss equipment horizontally.
# A 480px cell preserves the widest measured 448px pose at the same 300px
# visible height as the existing runtime boss art.
FRAME_W = 480
FRAME_H = 320
FRAME_COUNT = 12
TARGET_VISIBLE_HEIGHT = 300
FEET_Y = 312
KEY_RGB = np.array([0, 255, 0], dtype=np.uint8)


@dataclass(frozen=True)
class Crop:
    image: Image.Image
    visible_width: int
    visible_height: int
    visible_left: int
    visible_top: int


def foreground_mask(rgb: np.ndarray) -> np.ndarray:
    """Return a conservative non-green mask that keeps dark fine details."""
    distance = np.linalg.norm(rgb.astype(np.float32) - KEY_RGB.astype(np.float32), axis=2)
    green_dominance = rgb[:, :, 1].astype(np.int16) - np.maximum(
        rgb[:, :, 0].astype(np.int16), rgb[:, :, 2].astype(np.int16)
    )
    return (distance > 44) & (green_dominance < 76)


def crop_grid_cell(image: Image.Image, col: int, row: int) -> Crop:
    width, height = image.size
    x0 = round(col * width / 4)
    x1 = round((col + 1) * width / 4)
    y0 = round(row * height / 3)
    y1 = round((row + 1) * height / 3)
    cell = image.crop((x0, y0, x1, y1)).convert("RGB")
    mask = foreground_mask(np.asarray(cell))
    ys, xs = np.where(mask)
    if len(xs) < 900:
        raise ValueError(f"Grid cell ({col}, {row}) has too little foreground: {len(xs)} pixels")

    left = int(xs.min())
    right = int(xs.max()) + 1
    top = int(ys.min())
    bottom = int(ys.max()) + 1
    pad = 8
    crop_left = max(0, left - pad)
    crop_top = max(0, top - pad)
    crop_right = min(cell.width, right + pad)
    crop_bottom = min(cell.height, bottom + pad)
    return Crop(
        image=cell.crop((crop_left, crop_top, crop_right, crop_bottom)),
        visible_width=right - left,
        visible_height=bottom - top,
        visible_left=left - crop_left,
        visible_top=top - crop_top,
    )


def stabilize(crop: Crop) -> Image.Image:
    scale = TARGET_VISIBLE_HEIGHT / max(1, crop.visible_height)
    resized_w = max(1, round(crop.image.width * scale))
    resized_h = max(1, round(crop.image.height * scale))
    resized = crop.image.resize((resized_w, resized_h), Image.Resampling.LANCZOS)

    visible_center_x = (crop.visible_left + crop.visible_width / 2) * scale
    visible_bottom_y = (crop.visible_top + crop.visible_height) * scale
    x = round(FRAME_W / 2 - visible_center_x)
    y = round(FEET_Y - visible_bottom_y)

    frame = Image.new("RGB", (FRAME_W, FRAME_H), tuple(int(v) for v in KEY_RGB))
    frame.paste(resized, (x, y))
    return frame


def process_boss_grid(source: Path, output: Path) -> None:
    image = Image.open(source).convert("RGB")
    frames: list[Image.Image] = []
    visible_heights: list[int] = []
    for row in range(3):
        for col in range(4):
            crop = crop_grid_cell(image, col, row)
            visible_heights.append(crop.visible_height)
            frames.append(stabilize(crop))
    if len(frames) != FRAME_COUNT:
        raise AssertionError(f"Expected {FRAME_COUNT} frames, got {len(frames)}")

    strip = Image.new("RGB", (FRAME_W * FRAME_COUNT, FRAME_H), tuple(int(v) for v in KEY_RGB))
    for index, frame in enumerate(frames):
        strip.paste(frame, (index * FRAME_W, 0))
    output.parent.mkdir(parents=True, exist_ok=True)
    strip.save(output, optimize=True)
    print(
        f"{source.relative_to(ROOT)} -> {output.relative_to(ROOT)} "
        f"frames=12 source_h={min(visible_heights)}-{max(visible_heights)} "
        f"runtime={strip.width}x{strip.height}"
    )


def process_wipeout_grid() -> None:
    image = Image.open(VFX_SOURCE).convert("RGB")
    width, height = image.size
    output = KEY_ROOT / "vfx" / "matchday-wipeout-strip.png"
    output.parent.mkdir(parents=True, exist_ok=True)
    strip = Image.new("RGB", (512 * 6, 512), tuple(int(v) for v in KEY_RGB))
    for index in range(6):
        col = index % 3
        row = index // 3
        x0 = round(col * width / 3)
        x1 = round((col + 1) * width / 3)
        y0 = round(row * height / 2)
        y1 = round((row + 1) * height / 2)
        cell = image.crop((x0, y0, x1, y1)).resize((512, 512), Image.Resampling.LANCZOS)
        strip.paste(cell, (index * 512, 0))
    strip.save(output, optimize=True)
    print(f"{VFX_SOURCE.relative_to(ROOT)} -> {output.relative_to(ROOT)} runtime={strip.width}x{strip.height}")


def main() -> None:
    for boss in BOSSES:
        for direction in DIRECTIONS:
            process_boss_grid(
                SOURCE_ROOT / boss / f"{direction}-grid-src.png",
                KEY_ROOT / "enemies" / boss / f"{direction}.png",
            )
    process_wipeout_grid()


if __name__ == "__main__":
    main()
