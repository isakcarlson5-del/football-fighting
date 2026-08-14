#!/usr/bin/env python3
"""Build a normalized 12-frame Keeper's Halo strip from the AI source grid."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "work" / "keeper-halo-v2" / "source.png"
OUTPUT = ROOT / "public" / "art" / "abilities" / "keeper-halo-strip-v2.png"
PREVIEW = ROOT / "work" / "keeper-halo-v2" / "preview.png"

GRID_COLUMNS = 6
GRID_ROWS = 2
FRAME_COUNT = GRID_COLUMNS * GRID_ROWS
FRAME_SIZE = 256
TARGET_SIZE = 224


def largest_subject(mask: np.ndarray) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
    if count <= 1:
        raise ValueError("Keeper's Halo segmentation produced no visible subject")
    primary = max(range(1, count), key=lambda index: int(stats[index, cv2.CC_STAT_AREA]))
    result = np.zeros_like(mask, dtype=np.uint8)
    result[labels == primary] = 255
    return result


def segment(cell: np.ndarray) -> Image.Image:
    maximum = cell.max(axis=2)
    minimum = cell.min(axis=2)
    # Image generation uses a neutral preview checkerboard. Removing only
    # edge-connected neutral-bright pixels preserves the glove's white leather.
    neutral_bright = ((minimum > 212) & ((maximum - minimum) < 28)).astype(np.uint8)
    flood = neutral_bright.copy()
    flood_mask = np.zeros((cell.shape[0] + 2, cell.shape[1] + 2), np.uint8)
    for x in range(cell.shape[1]):
        if flood[0, x] == 1:
            cv2.floodFill(flood, flood_mask, (x, 0), 2)
        if flood[-1, x] == 1:
            cv2.floodFill(flood, flood_mask, (x, cell.shape[0] - 1), 2)
    for y in range(cell.shape[0]):
        if flood[y, 0] == 1:
            cv2.floodFill(flood, flood_mask, (0, y), 2)
        if flood[y, -1] == 1:
            cv2.floodFill(flood, flood_mask, (cell.shape[1] - 1, y), 2)
    subject = largest_subject(np.where(flood == 2, 0, 255).astype(np.uint8))
    alpha = cv2.GaussianBlur(subject, (0, 0), 0.7)
    alpha[alpha < 8] = 0
    rgba = np.dstack((cell, alpha)).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba)


def normalize(frame: Image.Image) -> Image.Image:
    alpha = np.asarray(frame.getchannel("A"))
    ys, xs = np.where(alpha > 20)
    if len(xs) < 4_000:
        raise ValueError(f"Keeper's Halo frame has too little visible art: {len(xs)} pixels")
    left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    crop = frame.crop((max(0, left - 3), max(0, top - 3), min(frame.width, right + 3), min(frame.height, bottom + 3)))
    scale = min(TARGET_SIZE / crop.width, TARGET_SIZE / crop.height)
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    crop = crop.resize((width, height), Image.Resampling.LANCZOS)
    output = Image.new("RGBA", (FRAME_SIZE, FRAME_SIZE), (0, 0, 0, 0))
    output.alpha_composite(crop, ((FRAME_SIZE - width) // 2, (FRAME_SIZE - height) // 2))
    return output


def frame_difference(left: Image.Image, right: Image.Image) -> float:
    a = np.asarray(left, dtype=np.int16)
    b = np.asarray(right, dtype=np.int16)
    return float(np.abs(a - b).mean())


def main() -> None:
    grid = Image.open(SOURCE).convert("RGB")
    frames: list[Image.Image] = []
    for index in range(FRAME_COUNT):
        column = index % GRID_COLUMNS
        row = index // GRID_COLUMNS
        left = round(column * grid.width / GRID_COLUMNS)
        right = round((column + 1) * grid.width / GRID_COLUMNS)
        top = round(row * grid.height / GRID_ROWS)
        bottom = round((row + 1) * grid.height / GRID_ROWS)
        frames.append(normalize(segment(np.asarray(grid.crop((left, top, right, bottom))))))

    differences = [frame_difference(frames[index], frames[(index + 1) % FRAME_COUNT]) for index in range(FRAME_COUNT)]
    if min(differences) < 1:
        raise ValueError(f"Keeper's Halo contains a duplicate frame: min difference {min(differences):.3f}")

    strip = Image.new("RGBA", (FRAME_SIZE * FRAME_COUNT, FRAME_SIZE), (0, 0, 0, 0))
    preview = Image.new("RGBA", (FRAME_SIZE * GRID_COLUMNS, FRAME_SIZE * GRID_ROWS), (44, 91, 50, 255))
    for index, frame in enumerate(frames):
        strip.alpha_composite(frame, (FRAME_SIZE * index, 0))
        preview.alpha_composite(frame, ((index % GRID_COLUMNS) * FRAME_SIZE, (index // GRID_COLUMNS) * FRAME_SIZE))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    strip.save(OUTPUT, optimize=True)
    preview.save(PREVIEW, optimize=True)
    print(f"frames={FRAME_COUNT} size={strip.size} bytes={OUTPUT.stat().st_size} min-diff={min(differences):.2f}")


if __name__ == "__main__":
    main()
