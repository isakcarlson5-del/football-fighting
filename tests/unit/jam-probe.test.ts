import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/game/sim';
import { PLAYERS } from '../../src/game/data';
import { Save } from '../../src/game/meta';

function freshSave(): Save {
  return new Save(null);
}

function makeSim(playerIdx = 0, seed = 1234): Sim {
  return new Sim(PLAYERS[playerIdx], freshSave(), seed);
}

function step(sim: Sim, frames: number, ax = 0, ay = 0): void {
  for (let i = 0; i < frames; i++) sim.update(1 / 60, ax, ay);
}

describe('dense horde', () => {
  it('a tight 24-pack unjams and keeps pressing the player', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.enemies.forEach((e) => (e.active = false));
    const p = sim.player;
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 4; col++) {
        sim.debugSpawn('invader', p.x - 500 + col * 46, p.y - 92 + row * 38);
      }
    }
    expect(sim.enemies.filter((e) => e.active)).toHaveLength(24);
    const meanSpread = () => {
      const pts = sim.enemies.filter((e) => e.active);
      let total = 0;
      let pairs = 0;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          total += Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
          pairs++;
        }
      }
      return total / pairs;
    };
    const minDist = () => Math.min(...sim.enemies.filter((e) => e.active).map((e) => Math.hypot(e.x - p.x, e.y - p.y)));
    const startSpread = meanSpread();
    const startMin = minDist();
    step(sim, 240); // 4s
    const endSpread = meanSpread();
    const endMin = minDist();
    // The spacing cap keeps the soft spring below the chase speed, so a
    // crowded horde opens up instead of locking into a jammed clump.
    expect(endMin).toBeLessThan(startMin);
    expect(endSpread).toBeGreaterThan(startSpread);
  });
});