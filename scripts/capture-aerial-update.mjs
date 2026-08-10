/** Focused visual evidence for the fast-pace aerial-attack release. */
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { launchChromium } from './browser-runtime.mjs';

const OUT = fileURLToPath(new URL('../evidence/shots', import.meta.url));
const BASE = process.env.FF_BASE ?? 'http://127.0.0.1:5180';
mkdirSync(OUT, { recursive: true });

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(BASE);
await page.waitForSelector('.game-logo');
await page.evaluate(() => window.__FF.startRun('messi'));

await page.evaluate(() => window.__FF.showAbilityCards(['curveball', 'bootseekers', 'strike']));
await page.waitForFunction(() => [...document.querySelectorAll('.upgrade-card .ability-art')]
  .every((img) => img.complete && img.naturalWidth > 0));
await page.waitForTimeout(450);
await page.screenshot({ path: `${OUT}/58-aerial-seeker-cards.png` });

await page.evaluate(() => {
  window.__FF.startRun('messi');
  const ff = window.__FF;
  const sim = ff.getSim();
  sim.enemies.forEach((enemy) => { enemy.active = false; });
  sim.player.abilities = { curveball: 5, bootseekers: 5 };
  sim.player.curveballCd = 0;
  sim.player.bootseekersCd = 0;
  const specs = [
    ['lobber', -720, -160], ['paparazzo', -650, 120],
    ['flag', -430, -230], ['chant', 440, -230],
    ['flare', 650, 120], ['vuvuzela', 720, -160],
  ];
  for (const [id, dx, dy] of specs) ff.debugSpawn(id, dx, dy);
  for (const enemy of sim.enemies.filter((entry) => entry.active)) {
    enemy.hp = 9999;
    enemy.maxHp = 9999;
    enemy.speed = 0;
  }
});
await page.waitForTimeout(560);
await page.keyboard.press('p');
await page.evaluate(() => {
  document.getElementById('pause-screen')?.remove();
  const banner = document.getElementById('banner');
  if (banner) banner.style.display = 'none';
});
await page.waitForTimeout(40);
await page.screenshot({ path: `${OUT}/59-aerial-seekers-gameplay.png` });

console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'NO PAGE ERRORS');
console.log('focused aerial evidence captured');
await browser.close();
