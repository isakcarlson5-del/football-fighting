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

test('all 32 directional player cycles load during real movement', async ({ page }) => {
  const errors = await collectErrors(page);
  const players = ['messi', 'ronaldo', 'neymar', 'yamal'];
  const directions = {
    n: [0, -1], ne: [Math.SQRT1_2, -Math.SQRT1_2], e: [1, 0], se: [Math.SQRT1_2, Math.SQRT1_2],
    s: [0, 1], sw: [-Math.SQRT1_2, Math.SQRT1_2], w: [-1, 0], nw: [-Math.SQRT1_2, -Math.SQRT1_2],
  } as const;

  for (const player of players) {
    for (const [direction, [dx, dy]] of Object.entries(directions)) {
      await page.goto(`/?debug=1&stage=player-directions&player=${player}&move=${direction}`);
      await expect.poll(() => page.evaluate(
        ({ playerId, directionId }) => performance
          .getEntriesByType('resource')
          .some((entry) => entry.name.endsWith(`/art/players/directional-v2/${playerId}/${directionId}.webp`)),
        { playerId: player, directionId: direction },
      )).toBe(true);
      const movement = await page.evaluate(() => {
        const state = window.__FF.getSim()!.player;
        return { moving: state.moving, dx: state.dashDx, dy: state.dashDy };
      });
      expect(movement.moving).toBe(true);
      expect(movement.dx).toBeCloseTo(dx, 5);
      expect(movement.dy).toBeCloseTo(dy, 5);
    }
  }
  expect(errors).toEqual([]);
});

test('all three calibrated high-resolution arena plates load and remain playable', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const arena of ['world-cup-classic', 'world-cup-showpiece', 'world-cup-modern-ai']) {
    await page.goto(`/?debug=1&stage=arena-preview&move=e&arena=${arena}`);
    await expect.poll(() => page.evaluate(
      (arenaId) => performance
        .getEntriesByType('resource')
        .some((entry) => entry.name.endsWith(`/art/arena/world-cup/${arenaId}.webp`)),
      arena,
    )).toBe(true);
    const state = await page.evaluate(() => ({
      app: window.__FF.getState(),
      moving: window.__FF.getSim()!.player.moving,
      x: window.__FF.getSim()!.player.x,
    }));
    expect(state.app).toEqual({ app: 'run', run: 'playing' });
    expect(state.moving).toBe(true);
    expect(state.x).toBeGreaterThan(1300);
  }
  expect(errors).toEqual([]);
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

test('all ability draft cards load their generated lane artwork', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  for (const ids of [
    ['strike', 'orbit', 'whistle'],
    ['dash', 'guard', 'pressure'],
    ['blast', 'strike', 'pressure'],
    ['curveball', 'bootseekers', 'strike'],
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

test('every training and fallback draft card loads its unique generated artwork', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  for (const ids of [
    ['power', 'speed', 'maxhp'],
    ['regen', 'magnet', 'armor'],
    ['heal', 'coins', 'maxhp'],
  ] as const) {
    await page.evaluate((cardIds) => window.__FF.showTrainingCards([...cardIds]), ids);
    const art = page.locator('.upgrade-card .ability-art');
    await expect(art).toHaveCount(3);
    await expect.poll(async () => art.evaluateAll((images) => images.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const sources = await art.evaluateAll((images) => images.map((img) => (img as HTMLImageElement).getAttribute('src')));
    expect(sources).toEqual(ids.map((id) => `art/cards/${id}.webp`));
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

test('miniboss spawns at seven minutes with nameplate', async ({ page }) => {
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    // Bosses are serialized; stage 7:00 as if the four-minute boss was
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

test('boss trophy loot pauses for two consecutive ability picks', async ({ page }) => {
  await page.goto('/?debug=1&stage=boss-loot');
  await expect(page.getByRole('heading', { name: 'Boss Loot' })).toBeVisible();
  await expect(page.getByText('Choose an ability · 2 picks remaining')).toBeVisible();
  await expect(page.locator('#levelup-screen .upgrade-card')).toHaveCount(3);
  await page.locator('#levelup-screen .upgrade-card').first().click();
  await expect(page.getByText('Choose an ability · 1 pick remaining')).toBeVisible();
  await expect(page.locator('#levelup-screen .upgrade-card')).toHaveCount(3);
  await page.locator('#levelup-screen .upgrade-card').first().click();
  await expect(page.locator('#levelup-screen')).toHaveCount(0);
  expect(await page.evaluate(() => window.__FF.getState().run)).toBe('playing');
});

test('security guards split grounded targets and ignore the aerial drone', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=guard-targeting');
  await page.waitForTimeout(450);
  const targeting = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    const droneIdx = sim.enemies.findIndex((enemy: { active: boolean; def: { id: string } }) => enemy.active && enemy.def.id === 'drone');
    return {
      droneIdx,
      targets: sim.guards.map((guard: { target: number }) => guard.target),
      targetIds: sim.guards.map((guard: { target: number }) => sim.enemies[guard.target]?.def.id ?? ''),
      droneHp: sim.enemies[droneIdx].hp,
      droneMaxHp: sim.enemies[droneIdx].maxHp,
    };
  });
  expect(targeting.targets).toHaveLength(2);
  expect(new Set(targeting.targets).size).toBe(2);
  expect(targeting.targets).not.toContain(targeting.droneIdx);
  expect(new Set(targeting.targetIds)).toEqual(new Set(['invader', 'steward']));
  expect(targeting.droneHp).toBe(targeting.droneMaxHp);
  expect(errors).toEqual([]);
});

test('performance: stable fps with a heavy late-game horde', async ({ page }) => {
  // Measure the richest plate, including its clipped live-stadium overlay.
  await page.goto('/?arena=world-cup-showpiece');
  await page.waitForSelector('.game-logo');
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const ff = window.__FF;
    ff.setTime(520);
    const sim = ff.getSim()!;
    sim.player.abilities = {
      strike: 5, curveball: 5, bootseekers: 5,
      orbit: 5, whistle: 5, dash: 5, guard: 5,
    };
    sim.player.maxHp = 5000;
    sim.player.hp = 5000;
    // This is a render-load fixture, not a pacing assertion. The production
    // director now introduces threats continuously one at a time, so stage a
    // real dense horde explicitly before measuring sustained FPS.
    const ids = ['invader', 'sprinter', 'lobber', 'flag', 'steward', 'drone'];
    for (let i = 0; i < 120; i++) {
      const angle = (i / 120) * Math.PI * 2;
      const radius = 300 + (i % 5) * 55;
      ff.debugSpawn(ids[i % ids.length], Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
  });
  await page.waitForTimeout(5000); // exercise max abilities against the staged horde
  const { fps, enemies } = await page.evaluate(() => ({
    fps: window.__FF.getFps(),
    enemies: window.__FF.getSim()!.enemies.filter((e: { active: boolean }) => e.active).length,
  }));
  expect(enemies).toBeGreaterThan(60);
  expect(fps).toBeGreaterThan(45);
});

test('sustained live play never crashes or returns to the menu', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?arena=world-cup-showpiece');
  await page.waitForSelector('.game-logo');
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const ff = window.__FF;
    const sim = ff.getSim()!;
    ff.setTime(360);
    sim.player.maxHp = 1_000_000;
    sim.player.hp = 1_000_000;
    sim.player.xpNext = 1_000_000_000;
    sim.player.abilities = {
      strike: 5, curveball: 5, bootseekers: 5,
      orbit: 5, whistle: 5, dash: 5, guard: 5,
      pressure: 5, blast: 5,
    };
    const ids = ['invader', 'sprinter', 'lobber', 'flare', 'flag', 'steward', 'drone', 'bull'];
    for (let i = 0; i < 96; i++) {
      const angle = (i / 96) * Math.PI * 2;
      const radius = 260 + (i % 6) * 58;
      ff.debugSpawn(ids[i % ids.length], Math.cos(angle) * radius, Math.sin(angle) * radius, i % 19 === 0);
    }
  });

  // Exercise real input, renderer, director, bosses, projectiles and VFX long
  // enough to catch the former unexplained run-to-menu/reset failure.
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(5000);
  await page.keyboard.up('KeyD');
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(5000);
  await page.keyboard.up('KeyS');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(5000);
  await page.keyboard.up('KeyA');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(5000);
  await page.keyboard.up('KeyW');

  // A scripted boss can legitimately die during this soak and pause for its
  // two reward picks. Resolve intended reward UI before judging whether the
  // run survived; the regression is a menu/reset/crash, not a level-up pause.
  for (let i = 0; i < 4; i++) {
    const runState = await page.evaluate(() => window.__FF.getState().run);
    if (runState !== 'levelup') break;
    await page.locator('.upgrade-card').first().click();
    await page.waitForTimeout(120);
  }

  const state = await page.evaluate(() => ({
    state: window.__FF.getState(),
    time: window.__FF.getSim()!.time,
    hp: window.__FF.getSim()!.player.hp,
    fps: window.__FF.getFps(),
  }));
  expect(state.state).toEqual({ app: 'run', run: 'playing' });
  // Browser scheduling can lose a few fixed steps when this runs last in the
  // full suite; fifteen simulated seconds still proves sustained live play.
  expect(state.time).toBeGreaterThan(375);
  expect(state.hp).toBeGreaterThan(0);
  expect(state.fps).toBeGreaterThan(35);
  await expect(page.locator('#game')).toBeVisible();
  expect(errors).toEqual([]);
});
