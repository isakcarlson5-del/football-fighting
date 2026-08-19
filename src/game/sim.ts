/**
 * Game simulation: pure logic, no DOM/canvas access (unit-testable).
 * Fixed-step updated from main.ts; render.ts only reads state.
 */

import { Rng, weightedPick } from '../core/rng';
import { clamp, dist2, TAU } from '../core/math';
import {
  ABILITIES,
  BOSS0_AT,
  BOSS1_AT,
  BOSS2_AT,
  BOSSES,
  ENEMY_PACE_MULT,
  ENEMIES,
  FREEZE_DURATION,
  PLAYER_PACE_MULT,
  RUN_LENGTH,
  STATS,
  difficultyProgress,
  eliteInterval,
  enemyDamageScale,
  enemySpawnWeight,
  enemySpeedScale,
  hpScale,
  powerPressure,
  spawnRate,
  xpForLevel,
  type AbilityId,
  type BossId,
  type EnemyDef,
  type PlayerDef,
  type StatId,
} from './data';
import type { Save } from './meta';

export const ARENA_W = 2600;
export const ARENA_H = 1416; // tuned playfield height; the renderer maps the arena plate's grass rect onto this exactly

/** Ordinary director ingress is reduced while a boss owns the encounter.
 * Boss-authored summons remain untouched, so each fight keeps its identity
 * without an unreadable ambient horde accumulating behind it. */
export function bossDirectorIngressMultiplier(boss: Enemy['boss']): number {
  if (boss === 'drumboss') return 0.1;
  if (boss === 'official') return 0.16;
  if (boss === 'captain') return 0.22;
  return 1;
}

/** Smoothly clears visual room for the next boss without introducing a wave
 * boundary. The ordinary director returns to its full curve between fights. */
export function bossApproachIngressMultiplier(secondsUntilBoss: number): number {
  if (!Number.isFinite(secondsUntilBoss) || secondsUntilBoss >= 45) return 1;
  if (secondsUntilBoss <= 0) return 0.12;
  return 0.12 + 0.88 * (secondsUntilBoss / 45);
}

/** Draft weights keep runs genuinely random: every draw is equal, with only
 *  a very slight lean toward owned tools so a build can evolve without
 *  railroading the player into one track. */
export function upgradeDraftWeight(kind: 'new-ability' | 'owned-ability' | 'stat'): number {
  if (kind === 'new-ability') return 12;
  if (kind === 'owned-ability') return 14;
  return 13;
}

/** Soft readability ceiling for ordinary enemies. Difficulty still grows via
 * the clock curves; only new director ingress fades as the live crowd fills
 * the pitch. Existing enemies and authored boss summons are never removed. */
export function directorPopulationIngressMultiplier(activeOrdinary: number, time: number): number {
  const target = clamp(46 + Math.max(0, time) * 0.04, 46, 70);
  const fadeStart = target * 0.72;
  if (activeOrdinary <= fadeStart) return 1;
  if (activeOrdinary >= target) return 0;
  return 1 - (activeOrdinary - fadeStart) / Math.max(1, target - fadeStart);
}

/** Later enemies cost much more time and damage to defeat, so their XP keeps
 * pace with that investment instead of forcing density to carry progression. */
export function enemyXpRewardMultiplier(time: number): number {
  return 1 + difficultyProgress(time) * 1.8;
}

export const STREAK_KILL_COUNT = 10;
export const STREAK_KILL_WINDOW = 8;
export const REWARD_EVENT_DURATION = 30;
export const REWARD_EVENT_MIN_TIME = 80;
export const REWARD_EVENT_INTERVAL = 50;
export const REWARD_EVENT_CHANCE = 0.012;
export const REWARD_EVENT_LABEL = 'DOUBLE XP + COINS';
export const HEAL_FX_DURATION = 1.6;

export type RewardBuffKind = 'both' | 'coin' | 'xp';

export interface RewardBuff {
  kind: RewardBuffKind;
  t: number;
  label: string;
}

export function rewardCoinMul(buff: RewardBuff | null): number {
  return buff && (buff.kind === 'both' || buff.kind === 'coin') ? 2 : 1;
}

export function rewardXpMul(buff: RewardBuff | null): number {
  return buff && (buff.kind === 'both' || buff.kind === 'xp') ? 2 : 1;
}

export function rewardScoreMul(buff: RewardBuff | null): number {
  return buff && buff.kind === 'both' ? 2 : 1;
}

/** Boss bases already encode encounter order. This modest independent scale
 * prevents the ordinary mob HP curve from turning later bosses into timers. */
export function bossHealthMultiplier(which: BossId, pressure: number): number {
  const build = clamp(pressure, 0, 1);
  if (which === 'official') return 1.15 + build * 0.15;
  if (which === 'captain') return 1.35 + build * 0.2;
  return 1;
}

/** Optional physical traversal limits for arena variants with raised scenery.
 *  Defaults intentionally preserve the original flat-arena collision bounds. */
export interface ArenaTraversalInsets {
  playerX?: number;
  playerY?: number;
  enemyX?: number;
  enemyY?: number;
}

/** Extra hybrid-only centre clearance for boss billboard silhouettes. Combat
 * radii deliberately stay smaller, so this must never affect hit detection. */
export function hybridBossSceneryPad(boss: Enemy['boss']): number {
  if (boss === 'drumboss') return 128;
  if (boss === 'official') return 136;
  if (boss === 'captain') return 166;
  return 0;
}

/** Raised aerial billboards are wider than their compact damage radius. */
export type HybridSceneryEdge = 'side' | 'far' | 'near';

export function hybridEnemySceneryPad(
  enemy: Pick<Enemy, 'boss' | 'def' | 'radius'>,
  edge: HybridSceneryEdge = 'side',
): number {
  // Billboards extend upward from their feet. The far edge needs full visual
  // height clearance in front of the stands; the near edge only needs their
  // physical foot/shadow footprint or it creates a conspicuous dead strip.
  if (edge === 'near') return Math.max(0, enemy.radius - 20);
  const bossPad = hybridBossSceneryPad(enemy.boss);
  if (bossPad > 0) return bossPad;
  if (enemy.def.behavior === 'aerial') return 54;
  return Math.max(0, enemy.radius - 20);
}

/** Physical half-body contact for the deliberately oversized hybrid bosses.
 * Projectile and ability hitboxes continue using Enemy.radius. */
export function hybridBossBodyContact(boss: Enemy['boss']): number {
  if (boss === 'drumboss') return 108;
  if (boss === 'official') return 112;
  if (boss === 'captain') return 148;
  return 0;
}

export interface HybridBodyContactPosition { x: number; y: number }
const HYBRID_BODY_ESCAPE_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2],
];

/** Finds the nearest valid non-overlapping position inside the physical pitch.
 * Cardinal/diagonal escape candidates handle an actor trapped between a giant
 * boss and raised scenery, where a simple radial push becomes invalid. */
export function resolveHybridBossBodyContact(
  playerX: number,
  playerY: number,
  bossX: number,
  bossY: number,
  contact: number,
  insetX: number,
  insetY: number,
  out: HybridBodyContactPosition = { x: playerX, y: playerY },
): HybridBodyContactPosition {
  const originX = clamp(playerX, insetX, ARENA_W - insetX);
  const originY = clamp(playerY, insetY, ARENA_H - insetY);
  const dx = originX - bossX;
  const dy = originY - bossY;
  const distance = Math.hypot(dx, dy);
  if (distance >= contact) {
    out.x = originX;
    out.y = originY;
    return out;
  }

  let bestX = originX;
  let bestY = originY;
  let bestTravel = Number.POSITIVE_INFINITY;
  const consider = (directionX: number, directionY: number): void => {
    const candidateX = clamp(bossX + directionX * contact, insetX, ARENA_W - insetX);
    const candidateY = clamp(bossY + directionY * contact, insetY, ARENA_H - insetY);
    const separation = Math.hypot(candidateX - bossX, candidateY - bossY);
    if (separation + 0.01 < contact) return;
    const travel = (candidateX - originX) ** 2 + (candidateY - originY) ** 2;
    if (travel >= bestTravel) return;
    bestTravel = travel;
    bestX = candidateX;
    bestY = candidateY;
  };
  if (distance > 0.001) consider(dx / distance, dy / distance);
  for (const [directionX, directionY] of HYBRID_BODY_ESCAPE_DIRECTIONS) consider(directionX, directionY);
  out.x = bestX;
  out.y = bestY;
  return out;
}
export const KICK_DURATION = 0.36;
export const KICK_CONTACT_DELAY = KICK_DURATION / 2;
/** The body may make a small early correction, then commits before contact so
 * a moving target cannot magnetically rotate the full kick strip. */
export const KICK_AIM_LOCK_DELAY = 0.1;

/** Preserve directional control while giving the kick a planted football
 * contact beat. This returns to full control during the last recovery frames. */
export function kickMovementScale(kickT: number): number {
  if (kickT <= 0) return 1;
  const elapsed = clamp(KICK_DURATION - kickT, 0, KICK_DURATION);
  if (elapsed < KICK_AIM_LOCK_DELAY) {
    const u = elapsed / KICK_AIM_LOCK_DELAY;
    return 0.82 + (0.58 - 0.82) * u;
  }
  if (elapsed < KICK_CONTACT_DELAY + 0.055) return 0.46;
  const recoveryU = (elapsed - KICK_CONTACT_DELAY - 0.055) / Math.max(0.001, KICK_DURATION - KICK_CONTACT_DELAY - 0.055);
  return 0.58 + (1 - 0.58) * clamp(recoveryU, 0, 1);
}
/** Locomotion tuning is expressed in seconds so every player's authored top
 * speed retains the same responsive football feel. */
export const PLAYER_ACCEL_TIME = 0.13;
export const PLAYER_BRAKE_TIME = 0.075;
export const PLAYER_TURN_TIME = 0.095;
/** One complete left/right foot cycle in world units. Animation and turf
 * contact both derive from this distance, so slow movement cannot moonwalk. */
export const PLAYER_RUN_FRAMES = 12;
/** The delivered hero atlases contain 12 authored frames. A 0.095 frame-rate
 * coefficient therefore maps to a 126.32-unit stride pair: at any real speed,
 * phase advances at `speed * 0.095` frames/s without wall-clock skating. */
export const PLAYER_RUN_CYCLE_DISTANCE = PLAYER_RUN_FRAMES / 0.095;
export const PLAYER_RUN_FPS = 18;
/** The hybrid camera compresses world Y on screen. Locomotion art therefore
 * advances by projected screen distance, while collision and gameplay remain
 * in unmodified world units. */
export const PLAYER_VISUAL_Y_SCALE = 0.62;
export const PLAYER_PIVOT_DURATION = 0.05;
/** One fixed-step grace frame after committed dash travel has ended. */
export const DASH_IFRAME_DURATION = 1 / 60;
export const BULL_CHARGE_WINDUP = 0.4;
/** The flare runner owns the longer authored leap. Heavy knockback uses its
 * own shorter duration stored per enemy, so both arcs start and end at turf. */
export const LEAPER_AIR_DURATION = 0.55;
export const AERIAL_FLIGHT_DURATION = 5;
export const AERIAL_OVERHEAT_DURATION = 1.35;
export const ELITE_HP_MULT = 4;
export const ELITE_DAMAGE_MULT = 1.35;
export const ELITE_XP_MULT = 4;
export const CAPTAIN_MELEE_MAX = 84;
export const CAPTAIN_CHARGE_MAX = 72;

export function enemyAirLift(airT: number, airMaxT: number): number {
  if (!Number.isFinite(airT) || airT <= 0) return 0;
  const duration = Math.max(0.001, Number.isFinite(airMaxT) && airMaxT > 0 ? airMaxT : airT);
  const progress = clamp(1 - airT / duration, 0, 1);
  const height = duration >= 0.5 ? 40 : 22;
  return Math.sin(Math.PI * progress) * height;
}

/** Turn the visual body through real neighboring 45 degree views instead of
 * snapping across several authored atlases. Simulation velocity stays fully
 * responsive; this is presentation-only and never resets the gait phase. */
export function stepMovementOctant(previousOctant: number, targetOctant: number): number {
  const previous = ((Math.round(previousOctant) % 8) + 8) % 8;
  const target = ((Math.round(targetOctant) % 8) + 8) % 8;
  const clockwise = (target - previous + 8) % 8;
  if (clockwise === 0) return previous;
  if (clockwise <= 4) return (previous + 1) % 8;
  return (previous + 7) % 8;
}

/** Target cadence for the existing six-frame enemy strips and twelve-frame
 * directional boss strips. Actual playback is distance-driven, so slows,
 * haste and collision stalls remain visually honest rather than moonwalking. */
export function enemyRunTargetFps(id: string, boss: '' | BossId): number {
  if (boss === 'captain') return 16;
  if (boss === 'official') return 14;
  if (boss === 'drumboss') return 12;
  switch (id) {
    case 'sprinter':
    case 'flare':
    case 'paparazzo':
      return 16;
    case 'bull':
      return 13;
    case 'invader':
    case 'lobber':
    case 'flag':
    case 'vuvuzela':
      return 12;
    case 'foam':
    case 'chant':
      return 11;
    case 'steward':
      return 10;
    case 'drummer':
      return 9;
    case 'mascot':
      return 8;
    case 'banner':
      return 6;
    default:
      return 11;
  }
}

export function enemyRunCycleDistance(
  enemy: Pick<Enemy, 'def' | 'boss' | 'speed'>,
  frames = enemy.boss ? 12 : 6,
): number {
  const safeFrames = Math.max(1, Math.floor(frames));
  const safeSpeed = Math.max(1, Number.isFinite(enemy.speed) ? enemy.speed : enemy.def.speed);
  return safeSpeed * safeFrames / enemyRunTargetFps(enemy.def.id, enemy.boss);
}

/** Guards use the same distance-authored cycle despite different variants.
 * Their higher world speed naturally advances the six concrete frames faster. */
export function guardRunCycleDistance(variant: 0 | 1 | 2 | 3): number {
  // Six concrete frames at each variant's authored top-speed cadence.
  return variant === 0 ? 110 : variant === 1 ? 112.5 : variant === 2 ? 122.5 : 120;
}
/** Real-time presentation window. The match clock and every hostile system are
 * paused, while the player may still reposition before the boss becomes live. */
export const BOSS_INTRO_DURATION = 1.35;
/** Melee timing is shared by simulation and rendering. Damage is resolved only
 * after the visible body has travelled past the authored contact frame. */
export const ENEMY_MELEE_LUNGE_DURATION = 0.18;
export const BOSS_MELEE_LUNGE_DURATION = 0.22;
export const MELEE_CONTACT_PROGRESS = 0.58;
export const MELEE_RECOVERY_DURATION = 0.16;
/** Nutmeg Dash is the game's single active movement action. The brief
 * anticipation makes the choice readable; recovery prevents level-four's
 * second charge from being consumed by the same press. */
export const DASH_ANTICIPATION_DURATION = 0.09;
export const DASH_RECOVERY_DURATION = 0.14;
export const DASH_SPEED = 560;

/** Stable close-protection slots keep allies out of the player's silhouette.
 * Small squads form a line; larger squads become a readable perimeter. */
export function guardFormationOffset(
  index: number,
  count: number,
  forwardX: number,
  forwardY: number,
): { x: number; y: number } {
  const length = Math.hypot(forwardX, forwardY) || 1;
  const fx = forwardX / length;
  const fy = forwardY / length;
  const sx = -fy;
  const sy = fx;
  if (count <= 1) return { x: fx * 68, y: fy * 68 };
  if (count === 2) {
    const side = index === 0 ? -68 : 68;
    return { x: fx * 18 + sx * side, y: fy * 18 + sy * side };
  }
  if (count === 3) {
    if (index === 2) return { x: -fx * 72, y: -fy * 72 };
    const side = index === 0 ? -64 : 64;
    return { x: fx * 42 + sx * side, y: fy * 42 + sy * side };
  }
  const angle = Math.atan2(fy, fx) + ((index + 0.5) / count) * TAU;
  return { x: Math.cos(angle) * 96, y: Math.sin(angle) * 96 };
}
const MAX_ENEMIES = 240;
const BOSS_RESERVED_ENEMY_SLOTS = 1;
const MAX_SPAWNS_PER_STEP = 3;
/** Local crowd radius used by horde cohesion so packs advance as a loose
 *  shared front instead of collapsing into one point. Members inside this
 *  radius feel the pull; the pull fades as the pack tightens. */
const HORDE_COHESION_RADIUS = 420;
const RANGED_MAX_ALIVE = 6;
const DRONE_MAX_ALIVE = 4;
const VARCAM_MAX_ALIVE = 2;
const BULL_MAX_ALIVE = 3;
const SUMMONER_MAX_ALIVE = 2;
const CELL = 72;
const LOB_GRAVITY = 1500; // aerial lob downward acceleration (world units/s²)
const ENEMY_ROSTER = Object.values(ENEMIES) as EnemyDef[];
const RANGED_BEHAVIORS = new Set(['ranged', 'cone', 'flanker', 'aerial']);

interface DirectorCounts {
  ranged: number;
  drones: number;
  varcams: number;
  bulls: number;
  summoners: number;
}

export interface VelocityStep {
  vx: number;
  vy: number;
}

/** Translate actual health loss into a restrained material flash. Zero-damage
 * contacts stay visible as a weak block while crits/heavy hits earn contrast. */
export function enemyHitFeedbackStrength(
  actualDamage: number,
  maxHp: number,
  force: number,
  crit = false,
): number {
  const damage = Math.max(0, Number.isFinite(actualDamage) ? actualDamage : 0);
  if (damage <= 0) return 0.12;
  const readableDamageBand = clamp(Math.max(10, maxHp * 0.12), 10, 60);
  const damageWeight = clamp(damage / readableDamageBand, 0, 1);
  const forceWeight = clamp(force / 360, 0, 1);
  return clamp(0.2 + damageWeight * 0.56 + forceWeight * 0.16 + (crit ? 0.12 : 0), 0.22, 1);
}

/** Guard run art is authored as a committed side-diagonal sprint. Long near-
 * vertical paths therefore take a readable lateral arc instead of making the
 * painted body moonwalk sideways. Close contact remains exact. */
export function guardAuthoredRunVector(
  dx: number,
  dy: number,
  preferredSide: -1 | 1,
  applyArc = true,
): { x: number; y: number } {
  let runX = Number.isFinite(dx) ? dx : 0;
  const runY = Number.isFinite(dy) ? dy : 0;
  if (applyArc && Math.abs(runY) > 0.001 && Math.abs(runX) < Math.abs(runY) * 0.94) {
    // The authored guard strips are committed side-diagonal sprints. Give a
    // near-vertical route a real diagonal stride instead of letting a
    // side-facing body slide straight up or down. Use the destination side as
    // soon as it is meaningful so the zig-zag converges on the target.
    const destinationSide = Math.abs(runX) > 8 ? (Math.sign(runX) as -1 | 1) : preferredSide;
    runX = destinationSide * Math.abs(runY) * 0.94;
  }
  const length = Math.hypot(runX, runY) || 1;
  return { x: runX / length, y: runY / length };
}

export interface GuardRunPresentation {
  face: -1 | 1;
  /** Canvas rotation applied before mirroring. Its world-space vertical sign
   * remains identical to the real velocity after the horizontal flip. */
  tilt: number;
}

/** Derive the guard's painted heading from its real velocity, never from the
 * player's input or the guard's target. This keeps inertial turns honest: the
 * strip flips only after the body has actually changed travel direction. */
export function guardRunPresentation(
  vx: number,
  vy: number,
  fallbackFace: number,
): GuardRunPresentation {
  const safeVx = Number.isFinite(vx) ? vx : 0;
  const safeVy = Number.isFinite(vy) ? vy : 0;
  const face: -1 | 1 = Math.abs(safeVx) > 4
    ? (safeVx > 0 ? 1 : -1)
    : fallbackFace < 0 ? -1 : 1;
  const worldSlope = Math.atan2(safeVy, Math.max(28, Math.abs(safeVx)));
  return {
    face,
    tilt: face * clamp(worldSlope * 0.18, -0.145, 0.145),
  };
}

/** Move a velocity vector toward its target without component-wise diagonal
 * bias. A fixed maximum delta keeps the 60 Hz and lower-rate tests equivalent. */
export function approachVelocity(
  vx: number,
  vy: number,
  targetVx: number,
  targetVy: number,
  maxDelta: number,
): VelocityStep {
  const dx = targetVx - vx;
  const dy = targetVy - vy;
  const distance = Math.hypot(dx, dy);
  if (distance <= maxDelta || distance < 0.000001) return { vx: targetVx, vy: targetVy };
  const scale = Math.max(0, maxDelta) / distance;
  return { vx: vx + dx * scale, vy: vy + dy * scale };
}

/** Eight-way direction with an angular dead band around the previous sector.
 * The dead band prevents a joystick hovering on a 22.5 degree boundary from
 * alternating between two full-body raster strips. */
export function hystereticMovementOctant(
  previousOctant: number,
  dx: number,
  dy: number,
  margin = Math.PI / 24,
): number {
  const previous = ((Math.round(previousOctant) % 8) + 8) % 8;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.0001) return previous;
  const angle = Math.atan2(dy, dx);
  const previousAngle = previous * (Math.PI / 4);
  const delta = Math.atan2(Math.sin(angle - previousAngle), Math.cos(angle - previousAngle));
  if (Math.abs(delta) <= Math.PI / 8 + Math.max(0, margin)) return previous;
  return ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
}

/* ------------------------------------------------------------------ */
/* Entity types                                                        */
/* ------------------------------------------------------------------ */

export interface Enemy {
  active: boolean;
  def: EnemyDef;
  /** Base invaders rotate through three equally complete visual silhouettes. */
  variant: 0 | 1 | 2;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** Delayed health used by the renderer for a readable damage-loss trail. */
  barHp: number;
  barHitT: number;
  speed: number;
  damage: number;
  radius: number;
  xp: number;
  elite: boolean;
  boss: '' | BossId;
  kx: number; // knockback velocity
  ky: number;
  flash: number;
  /** Alpha multiplier derived from real damage rather than one universal hit. */
  flashStrength: number;
  /** Recoil pose timer; intentionally outlasts the brief white impact flash. */
  hurtT: number;
  /** Screen-readable hit direction retained after physics velocity decays. */
  hurtDx: number;
  hurtDy: number;
  hurtStrength: number;
  /** Dedicated Orbiting Press reaction window for impact/skid VFX. */
  orbitHitT: number;
  /** Visual follow-through shared by melee, ranged and special attacks. */
  attackAnimT: number;
  attackCd: number;
  /** Per-orbiting-ball contact gates. A global gate made Yamal's sixth ball
   * cosmetic whenever it followed another ball around the same target. */
  orbitBallCds: number[];
  /** Short presentation throttle shared by all orbit balls on this enemy. */
  orbitCd: number;
  dashMark: number; // dash id that already hit this enemy
  stun: number;
  slow: number;
  face: number; // -1 | 1
  animT: number;
  /** Cumulative real locomotion distance. Run strips read this phase instead
   * of wall-clock time, preserving foot plants through slow/haste/turns. */
  runDistance: number;
  runStep: number;
  /** True only when the enemy changed world position during the latest step. */
  moving: boolean;
  /** Last real world-space movement direction retained for directional art. */
  moveDx: number;
  moveDy: number;
  /** generic behavior cooldown (bottle throws, leaps, thumps, flashes, chants) */
  rangedCd: number;
  /** melee wind-up: >0 while visibly pulling back before the strike */
  windup: number;
  /** >0 during the strike lunge itself (after windup) */
  lungeT: number;
  /** Direction captured at anticipation start and retained through recovery. */
  meleeDx: number;
  meleeDy: number;
  /** True after the current swing has crossed its single contact frame. */
  meleeHit: boolean;
  /** >0: briefly airborne (big knockback / leapers). Ground effects sweep
   *  harmlessly underneath; aerial attacks connect. Never a permanent immunity. */
  airT: number;
  /** Duration captured at launch so the renderer can draw a true 0-height to
   * apex to 0-height parabola for both short shoves and long leaps. */
  airMaxT: number;
  /** Permanent aerial threats periodically descend into a short grounded
   * overheat window so a legal Ground-only build always has counterplay. */
  aerialFlightT: number;
  aerialGroundT: number;
  /** haste aura multiplier from nearby Flag Bearers (recomputed each frame) */
  haste: number;
  /** >0: boss haste pulse active */
  boostT: number;
  /** non-melee wind-up marker ('' = melee swing, 'bottle' = lobbed bottle) */
  casting: string;
  // boss ability timers
  bossCd: number;
  bossCd2: number;
  /** >0 while a special attack is being telegraphed; drives the cast pose. */
  telegraph: number;
  /** Dedicated captain charge anticipation. It cannot share melee windup,
   * because boss melee converts that timer into a different contact action. */
  chargeWindupT: number;
  /** Presentation-only tail for the locked charge lane. The lane remains for
   * 100ms after commitment so it fades instead of popping off on one frame. */
  chargeLaneFadeT: number;
  /** Direction locked when a bull commits to its charge. */
  chargeDx: number;
  chargeDy: number;
  /** Prevents a charge from damaging the player more than once. */
  chargeHit: boolean;
  /** Visible post-charge turf brake. Movement eases to zero while the body
   * remains committed to the locked charge direction. */
  chargeBrakeT: number;
}

/** AERIAL lane: a lobbed ball with real height (z) flying to a reserved far
 *  target. Ordinary Precision Strikes hit only that locked target; explicitly
 *  special relays can still opt into a landing radius. */
export interface Ball {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number; // height above the pitch
  vz: number;
  dmg: number;
  splash: number; // landing splash radius
  ricochet: number; // re-lob bounces remaining
  spin: number;
  tx: number; // landing target point
  ty: number;
  targetIdx: number; // reserved enemy index (-1 = ground target)
  flightT: number;
  maxFlightT: number;
}

/** Pooled AERIAL homing projectile. A fixed pool keeps large volleys mobile-safe. */
export interface Seeker {
  active: boolean;
  kind: 'curveball' | 'goldenboot';
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  trail1X: number;
  trail1Y: number;
  trail2X: number;
  trail2Y: number;
  trailClock: number;
  z: number;
  vx: number;
  vy: number;
  speed: number;
  turnRate: number;
  targetIdx: number;
  dmg: number;
  splash: number;
  knock: number;
  life: number;
  maxLife: number;
  chain: number;
  angle: number;
  phase: number;
}

export interface Bottle {
  active: boolean;
  kind: 'bottle' | 'electric' | 'scan' | 'molotov';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  dmg: number;
  life: number;
  maxLife: number;
  targetX: number;
  targetY: number;
  reticleIdx: number;
  /** molotov impact payload */
  splashR: number;
  burn: number;
  dps: number;
}

/** Hostile molotov ground blaze. Burns the player if they stay in it. */
export interface FireZone {
  active: boolean;
  x: number;
  y: number;
  r: number;
  dps: number;
  life: number;
  maxLife: number;
  tick: number;
}

export interface Pickup {
  active: boolean;
  kind: 'xp' | 'coin' | 'heal' | 'trophy' | 'magnet' | 'bomb' | 'freeze';
  tier: 1 | 2 | 3;
  x: number;
  y: number;
  vx: number;
  vy: number;
  value: number;
  t: number;
}

export interface Guard {
  /** Visual/combat silhouette: rookie, close protection, heavy, fast scout. */
  variant: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  tx: number; // autonomous escort or attack target
  ty: number;
  vx: number;
  vy: number;
  /** A lagged escort centre follows position, never input or facing directly. */
  escortX: number;
  escortY: number;
  /** World-space escort sector. It does not rotate when the player turns. */
  patrolHomeAngle: number;
  patrolAngle: number;
  patrolRadius: number;
  patrolDirection: -1 | 1;
  decisionT: number;
  swingCd: number;
  strikeT: number;
  strikeTarget: number;
  strikeHit: boolean;
  blockT: number;
  moving: boolean;
  face: number;
  animT: number;
  /** Actual travelled distance driving the concrete run-strip cycle. */
  runDistance: number;
  target: number; // enemy index or -1
}

export interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  grav: number;
}

export interface DmgNum {
  active: boolean;
  x: number;
  y: number;
  value: string;
  life: number;
  crit: boolean;
}

/** Short pooled contact burst. These are intentionally separate from the
 *  general particle pool so dense combat keeps one readable impact origin per
 *  hit without allocating or flooding the pitch with debris. */
export interface Impact {
  active: boolean;
  x: number;
  y: number;
  life: number;
  maxLife: number;
  angle: number;
  strength: number;
  color: string;
  kind: 'contact' | 'landing' | 'airburst' | 'blastair' | 'kickground';
}

export interface Telegraph {
  active: boolean;
  x: number;
  y: number;
  r: number;
  t: number;
  max: number;
  kind: 'flare' | 'shock' | 'cone' | 'card' | 'flash' | 'chant' | 'summon';
  dmg: number;
  dir: number; // cone facing (radians)
  summon: 0 | 1 | 2 | 3;
  /** Exact add within a boss formation; -1 is a legacy/group marker. */
  summonIndex: number;
}

export interface Ring {
  active: boolean;
  x: number;
  y: number;
  r: number;
  maxR: number;
  life: number;
  color: string;
}

/** GROUND lane: an expanding pitch-hugging pressure ring that damages and
 *  shoves close mobs as the ring front passes them (once per ring). */
export interface Pressure {
  active: boolean;
  x: number;
  y: number;
  r: number;
  maxR: number;
  dmg: number;
  knock: number;
  hitSet: number[];
}

/** Ground-layer marker for an aimed or incoming aerial lob (purely visual). */
export interface Reticle {
  active: boolean;
  x: number;
  y: number;
  t: number;
  max: number;
  targetIdx: number;
  phase: 'aim' | 'landing';
}

/** Death visual: a fallen enemy that topples, sinks and fades (no gameplay). */
export interface Corpse {
  active: boolean;
  x: number;
  y: number;
  enemyId: string;
  variant: 0 | 1 | 2;
  boss: '' | BossId;
  elite: boolean;
  face: number;
  t: number;
  max: number;
}

export type SimEvent =
  | { type: 'hit'; x: number; y: number; heavy: boolean; crit: boolean }
  | { type: 'kill'; x: number; y: number; elite: boolean }
  | { type: 'kick' }
  | { type: 'xp' }
  | { type: 'coin' }
  | { type: 'trophy'; coins: number; tier: 1 | 2 | 3; abilityPicks: 2 }
  | { type: 'magnet' }
  | { type: 'bomb'; x: number; y: number; defeated: number }
  | { type: 'freeze'; duration: number }
  | { type: 'levelup' }
  | { type: 'whistle'; x: number; y: number }
  | { type: 'pressure'; x: number; y: number }
  | { type: 'blast'; x: number; y: number }
  | { type: 'lobLand'; x: number; y: number }
  | { type: 'seekerLaunch'; kind: 'curveball' | 'goldenboot' }
  | { type: 'seekerHit'; kind: 'curveball' | 'goldenboot'; x: number; y: number }
  | { type: 'dash' }
  | { type: 'hurt' }
  | { type: 'heal' }
  | { type: 'rewardBuff'; label: string }
  | { type: 'punch' }
  | { type: 'vuvuzela'; x: number; y: number }
  | { type: 'flash'; x: number; y: number }
  | { type: 'chant'; x: number; y: number }
  | { type: 'zap'; x: number; y: number }
  | { type: 'keeperBlock'; x: number; y: number; counter: boolean }
  | { type: 'scanImpact'; x: number; y: number }
  | { type: 'molotovIgnite'; x: number; y: number }
  | { type: 'upgradeFx'; max: boolean }
  | { type: 'bullCharge'; x: number; y: number }
  | { type: 'bossStep'; boss: BossId }
  | { type: 'heavyStep'; id: 'mascot' }
  | { type: 'maxAbility'; name: string }
  | { type: 'bossSpawn'; name: string; title: string; duration: number }
  | { type: 'bossDie'; x: number; y: number; coins: number }
  | { type: 'victory' }
  | { type: 'defeat' }
  | { type: 'flare' };

/* ------------------------------------------------------------------ */
/* Player + run state                                                  */
/* ------------------------------------------------------------------ */

export interface PlayerState {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpNext: number;
  face: number;
  moving: boolean;
  /** Physical locomotion velocity, excluding dash and enemy knockback. */
  moveVx: number;
  moveVy: number;
  /** Last physical movement direction used by camera lead and turf contact. */
  moveDx: number;
  moveDy: number;
  /** Hysteretic eight-way direction used only by authored player art. */
  visualDir: number;
  visualDirCandidate: number;
  visualDirHoldT: number;
  visualDx: number;
  visualDy: number;
  /** Three rendered beats for a planted 180-degree football cut. */
  pivotT: number;
  pivotFromDir: number;
  pivotToDir: number;
  /** Smoothed procedural body lean from real angular velocity. */
  turnLean: number;
  lastMoveAngle: number;
  /** 0..1 forward body lean while building speed. */
  accelLean: number;
  /** Cumulative locomotion distance and monotonic planted-step serial. */
  runDistance: number;
  runStep: number;
  animT: number;
  iframes: number;
  hurtT: number;
  hurtDx: number;
  hurtDy: number;
  regenAcc: number;
  kx: number; // knockback velocity (heavy enemy hits, vuvuzela blasts)
  ky: number;
  slowT: number; // >0: slowed (paparazzo flash)
  abilities: Partial<Record<AbilityId, number>>;
  stats: Record<StatId, number>;
  // ability timers
  strikeCd: number;
  curveballCd: number;
  bootseekersCd: number;
  whistleCd: number;
  whistlePulse: number;
  /** Target-scan ticks are kept off the HUD: the dock only ever reflects
   * cooldown after the ability has actually been used, never a retry poll. */
  curveballRetry: number;
  bootseekersRetry: number;
  pressureRetry: number;
  blastRetry: number;
  pressureCd: number;
  pressureQueue: number; // staggered pulses still to release
  pressureQueueT: number;
  pressureCastLevel: number;
  pressureCastX: number;
  pressureCastY: number;
  blastCd: number;
  kickT: number; // >0 during the lob's kick animation (contact at half duration)
  /** Locked primary target and facing vector for the complete kick motion. */
  kickTargetIdx: number;
  aimDx: number;
  aimDy: number;
  dashCds: number[];
  dashT: number;
  /** Remaining committed-travel invulnerability plus one fixed-step grace. */
  dashIframesT: number;
  /** A post-iframe hit preserves 70% of the committed dash momentum. */
  dashMomentum: number;
  dashWindupT: number;
  dashRecoveryT: number;
  dashDx: number;
  dashDy: number;
  dashId: number;
  orbitAngle: number;
  /** L5 Orbiting Press periodically converts a contact into an aerial counter. */
  orbitBreakCd: number;
  /** Keeper's Halo rotates independently from Orbiting Press and owns one
   * global parry recovery so visual shield count never grants accidental
   * frame-perfect invulnerability. */
  keeperAngle: number;
  keeperBlockCd: number;
  /** Generated Captain's Heart activation clip after a max-HP draft. */
  heartFxT: number;
  healT: number;
}

export interface UpgradeOption {
  kind: 'ability' | 'stat' | 'heal' | 'coins';
  id: string;
  name: string;
  desc: string;
  color: string;
  level: number; // new level for abilities (1 = new)
  maxed?: boolean;
  currentLabel?: string;
  afterLabel?: string;
  capLabel?: string;
  metaLabel?: string;
  synergyLabel?: string;
}

export function abilityCadenceLabel(id: AbilityId, level: number): string {
  const lvl = clamp(Math.floor(level), 1, 5);
  const cadence: Partial<Record<AbilityId, number[]>> = {
    strike: [0, 0.9, 0.9, 0.8, 0.8, 0.65],
    curveball: [0, 3.4, 3.2, 3.0, 2.7, 2.35],
    bootseekers: [0, 4.5, 4.3, 4.0, 3.6, 3.1],
    whistle: [0, 3.5, 3.5, 3.0, 3.0, 2.2],
    pressure: [0, 2.6, 2.6, 2.3, 2.3, 2.0],
    blast: [0, 4.8, 4.8, 4.4, 3.8, 3.2],
    dash: [0, 5, 5, 4, 4, 3],
    keeperhalo: [0, 1.55, 1.2, 0.9, 0.62, 0.34],
  };
  const seconds = cadence[id]?.[lvl];
  return seconds ? `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s cooldown` : 'Continuous';
}

export function statProgressLabel(id: StatId, level: number): string {
  const rank = Math.max(0, Math.floor(level));
  switch (id) {
    case 'power': return `+${rank * 8}% damage`;
    case 'speed': return `+${rank * 5}% move speed`;
    case 'maxhp': return `+${rank * 15} max HP`;
    case 'regen': return `+${(rank * 0.4).toFixed(1)} HP/s`;
    case 'magnet': return `+${rank * 18}% pickup radius`;
    case 'armor': return `-${rank} incoming damage`;
  }
}

export class Sim {
  rng = new Rng();
  private invaderVariantCursor = 0;
  time = 0;
  over: 'playing' | 'won' | 'lost' = 'playing';
  kills = 0;
  coins = 0;
  rewardBuff: RewardBuff | null = null;
  private rewardEventUsed = false;
  private killTimes: number[] = [];
  private nextRandomBuffAt = REWARD_EVENT_MIN_TIME;
  player!: PlayerState;
  enemies: Enemy[] = [];
  balls: Ball[] = [];
  seekers: Seeker[] = [];
  bottles: Bottle[] = [];
  fireZones: FireZone[] = [];
  pickups: Pickup[] = [];
  guards: Guard[] = [];
  particles: Particle[] = [];
  impacts: Impact[] = [];
  dmgNums: DmgNum[] = [];
  telegraphs: Telegraph[] = [];
  rings: Ring[] = [];
  pressures: Pressure[] = [];
  reticles: Reticle[] = [];
  corpses: Corpse[] = [];
  events: SimEvent[] = [];
  pendingLevelups = 0;
  /** Boss trophies queue two ability-only drafts before ordinary level-ups. */
  pendingBossAbilities = 0;
  /** Shared draft currency for the complete run, including boss loot. */
  rerollsRemaining = 2;
  boss0Spawned = false;
  boss1Spawned = false;
  boss2Spawned = false;
  bossAlive: Enemy | null = null;
  /** Full time has been reached but one or more scheduled boss encounters are
   *  still unresolved. The clock stays at 90' until the final whistle is fair. */
  suddenDeath = false;
  slowZones: { x: number; y: number; r: number; t: number }[] = [];
  flareZones: { x: number; y: number; r: number; t: number; tick: number }[] = [];
  /** Active rare-pickup effects are public so the renderer can communicate them. */
  magnetT = 0;
  freezeT = 0;
  /** Remaining real-time boss arrival window. Public for renderer and QA. */
  bossIntroT = 0;
  /** Deterministic screenshot fixture only; never enabled in normal play. */
  debugBossIntroHold = false;
  /** Deterministic summon-marker fixture only; never enabled in normal play. */
  debugTelegraphHold = false;
  /** Deterministic melee-pose fixture only; never enabled in normal play. */
  debugHostileHold = false;

  private grid = new Map<number, number[]>();
  private flagBearers: Enemy[] = [];
  /** Fractional spawn tokens. A capped budget prevents hitch recovery bursts. */
  private spawnBudget = 0;
  private eliteAcc = 0;
  /** Horde spawn anchor: consecutive spawns share one edge segment so a run
   *  opens with packs assembling instead of enemies drizzling in everywhere. */
  private spawnAnchor = { x: 40, y: 40, side: -1, born: -999, count: 0 };
  /** Deterministic visual-fixture switch; normal runs never enable it. */
  debugDirectorPaused = false;
  debugHoldRewardEvent = false;
  private def: PlayerDef;
  private deferred: { t: number; fn: () => void }[] = [];
  private powerMult = 1;
  private speedMult = 1;
  private magnetMult = 1;
  private guardDmgMult = 1;
  private guardExtra = 0;
  private xpMult = 1;
  private trailAcc = 0;
  private bombResolving = false;
  private playerEdgeInsetX = 30;
  private playerEdgeInsetY = 30;
  private enemyEdgeInsetX = 20;
  private enemyEdgeInsetY = 20;
  private radiusAwareSceneryEdges = false;
  private bossBodyContactScratch: HybridBodyContactPosition = { x: 0, y: 0 };

  constructor(
    def: PlayerDef,
    save: Save,
    seed = (Math.random() * 0xffffffff) >>> 0,
    traversalInsets?: ArenaTraversalInsets,
  ) {
    this.def = def;
    this.rng = new Rng(seed);
    if (traversalInsets) {
      this.radiusAwareSceneryEdges = true;
      this.playerEdgeInsetX = traversalInsets.playerX ?? this.playerEdgeInsetX;
      this.playerEdgeInsetY = traversalInsets.playerY ?? this.playerEdgeInsetY;
      this.enemyEdgeInsetX = traversalInsets.enemyX ?? this.enemyEdgeInsetX;
      this.enemyEdgeInsetY = traversalInsets.enemyY ?? this.enemyEdgeInsetY;
    }
    const mb = save.bonuses();
    this.powerMult = def.power * mb.power;
    this.speedMult = mb.speed;
    this.magnetMult = mb.magnet;
    this.guardDmgMult = mb.guardDamage;
    this.guardExtra = mb.guardExtra;
    if (def.id === 'yamal') this.xpMult = 1.2;
    this.player = {
      x: ARENA_W / 2,
      y: ARENA_H / 2,
      hp: def.maxHp,
      maxHp: def.maxHp,
      level: 1,
      xp: 0,
      xpNext: xpForLevel(1),
      face: 1,
      moving: false,
      moveVx: 0,
      moveVy: 0,
      moveDx: 1,
      moveDy: 0,
      visualDir: 0,
      visualDirCandidate: 0,
      visualDirHoldT: 0,
      visualDx: 1,
      visualDy: 0,
      pivotT: 0,
      pivotFromDir: 0,
      pivotToDir: 0,
      turnLean: 0,
      lastMoveAngle: 0,
      accelLean: 0,
      runDistance: 0,
      runStep: 0,
      animT: 0,
      iframes: 0,
      hurtT: 0,
      hurtDx: 0,
      hurtDy: 0,
      regenAcc: 0,
      kx: 0,
      ky: 0,
      slowT: 0,
      abilities: { [def.startAbility]: 1 },
      stats: { power: 0, speed: 0, maxhp: 0, regen: 0, magnet: 0, armor: 0 },
      strikeCd: 0,
      curveballCd: 0,
      bootseekersCd: 0,
      whistleCd: 0,
      whistlePulse: -1,
      curveballRetry: 0,
      bootseekersRetry: 0,
      pressureRetry: 0,
      blastRetry: 0,
      pressureCd: 0,
  pressureQueue: 0,
  pressureQueueT: 0,
  pressureCastLevel: 0,
      pressureCastX: ARENA_W / 2,
      pressureCastY: ARENA_H / 2,
      blastCd: 0,
      kickT: 0,
      kickTargetIdx: -1,
      aimDx: 1,
      aimDy: 0,
      dashCds: [0],
      dashT: 0,
      dashIframesT: 0,
      dashMomentum: 1,
      dashWindupT: 0,
      dashRecoveryT: 0,
      dashDx: 1,
      dashDy: 0,
      dashId: 0,
      orbitAngle: 0,
      orbitBreakCd: 0,
      keeperAngle: 0,
      keeperBlockCd: 0,
      heartFxT: 0,
      healT: 0,
    };
    if (def.id === 'neymar') this.player.dashCds = [0];
    this.spawnInitial();
  }

  /* ---------------- derived stats ---------------- */

  get moveSpeed(): number {
    return this.def.speed * PLAYER_PACE_MULT * this.speedMult * (1 + this.player.stats.speed * 0.05);
  }
  get damageMult(): number {
    return this.powerMult * (1 + this.player.stats.power * 0.08);
  }
  get pickupRadius(): number {
    return this.pickupRadiusForRank(this.player.stats.magnet);
  }
  get activeMagnetRadius(): number {
    // Match pickup: once collected, Ball Magnet covers every reachable point
    // on the pitch. Individual special tools are filtered separately below.
    return Math.hypot(ARENA_W, ARENA_H);
  }
  get regen(): number {
    return this.player.stats.regen * 0.4;
  }
  get armor(): number {
    return this.player.stats.armor;
  }

  /** Smooth pressure estimate used by the deterministic pacing functions. */
  get threatPressure(): number {
    const abilityRanks = Object.values(this.player.abilities).reduce((sum, rank) => sum + (rank ?? 0), 0);
    const statRanks = Object.values(this.player.stats).reduce((sum, rank) => sum + rank, 0);
    return powerPressure(abilityRanks, statRanks);
  }

  /** Every scheduled boss has entered and the currently active encounter has
   *  been defeated. Spawn flags are committed only after a successful spawn. */
  get bossFinaleResolved(): boolean {
    return this.boss0Spawned && this.boss1Spawned && this.boss2Spawned && !this.bossAlive;
  }

  /** Permanent aerial troops and temporarily launched enemies share the same
   * lane rules. First Touch Blast is deliberately HYBRID and can hit both. */
  private isAerialEnemy(e: Enemy): boolean {
    return (e.def.behavior === 'aerial' && e.aerialGroundT <= 0) || e.airT > 0;
  }

  private pickupRadiusForRank(rank: number): number {
    return Math.min(220, 92 * this.magnetMult * (1 + Math.max(0, rank) * 0.18));
  }

  private statHasEffect(id: StatId): boolean {
    if (id !== 'magnet') return true;
    const before = this.pickupRadiusForRank(this.player.stats.magnet);
    const after = this.pickupRadiusForRank(this.player.stats.magnet + 1);
    return after >= before * 1.1;
  }

  abilityLevel(id: AbilityId): number {
    return this.player.abilities[id] ?? 0;
  }

  /* ---------------- pools ---------------- */

  private alloc<T extends { active: boolean }>(arr: T[]): T | null {
    for (const e of arr) if (!e.active) return e;
    return null;
  }

  /** Ordinary director spawns never consume the final enemy slot. The boss
   * path may use the full pool, guaranteeing that a scheduled encounter cannot
   * disappear behind a 240-enemy allocation race. */
  private allocEnemy(forBoss: boolean): Enemy | null {
    const promisedBossAdds = this.telegraphs.reduce(
      (total, telegraph) => total + (telegraph.active && telegraph.kind === 'summon' ? 1 : 0),
      0,
    );
    const reserved = BOSS_RESERVED_ENEMY_SLOTS + promisedBossAdds;
    const limit = forBoss ? this.enemies.length : Math.max(0, this.enemies.length - reserved);
    for (let index = 0; index < limit; index++) {
      const enemy = this.enemies[index];
      if (!enemy.active) return enemy;
    }
    return null;
  }

  private spawnInitial(): void {
    this.enemies = [];
    for (let i = 0; i < MAX_ENEMIES; i++) {
      this.enemies.push({
        active: false, def: ENEMIES.invader, variant: 0, x: 0, y: 0, hp: 1, maxHp: 1, barHp: 1, barHitT: 0, speed: 0, damage: 0,
        radius: 10, xp: 1, elite: false, boss: '', kx: 0, ky: 0, flash: 0, flashStrength: 0, hurtT: 0, hurtDx: 0, hurtDy: 0, hurtStrength: 0, orbitHitT: 0, attackAnimT: 0, attackCd: 0, orbitBallCds: [0, 0, 0, 0, 0, 0], orbitCd: 0,
        dashMark: -1, stun: 0, slow: 0, face: 1, animT: 0, runDistance: 0, runStep: 0, moving: false, moveDx: 0, moveDy: 1, rangedCd: 2, windup: 0, lungeT: 0, meleeDx: 1, meleeDy: 0, meleeHit: false, airT: 0, airMaxT: 0, aerialFlightT: 0, aerialGroundT: 0, haste: 1, boostT: 0, casting: '', bossCd: 4, bossCd2: 8, telegraph: 0, chargeWindupT: 0, chargeLaneFadeT: 0, chargeDx: 0, chargeDy: 0, chargeHit: false, chargeBrakeT: 0,
      });
    }
    for (let i = 0; i < 400; i++) this.balls.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, z: 0, vz: 0, dmg: 0, splash: 60, ricochet: 0, spin: 0, tx: 0, ty: 0, targetIdx: -1, flightT: 0, maxFlightT: 1 });
    for (let i = 0; i < 192; i++) this.seekers.push({
      active: false, kind: 'curveball', x: 0, y: 0, lastX: 0, lastY: 0,
      trail1X: 0, trail1Y: 0, trail2X: 0, trail2Y: 0, trailClock: 0, z: 70,
      vx: 0, vy: 0, speed: 420, turnRate: 4, targetIdx: -1, dmg: 0, splash: 0,
      knock: 0, life: 0, maxLife: 3, chain: 0, angle: 0, phase: 0,
    });
    for (let i = 0; i < 200; i++) this.bottles.push({ active: false, kind: 'bottle', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dmg: 0, life: 0, maxLife: 0, targetX: 0, targetY: 0, reticleIdx: -1, splashR: 0, burn: 0, dps: 0 });
    for (let i = 0; i < 40; i++) this.fireZones.push({ active: false, x: 0, y: 0, r: 0, dps: 0, life: 0, maxLife: 0, tick: 0 });
    for (let i = 0; i < 500; i++) this.pickups.push({ active: false, kind: 'xp', tier: 1, x: 0, y: 0, vx: 0, vy: 0, value: 1, t: 0 });
    for (let i = 0; i < 600; i++) this.particles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: '#fff', grav: 0 });
    for (let i = 0; i < 96; i++) this.impacts.push({ active: false, x: 0, y: 0, life: 0, maxLife: 0.2, angle: 0, strength: 1, color: '#fff', kind: 'contact' });
    for (let i = 0; i < 120; i++) this.dmgNums.push({ active: false, x: 0, y: 0, value: '', life: 0, crit: false });
    for (let i = 0; i < 48; i++) this.telegraphs.push({ active: false, x: 0, y: 0, r: 0, t: 0, max: 1, kind: 'flare', dmg: 0, dir: 0, summon: 0, summonIndex: -1 });
    for (let i = 0; i < 16; i++) this.rings.push({ active: false, x: 0, y: 0, r: 0, maxR: 100, life: 0, color: '#fff' });
    for (let i = 0; i < 24; i++) this.pressures.push({ active: false, x: 0, y: 0, r: 0, maxR: 100, dmg: 0, knock: 0, hitSet: [] });
    for (let i = 0; i < 32; i++) this.reticles.push({ active: false, x: 0, y: 0, t: 0, max: 1, targetIdx: -1, phase: 'landing' });
    for (let i = 0; i < 64; i++) this.corpses.push({ active: false, x: 0, y: 0, enemyId: 'invader', variant: 0, boss: '', elite: false, face: 1, t: 0, max: 0.55 });
    this.refreshGuards();
  }

  /* ---------------- spatial hash ---------------- */

  private rebuildGrid(): void {
    this.grid.clear();
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.active) continue;
      const key = ((e.x / CELL) | 0) * 4096 + ((e.y / CELL) | 0);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  /** Collect enemy indexes near a point. Writes into `out`, returns count. */
  query(x: number, y: number, r: number, out: number[]): number {
    let n = 0;
    const x0 = ((x - r) / CELL) | 0;
    const x1 = ((x + r) / CELL) | 0;
    const y0 = ((y - r) / CELL) | 0;
    const y1 = ((y + r) / CELL) | 0;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.grid.get(cx * 4096 + cy);
        if (!bucket) continue;
        for (const i of bucket) out[n++] = i;
      }
    }
    return n;
  }

  nearestEnemy(x: number, y: number, maxDist: number): number {
    let best = -1;
    let bd = maxDist * maxDist;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.active) continue;
      const d = dist2(x, y, e.x, e.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  private hasGroundThreat(x: number, y: number, maxDist: number): boolean {
    const maxDist2 = maxDist * maxDist;
    for (const enemy of this.enemies) {
      if (!enemy.active || this.isAerialEnemy(enemy)) continue;
      if (dist2(x, y, enemy.x, enemy.y) <= maxDist2) return true;
    }
    return false;
  }

  private blastTargetLayers(x: number, y: number, groundR: number, airR: number): { ground: boolean; aerial: boolean } {
    let ground = false;
    let aerial = false;
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const isAerial = this.isAerialEnemy(enemy);
      const radius = isAerial ? airR : groundR;
      if (dist2(x, y, enemy.x, enemy.y) > (radius + enemy.radius) ** 2) continue;
      if (isAerial) aerial = true;
      else ground = true;
      if (ground && aerial) break;
    }
    return { ground, aerial };
  }

  /* ---------------- spawning ---------------- */

  private pickSpawnPos(): { x: number; y: number } {
    const p = this.player;
    // Keep consecutive spawns anchored to one edge segment for a while: each
    // pack member arrives loosely spaced (never stacked), then horde cohesion
    // in locomotion lets them advance as one spread-out front.
    if (this.time - this.spawnAnchor.born > 5 || this.spawnAnchor.count >= 4) {
      const side = this.rng.int(0, 3);
      this.spawnAnchor.side = side;
      this.spawnAnchor.x = side === 2 ? 60 : side === 3 ? ARENA_W - 60 : this.rng.range(60, ARENA_W - 60);
      this.spawnAnchor.y = side === 0 ? 60 : side === 1 ? ARENA_H - 60 : this.rng.range(60, ARENA_H - 60);
      this.spawnAnchor.born = this.time;
      this.spawnAnchor.count = 0;
    }
    this.spawnAnchor.count++;
    for (let tries = 0; tries < 12; tries++) {
      const x = clamp(this.spawnAnchor.x + this.rng.range(-200, 200), 46, ARENA_W - 46);
      const y = clamp(this.spawnAnchor.y + this.rng.range(-200, 200), 46, ARENA_H - 46);
      if (dist2(x, y, p.x, p.y) > 420 * 420) return { x, y };
    }
    return { x: 40, y: 40 };
  }

  private directorCounts(): DirectorCounts {
    const counts: DirectorCounts = { ranged: 0, drones: 0, varcams: 0, bulls: 0, summoners: 0 };
    for (const enemy of this.enemies) {
      if (!enemy.active || enemy.boss) continue;
      this.noteDirectorSpawn(counts, enemy.def);
    }
    return counts;
  }

  private noteDirectorSpawn(counts: DirectorCounts, def: EnemyDef): void {
    if (RANGED_BEHAVIORS.has(def.behavior)) counts.ranged++;
    if (def.id === 'drone') counts.drones++;
    if (def.id === 'varcam') counts.varcams++;
    if (def.id === 'bull') counts.bulls++;
    if (def.behavior === 'summoner') counts.summoners++;
  }

  private canDirectorSpawn(def: EnemyDef, counts: DirectorCounts): boolean {
    if (RANGED_BEHAVIORS.has(def.behavior) && counts.ranged >= RANGED_MAX_ALIVE) return false;
    if (def.id === 'drone' && counts.drones >= DRONE_MAX_ALIVE) return false;
    if (def.id === 'varcam' && counts.varcams >= VARCAM_MAX_ALIVE) return false;
    if (def.id === 'bull' && counts.bulls >= BULL_MAX_ALIVE) return false;
    if (def.behavior === 'summoner' && counts.summoners >= SUMMONER_MAX_ALIVE) return false;
    return true;
  }

  /** Allocation-free weighted director pick with time-based roster phases. */
  private pickDirectorEnemy(counts: DirectorCounts): EnemyDef | null {
    let total = 0;
    for (const def of ENEMY_ROSTER) {
      if (this.canDirectorSpawn(def, counts)) total += enemySpawnWeight(def, this.time);
    }
    if (total <= 0) return null;
    let roll = this.rng.next() * total;
    for (const def of ENEMY_ROSTER) {
      if (!this.canDirectorSpawn(def, counts)) continue;
      roll -= enemySpawnWeight(def, this.time);
      if (roll <= 0) return def;
    }
    return null;
  }

  private spawnEnemy(def: EnemyDef, x: number, y: number, elite: boolean, authored = false): Enemy | null {
    const e = this.allocEnemy(authored);
    if (!e) return null;
    const pressure = this.threatPressure;
    const mult = hpScale(this.time, pressure);
    e.active = true;
    e.def = def;
    if (def.id === 'invader') {
      e.variant = (this.invaderVariantCursor % 3) as 0 | 1 | 2;
      this.invaderVariantCursor++;
    } else {
      e.variant = 0;
    }
    e.x = x;
    e.y = y;
    const variantHp = e.variant === 1 ? 1.12 : 1;
    e.maxHp = def.hp * mult * (elite ? ELITE_HP_MULT : 1) * variantHp;
    e.hp = e.maxHp;
    e.barHp = e.maxHp;
    e.barHitT = 0;
    const variantSpeed = e.variant === 2 ? 1.12 : 1;
    e.speed = def.speed * ENEMY_PACE_MULT * enemySpeedScale(this.time, pressure) * variantSpeed * this.rng.range(0.9, 1.1);
    const damageScale = enemyDamageScale(this.time, pressure);
    const variantDamage = e.variant === 1 ? 1.08 : 1;
    e.damage = def.damage * damageScale * variantDamage * (elite ? ELITE_DAMAGE_MULT : 1);
    e.radius = def.radius * (elite ? 1.25 : 1);
    e.xp = def.xp * enemyXpRewardMultiplier(this.time) * (elite ? ELITE_XP_MULT : 1);
    e.elite = elite;
    e.boss = '';
    e.kx = 0;
    e.ky = 0;
    e.flash = 0;
    e.flashStrength = 0;
    e.hurtT = 0;
    e.hurtDx = 0;
    e.hurtDy = 0;
    e.hurtStrength = 0;
    e.orbitHitT = 0;
    e.attackAnimT = 0;
    e.attackCd = 0;
    e.orbitBallCds.fill(0);
    e.orbitCd = 0;
    e.dashMark = -1;
    e.stun = 0;
    e.slow = 0;
    e.animT = this.rng.range(0, 1);
    e.runDistance = 0;
    e.runStep = 0;
    e.moving = false;
    e.moveDx = 0;
    e.moveDy = 1;
    e.rangedCd = this.rng.range(1, 2.6);
    e.windup = 0;
    e.lungeT = 0;
    e.meleeDx = 1;
    e.meleeDy = 0;
    e.meleeHit = false;
    e.airT = 0;
    e.airMaxT = 0;
    e.aerialFlightT = def.behavior === 'aerial' ? AERIAL_FLIGHT_DURATION : 0;
    e.aerialGroundT = 0;
    e.haste = 1;
    e.boostT = 0;
    e.casting = '';
    e.telegraph = 0;
    e.chargeWindupT = 0;
    e.chargeLaneFadeT = 0;
    e.chargeDx = 0;
    e.chargeDy = 0;
    e.chargeHit = false;
    e.chargeBrakeT = 0;
    return e;
  }

  private spawnBoss(which: BossId): boolean {
    const def = BOSSES[which];
    const e = this.allocEnemy(true);
    if (!e) return false;
    const pos = this.pickSpawnPos();
    const pressure = this.threatPressure;
    e.active = true;
    e.def = { ...ENEMIES.mascot, id: 'mascot' };
    e.variant = 0;
    e.x = pos.x;
    e.y = pos.y;
    const tierScale = bossHealthMultiplier(which, pressure);
    e.maxHp = def.hp * tierScale;
    e.hp = e.maxHp;
    e.barHp = e.maxHp;
    e.barHitT = 0;
    e.speed = def.speed * ENEMY_PACE_MULT * enemySpeedScale(this.time, pressure);
    e.damage = def.damage * enemyDamageScale(this.time, pressure);
    e.radius = def.radius;
    e.xp = def.xp;
    e.elite = false;
    e.boss = which;
    e.kx = 0;
    e.ky = 0;
    e.flash = 0;
    e.flashStrength = 0;
    e.hurtT = 0;
    e.hurtDx = 0;
    e.hurtDy = 0;
    e.hurtStrength = 0;
    e.orbitHitT = 0;
    e.attackAnimT = 0;
    e.attackCd = 0;
    e.orbitBallCds.fill(0);
    e.orbitCd = 0;
    e.dashMark = -1;
    e.stun = 0;
    e.slow = 0;
    e.animT = 0;
    e.runDistance = 0;
    e.runStep = 0;
    e.moving = false;
    e.moveDx = 0;
    e.moveDy = 1;
    e.rangedCd = 2;
    e.windup = 0;
    e.lungeT = 0;
    e.meleeDx = 1;
    e.meleeDy = 0;
    e.meleeHit = false;
    e.airT = 0;
    e.airMaxT = 0;
    e.aerialFlightT = 0;
    e.aerialGroundT = 0;
    e.haste = 1;
    e.boostT = 0;
    e.casting = '';
    e.bossCd = 3;
    e.bossCd2 = 7;
    e.telegraph = 0;
    e.chargeWindupT = 0;
    e.chargeLaneFadeT = 0;
    e.chargeDx = 0;
    e.chargeDy = 0;
    e.chargeHit = false;
    e.chargeBrakeT = 0;
    this.bossAlive = e;
    this.bossIntroT = BOSS_INTRO_DURATION;
    this.player.iframes = Math.max(this.player.iframes, BOSS_INTRO_DURATION + 0.15);
    if (def.tier === 'major' && this.player.hp < this.player.maxHp * 0.75) {
      const recovery = Math.ceil(this.player.maxHp * 0.75 - this.player.hp);
      this.spawnPickup('heal', this.player.x, this.player.y, recovery, which === 'captain' ? 3 : 2, 0);
    }
    this.events.push({ type: 'bossSpawn', name: def.name, title: def.title, duration: BOSS_INTRO_DURATION });
    return true;
  }

  /* ---------------- pickups / drops ---------------- */

  private spawnPickup(kind: Pickup['kind'], x: number, y: number, value = 1, tier: 1 | 2 | 3 = 1, speed = 60): Pickup | null {
    const p = this.alloc(this.pickups);
    if (!p) return null;
    const a = this.rng.range(0, TAU);
    p.active = true;
    p.kind = kind;
    p.tier = tier;
    p.x = x;
    p.y = y;
    p.vx = Math.cos(a) * speed;
    p.vy = Math.sin(a) * speed;
    p.value = value;
    p.t = 0;
    return p;
  }

  /** Rare match-changing drops. Bosses and elites always leave one; ordinary
   *  threats only occasionally surprise you. */
  private maybeDropSpecial(e: Enemy): void {
    if (this.bombResolving) return;
    const chance = e.boss || e.elite ? 1 : 0.018;
    if (!this.rng.chance(chance)) return;
    const roll = this.rng.next();
    const kind: Pickup['kind'] = roll < 0.45 ? 'magnet' : roll < 0.77 ? 'freeze' : 'bomb';
    this.spawnPickup(kind, e.x, e.y, 1, e.boss === 'captain' ? 3 : e.elite || e.boss ? 2 : 1, 82);
  }

  private isRescuePickup(kind: Pickup['kind']): boolean {
    return kind === 'heal' || kind === 'magnet' || kind === 'freeze' || kind === 'bomb';
  }

  /** Bombs and magnets are deliberate ground decisions rather than rewards
   * that vacuum into the player. They retain only a very short, weak final
   * nudge so touching their visible edge still feels responsive. */
  private isAnchoredSpecialPickup(kind: Pickup['kind']): boolean {
    return kind === 'magnet' || kind === 'bomb';
  }

  /** Ball Magnet vacuums earned loot, never chain-activating another tool. */
  private isActiveMagnetCollectible(kind: Pickup['kind']): boolean {
    return kind === 'xp' || kind === 'coin' || kind === 'heal' || kind === 'trophy';
  }

  private dropLoot(e: Enemy): void {
    // XP orb(s)
    let remaining = e.xp;
    while (remaining > 0) {
      const tier: 1 | 2 | 3 = remaining >= 6 ? 3 : remaining >= 3 ? 2 : 1;
      const value = tier === 3 ? 6 : tier === 2 ? 3 : 1;
      remaining -= value;
      const p = this.alloc(this.pickups);
      if (!p) break;
      p.active = true;
      p.kind = 'xp';
      p.tier = tier;
      p.x = e.x;
      p.y = e.y;
      const a = this.rng.range(0, TAU);
      const sp = this.rng.range(30, 80);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.value = value;
      p.t = 0;
    }
    // coins
    const coinN = e.boss ? 0 : this.rng.chance(e.def.coinChance * (e.elite ? 4 : 1)) ? this.rng.int(1, e.elite ? 6 : 3) : 0;
    for (let i = 0; i < coinN; i++) {
      const p = this.alloc(this.pickups);
      if (!p) break;
      p.active = true;
      p.kind = 'coin';
      p.tier = 1;
      p.x = e.x;
      p.y = e.y;
      const a = this.rng.range(0, TAU);
      p.vx = Math.cos(a) * 70;
      p.vy = Math.sin(a) * 70;
      p.value = 1;
      p.t = 0;
    }
    // sports drink (heal) drops: tanks/elites are the comeback moments
    const healChance = e.boss ? 0 : e.elite ? 0.55 : e.def.id === 'mascot' ? 0.2 : e.def.id === 'steward' ? 0.1 : 0;
    if (this.rng.chance(healChance)) {
      const p = this.alloc(this.pickups);
      if (p) {
        p.active = true;
        p.kind = 'heal';
        p.tier = 1;
        p.x = e.x;
        p.y = e.y;
        const a = this.rng.range(0, TAU);
        p.vx = Math.cos(a) * 60;
        p.vy = Math.sin(a) * 60;
        p.value = 25;
        p.t = 0;
      }
    }
    this.maybeDropSpecial(e);
  }

  /** Pull nearby collectibles toward the player for a few seconds. */
  private activateMagnet(): void {
    this.magnetT = Math.max(this.magnetT, 3.5);
    this.events.push({ type: 'magnet' });
  }

  /** Defeat all ordinary threats and tear a balanced chunk from bosses. */
  private activateBomb(): void {
    let defeated = 0;
    this.bombResolving = true;
    try {
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.active) continue;
        if (e.boss) {
          this.damageEnemy(i, Math.max(1, e.maxHp * 0.3), 0, 0, { crit: false });
        } else {
          defeated++;
          this.damageEnemy(i, e.hp + 1, 0, 0, { crit: false });
        }
      }
    } finally {
      this.bombResolving = false;
    }
    // The authored full-pitch wipeout is the dominant visual. A small local
    // contact burst sells pickup activation without stacking a second blast.
    this.burst(this.player.x, this.player.y, 18, '#ffb02e');
    this.events.push({ type: 'bomb', x: this.player.x, y: this.player.y, defeated });
  }

  /** Pause every hostile simulation clock while the player and loot stay live. */
  private activateFreeze(): void {
    this.freezeT = Math.max(this.freezeT, FREEZE_DURATION);
    this.events.push({ type: 'freeze', duration: FREEZE_DURATION });
  }

  /* ---------------- damage ---------------- */

  private scratch: number[] = new Array(512);

  damageEnemy(
    i: number,
    dmg: number,
    kx = 0,
    ky = 0,
    opts?: { stun?: number; crit?: boolean; source?: 'orbit' | 'molotov'; feedback?: boolean },
  ): void {
    const e = this.enemies[i];
    if (!e.active || e.hp <= 0) return;
    // Arrival is a presentation and fairness boundary, not free DPS time.
    if (e.boss && e === this.bossAlive && this.bossIntroT > 0) return;
    const crit = opts?.crit ?? this.rng.chance(0.08);
    const final = Math.max(0, Math.round(dmg * (crit ? 1.6 : 1)));
    const hpBefore = e.hp;
    const actualDamage = Math.min(hpBefore, final);
    e.hp -= actualDamage;
    e.barHp = Math.max(e.barHp, hpBefore);
    e.barHitT = 0.32;
    const force = Math.hypot(kx, ky);
    e.flashStrength = enemyHitFeedbackStrength(actualDamage, e.maxHp, force, crit);
    e.flash = actualDamage > 0 ? 0.08 + e.flashStrength * 0.05 : 0.055;
    e.hurtT = actualDamage > 0 ? (force > 250 ? 0.32 : 0.26) : 0.08;
    if (force > 0.01) {
      e.hurtDx = kx / force;
      e.hurtDy = ky / force;
    } else {
      e.hurtDx = -e.face;
      e.hurtDy = 0;
    }
    e.hurtStrength = actualDamage > 0
      ? clamp(Math.max(force / 360, e.flashStrength * 0.72), 0.2, 1.25)
      : 0.1;
    if (opts?.source === 'orbit') e.orbitHitT = 0.38;
    if (opts?.source === 'molotov') e.orbitHitT = 0.3;
    e.kx += kx;
    e.ky += ky;
    // a heavy shove launches the enemy briefly airborne: ground effects sweep
    // underneath while it flies, aerial attacks still connect (no immunity)
    if (!e.boss && Math.hypot(kx, ky) > 330 && e.airT < 0.38) {
      e.airT = 0.38;
      e.airMaxT = 0.38;
    }
    if (opts?.stun) e.stun = Math.max(e.stun, opts.stun);
    const heavy = Math.hypot(kx, ky) > 250 || actualDamage >= 28;
    if (opts?.feedback !== false) {
      this.spawnImpact(e.x, e.y, kx, ky, crit && actualDamage > 0, 'contact', heavy, actualDamage > 0 ? 1 : 0.32);
      if (actualDamage > 0) this.spawnDmgNum(e.x, e.y - e.radius - 6, actualDamage, crit);
      if (actualDamage > 0) this.events.push({ type: 'hit', x: e.x, y: e.y, heavy, crit });
    }
    if (e.hp <= 0) this.killEnemy(i);
  }

  private killEnemy(i: number): void {
    const e = this.enemies[i];
    if (!e.active) return;
    e.active = false;
    this.kills++;
    this.noteKillForRewards();
    this.dropLoot(e);
    this.spawnCorpse(e);
    this.burst(e.x, e.y, e.boss ? 26 : e.elite ? 14 : 6, e.boss ? '#ffd23f' : '#e8b88a');
    this.events.push({ type: 'kill', x: e.x, y: e.y, elite: e.elite || !!e.boss });
    if (e.boss) {
      const def = BOSSES[e.boss];
      this.coins += def.coins * rewardCoinMul(this.rewardBuff);
      this.bossAlive = null;
      this.player.iframes = Math.max(this.player.iframes, 1.25);
      this.events.push({ type: 'bossDie', x: e.x, y: e.y, coins: def.coins });
      const tier: 1 | 2 | 3 = e.boss === 'captain' ? 3 : e.boss === 'official' ? 2 : 1;
      // The final reward is atomic: a distant Captain kill must not leave its
      // trophy behind after the won state stops pickup simulation. Earlier
      // bosses retain the tangible post-fight collection beat.
      if (e.boss === 'captain') {
        const finalCoins = 120;
        this.coins += finalCoins;
        this.pendingBossAbilities += 2;
        this.events.push({ type: 'trophy', coins: finalCoins, tier, abilityPicks: 2 });
        this.confetti(e.x, e.y, 40);
      } else {
        const trophy = this.alloc(this.pickups);
        if (trophy) {
        trophy.active = true;
        trophy.kind = 'trophy';
        trophy.tier = tier;
        trophy.x = e.x;
        trophy.y = e.y;
        trophy.vx = this.rng.range(-35, 35);
        trophy.vy = this.rng.range(-35, 35);
          trophy.value = tier === 2 ? 60 : 30;
        trophy.t = 0;
        }
      }
      const recoveryTier: 1 | 2 | 3 = e.boss === 'captain' ? 3 : e.boss === 'official' ? 2 : 1;
      this.spawnPickup('heal', e.x + 34, e.y + 12, 30 + recoveryTier * 10, recoveryTier, 70);
      // coin fountain
      for (let k = 0; k < 12; k++) {
        const p = this.alloc(this.pickups);
        if (!p) break;
        p.active = true;
        p.kind = 'coin';
        p.tier = 1;
        p.x = e.x;
        p.y = e.y;
        const a = this.rng.range(0, TAU);
        p.vx = Math.cos(a) * this.rng.range(60, 160);
        p.vy = Math.sin(a) * this.rng.range(60, 160);
        p.value = 1;
        p.t = 0;
      }
    }
  }

  /** Death visual: the fallen enemy topples, sinks and fades beside the loot. */
  private spawnCorpse(e: Enemy): void {
    const c = this.alloc(this.corpses);
    if (!c) return;
    c.active = true;
    c.x = e.x;
    c.y = e.y;
    c.enemyId = e.def.id;
    c.variant = e.variant;
    c.boss = e.boss;
    c.elite = e.elite;
    c.face = e.face;
    c.t = 0;
    c.max = e.boss ? 1.4 : 0.55;
  }

  private hurtPlayer(raw: number, kx = 0, ky = 0, slowT = 0): void {
    const p = this.player;
    if (p.iframes > 0 || p.dashIframesT > 0 || this.bossIntroT > 0 || this.over !== 'playing') return;
    const dmg = Math.max(1, Math.round(raw - this.armor));
    p.hp -= dmg;
    if (p.dashT > 0) p.dashMomentum = Math.min(p.dashMomentum, 0.7);
    p.iframes = 0.55;
    p.hurtT = 0.32;
    const hitLength = Math.hypot(kx, ky);
    p.hurtDx = hitLength > 0.01 ? kx / hitLength : -p.face;
    p.hurtDy = hitLength > 0.01 ? ky / hitLength : 0;
    p.kx += kx;
    p.ky += ky;
    if (slowT > 0) p.slowT = Math.max(p.slowT, slowT);
    this.events.push({ type: 'hurt' });
    this.burst(p.x, p.y, 8, '#ff6b6b');
    if (p.hp <= 0) {
      p.hp = 0;
      this.over = 'lost';
      this.events.push({ type: 'defeat' });
    }
  }

  /* ---------------- fx helpers ---------------- */

  burst(x: number, y: number, n: number, color: string): void {
    for (let i = 0; i < n; i++) {
      const pt = this.alloc(this.particles);
      if (!pt) return;
      pt.active = true;
      pt.x = x;
      pt.y = y;
      const a = this.rng.range(0, TAU);
      const sp = this.rng.range(40, 190);
      pt.vx = Math.cos(a) * sp;
      pt.vy = Math.sin(a) * sp - 30;
      pt.life = pt.maxLife = this.rng.range(0.25, 0.6);
      pt.size = this.rng.range(1.5, 4);
      pt.color = color;
      pt.grav = 300;
    }
  }

  confetti(x: number, y: number, n: number): void {
    const colors = ['#ffd23f', '#e8283f', '#4cc9f0', '#80ed99', '#f5f7fa'];
    for (let i = 0; i < n; i++) {
      const pt = this.alloc(this.particles);
      if (!pt) return;
      pt.active = true;
      pt.x = x + this.rng.range(-30, 30);
      pt.y = y + this.rng.range(-20, 20);
      const a = this.rng.range(-Math.PI / 2 - 0.8, -Math.PI / 2 + 0.8);
      const sp = this.rng.range(120, 320);
      pt.vx = Math.cos(a) * sp;
      pt.vy = Math.sin(a) * sp;
      pt.life = pt.maxLife = this.rng.range(0.7, 1.4);
      pt.size = this.rng.range(2, 4.5);
      pt.color = this.rng.pick(colors);
      pt.grav = 420;
    }
  }

  private spawnDmgNum(x: number, y: number, value: number, crit: boolean): void {
    const d = this.alloc(this.dmgNums);
    if (!d) return;
    d.active = true;
    d.x = x + this.rng.range(-6, 6);
    d.y = y;
    d.value = String(Number(value.toFixed(2)));
    d.life = 0.7;
    d.crit = crit;
  }

  /** Creates one directional contact flash. The fixed pool keeps this effect
   *  mobile-safe even when orbit, guards and splash damage land together. */
  private spawnImpact(
    x: number,
    y: number,
    kx: number,
    ky: number,
    crit: boolean,
    kind: Impact['kind'],
    heavy = false,
    strengthScale = 1,
  ): void {
    const impact = this.alloc(this.impacts);
    if (!impact) return;
    const force = Math.hypot(kx, ky);
    impact.active = true;
    impact.x = x;
    impact.y = y;
    impact.angle = force > 1 ? Math.atan2(ky, kx) : this.rng.range(0, TAU);
    impact.strength = (kind === 'landing' ? 1.55 : kind === 'blastair' ? 1.62 : kind === 'airburst' ? 1.4 : kind === 'kickground' ? 1.08 : crit ? 1.4 : heavy ? 1.18 : 0.9) * strengthScale;
    impact.color = kind === 'landing' ? '#ffd166' : kind === 'blastair' ? '#8affd4' : kind === 'airburst' ? '#70e7ff' : kind === 'kickground' ? '#b6e36b' : crit ? '#ffd23f' : heavy ? '#f5f7fa' : '#d9f3ff';
    impact.kind = kind;
    impact.life = impact.maxLife = kind === 'landing' ? 0.28 : kind === 'blastair' ? 0.38 : kind === 'airburst' ? 0.26 : kind === 'kickground' ? 0.42 : crit || heavy ? 0.22 : 0.16;
  }

  private ring(x: number, y: number, maxR: number, color: string): void {
    const r = this.alloc(this.rings);
    if (!r) return;
    r.active = true;
    r.x = x;
    r.y = y;
    r.r = 10;
    r.maxR = maxR;
    r.life = 0.45;
    r.color = color;
  }

  private telegraph(
    x: number,
    y: number,
    r: number,
    delay: number,
    kind: Telegraph['kind'],
    dmg = 0,
    dir = 0,
    summon: Telegraph['summon'] = 0,
    summonIndex = -1,
  ): boolean {
    const t = this.alloc(this.telegraphs);
    if (!t) return false;
    t.active = true;
    t.x = x;
    t.y = y;
    t.r = r;
    t.t = delay;
    t.max = delay;
    t.kind = kind;
    t.dmg = dmg;
    t.dir = dir;
    t.summon = summon;
    t.summonIndex = summonIndex;
    return true;
  }

  private bossSummonRoster(code: Telegraph['summon']): Array<keyof typeof ENEMIES> {
    return code === 1
      ? ['invader', 'invader', 'sprinter']
      : code === 2
        ? ['invader', 'invader', 'invader', 'invader', 'bull']
        : code === 3
          ? ['drone', 'sprinter', 'sprinter']
          : [];
  }

  /** Lay one honest pitch marker per future add. Each marker resolves at a
   * staggered beat, so the player can read and route around the formation. */
  private queueBossSummons(code: Telegraph['summon'], x: number, y: number, delay: number): void {
    const roster = this.bossSummonRoster(code);
    const availableEnemySlots = this.enemies.reduce((total, enemy) => total + (!enemy.active ? 1 : 0), 0);
    const availableMarkers = this.telegraphs.reduce((total, marker) => total + (!marker.active ? 1 : 0), 0);
    const promisedCount = Math.min(roster.length, availableEnemySlots, availableMarkers);
    const angleOffset = code * 0.61;
    for (let index = 0; index < promisedCount; index++) {
      const def = ENEMIES[roster[index]];
      const angle = (index / Math.max(1, roster.length)) * TAU + angleOffset;
      const distance = code === 2 && roster[index] === 'bull' ? 185 : 112 + (index % 2) * 34;
      const markerX = clamp(x + Math.cos(angle) * distance, 40, ARENA_W - 40);
      const markerY = clamp(y + Math.sin(angle) * distance, 40, ARENA_H - 40);
      const promised = this.telegraph(
        markerX,
        markerY,
        clamp(22 + def.radius * 1.55, 52, 104),
        delay + index * 0.14,
        'summon',
        0,
        angle,
        code,
        index,
      );
      if (!promised) break;
    }
  }

  /** Resolve exactly the add promised by one marker. */
  private summonBossAdd(code: Telegraph['summon'], index: number, x: number, y: number): void {
    const roster = this.bossSummonRoster(code);
    const enemyId = roster[index];
    if (!enemyId) return;
    const def = ENEMIES[enemyId];
    const spawned = this.spawnEnemy(def, x, y, false, true);
    if (spawned) {
      this.burst(x, y, enemyId === 'bull' ? 10 : 6, '#ff5c70');
      this.events.push({ type: 'chant', x, y });
    }
  }

  /** Molotov Lobber's throw (after the visible wind-up). Aimed at you. */
  private throwBottle(e: Enemy): void {
    let airborne = 0;
    for (const existing of this.bottles) {
      if (existing.active && existing.kind === 'molotov') airborne++;
    }
    if (airborne >= 2) return;
    const b = this.alloc(this.bottles);
    if (!b) return;
    const p = this.player;
    b.active = true;
    b.kind = 'molotov';
    b.x = e.x;
    b.y = e.y;
    b.z = 0;
    const lead = 0.4;
    const tx = p.x + p.moveVx * lead;
    const ty = p.y + p.moveVy * lead;
    const dd = Math.hypot(tx - e.x, ty - e.y) || 1;
    const flight = Math.max(0.55, Math.min(1.15, dd / 560));
    b.vx = (tx - e.x) / flight;
    b.vy = (ty - e.y) / flight;
    b.vz = 0.5 * LOB_GRAVITY * flight;
    b.dmg = Math.max(3, (e.damage || 7) * 0.4);
    b.life = flight;
    b.maxLife = flight;
    b.targetX = tx;
    b.targetY = ty;
    b.splashR = 54;
    b.burn = 1.5;
    b.dps = 5;
    b.reticleIdx = this.reticle(tx, ty, flight, -1, 'landing');
  }

  /** Landing: burn the player if they are in the splash, then leave a blaze. */
  private igniteMolotov(b: Bottle): void {
    const p = this.player;
    const splash = Math.max(48, b.splashR || 88);
    if (dist2(b.x, b.y, p.x, p.y) < (splash + 18) * (splash + 18)) {
      this.hurtPlayer(b.dmg || 3);
    }
    this.burst(b.x, b.y, 16, '#ff8a1e');
    this.ring(b.x, b.y, splash, '#ff8a1e');
    this.events.push({ type: 'molotovIgnite', x: b.x, y: b.y });
    const z = this.alloc(this.fireZones);
    if (z) {
      z.active = true;
      z.x = b.x;
      z.y = b.y;
      z.r = splash * 0.8;
      z.dps = b.dps || 12;
      z.life = b.burn || 2.6;
      z.maxLife = b.burn || 2.6;
      z.tick = 0;
    }
  }

  /** Shock Drone fires a fast, readable electric dart at a short player lead. */
  private fireElectric(e: Enemy): void {
    const b = this.alloc(this.bottles);
    if (!b) return;
    const p = this.player;
    const lead = 0.24;
    const tx = p.x + p.moveVx * lead;
    const ty = p.y + p.moveVy * lead;
    const d = Math.hypot(tx - e.x, ty - e.y) || 1;
    b.active = true;
    b.kind = 'electric';
    b.x = e.x;
    b.y = e.y;
    b.z = 0;
    b.vz = 0;
    b.vx = ((tx - e.x) / d) * 460;
    b.vy = ((ty - e.y) / d) * 460;
    b.dmg = e.damage;
    b.life = 1.45;
    b.maxLife = 1.45;
    b.targetX = tx;
    b.targetY = ty;
    b.reticleIdx = -1;
    this.events.push({ type: 'zap', x: e.x, y: e.y });
  }

  /** VAR Skycam commits to a slow, readable three-dart scan fan. Each dart is
   * individually dodgeable; taking the full volley is the real late-game
   * punishment and Keeper's Halo can parry its pieces one at a time. */
  private fireVarScan(e: Enemy): void {
    const p = this.player;
    const lead = 0.32;
    const tx = p.x + p.moveVx * lead;
    const ty = p.y + p.moveVy * lead;
    const base = Math.atan2(ty - e.y, tx - e.x);
    const speed = 345;
    for (const spread of [-0.14, 0, 0.14]) {
      const b = this.alloc(this.bottles);
      if (!b) break;
      const angle = base + spread;
      b.active = true;
      b.kind = 'scan';
      b.x = e.x;
      b.y = e.y;
      b.z = 0;
      b.vz = 0;
      b.vx = Math.cos(angle) * speed;
      b.vy = Math.sin(angle) * speed;
      b.dmg = e.damage;
      b.life = 2.05;
      b.maxLife = 2.05;
      b.targetX = tx;
      b.targetY = ty;
      b.reticleIdx = -1;
    }
    this.events.push({ type: 'zap', x: e.x, y: e.y });
  }

  /* ---------------- level-ups ---------------- */

  makeAbilityUpgradeOption(id: AbilityId, nextLevel = this.abilityLevel(id) + 1): UpgradeOption {
    const def = ABILITIES[id];
    const current = this.abilityLevel(id);
    const next = clamp(Math.floor(nextLevel), 1, def.levels.length);
    const complementary = (Object.keys(this.player.abilities) as AbilityId[])
      .find((ownedId) => ownedId !== id && (this.player.abilities[ownedId] ?? 0) > 0 && ABILITIES[ownedId].lane !== def.lane);
    return {
      kind: 'ability',
      id,
      name: next === 1 ? def.name : `${def.name} Lv${next}`,
      desc: def.levels[next - 1].desc,
      color: def.color,
      level: next,
      currentLabel: current > 0 ? `Level ${current}` : 'Not owned',
      afterLabel: `Level ${next}${next === def.levels.length ? ' · MAX' : ''}`,
      capLabel: `Level ${def.levels.length}`,
      metaLabel: `${def.lane.toUpperCase()} · ${def.rangeBand.toUpperCase()} · ${def.delivery.toUpperCase()} · ${abilityCadenceLabel(id, next)}`,
      synergyLabel: complementary ? `Pairs with ${ABILITIES[complementary].name}` : undefined,
    };
  }

  makeStatUpgradeOption(id: StatId): UpgradeOption {
    const def = STATS[id];
    const current = this.player.stats[id];
    const next = Math.min(def.max, current + 1);
    return {
      kind: 'stat',
      id,
      name: def.name,
      desc: def.desc,
      color: def.color,
      level: next,
      currentLabel: statProgressLabel(id, current),
      afterLabel: statProgressLabel(id, next),
      capLabel: statProgressLabel(id, def.max),
      metaLabel: 'PASSIVE TRAINING',
    };
  }

  private makeHealUpgradeOption(): UpgradeOption {
    return {
      kind: 'heal',
      id: 'heal',
      name: 'Orange Slices',
      desc: 'Recover 30 HP right now.',
      color: '#80ed99',
      level: 0,
      currentLabel: `${Math.ceil(this.player.hp)} / ${Math.ceil(this.player.maxHp)} HP`,
      afterLabel: `${Math.ceil(Math.min(this.player.maxHp, this.player.hp + 30))} / ${Math.ceil(this.player.maxHp)} HP`,
      capLabel: `${Math.ceil(this.player.maxHp)} HP`,
      metaLabel: 'RECOVERY',
    };
  }

  rollUpgrades(): UpgradeOption[] {
    const p = this.player;
    const ownedAbilityIds = (Object.keys(p.abilities) as AbilityId[])
      .filter((id) => (p.abilities[id] ?? 0) > 0);
    const activeAbilitySlots = ownedAbilityIds.length;
    interface Cand extends UpgradeOption {
      weight: number;
    }
    const cands: Cand[] = [];
    for (const id of Object.keys(ABILITIES) as AbilityId[]) {
      const lvl = p.abilities[id] ?? 0;
      const def = ABILITIES[id];
      if (lvl === 0 && activeAbilitySlots < 6) {
        cands.push({ ...this.makeAbilityUpgradeOption(id, 1), weight: upgradeDraftWeight('new-ability') });
      } else if (lvl > 0 && lvl < def.levels.length) {
        cands.push({ ...this.makeAbilityUpgradeOption(id, lvl + 1), weight: upgradeDraftWeight('owned-ability') });
      }
    }
    for (const id of Object.keys(STATS) as StatId[]) {
      const def = STATS[id];
      const cur = p.stats[id];
      if (cur < def.max && this.statHasEffect(id)) {
        cands.push({ ...this.makeStatUpgradeOption(id), weight: upgradeDraftWeight('stat') });
      }
    }
    const picks: UpgradeOption[] = [];
    const pool = [...cands];
    while (picks.length < 3 && pool.length > 0) {
      const hit = weightedPick(this.rng, pool);
      if (!hit) break;
      picks.push(hit);
      pool.splice(pool.indexOf(hit), 1);
    }
    while (picks.length < 3) {
      picks.push(
        picks.length % 2 === 0
          ? this.makeHealUpgradeOption()
          : { kind: 'coins', id: 'coins', name: 'Signing Bonus', desc: '+25 coins, straight into the club account.', color: '#ffd23f', level: 0 },
      );
    }
    return picks;
  }

  /** Boss loot deliberately excludes training and recovery cards. Each trophy
   *  opens this draft twice, producing two meaningful ability upgrades. */
  rollBossAbilities(): UpgradeOption[] {
    const pool: UpgradeOption[] = [];
    const ownedCount = (Object.keys(this.player.abilities) as AbilityId[])
      .filter((id) => (this.player.abilities[id] ?? 0) > 0).length;
    for (const id of Object.keys(ABILITIES) as AbilityId[]) {
      const lvl = this.player.abilities[id] ?? 0;
      const def = ABILITIES[id];
      if (lvl >= def.levels.length) continue;
      if (lvl === 0 && ownedCount >= 6) continue;
      const next = lvl + 1;
      pool.push(this.makeAbilityUpgradeOption(id, next));
    }
    const picks: UpgradeOption[] = [];
    while (picks.length < 3 && pool.length > 0) {
      const index = this.rng.int(0, pool.length - 1);
      picks.push(pool.splice(index, 1)[0]);
    }
    // A completely maxed build cannot receive another legal ability level.
    // Keep the draft valid without ever writing an out-of-range level.
    while (picks.length < 3) {
      picks.push({
        kind: 'coins', id: 'coins', name: 'Legend Bonus',
        desc: '+75 coins because every ability is already fully evolved.',
        color: '#ffd23f', level: 0,
      });
    }
    return picks;
  }

  applyUpgrade(opt: UpgradeOption): void {
    const p = this.player;
    if (opt.kind === 'ability') {
      p.abilities[opt.id as AbilityId] = opt.level;
      if (opt.id === 'guard') this.refreshGuards();
      if (opt.id === 'dash') {
        const want = opt.level >= 4 ? 2 : 1;
        while (p.dashCds.length < want) p.dashCds.push(0);
      }
      if (opt.level === 5) this.events.push({ type: 'maxAbility', name: ABILITIES[opt.id as AbilityId].name });
      this.events.push({ type: 'upgradeFx', max: opt.level === 5 });
    } else if (opt.kind === 'stat') {
      const id = opt.id as StatId;
      p.stats[id] += 1;
      if (id === 'maxhp') {
        p.maxHp += 15;
        p.hp = Math.min(p.maxHp, p.hp + 15);
        p.heartFxT = 0.9;
      }
    } else if (opt.kind === 'heal') {
      p.hp = Math.min(p.maxHp, p.hp + 30);
      p.healT = HEAL_FX_DURATION;
      this.events.push({ type: 'heal' });
    } else {
      this.coins += (opt.name === 'Legend Bonus' ? 75 : 25) * rewardCoinMul(this.rewardBuff);
    }
  }

  private startRewardBuff(): void {
    if (this.rewardEventUsed) return;
    if (this.rewardBuff && this.rewardBuff.t > 0) return;
    this.rewardEventUsed = true;
    this.rewardBuff = { kind: 'both', t: REWARD_EVENT_DURATION, label: REWARD_EVENT_LABEL };
    this.events.push({ type: 'rewardBuff', label: this.rewardBuff.label });
  }

  private noteKillForRewards(): void {
    this.killTimes.push(this.time);
    const cut = this.time - STREAK_KILL_WINDOW;
    this.killTimes = this.killTimes.filter((t) => t >= cut);
  }

  private tickRewardBuffs(dt: number): void {
    if (this.debugHoldRewardEvent) {
      const remaining = this.rewardBuff && this.rewardBuff.t > 0
        ? this.rewardBuff.t - dt
        : REWARD_EVENT_DURATION;
      this.rewardBuff = {
        kind: 'both',
        t: remaining <= 0 ? REWARD_EVENT_DURATION : remaining,
        label: REWARD_EVENT_LABEL,
      };
      return;
    }
    if (this.rewardBuff) {
      this.rewardBuff.t -= dt;
      if (this.rewardBuff.t <= 0) this.rewardBuff = null;
    }
    if (this.rewardEventUsed) return;
    if (this.time < this.nextRandomBuffAt) return;
    this.nextRandomBuffAt = this.time + REWARD_EVENT_INTERVAL;
    if (this.time < REWARD_EVENT_MIN_TIME) return;
    if (!this.rng.chance(REWARD_EVENT_CHANCE)) return;
    this.startRewardBuff();
  }

  private gainXp(v: number): void {
    const p = this.player;
    p.xp += v * this.xpMult * rewardXpMul(this.rewardBuff);
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.level += 1;
      p.xpNext = xpForLevel(p.level);
      this.pendingLevelups += 1;
      this.events.push({ type: 'levelup' });
    }
  }

  private refreshGuards(): void {
    const lvl = this.abilityLevel('guard');
    const want = lvl === 0 ? 0 : (lvl >= 5 ? 4 : lvl >= 3 ? 2 : 1) + (lvl > 0 ? this.guardExtra : 0);
    while (this.guards.length < want) {
      const a = (this.guards.length / Math.max(1, want)) * TAU;
      this.guards.push({
        variant: (this.guards.length % 4) as 0 | 1 | 2 | 3,
        x: this.player.x + Math.cos(a) * 50,
        y: this.player.y + Math.sin(a) * 50,
        tx: 0, ty: 0, vx: 0, vy: 0,
        escortX: this.player.x, escortY: this.player.y,
        patrolHomeAngle: a, patrolAngle: a, patrolRadius: 84,
        patrolDirection: this.guards.length % 2 === 0 ? 1 : -1,
        decisionT: this.rng.range(3 / 60, 12 / 60),
        swingCd: 0, strikeT: 0, strikeTarget: -1, strikeHit: false, blockT: 0,
        moving: false, face: 1, animT: 0, runDistance: 0, target: -1,
      });
    }
    for (let i = 0; i < this.guards.length; i++) {
      const guard = this.guards[i];
      guard.variant = (i % 4) as 0 | 1 | 2 | 3;
      // Re-space only when squad composition changes. During play these are
      // persistent world-space sectors, never a mirror of the player's facing.
      guard.patrolHomeAngle = 0.55 + (i / Math.max(1, this.guards.length)) * TAU;
      guard.patrolAngle = guard.patrolHomeAngle;
      guard.patrolRadius = i === 0 ? 84 : i === 1 ? 102 : i === 2 ? 128 : 145;
    }
  }

  /* ---------------- abilities ---------------- */

  /* AERIAL lane: nearest-target strike with damage reservation */

  /** Damage already inbound on enemy `idx` from every aerial projectile. */
  private reservedDmg(idx: number): number {
    let sum = 0;
    for (const b of this.balls) if (b.active && b.targetIdx === idx) sum += b.dmg;
    for (const s of this.seekers) if (s.active && s.targetIdx === idx) sum += s.dmg;
    return sum;
  }

  static AERIAL_MAX_RANGE = 900;

  /**
   * Picks the natural strike target: the nearest living threat inside aerial
   * range. Inbound balls already reserved on a target push the pick to the
   * next-closest enemy so volleys fan out across the nearest members of a
   * pack instead of overkilling one survivor.
   */
  pickAerialTarget(fromX: number, fromY: number): number {
    // Regulation-time pressure stays nearest-first. Once full time has
    // actually elapsed, aerial attacks lock the living final boss so sudden
    // death resolves as a focused duel instead of spending several extra
    // minutes clearing ordinary targets that no longer respawn.
    if (this.suddenDeath) {
      const captain = this.enemies.findIndex((enemy) => enemy.active && enemy.boss === 'captain');
      if (captain >= 0) return captain;
    }
    return this.pickNearestAerialTarget(fromX, fromY);
  }

  /** Nearest living threat within aerial range, spread by damage reservation. */
  private pickNearestAerialTarget(fromX: number, fromY: number): number {
    const max2 = Sim.AERIAL_MAX_RANGE * Sim.AERIAL_MAX_RANGE;
    let best = -1;
    let bestD2 = Infinity;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.active) continue;
        const d2 = dist2(fromX, fromY, e.x, e.y);
        if (d2 > max2) continue;
        const reserved = this.reservedDmg(i);
        if (reserved >= e.hp) continue; // projected dead: leave it
        if (pass === 0 && reserved > 0) continue; // prefer untouched targets
        if (d2 < bestD2) {
          best = i;
          bestD2 = d2;
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  /** Starts the readable wind-up; the ball is created on the strip's contact frame. */
  private fireStrike(): void {
    if (this.abilityLevel('strike') === 0) return;
    const p = this.player;
    const targetIdx = this.pickAerialTarget(p.x, p.y);
    if (targetIdx < 0) return;
    const target = this.enemies[targetIdx];
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const distance = Math.hypot(dx, dy) || 1;
    p.kickTargetIdx = targetIdx;
    p.aimDx = dx / distance;
    p.aimDy = dy / distance;
    if (Math.abs(dx) > 0.001) p.face = dx > 0 ? 1 : -1;
    p.kickT = KICK_DURATION;
    // The selected threat is readable during the wind-up, not only after the
    // ball already exists. This same marker is promoted to a landing marker
    // on the contact frame so there is no duplicate decal or visual jump.
    this.reticle(target.x, target.y, KICK_DURATION, targetIdx, 'aim');
    this.deferred.push({ t: KICK_CONTACT_DELAY, fn: () => this.releaseStrike() });
  }

  /** Releases the aerial volley on the exact contact beat of the kick strip. */
  private releaseStrike(): void {
    const lvl = this.abilityLevel('strike');
    if (lvl === 0) return;
    const p = this.player;
    const count = [0, 1, 2, 2, 3, 4][lvl] + (this.def.id === 'messi' ? 1 : 0);
    const dmg = [0, 14, 14, 20, 20, 28][lvl] * this.damageMult;
    const splash = 0; // ordinary footballs are precision hits, never splash damage
    const ric = lvl >= 5 ? 1 : 0;
    let launched = 0;
    for (let i = 0; i < count; i++) {
      const locked = i === 0 ? this.enemies[p.kickTargetIdx] : undefined;
      const ti = locked?.active ? p.kickTargetIdx : this.pickAerialTarget(p.x, p.y);
      if (ti < 0) break;
      const b = this.alloc(this.balls);
      if (!b) return;
      const e = this.enemies[ti];
      const aimReticle = i === 0
        ? this.reticles.find((marker) => marker.active && marker.phase === 'aim' && marker.targetIdx === ti)
        : undefined;
      // The destination may reacquire, but the contact foot stays on the
      // body's committed line instead of sliding around the player.
      const aimX = p.aimDx;
      const aimY = p.aimDy;
      const sideX = -aimY;
      const sideY = aimX;
      const volleyOffset = count > 1 ? (i - (count - 1) / 2) * 3.8 : 0;
      // Release from the lead cleat instead of the hero's body centre. Small
      // perpendicular offsets stop simultaneous max-level balls occupying the
      // same pixels while preserving their locked targets and flight times.
      const launchX = p.x + aimX * 27 + sideX * volleyOffset;
      const launchY = p.y + aimY * 27 + sideY * volleyOffset;
      this.lob(b, launchX, launchY, e.x, e.y, dmg, splash, ric, ti, aimReticle);
      launched++;
    }
    // A dead target can force reacquisition. Remove any stale wind-up marker;
    // the live replacement already received its own landing marker in lob().
    for (const marker of this.reticles) {
      if (marker.active && marker.phase === 'aim') marker.active = false;
    }
    if (launched > 0) {
      // A single authored ground-contact strip replaces the former square
      // glitter particles. It is pooled with other impacts, stays locked to
      // the committed kick vector and is rendered below every actor.
      this.spawnImpact(
        p.x + p.aimDx * 40,
        p.y + p.aimDy * 40,
        p.aimDx,
        p.aimDy,
        false,
        'kickground',
      );
      this.events.push({ type: 'kick' });
    }
  }

  /** Launches a lobbed ball on a ballistic arc that lands exactly on (tx,ty). */
  private lob(
    b: Ball,
    x: number,
    y: number,
    tx: number,
    ty: number,
    dmg: number,
    splash: number,
    ric: number,
    targetIdx: number,
    existingReticle?: Reticle,
  ): void {
    const d = Math.hypot(tx - x, ty - y);
    const T = Math.max(0.45, Math.min(1.15, d / 560));
    b.active = true;
    b.x = x;
    b.y = y;
    b.z = 0;
    b.vx = (tx - x) / T;
    b.vy = (ty - y) / T;
    b.vz = 0.5 * LOB_GRAVITY * T; // apex at T/2, touches down exactly at T
    b.dmg = dmg;
    b.splash = splash;
    b.ricochet = ric;
    b.spin = this.rng.range(6, 12);
    b.tx = tx;
    b.ty = ty;
    b.targetIdx = targetIdx;
    b.flightT = 0;
    b.maxFlightT = T;
    if (existingReticle) {
      existingReticle.active = true;
      existingReticle.x = tx;
      existingReticle.y = ty;
      existingReticle.t = T;
      existingReticle.max = T;
      existingReticle.targetIdx = targetIdx;
      existingReticle.phase = 'landing';
    } else {
      this.reticle(tx, ty, T, targetIdx);
    }
  }

  /** Landing impact: a direct locked-target hit for ordinary footballs,
   *  optional radius only for explicit special lobs, then optional ricochet. */
  private lobImpact(b: Ball): void {
    const r = b.splash;
    let hit = false;
    if (r <= 0) {
      const target = this.enemies[b.targetIdx];
      if (target?.active) {
        this.damageEnemy(b.targetIdx, b.dmg, 0, 0);
        hit = true;
      }
    } else {
      const n = this.query(b.x, b.y, r + 40, this.scratch);
      for (let i = 0; i < n; i++) {
        const idx = this.scratch[i];
        const e = this.enemies[idx];
        if (!e.active) continue;
        if (dist2(b.x, b.y, e.x, e.y) > (r + e.radius) * (r + e.radius)) continue;
        hit = true;
        const d = Math.hypot(e.x - b.x, e.y - b.y) || 1;
        this.damageEnemy(idx, b.dmg, ((e.x - b.x) / d) * 200, ((e.y - b.y) / d) * 200);
      }
    }
    if (!hit) return;
    this.spawnImpact(b.x, b.y, 0, 0, false, 'landing', true);
    this.burst(b.x, b.y, 10, '#ffd166');
    this.ring(b.x, b.y, r > 0 ? r : 24, '#ffd166');
    this.events.push({ type: 'lobLand', x: b.x, y: b.y });
    if (b.ricochet > 0) {
      const ti = this.pickAerialTarget(b.x, b.y);
      if (ti >= 0) {
        const e = this.enemies[ti];
        this.lob(b, b.x, b.y, e.x, e.y, b.dmg, b.splash, b.ricochet - 1, ti);
      }
    }
  }

  /** Smoothly steered long-range projectiles that can reacquire living threats. */
  private launchSeeker(
    kind: Seeker['kind'], targetIdx: number, dmg: number, splash: number,
    knock: number, speed: number, turnRate: number, chain: number, spread: number,
  ): boolean {
    const s = this.alloc(this.seekers);
    const target = this.enemies[targetIdx];
    if (!s || !target?.active) return false;
    const p = this.player;
    const aim = Math.atan2(target.y - p.y, target.x - p.x) + spread;
    s.active = true;
    s.kind = kind;
    s.x = p.x + Math.cos(aim) * 22;
    s.y = p.y + Math.sin(aim) * 22;
    s.lastX = s.x;
    s.lastY = s.y;
    s.trail1X = s.x;
    s.trail1Y = s.y;
    s.trail2X = s.x;
    s.trail2Y = s.y;
    s.trailClock = 0.06;
    s.z = kind === 'curveball' ? 72 : 88;
    s.vx = Math.cos(aim) * speed;
    s.vy = Math.sin(aim) * speed;
    s.speed = speed;
    s.turnRate = turnRate;
    s.targetIdx = targetIdx;
    s.dmg = dmg;
    s.splash = splash;
    s.knock = knock;
    s.life = kind === 'curveball' ? 3.1 : 3.6;
    s.maxLife = s.life;
    s.chain = chain;
    s.angle = aim;
    s.phase = this.rng.range(0, TAU);
    return true;
  }

  private fireCurveball(): void {
    const lvl = this.abilityLevel('curveball');
    if (lvl === 0) return;
    const count = [0, 3, 4, 4, 5, 7][lvl];
    const dmg = [0, 11, 13, 16, 18, 22][lvl] * this.damageMult;
    const speed = [0, 430, 450, 470, 500, 535][lvl];
    const turn = [0, 4.2, 4.8, 5.2, 5.8, 6.4][lvl];
    const chain = lvl >= 5 ? 2 : lvl >= 3 ? 1 : 0;
    let launched = 0;
    for (let i = 0; i < count; i++) {
      const ti = this.pickAerialTarget(this.player.x, this.player.y);
      if (ti < 0) break;
      const spread = count === 1 ? 0 : ((i / (count - 1)) - 0.5) * 0.7;
      if (this.launchSeeker('curveball', ti, dmg, 0, 80, speed, turn, chain, spread)) launched++;
    }
    if (launched > 0) {
      this.burst(this.player.x, this.player.y, 7, '#47d7ff');
      this.events.push({ type: 'seekerLaunch', kind: 'curveball' });
    }
  }

  private fireBootSeekers(): void {
    const lvl = this.abilityLevel('bootseekers');
    if (lvl === 0) return;
    const count = [0, 1, 2, 2, 3, 4][lvl];
    const dmg = [0, 28, 28, 38, 42, 55][lvl] * this.damageMult;
    const splash = [0, 72, 82, 96, 108, 126][lvl];
    const knock = [0, 260, 290, 330, 380, 450][lvl];
    const speed = [0, 360, 375, 400, 425, 455][lvl];
    const turn = [0, 2.8, 3.1, 3.5, 3.9, 4.4][lvl];
    let launched = 0;
    for (let i = 0; i < count; i++) {
      const ti = this.pickAerialTarget(this.player.x, this.player.y);
      if (ti < 0) break;
      const spread = count === 1 ? 0 : ((i / (count - 1)) - 0.5) * 0.5;
      if (this.launchSeeker('goldenboot', ti, dmg, splash, knock, speed, turn, 0, spread)) launched++;
    }
    if (launched > 0) {
      this.burst(this.player.x, this.player.y, 9, '#ffbf36');
      this.events.push({ type: 'seekerLaunch', kind: 'goldenboot' });
    }
  }

  private seekerImpact(s: Seeker, targetIdx: number): void {
    const target = this.enemies[targetIdx];
    if (!target?.active) return;
    const hitX = target.x;
    const hitY = target.y;
    if (s.kind === 'goldenboot') {
      const n = this.query(hitX, hitY, s.splash + 48, this.scratch);
      for (let i = 0; i < n; i++) {
        const idx = this.scratch[i];
        const e = this.enemies[idx];
        if (!e.active || dist2(hitX, hitY, e.x, e.y) > (s.splash + e.radius) ** 2) continue;
        const d = Math.hypot(e.x - hitX, e.y - hitY) || 1;
        const dmg = idx === targetIdx ? s.dmg : s.dmg * 0.55;
        this.damageEnemy(idx, dmg, ((e.x - hitX) / d) * s.knock, ((e.y - hitY) / d) * s.knock);
      }
      this.ring(hitX, hitY, s.splash, '#ffbf36');
      this.spawnImpact(hitX, hitY, 0, 0, true, 'airburst', true);
      this.burst(hitX, hitY, 12, '#ffbf36');
    } else {
      const dx = target.x - s.x;
      const dy = target.y - s.y;
      const d = Math.hypot(dx, dy) || 1;
      this.damageEnemy(targetIdx, s.dmg, (dx / d) * s.knock, (dy / d) * s.knock);
      if (this.abilityLevel('curveball') >= 5) {
        // Cyclone Swarm: every impact releases a compact arc burst before the
        // ball chains onward, so the evolution changes crowd handling too.
        const arcR = 72;
        const n = this.query(hitX, hitY, arcR + 36, this.scratch);
        for (let i = 0; i < n; i++) {
          const idx = this.scratch[i];
          const e = this.enemies[idx];
          if (!e.active || idx === targetIdx || dist2(hitX, hitY, e.x, e.y) > (arcR + e.radius) ** 2) continue;
          const dd = Math.hypot(e.x - hitX, e.y - hitY) || 1;
          this.damageEnemy(idx, s.dmg * 0.35, ((e.x - hitX) / dd) * 110, ((e.y - hitY) / dd) * 110);
        }
        this.ring(hitX, hitY, arcR, '#47d7ff');
      }
      this.spawnImpact(hitX, hitY, s.vx, s.vy, false, 'airburst', true);
      this.burst(hitX, hitY, 6, '#47d7ff');
    }
    if (s.kind === 'goldenboot' && this.abilityLevel('bootseekers') >= 5) {
      const echoDmg = s.dmg * 0.48;
      const echoR = s.splash * 0.82;
      const echoKnock = s.knock * 0.62;
      this.deferred.push({
        t: 0.32,
        fn: () => {
          const n = this.query(hitX, hitY, echoR + 40, this.scratch);
          for (let i = 0; i < n; i++) {
            const idx = this.scratch[i];
            const e = this.enemies[idx];
            if (!e.active || dist2(hitX, hitY, e.x, e.y) > (echoR + e.radius) ** 2) continue;
            const d = Math.hypot(e.x - hitX, e.y - hitY) || 1;
            this.damageEnemy(idx, echoDmg, ((e.x - hitX) / d) * echoKnock, ((e.y - hitY) / d) * echoKnock);
          }
          this.ring(hitX, hitY, echoR, '#fff1a8');
          this.spawnImpact(hitX, hitY, 0, 0, true, 'airburst', true);
          this.burst(hitX, hitY, 10, '#fff1a8');
          this.events.push({ type: 'seekerHit', kind: 'goldenboot', x: hitX, y: hitY });
        },
      });
    }
    this.events.push({ type: 'seekerHit', kind: s.kind, x: hitX, y: hitY });

    if (s.kind === 'curveball' && s.chain > 0) {
      const previous = s.targetIdx;
      s.targetIdx = -1; // do not count this seeker's old reservation while reacquiring
      const next = this.pickAerialTarget(hitX, hitY);
      if (next >= 0 && next !== previous) {
        s.chain--;
        s.x = hitX;
        s.y = hitY;
        s.lastX = hitX;
        s.lastY = hitY;
        s.trail1X = hitX;
        s.trail1Y = hitY;
        s.trail2X = hitX;
        s.trail2Y = hitY;
        s.targetIdx = next;
        s.life = Math.max(s.life, 1.4);
        return;
      }
    }
    s.active = false;
  }

  /* GROUND lane: expanding pressure ring */

  private firePressure(): void {
    const lvl = this.abilityLevel('pressure');
    if (lvl === 0) return;
    const p = this.player;
    p.pressureCastLevel = lvl;
    p.pressureCastX = p.x;
    p.pressureCastY = p.y;
    p.pressureQueue = lvl >= 5 ? 2 : lvl >= 3 ? 1 : 0;
    p.pressureQueueT = 0.45;
    this.pressurePulse(lvl, p.pressureCastX, p.pressureCastY, true);
    this.events.push({ type: 'pressure', x: p.x, y: p.y });
  }

  private pressurePulse(lvl: number, x: number, y: number, applyVortex = false): void {
    const ring = this.alloc(this.pressures);
    if (!ring) return;
    ring.active = true;
    ring.x = x;
    ring.y = y;
    ring.r = 26;
    ring.maxR = [0, 150, 170, 170, 205, 225][lvl];
    ring.dmg = [0, 12, 18, 18, 24, 26][lvl] * this.damageMult;
    ring.knock = [0, 260, 260, 260, 345, 385][lvl];
    ring.hitSet.length = 0;
    if (lvl >= 5 && applyVortex) {
      // One restrained grounded pull establishes the vortex identity. Queued
      // pulses only release outward, avoiding repeated pull/push jitter.
      const n = this.query(x, y, ring.maxR + 60, this.scratch);
      for (let i = 0; i < n; i++) {
        const e = this.enemies[this.scratch[i]];
        if (!e.active || e.boss || this.isAerialEnemy(e)) continue;
        const d = Math.hypot(x - e.x, y - e.y) || 1;
        e.kx += ((x - e.x) / d) * 150;
        e.ky += ((y - e.y) / d) * 150;
      }
    }
  }

  /** HYBRID lane: a broad pitch-hugging blast for grounded mobs plus a
   *  smaller overhead pop that catches leapers instead of granting immunity. */
  private fireBlast(): boolean {
    const lvl = this.abilityLevel('blast');
    if (lvl === 0) return false;
    const p = this.player;
    const groundR = [0, 165, 190, 205, 225, 250][lvl];
    const airR = [0, 105, 120, 150, 165, 190][lvl];
    const groundDmg = [0, 18, 24, 27, 35, 46][lvl] * this.damageMult;
    const airDmg = [0, 14, 18, 25, 30, 42][lvl] * this.damageMult;
    const initialLayers = this.blastTargetLayers(p.x, p.y, groundR, airR);
    if (!initialLayers.ground && !initialLayers.aerial) return false;
    const n = this.query(p.x, p.y, groundR + 40, this.scratch);
    for (let i = 0; i < n; i++) {
      const idx = this.scratch[i];
      const e = this.enemies[idx];
      if (!e.active) continue;
      const d2 = dist2(p.x, p.y, e.x, e.y);
      const aerial = this.isAerialEnemy(e);
      const radius = aerial ? airR : groundR;
      if (d2 > (radius + e.radius) * (radius + e.radius)) continue;
      const d = Math.sqrt(d2) || 1;
      const knock = aerial ? 220 : lvl >= 4 ? 430 : 360;
      this.damageEnemy(
        idx,
        aerial ? airDmg : groundDmg,
        ((e.x - p.x) / d) * knock,
        ((e.y - p.y) / d) * knock,
        { stun: lvl >= 4 ? 0.3 : 0 },
      );
    }
    if (initialLayers.ground) this.ring(p.x, p.y, groundR, '#a8ff4d');
    if (initialLayers.aerial) this.spawnImpact(p.x, p.y, 0, -1, false, 'blastair', true, 0.82 + lvl * 0.08);
    this.events.push({ type: 'blast', x: p.x, y: p.y });
    if (lvl >= 5) {
      const echoX = p.x;
      const echoY = p.y;
      this.deferred.push({
        t: 0.34,
        fn: () => {
          const echoGroundR = groundR * 0.76;
          const echoAirR = airR * 0.9;
          const echoLayers = this.blastTargetLayers(echoX, echoY, echoGroundR, echoAirR);
          if (!echoLayers.ground && !echoLayers.aerial) return;
          const n = this.query(echoX, echoY, echoGroundR + 45, this.scratch);
          for (let i = 0; i < n; i++) {
            const idx = this.scratch[i];
            const e = this.enemies[idx];
            if (!e.active) continue;
            const aerial = this.isAerialEnemy(e);
            const radius = aerial ? echoAirR : echoGroundR;
            const d2 = dist2(echoX, echoY, e.x, e.y);
            if (d2 > (radius + e.radius) ** 2) continue;
            const d = Math.sqrt(d2) || 1;
            this.damageEnemy(idx, (aerial ? airDmg : groundDmg) * 0.56, ((e.x - echoX) / d) * 300, ((e.y - echoY) / d) * 300, { stun: 0.22 });
          }
          if (echoLayers.ground) this.ring(echoX, echoY, echoGroundR, '#f5ff9b');
          if (echoLayers.aerial) this.spawnImpact(echoX, echoY, 0, -1, true, 'blastair', true, 0.9);
          this.events.push({ type: 'blast', x: echoX, y: echoY });
        },
      });
    }
    return true;
  }

  private reticle(x: number, y: number, t: number, targetIdx = -1, phase: Reticle['phase'] = 'landing'): number {
    const r = this.alloc(this.reticles);
    if (!r) return -1;
    r.active = true;
    r.x = x;
    r.y = y;
    r.t = t;
    r.max = t;
    r.targetIdx = targetIdx;
    r.phase = phase;
    return this.reticles.indexOf(r);
  }

  private fireWhistle(): void {
    const lvl = this.abilityLevel('whistle');
    if (lvl === 0) return;
    const p = this.player;
    const r = [0, 130, 165, 165, 205, 245][lvl] * (this.def.id === 'ronaldo' ? 1.25 : 1);
    const dmg = [0, 15, 15, 22, 22, 32][lvl] * this.damageMult;
    const stun = lvl >= 4 ? 1.0 : 0;
    this.doShockwave(p.x, p.y, r, dmg, stun);
    if (lvl >= 5) p.whistlePulse = 0.35; // second pulse follows
    this.events.push({ type: 'whistle', x: p.x, y: p.y });
  }

  private doShockwave(x: number, y: number, r: number, dmg: number, stun: number): void {
    const n = this.query(x, y, r + 40, this.scratch);
    for (let i = 0; i < n; i++) {
      const idx = this.scratch[i];
      const e = this.enemies[idx];
      if (this.isAerialEnemy(e)) continue; // GROUND lane: sweeps under aerial troops
      const d2 = dist2(x, y, e.x, e.y);
      if (d2 > (r + e.radius) * (r + e.radius)) continue;
      const d = Math.sqrt(d2) || 1;
      const k = 450;
      this.damageEnemy(idx, dmg, ((e.x - x) / d) * k, ((e.y - y) / d) * k, { stun });
    }
    this.ring(x, y, r, '#f5f7fa');
  }

  /** Cooldown of one charge at the current level, exposed for the HUD. */
  get dashCooldownDuration(): number {
    const lvl = this.abilityLevel('dash');
    if (lvl === 0) return 0;
    return [0, 5, 5, 4, 4, 3][lvl] * (this.def.id === 'neymar' ? 0.75 : 1);
  }

  /** Decision-facing HUD timing. Passive abilities intentionally return a
   * zero duration so the dock does not pretend they are waiting on a cast. */
  getAbilityTiming(id: AbilityId): { remaining: number; duration: number; active: boolean } {
    const lvl = this.abilityLevel(id);
    if (lvl <= 0) return { remaining: 0, duration: 0, active: false };
    const p = this.player;
    switch (id) {
      case 'strike':
        return { remaining: Math.max(0, p.strikeCd), duration: [0, 0.9, 0.9, 0.8, 0.8, 0.65][lvl], active: p.kickT > 0 };
      case 'curveball':
        return { remaining: Math.max(0, p.curveballCd), duration: [0, 3.4, 3.2, 3.0, 2.7, 2.35][lvl], active: this.seekers.some((seeker) => seeker.active && seeker.kind === 'curveball') };
      case 'bootseekers':
        return { remaining: Math.max(0, p.bootseekersCd), duration: [0, 4.5, 4.3, 4.0, 3.6, 3.1][lvl], active: this.seekers.some((seeker) => seeker.active && seeker.kind === 'goldenboot') };
      case 'whistle':
        return { remaining: Math.max(0, p.whistleCd), duration: [0, 3.5, 3.5, 3.0, 3.0, 2.2][lvl], active: p.whistlePulse > 0 };
      case 'pressure':
        return { remaining: Math.max(0, p.pressureCd), duration: [0, 2.6, 2.6, 2.3, 2.3, 2.0][lvl], active: p.pressureQueue > 0 || this.pressures.some((ring) => ring.active) };
      case 'blast':
        return { remaining: Math.max(0, p.blastCd), duration: [0, 4.8, 4.8, 4.4, 3.8, 3.2][lvl], active: false };
      case 'dash':
        return {
          remaining: Math.max(0, ...p.dashCds),
          duration: this.dashCooldownDuration,
          active: p.dashWindupT > 0 || p.dashT > 0 || p.dashRecoveryT > 0,
        };
      case 'orbit':
      case 'guard':
        return { remaining: 0, duration: 0, active: true };
      case 'keeperhalo':
        return {
          remaining: Math.max(0, p.keeperBlockCd),
          duration: [0, 1.55, 1.2, 0.9, 0.62, 0.34][lvl],
          active: p.keeperBlockCd > 0,
        };
    }
  }

  /** Explicitly request Nutmeg Dash. Returns false without spending a charge
   * when the action is unavailable or the locked path ends immediately at a
   * pitch edge. Auto attacks never call this method. */
  requestDash(ax = 0, ay = 0): boolean {
    const lvl = this.abilityLevel('dash');
    if (lvl === 0 || this.over !== 'playing') return false;
    const p = this.player;
    if (p.dashT > 0 || p.dashWindupT > 0 || p.dashRecoveryT > 0 || p.kickT > 0) return false;
    const cdIdx = p.dashCds.findIndex((c) => c <= 0);
    if (cdIdx < 0) return false;
    const requestedLength = Math.hypot(ax, ay);
    let dx = requestedLength > 0.05 ? ax / requestedLength : p.visualDx;
    let dy = requestedLength > 0.05 ? ay / requestedLength : p.visualDy;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;

    const xClearance = Math.abs(dx) < 0.0001
      ? Number.POSITIVE_INFINITY
      : dx > 0
        ? (ARENA_W - this.playerEdgeInsetX - p.x) / dx
        : (this.playerEdgeInsetX - p.x) / dx;
    const yClearance = Math.abs(dy) < 0.0001
      ? Number.POSITIVE_INFINITY
      : dy > 0
        ? (ARENA_H - this.playerEdgeInsetY - p.y) / dy
        : (this.playerEdgeInsetY - p.y) / dy;
    const clearance = Math.min(xClearance, yClearance);
    const plannedDistance = DASH_SPEED * (0.22 + lvl * 0.012);
    if (clearance < Math.min(58, plannedDistance * 0.42)) return false;

    p.dashCds[cdIdx] = this.dashCooldownDuration;
    p.dashDx = dx;
    p.dashDy = dy;
    p.dashWindupT = DASH_ANTICIPATION_DURATION;
    p.dashRecoveryT = 0;
    return true;
  }

  /** Capture one melee vector at anticipation start. The actor may miss if the
   * player sidesteps; neither the body nor the hitbox homes during the swing. */
  private beginMelee(e: Enemy, dx: number, dy: number, windup: number): void {
    const length = Math.hypot(dx, dy) || 1;
    e.meleeDx = dx / length;
    e.meleeDy = dy / length;
    e.meleeHit = false;
    e.windup = windup;
    if (Math.abs(e.meleeDx) > 0.001) e.face = e.meleeDx > 0 ? 1 : -1;
  }

  /** Advance the visible body first, then resolve the single authored contact
   * frame against the body's new position. */
  private advanceMeleeLunge(
    e: Enemy,
    dt: number,
    duration: number,
    speedScale: number,
    reach: number,
    knock: number,
    planted = false,
  ): void {
    const safeDuration = Math.max(0.001, duration);
    const beforeT = Math.max(0, e.lungeT);
    const activeDt = Math.min(dt, beforeT);
    const beforeProgress = Math.max(0, Math.min(1, 1 - beforeT / safeDuration));
    if (!planted) {
      e.x += e.meleeDx * e.speed * speedScale * activeDt;
      e.y += e.meleeDy * e.speed * speedScale * activeDt;
    }
    e.lungeT = Math.max(0, beforeT - dt);
    const afterProgress = Math.max(0, Math.min(1, 1 - e.lungeT / safeDuration));
    if (!e.meleeHit && beforeProgress < MELEE_CONTACT_PROGRESS && afterProgress >= MELEE_CONTACT_PROGRESS) {
      e.meleeHit = true;
      const p = this.player;
      if (e.airT <= 0 && dist2(e.x, e.y, p.x, p.y) < reach * reach) {
        const contactDamage = e.boss === 'captain' ? Math.min(CAPTAIN_MELEE_MAX, e.damage) : e.damage;
        this.hurtPlayer(contactDamage, e.meleeDx * knock, e.meleeDy * knock);
      }
      if (planted) this.burst(e.x, e.y, 7, '#8ead62');
      this.events.push({ type: 'punch' });
    }
  }

  /* ---------------- update ---------------- */

  update(dt: number, ax: number, ay: number): void {
    if (this.over !== 'playing') {
      this.updateFx(dt);
      return;
    }
    const p = this.player;
    const freezeActive = this.freezeT > 0;
    let worldFrozen = freezeActive || this.bossIntroT > 0 || this.debugHostileHold;
    // Freeze remains a powerful full-field rescue, but offensive timers and
    // friendly projectiles also slow down. This removes the old 5.5-second
    // free-DPS window while preserving full player movement for repositioning.
    const playerCombatDt = freezeActive ? dt * 0.4 : dt;
    this.freezeT = Math.max(0, this.freezeT - dt);
    if (!this.debugBossIntroHold) this.bossIntroT = Math.max(0, this.bossIntroT - dt);
    this.magnetT = Math.max(0, this.magnetT - dt);
    const worldDt = worldFrozen ? 0 : dt;
    // Regulation time ends at 90'. Gameplay may continue in sudden death, but
    // result rewards and the HUD must not invent minutes beyond full time.
    this.time = Math.min(RUN_LENGTH, this.time + worldDt);
    this.tickRewardBuffs(dt);
    for (let i = this.deferred.length - 1; i >= 0; i--) {
      this.deferred[i].t -= playerCombatDt;
      if (this.deferred[i].t <= 0) {
        const d = this.deferred.splice(i, 1)[0];
        d.fn();
      }
    }

    /* timers */
    p.iframes = Math.max(0, p.iframes - dt);
    p.dashIframesT = Math.max(0, p.dashIframesT - dt);
    p.pivotT = Math.max(0, p.pivotT - dt);
    if (!this.debugHostileHold) p.hurtT = Math.max(0, p.hurtT - dt);
    p.heartFxT = Math.max(0, p.heartFxT - dt);
    p.healT = Math.max(0, p.healT - dt);
    p.strikeCd -= playerCombatDt;
    p.curveballCd -= playerCombatDt;
    p.bootseekersCd -= playerCombatDt;
    p.whistleCd -= playerCombatDt;
    p.pressureCd -= playerCombatDt;
    p.blastCd -= playerCombatDt;
    p.curveballRetry -= playerCombatDt;
    p.bootseekersRetry -= playerCombatDt;
    p.pressureRetry -= playerCombatDt;
    p.blastRetry -= playerCombatDt;
    p.orbitBreakCd = Math.max(0, p.orbitBreakCd - playerCombatDt);
    p.keeperBlockCd = Math.max(0, p.keeperBlockCd - playerCombatDt);
    p.kickT = Math.max(0, p.kickT - playerCombatDt);
    if (p.kickT > 0 && KICK_DURATION - p.kickT < KICK_AIM_LOCK_DELAY) {
      const target = this.enemies[p.kickTargetIdx];
      if (target?.active) {
        const dx = target.x - p.x;
        const dy = target.y - p.y;
        const distance = Math.hypot(dx, dy) || 1;
        p.aimDx = dx / distance;
        p.aimDy = dy / distance;
        if (Math.abs(dx) > 0.001) p.face = dx > 0 ? 1 : -1;
      }
    } else if (p.kickT <= 0) {
      p.kickTargetIdx = -1;
    }
    for (let i = 0; i < p.dashCds.length; i++) p.dashCds[i] -= playerCombatDt;
    if (p.dashWindupT > 0) {
      p.dashWindupT = Math.max(0, p.dashWindupT - dt);
      if (p.dashWindupT <= 0) {
        const lvl = this.abilityLevel('dash');
        p.dashT = 0.22 + lvl * 0.012;
        p.dashIframesT = p.dashT + DASH_IFRAME_DURATION;
        p.dashMomentum = 1;
        p.dashId++;
        this.events.push({ type: 'dash' });
        this.burst(p.x, p.y, 6, '#80ed99');
      }
    } else if (p.dashT <= 0) {
      p.dashRecoveryT = Math.max(0, p.dashRecoveryT - dt);
    }
    if (p.pressureQueue > 0) {
      p.pressureQueueT -= playerCombatDt;
      if (p.pressureQueueT <= 0) {
        p.pressureQueue--;
        p.pressureQueueT = 0.45; // staggered so launched mobs land before the next pulse
        this.pressurePulse(p.pressureCastLevel, p.pressureCastX, p.pressureCastY);
        this.events.push({ type: 'pressure', x: p.pressureCastX, y: p.pressureCastY });
      }
    }
    if (p.whistlePulse > 0) {
      p.whistlePulse -= playerCombatDt;
      if (p.whistlePulse <= 0) {
        p.whistlePulse = -1;
        const r = 245 * 1.25 * (this.def.id === 'ronaldo' ? 1.25 : 1);
        this.doShockwave(p.x, p.y, r, 32 * this.damageMult * 0.6, 0.5);
        this.events.push({ type: 'whistle', x: p.x, y: p.y });
      }
    }
    // regen
    p.regenAcc += this.regen * playerCombatDt;
    if (p.regenAcc >= 1) {
      const h = Math.floor(p.regenAcc);
      p.regenAcc -= h;
      p.hp = Math.min(p.maxHp, p.hp + h);
    }

    /* movement */
    const rawIntent = Math.hypot(ax, ay);
    const intentMagnitude = Math.min(1, rawIntent);
    const intentDx = rawIntent > 0.0001 ? ax / rawIntent : 0;
    const intentDy = rawIntent > 0.0001 ? ay / rawIntent : 0;
    const sp = this.moveSpeed * (p.slowT > 0 ? 0.55 : 1);
    const dashControlScale = p.dashWindupT > 0 ? 0.34 : p.dashRecoveryT > 0 ? 0.62 : 1;
    const controlScale = Math.min(dashControlScale, kickMovementScale(p.kickT));
    const targetVx = intentDx * sp * intentMagnitude * controlScale;
    const targetVy = intentDy * sp * intentMagnitude * controlScale;
    const speedBefore = Math.hypot(p.moveVx, p.moveVy);
    const targetSpeed = Math.hypot(targetVx, targetVy);
    const alignment = speedBefore > 0.001 && targetSpeed > 0.001
      ? (p.moveVx * targetVx + p.moveVy * targetVy) / (speedBefore * targetSpeed)
      : 1;
    const responseTime = intentMagnitude < 0.001
      ? PLAYER_BRAKE_TIME
      : alignment < 0
        ? PLAYER_TURN_TIME
        : PLAYER_ACCEL_TIME;
    const velocity = approachVelocity(
      p.moveVx,
      p.moveVy,
      targetVx,
      targetVy,
      (sp / responseTime) * dt,
    );
    p.moveVx = velocity.vx;
    p.moveVy = velocity.vy;
    if (intentMagnitude > 0.001 && p.dashWindupT <= 0 && p.dashT <= 0 && p.dashRecoveryT <= 0) {
      // Dash intent stays immediate even though locomotion has physical ramp.
      p.dashDx = intentDx;
      p.dashDy = intentDy;
    }

    const physicalSpeed = Math.hypot(p.moveVx, p.moveVy);
    p.moving = physicalSpeed > sp * 0.025;
    if (p.moving) {
      p.moveDx = p.moveVx / physicalSpeed;
      p.moveDy = p.moveVy / physicalSpeed;
      const candidate = hystereticMovementOctant(p.visualDir, p.moveDx, p.moveDy);
      if (candidate === p.visualDir) {
        p.visualDirCandidate = candidate;
        p.visualDirHoldT = 0;
      } else {
        if (candidate !== p.visualDirCandidate) {
          p.visualDirCandidate = candidate;
          p.visualDirHoldT = dt;
        } else {
          p.visualDirHoldT += dt;
        }
        const octantDelta = Math.abs(candidate - p.visualDir);
        const sectorDistance = Math.min(octantDelta, 8 - octantDelta);
        const requiredHold = sectorDistance === 4 ? 0 : sectorDistance >= 2 ? 0.025 : 0.05;
        if (p.visualDirHoldT >= requiredHold) {
          if (sectorDistance === 4) {
            // A true 180-degree football cut is a three-beat planted action,
            // not four delayed sprite snaps. Gait phase remains untouched.
            p.pivotT = PLAYER_PIVOT_DURATION;
            p.pivotFromDir = p.visualDir;
            p.pivotToDir = candidate;
            p.visualDir = candidate;
          } else {
            p.visualDir = sectorDistance >= 2
              ? stepMovementOctant(p.visualDir, candidate)
              : candidate;
          }
          const visualAngle = p.visualDir * (Math.PI / 4);
          p.visualDx = Math.cos(visualAngle);
          p.visualDy = Math.sin(visualAngle);
          p.visualDirHoldT = 0;
        }
      }
      if (p.kickT <= 0 && Math.abs(p.visualDx) > 0.001) p.face = p.visualDx > 0 ? 1 : -1;
    }
    const movementAngle = p.moving ? Math.atan2(p.moveDy, p.moveDx) : p.lastMoveAngle;
    if (p.moving) {
      const angularDelta = Math.atan2(
        Math.sin(movementAngle - p.lastMoveAngle),
        Math.cos(movementAngle - p.lastMoveAngle),
      );
      const targetTurnLean = clamp(-angularDelta / Math.max(dt, 0.001) * 0.45, -Math.PI / 12, Math.PI / 12);
      p.turnLean += (targetTurnLean - p.turnLean) * (1 - Math.exp(-dt / 0.055));
      p.lastMoveAngle = movementAngle;
    } else {
      p.turnLean += (0 - p.turnLean) * (1 - Math.exp(-dt / 0.08));
    }
    const accelerating = intentMagnitude > 0.001
      && (targetSpeed > speedBefore + sp * 0.025 || alignment < 0.92);
    const leanResponse = accelerating ? 0.04 : 0.12;
    const leanTarget = accelerating ? 1 : 0;
    p.accelLean += (leanTarget - p.accelLean) * (1 - Math.exp(-dt / leanResponse));

    let locomotionDistance = 0;
    let locomotionDx = 0;
    let locomotionDy = 0;
    if (p.dashT > 0) {
      const activeDt = Math.min(dt, p.dashT);
      p.dashT = Math.max(0, p.dashT - dt);
      const lvl = this.abilityLevel('dash');
      const dashSpeed = DASH_SPEED * p.dashMomentum;
      const nextX = clamp(p.x + p.dashDx * dashSpeed * activeDt, this.playerEdgeInsetX, ARENA_W - this.playerEdgeInsetX);
      const nextY = clamp(p.y + p.dashDy * dashSpeed * activeDt, this.playerEdgeInsetY, ARENA_H - this.playerEdgeInsetY);
      locomotionDx = nextX - p.x;
      locomotionDy = nextY - p.y;
      locomotionDistance = Math.hypot(locomotionDx, locomotionDy);
      p.x = nextX;
      p.y = nextY;
      // damage enemies passed through
      const dmg = [0, 20, 30, 30, 30, 45][lvl] * this.damageMult;
      const n = this.query(p.x, p.y, 60, this.scratch);
      for (let i = 0; i < n; i++) {
        const idx = this.scratch[i];
        const e = this.enemies[idx];
        if (this.isAerialEnemy(e)) continue; // GROUND lane: dash sweep passes underneath
        if (dist2(p.x, p.y, e.x, e.y) < (e.radius + 42) * (e.radius + 42) && e.dashMark !== p.dashId) {
          e.dashMark = p.dashId;
          const d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
          this.damageEnemy(idx, dmg, ((e.x - p.x) / d) * 200, ((e.y - p.y) / d) * 200);
        }
      }
      // L5 slowing trail
      if (lvl >= 5) {
        this.trailAcc -= activeDt;
        if (this.trailAcc <= 0) {
          this.trailAcc = 0.06;
          this.slowZones.push({ x: p.x, y: p.y, r: 55, t: 3.5 });
        }
      }
      if (p.dashT <= 0) p.dashRecoveryT = DASH_RECOVERY_DURATION;
    } else {
      const nextX = clamp(p.x + p.moveVx * dt, this.playerEdgeInsetX, ARENA_W - this.playerEdgeInsetX);
      const nextY = clamp(p.y + p.moveVy * dt, this.playerEdgeInsetY, ARENA_H - this.playerEdgeInsetY);
      locomotionDx = nextX - p.x;
      locomotionDy = nextY - p.y;
      locomotionDistance = Math.hypot(locomotionDx, locomotionDy);
      p.x = nextX;
      p.y = nextY;
    }
    // Input may still request full speed against a physical pitch edge. Only
    // real world displacement may select the run strip; otherwise the player
    // plants into the neutral pose instead of moonwalking in place.
    if (locomotionDistance < 0.0001) p.moving = false;
    const visualLocomotionDistance = Math.hypot(
      locomotionDx,
      locomotionDy * PLAYER_VISUAL_Y_SCALE,
    );
    p.runDistance += visualLocomotionDistance;
    const firstPlant = PLAYER_RUN_CYCLE_DISTANCE * (2 / PLAYER_RUN_FRAMES);
    p.runStep = p.runDistance < firstPlant
      ? 0
      : Math.floor((p.runDistance - firstPlant) / (PLAYER_RUN_CYCLE_DISTANCE / 2)) + 1;
    // Preserve the renderer's time-shaped API while deriving its phase solely
    // from world distance. Standing still now freezes the exact planted pose.
    p.animT = (p.runDistance / PLAYER_RUN_CYCLE_DISTANCE) * (PLAYER_RUN_FRAMES / PLAYER_RUN_FPS);
    // player knockback (heavy hits, vuvuzela blasts)
    p.slowT = Math.max(0, p.slowT - dt);
    p.x += p.kx * dt;
    p.y += p.ky * dt;
    p.kx *= Math.pow(0.001, dt);
    p.ky *= Math.pow(0.001, dt);
    p.x = clamp(p.x, this.playerEdgeInsetX, ARENA_W - this.playerEdgeInsetX);
    p.y = clamp(p.y, this.playerEdgeInsetY, ARENA_H - this.playerEdgeInsetY);
    /* abilities */
    // refresh the spatial grid so same-frame spawns are targetable (abilities
    // run before the per-frame enemy rebuild below)
    this.rebuildGrid();
    if (
      p.strikeCd <= 0
      && this.abilityLevel('strike') > 0
      && p.dashWindupT <= 0
      && p.dashT <= 0
      && p.dashRecoveryT <= 0
    ) {
      const lvl = this.abilityLevel('strike');
      if (this.nearestEnemy(p.x, p.y, Sim.AERIAL_MAX_RANGE) >= 0) {
        p.strikeCd = [0, 0.9, 0.9, 0.8, 0.8, 0.65][lvl];
        this.fireStrike();
      }
    }
    if (p.curveballCd <= 0 && p.curveballRetry <= 0 && this.abilityLevel('curveball') > 0) {
      const lvl = this.abilityLevel('curveball');
      if (this.nearestEnemy(p.x, p.y, Sim.AERIAL_MAX_RANGE) >= 0) {
        p.curveballCd = [0, 3.4, 3.2, 3.0, 2.7, 2.35][lvl];
        this.fireCurveball();
      } else p.curveballRetry = 0.18;
    }
    if (p.bootseekersCd <= 0 && p.bootseekersRetry <= 0 && this.abilityLevel('bootseekers') > 0) {
      const lvl = this.abilityLevel('bootseekers');
      if (this.nearestEnemy(p.x, p.y, Sim.AERIAL_MAX_RANGE) >= 0) {
        p.bootseekersCd = [0, 4.5, 4.3, 4.0, 3.6, 3.1][lvl];
        this.fireBootSeekers();
      } else p.bootseekersRetry = 0.18;
    }
    if (p.whistleCd <= 0 && this.abilityLevel('whistle') > 0) {
      const lvl = this.abilityLevel('whistle');
      p.whistleCd = [0, 3.5, 3.5, 3.0, 3.0, 2.2][lvl];
      this.fireWhistle();
    }
    let pressureCastThisFrame = false;
    if (p.pressureCd <= 0 && p.pressureRetry <= 0 && this.abilityLevel('pressure') > 0) {
      const lvl = this.abilityLevel('pressure');
      const triggerR = [0, 150, 170, 170, 205, 225][lvl] + 60;
      if (this.hasGroundThreat(p.x, p.y, triggerR)) {
        p.pressureCd = [0, 2.6, 2.6, 2.3, 2.3, 2.0][lvl];
        this.firePressure();
        pressureCastThisFrame = true;
      } else {
        p.pressureRetry = 0.16;
      }
    }
    if (p.blastCd <= 0 && p.blastRetry <= 0 && this.abilityLevel('blast') > 0) {
      const lvl = this.abilityLevel('blast');
      if (pressureCastThisFrame) {
        // Keep the two large close-range reads distinct instead of stacking
        // their rings, hit flashes and sound on the same rendered frame.
        p.blastRetry = 0.22;
      } else if (this.fireBlast()) {
        p.blastCd = [0, 4.8, 4.8, 4.4, 3.8, 3.2][lvl];
      } else p.blastRetry = 0.16;
    }
    // orbit damage + press
    const orbitLvl = this.abilityLevel('orbit');
    if (orbitLvl > 0) {
      const count = [0, 2, 3, 3, 4, 5][orbitLvl] + (this.def.id === 'yamal' ? 1 : 0);
      const radius = [0, 90, 90, 115, 115, 140][orbitLvl];
      const speed = [0, 2.3, 2.3, 2.5, 2.8, 3.0][orbitLvl];
      const dmg = [0, 10, 10, 14, 14, 20][orbitLvl] * this.damageMult;
      const knock = [0, 280, 280, 300, 320, 360][orbitLvl];
      p.orbitAngle += speed * playerCombatDt;
      for (let b = 0; b < count; b++) {
        const a = p.orbitAngle + (b / count) * TAU;
        const ox = p.x + Math.cos(a) * radius;
        const oy = p.y + Math.sin(a) * radius;
        const n = this.query(ox, oy, 34, this.scratch);
        for (let i = 0; i < n; i++) {
          const idx = this.scratch[i];
          const e = this.enemies[idx];
          if (e.orbitBallCds[b] > 0 || this.isAerialEnemy(e)) continue; // GROUND lane: orbit misses aerial troops
          if (dist2(ox, oy, e.x, e.y) < (e.radius + 18) * (e.radius + 18)) {
            e.orbitBallCds[b] = 0.28;
            const showFeedback = e.orbitCd <= 0;
            if (showFeedback) e.orbitCd = 0.18;
            const d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
            this.damageEnemy(idx, dmg, ((e.x - p.x) / d) * knock, ((e.y - p.y) / d) * knock, {
              source: showFeedback ? 'orbit' : undefined,
              feedback: showFeedback,
            });
            if (orbitLvl >= 5 && p.orbitBreakCd <= 0) {
              const ti = this.pickAerialTarget(ox, oy);
              const ball = ti >= 0 ? this.alloc(this.balls) : null;
              if (ball && ti >= 0) {
                const target = this.enemies[ti];
                this.lob(ball, ox, oy, target.x, target.y, dmg * 1.4, 76, 0, ti);
                p.orbitBreakCd = 1.25;
                this.events.push({ type: 'kick' });
              }
            }
          }
        }
      }
    }
    const keeperLvl = this.abilityLevel('keeperhalo');
    if (keeperLvl > 0) {
      p.keeperAngle += [0, 1.65, 1.75, 1.9, 2.05, 2.25][keeperLvl] * playerCombatDt;
    }

    /* spawning */
    const pressure = this.threatPressure;
    const counts = this.directorCounts();
    const activeOrdinary = this.enemies.reduce(
      (total, enemy) => total + (enemy.active && !enemy.boss ? 1 : 0),
      0,
    );
    const nextBossAt = !this.boss0Spawned ? BOSS0_AT
      : !this.boss1Spawned ? BOSS1_AT
        : !this.boss2Spawned ? BOSS2_AT
          : Number.POSITIVE_INFINITY;
    const bossIngress = this.bossAlive
      ? bossDirectorIngressMultiplier(this.bossAlive.boss)
      : bossApproachIngressMultiplier(nextBossAt - this.time);
    const populationIngress = directorPopulationIngressMultiplier(activeOrdinary, this.time);
    if (this.debugDirectorPaused) {
      // Debug scenes must prove one authored interaction without unrelated
      // enemies walking into the capture while assets finish decoding.
      this.spawnBudget = 0;
      this.eliteAcc = 0;
    } else if (worldFrozen) {
      // Preserve fractional pacing but never release queued enemies beneath a
      // freeze or boss-arrival presentation.
      this.spawnBudget = Math.min(this.spawnBudget, 0.999);
    } else {
      if (this.time < RUN_LENGTH) {
        if (this.time <= 2) {
          this.spawnBudget = 0;
        } else {
          this.spawnBudget = Math.min(
            MAX_SPAWNS_PER_STEP,
            this.spawnBudget + spawnRate(this.time, pressure) * bossIngress * populationIngress * worldDt,
          );
        }
        let spawnedThisStep = 0;
        while (this.spawnBudget >= 1 && spawnedThisStep < MAX_SPAWNS_PER_STEP) {
          const def = this.pickDirectorEnemy(counts);
          if (!def) {
            this.spawnBudget = Math.min(1, this.spawnBudget);
            break;
          }
          const pos = this.pickSpawnPos();
          const spawned = this.spawnEnemy(def, pos.x, pos.y, false);
          if (!spawned) {
            // The pool is full. Do not release a stored burst when slots reopen.
            this.spawnBudget = Math.min(1, this.spawnBudget);
            break;
          }
          this.spawnBudget -= 1;
          spawnedThisStep++;
          this.noteDirectorSpawn(counts, def);
        }
        // elites
        this.eliteAcc += worldDt * bossIngress * populationIngress;
        if (this.time >= 55 && this.eliteAcc > eliteInterval(this.time, pressure)) {
          this.eliteAcc = 0;
          const def = this.pickDirectorEnemy(counts);
          if (def) {
            const pos = this.pickSpawnPos();
            const spawned = this.spawnEnemy(def, pos.x, pos.y, true);
            if (spawned) this.noteDirectorSpawn(counts, def);
          }
        }
      } else {
        // Full time is a focused boss finish, not an endless horde escalation.
        // Existing threats remain live, while new ordinary and elite ingress
        // stops and no stored burst is released after the boss falls.
        this.spawnBudget = 0;
        this.eliteAcc = 0;
      }
      // bosses: introduced progressively, never two on the pitch at once
      if (!this.boss0Spawned && this.time >= BOSS0_AT && !this.bossAlive) {
        if (this.spawnBoss('drumboss')) this.boss0Spawned = true;
      }
      if (!this.boss1Spawned && this.time >= BOSS1_AT && !this.bossAlive) {
        if (this.spawnBoss('official')) this.boss1Spawned = true;
      }
      if (!this.boss2Spawned && this.time >= BOSS2_AT && !this.bossAlive) {
        if (this.spawnBoss('captain')) this.boss2Spawned = true;
      }
    }

    // A boss can begin its presentation in the director block above. Promote
    // that same fixed step to a hostile pause so no old mob or projectile gets
    // one hidden attack frame under the arrival card.
    if (this.bossIntroT > 0) worldFrozen = true;

    /* enemies */
    this.rebuildGrid();
    // haste auras: collect active Flag Bearers once per frame
    this.flagBearers.length = 0;
    for (const e of this.enemies) {
      if (e.active && !e.boss && e.def.behavior === 'support') this.flagBearers.push(e);
    }
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.active) continue;
      if (worldFrozen) {
        e.moving = false;
        continue;
      }
      const stepX = e.x;
      const stepY = e.y;
      e.flash = Math.max(0, e.flash - dt);
      e.hurtT = Math.max(0, e.hurtT - dt);
      e.orbitHitT = Math.max(0, e.orbitHitT - dt);
      e.attackAnimT = Math.max(0, e.attackAnimT - dt);
      e.barHitT = Math.max(0, e.barHitT - dt);
      if (e.barHitT <= 0 && e.barHp > e.hp) {
        e.barHp += (e.hp - e.barHp) * (1 - Math.exp(-dt * 5.5));
        if (Math.abs(e.barHp - e.hp) < 0.05) e.barHp = e.hp;
      }
      e.attackCd = Math.max(0, e.attackCd - dt);
      e.orbitCd = Math.max(0, e.orbitCd - dt);
      for (let ball = 0; ball < e.orbitBallCds.length; ball++) {
        e.orbitBallCds[ball] = Math.max(0, e.orbitBallCds[ball] - dt);
      }
      e.stun = Math.max(0, e.stun - dt);
      const wasAir = e.airT > 0;
      e.airT = Math.max(0, e.airT - dt);
      if (wasAir && e.airT <= 0) e.airMaxT = 0;
      if (e.def.behavior === 'aerial') {
        if (e.aerialGroundT > 0) {
          e.aerialGroundT = Math.max(0, e.aerialGroundT - dt);
          if (e.aerialGroundT <= 0) e.aerialFlightT = AERIAL_FLIGHT_DURATION;
        } else {
          e.aerialFlightT = Math.max(0, e.aerialFlightT - dt);
          if (e.aerialFlightT <= 0) {
            e.aerialGroundT = AERIAL_OVERHEAT_DURATION;
            e.casting = '';
            e.windup = 0;
            e.telegraph = 0;
            e.attackAnimT = 0;
          }
        }
      }
      e.boostT = Math.max(0, e.boostT - dt);
      e.telegraph = Math.max(0, e.telegraph - dt);
      e.chargeLaneFadeT = Math.max(0, e.chargeLaneFadeT - dt);
      e.animT += dt;
      // knockback decay
      e.x += e.kx * dt;
      e.y += e.ky * dt;
      e.kx *= Math.pow(0.001, dt);
      e.ky *= Math.pow(0.001, dt);
      // Hybrid scenery is a real physical border. Large enemies and bosses
      // need proportionally more centre clearance or their authored body can
      // still cut through a post even when the collision point is in bounds.
      const sideSceneryPad = this.radiusAwareSceneryEdges ? hybridEnemySceneryPad(e, 'side') : 0;
      const farSceneryPad = this.radiusAwareSceneryEdges ? hybridEnemySceneryPad(e, 'far') : 0;
      const nearSceneryPad = this.radiusAwareSceneryEdges ? hybridEnemySceneryPad(e, 'near') : 0;
      const enemyInsetX = this.enemyEdgeInsetX + sideSceneryPad;
      const enemyFarInsetY = this.enemyEdgeInsetY + farSceneryPad;
      const enemyNearInsetY = this.enemyEdgeInsetY + nearSceneryPad;
      e.x = clamp(e.x, enemyInsetX, ARENA_W - enemyInsetX);
      e.y = clamp(e.y, enemyFarInsetY, ARENA_H - enemyNearInsetY);
      // leapers land with a visible thump (ground moves work again from here)
      if (wasAir && e.airT <= 0 && !e.boss) {
        this.burst(e.x, e.y, 6, '#ff9a3d');
        this.ring(e.x, e.y, 60, '#ff9a3d');
      }
      if (e.stun > 0) {
        e.windup = 0;
        e.chargeWindupT = 0;
        e.chargeBrakeT = 0;
        e.lungeT = 0;
        e.attackAnimT = 0;
        e.casting = '';
        e.meleeHit = false; // stun fully interrupts anticipation and contact
        e.chargeHit = false;
        const movedX = e.x - stepX;
        const movedY = e.y - stepY;
        e.moving = movedX * movedX + movedY * movedY > 0.01;
        if (e.moving) {
          const movedLength = Math.hypot(movedX, movedY) || 1;
          e.moveDx = movedX / movedLength;
          e.moveDy = movedY / movedLength;
        }
        continue;
      }

      // haste: Flag Bearer aura + boss pulses
      e.haste = e.boostT > 0 ? 1.45 : 1;
      for (const f of this.flagBearers) {
        if (f !== e && dist2(e.x, e.y, f.x, f.y) < 190 * 190) {
          e.haste *= 1.35;
          break;
        }
      }

      // slow zones
      let slowMult = 1;
      for (const z of this.slowZones) {
        if (dist2(e.x, e.y, z.x, z.y) < z.r * z.r) {
          slowMult = 0.45;
          break;
        }
      }

      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const chargeFacingLocked = e.def.behavior === 'charger' && (e.windup > 0 || e.lungeT > 0);
      const meleeFacingLocked = e.casting === ''
        && (e.windup > 0 || e.lungeT > 0 || (e.attackAnimT > 0 && e.meleeHit));
      if (chargeFacingLocked && Math.abs(e.chargeDx) > 0.001) e.face = e.chargeDx > 0 ? 1 : -1;
      else if (meleeFacingLocked && Math.abs(e.meleeDx) > 0.001) e.face = e.meleeDx > 0 ? 1 : -1;
      else e.face = dx > 0 ? 1 : -1;

      // Orbiting Press: enemies inside the ring are constantly pushed out
      let press = 0;
      if (orbitLvl > 0) {
        const ringR = [0, 90, 90, 115, 115, 140][orbitLvl];
        if (d < ringR) press = 36;
      }

      if (e.boss === 'official') {
        this.updateOfficial(e, dx / d, dy / d, dt);
      } else if (e.boss === 'captain') {
        this.updateCaptain(e, dx / d, dy / d, dt);
      } else if (e.boss === 'drumboss') {
        this.updateDrumboss(e, dx / d, dy / d, dt);
      } else if (e.windup > 0) {
        // ---- wind-up: visibly pull back, then strike ----
        e.windup -= dt;
        if (e.windup <= 0) {
          if (e.casting === 'bottle') {
            e.casting = '';
            e.lungeT = 0;
            e.attackAnimT = 0.32;
            e.attackCd = 1.4;
            this.throwBottle(e);
          } else if (e.casting === 'electric') {
            e.casting = '';
            e.lungeT = 0;
            e.attackAnimT = 0.3;
            e.attackCd = 1.1;
            this.fireElectric(e);
          } else if (e.casting === 'scan') {
            e.casting = '';
            e.lungeT = 0;
            e.attackAnimT = 0.42;
            e.attackCd = 1.2;
            this.fireVarScan(e);
          } else if (e.casting === 'charge') {
            e.casting = '';
            e.lungeT = 0.78;
            e.attackAnimT = 0.78;
            e.attackCd = 2.2;
            e.chargeHit = false;
            e.chargeBrakeT = 0;
            this.events.push({ type: 'bullCharge', x: e.x, y: e.y });
          } else {
            e.lungeT = ENEMY_MELEE_LUNGE_DURATION;
            e.attackAnimT = ENEMY_MELEE_LUNGE_DURATION + MELEE_RECOVERY_DURATION;
            e.attackCd = e.def.behavior === 'chase' || e.def.behavior === 'wall' ? 0.9 : 1.4;
          }
        }
      } else if (e.lungeT > 0) {
        // ---- strike lunge / direction-locked bull charge ----
        if (e.def.behavior === 'charger') {
          const beforeCharge = e.lungeT;
          const activeDt = Math.min(dt, e.lungeT);
          e.x += e.chargeDx * 520 * activeDt;
          e.y += e.chargeDy * 520 * activeDt;
          e.lungeT = Math.max(0, e.lungeT - dt);
          if (!e.chargeHit && dist2(e.x, e.y, p.x, p.y) < (e.radius + 28) ** 2) {
            e.chargeHit = true;
            this.hurtPlayer(e.damage, e.chargeDx * (e.def.push ?? 430), e.chargeDy * (e.def.push ?? 430), 0.28);
            this.spawnImpact(p.x, p.y, e.chargeDx, e.chargeDy, false, 'contact', true);
          }
          if (beforeCharge > 0 && e.lungeT <= 0) {
            e.chargeBrakeT = 0.15;
            this.burst(e.x, e.y, 8, '#87ad58');
          }
        } else {
          this.advanceMeleeLunge(
            e,
            dt,
            ENEMY_MELEE_LUNGE_DURATION,
            3.2,
            e.radius + 30,
            e.def.push ?? 120,
            e.def.id === 'foam',
          );
        }
      } else if (e.chargeBrakeT > 0) {
        // The last part of a bull charge transfers momentum into a short turf
        // skid instead of snapping from 520 units/s to a dead stop.
        const activeDt = Math.min(dt, e.chargeBrakeT);
        const brake = clamp(e.chargeBrakeT / 0.15, 0, 1);
        e.x += e.chargeDx * 210 * brake * brake * activeDt;
        e.y += e.chargeDy * 210 * brake * brake * activeDt;
        e.chargeBrakeT = Math.max(0, e.chargeBrakeT - dt);
      } else if (e.attackAnimT > 0) {
        // The body holds a short follow-through before locomotion can resume.
      } else {
        // ---- locomotion + behavior specials ----
        const sp = e.speed * e.haste * slowMult;
        // pair spacing: a soft spring holds pack members a readable distance
        // apart while a hard core prevents physical overlap. Horde identity
        // comes from shared spawn anchors and a common chase point, so packs
        // advance as a wide loose front instead of one tight ball. The soft
        // push is capped below the chase speed so a crowded horde always
        // keeps pressing instead of locking into a jammed clump.
        let sx = 0;
        let sy = 0;
        let tx = 0;
        let ty = 0;
        const n = this.query(e.x, e.y, 175, this.scratch);
        for (let s = 0; s < n; s++) {
          const o = this.enemies[this.scratch[s]];
          if (o === e || !o.active || o.boss || o.def.behavior === 'aerial') continue;
          const od2 = dist2(e.x, e.y, o.x, o.y);
          if (od2 <= 0.01) continue;
          const od = Math.sqrt(od2);
          const min = e.radius + o.radius;
          const ux = (e.x - o.x) / od;
          const uy = (e.y - o.y) / od;
          if (od < min) {
            sx += ux * (min - od) * 2.4;
            sy += uy * (min - od) * 2.4;
          } else {
            tx += ux * sp * 1.6 * (1 - od / 175);
            ty += uy * sp * 1.6 * (1 - od / 175);
          }
        }
        const tl = Math.hypot(tx, ty);
        if (tl > sp * 0.7) {
          tx *= (sp * 0.7) / tl;
          ty *= (sp * 0.7) / tl;
        }
        sx += tx;
        sy += ty;
        // horde cohesion: a weak pull keeps stragglers attached to the local
        // crowd so packs advance as one loose front while every member keeps
        // pressing the player. The pull fades as the pack tightens and the
        // pair spring above is what actually stops it from collapsing.
        let hx = 0;
        let hy = 0;
        {
          const hn = this.query(e.x, e.y, HORDE_COHESION_RADIUS, this.scratch);
          let cn = 0;
          let cx = 0;
          let cy = 0;
          for (let h = 0; h < hn; h++) {
            const o = this.enemies[this.scratch[h]];
            if (o === e || !o.active || o.boss || o.def.behavior === 'aerial') continue;
            cx += o.x;
            cy += o.y;
            cn++;
          }
          if (cn > 0) {
            const cdx = cx / cn - e.x;
            const cdy = cy / cn - e.y;
            const cd = Math.hypot(cdx, cdy) || 1;
            const pull = 0.12 * Math.min(1, cd / HORDE_COHESION_RADIUS);
            hx = (cdx / cd) * sp * pull;
            hy = (cdy / cd) * sp * pull;
          }
        }
        const beh = e.def.behavior;
        if (beh === 'aerial' && e.aerialGroundT > 0) {
          // Authored overheat: the unit is grounded, stationary and vulnerable
          // to Ground attacks for a readable 1.35-second counter window.
        } else if (e.airT > 0) {
          // mid-leap: momentum carries the leap (no steering)
        } else if (beh === 'chase' || beh === 'wall' || beh === 'thumper' || beh === 'leaper') {
          e.x += ((dx / d) * (sp - press) + sx + hx) * dt;
          e.y += ((dy / d) * (sp - press) + sy + hy) * dt;
          if (beh === 'wall' && d < e.radius + 16) {
            // Banner Wall body-blocks: shove the player out of the wall
            p.x = e.x + (dx / d) * (e.radius + 16);
            p.y = e.y + (dy / d) * (e.radius + 16);
            p.kx += (dx / d) * 160;
            p.ky += (dy / d) * 160;
          }
          if (beh === 'leaper') {
            e.rangedCd -= dt;
            if (e.rangedCd <= 0 && d > 140) {
              e.rangedCd = 3.4;
              e.airT = LEAPER_AIR_DURATION; // ground effects miss during the authored arc
              e.airMaxT = LEAPER_AIR_DURATION;
              e.kx += (dx / d) * 470;
              e.ky += (dy / d) * 470;
              this.events.push({ type: 'dash' });
            }
          }
          if (beh === 'thumper') {
            e.rangedCd -= dt;
            if (e.rangedCd <= 0 && d < 280) {
            e.rangedCd = 3.2;
            e.telegraph = Math.max(e.telegraph, 0.85);
            e.attackAnimT = 0.85;
              this.telegraph(e.x, e.y, 210, 0.85, 'shock', e.damage, 0);
            }
          }
        } else if (beh === 'support') {
          e.x += ((dx / d) * (sp * 0.65 - press) + sx + hx) * dt;
          e.y += ((dy / d) * (sp * 0.65 - press) + sy + hy) * dt;
        } else if (beh === 'ranged' || beh === 'cone' || beh === 'summoner') {
          // keep distance and pester
          const want = beh === 'ranged' ? 240 : beh === 'cone' ? 250 : 300;
          const mv = d > want + 30 ? 1 : d < want - 40 ? -1 : 0;
          e.x += ((dx / d) * sp * mv + sx) * dt;
          e.y += ((dy / d) * sp * mv + sy) * dt;
          e.rangedCd -= dt;
          if (beh === 'ranged' && e.rangedCd <= 0 && d < 480) {
            e.rangedCd = 2.4;
            e.casting = 'bottle';
            e.windup = 0.42; // visible arm raise before the throw
          } else if (beh === 'cone' && e.rangedCd <= 0 && d < 430) {
            e.rangedCd = 3.4;
            e.telegraph = Math.max(e.telegraph, 0.6);
            e.attackAnimT = 0.6;
            this.telegraph(e.x, e.y, 400, 0.6, 'cone', e.damage, Math.atan2(dy, dx));
          } else if (beh === 'summoner' && e.rangedCd <= 0 && d < 520) {
            e.rangedCd = 6.5;
            e.telegraph = Math.max(e.telegraph, 0.9);
            e.attackAnimT = 0.9;
            this.telegraph(e.x, e.y, 120, 0.9, 'chant', 0, 0);
          }
        } else if (beh === 'flanker') {
          // circle the player at mid range, flashing on cooldown
          const want = 210;
          const tang = Math.atan2(dy, dx) + Math.PI / 2;
          const radial = d > want + 25 ? 1 : d < want - 35 ? -0.8 : 0;
          e.x += ((dx / d) * sp * radial + Math.cos(tang) * sp * 0.85 + sx) * dt;
          e.y += ((dy / d) * sp * radial + Math.sin(tang) * sp * 0.85 + sy) * dt;
          e.rangedCd -= dt;
          if (e.rangedCd <= 0 && d < 300) {
            e.rangedCd = 4.2;
            e.telegraph = Math.max(e.telegraph, 0.7);
            e.attackAnimT = 0.7;
            this.telegraph(e.x, e.y, 230, 0.7, 'flash', e.damage, 0);
          }
        } else if (beh === 'charger') {
          // Bulls stalk just outside melee range, then lock a readable charge.
          e.x += ((dx / d) * sp * 0.72 + sx + hx) * dt;
          e.y += ((dy / d) * sp * 0.72 + sy + hy) * dt;
          e.rangedCd -= dt;
          if (e.rangedCd <= 0 && d > 120 && d < 620) {
            e.rangedCd = 4.6;
            e.chargeDx = dx / d;
            e.chargeDy = dy / d;
            e.casting = 'charge';
            e.windup = BULL_CHARGE_WINDUP;
            e.telegraph = BULL_CHARGE_WINDUP;
          }
        } else if (beh === 'aerial') {
          // Aerial threats keep separate lanes: the Shock Drone presses close
          // with fast darts, while the heavier VAR Skycam owns the far lane
          // and commits to a slower three-shot scan fan.
          const varcam = e.def.id === 'varcam';
          const want = varcam ? 345 : 255;
          const tang = Math.atan2(dy, dx) + Math.PI / 2;
          const radial = d > want + 45 ? 1 : d < want - 55 ? -0.85 : 0;
          const orbitWeight = varcam ? 0.36 : 0.52;
          e.x += ((dx / d) * sp * radial + Math.cos(tang) * sp * orbitWeight + sx) * dt;
          e.y += ((dy / d) * sp * radial + Math.sin(tang) * sp * orbitWeight + sy) * dt;
          e.rangedCd -= dt;
          if (e.rangedCd <= 0 && d < (varcam ? 590 : 490)) {
            e.rangedCd = varcam ? 4.35 : 2.35;
            e.casting = varcam ? 'scan' : 'electric';
            e.windup = varcam ? 0.72 : 0.42;
            e.telegraph = e.windup;
          }
        }
        // every grounded enemy swings when the player is in reach
        if (!this.isAerialEnemy(e) && e.def.behavior !== 'aerial' && e.attackCd <= 0 && e.casting === '' && dist2(e.x, e.y, p.x, p.y) < (e.radius + 20) * (e.radius + 20)) {
          this.beginMelee(e, dx, dy, 0.34);
        }
      }
      // Boss specials, charges and ordinary locomotion all happen after the
      // knockback pass above. Re-assert the same radius-aware physical edge at
      // the end of the completed frame so no actor jitters through scenery.
      e.x = clamp(e.x, enemyInsetX, ARENA_W - enemyInsetX);
      e.y = clamp(e.y, enemyFarInsetY, ARENA_H - enemyNearInsetY);
      const movedX = e.x - stepX;
      const movedY = e.y - stepY;
      e.moving = movedX * movedX + movedY * movedY > 0.01;
      if (e.moving) {
        const movedLength = Math.hypot(movedX, movedY) || 1;
        e.moveDx = movedX / movedLength;
        e.moveDy = movedY / movedLength;
        const previousRunStep = e.runStep;
        e.runDistance += movedLength;
        const runFrames = e.boss ? 12 : 6;
        const halfCycleDistance = enemyRunCycleDistance(e, runFrames) / 2;
        e.runStep = Math.floor(e.runDistance / Math.max(1, halfCycleDistance));
        if (e.boss && e.runStep > previousRunStep) {
          this.events.push({ type: 'bossStep', boss: e.boss });
        } else if (!e.boss && e.def.id === 'mascot' && e.runStep > previousRunStep) {
          this.events.push({ type: 'heavyStep', id: 'mascot' });
        }
      }
    }
    if (this.radiusAwareSceneryEdges) {
      for (const e of this.enemies) {
        if (!e.active || !e.boss) continue;
        const bodyContact = hybridBossBodyContact(e.boss);
        const resolved = resolveHybridBossBodyContact(
          p.x,
          p.y,
          e.x,
          e.y,
          bodyContact,
          this.playerEdgeInsetX,
          this.playerEdgeInsetY,
          this.bossBodyContactScratch,
        );
        p.x = resolved.x;
        p.y = resolved.y;
      }
      // Body-blocking enemies can push the player after the normal movement
      // clamp. Hybrid scenery must remain solid after that interaction too.
      p.x = clamp(p.x, this.playerEdgeInsetX, ARENA_W - this.playerEdgeInsetX);
      p.y = clamp(p.y, this.playerEdgeInsetY, ARENA_H - this.playerEdgeInsetY);
    }

    /* balls (AERIAL lane: lobbed ballistics, damage only on landing) */
    for (const b of this.balls) {
      if (!b.active) continue;
      b.flightT += playerCombatDt;
      let locked: Enemy | undefined = b.targetIdx >= 0 ? this.enemies[b.targetIdx] : undefined;
      if (b.targetIdx >= 0 && !locked?.active) {
        const previousTarget = b.targetIdx;
        const nextTarget = this.pickAerialTarget(b.x, b.y);
        b.targetIdx = nextTarget;
        locked = nextTarget >= 0 ? this.enemies[nextTarget] : undefined;
        for (const rc of this.reticles) {
          if (!rc.active || rc.targetIdx !== previousTarget) continue;
          rc.targetIdx = nextTarget;
          if (nextTarget < 0) rc.active = false;
        }
      }
      if (locked?.active) {
        // True target lock: both the projected landing point and horizontal
        // velocity track the living enemy until touchdown.
        b.tx = locked.x;
        b.ty = locked.y;
        const remaining = Math.max(0.05, b.maxFlightT - b.flightT);
        b.vx = (b.tx - b.x) / remaining;
        b.vy = (b.ty - b.y) / remaining;
      }
      b.x += b.vx * playerCombatDt;
      b.y += b.vy * playerCombatDt;
      b.z += b.vz * playerCombatDt;
      b.vz -= LOB_GRAVITY * playerCombatDt;
      if (b.z > 0) continue; // still airborne: passes over ground-level mobs
      b.active = false;
      this.lobImpact(b);
    }

    /* AERIAL seekers: smooth steering, live retargeting and pooled trails. */
    for (const s of this.seekers) {
      if (!s.active) continue;
      s.life -= playerCombatDt;
      if (s.life <= 0) {
        s.active = false;
        continue;
      }
      let target = this.enemies[s.targetIdx];
      if (!target?.active) {
        s.targetIdx = -1;
        const next = this.pickAerialTarget(s.x, s.y);
        if (next < 0) {
          s.active = false;
          continue;
        }
        s.targetIdx = next;
        target = this.enemies[next];
      }
      const desired = Math.atan2(target.y - s.y, target.x - s.x);
      const current = Math.atan2(s.vy, s.vx);
      const delta = Math.atan2(Math.sin(desired - current), Math.cos(desired - current));
      const angle = current + clamp(delta, -s.turnRate * playerCombatDt, s.turnRate * playerCombatDt);
      s.vx = Math.cos(angle) * s.speed;
      s.vy = Math.sin(angle) * s.speed;
      s.angle = angle;
      s.lastX = s.x;
      s.lastY = s.y;
      s.x += s.vx * playerCombatDt;
      s.y += s.vy * playerCombatDt;
      s.trailClock -= playerCombatDt;
      if (s.trailClock <= 0) {
        s.trailClock += 0.065;
        s.trail2X = s.trail1X;
        s.trail2Y = s.trail1Y;
        s.trail1X = s.lastX;
        s.trail1Y = s.lastY;
      }
      const age = s.maxLife - s.life;
      s.z = (s.kind === 'curveball' ? 72 : 88) + Math.sin(age * 8 + s.phase) * (s.kind === 'curveball' ? 8 : 5);
      if (dist2(s.x, s.y, target.x, target.y) <= (target.radius + (s.kind === 'curveball' ? 22 : 28)) ** 2) {
        this.seekerImpact(s, s.targetIdx);
      }
    }

    /* pressure rings (GROUND lane: expanding damaging front) */
    for (const pr of this.pressures) {
      if (!pr.active) continue;
      pr.r += pr.maxR * 2.1 * playerCombatDt; // expand to maxR in ~0.48s at normal time
      const n = this.query(pr.x, pr.y, pr.r + 70, this.scratch);
      for (let i = 0; i < n; i++) {
        const idx = this.scratch[i];
        const e = this.enemies[idx];
        if (!e.active || this.isAerialEnemy(e) || pr.hitSet.includes(idx)) continue;
        if (dist2(pr.x, pr.y, e.x, e.y) > (pr.r + e.radius) * (pr.r + e.radius)) continue;
        pr.hitSet.push(idx);
        const d = Math.hypot(e.x - pr.x, e.y - pr.y) || 1;
        this.damageEnemy(idx, pr.dmg, ((e.x - pr.x) / d) * pr.knock, ((e.y - pr.y) / d) * pr.knock);
      }
      if (pr.r >= pr.maxR) pr.active = false;
    }

    /* bottles */
    const keeperRadius = keeperLvl > 0 ? [0, 82, 88, 94, 102, 110][keeperLvl] : 0;
    for (const b of this.bottles) {
      if (!b.active) continue;
      if (worldFrozen) continue;
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.kind === 'molotov') {
        b.z += b.vz * dt;
        b.vz -= LOB_GRAVITY * dt;
        if (b.z > 0 && b.life > 0) continue;
        b.z = 0;
        b.life = 0;
      }
      if (b.life <= 0 || (b.kind === 'molotov' && b.z <= 0 && b.vz <= 0)) {
        b.active = false;
        if (b.reticleIdx >= 0) this.reticles[b.reticleIdx].active = false;
        if (b.kind === 'scan') {
          this.events.push({ type: 'scanImpact', x: b.x, y: b.y });
        } else if (b.kind === 'electric') {
          this.burst(b.x, b.y, 5, '#70e7ff');
        } else if (b.kind === 'molotov') {
          this.igniteMolotov(b);
        } else {
          this.spawnImpact(b.x, b.y, b.vx, b.vy, false, 'landing', false);
          this.burst(b.x, b.y, 5, '#c9e6cf');
        }
        continue;
      }
      // guards body-block (friendly fire never triggers it)
      let blocked = false;
      if (this.abilityLevel('guard') >= 4) {
        for (const g of this.guards) {
          const interceptR = g.variant === 2 ? 36 : g.variant === 3 ? 24 : 28;
          if (dist2(b.x, b.y, g.x, g.y) < interceptR * interceptR) {
            blocked = true;
            g.blockT = 0.3;
            g.face = b.x > g.x ? 1 : -1;
            break;
          }
        }
      }
      if (blocked) {
        b.active = false;
        if (b.reticleIdx >= 0) this.reticles[b.reticleIdx].active = false;
        if (b.kind === 'scan') this.events.push({ type: 'scanImpact', x: b.x, y: b.y });
        else this.burst(b.x, b.y, b.kind === 'electric' ? 8 : 4, b.kind === 'electric' ? '#70e7ff' : '#a7e8bd');
        continue;
      }
      if (
        keeperLvl > 0
        && p.keeperBlockCd <= 0
        && dist2(b.x, b.y, p.x, p.y) < (keeperRadius + 26) * (keeperRadius + 26)
        && dist2(b.x, b.y, p.x, p.y) > Math.max(0, keeperRadius - 38) ** 2
      ) {
        b.active = false;
        if (b.reticleIdx >= 0) this.reticles[b.reticleIdx].active = false;
        p.keeperBlockCd = [0, 1.55, 1.2, 0.9, 0.62, 0.34][keeperLvl];
        let counter = false;
        if (keeperLvl >= 5) {
          let targetIdx = -1;
          let targetDist = 760 * 760;
          for (let index = 0; index < this.enemies.length; index++) {
            const enemy = this.enemies[index];
            if (!enemy.active || !this.isAerialEnemy(enemy)) continue;
            const distance = dist2(p.x, p.y, enemy.x, enemy.y);
            if (distance >= targetDist) continue;
            targetDist = distance;
            targetIdx = index;
          }
          if (targetIdx >= 0) {
            const target = this.enemies[targetIdx];
            const dx = target.x - p.x;
            const dy = target.y - p.y;
            const distance = Math.hypot(dx, dy) || 1;
            this.damageEnemy(targetIdx, 24 * this.damageMult, (dx / distance) * 90, (dy / distance) * 90);
            counter = true;
          }
        }
        this.events.push({ type: 'keeperBlock', x: b.x, y: b.y, counter });
        continue;
      }
      if (dist2(b.x, b.y, p.x, p.y) < 20 * 20) {
        b.active = false;
        if (b.reticleIdx >= 0) this.reticles[b.reticleIdx].active = false;
        if (b.kind === 'molotov') {
          this.igniteMolotov(b);
        } else if (b.kind === 'scan') {
          this.hurtPlayer(b.dmg, 0, 0, 0.6);
          this.events.push({ type: 'scanImpact', x: p.x, y: p.y });
        } else if (b.kind === 'electric') {
          this.hurtPlayer(b.dmg, 0, 0, 0.48);
          this.spawnImpact(p.x, p.y, b.vx, b.vy, false, 'airburst', false);
          this.burst(p.x, p.y, 8, '#70e7ff');
        } else {
          this.hurtPlayer(b.dmg);
          this.spawnImpact(p.x, p.y, b.vx, b.vy, false, 'landing', false);
          this.burst(p.x, p.y, 5, '#c9e6cf');
        }
      }
    }

    /* fire zones */
    for (const z of this.fireZones) {
      if (!z.active) continue;
      if (worldFrozen) continue;
      z.life -= dt;
      if (z.life <= 0) {
        z.active = false;
        continue;
      }
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.5;
        if (dist2(p.x, p.y, z.x, z.y) < (z.r + 16) * (z.r + 16)) {
          this.hurtPlayer(z.dps * 0.5);
        }
      }
    }

    /* guards */
    const guardLvl = this.abilityLevel('guard');
    if (guardLvl > 0) {
      const dmg = [0, 12, 18, 18, 18, 30][guardLvl] * this.guardDmgMult * this.damageMult;
      const swingCd = guardLvl >= 5 ? 0.55 : 0.8;
      const knock = guardLvl >= 4 ? 260 : 90;
      const guardRange2 = 360 * 360;
      // Guards may read a distant grounded crowd before it enters punch range.
      // This is anticipation only: it biases the close patrol sector toward
      // the threat and never sends the guard outside the protection zone.
      let threatVectorX = 0;
      let threatVectorY = 0;
      let threatWeight = 0;
      for (const enemy of this.enemies) {
        if (!enemy.active || this.isAerialEnemy(enemy)) continue;
        const dx = enemy.x - p.x;
        const dy = enemy.y - p.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 1 || distance > 860) continue;
        const importance = enemy.boss ? 2.6 : enemy.elite ? 1.55 : 1;
        const weight = importance * clamp(1.18 - distance / 1_050, 0.24, 1.05);
        threatVectorX += (dx / distance) * weight;
        threatVectorY += (dy / distance) * weight;
        threatWeight += weight;
      }
      const threatCoherence = threatWeight > 0
        ? Math.hypot(threatVectorX, threatVectorY) / threatWeight
        : 0;
      const threatPatrolAngle = threatCoherence >= 0.18
        ? Math.atan2(threatVectorY, threatVectorX)
        : null;
      const validGroundTarget = (targetIdx: number): boolean => {
        const enemy = this.enemies[targetIdx];
        return !!enemy?.active
          && !this.isAerialEnemy(enemy)
          && dist2(p.x, p.y, enemy.x, enemy.y) <= guardRange2;
      };

      // Preserve valid assignments first, then distribute unassigned guards
      // across different grounded threats. This prevents a pair of guards
      // from stacking on one enemy while another approaches from the opposite
      // side, and it excludes drones/temporarily airborne mobs at acquisition.
      const claimedGroundTargets = new Set<number>();
      for (const guard of this.guards) {
        const outsideEscortLeash = dist2(guard.x, guard.y, p.x, p.y) > 320 * 320;
        if (!outsideEscortLeash && validGroundTarget(guard.target) && !claimedGroundTargets.has(guard.target)) {
          claimedGroundTargets.add(guard.target);
        } else {
          guard.target = -1;
        }
      }
      for (const guard of this.guards) {
        if (guard.target >= 0) continue;
        // A guard who has chased too far must recover its protection zone
        // before accepting another target. This prevents off-screen wandering.
        if (dist2(guard.x, guard.y, p.x, p.y) > 290 * 290) continue;
        let best = -1;
        let bestDistance = Infinity;
        for (let enemyIdx = 0; enemyIdx < this.enemies.length; enemyIdx++) {
          if (claimedGroundTargets.has(enemyIdx) || !validGroundTarget(enemyIdx)) continue;
          const enemy = this.enemies[enemyIdx];
          const distance = dist2(guard.x, guard.y, enemy.x, enemy.y);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = enemyIdx;
          }
        }
        // When there are fewer grounded threats than guards, sharing the only
        // legal target is better than leaving protection idle. Air targets are
        // still never eligible in this fallback.
        if (best < 0) {
          for (let enemyIdx = 0; enemyIdx < this.enemies.length; enemyIdx++) {
            if (!validGroundTarget(enemyIdx)) continue;
            const enemy = this.enemies[enemyIdx];
            const distance = dist2(guard.x, guard.y, enemy.x, enemy.y);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = enemyIdx;
            }
          }
        }
        guard.target = best;
        if (best >= 0) claimedGroundTargets.add(best);
      }

      this.guards.forEach((g, gi) => {
        const variantDmg = g.variant === 0 ? 0.9 : g.variant === 2 ? 1.42 : g.variant === 3 ? 0.78 : 1;
        const variantCd = g.variant === 0 ? 0.82 : g.variant === 2 ? 1.16 : g.variant === 3 ? 0.68 : 1;
        const variantKnock = g.variant === 0 ? 0.82 : g.variant === 2 ? 1.35 : g.variant === 3 ? 0.72 : 1;
        const chaseSpeed = g.variant === 0 ? 330 : g.variant === 2 ? 245 : g.variant === 3 ? 360 : 300;
        const stepX = g.x;
        const stepY = g.y;
        g.swingCd = Math.max(0, g.swingCd - playerCombatDt);
        const previousStrikeT = g.strikeT;
        g.strikeT = Math.max(0, g.strikeT - playerCombatDt);
        g.blockT = Math.max(0, g.blockT - playerCombatDt);
        g.animT += playerCombatDt;
        g.decisionT -= playerCombatDt;
        const escortDx = p.x - g.escortX;
        const escortDy = p.y - g.escortY;
        const escortDistance = Math.hypot(escortDx, escortDy);
        // Normal escorting deliberately trails the player by roughly a second.
        // Only a genuine separation triggers a faster catch-up. Turning or
        // tapping a key therefore cannot rotate or translate the guard at once.
        const escortFollowRate = escortDistance > 300 ? 3.6 : escortDistance > 190 ? 2.1 : 0.95;
        const escortFollow = 1 - Math.exp(-escortFollowRate * playerCombatDt);
        g.escortX += escortDx * escortFollow;
        g.escortY += escortDy * escortFollow;
        const strikeContactT = g.variant === 2 ? 0.14 : 0.12;
        if (previousStrikeT > strikeContactT && g.strikeT <= strikeContactT && !g.strikeHit) {
          g.strikeHit = true;
          const strikeIdx = g.strikeTarget;
          const strikeEnemy = this.enemies[strikeIdx];
          if (strikeEnemy?.active && !this.isAerialEnemy(strikeEnemy)) {
            const contactDistance = Math.hypot(strikeEnemy.x - g.x, strikeEnemy.y - g.y);
            if (contactDistance < strikeEnemy.radius + 50) {
              const directionLength = contactDistance || 1;
              this.damageEnemy(
                strikeIdx,
                dmg * variantDmg,
                ((strikeEnemy.x - g.x) / directionLength) * knock * variantKnock,
                ((strikeEnemy.y - g.y) / directionLength) * knock * variantKnock,
              );
              if (guardLvl >= 5) {
                // Lockdown: the max-level contact frame cleaves the grounded
                // pack and briefly interrupts follow-up hits.
                for (let ci = 0; ci < this.enemies.length; ci++) {
                  const cleave = this.enemies[ci];
                  if (ci === strikeIdx || !cleave.active || this.isAerialEnemy(cleave)) continue;
                  if (dist2(strikeEnemy.x, strikeEnemy.y, cleave.x, cleave.y) > (82 + cleave.radius) ** 2) continue;
                  const cd = Math.hypot(cleave.x - g.x, cleave.y - g.y) || 1;
                  this.damageEnemy(ci, dmg * 0.42, ((cleave.x - g.x) / cd) * 180, ((cleave.y - g.y) / cd) * 180, { stun: 0.2 });
                }
                this.ring(strikeEnemy.x, strikeEnemy.y, 82, '#7ce7ff');
              }
              this.events.push({ type: 'punch' });
            }
          }
        }
        const ti = g.target;
        if (ti < 0 && g.decisionT <= 0) {
          // Each guard makes a small independent patrol decision. The sector
          // remains personal, but the exact angle/radius and timing vary so a
          // squad breathes like people instead of tracing one rigid formation.
          const sectorHalf = Math.min(0.66, Math.PI / Math.max(3, this.guards.length + 1));
          g.patrolDirection = g.patrolDirection === 1 ? -1 : 1;
          const sweep = 0.58 + g.variant * 0.07;
          if (threatPatrolAngle !== null) {
            // Spread a squad across a narrow forward screen while a single
            // guard owns the exact crowd bearing. Position changes remain
            // inertial and decision-timed, independent from player input.
            const lineupOffset = this.guards.length <= 1
              ? 0
              : (gi - (this.guards.length - 1) / 2) * Math.min(0.32, 0.7 / (this.guards.length - 1));
            g.patrolAngle = threatPatrolAngle + lineupOffset;
          } else {
            g.patrolAngle = g.patrolHomeAngle + g.patrolDirection * sectorHalf * sweep;
          }
          g.patrolRadius = gi === 0 ? this.rng.range(82, 94)
            : gi === 1 ? this.rng.range(96, 112)
            : gi === 2 ? this.rng.range(122, 136)
            : this.rng.range(138, 150);
          g.decisionT = this.rng.range(0.85, 1.25) + this.rng.range(3 / 60, 12 / 60);
        }
        let tx = g.escortX + Math.cos(g.patrolAngle) * g.patrolRadius;
        let ty = g.escortY + Math.sin(g.patrolAngle) * g.patrolRadius;
        if (ti >= 0) {
          const e = this.enemies[ti];
          // Approach a grounded target from a readable side contact point.
          // The side-authored sprint and punch now point along the same route
          // instead of sliding vertically through the enemy's centre.
          const targetSide: -1 | 1 = Math.abs(e.x - g.x) > 8
            ? (e.x > g.x ? 1 : -1)
            : g.patrolDirection;
          tx = e.x - targetSide * (e.radius + 18);
          ty = e.y;
          const dd = Math.hypot(e.x - g.x, e.y - g.y);
          if (!this.isAerialEnemy(e) && dd < e.radius + 24 && g.swingCd <= 0 && g.strikeT <= 0) {
            g.swingCd = swingCd * variantCd;
            g.strikeT = 0.24;
            g.strikeTarget = ti;
            g.strikeHit = false;
            g.face = e.x > g.x ? 1 : -1;
          }
        }
        g.tx = tx;
        g.ty = ty;
        const dx = tx - g.x;
        const dy = ty - g.y;
        const d = Math.hypot(dx, dy);
        const distanceToPlayer = Math.hypot(g.x - p.x, g.y - p.y);
        // Separation affects velocity rather than teleporting positions. This
        // yields independent curved paths while keeping all guards readable.
        let repelX = 0;
        let repelY = 0;
        for (let otherIndex = 0; otherIndex < this.guards.length; otherIndex++) {
          if (otherIndex === gi) continue;
          const other = this.guards[otherIndex];
          const ox = g.x - other.x;
          const oy = g.y - other.y;
          const od = Math.hypot(ox, oy);
          if (od > 0.001 && od < 125) {
            const overlapBoost = od < 38 ? 360 + (38 - od) * 12 : 0;
            const strength = overlapBoost + (1 - od / 125) * 420;
            repelX += (ox / od) * strength;
            repelY += (oy / od) * strength;
          }
        }
        if (d > 6 && g.strikeT <= 0) {
          const returnUrgency = distanceToPlayer > 290 ? 1.22 : 1;
          const sp = Math.min(chaseSpeed * returnUrgency, d * (ti >= 0 ? 5.4 : 3.2));
          const authoredRun = guardAuthoredRunVector(dx, dy, g.patrolDirection, d > 84);
          let desiredVx = authoredRun.x * sp + repelX;
          let desiredVy = authoredRun.y * sp + repelY;
          const desiredSpeed = Math.hypot(desiredVx, desiredVy);
          const speedCap = chaseSpeed * returnUrgency;
          if (desiredSpeed > speedCap) {
            desiredVx = (desiredVx / desiredSpeed) * speedCap;
            desiredVy = (desiredVy / desiredSpeed) * speedCap;
          }
          const steered = approachVelocity(g.vx, g.vy, desiredVx, desiredVy, chaseSpeed * 6.5 * playerCombatDt);
          g.vx = steered.vx;
          g.vy = steered.vy;
          g.x += g.vx * playerCombatDt;
          g.y += g.vy * playerCombatDt;
          g.face = guardRunPresentation(g.vx, g.vy, g.face).face;
        } else {
          const brakeRate = g.variant === 0 ? chaseSpeed / 0.08 : chaseSpeed * 9;
          const braked = approachVelocity(g.vx, g.vy, 0, 0, brakeRate * playerCombatDt);
          g.vx = braked.vx;
          g.vy = braked.vy;
        }
        g.x = clamp(g.x, 36, ARENA_W - 36);
        g.y = clamp(g.y, 36, ARENA_H - 36);
        g.moving = dist2(g.x, g.y, stepX, stepY) > 0.01;
        if (g.moving) g.runDistance += Math.hypot(g.x - stepX, g.y - stepY);
      });
    }

    /* boss telegraphs & zones */
    for (const t of this.telegraphs) {
      if (!t.active) continue;
      if (worldFrozen) continue;
      if (!this.debugTelegraphHold) t.t -= dt;
      if (t.t <= 0) {
        t.active = false;
        const p = this.player;
        if (t.kind === 'flare') {
          this.flareZones.push({ x: t.x, y: t.y, r: t.r, t: 2.6, tick: 0 });
          this.burst(t.x, t.y, 14, '#ff9a3d');
          this.events.push({ type: 'flare' });
        } else if (t.kind === 'shock') {
          // drum thump / whistle blast: ground shockwave around the point
          this.ring(t.x, t.y, t.r, '#e8283f');
          this.burst(t.x, t.y, 10, '#e8283f');
          this.events.push({ type: 'whistle', x: t.x, y: t.y });
          const dd = dist2(p.x, p.y, t.x, t.y);
          if (dd < t.r * t.r) {
            const d = Math.sqrt(dd) || 1;
            this.hurtPlayer(t.dmg, ((p.x - t.x) / d) * 190, ((p.y - t.y) / d) * 190);
          }
        } else if (t.kind === 'cone') {
          // vuvuzela blast: a hard shove down the cone axis if the player is inside it
          this.events.push({ type: 'vuvuzela', x: t.x, y: t.y });
          for (let k = 0; k < 8; k++) {
            const pt = this.alloc(this.particles);
            if (!pt) break;
            pt.active = true;
            pt.x = t.x + Math.cos(t.dir) * (30 + k * 42);
            pt.y = t.y + Math.sin(t.dir) * (30 + k * 42);
            const sp = this.rng.range(60, 150);
            pt.vx = Math.cos(t.dir) * sp;
            pt.vy = Math.sin(t.dir) * sp;
            pt.life = pt.maxLife = 0.4;
            pt.size = 4;
            pt.color = '#ffd23f';
            pt.grav = 0;
          }
          const ddx = p.x - t.x;
          const ddy = p.y - t.y;
          const dd = Math.hypot(ddx, ddy);
          if (dd < t.r) {
            const ang = Math.atan2(ddy, ddx);
            let diff = Math.abs(ang - t.dir) % TAU;
            if (diff > Math.PI) diff = TAU - diff;
            if (diff < 0.55) this.hurtPlayer(t.dmg, Math.cos(t.dir) * 340, Math.sin(t.dir) * 340);
          }
        } else if (t.kind === 'card') {
          // Crooked Official verdict: a readable 60 degree red-card sector,
          // resolved only after the full 300ms anticipation.
          this.events.push({ type: 'flash', x: t.x, y: t.y });
          const ddx = p.x - t.x;
          const ddy = p.y - t.y;
          const distance = Math.hypot(ddx, ddy);
          if (distance < t.r) {
            const angle = Math.atan2(ddy, ddx);
            const delta = Math.abs(Math.atan2(Math.sin(angle - t.dir), Math.cos(angle - t.dir)));
            if (delta < Math.PI / 6) this.hurtPlayer(t.dmg, Math.cos(t.dir) * 190, Math.sin(t.dir) * 190, 0.72);
          }
        } else if (t.kind === 'flash') {
          // paparazzo flash: blinding burst slows the player briefly
          this.burst(t.x, t.y, 16, '#f5f7fa');
          this.events.push({ type: 'flash', x: t.x, y: t.y });
          if (dist2(p.x, p.y, t.x, t.y) < t.r * t.r) this.hurtPlayer(t.dmg, 0, 0, 1.2);
        } else if (t.kind === 'chant') {
          // Chant Leader rallies fresh invaders onto the pitch
          this.ring(t.x, t.y, t.r + 60, '#37d67a');
          this.events.push({ type: 'chant', x: t.x, y: t.y });
          for (let k = 0; k < 2; k++) {
            const activeOrdinary = this.enemies.reduce(
              (total, enemy) => total + (enemy.active && !enemy.boss ? 1 : 0),
              0,
            );
            if (directorPopulationIngressMultiplier(activeOrdinary, this.time) <= 0) break;
            const a = this.rng.range(0, TAU);
            this.spawnEnemy(
              ENEMIES.invader,
              clamp(t.x + Math.cos(a) * 90, 40, ARENA_W - 40),
              clamp(t.y + Math.sin(a) * 90, 40, ARENA_H - 40),
              false,
            );
          }
        } else if (t.kind === 'summon') {
          this.summonBossAdd(t.summon, t.summonIndex, t.x, t.y);
        }
      }
    }
    for (let i = this.flareZones.length - 1; i >= 0; i--) {
      const z = this.flareZones[i];
      if (worldFrozen) continue;
      z.t -= dt;
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.4;
        if (dist2(p.x, p.y, z.x, z.y) < z.r * z.r) this.hurtPlayer(8);
      }
      if (z.t <= 0) this.flareZones.splice(i, 1);
    }
    for (let i = this.slowZones.length - 1; i >= 0; i--) {
      if (worldFrozen) continue;
      this.slowZones[i].t -= dt;
      if (this.slowZones[i].t <= 0) this.slowZones.splice(i, 1);
    }

    /* pickups */
    const pr = this.pickupRadius;
    const activeMagnetRadius = this.activeMagnetRadius;
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      pk.t += dt;
      pk.x += pk.vx * dt;
      pk.y += pk.vy * dt;
      pk.vx *= Math.pow(0.01, dt);
      pk.vy *= Math.pow(0.01, dt);
      const d2 = dist2(pk.x, pk.y, p.x, p.y);
      const anchoredSpecial = this.isAnchoredSpecialPickup(pk.kind);
      const anchoredPullRadius = Math.min(68, pr * 0.55);
      if (
        this.magnetT > 0
        && this.isActiveMagnetCollectible(pk.kind)
        && d2 < activeMagnetRadius * activeMagnetRadius
      ) {
        const d = Math.sqrt(d2) || 1;
        const pull = 1650 + Math.min(650, d * 0.7);
        pk.vx += ((p.x - pk.x) / d) * pull * dt * 4;
        pk.vy += ((p.y - pk.y) / d) * pull * dt * 4;
      } else if (anchoredSpecial && d2 < anchoredPullRadius * anchoredPullRadius) {
        const d = Math.sqrt(d2) || 1;
        const pull = 84; // exactly 20% of the former 420 pickup pull
        pk.vx += ((p.x - pk.x) / d) * pull * dt * 4;
        pk.vy += ((p.y - pk.y) / d) * pull * dt * 4;
      } else if (pk.kind === 'heal') {
        // The sports drink is a deliberate ground decision: it pulls only
        // within a much smaller radius and with far less force, so the
        // player must come much closer to collect it.
        const healRadius = Math.min(52, pr * 0.4);
        if (d2 < healRadius * healRadius) {
          const d = Math.sqrt(d2) || 1;
          const pull = 110;
          pk.vx += ((p.x - pk.x) / d) * pull * dt * 4;
          pk.vy += ((p.y - pk.y) / d) * pull * dt * 4;
        }
      } else if (!anchoredSpecial && d2 < pr * pr) {
        const d = Math.sqrt(d2) || 1;
        const pull = pk.kind === 'coin' || pk.kind === 'trophy' ? 500 : 420;
        pk.vx += ((p.x - pk.x) / d) * pull * dt * 4;
        pk.vy += ((p.y - pk.y) / d) * pull * dt * 4;
      } else if (!anchoredSpecial && this.isRescuePickup(pk.kind) && pk.t > 0.8) {
        // Rare rescue tools remain physical pickups, but slowly seek the
        // player after settling so a dense horde cannot bury them forever.
        const d = Math.sqrt(d2) || 1;
        const pull = 170 + Math.min(190, d * 0.14);
        pk.vx += ((p.x - pk.x) / d) * pull * dt;
        pk.vy += ((p.y - pk.y) / d) * pull * dt;
      } else if (pk.kind === 'xp' && pk.t > 0.6) {
        // long-range drift: settled XP slowly migrates to the player so
        // long-range kills never strand progression off-screen
        const d = Math.sqrt(d2) || 1;
        pk.vx += ((p.x - pk.x) / d) * 26 * dt;
        pk.vy += ((p.y - pk.y) / d) * 26 * dt;
      }
      const collectRadius = this.isRescuePickup(pk.kind) ? 32 : 26;
      if (d2 < collectRadius * collectRadius) {
        pk.active = false;
        if (pk.kind === 'xp') {
          this.gainXp(pk.value);
          this.events.push({ type: 'xp' });
        } else if (pk.kind === 'heal') {
          p.hp = Math.min(p.maxHp, p.hp + pk.value);
          p.healT = HEAL_FX_DURATION;
          this.events.push({ type: 'heal' });
          this.burst(p.x, p.y, 4, '#8fbf9a');
        } else if (pk.kind === 'trophy') {
          this.coins += pk.value * rewardCoinMul(this.rewardBuff);
          this.pendingBossAbilities += 2;
          this.events.push({ type: 'trophy', coins: pk.value, tier: pk.tier, abilityPicks: 2 });
          this.confetti(p.x, p.y, 28 + pk.tier * 8);
        } else if (pk.kind === 'coin') {
          this.coins += pk.value * rewardCoinMul(this.rewardBuff);
          this.events.push({ type: 'coin' });
        } else if (pk.kind === 'magnet') {
          this.activateMagnet();
        } else if (pk.kind === 'bomb') {
          this.activateBomb();
        } else if (pk.kind === 'freeze') {
          this.activateFreeze();
        }
      }
    }

    this.updateFx(dt);

    /* victory */
    this.suddenDeath = this.time >= RUN_LENGTH && !this.bossFinaleResolved;
    if (
      this.time >= RUN_LENGTH
      && this.bossFinaleResolved
      && this.pendingBossAbilities === 0
      && this.over === 'playing'
    ) {
      this.over = 'won';
      this.suddenDeath = false;
      this.confetti(p.x, p.y, 80);
      this.events.push({ type: 'victory' });
    }
  }

  /** Shared boss melee: wind-up swing when the player is in reach. */
  private bossMelee(e: Enemy, nx: number, ny: number, d: number, dt: number): void {
    const major = !!e.boss && BOSSES[e.boss].tier === 'major';
    const physicalReach = this.radiusAwareSceneryEdges
      ? Math.max(e.radius, hybridBossBodyContact(e.boss))
      : e.radius;
    if (e.windup > 0) {
      e.windup -= dt;
      if (e.windup <= 0) {
        e.lungeT = BOSS_MELEE_LUNGE_DURATION;
        e.attackAnimT = BOSS_MELEE_LUNGE_DURATION + MELEE_RECOVERY_DURATION;
        e.attackCd = major ? 0.78 : 1.05;
      }
    } else if (e.lungeT > 0) {
      this.advanceMeleeLunge(
        e,
        dt,
        BOSS_MELEE_LUNGE_DURATION,
        major ? 3.35 : 2.8,
        physicalReach + 34,
        major ? 360 : 260,
      );
    } else if (e.attackAnimT <= 0 && e.attackCd <= 0 && d < physicalReach + 26) {
      this.beginMelee(e, nx, ny, major ? 0.32 : 0.42);
    }
  }

  private bossCooldown(base: number): number {
    return base / (1 + difficultyProgress(this.time) * 0.18 + this.threatPressure * 0.22);
  }

  private updateOfficial(e: Enemy, nx: number, ny: number, dt: number): void {
    if (e.windup <= 0 && e.lungeT <= 0 && e.attackAnimT <= 0) {
      e.x += nx * e.speed * dt;
      e.y += ny * e.speed * dt;
    }
    this.bossMelee(e, nx, ny, Math.hypot(this.player.x - e.x, this.player.y - e.y) || 1, dt);
    e.bossCd -= dt;
    e.bossCd2 -= dt;
    e.rangedCd -= dt;
    if (e.bossCd <= 0) {
      e.bossCd = this.bossCooldown(5);
      // whistle shockwave, telegraphed around the official
      e.telegraph = Math.max(e.telegraph, 0.8);
      this.telegraph(e.x, e.y, 255, 0.8, 'shock', 22, 0);
    }
    if (e.bossCd2 <= 0) {
      e.bossCd2 = this.bossCooldown(7.5);
      // Book the crowd: the seal gives the player 0.9s before the formation
      // and its charger materialize around the official.
      e.telegraph = Math.max(e.telegraph, 0.9);
      this.queueBossSummons(2, e.x, e.y, 0.9);
    }
    if (e.rangedCd <= 0) {
      e.rangedCd = this.bossCooldown(9);
      // Red card: a committed, avoidable 60 degree sector instead of an
      // invisible range check or a circle materializing below the player.
      const verdictDir = Math.atan2(this.player.y - e.y, this.player.x - e.x);
      e.telegraph = Math.max(e.telegraph, 0.3);
      this.telegraph(e.x, e.y, 285, 0.3, 'card', 10, verdictDir);
    }
  }

  private updateCaptain(e: Enemy, nx: number, ny: number, dt: number): void {
    e.bossCd -= dt;
    e.bossCd2 -= dt;
    e.rangedCd -= dt;

    if (e.chargeWindupT > 0) {
      e.chargeWindupT = Math.max(0, e.chargeWindupT - dt);
      e.telegraph = Math.max(e.telegraph, e.chargeWindupT);
      if (e.chargeWindupT <= 0) {
        e.casting = 'captain-charge';
        e.chargeLaneFadeT = 0.1;
        e.lungeT = 0.42;
        e.attackAnimT = 0.62;
        e.chargeHit = false;
        this.events.push({ type: 'bullCharge', x: e.x, y: e.y });
      }
      return;
    }

    if (e.casting === 'captain-charge') {
      if (e.lungeT > 0) {
        const activeDt = Math.min(dt, e.lungeT);
        e.x += e.chargeDx * 700 * activeDt;
        e.y += e.chargeDy * 700 * activeDt;
        e.lungeT = Math.max(0, e.lungeT - dt);
        if (!e.chargeHit && dist2(e.x, e.y, this.player.x, this.player.y) < (e.radius + 34) ** 2) {
          e.chargeHit = true;
          this.hurtPlayer(Math.min(CAPTAIN_CHARGE_MAX, e.damage * 1.15), e.chargeDx * 520, e.chargeDy * 520, 0.34);
          this.spawnImpact(this.player.x, this.player.y, e.chargeDx, e.chargeDy, false, 'contact', true, 1.35);
        }
        if (e.lungeT <= 0) {
          e.chargeBrakeT = 0.2;
          this.burst(e.x, e.y, 14, '#94bd62');
        }
      } else if (e.chargeBrakeT > 0) {
        const activeDt = Math.min(dt, e.chargeBrakeT);
        const brake = clamp(e.chargeBrakeT / 0.2, 0, 1);
        // Integral of 1200 * (remaining / .2)^2 over .2s is 80 world units.
        e.x += e.chargeDx * 1200 * brake * brake * activeDt;
        e.y += e.chargeDy * 1200 * brake * brake * activeDt;
        e.chargeBrakeT = Math.max(0, e.chargeBrakeT - dt);
        if (e.chargeBrakeT <= 0) {
          e.casting = '';
          e.attackAnimT = 0;
          this.burst(e.x, e.y, 10, '#6f964d');
        }
      } else {
        e.casting = '';
      }
      return;
    }

    if (e.windup <= 0 && e.lungeT <= 0 && e.attackAnimT <= 0) {
      e.x += nx * e.speed * dt;
      e.y += ny * e.speed * dt;
    }
    this.bossMelee(e, nx, ny, Math.hypot(this.player.x - e.x, this.player.y - e.y) || 1, dt);
    if (e.bossCd <= 0) {
      e.bossCd = this.bossCooldown(4.4);
      // Final-boss crossfire: five readable landings plus an aerial escort.
      e.telegraph = Math.max(e.telegraph, 0.95);
      const p = this.player;
      for (let i = 0; i < 5; i++) {
        const tx = clamp(p.x + this.rng.range(-190, 190), 60, ARENA_W - 60);
        const ty = clamp(p.y + this.rng.range(-190, 190), 60, ARENA_H - 60);
        this.telegraph(tx, ty, 96, 0.95 + i * 0.18, 'flare');
      }
    }
    if (
      e.bossCd2 <= 0
      && e.windup <= 0
      && e.lungeT <= 0
      && e.attackAnimT <= 0
      && e.casting === ''
    ) {
      e.bossCd2 = this.bossCooldown(6.8);
      // Final captain charge: locked 500ms lane, committed travel and a
      // visible 200ms turf brake. The player can sidestep after reading it.
      e.chargeDx = nx;
      e.chargeDy = ny;
      e.chargeWindupT = 0.5;
      e.telegraph = Math.max(e.telegraph, 0.5);
    }
    if (e.rangedCd <= 0) {
      e.rangedCd = this.bossCooldown(8.6);
      e.telegraph = Math.max(e.telegraph, 0.82);
      this.queueBossSummons(3, e.x, e.y, 0.82);
    }
  }

  private updateDrumboss(e: Enemy, nx: number, ny: number, dt: number): void {
    if (e.windup <= 0 && e.lungeT <= 0 && e.attackAnimT <= 0) {
      e.x += nx * e.speed * dt;
      e.y += ny * e.speed * dt;
    }
    this.bossMelee(e, nx, ny, Math.hypot(this.player.x - e.x, this.player.y - e.y) || 1, dt);
    e.bossCd -= dt;
    e.bossCd2 -= dt;
    e.rangedCd -= dt;
    if (e.bossCd <= 0) {
      e.bossCd = this.bossCooldown(3.4);
      // drum shockwave, telegraphed around the drummer
      e.telegraph = Math.max(e.telegraph, 1.0);
      this.telegraph(e.x, e.y, 225, 1.0, 'shock', 16, 0);
    }
    if (e.bossCd2 <= 0) {
      e.bossCd2 = this.bossCooldown(8.5);
      e.telegraph = Math.max(e.telegraph, 0.82);
      this.queueBossSummons(1, e.x, e.y, 0.82);
    }
    if (e.rangedCd <= 0) {
      e.rangedCd = this.bossCooldown(11);
      // beat surge: every nearby fan charges faster for 2s
      for (const o of this.enemies) {
        if (o.active && !o.boss && dist2(e.x, e.y, o.x, o.y) < 520 * 520) o.boostT = 2;
      }
      this.ring(e.x, e.y, 520, '#ff9a3d');
      this.events.push({ type: 'chant', x: e.x, y: e.y });
    }
  }

  private updateFx(dt: number): void {
    for (const pt of this.particles) {
      if (!pt.active) continue;
      pt.life -= dt;
      if (pt.life <= 0) {
        pt.active = false;
        continue;
      }
      pt.vy += pt.grav * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
    }
    for (const impact of this.impacts) {
      if (!impact.active) continue;
      impact.life -= dt;
      if (impact.life <= 0) impact.active = false;
    }
    for (const d of this.dmgNums) {
      if (!d.active) continue;
      d.life -= dt;
      d.y -= 46 * dt;
      if (d.life <= 0) d.active = false;
    }
    for (const r of this.rings) {
      if (!r.active) continue;
      r.life -= dt;
      r.r += (r.maxR - r.r) * dt * 10;
      if (r.life <= 0) r.active = false;
    }
    for (const rc of this.reticles) {
      if (!rc.active) continue;
      const target = this.enemies[rc.targetIdx];
      if (rc.targetIdx >= 0 && target?.active) {
        rc.x = target.x;
        rc.y = target.y;
      }
      rc.t -= dt;
      if (rc.t <= 0) rc.active = false;
    }
    for (const c of this.corpses) {
      if (!c.active) continue;
      c.t += dt;
      if (c.t >= c.max) c.active = false;
    }
  }

  /** Result summary for the end-of-run screen. */
  result(won: boolean): { time: number; kills: number; level: number; coins: number; bonus: number } {
    const bonus = Math.round((this.kills * 0.15 + (this.time / 60) * 6 + (won ? 100 : 0)) * rewardScoreMul(this.rewardBuff));
    return { time: this.time, kills: this.kills, level: this.player.level, coins: this.coins, bonus };
  }

  /** Debug/testing: force-spawn a specific enemy type at a position. */
  debugSpawn(id: keyof typeof ENEMIES, x: number, y: number, elite = false): void {
    this.spawnEnemy(ENEMIES[id], x, y, elite);
  }

  /** Debug/testing: stage a real boss without skipping the simulation clock. */
  debugSpawnBoss(id: BossId): boolean {
    return this.spawnBoss(id);
  }

  /** Debug/testing: keep staged guards animated without deleting the lineup. */
  debugSetGuardDamageMultiplier(value: number): void {
    this.guardDmgMult = Math.max(0, value);
  }

  /** Debug/testing: grant XP through the real level-up path. */
  debugGiveXp(n: number): void {
    this.gainXp(n);
  }

  /** Spend one of the two run-wide draft rerolls. UI state never owns this
   * counter, so opening another level-up or boss-loot screen cannot refill it. */
  consumeReroll(): boolean {
    if (this.rerollsRemaining <= 0) return false;
    this.rerollsRemaining--;
    return true;
  }

  /** Deterministic browser/e2e damage hook that still exercises real feedback. */
  debugHurt(n: number): void {
    this.player.iframes = 0;
    this.hurtPlayer(n, 180, 0);
  }

  /** Debug/testing: stage any real pickup without bypassing collection logic. */
  debugDropPickup(kind: Pickup['kind'], x: number, y: number): void {
    this.spawnPickup(kind, x, y, 1, 1, 0);
  }
}
