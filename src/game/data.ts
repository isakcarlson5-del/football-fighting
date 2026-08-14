/**
 * All game data: players, abilities, enemies, continuous pressure, meta-progression, skins.
 * Numbers are tuned for a 10-minute run (match clock maps 600s -> 90').
 */

export interface PlayerDef {
  id: string;
  name: string;
  number: number;
  nickname: string;
  /** Base stats */
  speed: number; // units/s
  maxHp: number;
  power: number; // damage multiplier
  /** Ability id granted at level 1 on run start */
  startAbility: AbilityId;
  trait: string;
  traitDesc: string;
  /** Visual identity */
  skin: number; // skin tone
  hair: string; // hair color
  hairStyle: 'short' | 'slick' | 'fade' | 'curl';
  beard: boolean;
  kit: { shirt: string; shorts: string; socks: string; trim: string };
}

export type AbilityId =
  | 'strike' | 'curveball' | 'bootseekers'
  | 'orbit' | 'whistle' | 'dash' | 'guard' | 'pressure' | 'blast' | 'keeperhalo';

/** Permanent base pace: responsive enough to thread late-game gaps while
 *  enemies retain pressure through density, charges and ranged attacks. */
export const PLAYER_PACE_MULT = 1.6;
export const ENEMY_PACE_MULT = 1.42;
export const FREEZE_DURATION = 4.0;

/** Attack-lane semantics: every offensive ability plays differently by lane. */
export type Lane = 'ground' | 'aerial' | 'hybrid';
export type RangeBand = 'near' | 'far';
export type Delivery = 'ring' | 'sweep' | 'trap' | 'lob' | 'direct' | 'barrage';
export type Force = 'none' | 'push' | 'pull';
export type AbilityRole =
  | 'directed-burst'
  | 'aerial-specialist'
  | 'boss-break'
  | 'sustained-clear'
  | 'rescue'
  | 'positioning'
  | 'defensive-timing'
  | 'aerial-denial'
  | 'zone-control'
  | 'hybrid-break';

export const ABILITY_ROLE_LABELS: Record<AbilityRole, string> = {
  'directed-burst': 'Directed burst',
  'aerial-specialist': 'Aerial specialist',
  'boss-break': 'Boss break',
  'sustained-clear': 'Sustained clear',
  rescue: 'Rescue tool',
  positioning: 'Positioning',
  'defensive-timing': 'Defensive timing',
  'aerial-denial': 'Aerial denial',
  'zone-control': 'Zone control',
  'hybrid-break': 'Hybrid break',
};

export interface AbilityLevel {
  desc: string;
}

export interface AbilityDef {
  id: AbilityId;
  name: string;
  icon: string; // short label used on procedural icon
  color: string;
  tagline: string;
  /** Attack-lane typing (ground hugs the pitch, aerial flies over near mobs). */
  lane: Lane;
  rangeBand: RangeBand;
  delivery: Delivery;
  force: Force;
  /** Unique decision role; two attractive cards should solve different match problems. */
  role: AbilityRole;
  levels: AbilityLevel[]; // length = max level
}

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  strike: {
    id: 'strike',
    name: 'Precision Strike',
    icon: 'PS',
    color: '#ffd166',
    tagline: 'Lobs footballs over the press onto distant high-priority threats.',
    lane: 'aerial',
    rangeBand: 'far',
    delivery: 'lob',
    force: 'none',
    role: 'directed-burst',
    levels: [
      { desc: 'AERIAL · Lob 1 ball at a distant threat (ranged first). 14 direct damage on impact.' },
      { desc: '+1 ball (2 total). Volleys spread across living targets.' },
      { desc: '20 damage, faster kicking.' },
      { desc: '+1 ball (3 total), tighter target distribution.' },
      { desc: 'MAX · Hat-Trick Relay: 4 balls, 28 damage, every landing ricochets to a second target.' },
    ],
  },
  curveball: {
    id: 'curveball',
    name: 'Curveball Swarm',
    icon: 'CS',
    color: '#47d7ff',
    tagline: 'A fan of bending footballs hunts priority threats beyond the press.',
    lane: 'aerial',
    rangeBand: 'far',
    delivery: 'barrage',
    force: 'none',
    role: 'aerial-specialist',
    levels: [
      { desc: 'AERIAL · Every 3.4s: 3 tracking curveballs hunt distant threats for 11 damage.' },
      { desc: '4 curveballs, 13 damage, tighter turns and smarter target spread.' },
      { desc: '16 damage; each ball chains once into another living threat.' },
      { desc: '5 faster curveballs, 18 damage, every 2.7s.' },
      { desc: 'MAX · Cyclone Swarm: 7 balls, 22 damage, two chains each and a damaging arc-burst on every hit.' },
    ],
  },
  bootseekers: {
    id: 'bootseekers',
    name: 'Golden Boot Seekers',
    icon: 'GB',
    color: '#ffbf36',
    tagline: 'Golden cleats arc over the crowd and crush the enemy back line.',
    lane: 'aerial',
    rangeBand: 'far',
    delivery: 'barrage',
    force: 'push',
    role: 'boss-break',
    levels: [
      { desc: 'AERIAL · Every 4.5s: a homing Golden Boot lands for 28 damage and a small airburst.' },
      { desc: 'Launch 2 boots. Splash grows and secondary targets take 55% damage.' },
      { desc: '38 damage, wider blast, stronger knockback and quicker tracking.' },
      { desc: 'Launch 3 boots every 3.6s; 42 damage and heavy back-line disruption.' },
      { desc: 'MAX · Finals Volley: 4 boots, 55 damage; every impact triggers a delayed golden aftershock.' },
    ],
  },
  orbit: {
    id: 'orbit',
    name: 'Orbiting Press',
    icon: 'OP',
    color: '#4cc9f0',
    tagline: 'Footballs circle you, pressing anyone who gets close.',
    lane: 'ground',
    rangeBand: 'near',
    delivery: 'ring',
    force: 'push',
    role: 'sustained-clear',
    levels: [
      { desc: 'GROUND · 2 balls orbit you. 10 damage on contact.' },
      { desc: '+1 orbiting ball (3 total).' },
      { desc: 'Wider orbit, 14 damage.' },
      { desc: '+1 orbiting ball (4 total), faster spin.' },
      { desc: 'MAX · Breakaway Orbit: 5 balls, huge knockback; a contact ball periodically launches as an aerial counter.' },
    ],
  },
  whistle: {
    id: 'whistle',
    name: "Captain's Whistle",
    icon: 'CW',
    color: '#f5f7fa',
    tagline: 'A periodic shockwave that blasts back a group of enemies.',
    lane: 'ground',
    rangeBand: 'near',
    delivery: 'ring',
    force: 'push',
    role: 'rescue',
    levels: [
      { desc: 'GROUND · Every 3.5s: shockwave, 15 damage, knocks enemies back.' },
      { desc: 'Bigger shockwave radius.' },
      { desc: '22 damage, blows every 3.0s.' },
      { desc: 'Huge radius, heavy knockback, brief stun.' },
      { desc: 'MAX · Echo Whistle: every 2.2s a 32-damage blast is followed by a second stunning pulse.' },
    ],
  },
  dash: {
    id: 'dash',
    name: 'Nutmeg Dash',
    icon: 'ND',
    color: '#80ed99',
    tagline: 'Press Space or the dash button to burst through danger along your locked movement line.',
    lane: 'ground',
    rangeBand: 'near',
    delivery: 'sweep',
    force: 'push',
    role: 'positioning',
    levels: [
      { desc: 'GROUND · ACTIVE: dash forward, 20 damage, untouchable during travel. 5s recharge.' },
      { desc: '30 damage and a longer committed run.' },
      { desc: 'Recharge reduced to 4s.' },
      { desc: 'Two deliberate dash charges; each requires a new press.' },
      { desc: 'MAX · Phantom Run: 3s recharge, 45 damage, leaves a persistent slowing nutmeg trail.' },
    ],
  },
  guard: {
    id: 'guard',
    name: 'Security Detail',
    icon: 'SD',
    color: '#ff6b6b',
    tagline: 'Calls in a bodyguard who protects you and flattens nearby threats.',
    lane: 'ground',
    rangeBand: 'near',
    delivery: 'direct',
    force: 'push',
    role: 'defensive-timing',
    levels: [
      { desc: 'GROUND · 1 bodyguard punches nearby threats. 12 damage.' },
      { desc: 'Bodyguard hits harder: 18 damage.' },
      { desc: '+1 bodyguard (2 total).' },
      { desc: 'Guards knock enemies back and body-block bottles.' },
      { desc: 'MAX · Lockdown Unit: 4 specialist guards, 30 damage, faster swings and every tackle cleaves nearby ground threats.' },
    ],
  },
  pressure: {
    id: 'pressure',
    name: 'Pitch Pressure',
    icon: 'PP',
    color: '#37d67a',
    tagline: 'An expanding pressure ring that stamps down and shoves close mobs back.',
    lane: 'ground',
    rangeBand: 'near',
    delivery: 'ring',
    force: 'push',
    role: 'zone-control',
    levels: [
      { desc: 'GROUND · Every 2.6s: expanding ring, 12 damage, shoves close enemies back.' },
      { desc: '18 damage, wider ring.' },
      { desc: 'Two staggered pulses per cast.' },
      { desc: '24 damage, huge ring, heavier shove.' },
      { desc: 'MAX · Terrace Vortex: drags the crowd inward, then detonates a 26-damage triple pulse.' },
    ],
  },
  blast: {
    id: 'blast',
    name: 'First Touch Blast',
    icon: 'FT',
    color: '#a8ff4d',
    tagline: 'A controlled touch detonates the pitch below and the air above.',
    lane: 'hybrid',
    rangeBand: 'near',
    delivery: 'ring',
    force: 'push',
    role: 'hybrid-break',
    levels: [
      { desc: 'HYBRID · Every 4.8s: 18-damage GROUND boom plus a 14-damage AERIAL airburst.' },
      { desc: 'Wider layers. Ground 24 damage, airburst 18.' },
      { desc: 'Airburst expands and hits for 25; ground boom hits for 27.' },
      { desc: 'Every 3.8s: 35 ground damage, 30 air damage, heavy shove.' },
      { desc: 'MAX · Perfect Touch: huge dual-layer blast followed by a delayed second overhead-and-ground detonation.' },
    ],
  },
  keeperhalo: {
    id: 'keeperhalo',
    name: "Keeper's Halo",
    icon: 'KH',
    color: '#5ee7e7',
    tagline: 'Goalkeeper shields orbit you and parry hostile aerial shots.',
    lane: 'aerial',
    rangeBand: 'near',
    delivery: 'ring',
    force: 'none',
    role: 'aerial-denial',
    levels: [
      { desc: 'AERIAL DEFENCE · 2 keeper shields orbit close and parry one hostile shot every 1.55s.' },
      { desc: '3 shields, wider coverage and a 1.2s parry recovery.' },
      { desc: '3 faster shields; parry recovery falls to 0.9s.' },
      { desc: '4 shields, wider halo and a 0.62s parry recovery.' },
      { desc: "MAX · Clean Sheet: 5 shields, 0.34s recovery; every parry counters the nearest aerial threat." },
    ],
  },
};

export const ABILITY_IDS: AbilityId[] = [
  'strike', 'curveball', 'bootseekers', 'orbit', 'whistle', 'dash', 'guard', 'pressure', 'blast', 'keeperhalo',
];

export const PLAYERS: PlayerDef[] = [
  {
    id: 'messi',
    name: 'Lionel Messi',
    number: 10,
    nickname: 'La Pulga',
    speed: 118,
    maxHp: 90,
    power: 1.0,
    startAbility: 'strike',
    trait: 'La Pulga',
    traitDesc: 'Precision Strike kicks +1 extra ball.',
    skin: 0xf0c8a0,
    hair: '#4a3222',
    hairStyle: 'short',
    beard: true,
    kit: { shirt: '#9fd8f0', shorts: '#ffffff', socks: '#9fd8f0', trim: '#ffffff' },
  },
  {
    id: 'ronaldo',
    name: 'Cristiano Ronaldo',
    number: 7,
    nickname: 'CR7',
    speed: 105,
    maxHp: 115,
    power: 1.15,
    startAbility: 'whistle',
    trait: 'Siuuu',
    traitDesc: 'Captain\u2019s Whistle has +25% radius. Hits like a truck.',
    skin: 0xd9a066,
    hair: '#1e1a16',
    hairStyle: 'slick',
    beard: false,
    kit: { shirt: '#c8102e', shorts: '#046a38', socks: '#c8102e', trim: '#046a38' },
  },
  {
    id: 'neymar',
    name: 'Neymar Jr',
    number: 10,
    nickname: 'Ney',
    speed: 126,
    maxHp: 80,
    power: 0.95,
    startAbility: 'dash',
    trait: 'Joga Bonito',
    traitDesc: 'Nutmeg Dash recharges 25% faster. Electric pace.',
    skin: 0xc68863,
    hair: '#242021',
    hairStyle: 'fade',
    beard: false,
    kit: { shirt: '#ffd23f', shorts: '#1c4fa1', socks: '#ffffff', trim: '#1c4fa1' },
  },
  {
    id: 'yamal',
    name: 'Lamine Yamal',
    number: 19,
    nickname: 'Golden Boy',
    speed: 112,
    maxHp: 85,
    power: 0.9,
    startAbility: 'orbit',
    trait: 'Golden Boy',
    traitDesc: 'Orbiting Press starts with +1 ball. +20% XP gain.',
    skin: 0xa06b42,
    hair: '#16120f',
    hairStyle: 'curl',
    beard: false,
    kit: { shirt: '#e8283f', shorts: '#1d3fae', socks: '#1d3fae', trim: '#f2c100' },
  },
];

/* ------------------------------------------------------------------ */
/* Enemies                                                             */
/* ------------------------------------------------------------------ */

export type EnemyId =
  | 'invader' | 'sprinter' | 'lobber' | 'flare' | 'flag' | 'foam' | 'drummer'
  | 'vuvuzela' | 'steward' | 'mascot' | 'banner' | 'paparazzo' | 'chant' | 'bull' | 'drone'
  | 'varcam'
  | 'official' | 'captain' | 'drumboss';

export type EnemyBehavior =
  | 'chase' // runs at the player and swings
  | 'ranged' // keeps distance, lobs bottles
  | 'leaper' // bounds through the air (ground effects miss mid-leap)
  | 'support' // aura that hastes nearby enemies; weak itself
  | 'thumper' // telegraphed drum shockwave around itself
  | 'cone' // keeps distance, vuvuzela blast shoves the player back
  | 'wall' // slow moving barricade, body-blocks lanes
  | 'flanker' // fast circler with a telegraphed blinding flash
  | 'summoner' // chant that rallies fresh invaders onto the pitch
  | 'charger' // telegraphed, direction-locked bull charge
  | 'aerial'; // hovering ranged troop; ground lanes pass underneath

export interface EnemyDef {
  id: EnemyId;
  name: string;
  hp: number;
  speed: number;
  damage: number;
  xp: number;
  radius: number; // collision radius
  /** seconds into the run when this type starts appearing */
  unlockAt: number;
  /** relative spawn weight once unlocked */
  weight: number;
  coinChance: number;
  behavior: EnemyBehavior;
  scale: number; // render scale
  /** melee shove inflicted on the player on hit (feel/counterplay) */
  push?: number;
}

export const ENEMIES: Record<Exclude<EnemyId, 'official' | 'captain' | 'drumboss'>, EnemyDef> = {
  invader: {
    id: 'invader', name: 'Pitch Invader', hp: 20, speed: 55, damage: 7, xp: 2,
    radius: 16, unlockAt: 0, weight: 100, coinChance: 0.22, behavior: 'chase', scale: 1,
  },
  sprinter: {
    id: 'sprinter', name: 'Scarf Sprinter', hp: 14, speed: 98, damage: 6, xp: 2,
    radius: 14, unlockAt: 25, weight: 55, coinChance: 0.2, behavior: 'chase', scale: 0.92,
  },
  lobber: {
    id: 'lobber', name: 'Bottle Lobber', hp: 17, speed: 52, damage: 7, xp: 2,
    radius: 15, unlockAt: 55, weight: 32, coinChance: 0.3, behavior: 'ranged', scale: 0.95,
  },
  flare: {
    id: 'flare', name: 'Flare Runner', hp: 22, speed: 88, damage: 8, xp: 3,
    radius: 15, unlockAt: 85, weight: 30, coinChance: 0.24, behavior: 'leaper', scale: 0.95,
  },
  flag: {
    id: 'flag', name: 'Flag Bearer', hp: 30, speed: 58, damage: 5, xp: 4,
    radius: 16, unlockAt: 120, weight: 24, coinChance: 0.26, behavior: 'support', scale: 1.15,
  },
  foam: {
    id: 'foam', name: 'Foam Finger Fan', hp: 55, speed: 44, damage: 13, xp: 3,
    radius: 18, unlockAt: 155, weight: 30, coinChance: 0.3, behavior: 'chase', scale: 1.18, push: 260,
  },
  steward: {
    id: 'steward', name: 'Rogue Steward', hp: 62, speed: 40, damage: 14, xp: 3,
    radius: 19, unlockAt: 190, weight: 30, coinChance: 0.38, behavior: 'chase', scale: 1.15, push: 200,
  },
  drummer: {
    id: 'drummer', name: 'Drumline Bruiser', hp: 85, speed: 36, damage: 16, xp: 5,
    radius: 20, unlockAt: 225, weight: 22, coinChance: 0.34, behavior: 'thumper', scale: 1.25,
  },
  vuvuzela: {
    id: 'vuvuzela', name: 'Vuvuzela Blaster', hp: 40, speed: 50, damage: 9, xp: 4,
    radius: 15, unlockAt: 270, weight: 24, coinChance: 0.3, behavior: 'cone', scale: 1.15,
  },
  mascot: {
    id: 'mascot', name: 'Rival Mascot', hp: 130, speed: 46, damage: 18, xp: 8,
    radius: 24, unlockAt: 315, weight: 14, coinChance: 0.6, behavior: 'chase', scale: 1.45, push: 300,
  },
  banner: {
    id: 'banner', name: 'Banner Wall', hp: 220, speed: 26, damage: 10, xp: 9,
    radius: 30, unlockAt: 360, weight: 12, coinChance: 0.5, behavior: 'wall', scale: 1.6,
  },
  paparazzo: {
    id: 'paparazzo', name: 'Flash Paparazzo', hp: 34, speed: 92, damage: 8, xp: 5,
    radius: 14, unlockAt: 405, weight: 20, coinChance: 0.3, behavior: 'flanker', scale: 0.9,
  },
  chant: {
    id: 'chant', name: 'Chant Leader', hp: 70, speed: 48, damage: 10, xp: 7,
    radius: 17, unlockAt: 460, weight: 14, coinChance: 0.4, behavior: 'summoner', scale: 1.05,
  },
  bull: {
    id: 'bull', name: 'Terrace Bull', hp: 190, speed: 62, damage: 24, xp: 11,
    radius: 28, unlockAt: 210, weight: 12, coinChance: 0.58, behavior: 'charger', scale: 1.48, push: 430,
  },
  drone: {
    id: 'drone', name: 'Shock Drone', hp: 78, speed: 74, damage: 14, xp: 8,
    radius: 20, unlockAt: 145, weight: 16, coinChance: 0.42, behavior: 'aerial', scale: 1.12,
  },
  varcam: {
    id: 'varcam', name: 'VAR Skycam', hp: 118, speed: 64, damage: 10, xp: 11,
    radius: 22, unlockAt: 330, weight: 9, coinChance: 0.5, behavior: 'aerial', scale: 1.22,
  },
};

export type BossId = 'drumboss' | 'official' | 'captain';
export type BossTier = 'minor' | 'major';

export interface BossDef {
  id: BossId;
  tier: BossTier;
  name: string;
  title: string;
  hp: number;
  speed: number;
  damage: number;
  xp: number;
  radius: number;
  coins: number;
  scale: number;
}

export const BOSSES: Record<BossId, BossDef> = {
  drumboss: {
    id: 'drumboss', tier: 'minor', name: 'The Riot Drummer', title: 'MINOR BOSS · 4:00', hp: 2200, speed: 57,
    damage: 26, xp: 80, radius: 38, coins: 120, scale: 2.08,
  },
  official: {
    id: 'official', tier: 'major', name: 'The Crooked Official', title: 'MINIBOSS · 7:00', hp: 4800, speed: 64,
    damage: 31, xp: 135, radius: 48, coins: 220, scale: 2.5,
  },
  captain: {
    id: 'captain', tier: 'major', name: 'The Ultra Captain', title: 'MAJOR BOSS · 9:00', hp: 6200, speed: 72,
    damage: 40, xp: 240, radius: 58, coins: 420, scale: 3,
  },
};

/* ------------------------------------------------------------------ */
/* Run pacing / difficulty                                             */
/* ------------------------------------------------------------------ */

export const RUN_LENGTH = 600; // seconds; maps to 90' on the match clock
export const BOSS0_AT = 240;
export const BOSS1_AT = 420;
export const BOSS2_AT = 540;

export interface CurvePoint {
  second: number;
  value: number;
}

/** Browser-safe version of the reference director. The supplied checkpoints
 *  are exact, including the inferred 30/s full-time value. Entity pools and
 *  per-step budgets remain the safety valve rather than flattening the curve. */
export const SPAWN_RATE_POINTS: readonly CurvePoint[] = [
  { second: 0, value: 0.6 },
  { second: 120, value: 1.9 },
  { second: 300, value: 6.5 },
  { second: 450, value: 14 },
  { second: 600, value: 30 },
];

export const HP_SCALE_POINTS: readonly CurvePoint[] = [
  { second: 0, value: 0.82 },
  { second: 120, value: 0.95 },
  { second: 300, value: 3.2 },
  { second: 450, value: 5.8 },
  { second: 600, value: 9.2 },
];

export const DAMAGE_SCALE_POINTS: readonly CurvePoint[] = [
  { second: 0, value: 0.76 },
  { second: 120, value: 0.9 },
  { second: 300, value: 1.25 },
  { second: 450, value: 1.7 },
  { second: 600, value: 2.3 },
];

export const SPEED_SCALE_POINTS: readonly CurvePoint[] = [
  { second: 0, value: 1 },
  { second: 120, value: 1.05 },
  { second: 300, value: 1.16 },
  { second: 450, value: 1.25 },
  { second: 600, value: 1.35 },
];

function smoothstep01(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function sampleCurve(points: readonly CurvePoint[], second: number): number {
  const t = Math.max(0, second);
  if (t <= points[0].second) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const next = points[i];
    if (t > next.second) continue;
    const previous = points[i - 1];
    const span = Math.max(0.001, next.second - previous.second);
    const blend = smoothstep01((t - previous.second) / span);
    return previous.value + (next.value - previous.value) * blend;
  }
  return points[points.length - 1].value;
}

function endlessMinutes(t: number): number {
  return Math.max(0, (t - RUN_LENGTH) / 60);
}

/** Normalized live build strength. It uses ranks rather than DPS so the
 *  curve remains deterministic and cannot oscillate during a fight. */
export function powerPressure(abilityRanks: number, statRanks: number): number {
  return Math.max(0, Math.min(1, (Math.max(0, abilityRanks - 1) + statRanks * 0.55) / 26));
}

/** Convex run progress keeps the opening readable, then steepens once a build
 *  has enough upgrades to clear dense groups. */
export function difficultyProgress(t: number): number {
  const u = Math.max(0, Math.min(1, t / RUN_LENGTH));
  return 0.18 * u + 0.82 * Math.pow(u, 2.25);
}

/** Enemy hp multiplier over run time and current build strength. Pressure is
 *  intentionally modest: the clock remains the primary source of difficulty. */
export function hpScale(t: number, pressure = 0): number {
  const endless = 1 + endlessMinutes(t) * 0.1;
  return sampleCurve(HP_SCALE_POINTS, t) * endless * (1 + Math.max(0, Math.min(1, pressure)) * 0.18);
}

/** Continuous enemies-per-second director curve. After full time the base
 *  grows linearly by 10% per minute, with the reference endless +0.8/s ramp. */
export function spawnRate(t: number, pressure = 0): number {
  const minutes = endlessMinutes(t);
  const base = sampleCurve(SPAWN_RATE_POINTS, t) * (1 + minutes * 0.1) + minutes * 0.8;
  return base * (1 + Math.max(0, Math.min(1, pressure)) * 0.18);
}

/** Compatibility helper for tooling that reasons in spawn intervals. */
export function spawnInterval(t: number, pressure = 0): number {
  return 1 / spawnRate(t, pressure);
}

/** Contact damage starts forgiving and catches up to high-output builds. */
export function enemyDamageScale(t: number, pressure = 0): number {
  const endless = 1 + endlessMinutes(t) * 0.1;
  return sampleCurve(DAMAGE_SCALE_POINTS, t) * endless * (1 + Math.max(0, Math.min(1, pressure)) * 0.08);
}

/** Movement pressure rises more gently than health/density to preserve dodges. */
export function enemySpeedScale(t: number, pressure = 0): number {
  const endless = Math.min(1.55, sampleCurve(SPEED_SCALE_POINTS, t) * (1 + endlessMinutes(t) * 0.05));
  return endless * (1 + Math.max(0, Math.min(1, pressure)) * 0.03);
}

/** Seconds between elite spawns. */
export function eliteInterval(t: number, _pressure = 0): number {
  return Math.max(22, 52 - (Math.max(0, t) / 60) * 3);
}

/** Time-sensitive roster weight. New archetypes fade in rather than appearing
 *  as a hard wave, while old fodder remains present in smaller numbers. */
export function enemySpawnWeight(def: EnemyDef, t: number): number {
  if (t < def.unlockAt) return 0;
  const age = Math.max(0, t - def.unlockAt);
  const unlockRamp = 0.2 + smoothstep01(age / 20) * 0.8;
  const fade = age <= 180 ? 1 : Math.max(0.38, 1 - ((age - 180) / 420) * 0.62);
  const specialistFloor = ['ranged', 'support', 'wall', 'flanker', 'summoner', 'charger', 'aerial'].includes(def.behavior)
    ? 0.65
    : 0.38;
  return def.weight * unlockRamp * Math.max(specialistFloor, fade);
}

/** XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return Math.round(3 + level * 4 + Math.pow(level, 1.6) * 2);
}

/* ------------------------------------------------------------------ */
/* Stat upgrades offered in the level-up pool                          */
/* ------------------------------------------------------------------ */

export type StatId = 'power' | 'speed' | 'maxhp' | 'regen' | 'magnet' | 'armor';

export interface StatDef {
  id: StatId;
  name: string;
  color: string;
  desc: string;
  max: number;
}

export const STATS: Record<StatId, StatDef> = {
  power: { id: 'power', name: 'Shot Power', color: '#ffd166', desc: '+8% all damage.', max: 10 },
  speed: { id: 'speed', name: 'Fresh Boots', color: '#80ed99', desc: '+5% move speed.', max: 6 },
  maxhp: { id: 'maxhp', name: 'Captain\u2019s Heart', color: '#ff6b6b', desc: '+15 max HP, heal 15.', max: 8 },
  regen: { id: 'regen', name: 'Energy Gel', color: '#f5f7fa', desc: '+0.4 HP/s regeneration.', max: 6 },
  magnet: { id: 'magnet', name: 'Ball Magnet', color: '#4cc9f0', desc: '+18% pickup radius.', max: 6 },
  armor: { id: 'armor', name: 'Shin Pads', color: '#b08968', desc: '-1 damage taken (min 1).', max: 5 },
};

export const STAT_IDS: StatId[] = ['power', 'speed', 'maxhp', 'regen', 'magnet', 'armor'];

/* ------------------------------------------------------------------ */
/* Meta progression (permanent, bought with coins between runs)        */
/* ------------------------------------------------------------------ */

export type MetaTrackId = 'power' | 'move' | 'magnet' | 'guard';

export interface MetaTrack {
  id: MetaTrackId;
  name: string;
  desc: string;
  maxRank: number;
  baseCost: number;
  /** value added per rank */
  per: number;
  unit: string;
}

export const META_TRACKS: MetaTrack[] = [
  { id: 'power', name: 'Power Training', desc: 'Permanent damage bonus.', maxRank: 5, baseCost: 50, per: 6, unit: '% damage' },
  { id: 'move', name: 'Pace Training', desc: 'Permanent move speed bonus.', maxRank: 5, baseCost: 50, per: 4, unit: '% speed' },
  { id: 'magnet', name: 'Ball Control', desc: 'Permanent XP pickup radius.', maxRank: 5, baseCost: 40, per: 15, unit: '% radius' },
  { id: 'guard', name: 'Security Budget', desc: 'Bodyguards hit harder. Rank 3 and 5 add a bodyguard.', maxRank: 5, baseCost: 60, per: 12, unit: '% guard damage' },
];

export function metaCost(track: MetaTrack, rank: number): number {
  return Math.round(track.baseCost * Math.pow(2.1, rank));
}

/* ------------------------------------------------------------------ */
/* Cosmetic skins (alternate kits)                                     */
/* ------------------------------------------------------------------ */

export interface SkinDef {
  id: string;
  player: string; // PlayerDef id
  name: string;
  cost: number;
  kit: { shirt: string; shorts: string; socks: string; trim: string };
}

export const SKINS: SkinDef[] = [
  { id: 'messi_away', player: 'messi', name: 'Midnight Away', cost: 150, kit: { shirt: '#1b1f2a', shorts: '#1b1f2a', socks: '#1b1f2a', trim: '#9fd8f0' } },
  { id: 'messi_retro', player: 'messi', name: 'Rosario Retro', cost: 300, kit: { shirt: '#d5002d', shorts: '#0b1f3a', socks: '#0b1f3a', trim: '#ffd23f' } },
  { id: 'ronaldo_white', player: 'ronaldo', name: 'All-White Galactico', cost: 150, kit: { shirt: '#f5f5f5', shorts: '#f5f5f5', socks: '#f5f5f5', trim: '#c9a227' } },
  { id: 'ronaldo_green', player: 'ronaldo', name: 'Selecao Away', cost: 300, kit: { shirt: '#046a38', shorts: '#c8102e', socks: '#046a38', trim: '#f5f5f5' } },
  { id: 'neymar_santos', player: 'neymar', name: 'Santos Classic', cost: 150, kit: { shirt: '#f5f5f5', shorts: '#111111', socks: '#f5f5f5', trim: '#111111' } },
  { id: 'neymar_samba', player: 'neymar', name: 'Samba Night', cost: 300, kit: { shirt: '#0aa84f', shorts: '#ffd23f', socks: '#0aa84f', trim: '#ffd23f' } },
  { id: 'yamal_away', player: 'yamal', name: 'La Roja Away', cost: 150, kit: { shirt: '#f2c100', shorts: '#e8283f', socks: '#f2c100', trim: '#e8283f' } },
  { id: 'yamal_street', player: 'yamal', name: 'Street League', cost: 300, kit: { shirt: '#7b2ff7', shorts: '#1b1f2a', socks: '#7b2ff7', trim: '#f2c100' } },
];
