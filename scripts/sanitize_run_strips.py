#!/usr/bin/env python3
"""Remove neighboring-frame fragments from generated six-frame run strips.

Image generators can let a wide pose cross a nominal cell boundary. After the
sheet is sliced, that creates a detached horn, hand, shoe or prop in the next
frame. Each delivered run pose is one connected character silhouette, so the
largest alpha component is retained and small detached cross-cell fragments
are removed. A two-pixel dilation keeps the original antialiased edge intact.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter


FRAME_WIDTH = 256
FRAME_HEIGHT = 320
FRAME_COUNT = 6
ALPHA_THRESHOLD = 8


def largest_component_mask(alpha: Image.Image) -> tuple[Image.Image, list[tuple[int, tuple[int, int, int, int]]]]:
    width, height = alpha.size
    pixels = alpha.load()
    visited = bytearray(width * height)
    components: list[tuple[list[tuple[int, int]], tuple[int, int, int, int]]] = []

    for y in range(height):
        for x in range(width):
            offset = y * width + x
            if visited[offset] or pixels[x, y] <= ALPHA_THRESHOLD:
                continue
            visited[offset] = 1
            queue = deque([(x, y)])
            points: list[tuple[int, int]] = []
            left = right = x
            top = bottom = y
            while queue:
                px, py = queue.popleft()
                points.append((px, py))
                left = min(left, px)
                right = max(right, px)
                top = min(top, py)
                bottom = max(bottom, py)
                for ny in range(max(0, py - 1), min(height, py + 2)):
                    for nx in range(max(0, px - 1), min(width, px + 2)):
                        neighbor = ny * width + nx
                        if visited[neighbor] or pixels[nx, ny] <= ALPHA_THRESHOLD:
                            continue
                        visited[neighbor] = 1
                        queue.append((nx, ny))
            components.append((points, (left, top, right + 1, bottom + 1)))

    mask = Image.new('L', alpha.size, 0)
    if not components:
        return mask, []
    components.sort(key=lambda component: len(component[0]), reverse=True)
    mask_pixels = mask.load()
    for x, y in components[0][0]:
        mask_pixels[x, y] = 255
    mask = mask.filter(ImageFilter.MaxFilter(5))
    removed = [(len(points), box) for points, box in components[1:] if len(points) >= 8]
    return mask, removed


def sanitize(path: Path, *, check: bool = False) -> int:
    source = Image.open(path).convert('RGBA')
    expected = (FRAME_WIDTH * FRAME_COUNT, FRAME_HEIGHT)
    if source.size != expected:
        raise ValueError(f'{path}: expected {expected}, got {source.size}')

    output = Image.new('RGBA', source.size, (0, 0, 0, 0))
    removed_total = 0
    for frame_index in range(FRAME_COUNT):
        left = frame_index * FRAME_WIDTH
        frame = source.crop((left, 0, left + FRAME_WIDTH, FRAME_HEIGHT))
        alpha = frame.getchannel('A')
        mask, removed = largest_component_mask(alpha)
        clean_alpha = Image.new('L', alpha.size, 0)
        clean_alpha.paste(alpha, mask=mask)
        frame.putalpha(clean_alpha)
        output.alpha_composite(frame, (left, 0))
        if removed:
            removed_total += len(removed)
            print(f'{path.name} frame {frame_index}: removed {removed}')

    if not check:
        output.save(path, optimize=True)
    return removed_total


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--check',
        action='store_true',
        help='Report detached components without modifying any strip.',
    )
    parser.add_argument('paths', nargs='+', type=Path)
    args = parser.parse_args()
    removed = sum(sanitize(path, check=args.check) for path in args.paths)
    verb = 'Checked' if args.check else 'Sanitized'
    print(f'{verb} {len(args.paths)} strips; found {removed} detached components.')
    if args.check and removed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
