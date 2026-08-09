/**
 * Game simulation: pure logic, no DOM/canvas access (unit-testable).
 * Fixed-step updated from main.ts; render.ts only reads state.
 */

import { Rng, weightedPick } from '../core/rng';
import { clamp, dist2, TAU } from '../core/math';
import {
  ABILITIES,
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
  type EnemyDef,
  type PlayerDef,
  type StatId,
} from './data';
import type { Save } from './meta';

export const ARENA_W = 2600;
export const ARENA_H = 1700;
const MAX_ENEMIES = 240;
const CELL = 72;

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
  boss: '' | 'referee' | 'captain';
  kx: number; // knockback velocity
  ky: number;
  flash: number;
  attackCd: number;
  orbitCd: number;
  dashMark: number; // dash id that already hit this enemy
  stun: number;
  slow: number;
  face: number; // -1 | 1
  animT: number;
  rangedCd: number;
  // boss ability timers
  bossCd: number;
  bossCd2: number;
  telegraph: number; // 0 = none, else seconds remaining of visible telegraph
}

export interface Ball {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dmg: number;
  pierce: number;
  ricochet: number;
  life: number;
  spin: number;
  hitSet: number[]; // enemy indexes already hit (pierce)
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
  kind: 'xp' | 'coin';
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
  kind: 'flare' | 'shock';
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

export type SimEvent =
  | { type: 'hit'; x: number; y: number }
  | { type: 'kill'; x: number; y: number; elite: boolean }
  | { type: 'kick' }
  | { type: 'xp' }
  | { type: 'coin' }
  | { type: 'levelup' }
  | { type: 'whistle'; x: number; y: number }
  | { type: 'dash' }
  | { type: 'hurt' }
  | { type: 'punch' }
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
  abilities: Partial<Record<AbilityId, number>>;
  stats: Record<StatId, number>;
  // ability timers
  strikeCd: number;
  whistleCd: number;
  whistlePulse: number;
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
  events: SimEvent[] = [];
  pendingLevelups = 0;
  boss1Spawned = false;
  boss2Spawned = false;
  bossAlive: Enemy | null = null;
  slowZones: { x: number; y: number; r: number; t: number }[] = [];
  flareZones: { x: number; y: number; r: number; t: number; tick: number }[] = [];

  private grid = new Map<number, number[]>();
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
      abilities: { [def.startAbility]: 1 },
      stats: { power: 0, speed: 0, maxhp: 0, regen: 0, magnet: 0, armor: 0 },
      strikeCd: 0.4,
      whistleCd: 2,
      whistlePulse: -1,
      dashCds: [0],
      dashT: 0,
      dashDx: 1,
      dashDy: 0,
      dashId: 0,
      orbitAngle: 0,
    };
    if (def.id === 'neymar') this.player.dashCds = [0];
    this.spawnInitial();
    // opening wave: a few hooligans just past the view edge so first contact
    // happens within ~3 seconds instead of an empty pitch
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.6;
      this.spawnEnemy(ENEMIES.hooligan, this.player.x + Math.cos(a) * 520, this.player.y + Math.sin(a) * 520, false);
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
    return 115 * this.magnetMult * (1 + this.player.stats.magnet * 0.25);
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
        active: false, def: ENEMIES.hooligan, x: 0, y: 0, hp: 1, maxHp: 1, speed: 0, damage: 0,
        radius: 10, xp: 1, elite: false, boss: '', kx: 0, ky: 0, flash: 0, attackCd: 0, orbitCd: 0,
        dashMark: -1, stun: 0, slow: 0, face: 1, animT: 0, rangedCd: 2, bossCd: 4, bossCd2: 8, telegraph: 0,
      });
    }
    for (let i = 0; i < 400; i++) this.balls.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, dmg: 0, pierce: 0, ricochet: 0, life: 0, spin: 0, hitSet: [] });
    for (let i = 0; i < 200; i++) this.bottles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, dmg: 0, life: 0 });
    for (let i = 0; i < 500; i++) this.pickups.push({ active: false, kind: 'xp', tier: 1, x: 0, y: 0, vx: 0, vy: 0, value: 1, t: 0 });
    for (let i = 0; i < 600; i++) this.particles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: '#fff', grav: 0 });
    for (let i = 0; i < 120; i++) this.dmgNums.push({ active: false, x: 0, y: 0, value: '', life: 0, crit: false });
    for (let i = 0; i < 16; i++) this.telegraphs.push({ active: false, x: 0, y: 0, r: 0, t: 0, max: 1, kind: 'flare' });
    for (let i = 0; i < 16; i++) this.rings.push({ active: false, x: 0, y: 0, r: 0, maxR: 100, life: 0, color: '#fff' });
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
    e.attackCd = 0;
    e.orbitCd = 0;
    e.dashMark = -1;
    e.stun = 0;
    e.slow = 0;
    e.animT = this.rng.range(0, 1);
    e.rangedCd = this.rng.range(1, 2.6);
    e.telegraph = 0;
    return e;
  }

  private spawnBoss(which: 'referee' | 'captain'): void {
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
    e.attackCd = 0;
    e.orbitCd = 0;
    e.dashMark = -1;
    e.stun = 0;
    e.slow = 0;
    e.animT = 0;
    e.rangedCd = 2;
    e.bossCd = 5;
    e.bossCd2 = 9;
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
    e.kx += kx;
    e.ky += ky;
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
    this.burst(e.x, e.y, e.boss ? 26 : e.elite ? 14 : 6, e.boss ? '#ffd23f' : '#e8b88a');
    this.events.push({ type: 'kill', x: e.x, y: e.y, elite: e.elite || !!e.boss });
    if (e.boss) {
      const def = BOSSES[e.boss];
      this.coins += def.coins;
      this.bossAlive = null;
      this.events.push({ type: 'bossDie', x: e.x, y: e.y, coins: def.coins });
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

  private hurtPlayer(raw: number): void {
    const p = this.player;
    if (p.iframes > 0 || p.dashT > 0 || this.over !== 'playing') return;
    const dmg = Math.max(1, Math.round(raw - this.armor));
    p.hp -= dmg;
    p.iframes = 0.55;
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

  private telegraph(x: number, y: number, r: number, delay: number, kind: 'flare' | 'shock'): void {
    const t = this.alloc(this.telegraphs);
    if (!t) return;
    t.active = true;
    t.x = x;
    t.y = y;
    t.r = r;
    t.t = delay;
    t.max = delay;
    t.kind = kind;
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
        tx: 0, ty: 0, swingCd: 0, face: 1, animT: 0, target: -1,
      });
    }
  }

  /* ---------------- abilities ---------------- */

  private fireStrike(): void {
    const lvl = this.abilityLevel('strike');
    if (lvl === 0) return;
    const p = this.player;
    const count = [0, 1, 2, 2, 3, 4][lvl] + (this.def.id === 'messi' ? 1 : 0);
    const dmg = [0, 12, 12, 18, 18, 26][lvl] * this.damageMult;
    const pierce = lvl >= 4 ? 1 : 0;
    const ric = lvl >= 5 ? 1 : 0;
    // aim at nearest, spread additional balls
    const near = this.nearestEnemy(p.x, p.y, 700);
    const baseA = near >= 0 ? Math.atan2(this.enemies[near].y - p.y, this.enemies[near].x - p.x) : this.rng.range(0, TAU);
    for (let i = 0; i < count; i++) {
      const b = this.alloc(this.balls);
      if (!b) return;
      const a = baseA + (i - (count - 1) / 2) * 0.22;
      b.active = true;
      b.x = p.x;
      b.y = p.y;
      b.vx = Math.cos(a) * 460;
      b.vy = Math.sin(a) * 460;
      b.dmg = dmg;
      b.pierce = pierce;
      b.ricochet = ric;
      b.life = 1.15;
      b.spin = this.rng.range(6, 12);
      b.hitSet.length = 0;
    }
    this.events.push({ type: 'kick' });
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
    for (let i = 0; i < p.dashCds.length; i++) p.dashCds[i] -= dt;
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
      const sp = this.moveSpeed;
      p.x += ax * sp * dt;
      p.y += ay * sp * dt;
    }
    p.x = clamp(p.x, 30, ARENA_W - 30);
    p.y = clamp(p.y, 30, ARENA_H - 30);
    p.animT += dt * (p.moving || p.dashT > 0 ? 1 : 0.4);

    /* abilities */
    if (p.strikeCd <= 0 && this.abilityLevel('strike') > 0) {
      const lvl = this.abilityLevel('strike');
      p.strikeCd = [0, 0.9, 0.9, 0.8, 0.8, 0.65][lvl];
      if (this.nearestEnemy(p.x, p.y, 700) >= 0) this.fireStrike();
    }
    if (p.whistleCd <= 0 && this.abilityLevel('whistle') > 0) {
      const lvl = this.abilityLevel('whistle');
      p.whistleCd = [0, 3.5, 3.5, 3.0, 3.0, 2.2][lvl];
      this.fireWhistle();
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
          if (e.orbitCd > 0) continue;
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
    // bosses
    if (!this.boss1Spawned && this.time >= BOSS1_AT) {
      this.boss1Spawned = true;
      this.spawnBoss('referee');
    }
    if (!this.boss2Spawned && this.time >= BOSS2_AT) {
      this.boss2Spawned = true;
      this.spawnBoss('captain');
    }

    /* enemies */
    this.rebuildGrid();
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.active) continue;
      e.flash = Math.max(0, e.flash - dt);
      e.attackCd = Math.max(0, e.attackCd - dt);
      e.orbitCd = Math.max(0, e.orbitCd - dt);
      e.stun = Math.max(0, e.stun - dt);
      e.animT += dt;
      // knockback decay
      e.x += e.kx * dt;
      e.y += e.ky * dt;
      e.kx *= Math.pow(0.001, dt);
      e.ky *= Math.pow(0.001, dt);
      e.x = clamp(e.x, 20, ARENA_W - 20);
      e.y = clamp(e.y, 20, ARENA_H - 20);
      if (e.stun > 0) continue;

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

      if (e.boss === 'referee') {
        this.updateReferee(e, dx / d, dy / d, dt);
      } else if (e.boss === 'captain') {
        this.updateCaptain(e, dx / d, dy / d, dt);
      } else if (e.def.behavior === 'ranged') {
        // keep distance, throw bottles
        const want = 240;
        const mv = d > want + 30 ? 1 : d < want - 40 ? -1 : 0;
        e.x += (dx / d) * e.speed * mv * slowMult * dt;
        e.y += (dy / d) * e.speed * mv * slowMult * dt;
        e.rangedCd -= dt;
        if (e.rangedCd <= 0 && d < 480) {
          e.rangedCd = 2.4;
          const b = this.alloc(this.bottles);
          if (b) {
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
        }
      } else {
        // Orbiting Press: enemies inside the ring are constantly pushed out
        let press = 0;
        if (orbitLvl > 0) {
          const ringR = [0, 90, 90, 115, 115, 140][orbitLvl];
          if (d < ringR) press = 36;
        }
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
        e.x += ((dx / d) * (e.speed * slowMult - press) + sx) * dt;
        e.y += ((dy / d) * (e.speed * slowMult - press) + sy) * dt;
      }

      // contact damage
      if (e.attackCd <= 0 && dist2(e.x, e.y, p.x, p.y) < (e.radius + 18) * (e.radius + 18)) {
        e.attackCd = 0.8;
        this.hurtPlayer(e.damage);
      }
    }

    /* balls */
    for (const b of this.balls) {
      if (!b.active) continue;
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.life <= 0 || b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) {
        b.active = false;
        continue;
      }
      const n = this.query(b.x, b.y, 34, this.scratch);
      for (let i = 0; i < n; i++) {
        const idx = this.scratch[i];
        const e = this.enemies[idx];
        if (!e.active || b.hitSet.includes(idx)) continue;
        if (dist2(b.x, b.y, e.x, e.y) < (e.radius + 10) * (e.radius + 10)) {
          const d = Math.hypot(e.x - b.x, e.y - b.y) || 1;
          this.damageEnemy(idx, b.dmg, ((e.x - b.x) / d) * 160, ((e.y - b.y) / d) * 160);
          if (b.pierce > 0) {
            b.pierce--;
            b.hitSet.push(idx);
          } else if (b.ricochet > 0) {
            b.ricochet--;
            b.hitSet.push(idx);
            const ni = this.nearestEnemy(e.x, e.y, 300);
            if (ni >= 0 && !b.hitSet.includes(ni)) {
              const ne = this.enemies[ni];
              const dd = Math.hypot(ne.x - b.x, ne.y - b.y) || 1;
              b.vx = ((ne.x - b.x) / dd) * 460;
              b.vy = ((ne.y - b.y) / dd) * 460;
              b.life = Math.max(b.life, 0.6);
            } else {
              b.active = false;
            }
          } else {
            b.active = false;
          }
          break;
        }
      }
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
        g.swingCd = Math.max(0, g.swingCd - dt);
        g.animT += dt;
        // acquire target near player
        let ti = g.target;
        if (ti < 0 || !this.enemies[ti]?.active) {
          ti = this.nearestEnemy(p.x, p.y, 340);
          g.target = ti;
        }
        let tx = p.x + Math.cos((gi / this.guards.length) * TAU + p.animT * 0.3) * 55;
        let ty = p.y + Math.sin((gi / this.guards.length) * TAU + p.animT * 0.3) * 55;
        if (ti >= 0) {
          const e = this.enemies[ti];
          tx = e.x;
          ty = e.y;
          const dd = Math.hypot(e.x - g.x, e.y - g.y);
          if (dd < e.radius + 24 && g.swingCd <= 0) {
            g.swingCd = swingCd;
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
      });
    }

    /* boss telegraphs & zones */
    for (const t of this.telegraphs) {
      if (!t.active) continue;
      t.t -= dt;
      if (t.t <= 0) {
        t.active = false;
        if (t.kind === 'flare') {
          this.flareZones.push({ x: t.x, y: t.y, r: t.r, t: 2.6, tick: 0 });
          this.burst(t.x, t.y, 14, '#ff9a3d');
          this.events.push({ type: 'flare' });
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
        const pull = pk.kind === 'coin' ? 500 : 420;
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

  private updateReferee(e: Enemy, nx: number, ny: number, dt: number): void {
    e.x += nx * e.speed * dt;
    e.y += ny * e.speed * dt;
    e.bossCd -= dt;
    e.bossCd2 -= dt;
    if (e.bossCd <= 0) {
      e.bossCd = 6;
      e.telegraph = 0.9;
      // whistle shockwave after telegraph
      this.deferred.push({
        t: 0.9,
        fn: () => {
          if (!e.active) return;
          e.telegraph = 0;
          const p = this.player;
          this.ring(e.x, e.y, 230, '#e8283f');
          this.events.push({ type: 'whistle', x: e.x, y: e.y });
          if (dist2(p.x, p.y, e.x, e.y) < 230 * 230) this.hurtPlayer(18);
        },
      });
    }
    if (e.bossCd2 <= 0) {
      e.bossCd2 = 9;
      // book the crowd: summon 4 hooligans
      for (let i = 0; i < 4; i++) {
        const a = this.rng.range(0, TAU);
        this.spawnEnemy(ENEMIES.hooligan, clamp(e.x + Math.cos(a) * 120, 40, ARENA_W - 40), clamp(e.y + Math.sin(a) * 120, 40, ARENA_H - 40), false);
      }
    }
  }

  private updateCaptain(e: Enemy, nx: number, ny: number, dt: number): void {
    e.x += nx * e.speed * dt;
    e.y += ny * e.speed * dt;
    e.bossCd -= dt;
    e.bossCd2 -= dt;
    if (e.bossCd <= 0) {
      e.bossCd = 5.5;
      // flare barrage: 3 flares aimed around player
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

