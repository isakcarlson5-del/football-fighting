/**
 * Procedural cartoon sprite painter — volumetric 2.5D style.
 *
 * Every sprite is drawn at boot into offscreen canvases (4-frame run cycles),
 * so per-frame rendering is just drawImage calls.
 *
 * Depth recipe (consistent fake-3D lighting, key light from top-left):
 *  - far-side limbs drawn first, darkened, partially behind the torso
 *  - radial/linear gradients on every volume (head, torso, limbs, boots)
 *  - rim light on top-left edges, ambient occlusion under chin and arms
 *  - specular highlights on skin, boots and caps
 */

import type { EnemyId, PlayerDef } from '../game/data';

export const FW = 64; // frame width
export const FH = 80; // frame height
const OUTLINE = '#1d1626';
const FRAMES = 4;

export interface Atlas {
  canvas: HTMLCanvasElement;
  flash: HTMLCanvasElement; // white silhouette for hit feedback
  fw: number;
  fh: number;
  frames: number;
  feetY: number; // pixels from frame top to the feet baseline
  flippable: boolean; // may be horizontally mirrored for left movement
}

const cache = new Map<string, Atlas>();

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function buildAtlas(key: string, paint: (ctx: CanvasRenderingContext2D, frame: number) => void): Atlas {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = makeCanvas(FW * FRAMES, FH);
  const ctx = canvas.getContext('2d')!;
  for (let f = 0; f < FRAMES; f++) {
    ctx.save();
    ctx.translate(f * FW, 0);
    paint(ctx, f);
    ctx.restore();
  }
  const flash = makeCanvas(FW * FRAMES, FH);
  const fctx = flash.getContext('2d')!;
  fctx.drawImage(canvas, 0, 0);
  fctx.globalCompositeOperation = 'source-in';
  fctx.fillStyle = '#ffffff';
  fctx.fillRect(0, 0, flash.width, flash.height);
  const atlas = { canvas, flash, fw: FW, fh: FH, frames: FRAMES, feetY: FH - 7, flippable: true };
  cache.set(key, atlas);
  return atlas;
}

/* ------------------------------------------------------------------ */
/* Raster strip atlases (generated player art)                         */
/* ------------------------------------------------------------------ */

const STRIP_FW = 256;
const STRIP_FH = 320;
const STRIP_FEET = 312; // 8px bottom padding in the delivered strips
const stripCache = new Map<string, Atlas | null>(); // null = unavailable -> procedural fallback
const stripPending = new Map<string, Promise<Atlas | null>>();

/**
 * Loads a generated 1x4 run-cycle strip (1024x320, RGBA) into an Atlas with
 * a white flash variant. `tint` optionally recolors the torso zone (skins).
 * Returns null when the file is missing/unreadable so callers fall back to
 * the procedural atlas.
 */
export function loadStripAtlas(id: string, url: string, tint?: string): Promise<Atlas | null> {
  const key = `strip:${id}:${tint ?? 'base'}`;
  const cached = stripCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = stripPending.get(key);
  if (pending) return pending;
  const p = new Promise<Atlas | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.width !== STRIP_FW * 4 || img.height !== STRIP_FH) {
        stripCache.set(key, null);
        resolve(null);
        return;
      }
      const canvas = makeCanvas(STRIP_FW * 4, STRIP_FH);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      if (tint) {
        // recolor the shirt zone only (skins); number/arms largely untouched
        ctx.globalCompositeOperation = 'hue';
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = tint;
        for (let f = 0; f < 4; f++) ctx.fillRect(f * STRIP_FW + 62, 96, 132, 96);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      const flash = makeCanvas(STRIP_FW * 4, STRIP_FH);
      const fctx = flash.getContext('2d')!;
      fctx.drawImage(canvas, 0, 0);
      fctx.globalCompositeOperation = 'source-in';
      fctx.fillStyle = '#ffffff';
      fctx.fillRect(0, 0, flash.width, flash.height);
      // front-facing strips with printed shirt numbers are never mirrored:
      // a flipped "19" reads garbled. Direction feel comes from the run cycle.
      const atlas: Atlas = { canvas, flash, fw: STRIP_FW, fh: STRIP_FH, frames: 4, feetY: STRIP_FEET, flippable: false };
      stripCache.set(key, atlas);
      resolve(atlas);
    };
    img.onerror = () => {
      stripCache.set(key, null);
      resolve(null);
    };
    img.src = url;
  });
  stripPending.set(key, p);
  return p;
}

/** Synchronously returns a loaded strip atlas, or null if not ready/missing. */
export function getStripAtlas(id: string, tint?: string): Atlas | null {
  return stripCache.get(`strip:${id}:${tint ?? 'base'}`) ?? null;
}

/** Kick off loading all four player strips (fallbacks stay procedural). */
export function primePlayerStrips(playerIds: string[]): void {
  for (const id of playerIds) {
    void loadStripAtlas(id, `art/players/${id}.png`);
    void loadStripAtlas(`${id}-idle`, `art/players/${id}-idle.png`);
  }
}

/* ------------------------------------------------------------------ */
/* Color + shading helpers                                             */
/* ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** factor < 1 darkens, > 1 lightens. Accepts #rgb/#rrggbb. */
export function shade(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Fill current path with a vertical gradient and outline it. */
function fillGrad(ctx: CanvasRenderingContext2D, top: string, bottom: string, y0: number, y1: number, stroke = true): void {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fill();
  if (stroke) ctx.stroke();
}

/** Radial sphere shading with highlight at top-left. */
function sphereGrad(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, base: string): void {
  const g = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.12, cx, cy, r * 1.08);
  g.addColorStop(0, shade(base, 1.34));
  g.addColorStop(0.5, base);
  g.addColorStop(1, shade(base, 0.6));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/* ------------------------------------------------------------------ */
/* Figure painter                                                      */
/* ------------------------------------------------------------------ */

export interface FigureOpts {
  skin: string;
  hair: string;
  hairStyle: 'short' | 'slick' | 'fade' | 'curl' | 'bald' | 'cap' | 'bandana' | 'hood' | 'mane' | 'flatcap';
  hairColor?: string;
  beard?: boolean;
  mustache?: boolean;
  shirt: string;
  shorts: string;
  socks: string;
  trim: string;
  number?: string;
  scarf?: string;
  vest?: string; // hi-vis
  suit?: boolean;
  sunglasses?: boolean;
  bottle?: boolean;
  redCard?: boolean;
  flare?: boolean;
  bulk?: number; // width multiplier
  capColor?: string;
  belly?: string; // lighter belly patch (mascot suits)
}

function drawLeg(ctx: CanvasRenderingContext2D, o: FigureOpts, x: number, hipY: number, lift: number, dark: boolean): void {
  const f = dark ? 0.6 : 1;
  const sockTop = hipY + 10 - lift * 0.55;
  // sock (lower leg)
  rr(ctx, x - 4.5, sockTop, 9, 17 - lift * 0.3, 3.5);
  fillGrad(ctx, shade(o.socks, 1.12 * f), shade(o.socks, 0.7 * f), sockTop, sockTop + 17);
  // shorts stub (upper leg)
  rr(ctx, x - 6, hipY + 1, 12, 12, 5);
  fillGrad(ctx, shade(o.shorts, 1.1 * f), shade(o.shorts, 0.68 * f), hipY + 1, hipY + 13);
  // boot
  const by = -lift;
  const g = ctx.createLinearGradient(0, by - 6, 0, by + 3);
  g.addColorStop(0, dark ? '#1c1a22' : '#322f3c');
  g.addColorStop(1, '#0d0c10');
  ctx.fillStyle = g;
  rr(ctx, x - 6.5, by - 5, 14, 7.5, 3.5);
  ctx.fill();
  ctx.stroke();
  // boot sheen
  ctx.strokeStyle = rgba('#ffffff', dark ? 0.07 : 0.25);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x - 3.5, by - 3);
  ctx.lineTo(x + 3, by - 3.6);
  ctx.stroke();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3;
}

function drawArm(
  ctx: CanvasRenderingContext2D,
  o: FigureOpts,
  side: number,
  shoulderX: number,
  shoulderY: number,
  swing: number,
  dark: boolean,
): { hx: number; hy: number } {
  const f = dark ? 0.6 : 1;
  const ax = shoulderX + side * 1.5;
  const elbowY = shoulderY + 7 + swing * 0.4;
  const hx = ax + side * 1.2 + swing * 0.35;
  const hy = shoulderY + 12 + swing * 0.55;
  const sleeve = o.suit ? '#232836' : o.shirt;
  // sleeve
  rr(ctx, ax - 4.6, shoulderY - 1, 9.2, 9.5, 4.4);
  fillGrad(ctx, shade(sleeve, 1.12 * f), shade(sleeve, 0.64 * f), shoulderY - 1, shoulderY + 9);
  // forearm (skin)
  ctx.fillStyle = shade(o.skin, f);
  rr(ctx, ax - 3.8, elbowY, 7.6, hy - elbowY + 2, 3.6);
  ctx.fill();
  ctx.stroke();
  // hand (small sphere)
  sphereGrad(ctx, hx, hy + 2.5, 5, shade(o.skin, f));
  return { hx, hy: hy + 2.5 };
}

/**
 * Draws a volumetric cartoon figure. Origin = feet center. Frame 0..3 run cycle.
 * Figure is ~62px tall, centered at x=0.
 */
export function drawFigure(ctx: CanvasRenderingContext2D, o: FigureOpts, frame: number): void {
  const bulk = o.bulk ?? 1;
  const t = frame / FRAMES;
  const swing = Math.sin(t * Math.PI * 2);
  const bob = Math.abs(Math.sin(t * Math.PI * 2)) * 2.5;

  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const hipY = -35 - bob;
  const shoulderY = hipY - 19;
  const headR = o.hairStyle === 'mane' ? 15 : 12.5;
  const headY = shoulderY - 2 - headR;
  const torsoW = 27 * bulk;

  // ---- far arm (behind torso) ----
  drawArm(ctx, o, -1, -torsoW / 2 - 2, shoulderY + 2, -swing * 7, true);

  // ---- far leg, then near leg ----
  const farLift = Math.max(0, -swing) * 6;
  const nearLift = Math.max(0, swing) * 6;
  drawLeg(ctx, o, -5 - bulk * 2 - swing * 2.2, hipY, farLift, true);
  drawLeg(ctx, o, 5 + bulk * 2 + swing * 2.2, hipY, nearLift, false);

  // ---- torso (gradient trapezoid, wider at shoulders) ----
  const waistW = torsoW * 0.82;
  ctx.beginPath();
  ctx.moveTo(-torsoW / 2, shoulderY - 1);
  ctx.quadraticCurveTo(0, shoulderY - 4, torsoW / 2, shoulderY - 1);
  ctx.lineTo(waistW / 2, hipY + 4);
  ctx.quadraticCurveTo(0, hipY + 7, -waistW / 2, hipY + 4);
  ctx.closePath();
  const shirtBase = o.suit ? '#232836' : o.shirt;
  fillGrad(ctx, shade(shirtBase, 1.18), shade(shirtBase, 0.66), shoulderY - 4, hipY + 7);

  // torso shading: side falloff + fold lines
  ctx.save();
  ctx.clip();
  const side = ctx.createLinearGradient(-torsoW / 2, 0, torsoW / 2, 0);
  side.addColorStop(0, 'rgba(0,0,0,0.16)');
  side.addColorStop(0.35, 'rgba(0,0,0,0)');
  side.addColorStop(0.75, 'rgba(0,0,0,0.05)');
  side.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = side;
  ctx.fillRect(-torsoW / 2 - 2, shoulderY - 5, torsoW + 4, hipY - shoulderY + 13);
  ctx.strokeStyle = 'rgba(0,0,0,0.14)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-torsoW * 0.22, shoulderY + 8);
  ctx.quadraticCurveTo(-torsoW * 0.28, (shoulderY + hipY) / 2, -torsoW * 0.16, hipY + 2);
  ctx.moveTo(torsoW * 0.24, shoulderY + 9);
  ctx.quadraticCurveTo(torsoW * 0.3, (shoulderY + hipY) / 2, torsoW * 0.18, hipY + 2);
  ctx.stroke();
  // top rim light on shoulders
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(-torsoW / 2 + 2, shoulderY + 1);
  ctx.quadraticCurveTo(-torsoW * 0.2, shoulderY - 3, torsoW * 0.1, shoulderY - 2);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3;

  // chest details
  if (o.belly) {
    ctx.fillStyle = o.belly;
    ctx.beginPath();
    ctx.ellipse(0, (shoulderY + hipY) / 2 + 3, torsoW * 0.28, (hipY - shoulderY) * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (o.vest) {
    ctx.fillStyle = o.vest;
    rr(ctx, -torsoW / 2 + 3, shoulderY + 1, torsoW - 6, hipY - shoulderY, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(220,228,235,0.9)';
    ctx.fillRect(-torsoW / 2 + 3, shoulderY + 9, torsoW - 6, 4.5);
  } else if (o.suit) {
    ctx.fillStyle = '#f5f5f5';
    ctx.beginPath();
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(6, shoulderY + 12);
    ctx.lineTo(0, shoulderY + 21);
    ctx.lineTo(-6, shoulderY + 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#c8102e';
    ctx.beginPath();
    ctx.moveTo(0, shoulderY + 2);
    ctx.lineTo(2.4, shoulderY + 12);
    ctx.lineTo(0, shoulderY + 19);
    ctx.lineTo(-2.4, shoulderY + 12);
    ctx.closePath();
    ctx.fill();
  } else {
    // collar trim + number
    ctx.strokeStyle = o.trim;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-6, shoulderY + 1);
    ctx.lineTo(0, shoulderY + 6);
    ctx.lineTo(6, shoulderY + 1);
    ctx.stroke();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
    if (o.number) {
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = rgba('#0a0d18', 0.55);
      ctx.strokeText(o.number, 0, shoulderY + 15);
      ctx.fillStyle = o.trim;
      ctx.fillText(o.number, 0, shoulderY + 15);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 3;
    }
  }

  // ---- near arm (in front of torso) ----
  const nearHand = drawArm(ctx, o, 1, torsoW / 2 + 2, shoulderY + 2, swing * 7, false);
  // ambient occlusion under the near arm
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.ellipse(torsoW / 2 - 2, shoulderY + 8, 4, 7, 0.4, 0, Math.PI * 2);
  ctx.fill();

  // held items (near hand)
  if (o.bottle) {
    ctx.save();
    ctx.translate(nearHand.hx, nearHand.hy);
    ctx.rotate(0.3);
    rr(ctx, -2.6, -10, 5.2, 12, 2);
    fillGrad(ctx, '#3f9b58', '#1d5c31', -10, 2);
    ctx.fillStyle = '#a7e8bd';
    ctx.fillRect(-2.6, -10, 5.2, 2.6);
    ctx.restore();
  }
  if (o.redCard) {
    ctx.fillStyle = '#e8283f';
    rr(ctx, nearHand.hx - 3, nearHand.hy - 10, 7.5, 10, 1.2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(nearHand.hx - 1.5, nearHand.hy - 8);
    ctx.lineTo(nearHand.hx + 2, nearHand.hy - 8.8);
    ctx.stroke();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
  }
  if (o.flare) {
    ctx.fillStyle = '#5a4632';
    rr(ctx, nearHand.hx - 2.2, nearHand.hy - 11, 4.4, 12, 2);
    ctx.fill();
    ctx.stroke();
    const fg = ctx.createRadialGradient(nearHand.hx, nearHand.hy - 13, 0.5, nearHand.hx, nearHand.hy - 13, 7);
    fg.addColorStop(0, '#fff3c4');
    fg.addColorStop(0.5, '#ff9a3d');
    fg.addColorStop(1, 'rgba(255,90,30,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(nearHand.hx, nearHand.hy - 13, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- scarf (behind head, over shoulders) ----
  if (o.scarf) {
    rr(ctx, -headR - 3, headY + headR - 4, (headR + 3) * 2, 7.5, 3.5);
    fillGrad(ctx, shade(o.scarf, 1.15), shade(o.scarf, 0.62), headY + headR - 4, headY + headR + 4);
    rr(ctx, 5, headY + headR + 2, 7, 12, 3);
    fillGrad(ctx, shade(o.scarf, 1.05), shade(o.scarf, 0.6), headY + headR + 2, headY + headR + 14);
  }

  // ---- neck + chin shadow ----
  ctx.fillStyle = shade(o.skin, 0.8);
  rr(ctx, -4.5, headY + headR - 5, 9, 7, 3);
  ctx.fill();

  // ---- mane / hood back layer ----
  if (o.hairStyle === 'mane') {
    sphereGrad(ctx, 0, headY, headR + 7.5, '#a06c34');
    for (const s of [-1, 1]) {
      sphereGrad(ctx, s * (headR + 4), headY - headR - 2, 4.6, '#a06c34');
    }
  }
  if (o.hairStyle === 'hood') {
    sphereGrad(ctx, 0, headY, headR + 5.5, '#2b2430');
  }

  // ---- head (sphere) ----
  sphereGrad(ctx, 0, headY, headR, o.skin);
  // occlusion shadow under chin is baked by sphere gradient bottom

  // ---- hair / headwear ----
  const hairC = o.hairColor ?? o.hair;
  const hy = headY;
  switch (o.hairStyle) {
    case 'short': {
      ctx.beginPath();
      ctx.arc(0, hy, headR, Math.PI * 0.95, Math.PI * 2.05);
      ctx.quadraticCurveTo(headR * 0.55, hy - headR - 4, 0, hy - headR - 2.5);
      ctx.quadraticCurveTo(-headR * 0.55, hy - headR - 4, -headR * 0.99, hy - 1);
      fillGrad(ctx, shade(hairC, 1.35), shade(hairC, 0.7), hy - headR - 4, hy + 1);
      break;
    }
    case 'slick': {
      ctx.beginPath();
      ctx.arc(0, hy, headR, Math.PI * 0.92, Math.PI * 2.08);
      ctx.quadraticCurveTo(3, hy - headR - 5.5, -headR * 0.7, hy - headR - 0.5);
      fillGrad(ctx, shade(hairC, 1.5), shade(hairC, 0.75), hy - headR - 5, hy + 1);
      // pompadour shine
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.55, hy - headR * 0.75);
      ctx.quadraticCurveTo(0, hy - headR - 3, headR * 0.5, hy - headR * 0.7);
      ctx.stroke();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 3;
      break;
    }
    case 'fade': {
      ctx.beginPath();
      ctx.arc(0, hy - 1, headR * 0.94, Math.PI * 1.02, Math.PI * 1.98);
      ctx.lineTo(headR * 0.52, hy - headR - 2.5);
      ctx.lineTo(-headR * 0.52, hy - headR - 2.5);
      ctx.closePath();
      fillGrad(ctx, shade(hairC, 1.3), shade(hairC, 0.8), hy - headR - 3, hy);
      break;
    }
    case 'curl': {
      for (let i = -2; i <= 2; i++) {
        sphereGrad(ctx, i * 5.1, hy - headR + 1.5 - Math.abs(i) * -0.5, 5.2, hairC);
      }
      sphereGrad(ctx, -headR + 2, hy - headR * 0.5, 4.4, hairC);
      sphereGrad(ctx, headR - 2, hy - headR * 0.5, 4.4, hairC);
      break;
    }
    case 'bald':
      break;
    case 'cap':
    case 'flatcap': {
      const cc = o.capColor ?? '#c8102e';
      ctx.beginPath();
      ctx.arc(0, hy - 1, headR + 1, Math.PI, Math.PI * 2);
      fillGrad(ctx, shade(cc, 1.25), shade(cc, 0.7), hy - headR - 2, hy);
      // brim + the shadow it casts on the face
      ctx.fillStyle = shade(cc, 0.85);
      rr(ctx, -headR - 3.5, hy - 4.5, (headR + 3.5) * 2, 5, 2.4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(-headR + 1, hy - 1, headR * 2 - 2, 4);
      break;
    }
    case 'bandana': {
      const cc = o.capColor ?? '#e8283f';
      rr(ctx, -headR, hy - headR - 1, headR * 2, 6.5, 3);
      fillGrad(ctx, shade(cc, 1.2), shade(cc, 0.7), hy - headR - 1, hy - headR + 6);
      break;
    }
    case 'hood':
    case 'mane':
      break;
  }

  // ---- face ----
  const eyeY = hy + 2.2;
  if (o.sunglasses) {
    ctx.fillStyle = '#101014';
    rr(ctx, -headR + 2, eyeY - 3.5, headR * 2 - 4, 7, 3);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-headR + 5, eyeY + 2);
    ctx.lineTo(-headR + 9, eyeY - 2.5);
    ctx.stroke();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
  } else {
    // white of eyes + pupils
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#f5f7fa';
      ctx.beginPath();
      ctx.ellipse(s * 4.4, eyeY, 2, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.arc(s * 4.4 + 0.5, eyeY + 0.5, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    // brows
    ctx.strokeStyle = hairC;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-7, eyeY - 4.6);
    ctx.lineTo(-2.2, eyeY - 5.3);
    ctx.moveTo(7, eyeY - 4.6);
    ctx.lineTo(2.2, eyeY - 5.3);
    ctx.stroke();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
  }
  // nose hint
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(0, eyeY + 2);
  ctx.lineTo(-1, eyeY + 4.4);
  ctx.stroke();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3;

  if (o.beard) {
    ctx.beginPath();
    ctx.arc(0, hy + 5, headR - 2, Math.PI * 0.12, Math.PI * 0.88);
    ctx.lineTo(0, hy + headR - 3);
    ctx.closePath();
    fillGrad(ctx, shade(hairC, 1.15), shade(hairC, 0.7), hy + 3, hy + headR);
    // mouth gap
    ctx.fillStyle = shade(o.skin, 0.9);
    ctx.fillRect(-2.5, hy + 6.5, 5, 3);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(-2.5, hy + 6.5, 5, 3);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
  }
  if (o.mustache) {
    rr(ctx, -6, hy + 4, 12, 2.6, 1.3);
    fillGrad(ctx, shade(hairC, 1.1), shade(hairC, 0.7), hy + 4, hy + 6.6);
  }
  if (!o.beard && !o.mustache && !o.sunglasses && o.hairStyle !== 'mane') {
    // smile
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.arc(0, hy + 3.6, 4.4, Math.PI * 0.18, Math.PI * 0.82);
    ctx.stroke();
    ctx.lineWidth = 3;
  }

  // ---- rim light (key light top-left) ----
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.arc(0, headY, headR - 0.8, Math.PI * 0.95, Math.PI * 1.55);
  ctx.stroke();
  // skin specular
  if (o.hairStyle === 'bald') {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.ellipse(-headR * 0.35, headY - headR * 0.45, 2.6, 1.6, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ------------------------------------------------------------------ */
/* Atlases                                                             */
/* ------------------------------------------------------------------ */

export function playerAtlas(p: PlayerDef, kit?: { shirt: string; shorts: string; socks: string; trim: string }): Atlas {
  const k = kit ?? p.kit;
  return buildAtlas(`player:${p.id}:${k.shirt}${k.shorts}`, (ctx, f) => {
    ctx.translate(FW / 2, FH - 7);
    drawFigure(
      ctx,
      {
        skin: `#${p.skin.toString(16).padStart(6, '0')}`,
        hair: p.hair,
        hairStyle: p.hairStyle,
        beard: p.beard,
        shirt: k.shirt,
        shorts: k.shorts,
        socks: k.socks,
        trim: k.trim,
        number: String(p.number),
      },
      f,
    );
  });
}

export function enemyAtlas(id: Exclude<EnemyId, 'referee' | 'captain'>): Atlas {
  return buildAtlas(`enemy:${id}`, (ctx, f) => {
    ctx.translate(FW / 2, FH - 7);
    switch (id) {
      case 'hooligan':
        drawFigure(ctx, { skin: '#e8b88a', hair: '#3c2c1e', hairStyle: 'cap', capColor: '#7a1f2b', shirt: '#33415c', shorts: '#2b3245', socks: '#22283a', trim: '#8d99ae', bulk: 1.05 }, f);
        break;
      case 'ultra':
        drawFigure(ctx, { skin: '#e8b88a', hair: '#3c2c1e', hairStyle: 'bald', shirt: '#23202a', shorts: '#23202a', socks: '#23202a', trim: '#e8283f', scarf: '#e8283f' }, f);
        break;
      case 'thrower':
        drawFigure(ctx, { skin: '#d9a066', hair: '#26201c', hairStyle: 'flatcap', capColor: '#2e5339', shirt: '#2e5339', shorts: '#3a3f4b', socks: '#2b2f38', trim: '#e9c46a', bottle: true }, f);
        break;
      case 'steward':
        drawFigure(ctx, { skin: '#c68863', hair: '#4a3a2a', hairStyle: 'short', mustache: true, shirt: '#6c757d', shorts: '#343a40', socks: '#343a40', trim: '#343a40', vest: '#e8f33f', bulk: 1.15 }, f);
        break;
      case 'mascot':
        drawFigure(ctx, { skin: '#d69a4e', hair: '#b0783c', hairStyle: 'mane', shirt: '#d69a4e', shorts: '#c98f42', socks: '#c98f42', trim: '#8a5a28', belly: '#eed3a3', bulk: 1.35 }, f);
        break;
    }
  });
}

export function bossAtlas(id: 'referee' | 'captain'): Atlas {
  return buildAtlas(`boss:${id}`, (ctx, f) => {
    ctx.translate(FW / 2, FH - 7);
    if (id === 'referee') {
      drawFigure(ctx, { skin: '#e8b88a', hair: '#5a5a5a', hairStyle: 'short', shirt: '#17181c', shorts: '#17181c', socks: '#17181c', trim: '#f5f5f5', redCard: true, bulk: 1.2 }, f);
    } else {
      drawFigure(ctx, { skin: '#c68863', hair: '#1c1a1e', hairStyle: 'hood', shirt: '#3d2b3f', shorts: '#241f2b', socks: '#241f2b', trim: '#ff9a3d', flare: true, bulk: 1.3 }, f);
    }
  });
}

export function guardAtlas(): Atlas {
  return buildAtlas('guard', (ctx, f) => {
    ctx.translate(FW / 2, FH - 7);
    drawFigure(ctx, { skin: '#b08054', hair: '#1c1a1e', hairStyle: 'bald', shirt: '#20242e', shorts: '#20242e', socks: '#20242e', trim: '#f5f5f5', suit: true, sunglasses: true, bulk: 1.3 }, f);
  });
}

/* ------------------------------------------------------------------ */
/* Small sprites                                                       */
/* ------------------------------------------------------------------ */

export function ballSprite(size = 20): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d')!;
  const r = size / 2 - 1;
  ctx.translate(size / 2, size / 2);
  // shaded sphere base
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.15, 0, 0, r * 1.1);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.55, '#eef1f5');
  g.addColorStop(1, '#9aa3b0');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // pentagon + patches
  ctx.fillStyle = '#23232b';
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    const px = Math.cos(a) * r * 0.34;
    const py = Math.sin(a) * r * 0.34;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5 + Math.PI / 5;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r * 0.78, Math.sin(a) * r * 0.78, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }
  // specular
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  ctx.arc(-r * 0.35, -r * 0.42, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

export function xpSprite(tier: 1 | 2 | 3): HTMLCanvasElement {
  const size = tier === 1 ? 12 : tier === 2 ? 14 : 18;
  const color = tier === 1 ? '#8ed0ff' : tier === 2 ? '#ffd166' : '#ff8ef0';
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d')!;
  ctx.translate(size / 2, size / 2);
  const r = size / 2 - 1.5;
  // crystal: gradient fill + facet line
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r * 1.15);
  g.addColorStop(0, shade(color, 1.5));
  g.addColorStop(0.55, color);
  g.addColorStop(1, shade(color, 0.55));
  ctx.fillStyle = g;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 6;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-r * 0.3, -r * 0.45);
  ctx.lineTo(r * 0.35, -r * 0.1);
  ctx.stroke();
  return c;
}

export function coinSprite(): HTMLCanvasElement {
  const size = 14;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d')!;
  ctx.translate(size / 2, size / 2);
  const r = size / 2 - 1;
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r * 1.1);
  g.addColorStop(0, '#fff3c4');
  g.addColorStop(0.5, '#ffd23f');
  g.addColorStop(1, '#b8920f');
  ctx.fillStyle = g;
  ctx.strokeStyle = '#8a6d1f';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, r - 2.8, 0, Math.PI * 2);
  ctx.stroke();
  return c;
}

/** Sports drink pickup (heal). */
export function drinkSprite(): HTMLCanvasElement {
  const c = makeCanvas(16, 22);
  const ctx = c.getContext('2d')!;
  ctx.translate(8, 11);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.6;
  // bottle body
  rr(ctx, -5.5, -6, 11, 14, 3.5);
  const g = ctx.createLinearGradient(-5.5, 0, 5.5, 0);
  g.addColorStop(0, '#1d7a45');
  g.addColorStop(0.45, '#37d67a');
  g.addColorStop(1, '#156236');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.stroke();
  // cap
  rr(ctx, -3, -10, 6, 4.5, 1.6);
  ctx.fillStyle = '#f5f7fa';
  ctx.fill();
  ctx.stroke();
  // energy bolt
  ctx.fillStyle = '#f5f7fa';
  ctx.beginPath();
  ctx.moveTo(1.5, -3.5);
  ctx.lineTo(-2.5, 1.5);
  ctx.lineTo(0, 1.5);
  ctx.lineTo(-1.5, 5);
  ctx.lineTo(2.5, 0.5);
  ctx.lineTo(0, 0.5);
  ctx.closePath();
  ctx.fill();
  return c;
}

export function bottleSprite(): HTMLCanvasElement {  const c = makeCanvas(12, 20);
  const ctx = c.getContext('2d')!;
  ctx.translate(6, 10);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.5;
  rr(ctx, -4, -6, 8, 13, 3);
  const g = ctx.createLinearGradient(-4, 0, 4, 0);
  g.addColorStop(0, '#1d5c31');
  g.addColorStop(0.45, '#3f9b58');
  g.addColorStop(1, '#17492a');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.stroke();
  rr(ctx, -2, -10, 4, 5, 1.5);
  ctx.fillStyle = '#2e7d43';
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(-2.6, -4, 1.8, 9);
  return c;
}

/** Circular ability badge icon used in the DOM UI. */
export function abilityIcon(glyph: 'ball' | 'orbit' | 'whistle' | 'dash' | 'shield' | 'pressure', color: string, size = 64): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d')!;
  const r = size / 2;
  ctx.translate(r, r);
  const bg = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.2, 0, 0, r);
  bg.addColorStop(0, '#232c44');
  bg.addColorStop(1, '#10141f');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(0, 0, r - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = size * 0.07;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const s = size / 64;
  ctx.lineWidth = 4 * s;
  ctx.lineCap = 'round';
  switch (glyph) {
    case 'ball': {
      ctx.beginPath();
      ctx.arc(4 * s, 4 * s, 12 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#141824';
      ctx.lineWidth = 2.4 * s;
      ctx.beginPath();
      ctx.arc(4 * s, 4 * s, 5.5 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 * s;
      ctx.beginPath();
      ctx.moveTo(-22 * s, -10 * s);
      ctx.lineTo(-12 * s, -6 * s);
      ctx.moveTo(-24 * s, 2 * s);
      ctx.lineTo(-13 * s, 2 * s);
      ctx.stroke();
      break;
    }
    case 'orbit': {
      ctx.setLineDash([5 * s, 6 * s]);
      ctx.beginPath();
      ctx.arc(0, 0, 17 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 17 * s, Math.sin(a) * 17 * s, 5.5 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(0, 0, 4.5 * s, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'whistle': {
      rr(ctx, -18 * s, -6 * s, 30 * s, 16 * s, 7 * s);
      ctx.fill();
      ctx.fillRect(6 * s, -10 * s, 12 * s, 7 * s);
      ctx.fillStyle = '#141824';
      ctx.beginPath();
      ctx.arc(-7 * s, 2 * s, 5 * s, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'dash': {
      ctx.lineWidth = 6 * s;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo((-12 + i * 4) * s, (-14 + i * 14) * s);
        ctx.lineTo((10 + i * 4) * s, i * 14 * s);
        ctx.lineTo((-12 + i * 4) * s, (14 + i * 14) * s);
        ctx.stroke();
      }
      break;
    }
    case 'shield': {
      ctx.beginPath();
      ctx.moveTo(0, -18 * s);
      ctx.quadraticCurveTo(16 * s, -14 * s, 16 * s, -6 * s);
      ctx.quadraticCurveTo(16 * s, 10 * s, 0, 18 * s);
      ctx.quadraticCurveTo(-16 * s, 10 * s, -16 * s, -6 * s);
      ctx.quadraticCurveTo(-16 * s, -14 * s, 0, -18 * s);
      ctx.fill();
      ctx.fillStyle = '#141824';
      ctx.beginPath();
      ctx.arc(0, -2 * s, 6 * s, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'pressure': {
      // ground-stomp: downward arrow + expanding pressure waves
      ctx.beginPath();
      ctx.moveTo(0, -20 * s);
      ctx.lineTo(0, -3 * s);
      ctx.moveTo(-7 * s, -10 * s);
      ctx.lineTo(0, -2 * s);
      ctx.lineTo(7 * s, -10 * s);
      ctx.stroke();
      for (let i = 1; i <= 3; i++) {
        ctx.globalAlpha = 1.05 - i * 0.24;
        ctx.beginPath();
        ctx.arc(0, 2 * s, 4 * s + i * 7 * s, Math.PI * 0.18, Math.PI * 0.82);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
  }
  return c;
}

export const ABILITY_GLYPHS: Record<string, 'ball' | 'orbit' | 'whistle' | 'dash' | 'shield' | 'pressure'> = {
  strike: 'ball',
  orbit: 'orbit',
  whistle: 'whistle',
  dash: 'dash',
  guard: 'shield',
  pressure: 'pressure',
};
