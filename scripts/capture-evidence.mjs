/**
 * Captures the full evidence set of screenshots into evidence/shots/
 * (persists across test runs; test-results/ gets wiped by playwright).
 * Usage: node scripts/capture-evidence.mjs   (dev server must be running)
 */
import { devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser-runtime.mjs';

const OUT = fileURLToPath(new URL('../evidence/shots', import.meta.url));
mkdirSync(OUT, { recursive: true });
const BASE = process.env.FF_BASE ?? 'http://localhost:5199';

const browser = await launchChromium();
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

// Accepted generated enemy art, staged before the later density tests.
await page.evaluate(() => {
  const ff = window.__FF;
  const sim = ff.getSim();
  sim.enemies.forEach((e) => { e.active = false; });
  ff.debugSpawn('invader', -260, -105);
  ff.debugSpawn('sprinter', -85, -105);
  ff.debugSpawn('lobber', 90, -105);
  ff.debugSpawn('steward', 265, -105);
  for (const e of sim.enemies.filter((enemy) => enemy.active)) {
    e.hp = 9999;
    e.maxHp = 9999;
  }
});
await page.waitForTimeout(80);
await page.screenshot({ path: `${OUT}/43-ai-enemy-lineup.png` });
await page.evaluate(() => window.__FF.getSim().enemies.forEach((e) => { e.active = false; }));

await page.evaluate(() => {
  const ff = window.__FF;
  const sim = ff.getSim();
  ff.debugSpawn('flare', -190, -105);
  ff.debugSpawn('flag', 0, -105);
  ff.debugSpawn('foam', 190, -105);
  for (const e of sim.enemies.filter((enemy) => enemy.active)) {
    e.hp = 9999;
    e.maxHp = 9999;
  }
});
await page.waitForTimeout(80);
await page.screenshot({ path: `${OUT}/44-ai-enemy-lineup-b.png` });
await page.evaluate(() => window.__FF.getSim().enemies.forEach((e) => { e.active = false; }));

await page.evaluate(() => {
  const ff = window.__FF;
  const sim = ff.getSim();
  ff.debugSpawn('drummer', -210, -105);
  ff.debugSpawn('vuvuzela', 0, -220);
  ff.debugSpawn('mascot', 210, -105);
  for (const e of sim.enemies.filter((enemy) => enemy.active)) {
    e.hp = 9999;
    e.maxHp = 9999;
  }
});
await page.waitForTimeout(80);
await page.screenshot({ path: `${OUT}/45-ai-enemy-lineup-c.png` });
await page.evaluate(() => window.__FF.getSim().enemies.forEach((e) => { e.active = false; }));

await page.evaluate(() => {
  const ff = window.__FF;
  const sim = ff.getSim();
  ff.debugSpawn('banner', -210, -105);
  ff.debugSpawn('paparazzo', 0, -105);
  ff.debugSpawn('chant', 210, -105);
  for (const e of sim.enemies.filter((enemy) => enemy.active)) {
    e.hp = 9999;
    e.maxHp = 9999;
  }
});
await page.waitForTimeout(80);
await page.screenshot({ path: `${OUT}/46-ai-enemy-lineup-d.png` });
await page.evaluate(() => window.__FF.getSim().enemies.forEach((e) => { e.active = false; }));

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
  // Keep capture timing deterministic instead of letting an earned level-up
  // cover the combat and boss evidence frames.
  window.__ffAuto = setInterval(() => {
    if (window.__FF.getState().run === 'levelup') window.__FF.pickUpgrade(0);
  }, 100);
  sim.boss0Spawned = true;
  ff.setTime(210);
  const types = [
    'invader', 'sprinter', 'lobber', 'steward', 'flare', 'flag', 'foam',
    'drummer', 'vuvuzela', 'mascot', 'banner', 'paparazzo', 'chant',
  ];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ff.debugSpawn(types[i % types.length], Math.cos(a) * 330, Math.sin(a) * 250, i % 6 === 0);
  }
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/05-combat.png` });

// first-quarter boss close
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.enemies.forEach((e) => { e.active = false; });
  sim.bossAlive = null;
  sim.boss0Spawned = false;
  sim.boss1Spawned = false;
  sim.boss2Spawned = false;
  window.__FF.setTime(150.2);
});
await page.waitForFunction(() => {
  const sim = window.__FF.getSim();
  return sim?.bossAlive?.boss === 'drumboss'
    && Math.hypot(sim.bossAlive.x - sim.player.x, sim.bossAlive.y - sim.player.y) < 430;
}, null, { timeout: 25000 });
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.enemies.forEach((e) => { if (e !== sim.bossAlive) e.active = false; });
  sim.bossAlive.x = sim.player.x + 165;
  sim.bossAlive.y = sim.player.y + 20;
});
await page.waitForTimeout(80);
await page.screenshot({ path: `${OUT}/40-boss-drumboss.png` });

// half-time boss close
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.enemies.forEach((e) => { e.active = false; });
  sim.bossAlive = null;
  sim.boss0Spawned = true;
  sim.boss1Spawned = false;
  window.__FF.setTime(300.2);
});
await page.waitForFunction(() => {
  const sim = window.__FF.getSim();
  if (sim?.bossAlive?.boss !== 'official') return false;
  return Math.hypot(sim.bossAlive.x - sim.player.x, sim.bossAlive.y - sim.player.y) < 430;
}, null, { timeout: 25000 });
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.enemies.forEach((e) => { if (e !== sim.bossAlive) e.active = false; });
  sim.bossAlive.x = sim.player.x + 165;
  sim.bossAlive.y = sim.player.y + 20;
});
await page.waitForTimeout(80);
await page.screenshot({ path: `${OUT}/41-boss-official.png` });

// final boss + flare telegraphs
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.enemies.forEach((e) => { e.active = false; });
  sim.bossAlive = null;
  sim.boss0Spawned = true;
  sim.boss1Spawned = true;
  sim.boss2Spawned = false;
  window.__FF.setTime(540.2);
});
await page.waitForFunction(() => {
  const sim = window.__FF.getSim();
  return sim?.bossAlive?.boss === 'captain' && sim.telegraphs.some((t) => t.active);
}, null, { timeout: 25000 });
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.enemies.forEach((e) => { if (e !== sim.bossAlive) e.active = false; });
  sim.bossAlive.x = sim.player.x + 165;
  sim.bossAlive.y = sim.player.y + 20;
});
await page.waitForTimeout(80);
await page.screenshot({ path: `${OUT}/42-boss-captain.png` });
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
await m.waitForTimeout(1600);
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
