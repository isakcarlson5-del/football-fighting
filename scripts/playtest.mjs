/**
 * Quick interactive playtest harness: loads the game, drives it with real
 * input, captures screenshots into the project's test-results/shots folder.
 * Usage: node scripts/playtest.mjs [scenario]
 */
/**
 * Quick interactive playtest harness: loads the game, drives it with real
 * input, captures screenshots into the project's evidence/shots folder
 * (kept outside test-results/ because the playwright runner wipes that).
 * Usage: node scripts/playtest.mjs [scenario]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../evidence/shots', import.meta.url));
mkdirSync(OUT, { recursive: true });

const scenario = process.argv[2] ?? 'basic';
const BASE = 'http://localhost:5199';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE: ${m.text()}`);
});

await page.goto(BASE);
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/01-menu.png` });

// char select
await page.click('[data-act="play"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-select.png` });

// pick a player by scenario
const pick = { basic: 'messi', guard: 'neymar', boss: 'ronaldo', long: 'yamal' }[scenario] ?? 'messi';
await page.click(`.char-card[data-player="${pick}"]`);
await page.waitForTimeout(200);
await page.click('[data-act="start"]');
await page.waitForTimeout(500);

// hold keys to run around
await page.keyboard.down('d');
await page.waitForTimeout(900);
await page.keyboard.up('d');
await page.keyboard.down('w');
await page.waitForTimeout(700);
await page.keyboard.up('w');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/03-gameplay-early.png` });

if (scenario === 'levelup' || scenario === 'basic' || scenario === 'long') {
  // force level-up flow
  await page.evaluate(() => window.__FF.giveXp(200));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/04-levelup.png` });
  await page.evaluate(() => window.__FF.pickUpgrade(0));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__FF.pickUpgrade(0));
  await page.waitForTimeout(400);
}

if (scenario === 'boss' || scenario === 'long') {
  await page.evaluate(() => window.__FF.skipToBoss(1));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/05-boss.png` });
}

if (scenario === 'long') {
  // survive a stretch with movement to eyeball mid-game density
  await page.evaluate(() => window.__FF.setTime(200));
  const dirs = ['a', 'd', 'w', 's'];
  for (let i = 0; i < 8; i++) {
    const k = dirs[i % 4];
    await page.keyboard.down(k);
    await page.waitForTimeout(650);
    await page.keyboard.up(k);
    // dismiss any level-up
    const st = await page.evaluate(() => window.__FF.getState());
    if (st.run === 'levelup') await page.evaluate(() => window.__FF.pickUpgrade(0));
  }
  await page.screenshot({ path: `${OUT}/06-midgame.png` });
  const perf = await page.evaluate(() => ({ fps: window.__FF.getFps(), enemies: window.__FF.getSim().enemies.filter((e) => e.active).length }));
  console.log('PERF', JSON.stringify(perf));
}

if (scenario === 'death') {
  await page.evaluate(() => window.__FF.hurt(9999));
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${OUT}/07-result.png` });
}

if (scenario === 'win') {
  await page.evaluate(() => window.__FF.setTime(599));
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${OUT}/07-victory.png` });
}

if (scenario === 'club') {
  await page.evaluate(() => window.__FF.hurt(9999));
  await page.waitForTimeout(2000);
  await page.click('[data-act="club"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/08-club.png` });
  await page.click('[data-tab="skins"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/09-skins.png` });
}

if (scenario === 'closeup') {
  // arrange a spaced lineup around the player and crop tight for art inspection
  await page.evaluate(() => {
    const ff = window.__FF;
    const types = ['invader', 'sprinter', 'lobber', 'steward', 'mascot'];
    types.forEach((t, i) => ff.debugSpawn(t, -340 + i * 170, -190));
    ff.debugSpawn('invader', -170, 200, true); // elite
    ff.debugSpawn('steward', 170, 200, false);
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/11-closeup.png` });
}

const state = await page.evaluate(() => window.__FF.getState());
console.log('STATE', JSON.stringify(state));
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'NO PAGE ERRORS');
await browser.close();
