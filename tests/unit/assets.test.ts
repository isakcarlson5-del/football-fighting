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

function pngHeader(path: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(path);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}

describe('generated locomotion art', () => {
  it.each(enemyIds)('%s has a six-frame transparent enemy strip', (id) => {
    const header = pngHeader(resolve(`public/art/enemies/${id}-run.png`));
    expect(header).toEqual({ width: 256 * 6, height: 320, colorType: 6 });
  });

  it.each(playerIds)('%s has a six-frame transparent player strip', (id) => {
    const header = pngHeader(resolve(`public/art/players/${id}-run.png`));
    expect(header).toEqual({ width: 256 * 6, height: 320, colorType: 6 });
  });

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

  it('ships the sharp production arena plate', () => {
    expect(statSync(resolve('public/art/arena/gameplay-pitch-v2.webp')).size).toBeGreaterThan(300_000);
  });

  it.each(trainingCardIds)('%s has its own generated upgrade-card illustration', (id) => {
    expect(statSync(resolve(`public/art/cards/${id}.webp`)).size).toBeGreaterThan(20_000);
  });
});
