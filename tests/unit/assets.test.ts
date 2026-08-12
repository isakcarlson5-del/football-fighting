// @ts-nocheck -- the browser project intentionally does not ship Node typings;
// Vitest still executes this small PNG-header regression in its Node runtime.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const enemyIds = [
  'invader', 'invader-ultra', 'invader-away', 'sprinter', 'lobber', 'flare', 'flag', 'foam', 'steward',
  'drummer', 'vuvuzela', 'mascot', 'banner', 'paparazzo', 'chant', 'bull',
  'drone', 'boss-drumboss', 'boss-official', 'boss-captain',
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
];
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
      const path = resolve(`public/art/players/directional-v2/${player}/${direction}.webp`);
      expect(webpHeader(path)).toEqual({ width: 256 * 12, height: 320, alpha: true });
      expect(statSync(path).size).toBeGreaterThan(150_000);
    },
  );

  it.each(guardIds)('%s has semantic poses and a six-frame transparent run strip', (id) => {
    expect(pngHeader(resolve(`public/art/allies/${id}.png`))).toEqual({ width: 256 * 4, height: 320, colorType: 6 });
    expect(pngHeader(resolve(`public/art/allies/${id}-run.png`))).toEqual({ width: 256 * 6, height: 320, colorType: 6 });
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

  it('ships a six-stage alpha Matchday Wipeout explosion', () => {
    const path = resolve('public/art/vfx/matchday-wipeout-strip.webp');
    expect(webpHeader(path)).toEqual({ width: 512 * 6, height: 512, alpha: true });
    expect(statSync(path).size).toBeGreaterThan(300_000);
  });

  it.each(['midnight-final', 'heritage-day', 'electric-derby'])('%s ships as a high-resolution production arena', (id) => {
    const path = resolve(`public/art/arena/variants/${id}.webp`);
    expect(opaqueWebpHeader(path)).toEqual({ width: 3072, height: 2048 });
    expect(statSync(path).size).toBeGreaterThan(1_500_000);
  });

  it.each(trainingCardIds)('%s has its own generated upgrade-card illustration', (id) => {
    expect(statSync(resolve(`public/art/cards/${id}.webp`)).size).toBeGreaterThan(20_000);
  });
});
