/**
 * Captures the full evidence set of screenshots into evidence/shots/
 * (persists across test runs; test-results/ gets wiped by playwright).
 * Usage: node scripts/capture-evidence.mjs   (dev server must be running)
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../evidence/shots', import.meta.url));
mkdirSync(OUT, { recursive: true });
const BASE = process.env.FF_BASE ?? 'http://localhost:5199';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.game-logo');
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/01-menu.png` });

await page.click('[data-act="play"]');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-select.png` });

await page.click('.char-card[data-player="messi"]');
await page.click('[data-act="start"]');
await page.waitForTimeout(2500);
await page.keyboard.down('d');
await page.waitForTimeout(700);
await page.keyboard.up('d');
await page.screenshot({ path: `${OUT}/03-gameplay.png` });

// level-up
await page.evaluate(() => window.__FF.giveXp(40));
await page.waitForSelector('#levelup-screen');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/04-levelup.png` });
await page.evaluate(() => window.__FF.pickUpgrade(0));

// dense combat
await page.evaluate(() => {
  const ff = window.__FF;
  const sim = ff.getSim();
  sim.player.abilities = { strike: 4, orbit: 4, whistle: 3, dash: 3, guard: 3 };
  sim.player.maxHp = 2000;
  sim.player.hp = 2000;
  ff.setTime(210);
  const types = ['hooligan', 'ultra', 'thrower', 'steward', 'mascot'];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ff.debugSpawn(types[i % 5], Math.cos(a) * 330, Math.sin(a) * 250, i % 6 === 0);
  }
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/05-combat.png` });

// half-time boss close
await page.evaluate(() => {
  // auto-dismiss level-up overlays while staging boss shots
  window.__ffAuto = setInterval(() => {
    if (window.__FF.getState().run === 'levelup') window.__FF.pickUpgrade(0);
  }, 250);
  const sim = window.__FF.getSim();
  sim.enemies.forEach((e) => { if (e.boss) e.active = false; });
  sim.bossAlive = null;
  window.__FF.setTime(300.2);
});
await page.waitForFunction(() => {
  const sim = window.__FF.getSim();
  if (!sim || !sim.bossAlive) return false;
  return Math.hypot(sim.bossAlive.x - sim.player.x, sim.bossAlive.y - sim.player.y) < 430;
}, null, { timeout: 25000 });
await page.screenshot({ path: `${OUT}/06-boss-referee.png` });

// final boss + flare telegraphs
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.enemies.forEach((e) => { if (e.boss) e.active = false; });
  sim.bossAlive = null;
  window.__FF.setTime(540.2);
});
await page.waitForFunction(() => {
  const sim = window.__FF.getSim();
  return sim && sim.bossAlive && sim.telegraphs.some((t) => t.active);
}, null, { timeout: 25000 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/07-boss-captain.png` });
await page.evaluate(() => clearInterval(window.__ffAuto));

// death result (dismiss any pending level-up first)
await page.evaluate(() => {
  for (let i = 0; i < 20; i++) {
    const st = window.__FF.getState();
    if (st.run !== 'levelup') break;
    window.__FF.pickUpgrade(0);
  }
});
await page.evaluate(() => window.__FF.hurt(99999));
await page.waitForSelector('.result-title-lose', { timeout: 8000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/08-defeat.png` });

// club: upgrades + skins
await page.evaluate(() => window.__FF.addCoins(500));
await page.click('[data-act="club"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/09-club.png` });
await page.click('[data-tab="skins"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/10-skins.png` });

// victory
await page.click('[data-act="back"]');
await page.evaluate(() => window.__FF.startRun('yamal'));
await page.waitForTimeout(400);
await page.evaluate(() => window.__FF.setTime(598));
await page.waitForSelector('.victory-screen', { timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/11-victory.png` });

// mobile menu + gameplay with joystick
const ctx2 = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true });
const m = await ctx2.newPage();
await m.goto(BASE);
await m.waitForSelector('.game-logo');
await m.waitForTimeout(800);
await m.screenshot({ path: `${OUT}/12-mobile-menu.png` });
await m.tap('[data-act="play"]');
await m.tap('[data-act="start"]');
await m.waitForTimeout(600);
const cdp = await ctx2.newCDPSession(m);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 500, id: 1 }] });
for (let i = 0; i < 8; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100 + i * 4, y: 500, id: 1 }] });
  await m.waitForTimeout(50);
}
await m.screenshot({ path: `${OUT}/13-mobile-joystick.png` });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'NO PAGE ERRORS');
console.log('evidence captured to evidence/shots/');
await browser.close();
