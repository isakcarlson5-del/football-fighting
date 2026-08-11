#!/usr/bin/env python3
"""Clean transparent boss strips and encode compact alpha-WebP runtime art."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSET_ROOT = ROOT / "public" / "art" / "enemies" / "directional-v2"
BOSSES = ("boss-drumboss", "boss-official", "boss-captain")
DIRECTIONS = ("n", "ne", "e", "se", "s", "sw", "w", "nw")
FRAME_W = 480
FRAME_H = 320
FRAME_COUNT = 12
ALPHA_FLOOR = 32
ACCESSORY_MIN_AREA = 300


def clean_frame(frame: np.ndarray, keep_accessories: bool) -> tuple[np.ndarray, int]:
    alpha = frame[:, :, 3]
    mask = (alpha >= ALPHA_FLOOR).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if count <= 1:
        raise ValueError("No visible sprite component found")

    component_ids = list(range(1, count))
    main = max(component_ids, key=lambda index: int(stats[index, cv2.CC_STAT_AREA]))
    keep_ids = {
        index
        for index in component_ids
        if index == main
        or (keep_accessories and int(stats[index, cv2.CC_STAT_AREA]) >= ACCESSORY_MIN_AREA)
    }
    keep = np.isin(labels, list(keep_ids))
    removed = int(np.count_nonzero((alpha > 0) & ~keep))
    cleaned = frame.copy()
    cleaned[:, :, 3] = np.where(keep, alpha, 0).astype(np.uint8)
    cleaned[cleaned[:, :, 3] == 0, :3] = 0
    return cleaned, removed


def finalize_boss(path: Path) -> None:
    image = np.asarray(Image.open(path).convert("RGBA"))
    expected = (FRAME_H, FRAME_W * FRAME_COUNT, 4)
    if image.shape != expected:
        raise ValueError(f"{path}: expected {expected}, got {image.shape}")

    frames: list[np.ndarray] = []
    removed = 0
    keep_accessories = path.parent.name == "boss-drumboss"
    for index in range(FRAME_COUNT):
        frame, frame_removed = clean_frame(
            image[:, index * FRAME_W : (index + 1) * FRAME_W],
            keep_accessories,
        )
        frames.append(frame)
        removed += frame_removed

        alpha = frame[:, :, 3]
        ys, xs = np.where(alpha > 0)
        if not len(xs):
            raise ValueError(f"{path}: frame {index} became empty")
        if xs.min() < 4 or xs.max() > FRAME_W - 5 or ys.min() < 3 or ys.max() > FRAME_H - 3:
            raise ValueError(
                f"{path}: frame {index} lacks safe padding "
                f"bbox=({xs.min()},{ys.min()})-({xs.max()},{ys.max()})"
            )

    cleaned = Image.fromarray(np.concatenate(frames, axis=1))
    cleaned.save(path, optimize=True)
    webp = path.with_suffix(".webp")
    cleaned.save(webp, "WEBP", quality=92, method=6)
    print(
        f"{path.relative_to(ROOT)} -> {webp.relative_to(ROOT)} "
        f"removed={removed} png={path.stat().st_size} webp={webp.stat().st_size}"
    )


def finalize_wipeout() -> None:
    source = ROOT / "public" / "art" / "vfx" / "matchday-wipeout-strip.png"
    rgba = np.asarray(Image.open(source).convert("RGBA")).copy()
    rgba[rgba[:, :, 3] < 16, 3] = 0
    rgba[rgba[:, :, 3] == 0, :3] = 0
    image = Image.fromarray(rgba)
    image.save(source, optimize=True)
    webp = source.with_suffix(".webp")
    image.save(webp, "WEBP", quality=92, method=6)
    print(
        f"{source.relative_to(ROOT)} -> {webp.relative_to(ROOT)} "
        f"png={source.stat().st_size} webp={webp.stat().st_size}"
    )


def main() -> None:
    for boss in BOSSES:
        for direction in DIRECTIONS:
            finalize_boss(ASSET_ROOT / boss / f"{direction}.png")
    finalize_wipeout()


if __name__ == "__main__":
    main()
