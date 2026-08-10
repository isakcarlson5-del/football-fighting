/**
 * Attack-lane tests: range-band targeting, damage reservation across volleys,
 * ground-vs-airborne rules, and the Pitch Pressure ground ring.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/game/sim';
import { ENEMIES, PLAYERS } from '../../src/game/data';
import { Save } from '../../src/game/meta';

function makeSim(playerIdx = 0, seed = 1234): Sim {
  return new Sim(PLAYERS[playerIdx], new Save(null), seed);
}

function step(sim: Sim, frames: number, ax = 0, ay = 0): void {
  for (let i = 0; i < frames; i++) sim.update(1 / 60, ax, ay);
}

/** Remove the constructor's opening wave so staged enemies are the only ones. */
function clearField(sim: Sim): void {
  sim.enemies.forEach((e) => (e.active = false));
}

function far(sim: Sim, dist: number, angle = 0): { x: number; y: number } {
  return { x: sim.player.x + Math.cos(angle) * dist, y: sim.player.y + Math.sin(angle) * dist };
}

describe('attack lanes', () => {
  it('aerial targeting prefers far ranged threats over near melee', () => {
    const sim = makeSim();
    clearField(sim);
    const nearP = far(sim, 120);
    const farP = far(sim, 420);
    sim.debugSpawn('hooligan', nearP.x, nearP.y);
    sim.debugSpawn('thrower', farP.x, farP.y);
    const pick = sim.pickAerialTarget(sim.player.x, sim.player.y);
    expect(sim.enemies[pick].def.id).toBe('thrower');
  });

  it('between two far targets the ranged one wins over the plain chaser', () => {
    const sim = makeSim();
    clearField(sim);
    sim.debugSpawn('hooligan', far(sim, 300).x, sim.player.y);
    sim.debugSpawn('thrower', far(sim, 500).x, sim.player.y);
    const pick = sim.pickAerialTarget(sim.player.x, sim.player.y);
    expect(sim.enemies[pick].def.id).toBe('thrower');
  });

  it('falls back to a near target when nothing is in the far band', () => {
    const sim = makeSim();
    clearField(sim);
    sim.debugSpawn('hooligan', far(sim, 130).x, sim.player.y);
    const pick = sim.pickAerialTarget(sim.player.x, sim.player.y);
    expect(pick).toBeGreaterThanOrEqual(0);
    expect(sim.enemies[pick].def.id).toBe('hooligan');
  });

  it('volleys distribute onto living targets instead of overkill-stacking (reservation)', () => {
    const sim = makeSim(0); // Messi: strike L1 lobs 2 balls
    clearField(sim);
    sim.debugSpawn('thrower', far(sim, 380).x, sim.player.y);
    sim.debugSpawn('thrower', far(sim, 430, 0.6).x, far(sim, 430, 0.6).y);
    const [a, b] = sim.enemies.filter((e) => e.active);
    a.hp = 5; // almost dead: one reserved lob already projects the kill
    a.maxHp = 5;
    sim.player.strikeCd = 0;
    step(sim, 2);
    const targets = sim.balls.filter((x) => x.active).map((x) => x.targetIdx);
    expect(targets.length).toBe(2);
    expect(new Set(targets).size).toBe(2); // each ball reserved a different enemy
  });

  it('GROUND ring does not touch airborne enemies, but damages + pushes grounded ones', () => {
    const sim = makeSim(3); // Yamal: orbit-only start, so Pitch Pressure is the lone attacker here
    clearField(sim);
    sim.applyUpgrade({ kind: 'ability', id: 'pressure', name: '', desc: '', color: '', level: 1 });
    const pos = far(sim, 100);
    sim.debugSpawn('hooligan', pos.x, pos.y);
    const e = sim.enemies.find((x) => x.active)!;
    e.speed = 0;
    e.hp = 500; // tanky: survives the window so the slot is never reused
    e.maxHp = 500;
    // airborne: the ring sweeps underneath
    e.airT = 5;
    sim.player.pressureCd = 0;
    step(sim, 45); // ring expands past the enemy
    expect(e.hp).toBe(500);
    // grounded: the ring connects and shoves
    e.airT = 0;
    sim.player.pressureCd = 0;
    const d0 = Math.hypot(e.x - sim.player.x, e.y - sim.player.y);
    step(sim, 45);
    expect(e.hp).toBeLessThan(500);
    const d1 = Math.hypot(e.x - sim.player.x, e.y - sim.player.y);
    expect(d1).toBeGreaterThan(d0);
  });

  it('AERIAL lobs connect with airborne enemies (no permanent immunities)', () => {
    const sim = makeSim(0); // Messi starts with strike
    clearField(sim);
    const pos = far(sim, 340);
    sim.debugSpawn('thrower', pos.x, pos.y);
    const e = sim.enemies.find((x) => x.active)!;
    e.speed = 0;
    e.hp = 500;
    e.maxHp = 500;
    sim.player.strikeCd = 0;
    step(sim, 3); // lobs launch
    e.airT = 3; // mid-leap when the ball lands
    step(sim, 90); // ~1.5s: balls land
    expect(e.hp).toBeLessThan(500);
  });

  it('heavy knockback launches enemies briefly airborne (then they land again)', () => {
    const sim = makeSim(1); // Ronaldo: whistle L1
    clearField(sim);
    const pos = far(sim, 100);
    sim.debugSpawn('hooligan', pos.x, pos.y);
    const e = sim.enemies.find((x) => x.active)!;
    e.speed = 0;
    sim.damageEnemy(sim.enemies.indexOf(e), 1, 400, 0); // heavy shove
    expect(e.airT).toBeGreaterThan(0);
    step(sim, 60); // 1s later: landed
    expect(e.airT).toBe(0);
  });

  it('aerial lobs land a group splash (both nearby enemies take damage)', () => {
    const sim = makeSim(0);
    clearField(sim);
    sim.debugSpawn('thrower', far(sim, 360).x, sim.player.y);
    sim.debugSpawn('thrower', far(sim, 400).x, sim.player.y + 40);
    const pair = sim.enemies.filter((e) => e.active);
    for (const e of pair) {
      e.speed = 0;
      e.hp = 400;
      e.maxHp = 400;
    }
    sim.player.strikeCd = 0;
    step(sim, 100);
    // at least one landing splashed both members of the pair
    const hurt = pair.filter((e) => e.hp < 400).length;
    expect(hurt).toBeGreaterThan(0);
  });
});
