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


def _composite_ring(
    base: Image.Image,
    outer: tuple[int, int, int, int],
    inner: tuple[int, int, int, int],
    radius: int,
    color: tuple[int, int, int, int],
    seed: int,
    flecks: int = 0,
) -> Image.Image:
    """Return a material ring with subtle non-repeating surface variation."""
    mask = _rounded_ring_mask(outer, inner, radius)
    layer = Image.new("RGBA", SIZE, color)
    if flecks:
        rng = _rng(seed)
        material = ImageDraw.Draw(layer, "RGBA")
        for _ in range(flecks):
            x = rng.randrange(outer[0], outer[2])
            y = rng.randrange(outer[1], outer[3])
            if mask.getpixel((x, y)) < 128:
                continue
            tone = rng.choice(((255, 255, 255, 15), (0, 0, 0, 20), (171, 184, 187, 18)))
            material.line((x, y, x + rng.randrange(-3, 5), y + rng.randrange(1, 7)), fill=tone, width=1)
    ring = Image.composite(layer, Image.new("RGBA", SIZE), mask)
    base.alpha_composite(ring)
    return mask


def _draw_showpiece_stadium(base: Image.Image, palette: dict[str, tuple[int, int, int]], seed: int) -> None:
    """Author a layered, broadcast-grade final stadium without source art.

    The bowl uses separate material and occupancy passes instead of broad flat
    polygons. Every detail stays outside the calibrated turf rectangle.
    """
    rng = _rng(seed)
    draw = ImageDraw.Draw(base, "RGBA")

    # Deep exterior shadow gives the bowl weight against the page background.
    shadow = Image.new("RGBA", SIZE)
    shadow_draw = ImageDraw.Draw(shadow, "RGBA")
    shadow_draw.rounded_rectangle((20, 18, 3052, 2030), radius=322, fill=(0, 0, 0, 205))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    base.alpha_composite(shadow)

    # Six physical depth layers: outer roof, catwalk, upper bowl, glass
    # concourse, lower bowl and pitch apron.
    roof_mask = _composite_ring(
        base, (18, 10, 3054, 2038), (104, 78, 2968, 1970), 320,
        (57, 66, 75, 255), seed + 1, 28_000,
    )
    catwalk_mask = _composite_ring(
        base, (92, 67, 2980, 1981), (156, 120, 2916, 1928), 262,
        (20, 30, 40, 255), seed + 2, 9_000,
    )
    upper_mask = _composite_ring(
        base, (144, 108, 2928, 1940), (231, 184, 2841, 1864), 238,
        (14, 39, 69, 255), seed + 3,
    )
    concourse_mask = _composite_ring(
        base, (220, 174, 2852, 1874), (270, 219, 2802, 1829), 196,
        (103, 119, 126, 255), seed + 4, 15_000,
    )
    lower_mask = _composite_ring(
        base, (259, 208, 2813, 1840), (341, 279, 2731, 1769), 170,
        (11, 34, 61, 255), seed + 5,
    )

    # Individually shaded seats plus tiny occupants. This density remains
    # readable after the game camera crops into a touchline.
    seat_layer = Image.new("RGBA", SIZE)
    seats = ImageDraw.Draw(seat_layer, "RGBA")
    upper_px = upper_mask.load()
    lower_px = lower_mask.load()
    team_colors = [
        (232, 235, 228, 235), (209, 54, 72, 245), (42, 112, 190, 245),
        (244, 184, 48, 245), (51, 156, 111, 235), (220, 109, 48, 235),
    ]
    for y in range(112, 1938, 10):
        row_offset = 5 if (y // 10) % 2 else 0
        for x in range(145 + row_offset, 2927, 12):
            tier = upper_px[x, y] >= 128 or lower_px[x, y] >= 128
            if not tier:
                continue
            # Seat back, front lip and metal mounting point.
            seat_color = (20, 61 + rng.randrange(-6, 9), 102 + rng.randrange(-8, 12), 255)
            seats.rounded_rectangle((x - 4, y - 3, x + 4, y + 4), radius=2, fill=(4, 13, 23, 150))
            seats.rounded_rectangle((x - 4, y - 4, x + 3, y + 2), radius=2, fill=seat_color)
            seats.line((x - 3, y - 3, x + 2, y - 3), fill=(111, 153, 183, 95), width=1)
            if rng.random() < (0.88 if lower_px[x, y] >= 128 else 0.79):
                shirt = rng.choice(team_colors)
                # Torso, shoulders, head and a local contact shadow.
                seats.ellipse((x - 4, y + 1, x + 4, y + 5), fill=(0, 0, 0, 90))
                seats.rounded_rectangle((x - 3, y - 2, x + 3, y + 3), radius=1, fill=shirt)
                skin = rng.choice(((236, 192, 151, 255), (190, 134, 94, 255), (116, 77, 54, 255), (244, 211, 175, 255)))
                seats.ellipse((x - 2, y - 6, x + 2, y - 2), fill=skin)
                if rng.random() < 0.065:
                    seats.line((x - 5, y - 3, x - 8, y - 7), fill=shirt, width=2)
                    seats.line((x + 5, y - 3, x + 8, y - 7), fill=shirt, width=2)
    base.alpha_composite(seat_layer)

    draw = ImageDraw.Draw(base, "RGBA")

    # Section aisles, stair nosings and guard rails carve convincing access
    # structure through both tiers.
    for x in range(280, 2840, 184):
        draw.polygon(((x, 108), (x + 23, 108), (x + 37, 278), (x - 11, 278)), fill=(177, 187, 187, 170))
        draw.polygon(((x, 1940), (x + 23, 1940), (x + 37, 1770), (x - 11, 1770)), fill=(177, 187, 187, 170))
        for sy in range(116, 272, 13):
            draw.line((x, sy, x + 26, sy), fill=(235, 238, 232, 105), width=2)
            draw.line((x, 2048 - sy, x + 26, 2048 - sy), fill=(235, 238, 232, 105), width=2)
    for y in range(330, 1740, 142):
        draw.polygon(((144, y), (270, y + 18), (270, y + 43), (144, y + 29)), fill=(177, 187, 187, 165))
        draw.polygon(((2928, y), (2802, y + 18), (2802, y + 43), (2928, y + 29)), fill=(177, 187, 187, 165))

    # Executive glass boxes and hospitality lights sit between the tiers.
    for side_y, flip in ((174, 1), (1874, -1)):
        for x in range(420, 2670, 132):
            y0 = side_y if flip > 0 else side_y - 38
            y1 = y0 + 38
            draw.rounded_rectangle((x, y0, x + 104, y1), radius=5, fill=(7, 19, 31, 245), outline=(179, 202, 213, 170), width=2)
            glass = draw.rounded_rectangle((x + 6, y0 + 6, x + 98, y1 - 7), radius=3, fill=(30, 73, 94, 220))
            draw.line((x + 12, y0 + 8, x + 46, y1 - 9), fill=(156, 209, 224, 80), width=2)
            for lamp_x in range(x + 13, x + 95, 18):
                draw.ellipse((lamp_x, y0 + 4, lamp_x + 5, y0 + 9), fill=(255, 232, 171, 230))

    # Repeating roof ribs, tension cables, maintenance catwalks and floodlights.
    for x in range(78, 3000, 76):
        draw.line((x, 16, x + 54, 106), fill=(221, 230, 229, 155), width=5)
        draw.line((x + 9, 21, x + 63, 111), fill=(12, 22, 29, 155), width=2)
        draw.line((x, 2032, x + 54, 1942), fill=(221, 230, 229, 155), width=5)
        draw.line((x + 9, 2027, x + 63, 1937), fill=(12, 22, 29, 155), width=2)
    for x in range(111, 2970, 98):
        draw.ellipse((x, 55, x + 23, 78), fill=(255, 246, 217, 245), outline=(255, 255, 255, 180), width=2)
        draw.ellipse((x, 1970, x + 23, 1993), fill=(255, 246, 217, 245), outline=(255, 255, 255, 180), width=2)
    for y in range(154, 1900, 92):
        draw.line((23, y, 111, y + 42), fill=(219, 229, 229, 135), width=4)
        draw.line((3049, y, 2961, y + 42), fill=(219, 229, 229, 135), width=4)

    # Distributed speaker arrays and match-control displays add recognisable
    # tournament infrastructure without using copied brands, crests or text.
    for x in range(310, 2810, 250):
        for y, flip in ((88, 1), (1960, -1)):
            draw.rounded_rectangle((x, y - 10, x + 42, y + 13), radius=4, fill=(6, 11, 16, 255), outline=(113, 127, 132, 155), width=2)
            for driver_x in (x + 10, x + 31):
                draw.ellipse((driver_x - 6, y - 5, driver_x + 6, y + 7), fill=(20, 25, 29, 255), outline=(148, 157, 158, 110), width=1)
                draw.ellipse((driver_x - 2, y - 1, driver_x + 2, y + 3), fill=(2, 5, 8, 255))
            draw.line((x + 21, y + 13 * flip, x + 21, y + 27 * flip), fill=(141, 151, 153, 170), width=3)
    for x0, y0 in ((1110, 128), (1780, 128), (1110, 1876), (1780, 1876)):
        draw.rounded_rectangle((x0, y0, x0 + 178, y0 + 48), radius=7, fill=(3, 10, 17, 255), outline=(153, 175, 182, 185), width=3)
        draw.rectangle((x0 + 9, y0 + 9, x0 + 169, y0 + 39), fill=(9, 32, 48, 255))
        draw.rectangle((x0 + 16, y0 + 15, x0 + 66, y0 + 33), fill=(187, 38, 57, 225))
        draw.rectangle((x0 + 112, y0 + 15, x0 + 162, y0 + 33), fill=(37, 107, 170, 225))
        draw.ellipse((x0 + 80, y0 + 13, x0 + 98, y0 + 35), outline=(235, 218, 139, 190), width=3)

    # Pitch apron with slabs, drainage channels and a segmented abstract LED
    # perimeter. No words, sponsors or tournament marks are baked in.
    draw.rounded_rectangle((320, 255, 2752, 1793), radius=98, fill=(20, 35, 43, 255), outline=(163, 178, 180, 160), width=5)
    for x in range(328, 2748, 34):
        draw.line((x, 258, x, 321), fill=(86, 105, 108, 75), width=1)
        draw.line((x, 1727, x, 1790), fill=(86, 105, 108, 75), width=1)
    for y in range(265, 1790, 32):
        draw.line((322, y, 389, y), fill=(86, 105, 108, 70), width=1)
        draw.line((2683, y, 2750, y), fill=(86, 105, 108, 70), width=1)
    # Inner curb and open drainage grate immediately outside the turf.
    draw.rectangle((372, 304, 2700, 321), fill=(5, 15, 20, 250))
    draw.rectangle((372, 1727, 2700, 1744), fill=(5, 15, 20, 250))
    draw.rectangle((372, 304, 389, 1744), fill=(5, 15, 20, 250))
    draw.rectangle((2683, 304, 2700, 1744), fill=(5, 15, 20, 250))
    for x in range(378, 2697, 11):
        draw.line((x, 306, x, 319), fill=(111, 129, 130, 125), width=2)
        draw.line((x, 1729, x, 1742), fill=(111, 129, 130, 125), width=2)
    for y in range(310, 1741, 11):
        draw.line((374, y, 387, y), fill=(111, 129, 130, 125), width=2)
        draw.line((2685, y, 2698, y), fill=(111, 129, 130, 125), width=2)

    led_colors = ((190, 32, 53, 255), (219, 163, 41, 255), (33, 105, 151, 255), (232, 231, 217, 255))
    for x in range(398, 2670, 74):
        color = led_colors[(x // 74) % len(led_colors)]
        draw.rounded_rectangle((x, 286, x + 60, 301), radius=3, fill=(5, 13, 20, 255), outline=(114, 132, 137, 140), width=1)
        draw.rectangle((x + 4, 290, x + 56, 297), fill=color)
        draw.rounded_rectangle((x, 1747, x + 60, 1762), radius=3, fill=(5, 13, 20, 255), outline=(114, 132, 137, 140), width=1)
        draw.rectangle((x + 4, 1751, x + 56, 1758), fill=color)
    for y in range(341, 1708, 68):
        color = led_colors[(y // 68) % len(led_colors)]
        draw.rounded_rectangle((349, y, 366, y + 54), radius=3, fill=(5, 13, 20, 255))
        draw.rectangle((354, y + 4, 361, y + 50), fill=color)
        draw.rounded_rectangle((2706, y, 2723, y + 54), radius=3, fill=(5, 13, 20, 255))
        draw.rectangle((2711, y + 4, 2718, y + 50), fill=color)

    # Player tunnels have visible depth, guide lights and floor ramps.
    tunnel_specs = (
        (1394, 213, 1678, 321), (1394, 1727, 1678, 1835),
        (259, 878, 389, 1170), (2683, 878, 2813, 1170),
    )
    for tx0, ty0, tx1, ty1 in tunnel_specs:
        draw.rounded_rectangle((tx0, ty0, tx1, ty1), radius=14, fill=(2, 7, 12, 255), outline=(150, 165, 165, 185), width=4)
        inset = 10
        draw.rounded_rectangle((tx0 + inset, ty0 + inset, tx1 - inset, ty1 - inset), radius=10, fill=(10, 20, 28, 255))
        center_x = (tx0 + tx1) // 2
        center_y = (ty0 + ty1) // 2
        if tx1 - tx0 > ty1 - ty0:
            draw.polygon(((tx0 + 14, ty1 - 15), (tx1 - 14, ty1 - 15), (center_x + 54, center_y), (center_x - 54, center_y)), fill=(25, 34, 40, 230))
            for rail_y in (ty0 + 17, ty1 - 18):
                draw.line((tx0 + 18, rail_y, center_x - 45, center_y), fill=(121, 137, 141, 145), width=2)
                draw.line((tx1 - 18, rail_y, center_x + 45, center_y), fill=(121, 137, 141, 145), width=2)
        else:
            draw.polygon(((tx0 + 14, ty0 + 14), (tx0 + 14, ty1 - 14), (center_x, center_y + 54), (center_x, center_y - 54)), fill=(25, 34, 40, 230))
            for rail_x in (tx0 + 17, tx1 - 18):
                draw.line((rail_x, ty0 + 18, center_x, center_y - 45), fill=(121, 137, 141, 145), width=2)
                draw.line((rail_x, ty1 - 18, center_x, center_y + 45), fill=(121, 137, 141, 145), width=2)
        for n in range(4):
            px = tx0 + 26 + n * max(14, (tx1 - tx0 - 52) // 4)
            py = ty0 + 25 + n * max(14, (ty1 - ty0 - 50) // 4)
            if tx1 - tx0 > ty1 - ty0:
                draw.ellipse((px, (ty0 + ty1) // 2 - 3, px + 7, (ty0 + ty1) // 2 + 4), fill=(227, 61, 71, 220))
            else:
                draw.ellipse(((tx0 + tx1) // 2 - 3, py, (tx0 + tx1) // 2 + 4, py + 7), fill=(227, 61, 71, 220))

    # Transparent dugouts, shaped seats, coolers, ball racks, broadcast
    # cameras and cable coils make touchline close-ups hold up.
    for y0, inward in ((252, 1), (1760, -1)):
        for x0 in (850, 1782):
            y1 = y0 + 56 * inward
            top, bottom = sorted((y0, y1))
            draw.rounded_rectangle((x0, top, x0 + 388, bottom), radius=15, fill=(18, 45, 56, 230), outline=(183, 217, 223, 190), width=3)
            draw.line((x0 + 16, top + 9, x0 + 372, top + 9), fill=(202, 235, 239, 110), width=2)
            seat_y = top + 20
            for sx in range(x0 + 20, x0 + 370, 29):
                draw.rounded_rectangle((sx, seat_y, sx + 18, seat_y + 25), radius=5, fill=(184, 38, 59, 255), outline=(238, 93, 105, 120), width=1)
                draw.ellipse((sx + 4, seat_y + 18, sx + 14, seat_y + 28), fill=(8, 16, 21, 125))

    # Cameras are explicit multi-part silhouettes with tripod legs.
    camera_positions = [(520, 300), (692, 300), (2370, 300), (2542, 300), (520, 1748), (692, 1748), (2370, 1748), (2542, 1748)]
    for cx, cy in camera_positions:
        draw.ellipse((cx - 7, cy + 7, cx + 7, cy + 15), fill=(0, 0, 0, 105))
        draw.rounded_rectangle((cx - 9, cy - 4, cx + 10, cy + 8), radius=3, fill=(18, 23, 28, 255), outline=(116, 126, 129, 150), width=1)
        draw.rectangle((cx + 8, cy - 1, cx + 20, cy + 5), fill=(7, 12, 16, 255))
        draw.line((cx, cy + 8, cx - 9, cy + 21), fill=(28, 32, 35, 230), width=2)
        draw.line((cx, cy + 8, cx + 9, cy + 21), fill=(28, 32, 35, 230), width=2)
        draw.line((cx, cy + 8, cx, cy + 22), fill=(28, 32, 35, 230), width=2)

    for x, y in ((780, 304), (2275, 304), (780, 1744), (2275, 1744)):
        draw.rounded_rectangle((x, y, x + 24, y + 28), radius=4, fill=(220, 226, 218, 255), outline=(72, 91, 96, 200), width=2)
        draw.rectangle((x + 5, y + 7, x + 19, y + 13), fill=(40, 132, 170, 220))
    # Match-ball cradles are small but fully modelled: rail, shadow and six
    # panelled balls per rack, all kept outside the playable grass.
    for x, y in ((805, 293), (2206, 293), (805, 1729), (2206, 1729)):
        draw.rounded_rectangle((x - 6, y + 8, x + 74, y + 29), radius=5, fill=(1, 5, 8, 120))
        draw.line((x, y + 8, x + 68, y + 8), fill=(139, 151, 153, 210), width=3)
        draw.line((x + 4, y + 8, x + 4, y + 27), fill=(139, 151, 153, 185), width=2)
        draw.line((x + 64, y + 8, x + 64, y + 27), fill=(139, 151, 153, 185), width=2)
        for ball_index in range(6):
            bx = x + 7 + ball_index * 11
            draw.ellipse((bx - 5, y - 1, bx + 5, y + 9), fill=(230, 231, 220, 255), outline=(33, 42, 45, 210), width=1)
            draw.polygon(((bx, y + 1), (bx + 3, y + 3), (bx + 2, y + 6), (bx - 2, y + 6), (bx - 3, y + 3)), fill=(37, 46, 48, 210))
    for x, y in ((450, 309), (2622, 309), (450, 1739), (2622, 1739)):
        for ring in range(4):
            draw.ellipse((x - ring * 2, y - ring * 2, x + 18 + ring * 2, y + 10 + ring * 2), outline=(11, 16, 19, 180), width=2)

    # Inner-tier safety rails and glass partitions break the last broad edges
    # into believable stadium construction modules.
    for y in (245, 281, 1767, 1803):
        draw.line((398, y, 2674, y), fill=(195, 211, 210, 175), width=3)
        for x in range(405, 2670, 42):
            draw.line((x, y - 8, x, y + 8), fill=(189, 204, 204, 150), width=2)
    for x in (328, 370, 2702, 2744):
        draw.line((x, 337, x, 1711), fill=(195, 211, 210, 175), width=3)
        for y in range(344, 1708, 42):
            draw.line((x - 8, y, x + 8, y), fill=(189, 204, 204, 150), width=2)

    # Four articulated broadcast jibs add recognizable matchday machinery.
    for pivot_x, pivot_y, arm_x, arm_y in (
        (1010, 297, 900, 274), (2062, 297, 2172, 274),
        (1010, 1751, 900, 1774), (2062, 1751, 2172, 1774),
    ):
        draw.ellipse((pivot_x - 13, pivot_y - 7, pivot_x + 13, pivot_y + 11), fill=(0, 0, 0, 100))
        draw.ellipse((pivot_x - 9, pivot_y - 9, pivot_x + 9, pivot_y + 9), fill=(37, 43, 47, 255), outline=(142, 151, 151, 170), width=2)
        draw.line((pivot_x, pivot_y, arm_x, arm_y), fill=(18, 23, 27, 255), width=6)
        draw.line((pivot_x, pivot_y - 2, arm_x, arm_y - 2), fill=(122, 132, 134, 130), width=2)
        draw.rounded_rectangle((arm_x - 12, arm_y - 7, arm_x + 12, arm_y + 7), radius=3, fill=(7, 12, 16, 255), outline=(138, 147, 147, 140), width=1)
        draw.rectangle((arm_x - 17, arm_y - 3, arm_x - 10, arm_y + 3), fill=(25, 31, 34, 255))

    # Stewards and camera operators remain behind the perimeter boards. Their
    # asymmetry makes the technical area feel staffed without entering play.
    staff_positions = [
        (430, 298, 1), (612, 298, -1), (1465, 298, 1), (1640, 298, -1), (2454, 298, 1),
        (430, 1750, -1), (612, 1750, 1), (1465, 1750, -1), (1640, 1750, 1), (2454, 1750, -1),
    ]
    for x, y, facing in staff_positions:
        draw.ellipse((x - 5, y - 16, x + 5, y - 6), fill=(188, 135, 94, 255))
        draw.rounded_rectangle((x - 7, y - 7, x + 7, y + 12), radius=3, fill=(213, 225, 56, 255), outline=(32, 42, 43, 170), width=1)
        draw.rectangle((x - 5, y - 2, x + 5, y + 2), fill=(48, 55, 58, 230))
        draw.line((x - 4, y + 11, x - 6, y + 23), fill=(24, 29, 31, 230), width=3)
        draw.line((x + 4, y + 11, x + 6, y + 23), fill=(24, 29, 31, 230), width=3)
        draw.line((x + facing * 6, y - 2, x + facing * 12, y + 5), fill=(188, 135, 94, 230), width=2)

    # Restrained highlights increase material separation without throwing a
    # fake spotlight across the gameplay grass.
    edge_glow = Image.new("RGBA", SIZE)
    glow_draw = ImageDraw.Draw(edge_glow, "RGBA")
    glow_draw.rounded_rectangle((300, 238, 2772, 1810), radius=112, outline=(198, 228, 229, 95), width=7)
    edge_glow = edge_glow.filter(ImageFilter.GaussianBlur(5))
    base.alpha_composite(edge_glow)

    # Contact shadows from the tier overhangs finally separate the vertical
    # bowl from the horizontal apron. They stop before the calibrated turf.
    overhang = Image.new("RGBA", SIZE)
    overhang_draw = ImageDraw.Draw(overhang, "RGBA")
    overhang_draw.rounded_rectangle((209, 164, 2863, 1884), radius=204, outline=(0, 0, 0, 205), width=42)
    overhang_draw.rounded_rectangle((305, 242, 2767, 1806), radius=116, outline=(0, 0, 0, 185), width=26)
    overhang = overhang.filter(ImageFilter.GaussianBlur(13))
    base.alpha_composite(overhang)

    # Material lighting is masked to stadium surfaces. Directional highlights,
    # roof pools and a restrained vignette create depth without touching turf.
    lighting = Image.new("RGBA", SIZE)
    light_draw = ImageDraw.Draw(lighting, "RGBA")
    for cx, cy, radius, alpha in (
        (340, 158, 230, 38), (2732, 158, 230, 38),
        (340, 1890, 230, 30), (2732, 1890, 230, 30),
        (1536, 54, 410, 24), (1536, 1994, 410, 22),
    ):
        glow = Image.new("L", SIZE, 0)
        glow_draw = ImageDraw.Draw(glow)
        glow_draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=alpha)
        glow = glow.filter(ImageFilter.GaussianBlur(radius // 3))
        pool = Image.new("RGBA", SIZE, (255, 236, 191, 0))
        pool.putalpha(glow)
        lighting = Image.alpha_composite(lighting, pool)
    # Dark outer corners keep the field-facing structures visually forward.
    vignette = Image.new("L", SIZE, 0)
    vignette_draw = ImageDraw.Draw(vignette)
    vignette_draw.rounded_rectangle((5, 3, 3067, 2045), radius=336, outline=80, width=118)
    vignette = vignette.filter(ImageFilter.GaussianBlur(45))
    dark = Image.new("RGBA", SIZE, (0, 6, 13, 0))
    dark.putalpha(vignette)
    lighting = Image.alpha_composite(lighting, dark)
    base.alpha_composite(lighting)

    # Small paper flags, hand banners and phone flashes make the authored
    # crowd less uniformly dotted while remaining fully fictional and textless.
    detail_draw = ImageDraw.Draw(base, "RGBA")
    for _ in range(620):
        side = rng.randrange(4)
        if side < 2:
            x = rng.randrange(170, 2902)
            y = rng.randrange(86, 279) if side == 0 else rng.randrange(1769, 1962)
        else:
            x = rng.randrange(104, 341) if side == 2 else rng.randrange(2731, 2968)
            y = rng.randrange(244, 1805)
        if upper_px[x, y] < 128 and lower_px[x, y] < 128:
            continue
        flag = rng.choice(((221, 47, 68, 210), (39, 115, 192, 210), (242, 186, 46, 210), (235, 236, 230, 210)))
        if rng.random() < 0.72:
            detail_draw.line((x, y, x, y - 11), fill=(220, 221, 210, 165), width=1)
            detail_draw.polygon(((x, y - 11), (x + 11, y - 8), (x, y - 4)), fill=flag)
        else:
            detail_draw.rectangle((x - 6, y - 4, x + 7, y + 4), fill=flag, outline=(240, 241, 233, 90), width=1)
    for _ in range(190):
        side = rng.randrange(4)
        if side < 2:
            x = rng.randrange(170, 2902)
            y = rng.randrange(88, 278) if side == 0 else rng.randrange(1770, 1960)
        else:
            x = rng.randrange(105, 338) if side == 2 else rng.randrange(2734, 2967)
            y = rng.randrange(245, 1802)
        if upper_px[x, y] >= 128 or lower_px[x, y] >= 128:
            detail_draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(255, 249, 220, rng.randrange(150, 235)))


def _grass_texture(style: str, seed: int) -> Image.Image:
    x0, y0, x1, y1 = GRASS
    width, height = x1 - x0, y1 - y0
    rng = _rng(seed)
    if style == "classic":
        dark = (31, 112, 54)
        light = (47, 137, 67)
        band = 146
    else:
        # Measured from the approved olive broadcast-pitch reference. The
        # red/blue balance is intentionally warmer and less neon than generic
        # game grass; 112px runtime-source bands reproduce its tighter cadence.
        dark = (93, 108, 42)
        light = (119, 135, 57)
        band = 112

    is_showpiece = style == "showpiece"
    turf = Image.new("RGB", (width, height), dark)
    pixels = turf.load()
    # Per-pixel seeded fibre/noise detail survives camera zoom without a repeated tile.
    for y in range(height):
        for x in range(width):
            stripe_index = x // band
            stripe = stripe_index % 2
            base = light if stripe == 0 else dark
            if is_showpiece:
                # Real mower turns do not form single-pixel digital seams. A
                # narrow five-pixel transition keeps the measured cadence but
                # lets adjacent blade directions feather into one another.
                position = x % band
                edge_distance = min(position, band - 1 - position)
                if edge_distance < 5:
                    edge_mix = (edge_distance + 1) / 6
                    midpoint = tuple((dark[channel] + light[channel]) / 2 for channel in range(3))
                    base = tuple(round(midpoint[channel] * (1 - edge_mix) + base[channel] * edge_mix) for channel in range(3))
                roller_nap = round(math.sin(position / band * math.pi) * (1 if stripe == 0 else -1))
                base = (base[0] + roller_nap, base[1] + roller_nap, base[2])
            fine = ((x * 17 + y * 31 + seed * 13) % 23) - 11
            grain = rng.randrange(-6, 7)
            if is_showpiece:
                cross = 2 if ((x + y) // 34) % 2 == 0 else -1
            else:
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
            color = (184, 199, 109, rng.randrange(13, 36)) if is_showpiece else (176, 209, 143, rng.randrange(15, 42))
        else:
            color = (44, 58, 17, rng.randrange(11, 31)) if is_showpiece else (3, 41, 18, rng.randrange(12, 36))
        draw.line((x, y, x + rng.choice((-1, 0, 1)), y + length), fill=color, width=1)
    for _ in range(900):
        x = rng.randrange(width)
        y = rng.randrange(height)
        clipping = (57, 69, 25, rng.randrange(10, 31)) if is_showpiece else (15, 61, 27, rng.randrange(12, 36))
        draw.ellipse((x, y, x + rng.randrange(2, 7), y + rng.randrange(1, 4)), fill=clipping)

    # Natural use, never painted markings: subtle compression through central lanes.
    wear = Image.new("RGBA", (width, height))
    wear_draw = ImageDraw.Draw(wear, "RGBA")
    for cx, cy, rx, ry in ((width // 2, height // 2, 330, 180), (210, height // 2, 185, 265), (width - 210, height // 2, 185, 265)):
        for _ in range(300):
            a = rng.random() * TAU
            r = math.sqrt(rng.random())
            x = cx + math.cos(a) * rx * r
            y = cy + math.sin(a) * ry * r
            wear_color = (156, 143, 73, rng.randrange(3, 10)) if is_showpiece else (171, 157, 91, rng.randrange(3, 11))
            wear_draw.ellipse((x - 7, y - 3, x + 7, y + 3), fill=wear_color)
    wear = wear.filter(ImageFilter.GaussianBlur(2.2))
    turf = Image.alpha_composite(turf.convert("RGBA"), wear)

    if is_showpiece:
        # Broadcast-pitch finish: multiple independent spatial frequencies
        # avoid the single-noise-layer look of a procedural texture.
        detail = Image.new("RGBA", (width, height))
        detail_draw = ImageDraw.Draw(detail, "RGBA")
        # Fine roller nap follows the mowing direction inside every band.
        for stripe_x in range(0, width, band):
            direction = 1 if (stripe_x // band) % 2 == 0 else -1
            for x in range(stripe_x + 5, min(width, stripe_x + band), 11):
                detail_draw.line(
                    (x, 0, x + direction * 19, height),
                    fill=(210, 219, 142, 6),
                    width=1,
                )
        # Groundskeeper seams, dew flecks and clipped blade clusters.
        for y in range(0, height, 87):
            detail_draw.line((0, y, width, y + 9), fill=(227, 231, 170, 6), width=1)
        for _ in range(145_000):
            x = rng.randrange(width)
            y = rng.randrange(height)
            if rng.random() < 0.72:
                c = (218, 226, 148, rng.randrange(6, 21))
            else:
                c = (44, 57, 16, rng.randrange(7, 23))
            length = rng.choice((1, 1, 2, 2, 3, 4))
            detail_draw.line((x, y, x + rng.choice((-1, 0, 1)), y + length), fill=c, width=1)
        for _ in range(3_800):
            x = rng.randrange(width)
            y = rng.randrange(height)
            detail_draw.ellipse((x - 1, y - 1, x + 2, y + 1), fill=(231, 231, 170, rng.randrange(7, 20)))

        # Physical divots and repaired plugs remain subtle enough not to read
        # as pickups or combat marks.
        for _ in range(1_100):
            x = rng.randrange(14, width - 14)
            y = rng.randrange(12, height - 12)
            rx = rng.randrange(2, 7)
            ry = rng.randrange(1, 4)
            detail_draw.ellipse((x - rx, y - ry, x + rx, y + ry), fill=(53, 64, 21, rng.randrange(9, 27)))
            detail_draw.arc((x - rx - 1, y - ry - 1, x + rx + 2, y + ry + 2), 195, 350, fill=(183, 193, 105, 26), width=1)
        turf = Image.alpha_composite(turf, detail)

        # Broad, almost invisible natural luminance drift prevents a perfectly
        # flat digital fill while preserving exact gameplay readability.
        drift = Image.new("L", (width, height), 0)
        drift_pixels = drift.load()
        for y in range(height):
            for x in range(width):
                wave = math.sin(x / 137.0) + math.cos(y / 93.0) + math.sin((x + y) / 211.0)
                drift_pixels[x, y] = max(0, min(255, int(128 + wave * 10)))
        drift = drift.filter(ImageFilter.GaussianBlur(42))
        cool = Image.new("RGBA", (width, height), (72, 79, 24, 0))
        cool.putalpha(drift.point(lambda v: max(0, min(15, abs(v - 128)))))
        turf = Image.alpha_composite(turf, cool)

    # Crisp drainage lip and contact occlusion are part of the same ground plane.
    # Keep the legacy 1.08 expression untouched for deterministic Classic output.
    if is_showpiece:
        turf = ImageEnhance.Contrast(turf).enhance(1.035)
    else:
        turf = ImageEnhance.Contrast(turf).enhance(1.08)
    return turf


def build_arena(name: str, style: str, seed: int, palette: dict[str, tuple[int, int, int]]) -> None:
    base = _gradient(SIZE, palette["background_top"], palette["background_bottom"]).convert("RGBA")
    if style == "showpiece":
        _draw_showpiece_stadium(base, palette, seed)
    else:
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
