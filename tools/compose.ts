/**
 * Dev-tool art composer: paints the game's menu key art with the same
 * procedural sprite painter used in-game, so the menu matches the world.
 * Rendered in a headless browser by scripts/make-art.mjs and saved to
 * public/art/menu-art.png. Not part of the shipped bundle.
 */

import { playerAtlas } from '../src/core/sprites';
import { PLAYERS } from '../src/game/data';

const W = 1920;
const H = 1080;
const canvas = document.getElementById('art') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let seed = 987654321;
function rng(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

/* ---------- night sky ---------- */
const sky = ctx.createLinearGradient(0, 0, 0, H * 0.75);
sky.addColorStop(0, '#05070f');
sky.addColorStop(0.55, '#0b1020');
sky.addColorStop(1, '#131c33');
ctx.fillStyle = sky;
ctx.fillRect(0, 0, W, H);

// stars
for (let i = 0; i < 120; i++) {
  ctx.fillStyle = `rgba(245,241,230,${0.1 + rng() * 0.4})`;
  ctx.fillRect(rng() * W, rng() * H * 0.4, 2, 2);
}

// haze
const haze = ctx.createRadialGradient(W / 2, H * 0.62, 60, W / 2, H * 0.62, W * 0.6);
haze.addColorStop(0, 'rgba(120,150,220,0.14)');
haze.addColorStop(1, 'rgba(120,150,220,0)');
ctx.fillStyle = haze;
ctx.fillRect(0, 0, W, H);

/* ---------- floodlights ---------- */
for (const [fx, dir] of [
  [W * 0.08, 1],
  [W * 0.32, 1],
  [W * 0.68, -1],
  [W * 0.92, -1],
] as const) {
  const topY = 60;
  // tower
  ctx.strokeStyle = '#1c2438';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(fx, topY);
  ctx.lineTo(fx + dir * 30, H * 0.42);
  ctx.stroke();
  // lamp head glow
  const glow = ctx.createRadialGradient(fx, topY, 4, fx, topY, 190);
  glow.addColorStop(0, 'rgba(255,246,214,0.95)');
  glow.addColorStop(0.18, 'rgba(255,238,180,0.5)');
  glow.addColorStop(1, 'rgba(255,238,180,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(fx, topY, 190, 0, Math.PI * 2);
  ctx.fill();
  // light cone
  const cone = ctx.createLinearGradient(fx, topY, fx + dir * 260, H * 0.8);
  cone.addColorStop(0, 'rgba(255,244,200,0.20)');
  cone.addColorStop(1, 'rgba(255,244,200,0)');
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(fx - 26, topY + 8);
  ctx.lineTo(fx + 26, topY + 8);
  ctx.lineTo(fx + dir * 480, H * 0.86);
  ctx.lineTo(fx + dir * 40, H * 0.86);
  ctx.closePath();
  ctx.fill();
}

/* ---------- stands with crowd ---------- */
const standTop = H * 0.3;
const standBottom = H * 0.62;
// stand structure
const standGrad = ctx.createLinearGradient(0, standTop, 0, standBottom);
standGrad.addColorStop(0, '#1a2236');
standGrad.addColorStop(1, '#0d1322');
ctx.fillStyle = standGrad;
ctx.fillRect(0, standTop, W, standBottom - standTop);
// tier separators
ctx.fillStyle = 'rgba(0,0,0,0.4)';
for (let t = 1; t < 4; t++) {
  ctx.fillRect(0, standTop + (t * (standBottom - standTop)) / 4, W, 5);
}
// crowd dots
const crowdColors = ['#d8d3c8', '#c46a5a', '#5a7bc4', '#c4b45a', '#7ac48a', '#b08ac4', '#e0e0e0', '#e8283f', '#ffd23f'];
for (let y = standTop + 10; y < standBottom - 6; y += 11) {
  const rowDepth = (y - standTop) / (standBottom - standTop);
  const size = 4.5 + rowDepth * 3.5;
  for (let x = 0; x < W; x += size + 2.5) {
    if (rng() < 0.24) continue;
    ctx.fillStyle = crowdColors[(rng() * crowdColors.length) | 0];
    ctx.fillRect(x + rng() * 3, y + rng() * 3, size, size);
  }
}
// flags and scarves streaks
for (let i = 0; i < 26; i++) {
  const fx = rng() * W;
  const fy = standTop + 20 + rng() * (standBottom - standTop - 60);
  const c = ['#e8283f', '#ffd23f', '#4cc9f0', '#f5f7fa'][(rng() * 4) | 0];
  ctx.fillStyle = c;
  ctx.save();
  ctx.translate(fx, fy);
  ctx.rotate((rng() - 0.5) * 0.6);
  ctx.fillRect(0, 0, 34, 20);
  ctx.restore();
}

/* ---------- LED ad boards ---------- */
ctx.fillStyle = '#0a0e18';
ctx.fillRect(0, standBottom, W, 46);
const ads = ['FOOTBALL FIGHTING', 'TERRACE TV', 'KICK ENERGY', 'MATCHDAY', 'STRIKE COLA', 'BOOTS & CO'];
ctx.font = '700 26px system-ui, sans-serif';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ads.forEach((a, i) => {
  ctx.fillStyle = ['#ffd23f', '#4cc9f0', '#e8283f', '#80ed99', '#f5f7fa', '#ff9a3d'][i];
  ctx.fillText(a, (W / ads.length) * (i + 0.5), standBottom + 24);
});

/* ---------- pitch in perspective ---------- */
const pitchTop = standBottom + 46;
const horizonW = W * 0.94;
const nearW = W * 1.35;
// trapezoid pitch
ctx.beginPath();
ctx.moveTo((W - horizonW) / 2, pitchTop);
ctx.lineTo((W + horizonW) / 2, pitchTop);
ctx.lineTo((W + nearW) / 2, H + 60);
ctx.lineTo((W - nearW) / 2, H + 60);
ctx.closePath();
const pg = ctx.createLinearGradient(0, pitchTop, 0, H);
pg.addColorStop(0, '#1f6b35');
pg.addColorStop(1, '#2e8b47');
ctx.fillStyle = pg;
ctx.fill();
// mowed stripes in perspective
ctx.save();
ctx.clip();
const stripes = 9;
for (let i = 0; i < stripes; i++) {
  if (i % 2 === 0) continue;
  const u0 = i / stripes;
  const u1 = (i + 1) / stripes;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath();
  ctx.moveTo((W - horizonW) / 2 + (horizonW * u0 * (1 - 0)) / 1, pitchTop);
  const xTop0 = (W - horizonW) / 2 + horizonW * u0;
  const xTop1 = (W - horizonW) / 2 + horizonW * u1;
  const xBot0 = (W - nearW) / 2 + nearW * u0;
  const xBot1 = (W - nearW) / 2 + nearW * u1;
  ctx.moveTo(xTop0, pitchTop);
  ctx.lineTo(xTop1, pitchTop);
  ctx.lineTo(xBot1, H + 60);
  ctx.lineTo(xBot0, H + 60);
  ctx.closePath();
  ctx.fill();
}
// center circle (perspective ellipse)
ctx.strokeStyle = 'rgba(245,247,250,0.85)';
ctx.lineWidth = 6;
ctx.beginPath();
ctx.ellipse(W / 2, H * 0.86, 300, 92, 0, 0, Math.PI * 2);
ctx.stroke();
// halfway line
ctx.beginPath();
ctx.moveTo(W / 2 - 640, H * 0.862);
ctx.lineTo(W / 2 + 640, H * 0.862);
ctx.stroke();
// floodlight pools on grass
for (const px of [W * 0.3, W * 0.5, W * 0.7]) {
  const pool = ctx.createRadialGradient(px, H * 0.8, 20, px, H * 0.8, 420);
  pool.addColorStop(0, 'rgba(255,250,220,0.10)');
  pool.addColorStop(1, 'rgba(255,250,220,0)');
  ctx.fillStyle = pool;
  ctx.fillRect(px - 420, H * 0.8 - 420, 840, 840);
}
ctx.restore();

/* ---------- confetti ---------- */
for (let i = 0; i < 160; i++) {
  const c = ['#ffd23f', '#e8283f', '#4cc9f0', '#80ed99', '#f5f7fa'][(rng() * 5) | 0];
  ctx.fillStyle = c;
  ctx.save();
  ctx.translate(rng() * W, standBottom + rng() * (H - standBottom) * 0.7);
  ctx.rotate(rng() * Math.PI);
  ctx.globalAlpha = 0.5 + rng() * 0.5;
  ctx.fillRect(0, 0, 7, 4);
  ctx.restore();
}
ctx.globalAlpha = 1;

/* ---------- heroes ---------- */
function drawHero(p: (typeof PLAYERS)[number], x: number, baseY: number, scale: number): void {
  const atlas = playerAtlas(p);
  const dw = atlas.fw * scale;
  const dh = atlas.fh * scale;
  // ground shadow
  ctx.fillStyle = 'rgba(4,10,6,0.5)';
  ctx.beginPath();
  ctx.ellipse(x + 6, baseY + 2, dw * 0.3, dw * 0.085, 0, 0, Math.PI * 2);
  ctx.fill();
  // rim light behind hero (separates them from the crowd)
  const rim = ctx.createRadialGradient(x, baseY - dh * 0.55, 10, x, baseY - dh * 0.55, dh * 0.72);
  rim.addColorStop(0, 'rgba(255,244,200,0.16)');
  rim.addColorStop(1, 'rgba(255,244,200,0)');
  ctx.fillStyle = rim;
  ctx.fillRect(x - dh, baseY - dh * 1.4, dh * 2, dh * 1.5);
  ctx.save();
  ctx.translate(x, baseY);
  ctx.drawImage(atlas.canvas, 0, 0, atlas.fw, atlas.fh, -dw / 2, -dh + 4 * scale, dw, dh);
  ctx.restore();
}

const heroY = H * 0.985;
drawHero(PLAYERS[2], W * 0.315, heroY - 6, 4.0); // Neymar
drawHero(PLAYERS[0], W * 0.435, heroY, 4.45); // Messi
drawHero(PLAYERS[1], W * 0.565, heroY, 4.45); // Ronaldo
drawHero(PLAYERS[3], W * 0.685, heroY - 6, 4.0); // Yamal

/* ---------- creeping enemy silhouettes ---------- */
for (const [ex, ey, es] of [
  [W * 0.14, H * 0.93, 3.4],
  [W * 0.85, H * 0.9, 3.7],
  [W * 0.07, H * 0.84, 2.7],
  [W * 0.94, H * 0.82, 2.5],
] as const) {
  // ground shadow
  ctx.fillStyle = 'rgba(4,10,6,0.5)';
  ctx.beginPath();
  ctx.ellipse(ex, ey + 4, 16 * es, 5 * es, 0, 0, Math.PI * 2);
  ctx.fill();
  // menacing silhouette: shoulders + head
  ctx.fillStyle = 'rgba(10,12,22,0.92)';
  ctx.beginPath();
  ctx.ellipse(ex, ey, 15 * es, 21 * es, 0, Math.PI, 0);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex, ey - 38 * es, 10.5 * es, 0, Math.PI * 2);
  ctx.fill();
  // glowing eyes
  ctx.fillStyle = 'rgba(232,40,63,0.95)';
  ctx.beginPath();
  ctx.arc(ex - 3.8 * es, ey - 40 * es, 1.7 * es, 0, Math.PI * 2);
  ctx.arc(ex + 3.8 * es, ey - 40 * es, 1.7 * es, 0, Math.PI * 2);
  ctx.fill();
}

/* ---------- vignette ---------- */
const vg = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.3, W / 2, H * 0.55, H * 0.95);
vg.addColorStop(0, 'rgba(5,7,15,0)');
vg.addColorStop(1, 'rgba(5,7,15,0.5)');
ctx.fillStyle = vg;
ctx.fillRect(0, 0, W, H);

// warm grade
ctx.fillStyle = 'rgba(255,210,120,0.03)';
ctx.fillRect(0, 0, W, H);

// signal readiness for the capture script
(window as unknown as { __ART_READY: boolean }).__ART_READY = true;
