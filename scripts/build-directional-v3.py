#!/usr/bin/env python3
"""Build normalized 12-frame directional player atlases from AI source grids.

Each source image is a 6x2 grid. The script segments every frame, keeps the
largest connected subject, aligns the feet to a shared baseline, and emits a
compact transparent WebP strip without modifying the directional-v2 fallback.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "work" / "player-atlas-v3" / "source-grids"
RUNTIME_ROOT = ROOT / "public" / "art" / "players" / "directional-v3"
PREVIEW_ROOT = ROOT / "work" / "player-atlas-v3" / "previews"

PLAYERS = ("messi", "ronaldo", "neymar", "yamal")
DIRECTIONS = ("n", "ne", "e", "se", "s", "sw", "w", "nw")
FULL_GRID_DIRECTIONS = {("yamal", "ne"), ("yamal", "e")}
GRID_COLUMNS = 6
GRID_ROWS = 2
FRAME_COUNT = GRID_COLUMNS * GRID_ROWS
FRAME_W = 256
FRAME_H = 320
FEET_Y = 312
TARGET_HEIGHT = 296


def largest_subject(mask: np.ndarray) -> np.ndarray:
    binary = (mask > 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    if count <= 1:
        raise ValueError("segmentation produced no visible subject")
    candidates = sorted(range(1, count), key=lambda i: int(stats[i, cv2.CC_STAT_AREA]), reverse=True)
    result = np.zeros_like(binary)
    primary = candidates[0]
    result[labels == primary] = 255
    px, py, pw, ph, primary_area = stats[primary]
    primary_bottom = py + ph
    # Keep small pieces only when they are close to the body. This preserves
    # separated boots while rejecting checkerboard islands and floor glows.
    for component in candidates[1:]:
        x, y, w, h, area = stats[component]
        if area < max(35, primary_area * 0.002):
            continue
        horizontal_gap = max(0, px - (x + w), x - (px + pw))
        vertical_gap = max(0, py - (y + h), y - primary_bottom)
        if horizontal_gap <= 18 and vertical_gap <= 22:
            result[labels == component] = 255
    return result


def checkerboard_mask(rgb: np.ndarray) -> np.ndarray | None:
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    neutral_bright = (minimum > 214) & ((maximum - minimum) < 24)
    border_ratio = np.concatenate(
        (neutral_bright[:8].ravel(), neutral_bright[-8:].ravel(), neutral_bright[:, :8].ravel(), neutral_bright[:, -8:].ravel())
    ).mean()
    if border_ratio < 0.72:
        return None
    # Only erase neutral pixels connected to an edge. White shirt/short details
    # remain protected when enclosed by the character silhouette.
    candidate = neutral_bright.astype(np.uint8)
    flood_source = candidate.copy()
    flood_mask = np.zeros((candidate.shape[0] + 2, candidate.shape[1] + 2), np.uint8)
    for x in range(candidate.shape[1]):
        if flood_source[0, x]:
            cv2.floodFill(flood_source, flood_mask, (x, 0), 2)
        if flood_source[-1, x] == 1:
            cv2.floodFill(flood_source, flood_mask, (x, candidate.shape[0] - 1), 2)
    for y in range(candidate.shape[0]):
        if flood_source[y, 0] == 1:
            cv2.floodFill(flood_source, flood_mask, (0, y), 2)
        if flood_source[y, -1] == 1:
            cv2.floodFill(flood_source, flood_mask, (candidate.shape[1] - 1, y), 2)
    foreground = np.where(flood_source == 2, 0, 255).astype(np.uint8)
    return largest_subject(foreground)


def grabcut_mask(rgb: np.ndarray) -> np.ndarray:
    height, width = rgb.shape[:2]
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    mask = np.full((height, width), cv2.GC_PR_BGD, np.uint8)
    border = max(5, round(min(width, height) * 0.025))
    mask[:border] = cv2.GC_BGD
    mask[-border:] = cv2.GC_BGD
    mask[:, :border] = cv2.GC_BGD
    mask[:, -border:] = cv2.GC_BGD
    # Saturated and high-contrast pixels near the center are reliable kit/skin
    # seeds. The rest is classified by GrabCut from the clean outer border.
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    yy, xx = np.mgrid[:height, :width]
    central = (xx > width * 0.12) & (xx < width * 0.88) & (yy > height * 0.04) & (yy < height * 0.98)
    mask[central & (hsv[:, :, 1] > 72)] = cv2.GC_PR_FGD
    bg_model = np.zeros((1, 65), np.float64)
    fg_model = np.zeros((1, 65), np.float64)
    cv2.grabCut(bgr, mask, None, bg_model, fg_model, 7, cv2.GC_INIT_WITH_MASK)
    foreground = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    foreground = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return largest_subject(foreground)


def segment_frame(rgb: np.ndarray) -> Image.Image:
    mask = checkerboard_mask(rgb)
    if mask is None:
        mask = grabcut_mask(rgb)
    alpha = cv2.GaussianBlur(mask, (0, 0), 0.65)
    alpha[alpha < 8] = 0
    rgba = np.dstack((rgb, alpha)).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba)


def normalize_frame(frame: Image.Image) -> Image.Image:
    alpha = np.asarray(frame.getchannel("A"))
    ys, xs = np.where(alpha > 20)
    if len(xs) < 1200:
        raise ValueError(f"frame has too little visible art: {len(xs)} pixels")
    left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    crop = frame.crop((max(0, left - 3), max(0, top - 3), min(frame.width, right + 3), min(frame.height, bottom + 3)))
    scale = TARGET_HEIGHT / max(1, crop.height)
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    if width > FRAME_W - 8:
        scale *= (FRAME_W - 8) / width
        width = max(1, round(crop.width * scale))
        height = max(1, round(crop.height * scale))
    crop = crop.resize((width, height), Image.Resampling.LANCZOS)
    output = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    output.alpha_composite(crop, ((FRAME_W - width) // 2, FEET_Y - height))
    return output


def extract_full_grid_figures(source: Path) -> list[Image.Image]:
    """Find complete figures globally when artwork crosses nominal cell lines."""
    grid = Image.open(source).convert("RGB")
    rgb = np.asarray(grid)
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    foreground = ((minimum <= 214) | ((maximum - minimum) >= 24)).astype(np.uint8)
    foreground = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, _, stats, centers = cv2.connectedComponentsWithStats(foreground, 8)
    subjects: list[tuple[float, float, int, int, int, int]] = []
    for component in range(1, count):
        x, y, width, height, area = map(int, stats[component])
        if area <= 1500 or width <= 40 or height <= 100:
            continue
        center_x, center_y = map(float, centers[component])
        subjects.append((center_y, center_x, x, y, width, height))
    subjects.sort(key=lambda item: (0 if item[0] < grid.height / 2 else 1, item[1]))
    frames: list[Image.Image] = []
    for _, _, x, y, width, height in subjects:
        pad_x = 12
        pad_top = 10
        pad_bottom = 18
        crop = np.asarray(
            grid.crop(
                (
                    max(0, x - pad_x),
                    max(0, y - pad_top),
                    min(grid.width, x + width + pad_x),
                    min(grid.height, y + height + pad_bottom),
                )
            )
        )
        frames.append(normalize_frame(segment_frame(crop)))
    return frames


def frame_difference(a: Image.Image, b: Image.Image) -> float:
    left = np.asarray(a.convert("RGBA"), dtype=np.int16)
    right = np.asarray(b.convert("RGBA"), dtype=np.int16)
    return float(np.abs(left - right).mean())


def process_grid(player: str, direction: str) -> tuple[int, float]:
    source = SOURCE_ROOT / player / f"{direction}.png"
    if (player, direction) in FULL_GRID_DIRECTIONS:
        frames = extract_full_grid_figures(source)
    elif (player, direction) == ("yamal", "se"):
        alternate = SOURCE_ROOT / player / "se-alt.png"
        alternate_frames = extract_full_grid_figures(alternate)
        fallback_frames = extract_full_grid_figures(source)
        if len(alternate_frames) != 11 or len(fallback_frames) < 10:
            raise ValueError(
                f"yamal/se source fusion expected 11+10 figures, got {len(alternate_frames)}+{len(fallback_frames)}"
            )
        frames = [*alternate_frames, fallback_frames[-1]]
    else:
        grid = Image.open(source).convert("RGB")
        frames = []
        for index in range(FRAME_COUNT):
            column = index % GRID_COLUMNS
            row = index // GRID_COLUMNS
            left = round(column * grid.width / GRID_COLUMNS)
            right = round((column + 1) * grid.width / GRID_COLUMNS)
            top = round(row * grid.height / GRID_ROWS)
            bottom = round((row + 1) * grid.height / GRID_ROWS)
            cell = np.asarray(grid.crop((left, top, right, bottom)))
            frames.append(normalize_frame(segment_frame(cell)))

    if len(frames) != FRAME_COUNT:
        raise ValueError(f"{source}: expected 12 complete figures, detected {len(frames)}")

    differences = [frame_difference(frames[index], frames[(index + 1) % FRAME_COUNT]) for index in range(FRAME_COUNT)]
    minimum_difference = min(differences)
    if minimum_difference < 0.35:
        raise ValueError(f"{source}: adjacent frames are too similar ({minimum_difference:.3f})")

    strip = Image.new("RGBA", (FRAME_W * FRAME_COUNT, FRAME_H), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        strip.alpha_composite(frame, (index * FRAME_W, 0))
    output = RUNTIME_ROOT / player / f"{direction}.webp"
    output.parent.mkdir(parents=True, exist_ok=True)
    strip.save(output, "WEBP", quality=93, method=6, exact=True)

    preview = Image.new("RGBA", (FRAME_W * GRID_COLUMNS, FRAME_H * GRID_ROWS), (28, 54, 25, 255))
    for index, frame in enumerate(frames):
        preview.alpha_composite(frame, ((index % GRID_COLUMNS) * FRAME_W, (index // GRID_COLUMNS) * FRAME_H))
    preview_path = PREVIEW_ROOT / player / f"{direction}.png"
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    preview.save(preview_path)
    return output.stat().st_size, minimum_difference


def main() -> None:
    total_bytes = 0
    for player in PLAYERS:
        for direction in DIRECTIONS:
            size, difference = process_grid(player, direction)
            total_bytes += size
            print(f"{player}/{direction}: 12 frames, min-diff={difference:.2f}, bytes={size}")
    print(f"built={len(PLAYERS) * len(DIRECTIONS)} strips frames={len(PLAYERS) * len(DIRECTIONS) * FRAME_COUNT} bytes={total_bytes}")


if __name__ == "__main__":
    main()
