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
    for (let i = 0; i < 400; i++) this.crowdSeed.push(Math.random());
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
  setArenaImage(img: HTMLImageElement): void {
    this.plate = img;
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
      psx = ARENA_W / PLATE_GRASS.w;
      psy = ARENA_H / PLATE_GRASS.h;
      ml = PLATE_GRASS.x * psx;
      mr = (this.plate.width - PLATE_GRASS.x - PLATE_GRASS.w) * psx;
      mt = PLATE_GRASS.y * psy;
      mb = (this.plate.height - PLATE_GRASS.y - PLATE_GRASS.h) * psy;
    }
    this.bounds = { x0: -ml, y0: -mt, x1: ARENA_W + mr, y1: ARENA_H + mb };
    const w = ARENA_W + ml + mr;
    const h = ARENA_H + mt + mb;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w);
    c.height = Math.ceil(h * TILT);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, TILT, 0, 0);
    ctx.translate(ml, mt);

    if (this.plate) {
      // AI arena plate: the measured grass rect maps exactly onto the playable
      // arena (slight non-uniform scale absorbs the plate's aspect difference);
      // the plate's own stands/track fill the surrounding margin completely.
      ctx.drawImage(this.plate, -PLATE_GRASS.x * psx, -PLATE_GRASS.y * psy, this.plate.width * psx, this.plate.height * psy);
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
    ctx.beginPath();
    ctx.arc(ARENA_W / 2, ARENA_H / 2, 6.5, 0, TAU);
    ctx.fill();
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
    for (const px of [40 + 230, ARENA_W - 40 - 230]) {
      ctx.beginPath();
      ctx.arc(px, ARENA_H / 2, 6, 0, TAU);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(40 + 230, ARENA_H / 2, 150, -Math.PI / 3.2, Math.PI / 3.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ARENA_W - 40 - 230, ARENA_H / 2, 150, Math.PI - Math.PI / 3.2, Math.PI + Math.PI / 3.2);
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // goals
    for (const side of [0, 1]) {
      const gx = side === 0 ? 40 : ARENA_W - 40;
      const dir = side === 0 ? -1 : 1;
      ctx.fillStyle = 'rgba(245,247,250,0.25)';
      ctx.fillRect(gx + (dir === -1 ? -46 : 0), ARENA_H / 2 - 130, 46, 260);
      ctx.strokeStyle = '#f5f7fa';
      ctx.lineWidth = 6;
      ctx.strokeRect(gx + (dir === -1 ? -46 : 0), ARENA_H / 2 - 130, 46, 260);
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
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - 34);
      ctx.stroke();
      ctx.fillStyle = '#e8283f';
      ctx.beginPath();
      ctx.moveTo(cx, cy - 34);
      ctx.lineTo(cx + 22, cy - 27);
      ctx.lineTo(cx, cy - 20);
      ctx.closePath();
      ctx.fill();
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

    // pitch blit
    const sx = camTX - vw / 2;
    const sy = camTY - vh / 2;
    ctx.drawImage(this.pitch, sx, sy, vw, vh, 0, 0, vw, vh);

    const toSX = (wx: number) => wx - b.x0 - sx;
    const toSY = (wy: number) => (wy - b.y0) * TILT - sy;

    // animated crowd: jumping dots near the visible stands edge
    // (skipped when the arena plate supplies its own crowd)
    if (!this.plate) this.drawCrowd(ctx, toSX, toSY, sx + b.x0, sy / TILT + b.y0, vw, vh / TILT, time);

    // ground decals: telegraphs, flare zones, slow zones
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
        // The delivered feet baseline is the only grounding cue. A separate
        // contact shadow/selection ring made the player float above the plate.
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
}
