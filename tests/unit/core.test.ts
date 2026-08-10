import { describe, expect, it } from 'vitest';
import { Rng, weightedPick } from '../../src/core/rng';
import { matchClock } from '../../src/core/math';
import {
  ABILITIES,
  ABILITY_IDS,
  BOSSES,
  ENEMIES,
  META_TRACKS,
  PLAYERS,
  SKINS,
  hpScale,
  metaCost,
  spawnBatch,
  spawnInterval,
  xpForLevel,
} from '../../src/game/data';
import { Save } from '../../src/game/meta';

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

describe('data integrity', () => {
  it('has exactly the 4 required players, all selectable', () => {
    expect(PLAYERS.map((p) => p.id).sort()).toEqual(['messi', 'neymar', 'ronaldo', 'yamal']);
  });
  it('every player has distinct stats and a valid start ability', () => {
    const sigs = new Set(PLAYERS.map((p) => `${p.speed}/${p.maxHp}/${p.power}`));
    expect(sigs.size).toBe(4);
    for (const p of PLAYERS) expect(ABILITY_IDS).toContain(p.startAbility);
  });
  it('has every required ability plus First Touch Blast, each with 5 levels', () => {
    expect(ABILITY_IDS.sort()).toEqual(['blast', 'dash', 'guard', 'orbit', 'pressure', 'strike', 'whistle']);
    for (const id of ABILITY_IDS) expect(ABILITIES[id].levels).toHaveLength(5);
  });
  it('every offensive ability is lane-typed (ground/aerial + band + delivery + force)', () => {
    for (const id of ABILITY_IDS) {
      const a = ABILITIES[id];
      expect(['ground', 'aerial', 'hybrid']).toContain(a.lane);
      expect(['near', 'far']).toContain(a.rangeBand);
      expect(['ring', 'sweep', 'trap', 'lob', 'direct', 'barrage']).toContain(a.delivery);
      expect(['none', 'push', 'pull']).toContain(a.force);
    }
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
  it('xp requirement grows monotonically', () => {
    for (let l = 1; l < 40; l++) expect(xpForLevel(l + 1)).toBeGreaterThan(xpForLevel(l));
  });
  it('difficulty scales up over the run', () => {
    expect(hpScale(300)).toBeGreaterThan(hpScale(60));
    expect(spawnInterval(300)).toBeLessThan(spawnInterval(30));
    expect(spawnBatch(590)).toBeGreaterThan(spawnBatch(30));
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

  it('persists and reloads coins, ranks and skins', () => {
    const storage = fakeStorage();
    const s1 = new Save(storage);
    s1.addCoins(500);
    s1.buyRank('power', metaCost(META_TRACKS[0], 0));
    s1.buySkin('messi_away');
    s1.equipSkin('messi', 'messi_away');
    s1.recordRun({ kills: 100, time: 320, level: 8, won: false });
    const s2 = new Save(storage);
    expect(s2.data.coins).toBe(500 - metaCost(META_TRACKS[0], 0) - 150);
    expect(s2.rank('power')).toBe(1);
    expect(s2.ownsSkin('messi_away')).toBe(true);
    expect(s2.equippedSkin('messi')).toBe('messi_away');
    expect(s2.data.stats.totalKills).toBe(100);
    expect(s2.data.stats.bestTime).toBe(320);
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
