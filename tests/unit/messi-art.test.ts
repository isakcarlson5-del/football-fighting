// @ts-nocheck
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
const SCRATCH = resolve('work/qa/messi-art-check');
mkdirSync(SCRATCH, { recursive: true });

function pngRgba(path: string): { width: number; height: number; data: Buffer } {
  const bytes = readFileSync(path);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const data = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const row = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + up) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upperLeft)) & 255;
    }
    row.copy(data, y * stride);
    previous = row;
  }
  return { width, height, data };
}

function webpRgba(path: string): { width: number; height: number; data: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'ff-messi-'));
  const png = join(dir, 'sheet.png');
  execFileSync('dwebp', [path, '-o', png], { stdio: 'pipe' });
  return pngRgba(png);
}

function chromaCount(img: { width: number; height: number; data: Buffer }): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    const a = img.data[i + 3];
    if (a > 20 && g > 90 && g > r * 1.25 && g > b * 1.15 && g - Math.max(r, b) > 18) n++;
  }
  return n;
}

function skinWarmth(img: { data: Buffer }): number {
  let acc = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    const a = img.data[i + 3];
    if (a > 80 && r > 125 && r > g * 1.04 && g > b && r - b > 28) {
      acc += r - b;
      n++;
    }
  }
  return n ? acc / n : 0;
}

function torsoOpaqueRatio(img: { width: number; height: number; data: Buffer }, frame = 0, fw = 256): number {
  const x0 = frame * fw + 108;
  const x1 = frame * fw + 168;
  const y0 = 118;
  const y1 = 178;
  let opaque = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      if (img.data[(y * img.width + x) * 4 + 3] > 160) opaque++;
    }
  }
  return opaque / Math.max(1, total);
}

describe('Messi shipped figure', () => {
  const idle = pngRgba(resolve('public/art/players/messi-idle.png'));
  const run = pngRgba(resolve('public/art/players/messi-run.png'));
  const kick = pngRgba(resolve('public/art/players/messi-kick.png'));

  it('has almost no chroma-green leftover on idle/run/kick', () => {
    const counts = {
      idle: chromaCount(idle),
      run: chromaCount(run),
      kick: chromaCount(kick),
    };
    writeFileSync(join(SCRATCH, 'messi-chroma-png.json'), JSON.stringify(counts));
    expect(counts.idle).toBeLessThan(40);
    expect(counts.run).toBeLessThan(40);
    expect(counts.kick).toBeLessThan(40);
  });

  it('keeps skin warmth in one band across idle/run/kick', () => {
    const warmth = {
      idle: skinWarmth(idle),
      run: skinWarmth(run),
      kick: skinWarmth(kick),
    };
    writeFileSync(join(SCRATCH, 'messi-warmth-png.json'), JSON.stringify(warmth));
    expect(warmth.idle).toBeGreaterThan(80);
    expect(Math.abs(warmth.run - warmth.idle)).toBeLessThan(28);
    expect(Math.abs(warmth.kick - warmth.idle)).toBeLessThan(28);
  });

  it('paints the directional torso instead of a greenscreen window', () => {
    const east = webpRgba(resolve('public/art/players/directional-v4/messi/e.webp'));
    const chroma = chromaCount(east);
    const opaque = torsoOpaqueRatio(east, 0);
    const warmth = skinWarmth(east);
    writeFileSync(join(SCRATCH, 'messi-east.json'), JSON.stringify({ chroma, opaque, warmth }));
    expect(chroma).toBeLessThan(80);
    expect(opaque).toBeGreaterThan(0.72);
    expect(Math.abs(warmth - skinWarmth(idle))).toBeLessThan(32);
  });

  it.each(DIRS)('keeps %s directional strip free of chroma-green', (direction) => {
    const img = webpRgba(resolve(`public/art/players/directional-v4/messi/${direction}.webp`));
    expect(chromaCount(img)).toBeLessThan(80);
  });
});
