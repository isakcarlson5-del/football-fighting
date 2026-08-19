import { describe, expect, it } from 'vitest';
import { audioPriorityProfile } from '../../src/core/audio';
import { Rng, weightedPick } from '../../src/core/rng';
import { matchClock } from '../../src/core/math';
import { JOYSTICK_DEADZONE, remapRadialDeadzone } from '../../src/core/input';
import { consumeFixedSteps, exponentialSmoothing } from '../../src/core/timing';
import { hardenInteriorAlpha, opaqueFrameBaselineOffset, punchSkinAdjacentWhiteGaps } from '../../src/core/sprites';
import {
  ABILITIES,
  ABILITY_IDS,
  BOSSES,
  ENEMIES,
  META_TRACKS,
  ENEMY_PACE_MULT,
  PLAYER_PACE_MULT,
  PLAYERS,
  SKINS,
  difficultyProgress,
  eliteInterval,
  enemyDamageScale,
  enemySpawnWeight,
  enemySpeedScale,
  hpScale,
  metaCost,
  powerPressure,
  spawnInterval,
  spawnRate,
  xpForLevel,
} from '../../src/game/data';
import { SAVE_VERSION, Save } from '../../src/game/meta';

describe('rng', () => {
  it('is deterministic for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('produces values in [0,1)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('weightedPick respects zero weight', () => {
    const r = new Rng(1);
    const items = [
      { id: 'a', weight: 0 },
      { id: 'b', weight: 10 },
    ];
    for (let i = 0; i < 50; i++) expect(weightedPick(r, items)?.id).toBe('b');
  });
});

describe('virtual joystick', () => {
  it('remaps the radial deadzone continuously instead of jumping to 18% speed', () => {
    expect(remapRadialDeadzone(0.17, 0)).toEqual({ x: 0, y: 0 });
    expect(remapRadialDeadzone(JOYSTICK_DEADZONE, 0)).toEqual({ x: 0, y: 0 });
    expect(remapRadialDeadzone(0.19, 0).x).toBeCloseTo((0.19 - 0.18) / 0.82, 10);
    expect(remapRadialDeadzone(0.5, 0).x).toBeCloseTo((0.5 - 0.18) / 0.82, 10);
    expect(remapRadialDeadzone(1, 0)).toEqual({ x: 1, y: 0 });
  });

  it('preserves direction, clamps overtravel and stays monotonic', () => {
    const diagonal = remapRadialDeadzone(0.5 / Math.SQRT2, 0.5 / Math.SQRT2);
    expect(diagonal.x).toBeCloseTo(diagonal.y, 12);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo((0.5 - 0.18) / 0.82, 10);
    expect(remapRadialDeadzone(2, 0)).toEqual({ x: 1, y: 0 });
    const magnitudes = [0.18, 0.19, 0.24, 0.5, 0.75, 1]
      .map((magnitude) => Math.hypot(...Object.values(remapRadialDeadzone(magnitude, 0))));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => a - b));
    expect(remapRadialDeadzone(Number.NaN, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('frame timing', () => {
  it('produces the same exponential camera response at 60 and 120 Hz', () => {
    const at60 = 1 - (1 - exponentialSmoothing(7.67, 1 / 60)) ** 60;
    const at120 = 1 - (1 - exponentialSmoothing(7.67, 1 / 120)) ** 120;
    expect(at60).toBeCloseTo(at120, 10);
  });

  it('retains one catch-up step and reports only surplus fixed-step time', () => {
    const normal = consumeFixedSteps(0, 1 / 30);
    expect(normal.steps).toBe(2);
    expect(normal.discarded).toBe(0);

    const hitch = consumeFixedSteps(0, 0.25, 1 / 60, 8);
    expect(hitch.steps).toBe(8);
    expect(hitch.remainder).toBeCloseTo(1 / 60, 8);
    expect(hitch.discarded).toBeCloseTo(0.1, 8);
  });
});

describe('generated strip grounding', () => {
  it('moves an airborne authored body down to the shared foot baseline', () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    pixels[(1 * 4 + 2) * 4 + 3] = 255;
    expect(opaqueFrameBaselineOffset(pixels, 4, 4, 3)).toBe(1);
    pixels[(2 * 4 + 1) * 4 + 3] = 255;
    expect(opaqueFrameBaselineOffset(pixels, 4, 4, 3)).toBe(0);
  });

  it('hardens interior coverage while leaving isolated fringe pixels soft', () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y <= 2; y++) {
      for (let x = 0; x <= 2; x++) {
        pixels[(y * 4 + x) * 4 + 3] = 120;
      }
    }
    pixels[(3 * 4 + 3) * 4 + 3] = 80;
    hardenInteriorAlpha(pixels, 4, 4);
    expect(pixels[(1 * 4 + 1) * 4 + 3]).toBe(255);
    expect(pixels[(3 * 4 + 3) * 4 + 3]).toBeLessThan(255);
  });

  it('does not turn leftover white fringe into opaque armpit spots', () => {
    const pixels = new Uint8ClampedArray(5 * 5 * 4);
    const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
      const i = (y * 5 + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    };
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) put(x, y, 70, 150, 210, 255);
    }
    put(0, 2, 210, 150, 100, 255);
    put(1, 2, 205, 145, 95, 255);
    put(2, 2, 252, 250, 248, 90);
    hardenInteriorAlpha(pixels, 5, 5);
    const i = (2 * 5 + 2) * 4;
    expect(pixels[i + 3]).toBe(255);
    expect(Math.max(pixels[i], pixels[i + 1], pixels[i + 2])).toBeLessThan(220);
  });

  it('fills white arm/hand gaps with nearby body paint and keeps kit stripes', () => {
    const w = 8;
    const h = 8;
    const pixels = new Uint8ClampedArray(w * h * 4);
    const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
      const i = (y * w + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) put(x, y, 0, 0, 0, 0);
    }
    for (let y = 3; y <= 6; y++) {
      put(1, y, 210, 150, 100, 255);
      put(2, y, 250, 248, 246, 255);
      put(5, y, 250, 248, 246, 255);
    }
    punchSkinAdjacentWhiteGaps(pixels, w, h, w);
    const filled = (4 * w + 2) * 4;
    expect(pixels[filled + 3]).toBe(255);
    expect(pixels[filled]).toBeGreaterThan(180);
    expect(pixels[filled] - pixels[filled + 2]).toBeGreaterThan(20);
    expect(pixels[(4 * w + 5) * 4 + 3]).toBe(255);
    expect(pixels[(4 * w + 5) * 4]).toBeGreaterThan(240);
  });
});

describe('audio threat hierarchy', () => {
  it('ducks lower layers monotonically without increasing master loudness', () => {
    const ordinary = audioPriorityProfile(2);
    const warning = audioPriorityProfile(3);
    const immediateDanger = audioPriorityProfile(4);

    expect(ordinary.musicDuck).toBe(1);
    expect(ordinary.combatDuck).toBe(1);
    expect(warning.musicDuck).toBeLessThan(ordinary.musicDuck);
    expect(warning.combatDuck).toBeLessThan(ordinary.combatDuck);
    expect(immediateDanger.musicDuck).toBeLessThan(warning.musicDuck);
    expect(immediateDanger.combatDuck).toBeLessThan(warning.combatDuck);
    expect(immediateDanger.hold).toBeGreaterThan(warning.hold);
  });
});

describe('data integrity', () => {
  it('has exactly the 4 required players, all selectable', () => {
    expect(PLAYERS.map((p) => p.id).sort()).toEqual(['messi', 'neymar', 'ronaldo', 'yamal']);
  });
  it('every player has distinct stats and a valid start ability', () => {
    const sigs = new Set(PLAYERS.map((p) => `${p.speed}/${p.maxHp}/${p.power}`));
    expect(sigs.size).toBe(4);
    for (const p of PLAYERS) expect(ABILITY_IDS).toContain(p.startAbility);
  });
  it('has every required ability plus the expanded aerial kit, each with 5 levels', () => {
    expect(ABILITY_IDS.sort()).toEqual([
      'blast', 'bootseekers', 'curveball', 'dash', 'guard', 'keeperhalo', 'orbit', 'pressure', 'strike', 'whistle',
    ]);
    for (const id of ABILITY_IDS) expect(ABILITIES[id].levels).toHaveLength(5);
  });
  it('every offensive ability is lane-typed (ground/aerial + band + delivery + force)', () => {
    const roles = new Set<string>();
    for (const id of ABILITY_IDS) {
      const a = ABILITIES[id];
      expect(['ground', 'aerial', 'hybrid']).toContain(a.lane);
      expect(['near', 'far']).toContain(a.rangeBand);
      expect(['ring', 'sweep', 'trap', 'lob', 'direct', 'barrage']).toContain(a.delivery);
      expect(['none', 'push', 'pull']).toContain(a.force);
      roles.add(a.role);
    }
    expect(roles.size).toBe(ABILITY_IDS.length);
  });
  it('has the 4 required meta tracks', () => {
    expect(META_TRACKS.map((t) => t.id).sort()).toEqual(['guard', 'magnet', 'move', 'power']);
  });
  it('has cosmetic skins for every player', () => {
    for (const p of PLAYERS) {
      expect(SKINS.filter((s) => s.player === p.id).length).toBeGreaterThanOrEqual(2);
    }
  });
  it('enemy roster escalates: later enemies are tougher', () => {
    expect(ENEMIES.steward.hp).toBeGreaterThan(ENEMIES.invader.hp);
    expect(ENEMIES.mascot.hp).toBeGreaterThan(ENEMIES.steward.hp);
    expect(ENEMIES.sprinter.speed).toBeGreaterThan(ENEMIES.invader.speed);
  });
  it('bosses are clearly stronger than regular enemies', () => {
    expect(BOSSES.official.hp).toBeGreaterThan(ENEMIES.mascot.hp * 5);
    expect(BOSSES.captain.hp).toBeGreaterThan(BOSSES.official.hp);
  });
});

describe('pacing curves', () => {
  it('accelerates the match while preserving a small player reaction advantage', () => {
    expect(PLAYER_PACE_MULT).toBe(1.6);
    expect(ENEMY_PACE_MULT).toBe(1.55);
    expect(PLAYER_PACE_MULT).toBeGreaterThan(ENEMY_PACE_MULT);
  });
  it('xp requirement grows monotonically', () => {
    for (let l = 1; l < 40; l++) expect(xpForLevel(l + 1)).toBeGreaterThan(xpForLevel(l));
  });
  it('matches the reference pacing checkpoints with smooth browser-safe ramps', () => {
    expect(spawnRate(0)).toBeCloseTo(0.8, 6);
    expect(spawnRate(120)).toBeCloseTo(1.92, 6);
    expect(spawnRate(300)).toBeCloseTo(5.2, 6);
    expect(spawnRate(450)).toBeCloseTo(11.2, 6);
    expect(spawnRate(600)).toBeCloseTo(24, 6);
    expect(spawnRate(720)).toBeCloseTo(30.4, 6);
    expect(spawnRate(119.99)).toBeLessThanOrEqual(spawnRate(120));
    expect(spawnRate(120.01)).toBeGreaterThanOrEqual(spawnRate(120));
    expect(spawnInterval(0)).toBeCloseTo(1 / 0.8, 6);
  });
  it('uses the reference HP, damage and speed endpoints without hard jumps', () => {
    expect(hpScale(0)).toBeCloseTo(1.5, 6);
    expect(hpScale(600)).toBeCloseTo(9.2, 6);
    expect(enemyDamageScale(0)).toBeCloseTo(0.9, 6);
    expect(enemyDamageScale(600)).toBeCloseTo(2.62, 6);
    expect(enemySpeedScale(0)).toBeCloseTo(1, 6);
    expect(enemySpeedScale(600)).toBeCloseTo(1.35, 6);
    expect(hpScale(720)).toBeCloseTo(11.04, 6);
    expect(enemyDamageScale(720)).toBeCloseTo(3.144, 6);
    expect(enemySpeedScale(720)).toBeCloseTo(1.485, 6);
    expect(enemySpeedScale(900)).toBeCloseTo(1.55, 6);
    expect(difficultyProgress(300)).toBeLessThan(0.35);
    expect(eliteInterval(55)).toBeCloseTo(49.25, 6);
    expect(eliteInterval(600)).toBe(22);
  });
  it('live build strength increases pressure without discrete difficulty jumps', () => {
    const low = powerPressure(3, 1);
    const high = powerPressure(22, 8);
    expect(high).toBeGreaterThan(low);
    expect(hpScale(420, high)).toBeGreaterThan(hpScale(420, low));
    expect(spawnInterval(420, high)).toBeLessThan(spawnInterval(420, low));
    expect(spawnRate(600, 1) / spawnRate(600, 0)).toBeCloseTo(1.18, 6);
    expect(hpScale(600, 1) / hpScale(600, 0)).toBeCloseTo(1.18, 6);
  });
  it('fades enemy archetypes in and keeps earlier fodder in the match', () => {
    expect(enemySpawnWeight(ENEMIES.drone, ENEMIES.drone.unlockAt - 0.01)).toBe(0);
    expect(enemySpawnWeight(ENEMIES.drone, ENEMIES.drone.unlockAt)).toBeGreaterThan(0);
    expect(enemySpawnWeight(ENEMIES.drone, ENEMIES.drone.unlockAt + 20)).toBeGreaterThan(
      enemySpawnWeight(ENEMIES.drone, ENEMIES.drone.unlockAt),
    );
    expect(enemySpawnWeight(ENEMIES.invader, 600)).toBeGreaterThan(0);
    expect(enemySpawnWeight(ENEMIES.invader, 600)).toBeLessThan(enemySpawnWeight(ENEMIES.invader, 120));
  });
  it('match clock maps 600s to 90 minutes', () => {
    expect(matchClock(0)).toBe("0'");
    expect(matchClock(300)).toBe("45'");
    expect(matchClock(600)).toBe("90'");
  });
  it('meta costs grow exponentially', () => {
    for (const t of META_TRACKS) {
      expect(metaCost(t, 1)).toBeGreaterThan(metaCost(t, 0));
      expect(metaCost(t, 4)).toBeGreaterThan(metaCost(t, 1));
    }
  });
});

describe('meta / save', () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  }

  it('starts new saves muted so no audio layer is audible by default', () => {
    expect(new Save(fakeStorage()).data.muted).toBe(true);
  });

  it('persists and reloads coins, ranks and skins', () => {
    const storage = fakeStorage();
    const s1 = new Save(storage);
    s1.addCoins(500);
    s1.buyRank('power', metaCost(META_TRACKS[0], 0));
    s1.buySkin('messi_away');
    s1.equipSkin('messi', 'messi_away');
    s1.data.reducedVfx = true;
    s1.data.haptics = false;
    s1.persist();
    s1.recordRun({ kills: 100, time: 320, level: 8, won: false });
    const s2 = new Save(storage);
    expect(s2.data.coins).toBe(500 - metaCost(META_TRACKS[0], 0) - 150);
    expect(s2.rank('power')).toBe(1);
    expect(s2.ownsSkin('messi_away')).toBe(true);
    expect(s2.equippedSkin('messi')).toBe('messi_away');
    expect(s2.data.stats.totalKills).toBe(100);
    expect(s2.data.stats.bestTime).toBe(320);
    expect(s2.data.reducedVfx).toBe(true);
    expect(s2.data.haptics).toBe(false);
  });

  it('migrates old saves and clamps corrupt values without losing valid progress', () => {
    const storage = fakeStorage();
    storage.setItem('ff_save_v1', JSON.stringify({
      coins: 420.4,
      ranks: { power: 999, move: 3, magnet: -4, guard: 2 },
      ownedSkins: ['messi_away', 'messi_away', 17],
      equipped: { messi: 'messi_away', broken: 9 },
      stats: { runs: 12, wins: -2, totalKills: 770, bestTime: Number.POSITIVE_INFINITY, bestLevel: 8 },
      leaderboardName: '  Isak FC  ',
      volume: { master: 4, sfx: -1, music: 0.45 },
    }));

    const save = new Save(storage);

    expect(save.data.version).toBe(SAVE_VERSION);
    expect(save.data.coins).toBe(420);
    expect(save.data.ranks).toEqual({ power: 5, move: 3, magnet: 0, guard: 2 });
    expect(save.data.ownedSkins).toEqual(['messi_away']);
    expect(save.data.equipped).toEqual({ messi: 'messi_away' });
    expect(save.data.stats).toMatchObject({ runs: 12, wins: 0, totalKills: 770, bestTime: 0, bestLevel: 8 });
    expect(save.data.leaderboardName).toBe('Isak FC');
    expect(save.data.volume).toEqual({ master: 1, sfx: 0, music: 0.45 });
  });

  it('refuses purchases without funds and caps ranks', () => {
    const s = new Save(fakeStorage());
    expect(s.buyRank('power', 50)).toBe(false);
    s.addCoins(100000);
    for (let i = 0; i < 5; i++) s.buyRank('move', metaCost(META_TRACKS[1], i));
    expect(s.rank('move')).toBe(5);
    expect(s.buyRank('move', 1)).toBe(false); // maxed
  });

  it('meta bonuses scale with ranks', () => {
    const s = new Save(fakeStorage());
    const b0 = s.bonuses();
    s.addCoins(100000);
    for (let i = 0; i < 5; i++) s.buyRank('guard', metaCost(META_TRACKS[3], i));
    const b1 = s.bonuses();
    expect(b1.guardDamage).toBeGreaterThan(b0.guardDamage);
    expect(b1.guardExtra).toBe(2); // ranks 3 and 5 each add a bodyguard
  });
});
