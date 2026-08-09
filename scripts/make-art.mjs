/**
 * Renders tools/compose.html in headless Chromium and saves the canvas as
 * public/art/menu-art.png + generates src/assets/icon.png (app icon).
 * All artifacts stay inside the project. Run with the dev server up:
 *   node scripts/make-art.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ART_DIR = `${ROOT}public/art`;
mkdirSync(ART_DIR, { recursive: true });
mkdirSync(`${ROOT}src/assets`, { recursive: true });

const BASE = process.env.FF_BASE ?? 'http://localhost:5199';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

// key art
await page.goto(`${BASE}/tools/compose.html`);
await page.waitForFunction(() => window.__ART_READY === true, null, { timeout: 15000 });
await page.waitForTimeout(300);
const dataUrl = await page.evaluate(() => {
  const c = document.getElementById('art');
  return c.toDataURL('image/png');
});
const png = Buffer.from(dataUrl.split(',')[1], 'base64');
writeFileSync(`${ART_DIR}/menu-art.png`, png);
console.log(`menu-art.png saved (${(png.length / 1024).toFixed(0)} KB)`);
await page.screenshot({ path: `${ROOT}test-results/shots/art-preview.png` });

// icon: drawn programmatically (crest + ball + FF monogram)
const iconUrl = await page.evaluate(() => {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d');
  const cx = S / 2;
  // rounded crest
  const crest = (r) => {
    ctx.beginPath();
    ctx.moveTo(cx - r, S * 0.18);
    ctx.quadraticCurveTo(cx - r, S * 0.1, cx - r * 0.72, S * 0.1);
    ctx.lineTo(cx + r * 0.72, S * 0.1);
    ctx.quadraticCurveTo(cx + r, S * 0.1, cx + r, S * 0.18);
    ctx.lineTo(cx + r, S * 0.52);
    ctx.quadraticCurveTo(cx + r, S * 0.78, cx, S * 0.94);
    ctx.quadraticCurveTo(cx - r, S * 0.78, cx - r, S * 0.52);
    ctx.closePath();
  };
  crest(200);
  const g = ctx.createLinearGradient(0, S * 0.1, 0, S * 0.94);
  g.addColorStop(0, '#1b2440');
  g.addColorStop(1, '#0b1020');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 22;
  ctx.strokeStyle = '#ffd23f';
  ctx.stroke();
  // ball
  const br = 108;
  const by = S * 0.46;
  const bg = ctx.createRadialGradient(cx - br * 0.35, by - br * 0.4, br * 0.15, cx, by, br * 1.1);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(0.55, '#eef1f5');
  bg.addColorStop(1, '#9aa3b0');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, by, br, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#1d1626';
  ctx.stroke();
  ctx.fillStyle = '#23232b';
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    const px = cx + Math.cos(a) * br * 0.36;
    const py = by + Math.sin(a) * br * 0.36;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5 + Math.PI / 5;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * br * 0.8, by + Math.sin(a) * br * 0.8, br * 0.17, 0, Math.PI * 2);
    ctx.fill();
  }
  // FF monogram
  ctx.font = '900 92px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 12;
  ctx.strokeStyle = '#1d1626';
  ctx.strokeText('FF', cx, S * 0.78);
  ctx.fillStyle = '#ffd23f';
  ctx.fillText('FF', cx, S * 0.78);
  return c.toDataURL('image/png');
});
writeFileSync(`${ROOT}src/assets/icon.png`, Buffer.from(iconUrl.split(',')[1], 'base64'));
console.log('icon.png saved');

await browser.close();
console.log('DONE');
