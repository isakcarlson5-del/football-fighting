import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const FRAME_WIDTH = 256;
const FRAME_HEIGHT = 320;
const FRAME_COUNT = 12;
const DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

const inputDir = resolve(process.argv[2] ?? 'public/art/players/directional-v2/messi');
const outputDir = resolve(process.argv[3] ?? 'work/goal-all-directions/messi-clean-preview');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function colorAt(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

function isSkin(r, g, b) {
  return r > 125 && r > g * 1.07 && g > b * 1.08 && r - b > 38;
}

function isKitBlue(r, g, b) {
  return b > 90 && b > r * 1.08 && b > g * 1.02;
}

function isDarkNeutral(r, g, b) {
  const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
  return luma < 132 && Math.max(r, g, b) - Math.min(r, g, b) < 74;
}

function buildComponents(candidate, width, height) {
  const visited = new Uint8Array(width * height);
  const components = [];
  const queueX = new Int16Array(width * height);
  const queueY = new Int16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!candidate[start] || visited[start]) continue;
      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail++] = y;
      visited[start] = 1;
      const pixels = [];
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let sumX = 0;
      let sumY = 0;
      while (head < tail) {
        const px = queueX[head];
        const py = queueY[head++];
        pixels.push(py * width + px);
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        sumX += px;
        sumY += py;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = px + ox;
            const ny = py + oy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const index = ny * width + nx;
            if (!candidate[index] || visited[index]) continue;
            visited[index] = 1;
            queueX[tail] = nx;
            queueY[tail++] = ny;
          }
        }
      }
      components.push({
        pixels,
        minX,
        maxX,
        minY,
        maxY,
        centerX: sumX / pixels.length,
        centerY: sumY / pixels.length,
      });
    }
  }
  return components;
}

function repairFrame(data, sheetWidth, frameIndex, direction) {
  // The authored north-facing strip already contains clean white shorts and
  // is the visual reference for the repair. Preserve it byte-for-pixel.
  if (direction === 'n') return { changed: false, coreCount: 0, changedPixels: 0 };
  const frameX = frameIndex * FRAME_WIDTH;
  const candidate = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  for (let y = 178; y <= 252; y++) {
    for (let x = 34; x <= 221; x++) {
      const [r, g, b, a] = colorAt(data, sheetWidth, frameX + x, y);
      if (a > 28 && !isSkin(r, g, b) && !isKitBlue(r, g, b) && isDarkNeutral(r, g, b)) {
        candidate[y * FRAME_WIDTH + x] = 1;
      }
    }
  }

  const components = buildComponents(candidate, FRAME_WIDTH, FRAME_HEIGHT)
    .filter((component) => (
      component.pixels.length >= 46
      && component.maxY >= 198
      && component.minY <= 232
      && component.centerX >= 45
      && component.centerX <= 211
      && component.minY < 246
    ));

  const core = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  for (const component of components) {
    for (const index of component.pixels) core[index] = 1;
  }
  const coreCount = core.reduce((sum, value) => sum + value, 0);
  // White source shorts contain only small dark seams. Leave those clean
  // authored frames untouched; only original black-short frames need repair.
  if (coreCount < 260) return { changed: false, coreCount, changedPixels: 0 };

  const expanded = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  const radius = 8;
  for (let y = 178; y <= 252; y++) {
    for (let x = 34; x <= 221; x++) {
      let nearCore = false;
      for (let oy = -radius; oy <= radius && !nearCore; oy++) {
        const ny = y + oy;
        if (ny < 0 || ny >= FRAME_HEIGHT) continue;
        const maxOx = Math.floor(Math.sqrt(radius * radius - oy * oy));
        for (let ox = -maxOx; ox <= maxOx; ox++) {
          const nx = x + ox;
          if (nx >= 0 && nx < FRAME_WIDTH && core[ny * FRAME_WIDTH + nx]) {
            nearCore = true;
            break;
          }
        }
      }
      if (!nearCore) continue;
      const [r, g, b, a] = colorAt(data, sheetWidth, frameX + x, y);
      if (a <= 28 || isSkin(r, g, b) || isKitBlue(r, g, b)) continue;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (spread < 86 || luma < 105) expanded[y * FRAME_WIDTH + x] = 1;
    }
  }

  let minY = FRAME_HEIGHT;
  let maxY = 0;
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      if (!expanded[y * FRAME_WIDTH + x]) continue;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  let changedPixels = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const local = y * FRAME_WIDTH + x;
      if (!expanded[local]) continue;
      const sheetOffset = (y * sheetWidth + frameX + x) * 4;
      let transparentEdge = false;
      let maskEdge = false;
      for (let oy = -1; oy <= 1 && !transparentEdge; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || nx >= FRAME_WIDTH || ny < 0 || ny >= FRAME_HEIGHT) {
            transparentEdge = true;
            break;
          }
          const neighborAlpha = data[(ny * sheetWidth + frameX + nx) * 4 + 3];
          if (neighborAlpha < 20) {
            transparentEdge = true;
            break;
          }
          if (!expanded[ny * FRAME_WIDTH + nx]) maskEdge = true;
        }
      }
      const originalLuma = data[sheetOffset] * 0.2126 + data[sheetOffset + 1] * 0.7152 + data[sheetOffset + 2] * 0.0722;
      if (transparentEdge || (maskEdge && originalLuma < 150)) {
        data[sheetOffset] = 55;
        data[sheetOffset + 1] = 62;
        data[sheetOffset + 2] = 70;
      } else {
        const vertical = (y - minY) / Math.max(1, maxY - minY);
        const fold = clamp((originalLuma - 30) / 110, 0, 1);
        const shade = Math.round(clamp(244 - vertical * 24 + fold * 8, 208, 250));
        data[sheetOffset] = shade;
        data[sheetOffset + 1] = Math.min(252, shade + 2);
        data[sheetOffset + 2] = Math.min(255, shade + 6);
      }
      changedPixels++;
    }
  }
  return { changed: true, coreCount, changedPixels };
}

async function repairStrip(direction) {
  const source = join(inputDir, `${direction}.webp`);
  const image = await loadImage(source);
  if (image.width !== FRAME_WIDTH * FRAME_COUNT || image.height !== FRAME_HEIGHT) {
    throw new Error(`${basename(source)} must be ${FRAME_WIDTH * FRAME_COUNT}x${FRAME_HEIGHT}`);
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, image.width, image.height);
  const frames = [];
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    frames.push(repairFrame(imageData.data, image.width, frame, direction));
  }
  context.putImageData(imageData, 0, 0);
  await mkdir(outputDir, { recursive: true });
  const destination = join(outputDir, `${direction}.webp`);
  const output = canvas.toBuffer('image/webp', 92);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(destination, output));
  return { direction, destination, frames };
}

const results = [];
for (const direction of DIRECTIONS) results.push(await repairStrip(direction));
console.log(JSON.stringify({ inputDir, outputDir, results }, null, 2));
