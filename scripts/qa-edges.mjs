/**
 * Arena edge + idle/run QA: starts a run, then photographs the player idle at
 * the pitch center and at all four arena edges (camera hard against the
 * painted-world bounds). Saves into evidence/shots/.
 * Usage: node scripts/qa-edges.mjs   (dev server must be running)
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser-runtime.mjs';

const OUT = fileURLToPath(new URL('../evidence/shots', import.meta.url));
mkdirSync(OUT, { recursive: true });
const BASE = process.env.FF_BASE ?? 'http://localhost:5180';

const browser = await launchChromium();
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
await page.waitForTimeout(1600); // strips + arena plate load

// keep the hero alive while framing shots
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.player.maxHp = 99999;
  sim.player.hp = 99999;
});

// idle at center (zero input, camera settled)
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/25-idle-center.png` });

const spots = [
  ['26-edge-top', 1300, 60],
  ['27-edge-bottom', 1300, 1356],
  ['28-edge-left', 60, 708],
  ['29-edge-right', 2540, 708],
];
for (const [name, x, y] of spots) {
  await page.evaluate(([px, py]) => {
    const sim = window.__FF.getSim();
    sim.player.x = px;
    sim.player.y = py;
  }, [x, y]);
  await page.waitForTimeout(1300); // camera lerp settle
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

// back to center: run right, then stop -> run strip while moving, idle after
await page.evaluate(() => {
  const sim = window.__FF.getSim();
  sim.player.x = 1300;
  sim.player.y = 708;
});
await page.waitForTimeout(1200);
await page.keyboard.down('d');
await page.waitForTimeout(650);
await page.screenshot({ path: `${OUT}/30-run-moving.png` });
await page.keyboard.up('d');
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/31-idle-after-run.png` });

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'NO PAGE ERRORS');
await browser.close();
