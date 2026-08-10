/**
 * All game data: players, abilities, enemies, waves, meta-progression, skins.
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
  | 'orbit' | 'whistle' | 'dash' | 'guard' | 'pressure' | 'blast';

/** The pace pass deliberately gives the player a small reaction advantage. */
export const PLAYER_PACE_MULT = 1.3;
export const ENEMY_PACE_MULT = 1.25;

/** Attack-lane semantics: every offensive ability plays differently by lane. */
export type Lane = 'ground' | 'aerial' | 'hybrid';
export type RangeBand = 'near' | 'far';
export type Delivery = 'ring' | 'sweep' | 'trap' | 'lob' | 'direct' | 'barrage';
export type Force = 'none' | 'push' | 'pull';

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
    levels: [
      { desc: 'AERIAL · Lob 1 ball at a distant threat (ranged first). 14 damage splash on landing.' },
      { desc: '+1 ball (2 total). Volleys spread across living targets.' },
      { desc: '20 damage, faster kicking.' },
      { desc: '+1 ball (3 total), wider landing splash.' },
      { desc: '4 balls, 28 damage, balls ricochet on to a second target.' },
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
    levels: [
      { desc: 'AERIAL · Every 3.4s: 3 tracking curveballs hunt distant threats for 11 damage.' },
      { desc: '4 curveballs, 13 damage, tighter turns and smarter target spread.' },
      { desc: '16 damage; each ball chains once into another living threat.' },
      { desc: '5 faster curveballs, 18 damage, every 2.7s.' },
      { desc: 'Golden curve: 7 balls, 22 damage, one chain each, every 2.35s.' },
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
    levels: [
      { desc: 'AERIAL · Every 4.5s: a homing Golden Boot lands for 28 damage and a small airburst.' },
      { desc: 'Launch 2 boots. Splash grows and secondary targets take 55% damage.' },
      { desc: '38 damage, wider blast, stronger knockback and quicker tracking.' },
      { desc: 'Launch 3 boots every 3.6s; 42 damage and heavy back-line disruption.' },
      { desc: 'Finals volley: 4 boots, 55 damage, huge airbursts every 3.1s.' },
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
    levels: [
      { desc: 'GROUND · 2 balls orbit you. 10 damage on contact.' },
      { desc: '+1 orbiting ball (3 total).' },
      { desc: 'Wider orbit, 14 damage.' },
      { desc: '+1 orbiting ball (4 total), faster spin.' },
      { desc: '5 balls, huge orbit, 20 damage, hits knock enemies back.' },
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
    levels: [
      { desc: 'GROUND · Every 3.5s: shockwave, 15 damage, knocks enemies back.' },
      { desc: 'Bigger shockwave radius.' },
      { desc: '22 damage, blows every 3.0s.' },
      { desc: 'Huge radius, heavy knockback, brief stun.' },
      { desc: 'Every 2.2s: double pulse, 32 damage.' },
    ],
  },
  dash: {
    id: 'dash',
    name: 'Nutmeg Dash',
    icon: 'ND',
    color: '#80ed99',
    tagline: 'A burst of speed straight through danger, hitting everything in the way.',
    lane: 'ground',
    rangeBand: 'near',
    delivery: 'sweep',
    force: 'push',
    levels: [
      { desc: 'GROUND · Every 5s: dash forward, 20 damage, untouchable mid-dash.' },
      { desc: '30 damage, longer dash.' },
      { desc: 'Every 4s.' },
      { desc: 'Two dash charges.' },
      { desc: 'Every 3s, 45 damage, dash leaves a slowing nutmeg trail.' },
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
    levels: [
      { desc: 'GROUND · 1 bodyguard punches nearby threats. 12 damage.' },
      { desc: 'Bodyguard hits harder: 18 damage.' },
      { desc: '+1 bodyguard (2 total).' },
      { desc: 'Guards knock enemies back and body-block bottles.' },
      { desc: '+1 bodyguard (3 total), 30 damage, faster swings.' },
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
    levels: [
      { desc: 'GROUND · Every 2.6s: expanding ring, 12 damage, shoves close enemies back.' },
      { desc: '18 damage, wider ring.' },
      { desc: 'Two staggered pulses per cast.' },
      { desc: '24 damage, huge ring, heavier shove.' },
      { desc: 'Vortex: drags the crowd in, then detonates a 26-damage triple pulse.' },
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
    levels: [
      { desc: 'HYBRID · Every 4.8s: 18-damage GROUND boom plus a 14-damage AERIAL airburst.' },
      { desc: 'Wider layers. Ground 24 damage, airburst 18.' },
      { desc: 'Airburst expands and hits for 25; ground boom hits for 27.' },
      { desc: 'Every 3.8s: 35 ground damage, 30 air damage, heavy shove.' },
      { desc: 'Perfect touch: huge 46-damage ground blast and 42-damage overhead detonation every 3.2s.' },
    ],
  },
};

export const ABILITY_IDS: AbilityId[] = [
  'strike', 'curveball', 'bootseekers', 'orbit', 'whistle', 'dash', 'guard', 'pressure', 'blast',
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
  | 'vuvuzela' | 'steward' | 'mascot' | 'banner' | 'paparazzo' | 'chant'
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
  | 'summoner'; // chant that rallies fresh invaders onto the pitch

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
};

export type BossId = 'drumboss' | 'official' | 'captain';

export interface BossDef {
  id: BossId;
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
    id: 'drumboss', name: 'The Riot Drummer', title: 'FIRST-QUARTER BOSS', hp: 900, speed: 55,
    damage: 20, xp: 40, radius: 28, coins: 60, scale: 1.55,
  },
  official: {
    id: 'official', name: 'The Crooked Official', title: 'HALF-TIME BOSS', hp: 1400, speed: 62,
    damage: 22, xp: 60, radius: 26, coins: 80, scale: 1.5,
  },
  captain: {
    id: 'captain', name: 'The Ultra Captain', title: 'FINAL BOSS', hp: 3200, speed: 70,
    damage: 28, xp: 150, radius: 30, coins: 200, scale: 1.7,
  },
};

/* ------------------------------------------------------------------ */
/* Run pacing / difficulty                                             */
/* ------------------------------------------------------------------ */

export const RUN_LENGTH = 600; // seconds; maps to 90' on the match clock
export const BOSS0_AT = 150;
export const BOSS1_AT = 300;
export const BOSS2_AT = 540;

/** Enemy hp multiplier over run time (seconds). */
export function hpScale(t: number): number {
  const m = t / 60;
  return 1 + m * 0.27 + m * m * 0.02;
}

/** Spawn interval seconds, shrinking over the run. */
export function spawnInterval(t: number): number {
  const u = Math.min(1, t / RUN_LENGTH);
  return 1.25 - u * 0.87; // 1.25s -> 0.38s
}

/** Enemies per spawn tick. */
export function spawnBatch(t: number): number {
  const u = Math.min(1, t / RUN_LENGTH);
  return 1 + Math.floor(u * 5.2); // 1 -> 6
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
  magnet: { id: 'magnet', name: 'Ball Magnet', color: '#4cc9f0', desc: '+25% pickup radius.', max: 6 },
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
