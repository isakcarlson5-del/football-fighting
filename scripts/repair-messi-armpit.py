#!/usr/bin/env python3
"""Punch leftover white armpit blobs to transparent so the pitch shows through.

White kit stripes stay: they are tall vertical components. Small white
patches against skin in the torso band are gap leftovers, not kit.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "public/art/players/directional-v4/messi"
BACKUP = ROOT / "work/asset-backups/messi-armpit-2026-08-18"
FRAME_W = 256
FRAME_H = 320
FRAME_COUNT = 12


def is_white(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    luma = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    return (alpha > 40) & (mn > 168) & ((mx - mn) < 52) & (luma > 180)


def is_skin(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    return (alpha > 80) & (r > 125) & (r > g * 1.04) & (g > b) & ((r - b) > 28)


def components(mask: np.ndarray) -> list[np.ndarray]:
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out: list[np.ndarray] = []
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if seen[y, x]:
            continue
        stack = [(y, x)]
        seen[y, x] = True
        cells: list[tuple[int, int]] = []
        while stack:
            cy, cx = stack.pop()
            cells.append((cy, cx))
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if ny < 0 or nx < 0 or ny >= h or nx >= w:
                    continue
                if seen[ny, nx] or not mask[ny, nx]:
                    continue
                seen[ny, nx] = True
                stack.append((ny, nx))
        arr = np.array(cells)
        out.append(arr)
    return out


def repair_frame(rgba: np.ndarray) -> int:
    rgb = rgba[:, :, :3].astype(np.int16)
    alpha = rgba[:, :, 3]
    white = is_white(rgb, alpha)
    skin = is_skin(rgb, alpha)
    changed = 0
    for cells in components(white):
        ys = cells[:, 0]
        xs = cells[:, 1]
        height = int(ys.max() - ys.min()) + 1
        width = int(xs.max() - xs.min()) + 1
        mid_y = float(ys.mean())
        if mid_y < 100 or mid_y > 220:
            continue
        if height > 26 or width > 24 or cells.shape[0] > 200:
            continue
        touches_skin = False
        for y, x in cells:
            for oy in (-2, -1, 0, 1, 2):
                for ox in (-2, -1, 0, 1, 2):
                    ny, nx = int(y + oy), int(x + ox)
                    if ny < 0 or nx < 0 or ny >= FRAME_H or nx >= FRAME_W:
                        continue
                    if skin[ny, nx]:
                        touches_skin = True
        if not touches_skin:
            continue
        for y, x in cells:
            rgba[int(y), int(x), 0] = 0
            rgba[int(y), int(x), 1] = 0
            rgba[int(y), int(x), 2] = 0
            rgba[int(y), int(x), 3] = 0
            changed += 1
    # The leftover armpit/hand fill is often glued to the kit stripe, so
    # component size skips it. Punch any white pixel that sits on skin.
    rgb = rgba[:, :, :3].astype(np.int16)
    alpha = rgba[:, :, 3]
    white = is_white(rgb, alpha)
    skin = is_skin(rgb, alpha)
    ys, xs = np.nonzero(white)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if y < 108 or y > 180:
            continue
        near_skin = False
        for oy in range(-3, 4):
            for ox in range(-3, 4):
                ny, nx = y + oy, x + ox
                if ny < 0 or nx < 0 or ny >= FRAME_H or nx >= FRAME_W:
                    continue
                if skin[ny, nx]:
                    near_skin = True
                    break
            if near_skin:
                break
        if near_skin:
            rgba[y, x, :] = 0
            changed += 1
    return changed


def repair_strip(path: Path) -> int:
    image = Image.open(path).convert("RGBA")
    arr = np.array(image)
    total = 0
    for frame in range(FRAME_COUNT):
        x0 = frame * FRAME_W
        frame_arr = arr[:, x0 : x0 + FRAME_W].copy()
        total += repair_frame(frame_arr)
        arr[:, x0 : x0 + FRAME_W] = frame_arr
    Image.fromarray(arr).save(path, format="WEBP", lossless=True, method=6)
    return total


def main() -> None:
    BACKUP.mkdir(parents=True, exist_ok=True)
    total = 0
    paths = sorted(SRC_DIR.glob("*.webp"))
    for player in ("neymar", "ronaldo", "yamal"):
        paths.extend(sorted((ROOT / "public/art/players/directional-v4" / player).glob("*.webp")))
    for path in paths:
        dest = BACKUP / f"{path.parent.name}-{path.name}"
        if path.parent.name == "messi" and dest.exists():
            shutil.copy2(dest, path)
        elif (BACKUP / path.name).exists() and path.parent.name == "messi":
            shutil.copy2(BACKUP / path.name, path)
        elif not dest.exists():
            shutil.copy2(path, dest)
        changed = repair_strip(path)
        total += changed
        print(f"{path.parent.name}/{path.name:12s} punched {changed}")
    print(f"total {total}")


if __name__ == "__main__":
    main()
