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
  ENEMIES,
  RUN_LENGTH,
  STATS,
  hpScale,
  spawnBatch,
  spawnInterval,
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
export const KICK_DURATION = 0.36;
export const KICK_CONTACT_DELAY = KICK_DURATION / 2;
const MAX_ENEMIES = 240;
const CELL = 72;
const LOB_GRAVITY = 1500; // aerial lob downward acceleration (world units/s²)

/* ------------------------------------------------------------------ */
/* Entity types                                                        */
/* ------------------------------------------------------------------ */

export interface Enemy {
  active: boolean;
  def: EnemyDef;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  radius: number;
  xp: number;
  elite: boolean;
  boss: '' | BossId;
  kx: number; // knockback velocity
  ky: number;
  flash: number;
  /** Recoil pose timer; intentionally outlasts the brief white impact flash. */
  hurtT: number;
  attackCd: number;
  orbitCd: number;
  dashMark: number; // dash id that already hit this enemy
  stun: number;
  slow: number;
  face: number; // -1 | 1
  animT: number;
  /** True only when the enemy changed world position during the latest step. */
  moving: boolean;
  /** generic behavior cooldown (bottle throws, leaps, thumps, flashes, chants) */
  rangedCd: number;
  /** melee wind-up: >0 while visibly pulling back before the strike */
  windup: number;
  /** >0 during the strike lunge itself (after windup) */
  lungeT: number;
  /** >0: briefly airborne (big knockback / leapers). Ground effects sweep
   *  harmlessly underneath; aerial attacks connect. Never a permanent immunity. */
  airT: number;
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
}

/** AERIAL lane: a lobbed ball with real height (z) flying to a reserved far
 *  target; it passes over near enemies and lands with a splash. */
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

export interface Bottle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dmg: number;
  life: number;
}

export interface Pickup {
  active: boolean;
  kind: 'xp' | 'coin' | 'heal' | 'trophy';
  tier: 1 | 2 | 3;
  x: number;
  y: number;
  vx: number;
  vy: number;
  value: number;
  t: number;
}

export interface Guard {
  x: number;
  y: number;
  tx: number; // formation target
  ty: number;
  swingCd: number;
  strikeT: number;
  blockT: number;
  moving: boolean;
  face: number;
  animT: number;
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

export interface Telegraph {
  active: boolean;
  x: number;
  y: number;
  r: number;
  t: number;
  max: number;
  kind: 'flare' | 'shock' | 'cone' | 'flash' | 'chant';
  dmg: number;
  dir: number; // cone facing (radians)
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

/** Landing marker for an incoming aerial lob (purely visual, no gameplay). */
export interface Reticle {
  active: boolean;
  x: number;
  y: number;
  t: number;
  max: number;
}

/** Death visual: a fallen enemy that topples, sinks and fades (no gameplay). */
export interface Corpse {
  active: boolean;
  x: number;
  y: number;
  enemyId: string;
  boss: '' | BossId;
  elite: boolean;
  face: number;
  t: number;
  max: number;
}

export type SimEvent =
  | { type: 'hit'; x: number; y: number }
  | { type: 'kill'; x: number; y: number; elite: boolean }
  | { type: 'kick' }
  | { type: 'xp' }
  | { type: 'coin' }
  | { type: 'trophy'; coins: number; tier: 1 | 2 | 3 }
  | { type: 'levelup' }
  | { type: 'whistle'; x: number; y: number }
  | { type: 'pressure'; x: number; y: number }
  | { type: 'lobLand'; x: number; y: number }
  | { type: 'dash' }
  | { type: 'hurt' }
  | { type: 'punch' }
  | { type: 'vuvuzela'; x: number; y: number }
  | { type: 'flash'; x: number; y: number }
  | { type: 'chant'; x: number; y: number }
  | { type: 'bossSpawn'; name: string; title: string }
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
  animT: number;
  iframes: number;
  regenAcc: number;
  kx: number; // knockback velocity (heavy enemy hits, vuvuzela blasts)
  ky: number;
  slowT: number; // >0: slowed (paparazzo flash)
  abilities: Partial<Record<AbilityId, number>>;
  stats: Record<StatId, number>;
  // ability timers
  strikeCd: number;
  whistleCd: number;
  whistlePulse: number;
  pressureCd: number;
  pressureQueue: number; // staggered pulses still to release
  pressureQueueT: number;
  kickT: number; // >0 during the lob's kick animation (contact at half duration)
  dashCds: number[];
  dashT: number; // >0 while dashing
  dashDx: number;
  dashDy: number;
  dashId: number;
  orbitAngle: number;
}

export interface UpgradeOption {
  kind: 'ability' | 'stat' | 'heal' | 'coins';
  id: string;
  name: string;
  desc: string;
  color: string;
  level: number; // new level for abilities (1 = new)
  maxed?: boolean;
}

export class Sim {
  rng = new Rng();
  time = 0;
  over: 'playing' | 'won' | 'lost' = 'playing';
  kills = 0;
  coins = 0;
  player!: PlayerState;
  enemies: Enemy[] = [];
  balls: Ball[] = [];
  bottles: Bottle[] = [];
  pickups: Pickup[] = [];
  guards: Guard[] = [];
  particles: Particle[] = [];
  dmgNums: DmgNum[] = [];
  telegraphs: Telegraph[] = [];
  rings: Ring[] = [];
  pressures: Pressure[] = [];
  reticles: Reticle[] = [];
  corpses: Corpse[] = [];
  events: SimEvent[] = [];
  pendingLevelups = 0;
  boss0Spawned = false;
  boss1Spawned = false;
  boss2Spawned = false;
  bossAlive: Enemy | null = null;
  slowZones: { x: number; y: number; r: number; t: number }[] = [];
  flareZones: { x: number; y: number; r: number; t: number; tick: number }[] = [];

  private grid = new Map<number, number[]>();
  private flagBearers: Enemy[] = [];
  private spawnAcc = 0;
  private eliteAcc = 0;
  private def: PlayerDef;
  private deferred: { t: number; fn: () => void }[] = [];
  private powerMult = 1;
  private speedMult = 1;
  private magnetMult = 1;
  private guardDmgMult = 1;
  private guardExtra = 0;
  private xpMult = 1;
  private trailAcc = 0;

  constructor(def: PlayerDef, save: Save, seed = (Math.random() * 0xffffffff) >>> 0) {
    this.def = def;
    this.rng = new Rng(seed);
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
      animT: 0,
      iframes: 0,
      regenAcc: 0,
      kx: 0,
      ky: 0,
      slowT: 0,
      abilities: { [def.startAbility]: 1 },
      stats: { power: 0, speed: 0, maxhp: 0, regen: 0, magnet: 0, armor: 0 },
      strikeCd: 0.4,
      whistleCd: 2,
      whistlePulse: -1,
      pressureCd: 1.2,
      pressureQueue: 0,
      pressureQueueT: 0,
      kickT: 0,
      dashCds: [0],
      dashT: 0,
      dashDx: 1,
      dashDy: 0,
      dashId: 0,
      orbitAngle: 0,
    };
    if (def.id === 'neymar') this.player.dashCds = [0];
    this.spawnInitial();
    // opening wave: a few invaders just past the view edge so first contact
    // happens within ~3 seconds instead of an empty pitch
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.6;
      this.spawnEnemy(ENEMIES.invader, this.player.x + Math.cos(a) * 520, this.player.y + Math.sin(a) * 520, false);
    }
  }

  /* ---------------- derived stats ---------------- */

  get moveSpeed(): number {
    return this.def.speed * this.speedMult * (1 + this.player.stats.speed * 0.05);
  }
  get damageMult(): number {
    return this.powerMult * (1 + this.player.stats.power * 0.08);
  }
  get pickupRadius(): number {
    return 130 * this.magnetMult * (1 + this.player.stats.magnet * 0.25);
  }
  get regen(): number {
    return this.player.stats.regen * 0.4;
  }
  get armor(): number {
    return this.player.stats.armor;
  }

  abilityLevel(id: AbilityId): number {
    return this.player.abilities[id] ?? 0;
  }

  /* ---------------- pools ---------------- */

  private alloc<T extends { active: boolean }>(arr: T[]): T | null {
    for (const e of arr) if (!e.active) return e;
    return null;
  }

  private spawnInitial(): void {
    this.enemies = [];
    for (let i = 0; i < MAX_ENEMIES; i++) {
      this.enemies.push({
        active: false, def: ENEMIES.invader, x: 0, y: 0, hp: 1, maxHp: 1, speed: 0, damage: 0,
        radius: 10, xp: 1, elite: false, boss: '', kx: 0, ky: 0, flash: 0, hurtT: 0, attackCd: 0, orbitCd: 0,
        dashMark: -1, stun: 0, slow: 0, face: 1, animT: 0, moving: false, rangedCd: 2, windup: 0, lungeT: 0, airT: 0, haste: 1, boostT: 0, casting: '', bossCd: 4, bossCd2: 8, telegraph: 0,
      });
    }
    for (let i = 0; i < 400; i++) this.balls.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, z: 0, vz: 0, dmg: 0, splash: 60, ricochet: 0, spin: 0, tx: 0, ty: 0, targetIdx: -1, flightT: 0, maxFlightT: 1 });
    for (let i = 0; i < 200; i++) this.bottles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, dmg: 0, life: 0 });
    for (let i = 0; i < 500; i++) this.pickups.push({ active: false, kind: 'xp', tier: 1, x: 0, y: 0, vx: 0, vy: 0, value: 1, t: 0 });
    for (let i = 0; i < 600; i++) this.particles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: '#fff', grav: 0 });
    for (let i = 0; i < 120; i++) this.dmgNums.push({ active: false, x: 0, y: 0, value: '', life: 0, crit: false });
    for (let i = 0; i < 16; i++) this.telegraphs.push({ active: false, x: 0, y: 0, r: 0, t: 0, max: 1, kind: 'flare', dmg: 0, dir: 0 });
    for (let i = 0; i < 16; i++) this.rings.push({ active: false, x: 0, y: 0, r: 0, maxR: 100, life: 0, color: '#fff' });
    for (let i = 0; i < 24; i++) this.pressures.push({ active: false, x: 0, y: 0, r: 0, maxR: 100, dmg: 0, knock: 0, hitSet: [] });
    for (let i = 0; i < 32; i++) this.reticles.push({ active: false, x: 0, y: 0, t: 0, max: 1 });
    for (let i = 0; i < 64; i++) this.corpses.push({ active: false, x: 0, y: 0, enemyId: 'invader', boss: '', elite: false, face: 1, t: 0, max: 0.55 });
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

  /* ---------------- spawning ---------------- */

  private pickSpawnPos(): { x: number; y: number } {
    const p = this.player;
    for (let tries = 0; tries < 12; tries++) {
      const edge = this.rng.int(0, 3);
      let x = 0;
      let y = 0;
      if (edge === 0) {
        x = this.rng.range(40, ARENA_W - 40);
        y = 40;
      } else if (edge === 1) {
        x = this.rng.range(40, ARENA_W - 40);
        y = ARENA_H - 40;
      } else if (edge === 2) {
        x = 40;
        y = this.rng.range(40, ARENA_H - 40);
      } else {
        x = ARENA_W - 40;
        y = this.rng.range(40, ARENA_H - 40);
      }
      if (dist2(x, y, p.x, p.y) > 420 * 420) return { x, y };
    }
    return { x: 40, y: 40 };
  }

  private spawnEnemy(def: EnemyDef, x: number, y: number, elite: boolean): Enemy | null {
    const e = this.alloc(this.enemies);
    if (!e) return null;
    const mult = hpScale(this.time);
    e.active = true;
    e.def = def;
    e.x = x;
    e.y = y;
    e.maxHp = def.hp * mult * (elite ? 6 : 1);
    e.hp = e.maxHp;
    e.speed = def.speed * this.rng.range(0.9, 1.1) * (1 + Math.min(0.25, this.time / 2400));
    e.damage = def.damage * (elite ? 1.5 : 1);
    e.radius = def.radius * (elite ? 1.25 : 1);
    e.xp = elite ? def.xp * 4 : def.xp;
    e.elite = elite;
    e.boss = '';
    e.kx = 0;
    e.ky = 0;
    e.flash = 0;
    e.hurtT = 0;
    e.attackCd = 0;
    e.orbitCd = 0;
    e.dashMark = -1;
    e.stun = 0;
    e.slow = 0;
    e.animT = this.rng.range(0, 1);
    e.moving = false;
    e.rangedCd = this.rng.range(1, 2.6);
    e.windup = 0;
    e.lungeT = 0;
    e.airT = 0;
    e.haste = 1;
    e.boostT = 0;
    e.casting = '';
    e.telegraph = 0;
    return e;
  }

  private spawnBoss(which: BossId): void {
    const def = BOSSES[which];
    const e = this.alloc(this.enemies);
    if (!e) return;
    const pos = this.pickSpawnPos();
    const mult = hpScale(this.time);
    e.active = true;
    e.def = { ...ENEMIES.mascot, id: 'mascot' };
    e.x = pos.x;
    e.y = pos.y;
    e.maxHp = def.hp * (which === 'captain' ? Math.max(1, mult * 0.55) : 1);
    e.hp = e.maxHp;
    e.speed = def.speed;
    e.damage = def.damage;
    e.radius = def.radius;
    e.xp = def.xp;
    e.elite = false;
    e.boss = which;
    e.kx = 0;
    e.ky = 0;
    e.flash = 0;
    e.hurtT = 0;
    e.attackCd = 0;
    e.orbitCd = 0;
    e.dashMark = -1;
    e.stun = 0;
    e.slow = 0;
    e.animT = 0;
    e.moving = false;
    e.rangedCd = 2;
    e.windup = 0;
    e.lungeT = 0;
    e.airT = 0;
    e.haste = 1;
    e.boostT = 0;
    e.casting = '';
    e.bossCd = 3;
    e.bossCd2 = 7;
    e.telegraph = 0;
    this.bossAlive = e;
    this.events.push({ type: 'bossSpawn', name: def.name, title: def.title });
  }

  /* ---------------- pickups / drops ---------------- */

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
    const healChance = e.boss ? 0 : e.elite ? 1 : e.def.id === 'mascot' ? 0.4 : e.def.id === 'steward' ? 0.22 : 0;
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
  }

  /* ---------------- damage ---------------- */

  private scratch: number[] = new Array(512);

  damageEnemy(i: number, dmg: number, kx = 0, ky = 0, opts?: { stun?: number; crit?: boolean }): void {
    const e = this.enemies[i];
    if (!e.active || e.hp <= 0) return;
    const crit = opts?.crit ?? this.rng.chance(0.08);
    const final = Math.round(dmg * (crit ? 1.6 : 1));
    e.hp -= final;
    e.flash = 0.12;
    e.hurtT = 0.24;
    e.kx += kx;
    e.ky += ky;
    // a heavy shove launches the enemy briefly airborne: ground effects sweep
    // underneath while it flies, aerial attacks still connect (no immunity)
    if (!e.boss && Math.hypot(kx, ky) > 330) e.airT = Math.max(e.airT, 0.38);
    if (opts?.stun) e.stun = Math.max(e.stun, opts.stun);
    this.spawnDmgNum(e.x, e.y - e.radius - 6, final, crit);
    this.events.push({ type: 'hit', x: e.x, y: e.y });
    if (e.hp <= 0) this.killEnemy(i);
  }

  private killEnemy(i: number): void {
    const e = this.enemies[i];
    if (!e.active) return;
    e.active = false;
    this.kills++;
    this.dropLoot(e);
    this.spawnCorpse(e);
    this.burst(e.x, e.y, e.boss ? 26 : e.elite ? 14 : 6, e.boss ? '#ffd23f' : '#e8b88a');
    this.events.push({ type: 'kill', x: e.x, y: e.y, elite: e.elite || !!e.boss });
    if (e.boss) {
      const def = BOSSES[e.boss];
      this.coins += def.coins;
      this.bossAlive = null;
      this.events.push({ type: 'bossDie', x: e.x, y: e.y, coins: def.coins });
      // Every boss leaves one tangible trophy. Collecting it grants an extra
      // tiered payout and creates a deliberate post-boss pickup beat.
      const trophy = this.alloc(this.pickups);
      if (trophy) {
        const tier: 1 | 2 | 3 = e.boss === 'captain' ? 3 : e.boss === 'official' ? 2 : 1;
        trophy.active = true;
        trophy.kind = 'trophy';
        trophy.tier = tier;
        trophy.x = e.x;
        trophy.y = e.y;
        trophy.vx = this.rng.range(-35, 35);
        trophy.vy = this.rng.range(-35, 35);
        trophy.value = tier === 3 ? 50 : tier === 2 ? 25 : 15;
        trophy.t = 0;
      }
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
    c.boss = e.boss;
    c.elite = e.elite;
    c.face = e.face;
    c.t = 0;
    c.max = e.boss ? 1.4 : 0.55;
  }

  private hurtPlayer(raw: number, kx = 0, ky = 0, slowT = 0): void {
    const p = this.player;
    if (p.iframes > 0 || p.dashT > 0 || this.over !== 'playing') return;
    const dmg = Math.max(1, Math.round(raw - this.armor));
    p.hp -= dmg;
    p.iframes = 0.55;
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
    d.value = String(value);
    d.life = 0.7;
    d.crit = crit;
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

  private telegraph(x: number, y: number, r: number, delay: number, kind: Telegraph['kind'], dmg = 0, dir = 0): void {
    const t = this.alloc(this.telegraphs);
    if (!t) return;
    t.active = true;
    t.x = x;
    t.y = y;
    t.r = r;
    t.t = delay;
    t.max = delay;
    t.kind = kind;
    t.dmg = dmg;
    t.dir = dir;
  }

  /** Bottle Lobber's throw (after the visible wind-up). */
  private throwBottle(e: Enemy): void {
    const b = this.alloc(this.bottles);
    if (!b) return;
    const p = this.player;
    b.active = true;
    b.x = e.x;
    b.y = e.y;
    const lead = 0.4;
    const tx = p.x + p.dashDx * (p.moving ? this.moveSpeed * lead : 0);
    const ty = p.y + p.dashDy * (p.moving ? this.moveSpeed * lead : 0);
    const dd = Math.hypot(tx - e.x, ty - e.y) || 1;
    b.vx = ((tx - e.x) / dd) * 280;
    b.vy = ((ty - e.y) / dd) * 280;
    b.dmg = e.damage;
    b.life = 2.2;
  }

  /* ---------------- level-ups ---------------- */

  rollUpgrades(): UpgradeOption[] {
    const p = this.player;
    interface Cand extends UpgradeOption {
      weight: number;
    }
    const cands: Cand[] = [];
    for (const id of Object.keys(ABILITIES) as AbilityId[]) {
      const lvl = p.abilities[id] ?? 0;
      const def = ABILITIES[id];
      if (lvl === 0) {
        cands.push({ kind: 'ability', id, name: def.name, desc: def.levels[0].desc, color: def.color, level: 1, weight: 26 });
      } else if (lvl < def.levels.length) {
        cands.push({ kind: 'ability', id, name: `${def.name} Lv${lvl + 1}`, desc: def.levels[lvl].desc, color: def.color, level: lvl + 1, weight: 30 });
      }
    }
    for (const id of Object.keys(STATS) as StatId[]) {
      const def = STATS[id];
      const cur = p.stats[id];
      if (cur < def.max) {
        cands.push({ kind: 'stat', id, name: def.name, desc: def.desc, color: def.color, level: cur + 1, weight: 15 });
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
          ? { kind: 'heal', id: 'heal', name: 'Orange Slices', desc: 'Recover 30 HP right now.', color: '#80ed99', level: 0 }
          : { kind: 'coins', id: 'coins', name: 'Signing Bonus', desc: '+25 coins, straight into the club account.', color: '#ffd23f', level: 0 },
      );
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
    } else if (opt.kind === 'stat') {
      const id = opt.id as StatId;
      p.stats[id] += 1;
      if (id === 'maxhp') {
        p.maxHp += 15;
        p.hp = Math.min(p.maxHp, p.hp + 15);
      }
    } else if (opt.kind === 'heal') {
      p.hp = Math.min(p.maxHp, p.hp + 30);
    } else {
      this.coins += 25;
    }
  }

  private gainXp(v: number): void {
    const p = this.player;
    p.xp += v * this.xpMult;
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.level += 1;
      p.xpNext = xpForLevel(p.level);
      this.pendingLevelups += 1;
      this.events.push({ type: 'levelup' });
      this.confetti(p.x, p.y, 30);
    }
  }

  private refreshGuards(): void {
    const lvl = this.abilityLevel('guard');
    const want = lvl === 0 ? 0 : (lvl >= 5 ? 3 : lvl >= 3 ? 2 : 1) + (lvl > 0 ? this.guardExtra : 0);
    while (this.guards.length < want) {
      const a = (this.guards.length / Math.max(1, want)) * TAU;
      this.guards.push({
        x: this.player.x + Math.cos(a) * 60,
        y: this.player.y + Math.sin(a) * 60,
        tx: 0, ty: 0, swingCd: 0, strikeT: 0, blockT: 0,
        moving: false, face: 1, animT: 0, target: -1,
      });
    }
  }

  /* ---------------- abilities ---------------- */

  /* AERIAL lane: far-band targeting with damage reservation */

  /** Damage already inbound on enemy `idx` from lobs still in flight. */
  private reservedDmg(idx: number): number {
    let sum = 0;
    for (const b of this.balls) if (b.active && b.targetIdx === idx) sum += b.dmg;
    return sum;
  }

  /** Aerial lobs prefer threats outside this near band (they fly over closer mobs). */
  static AERIAL_NEAR_BAND = 260;
  static AERIAL_MAX_RANGE = 700;

  /**
   * Picks the best far-band target for an aerial lob: ranged/support threats
   * first, then bosses/elites, then the nearest of those. Targets whose
   * reserved inbound damage already projects a kill are skipped, so volleys
   * distribute over living threats instead of overkill-stacking one corpse.
   * Falls back to the nearest enemy in range when no far target qualifies.
   */
  pickAerialTarget(fromX: number, fromY: number): number {
    const band2 = Sim.AERIAL_NEAR_BAND * Sim.AERIAL_NEAR_BAND;
    const max2 = Sim.AERIAL_MAX_RANGE * Sim.AERIAL_MAX_RANGE;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.active) continue;
      const d2 = dist2(fromX, fromY, e.x, e.y);
      if (d2 < band2 || d2 > max2) continue; // far band only
      if (this.reservedDmg(i) >= e.hp) continue; // projected dead: leave it
      let score = 0;
      if (e.def.behavior === 'ranged') score += 400; // support/ranged first
      if (e.boss) score += 260;
      else if (e.elite) score += 160;
      score -= Math.sqrt(d2) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) return best;
    return this.nearestEnemy(fromX, fromY, Sim.AERIAL_MAX_RANGE);
  }

  /** Starts the readable wind-up; the ball is created on the strip's contact frame. */
  private fireStrike(): void {
    if (this.abilityLevel('strike') === 0) return;
    this.player.kickT = KICK_DURATION;
    this.deferred.push({ t: KICK_CONTACT_DELAY, fn: () => this.releaseStrike() });
  }

  /** Releases the aerial volley on the exact contact beat of the kick strip. */
  private releaseStrike(): void {
    const lvl = this.abilityLevel('strike');
    if (lvl === 0) return;
    const p = this.player;
    const count = [0, 1, 2, 2, 3, 4][lvl] + (this.def.id === 'messi' ? 1 : 0);
    const dmg = [0, 14, 14, 20, 20, 28][lvl] * this.damageMult;
    const splash = lvl >= 4 ? 92 : 66;
    const ric = lvl >= 5 ? 1 : 0;
    let launched = 0;
    for (let i = 0; i < count; i++) {
      const ti = this.pickAerialTarget(p.x, p.y);
      if (ti < 0) break;
      const b = this.alloc(this.balls);
      if (!b) return;
      const e = this.enemies[ti];
      this.lob(b, p.x, p.y, e.x, e.y, dmg, splash, ric, ti);
      launched++;
    }
    if (launched > 0) {
      this.burst(p.x + p.face * 22, p.y, 4, '#ffd166');
      this.events.push({ type: 'kick' });
    }
  }

  /** Launches a lobbed ball on a ballistic arc that lands exactly on (tx,ty). */
  private lob(b: Ball, x: number, y: number, tx: number, ty: number, dmg: number, splash: number, ric: number, targetIdx: number): void {
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
    this.reticle(tx, ty, T);
  }

  /** Landing impact: group splash + shove, then optional ricochet re-lob. */
  private lobImpact(b: Ball): void {
    const r = b.splash;
    const n = this.query(b.x, b.y, r + 40, this.scratch);
    for (let i = 0; i < n; i++) {
      const idx = this.scratch[i];
      const e = this.enemies[idx];
      if (!e.active) continue;
      if (dist2(b.x, b.y, e.x, e.y) > (r + e.radius) * (r + e.radius)) continue;
      const d = Math.hypot(e.x - b.x, e.y - b.y) || 1;
      this.damageEnemy(idx, b.dmg, ((e.x - b.x) / d) * 200, ((e.y - b.y) / d) * 200);
    }
    this.burst(b.x, b.y, 10, '#ffd166');
    this.ring(b.x, b.y, r, '#ffd166');
    this.events.push({ type: 'lobLand', x: b.x, y: b.y });
    if (b.ricochet > 0) {
      const ti = this.pickAerialTarget(b.x, b.y);
      if (ti >= 0) {
        const e = this.enemies[ti];
        this.lob(b, b.x, b.y, e.x, e.y, b.dmg, b.splash, b.ricochet - 1, ti);
      }
    }
  }

  /* GROUND lane: expanding pressure ring */

  private firePressure(): void {
    const lvl = this.abilityLevel('pressure');
    if (lvl === 0) return;
    const p = this.player;
    p.pressureQueue = lvl >= 5 ? 2 : lvl >= 3 ? 1 : 0;
    p.pressureQueueT = 0.45;
    this.pressurePulse(lvl);
    this.events.push({ type: 'pressure', x: p.x, y: p.y });
  }

  private pressurePulse(lvl: number): void {
    const p = this.player;
    const ring = this.alloc(this.pressures);
    if (!ring) return;
    ring.active = true;
    ring.x = p.x;
    ring.y = p.y;
    ring.r = 26;
    ring.maxR = [0, 150, 170, 170, 205, 225][lvl];
    ring.dmg = [0, 12, 18, 18, 24, 26][lvl] * this.damageMult;
    ring.knock = [0, 260, 260, 260, 345, 385][lvl];
    ring.hitSet.length = 0;
    if (lvl >= 5) {
      // vortex: drag the crowd inward before the blast wave reaches them
      const n = this.query(p.x, p.y, ring.maxR + 60, this.scratch);
      for (let i = 0; i < n; i++) {
        const e = this.enemies[this.scratch[i]];
        if (!e.active || e.boss) continue;
        const d = Math.hypot(p.x - e.x, p.y - e.y) || 1;
        e.kx += ((p.x - e.x) / d) * 230;
        e.ky += ((p.y - e.y) / d) * 230;
      }
    }
  }

  private reticle(x: number, y: number, t: number): void {
    const r = this.alloc(this.reticles);
    if (!r) return;
    r.active = true;
    r.x = x;
    r.y = y;
    r.t = t;
    r.max = t;
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
      if (e.airT > 0) continue; // GROUND lane: sweeps harmlessly under airborne mobs
      const d2 = dist2(x, y, e.x, e.y);
      if (d2 > (r + e.radius) * (r + e.radius)) continue;
      const d = Math.sqrt(d2) || 1;
      const k = 340;
      this.damageEnemy(idx, dmg, ((e.x - x) / d) * k, ((e.y - y) / d) * k, { stun });
    }
    this.ring(x, y, r, '#f5f7fa');
  }

  private tryDash(): void {
    const lvl = this.abilityLevel('dash');
    if (lvl === 0) return;
    const p = this.player;
    if (p.dashT > 0) return;
    const cdIdx = p.dashCds.findIndex((c) => c <= 0);
    if (cdIdx < 0) return;
    const cdBase = [0, 5, 5, 4, 4, 3][lvl] * (this.def.id === 'neymar' ? 0.75 : 1);
    // trigger only when threatened or moving with intent
    const threat = this.nearestEnemy(p.x, p.y, 170) >= 0;
    if (!threat && !p.moving) return;
    p.dashCds[cdIdx] = cdBase;
    let dx = p.dashDx;
    let dy = p.dashDy;
    if (!p.moving) {
      const ni = this.nearestEnemy(p.x, p.y, 300);
      if (ni >= 0) {
        const d = Math.hypot(this.enemies[ni].x - p.x, this.enemies[ni].y - p.y) || 1;
        dx = -(this.enemies[ni].x - p.x) / d;
        dy = -(this.enemies[ni].y - p.y) / d;
      }
    }
    const l = Math.hypot(dx, dy) || 1;
    p.dashDx = dx / l;
    p.dashDy = dy / l;
    p.dashT = 0.22 + lvl * 0.012;
    p.dashId++;
    this.events.push({ type: 'dash' });
    this.burst(p.x, p.y, 6, '#80ed99');
  }

  /* ---------------- update ---------------- */

  update(dt: number, ax: number, ay: number): void {
    if (this.over !== 'playing') {
      this.updateFx(dt);
      return;
    }
    const p = this.player;
    this.time += dt;
    for (let i = this.deferred.length - 1; i >= 0; i--) {
      this.deferred[i].t -= dt;
      if (this.deferred[i].t <= 0) {
        const d = this.deferred.splice(i, 1)[0];
        d.fn();
      }
    }

    /* timers */
    p.iframes = Math.max(0, p.iframes - dt);
    p.strikeCd -= dt;
    p.whistleCd -= dt;
    p.pressureCd -= dt;
    p.kickT = Math.max(0, p.kickT - dt);
    for (let i = 0; i < p.dashCds.length; i++) p.dashCds[i] -= dt;
    if (p.pressureQueue > 0) {
      p.pressureQueueT -= dt;
      if (p.pressureQueueT <= 0) {
        p.pressureQueue--;
        p.pressureQueueT = 0.45; // staggered so launched mobs land before the next pulse
        this.pressurePulse(this.abilityLevel('pressure'));
        this.events.push({ type: 'pressure', x: p.x, y: p.y });
      }
    }
    if (p.whistlePulse > 0) {
      p.whistlePulse -= dt;
      if (p.whistlePulse <= 0) {
        p.whistlePulse = -1;
        const r = 245 * 1.25 * (this.def.id === 'ronaldo' ? 1.25 : 1);
        this.doShockwave(p.x, p.y, r, 32 * this.damageMult * 0.6, 0.5);
        this.events.push({ type: 'whistle', x: p.x, y: p.y });
      }
    }
    // regen
    p.regenAcc += this.regen * dt;
    if (p.regenAcc >= 1) {
      const h = Math.floor(p.regenAcc);
      p.regenAcc -= h;
      p.hp = Math.min(p.maxHp, p.hp + h);
    }

    /* movement */
    p.moving = ax !== 0 || ay !== 0;
    if (p.moving) {
      p.dashDx = ax;
      p.dashDy = ay;
      if (ax !== 0) p.face = ax > 0 ? 1 : -1;
    }
    if (p.dashT > 0) {
      p.dashT -= dt;
      const lvl = this.abilityLevel('dash');
      const speed = 560;
      p.x += p.dashDx * speed * dt;
      p.y += p.dashDy * speed * dt;
      // damage enemies passed through
      const dmg = [0, 20, 30, 30, 30, 45][lvl] * this.damageMult;
      const n = this.query(p.x, p.y, 60, this.scratch);
      for (let i = 0; i < n; i++) {
        const idx = this.scratch[i];
        const e = this.enemies[idx];
        if (e.airT > 0) continue; // GROUND lane: dash sweep passes under airborne mobs
        if (dist2(p.x, p.y, e.x, e.y) < (e.radius + 42) * (e.radius + 42) && e.dashMark !== p.dashId) {
          e.dashMark = p.dashId;
          const d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
          this.damageEnemy(idx, dmg, ((e.x - p.x) / d) * 200, ((e.y - p.y) / d) * 200);
        }
      }
      // L5 slowing trail
      if (lvl >= 5) {
        this.trailAcc -= dt;
        if (this.trailAcc <= 0) {
          this.trailAcc = 0.06;
          this.slowZones.push({ x: p.x, y: p.y, r: 55, t: 3.5 });
        }
      }
    } else {
      const sp = this.moveSpeed * (p.slowT > 0 ? 0.55 : 1);
      p.x += ax * sp * dt;
      p.y += ay * sp * dt;
    }
    // player knockback (heavy hits, vuvuzela blasts)
    p.slowT = Math.max(0, p.slowT - dt);
    p.x += p.kx * dt;
    p.y += p.ky * dt;
    p.kx *= Math.pow(0.001, dt);
    p.ky *= Math.pow(0.001, dt);
    p.x = clamp(p.x, 30, ARENA_W - 30);
    p.y = clamp(p.y, 30, ARENA_H - 30);
    p.animT += dt * (p.moving || p.dashT > 0 ? 1 : 0.4);

    /* abilities */
    // refresh the spatial grid so same-frame spawns are targetable (abilities
    // run before the per-frame enemy rebuild below)
    this.rebuildGrid();
    if (p.strikeCd <= 0 && this.abilityLevel('strike') > 0) {
      const lvl = this.abilityLevel('strike');
      p.strikeCd = [0, 0.9, 0.9, 0.8, 0.8, 0.65][lvl];
      if (this.nearestEnemy(p.x, p.y, Sim.AERIAL_MAX_RANGE) >= 0) this.fireStrike();
    }
    if (p.whistleCd <= 0 && this.abilityLevel('whistle') > 0) {
      const lvl = this.abilityLevel('whistle');
      p.whistleCd = [0, 3.5, 3.5, 3.0, 3.0, 2.2][lvl];
      this.fireWhistle();
    }
    if (p.pressureCd <= 0 && this.abilityLevel('pressure') > 0) {
      const lvl = this.abilityLevel('pressure');
      p.pressureCd = [0, 2.6, 2.6, 2.3, 2.3, 2.0][lvl];
      this.firePressure();
    }
    this.tryDash();

    // orbit damage + press
    const orbitLvl = this.abilityLevel('orbit');
    if (orbitLvl > 0) {
      const count = [0, 2, 3, 3, 4, 5][orbitLvl] + (this.def.id === 'yamal' ? 1 : 0);
      const radius = [0, 90, 90, 115, 115, 140][orbitLvl];
      const speed = [0, 2.3, 2.3, 2.5, 2.8, 3.0][orbitLvl];
      const dmg = [0, 10, 10, 14, 14, 20][orbitLvl] * this.damageMult;
      const knock = [0, 280, 280, 300, 320, 360][orbitLvl];
      p.orbitAngle += speed * dt;
      for (let b = 0; b < count; b++) {
        const a = p.orbitAngle + (b / count) * TAU;
        const ox = p.x + Math.cos(a) * radius;
        const oy = p.y + Math.sin(a) * radius;
        const n = this.query(ox, oy, 34, this.scratch);
        for (let i = 0; i < n; i++) {
          const idx = this.scratch[i];
          const e = this.enemies[idx];
          if (e.orbitCd > 0 || e.airT > 0) continue; // GROUND lane: orbit misses airborne mobs
          if (dist2(ox, oy, e.x, e.y) < (e.radius + 18) * (e.radius + 18)) {
            e.orbitCd = 0.38;
            const d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
            this.damageEnemy(idx, dmg, ((e.x - p.x) / d) * knock, ((e.y - p.y) / d) * knock);
          }
        }
      }
    }

    /* spawning */
    this.spawnAcc += dt;
    const interval = spawnInterval(this.time);
    if (this.spawnAcc >= interval) {
      this.spawnAcc = 0;
      const batch = spawnBatch(this.time);
      const unlocked = Object.values(ENEMIES).filter((d) => d.unlockAt <= this.time);
      for (let i = 0; i < batch; i++) {
        const def = weightedPick(this.rng, unlocked);
        if (!def) break;
        const pos = this.pickSpawnPos();
        this.spawnEnemy(def, pos.x, pos.y, false);
      }
    }
    // elites
    this.eliteAcc += dt;
    if (this.time > 90 && this.eliteAcc > 40) {
      this.eliteAcc = 0;
      const unlocked = Object.values(ENEMIES).filter((d) => d.unlockAt <= this.time);
      const def = weightedPick(this.rng, unlocked);
      if (def) {
        const pos = this.pickSpawnPos();
        this.spawnEnemy(def, pos.x, pos.y, true);
      }
    }
    // bosses: introduced progressively, never two on the pitch at once
    if (!this.boss0Spawned && this.time >= BOSS0_AT && !this.bossAlive) {
      this.boss0Spawned = true;
      this.spawnBoss('drumboss');
    }
    if (!this.boss1Spawned && this.time >= BOSS1_AT && !this.bossAlive) {
      this.boss1Spawned = true;
      this.spawnBoss('official');
    }
    if (!this.boss2Spawned && this.time >= BOSS2_AT && !this.bossAlive) {
      this.boss2Spawned = true;
      this.spawnBoss('captain');
    }

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
      const stepX = e.x;
      const stepY = e.y;
      e.flash = Math.max(0, e.flash - dt);
      e.hurtT = Math.max(0, e.hurtT - dt);
      e.attackCd = Math.max(0, e.attackCd - dt);
      e.orbitCd = Math.max(0, e.orbitCd - dt);
      e.stun = Math.max(0, e.stun - dt);
      const wasAir = e.airT > 0;
      e.airT = Math.max(0, e.airT - dt);
      e.lungeT = Math.max(0, e.lungeT - dt);
      e.boostT = Math.max(0, e.boostT - dt);
      e.telegraph = Math.max(0, e.telegraph - dt);
      e.animT += dt;
      // knockback decay
      e.x += e.kx * dt;
      e.y += e.ky * dt;
      e.kx *= Math.pow(0.001, dt);
      e.ky *= Math.pow(0.001, dt);
      e.x = clamp(e.x, 20, ARENA_W - 20);
      e.y = clamp(e.y, 20, ARENA_H - 20);
      // leapers land with a visible thump (ground moves work again from here)
      if (wasAir && e.airT <= 0 && !e.boss) {
        this.burst(e.x, e.y, 6, '#ff9a3d');
        this.ring(e.x, e.y, 60, '#ff9a3d');
      }
      if (e.stun > 0) {
        e.windup = 0; // stun interrupts the swing
        e.moving = dist2(e.x, e.y, stepX, stepY) > 0.01;
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
      e.face = dx > 0 ? 1 : -1;

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
          e.lungeT = 0.14;
          e.attackCd = e.def.behavior === 'chase' || e.def.behavior === 'wall' ? 0.9 : 1.4;
          if (e.casting === 'bottle') {
            e.casting = '';
            this.throwBottle(e);
          } else if (e.airT <= 0 && dist2(e.x, e.y, p.x, p.y) < (e.radius + 30) * (e.radius + 30)) {
            const push = e.def.push ?? 120;
            this.hurtPlayer(e.damage, (dx / d) * push, (dy / d) * push);
          }
          this.events.push({ type: 'punch' });
        }
      } else if (e.lungeT > 0) {
        // ---- strike lunge: quick step in ----
        e.x += (dx / d) * e.speed * 3.2 * dt;
        e.y += (dy / d) * e.speed * 3.2 * dt;
      } else {
        // ---- locomotion + behavior specials ----
        const sp = e.speed * e.haste * slowMult;
        // separation from neighbors
        let sx = 0;
        let sy = 0;
        const n = this.query(e.x, e.y, e.radius + 18, this.scratch);
        for (let s = 0; s < n; s++) {
          const o = this.enemies[this.scratch[s]];
          if (o === e || !o.active) continue;
          const od2 = dist2(e.x, e.y, o.x, o.y);
          const min = e.radius + o.radius;
          if (od2 < min * min && od2 > 0.01) {
            const od = Math.sqrt(od2);
            sx += ((e.x - o.x) / od) * (min - od) * 2.4;
            sy += ((e.y - o.y) / od) * (min - od) * 2.4;
          }
        }
        const beh = e.def.behavior;
        if (e.airT > 0) {
          // mid-leap: momentum carries the leap (no steering)
        } else if (beh === 'chase' || beh === 'wall' || beh === 'thumper' || beh === 'leaper') {
          e.x += ((dx / d) * (sp - press) + sx) * dt;
          e.y += ((dy / d) * (sp - press) + sy) * dt;
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
              e.airT = 0.55; // bounds through the air: ground effects miss
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
              this.telegraph(e.x, e.y, 210, 0.85, 'shock', e.damage, 0);
            }
          }
        } else if (beh === 'support') {
          e.x += ((dx / d) * (sp * 0.65 - press) + sx) * dt;
          e.y += ((dy / d) * (sp * 0.65 - press) + sy) * dt;
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
            this.telegraph(e.x, e.y, 400, 0.6, 'cone', e.damage, Math.atan2(dy, dx));
          } else if (beh === 'summoner' && e.rangedCd <= 0 && d < 520) {
            e.rangedCd = 6.5;
            e.telegraph = Math.max(e.telegraph, 0.9);
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
            this.telegraph(e.x, e.y, 230, 0.7, 'flash', e.damage, 0);
          }
        }
        // every grounded enemy swings when the player is in reach
        if (e.airT <= 0 && e.attackCd <= 0 && e.casting === '' && dist2(e.x, e.y, p.x, p.y) < (e.radius + 20) * (e.radius + 20)) {
          e.windup = 0.34; // readable pull-back before the hit lands
        }
      }
      e.moving = dist2(e.x, e.y, stepX, stepY) > 0.01;
    }

    /* balls (AERIAL lane: lobbed ballistics, damage only on landing) */
    for (const b of this.balls) {
      if (!b.active) continue;
      b.flightT += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.vz -= LOB_GRAVITY * dt;
      if (b.z > 0) continue; // still airborne: passes over ground-level mobs
      b.active = false;
      this.lobImpact(b);
    }

    /* pressure rings (GROUND lane: expanding damaging front) */
    for (const pr of this.pressures) {
      if (!pr.active) continue;
      pr.r += pr.maxR * 2.1 * dt; // expand to maxR in ~0.48s
      const n = this.query(pr.x, pr.y, pr.r + 70, this.scratch);
      for (let i = 0; i < n; i++) {
        const idx = this.scratch[i];
        const e = this.enemies[idx];
        if (!e.active || e.airT > 0 || pr.hitSet.includes(idx)) continue;
        if (dist2(pr.x, pr.y, e.x, e.y) > (pr.r + e.radius) * (pr.r + e.radius)) continue;
        pr.hitSet.push(idx);
        const d = Math.hypot(e.x - pr.x, e.y - pr.y) || 1;
        this.damageEnemy(idx, pr.dmg, ((e.x - pr.x) / d) * pr.knock, ((e.y - pr.y) / d) * pr.knock);
      }
      if (pr.r >= pr.maxR) pr.active = false;
    }

    /* bottles */
    for (const b of this.bottles) {
      if (!b.active) continue;
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.life <= 0) {
        b.active = false;
        continue;
      }
      // guards body-block
      let blocked = false;
      if (this.abilityLevel('guard') >= 4) {
        for (const g of this.guards) {
          if (dist2(b.x, b.y, g.x, g.y) < 26 * 26) {
            blocked = true;
            g.blockT = 0.3;
            g.face = b.x > g.x ? 1 : -1;
            break;
          }
        }
      }
      if (blocked) {
        b.active = false;
        this.burst(b.x, b.y, 4, '#a7e8bd');
        continue;
      }
      if (dist2(b.x, b.y, p.x, p.y) < 20 * 20) {
        b.active = false;
        this.hurtPlayer(b.dmg);
      }
    }

    /* guards */
    const guardLvl = this.abilityLevel('guard');
    if (guardLvl > 0) {
      const dmg = [0, 12, 18, 18, 18, 30][guardLvl] * this.guardDmgMult * this.damageMult;
      const swingCd = guardLvl >= 5 ? 0.55 : 0.8;
      const knock = guardLvl >= 4 ? 260 : 90;
      this.guards.forEach((g, gi) => {
        const stepX = g.x;
        const stepY = g.y;
        g.swingCd = Math.max(0, g.swingCd - dt);
        g.strikeT = Math.max(0, g.strikeT - dt);
        g.blockT = Math.max(0, g.blockT - dt);
        g.animT += dt;
        // acquire target near player
        let ti = g.target;
        if (ti < 0 || !this.enemies[ti]?.active) {
          ti = this.nearestEnemy(p.x, p.y, 340);
          g.target = ti;
        }
        const formationTurn = p.moving ? p.animT * 0.3 : 0;
        let tx = p.x + Math.cos((gi / this.guards.length) * TAU + formationTurn) * 55;
        let ty = p.y + Math.sin((gi / this.guards.length) * TAU + formationTurn) * 55;
        if (ti >= 0) {
          const e = this.enemies[ti];
          tx = e.x;
          ty = e.y;
          const dd = Math.hypot(e.x - g.x, e.y - g.y);
          if (e.airT <= 0 && dd < e.radius + 24 && g.swingCd <= 0) {
            g.swingCd = swingCd;
            g.strikeT = 0.24;
            const d2 = dd || 1;
            this.damageEnemy(ti, dmg, ((e.x - g.x) / d2) * knock, ((e.y - g.y) / d2) * knock);
            this.events.push({ type: 'punch' });
            g.face = e.x > g.x ? 1 : -1;
          }
        }
        const dx = tx - g.x;
        const dy = ty - g.y;
        const d = Math.hypot(dx, dy);
        if (d > 6) {
          const sp = Math.min(300, d * 6);
          g.x += (dx / d) * sp * dt;
          g.y += (dy / d) * sp * dt;
          if (ti < 0) g.face = dx > 0 ? 1 : -1;
        }
        g.moving = dist2(g.x, g.y, stepX, stepY) > 0.01;
      });
    }

    /* boss telegraphs & zones */
    for (const t of this.telegraphs) {
      if (!t.active) continue;
      t.t -= dt;
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
            const a = this.rng.range(0, TAU);
            this.spawnEnemy(
              ENEMIES.invader,
              clamp(t.x + Math.cos(a) * 90, 40, ARENA_W - 40),
              clamp(t.y + Math.sin(a) * 90, 40, ARENA_H - 40),
              false,
            );
          }
        }
      }
    }
    for (let i = this.flareZones.length - 1; i >= 0; i--) {
      const z = this.flareZones[i];
      z.t -= dt;
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.4;
        if (dist2(p.x, p.y, z.x, z.y) < z.r * z.r) this.hurtPlayer(8);
      }
      if (z.t <= 0) this.flareZones.splice(i, 1);
    }
    for (let i = this.slowZones.length - 1; i >= 0; i--) {
      this.slowZones[i].t -= dt;
      if (this.slowZones[i].t <= 0) this.slowZones.splice(i, 1);
    }

    /* pickups */
    const pr = this.pickupRadius;
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      pk.t += dt;
      pk.x += pk.vx * dt;
      pk.y += pk.vy * dt;
      pk.vx *= Math.pow(0.01, dt);
      pk.vy *= Math.pow(0.01, dt);
      const d2 = dist2(pk.x, pk.y, p.x, p.y);
      if (d2 < pr * pr) {
        const d = Math.sqrt(d2) || 1;
        const pull = pk.kind === 'coin' || pk.kind === 'trophy' ? 500 : 420;
        pk.vx += ((p.x - pk.x) / d) * pull * dt * 4;
        pk.vy += ((p.y - pk.y) / d) * pull * dt * 4;
      } else if (pk.kind === 'xp' && pk.t > 0.6) {
        // long-range drift: settled XP slowly migrates to the player so
        // long-range kills never strand progression off-screen
        const d = Math.sqrt(d2) || 1;
        pk.vx += ((p.x - pk.x) / d) * 26 * dt;
        pk.vy += ((p.y - pk.y) / d) * 26 * dt;
      }
      if (d2 < 26 * 26) {
        pk.active = false;
        if (pk.kind === 'xp') {
          this.gainXp(pk.value);
          this.events.push({ type: 'xp' });
        } else if (pk.kind === 'heal') {
          p.hp = Math.min(p.maxHp, p.hp + pk.value);
          this.events.push({ type: 'xp' });
          this.burst(p.x, p.y, 10, '#37d67a');
        } else if (pk.kind === 'trophy') {
          this.coins += pk.value;
          this.events.push({ type: 'trophy', coins: pk.value, tier: pk.tier });
          this.confetti(p.x, p.y, 28 + pk.tier * 8);
        } else {
          this.coins += pk.value;
          this.events.push({ type: 'coin' });
        }
      }
    }

    this.updateFx(dt);

    /* victory */
    if (this.time >= RUN_LENGTH && this.over === 'playing') {
      this.over = 'won';
      this.confetti(p.x, p.y, 80);
      this.events.push({ type: 'victory' });
    }
  }

  /** Shared boss melee: wind-up swing when the player is in reach. */
  private bossMelee(e: Enemy, dx: number, dy: number, d: number, dt: number): void {
    const p = this.player;
    if (e.windup > 0) {
      e.windup -= dt;
      if (e.windup <= 0) {
        e.lungeT = 0.16;
        e.attackCd = 1.1;
        if (e.airT <= 0 && dist2(e.x, e.y, p.x, p.y) < (e.radius + 34) * (e.radius + 34)) {
          this.hurtPlayer(e.damage, (dx / d) * 260, (dy / d) * 260);
        }
        this.events.push({ type: 'punch' });
      }
    } else if (e.lungeT > 0) {
      e.lungeT -= dt;
      e.x += (dx / d) * e.speed * 2.8 * dt;
      e.y += (dy / d) * e.speed * 2.8 * dt;
    } else if (e.attackCd <= 0 && d < e.radius + 26) {
      e.windup = 0.42;
    }
  }

  private updateOfficial(e: Enemy, nx: number, ny: number, dt: number): void {
    if (e.windup <= 0 && e.lungeT <= 0) {
      e.x += nx * e.speed * dt;
      e.y += ny * e.speed * dt;
    }
    this.bossMelee(e, nx, ny, Math.hypot(this.player.x - e.x, this.player.y - e.y) || 1, dt);
    e.bossCd -= dt;
    e.bossCd2 -= dt;
    e.rangedCd -= dt;
    if (e.bossCd <= 0) {
      e.bossCd = 6;
      // whistle shockwave, telegraphed around the official
      e.telegraph = Math.max(e.telegraph, 0.9);
      this.telegraph(e.x, e.y, 230, 0.9, 'shock', 18, 0);
    }
    if (e.bossCd2 <= 0) {
      e.bossCd2 = 9;
      // book the crowd: summon 4 invaders
      for (let i = 0; i < 4; i++) {
        const a = this.rng.range(0, TAU);
        this.spawnEnemy(ENEMIES.invader, clamp(e.x + Math.cos(a) * 120, 40, ARENA_W - 40), clamp(e.y + Math.sin(a) * 120, 40, ARENA_H - 40), false);
      }
    }
    if (e.rangedCd <= 0) {
      e.rangedCd = 12;
      // red card: telegraphed marker on the player, brief slow on verdict
      e.telegraph = Math.max(e.telegraph, 1.0);
      this.telegraph(this.player.x, this.player.y, 150, 1.0, 'flash', 10, 0);
    }
  }

  private updateCaptain(e: Enemy, nx: number, ny: number, dt: number): void {
    if (e.windup <= 0 && e.lungeT <= 0) {
      e.x += nx * e.speed * dt;
      e.y += ny * e.speed * dt;
    }
    this.bossMelee(e, nx, ny, Math.hypot(this.player.x - e.x, this.player.y - e.y) || 1, dt);
    e.bossCd -= dt;
    e.bossCd2 -= dt;
    if (e.bossCd <= 0) {
      e.bossCd = 5.5;
      // flare barrage: 3 flares aimed around player
      e.telegraph = Math.max(e.telegraph, 1.1);
      const p = this.player;
      for (let i = 0; i < 3; i++) {
        const tx = clamp(p.x + this.rng.range(-140, 140), 60, ARENA_W - 60);
        const ty = clamp(p.y + this.rng.range(-140, 140), 60, ARENA_H - 60);
        this.telegraph(tx, ty, 90, 1.1 + i * 0.25, 'flare');
      }
    }
    if (e.bossCd2 <= 0) {
      e.bossCd2 = 8;
      // charge: burst of speed via knockback-like impulse toward player
      e.kx += nx * 700;
      e.ky += ny * 700;
      this.events.push({ type: 'dash' });
    }
  }

  private updateDrumboss(e: Enemy, nx: number, ny: number, dt: number): void {
    if (e.windup <= 0 && e.lungeT <= 0) {
      e.x += nx * e.speed * dt;
      e.y += ny * e.speed * dt;
    }
    this.bossMelee(e, nx, ny, Math.hypot(this.player.x - e.x, this.player.y - e.y) || 1, dt);
    e.bossCd -= dt;
    e.bossCd2 -= dt;
    e.rangedCd -= dt;
    if (e.bossCd <= 0) {
      e.bossCd = 3.4;
      // drum shockwave, telegraphed around the drummer
      e.telegraph = Math.max(e.telegraph, 1.0);
      this.telegraph(e.x, e.y, 225, 1.0, 'shock', 16, 0);
    }
    if (e.bossCd2 <= 0) {
      e.bossCd2 = 8.5;
      // rally the drumline: 2 invaders + 1 sprinter join in
      for (let i = 0; i < 2; i++) {
        const a = this.rng.range(0, TAU);
        this.spawnEnemy(ENEMIES.invader, clamp(e.x + Math.cos(a) * 130, 40, ARENA_W - 40), clamp(e.y + Math.sin(a) * 130, 40, ARENA_H - 40), false);
      }
      const a = this.rng.range(0, TAU);
      this.spawnEnemy(ENEMIES.sprinter, clamp(e.x + Math.cos(a) * 160, 40, ARENA_W - 40), clamp(e.y + Math.sin(a) * 160, 40, ARENA_H - 40), false);
    }
    if (e.rangedCd <= 0) {
      e.rangedCd = 11;
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
    const bonus = Math.round(this.kills * 0.15 + (this.time / 60) * 6 + (won ? 100 : 0));
    return { time: this.time, kills: this.kills, level: this.player.level, coins: this.coins, bonus };
  }

  /** Debug/testing: force-spawn a specific enemy type at a position. */
  debugSpawn(id: keyof typeof ENEMIES, x: number, y: number, elite = false): void {
    this.spawnEnemy(ENEMIES[id], x, y, elite);
  }

  /** Debug/testing: grant XP through the real level-up path. */
  debugGiveXp(n: number): void {
    this.gainXp(n);
  }
}
