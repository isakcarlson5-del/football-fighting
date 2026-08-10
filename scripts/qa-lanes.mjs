/**
 * GROUND/AERIAL vertical-slice proof: stages a fight with Pitch Pressure
 * rings (ground) and Precision Strike lobs (aerial) firing together, plus
 * far thrower targets with landing reticles. Saves evidence shots.
 * Usage: node scripts/qa-lanes.mjs   (dev server must be running)
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../evidence/shots', import.meta.url));
mkdirSync(OUT, { recursive: true });
const BASE = process.env.FF_BASE ?? 'http://localhost:5180';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE: ${m.text()}`);
});

await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.game-logo');
await page.click('[data-act="play"]');
await page.click('.char-card[data-player="messi"]');
await page.click('[data-act="start"]');
await page.waitForTimeout(1500);

// stage: strike L3 + pressure L2, ring of close mobs + far throwers
await page.evaluate(() => {
  const ff = window.__FF;
  const sim = ff.getSim();
  sim.player.maxHp = 99999;
  sim.player.hp = 99999;
  sim.player.abilities = { strike: 3, pressure: 2 };
  sim.enemies.forEach((e) => (e.active = false));
  // close mobs (inside the pressure ring)
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    ff.debugSpawn('hooligan', Math.cos(a) * 130, Math.sin(a) * 130);
  }
  // far ranged threats (lob targets) + a far elite
  ff.debugSpawn('thrower', 420, -120);
  ff.debugSpawn('thrower', -450, 80);
  ff.debugSpawn('thrower', 240, 350);
  ff.debugSpawn('steward', -300, -330, true);
  // hold fire until staged
  sim.player.strikeCd = 999;
  sim.player.pressureCd = 999;
});
await page.waitForTimeout(400);

// fire both lanes at once
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.player.strikeCd = 0;
  sim.player.pressureCd = 0;
});
await page.waitForTimeout(320); // ring mid-expansion, lobs mid-arc
await page.screenshot({ path: `${OUT}/32-lanes-both.png` });
await page.waitForTimeout(650); // lobs land: splashes + reticles closing
await page.screenshot({ path: `${OUT}/33-lanes-landing.png` });

// level-up card lane tags
await page.evaluate(() => window.__FF.giveXp(60));
await page.waitForSelector('#levelup-screen');
await page.waitForTimeout(350);
await page.screenshot({ path: `${OUT}/34-lane-cards.png` });

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'NO PAGE ERRORS');
await browser.close();
