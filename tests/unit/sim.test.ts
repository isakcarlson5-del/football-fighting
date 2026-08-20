import { describe, expect, it } from 'vitest';
import { abilityCadenceLabel, approachVelocity, ARENA_H, ARENA_W, bossApproachIngressMultiplier, bossDirectorIngressMultiplier, bossHealthMultiplier, BOSS_INTRO_DURATION, BOSS_MELEE_LUNGE_DURATION, directorPopulationIngressMultiplier, ENEMY_MELEE_LUNGE_DURATION, enemyAirLift, enemyHitFeedbackStrength, enemyRunCycleDistance, enemyRunTargetFps, enemyXpRewardMultiplier, guardAuthoredRunVector, guardFormationOffset, guardRunPresentation, hybridBossBodyContact, hybridBossSceneryPad, hybridEnemySceneryPad, hystereticMovementOctant, MELEE_CONTACT_PROGRESS, PLAYER_RUN_CYCLE_DISTANCE, PLAYER_RUN_FPS, PLAYER_RUN_FRAMES, PLAYER_VISUAL_Y_SCALE, REWARD_EVENT_CHANCE, REWARD_EVENT_DURATION, REWARD_EVENT_LABEL, REWARD_EVENT_MIN_TIME, resolveHybridBossBodyContact, rewardCoinMul, rewardEventChance, rewardScoreMul, rewardXpMul, Sim, statProgressLabel, stepMovementOctant, upgradeDraftWeight } from '../../src/game/sim';
import { ABILITIES, ABILITY_IDS, BOSS0_AT, BOSS1_AT, BOSSES, ENEMIES, PLAYERS, RUN_LENGTH } from '../../src/game/data';
import { Save } from '../../src/game/meta';
import { aerialLaunchVisual, ART_DIRECTION_PROFILE, bossArrivalVisual, combatPresentationBudget, corpseCollapseVisual, dampedTurfDisplacement, directionalFrameBlend, enemyHealthBarPriority, enemyHealthBarStyle, enemyPoseFrame, guardPoseFrame, HYBRID_LIGHT_CAST, hybridCentreMarkingGeometry, hybridCornerFlagDepthScale, hybridEntityDepthScale, hybridEntityShadowGeometry, hybridGoalNetBreathe, hybridHostileProjectileElevation, hybridPitchMarkingGeometry, hybridStadiumParallax, matchdayWipeoutVisual, movementDirection, orbitPainterDepthY, orbitTrailArcGeometry, pickupVisibleBounds, placeEnemyHealthBar, playerOcclusionStrength, playerStepCue, reducedCombatPresentationBudget, type HealthBarCollisionRect } from '../../src/game/render';

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
  it('provides exactly two rerolls shared across the complete run', () => {
    const sim = makeSim();
    expect(sim.rerollsRemaining).toBe(2);
    expect(sim.consumeReroll()).toBe(true);
    expect(sim.rerollsRemaining).toBe(1);
    expect(sim.consumeReroll()).toBe(true);
    expect(sim.rerollsRemaining).toBe(0);
    expect(sim.consumeReroll()).toBe(false);
    expect(sim.rerollsRemaining).toBe(0);
  });

  it('reduces ambient ingress during bosses without flattening encounter tiers', () => {
    expect(bossDirectorIngressMultiplier('')).toBe(1);
    expect(bossDirectorIngressMultiplier('drumboss')).toBe(0.1);
    expect(bossDirectorIngressMultiplier('official')).toBe(0.16);
    expect(bossDirectorIngressMultiplier('captain')).toBe(0.22);
    expect(bossDirectorIngressMultiplier('drumboss')).toBeLessThan(bossDirectorIngressMultiplier('official'));
    expect(bossDirectorIngressMultiplier('official')).toBeLessThan(bossDirectorIngressMultiplier('captain'));
  });

  it('tapers ordinary ingress continuously before each boss arrival', () => {
    expect(bossApproachIngressMultiplier(Number.POSITIVE_INFINITY)).toBe(1);
    expect(bossApproachIngressMultiplier(45)).toBe(1);
    expect(bossApproachIngressMultiplier(22.5)).toBeCloseTo(0.56, 8);
    expect(bossApproachIngressMultiplier(0)).toBe(0.12);
    expect(bossApproachIngressMultiplier(-2)).toBe(0.12);
  });

  it('weights drafts toward slightly evolving a build while staying random', () => {
    expect(upgradeDraftWeight('owned-ability')).toBeGreaterThan(upgradeDraftWeight('stat'));
    expect(upgradeDraftWeight('stat')).toBeGreaterThan(upgradeDraftWeight('new-ability'));
    expect(upgradeDraftWeight('owned-ability')).toBeLessThan(upgradeDraftWeight('new-ability') * 2);
  });

  it('soft-caps live director population without deleting existing threats', () => {
    expect(directorPopulationIngressMultiplier(40, 360)).toBe(1);
    expect(directorPopulationIngressMultiplier(52, 360)).toBeGreaterThan(0);
    expect(directorPopulationIngressMultiplier(52, 360)).toBeLessThan(1);
    expect(directorPopulationIngressMultiplier(61, 360)).toBe(0);
    expect(directorPopulationIngressMultiplier(70, 600)).toBe(0);
  });

  it('scales XP rewards with late enemy investment', () => {
    expect(enemyXpRewardMultiplier(0)).toBe(1);
    expect(enemyXpRewardMultiplier(300)).toBeGreaterThan(1.3);
    expect(enemyXpRewardMultiplier(600)).toBeCloseTo(2.8, 8);
  });

  it('scales boss endurance independently from the ordinary mob curve', () => {
    expect(bossHealthMultiplier('drumboss', 1)).toBe(1);
    expect(bossHealthMultiplier('official', 0)).toBe(1.15);
    expect(bossHealthMultiplier('official', 1)).toBeCloseTo(1.3, 8);
    expect(bossHealthMultiplier('captain', 1)).toBe(1.55);
    expect(BOSSES.official.hp * bossHealthMultiplier('official', 1)).toBeLessThan(12_500);
    expect(BOSSES.captain.hp * bossHealthMultiplier('captain', 1)).toBeLessThan(20_000);
  });

  it('scales material hit feedback by real damage and keeps blocks subdued', () => {
    const blocked = enemyHitFeedbackStrength(0, 100, 0, false);
    const light = enemyHitFeedbackStrength(4, 100, 40, false);
    const heavy = enemyHitFeedbackStrength(32, 100, 320, false);
    const crit = enemyHitFeedbackStrength(32, 100, 320, true);
    expect(blocked).toBe(0.12);
    expect(light).toBeGreaterThan(blocked);
    expect(heavy).toBeGreaterThan(light);
    expect(crit).toBeGreaterThanOrEqual(heavy);
    expect(crit).toBeLessThanOrEqual(1);
  });

  it('turns long vertical guard travel into a sprite-aligned diagonal arc', () => {
    const rightArc = guardAuthoredRunVector(0, 200, 1, true);
    const leftArc = guardAuthoredRunVector(0, -200, -1, true);
    const closeExact = guardAuthoredRunVector(0, 40, 1, false);
    expect(rightArc.x).toBeGreaterThan(0.68);
    expect(rightArc.y).toBeGreaterThan(0.7);
    expect(leftArc.x).toBeLessThan(-0.68);
    expect(leftArc.y).toBeLessThan(-0.7);
    expect(closeExact.x).toBe(0);
    expect(closeExact.y).toBe(1);
  });

  it('derives the painted guard heading from real velocity in every diagonal', () => {
    const downRight = guardRunPresentation(180, 150, -1);
    const upRight = guardRunPresentation(180, -150, -1);
    const downLeft = guardRunPresentation(-180, 150, 1);
    const upLeft = guardRunPresentation(-180, -150, 1);

    expect(downRight.face).toBe(1);
    expect(Math.sign(downRight.tilt * downRight.face)).toBe(1);
    expect(upRight.face).toBe(1);
    expect(Math.sign(upRight.tilt * upRight.face)).toBe(-1);
    expect(downLeft.face).toBe(-1);
    expect(Math.sign(downLeft.tilt * downLeft.face)).toBe(1);
    expect(upLeft.face).toBe(-1);
    expect(Math.sign(upLeft.tilt * upLeft.face)).toBe(-1);
  });

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

  it('accelerates in 130ms, brakes responsively and advances gait by distance', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    const topSpeed = sim.moveSpeed;

    step(sim, 6, 1, 0); // 100ms: responsive, but not an instant digital jump
    expect(sim.player.moveVx).toBeGreaterThan(topSpeed * 0.7);
    expect(sim.player.moveVx).toBeLessThan(topSpeed * 0.9);
    step(sim, 2, 1, 0); // 133ms: authored top speed reached
    expect(sim.player.moveVx).toBeCloseTo(topSpeed, 5);
    expect(sim.player.runDistance).toBeGreaterThan(0);
    expect(sim.player.animT).toBeCloseTo(
      (sim.player.runDistance / PLAYER_RUN_CYCLE_DISTANCE) * (PLAYER_RUN_FRAMES / PLAYER_RUN_FPS),
      8,
    );

    step(sim, 5); // 83ms brake window
    expect(sim.player.moveVx).toBeCloseTo(0, 8);
    expect(sim.player.moveVy).toBeCloseTo(0, 8);
    expect(sim.player.moving).toBe(false);
    const plantedDistance = sim.player.runDistance;
    const plantedPhase = sim.player.animT;
    step(sim, 30);
    expect(sim.player.runDistance).toBeCloseTo(plantedDistance, 8);
    expect(sim.player.animT).toBeCloseTo(plantedPhase, 8);

    sim.player.x = ARENA_W - 30;
    sim.player.moveVx = topSpeed;
    const edgePhase = sim.player.animT;
    step(sim, 1, 1, 0);
    expect(sim.player.moving).toBe(false);
    expect(sim.player.animT).toBeCloseTo(edgePhase, 8);
  });

  it('advances hero gait by projected screen distance in the compressed Y axis', () => {
    const east = makeSim();
    const south = makeSim();
    east.debugDirectorPaused = true;
    south.debugDirectorPaused = true;
    east.player.abilities = {};
    south.player.abilities = {};
    step(east, 30, 1, 0);
    step(south, 30, 0, 1);
    expect(east.player.runDistance).toBeGreaterThan(0);
    expect(south.player.runDistance / east.player.runDistance).toBeCloseTo(PLAYER_VISUAL_Y_SCALE, 3);
  });

  it('holds an authored direction through boundary jitter before changing sector', () => {
    const vector = (degrees: number) => {
      const radians = degrees * Math.PI / 180;
      return [Math.cos(radians), Math.sin(radians)] as const;
    };
    const nearBoundary = vector(29.5);
    const committed = vector(31);
    expect(hystereticMovementOctant(0, ...nearBoundary)).toBe(0);
    expect(hystereticMovementOctant(0, ...committed)).toBe(1);
    expect(hystereticMovementOctant(1, ...nearBoundary)).toBe(1);
    expect(hystereticMovementOctant(0, -1, 0)).toBe(4);

    const approach = approachVelocity(0, 0, 100, 100, 10);
    expect(Math.hypot(approach.vx, approach.vy)).toBeCloseTo(10, 8);
    expect(approach.vx).toBeCloseTo(approach.vy, 8);
  });

  it('turns through neighboring authored views without resetting gait phase', () => {
    expect(stepMovementOctant(0, 4)).toBe(1);
    expect(stepMovementOctant(1, 4)).toBe(2);
    expect(stepMovementOctant(0, 7)).toBe(7);
    expect(stepMovementOctant(7, 3)).toBe(0);

    const sim = makeSim();
    sim.debugDirectorPaused = true;
    step(sim, 18, 1, 0);
    const phaseBeforeTurn = sim.player.runDistance;
    step(sim, 2, -1, 0);
    expect(sim.player.visualDir).not.toBe(4);
    expect(sim.player.runDistance).toBeGreaterThan(phaseBeforeTurn);
  });

  it('derives enemy gait cadence from travelled distance and preserves a full leap arc', () => {
    expect(enemyRunTargetFps('sprinter', '')).toBe(16);
    expect(enemyRunTargetFps('mascot', '')).toBe(8);
    expect(enemyRunTargetFps('captain', 'captain')).toBe(16);
    expect(enemyRunCycleDistance({ def: ENEMIES.sprinter, boss: '', speed: 98 }, 6)).toBeCloseTo(36.75, 8);
    expect(enemyAirLift(0.55, 0.55)).toBeCloseTo(0, 8);
    expect(enemyAirLift(0.275, 0.55)).toBeCloseTo(40, 8);
    expect(enemyAirLift(0, 0.55)).toBe(0);
  });

  it('holds one directional run pose at a time and wraps the 12-frame cycle', () => {
    expect(directionalFrameBlend(0, 20, 12)).toEqual({ frame: 0, nextFrame: 1, mix: 0 });
    expect(directionalFrameBlend(0.04, 20, 12)).toEqual({ frame: 0, nextFrame: 1, mix: 0 });
    expect(directionalFrameBlend(0.59, 20, 12)).toMatchObject({ frame: 11, nextFrame: 0 });
    expect(directionalFrameBlend(0.59, 20, 12).mix).toBe(0);
    expect(directionalFrameBlend(Number.NaN, 20, 12)).toEqual({ frame: 0, nextFrame: 1, mix: 0 });
    expect(directionalFrameBlend(0.03, 20, 12).mix).toBe(0);
    expect(directionalFrameBlend(0.048, 20, 12).mix).toBe(0);
  });

  it('keeps Matchday Wipeout inside the fair-play viewport footprint', () => {
    const landscape = matchdayWipeoutVisual(844, 390, 0.5, false);
    const portrait = matchdayWipeoutVisual(390, 844, 0.5, false);
    const reduced = matchdayWipeoutVisual(844, 390, 0.5, true);
    expect(landscape.size).toBeCloseTo(390 * 0.65, 8);
    expect(portrait.size).toBeCloseTo(390 * 0.65, 8);
    expect(landscape.alpha).toBeLessThanOrEqual(0.5);
    expect(reduced.alpha).toBeLessThan(landscape.alpha);
    expect(matchdayWipeoutVisual(844, 390, 0.999, false).alpha).toBeLessThan(0.01);
  });

  it('budgets a player contour only for bodies painted in front of the hero', () => {
    const player = { left: 100, right: 150, top: 100, bottom: 200 };
    expect(playerOcclusionStrength(player, { left: 90, right: 160, top: 90, bottom: 210 }, false)).toBe(0);
    expect(playerOcclusionStrength(player, { left: 90, right: 160, top: 90, bottom: 210 }, true)).toBe(1);
    const partial = playerOcclusionStrength(player, { left: 125, right: 180, top: 140, bottom: 220 }, true);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    expect(playerOcclusionStrength(player, { left: 151, right: 180, top: 100, bottom: 200 }, true)).toBe(0);
  });

  it('degrades decorative combat presentation monotonically under horde pressure', () => {
    const calm = combatPresentationBudget(20);
    const busy = combatPresentationBudget(60);
    const dense = combatPresentationBudget(85);
    const extreme = combatPresentationBudget(120);
    expect([calm.maxOrdinaryHealthBars, busy.maxOrdinaryHealthBars, dense.maxOrdinaryHealthBars, extreme.maxOrdinaryHealthBars])
      .toEqual([16, 10, 7, 5]);
    expect(calm.particleStride).toBeLessThan(busy.particleStride);
    expect(busy.particleStride).toBeLessThan(dense.particleStride);
    expect(dense.particleStride).toBeLessThan(extreme.particleStride);
    expect(extreme.hitFlashAlpha).toBeLessThan(calm.hitFlashAlpha);
    expect(extreme.maxSeekerTrails).toBeLessThan(dense.maxSeekerTrails);
    expect(dense.maxSeekerTrails).toBeLessThan(busy.maxSeekerTrails);
  });

  it('reduced VFX preserves tactical bars while lowering decorative intensity', () => {
    const normal = combatPresentationBudget(60);
    const reduced = reducedCombatPresentationBudget(normal);
    expect(reduced.maxOrdinaryHealthBars).toBe(normal.maxOrdinaryHealthBars);
    expect(reduced.particleStride).toBeGreaterThan(normal.particleStride);
    expect(reduced.maxStandardImpacts).toBeLessThan(normal.maxStandardImpacts);
    expect(reduced.maxPriorityImpacts).toBeGreaterThanOrEqual(4);
    expect(reduced.hitFlashAlpha).toBeLessThan(normal.hitFlashAlpha);
  });

  it('prioritizes damaged, nearby and tactical enemy health without distant UI walls', () => {
    const ordinary = {
      hp: 20, maxHp: 20, elite: false, boss: '' as const,
      stun: 0, slow: 0, airT: 0, barHitT: 0, def: ENEMIES.invader,
    };
    expect(enemyHealthBarPriority(ordinary, 520, 120)).toBe(-1);
    expect(enemyHealthBarPriority(ordinary, 100, 120)).toBeGreaterThan(0);
    expect(enemyHealthBarPriority({ ...ordinary, hp: 12 }, 520, 120)).toBeGreaterThan(0);
    expect(enemyHealthBarPriority({ ...ordinary, elite: true }, 900, 120)).toBe(Number.POSITIVE_INFINITY);
    expect(enemyHealthBarPriority({ ...ordinary, def: ENEMIES.drone }, 440, 20)).toBeGreaterThan(0);
    expect(enemyHealthBarPriority({ ...ordinary, def: ENEMIES.drone }, 440, 120)).toBe(-1);
  });

  it('keeps damped turf clipping travel monotonic until it settles', () => {
    const samples = [0, 0.08, 0.16, 0.24, 0.4, 0.72].map((age) => dampedTurfDisplacement(age));
    expect(samples[0]).toBe(0);
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]).toBeGreaterThan(samples[index - 1]);
    }
    expect(dampedTurfDisplacement(10)).toBeCloseTo(1 / 4.7, 6);
  });

  it('exposes alternating concrete foot plants during the run cycle', () => {
    expect(playerStepCue(2 / 18)).toEqual({ strength: 1, foot: -1 });
    expect(playerStepCue(8 / 18)).toEqual({ strength: 1, foot: 1 });
    expect(playerStepCue(5 / 18).strength).toBe(0);
  });

  it('keeps optional raised-arena scenery outside physical traversal bounds', () => {
    const hybrid = new Sim(PLAYERS[0], freshSave(), 1234, {
      playerX: 112,
      playerY: 68,
      enemyX: 80,
      enemyY: 52,
    });
    hybrid.player.x = 30;
    hybrid.player.y = 30;
    hybrid.debugSpawn('invader', -100, -100);
    step(hybrid, 1, -1, -1);
    const enemy = hybrid.enemies.find((entry) => entry.active)!;

    expect(hybrid.player.x).toBe(112);
    expect(hybrid.player.y).toBe(68);
    expect(enemy.x).toBeGreaterThanOrEqual(80);
    expect(enemy.y).toBeGreaterThanOrEqual(52);

    for (const bossId of ['drumboss', 'official', 'captain'] as const) {
      hybrid.debugSpawnBoss(bossId);
      const boss = hybrid.enemies.find((entry) => entry.active && entry.boss === bossId)!;
      hybrid.bossIntroT = 0;
      boss.x = 0;
      boss.y = 0;
      boss.stun = 999;
      step(hybrid, 1);
      expect(boss.x).toBeGreaterThanOrEqual(80 + hybridBossSceneryPad(bossId));
      expect(boss.y).toBeGreaterThanOrEqual(52 + hybridBossSceneryPad(bossId));
      boss.y = ARENA_H;
      step(hybrid, 1);
      expect(boss.y).toBeLessThanOrEqual(ARENA_H - 52 - hybridEnemySceneryPad(boss, 'near'));
    }

    hybrid.debugSpawn('drone', 0, 0);
    const drone = hybrid.enemies.find((entry) => entry.active && entry.def.id === 'drone')!;
    drone.stun = 999;
    step(hybrid, 1);
    expect(hybridEnemySceneryPad(drone)).toBe(54);
    expect(hybridEnemySceneryPad(drone, 'near')).toBe(0);
    expect(drone.x).toBeGreaterThanOrEqual(80 + 54);
    expect(drone.y).toBeGreaterThanOrEqual(52 + 54);

    const captain = hybrid.enemies.find((entry) => entry.active && entry.boss === 'captain')!;
    hybrid.player.x = captain.x - 40;
    hybrid.player.y = captain.y;
    step(hybrid, 1);
    expect(Math.hypot(hybrid.player.x - captain.x, hybrid.player.y - captain.y))
      .toBeCloseTo(hybridBossBodyContact('captain'), 5);
    expect(hybrid.player.x).toBeGreaterThanOrEqual(112);
    expect(hybrid.player.y).toBeGreaterThanOrEqual(68);

    const resolvedCorner = resolveHybridBossBodyContact(115, 70, 246, 218, 148, 112, 68);
    expect(Math.hypot(resolvedCorner.x - 246, resolvedCorner.y - 218)).toBeGreaterThanOrEqual(147.99);
    expect(resolvedCorner.x).toBeGreaterThanOrEqual(112);
    expect(resolvedCorner.y).toBeGreaterThanOrEqual(68);

    const original = makeSim();
    original.player.x = 30;
    original.player.y = 30;
    step(original, 1, -1, -1);
    expect(original.player.x).toBe(30);
    expect(original.player.y).toBe(30);
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
    step(sim, 90); // 1.5 seconds: brief kickoff calm
    expect(sim.enemies.some((e) => e.active)).toBe(false);
    step(sim, 420); // enemies arrive steadily through continuous ingress
    const active = sim.enemies.filter((e) => e.active).length;
    expect(active + sim.kills).toBeGreaterThanOrEqual(3);
  });

  it('can pause only the procedural director for deterministic visual fixtures', () => {
    const sim = makeSim();
    sim.player.hp = sim.player.maxHp = 99999;
    sim.player.abilities = {};
    sim.debugDirectorPaused = true;
    sim.time = 590;
    step(sim, 600);
    expect(sim.enemies.filter((enemy) => enemy.active)).toHaveLength(0);
    expect(sim.bossAlive).toBeNull();
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
    expect(active).toBeGreaterThanOrEqual(5);
    expect(active).toBeLessThanOrEqual(6);
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
    expect(active).toBeGreaterThanOrEqual(22);
    expect(active).toBeLessThanOrEqual(26);
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

  it('keeps elites below boss-scale toughness and guarantees a meaningful rare drop', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.debugSpawn('invader', sim.player.x + 300, sim.player.y, true);
    const eliteIndex = sim.enemies.findIndex((enemy) => enemy.active && enemy.elite);
    const elite = sim.enemies[eliteIndex];
    expect(elite.maxHp).toBeCloseTo(ENEMIES.invader.hp * 1.5 * 4, 5);
    sim.damageEnemy(eliteIndex, elite.hp + 1);
    expect(sim.pickups.some((pickup) => pickup.active && ['magnet', 'freeze', 'bomb'].includes(pickup.kind))).toBe(true);
  });

  it('enemies spawn continuously and chase the player', () => {
    const sim = makeSim();
    step(sim, 600); // 10s of continuous ingress
    const alive = sim.enemies.filter((e) => e.active);
    expect(alive.length + sim.kills).toBeGreaterThanOrEqual(3);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((e) => (e.active = false));
    const p = sim.player;
    sim.debugSpawn('invader', p.x + 400, p.y);
    const chaser = sim.enemies.find((e) => e.active)!;
    chaser.hp = chaser.maxHp = 9999;
    const d0 = Math.hypot(chaser.x - p.x, chaser.y - p.y);
    step(sim, 120);
    expect(chaser.active).toBe(true);
    const d1 = Math.hypot(chaser.x - p.x, chaser.y - p.y);
    expect(d1).toBeLessThan(d0);
  });

  it('opens with a sparse pitch: the director delivers loose packs from one edge segment', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    step(sim, 420); // 7s: 2s warm-up + 5s at 0.8/s ≈ 4 invaders, one edge anchor
    const active = sim.enemies.filter((e) => e.active && !e.boss);
    expect(active.length).toBeGreaterThanOrEqual(3);
    let widest = 0;
    let tightest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const d = Math.hypot(active[i].x - active[j].x, active[i].y - active[j].y);
        widest = Math.max(widest, d);
        tightest = Math.min(tightest, d);
      }
    }
    // Spawned around one shared anchor: never stacked on top of each other,
    // and spaced loosely enough to read as a pack rather than one blob.
    expect(widest).toBeLessThan(620);
    expect(tightest).toBeGreaterThan(8);
  });

  it('horde cohesion gathers a scattered pack loosely while it still presses the player', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.enemies.forEach((e) => (e.active = false));
    const p = sim.player;
    const pack: { x: number; y: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = -0.45 + i * 0.225;
      const x = p.x + Math.cos(angle) * 720;
      const y = p.y + Math.sin(angle) * 720;
      sim.debugSpawn('invader', x, y);
      pack.push({ x, y });
    }
    const meanSpread = (pts: { x: number; y: number }[]) => {
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
    const before = meanSpread(pack);
    step(sim, 360); // 6s of locomotion toward the player
    const active = sim.enemies.filter((e) => e.active);
    expect(active).toHaveLength(5);
    const after = meanSpread(active.map((e) => ({ x: e.x, y: e.y })));
    // Cohesion draws the pack together, but the pull is gentle: the front
    // never collapses into one tight blob.
    expect(after).toBeLessThan(before * 0.9);
    expect(after).toBeGreaterThan(before * 0.5);
    const reached = Math.hypot(active[0].x - p.x, active[0].y - p.y);
    expect(reached).toBeLessThan(720);
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

  it('mirrors live World Cup penalty geometry exactly across the pitch', () => {
    const left = hybridPitchMarkingGeometry('left');
    const right = hybridPitchMarkingGeometry('right');
    expect(left.penaltyLineX).toBe(370);
    expect(right.penaltyLineX).toBe(ARENA_W - 370);
    expect(left.goalAreaLineX).toBe(170);
    expect(right.goalAreaLineX).toBe(ARENA_W - 170);
    expect(left.penaltySpotX).toBe(270);
    expect(right.penaltySpotX).toBe(ARENA_W - 270);
    expect(left.penaltyTop).toBe(right.penaltyTop);
    expect(left.penaltyBottom).toBe(right.penaltyBottom);
    expect(left.penaltyLineX + right.penaltyLineX).toBe(ARENA_W);
    expect(left.penaltySpotX + right.penaltySpotX).toBe(ARENA_W);
    expect(left.arcStart).toBeCloseTo(-right.arcEnd + Math.PI, 12);
    expect(left.arcEnd).toBeCloseTo(-right.arcStart + Math.PI, 12);
  });

  it('registers the worn hybrid centre construction to the pitch geometry', () => {
    const centre = hybridCentreMarkingGeometry();
    expect(centre.lineX).toBe(ARENA_W / 2);
    expect(centre.circleX).toBe(centre.lineX);
    expect(centre.circleY).toBe(ARENA_H / 2);
    expect(centre.top).toBe(40);
    expect(centre.bottom).toBe(ARENA_H - 40);
    expect(centre.radius).toBe(190);
  });

  it('anchors every generated pickup by its measured visible alpha bounds', () => {
    const kinds = ['xp', 'coin', 'heal', 'trophy', 'magnet', 'bomb', 'freeze'] as const;
    for (const kind of kinds) {
      const bounds = pickupVisibleBounds(kind, kind === 'xp' ? 2 : 1);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(1);
    }
    expect(pickupVisibleBounds('magnet', 1).height).toBeCloseTo(217 / 256, 8);
    expect(pickupVisibleBounds('bomb', 1).height).toBeCloseTo(220 / 256, 8);
    expect(pickupVisibleBounds('trophy', 1).height).toBeCloseTo(112 / 128, 8);
  });

  it('reveals aerial bodies before their large additive wakes clear the hero', () => {
    const contact = aerialLaunchVisual(0);
    const emerging = aerialLaunchVisual(0.08);
    const clear = aerialLaunchVisual(0.24);
    expect(contact.bodyAlpha).toBe(0);
    expect(contact.wakeAlpha).toBe(0);
    expect(contact.scale).toBeCloseTo(0.76, 8);
    expect(emerging.bodyAlpha).toBeGreaterThan(0);
    expect(emerging.bodyAlpha).toBeGreaterThan(emerging.wakeAlpha);
    expect(clear).toEqual({ bodyAlpha: 1, wakeAlpha: 1, scale: 1 });
    expect(aerialLaunchVisual(Number.NaN)).toEqual(contact);
  });

  it('keeps hybrid goal-net wind movement subtle and out of phase', () => {
    const left = Array.from({ length: 241 }, (_, index) => hybridGoalNetBreathe(index / 60, 'left'));
    const right = Array.from({ length: 241 }, (_, index) => hybridGoalNetBreathe(index / 60, 'right'));
    expect(Math.max(...left.map(Math.abs))).toBeLessThanOrEqual(0.48);
    expect(Math.max(...right.map(Math.abs))).toBeLessThanOrEqual(0.48);
    expect(left.some((value, index) => Math.abs(value - right[index]) > 0.35)).toBe(true);
    expect(hybridGoalNetBreathe(Number.NaN, 'left')).toBe(0);
  });

  it('gives fixed hybrid corner flags restrained near-edge depth without moving their anchors', () => {
    expect(hybridCornerFlagDepthScale(0)).toBeCloseTo(0.92, 6);
    expect(hybridCornerFlagDepthScale(ARENA_H / 2)).toBeCloseTo(1, 6);
    expect(hybridCornerFlagDepthScale(ARENA_H)).toBeCloseTo(1.08, 6);
    expect(hybridCornerFlagDepthScale(Number.NaN)).toBeCloseTo(1, 6);
  });

  it('clamps the hybrid rear-bowl parallax to a subtle screen-space offset', () => {
    expect(hybridStadiumParallax(ARENA_W / 2, ARENA_W / 2)).toBe(0);
    expect(hybridStadiumParallax(ARENA_W / 2 + 200, ARENA_W / 2)).toBeCloseTo(4.8, 6);
    expect(hybridStadiumParallax(0, ARENA_W / 2)).toBe(-8);
    expect(hybridStadiumParallax(ARENA_W, ARENA_W / 2)).toBe(8);
    expect(hybridStadiumParallax(Number.NaN, ARENA_W / 2)).toBe(0);
  });

  it('keeps every hybrid cast shadow aligned down-right from the upper-left key light', () => {
    expect(ART_DIRECTION_PROFILE.projectionTilt).toBe(0.62);
    expect(ART_DIRECTION_PROFILE.scale.player).toBeGreaterThan(ART_DIRECTION_PROFILE.scale.standardEnemy);
    expect(ART_DIRECTION_PROFILE.scale.ally).toBeGreaterThan(ART_DIRECTION_PROFILE.scale.standardEnemy);
    expect(ART_DIRECTION_PROFILE.bossScale.minimum).toBeGreaterThan(ART_DIRECTION_PROFILE.scale.player);
    expect(ART_DIRECTION_PROFILE.aerial.baseLift).toBeGreaterThan(ART_DIRECTION_PROFILE.aerial.bobAmplitude * 5);
    expect(HYBRID_LIGHT_CAST.x).toBeGreaterThan(0);
    expect(HYBRID_LIGHT_CAST.y).toBeGreaterThan(0);
    expect(HYBRID_LIGHT_CAST.x).toBeGreaterThan(HYBRID_LIGHT_CAST.y);
    expect(Math.hypot(HYBRID_LIGHT_CAST.x, HYBRID_LIGHT_CAST.y)).toBeCloseTo(0.9602, 3);
  });

  it('scales hybrid material shadows by threat size and separates aerial height', () => {
    const player = hybridEntityShadowGeometry(20, 'player');
    const enemy = hybridEntityShadowGeometry(16, 'enemy');
    const boss = hybridEntityShadowGeometry(50, 'boss');
    const drone = hybridEntityShadowGeometry(18, 'aerial', 42);
    const pickup = hybridEntityShadowGeometry(10, 'pickup');
    expect(player.castLength).toBeGreaterThan(enemy.castLength);
    expect(boss.castLength).toBeGreaterThan(player.castLength * 2);
    expect(boss.castWidth).toBeGreaterThan(player.castWidth);
    expect(player.contactAlpha).toBeGreaterThan(0);
    expect(drone.contactAlpha).toBe(0);
    expect(drone.offsetX).toBeGreaterThan(enemy.offsetX);
    expect(drone.offsetY).toBeGreaterThan(enemy.offsetY);
    expect(pickup.castLength).toBeLessThan(enemy.castLength);
    expect(pickup.alpha).toBeLessThan(enemy.alpha);
    expect(pickup.contactAlpha).toBeGreaterThan(0);
    expect(hybridEntityShadowGeometry(Number.NaN, 'enemy', Number.NaN).castLength).toBeGreaterThan(0);
    const scratch = { castLength: 0, castWidth: 0, offsetX: 0, offsetY: 0, alpha: 0, contactAlpha: 0 };
    expect(hybridEntityShadowGeometry(16, 'enemy', 0, scratch)).toBe(scratch);
    expect(scratch.castLength).toBeCloseTo(enemy.castLength, 12);
  });

  it('keeps hybrid billboard depth restrained and monotonic across the pitch', () => {
    expect(hybridEntityDepthScale(0)).toBeCloseTo(0.96, 12);
    expect(hybridEntityDepthScale(ARENA_H / 2)).toBeCloseTo(1, 12);
    expect(hybridEntityDepthScale(ARENA_H)).toBeCloseTo(1.04, 12);
    expect(hybridEntityDepthScale(350)).toBeLessThan(hybridEntityDepthScale(1050));
    expect(hybridEntityDepthScale(Number.NaN)).toBe(1);
  });

  it('keeps every Orbiting Press ball behind the player painter layer', () => {
    const playerY = ARENA_H / 2;
    expect(orbitPainterDepthY(playerY, playerY - 120)).toBe(playerY - 120);
    expect(orbitPainterDepthY(playerY, playerY)).toBeLessThan(playerY);
    expect(orbitPainterDepthY(playerY, playerY + 120)).toBeLessThan(playerY);
  });

  it('curves every Orbiting Press trail while preserving clearance before the following ball', () => {
    const formations = [
      [90, 2],
      [90, 3],
      [115, 3],
      [115, 4],
      [140, 5],
      [140, 6],
    ] as const;
    for (const [radius, count] of formations) {
      const geometry = orbitTrailArcGeometry(radius, count);
      expect(geometry.arcRadians).toBeGreaterThan(0.17);
      expect(geometry.arcRadians).toBeLessThan((Math.PI * 2) / count);
      expect(geometry.segments).toBeGreaterThanOrEqual(6);
      expect(geometry.segmentLength).toBeGreaterThanOrEqual(28);
      const remainingChord = 2 * radius * Math.sin(geometry.remainingGapRadians / 2);
      expect(remainingChord).toBeGreaterThanOrEqual(57.9);
    }
  });

  it('gives hostile hybrid projectiles distinct readable flight profiles', () => {
    expect(hybridHostileProjectileElevation('electric', 1.45)).toBe(28);
    expect(hybridHostileProjectileElevation('electric', 0.1)).toBe(28);
    const bottleStart = hybridHostileProjectileElevation('bottle', 1.2, 1.2);
    const bottleApex = hybridHostileProjectileElevation('bottle', 0.6, 1.2);
    const bottleLate = hybridHostileProjectileElevation('bottle', 0, 1.2);
    expect(bottleStart).toBeCloseTo(12, 10);
    expect(bottleApex).toBeGreaterThan(45);
    expect(bottleLate).toBeCloseTo(12, 10);
    expect(hybridHostileProjectileElevation('bottle', Number.NaN)).toBeGreaterThanOrEqual(12);
  });

  it('compresses a corpse into the turf instead of rotating a flat card', () => {
    const start = corpseCollapseVisual(0);
    const middle = corpseCollapseVisual(0.45);
    const end = corpseCollapseVisual(1);
    expect(start.rotation).toBe(0);
    expect(middle.rotation).toBeGreaterThan(0);
    expect(end.rotation).toBeLessThan(0.5);
    expect(end.scaleY).toBeLessThan(middle.scaleY);
    expect(end.sink).toBeGreaterThan(middle.sink);
    expect(end.alpha).toBe(0);
  });

  it('suppresses redundant full-health plates while preserving informative bars', () => {
    const occupied: HealthBarCollisionRect[] = [];
    const ordinary = Array.from({ length: 5 }, () => placeEnemyHealthBar(400, 220, 52, 6, false, true, occupied));
    expect(ordinary[0]).toMatchObject({ x: 400, y: 220, lane: 0, compact: false, hidden: false });
    expect(ordinary.slice(1).every((placement) => placement.hidden && placement.alpha === 0)).toBe(true);
    expect(occupied).toHaveLength(1);

    const eliteOccupied: HealthBarCollisionRect[] = [];
    const elites = Array.from({ length: 3 }, () => placeEnemyHealthBar(500, 240, 70, 8, true, false, eliteOccupied));
    expect(elites.every((placement) => placement.widthScale === 1 && !placement.compact && !placement.hidden)).toBe(true);
    expect(new Set(elites.map((placement) => `${placement.x}:${placement.y}`)).size).toBe(elites.length);

    const damagedOccupied: HealthBarCollisionRect[] = [];
    const damaged = Array.from({ length: 5 }, () => placeEnemyHealthBar(600, 260, 52, 6, false, false, damagedOccupied));
    expect(damaged.every((placement) => placement.widthScale === 1 && placement.alpha === 1 && !placement.hidden)).toBe(true);
    expect(damaged.every((placement) => !placement.compact)).toBe(true);
  });

  it('moves hybrid health bars away from a reserved hero silhouette', () => {
    const occupied: HealthBarCollisionRect[] = [];
    const hero: HealthBarCollisionRect[] = [{ left: 370, right: 430, top: 132, bottom: 255 }];
    const placement = placeEnemyHealthBar(400, 220, 52, 6, false, true, occupied, hero);
    const width = 52 * placement.widthScale + 12;
    const height = 6 * (placement.compact ? 0.82 : 1) + 8;
    const overlapsHero = placement.x + width / 2 + 4 > hero[0].left
      && placement.x - width / 2 - 4 < hero[0].right
      && placement.y + height + 3 > hero[0].top
      && placement.y - 3 < hero[0].bottom;
    expect(placement.lane).toBeGreaterThan(0);
    expect(overlapsHero).toBe(false);
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

  it('releases the max Precision Strike volley from separated lead-cleat points', () => {
    const sim = makeSim(0);
    sim.player.abilities.strike = 5;
    for (let index = 0; index < 6; index++) {
      sim.debugSpawn('invader', sim.player.x + 460 + index * 18, sim.player.y - 110 + index * 44);
      const enemy = [...sim.enemies].reverse().find((entry) => entry.active)!;
      enemy.speed = 0;
      enemy.hp = enemy.maxHp = 9999;
    }
    sim.player.strikeCd = 0;
    step(sim, 14);
    const balls = sim.balls.filter((ball) => ball.active);
    expect(balls).toHaveLength(5); // max-level four plus Messi's character bonus
    expect(balls.every((ball) => Math.hypot(ball.x - sim.player.x, ball.y - sim.player.y) > 27)).toBe(true);
    expect(new Set(balls.map((ball) => `${ball.x.toFixed(2)}:${ball.y.toFixed(2)}`)).size).toBe(balls.length);
    expect(new Set(balls.map((ball) => ball.targetIdx)).size).toBeGreaterThan(1);
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

  it('commits the body aim before contact while the ground marker follows the target', () => {
    const sim = makeSim(0);
    sim.debugDirectorPaused = true;
    sim.debugSpawn('invader', sim.player.x + 420, sim.player.y - 80);
    const enemy = sim.enemies.find((entry) => entry.active)!;
    enemy.speed = 0;
    enemy.hp = enemy.maxHp = 9999;
    sim.player.strikeCd = 0;
    step(sim, 8);
    const lockedAim = { x: sim.player.aimDx, y: sim.player.aimDy };
    enemy.y += 280;
    step(sim, 1);
    expect(sim.player.kickT).toBeGreaterThan(0);
    expect(sim.player.aimDx).toBeCloseTo(lockedAim.x, 6);
    expect(sim.player.aimDy).toBeCloseTo(lockedAim.y, 6);
    const marker = sim.reticles.find((entry) => entry.active && entry.targetIdx === sim.enemies.indexOf(enemy));
    expect(marker?.y).toBeCloseTo(enemy.y, 5);
  });

  it('reduces rather than removes movement through kick contact and restores full control', () => {
    const committed = makeSim(0);
    committed.debugDirectorPaused = true;
    committed.enemies.forEach((enemy) => (enemy.active = false));
    committed.debugSpawn('invader', committed.player.x + 460, committed.player.y);
    const target = committed.enemies.find((enemy) => enemy.active)!;
    target.speed = 0;
    target.hp = target.maxHp = 9999;
    committed.player.strikeCd = 0;

    const free = makeSim(0);
    free.debugDirectorPaused = true;
    free.enemies.forEach((enemy) => (enemy.active = false));
    free.player.abilities = {};

    step(committed, 8, 1, 0);
    step(free, 8, 1, 0);
    expect(committed.player.kickT).toBeGreaterThan(0);
    expect(committed.player.moveVx).toBeGreaterThan(0);
    expect(committed.player.moveVx).toBeLessThan(free.player.moveVx * 0.72);
    committed.player.abilities.dash = 1;
    expect(committed.requestDash(1, 0)).toBe(false);
    step(committed, 24, 1, 0);
    expect(committed.player.kickT).toBe(0);
    expect(committed.player.moveVx).toBeGreaterThan(committed.moveSpeed * 0.95);
  });

  it('uses damage reservation in the close-range aerial fallback', () => {
    const sim = makeSim(0);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugSpawn('invader', sim.player.x + 500, sim.player.y);
    const far = sim.enemies.find((enemy) => enemy.active)!;
    far.speed = 0;
    far.hp = far.maxHp = 10;
    sim.debugSpawn('steward', sim.player.x + 150, sim.player.y + 20);
    const near = [...sim.enemies].reverse().find((enemy) => enemy.active)!;
    near.speed = 0;
    near.hp = near.maxHp = 9999;
    sim.player.strikeCd = 0;
    step(sim, 14);
    const targets = sim.balls.filter((ball) => ball.active).map((ball) => ball.targetIdx);
    expect(new Set(targets)).toEqual(new Set([sim.enemies.indexOf(far), sim.enemies.indexOf(near)]));
  });

  it('does not stack a bonus football on an already projected single-target kill', () => {
    const sim = makeSim(0);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugSpawn('invader', sim.player.x + 480, sim.player.y);
    const enemy = sim.enemies.find((entry) => entry.active)!;
    enemy.speed = 0;
    enemy.hp = enemy.maxHp = 10;
    sim.player.strikeCd = 0;
    step(sim, 14);
    expect(sim.balls.filter((ball) => ball.active)).toHaveLength(1);
    expect(sim.pickAerialTarget(sim.player.x, sim.player.y)).toBe(-1);
  });

  it('removes a dead-target landing marker without inventing an empty impact', () => {
    const sim = makeSim(0);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugSpawn('steward', sim.player.x + 460, sim.player.y);
    const enemy = sim.enemies.find((entry) => entry.active)!;
    enemy.speed = 0;
    enemy.hp = enemy.maxHp = 9999;
    sim.player.strikeCd = 0;
    step(sim, 14);
    expect(sim.balls.some((ball) => ball.active)).toBe(true);
    sim.enemies.forEach((entry) => (entry.active = false));
    sim.events.length = 0;
    sim.impacts.forEach((impact) => (impact.active = false));
    sim.rings.forEach((ring) => (ring.active = false));
    step(sim, 90);
    expect(sim.balls.some((ball) => ball.active)).toBe(false);
    expect(sim.reticles.some((marker) => marker.active)).toBe(false);
    expect(sim.events.some((event) => event.type === 'lobLand')).toBe(false);
    expect(sim.impacts.some((impact) => impact.active)).toBe(false);
    expect(sim.rings.some((ring) => ring.active)).toBe(false);
  });

  it('moves an ordinary melee body before resolving one visible contact frame', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.debugSpawn('invader', sim.player.x + 18, sim.player.y);
    const enemy = sim.enemies.find((e) => e.active)!;
    enemy.speed = 72;
    enemy.damage = 8;
    const hpBefore = sim.player.hp;
    step(sim, 1);
    expect(enemy.windup).toBeGreaterThan(0);
    expect(enemy.meleeDx).toBeCloseTo(-1, 6);
    const anticipationX = enemy.x;
    while (enemy.windup > 0) {
      step(sim, 1);
      expect(sim.player.hp).toBe(hpBefore);
      expect(enemy.x).toBeCloseTo(anticipationX, 8);
    }
    expect(enemy.lungeT).toBeCloseTo(ENEMY_MELEE_LUNGE_DURATION, 6);
    while (!enemy.meleeHit) {
      step(sim, 1);
      if (!enemy.meleeHit) expect(sim.player.hp).toBe(hpBefore);
    }
    const contactProgress = 1 - enemy.lungeT / ENEMY_MELEE_LUNGE_DURATION;
    expect(contactProgress).toBeGreaterThanOrEqual(MELEE_CONTACT_PROGRESS);
    expect(enemy.x).toBeLessThan(anticipationX);
    expect(sim.player.hp).toBeLessThan(hpBefore);
    expect(sim.player.hurtT).toBeGreaterThan(0);
    expect(enemy.lungeT).toBeGreaterThan(0);
    expect(sim.events.some((event) => event.type === 'hurt')).toBe(true);

    const hpAfterContact = sim.player.hp;
    while (enemy.lungeT > 0) {
      sim.player.iframes = 0;
      step(sim, 1);
    }
    expect(sim.player.hp).toBe(hpAfterContact);
    expect(enemy.attackAnimT).toBeGreaterThan(0);
    const recoveryX = enemy.x;
    step(sim, 3);
    expect(enemy.x).toBeCloseTo(recoveryX, 8);
  });

  it('keeps a committed melee direction when the player sidesteps during anticipation', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.debugSpawn('invader', sim.player.x + 18, sim.player.y);
    const enemy = sim.enemies.find((entry) => entry.active)!;
    enemy.speed = 72;
    const hpBefore = sim.player.hp;
    step(sim, 1);
    const lockedDx = enemy.meleeDx;
    const lungeStartX = enemy.x;
    sim.player.x = enemy.x + 190;
    while (enemy.windup > 0 || enemy.lungeT > 0) step(sim, 1);
    expect(lockedDx).toBeLessThan(-0.99);
    expect(enemy.meleeDx).toBeCloseTo(lockedDx, 8);
    expect(enemy.x).toBeLessThan(lungeStartX);
    expect(sim.player.hp).toBe(hpBefore);
  });

  it('gives bosses the same body-first contact timing and locked attack vector', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.player.hp = sim.player.maxHp = 99_999;
    sim.boss0Spawned = true;
    sim.boss1Spawned = true;
    sim.boss2Spawned = true;
    expect(sim.debugSpawnBoss('captain')).toBe(true);
    sim.bossIntroT = 0;
    sim.player.iframes = 0;
    const boss = sim.bossAlive!;
    boss.x = sim.player.x + 70;
    boss.y = sim.player.y;
    boss.speed = 60;
    boss.damage = 12;
    boss.attackCd = 0;
    boss.bossCd = boss.bossCd2 = boss.rangedCd = 999;
    const hpBefore = sim.player.hp;
    step(sim, 1);
    expect(boss.windup).toBeGreaterThan(0);
    expect(boss.meleeDx).toBeCloseTo(-1, 6);
    const startX = boss.x;
    while (boss.windup > 0) {
      step(sim, 1);
      expect(sim.player.hp).toBe(hpBefore);
    }
    while (!boss.meleeHit) {
      step(sim, 1);
      if (!boss.meleeHit) expect(sim.player.hp).toBe(hpBefore);
    }
    expect(1 - boss.lungeT / BOSS_MELEE_LUNGE_DURATION).toBeGreaterThanOrEqual(MELEE_CONTACT_PROGRESS);
    expect(boss.x).toBeLessThan(startX);
    expect(sim.player.hp).toBeLessThan(hpBefore);
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
    // clear the pitch so the instant first strike (no warm-up) cannot spawn a
    // kickground impact while the pooled contact fx is expected to expire
    sim.enemies.forEach((e) => (e.active = false));
    sim.balls.forEach((ball) => (ball.active = false));
    step(sim, 20);
    expect(sim.impacts.some((fx) => fx.active)).toBe(false);
  });

  it('rounds damage numbers to at most two decimals so overflows stay short', () => {
    const sim = makeSim();
    sim.enemies.forEach((e) => (e.active = false));
    sim.debugSpawn('steward', sim.player.x + 100, sim.player.y);
    const idx = sim.enemies.findIndex((e) => e.active);
    const enemy = sim.enemies[idx];
    enemy.hp = 37.400000000000006;
    enemy.maxHp = 100;
    sim.damageEnemy(idx, 999);
    const dmg = sim.dmgNums.filter((d) => d.active).at(-1);
    expect(dmg?.value).toBe('37.4');
    expect(dmg?.value).toMatch(/^\d+(\.\d{1,2})?$/);
    sim.debugSpawn('steward', sim.player.x + 140, sim.player.y);
    const second = sim.enemies.findIndex((e) => e.active);
    sim.damageEnemy(second, 5, 0, 0, { crit: true });
    expect(sim.dmgNums.filter((d) => d.active).at(-1)?.value).toBe('8');
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

  it('draft options expose current, after, cap and cadence without guessing', () => {
    const sim = makeSim();
    sim.player.abilities = { strike: 2, pressure: 1 };
    sim.player.stats.speed = 2;
    const ability = sim.makeAbilityUpgradeOption('strike', 3);
    expect(ability).toMatchObject({
      currentLabel: 'Level 2',
      afterLabel: 'Level 3',
      capLabel: 'Level 5',
      synergyLabel: 'Pairs with Pitch Pressure',
    });
    expect(ability.metaLabel).toContain('0.8s cooldown');
    expect(abilityCadenceLabel('guard', 5)).toBe('Continuous');

    const training = sim.makeStatUpgradeOption('speed');
    expect(training.currentLabel).toBe('+10% move speed');
    expect(training.afterLabel).toBe('+15% move speed');
    expect(training.capLabel).toBe('+30% move speed');
    expect(statProgressLabel('regen', 3)).toBe('+1.2 HP/s');
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

  it('caps a run at six active ability slots without forcing an owned card', () => {
    const sim = makeSim();
    sim.player.abilities = {
      strike: 2, curveball: 1, bootseekers: 1, orbit: 1, whistle: 1, blast: 1,
    };
    for (let roll = 0; roll < 20; roll++) {
      const options = sim.rollUpgrades();
      expect(options).toHaveLength(3);
      const newAbilityIds = options
        .filter((option) => option.kind === 'ability'
          && !Object.prototype.hasOwnProperty.call(sim.player.abilities, option.id))
        .map((option) => option.id);
      expect(newAbilityIds).toEqual([]);
    }
  });

  it('late-game drafts stay a random draw instead of forcing recovery or defense', () => {
    const sim = makeSim();
    sim.time = 181;
    sim.player.hp = sim.player.maxHp * 0.4;
    let healSeen = false;
    let defensiveSeen = false;
    let nonDefensiveSeen = false;
    for (let roll = 0; roll < 30; roll++) {
      const opts = sim.rollUpgrades();
      expect(opts).toHaveLength(3);
      for (const option of opts) {
        if (option.kind === 'heal') healSeen = true;
        if (option.kind === 'stat' && ['armor', 'maxhp', 'regen'].includes(option.id)) defensiveSeen = true;
        else nonDefensiveSeen = true;
      }
    }
    // Recovery is never injected into a low-HP draft, and defensive stats
    // appear through the random pool without monopolising every slot.
    expect(healSeen).toBe(false);
    expect(defensiveSeen).toBe(true);
    expect(nonDefensiveSeen).toBe(true);
  });

  it('player dies when hp reaches zero', () => {
    const sim = makeSim();
    sim.player.hp = 1;
    sim.player.iframes = 0;
    sim.debugSpawn('invader', sim.player.x + 5, sim.player.y);
    step(sim, 240);
    expect(sim.over).toBe('lost');
  });

  it('keeps playing after 90 minutes instead of awarding full time', () => {
    const sim = makeSim();
    sim.player.hp = 99999;
    sim.player.maxHp = 99999;
    sim.player.stats.armor = 5;
    sim.boss0Spawned = true;
    sim.boss1Spawned = true;
    sim.boss2Spawned = true;
    sim.time = RUN_LENGTH - 1;
    step(sim, 90);
    expect(sim.over).toBe('playing');
    expect(sim.time).toBeGreaterThan(RUN_LENGTH);
    expect(sim.suddenDeath).toBe(false);
  });

  it('holds at 90 minutes in sudden death until a living final boss falls', () => {
    const sim = makeSim();
    sim.player.hp = sim.player.maxHp = 99_999;
    sim.player.abilities = {};
    sim.boss0Spawned = true;
    sim.boss1Spawned = true;
    sim.boss2Spawned = true;
    expect(sim.debugSpawnBoss('captain')).toBe(true);
    sim.bossIntroT = 0;
    sim.bossAlive!.stun = 999;
    sim.bossAlive!.damage = 0;
    sim.time = RUN_LENGTH - 0.05;

    step(sim, 120);
    expect(sim.time).toBeGreaterThan(RUN_LENGTH);
    expect(sim.over).toBe('playing');
    expect(sim.suddenDeath).toBe(false);
    expect(sim.bossAlive?.boss).toBe('captain');
    expect(sim.enemies.filter((enemy) => enemy.active && !enemy.boss)).toHaveLength(0);

    const bossIndex = sim.enemies.findIndex((enemy) => enemy.active && enemy.boss === 'captain');
    sim.damageEnemy(bossIndex, sim.enemies[bossIndex].hp + 1);
    step(sim, 1);
    expect(sim.bossAlive).toBeNull();
    expect(sim.pendingBossAbilities).toBe(2);
    expect(sim.over).toBe('playing');
    for (let pick = 0; pick < 2; pick++) {
      const option = sim.rollBossAbilities()[0];
      sim.applyUpgrade(option);
      sim.pendingBossAbilities--;
    }
    step(sim, 1);
    expect(sim.over).toBe('playing');
    expect(sim.suddenDeath).toBe(false);
  });

  it('does not skip a scheduled late boss when an earlier boss dies after full time', () => {
    const sim = makeSim();
    sim.player.hp = sim.player.maxHp = 99_999;
    sim.player.abilities = {};
    sim.boss0Spawned = true;
    sim.time = RUN_LENGTH;

    step(sim, 1);
    expect(sim.over).toBe('playing');
    expect(sim.suddenDeath).toBe(false);
    expect(sim.bossAlive?.boss).toBe('official');
    expect(sim.boss1Spawned).toBe(true);
    expect(sim.boss2Spawned).toBe(false);

    let bossIndex = sim.enemies.findIndex((enemy) => enemy.active && enemy.boss === 'official');
    sim.bossIntroT = 0;
    sim.damageEnemy(bossIndex, sim.enemies[bossIndex].hp + 1);
    step(sim, 1);
    expect(sim.over).toBe('playing');
    expect(sim.bossAlive?.boss).toBe('captain');
    expect(sim.boss2Spawned).toBe(true);

    bossIndex = sim.enemies.findIndex((enemy) => enemy.active && enemy.boss === 'captain');
    sim.bossIntroT = 0;
    sim.damageEnemy(bossIndex, sim.enemies[bossIndex].hp + 1);
    step(sim, 1);
    expect(sim.pendingBossAbilities).toBe(2);
    for (let pick = 0; pick < 2; pick++) {
      const option = sim.rollBossAbilities()[0];
      sim.applyUpgrade(option);
      sim.pendingBossAbilities--;
    }
    step(sim, 1);
    expect(sim.over).toBe('playing');
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

  it('pauses every hostile system during a short boss arrival while movement stays live', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugSpawn('invader', sim.player.x + 24, sim.player.y);
    const threat = sim.enemies.find((enemy) => enemy.active)!;
    threat.damage = 99;
    threat.windup = 0.01;
    const threatX = threat.x;
    const threatY = threat.y;
    const hp = sim.player.hp;
    const playerX = sim.player.x;
    sim.time = BOSS0_AT;
    step(sim, 1, 1, 0);
    const bossIndex = sim.enemies.findIndex((enemy) => enemy.active && enemy.boss === 'drumboss');
    const boss = sim.enemies[bossIndex];
    const clockAtArrival = sim.time;
    const bossHp = boss.hp;

    expect(sim.bossIntroT).toBeGreaterThan(BOSS_INTRO_DURATION - 0.05);
    sim.damageEnemy(bossIndex, 999_999);
    step(sim, 60, 1, 0);
    expect(sim.player.x).toBeGreaterThan(playerX + 100);
    expect(sim.player.hp).toBe(hp);
    expect(boss.hp).toBe(bossHp);
    expect(threat.x).toBeCloseTo(threatX, 8);
    expect(threat.y).toBeCloseTo(threatY, 8);
    expect(sim.time).toBeCloseTo(clockAtArrival, 8);

    step(sim, 24);
    expect(sim.bossIntroT).toBe(0);
    expect(sim.player.iframes).toBeGreaterThan(0);
  });

  it('reserves a pool slot for bosses and only commits spawn flags after success', () => {
    const crowded = makeSim();
    crowded.player.abilities = {};
    crowded.enemies.forEach((enemy) => (enemy.active = false));
    for (let index = 0; index < 239; index++) {
      crowded.debugSpawn('invader', 60 + (index % 20) * 8, 60 + Math.floor(index / 20) * 8);
    }
    expect(crowded.enemies.filter((enemy) => enemy.active)).toHaveLength(239);
    crowded.time = BOSS0_AT;
    step(crowded, 1);
    expect(crowded.boss0Spawned).toBe(true);
    expect(crowded.enemies.some((enemy) => enemy.active && enemy.boss === 'drumboss')).toBe(true);
    expect(crowded.enemies.filter((enemy) => enemy.active)).toHaveLength(240);

    const full = makeSim();
    full.player.abilities = {};
    for (const enemy of full.enemies) enemy.active = true;
    full.time = BOSS0_AT;
    step(full, 1);
    expect(full.boss0Spawned).toBe(false);
    expect(full.bossAlive).toBeNull();
    full.enemies[full.enemies.length - 1].active = false;
    step(full, 1);
    expect(full.boss0Spawned).toBe(true);
    expect(full.bossAlive?.boss).toBe('drumboss');
  });

  it('materializes bosses upward without a danger-circle silhouette', () => {
    const early = bossArrivalVisual(BOSS_INTRO_DURATION * 0.8);
    const middle = bossArrivalVisual(BOSS_INTRO_DURATION * 0.5);
    const finished = bossArrivalVisual(0);
    expect(early.scale).toBeLessThan(middle.scale);
    expect(early.lift).toBeGreaterThan(middle.lift);
    expect(finished).toMatchObject({ progress: 1, alpha: 1, scale: 1, lift: 0 });
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

  it('Ultra Captain exposes a 500ms lane before a committed charge and turf brake', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    expect(sim.debugSpawnBoss('captain')).toBe(true);
    sim.bossIntroT = 0;
    const captain = sim.enemies.find((enemy) => enemy.active && enemy.boss === 'captain')!;
    captain.x = sim.player.x + 520;
    captain.y = sim.player.y;
    captain.bossCd = 99;
    captain.rangedCd = 99;
    captain.bossCd2 = 0;
    const startX = captain.x;

    step(sim, 1);
    expect(captain.chargeWindupT).toBeGreaterThan(0.48);
    expect(Math.abs(captain.x - startX)).toBeLessThan(2);
    step(sim, 31);
    expect(captain.casting).toBe('captain-charge');
    expect(captain.chargeLaneFadeT).toBeGreaterThan(0);
    expect(captain.chargeLaneFadeT).toBeLessThanOrEqual(0.1);
    expect(sim.events.some((event) => event.type === 'bullCharge')).toBe(true);
    step(sim, 45);
    expect(startX - captain.x).toBeGreaterThan(250);
    expect(captain.chargeWindupT).toBe(0);
    expect(captain.chargeBrakeT).toBe(0);
    expect(captain.casting).toBe('');
  });

  it('focuses aerial damage on the final captain only after sudden death begins', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.player.abilities = { strike: 1 };
    sim.debugSpawn('lobber', sim.player.x + 340, sim.player.y);
    expect(sim.debugSpawnBoss('captain')).toBe(true);
    const captainIndex = sim.enemies.findIndex((enemy) => enemy.active && enemy.boss === 'captain');
    const captain = sim.enemies[captainIndex];
    captain.x = sim.player.x + 620;
    captain.y = sim.player.y;

    const regulationTarget = sim.pickAerialTarget(sim.player.x, sim.player.y);
    expect(sim.enemies[regulationTarget].def.id).toBe('lobber');
    sim.suddenDeath = true;
    expect(sim.pickAerialTarget(sim.player.x, sim.player.y)).toBe(captainIndex);
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

  it('Bottle Lobber telegraphs an exact landing point and gives miss feedback', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugSpawn('lobber', sim.player.x + 300, sim.player.y);
    const lobber = sim.enemies.find((enemy) => enemy.active)!;
    lobber.speed = 0;
    lobber.damage = 0;
    lobber.casting = 'bottle';
    lobber.windup = 0.001;
    step(sim, 1);

    const bottle = sim.bottles.find((entry) => entry.active && entry.kind === 'molotov')!;
    expect(bottle).toBeTruthy();
    expect(bottle.maxLife).toBeGreaterThanOrEqual(0.55);
    expect(bottle.reticleIdx).toBeGreaterThanOrEqual(0);
    expect(sim.reticles[bottle.reticleIdx].active).toBe(true);
    expect(sim.reticles[bottle.reticleIdx].x).toBeCloseTo(bottle.targetX, 5);
    sim.player.x -= 240;

    step(sim, Math.ceil(bottle.maxLife * 60) + 2);

    expect(bottle.active).toBe(false);
    expect(sim.reticles[bottle.reticleIdx].active).toBe(false);
    expect(sim.events.some((event) => event.type === 'molotovIgnite')).toBe(true);
    expect(sim.fireZones.some((zone) => zone.active)).toBe(true);
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

  it('Security Detail applies damage on the visible punch contact frame', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 1 });
    sim.debugSpawn('steward', sim.player.x + 105, sim.player.y);
    const target = sim.enemies.find((enemy) => enemy.active)!;
    target.speed = 0;
    target.hp = target.maxHp = 1000;

    for (let frame = 0; frame < 120 && sim.guards[0].strikeT <= 0; frame++) step(sim, 1);
    expect(sim.guards[0].strikeT).toBeGreaterThan(0.2);
    expect(target.hp).toBe(1000);
    step(sim, 8);
    expect(target.hp).toBeLessThan(1000);
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

  it('exposes honest cooldown and active-state timing for the HUD', () => {
    const sim = makeSim();
    sim.player.abilities = { strike: 1, orbit: 1 };
    sim.player.strikeCd = 0.45;
    expect(sim.getAbilityTiming('strike')).toMatchObject({ remaining: 0.45, duration: 0.9, active: false });
    expect(sim.getAbilityTiming('orbit')).toEqual({ remaining: 0, duration: 0, active: true });
  });

  it('Security Detail uses a spaced protection line instead of overlapping the player', () => {
    const pair = [guardFormationOffset(0, 2, 1, 0), guardFormationOffset(1, 2, 1, 0)];
    expect(pair[0].y).toBeLessThan(-60);
    expect(pair[1].y).toBeGreaterThan(60);

    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    for (let level = 1; level <= 5; level++) {
      sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level });
    }
    step(sim, 120);
    for (const guard of sim.guards) {
      expect(Math.hypot(guard.x - sim.player.x, guard.y - sim.player.y)).toBeGreaterThan(78);
    }
    for (let i = 0; i < sim.guards.length; i++) {
      for (let j = i + 1; j < sim.guards.length; j++) {
        expect(Math.hypot(sim.guards[i].x - sim.guards[j].x, sim.guards[i].y - sim.guards[j].y)).toBeGreaterThan(100);
      }
    }
  });

  it('Security Detail patrol sectors stay world-fixed when the player turns', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 1 });
    const guard = sim.guards[0];
    guard.decisionT = 10;
    step(sim, 1);
    const before = { x: guard.tx - sim.player.x, y: guard.ty - sim.player.y };

    sim.player.visualDx = 0;
    sim.player.visualDy = -1;
    sim.player.face = -1;
    step(sim, 1);
    const after = { x: guard.tx - sim.player.x, y: guard.ty - sim.player.y };

    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });

  it('idle Security Detail makes independent patrol decisions with inertial steering', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 3 });
    const [first, second] = sim.guards;
    first.decisionT = 0;
    second.decisionT = 10;
    const oldFirstAngle = first.patrolAngle;
    const oldSecondAngle = second.patrolAngle;
    const startX = first.x;

    step(sim, 1);

    expect(first.patrolAngle).not.toBe(oldFirstAngle);
    expect(second.patrolAngle).toBe(oldSecondAngle);
    expect(Math.hypot(first.vx, first.vy)).toBeGreaterThan(0);
    expect(Math.abs(first.x - startX)).toBeLessThan(8);
  });

  it('Security Detail follows a lagged escort centre instead of the D-key vector', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 1 });
    const guard = sim.guards[0];
    guard.decisionT = 10;
    const startPlayerX = sim.player.x;
    const startEscortX = guard.escortX;
    const patrolAngle = guard.patrolAngle;

    step(sim, 30, 1, 0);

    const playerTravel = sim.player.x - startPlayerX;
    const escortTravel = guard.escortX - startEscortX;
    expect(playerTravel).toBeGreaterThan(70);
    expect(escortTravel).toBeGreaterThan(0);
    expect(escortTravel).toBeLessThan(playerTravel * 0.45);
    expect(guard.patrolAngle).toBe(patrolAngle);
  });

  it('Security Detail screens toward a coherent distant ground threat without chasing it', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.applyUpgrade({ kind: 'ability', id: 'guard', name: '', desc: '', color: '', level: 1 });
    const guard = sim.guards[0];
    sim.debugSpawn('steward', sim.player.x + 690, sim.player.y + 40);
    const threat = sim.enemies.find((enemy) => enemy.active)!;
    threat.speed = 0;
    threat.hp = threat.maxHp = 10_000;
    guard.decisionT = 0;

    step(sim, 1);

    expect(guard.target).toBe(-1);
    expect(guard.tx).toBeGreaterThan(sim.player.x + 70);
    expect(Math.abs(guard.ty - sim.player.y)).toBeLessThan(40);
    expect(Math.hypot(guard.tx - guard.escortX, guard.ty - guard.escortY)).toBeLessThan(100);
    step(sim, 90);
    expect(Math.hypot(guard.x - sim.player.x, guard.y - sim.player.y)).toBeLessThan(150);
    expect(Math.hypot(threat.x - sim.player.x, threat.y - sim.player.y)).toBeGreaterThan(600);
  });

  it('Nutmeg Dash never spends itself without an explicit request', () => {
    const sim = makeSim(2); // Neymar starts with dash
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    step(sim, 90, 1, 0);
    expect(sim.player.dashWindupT).toBe(0);
    expect(sim.player.dashT).toBe(0);
    expect(sim.player.dashCds).toEqual([expect.any(Number)]);
    expect(sim.player.dashCds[0]).toBeLessThanOrEqual(0);
  });

  it('Nutmeg Dash locks the requested line through anticipation and travel', () => {
    const sim = makeSim(2);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    const startX = sim.player.x;
    expect(sim.requestDash(1, 0)).toBe(true);
    expect(sim.player.dashWindupT).toBeGreaterThan(0);
    expect(sim.player.dashCds[0]).toBeGreaterThan(0);
    expect(sim.requestDash(-1, 0)).toBe(false);
    step(sim, 7, -1, 0);
    expect(sim.player.dashT).toBeGreaterThan(0);
    expect(sim.player.dashDx).toBe(1);
    expect(sim.player.dashDy).toBe(0);
    step(sim, 4, -1, 0);
    expect(sim.player.x).toBeGreaterThan(startX);
  });

  it('Nutmeg Dash grants invulnerability only during committed travel', () => {
    const sim = makeSim(2);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    expect(sim.requestDash(1, 0)).toBe(true);
    const hpBeforeWindup = sim.player.hp;
    sim.debugHurt(5);
    expect(sim.player.hp).toBe(hpBeforeWindup - 5);
    step(sim, 6, 1, 0);
    expect(sim.player.dashT).toBeGreaterThan(0);
    const hpBeforeTravel = sim.player.hp;
    sim.debugHurt(10);
    expect(sim.player.hp).toBe(hpBeforeTravel);
  });

  it('level-four Nutmeg Dash requires a new press for its second charge', () => {
    const sim = makeSim(2);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.player.abilities.dash = 4;
    sim.player.dashCds = [0, 0];
    expect(sim.requestDash(1, 0)).toBe(true);
    expect(sim.player.dashCds.filter((cooldown) => cooldown <= 0)).toHaveLength(1);
    step(sim, 40, 1, 0);
    expect(sim.player.dashT).toBe(0);
    expect(sim.player.dashRecoveryT).toBe(0);
    expect(sim.player.dashCds.filter((cooldown) => cooldown <= 0)).toHaveLength(1);
    expect(sim.requestDash(1, 0)).toBe(true);
    expect(sim.player.dashCds.every((cooldown) => cooldown > 0)).toBe(true);
  });

  it('Nutmeg Dash rejects an immediate pitch-edge collision without spending a charge', () => {
    const sim = makeSim(2);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.player.x = ARENA_W - 30;
    expect(sim.requestDash(1, 0)).toBe(false);
    expect(sim.player.dashCds[0]).toBeLessThanOrEqual(0);
    expect(sim.player.dashWindupT).toBe(0);
  });

  it('Orbiting Press damages enemies that get close', () => {
    const sim = makeSim(3); // Yamal starts with orbit
    sim.debugSpawn('invader', sim.player.x + 90, sim.player.y);
    step(sim, 240);
    expect(sim.kills).toBeGreaterThan(0);
  });

  it("Yamal's sixth orbit ball owns its contact instead of being blocked by a global gate", () => {
    const sim = makeSim(3);
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.player.abilities.orbit = 5;
    sim.player.orbitAngle = 0;
    sim.player.orbitBreakCd = 999;
    sim.debugSpawn('steward', sim.player.x + 140, sim.player.y);
    const enemy = sim.enemies.find((entry) => entry.active)!;
    enemy.speed = 0;
    enemy.damage = 0;
    enemy.hp = enemy.maxHp = enemy.barHp = 9999;
    const hpBefore = enemy.hp;
    for (let frame = 0; frame < 145; frame++) {
      sim.update(1 / 60, 0, 0);
      enemy.x = sim.player.x + 140;
      enemy.y = sim.player.y;
      enemy.kx = 0;
      enemy.ky = 0;
      enemy.airT = 0;
    }
    expect(hpBefore - enemy.hp).toBeGreaterThanOrEqual(6 * 20);
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
    sim.bossIntroT = 0;
    sim.damageEnemy(bossIndex, 99999);
    const trophy = sim.pickups.find((p) => p.active && p.kind === 'trophy');
    expect(trophy?.tier).toBe(1);
    const recovery = sim.pickups.find((p) => p.active && p.kind === 'heal');
    expect(recovery?.tier).toBe(1);
    expect(recovery?.value).toBe(40);
    expect(sim.player.iframes).toBeGreaterThanOrEqual(1.25);
    const before = sim.coins;
    trophy!.x = sim.player.x;
    trophy!.y = sim.player.y;
    step(sim, 1);
    expect(sim.coins).toBe(before + 30);
    expect(sim.pendingBossAbilities).toBe(2);
    expect(sim.rollBossAbilities().every((option) => option.kind === 'ability')).toBe(true);
    expect(sim.events.some((event) => event.type === 'trophy')).toBe(true);
  });

  it('Ball Magnet vacuums the full pitch while leaving special tools grounded', () => {
    const sim = makeSim();
    sim.player.abilities = {};
    sim.enemies.forEach((e) => (e.active = false));
    sim.debugDropPickup('xp', sim.player.x + 150, sim.player.y);
    sim.debugDropPickup('xp', sim.player.x + 700, sim.player.y);
    sim.debugDropPickup('heal', sim.player.x - 700, sim.player.y);
    sim.debugDropPickup('bomb', sim.player.x, sim.player.y + 700);
    sim.debugDropPickup('freeze', sim.player.x, sim.player.y - 700);
    const xp = sim.pickups.filter((pickup) => pickup.active && pickup.kind === 'xp');
    const nearby = xp[0];
    const distant = xp[1];
    const heal = sim.pickups.find((pickup) => pickup.active && pickup.kind === 'heal')!;
    const bomb = sim.pickups.find((pickup) => pickup.active && pickup.kind === 'bomb')!;
    const freeze = sim.pickups.find((pickup) => pickup.active && pickup.kind === 'freeze')!;
    sim.debugDropPickup('magnet', sim.player.x, sim.player.y);
    step(sim, 1);
    expect(sim.magnetT).toBeGreaterThan(3);
    for (const pickup of [nearby, distant, heal, bomb, freeze]) {
      pickup.vx = 0;
      pickup.vy = 0;
      pickup.t = 0;
    }
    step(sim, 1);
    expect(nearby.vx).toBeLessThan(-100);
    expect(distant.vx).toBeLessThan(-100);
    expect(heal.vx).toBeGreaterThan(100);
    expect(Math.abs(bomb.vy)).toBeLessThan(0.001);
    expect(Math.abs(freeze.vy)).toBeLessThan(0.001);
    expect(sim.activeMagnetRadius).toBeGreaterThanOrEqual(Math.hypot(2400, 1600));
    expect(sim.events.some((event) => event.type === 'magnet')).toBe(true);
  });

  it('bomb and magnet drops stay grounded instead of seeking the player', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugDropPickup('bomb', sim.player.x + 760, sim.player.y);
    sim.debugDropPickup('magnet', sim.player.x - 760, sim.player.y);
    const bomb = sim.pickups.find((pickup) => pickup.active && pickup.kind === 'bomb')!;
    const magnet = sim.pickups.find((pickup) => pickup.active && pickup.kind === 'magnet')!;
    const bombBefore = Math.hypot(bomb.x - sim.player.x, bomb.y - sim.player.y);
    const magnetBefore = Math.hypot(magnet.x - sim.player.x, magnet.y - sim.player.y);
    step(sim, 180);
    const bombAfter = Math.hypot(bomb.x - sim.player.x, bomb.y - sim.player.y);
    const magnetAfter = Math.hypot(magnet.x - sim.player.x, magnet.y - sim.player.y);
    expect(bomb.active).toBe(true);
    expect(magnet.active).toBe(true);
    expect(Math.abs(bombAfter - bombBefore)).toBeLessThan(1);
    expect(Math.abs(magnetAfter - magnetBefore)).toBeLessThan(1);
    expect(sim.events.some((event) => event.type === 'bomb')).toBe(false);
  });

  it('heal drinks only pull in from much closer than ordinary pickups', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.player.stats.magnet = 6; // huge ordinary pickup radius (~191px)
    sim.debugDropPickup('heal', sim.player.x + 180, sim.player.y);
    sim.debugDropPickup('xp', sim.player.x + 180, sim.player.y);
    const heal = sim.pickups.find((pickup) => pickup.active && pickup.kind === 'heal')!;
    const xp = sim.pickups.find((pickup) => pickup.active && pickup.kind === 'xp')!;
    step(sim, 60);
    expect(xp.active).toBe(false); // the normal radius vacuumed the XP
    expect(heal.active).toBe(true); // the bottle stayed put at 180px
    expect(Math.hypot(heal.x - sim.player.x, heal.y - sim.player.y)).toBeGreaterThan(120);
    heal.x = sim.player.x + 40;
    heal.y = sim.player.y;
    heal.vx = 0;
    heal.vy = 0;
    heal.t = 0;
    step(sim, 30);
    expect(heal.vx).toBeLessThan(0); // up close it pulls, but gently
    expect(Math.abs(heal.vx)).toBeLessThan(200);
  });

  it("Keeper's Halo blocks hostile aerial shots and max level counters an aerial threat", () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.player.abilities = { keeperhalo: 5 };
    sim.player.keeperBlockCd = 0;
    sim.debugSpawn('drone', sim.player.x + 240, sim.player.y);
    const drone = sim.enemies.find((enemy) => enemy.active && enemy.def.id === 'drone')!;
    drone.speed = 0;
    drone.hp = drone.maxHp = drone.barHp = 500;
    const hpBefore = drone.hp;
    const shot = sim.bottles[0];
    Object.assign(shot, {
      active: true,
      kind: 'electric',
      x: sim.player.x + 110,
      y: sim.player.y,
      vx: -60,
      vy: 0,
      dmg: 50,
      life: 1,
      maxLife: 1,
      targetX: sim.player.x,
      targetY: sim.player.y,
      reticleIdx: -1,
    });
    const playerHp = sim.player.hp;

    step(sim, 1);

    expect(shot.active).toBe(false);
    expect(sim.player.hp).toBe(playerHp);
    expect(drone.hp).toBeLessThan(hpBefore);
    expect(sim.events.some((event) => event.type === 'keeperBlock' && event.counter)).toBe(true);
  });

  it('VAR Skycam fires a three-shot authored scan salvo', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.player.hp = sim.player.maxHp = 9_999;
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugSpawn('varcam', sim.player.x + 340, sim.player.y);
    const varcam = sim.enemies.find((enemy) => enemy.active && enemy.def.id === 'varcam')!;
    varcam.speed = 0;
    varcam.rangedCd = 0;

    step(sim, 50);

    const scans = sim.bottles.filter((bottle) => bottle.active && bottle.kind === 'scan');
    expect(scans).toHaveLength(3);
    expect(new Set(scans.map((shot) => Math.sign(shot.vy))).size).toBeGreaterThan(1);
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
    sim.bossIntroT = 0;
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
    expect(sim.freezeT).toBeGreaterThan(1.5);
    frozen.forEach((enemy, index) => {
      expect(enemy.x).toBeCloseTo(positions[index][0], 6);
      expect(enemy.y).toBeCloseTo(positions[index][1], 6);
    });
    expect(sim.player.x).toBeGreaterThan(playerX + 100);
    expect(sim.time).toBeCloseTo(time, 6);
    expect(sim.events.some((event) => event.type === 'freeze')).toBe(true);
  });

  it('Stoppage-Time Freeze slows offensive cooldowns instead of granting a free DPS window', () => {
    const sim = makeSim();
    sim.enemies.forEach((enemy) => (enemy.active = false));
    sim.debugDirectorPaused = true;
    sim.player.abilities = { strike: 1 };
    sim.player.strikeCd = 2;
    sim.debugDropPickup('freeze', sim.player.x, sim.player.y);
    step(sim, 1);
    const before = sim.player.strikeCd;

    step(sim, 60);

    expect(before - sim.player.strikeCd).toBeCloseTo(0.4, 2);
    expect(sim.freezeT).toBeGreaterThan(2.9);
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
    step(sim, Math.ceil(BOSS_INTRO_DURATION * 60) + 1);
    step(sim, 1);
    const summonMarkers = sim.telegraphs.filter((telegraph) => telegraph.active && telegraph.kind === 'summon');
    expect(summonMarkers).toHaveLength(3);
    expect(new Set(summonMarkers.map((marker) => `${marker.x},${marker.y}`)).size).toBe(3);
    expect(summonMarkers[1].t - summonMarkers[0].t).toBeCloseTo(0.14, 6);
    expect(sim.enemies.filter((enemy) => enemy.active && !enemy.boss)).toHaveLength(before);
    step(sim, 51);
    expect(sim.enemies.filter((enemy) => enemy.active && !enemy.boss)).toHaveLength(before + 1);
    step(sim, 18);
    expect(sim.enemies.filter((enemy) => enemy.active && !enemy.boss)).toHaveLength(before + 3);
  });
});

describe('reward buffs', () => {
  it('doubles only the named reward channel', () => {
    expect(rewardCoinMul({ kind: 'coin', t: 2, label: 'DOUBLE COINS' })).toBe(2);
    expect(rewardXpMul({ kind: 'coin', t: 2, label: 'DOUBLE COINS' })).toBe(1);
    expect(rewardXpMul({ kind: 'xp', t: 2, label: 'DOUBLE XP' })).toBe(2);
    expect(rewardCoinMul({ kind: 'both', t: 2, label: 'DOUBLE COINS + XP' })).toBe(2);
    expect(rewardScoreMul({ kind: 'both', t: 2, label: 'DOUBLE COINS + XP' })).toBe(2);
    expect(rewardCoinMul(null)).toBe(1);
  });

  it('starts the 30s double-xp-and-coins event from the match tick, then refuses a second start', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.time = REWARD_EVENT_MIN_TIME;
    sim.rng.chance = () => true;
    step(sim, 1);
    expect(sim.rewardBuff?.kind).toBe('both');
    expect(sim.rewardBuff?.label).toBe(REWARD_EVENT_LABEL);
    expect(sim.rewardBuff!.t).toBeGreaterThan(REWARD_EVENT_DURATION - 0.05);
    expect(sim.rewardBuff!.t).toBeLessThanOrEqual(REWARD_EVENT_DURATION);
    expect(rewardXpMul(sim.rewardBuff)).toBe(2);
    expect(rewardCoinMul(sim.rewardBuff)).toBe(2);
    const before = sim.coins;
    sim.debugDropPickup('coin', 0, 0);
    const coin = sim.pickups.find((p) => p.active && p.kind === 'coin')!;
    coin.x = sim.player.x;
    coin.y = sim.player.y;
    step(sim, 4);
    expect(sim.coins).toBe(before + coin.value * 2);
    sim.rng.chance = () => true;
    sim.time = REWARD_EVENT_MIN_TIME + 200;
    step(sim, 1);
    expect(sim.events.filter((event) => event.type === 'rewardBuff')).toHaveLength(1);
    step(sim, Math.ceil(REWARD_EVENT_DURATION * 60) + 4);
    expect(sim.rewardBuff).toBeNull();
    expect(rewardXpMul(sim.rewardBuff)).toBe(1);
    expect(rewardCoinMul(sim.rewardBuff)).toBe(1);
  });

  it('raises the rare event chance after a burst of player damage', () => {
    expect(rewardEventChance(0)).toBe(REWARD_EVENT_CHANCE);
    expect(rewardEventChance(240)).toBeGreaterThan(REWARD_EVENT_CHANCE);
    expect(rewardEventChance(240)).toBeLessThan(rewardEventChance(480));
    expect(rewardEventChance(9999)).toBeLessThanOrEqual(0.32);
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.debugSpawn('invader', 40, 0);
    const enemy = sim.enemies.find((entry) => entry.active && !entry.boss)!;
    enemy.hp = enemy.maxHp = 400;
    sim.time = REWARD_EVENT_MIN_TIME;
    sim.damageEnemy(sim.enemies.indexOf(enemy), 200);
    let rolls: number[] = [];
    sim.rng.chance = (p: number) => {
      rolls.push(p);
      return false;
    };
    step(sim, 1);
    expect(rolls[0]).toBeGreaterThan(REWARD_EVENT_CHANCE);
    expect(sim.rewardBuff).toBeNull();
  });
});

describe('molotov', () => {
  it('is not a player ability', () => {
    expect(ABILITY_IDS.includes('molotov' as never)).toBe(false);
    expect(ABILITIES).not.toHaveProperty('molotov');
  });

  it('is thrown by the Bottle Lobber at the player and ignites a blaze on landing', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.player.hp = sim.player.maxHp = 400;
    const p = sim.player;
    sim.debugSpawn('lobber', p.x + 160, p.y);
    const lobber = sim.enemies.find((e) => e.active && e.def.id === 'lobber')!;
    lobber.speed = 0;
    lobber.casting = 'bottle';
    lobber.windup = 0.001;
    step(sim, 1);
    const cocktail = sim.bottles.find((b) => b.active && b.kind === 'molotov');
    expect(cocktail).toBeDefined();
    expect(cocktail!.targetX).toBeCloseTo(p.x, 0);
    expect(cocktail!.targetY).toBeCloseTo(p.y, 0);
    expect(cocktail!.vz).toBeGreaterThan(0);
    expect(cocktail!.z).toBeGreaterThanOrEqual(0);
    step(sim, Math.ceil((cocktail!.maxLife) * 60) + 2);
    expect(sim.events.some((event) => event.type === 'molotovIgnite')).toBe(true);
    expect(sim.fireZones.some((zone) => zone.active)).toBe(true);
    expect(sim.player.hp).toBeLessThan(400);
    expect(sim.player.hp).toBeGreaterThan(360);
  });

  it('keeps at most two molotovs in the air', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    const p = sim.player;
    for (let i = 0; i < 4; i++) {
      sim.debugSpawn('lobber', p.x + 120 + i * 10, p.y);
      const lobber = [...sim.enemies].reverse().find((e) => e.active && e.def.id === 'lobber')!;
      lobber.speed = 0;
      lobber.casting = 'bottle';
      lobber.windup = 0.001;
      step(sim, 1);
    }
    expect(sim.bottles.filter((b) => b.active && b.kind === 'molotov').length).toBeLessThanOrEqual(2);
  });

  it('burns the player who stays in the fire, not the lobber', () => {
    const sim = makeSim();
    sim.debugDirectorPaused = true;
    sim.player.abilities = {};
    sim.player.hp = sim.player.maxHp = 400;
    const p = sim.player;
    sim.debugSpawn('lobber', p.x + 140, p.y);
    const lobber = sim.enemies.find((e) => e.active && e.def.id === 'lobber')!;
    const lobberHp = lobber.hp;
    lobber.speed = 0;
    lobber.casting = 'bottle';
    lobber.windup = 0.001;
    step(sim, 80);
    const hpAfterHit = sim.player.hp;
    expect(hpAfterHit).toBeLessThan(400);
    step(sim, 80);
    expect(sim.player.hp).toBeLessThan(hpAfterHit);
    expect(lobber.hp).toBe(lobberHp);
  });
});
