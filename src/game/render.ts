/**
 * 2.5D oblique renderer: world (x,y) -> screen with vertical tilt.
 * The pitch + stadium surroundings are prerendered once to an offscreen
 * canvas; entities are billboard sprites sorted by depth (painter's algorithm).
 */

import { clamp, TAU } from '../core/math';
import {
  ballSprite,
  bossAtlas,
  bottleSprite,
  coinSprite,
  drinkSprite,
  enemyAtlas,
  getStripAtlas,
  guardAtlas,
  loadStripAtlas,
  playerAtlas,
  trimStripAtlasCache,
  trophySprite,
  xpSprite,
  type Atlas,
} from '../core/sprites';
import { BOSSES, ENEMIES, FREEZE_DURATION, SKINS, type BossId, type EnemyDef, type PlayerDef } from './data';
import { ARENA_H, ARENA_W, KICK_DURATION, type Enemy, type Guard, type Sim } from './sim';
import type { Save } from './meta';

const TILT = 0.62;
const MARGIN = 340; // stands width around pitch (world units) — procedural fallback only
const PLAYER_ENTITY_SCALE = 1.68;
const ENEMY_ENTITY_SCALE = 1.52;
const ALLY_ENTITY_SCALE = 1.56;
export interface ArenaGrassRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Conservative grass rect inside the sharp arena plate (source px,
 *  1536x1024). The painted field is slightly trapezoidal, so this inset keeps
 *  all four playable corners on turf while the surrounding stadium remains
 *  available to the camera. */
const PLATE_GRASS = { x: 124, y: 150, w: 1288, h: 790 };
/** Camera never gets closer than this to the painted world's outer edge. */
const EDGE_PAD = 6;
type SpriteBitmap = HTMLCanvasElement | HTMLImageElement;
export type MovementDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const MOVEMENT_DIRECTIONS: readonly MovementDirection[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];
const BOSS_DIRECTION_FRAME_WIDTH = 480;
const PLAYER_DIRECTION_FRAME_WIDTH = 256;
const PLAYER_DIRECTION_RUN_FPS = 18;

/** Quantize a world-space movement vector into one of eight authored views. */
export function movementDirection(dx: number, dy: number): MovementDirection {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) + Math.abs(dy) < 0.0001) return 's';
  const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return MOVEMENT_DIRECTIONS[(octant + 8) % 8];
}

export interface DirectionalFrameBlend {
  frame: number;
  nextFrame: number;
  mix: number;
}

export interface PlayerStepCue {
  strength: number;
  foot: -1 | 1;
}

interface TurfFootprint {
  active: boolean;
  x: number;
  y: number;
  born: number;
  side: -1 | 1;
  angle: number;
}

interface TurfClipping {
  active: boolean;
  x: number;
  y: number;
  born: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  length: number;
  shade: number;
}

/** Integrated exponential drag for turf clippings. Exported so monotonic
 * world-space motion remains covered independently of canvas rendering. */
export function dampedTurfDisplacement(age: number, dragRate = 4.7): number {
  const safeAge = Math.max(0, Number.isFinite(age) ? age : 0);
  const safeDrag = Math.max(0.001, Number.isFinite(dragRate) ? dragRate : 4.7);
  return (1 - Math.exp(-safeAge * safeDrag)) / safeDrag;
}

/** Smoothly blend authored poses at render rate while retaining the concrete
 *  12-frame cycle. The cubic easing prevents a visible snap at frame edges. */
export function directionalFrameBlend(animT: number, fps: number, frames: number): DirectionalFrameBlend {
  const count = Math.max(1, Math.floor(frames));
  const phase = Math.max(0, Number.isFinite(animT) ? animT : 0) * Math.max(0, fps);
  const base = Math.floor(phase);
  const fraction = phase - base;
  // Hold each authored pose briefly before cross-fading. Legs and planted
  // cleats remain readable at gameplay scale, while the middle transition is
  // still interpolated smoothly at the display refresh rate.
  const transition = clamp((fraction - 0.16) / 0.68, 0, 1);
  const mix = transition * transition * (3 - 2 * transition);
  return {
    frame: base % count,
    nextFrame: (base + 1) % count,
    mix,
  };
}

/** Two authored foot plants per 12-frame running cycle. This drives a tiny
 *  turf-contact cue and body lift; it never appears while the player is idle. */
export function playerStepCue(animT: number, fps = PLAYER_DIRECTION_RUN_FPS, frames = 12): PlayerStepCue {
  const count = Math.max(2, Math.floor(frames));
  const phase = Math.max(0, Number.isFinite(animT) ? animT : 0) * Math.max(0, fps);
  const frame = phase % count;
  const contacts = [2, 2 + count / 2];
  const circularDistance = (value: number, target: number) => {
    const raw = Math.abs(value - target);
    return Math.min(raw, count - raw);
  };
  const firstDistance = circularDistance(frame, contacts[0]);
  const secondDistance = circularDistance(frame, contacts[1]);
  const distance = Math.min(firstDistance, secondDistance);
  const normalized = clamp(1 - distance / 0.9, 0, 1);
  return {
    strength: normalized * normalized * (3 - 2 * normalized),
    foot: firstDistance <= secondDistance ? -1 : 1,
  };
}

/** Generated enemy strips use semantic poses: idle, move, attack/cast, hurt. */
export function enemyPoseFrame(
  e: Pick<Enemy, 'hurtT' | 'stun' | 'windup' | 'lungeT' | 'attackAnimT' | 'telegraph' | 'casting' | 'moving' | 'airT'>,
  frames: number,
): number {
  if (frames < 4) return Math.max(0, frames - 1);
  if (e.hurtT > 0 || e.stun > 0) return 3;
  if (e.windup > 0 || e.lungeT > 0 || e.attackAnimT > 0 || e.telegraph > 0 || e.casting !== '') return 2;
  if (e.moving || e.airT > 0) return 1;
  return 0;
}

/** Allied bodyguard strip poses: idle, move, punch, bottle interception. */
export function guardPoseFrame(
  g: Pick<Guard, 'moving' | 'strikeT' | 'blockT'>,
  frames: number,
): number {
  if (frames < 4) return Math.max(0, frames - 1);
  if (g.blockT > 0) return 3;
  if (g.strikeT > 0) return 2;
  if (g.moving) return 1;
  return 0;
}

export interface EnemyHealthBarStyle {
  ratio: number;
  width: number;
  height: number;
  accent: string;
  numeric: boolean;
}

/** Shared health-bar metrics keep every archetype readable without letting
 *  100+ simultaneous bars dominate the pitch. */
export function enemyHealthBarStyle(
  e: Pick<Enemy, 'hp' | 'maxHp' | 'radius' | 'elite' | 'boss'>,
): EnemyHealthBarStyle {
  const ratio = clamp(e.maxHp > 0 ? e.hp / e.maxHp : 0, 0, 1);
  const boss = !!e.boss;
  const width = boss
    ? clamp(52 + e.radius * 2.1, 128, 166)
    : clamp((24 + e.radius * 1.5) * (e.elite ? 1.16 : 1), 42, e.elite ? 84 : 70);
  return {
    ratio,
    width,
    height: boss
      ? clamp(8 + (e.radius - 38) * 0.2, 8, 11)
      : e.elite
        ? clamp(5 + e.radius * 0.16, 7, 9)
        : clamp(3.4 + e.radius * 0.16, 5, 8.2),
    accent: boss ? '#ff4d66' : e.elite ? '#ffd23f' : '#b7cbd6',
    numeric: boss || e.elite,
  };
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pitch: HTMLCanvasElement;
  private plate: HTMLImageElement | null = null;
  private plateGrass: ArenaGrassRect = PLATE_GRASS;
  private liveStadium = false;
  /** World rect covered by the prerendered pitch canvas (camera hard limits). */
  private bounds = { x0: -MARGIN, y0: -MARGIN, x1: ARENA_W + MARGIN, y1: ARENA_H + MARGIN };
  private scale = 1;
  private shake = 0;
  private ball: HTMLCanvasElement;
  private matchBallSpr: SpriteBitmap;
  private curveballSpr: SpriteBitmap;
  private goldenBootSpr: SpriteBitmap;
  private xpSpr: SpriteBitmap[];
  private coinSpr: SpriteBitmap;
  private healSpr: SpriteBitmap;
  private trophySpr: SpriteBitmap;
  private magnetSpr: SpriteBitmap;
  private bombSpr: SpriteBitmap;
  private freezeSpr: SpriteBitmap;
  private orbitImpactSpr: HTMLImageElement | null = null;
  private orbitSkidSpr: HTMLImageElement | null = null;
  private contactHitSpr: HTMLImageElement | null = null;
  private playerHurtSpr: HTMLImageElement | null = null;
  private knockoutSpr: HTMLImageElement | null = null;
  private guardSlamSpr: HTMLImageElement | null = null;
  private curveTrailSpr: HTMLImageElement | null = null;
  private goldenBootTrailSpr: HTMLImageElement | null = null;
  private bossWarningSpr: HTMLImageElement | null = null;
  private bullChargeLaneSpr: HTMLImageElement | null = null;
  private aerialTargetSpr: HTMLImageElement | null = null;
  private captainsHeartSpr: HTMLImageElement | null = null;
  private droneShotSpr: HTMLImageElement | null = null;
  private matchdayWipeoutSpr: HTMLImageElement | null = null;
  private bottleSpr: HTMLCanvasElement;
  private atlasCache = new Map<string, Atlas>();
  private crowdSeed: number[] = [];
  private flashWarn = 0;
  private flashWhiteT = 0;
  private lossStartedAt = -1;
  private matchdayWipeoutStartedAt = -1;
  private turfFootprints: TurfFootprint[] = Array.from({ length: 24 }, () => ({
    active: false, x: 0, y: 0, born: 0, side: 1, angle: 0,
  }));
  private turfFootprintCursor = 0;
  private turfClippings: TurfClipping[] = Array.from({ length: 72 }, () => ({
    active: false, x: 0, y: 0, born: 0, vx: 0, vy: 0, angle: 0, spin: 0, length: 0, shade: 0,
  }));
  private turfClippingCursor = 0;
  private lastTurfFootprintAt = -1e9;
  private lastTurfFootprintX = Number.NaN;
  private lastTurfFootprintY = Number.NaN;
  private nextTurfFoot: -1 | 1 = -1;

  camX = ARENA_W / 2;
  camY = ARENA_H / 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.pitch = this.buildPitch();
    this.ball = ballSprite(22);
    this.matchBallSpr = this.ball;
    this.curveballSpr = this.ball;
    this.goldenBootSpr = this.ball;
    this.xpSpr = [xpSprite(1), xpSprite(2), xpSprite(3)];
    this.coinSpr = coinSprite();
    this.healSpr = drinkSprite();
    this.trophySpr = trophySprite();
    this.magnetSpr = coinSprite();
    this.bombSpr = ballSprite(28);
    this.freezeSpr = xpSprite(1);
    this.bottleSpr = bottleSprite();
    ['xp-1', 'xp-2', 'xp-3'].forEach((id, i) => {
      this.loadPickupSprite(`art/pickups/${id}.png`, (img) => {
        this.xpSpr[i] = img;
      });
    });
    this.loadPickupSprite('art/pickups/coin.png', (img) => {
      this.coinSpr = img;
    });
    this.loadPickupSprite('art/pickups/heal.png', (img) => {
      this.healSpr = img;
    });
    this.loadPickupSprite('art/pickups/trophy.png', (img) => {
      this.trophySpr = img;
    });
    this.loadPickupSprite('art/pickups/magnet.png', (img) => {
      this.magnetSpr = img;
    });
    this.loadPickupSprite('art/pickups/bomb.png', (img) => {
      this.bombSpr = img;
    });
    this.loadPickupSprite('art/pickups/freeze.png', (img) => {
      this.freezeSpr = img;
    });
    this.loadPickupSprite('art/projectiles/curveball-v2.png', (img) => {
      this.curveballSpr = img;
    });
    this.loadPickupSprite('art/projectiles/golden-boot-v2.png', (img) => {
      this.goldenBootSpr = img;
    });
    this.loadPickupSprite('art/projectiles/match-ball.png', (img) => {
      this.matchBallSpr = img;
    });
    this.loadPickupSprite('art/vfx/orbit-impact-v2.png', (img) => {
      this.orbitImpactSpr = img;
    });
    this.loadPickupSprite('art/vfx/orbit-skid-v2.png', (img) => {
      this.orbitSkidSpr = img;
    });
    this.loadPickupSprite('art/vfx/contact-hit-strip.png', (img) => {
      this.contactHitSpr = img;
    });
    this.loadPickupSprite('art/vfx/player-hurt-strip.png', (img) => {
      this.playerHurtSpr = img;
    });
    this.loadPickupSprite('art/vfx/knockout-strip.png', (img) => {
      this.knockoutSpr = img;
    });
    this.loadPickupSprite('art/vfx/guard-slam-strip.png', (img) => {
      this.guardSlamSpr = img;
    });
    this.loadPickupSprite('art/vfx/curveball-trail-strip.png', (img) => {
      this.curveTrailSpr = img;
    });
    this.loadPickupSprite('art/vfx/golden-boot-trail-strip.png', (img) => {
      this.goldenBootTrailSpr = img;
    });
    this.loadPickupSprite('art/vfx/boss-warning-strip.png', (img) => {
      this.bossWarningSpr = img;
    });
    this.loadPickupSprite('art/vfx/bull-charge-lane-strip.png', (img) => {
      this.bullChargeLaneSpr = img;
    });
    this.loadPickupSprite('art/vfx/aerial-target-strip.png', (img) => {
      this.aerialTargetSpr = img;
    });
    this.loadPickupSprite('art/vfx/captains-heart-strip.png', (img) => {
      this.captainsHeartSpr = img;
    });
    this.loadPickupSprite('art/vfx/drone-shot-strip.png', (img) => {
      this.droneShotSpr = img;
    });
    this.loadPickupSprite('art/vfx/matchday-wipeout-strip.webp', (img) => {
      this.matchdayWipeoutSpr = img;
    });
    void loadStripAtlas('ally-bodyguard-rookie', 'art/allies/bodyguard-rookie.png');
    void loadStripAtlas('ally-bodyguard-rookie-run', 'art/allies/bodyguard-rookie-run.png');
    void loadStripAtlas('ally-bodyguard', 'art/allies/bodyguard.png');
    void loadStripAtlas('ally-bodyguard-run', 'art/allies/bodyguard-run.png');
    void loadStripAtlas('ally-bodyguard-heavy', 'art/allies/bodyguard-heavy.png');
    void loadStripAtlas('ally-bodyguard-heavy-run', 'art/allies/bodyguard-heavy-run.png');
    void loadStripAtlas('ally-bodyguard-scout', 'art/allies/bodyguard-scout.png');
    void loadStripAtlas('ally-bodyguard-scout-run', 'art/allies/bodyguard-scout-run.png');
    // Stable stadium seed makes visual reviews and repeated arena loads
    // pixel-comparable while retaining varied crowd and material placement.
    let stadiumSeed = 0x5f3759df;
    for (let i = 0; i < 400; i++) {
      stadiumSeed = (Math.imul(stadiumSeed, 1664525) + 1013904223) >>> 0;
      this.crowdSeed.push(stadiumSeed / 0x100000000);
    }
  }

  /** Loads generated pickup art while preserving the procedural fallback. */
  private loadPickupSprite(url: string, apply: (img: HTMLImageElement) => void): void {
    const img = new Image();
    img.onload = () => apply(img);
    img.src = url;
  }

  /** Draws one cell from a six-frame generated VFX strip. Keeping VFX in one
   *  fixed atlas avoids per-hit allocations and remains safe in dense runs. */
  private drawVfxFrame(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement | null,
    frame: number,
    x: number,
    y: number,
    size: number,
    rotation = 0,
    alpha = 1,
    additive = false,
    anchorX = 0.5,
  ): boolean {
    if (!sprite || !sprite.complete || sprite.naturalWidth <= 0) return false;
    const frames = 6;
    const fw = sprite.naturalWidth / frames;
    const sourceFrame = clamp(Math.floor(frame), 0, frames - 1);
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    if (additive) ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(
      sprite,
      sourceFrame * fw,
      0,
      fw,
      sprite.naturalHeight,
      -size * anchorX,
      -size / 2,
      size,
      size,
    );
    ctx.restore();
    return true;
  }

  /** Rectangular six-frame VFX for directional lanes and beams. Unlike the
   * square helper this preserves a long charge silhouette without stretching
   * its thickness to match the travel distance. */
  private drawVfxFrameRect(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement | null,
    frame: number,
    x: number,
    y: number,
    width: number,
    height: number,
    rotation = 0,
    alpha = 1,
    additive = false,
  ): boolean {
    if (!sprite || !sprite.complete || sprite.naturalWidth <= 0) return false;
    const frames = 6;
    const fw = sprite.naturalWidth / frames;
    const sourceFrame = clamp(Math.floor(frame), 0, frames - 1);
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    if (additive) ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(sprite, sourceFrame * fw, 0, fw, sprite.naturalHeight, -width / 2, -height / 2, width, height);
    ctx.restore();
    return true;
  }

  /** Ground decals share world perspective instead of looking like upright UI. */
  private drawGroundVfxFrame(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement | null,
    frame: number,
    x: number,
    y: number,
    diameter: number,
    alpha = 1,
  ): boolean {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, TILT);
    const drawn = this.drawVfxFrame(ctx, sprite, frame, 0, 0, diameter, 0, alpha, false);
    ctx.restore();
    return drawn;
  }

  /** Compact stadium-scoreboard health bar. It uses only pooled canvas work,
   *  so large late-game crowds remain mobile-safe. */
  private drawEnemyHealthBar(ctx: CanvasRenderingContext2D, e: Enemy, x: number, y: number, time: number): void {
    const style = enemyHealthBarStyle(e);
    const { ratio, width: w, height: h } = style;
    if (x + w / 2 < -12 || x - w / 2 > this.canvas.width + 12 || y < -30 || y > this.canvas.height + 12) return;

    const left = Math.round(x - w / 2);
    const top = Math.round(y);
    const low = ratio <= 0.25;
    const hit = e.flash > 0 || e.hurtT > 0;
    const fill = ratio > 0.58 ? '#45dc86' : ratio > 0.28 ? '#ffc247' : '#ff4d61';
    const pulse = low ? 0.72 + Math.sin(time * 11 + e.x * 0.01) * 0.2 : 0.88;

    ctx.save();
    ctx.globalAlpha = e.boss || e.elite || ratio < 0.999 ? 1 : 0.84;
    if (e.boss || e.elite) {
      ctx.shadowColor = e.boss ? 'rgba(255,45,76,0.48)' : 'rgba(255,210,63,0.42)';
      ctx.shadowBlur = e.boss ? 9 : 6;
    }

    // Metal outer casing and inset dark track.
    ctx.fillStyle = 'rgba(5,10,14,0.9)';
    ctx.beginPath();
    ctx.roundRect(left - 3, top - 3, w + 6, h + 6, h / 2 + 3);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = hit ? '#ffffff' : style.accent;
    ctx.lineWidth = hit ? 2 : e.boss || e.elite ? 1.6 : 1.15;
    ctx.stroke();

    ctx.fillStyle = 'rgba(20,28,34,0.96)';
    ctx.beginPath();
    ctx.roundRect(left, top, w, h, h / 2);
    ctx.fill();

    // A pale delayed chip shows exactly how much the latest hit removed before
    // easing down to the real value. This makes burst damage legible in crowds.
    const trailRatio = clamp(e.maxHp > 0 ? e.barHp / e.maxHp : ratio, ratio, 1);
    const trailW = w * trailRatio;
    if (trailW > w * ratio + 0.5) {
      ctx.fillStyle = e.boss ? '#ffd0d7' : e.elite ? '#fff0a8' : '#dcecf2';
      ctx.globalAlpha = 0.88;
      ctx.beginPath();
      ctx.roundRect(left, top, trailW, h, Math.min(h / 2, trailW / 2));
      ctx.fill();
      ctx.globalAlpha = e.boss || e.elite || ratio < 0.999 ? 1 : 0.84;
    }

    const fillW = Math.max(ratio > 0 ? 2 : 0, w * ratio);
    if (fillW > 0) {
      ctx.globalAlpha *= pulse;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(left, top, fillW, h, Math.min(h / 2, fillW / 2));
      ctx.fill();
      // Highlight strip makes the bar feel like a physical enamel scoreboard.
      ctx.globalAlpha *= 0.72;
      ctx.fillStyle = 'rgba(255,255,255,0.48)';
      ctx.beginPath();
      ctx.roundRect(left + 1, top + 1, Math.max(0, fillW - 2), Math.max(1, h * 0.28), h / 4);
      ctx.fill();
    }

    ctx.globalAlpha = e.boss || e.elite || ratio < 0.999 ? 0.48 : 0.32;
    ctx.strokeStyle = '#071015';
    ctx.lineWidth = 1;
    for (let segment = 1; segment < 4; segment++) {
      const sx = left + (w * segment) / 4;
      ctx.beginPath();
      ctx.moveTo(sx, top + 1);
      ctx.lineTo(sx, top + h - 1);
      ctx.stroke();
    }

    // Status pips: purple = stunned, cyan = slowed, blue chevron = airborne.
    const statuses: Array<{ color: string; kind: 'dot' | 'air' }> = [];
    if (e.stun > 0) statuses.push({ color: '#c78cff', kind: 'dot' });
    if (e.slow > 0) statuses.push({ color: '#5cecff', kind: 'dot' });
    if (e.airT > 0 || e.def.behavior === 'aerial') statuses.push({ color: '#7ca8ff', kind: 'air' });
    statuses.forEach((status, index) => {
      const sx = left + w + 8 + index * 9;
      const sy = top + h / 2;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = status.color;
      ctx.strokeStyle = '#061016';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (status.kind === 'air') {
        ctx.moveTo(sx, sy - 4);
        ctx.lineTo(sx + 4, sy + 3);
        ctx.lineTo(sx - 4, sy + 3);
        ctx.closePath();
      } else {
        ctx.arc(sx, sy, 3.5, 0, TAU);
      }
      ctx.fill();
      ctx.stroke();
    });

    // Tiny rotated crest anchors the bar to the game's football presentation.
    ctx.globalAlpha = 1;
    ctx.translate(left - 5, top + h / 2);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = style.accent;
    ctx.fillRect(-3.5, -3.5, 7, 7);
    ctx.fillStyle = '#111a20';
    ctx.fillRect(-1.5, -1.5, 3, 3);
    ctx.rotate(-Math.PI / 4);
    ctx.translate(-(left - 5), -(top + h / 2));

    if (style.numeric) {
      ctx.font = `800 ${e.boss ? 10 : 8}px "Space Grotesk", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4,8,12,0.9)';
      const label = `${Math.ceil(Math.max(0, e.hp)).toLocaleString()} HP`;
      ctx.strokeText(label, x, top - 4);
      ctx.fillStyle = e.boss ? '#fff2f4' : '#fff1b3';
      ctx.fillText(label, x, top - 4);
    }
    ctx.restore();
  }

  /** Draws the generated four-frame match ball strip, with a procedural
   * fallback while the asset is loading. */
  private drawMatchBall(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, frame: number): void {
    const spr = this.matchBallSpr;
    const frames = spr.width >= spr.height * 3.2 ? 4 : 1;
    const fw = spr.width / frames;
    const f = frames === 1 ? 0 : Math.floor(frame) % frames;
    ctx.drawImage(spr, f * fw, 0, fw, spr.height, x - size / 2, y - size / 2, size, size);
  }

  /** Swap in the AI arena plate and rebuild the prerendered world canvas. */
  setArenaImage(img: HTMLImageElement, grassRect: ArenaGrassRect = PLATE_GRASS, liveStadium = false): void {
    this.plate = img;
    this.plateGrass = grassRect;
    this.liveStadium = liveStadium;
    this.pitch = this.buildPitch();
  }

  /** Enemy visuals: generated 2.5D strip when available, else the procedural atlas. */
  private enemyAtlasFor(e: { def: EnemyDef; boss: '' | BossId; variant: 0 | 1 | 2 }): Atlas {
    const id = e.boss
      ? `boss-${e.boss}`
      : e.def.id === 'invader' && e.variant === 1 ? 'invader-ultra'
        : e.def.id === 'invader' && e.variant === 2 ? 'invader-away'
          : e.def.id;
    const strip = getStripAtlas(id);
    if (strip) return strip;
    void loadStripAtlas(id, `art/enemies/${id}.png`);
    return e.boss ? bossAtlas(e.boss) : enemyAtlas(e.def.id as Parameters<typeof enemyAtlas>[0]);
  }

  /** Dedicated six-frame locomotion art. Semantic idle/attack/hurt strips are
   * kept separate so an enemy never appears to run while standing still. */
  private enemyRunAtlasFor(e: Pick<Enemy, 'def' | 'boss' | 'variant' | 'moveDx' | 'moveDy'>): Atlas | null {
    // The drone is a hovering machine, not a footstep character. Holding its
    // clean thrust pose and animating roll/height continuously avoids the
    // clipped, off-centre cells in the generated locomotion strip.
    if (e.def.behavior === 'aerial') return null;
    if (e.boss) {
      const direction = movementDirection(e.moveDx, e.moveDy);
      const directionalId = `boss-directional-${e.boss}-${direction}`;
      const directional = getStripAtlas(directionalId);
      if (directional) {
        trimStripAtlasCache('boss-directional-', directionalId, 6);
        return directional;
      }
      void loadStripAtlas(
        directionalId,
        `art/enemies/directional-v2/boss-${e.boss}/${direction}.webp`,
        undefined,
        {
          frameWidth: BOSS_DIRECTION_FRAME_WIDTH,
          frameHeight: 320,
          feetY: 312,
          minFrames: 12,
          maxFrames: 12,
          buildEffects: false,
        },
      ).then(() => trimStripAtlasCache('boss-directional-', directionalId, 6));
      const fallbackId = `boss-${e.boss}-run`;
      const fallback = getStripAtlas(fallbackId);
      if (fallback) return fallback;
      void loadStripAtlas(fallbackId, `art/enemies/boss-${e.boss}-run.png`);
      return null;
    }
    const id = e.boss
      ? `boss-${e.boss}`
      : e.def.id === 'invader' && e.variant === 1 ? 'invader-ultra'
        : e.def.id === 'invader' && e.variant === 2 ? 'invader-away'
          : e.def.id;
    const runId = `${id}-run`;
    const strip = getStripAtlas(runId);
    if (strip) return strip;
    void loadStripAtlas(runId, `art/enemies/${id}-run.png`);
    return null;
  }

  /** White blinding flash (paparazzo). */
  flashWhite(): void {
    this.flashWhiteT = 0.28;
  }

  addShake(amount: number): void {
    this.shake = Math.min(14, this.shake + amount);
  }

  warnFlash(): void {
    this.flashWarn = 0.42;
  }

  playMatchdayWipeout(): void {
    this.matchdayWipeoutStartedAt = performance.now() / 1000;
  }

  /* ------------------------------------------------------------------ */

  private buildPitch(): HTMLCanvasElement {
    // Margins around the playable arena that the base layer covers. The arena
    // plate supplies its own asymmetric surround (stands/track/tunnel), so the
    // world canvas and the camera bounds derive from the measured grass rect.
    let ml = MARGIN;
    let mr = MARGIN;
    let mt = MARGIN;
    let mb = MARGIN;
    let psx = 1;
    let psy = 1;
    if (this.plate) {
      psx = ARENA_W / this.plateGrass.w;
      psy = ARENA_H / this.plateGrass.h;
      ml = this.plateGrass.x * psx;
      mr = (this.plate.width - this.plateGrass.x - this.plateGrass.w) * psx;
      mt = this.plateGrass.y * psy;
      mb = (this.plate.height - this.plateGrass.y - this.plateGrass.h) * psy;
    }
    this.bounds = { x0: -ml, y0: -mt, x1: ARENA_W + mr, y1: ARENA_H + mb };
    const w = ARENA_W + ml + mr;
    const h = ARENA_H + mt + mb;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w);
    c.height = Math.ceil(h * TILT);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(1, 0, 0, TILT, 0, 0);
    ctx.translate(ml, mt);

    if (this.plate) {
      // The authored arena plate's measured grass rect maps exactly onto the
      // playable arena. A slight non-uniform scale absorbs each source plate's
      // aspect difference while its stands fill the surrounding margin.
      ctx.drawImage(this.plate, -this.plateGrass.x * psx, -this.plateGrass.y * psy, this.plate.width * psx, this.plate.height * psy);
    } else {
    // surround apron
    ctx.fillStyle = '#0d2818';
    ctx.fillRect(-MARGIN, -MARGIN, w, h);

    // crowd stands: rows of dots in the margin ring
    const crowdColors = ['#d8d3c8', '#c46a5a', '#5a7bc4', '#c4b45a', '#7ac48a', '#b08ac4', '#e0e0e0', '#8a94a6'];
    const rng = (() => {
      let s = 1234567;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    })();
    for (let row = 0; row < 22; row++) {
      const inset = 30 + row * 13;
      const density = 0.55;
      // top & bottom rows
      for (let x = -MARGIN + inset; x < ARENA_W + MARGIN - inset; x += 9) {
        if (rng() > density) continue;
        const yTop = -MARGIN + inset + rng() * 8;
        const yBot = ARENA_H + MARGIN - inset - rng() * 8;
        ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
        ctx.fillRect(x, yTop, 5.5, 5.5);
        if (rng() > density) {
          ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
          ctx.fillRect(x, yBot, 5.5, 5.5);
        }
      }
      // left & right rows
      for (let y = -MARGIN + inset; y < ARENA_H + MARGIN - inset; y += 9) {
        if (rng() > density) continue;
        ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
        ctx.fillRect(-MARGIN + inset + rng() * 8, y, 5.5, 5.5);
        if (rng() > density) {
          ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
          ctx.fillRect(ARENA_W + MARGIN - inset - rng() * 8, y, 5.5, 5.5);
        }
      }
    }

    // ad boards ring
    ctx.fillStyle = '#101820';
    ctx.fillRect(-70, -70, ARENA_W + 140, 26);
    ctx.fillRect(-70, ARENA_H + 44, ARENA_W + 140, 26);
    ctx.fillRect(-70, -44, 26, ARENA_H + 88);
    ctx.fillRect(ARENA_W + 44, -44, 26, ARENA_H + 88);
    const ads = ['FOOTBALL FIGHTING', 'KICK ENERGY', 'STRIKE COLA', 'BOOTS & CO', 'TERRACE TV', 'MATCHDAY'];
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const boardW = (ARENA_W + 140) / 6;
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#ffd23f' : '#4cc9f0';
      ctx.textAlign = 'center';
      ctx.fillText(ads[i], -70 + boardW * (i + 0.5), -56);
      ctx.fillText(ads[5 - i], -70 + boardW * (i + 0.5), ARENA_H + 58);
    }
    ctx.save();
    ctx.translate(-56, ARENA_H / 2);
    ctx.rotate(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#e8283f' : '#f5f7fa';
      ctx.fillText(ads[i], -(ARENA_H / 4) * (i - 1.5), 0);
    }
    ctx.restore();
    ctx.save();
    ctx.translate(ARENA_W + 58, ARENA_H / 2);
    ctx.rotate(Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#80ed99' : '#ffd23f';
      ctx.fillText(ads[i + 2], -(ARENA_H / 4) * (i - 1.5), 0);
    }
    ctx.restore();

    // grass with mowed stripes
    for (let i = 0; i < Math.ceil(ARENA_W / 170); i++) {
      ctx.fillStyle = i % 2 === 0 ? '#2e8b47' : '#2a8042';
      ctx.fillRect(i * 170, 0, 170, ARENA_H);
    }
    // subtle noise
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.03 + rng() * 0.05})`;
      ctx.fillRect(rng() * ARENA_W, rng() * ARENA_H, 3, 3);
    }
    // mowing arcs (alternating circular cut pattern for richness)
    for (let i = 0; i < 7; i++) {
      const ax = ARENA_W * (0.12 + i * 0.14);
      const dir = i % 2 === 0 ? 1 : -1;
      ctx.strokeStyle = 'rgba(255,255,255,0.028)';
      ctx.lineWidth = 90;
      ctx.beginPath();
      ctx.arc(ax, ARENA_H / 2, 420 + i * 30, dir > 0 ? -Math.PI / 2.6 : Math.PI / 2.6, dir > 0 ? Math.PI / 2.6 : Math.PI - Math.PI / 2.6, dir < 0);
      ctx.stroke();
    }
    // worn scuffs near heavy-traffic zones
    for (let i = 0; i < 60; i++) {
      const zones = [
        [ARENA_W / 2, ARENA_H / 2, 260],
        [40 + 230, ARENA_H / 2, 200],
        [ARENA_W - 40 - 230, ARENA_H / 2, 200],
      ];
      const z = zones[i % 3];
      const a = rng() * TAU;
      const r = rng() * z[2];
      ctx.fillStyle = `rgba(90,60,30,${0.04 + rng() * 0.05})`;
      ctx.beginPath();
      ctx.ellipse(z[0] + Math.cos(a) * r, z[1] + Math.sin(a) * r, 4 + rng() * 14, 3 + rng() * 8, rng() * 3, 0, TAU);
      ctx.fill();
    }
    } // end procedural fallback base

    if (this.liveStadium) {
      // A final code-built nap survives WebP resampling as distinct grass
      // blades. It is baked into the pitch canvas once (never per frame), uses
      // a fixed generator and follows the alternating mower direction. Paired
      // root shadows and fine lit edges keep the fibres physical at gameplay
      // scale without becoming a noisy particle field.
      let turfSeed = 0x47a91f2d;
      const turfRandom = (): number => {
        turfSeed = (Math.imul(turfSeed, 1664525) + 1013904223) >>> 0;
        return turfSeed / 0x100000000;
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, ARENA_W, ARENA_H);
      ctx.clip();
      ctx.lineCap = 'round';
      const ellipticalWear = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): number => {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        return Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
      };
      for (let blade = 0; blade < 9_600; blade++) {
        const x = 10 + turfRandom() * (ARENA_W - 20);
        const y = 10 + turfRandom() * (ARENA_H - 20);
        const densityWave = (
          Math.sin(x * 0.0107 + y * 0.0041)
          + Math.cos(y * 0.0129 - x * 0.0037)
        ) * 0.5;
        if (turfRandom() > 0.72 + densityWave * 0.08) continue;
        const mowerDirection = Math.floor(x / 112) % 2 === 0 ? 1 : -1;
        const trafficWear = Math.max(
          ellipticalWear(x, y, ARENA_W * 0.5, ARENA_H * 0.5, 370, 225),
          ellipticalWear(x, y, 138, ARENA_H * 0.5, 220, 330),
          ellipticalWear(x, y, ARENA_W - 138, ARENA_H * 0.5, 220, 330),
        );
        if (trafficWear > 0.08 && turfRandom() < trafficWear * 0.58) {
          const flattenedDirection = turfRandom() < 0.5 ? -1 : 1;
          const flattenedLength = 3.2 + turfRandom() * (4.2 + trafficWear * 3.8);
          const flattenedLift = (turfRandom() - 0.5) * (1.4 - trafficWear * 0.65);
          const flattenedAlpha = 0.036 + turfRandom() * 0.038;
          ctx.strokeStyle = `rgba(28,38,10,${flattenedAlpha * (0.85 + trafficWear * 0.35)})`;
          ctx.lineWidth = 0.72;
          ctx.beginPath();
          ctx.moveTo(x + 0.65, y + 0.65);
          ctx.quadraticCurveTo(
            x + flattenedDirection * flattenedLength * 0.46,
            y + flattenedLift * 0.45 + 0.65,
            x + flattenedDirection * flattenedLength,
            y + flattenedLift + 0.65,
          );
          ctx.stroke();
          ctx.strokeStyle = `rgba(198,201,116,${flattenedAlpha * 0.72})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(
            x + flattenedDirection * flattenedLength * 0.46,
            y + flattenedLift * 0.45,
            x + flattenedDirection * flattenedLength,
            y + flattenedLift,
          );
          ctx.stroke();
          continue;
        }
        const length = 2.1 + turfRandom() * 3.8;
        const bend = mowerDirection * (0.35 + turfRandom() * 1.25) + (turfRandom() - 0.5) * 0.7;
        const lift = length * (0.82 + turfRandom() * 0.16);
        const alpha = 0.045 + turfRandom() * 0.05;
        ctx.strokeStyle = `rgba(32,42,12,${alpha * 0.72})`;
        ctx.lineWidth = 0.76;
        ctx.beginPath();
        ctx.moveTo(x + 0.75, y + 0.55);
        ctx.quadraticCurveTo(x + bend * 0.42 + 0.75, y - lift * 0.48 + 0.55, x + bend + 0.75, y - lift + 0.55);
        ctx.stroke();
        ctx.strokeStyle = `rgba(223,224,145,${alpha})`;
        ctx.lineWidth = 0.58;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + bend * 0.42, y - lift * 0.48, x + bend, y - lift);
        ctx.stroke();
        if (blade % 17 === 0) {
          const siblingLean = bend * 0.62 - mowerDirection * 0.9;
          ctx.strokeStyle = `rgba(191,198,106,${alpha * 0.72})`;
          ctx.lineWidth = 0.52;
          ctx.beginPath();
          ctx.moveTo(x + 0.9, y + 0.2);
          ctx.quadraticCurveTo(x + siblingLean * 0.45, y - lift * 0.31, x + siblingLean, y - lift * 0.72);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Chalk markings: thinner, slightly translucent and softly grounded into
    // the turf so they read as painted grass rather than bright UI strokes.
    ctx.strokeStyle = 'rgba(245,247,250,0.74)';
    ctx.fillStyle = 'rgba(245,247,250,0.76)';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(5,32,14,0.6)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;
    ctx.strokeRect(40, 40, ARENA_W - 80, ARENA_H - 80);
    // halfway line + center circle
    ctx.beginPath();
    ctx.moveTo(ARENA_W / 2, 40);
    ctx.lineTo(ARENA_W / 2, ARENA_H - 40);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ARENA_W / 2, ARENA_H / 2, 190, 0, TAU);
    ctx.stroke();
    const paintedSpot = (x: number, y: number, seed: number): void => {
      ctx.fillStyle = 'rgba(245,247,238,0.63)';
      ctx.beginPath();
      for (let segment = 0; segment <= 18; segment++) {
        const angle = (segment / 18) * TAU;
        const radius = 5.4 + Math.sin(seed * 0.73 + segment * 2.17) * 0.75 + Math.cos(segment * 1.31) * 0.32;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (segment === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,244,0.29)';
      ctx.lineWidth = 0.72;
      for (let fibre = -3; fibre <= 3; fibre++) {
        ctx.beginPath();
        ctx.moveTo(x - 3.6, y + fibre * 1.15);
        ctx.lineTo(x + 3.9, y + fibre * 0.96 + ((fibre + seed) % 2) * 0.45);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(73,87,34,0.23)';
      for (let chip = 0; chip < 5; chip++) {
        const angle = seed + chip * 2.31;
        const radius = 1.5 + (chip % 3) * 1.15;
        ctx.fillRect(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, 0.9, 0.75);
      }
    };
    paintedSpot(ARENA_W / 2, ARENA_H / 2, 17);
    // penalty boxes
    const boxW = 330;
    const boxH = 820;
    const boxY = (ARENA_H - boxH) / 2;
    ctx.strokeRect(40, boxY, boxW, boxH);
    ctx.strokeRect(ARENA_W - 40 - boxW, boxY, boxW, boxH);
    const sixW = 130;
    const sixH = 420;
    ctx.strokeRect(40, (ARENA_H - sixH) / 2, sixW, sixH);
    ctx.strokeRect(ARENA_W - 40 - sixW, (ARENA_H - sixH) / 2, sixW, sixH);
    // penalty spots + arcs
    paintedSpot(40 + 230, ARENA_H / 2, 29);
    paintedSpot(ARENA_W - 40 - 230, ARENA_H / 2, 41);
    ctx.beginPath();
    ctx.arc(40 + 230, ARENA_H / 2, 150, -Math.PI / 3.2, Math.PI / 3.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ARENA_W - 40 - 230, ARENA_H / 2, 150, Math.PI - Math.PI / 3.2, Math.PI + Math.PI / 3.2);
    ctx.stroke();
    // Painted corner arcs follow the same collision-accurate 40-unit radius.
    for (const [cornerX, cornerY, startAngle, endAngle] of [
      [40, 40, 0, Math.PI / 2],
      [ARENA_W - 40, 40, Math.PI / 2, Math.PI],
      [40, ARENA_H - 40, -Math.PI / 2, 0],
      [ARENA_W - 40, ARENA_H - 40, Math.PI, Math.PI * 1.5],
    ] as const) {
      ctx.beginPath();
      ctx.arc(cornerX, cornerY, 42, startAngle, endAngle);
      ctx.stroke();
    }

    // A sparse upper nap makes the white paint belong to the grass instead of
    // reading as a perfectly vector-clean HUD line. All marks are deterministic
    // and stay sub-pixel at normal gameplay zoom.
    const paintedFibre = (x: number, y: number, dx: number, dy: number): void => {
      ctx.strokeStyle = 'rgba(255,255,246,0.20)';
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + dy);
      ctx.stroke();
    };
    for (let y = 48; y < ARENA_H - 45; y += 29) {
      const jitter = ((y * 17) % 9) - 4;
      paintedFibre(40 + jitter * 0.18, y, jitter * 0.09, 3.8);
      paintedFibre(ARENA_W - 40 + jitter * 0.16, y + 7, -jitter * 0.08, 3.4);
      paintedFibre(ARENA_W / 2 + jitter * 0.12, y + 13, jitter * 0.06, 3.7);
    }
    for (let x = 48; x < ARENA_W - 45; x += 31) {
      const jitter = ((x * 13) % 11) - 5;
      paintedFibre(x, 40 + jitter * 0.12, 3.5, jitter * 0.08);
      paintedFibre(x + 11, ARENA_H - 40 + jitter * 0.11, 3.8, -jitter * 0.07);
    }
    for (let angle = 0; angle < TAU; angle += 0.17) {
      const radius = 190 + ((Math.floor(angle * 100) * 7) % 5) - 2;
      const x = ARENA_W / 2 + Math.cos(angle) * radius;
      const y = ARENA_H / 2 + Math.sin(angle) * radius;
      paintedFibre(x, y, Math.cos(angle + 0.34) * 3.2, Math.sin(angle + 0.34) * 3.2);
    }
    if (this.liveStadium) {
      // Tiny olive interruptions and paint crumbs remove the last vector-clean
      // edge from the Showpiece markings. They stay deterministic and much
      // smaller than any collectible or combat decal.
      const paintWear = (x: number, y: number, angle: number, index: number): void => {
        const tangentX = Math.cos(angle);
        const tangentY = Math.sin(angle);
        const normalX = -tangentY;
        const normalY = tangentX;
        const offset = ((index * 17) % 7) - 3;
        const length = 1.2 + ((index * 11) % 5) * 0.34;
        ctx.strokeStyle = `rgba(75,88,35,${0.22 + (index % 3) * 0.045})`;
        ctx.lineWidth = 0.72 + (index % 2) * 0.18;
        ctx.beginPath();
        ctx.moveTo(x + normalX * offset * 0.22, y + normalY * offset * 0.22);
        ctx.lineTo(
          x + tangentX * length + normalX * offset * 0.3,
          y + tangentY * length + normalY * offset * 0.3,
        );
        ctx.stroke();
        if (index % 4 === 0) {
          ctx.fillStyle = 'rgba(251,249,224,0.28)';
          ctx.fillRect(x + normalX * 2.1, y + normalY * 2.1, 1.1, 0.8);
        }
      };
      for (let y = 54, i = 0; y < ARENA_H - 50; y += 37, i++) {
        paintWear(40, y, Math.PI / 2, i);
        paintWear(ARENA_W - 40, y + 11, Math.PI / 2, i + 29);
        paintWear(ARENA_W / 2, y + 19, Math.PI / 2, i + 61);
      }
      for (let x = 55, i = 0; x < ARENA_W - 50; x += 41, i++) {
        paintWear(x, 40, 0, i + 91);
        paintWear(x + 17, ARENA_H - 40, 0, i + 137);
      }
      for (let angle = 0, i = 0; angle < TAU; angle += 0.23, i++) {
        paintWear(
          ARENA_W / 2 + Math.cos(angle) * 190,
          ARENA_H / 2 + Math.sin(angle) * 190,
          angle + Math.PI / 2,
          i + 181,
        );
      }
      const wearRect = (left: number, top: number, width: number, height: number, seed: number): void => {
        let index = seed;
        for (let x = left + 13; x < left + width - 10; x += 43) {
          paintWear(x, top, 0, index++);
          paintWear(x + 19, top + height, 0, index++);
        }
        for (let y = top + 13; y < top + height - 10; y += 39) {
          paintWear(left, y, Math.PI / 2, index++);
          paintWear(left + width, y + 17, Math.PI / 2, index++);
        }
      };
      wearRect(40, boxY, boxW, boxH, 229);
      wearRect(ARENA_W - 40 - boxW, boxY, boxW, boxH, 317);
      wearRect(40, (ARENA_H - sixH) / 2, sixW, sixH, 409);
      wearRect(ARENA_W - 40 - sixW, (ARENA_H - sixH) / 2, sixW, sixH, 461);
      for (let angle = -Math.PI / 3.2, i = 0; angle <= Math.PI / 3.2; angle += 0.17, i++) {
        paintWear(
          40 + 230 + Math.cos(angle) * 150,
          ARENA_H / 2 + Math.sin(angle) * 150,
          angle + Math.PI / 2,
          521 + i,
        );
        const opposite = Math.PI + angle;
        paintWear(
          ARENA_W - 40 - 230 + Math.cos(opposite) * 150,
          ARENA_H / 2 + Math.sin(opposite) * 150,
          opposite + Math.PI / 2,
          559 + i,
        );
      }
      const cornerWearSpecs = [
        [40, 40, 0, Math.PI / 2, 601],
        [ARENA_W - 40, 40, Math.PI / 2, Math.PI, 619],
        [40, ARENA_H - 40, -Math.PI / 2, 0, 637],
        [ARENA_W - 40, ARENA_H - 40, Math.PI, Math.PI * 1.5, 653],
      ] as const;
      for (const [cornerX, cornerY, startAngle, endAngle, seed] of cornerWearSpecs) {
        let index = seed;
        for (let angle = startAngle; angle <= endAngle; angle += 0.19) {
          paintWear(
            cornerX + Math.cos(angle) * 42,
            cornerY + Math.sin(angle) * 42,
            angle + Math.PI / 2,
            index++,
          );
        }
      }
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Goals: layered mesh, ground shadow, rear frame and highlighted posts.
    // The old translucent box read as a UI rectangle rather than a real net.
    for (const side of [0, 1]) {
      const gx = side === 0 ? 40 : ARENA_W - 40;
      const dir = side === 0 ? -1 : 1;
      const frontX = gx;
      const backX = gx + dir * 52;
      const left = Math.min(frontX, backX);
      const top = ARENA_H / 2 - 130;
      const height = 260;
      ctx.save();
      const netDepth = Math.abs(backX - frontX);
      const netShadow = ctx.createLinearGradient(frontX, 0, backX, 0);
      netShadow.addColorStop(0, 'rgba(3,18,10,0.16)');
      netShadow.addColorStop(1, 'rgba(3,18,10,0.42)');
      ctx.fillStyle = netShadow;
      ctx.fillRect(left + 4, top + 7, netDepth, height);
      ctx.fillStyle = 'rgba(235,241,238,0.075)';
      ctx.fillRect(left, top, Math.abs(backX - frontX), height);

      ctx.strokeStyle = 'rgba(232,238,235,0.42)';
      ctx.lineWidth = 1.25;
      for (let row = 0; row <= 10; row++) {
        const y = top + (height * row) / 10;
        ctx.beginPath();
        ctx.moveTo(frontX, y);
        ctx.quadraticCurveTo(
          frontX + (backX - frontX) * 0.56,
          y + Math.sin((row / 10) * Math.PI) * 3.2,
          backX,
          y,
        );
        ctx.stroke();
      }
      for (let column = 0; column <= 5; column++) {
        const x = frontX + ((backX - frontX) * column) / 5;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.quadraticCurveTo(x + dir * Math.sin((column / 5) * Math.PI) * 2.6, top + height / 2, x, top + height);
        ctx.stroke();
      }

      // Rear stanchion, diagonal braces and four dark anchor plates establish
      // physical depth without adding a warning ring beneath the goal.
      ctx.strokeStyle = 'rgba(216,223,220,0.72)';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(backX, top);
      ctx.lineTo(backX, top + height);
      ctx.moveTo(frontX, top);
      ctx.lineTo(backX, top + 17);
      ctx.moveTo(frontX, top + height);
      ctx.lineTo(backX, top + height - 17);
      ctx.stroke();
      for (const anchorY of [top + 8, top + height - 8]) {
        ctx.fillStyle = 'rgba(7,21,13,0.54)';
        ctx.beginPath();
        ctx.ellipse(backX + dir * 2.5, anchorY + 3, 5.5, 3.2, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(220,224,211,0.62)';
        ctx.beginPath();
        ctx.arc(backX + dir * 2.5, anchorY + 1.5, 1.35, 0, TAU);
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(16,35,27,0.48)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(frontX + 4, top + 5);
      ctx.lineTo(frontX + 4, top + height + 5);
      ctx.stroke();
      ctx.strokeStyle = '#f5f7fa';
      ctx.lineWidth = 6;
      ctx.strokeRect(left, top, netDepth, height);
      ctx.beginPath();
      ctx.moveTo(frontX, top);
      ctx.lineTo(frontX, top + height);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.78)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(frontX - dir * 1.5, top + 2);
      ctx.lineTo(frontX - dir * 1.5, top + height - 2);
      ctx.stroke();
      ctx.restore();
    }

    // stadium lighting: dark corners, floodlight pools (procedural base only;
    // the arena plate ships its own baked floodlighting)
    if (!this.plate) {
      for (const [cx, cy] of [
        [0, 0],
        [ARENA_W, 0],
        [0, ARENA_H],
        [ARENA_W, ARENA_H],
      ]) {
        const dg = ctx.createRadialGradient(cx, cy, 80, cx, cy, 900);
        dg.addColorStop(0, 'rgba(4,10,8,0.26)');
        dg.addColorStop(1, 'rgba(4,10,8,0)');
        ctx.fillStyle = dg;
        ctx.fillRect(-MARGIN, -MARGIN, w, h);
      }
      for (const [cx, cy, cr] of [
        [ARENA_W / 2, ARENA_H / 2, 700],
        [ARENA_W * 0.18, ARENA_H / 2, 480],
        [ARENA_W * 0.82, ARENA_H / 2, 480],
      ]) {
        const lg = ctx.createRadialGradient(cx, cy, 40, cx, cy, cr);
        lg.addColorStop(0, 'rgba(255,250,220,0.09)');
        lg.addColorStop(1, 'rgba(255,250,220,0)');
        ctx.fillStyle = lg;
        ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
      }
    }

    // corner flags
    for (const [cx, cy] of [
      [40, 40],
      [ARENA_W - 40, 40],
      [40, ARENA_H - 40],
      [ARENA_W - 40, ARENA_H - 40],
    ]) {
      ctx.strokeStyle = 'rgba(48,64,20,0.21)';
      ctx.lineWidth = 0.9;
      for (let fibre = 0; fibre < 9; fibre++) {
        const angle = (fibre / 9) * TAU + cx * 0.001 + cy * 0.0007;
        const innerRadius = 3 + (fibre % 3) * 1.3;
        const outerRadius = 9 + (fibre % 4) * 2.1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * innerRadius, cy + Math.sin(angle) * innerRadius);
        ctx.lineTo(cx + Math.cos(angle) * outerRadius, cy + Math.sin(angle) * outerRadius);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(3,18,10,0.28)';
      ctx.beginPath();
      ctx.ellipse(cx + 9, cy + 3, 18, 5, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - 34);
      ctx.stroke();
      if (!this.liveStadium) {
        ctx.fillStyle = '#e8283f';
        ctx.beginPath();
        ctx.moveTo(cx, cy - 34);
        ctx.lineTo(cx + 22, cy - 27);
        ctx.lineTo(cx, cy - 20);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,244,208,0.46)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + 2, cy - 32);
        ctx.lineTo(cx + 18, cy - 27);
        ctx.stroke();
      }
    }

    return c;
  }

  /* ------------------------------------------------------------------ */

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /**
   * Picks the hero's atlas for the current locomotion state.
   * kind 'kick'     — one-shot wind-up/contact/recovery strip
   * kind 'idle'     — dedicated idle strip (generated art), loop its frames
   * kind 'run'      — run strip cycling while moving/dashing
   * kind 'run-held' — no idle art yet: hold the run strip's first frame
   *                   (a subtle breathing bob is added at draw time)
   */
  private heroVisual(
    def: PlayerDef,
    save: Save,
    running: boolean,
    kicking: boolean,
    direction: MovementDirection,
  ): { atlas: Atlas; kind: 'kick' | 'idle' | 'run-directional' | 'run' | 'run-held' } {
    const skinId = save.equippedSkin(def.id);
    const skin = skinId ? SKINS.find((s) => s.id === skinId) : undefined;
    const tint = skin?.kit.shirt;
    if (kicking) {
      const kickStrip = getStripAtlas(`${def.id}-kick`, tint);
      if (kickStrip) return { atlas: kickStrip, kind: 'kick' };
      void loadStripAtlas(`${def.id}-kick`, `art/players/${def.id}-kick.png`, tint);
    }
    if (!running) {
      const idleStrip = getStripAtlas(`${def.id}-idle`, tint);
      if (idleStrip) return { atlas: idleStrip, kind: 'idle' };
      // trigger a lazy load; until idle art exists, hold a neutral frame
      void loadStripAtlas(`${def.id}-idle`, `art/players/${def.id}-idle.png`, tint);
    }
    if (running) {
      const directionalId = `player-directional-${def.id}-${direction}`;
      const directional = getStripAtlas(directionalId, tint);
      if (directional) {
        trimStripAtlasCache('player-directional-', directionalId, 8);
        return { atlas: directional, kind: 'run-directional' };
      }
      // Load the requested view plus its two neighboring octants. This keeps
      // first-time turns seamless without decoding all 32 player atlases.
      const directionIndex = MOVEMENT_DIRECTIONS.indexOf(direction);
      for (const offset of [-1, 0, 1]) {
        const nextDirection = MOVEMENT_DIRECTIONS[(directionIndex + offset + MOVEMENT_DIRECTIONS.length) % MOVEMENT_DIRECTIONS.length];
        const nextId = `player-directional-${def.id}-${nextDirection}`;
        void loadStripAtlas(
          nextId,
          `art/players/directional-v2/${def.id}/${nextDirection}.webp`,
          tint,
          {
            frameWidth: PLAYER_DIRECTION_FRAME_WIDTH,
            frameHeight: 320,
            feetY: 312,
            minFrames: 12,
            maxFrames: 12,
            flippable: false,
            buildEffects: false,
          },
        ).then(() => trimStripAtlasCache('player-directional-', nextId, 8));
      }
      const runStrip = getStripAtlas(`${def.id}-run`, tint);
      if (runStrip) return { atlas: runStrip, kind: 'run' };
      void loadStripAtlas(`${def.id}-run`, `art/players/${def.id}-run.png`, tint);
    }
    // prefer the generated 2.5D strip; fall back to the procedural atlas
    const strip = getStripAtlas(def.id, tint);
    if (strip) return { atlas: strip, kind: running ? 'run' : 'run-held' };
    // trigger a lazy load (primed at boot; skin variants load on demand)
    void loadStripAtlas(def.id, `art/players/${def.id}.png`, tint);
    const key = `p:${def.id}:${skinId ?? 'base'}`;
    let a = this.atlasCache.get(key);
    if (!a) {
      a = playerAtlas(def, skin?.kit);
      this.atlasCache.set(key, a);
    }
    return { atlas: a, kind: running ? 'run' : 'run-held' };
  }

  /** Main per-frame draw. */
  draw(sim: Sim, def: PlayerDef, save: Save, time: number, debug: boolean): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (W === 0 || H === 0) return;

    // view: fixed world-height window
    const viewWorldH = 1240;
    this.scale = H / (viewWorldH * TILT);
    const scale = this.scale;
    const vw = W / scale;
    const vh = H / scale; // in tilted pixels

    // camera follows player, hard-clamped so the view never leaves the
    // painted world (bounds derive from the arena plate's real surround)
    const p = sim.player;
    const px = p ? p.x : this.camX;
    const py = p ? p.y : this.camY;
    this.camX += (px - this.camX) * 0.12;
    this.camY += (py - this.camY) * 0.12;
    const b = this.bounds;
    const minCx = b.x0 + vw / 2 + EDGE_PAD;
    const maxCx = b.x1 - vw / 2 - EDGE_PAD;
    this.camX = minCx <= maxCx ? clamp(this.camX, minCx, maxCx) : (b.x0 + b.x1) / 2;
    const minCy = b.y0 + vh / 2 / TILT + EDGE_PAD;
    const maxCy = b.y1 - vh / 2 / TILT - EDGE_PAD;
    this.camY = minCy <= maxCy ? clamp(this.camY, minCy, maxCy) : (b.y0 + b.y1) / 2;

    const camTX = this.camX - b.x0; // pitch-canvas coords (x)
    const camTY = (this.camY - b.y0) * TILT;

    this.shake *= 0.86;
    const shX = (Math.random() - 0.5) * this.shake * scale;
    const shY = (Math.random() - 0.5) * this.shake * scale;

    ctx.setTransform(scale, 0, 0, scale, shX, shY);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // pitch blit
    const sx = camTX - vw / 2;
    const sy = camTY - vh / 2;
    ctx.drawImage(this.pitch, sx, sy, vw, vh, 0, 0, vw, vh);

    const toSX = (wx: number) => wx - b.x0 - sx;
    const toSY = (wy: number) => (wy - b.y0) * TILT - sy;

    // animated crowd: jumping dots near the visible stands edge
    // (skipped when the arena plate supplies its own crowd)
    if (!this.plate) this.drawCrowd(ctx, toSX, toSY, sx + b.x0, sy / TILT + b.y0, vw, vh / TILT, time);
    if (this.liveStadium) this.drawLiveShowpieceStadium(ctx, b, sx, sy, vw, vh, time);
    if (this.liveStadium) this.drawPitchEdgeOcclusion(ctx, toSX, toSY);
    if (this.liveStadium) this.drawTurfWindFibres(ctx, toSX, toSY, time);
    if (this.liveStadium) this.drawLiveCornerFlags(ctx, toSX, toSY, time);

    // ground decals: telegraphs, flare zones, slow zones
    this.updateAndDrawTurfFootprints(ctx, sim, toSX, toSY, time);

    for (const t of sim.telegraphs) {
      if (!t.active) continue;
      const u = 1 - t.t / t.max;
      const tx = toSX(t.x);
      const ty = toSY(t.y);
      if (t.kind === 'cone') {
        // vuvuzela wedge: pulsing gold sector down the blast axis
        ctx.fillStyle = `rgba(255,210,63,${0.1 + u * 0.16})`;
        ctx.strokeStyle = `rgba(255,210,63,${0.45 + u * 0.45})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.ellipse(tx, ty, t.r * (0.25 + u * 0.75), t.r * (0.25 + u * 0.75) * TILT, 0, t.dir - 0.55, t.dir + 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        continue;
      }
      if (t.kind !== 'chant') {
        const frame = Math.min(5, Math.floor(u * 6));
        const diameter = t.r * (t.kind === 'summon' ? 2.18 : 2.06);
        if (this.drawGroundVfxFrame(ctx, this.bossWarningSpr, frame, tx, ty, diameter, 0.72 + u * 0.28)) {
          continue;
        }
      }
      const col =
        t.kind === 'shock' ? '232,40,63'
        : t.kind === 'flash' ? '245,247,250'
        : t.kind === 'chant' ? '55,214,122'
        : '232,40,63';
      ctx.fillStyle = `rgba(${col},${0.12 + u * 0.15})`;
      ctx.strokeStyle = `rgba(${col},${0.5 + u * 0.5})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(tx, ty, t.r, t.r * TILT, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
      if (t.kind === 'chant') {
        // sound waves radiating from the chant
        ctx.beginPath();
        ctx.ellipse(tx, ty, t.r * (0.4 + u * 0.6), t.r * (0.4 + u * 0.6) * TILT, 0, 0, TAU);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.ellipse(tx, ty, t.r * u, t.r * u * TILT, 0, 0, TAU);
        ctx.stroke();
      }
    }
    for (const z of sim.flareZones) {
      ctx.fillStyle = `rgba(255,120,40,${0.16 + 0.08 * Math.sin(time * 9)})`;
      ctx.beginPath();
      ctx.ellipse(toSX(z.x), toSY(z.y), z.r, z.r * TILT, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,154,61,0.6)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    for (const z of sim.slowZones) {
      ctx.fillStyle = `rgba(128,237,153,${0.1 + Math.min(0.12, z.t * 0.05)})`;
      ctx.beginPath();
      ctx.ellipse(toSX(z.x), toSY(z.y), z.r, z.r * TILT, 0, 0, TAU);
      ctx.fill();
    }

    // AERIAL aim/landing markers belong to the pitch decal layer. Drawing
    // them here guarantees that every enemy billboard, health bar and combat
    // pose is painted over the marker instead of being obscured by it.
    for (const rc of sim.reticles) {
      if (!rc.active) continue;
      const target = rc.targetIdx >= 0 ? sim.enemies[rc.targetIdx] : undefined;
      const u = clamp(rc.t / rc.max, 0, 1); // 1 -> 0 as the ball descends
      const x = toSX(rc.x);
      const y = toSY(rc.y);
      const baseDiameter = target?.active
        ? clamp(54 + target.radius * 1.45, 74, target.boss ? 176 : 112)
        : 86;
      const aiming = rc.phase === 'aim';
      const pulse = aiming ? 1 + Math.sin(time * 16) * 0.055 : 1;
      const targetFrame = aiming ? 1 : Math.min(5, Math.floor((1 - u) * 6));
      const diameter = aiming
        ? baseDiameter * 1.08 * pulse
        : baseDiameter * (0.82 + u * 0.55);
      this.drawGroundVfxFrame(
        ctx,
        this.aerialTargetSpr,
        targetFrame,
        x,
        y,
        diameter,
        aiming ? 0.72 : 0.58 + (1 - u) * 0.42,
      );
    }

    // A short alternating cleat press makes each authored foot plant legible
    // without restoring the artificial selection ring removed from the hero.
    if (p.moving && p.dashT <= 0 && p.kickT <= 0) {
      const step = playerStepCue(p.animT);
      if (step.strength > 0.01) {
        const dx = p.dashDx;
        const dy = p.dashDy * TILT;
        const length = Math.hypot(dx, dy) || 1;
        const forwardX = dx / length;
        const forwardY = dy / length;
        const sideX = -forwardY;
        const sideY = forwardX;
        const footX = toSX(p.x) - forwardX * 4 + sideX * step.foot * 6;
        const footY = toSY(p.y) - forwardY * 4 + sideY * step.foot * 6 + 1;
        ctx.save();
        ctx.translate(footX, footY);
        ctx.rotate(Math.atan2(forwardY, forwardX));
        ctx.globalAlpha = step.strength * 0.48;
        ctx.strokeStyle = '#d8f3c8';
        ctx.lineWidth = 1.35;
        ctx.lineCap = 'round';
        for (const offset of [-2.2, 0, 2.2]) {
          ctx.beginPath();
          ctx.moveTo(-6.5, offset);
          ctx.lineTo(3.5, offset * 0.72);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // pickups
    for (const pk of sim.pickups) {
      if (!pk.active) continue;
      const img = pk.kind === 'coin' ? this.coinSpr
        : pk.kind === 'heal' ? this.healSpr
          : pk.kind === 'trophy' ? this.trophySpr
            : pk.kind === 'magnet' ? this.magnetSpr
              : pk.kind === 'bomb' ? this.bombSpr
                : pk.kind === 'freeze' ? this.freezeSpr
                  : this.xpSpr[pk.tier - 1];
      const baseSize = pk.kind === 'trophy' ? 52
        : pk.kind === 'magnet' ? 52
          : pk.kind === 'bomb' ? 50
            : pk.kind === 'freeze' ? 50
              : pk.kind === 'heal' ? 42
                : pk.kind === 'coin' ? 30
                  : pk.tier === 3 ? 38 : pk.tier === 2 ? 32 : 27;
      // Pickups are physical objects resting on the turf. Keep the world point
      // as the sprite's bottom contact instead of centering/bobbing it above
      // the grass; all identity and rarity lighting lives in the asset itself.
      const groundX = toSX(pk.x);
      const groundY = toSY(pk.y) + 4;
      ctx.drawImage(img, groundX - baseSize / 2, groundY - baseSize, baseSize, baseSize);
    }

    /* corpses: fallen enemies topple sideways, sink and fade (under live entities) */
    for (const c of sim.corpses) {
      if (!c.active) continue;
      const u = c.t / c.max;
      const atlas = this.enemyAtlasFor({ def: ENEMIES[c.enemyId as keyof typeof ENEMIES] ?? ENEMIES.invader, boss: c.boss, variant: c.variant });
      // Generated strips are 4x the procedural atlas resolution. Normalize by
      // source height so swapping art never changes the enemy's world size.
      const sc = ENEMY_ENTITY_SCALE * (80 / atlas.fh) * (c.boss ? BOSSES[c.boss].scale : (ENEMIES[c.enemyId as keyof typeof ENEMIES]?.scale ?? 1)) * (c.elite ? 1.22 : 1);
      const fall = Math.min(1, u * 2.4); // topple quickly, then fade
      const alpha = u < 0.5 ? 1 : Math.max(0, 1 - (u - 0.5) / 0.5);
      const x = toSX(c.x);
      const y = toSY(c.y);
      const knockoutFrame = Math.min(5, Math.floor(clamp(u / 0.72, 0, 0.999) * 6));
      const knockoutSize = c.boss ? 178 : c.elite ? 132 : 104;
      this.drawVfxFrame(ctx, this.knockoutSpr, knockoutFrame, x, y - 11, knockoutSize, 0, alpha * 0.92, false);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, y - 3);
      ctx.rotate(c.face * fall * 1.35); // topple toward the facing side
      const dw = atlas.fw * sc;
      const dh = atlas.fh * sc;
      const frame = atlas.frames >= 4 ? 3 : 0;
      ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc, dw, dh);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // Orbiting Press is intentionally a rear gameplay layer. The balls still
    // use their true simulation positions for contact, but every live actor —
    // especially the hero — is painted over them so they can never unnaturally
    // cross in front of a body.
    const orbitLvl = sim.abilityLevel('orbit');
    if (orbitLvl > 0) {
      const count = [0, 2, 3, 3, 4, 5][orbitLvl] + (def.id === 'yamal' ? 1 : 0);
      const radius = [0, 90, 90, 115, 115, 140][orbitLvl];
      for (let b = 0; b < count; b++) {
        const a = p.orbitAngle + (b / count) * TAU;
        const ox = toSX(p.x + Math.cos(a) * radius);
        const oy = toSY(p.y + Math.sin(a) * radius);
        const lift = 12 + Math.sin(time * 7 + b * 1.7) * 3;
        ctx.fillStyle = 'rgba(4,10,6,0.24)';
        ctx.beginPath();
        ctx.ellipse(ox, oy + 2, 8, 3.4, 0, 0, TAU);
        ctx.fill();
        ctx.save();
        ctx.translate(ox, oy - lift);
        const orbitFrame = Math.floor(time * 14 + b * 1.7);
        ctx.rotate(Math.sin(time * 5 + b) * 0.12);
        this.drawMatchBall(ctx, 0, 0, 28, orbitFrame);
        ctx.restore();
      }
    }

    /* depth-sorted draw list */
    interface Item {
      y: number;
      kind: number; // 0 enemy, 1 player, 2 guard
      idx: number;
    }
    const items: Item[] = [];
    for (let i = 0; i < sim.enemies.length; i++) {
      const e = sim.enemies[i];
      if (e.active) items.push({ y: e.y, kind: 0, idx: i });
    }
    for (let i = 0; i < sim.guards.length; i++) items.push({ y: sim.guards[i].y, kind: 2, idx: i });
    if (p) items.push({ y: p.y, kind: 1, idx: 0 });
    items.sort((a, b) => a.y - b.y);

    for (const it of items) {
      if (it.kind === 0) {
        const e = sim.enemies[it.idx];
        const semanticAtlas = this.enemyAtlasFor(e);
        const locomoting = e.moving && e.windup <= 0 && e.lungeT <= 0 && e.attackAnimT <= 0 && e.telegraph <= 0 && e.hurtT <= 0;
        const runAtlas = locomoting ? this.enemyRunAtlasFor(e) : null;
        const atlas = runAtlas ?? semanticAtlas;
        const directionalBossRun = !!(e.boss && runAtlas && runAtlas.frames === 12);
        const bossBreath = e.boss ? 1 + Math.sin(time * (e.boss === 'captain' ? 2.6 : 2.2) + it.idx) * 0.018 : 1;
        // Semantic lobber frames are already height-normalized in the source
        // strip (idle 233px, throw 232px). A previous 0.87 multiplier made the
        // whole character shrink during its cast despite matching source art.
        const sc = ENEMY_ENTITY_SCALE * (80 / atlas.fh) * (e.boss ? BOSSES[e.boss].scale : e.def.scale) * (e.elite ? 1.22 : 1) * bossBreath;
        const x = toSX(e.x);
        const y = toSY(e.y);
        // Permanent aerial troops hover; temporarily launched mobs follow an arc.
        const lift = e.def.behavior === 'aerial'
          ? 38 + Math.sin(e.animT * 7.5) * 4
          : e.airT > 0 ? Math.sin(Math.PI * (1 - e.airT / 0.38)) * 22 : 0;
        const hitAngle = Math.atan2(e.hurtDy * TILT, e.hurtDx || e.face);
        if (e.orbitHitT > 0 && this.orbitSkidSpr) {
          const u = clamp(1 - e.orbitHitT / 0.38, 0, 1);
          const skidSize = clamp(78 + e.radius * 1.35, 92, e.boss ? 154 : 124);
          ctx.save();
          ctx.globalAlpha = Math.sin(Math.PI * clamp(u * 1.1, 0, 1)) * 0.86;
          ctx.translate(x - e.hurtDx * 12, y - e.hurtDy * 12 * TILT - 1);
          ctx.rotate(hitAngle);
          ctx.scale(0.72 + u * 0.38, 0.72 + u * 0.18);
          ctx.drawImage(this.orbitSkidSpr, -skidSize * 0.82, -skidSize / 2, skidSize, skidSize);
          ctx.restore();
        }
        // Characters are grounded by their delivered feet baseline. Extra
        // drop shadows and elite foot-rings made the cutouts appear to hover.
        if (e.telegraph > 0) {
          const pulse = 0.55 + Math.sin(time * 18) * 0.25;
          if (e.def.behavior === 'charger') {
            const ex = toSX(e.x + e.chargeDx * 520);
            const ey = toSY(e.y + e.chargeDy * 520);
            const laneDx = ex - x;
            const laneDy = ey - y;
            const laneLength = Math.hypot(laneDx, laneDy);
            const laneFrame = Math.min(5, Math.floor(clamp(1 - e.telegraph / 0.72, 0, 0.999) * 6));
            this.drawVfxFrameRect(
              ctx,
              this.bullChargeLaneSpr,
              laneFrame,
              x + laneDx / 2,
              y + laneDy / 2,
              laneLength + 64,
              92,
              Math.atan2(laneDy, laneDx),
              0.68 + pulse * 0.25,
              false,
            );
          } else if (e.def.behavior === 'aerial' && p) {
            ctx.strokeStyle = `rgba(112,231,255,${pulse})`;
            ctx.lineWidth = 2.5;
            ctx.setLineDash([7, 7]);
            ctx.beginPath();
            ctx.moveTo(x, y - lift);
            ctx.lineTo(toSX(p.x), toSY(p.y) - 12);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        if (e.windup > 0 && e.telegraph <= 0 && e.casting === '' && e.def.behavior !== 'aerial') {
          // Every melee swing exposes a short red contact wedge. It reads as
          // intent at crowd scale without turning the pitch into warning spam.
          const pulse = 0.58 + Math.sin(time * 24) * 0.18;
          ctx.strokeStyle = `rgba(255,61,85,${pulse})`;
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(x + e.face * 20, y - 3, 25 + e.radius * 0.22, e.face > 0 ? -1.05 : Math.PI - 2.1, e.face > 0 ? 1.05 : Math.PI + 2.1);
          ctx.stroke();
        }
        // Six-frame locomotion plays only while the simulation reports real
        // movement. Idle, attack and hurt remain explicit semantic poses.
        const runFps = directionalBossRun ? 14 : e.def.behavior === 'aerial' ? 8 : 10.5;
        const frame = runAtlas ? Math.floor(e.animT * runFps) % runAtlas.frames : enemyPoseFrame(e, atlas.frames);
        const useFlash = e.flash > 0;
        const img = useFlash ? atlas.flash : atlas.canvas;
        const dw = atlas.fw * sc;
        const dh = atlas.fh * sc;
        ctx.save();
        ctx.translate(x, y - lift);
        if (locomoting && !directionalBossRun) {
          const gait = Math.sin(e.animT * 12);
          ctx.translate(e.face * gait * 1.5, 0);
          ctx.rotate(e.face * gait * 0.018);
          ctx.scale(1 + Math.abs(gait) * 0.008, 1 - Math.abs(gait) * 0.012);
        }
        if (e.windup > 0) {
          const windupMax = e.def.behavior === 'charger' ? 0.72 : e.def.behavior === 'aerial' ? 0.46 : 0.34;
          const w = clamp(1 - e.windup / windupMax, 0, 1);
          const ease = w * w * (3 - 2 * w);
          ctx.translate(-e.face * (3 + ease * 9), ease * 3);
          ctx.rotate(-e.face * 0.13 * ease);
          ctx.scale(1 - ease * 0.035, 1 + ease * 0.025);
        } else if (e.lungeT > 0) {
          if (e.def.behavior === 'charger') {
            const charge = 0.5 + Math.sin(e.animT * 22) * 0.5;
            ctx.translate(e.chargeDx * 7, e.chargeDy * 3);
            ctx.rotate(e.face * 0.025 * charge);
            ctx.scale(1.07, 0.94);
          } else {
            const progress = clamp(1 - e.lungeT / 0.14, 0, 1);
            const strike = Math.sin(Math.PI * progress);
            ctx.translate(e.face * strike * 18, -strike * 2);
            ctx.rotate(e.face * strike * 0.1);
            ctx.scale(1 + strike * 0.08, 1 - strike * 0.07);
          }
        } else if (e.telegraph > 0) {
          const cast = 0.5 + 0.5 * Math.sin(e.animT * 18);
          ctx.translate(e.face * cast * 3, -cast * 4);
          ctx.rotate(e.face * (cast - 0.5) * 0.045);
          ctx.scale(1 + cast * 0.035, 1 - cast * 0.02);
        } else if (e.attackAnimT > 0) {
          const recover = clamp(e.attackAnimT / 0.32, 0, 1);
          const follow = Math.sin(Math.PI * recover);
          ctx.translate(e.face * follow * 9, -follow * 2);
          ctx.rotate(e.face * follow * 0.07);
          ctx.scale(1 + follow * 0.035, 1 - follow * 0.025);
        }
        if (e.hurtT > 0) {
          const hurtMax = e.hurtStrength > 0.75 ? 0.32 : 0.26;
          const elapsed = clamp(1 - e.hurtT / hurtMax, 0, 1);
          const recoil = Math.sin(Math.PI * elapsed);
          const kick = (8 + e.hurtStrength * 8) * recoil;
          ctx.translate(e.hurtDx * kick, e.hurtDy * kick * TILT - recoil * (2 + e.hurtStrength * 3));
          ctx.rotate(e.hurtDx * recoil * 0.1);
          ctx.scale(1 + recoil * 0.07, 1 - recoil * 0.1);
        }
        if (e.def.behavior === 'aerial') {
          const hover = Math.sin(e.animT * 10);
          ctx.rotate(hover * 0.018);
          ctx.scale(1 + Math.abs(hover) * 0.012, 1 - Math.abs(hover) * 0.008);
        }
        if (e.face < 0 && !directionalBossRun) ctx.scale(-1, 1);
        ctx.drawImage(img, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc, dw, dh);
        if (sim.freezeT > 0) {
          // The precomputed material is clipped to this atlas and exact pose;
          // the old one-size ice shell made bulls, drones and humans identical.
          const elapsed = Number.isFinite(sim.freezeT)
            ? Math.max(0, FREEZE_DURATION - sim.freezeT)
            : 0.72;
          const flicker = 0.92 + Math.sin(elapsed * 12 + it.idx * 0.71) * 0.04;
          ctx.globalAlpha = flicker;
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(atlas.frost, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc, dw, dh);
        }
        ctx.restore();
        if (e.orbitHitT > 0 && this.orbitImpactSpr) {
          const u = clamp(1 - e.orbitHitT / 0.38, 0, 1);
          const impactSize = clamp(82 + e.radius * 1.2, 94, e.boss ? 164 : 132);
          ctx.save();
          ctx.globalAlpha = Math.pow(1 - u, 1.7) * 0.96;
          ctx.globalCompositeOperation = 'lighter';
          ctx.translate(x - e.hurtDx * 9, y - lift - Math.min(30, e.radius * sc * 0.34));
          ctx.rotate(hitAngle);
          ctx.scale(0.72 + u * 0.58, 0.72 + u * 0.34);
          ctx.drawImage(this.orbitImpactSpr, -impactSize * 0.82, -impactSize / 2, impactSize, impactSize);
          ctx.restore();
        }
        if (e.lungeT > 0 && e.def.behavior !== 'charger') {
          const strikeProgress = clamp(1 - e.lungeT / 0.16, 0, 0.999);
          this.drawVfxFrame(
            ctx,
            this.playerHurtSpr,
            Math.floor(strikeProgress * 6),
            x + e.face * 28,
            y - lift - 26,
            clamp(82 + e.radius, 92, 132),
            e.face < 0 ? Math.PI : 0,
            0.76,
            true,
            0.7,
          );
        }
        // Every ordinary living threat carries a compact physical scoreboard
        // bar; elites gain numeric HP and a stronger metal/glow accent.
        // Generated plates retain transparent headroom; compensate here so
        // the bar hugs the visible silhouette instead of floating too high.
        const healthY = y - lift - atlas.feetY * sc + (e.boss ? 8 : e.elite ? 8 : 12);
        // Boss HP already has a large persistent screen-space plate; omitting
        // the duplicate billboard prevents it clipping above giant bosses.
        if (!e.boss) this.drawEnemyHealthBar(ctx, e, x, healthY, time);
      } else if (it.kind === 1) {
        const running = p.moving || p.dashT > 0;
        const direction = movementDirection(p.dashDx, p.dashDy);
        const vis = this.heroVisual(def, save, running, p.kickT > 0, direction);
        const heroSkinId = save.equippedSkin(def.id);
        const heroSkin = heroSkinId ? SKINS.find((skin) => skin.id === heroSkinId) : undefined;
        const semanticAtlas = p.hurtT > 0 || sim.over === 'lost'
          ? getStripAtlas(def.id, heroSkin?.kit.shirt)
          : null;
        const atlas = semanticAtlas ?? vis.atlas;
        const x = toSX(p.x);
        const y = toSY(p.y);
        // Two tight cleat occlusion marks visually pin the authored foot
        // baseline to the turf. They are deliberately tiny and independent —
        // never a selection disc or character ring — so the player reads as
        // standing on detailed grass without looking like a floating token.
        ctx.save();
        ctx.fillStyle = 'rgba(2, 18, 8, 0.24)';
        ctx.beginPath();
        ctx.ellipse(x - 5.2, y + 0.8, 6.8, 2.05, -0.14, 0, TAU);
        ctx.ellipse(x + 5.2, y + 0.8, 6.8, 2.05, 0.14, 0, TAU);
        ctx.fill();
        ctx.restore();
        // dash trail
        if (p.dashT > 0) {
          const dashAngle = Math.atan2(p.dashDy * TILT, p.dashDx);
          ctx.save();
          ctx.translate(x, y - 8);
          ctx.rotate(dashAngle);
          const dashGlow = ctx.createLinearGradient(-86, 0, 5, 0);
          dashGlow.addColorStop(0, 'rgba(128,237,153,0)');
          dashGlow.addColorStop(0.68, 'rgba(128,237,153,0.32)');
          dashGlow.addColorStop(1, 'rgba(232,255,238,0.8)');
          ctx.strokeStyle = dashGlow;
          ctx.lineWidth = 8;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-86, 0);
          ctx.lineTo(2, 0);
          ctx.stroke();
          // Alternating cleat cuts make the trail read as a football sprint,
          // not a generic sci-fi beam.
          for (let mark = 0; mark < 4; mark++) {
            const mx = -18 - mark * 17;
            const my = (mark % 2 === 0 ? -1 : 1) * 6;
            ctx.globalAlpha = 0.78 - mark * 0.13;
            ctx.fillStyle = '#bfffd0';
            ctx.beginPath();
            ctx.ellipse(mx, my, 6.5, 2.2, mark % 2 === 0 ? -0.24 : 0.24, 0, TAU);
            ctx.fill();
            ctx.strokeStyle = '#37d67a';
            ctx.lineWidth = 1.5;
            for (let cleat = -1; cleat <= 1; cleat++) {
              ctx.beginPath();
              ctx.moveTo(mx + cleat * 3, my - 5);
              ctx.lineTo(mx + cleat * 3 - 4, my - 10);
              ctx.stroke();
            }
          }
          ctx.restore();
        }
        // Idle plays the dedicated neutral clip. Keep the feet planted; any
        // breathing motion belongs inside the art rather than moving the body.
        const directionalBlend = vis.kind === 'run-directional'
          ? directionalFrameBlend(p.animT, PLAYER_DIRECTION_RUN_FPS, atlas.frames)
          : null;
        const frame = semanticAtlas
          ? Math.min(3, semanticAtlas.frames - 1)
          : vis.kind === 'kick'
            ? Math.min(atlas.frames - 1, Math.floor(clamp(1 - p.kickT / KICK_DURATION, 0, 0.999) * atlas.frames))
          : vis.kind === 'idle' ? Math.floor(time * 4.5) % atlas.frames
          : directionalBlend ? directionalBlend.frame
          : vis.kind === 'run' ? Math.floor(p.animT * 12.2) % atlas.frames
          : 0;
        const step = directionalBlend ? playerStepCue(p.animT, PLAYER_DIRECTION_RUN_FPS, atlas.frames) : null;
        // Lift only between planted poses. Contact frames retain the exact
        // delivered feet baseline, so the runner reads as stepping, not sliding.
        const bobY = step ? -(1 - step.strength) * 1.5 : 0;
        const sc = PLAYER_ENTITY_SCALE * (80 / atlas.fh);
        const dw = atlas.fw * sc;
        const dh = atlas.fh * sc;
        const blink = p.iframes > 0 && Math.floor(time * 20) % 2 === 0;
        ctx.save();
        ctx.translate(x, y);
        if (sim.over === 'lost') {
          if (this.lossStartedAt < 0) this.lossStartedAt = time;
          const fall = clamp((time - this.lossStartedAt) / 0.72, 0, 1);
          const easedFall = Math.sin((fall * Math.PI) / 2);
          ctx.translate(p.face * easedFall * 18, easedFall * 9);
          ctx.rotate(p.face * easedFall * 1.18);
        }
        if (p.hurtT > 0) {
          const recoil = Math.sin(Math.PI * clamp(p.hurtT / 0.32, 0, 1));
          ctx.translate(p.hurtDx * recoil * 11, p.hurtDy * recoil * 11 * TILT - recoil * 3);
          ctx.rotate(p.hurtDx * recoil * 0.07);
          ctx.scale(1 + recoil * 0.05, 1 - recoil * 0.08);
        }
        if (p.face < 0 && atlas.flippable) ctx.scale(-1, 1);
        const visibleAlpha = blink ? 0.45 : 1;
        if (directionalBlend) {
          ctx.globalAlpha = visibleAlpha * (1 - directionalBlend.mix);
          ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc + bobY, dw, dh);
          ctx.globalAlpha = visibleAlpha * directionalBlend.mix;
          ctx.drawImage(
            atlas.canvas,
            directionalBlend.nextFrame * atlas.fw,
            0,
            atlas.fw,
            atlas.fh,
            -dw / 2,
            -atlas.feetY * sc + bobY,
            dw,
            dh,
          );
        } else {
          ctx.globalAlpha = visibleAlpha;
          ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc + bobY, dw, dh);
        }
        ctx.restore();
        if (p.heartFxT > 0) {
          const age = Number.isFinite(p.heartFxT) ? clamp(1 - p.heartFxT / 0.9, 0, 0.999) : 0.72;
          const heartFrame = Math.min(5, Math.floor(age * 6));
          const heartAlpha = Math.min(1, p.heartFxT * 2.8);
          this.drawVfxFrame(ctx, this.captainsHeartSpr, heartFrame, x, y - 148, 102 + age * 12, 0, heartAlpha, false);
        }
        if (p.hurtT > 0) {
          const hurtProgress = clamp(1 - p.hurtT / 0.32, 0, 0.999);
          this.drawVfxFrame(ctx, this.playerHurtSpr, Math.floor(hurtProgress * 6), x, y - 30, 118, 0, 0.96, true);
        }
      } else {
        const g = sim.guards[it.idx];
        const guardIds = ['ally-bodyguard-rookie', 'ally-bodyguard', 'ally-bodyguard-heavy', 'ally-bodyguard-scout'] as const;
        const semanticAtlas = getStripAtlas(guardIds[g.variant]) ?? guardAtlas();
        const locomoting = g.moving && g.strikeT <= 0 && g.blockT <= 0;
        const runAtlas = locomoting ? getStripAtlas(`${guardIds[g.variant]}-run`) : null;
        const atlas = runAtlas ?? semanticAtlas;
        const variantScale = g.variant === 0 ? 0.92 : g.variant === 2 ? 1.14 : g.variant === 3 ? 1.02 : 0.87;
        const sc = ALLY_ENTITY_SCALE * (80 / atlas.fh) * variantScale;
        const x = toSX(g.x);
        const y = toSY(g.y);
        if (g.strikeT > 0) {
          const strikeProgress = clamp(1 - g.strikeT / 0.24, 0, 0.999);
          this.drawVfxFrame(
            ctx,
            this.guardSlamSpr,
            Math.floor(strikeProgress * 6),
            x + g.face * (g.variant === 2 ? 34 : 28),
            y - 18,
            g.variant === 2 ? 112 : 90,
            g.face < 0 ? Math.PI : 0,
            0.82,
            true,
          );
        }
        const frame = runAtlas
          ? Math.floor(g.animT * (g.variant === 3 ? 11.5 : g.variant === 0 ? 11 : 10.5)) % runAtlas.frames
          : guardPoseFrame(g, semanticAtlas.frames);
        ctx.save();
        ctx.translate(x, y);
        if (g.strikeT > 0) {
          const punch = Math.sin(Math.PI * (1 - g.strikeT / 0.24));
          ctx.translate(g.face * punch * 7, -punch);
          ctx.rotate(g.face * punch * 0.045);
        } else if (g.blockT > 0) {
          const brace = 0.5 + 0.5 * Math.sin(g.animT * 20);
          ctx.scale(1 + brace * 0.016, 1 - brace * 0.008);
        }
        if (g.face < 0) ctx.scale(-1, 1);
        ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -(atlas.fw * sc) / 2, -atlas.feetY * sc, atlas.fw * sc, atlas.fh * sc);
        ctx.restore();
      }
    }

    // The net and anchor hardware belong to the pitch layer, but the elevated
    // front bar must occlude actors crossing beneath it. Redrawing only that
    // narrow bar prevents the player from looking pasted over the whole goal.
    this.drawGoalForeground(ctx, toSX, toSY);

    // balls (AERIAL lobs: height via z, moving ground shadow sells the arc)
    for (const b of sim.balls) {
      if (!b.active) continue;
      const x = toSX(b.x);
      const y = toSY(b.y);
      const hFrac = clamp(b.z / 240, 0, 1);
      // ground shadow tracks the landing point, shrinking/fading with height
      ctx.fillStyle = `rgba(4,10,6,${0.3 * (1 - hFrac * 0.6)})`;
      ctx.beginPath();
      ctx.ellipse(x, y + 2, 7 * (1 - hFrac * 0.45), 3 * (1 - hFrac * 0.45), 0, 0, TAU);
      ctx.fill();
      ctx.save();
      ctx.translate(x, y - 16 - b.z);
      ctx.rotate(Math.sin(b.flightT * 9) * 0.1);
      const bs = 1 + hFrac * 0.12; // slight forced perspective near the apex
      this.drawMatchBall(ctx, 0, 0, 24 * bs, Math.floor(b.flightT * 16 * Math.max(0.6, Math.abs(b.spin))));
      ctx.restore();
    }
    // Homing AERIAL seekers: physical airborne sprites paired with generated
    // six-frame wakes. The wake anchor follows the projectile through turns.
    for (const s of sim.seekers) {
      if (!s.active) continue;
      const x = toSX(s.x);
      const y = toSY(s.y);
      const lift = 16 + s.z;
      const size = s.kind === 'curveball' ? 40 : 48;
      const screenAngle = Math.atan2(s.vy * TILT, s.vx);
      const age = s.maxLife - s.life;

      ctx.fillStyle = 'rgba(4,10,6,0.24)';
      ctx.beginPath();
      ctx.ellipse(x, y + 2, s.kind === 'curveball' ? 8 : 11, s.kind === 'curveball' ? 3.5 : 4.5, 0, 0, TAU);
      ctx.fill();

      // A ping-pong frame order keeps the generated wake breathing without a
      // visible jump from its dissipated final cell back to the full burst.
      const wakeOrder = [0, 1, 2, 3, 2, 1];
      const wakeFrame = wakeOrder[Math.floor(age * 15 + s.phase * 2) % wakeOrder.length];
      const wakeSprite = s.kind === 'curveball' ? this.curveTrailSpr : this.goldenBootTrailSpr;
      this.drawVfxFrame(
        ctx,
        wakeSprite,
        wakeFrame,
        x,
        y - lift,
        s.kind === 'curveball' ? 112 : 134,
        screenAngle,
        s.kind === 'curveball' ? 0.86 : 0.98,
        true,
        0.82,
      );

      const sprite = s.kind === 'curveball' ? this.curveballSpr : this.goldenBootSpr;
      ctx.save();
      ctx.translate(x, y - lift);
      const pulse = 1 + Math.sin(age * 14 + s.phase) * (s.kind === 'curveball' ? 0.035 : 0.025);
      ctx.rotate(s.kind === 'curveball'
        ? age * 13 + s.phase
        : screenAngle + Math.PI / 4 + Math.sin(age * 17 + s.phase) * 0.06);
      ctx.drawImage(sprite, -size * pulse / 2, -size * pulse / 2, size * pulse, size * pulse);
      ctx.restore();
    }
    // bottles
    for (const b of sim.bottles) {
      if (!b.active) continue;
      const bx = toSX(b.x);
      const by = toSY(b.y) - (b.kind === 'electric' ? 28 : 12);
      ctx.save();
      ctx.translate(bx, by);
      if (b.kind === 'electric') {
        const a = Math.atan2(b.vy * TILT, b.vx);
        const age = Math.max(0, 1.45 - b.life);
        const shotFrame = age < 0.08 ? 0 : 1 + (Math.floor(time * 22 + age * 9) % 4);
        this.drawVfxFrame(ctx, this.droneShotSpr, shotFrame, 0, 0, 72, a, 0.98, true, 0.44);
      } else {
        ctx.rotate(time * 9);
        ctx.drawImage(this.bottleSpr, -6, -10, 12, 20);
      }
      ctx.restore();
    }

    // rings
    for (const r of sim.rings) {
      if (!r.active) continue;
      const a = clamp(r.life / 0.45, 0, 1);
      if (r.color === '#7ce7ff' && this.guardSlamSpr) {
        const slamProgress = clamp(1 - r.life / 0.45, 0, 0.999);
        this.drawVfxFrame(
          ctx,
          this.guardSlamSpr,
          Math.floor(slamProgress * 6),
          toSX(r.x),
          toSY(r.y) - 12,
          Math.max(116, r.maxR * 1.72),
          0,
          Math.min(1, a * 1.35),
          true,
        );
        continue;
      }
      const whistle = r.color === '#f5f7fa';
      const pitchBlast = r.color === '#a8ff4d' || r.color === '#f5ff9b';
      ctx.globalAlpha = whistle ? a * 0.9 : a;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 5 * a + 1;
      ctx.beginPath();
      ctx.ellipse(toSX(r.x), toSY(r.y), r.r, r.r * TILT, 0, 0, TAU);
      ctx.stroke();
      if (whistle) {
        // Short tangential sound dashes keep Captain's Whistle visually
        // separate from damage blasts while staying readable in a crowd.
        ctx.strokeStyle = `rgba(225,248,255,${a * 0.82})`;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        for (let dash = 0; dash < 12; dash++) {
          const angle = (dash / 12) * TAU + time * 0.35;
          const inner = r.r - 9;
          const outer = r.r + 9;
          ctx.beginPath();
          ctx.moveTo(toSX(r.x + Math.cos(angle) * inner), toSY(r.y + Math.sin(angle) * inner));
          ctx.lineTo(toSX(r.x + Math.cos(angle) * outer), toSY(r.y + Math.sin(angle) * outer));
          ctx.stroke();
        }
      } else if (pitchBlast) {
        // Jagged turf fissures belong to the GROUND layer; the separate cyan
        // airburst impact above it communicates the smaller AERIAL detonation.
        ctx.strokeStyle = `rgba(214,255,140,${a * 0.72})`;
        ctx.lineWidth = 2.5;
        for (let crack = 0; crack < 8; crack++) {
          const angle = (crack / 8) * TAU + 0.22;
          const inner = Math.max(12, r.r * 0.34);
          const mid = r.r * 0.61;
          const outer = r.r * 0.88;
          ctx.beginPath();
          ctx.moveTo(toSX(r.x + Math.cos(angle) * inner), toSY(r.y + Math.sin(angle) * inner));
          ctx.lineTo(toSX(r.x + Math.cos(angle + 0.08) * mid), toSY(r.y + Math.sin(angle + 0.08) * mid));
          ctx.lineTo(toSX(r.x + Math.cos(angle - 0.035) * outer), toSY(r.y + Math.sin(angle - 0.035) * outer));
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;

    // pitch pressure rings (GROUND lane: pitch-hugging expanding front)
    for (const pr of sim.pressures) {
      if (!pr.active) continue;
      const u = pr.r / pr.maxR;
      const a = (1 - u) * 0.8 + 0.15;
      ctx.fillStyle = `rgba(55,214,122,${0.07 * (1 - u)})`;
      ctx.beginPath();
      ctx.ellipse(toSX(pr.x), toSY(pr.y), pr.r, pr.r * TILT, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(55,214,122,${a})`;
      ctx.lineWidth = 7 * (1 - u) + 2;
      ctx.beginPath();
      ctx.ellipse(toSX(pr.x), toSY(pr.y), pr.r, pr.r * TILT, 0, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = `rgba(245,247,250,${a * 0.5})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(toSX(pr.x), toSY(pr.y), Math.max(1, pr.r - 7), (pr.r - 7) * TILT, 0, 0, TAU);
      ctx.stroke();
      // Pitch-facing chevrons point with the shove front. At max level their
      // reversed inner row also exposes the brief vortex pull before release.
      const maxPressure = sim.abilityLevel('pressure') >= 5;
      const arrows = pr.r > 42 ? 8 : 4;
      ctx.lineWidth = 2;
      for (let arrow = 0; arrow < arrows; arrow++) {
        const angle = (arrow / arrows) * TAU + time * 0.18;
        const ax = toSX(pr.x + Math.cos(angle) * pr.r);
        const ay = toSY(pr.y + Math.sin(angle) * pr.r);
        const screenAngle = Math.atan2(Math.sin(angle) * TILT, Math.cos(angle));
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(screenAngle);
        ctx.strokeStyle = `rgba(229,255,238,${a * 0.78})`;
        ctx.beginPath();
        ctx.moveTo(-7, -5);
        ctx.lineTo(1, 0);
        ctx.lineTo(-7, 5);
        ctx.stroke();
        if (maxPressure) {
          ctx.strokeStyle = `rgba(128,237,153,${a * 0.5})`;
          ctx.beginPath();
          ctx.moveTo(-15, -4);
          ctx.lineTo(-21, 0);
          ctx.lineTo(-15, 4);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // particles
    for (const pt of sim.particles) {
      if (!pt.active) continue;
      const a = clamp(pt.life / pt.maxLife, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = pt.color;
      ctx.fillRect(toSX(pt.x) - pt.size / 2, toSY(pt.y) - pt.size / 2 - 8, pt.size, pt.size);
    }
    ctx.globalAlpha = 1;

    // Generated directional contact, aerial and landing bursts. The source
    // strips carry the exact impact silhouette; no procedural ray scaffolding.
    for (const impact of sim.impacts) {
      if (!impact.active) continue;
      const remaining = clamp(impact.life / impact.maxLife, 0, 1);
      const age = 1 - remaining;
      const x = toSX(impact.x);
      const groundY = toSY(impact.y);
      const angle = Math.atan2(Math.sin(impact.angle) * TILT, Math.cos(impact.angle));
      const frame = Math.min(5, Math.floor(clamp(age, 0, 0.999) * 6));
      const landing = impact.kind === 'landing';
      const airburst = impact.kind === 'airburst';
      const sprite = landing ? this.knockoutSpr : this.contactHitSpr;
      const impactY = groundY - (landing ? 10 : airburst ? 78 : 24);
      const size = (landing ? 108 : airburst ? 98 : 76) * impact.strength;
      this.drawVfxFrame(ctx, sprite, frame, x, impactY, size, landing ? 0 : angle, Math.min(1, remaining * 1.8), true);
    }
    ctx.globalAlpha = 1;

    // Matchday Wipeout is authored as a six-stage, full-pitch explosion. It
    // replaces the old oversized procedural ring and remains below HUD text.
    if (this.matchdayWipeoutStartedAt >= 0) {
      const age = time - this.matchdayWipeoutStartedAt;
      const duration = 1.05;
      if (age < duration) {
        const progress = clamp(age / duration, 0, 0.999);
        const frame = Math.min(5, Math.floor(progress * 6));
        const fade = progress < 0.72 ? 1 : 1 - (progress - 0.72) / 0.28;
        const size = Math.max(vw, vh * 1.45) * 1.34;
        this.drawVfxFrame(
          ctx,
          this.matchdayWipeoutSpr,
          frame,
          toSX(sim.player.x),
          toSY(sim.player.y) - 20,
          size,
          0,
          clamp(fade, 0, 1),
          false,
        );
      } else {
        this.matchdayWipeoutStartedAt = -1;
      }
    }

    // The final player knockout is also a generated sequence. It has enough
    // time to complete before the result screen replaces the live pitch.
    if (sim.over === 'lost') {
      if (this.lossStartedAt < 0) this.lossStartedAt = time;
      const lossProgress = clamp((time - this.lossStartedAt) / 1.05, 0, 0.999);
      this.drawVfxFrame(
        ctx,
        this.knockoutSpr,
        Math.floor(lossProgress * 6),
        toSX(sim.player.x),
        toSY(sim.player.y) - 16,
        164,
        0,
        1 - lossProgress * 0.18,
        false,
      );
    } else {
      this.lossStartedAt = -1;
    }

    // damage numbers
    ctx.textAlign = 'center';
    for (const d of sim.dmgNums) {
      if (!d.active) continue;
      const a = clamp(d.life / 0.7, 0, 1);
      ctx.globalAlpha = a;
      ctx.font = `bold ${d.crit ? 21 : 15}px system-ui, sans-serif`;
      ctx.strokeStyle = 'rgba(10,12,20,0.85)';
      ctx.lineWidth = 3.5;
      const x = toSX(d.x);
      const y = toSY(d.y) - 26;
      ctx.strokeText(d.value, x, y);
      ctx.fillStyle = d.crit ? '#ffd23f' : '#f5f7fa';
      ctx.fillText(d.value, x, y);
    }
    ctx.globalAlpha = 1;

    // vignette
    const vg = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.42, vw / 2, vh / 2, vh * 0.85);
    vg.addColorStop(0, 'rgba(6,10,16,0)');
    vg.addColorStop(1, 'rgba(6,10,16,0.42)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, vw, vh);

    // Stoppage-Time Freeze keeps the field readable while clearly freezing
    // the hostile layer. A cool rim and scan sheen avoid a flat blue overlay.
    if (sim.freezeT > 0) {
      ctx.fillStyle = `rgba(82,210,255,${0.055 + 0.018 * Math.sin(time * 8)})`;
      ctx.fillRect(0, 0, vw, vh);
      const iceRim = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.3, vw / 2, vh / 2, vh * 0.82);
      iceRim.addColorStop(0, 'rgba(124,236,255,0)');
      iceRim.addColorStop(1, 'rgba(124,236,255,0.34)');
      ctx.fillStyle = iceRim;
      ctx.fillRect(0, 0, vw, vh);
    }

    // hurt flash
    if (this.flashWarn > 0) {
      this.flashWarn -= 1 / 60;
      const hurtStrength = clamp(this.flashWarn / 0.42, 0, 1);
      ctx.fillStyle = `rgba(178,0,28,${hurtStrength * 0.2})`;
      ctx.fillRect(0, 0, vw, vh);
      const redVignette = ctx.createRadialGradient(vw / 2, vh / 2, vh * 0.18, vw / 2, vh / 2, vh * 0.76);
      redVignette.addColorStop(0, 'rgba(205,0,32,0)');
      redVignette.addColorStop(0.58, `rgba(205,0,32,${hurtStrength * 0.12})`);
      redVignette.addColorStop(1, `rgba(205,0,32,${hurtStrength * 0.72})`);
      ctx.fillStyle = redVignette;
      ctx.fillRect(0, 0, vw, vh);
    }
    // paparazzo white flash
    if (this.flashWhiteT > 0) {
      this.flashWhiteT -= 1 / 60;
      ctx.fillStyle = `rgba(245,247,250,${Math.max(0, this.flashWhiteT) * 2.4})`;
      ctx.fillRect(0, 0, vw, vh);
    }

    if (debug) {
      ctx.fillStyle = '#80ed99';
      ctx.font = '13px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`enemies=${sim.enemies.filter((e) => e.active).length} scale=${scale.toFixed(2)}`, 10, vh - 10);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawCrowd(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    wx0: number,
    wy0: number,
    vw: number,
    vh: number,
    time: number,
  ): void {
    // jumping crowd dots around the visible window edges (stands live in the margin ring)
    const colors = ['#e8e0d0', '#e0705a', '#6a8bd4', '#d4c46a', '#8ad49a', '#c09ad4'];
    const n = 130;
    for (let i = 0; i < n; i++) {
      const rx = this.crowdSeed[i * 2] ?? 0.5;
      const rz = this.crowdSeed[i * 2 + 1] ?? 0.5;
      const edge = i % 4;
      let x = 0;
      let y = 0;
      if (edge === 0) {
        x = wx0 + rx * vw;
        y = wy0 - 20 - rz * 240;
      } else if (edge === 1) {
        x = wx0 + rx * vw;
        y = wy0 + vh + 30 + rz * 240;
      } else if (edge === 2) {
        x = wx0 - 25 - rz * 240;
        y = wy0 + rx * vh;
      } else {
        x = wx0 + vw + 30 + rz * 240;
        y = wy0 + rx * vh;
      }
      const jump = Math.abs(Math.sin(time * 2.4 + i * 1.7)) * 5;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(toSX(x), toSY(y) - jump, 6, 6);
    }
  }

  /** Restrained runtime life for the detailed Showpiece plate.
   *
   * The effect is clipped to the stadium surround and uses a fixed seed table,
   * so no particles or allocations enter the dense combat loop. It animates
   * phone flashes and little supporter flags without ever drawing over turf.
   */
  private drawLiveShowpieceStadium(
    ctx: CanvasRenderingContext2D,
    bounds: { x0: number; y0: number; x1: number; y1: number },
    sx: number,
    sy: number,
    vw: number,
    vh: number,
    time: number,
  ): void {
    const left = -bounds.x0 - sx;
    const right = ARENA_W - bounds.x0 - sx;
    const top = (-bounds.y0 * TILT) - sy;
    const bottom = ((ARENA_H - bounds.y0) * TILT) - sy;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, vw, vh);
    ctx.rect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
    ctx.clip('evenodd');

    const surroundW = Math.max(1, bounds.x1 - bounds.x0);
    const surroundH = Math.max(1, (bounds.y1 - bounds.y0) * TILT);
    const worldLeft = -sx;
    const worldRight = surroundW - sx;
    const worldTop = -sy;
    const worldBottom = surroundH - sy;
    const pitchWidth = Math.max(1, right - left);
    const pitchHeight = Math.max(1, bottom - top);
    for (let i = 0; i < 92; i++) {
      const seedA = this.crowdSeed[(i * 2) % this.crowdSeed.length] ?? 0.5;
      const seedB = this.crowdSeed[(i * 2 + 1) % this.crowdSeed.length] ?? 0.5;
      const side = i % 4;
      let x = worldLeft;
      let y = worldTop;
      if (side === 0 || side === 1) {
        x = worldLeft + seedA * surroundW;
        y = side === 0
          ? worldTop + seedB * Math.max(12, top - worldTop)
          : bottom + seedB * Math.max(12, worldBottom - bottom);
      } else {
        x = side === 2
          ? worldLeft + seedA * Math.max(12, left - worldLeft)
          : right + seedA * Math.max(12, worldRight - right);
        y = worldTop + seedB * surroundH;
      }
      if (x < -12 || x > vw + 12 || y < -12 || y > vh + 12) continue;
      const phase = time * (1.4 + seedB * 2.2) + i * 2.381;
      const flash = Math.max(0, Math.sin(phase * 0.73) - 0.965) / 0.035;
      if (flash > 0) {
        const radius = 2.1 + flash * 3.8;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, `rgba(255,251,224,${0.8 * flash})`);
        glow.addColorStop(1, 'rgba(255,244,198,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      // Tiny paired torso/head motions reinforce the baked spectators instead
      // of adding free-floating particles. Only selected seeds animate and the
      // surround clip prevents all overlap with the pitch.
      if (i % 5 === 1 || i % 11 === 3) {
        const cheer = Math.max(0, Math.sin(phase * 0.46 + seedA * 3.1));
        const lift = cheer * (0.75 + seedB * 1.2);
        const shirtColors = [
          'rgba(207,54,70,0.27)',
          'rgba(45,112,181,0.27)',
          'rgba(232,181,52,0.25)',
          'rgba(226,228,218,0.24)',
        ];
        ctx.fillStyle = 'rgba(219,181,142,0.24)';
        ctx.beginPath();
        ctx.arc(x, y - 3.2 - lift, 1.15, 0, TAU);
        ctx.fill();
        ctx.fillStyle = shirtColors[i % shirtColors.length];
        ctx.fillRect(x - 1.5, y - 1.6 - lift, 3, 3.2);
        if (cheer > 0.62) {
          ctx.strokeStyle = shirtColors[(i + 1) % shirtColors.length];
          ctx.lineWidth = 0.72;
          ctx.beginPath();
          ctx.moveTo(x - 1.1, y - 1.1 - lift);
          ctx.lineTo(x - 2.8, y - 4.2 - lift);
          ctx.moveTo(x + 1.1, y - 1.1 - lift);
          ctx.lineTo(x + 2.8, y - 4.2 - lift);
          ctx.stroke();
        }
      }
      if (i % 7 === 0) {
        const wave = Math.sin(phase) * 2.5;
        ctx.strokeStyle = 'rgba(226,230,220,0.42)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + 4);
        ctx.lineTo(x, y - 8);
        ctx.stroke();
        ctx.fillStyle = i % 14 === 0 ? 'rgba(222,49,70,0.72)' : 'rgba(238,185,49,0.72)';
        ctx.beginPath();
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x + 8 + wave, y - 5);
        ctx.lineTo(x, y - 1);
        ctx.fill();
      }
    }

    // Stadium LED chase and camera tally lights are deliberately confined to
    // the touchline surround. The pulses are sparse, subtle and allocation-free.
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.15);
    const boardAlpha = 0.12 + pulse * 0.14;
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    for (let i = 0; i < 18; i++) {
      const phase = (i / 18 + time * 0.055) % 1;
      const x = left + phase * Math.max(1, right - left);
      ctx.strokeStyle = i % 3 === 0
        ? `rgba(226,57,78,${boardAlpha})`
        : i % 3 === 1
          ? `rgba(238,189,58,${boardAlpha})`
          : `rgba(67,147,202,${boardAlpha})`;
      ctx.beginPath();
      ctx.moveTo(x - 13, top - 8);
      ctx.lineTo(x + 13, top - 8);
      ctx.moveTo(x - 13, bottom + 8);
      ctx.lineTo(x + 13, bottom + 8);
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const x = left + ((i + 0.5) / 8) * Math.max(1, right - left);
      const tally = Math.max(0, Math.sin(time * 1.35 + i * 1.7) - 0.82) / 0.18;
      if (tally <= 0) continue;
      ctx.fillStyle = `rgba(255,52,64,${0.28 + tally * 0.58})`;
      ctx.beginPath();
      ctx.arc(x, top - 20, 1.4 + tally * 1.2, 0, TAU);
      ctx.arc(x, bottom + 20, 1.4 + tally * 1.2, 0, TAU);
      ctx.fill();
    }

    // Warm aisle markers give the dark lower bowl readable depth at gameplay
    // scale. Each short dash follows a fixed access path away from the pitch;
    // there are no travelling lights or random flashes that could read as
    // pickups, projectiles or combat telegraphs.
    const aisleAlpha = 0.16 + (0.5 + 0.5 * Math.sin(time * 0.42)) * 0.025;
    const aisleTopDepth = Math.max(0, top - worldTop - 36);
    const aisleBottomDepth = Math.max(0, worldBottom - bottom - 36);
    ctx.lineCap = 'round';
    for (let aisle = 0; aisle < 6; aisle++) {
      const anchorX = left + ((aisle + 0.5) / 6) * pitchWidth;
      const lean = (aisle - 2.5) * 1.8;
      for (let step = 0; step < 7; step++) {
        const depthT = (step + 0.7) / 7;
        const topY = top - 25 - depthT * aisleTopDepth;
        const bottomY = bottom + 25 + depthT * aisleBottomDepth;
        const x = anchorX + lean * depthT;
        const markerAlpha = aisleAlpha * (0.72 + depthT * 0.28);
        ctx.strokeStyle = `rgba(255,210,113,${markerAlpha})`;
        ctx.lineWidth = 1.35;
        ctx.beginPath();
        ctx.moveTo(x - 2.4, topY);
        ctx.lineTo(x + 2.4, topY);
        ctx.moveTo(x - 2.4, bottomY);
        ctx.lineTo(x + 2.4, bottomY);
        ctx.stroke();
      }
    }
    const aisleLeftDepth = Math.max(0, left - worldLeft - 36);
    const aisleRightDepth = Math.max(0, worldRight - right - 36);
    for (let aisle = 0; aisle < 4; aisle++) {
      const anchorY = top + ((aisle + 0.5) / 4) * pitchHeight;
      const lean = (aisle - 1.5) * 1.6;
      for (let step = 0; step < 6; step++) {
        const depthT = (step + 0.7) / 6;
        const leftX = left - 25 - depthT * aisleLeftDepth;
        const rightX = right + 25 + depthT * aisleRightDepth;
        const y = anchorY + lean * depthT;
        const markerAlpha = aisleAlpha * (0.72 + depthT * 0.28);
        ctx.strokeStyle = `rgba(255,210,113,${markerAlpha})`;
        ctx.lineWidth = 1.35;
        ctx.beginPath();
        ctx.moveTo(leftX, y - 2.4);
        ctx.lineTo(leftX, y + 2.4);
        ctx.moveTo(rightX, y - 2.4);
        ctx.lineTo(rightX, y + 2.4);
        ctx.stroke();
      }
    }

    // Crisp construction details are rendered after the lossy arena plate so
    // its smallest rails, drain teeth and fasteners survive runtime scaling.
    // The even-odd clip above guarantees every stroke remains outside turf.
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(205,218,216,0.22)';
    ctx.lineWidth = 1;
    for (let x = left + 9; x < right - 7; x += 37) {
      const offset = ((Math.floor(x) * 13) % 7) - 3;
      ctx.beginPath();
      ctx.moveTo(x, top - 25 + offset * 0.2);
      ctx.lineTo(x, top - 7);
      ctx.moveTo(x + 17, bottom + 7);
      ctx.lineTo(x + 17, bottom + 25 - offset * 0.2);
      ctx.stroke();
    }
    for (let y = top + 11; y < bottom - 9; y += 35) {
      const offset = ((Math.floor(y) * 11) % 7) - 3;
      ctx.beginPath();
      ctx.moveTo(left - 24 + offset * 0.2, y);
      ctx.lineTo(left - 7, y);
      ctx.moveTo(right + 7, y + 16);
      ctx.lineTo(right + 24 - offset * 0.2, y + 16);
      ctx.stroke();
    }

    // Drainage slots and individual retaining bolts create a fine mechanical
    // seam at the grass boundary without turning it into a bright outline.
    ctx.strokeStyle = 'rgba(151,170,168,0.27)';
    ctx.lineWidth = 0.8;
    for (let x = left + 5, index = 0; x < right - 4; x += 14, index++) {
      const depth = 3 + (index % 3);
      ctx.beginPath();
      ctx.moveTo(x, top - 2);
      ctx.lineTo(x + 1.5, top - depth);
      ctx.moveTo(x + 6, bottom + 2);
      ctx.lineTo(x + 7.5, bottom + depth);
      ctx.stroke();
      if (index % 4 === 0) {
        ctx.fillStyle = 'rgba(226,230,218,0.30)';
        ctx.beginPath();
        ctx.arc(x + 3, top - 7, 0.85, 0, TAU);
        ctx.arc(x + 9, bottom + 7, 0.85, 0, TAU);
        ctx.fill();
      }
    }
    for (let y = top + 5, index = 0; y < bottom - 4; y += 14, index++) {
      const depth = 3 + (index % 3);
      ctx.beginPath();
      ctx.moveTo(left - 2, y);
      ctx.lineTo(left - depth, y + 1.5);
      ctx.moveTo(right + 2, y + 6);
      ctx.lineTo(right + depth, y + 7.5);
      ctx.stroke();
    }

    // Short diagonal glass catches appear only on a subset of panels and use
    // fixed geometry, avoiding a synthetic continuous shine.
    ctx.strokeStyle = 'rgba(221,240,239,0.13)';
    ctx.lineWidth = 1.1;
    for (let panel = 0; panel < 22; panel++) {
      const x = left + ((panel + 0.35) / 22) * pitchWidth;
      if (panel % 3 !== 1) continue;
      ctx.beginPath();
      ctx.moveTo(x - 6, top - 33);
      ctx.lineTo(x + 7, top - 24);
      ctx.moveTo(x + 13, bottom + 24);
      ctx.lineTo(x + 1, bottom + 33);
      ctx.stroke();
    }
    for (let panel = 0; panel < 12; panel++) {
      const y = top + ((panel + 0.4) / 12) * pitchHeight;
      if (panel % 3 !== 0) continue;
      ctx.beginPath();
      ctx.moveTo(left - 33, y - 6);
      ctx.lineTo(left - 24, y + 7);
      ctx.moveTo(right + 24, y + 13);
      ctx.lineTo(right + 33, y + 1);
      ctx.stroke();
    }

    // Technical rubber walkway: broad slab seams, shallow caster scuffs and
    // cable-channel covers. These marks remain dark and textless so the apron
    // gains scale without competing with pickups or attack telegraphs.
    ctx.strokeStyle = 'rgba(4,12,15,0.31)';
    ctx.lineWidth = 1.2;
    for (let slab = 0; slab <= 28; slab++) {
      const x = worldLeft + (slab / 28) * surroundW;
      const skipTop = x > left - 80 && x < right + 80;
      if (!skipTop || slab % 4 === 0) {
        ctx.beginPath();
        ctx.moveTo(x, worldTop + 5);
        ctx.lineTo(x + ((slab * 13) % 5) - 2, Math.max(worldTop + 8, top - 38));
        ctx.moveTo(x + 7, Math.min(worldBottom - 8, bottom + 38));
        ctx.lineTo(x + 7, worldBottom - 5);
        ctx.stroke();
      }
    }
    for (let slab = 0; slab <= 18; slab++) {
      const y = worldTop + (slab / 18) * surroundH;
      ctx.beginPath();
      ctx.moveTo(worldLeft + 5, y);
      ctx.lineTo(Math.max(worldLeft + 8, left - 38), y + ((slab * 11) % 5) - 2);
      ctx.moveTo(Math.min(worldRight - 8, right + 38), y + 7);
      ctx.lineTo(worldRight - 5, y + 7);
      ctx.stroke();
    }

    // Paired channel lids with hinge bolts imply broadcast/power cabling.
    const channelColor = 'rgba(131,148,150,0.19)';
    ctx.strokeStyle = channelColor;
    ctx.lineWidth = 1;
    for (let segment = 0; segment < 16; segment++) {
      const x = left + ((segment + 0.25) / 16) * pitchWidth;
      const width = pitchWidth / 16 * 0.52;
      for (const y of [top - 47, bottom + 47]) {
        ctx.strokeRect(x, y - 3, width, 6);
        ctx.fillStyle = 'rgba(205,213,204,0.24)';
        ctx.beginPath();
        ctx.arc(x + 3, y, 0.75, 0, TAU);
        ctx.arc(x + width - 3, y, 0.75, 0, TAU);
        ctx.fill();
      }
    }

    // Sparse caster and boot scuffs use short paired arcs rather than circles,
    // keeping them recognisably physical and never pickup-shaped.
    ctx.strokeStyle = 'rgba(0,5,7,0.20)';
    ctx.lineWidth = 0.9;
    for (let mark = 0; mark < 38; mark++) {
      const seedA = this.crowdSeed[(mark * 5 + 23) % this.crowdSeed.length] ?? 0.5;
      const seedB = this.crowdSeed[(mark * 5 + 24) % this.crowdSeed.length] ?? 0.5;
      const side = mark % 4;
      let x = left + seedA * pitchWidth;
      let y = top - 54 - seedB * Math.max(10, top - worldTop - 62);
      if (side === 1) y = bottom + 54 + seedB * Math.max(10, worldBottom - bottom - 62);
      if (side === 2) {
        x = left - 54 - seedB * Math.max(10, left - worldLeft - 62);
        y = top + seedA * pitchHeight;
      }
      if (side === 3) {
        x = right + 54 + seedB * Math.max(10, worldRight - right - 62);
        y = top + seedA * pitchHeight;
      }
      const rotation = mark * 0.83;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.beginPath();
      ctx.arc(0, 0, 5 + (mark % 4), -0.8, 0.75);
      ctx.arc(3, 1.5, 5 + (mark % 3), Math.PI - 0.65, Math.PI + 0.7);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /** Sparse world-fixed fibres catch light as a restrained breeze crosses the
   *  pitch. Positions are deterministic, camera-independent and allocation-free;
   *  low alpha prevents water-like shimmer or interference with combat reads. */
  private drawTurfWindFibres(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.7;
    for (let fibre = 0; fibre < 86; fibre++) {
      const seedA = this.crowdSeed[(fibre * 4 + 17) % this.crowdSeed.length] ?? 0.5;
      const seedB = this.crowdSeed[(fibre * 4 + 18) % this.crowdSeed.length] ?? 0.5;
      const seedC = this.crowdSeed[(fibre * 4 + 19) % this.crowdSeed.length] ?? 0.5;
      const worldX = 55 + seedA * (ARENA_W - 110);
      const worldY = 55 + seedB * (ARENA_H - 110);
      const wave = Math.sin(time * (0.42 + seedC * 0.24) + fibre * 1.791);
      const visibility = Math.max(0, Math.abs(wave) - 0.47) / 0.53;
      if (visibility <= 0.02) continue;
      const x = toSX(worldX);
      const y = toSY(worldY);
      const lean = wave * (1.2 + seedC * 1.6);
      const length = 2.2 + seedC * 2.4;
      ctx.strokeStyle = wave > 0
        ? `rgba(221,224,148,${visibility * 0.105})`
        : `rgba(55,69,21,${visibility * 0.09})`;
      ctx.beginPath();
      ctx.moveTo(x, y + 1.2);
      ctx.quadraticCurveTo(x + lean * 0.45, y - length * 0.45, x + lean, y - length);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Small deterministic cloth motion for the four physical corner poles. */
  private drawLiveCornerFlags(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    const corners = [
      [40, 40, 1, 1],
      [ARENA_W - 40, 40, -1, 1],
      [40, ARENA_H - 40, 1, -1],
      [ARENA_W - 40, ARENA_H - 40, -1, -1],
    ] as const;
    ctx.save();
    for (let index = 0; index < corners.length; index++) {
      const [worldX, worldY, inwardX, inwardY] = corners[index];
      const x = toSX(worldX);
      const groundY = toSY(worldY);
      const wave = Math.sin(time * 1.65 + index * 1.37);
      const flutter = Math.sin(time * 3.4 + index * 2.11) * 0.85;
      const direction = inwardX;
      const poleTop = groundY - 34 * TILT;
      const tailX = x + direction * (20.5 + wave * 2.1);
      const centerY = poleTop + 7.2 * TILT + inwardY * flutter * 0.24;
      const controlX = x + direction * (9.5 + wave * 1.15);
      ctx.fillStyle = '#e8283f';
      ctx.beginPath();
      ctx.moveTo(x, poleTop);
      ctx.quadraticCurveTo(controlX, poleTop + 2.7 * TILT - flutter * 0.25, tailX, centerY);
      ctx.quadraticCurveTo(controlX + direction * 0.9, poleTop + 12.5 * TILT + flutter * 0.18, x, poleTop + 14 * TILT);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,244,208,0.44)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x + direction * 1.6, poleTop + 2 * TILT);
      ctx.quadraticCurveTo(controlX, poleTop + 4.2 * TILT, tailX - direction * 2.4, centerY);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Narrow asymmetric contact shadows anchor the horizontal turf to the
   *  vertical stadium construction. Each side fades independently, avoiding
   *  a uniform vignette or gameplay-looking border around the pitch. */
  private drawPitchEdgeOcclusion(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
  ): void {
    const left = toSX(0);
    const right = toSX(ARENA_W);
    const top = toSY(0);
    const bottom = toSY(ARENA_H);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    ctx.save();
    const topShade = ctx.createLinearGradient(0, top, 0, top + 21);
    topShade.addColorStop(0, 'rgba(3,15,8,0.115)');
    topShade.addColorStop(0.34, 'rgba(3,15,8,0.045)');
    topShade.addColorStop(1, 'rgba(3,15,8,0)');
    ctx.fillStyle = topShade;
    ctx.fillRect(left, top, width, 22);

    const bottomShade = ctx.createLinearGradient(0, bottom, 0, bottom - 18);
    bottomShade.addColorStop(0, 'rgba(3,15,8,0.085)');
    bottomShade.addColorStop(0.42, 'rgba(3,15,8,0.035)');
    bottomShade.addColorStop(1, 'rgba(3,15,8,0)');
    ctx.fillStyle = bottomShade;
    ctx.fillRect(left, bottom - 19, width, 20);

    const leftShade = ctx.createLinearGradient(left, 0, left + 14, 0);
    leftShade.addColorStop(0, 'rgba(3,15,8,0.066)');
    leftShade.addColorStop(1, 'rgba(3,15,8,0)');
    ctx.fillStyle = leftShade;
    ctx.fillRect(left, top + 14, 15, Math.max(0, height - 28));

    const rightShade = ctx.createLinearGradient(right, 0, right - 11, 0);
    rightShade.addColorStop(0, 'rgba(3,15,8,0.052)');
    rightShade.addColorStop(1, 'rgba(3,15,8,0)');
    ctx.fillStyle = rightShade;
    ctx.fillRect(right - 12, top + 17, 13, Math.max(0, height - 34));
    ctx.restore();
  }

  /** Draw only the goal-mouth bars that physically sit above actors. */
  private drawGoalForeground(
    ctx: CanvasRenderingContext2D,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
  ): void {
    const top = toSY(ARENA_H / 2 - 130);
    const bottom = toSY(ARENA_H / 2 + 130);
    ctx.save();
    ctx.lineCap = 'round';
    for (const gx of [40, ARENA_W - 40]) {
      const x = toSX(gx);
      ctx.strokeStyle = 'rgba(13,30,22,0.46)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(x + 3.5, top + 3.5);
      ctx.lineTo(x + 3.5, bottom + 3.5);
      ctx.stroke();
      ctx.strokeStyle = '#f5f7fa';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.74)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x - 1.2, top + 2);
      ctx.lineTo(x - 1.2, bottom - 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Record and render restrained cleat compression in the grass.
   *
   * This is not a trail VFX: each mark is a tiny, fading pair of dark fibres
   * placed only after meaningful travel. A fixed pool keeps it mobile-safe.
   */
  private updateAndDrawTurfFootprints(
    ctx: CanvasRenderingContext2D,
    sim: Sim,
    toSX: (wx: number) => number,
    toSY: (wy: number) => number,
    time: number,
  ): void {
    const p = sim.player;
    if (p.moving || p.dashT > 0) {
      const travelled = Number.isFinite(this.lastTurfFootprintX)
        ? Math.hypot(p.x - this.lastTurfFootprintX, p.y - this.lastTurfFootprintY)
        : Number.POSITIVE_INFINITY;
      const cadence = p.dashT > 0 ? 0.075 : 0.145;
      if (travelled >= (p.dashT > 0 ? 21 : 16) && time - this.lastTurfFootprintAt >= cadence) {
        const mark = this.turfFootprints[this.turfFootprintCursor];
        const angle = Math.atan2(p.dashDy, p.dashDx);
        const lateral = this.nextTurfFoot * 5.2;
        mark.active = true;
        mark.x = p.x + Math.cos(angle + Math.PI / 2) * lateral;
        mark.y = p.y + Math.sin(angle + Math.PI / 2) * lateral;
        mark.born = time;
        mark.side = this.nextTurfFoot;
        mark.angle = angle;
        this.nextTurfFoot = this.nextTurfFoot === -1 ? 1 : -1;
        this.turfFootprintCursor = (this.turfFootprintCursor + 1) % this.turfFootprints.length;
        const clippingCount = p.dashT > 0 ? 7 : 3;
        for (let clippingIndex = 0; clippingIndex < clippingCount; clippingIndex++) {
          const clipping = this.turfClippings[this.turfClippingCursor];
          const spread = clippingIndex - (clippingCount - 1) / 2;
          const seed = this.turfClippingCursor * 2.399 + mark.x * 0.017 + mark.y * 0.013;
          const sideAngle = angle + Math.PI + spread * 0.115 + Math.sin(seed) * 0.08;
          const speed = (p.dashT > 0 ? 34 : 17) + (0.5 + 0.5 * Math.sin(seed * 1.71)) * (p.dashT > 0 ? 38 : 18);
          clipping.active = true;
          clipping.x = mark.x + Math.cos(angle + Math.PI / 2) * spread * 1.1;
          clipping.y = mark.y + Math.sin(angle + Math.PI / 2) * spread * 1.1;
          clipping.born = time;
          clipping.vx = Math.cos(sideAngle) * speed;
          clipping.vy = Math.sin(sideAngle) * speed;
          clipping.angle = sideAngle;
          clipping.spin = (clippingIndex % 2 === 0 ? 1 : -1) * (2.2 + (seed % 1) * 2.1);
          clipping.length = 2.7 + (0.5 + 0.5 * Math.cos(seed * 2.31)) * 3.6;
          clipping.shade = clippingIndex % 3;
          this.turfClippingCursor = (this.turfClippingCursor + 1) % this.turfClippings.length;
        }
        this.lastTurfFootprintAt = time;
        this.lastTurfFootprintX = p.x;
        this.lastTurfFootprintY = p.y;
      }
    }

    for (const mark of this.turfFootprints) {
      if (!mark.active) continue;
      const age = time - mark.born;
      if (age >= 2.8) {
        mark.active = false;
        continue;
      }
      const alpha = (1 - age / 2.8) * 0.16;
      const x = toSX(mark.x);
      const y = toSY(mark.y);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(Math.sin(mark.angle) * TILT, Math.cos(mark.angle)));
      ctx.scale(1, TILT);
      ctx.fillStyle = `rgba(2,25,10,${alpha})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, 5.2, 2.1, mark.side * 0.12, 0, TAU);
      ctx.fill();
      // A planted boot presses individual fibres backwards along its travel
      // axis. These short deterministic strokes sit beneath the character and
      // make contact readable without a glow, ring or particle emitter.
      ctx.strokeStyle = `rgba(43,57,17,${alpha * 1.28})`;
      ctx.lineWidth = 0.8;
      for (let fibre = -3; fibre <= 3; fibre++) {
        const offset = fibre * 1.15;
        const reach = 4.2 + ((fibre * fibre + mark.side + 7) % 3) * 1.3;
        ctx.beginPath();
        ctx.moveTo(-1.4, offset * 0.34);
        ctx.lineTo(-reach, offset * 0.5 + mark.side * 0.32);
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(194,220,167,${alpha * 0.48})`;
      ctx.lineWidth = 0.75;
      for (const offset of [-2.5, 0, 2.5]) {
        ctx.beginPath();
        ctx.moveTo(-3.8, offset * 0.2);
        ctx.lineTo(2.8, offset * 0.17);
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(210,218,132,${alpha * 0.42})`;
      ctx.lineWidth = 0.65;
      for (const offset of [-3.4, 3.4]) {
        ctx.beginPath();
        ctx.moveTo(-0.5, offset * 0.3);
        ctx.lineTo(1.2 + mark.side * 0.5, offset * 0.44 - 1.7);
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const clipping of this.turfClippings) {
      if (!clipping.active) continue;
      const age = time - clipping.born;
      const lifetime = 0.72;
      if (age >= lifetime) {
        clipping.active = false;
        continue;
      }
      // Integral of exponentially damped velocity: displacement increases
      // monotonically and asymptotically settles instead of sliding backwards.
      const displacement = dampedTurfDisplacement(age);
      const x = toSX(clipping.x + clipping.vx * displacement);
      const y = toSY(clipping.y + clipping.vy * displacement);
      const lift = Math.sin(clamp(age / lifetime, 0, 1) * Math.PI) * Math.min(4.5, clipping.length * 0.7);
      const alpha = (1 - age / lifetime) * 0.34;
      ctx.save();
      ctx.translate(x, y - lift);
      ctx.rotate(clipping.angle + clipping.spin * age);
      ctx.scale(1, TILT);
      ctx.strokeStyle = clipping.shade === 0
        ? `rgba(184,195,102,${alpha})`
        : clipping.shade === 1
          ? `rgba(66,83,25,${alpha * 0.92})`
          : `rgba(216,216,132,${alpha * 0.78})`;
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(-clipping.length * 0.5, 0);
      ctx.quadraticCurveTo(0, -0.9, clipping.length * 0.5, 0.2);
      ctx.stroke();
      ctx.restore();
    }
  }
}
