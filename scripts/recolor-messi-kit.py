#!/usr/bin/env python3
"""Recolor Messi's generated strips to the canonical data.ts palette:
vivid sky-blue kit #2e86de with #1562af shadows, pure-black outlines,
canonical dark-brown hair/beard #4a3222, purer whites, redder skin.
Applies to the runtime strips the game loads and the art-source plates
retained for provenance, so a future regeneration keeps the palette.
"""

from __future__ import annotations

import colorsys
import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

KIT_BLUE_HUE = 210.0  # canonical shirt/socks #2e86de
KIT_BLUE_SAT = 0.79
SHADOW_BLUE_HUE = 210.0  # canonical shaded fold #1562af
SHADOW_BLUE_SAT = 0.88
OUTLINE_MAX = 70  # any blue-dominant pixel this dark becomes pure black
HAIR_HUE = 24.0  # canonical hair/beard #4a3222
HAIR_SAT = 0.54
HAIR_MAX = 120  # only genuinely dark browns are hair/beard, not shaded skin
WHITE_STRENGTH = 0.75  # 0..1 pull toward pure white
ALPHA_THRESHOLD = 40

RUNTIME_STRIPS = [
    Path("public/art/players/messi.png"),
    Path("public/art/players/messi-idle.png"),
    Path("public/art/players/messi-run.png"),
    Path("public/art/players/messi-kick.png"),
]
RUNTIME_DIRECTIONAL = sorted((ROOT / "public/art/players/directional-v4/messi").glob("*.webp"))
SOURCE_STRIPS = [
    Path("art-source/players/messi-run6-src.png"),
    Path("art-source/players/messi-kick-src.png"),
]
SOURCE_DIRECTIONAL = sorted((ROOT / "art-source/players/directional-v2/messi").glob("*.png"))


def recolor_pixels(rgba: np.ndarray) -> dict[str, int]:
    """In-place recolor. Returns per-family changed-pixel counts."""
    counts = {"blue": 0, "shadow": 0, "outline": 0, "white": 0, "skin": 0, "hair": 0}
    alpha = rgba[:, :, 3]
    active = alpha > ALPHA_THRESHOLD
    rgb = rgba[:, :, :3].astype(np.float32)

    blue = active & (rgb[:, :, 2] > rgb[:, :, 0] * 1.04) & (rgb[:, :, 2] > rgb[:, :, 1] * 1.02)
    white = active & (rgb.min(axis=2) > 178) & (rgb.max(axis=2) - rgb.min(axis=2) < 46)
    skin = (
        active
        & ~blue
        & ~white
        & (rgb[:, :, 0] > 130)
        & (rgb[:, :, 0] > rgb[:, :, 1])
        & (rgb[:, :, 1] > rgb[:, :, 2])
        & (rgb[:, :, 0] - rgb[:, :, 2] > 28)
    )
    hair = (
        active
        & ~blue
        & ~white
        & ~skin
        & (rgb.max(axis=2) < HAIR_MAX)
        & (rgb[:, :, 0] >= rgb[:, :, 1])
        & (rgb[:, :, 1] >= rgb[:, :, 2])
        & (rgb[:, :, 0] - rgb[:, :, 2] > 10)
    )

    # White first: near-white blue tints are highlights on white kit, they
    # must converge toward pure white. The blue pass then only ever sees
    # saturated shirt tones and pins them to the canonical palette.
    if white.any():
        new = rgb[white] + (255.0 - rgb[white]) * WHITE_STRENGTH
        rgb[white] = new
        counts["white"] = int(white.sum())

    # Blue kit: a clean flat two-stop palette — main shirt exactly #2e86de,
    # shaded folds exactly #1562af, blue-black contours pure black.
    if blue.any():
        hsv = np.asarray(
            [colorsys.rgb_to_hsv(*(rgb[y, x] / 255.0)) for y, x in np.argwhere(blue)],
            dtype=np.float32,
        )
        val = hsv[:, 2]
        outline = val < OUTLINE_MAX / 255.0
        shadow = ~outline & (val < 0.75)
        main = ~outline & ~shadow
        hsv[:, 0] = KIT_BLUE_HUE / 360.0
        hsv[:, 1] = np.where(shadow, SHADOW_BLUE_SAT, KIT_BLUE_SAT)
        hsv[:, 2] = np.where(shadow, 175 / 255.0, 222 / 255.0)
        new = np.asarray(
            [colorsys.hsv_to_rgb(*row) for row in hsv],
            dtype=np.float32,
        ) * 255.0
        new[outline] = 0.0
        ys, xs = np.nonzero(blue)
        rgb[ys, xs] = new
        counts["outline"] = int(outline.sum())
        counts["shadow"] = int(shadow.sum())
        counts["blue"] = int(main.sum())

    if skin.any():
        r, g, b = rgb[skin, 0], rgb[skin, 1], rgb[skin, 2]
        rgb[skin, 0] = np.minimum(255, r * 1.03 + 4)
        rgb[skin, 1] = np.maximum(0, g * 0.96 - 2)
        rgb[skin, 2] = np.maximum(0, b * 0.92 - 5)
        counts["skin"] = int(skin.sum())

    # Hair/beard: pull hue/sat to canonical #4a3222 and lift strands that are
    # darker than the canonical value so they stop reading red-black.
    if hair.any():
        hsv = np.asarray(
            [colorsys.rgb_to_hsv(*(rgb[y, x] / 255.0)) for y, x in np.argwhere(hair)],
            dtype=np.float32,
        )
        hsv[:, 0] = HAIR_HUE / 360.0
        hsv[:, 1] = HAIR_SAT
        hsv[:, 2] = np.maximum(hsv[:, 2], 74 / 255.0)
        new = np.asarray(
            [colorsys.hsv_to_rgb(*row) for row in hsv],
            dtype=np.float32,
        ) * 255.0
        ys, xs = np.nonzero(hair)
        rgb[ys, xs] = new
        counts["hair"] = int(hair.sum())

    rgba[:, :, :3] = rgb
    return counts


def write_webp_extended_lossless(image: Image.Image, path: Path) -> None:
    """Write a pixel-exact lossless webp wrapped in the extended VP8X
    container the runtime strips use (RIFF > VP8X > VP8L). Plain VP8L is
    valid webp, but the game's asset contract reads the VP8X header."""
    buf = io.BytesIO()
    image.save(buf, "WEBP", lossless=True, method=6)
    data = buf.getvalue()
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    assert data[12:16] == b"VP8L", f"unexpected PIL webp layout: {data[12:16]!r}"
    vp8l = data[12:]
    # Match the VP8X layout PIL/libwebp actually writes (flags byte, three
    # reserved bytes, then the two canvas sizes); the asset contract reads
    # the sizes at exactly those offsets.
    vp8x = b"VP8X" + (10).to_bytes(4, "little") + b"\x10" + b"\x00\x00\x00" \
        + (image.width - 1).to_bytes(3, "little") + (image.height - 1).to_bytes(3, "little")
    payload = vp8x + vp8l
    path.write_bytes(b"RIFF" + (len(payload) + 4).to_bytes(4, "little") + b"WEBP" + payload)


def process(path: Path) -> dict[str, int]:
    image = Image.open(path).convert("RGBA")
    rgba = np.asarray(image).copy()
    counts = recolor_pixels(rgba)
    output = Image.fromarray(rgba)
    if path.suffix.lower() == ".webp":
        # Lossless keeps the flat canonical palette pixel-exact; lossy webp
        # smears blend tones along the dark contours on every save.
        write_webp_extended_lossless(output, path)
    else:
        output.save(path, "PNG")
    return counts


def main() -> None:
    targets = RUNTIME_STRIPS + RUNTIME_DIRECTIONAL + SOURCE_STRIPS + SOURCE_DIRECTIONAL
    keys = ["blue", "shadow", "outline", "white", "skin", "hair"]
    total = {key: 0 for key in keys}
    for rel in targets:
        path = ROOT / rel
        if not path.exists():
            print(f"skip missing {rel}")
            continue
        counts = process(path)
        for key in keys:
            total[key] += counts[key]
        print(f"{rel}: " + " ".join(f"{k}={counts[k]}" for k in keys))
    print(f"TOTAL " + " ".join(f"{k}={total[k]}" for k in keys))
    if total["blue"] == 0:
        print("WARNING: no blue-family pixels changed; kit recolor may be a no-op", file=sys.stderr)


if __name__ == "__main__":
    main()