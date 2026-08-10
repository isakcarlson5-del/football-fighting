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
  trophySprite,
  xpSprite,
  type Atlas,
} from '../core/sprites';
import { BOSSES, ENEMIES, SKINS, type BossId, type EnemyDef, type PlayerDef } from './data';
import { ARENA_H, ARENA_W, KICK_DURATION, type Enemy, type Guard, type Sim } from './sim';
import type { Save } from './meta';

const TILT = 0.62;
const MARGIN = 340; // stands width around pitch (world units) — procedural fallback only
const ENTITY_SCALE = 1.85;
/** Grass rect inside the arena plate image (source px, 1536x1024).
 *  Measured from the delivered art (soft painterly edges) and inset a few px
 *  so the mapped arena edges always land on real grass, never on the track. */
const PLATE_GRASS = { x: 124, y: 157, w: 1287, h: 769 };
/** Camera never gets closer than this to the painted world's outer edge. */
const EDGE_PAD = 6;
type SpriteBitmap = HTMLCanvasElement | HTMLImageElement;

/** Generated enemy strips use semantic poses: idle, move, attack/cast, hurt. */
export function enemyPoseFrame(
  e: Pick<Enemy, 'hurtT' | 'stun' | 'windup' | 'lungeT' | 'telegraph' | 'casting' | 'moving' | 'airT'>,
  frames: number,
): number {
  if (frames < 4) return Math.max(0, frames - 1);
  if (e.hurtT > 0 || e.stun > 0) return 3;
  if (e.windup > 0 || e.lungeT > 0 || e.telegraph > 0 || e.casting !== '') return 2;
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
  private xpSpr: SpriteBitmap[];
  private coinSpr: SpriteBitmap;
  private healSpr: SpriteBitmap;
  private trophySpr: SpriteBitmap;
  private bottleSpr: HTMLCanvasElement;
  private atlasCache = new Map<string, Atlas>();
  private crowdSeed: number[] = [];
  private flashWarn = 0;
  private flashWhiteT = 0;

  camX = ARENA_W / 2;
  camY = ARENA_H / 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.pitch = this.buildPitch();
    this.ball = ballSprite(22);
    this.xpSpr = [xpSprite(1), xpSprite(2), xpSprite(3)];
    this.coinSpr = coinSprite();
    this.healSpr = drinkSprite();
    this.trophySpr = trophySprite();
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
    void loadStripAtlas('ally-bodyguard', 'art/allies/bodyguard.png');
    for (let i = 0; i < 400; i++) this.crowdSeed.push(Math.random());
  }

  /** Loads generated pickup art while preserving the procedural fallback. */
  private loadPickupSprite(url: string, apply: (img: HTMLImageElement) => void): void {
    const img = new Image();
    img.onload = () => apply(img);
    img.src = url;
  }

  /** Swap in the AI arena plate and rebuild the prerendered world canvas. */
  setArenaImage(img: HTMLImageElement): void {
    this.plate = img;
    this.pitch = this.buildPitch();
  }

  /** Enemy visuals: generated 2.5D strip when available, else the procedural atlas. */
  private enemyAtlasFor(e: { def: EnemyDef; boss: '' | BossId }): Atlas {
    const id = e.boss ? `boss-${e.boss}` : e.def.id;
    const strip = getStripAtlas(id);
    if (strip) return strip;
    void loadStripAtlas(id, `art/enemies/${id}.png`);
    return e.boss ? bossAtlas(e.boss) : enemyAtlas(e.def.id as Parameters<typeof enemyAtlas>[0]);
  }

  /** White blinding flash (paparazzo). */
  flashWhite(): void {
    this.flashWhiteT = 0.28;
  }

  addShake(amount: number): void {
    this.shake = Math.min(14, this.shake + amount);
  }

  warnFlash(): void {
    this.flashWarn = 0.25;
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

    // pitch markings
    ctx.strokeStyle = 'rgba(245,247,250,0.9)';
    ctx.lineWidth = 5;
    ctx.strokeRect(40, 40, ARENA_W - 80, ARENA_H - 80);
    // halfway line + center circle
    ctx.beginPath();
    ctx.moveTo(ARENA_W / 2, 40);
    ctx.lineTo(ARENA_W / 2, ARENA_H - 40);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ARENA_W / 2, ARENA_H / 2, 190, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = 'rgba(245,247,250,0.9)';
    ctx.beginPath();
    ctx.arc(ARENA_W / 2, ARENA_H / 2, 9, 0, TAU);
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
      ctx.arc(px, ARENA_H / 2, 8, 0, TAU);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(40 + 230, ARENA_H / 2, 150, -Math.PI / 3.2, Math.PI / 3.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ARENA_W - 40 - 230, ARENA_H / 2, 150, Math.PI - Math.PI / 3.2, Math.PI + Math.PI / 3.2);
    ctx.stroke();

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
  private heroVisual(def: PlayerDef, save: Save, running: boolean, kicking: boolean): { atlas: Atlas; kind: 'kick' | 'idle' | 'run' | 'run-held' } {
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
    const viewWorldH = 980;
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

    // pickups
    for (const pk of sim.pickups) {
      if (!pk.active) continue;
      const bobY = Math.sin(pk.t * 5 + pk.x) * 3;
      const img = pk.kind === 'coin' ? this.coinSpr : pk.kind === 'heal' ? this.healSpr : pk.kind === 'trophy' ? this.trophySpr : this.xpSpr[pk.tier - 1];
      const baseSize = pk.kind === 'trophy' ? 52 : pk.kind === 'heal' ? 42 : pk.kind === 'coin' ? 30 : pk.tier === 3 ? 38 : pk.tier === 2 ? 32 : 27;
      const drawSize = baseSize * (1 + Math.sin(pk.t * 4.5) * 0.035);
      // glow
      ctx.fillStyle = pk.kind === 'coin' ? 'rgba(255,210,63,0.28)' : pk.kind === 'heal' ? 'rgba(55,214,122,0.28)' : pk.kind === 'trophy' ? 'rgba(255,243,196,0.34)' : pk.tier === 3 ? 'rgba(255,142,240,0.26)' : 'rgba(142,208,255,0.24)';
      ctx.beginPath();
      ctx.ellipse(toSX(pk.x), toSY(pk.y) + 3, drawSize * 0.55, drawSize * 0.24, 0, 0, TAU);
      ctx.fill();
      ctx.drawImage(img, toSX(pk.x) - drawSize / 2, toSY(pk.y) - drawSize / 2 + bobY, drawSize, drawSize);
    }

    /* corpses: fallen enemies topple sideways, sink and fade (under live entities) */
    for (const c of sim.corpses) {
      if (!c.active) continue;
      const u = c.t / c.max;
      const atlas = this.enemyAtlasFor({ def: ENEMIES[c.enemyId as keyof typeof ENEMIES] ?? ENEMIES.invader, boss: c.boss });
      // Generated strips are 4x the procedural atlas resolution. Normalize by
      // source height so swapping art never changes the enemy's world size.
      const sc = ENTITY_SCALE * (80 / atlas.fh) * (c.boss ? BOSSES[c.boss].scale : (ENEMIES[c.enemyId as keyof typeof ENEMIES]?.scale ?? 1)) * (c.elite ? 1.22 : 1);
      const fall = Math.min(1, u * 2.4); // topple quickly, then fade
      const alpha = u < 0.5 ? 1 : Math.max(0, 1 - (u - 0.5) / 0.5);
      const x = toSX(c.x);
      const y = toSY(c.y);
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
        const atlas = this.enemyAtlasFor(e);
        const sc = ENTITY_SCALE * (80 / atlas.fh) * (e.boss ? BOSSES[e.boss].scale : e.def.scale) * (e.elite ? 1.22 : 1);
        const x = toSX(e.x);
        const y = toSY(e.y);
        // airborne mobs lift off the pitch; the shadow stays on the grass
        const lift = e.airT > 0 ? Math.sin(Math.PI * (1 - e.airT / 0.38)) * 22 : 0;
        this.shadow(ctx, x, y, e.radius * sc * 0.8 * (1 - lift / 60));
        if (e.elite) {
          const pulse = 0.5 + 0.3 * Math.sin(time * 6);
          ctx.strokeStyle = `rgba(255,210,63,${pulse})`;
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.ellipse(x, y, e.radius * sc * 0.8, e.radius * sc * 0.8 * TILT, 0, 0, TAU);
          ctx.stroke();
          ctx.strokeStyle = `rgba(255,240,180,${pulse * 0.5})`;
          ctx.lineWidth = 10;
          ctx.beginPath();
          ctx.ellipse(x, y, e.radius * sc * 0.95, e.radius * sc * 0.95 * TILT, 0, 0, TAU);
          ctx.stroke();
        }
        if (e.telegraph > 0) {
          ctx.strokeStyle = 'rgba(232,40,63,0.8)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.ellipse(x, y, 230, 230 * TILT, 0, 0, TAU);
          ctx.stroke();
        }
        // Semantic strip poses prevent idle enemies from cycling through attack
        // and hurt art. Locomotion stays alive through a restrained body sway.
        const frame = enemyPoseFrame(e, atlas.frames);
        const useFlash = e.flash > 0;
        const img = useFlash ? atlas.flash : atlas.canvas;
        const dw = atlas.fw * sc;
        const dh = atlas.fh * sc;
        ctx.save();
        ctx.translate(x, y - lift);
        if (e.moving && e.windup <= 0 && e.lungeT <= 0 && e.telegraph <= 0) {
          const gait = Math.sin(e.animT * 12);
          ctx.translate(0, -Math.abs(gait) * 1.6);
          ctx.rotate(e.face * gait * 0.018);
        }
        if (e.windup > 0) {
          const w = 1 - e.windup / 0.34; // pull back harder as the strike nears
          ctx.translate(-e.face * (3 + w * 5), w * 2);
          ctx.rotate(-e.face * 0.08 * w);
        } else if (e.lungeT > 0) {
          const l = e.lungeT / 0.14;
          ctx.translate(e.face * l * 9, 0);
          ctx.rotate(e.face * 0.05 * l);
        } else if (e.telegraph > 0) {
          const cast = 0.5 + 0.5 * Math.sin(e.animT * 18);
          ctx.scale(1 + cast * 0.018, 1 - cast * 0.01);
        }
        if (e.face < 0) ctx.scale(-1, 1);
        ctx.drawImage(img, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc, dw, dh);
        ctx.restore();
        // boss hp bar (only while the boss is actually on screen)
        if (e.boss && x > -80 && x < vw + 80 && y > -80 && y < vh + 80) {
          const bw = 120;
          ctx.fillStyle = 'rgba(10,12,20,0.7)';
          ctx.fillRect(x - bw / 2, y - dh - 18, bw, 10);
          ctx.fillStyle = '#e8283f';
          ctx.fillRect(x - bw / 2 + 1.5, y - dh - 16.5, (bw - 3) * Math.max(0, e.hp / e.maxHp), 7);
        }
      } else if (it.kind === 1) {
        const running = p.moving || p.dashT > 0;
        const vis = this.heroVisual(def, save, running, p.kickT > 0);
        const atlas = vis.atlas;
        const x = toSX(p.x);
        const y = toSY(p.y);
        this.shadow(ctx, x, y, 26);
        // player indicator: soft team-colored underglow so the hero never
        // disappears inside a crowd pile
        const glow = ctx.createRadialGradient(x, y, 4, x, y, 34);
        glow.addColorStop(0, 'rgba(128,237,153,0.4)');
        glow.addColorStop(0.7, 'rgba(128,237,153,0.14)');
        glow.addColorStop(1, 'rgba(128,237,153,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.ellipse(x, y + 2, 34, 15, 0, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(245,247,250,0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(x, y + 2, 21, 9, 0, 0, TAU);
        ctx.stroke();
        // dash trail
        if (p.dashT > 0) {
          ctx.strokeStyle = 'rgba(128,237,153,0.5)';
          ctx.lineWidth = 8;
          ctx.beginPath();
          ctx.moveTo(x, y - 20);
          ctx.lineTo(x - p.dashDx * 60, y - p.dashDy * 60 * TILT - 20);
          ctx.stroke();
        }
        // Idle plays the dedicated neutral clip. Keep the feet planted; any
        // breathing motion belongs inside the art rather than moving the body.
        const frame =
          vis.kind === 'kick'
            ? Math.min(atlas.frames - 1, Math.floor(clamp(1 - p.kickT / KICK_DURATION, 0, 0.999) * atlas.frames))
          : vis.kind === 'idle' ? Math.floor(time * 4.5) % atlas.frames
          : vis.kind === 'run' ? Math.floor(p.animT * 11) % atlas.frames
          : 0;
        const bobY = vis.kind === 'run-held' ? Math.sin(time * 2.6) * 1.6 : 0;
        const sc = ENTITY_SCALE * (80 / atlas.fh);
        const dw = atlas.fw * sc;
        const dh = atlas.fh * sc;
        const blink = p.iframes > 0 && Math.floor(time * 20) % 2 === 0;
        ctx.save();
        ctx.translate(x, y);
        if (p.face < 0 && atlas.flippable) ctx.scale(-1, 1);
        if (blink) ctx.globalAlpha = 0.45;
        ctx.drawImage(atlas.canvas, frame * atlas.fw, 0, atlas.fw, atlas.fh, -dw / 2, -atlas.feetY * sc + bobY, dw, dh);
        ctx.restore();
        // orbit balls (with ground shadows to sell height)
        const orbitLvl = sim.abilityLevel('orbit');
        if (orbitLvl > 0) {
          const count = [0, 2, 3, 3, 4, 5][orbitLvl] + (def.id === 'yamal' ? 1 : 0);
          const radius = [0, 90, 90, 115, 115, 140][orbitLvl];
          for (let b = 0; b < count; b++) {
            const a = p.orbitAngle + (b / count) * TAU;
            const ox = toSX(p.x + Math.cos(a) * radius);
            const oy = toSY(p.y + Math.sin(a) * radius);
            ctx.fillStyle = 'rgba(4,10,6,0.28)';
            ctx.beginPath();
            ctx.ellipse(ox, oy + 2, 8, 3.4, 0, 0, TAU);
            ctx.fill();
            ctx.drawImage(this.ball, ox - 13, oy - 18, 26, 26);
          }
        }
      } else {
        const g = sim.guards[it.idx];
        const atlas = getStripAtlas('ally-bodyguard') ?? guardAtlas();
        const sc = ENTITY_SCALE * (80 / atlas.fh) * 1.05;
        const x = toSX(g.x);
        const y = toSY(g.y);
        this.shadow(ctx, x, y, 22);
        const frame = guardPoseFrame(g, atlas.frames);
        ctx.save();
        ctx.translate(x, y);
        if (g.moving && g.strikeT <= 0 && g.blockT <= 0) {
          const gait = Math.sin(g.animT * 12);
          ctx.translate(0, -Math.abs(gait) * 1.5);
          ctx.rotate(g.face * gait * 0.018);
        } else if (g.strikeT > 0) {
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
      ctx.rotate(b.spin * time * 4);
      const bs = 1 + hFrac * 0.12; // slight forced perspective near the apex
      ctx.drawImage(this.ball, -11 * bs, -11 * bs, 22 * bs, 22 * bs);
      ctx.restore();
    }
    // bottles
    for (const b of sim.bottles) {
      if (!b.active) continue;
      ctx.save();
      ctx.translate(toSX(b.x), toSY(b.y) - 12);
      ctx.rotate(time * 9);
      ctx.drawImage(this.bottleSpr, -6, -10, 12, 20);
      ctx.restore();
    }

    // rings
    for (const r of sim.rings) {
      if (!r.active) continue;
      const a = clamp(r.life / 0.45, 0, 1);
      ctx.strokeStyle = r.color === '#e8283f' ? `rgba(232,40,63,${a})` : `rgba(245,247,250,${a * 0.9})`;
      ctx.lineWidth = 5 * a + 1;
      ctx.beginPath();
      ctx.ellipse(toSX(r.x), toSY(r.y), r.r, r.r * TILT, 0, 0, TAU);
      ctx.stroke();
    }

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
    }

    // landing reticles for incoming aerial lobs
    for (const rc of sim.reticles) {
      if (!rc.active) continue;
      const u = clamp(rc.t / rc.max, 0, 1); // 1 -> 0 as the ball descends
      const rr = 16 + 34 * u;
      const x = toSX(rc.x);
      const y = toSY(rc.y);
      ctx.strokeStyle = `rgba(255,209,102,${0.3 + (1 - u) * 0.6})`;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.ellipse(x, y, rr, rr * TILT, 0, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(255,209,102,${0.35 + (1 - u) * 0.5})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 3.5, 2, 0, 0, TAU);
      ctx.fill();
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

    // Directional contact flashes. A bright core pins the exact collision
    // point while short tapered rays communicate the incoming force.
    for (const impact of sim.impacts) {
      if (!impact.active) continue;
      const remaining = clamp(impact.life / impact.maxLife, 0, 1);
      const age = 1 - remaining;
      const x = toSX(impact.x);
      const groundY = toSY(impact.y);
      const angle = Math.atan2(Math.sin(impact.angle) * TILT, Math.cos(impact.angle));
      const alpha = Math.min(1, remaining * 1.8);
      const size = (12 + age * 15) * impact.strength;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (impact.kind === 'landing') {
        ctx.fillStyle = `rgba(255,209,102,${0.16 * remaining})`;
        ctx.strokeStyle = `rgba(255,226,146,${0.9 * remaining})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(x, groundY, size * 1.5, size * 0.62, 0, 0, TAU);
        ctx.fill();
        ctx.stroke();
      }
      ctx.translate(x, groundY - (impact.kind === 'landing' ? 8 : 22));
      ctx.rotate(angle);
      ctx.strokeStyle = impact.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = 3.2 * impact.strength * remaining + 1;
      const rayCount = impact.strength > 1.25 ? 7 : impact.strength > 1 ? 5 : 3;
      for (let i = 0; i < rayCount; i++) {
        const rayAngle = (i / rayCount) * TAU;
        const directionalBias = 0.72 + Math.max(0, Math.cos(rayAngle)) * 0.38;
        const inner = 3 + (i % 2) * 1.2;
        const outer = size * directionalBias * (0.8 + (i % 2) * 0.2);
        ctx.beginPath();
        ctx.moveTo(Math.cos(rayAngle) * inner, Math.sin(rayAngle) * inner);
        ctx.lineTo(Math.cos(rayAngle) * outer, Math.sin(rayAngle) * outer);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(2, 5 * remaining * impact.strength), 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

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

    // hurt flash
    if (this.flashWarn > 0) {
      this.flashWarn -= 1 / 60;
      ctx.fillStyle = `rgba(232,40,63,${Math.max(0, this.flashWarn) * 0.9})`;
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

  private shadow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    // soft cast shadow, offset down-right (key light from top-left)
    const g = ctx.createRadialGradient(x + r * 0.35, y + 4, r * 0.1, x + r * 0.35, y + 4, r * 1.55);
    g.addColorStop(0, 'rgba(6,12,8,0.34)');
    g.addColorStop(1, 'rgba(6,12,8,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x + r * 0.35, y + 4, r * 1.55, r * 0.62, 0, 0, TAU);
    ctx.fill();
    // tight contact shadow
    ctx.fillStyle = 'rgba(4,10,6,0.42)';
    ctx.beginPath();
    ctx.ellipse(x, y + 2, r * 0.72, r * 0.3, 0, 0, TAU);
    ctx.fill();
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
