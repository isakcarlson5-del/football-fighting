/**
 * Attack-lane tests: range-band targeting, damage reservation across volleys,
 * ground-vs-airborne rules, the Pitch Pressure ring and the hybrid blast.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/game/sim';
import { PLAYERS } from '../../src/game/data';
import { Save } from '../../src/game/meta';

function makeSim(playerIdx = 0, seed = 1234): Sim {
  return new Sim(PLAYERS[playerIdx], new Save(null), seed);
}

function step(sim: Sim, frames: number, ax = 0, ay = 0): void {
  for (let i = 0; i < frames; i++) sim.update(1 / 60, ax, ay);
}

/** Remove ambient spawns so staged enemies are the only ones. */
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
    sim.debugSpawn('invader', nearP.x, nearP.y);
    sim.debugSpawn('lobber', farP.x, farP.y);
    const pick = sim.pickAerialTarget(sim.player.x, sim.player.y);
    expect(sim.enemies[pick].def.id).toBe('lobber');
  });

  it('between two far targets the ranged one wins over the plain chaser', () => {
    const sim = makeSim();
    clearField(sim);
    sim.debugSpawn('invader', far(sim, 300).x, sim.player.y);
    sim.debugSpawn('lobber', far(sim, 500).x, sim.player.y);
    const pick = sim.pickAerialTarget(sim.player.x, sim.player.y);
    expect(sim.enemies[pick].def.id).toBe('lobber');
  });

  it('falls back to a near target when nothing is in the far band', () => {
    const sim = makeSim();
    clearField(sim);
    sim.debugSpawn('invader', far(sim, 130).x, sim.player.y);
    const pick = sim.pickAerialTarget(sim.player.x, sim.player.y);
    expect(pick).toBeGreaterThanOrEqual(0);
    expect(sim.enemies[pick].def.id).toBe('invader');
  });

  it('volleys distribute onto living targets instead of overkill-stacking (reservation)', () => {
    const sim = makeSim(0); // Messi: strike L1 lobs 2 balls
    clearField(sim);
    sim.debugSpawn('lobber', far(sim, 380).x, sim.player.y);
    sim.debugSpawn('lobber', far(sim, 430, 0.6).x, far(sim, 430, 0.6).y);
    const [a] = sim.enemies.filter((e) => e.active);
    a.hp = 5; // almost dead: one reserved lob already projects the kill
    a.maxHp = 5;
    sim.player.strikeCd = 0;
    step(sim, 2);
    expect(sim.player.kickT).toBeGreaterThan(0);
    expect(sim.balls.filter((x) => x.active)).toHaveLength(0); // wind-up precedes contact
    step(sim, 11); // pass the 180ms contact beat
    expect(sim.impacts.some((impact) => impact.active && impact.kind === 'kickground')).toBe(true);
    const targets = sim.balls.filter((x) => x.active).map((x) => x.targetIdx);
    expect(targets.length).toBe(2);
    expect(new Set(targets).size).toBe(2); // each ball reserved a different enemy
  });

  it('Curveball Swarm tracks beyond the old range, spreads reservations and reacquires a dead target', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.player.abilities = { curveball: 1 };
    for (const [distance, angle] of [[760, -0.24], [790, -0.08], [820, 0.1], [860, 0.25]] as const) {
      const position = far(sim, distance, angle);
      sim.debugSpawn('lobber', position.x, position.y);
    }
    const targets = sim.enemies.filter((e) => e.active);
    for (const e of targets) {
      e.speed = 0;
      e.hp = 8; // one reserved curveball projects the kill, forcing target spread
      e.maxHp = 8;
    }
    sim.player.curveballCd = 0;
    step(sim, 1);
    const active = sim.seekers.filter((s) => s.active);
    expect(active).toHaveLength(3);
    expect(new Set(active.map((s) => s.targetIdx)).size).toBe(3);

    const seeker = active[0];
    const oldTarget = seeker.targetIdx;
    const initiallyUnreserved = sim.enemies.findIndex((enemy) => enemy.active && !active.some((entry) => entry.targetIdx === sim.enemies.indexOf(enemy)));
    expect(initiallyUnreserved).toBeGreaterThanOrEqual(0);
    sim.enemies[oldTarget].active = false;
    step(sim, 1);
    expect(seeker.active).toBe(true);
    expect(seeker.targetIdx).toBe(initiallyUnreserved);
  });

  it('Golden Boot Seekers home into the back line and splash nearby threats', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.player.abilities = { bootseekers: 1 };
    const pos = far(sim, 620);
    sim.debugSpawn('lobber', pos.x, pos.y);
    sim.debugSpawn('invader', pos.x + 42, pos.y + 24);
    const pair = sim.enemies.filter((e) => e.active);
    for (const e of pair) {
      e.speed = 0;
      e.hp = 500;
      e.maxHp = 500;
    }
    sim.player.bootseekersCd = 0;
    step(sim, 150);
    expect(pair.every((e) => e.hp < 500)).toBe(true);
    expect(sim.events.some((event) => event.type === 'seekerHit' && event.kind === 'goldenboot')).toBe(true);
  });

  it('GROUND ring does not touch airborne enemies, but damages + pushes grounded ones', () => {
    const sim = makeSim(3); // Yamal: orbit-only start, so Pitch Pressure is the lone attacker here
    clearField(sim);
    sim.applyUpgrade({ kind: 'ability', id: 'pressure', name: '', desc: '', color: '', level: 1 });
    const pos = far(sim, 100);
    sim.debugSpawn('invader', pos.x, pos.y);
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

  it('Pitch Pressure waits for a grounded threat instead of firing on an empty pitch', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.player.abilities = { pressure: 1 };
    sim.player.pressureCd = 0;
    step(sim, 1);
    expect(sim.pressures.some((ring) => ring.active)).toBe(false);
    expect(sim.player.pressureCd).toBeCloseTo(0.16, 5);

    sim.debugSpawn('invader', sim.player.x + 120, sim.player.y);
    const enemy = sim.enemies.find((entry) => entry.active)!;
    enemy.speed = 0;
    step(sim, 11);
    expect(sim.pressures.some((ring) => ring.active)).toBe(true);
  });

  it('max Pitch Pressure captures cast level and centre for every queued pulse', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.player.abilities = { pressure: 5 };
    sim.debugSpawn('steward', sim.player.x + 130, sim.player.y);
    const enemy = sim.enemies.find((entry) => entry.active)!;
    enemy.speed = 0;
    enemy.hp = enemy.maxHp = 9999;
    const castX = sim.player.x;
    const castY = sim.player.y;
    sim.player.pressureCd = 0;
    step(sim, 1);
    expect(sim.player.pressureQueue).toBe(2);
    sim.player.x += 420;
    sim.player.y += 180;
    sim.player.abilities.pressure = 1;
    step(sim, 28);
    const queued = sim.pressures.find((ring) => ring.active)!;
    expect(queued).toBeTruthy();
    expect(queued.x).toBeCloseTo(castX, 5);
    expect(queued.y).toBeCloseTo(castY, 5);
    expect(queued.maxR).toBe(225);
  });

  it('max Pitch Pressure vortex pulls grounded threats once and never pulls aerial drones', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.player.abilities = { pressure: 5 };
    sim.debugSpawn('steward', sim.player.x + 150, sim.player.y);
    const grounded = sim.enemies.find((entry) => entry.active)!;
    sim.debugSpawn('drone', sim.player.x + 130, sim.player.y - 30);
    const drone = [...sim.enemies].reverse().find((entry) => entry.active)!;
    grounded.speed = drone.speed = 0;
    grounded.hp = grounded.maxHp = drone.hp = drone.maxHp = 9999;
    sim.player.pressureCd = 0;
    step(sim, 1);
    expect(grounded.kx).toBeLessThan(0);
    expect(drone.kx).toBe(0);
    const firstPull = grounded.kx;
    step(sim, 28);
    expect(grounded.kx).toBeGreaterThan(firstPull);
  });

  it('First Touch Blast damages grounded and airborne threats in separate layers', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.player.abilities = { blast: 1 };
    const groundedPos = far(sim, 120);
    const airbornePos = far(sim, 90, 0.7);
    sim.debugSpawn('steward', groundedPos.x, groundedPos.y);
    sim.debugSpawn('flare', airbornePos.x, airbornePos.y);
    const [grounded, airborne] = sim.enemies.filter((e) => e.active);
    for (const e of [grounded, airborne]) {
      e.speed = 0;
      e.hp = 500;
      e.maxHp = 500;
    }
    airborne.airT = 3;
    sim.player.blastCd = 0;
    step(sim, 1);
    expect(grounded.hp).toBeLessThan(500);
    expect(airborne.hp).toBeLessThan(500);
    expect(sim.rings.some((ring) => ring.active && ring.color === '#a8ff4d')).toBe(true);
    expect(sim.impacts.some((impact) => impact.active && impact.kind === 'blastair')).toBe(true);
  });

  it('First Touch Blast waits when an aerial threat is outside its smaller air radius', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.debugDirectorPaused = true;
    sim.player.abilities = { blast: 1 };
    sim.debugSpawn('drone', sim.player.x + 140, sim.player.y);
    const drone = sim.enemies.find((entry) => entry.active)!;
    drone.speed = 0;
    drone.hp = drone.maxHp = 500;
    sim.player.blastCd = 0;

    step(sim, 1);

    expect(drone.hp).toBe(500);
    expect(sim.player.blastCd).toBeCloseTo(0.16, 5);
    expect(sim.events.some((event) => event.type === 'blast')).toBe(false);
    expect(sim.impacts.some((impact) => impact.active && impact.kind === 'blastair')).toBe(false);
  });

  it('First Touch Blast renders only the layer it actually affects', () => {
    const groundSim = makeSim(3);
    clearField(groundSim);
    groundSim.debugDirectorPaused = true;
    groundSim.player.abilities = { blast: 1 };
    groundSim.debugSpawn('steward', groundSim.player.x + 100, groundSim.player.y);
    groundSim.enemies.find((entry) => entry.active)!.speed = 0;
    groundSim.player.blastCd = 0;
    step(groundSim, 1);
    expect(groundSim.rings.some((ring) => ring.active && ring.color === '#a8ff4d')).toBe(true);
    expect(groundSim.impacts.some((impact) => impact.active && impact.kind === 'blastair')).toBe(false);

    const airSim = makeSim(3);
    clearField(airSim);
    airSim.debugDirectorPaused = true;
    airSim.player.abilities = { blast: 1 };
    airSim.debugSpawn('drone', airSim.player.x + 90, airSim.player.y);
    airSim.enemies.find((entry) => entry.active)!.speed = 0;
    airSim.player.blastCd = 0;
    step(airSim, 1);
    expect(airSim.rings.some((ring) => ring.active && ring.color === '#a8ff4d')).toBe(false);
    expect(airSim.impacts.some((impact) => impact.active && impact.kind === 'blastair')).toBe(true);
  });

  it('max First Touch Blast omits a fake echo after its only target dies', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.debugDirectorPaused = true;
    sim.player.abilities = { blast: 5 };
    sim.debugSpawn('steward', sim.player.x + 100, sim.player.y);
    const target = sim.enemies.find((entry) => entry.active)!;
    target.speed = 0;
    target.hp = target.maxHp = 1;
    sim.player.blastCd = 0;

    step(sim, 1);
    expect(target.active).toBe(false);
    step(sim, 24);

    expect(sim.events.filter((event) => event.type === 'blast')).toHaveLength(1);
  });

  it('Pitch Pressure gets visual priority instead of stacking with Blast on one frame', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.debugDirectorPaused = true;
    sim.player.abilities = { pressure: 1, blast: 1 };
    sim.debugSpawn('steward', sim.player.x + 90, sim.player.y);
    const target = sim.enemies.find((entry) => entry.active)!;
    target.speed = 0;
    target.hp = target.maxHp = 9999;
    sim.player.pressureCd = 0;
    sim.player.blastCd = 0;

    step(sim, 1);

    expect(sim.pressures.some((ring) => ring.active)).toBe(true);
    expect(sim.events.some((event) => event.type === 'blast')).toBe(false);
    expect(sim.player.blastCd).toBeCloseTo(0.22, 5);
  });

  it('permanent aerial drones ignore ground rings but take hybrid close-blast damage', () => {
    const sim = makeSim(3);
    clearField(sim);
    sim.player.abilities = { pressure: 1 };
    const pos = far(sim, 92);
    sim.debugSpawn('drone', pos.x, pos.y);
    const drone = sim.enemies.find((e) => e.active)!;
    drone.speed = 0;
    drone.hp = drone.maxHp = 500;
    sim.player.pressureCd = 0;
    step(sim, 45);
    expect(drone.hp).toBe(500);

    sim.player.abilities = { blast: 1 };
    sim.player.blastCd = 0;
    step(sim, 1);
    expect(drone.hp).toBeLessThan(500);
  });

  it('AERIAL lobs connect with airborne enemies (no permanent immunities)', () => {
    const sim = makeSim(0); // Messi starts with strike
    clearField(sim);
    const pos = far(sim, 340);
    sim.debugSpawn('lobber', pos.x, pos.y);
    const e = sim.enemies.find((x) => x.active)!;
    e.speed = 0;
    e.hp = 500;
    e.maxHp = 500;
    sim.player.strikeCd = 0;
    step(sim, 14); // wind-up completes and lobs launch on contact
    e.airT = 3; // mid-leap when the ball lands
    step(sim, 90); // ~1.5s: balls land
    expect(e.hp).toBeLessThan(500);
  });

  it('heavy knockback launches enemies briefly airborne (then they land again)', () => {
    const sim = makeSim(1); // Ronaldo: whistle L1
    clearField(sim);
    const pos = far(sim, 100);
    sim.debugSpawn('invader', pos.x, pos.y);
    const e = sim.enemies.find((x) => x.active)!;
    e.speed = 0;
    sim.damageEnemy(sim.enemies.indexOf(e), 1, 400, 0); // heavy shove
    expect(e.airT).toBeGreaterThan(0);
    step(sim, 60); // 1s later: landed
    expect(e.airT).toBe(0);
  });

  it('ordinary Precision Strike footballs damage only their locked target', () => {
    const sim = makeSim(2);
    clearField(sim);
    sim.player.abilities = { strike: 1 };
    sim.debugSpawn('lobber', far(sim, 360).x, sim.player.y);
    sim.debugSpawn('lobber', far(sim, 400).x, sim.player.y + 40);
    const pair = sim.enemies.filter((e) => e.active);
    for (const e of pair) {
      e.speed = 0;
      e.hp = 400;
      e.maxHp = 400;
    }
    sim.player.strikeCd = 0;
    step(sim, 100);
    // One ball lands between a tight pair, but the untargeted neighbour is safe.
    const hurt = pair.filter((e) => e.hp < 400).length;
    expect(hurt).toBe(1);
  });
});
