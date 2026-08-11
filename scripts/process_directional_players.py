#!/usr/bin/env python3
"""Normalize transparent 12-frame player strips for the runtime.

The committed source strips contain twelve concrete AI-authored poses on a
transparent 362x724 cell grid. This processor crops each pose independently,
stabilizes its visible height and feet baseline, then writes compact alpha-WebP
atlases. Existing semantic idle, kick, hurt and six-frame run strips remain
untouched as runtime fallbacks.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "art-source" / "players" / "directional-v2"
RUNTIME_ROOT = ROOT / "public" / "art" / "players" / "directional-v2"

PLAYERS = ("messi", "ronaldo", "neymar", "yamal")
DIRECTIONS = ("n", "ne", "e", "se", "s", "sw", "w", "nw")
SOURCE_FRAME_W = 362
SOURCE_FRAME_H = 724
FRAME_W = 256
FRAME_H = 320
FRAME_COUNT = 12
TARGET_VISIBLE_HEIGHT = 292
FEET_Y = 312
ALPHA_THRESHOLD = 8


def visible_bounds(frame: np.ndarray) -> tuple[int, int, int, int]:
    alpha = frame[:, :, 3]
    ys, xs = np.where(alpha > ALPHA_THRESHOLD)
    if len(xs) < 500:
        raise ValueError(f"Frame has too little visible subject: {len(xs)} pixels")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def normalize_frame(frame: np.ndarray) -> Image.Image:
    left, top, right, bottom = visible_bounds(frame)
    pad = 4
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(frame.shape[1], right + pad)
    bottom = min(frame.shape[0], bottom + pad)

    crop = Image.fromarray(frame[top:bottom, left:right])
    visible_height = bottom - top - pad * 2
    scale = TARGET_VISIBLE_HEIGHT / max(1, visible_height)
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    if width > FRAME_W - 8:
        scale *= (FRAME_W - 8) / width
        width = max(1, round(crop.width * scale))
        height = max(1, round(crop.height * scale))
    crop = crop.resize((width, height), Image.Resampling.LANCZOS)

    output = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    x = round((FRAME_W - width) / 2)
    y = round(FEET_Y - height + pad * scale)
    output.alpha_composite(crop, (x, y))
    rgba = np.asarray(output).copy()
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba)


def process_strip(player: str, direction: str) -> None:
    source = SOURCE_ROOT / player / f"{direction}.png"
    image = np.asarray(Image.open(source).convert("RGBA"))
    expected = (SOURCE_FRAME_H, SOURCE_FRAME_W * FRAME_COUNT, 4)
    if image.shape != expected:
        raise ValueError(f"{source}: expected {expected}, got {image.shape}")

    frames = [
        normalize_frame(image[:, index * SOURCE_FRAME_W : (index + 1) * SOURCE_FRAME_W])
        for index in range(FRAME_COUNT)
    ]
    frame_hashes = {frame.tobytes() for frame in frames}
    if len(frame_hashes) != FRAME_COUNT:
        raise ValueError(f"{source}: expected 12 unique concrete frames, got {len(frame_hashes)}")

    strip = Image.new("RGBA", (FRAME_W * FRAME_COUNT, FRAME_H), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        strip.alpha_composite(frame, (index * FRAME_W, 0))

    output = RUNTIME_ROOT / player / f"{direction}.webp"
    output.parent.mkdir(parents=True, exist_ok=True)
    strip.save(output, "WEBP", quality=92, method=6)
    print(
        f"{source.relative_to(ROOT)} -> {output.relative_to(ROOT)} "
        f"frames={FRAME_COUNT} runtime={strip.width}x{strip.height} bytes={output.stat().st_size}"
    )


def main() -> None:
    for player in PLAYERS:
        for direction in DIRECTIONS:
            process_strip(player, direction)


if __name__ == "__main__":
    main()
