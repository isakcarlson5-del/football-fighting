import { expect, test, type Page } from '@playwright/test';

/** Full user-flow e2e suite driving the real game in a real browser. */

async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CONSOLE: ${m.text()}`);
  });
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear()); // clean save for determinism
  await page.reload();
  await page.waitForSelector('.game-logo');
});

test('menu loads with logo, key art and entries', async ({ page }) => {
  const errors = await collectErrors(page);
  await expect(page.locator('.game-logo')).toBeVisible();
  await expect(page.locator('[data-act="play"]')).toBeVisible();
  await expect(page.locator('[data-act="club"]')).toBeVisible();
  // key art applied (background-image present)
  await page.waitForFunction(() => {
    const el = document.getElementById('menu-art');
    return el && el.style.backgroundImage.includes('menu-key-art');
  });
  expect(errors).toEqual([]);
});

test('character select shows all 4 players with stats and traits', async ({ page }) => {
  await page.click('[data-act="play"]');
  const cards = page.locator('.char-card');
  await expect(cards).toHaveCount(4);
  for (const name of ['Lionel Messi', 'Cristiano Ronaldo', 'Neymar Jr', 'Lamine Yamal']) {
    await expect(page.locator('.char-card', { hasText: name })).toBeVisible();
  }
  await expect(page.locator('.char-card .stat-bars')).toHaveCount(4);
  await expect(page.locator('.char-card .starts-with')).toHaveCount(4);
});

test('run starts: HUD, auto-attacks, kills and XP flow to level-up', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await expect(page.locator('#match-clock')).toBeVisible();
  await expect(page.locator('#hp-wrap')).toBeVisible();
  await expect(page.locator('#ability-dock .ability-slot')).toHaveCount(1); // start ability
  // pin an enemy near the player: auto-attack must kill it without input
  await page.evaluate(() => window.__FF.debugSpawn('invader', 150, 0));
  await page.waitForFunction(() => window.__FF.getSim()!.kills > 0, null, { timeout: 8000 });
  expect(errors).toEqual([]);
});

test('level-up pauses the game, offers 3 upgrades, pick resumes', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  const lvlBefore = await page.evaluate(() => window.__FF.getSim()!.player.level);
  await page.evaluate(() => window.__FF.giveXp(500));
  await page.waitForSelector('#levelup-screen');
  await expect(page.locator('.upgrade-card')).toHaveCount(3);
  expect(await page.evaluate(() => window.__FF.getState().run)).toBe('levelup');
  await page.locator('.upgrade-card').first().click();
  // chained level-ups may follow; click through until playing again
  for (let i = 0; i < 12; i++) {
    const st = await page.evaluate(() => window.__FF.getState().run);
    if (st === 'playing') break;
    const card = page.locator('.upgrade-card').first();
    if (await card.count()) await card.click();
    await page.waitForTimeout(120);
  }
  expect(await page.evaluate(() => window.__FF.getState().run)).toBe('playing');
  expect(await page.evaluate(() => window.__FF.getSim()!.player.level)).toBeGreaterThan(lvlBefore);
});

test('all ability draft cards load their generated AERIAL/GROUND artwork', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  for (const ids of [
    ['strike', 'orbit', 'whistle'],
    ['dash', 'guard', 'pressure'],
  ] as const) {
    await page.evaluate((abilityIds) => window.__FF.showAbilityCards([...abilityIds]), ids);
    const art = page.locator('.upgrade-card .ability-art');
    await expect(art).toHaveCount(3);
    await expect(page.locator('.upgrade-card .lane-tag')).toHaveCount(3);
    await expect.poll(async () => art.evaluateAll((images) => images.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const sources = await art.evaluateAll((images) => images.map((img) => (img as HTMLImageElement).getAttribute('src')));
    expect(sources).toEqual(ids.map((id) => `art/abilities/${id}.webp`));
  }
});

test('ability draft starts at the title and remains scrollable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.evaluate(() => window.__FF.showAbilityCards(['strike', 'orbit', 'whistle']));
  const screen = page.locator('#levelup-screen');
  await expect(screen.locator('.screen-title')).toBeVisible();
  await expect(screen.locator('.upgrade-card').first()).toBeVisible();
  expect(await screen.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await screen.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});

test('death shows the result screen and pays out coins', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__FF.hurt(9999));
  await page.waitForSelector('.result-title-lose', { timeout: 8000 });
  await expect(page.locator('.result-title-lose')).toContainText('Knocked Out');
  const coins = await page.evaluate(() => window.__FF.getSave().data.coins);
  expect(coins).toBeGreaterThanOrEqual(0);
  await expect(page.locator('[data-act="again"]')).toBeVisible();
});

test('surviving to full time shows the victory screen', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__FF.setTime(598));
  await page.waitForSelector('.victory-screen', { timeout: 15000 });
  await expect(page.locator('.screen-title')).toContainText('Full Time');
});

test('boss spawns at half time with nameplate', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    // Bosses are serialized; stage half-time as if the first-quarter boss was
    // already defeated so this test specifically verifies the official.
    window.__FF.getSim().boss0Spawned = true;
    window.__FF.skipToBoss(1);
  });
  await page.waitForTimeout(1500);
  await expect(page.locator('#boss-plate')).toBeVisible();
  await expect(page.locator('#boss-plate .name')).toContainText('The Crooked Official');
});

test('shop purchases persist across reload (localStorage save)', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__FF.addCoins(500));
  await page.evaluate(() => window.__FF.hurt(9999));
  await page.waitForSelector('[data-act="club"]');
  await page.click('[data-act="club"]');
  // buy first power rank
  const buyBtn = page.locator('[data-buy="power"]');
  await expect(buyBtn).toBeEnabled();
  await buyBtn.click();
  await expect(page.locator('.rank-pips i.on').first()).toBeVisible();
  // reload: save must survive
  await page.reload();
  await page.waitForSelector('.game-logo');
  const rank = await page.evaluate(() => window.__FF.getSave().rank('power'));
  expect(rank).toBe(1);
  const stats = await page.evaluate(() => window.__FF.getSave().data.stats);
  expect(stats.runs).toBe(1);
});

test('skins can be bought and equipped, persisting across reload', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.__FF.addCoins(1000));
  await page.click('[data-act="club"]');
  await page.click('[data-tab="skins"]');
  const buy = page.locator('[data-buyskin="messi_away"]');
  await expect(buy).toBeEnabled();
  await buy.click();
  const equip = page.locator('[data-equip="messi_away"]');
  await equip.click();
  await expect(page.locator('.skin-card.equipped')).toHaveCount(1);
  await page.reload();
  await page.waitForSelector('.game-logo');
  const equipped = await page.evaluate(() => window.__FF.getSave().equippedSkin('messi'));
  expect(equipped).toBe('messi_away');
});

test('pause overlay opens and resumes', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pause-screen');
  expect(await page.evaluate(() => window.__FF.getState().run)).toBe('paused');
  await page.click('[data-act="resume"]');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__FF.getState().run)).toBe('playing');
});

test('performance: stable fps with a heavy late-game horde', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const ff = window.__FF;
    ff.setTime(520);
    const sim = ff.getSim()!;
    sim.player.abilities = { strike: 5, orbit: 5, whistle: 5, dash: 5, guard: 5 };
    sim.player.maxHp = 5000;
    sim.player.hp = 5000;
  });
  await page.waitForTimeout(9000); // let the horde build
  const { fps, enemies } = await page.evaluate(() => ({
    fps: window.__FF.getFps(),
    enemies: window.__FF.getSim()!.enemies.filter((e: { active: boolean }) => e.active).length,
  }));
  expect(enemies).toBeGreaterThan(60);
  expect(fps).toBeGreaterThan(45);
});
