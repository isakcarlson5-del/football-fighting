// @ts-nocheck -- the browser project intentionally does not ship Node typings;
// Vitest still executes this small PNG-header regression in its Node runtime.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const enemyIds = [
  'invader', 'invader-ultra', 'invader-away', 'sprinter', 'lobber', 'flare', 'flag', 'foam', 'steward',
  'drummer', 'vuvuzela', 'mascot', 'banner', 'paparazzo', 'chant', 'bull',
  'drone', 'varcam', 'boss-drumboss', 'boss-official', 'boss-captain',
];
const playerIds = ['messi', 'ronaldo', 'neymar', 'yamal'];
const specialPickupIds = ['magnet', 'bomb', 'freeze'];
const trainingCardIds = ['power', 'speed', 'maxhp', 'regen', 'magnet', 'armor', 'heal', 'coins'];
const guardIds = ['bodyguard-rookie', 'bodyguard', 'bodyguard-heavy', 'bodyguard-scout'];
const projectileIds = ['golden-boot-v2', 'curveball-v2'];
const combatVfxIds = ['orbit-impact-v2', 'orbit-skid-v2'];
const animatedVfxIds = [
  'contact-hit-strip',
  'player-hurt-strip',
  'knockout-strip',
  'guard-slam-strip',
  'curveball-trail-strip',
  'golden-boot-trail-strip',
  'boss-warning-strip',
  'bull-charge-lane-strip',
  'aerial-target-strip',
  'captains-heart-strip',
  'drone-shot-strip',
  'var-scan-shot-strip',
  'ability-upgrade-strip',
];
const subtleVfxAssets = [
  ['kick-dust-motes', 128, 128],
  ['orbit-ball-trail', 180, 32],
  ['orbit-ball-curved-trail', 256, 128],
] as const;
const bossIds = ['boss-drumboss', 'boss-official', 'boss-captain'];
const bossDirections = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const playerDirections = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

function pngHeader(path: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(path);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}

function maxPngAlphaInTopRows(path: string, rowCount: number): number {
  const bytes = readFileSync(path);
  const { width, colorType } = pngHeader(path);
  expect(colorType).toBe(6);
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
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  let maxAlpha = 0;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < rowCount; y++) {
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
    for (let x = 3; x < stride; x += 4) maxAlpha = Math.max(maxAlpha, row[x]);
    previous = row;
  }
  return maxAlpha;
}

function webpHeader(path: string): { width: number; height: number; alpha: boolean } {
  const bytes = readFileSync(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
  expect(bytes.toString('ascii', 12, 16)).toBe('VP8X');
  return {
    width: 1 + bytes.readUIntLE(24, 3),
    height: 1 + bytes.readUIntLE(27, 3),
    alpha: (bytes[20] & 0x10) !== 0,
  };
}

function alphaWebpDimensions(path: string): { width: number; height: number; alpha: boolean } {
  const bytes = readFileSync(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return webpHeader(path);
  expect(chunk).toBe('VP8L');
  const bits = bytes.readUInt32LE(21);
  return {
    width: 1 + (bits & 0x3fff),
    height: 1 + ((bits >>> 14) & 0x3fff),
    alpha: true,
  };
}

function opaqueWebpHeader(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
  expect(bytes.toString('ascii', 12, 16)).toBe('VP8 ');
  // Lossy VP8 stores its 14-bit frame dimensions in the frame header after
  // the ten-byte RIFF chunk prefix and three-byte start code.
  return {
    width: bytes.readUInt16LE(26) & 0x3fff,
    height: bytes.readUInt16LE(28) & 0x3fff,
  };
}

describe('generated locomotion art', () => {
  it.each(enemyIds)('%s has a six-frame transparent enemy strip', (id) => {
    const header = pngHeader(resolve(`public/art/enemies/${id}-run.png`));
    expect(header).toEqual({ width: 256 * 6, height: 320, colorType: 6 });
  });

  it.each(bossIds.flatMap((boss) => bossDirections.map((direction) => [boss, direction])))(
    '%s has a 12-frame transparent %s directional runtime strip',
    (boss, direction) => {
      const path = resolve(`public/art/enemies/directional-v2/${boss}/${direction}.webp`);
      expect(webpHeader(path)).toEqual({ width: 480 * 12, height: 320, alpha: true });
      expect(statSync(path).size).toBeGreaterThan(100_000);
    },
  );

  it.each(playerIds)('%s has a six-frame transparent player strip', (id) => {
    const header = pngHeader(resolve(`public/art/players/${id}-run.png`));
    expect(header).toEqual({ width: 256 * 6, height: 320, colorType: 6 });
  });

  it.each(playerIds.flatMap((player) => playerDirections.map((direction) => [player, direction])))(
    '%s has a 12-frame transparent %s directional runtime strip',
    (player, direction) => {
      const path = resolve(`public/art/players/directional-v4/${player}/${direction}.webp`);
      expect(webpHeader(path)).toEqual({ width: 256 * 12, height: 320, alpha: true });
      expect(statSync(path).size).toBeGreaterThan(150_000);
    },
  );

  it.each(guardIds)('%s has semantic poses and a six-frame transparent run strip', (id) => {
    expect(pngHeader(resolve(`public/art/allies/${id}.png`))).toEqual({ width: 256 * 4, height: 320, colorType: 6 });
    expect(pngHeader(resolve(`public/art/allies/${id}-run.png`))).toEqual({ width: 256 * 6, height: 320, colorType: 6 });
  });

  it.each(['bodyguard-heavy-clean', 'bodyguard-scout-clean'])('%s removes the contaminated semantic top band', (id) => {
    const path = resolve(`public/art/allies/${id}.png`);
    expect(pngHeader(path)).toEqual({ width: 256 * 4, height: 320, colorType: 6 });
    expect(statSync(path).size).toBeGreaterThan(100_000);
    expect(maxPngAlphaInTopRows(path, 13)).toBe(0);
  });

  it.each(specialPickupIds)('%s has a square transparent pickup asset', (id) => {
    const header = pngHeader(resolve(`public/art/pickups/${id}.png`));
    expect(header).toEqual({ width: 256, height: 256, colorType: 6 });
  });

  it.each(projectileIds)('%s has a square transparent projectile asset', (id) => {
    const header = pngHeader(resolve(`public/art/projectiles/${id}.png`));
    expect(header).toEqual({ width: 256, height: 256, colorType: 6 });
  });

  it.each(combatVfxIds)('%s has a square transparent combat VFX asset', (id) => {
    const header = pngHeader(resolve(`public/art/vfx/${id}.png`));
    expect(header).toEqual({ width: 256, height: 256, colorType: 6 });
  });

  it.each(animatedVfxIds)('%s has a six-frame transparent VFX strip', (id) => {
    const header = pngHeader(resolve(`public/art/vfx/${id}.png`));
    expect(header).toEqual({ width: 256 * 6, height: 256, colorType: 6 });
  });

  it('ships the twelve-frame transparent Keeper\'s Halo ability strip and card', () => {
    const strip = resolve('public/art/abilities/keeper-halo-strip-v2.png');
    expect(pngHeader(strip)).toEqual({
      width: 256 * 12,
      height: 256,
      colorType: 6,
    });
    expect(statSync(strip).size).toBeGreaterThan(500_000);
    const card = resolve('public/art/abilities/keeperhalo.webp');
    expect(opaqueWebpHeader(card)).toEqual({ width: 512, height: 512 });
    expect(statSync(card).size).toBeGreaterThan(5_000);
  });

  it.each(subtleVfxAssets)('%s has a compact transparent single-texture VFX asset', (id, width, height) => {
    const header = pngHeader(resolve(`public/art/vfx/${id}.png`));
    expect(header).toEqual({ width, height, colorType: 6 });
  });

  it('ships a six-stage alpha Matchday Wipeout explosion', () => {
    const path = resolve('public/art/vfx/matchday-wipeout-strip.webp');
    expect(webpHeader(path)).toEqual({ width: 512 * 6, height: 512, alpha: true });
    expect(statSync(path).size).toBeGreaterThan(300_000);
  });

  it('ships a compact six-frame alpha Captain\'s Whistle strip', () => {
    const path = resolve('public/art/vfx/captains-whistle-strip.webp');
    expect(alphaWebpDimensions(path)).toEqual({ width: 256 * 6, height: 256, alpha: true });
    expect(statSync(path).size).toBeGreaterThan(50_000);
  });

  it.each(['world-cup-classic', 'world-cup-showpiece', 'world-cup-modern-ai'])('%s ships as a high-resolution production arena', (id) => {
    const path = resolve(`public/art/arena/world-cup/${id}.webp`);
    expect(opaqueWebpHeader(path)).toEqual({ width: 3072, height: 2048 });
    expect(statSync(path).size).toBeGreaterThan(1_500_000);
  });

  it.each(trainingCardIds)('%s has its own generated upgrade-card illustration', (id) => {
    expect(statSync(resolve(`public/art/cards/${id}.webp`)).size).toBeGreaterThan(20_000);
  });
});
