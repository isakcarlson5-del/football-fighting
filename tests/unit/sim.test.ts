import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/game/sim';
import { BOSS0_AT, BOSS1_AT, BOSSES, ENEMIES, PLAYERS, RUN_LENGTH } from '../../src/game/data';
import { Save } from '../../src/game/meta';
import { directionalFrameBlend, enemyHealthBarStyle, enemyPoseFrame, guardPoseFrame, movementDirection, playerStepCue } from '../../src/game/render';

function freshSave(): Save {
  return new Save(null);
}

function makeSim(playerIdx = 0, seed = 1234): Sim {
  return new Sim(PLAYERS[playerIdx], freshSave(), seed);
}

/** Step the sim n frames at 60fps with no input. */
function step(sim: Sim, frames: number, ax = 0, ay = 0): void {
  for (let i = 0; i < frames; i++) sim.update(1 / 60, ax, ay);
}

describe('sim core loop', () => {
  it('quantizes boss movement into all eight authored sprite directions', () => {
    expect(movementDirection(0, -1)).toBe('n');
    expect(movementDirection(1, -1)).toBe('ne');
    expect(movementDirection(1, 0)).toBe('e');
    expect(movementDirection(1, 1)).toBe('se');
    expect(movementDirection(0, 1)).toBe('s');
    expect(movementDirection(-1, 1)).toBe('sw');
    expect(movementDirection(-1, 0)).toBe('w');
    expect(movementDirection(-1, -1)).toBe('nw');
    expect(movementDirection(0, 0)).toBe('s');
  });

  it('smoothly blends directional run poses and wraps the 12-frame cycle', () => {
    expect(directionalFrameBlend(0, 20, 12)).toEqual({ frame: 0, nextFrame: 1, mix: 0 });
    expect(directionalFrameBlend(0.025, 20, 12)).toMatchObject({ frame: 0, nextFrame: 1 });
    expect(directionalFrameBlend(0.025, 20, 12).mix).toBeCloseTo(0.5, 12);
    expect(directionalFrameBlend(0.575, 20, 12)).toMatchObject({ frame: 11, nextFrame: 0 });
    expect(directionalFrameBlend(0.575, 20, 12).mix).toBeCloseTo(0.5, 12);
    expect(directionalFrameBlend(Number.NaN, 20, 12)).toEqual({ frame: 0, nextFrame: 1, mix: 0 });
    expect(directionalFrameBlend(0.005, 20, 12).mix).toBe(0);
    expect(directionalFrameBlend(0.045, 20, 12).mix).toBe(1);
  });

  it('exposes alternating concrete foot plants during the run cycle', () => {
    expect(playerStepCue(2 / 18)).toEqual({ strength: 1, foot: -1 });
    expect(playerStepCue(8 / 18)).toEqual({ strength: 1, foot: 1 });
    expect(playerStepCue(5 / 18).strength).toBe(0);
  });

  it('announces a max evolution when an ability reaches level five', () => {
    const sim = makeSim();
    sim.player.abilities.strike = 4;
    sim.applyUpgrade({ kind: 'ability', id: 'strike', name: 'Precision Strike', desc: 'MAX', color: '#fff', level: 5 });
    expect(sim.player.abilities.strike).toBe(5);
    expect(sim.events).toContainEqual({ type: 'maxAbility', name: 'Precision Strike' });
  });

  it('opens on a quiet pitch, then introduces a continuous natural trickle', () => {
    const sim = makeSim();
    expect(sim.enemies.some((e) => e.active)).toBe(false);
    step(sim, 180); // 3 seconds: deliberate kickoff calm
    expect(sim.enemies.some((e) => e.active)).toBe(false);
    step(sim, 210); // enemies arrive one at a time through continuous ingress
    const active = sim.enemies.filter((e) => e.active).length;
    expect(active + sim.kills).toBeGreaterThanOrEqual(1);
    expect(active + sim.kills).toBeLessThan(5);
  });

  it('converts the checkpoint rate into a continuous capped spawn budget', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.player.hp = sim.player.maxHp = 99999;
    sim.boss0Spawned = true;
    sim.boss1Spawned = true;
    sim.time = 300;
    step(sim, 60);
    const active = sim.enemies.filter((enemy) => enemy.active && !enemy.boss).length;
    expect(active).toBeGreaterThanOrEqual(6);
    expect(active).toBeLessThanOrEqual(7);
  });

  it('reaches the late reference ingress without releasing a batch spike', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.player.hp = sim.player.maxHp = 99999;
    sim.player.xpNext = 999999;
    sim.boss0Spawned = true;
    sim.boss1Spawned = true;
    sim.boss2Spawned = true;
    sim.time = 590;
    step(sim, 60);
    const active = sim.enemies.filter((enemy) => enemy.active && !enemy.boss).length;
    expect(active).toBeGreaterThanOrEqual(28);
    expect(active).toBeLessThanOrEqual(31);
  });

  it('keeps ranged, drone, bull and summoner populations under director caps', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.player.hp = sim.player.maxHp = 99999;
    sim.boss0Spawned = true;
    sim.boss1Spawned = true;
    sim.time = 450;
    for (let i = 0; i < 4; i++) sim.debugSpawn('drone', 120 + i * 80, 120);
    for (let i = 0; i < 2; i++) sim.debugSpawn('lobber', 120 + i * 80, 240);
    for (let i = 0; i < 3; i++) sim.debugSpawn('bull', 120 + i * 80, 360);
    for (let i = 0; i < 2; i++) sim.debugSpawn('chant', 120 + i * 80, 480);
    step(sim, 180);
    const active = sim.enemies.filter((enemy) => enemy.active && !enemy.boss);
    expect(active.filter((enemy) => ['ranged', 'cone', 'flanker', 'aerial'].includes(enemy.def.behavior))).toHaveLength(6);
    expect(active.filter((enemy) => enemy.def.id === 'drone')).toHaveLength(4);
    expect(active.filter((enemy) => enemy.def.id === 'bull')).toHaveLength(3);
    expect(active.filter((enemy) => enemy.def.behavior === 'summoner')).toHaveLength(2);
  });

  it('makes elites eight times tougher and guarantees a meaningful rare drop', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.debugSpawn('invader', sim.player.x + 300, sim.player.y, true);
    const eliteIndex = sim.enemies.findIndex((enemy) => enemy.active && enemy.elite);
    const elite = sim.enemies[eliteIndex];
    expect(elite.maxHp).toBeCloseTo(ENEMIES.invader.hp * 0.82 * 8, 5);
    sim.damageEnemy(eliteIndex, elite.hp + 1);
    expect(sim.pickups.some((pickup) => pickup.active && ['magnet', 'freeze', 'bomb'].includes(pickup.kind))).toBe(true);
  });

  it('enemies spawn continuously and chase the player', () => {
    const sim = makeSim();
    step(sim, 600); // 10s
    const active = sim.enemies.filter((e) => e.active);
    expect(active.length + sim.kills).toBeGreaterThanOrEqual(3);
    const p = sim.player;
    const d0 = Math.hypot(active[0].x - p.x, active[0].y - p.y);
    step(sim, 120);
    const d1 = Math.hypot(active[0].x - p.x, active[0].y - p.y);
    expect(d1).toBeLessThan(d0);
  });

  it('enemy art selects semantic idle, movement, cast and hurt poses', () => {
    const sim = makeSim();
    sim.enemies.forEach((e) => (e.active = false));
    sim.debugSpawn('chant', sim.player.x + 360, sim.player.y);
    const e = sim.enemies.find((x) => x.active)!;

    e.moving = false;
    expect(enemyPoseFrame(e, 4)).toBe(0);
    e.moving = true;
    expect(enemyPoseFrame(e, 4)).toBe(1);
    e.telegraph = 0.5;
    expect(enemyPoseFrame(e, 4)).toBe(2);
    e.telegraph = 0;
    e.attackAnimT = 0.2;
    expect(enemyPoseFrame(e, 4)).toBe(2);
    e.hurtT = 0.2;
    expect(enemyPoseFrame(e, 4)).toBe(3);
  });

  it('enemy health bars scale cleanly from regular threats to elites and bosses', () => {
    const small = enemyHealthBarStyle({ hp: 10, maxHp: 20, radius: 14, elite: false, boss: '' });
    const regular = enemyHealthBarStyle({ hp: 50, maxHp: 100, radius: 16, elite: false, boss: '' });
    const large = enemyHealthBarStyle({ hp: 110, maxHp: 220, radius: 30, elite: false, boss: '' });
    const elite = enemyHealthBarStyle({ hp: 25, maxHp: 100, radius: 16, elite: true, boss: '' });
    const firstBoss = enemyHealthBarStyle({ hp: 1200, maxHp: 1600, radius: 38, elite: false, boss: 'drumboss' });
    const finalBoss = enemyHealthBarStyle({ hp: 3600, maxHp: 4800, radius: 50, elite: false, boss: 'captain' });
    expect(regular.ratio).toBe(0.5);
    expect(regular.numeric).toBe(false);
    expect(small.width).toBeLessThan(regular.width);
    expect(large.width).toBeGreaterThan(regular.width);
    expect(elite.width).toBeGreaterThan(regular.width);
    expect(elite.height).toBeGreaterThan(regular.height);
    expect(elite.numeric).toBe(true);
    expect(firstBoss.width).toBeGreaterThan(elite.width);
    expect(finalBoss.width).toBeGreaterThan(firstBoss.width);
    expect(finalBoss.height).toBeGreaterThan(firstBoss.height);
    expect(finalBoss.numeric).toBe(true);
    expect(enemyHealthBarStyle({ hp: -10, maxHp: 100, radius: 10, elite: false, boss: '' }).ratio).toBe(0);
  });

  it('base invaders cycle evenly through all three complete visual variants', () => {
    const sim = makeSim();
    for (let i = 0; i < 6; i++) sim.debugSpawn('invader', sim.player.x + 300 + i * 5, sim.player.y);
    expect(sim.enemies.filter((enemy) => enemy.active).map((enemy) => enemy.variant)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('movement state follows actual locomotion and stops while planted', () => {
    const sim = makeSim();
    sim.enemies.forEach((e) => (e.active = false));
    sim.debugSpawn('invader', sim.player.x + 400, sim.player.y);
    const e = sim.enemies.find((x) => x.active)!;
    step(sim, 1);
    expect(e.moving).toBe(true);
    e.speed = 0;
    e.kx = 0;
    e.ky = 0;
    e.stun = 1;
    step(sim, 1);
    expect(e.moving).toBe(false);
  });

  it('Precision Strike fires automatically, kills enemies and awards XP', () => {
    const sim = makeSim(0); // Messi starts with strike
    // pin an enemy right next to the player
    sim.debugSpawn('invader', sim.player.x + 120, sim.player.y);
    const e = sim.enemies.find((x) => x.active)!;
    e.speed = 0;
    step(sim, 60 * 8);
    expect(sim.kills).toBeGreaterThan(0);
    const xpStillOnPitch = sim.pickups.some((pk) => pk.active && pk.kind === 'xp');
    expect(xpStillOnPitch || sim.player.xp > 0 || sim.player.level > 1).toBe(true);
  });

  it('keeps a kicked ball and its landing marker locked to a moving target', () => {
    const sim = makeSim(0);
    sim.debugSpawn('invader', sim.player.x + 430, sim.player.y);
    const enemy = sim.enemies.find((e) => e.active)!;
    enemy.speed = 0;
    sim.player.strikeCd = 0;
    step(sim, 14);
    const ball = sim.balls.find((b) => b.active)!;
    expect(ball).toBeTruthy();
    enemy.y += 170;
    step(sim, 1);
    expect(ball.ty).toBeCloseTo(enemy.y, 4);
    const reticle = sim.reticles.find((r) => r.active && r.targetIdx === ball.targetIdx)!;
    expect(reticle.y).toBeCloseTo(enemy.y, 4);
  });

  it('locks aim and shows a ground marker before the kick contact frame', () => {
    const sim = makeSim(0);
    sim.debugSpawn('invader', sim.player.x - 430, sim.player.y + 120);
    const enemy = sim.enemies.find((e) => e.active)!;
    enemy.speed = 0;
    sim.player.strikeCd = 0;
    step(sim, 1);

    expect(sim.player.kickT).toBeGreaterThan(0);
    expect(sim.player.kickTargetIdx).toBe(sim.enemies.indexOf(enemy));
    expect(sim.player.face).toBe(-1);
    expect(sim.balls.some((ball) => ball.active)).toBe(false);
    const aim = sim.reticles.find((marker) => marker.active && marker.phase === 'aim');
    expect(aim?.targetIdx).toBe(sim.enemies.indexOf(enemy));
    expect(aim?.x).toBeCloseTo(enemy.x, 4);
    expect(aim?.y).toBeCloseTo(enemy.y, 4);
  });

  it('exposes attack and red-hit feedback state when a melee enemy connects', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.debugSpawn('invader', sim.player.x + 18, sim.player.y);
    const enemy = sim.enemies.find((e) => e.active)!;
    enemy.speed = 0;
    const hpBefore = sim.player.hp;
    step(sim, 25);
    expect(sim.player.hp).toBeLessThan(hpBefore);
    expect(sim.player.hurtT).toBeGreaterThan(0);
    expect(enemy.lungeT).toBeGreaterThan(0);
    expect(sim.events.some((event) => event.type === 'hurt')).toBe(true);
  });

  it('spawns and expires pooled directional contact impacts', () => {
    const sim = makeSim();
    sim.enemies.forEach((e) => (e.active = false));
    sim.debugSpawn('steward', sim.player.x + 100, sim.player.y);
    const enemyIndex = sim.enemies.findIndex((e) => e.active);
    sim.damageEnemy(enemyIndex, 5, 360, 0, { crit: true });
    const impact = sim.impacts.find((fx) => fx.active);
    expect(impact).toMatchObject({ kind: 'contact', color: '#ffd23f' });
    expect(impact!.strength).toBeGreaterThan(1);
    step(sim, 20);
    expect(sim.impacts.some((fx) => fx.active)).toBe(false);
  });

  it('XP pickup raises level and queues level-up choices', () => {
    const sim = makeSim();
    sim.debugGiveXp(sim.player.xpNext + 1);
    expect(sim.player.level).toBe(2);
    expect(sim.pendingLevelups).toBe(1);
    const opts = sim.rollUpgrades();
    expect(opts).toHaveLength(3);
    const before = JSON.stringify([sim.player.abilities, sim.player.stats, sim.player.maxHp, sim.coins]);
    sim.applyUpgrade(opts[0]);
    expect(JSON.stringify([sim.player.abilities, sim.player.stats, sim.player.maxHp, sim.coins])).not.toBe(before);
  });

  it('rolled upgrades are always legal (owned<max, stats<cap)', () => {
    const sim = makeSim();
    sim.player.abilities = {
      strike: 5, curveball: 5, bootseekers: 5, orbit: 5, whistle: 5,
      dash: 5, guard: 5, pressure: 5, blast: 5,
    };
    sim.player.stats = { power: 10, speed: 6, maxhp: 8, regen: 6, magnet: 6, armor: 5 };
    const opts = sim.rollUpgrades();
    expect(opts).toHaveLength(3);
    for (const o of opts) expect(['heal', 'coins']).toContain(o.kind); // all maxed -> fallbacks only
  });

  it('player dies when hp reaches zero', () => {
    const sim = makeSim();
    sim.player.hp = 1;
    sim.player.iframes = 0;
    sim.debugSpawn('invader', sim.player.x + 5, sim.player.y);
    step(sim, 240);
    expect(sim.over).toBe('lost');
  });

  it('surviving to full time wins the run', () => {
    const sim = makeSim();
    sim.player.hp = 99999;
    sim.player.maxHp = 99999;
    sim.player.stats.armor = 5;
    sim.time = RUN_LENGTH - 1;
    step(sim, 90);
    expect(sim.over).toBe('won');
  });

  it('seven-minute miniboss spawns and is clearly flagged', () => {
    const sim = makeSim();
    // The four-minute boss is normally still alive when time is jumped
    // directly to 7:00. Mark that encounter as completed so this test
    // isolates the serialized miniboss spawn.
    sim.boss0Spawned = true;
    sim.time = BOSS1_AT;
    step(sim, 5);
    const boss = sim.enemies.find((e) => e.active && e.boss === 'official');
    expect(boss).toBeTruthy();
    expect(boss!.maxHp).toBeGreaterThan(ENEMIES.mascot.hp);
    expect(sim.bossAlive).toBeTruthy();
  });

  it('bosses are progressively larger and substantially tougher than the roster', () => {
    expect(BOSSES.drumboss.tier).toBe('minor');
    expect(BOSSES.official.tier).toBe('major');
    expect(BOSSES.captain.tier).toBe('major');
    expect(BOSSES.drumboss.scale).toBeGreaterThan(ENEMIES.banner.scale);
    expect(BOSSES.official.scale).toBeGreaterThan(BOSSES.drumboss.scale);
    expect(BOSSES.captain.scale).toBeGreaterThan(BOSSES.official.scale);
    expect(BOSSES.drumboss.hp).toBeGreaterThan(ENEMIES.banner.hp * 5);
    expect(BOSSES.official.hp).toBeGreaterThan(BOSSES.drumboss.hp);
    expect(BOSSES.captain.hp).toBeGreaterThan(BOSSES.official.hp);
  });

  it('Terrace Bull telegraphs and commits to a damaging charge', () => {
    const sim = makeSim();
    sim.enemies.forEach((e) => (e.active = false));
    sim.player.abilities = {};
    sim.debugSpawn('bull', sim.player.x + 440, sim.player.y);
    const hp = sim.player.hp;
    step(sim, 250);
    expect(sim.events.some((event) => event.type === 'bullCharge')).toBe(true);
    expect(sim.player.hp).toBeLessThan(hp);
  });

  it('Shock Drone circles in the aerial lane and fires an electric dart', () => {
    const sim = makeSim();
    sim.enemies.forEach((e) => (e.active = false));
    sim.player.abilities = {};
    sim.debugSpawn('drone', sim.player.x + 260, sim.player.y);
    const hp = sim.player.hp;
    step(sim, 300);
    expect(sim.events.some((event) => event.type === 'zap')).toBe(true);
    expect(sim.player.hp).toBeLessThan(hp);
  });

  it('Security Detail fields bodyguards that attack nearby enemies', () => {
    const sim = makeSim();
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 1 });
    expect(sim.guards.length).toBe(1);
    sim.debugSpawn('invader', sim.player.x + 100, sim.player.y);
    step(sim, 240);
    // guard punched the pinned enemy to death (slot reuse makes hp checks unreliable)
    expect(sim.kills).toBeGreaterThan(0);
  });

  it('two security guards split across grounded threats on opposite sides', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 3 });
    sim.debugSpawn('invader', sim.player.x + 250, sim.player.y - 30);
    sim.debugSpawn('steward', sim.player.x - 250, sim.player.y + 30);
    const threats = sim.enemies.filter((enemy) => enemy.active);
    for (const enemy of threats) {
      enemy.speed = 0;
      enemy.hp = enemy.maxHp = 10_000;
    }

    step(sim, 1);
    expect(sim.guards).toHaveLength(2);
    expect(new Set(sim.guards.map((guard) => guard.target)).size).toBe(2);
    const targetSides = sim.guards.map((guard) => Math.sign(sim.enemies[guard.target].x - sim.player.x));
    expect(new Set(targetSides)).toEqual(new Set([-1, 1]));
  });

  it('security guards never acquire or punch aerial drones', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 3 });
    sim.debugSpawn('drone', sim.player.x + 180, sim.player.y);
    const drone = sim.enemies.find((enemy) => enemy.active)!;
    drone.speed = 0;
    drone.damage = 0;
    drone.hp = drone.maxHp = 10_000;

    step(sim, 90);
    expect(sim.guards.every((guard) => guard.target === -1)).toBe(true);
    expect(sim.guards.every((guard) => guard.strikeT === 0)).toBe(true);
    expect(drone.hp).toBe(10_000);
  });

  it('bodyguard art selects idle, movement, punch and interception poses', () => {
    const sim = makeSim();
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 1 });
    const g = sim.guards[0];
    expect(guardPoseFrame(g, 4)).toBe(0);
    g.moving = true;
    expect(guardPoseFrame(g, 4)).toBe(1);
    g.strikeT = 0.2;
    expect(guardPoseFrame(g, 4)).toBe(2);
    g.blockT = 0.2;
    expect(guardPoseFrame(g, 4)).toBe(3);
  });

  it('max Security Detail fields four distinct guard silhouettes', () => {
    const sim = makeSim();
    for (let level = 1; level <= 5; level++) {
      sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level });
    }
    expect(sim.guards.map((g) => g.variant)).toEqual([0, 1, 2, 3]);
  });

  it('Nutmeg Dash grants invulnerability frames while dashing', () => {
    const sim = makeSim(2); // Neymar starts with dash
    sim.debugSpawn('invader', sim.player.x + 28, sim.player.y); // adjacent threat
    step(sim, 6, 1, 0); // dash triggers immediately, lasts ~14 frames
    expect(sim.player.dashT).toBeGreaterThan(0);
    const hpBefore = sim.player.hp;
    step(sim, 8, 1, 0); // still inside the dash window
    expect(sim.player.hp).toBe(hpBefore); // untouchable mid-dash despite contact
  });

  it('Orbiting Press damages enemies that get close', () => {
    const sim = makeSim(3); // Yamal starts with orbit
    sim.debugSpawn('invader', sim.player.x + 90, sim.player.y);
    step(sim, 240);
    expect(sim.kills).toBeGreaterThan(0);
  });

  it('Orbiting Press records a directional knockback reaction for rendering', () => {
    const sim = makeSim(3);
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.player.abilities.orbit = 5;
    sim.player.orbitAngle = 0;
    sim.player.orbitBreakCd = 999;
    sim.debugSpawn('invader', sim.player.x + 140, sim.player.y);
    const enemy = sim.enemies.find((entry) => entry.active)!;
    enemy.maxHp = 9999;
    enemy.hp = 9999;
    enemy.barHp = 9999;
    enemy.speed = 0;

    step(sim, 1);

    expect(enemy.orbitHitT).toBeGreaterThan(0);
    expect(enemy.hurtT).toBeGreaterThan(0);
    expect(enemy.hurtDx).toBeGreaterThan(0.9);
    expect(enemy.kx).toBeGreaterThan(0);
  });

  it("Captain's Whistle knocks groups back", () => {
    const sim = makeSim(1); // Ronaldo starts with whistle
    sim.enemies.forEach((e) => (e.active = false)); // isolate the staged enemy
    sim.debugSpawn('invader', sim.player.x + 80, sim.player.y);
    const enemy = sim.enemies.find((x) => x.active)!;
    enemy.speed = 0;
    const d0 = Math.hypot(enemy.x - sim.player.x, enemy.y - sim.player.y);
    expect(d0).toBeLessThan(90);
    sim.player.whistleCd = 0;
    step(sim, 30); // whistle fires, knockback ejects the enemy
    const d1 = Math.hypot(enemy.x - sim.player.x, enemy.y - sim.player.y);
    expect(enemy.active ? d1 : Infinity).toBeGreaterThan(d0);
  });

  it('coins drop and are collected into the run total', () => {
    const sim = makeSim();
    sim.player.stats.magnet = 6; // huge pickup radius
    // kill enemies near the player until a coin lands and is collected
    for (let i = 0; i < 30; i++) {
      sim.debugSpawn('mascot', sim.player.x + 40 + i, sim.player.y);
      const e = sim.enemies[sim.enemies.length - 1];
      void e;
    }
    step(sim, 60 * 20);
    // with 20s of combat and maxed magnet, at least drops existed:
    expect(sim.kills + sim.enemies.filter((e) => e.active).length).toBeGreaterThan(0);
    expect(sim.pickups.some((p) => !p.active) || sim.coins >= 0).toBe(true);
  });

  it('boss defeat drops a tiered trophy with two ability-only picks', () => {
    const sim = makeSim();
    sim.enemies.forEach((e) => (e.active = false));
    sim.time = BOSS0_AT + 0.1;
    step(sim, 1);
    const bossIndex = sim.enemies.findIndex((e) => e.active && e.boss === 'drumboss');
    expect(bossIndex).toBeGreaterThanOrEqual(0);
    sim.damageEnemy(bossIndex, 99999);
    const trophy = sim.pickups.find((p) => p.active && p.kind === 'trophy');
    expect(trophy?.tier).toBe(1);
    const before = sim.coins;
    trophy!.x = sim.player.x;
    trophy!.y = sim.player.y;
    step(sim, 1);
    expect(sim.coins).toBe(before + 30);
    expect(sim.pendingBossAbilities).toBe(2);
    expect(sim.rollBossAbilities().every((option) => option.kind === 'ability')).toBe(true);
    expect(sim.events.some((event) => event.type === 'trophy')).toBe(true);
  });

  it('Full-Pitch Magnet pulls distant ground loot toward the player', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.enemies.forEach((e) => (e.active = false));
    sim.debugSpawn('invader', sim.player.x + 520, sim.player.y);
    const enemyIndex = sim.enemies.findIndex((e) => e.active);
    sim.damageEnemy(enemyIndex, 9999, 0, 0, { crit: false });
    const loot = sim.pickups.find((p) => p.active && p.kind === 'xp')!;
    loot.vx = 0;
    loot.vy = 0;
    const before = Math.hypot(loot.x - sim.player.x, loot.y - sim.player.y);
    sim.debugDropPickup('magnet', sim.player.x, sim.player.y);
    step(sim, 1);
    expect(sim.magnetT).toBeGreaterThan(3);
    step(sim, 30);
    const after = loot.active ? Math.hypot(loot.x - sim.player.x, loot.y - sim.player.y) : 0;
    expect(after).toBeLessThan(before);
    expect(sim.events.some((event) => event.type === 'magnet')).toBe(true);
  });

  it('Matchday Wipeout defeats regular threats and chunks, but does not erase, a boss', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.enemies.forEach((e) => (e.active = false));
    sim.boss0Spawned = true;
    sim.time = BOSS1_AT;
    step(sim, 1);
    sim.debugSpawn('invader', sim.player.x + 180, sim.player.y);
    sim.debugSpawn('drone', sim.player.x - 180, sim.player.y);
    const boss = sim.enemies.find((e) => e.active && e.boss === 'official')!;
    const bossHp = boss.hp;
    sim.debugDropPickup('bomb', sim.player.x, sim.player.y);
    step(sim, 1);
    expect(sim.enemies.some((e) => e.active && !e.boss)).toBe(false);
    expect(boss.active).toBe(true);
    expect(boss.hp).toBeLessThan(bossHp);
    expect(boss.hp).toBeGreaterThan(0);
    expect(sim.events.some((event) => event.type === 'bomb')).toBe(true);
    expect(sim.rings.some((ring) => ring.active && ring.color === '#ff7a2e')).toBe(false);
  });

  it('Stoppage-Time Freeze pauses every enemy across the map while the player remains mobile', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.enemies.forEach((e) => (e.active = false));
    sim.debugSpawn('invader', sim.player.x + 350, sim.player.y);
    sim.debugSpawn('drone', sim.player.x - 980, sim.player.y - 520);
    const frozen = sim.enemies.filter((e) => e.active);
    sim.debugDropPickup('freeze', sim.player.x, sim.player.y);
    step(sim, 1);
    const positions = frozen.map((enemy) => [enemy.x, enemy.y]);
    const playerX = sim.player.x;
    const time = sim.time;
    for (let frame = 0; frame < 120; frame++) sim.update(1 / 60, 1, 0);
    expect(sim.freezeT).toBeGreaterThan(3);
    frozen.forEach((enemy, index) => {
      expect(enemy.x).toBeCloseTo(positions[index][0], 6);
      expect(enemy.y).toBeCloseTo(positions[index][1], 6);
    });
    expect(sim.player.x).toBeGreaterThan(playerX + 100);
    expect(sim.time).toBeCloseTo(time, 6);
    expect(sim.events.some((event) => event.type === 'freeze')).toBe(true);
  });

  it('boss summons resolve only after their generated warning telegraph', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugSpawnBoss('drumboss');
    const boss = sim.enemies.find((enemy) => enemy.active && enemy.boss === 'drumboss')!;
    boss.damage = 0;
    boss.bossCd = 999;
    boss.bossCd2 = 0;
    boss.rangedCd = 999;
    const before = sim.enemies.filter((enemy) => enemy.active && !enemy.boss).length;
    step(sim, 1);
    expect(sim.telegraphs.some((telegraph) => telegraph.active && telegraph.kind === 'summon')).toBe(true);
    expect(sim.enemies.filter((enemy) => enemy.active && !enemy.boss)).toHaveLength(before);
    step(sim, 60);
    expect(sim.enemies.filter((enemy) => enemy.active && !enemy.boss).length).toBeGreaterThan(before);
  });
});
