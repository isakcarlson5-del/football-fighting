#!/usr/bin/env python3
"""Build strict, artifact-free v4 directional player animation candidates.

The v4 pipeline is intentionally separate from the installed v3 runtime. It
extracts a 6x2 AI source grid, rebuilds edge colors beneath a clean alpha
matte, aligns every frame to one footline, and rejects clipping or white
fringing before a candidate can be reviewed for installation.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "work" / "player-atlas-v4" / "source-grids"
CANDIDATE_ROOT = ROOT / "work" / "player-atlas-v4" / "candidates"

GRID_COLUMNS = 6
GRID_ROWS = 2
FRAME_COUNT = GRID_COLUMNS * GRID_ROWS
DIRECTIONS = ("n", "ne", "e", "se", "s", "sw", "w", "nw")
FRAME_W = 256
FRAME_H = 320
SAFE_MARGIN = 12
FEET_Y = FRAME_H - SAFE_MARGIN - 1
TARGET_HEIGHT = 286


def largest_subject(mask: np.ndarray) -> np.ndarray:
    binary = (mask > 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    if count <= 1:
        raise ValueError("segmentation produced no visible subject")
    candidates = sorted(
        range(1, count),
        key=lambda index: int(stats[index, cv2.CC_STAT_AREA]),
        reverse=True,
    )
    primary = candidates[0]
    result = np.zeros_like(binary)
    result[labels == primary] = 255
    px, py, pw, ph, primary_area = stats[primary]
    primary_bottom = py + ph
    for component in candidates[1:]:
        x, y, width, height, area = stats[component]
        if area < max(48, primary_area * 0.003):
            continue
        horizontal_gap = max(0, px - (x + width), x - (px + pw))
        vertical_gap = max(0, py - (y + height), y - primary_bottom)
        if horizontal_gap <= 14 and vertical_gap <= 18:
            result[labels == component] = 255
    return result


def edge_connected_background(rgb: np.ndarray) -> np.ndarray:
    """Return the primary subject from white/checker or chroma-green sheets.

    Background classification is deliberately edge-connected. A green item of
    kit therefore remains intact unless it is actually connected to the outer
    sheet background.
    """
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    neutral_bright = ((minimum > 210) & ((maximum - minimum) < 30)).astype(np.uint8)
    red = rgb[:, :, 0].astype(np.int16)
    green = rgb[:, :, 1].astype(np.int16)
    blue = rgb[:, :, 2].astype(np.int16)
    chroma_green = (
        (green > 82)
        & (green - red > 42)
        & (green - blue > 42)
        & (green > red * 1.32)
        & (green > blue * 1.32)
    ).astype(np.uint8)

    border = np.concatenate((
        rgb[0, :, :],
        rgb[-1, :, :],
        rgb[:, 0, :],
        rgb[:, -1, :],
    ))
    border_green_ratio = float((
        (border[:, 1] > 82)
        & (border[:, 1].astype(np.int16) - border[:, 0].astype(np.int16) > 42)
        & (border[:, 1].astype(np.int16) - border[:, 2].astype(np.int16) > 42)
    ).mean())
    flood = (chroma_green if border_green_ratio > 0.55 else neutral_bright).copy()
    flood_mask = np.zeros((flood.shape[0] + 2, flood.shape[1] + 2), np.uint8)
    for x in range(flood.shape[1]):
        if flood[0, x] == 1:
            cv2.floodFill(flood, flood_mask, (x, 0), 2)
        if flood[-1, x] == 1:
            cv2.floodFill(flood, flood_mask, (x, flood.shape[0] - 1), 2)
    for y in range(flood.shape[0]):
        if flood[y, 0] == 1:
            cv2.floodFill(flood, flood_mask, (0, y), 2)
        if flood[y, -1] == 1:
            cv2.floodFill(flood, flood_mask, (flood.shape[1] - 1, y), 2)
    foreground = np.where(flood == 2, 0, 255).astype(np.uint8)
    foreground = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return largest_subject(foreground)


def clean_rgba(rgb: np.ndarray) -> np.ndarray:
    hard_mask = edge_connected_background(rgb)
    # Pull the visible edge one pixel into the subject. The softly blurred
    # matte is then painted with nearest interior colors rather than the
    # source sheet's white checkerboard, eliminating light fringe pixels.
    core = cv2.erode(hard_mask, np.ones((3, 3), np.uint8), iterations=1) > 0
    if int(core.sum()) < 1_200:
        raise ValueError("foreground core is too small")
    _, nearest = distance_transform_edt(~core, return_indices=True)
    filled_rgb = rgb[nearest[0], nearest[1]]
    alpha = cv2.GaussianBlur((core.astype(np.uint8) * 255), (0, 0), 0.72)
    alpha[alpha < 4] = 0
    rgba = np.dstack((filled_rgb, alpha)).astype(np.uint8)
    rgba[alpha == 0, :3] = 0
    return rgba


def premultiplied_resize(rgba: np.ndarray, width: int, height: int) -> np.ndarray:
    alpha = rgba[:, :, 3].astype(np.float32) / 255.0
    premultiplied = rgba[:, :, :3].astype(np.float32) * alpha[:, :, None]
    resized_alpha = cv2.resize(alpha, (width, height), interpolation=cv2.INTER_LANCZOS4)
    resized_premultiplied = cv2.resize(premultiplied, (width, height), interpolation=cv2.INTER_LANCZOS4)
    resized_alpha = np.clip(resized_alpha, 0.0, 1.0)
    safe_alpha = np.maximum(resized_alpha, 1e-5)
    resized_rgb = np.clip(resized_premultiplied / safe_alpha[:, :, None], 0, 255)
    output = np.dstack((resized_rgb, resized_alpha * 255)).astype(np.uint8)
    output[output[:, :, 3] < 4] = 0
    return output


def repair_white_composite_fringe(rgba: np.ndarray) -> np.ndarray:
    """Replace only white matte remnants that do not belong to white kit."""
    output = rgba.copy()
    alpha = output[:, :, 3]
    rgb = output[:, :, :3]
    opaque = alpha >= 245
    _, nearest_opaque = distance_transform_edt(~opaque, return_indices=True)
    interior_rgb = rgb[nearest_opaque[0], nearest_opaque[1]]
    edge = (alpha > 0) & (alpha < 245)
    edge_white = edge & (rgb.min(axis=2) > 232) & ((rgb.max(axis=2) - rgb.min(axis=2)) < 18)
    interior_white = (interior_rgb.min(axis=2) > 218) & ((interior_rgb.max(axis=2) - interior_rgb.min(axis=2)) < 28)
    repair = edge_white & ~interior_white
    output[repair, :3] = interior_rgb[repair]
    return output


def remove_detached_components(rgba: np.ndarray) -> np.ndarray:
    """Keep the complete connected character and remove isolated matte debris."""
    output = rgba.copy()
    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        (output[:, :, 3] > 0).astype(np.uint8),
        8,
    )
    if count <= 1:
        raise ValueError("normalized frame contains no connected subject")
    primary = max(
        range(1, count),
        key=lambda component: int(stats[component, cv2.CC_STAT_AREA]),
    )
    output[labels != primary] = 0
    return output


def prepare_frame(cell_rgb: np.ndarray) -> np.ndarray:
    rgba = clean_rgba(cell_rgb)
    alpha = rgba[:, :, 3]
    ys, xs = np.where(alpha > 20)
    if len(xs) < 1_200:
        raise ValueError(f"frame has too little visible art: {len(xs)} pixels")
    source_margin = min(
        int(xs.min()),
        cell_rgb.shape[1] - 1 - int(xs.max()),
        int(ys.min()),
        cell_rgb.shape[0] - 1 - int(ys.max()),
    )
    source_safe_margin = max(4, round(min(cell_rgb.shape[:2]) * 0.015))
    if source_margin < source_safe_margin:
        raise ValueError(
            "source subject is cropped or crosses its grid cell: "
            f"margin={source_margin}, required={source_safe_margin}"
        )
    left, top = int(xs.min()), int(ys.min())
    right, bottom = int(xs.max()) + 1, int(ys.max()) + 1
    pad = 3
    crop = rgba[
        max(0, top - pad):min(rgba.shape[0], bottom + pad),
        max(0, left - pad):min(rgba.shape[1], right + pad),
    ]
    return crop


def normalize_prepared_frame(crop: np.ndarray, scale: float) -> Image.Image:
    width = max(1, round(crop.shape[1] * scale))
    height = max(1, round(crop.shape[0] * scale))
    max_width = FRAME_W - SAFE_MARGIN * 2
    if width > max_width or height > TARGET_HEIGHT:
        raise ValueError(
            f"shared scale exceeds runtime frame: width={width}, height={height}"
        )
    resized = premultiplied_resize(crop, width, height)
    output = np.zeros((FRAME_H, FRAME_W, 4), np.uint8)
    x = (FRAME_W - width) // 2
    y = FEET_Y - height
    if x < SAFE_MARGIN or y < SAFE_MARGIN:
        raise ValueError(f"normalized art violates safe placement: x={x}, y={y}")
    output[y:y + height, x:x + width] = resized
    output = repair_white_composite_fringe(output)
    return Image.fromarray(remove_detached_components(output))


def frame_metrics(frame: Image.Image, index: int) -> dict[str, int | float]:
    rgba = np.asarray(frame.convert("RGBA"))
    alpha = rgba[:, :, 3]
    ys, xs = np.where(alpha > 8)
    if len(xs) == 0:
        raise ValueError(f"frame {index}: empty alpha")
    margins = {
        "left": int(xs.min()),
        "top": int(ys.min()),
        "right": FRAME_W - 1 - int(xs.max()),
        "bottom": FRAME_H - 1 - int(ys.max()),
    }
    smallest_margin = min(margins.values())
    if smallest_margin < SAFE_MARGIN:
        raise ValueError(f"frame {index}: clipped safety margin {margins}")
    component_count, _, stats, _ = cv2.connectedComponentsWithStats(
        (alpha > 0).astype(np.uint8),
        8,
    )
    connected_components = [
        int(stats[component, cv2.CC_STAT_AREA])
        for component in range(1, component_count)
    ]
    if len(connected_components) != 1:
        raise ValueError(
            f"frame {index}: detached foreground components {connected_components}"
        )
    edge_alpha = (alpha > 0) & (alpha < 245)
    edge_rgb = rgba[:, :, :3]
    white_edge = edge_alpha & (edge_rgb.min(axis=2) > 232) & ((edge_rgb.max(axis=2) - edge_rgb.min(axis=2)) < 18)
    opaque = alpha >= 245
    _, nearest_opaque = distance_transform_edt(~opaque, return_indices=True)
    interior_rgb = edge_rgb[nearest_opaque[0], nearest_opaque[1]]
    interior_white = (interior_rgb.min(axis=2) > 218) & ((interior_rgb.max(axis=2) - interior_rgb.min(axis=2)) < 28)
    suspicious_fringe_count = int((white_edge & ~interior_white).sum())
    if suspicious_fringe_count > 2:
        raise ValueError(f"frame {index}: {suspicious_fringe_count} suspicious white fringe pixels")
    return {
        "margin": smallest_margin,
        "width": int(xs.max() - xs.min() + 1),
        "height": int(ys.max() - ys.min() + 1),
        "white_fringe": suspicious_fringe_count,
    }


def frame_difference(left: Image.Image, right: Image.Image) -> float:
    a = np.asarray(left.convert("RGBA"), dtype=np.int16)
    b = np.asarray(right.convert("RGBA"), dtype=np.int16)
    return float(np.abs(a - b).mean())


def smooth_closed_loop(frames: list[Image.Image]) -> tuple[list[Image.Image], tuple[int, ...], list[float], list[float]]:
    """Find the least-discontinuous closed frame order with Held-Karp DP."""
    count = len(frames)
    distance = np.zeros((count, count), np.float64)
    for left in range(count):
        for right in range(count):
            distance[left, right] = frame_difference(frames[left], frames[right])
    original_edges = [float(distance[index, (index + 1) % count]) for index in range(count)]
    paths: dict[tuple[int, int], tuple[float, tuple[int, ...]]] = {(1, 0): (0.0, (0,))}
    for mask in range(1, 1 << count):
        if not mask & 1:
            continue
        for last in range(count):
            state = (mask, last)
            if state not in paths:
                continue
            cost, path = paths[state]
            for following in range(1, count):
                if mask & (1 << following):
                    continue
                next_mask = mask | (1 << following)
                next_cost = cost + float(distance[last, following])
                previous = paths.get((next_mask, following))
                if previous is None or next_cost < previous[0]:
                    paths[(next_mask, following)] = (next_cost, path + (following,))
    full_mask = (1 << count) - 1
    _, order = min(
        (cost + float(distance[last, 0]), path)
        for (mask, last), (cost, path) in paths.items()
        if mask == full_mask
    )
    ordered_edges = [float(distance[order[index], order[(index + 1) % count]]) for index in range(count)]
    return [frames[index] for index in order], order, original_edges, ordered_edges


def extract_frames(source: Path) -> list[Image.Image]:
    grid = Image.open(source).convert("RGB")
    prepared: list[np.ndarray] = []
    for index in range(FRAME_COUNT):
        column = index % GRID_COLUMNS
        row = index // GRID_COLUMNS
        nominal_left = round(column * grid.width / GRID_COLUMNS)
        nominal_right = round((column + 1) * grid.width / GRID_COLUMNS)
        nominal_top = round(row * grid.height / GRID_ROWS)
        nominal_bottom = round((row + 1) * grid.height / GRID_ROWS)
        # AI grids regularly place an extended boot a few pixels over the
        # mathematical cell boundary even when the complete body still exists
        # in the source image. Read overlapping source windows, isolate the
        # largest connected subject, then normalize it into a genuinely safe
        # independent runtime frame. The outer image edge remains a hard edge,
        # so genuinely cropped source art is still rejected by normalize_frame.
        overlap_x = round((nominal_right - nominal_left) * 0.24)
        overlap_y = round((nominal_bottom - nominal_top) * 0.10)
        left = max(0, nominal_left - overlap_x)
        right = min(grid.width, nominal_right + overlap_x)
        top = max(0, nominal_top - overlap_y)
        bottom = min(grid.height, nominal_bottom + overlap_y)
        prepared.append(prepare_frame(np.asarray(grid.crop((left, top, right, bottom)))))
    max_width = max(frame.shape[1] for frame in prepared)
    max_height = max(frame.shape[0] for frame in prepared)
    shared_scale = min(
        TARGET_HEIGHT / max(1, max_height),
        (FRAME_W - SAFE_MARGIN * 2) / max(1, max_width),
    )
    return [normalize_prepared_frame(frame, shared_scale) for frame in prepared]


def write_candidate(player: str, direction: str) -> None:
    source = SOURCE_ROOT / player / f"{direction}.png"
    if not source.is_file():
        raise FileNotFoundError(source)
    source_frames = extract_frames(source)
    frames, source_order, original_differences, differences = smooth_closed_loop(source_frames)
    metrics = [frame_metrics(frame, index) for index, frame in enumerate(frames)]
    if min(differences) < 0.35:
        raise ValueError(f"adjacent frames are too similar: {min(differences):.3f}")

    output_dir = CANDIDATE_ROOT / player
    output_dir.mkdir(parents=True, exist_ok=True)
    frame_dir = output_dir / f"{direction}-frames"
    frame_dir.mkdir(parents=True, exist_ok=True)
    strip = Image.new("RGBA", (FRAME_W * FRAME_COUNT, FRAME_H), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        strip.alpha_composite(frame, (index * FRAME_W, 0))
        frame.save(frame_dir / f"{index + 1:02d}.png")
    strip.save(output_dir / f"{direction}.webp", "WEBP", quality=94, method=6, exact=True)

    contact = Image.new("RGBA", (FRAME_W * GRID_COLUMNS, FRAME_H * GRID_ROWS), (36, 87, 36, 255))
    draw = ImageDraw.Draw(contact)
    for index, frame in enumerate(frames):
        x = (index % GRID_COLUMNS) * FRAME_W
        y = (index // GRID_COLUMNS) * FRAME_H
        contact.alpha_composite(frame, (x, y))
        draw.text(
            (x + 8, y + 8),
            f"{index + 1:02d} <- source {source_order[index] + 1:02d}",
            fill=(255, 225, 113, 255),
        )
    contact.save(output_dir / f"{direction}-contact.png")
    frames[0].save(
        output_dir / f"{direction}-loop.webp",
        "WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=72,
        loop=0,
        lossless=True,
        method=6,
    )
    preview_frames: list[Image.Image] = []
    for frame in frames:
        preview = Image.new("RGBA", (FRAME_W, FRAME_H), (36, 87, 36, 255))
        preview.alpha_composite(frame)
        preview_frames.append(preview.convert("RGB"))
    preview_frames[0].save(
        output_dir / f"{direction}-loop-preview.webp",
        "WEBP",
        save_all=True,
        append_images=preview_frames[1:],
        duration=72,
        loop=0,
        lossless=True,
        method=6,
    )

    heights = [int(metric["height"]) for metric in metrics]
    widths = [int(metric["width"]) for metric in metrics]
    print(
        f"{player}/{direction}: frames={len(frames)} "
        f"margin={min(int(metric['margin']) for metric in metrics)} "
        f"height={min(heights)}..{max(heights)} width={min(widths)}..{max(widths)} "
        f"white-fringe={sum(int(metric['white_fringe']) for metric in metrics)} "
        f"original-max-diff={max(original_differences):.2f} max-diff={max(differences):.2f} "
        f"original-total-diff={sum(original_differences):.2f} total-diff={sum(differences):.2f} "
        f"order={','.join(str(index + 1) for index in source_order)}"
    )


def build_player_overview(player: str) -> None:
    strips: dict[str, Image.Image] = {}
    for direction in DIRECTIONS:
        path = CANDIDATE_ROOT / player / f"{direction}.webp"
        if not path.is_file():
            raise FileNotFoundError(path)
        strip = Image.open(path).convert("RGBA")
        if strip.size != (FRAME_W * FRAME_COUNT, FRAME_H):
            raise ValueError(f"{path}: unexpected strip size {strip.size}")
        strips[direction] = strip

    overview_frames: list[Image.Image] = []
    for frame_index in range(FRAME_COUNT):
        overview = Image.new("RGB", (FRAME_W * 4, FRAME_H * 2), (36, 87, 36))
        draw = ImageDraw.Draw(overview)
        for direction_index, direction in enumerate(DIRECTIONS):
            cell = strips[direction].crop(
                (frame_index * FRAME_W, 0, (frame_index + 1) * FRAME_W, FRAME_H)
            )
            x = (direction_index % 4) * FRAME_W
            y = (direction_index // 4) * FRAME_H
            overview.paste(cell, (x, y), cell)
            draw.text((x + 8, y + 8), direction.upper(), fill=(255, 225, 113))
        overview_frames.append(overview)

    output_dir = CANDIDATE_ROOT / player
    overview_frames[0].save(output_dir / "all-directions-contact.png")
    overview_frames[0].save(
        output_dir / "all-directions-loop-preview.webp",
        "WEBP",
        save_all=True,
        append_images=overview_frames[1:],
        duration=72,
        loop=0,
        lossless=True,
        method=6,
    )
    print(f"{player}: overview directions={len(DIRECTIONS)} frames={len(DIRECTIONS) * FRAME_COUNT}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("player")
    parser.add_argument("direction")
    args = parser.parse_args()
    if args.direction == "all":
        build_player_overview(args.player)
    else:
        write_candidate(args.player, args.direction)


if __name__ == "__main__":
    main()
