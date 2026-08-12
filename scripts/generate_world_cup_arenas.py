#!/usr/bin/env python3
"""Generate two original, high-resolution World Cup-style arena plates.

The output is deterministic and uses only Pillow primitives. Keeping the turf
and stadium in one source-space plate lets the renderer align gameplay lines,
goals, feet, pickups and shadows to the exact same grass rectangle.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "art-source" / "arena" / "world-cup"
OUTPUT_DIR = ROOT / "public" / "art" / "arena" / "world-cup"
SIZE = (3072, 2048)
GRASS = (390, 322, 2682, 1726)  # x0, y0, x1, y1 in the 3072x2048 plate
TAU = math.pi * 2


def _rng(seed: int) -> random.Random:
    return random.Random(seed)


def _rounded_ring_mask(outer: tuple[int, int, int, int], inner: tuple[int, int, int, int], radius: int) -> Image.Image:
    mask = Image.new("L", SIZE, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(outer, radius=radius, fill=255)
    draw.rounded_rectangle(inner, radius=max(1, radius - 72), fill=0)
    return mask


def _gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        t = y / max(1, height - 1)
        color = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        for x in range(width):
            pixels[x, y] = color
    return image


def _draw_stadium(base: Image.Image, palette: dict[str, tuple[int, int, int]], seed: int) -> None:
    draw = ImageDraw.Draw(base, "RGBA")
    rng = _rng(seed)
    outer = (30, 22, SIZE[0] - 30, SIZE[1] - 22)
    roof_inner = (126, 102, SIZE[0] - 126, SIZE[1] - 102)
    upper_inner = (218, 176, SIZE[0] - 218, SIZE[1] - 176)
    lower_inner = (292, 246, SIZE[0] - 292, SIZE[1] - 246)
    apron = (344, 278, SIZE[0] - 344, SIZE[1] - 278)

    # Roof and concourse shells establish a readable, symmetric stadium bowl.
    draw.rounded_rectangle(outer, radius=330, fill=palette["roof"], outline=(220, 228, 230, 190), width=10)
    for inset, alpha in ((38, 95), (70, 70), (100, 45)):
        draw.rounded_rectangle(
            (outer[0] + inset, outer[1] + inset, outer[2] - inset, outer[3] - inset),
            radius=330 - inset,
            outline=(235, 239, 235, alpha),
            width=6,
        )
    draw.rounded_rectangle(roof_inner, radius=250, fill=palette["concourse"], outline=(16, 28, 40, 220), width=10)

    upper_mask = _rounded_ring_mask(upper_inner, lower_inner, 205)
    seats = Image.new("RGBA", SIZE, palette["seat"] + (255,))
    seat_draw = ImageDraw.Draw(seats, "RGBA")
    # Alternating international-final seat sections; no letters or branding.
    for x in range(upper_inner[0], upper_inner[2], 104):
        seat_draw.rectangle((x, upper_inner[1], x + 48, upper_inner[3]), fill=palette["seat_alt"] + (120,))
    for y in range(upper_inner[1], upper_inner[3], 80):
        seat_draw.rectangle((upper_inner[0], y, upper_inner[2], y + 4), fill=(235, 226, 188, 80))
    base.alpha_composite(Image.composite(seats, Image.new("RGBA", SIZE), upper_mask))

    # Thousands of small spectators provide detail without becoming noisy on pitch.
    crowd = Image.new("RGBA", SIZE)
    crowd_draw = ImageDraw.Draw(crowd, "RGBA")
    crowd_colors = [(240, 230, 203, 205), (205, 56, 67, 220), (46, 118, 194, 220), (244, 183, 52, 220), (230, 230, 232, 200)]
    px = upper_mask.load()
    for _ in range(20_000):
        x = rng.randrange(upper_inner[0], upper_inner[2])
        y = rng.randrange(upper_inner[1], upper_inner[3])
        if px[x, y] < 128:
            continue
        c = rng.choice(crowd_colors)
        crowd_draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=c)
    base.alpha_composite(crowd)

    # A dark lower bowl, access aisles and tunnels add stadium scale.
    draw.rounded_rectangle(lower_inner, radius=138, fill=palette["lower"], outline=(218, 224, 219, 135), width=8)
    for x in range(426, 2647, 190):
        draw.polygon(((x, 250), (x + 26, 250), (x + 44, 321), (x + 4, 321)), fill=(215, 221, 220, 145))
        draw.polygon(((x, 1798), (x + 26, 1798), (x + 44, 1727), (x + 4, 1727)), fill=(215, 221, 220, 145))
    for y in range(398, 1652, 150):
        draw.polygon(((292, y), (344, y + 14), (344, y + 42), (292, y + 28)), fill=(210, 216, 216, 145))
        draw.polygon(((2780, y), (2728, y + 14), (2728, y + 42), (2780, y + 28)), fill=(210, 216, 216, 145))

    # Pitch apron, drainage rails, camera lanes and benches.
    draw.rounded_rectangle(apron, radius=72, fill=palette["apron"], outline=(225, 229, 223, 120), width=5)
    for box in ((1130, 272, 1395, 318), (1677, 272, 1942, 318), (1130, 1730, 1395, 1776), (1677, 1730, 1942, 1776)):
        draw.rounded_rectangle(box, radius=10, fill=(38, 50, 57, 245), outline=(210, 219, 214, 150), width=3)
        for sx in range(box[0] + 15, box[2] - 10, 28):
            draw.rounded_rectangle((sx, box[1] + 11, sx + 17, box[3] - 10), radius=4, fill=palette["bench"] + (255,))
    for box in ((35, 780, 214, 1268), (2858, 780, 3037, 1268)):
        draw.rounded_rectangle(box, radius=18, fill=(16, 22, 30, 255), outline=(210, 217, 214, 110), width=5)

    # Roof trusses and neutral floodlights. Reflections remain outside the turf.
    for x in range(105, 2970, 122):
        draw.line((x, 38, x + 64, 128), fill=(229, 234, 231, 125), width=5)
        draw.ellipse((x + 6, 49, x + 29, 72), fill=(255, 244, 210, 235))
        draw.line((x, 2010, x + 64, 1920), fill=(229, 234, 231, 125), width=5)
        draw.ellipse((x + 6, 1976, x + 29, 1999), fill=(255, 244, 210, 235))


def _grass_texture(style: str, seed: int) -> Image.Image:
    x0, y0, x1, y1 = GRASS
    width, height = x1 - x0, y1 - y0
    rng = _rng(seed)
    if style == "classic":
        dark = (31, 112, 54)
        light = (47, 137, 67)
        band = 146
    else:
        dark = (25, 103, 47)
        light = (52, 139, 69)
        band = 191

    turf = Image.new("RGB", (width, height), dark)
    pixels = turf.load()
    # Per-pixel seeded fibre/noise detail survives camera zoom without a repeated tile.
    for y in range(height):
        for x in range(width):
            stripe = (x // band) % 2
            base = light if stripe == 0 else dark
            fine = ((x * 17 + y * 31 + seed * 13) % 23) - 11
            grain = rng.randrange(-6, 7)
            cross = 3 if ((x + y) // 34) % 2 == 0 else -2
            pixels[x, y] = (
                max(0, min(255, base[0] + grain + fine // 5)),
                max(0, min(255, base[1] + grain + fine // 3 + cross)),
                max(0, min(255, base[2] + grain + fine // 4)),
            )

    draw = ImageDraw.Draw(turf, "RGBA")
    # Micro-blades, clippings and roller sheen create actual ground contact detail.
    for _ in range(75_000):
        x = rng.randrange(width)
        y = rng.randrange(height)
        length = rng.choice((1, 1, 2, 2, 3))
        if rng.random() < 0.58:
            color = (176, 209, 143, rng.randrange(15, 42))
        else:
            color = (3, 41, 18, rng.randrange(12, 36))
        draw.line((x, y, x + rng.choice((-1, 0, 1)), y + length), fill=color, width=1)
    for _ in range(900):
        x = rng.randrange(width)
        y = rng.randrange(height)
        draw.ellipse((x, y, x + rng.randrange(2, 7), y + rng.randrange(1, 4)), fill=(15, 61, 27, rng.randrange(12, 36)))

    # Natural use, never painted markings: subtle compression through central lanes.
    wear = Image.new("RGBA", (width, height))
    wear_draw = ImageDraw.Draw(wear, "RGBA")
    for cx, cy, rx, ry in ((width // 2, height // 2, 330, 180), (210, height // 2, 185, 265), (width - 210, height // 2, 185, 265)):
        for _ in range(300):
            a = rng.random() * TAU
            r = math.sqrt(rng.random())
            x = cx + math.cos(a) * rx * r
            y = cy + math.sin(a) * ry * r
            wear_draw.ellipse((x - 7, y - 3, x + 7, y + 3), fill=(171, 157, 91, rng.randrange(3, 11)))
    wear = wear.filter(ImageFilter.GaussianBlur(2.2))
    turf = Image.alpha_composite(turf.convert("RGBA"), wear)

    # Crisp drainage lip and contact occlusion are part of the same ground plane.
    turf = ImageEnhance.Contrast(turf).enhance(1.08)
    return turf


def build_arena(name: str, style: str, seed: int, palette: dict[str, tuple[int, int, int]]) -> None:
    base = _gradient(SIZE, palette["background_top"], palette["background_bottom"]).convert("RGBA")
    _draw_stadium(base, palette, seed)
    x0, y0, x1, y1 = GRASS
    draw = ImageDraw.Draw(base, "RGBA")
    draw.rectangle((x0 - 18, y0 - 18, x1 + 18, y1 + 18), fill=(8, 20, 18, 245), outline=(205, 214, 207, 150), width=4)
    turf = _grass_texture(style, seed + 101)
    base.alpha_composite(turf, (x0, y0))
    # No pitch markings here: the game draws collision-accurate lines and goals.
    base = base.convert("RGB").filter(ImageFilter.UnsharpMask(radius=0.75, percent=74, threshold=2))
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    source = SOURCE_DIR / f"{name}.png"
    output = OUTPUT_DIR / f"{name}.webp"
    base.save(source, "PNG", optimize=True)
    base.save(output, "WEBP", quality=95, method=6)
    print(f"{name}: {base.width}x{base.height}; grass={GRASS}; {output.relative_to(ROOT)}")


PALETTES = {
    "classic": {
        "background_top": (14, 28, 38), "background_bottom": (10, 22, 31),
        "roof": (68, 79, 82), "concourse": (181, 178, 159), "seat": (17, 71, 113),
        "seat_alt": (224, 180, 54), "lower": (20, 48, 72), "apron": (29, 64, 70),
        "bench": (223, 184, 57),
    },
    "showpiece": {
        "background_top": (8, 21, 33), "background_bottom": (8, 16, 26),
        "roof": (56, 65, 75), "concourse": (137, 151, 157), "seat": (20, 49, 86),
        "seat_alt": (173, 39, 57), "lower": (13, 36, 59), "apron": (19, 50, 62),
        "bench": (193, 48, 64),
    },
}


def main() -> None:
    build_arena("world-cup-classic", "classic", 20260812, PALETTES["classic"])
    build_arena("world-cup-showpiece", "showpiece", 20260813, PALETTES["showpiece"])


if __name__ == "__main__":
    main()
