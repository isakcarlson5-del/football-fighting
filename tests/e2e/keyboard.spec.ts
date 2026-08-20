import { expect, test, type Page } from '@playwright/test';

/** Keyboard-only navigation: every menu is reachable and activatable
 * with WASD and arrow keys (roving focus, Enter/Space activates). */

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

test('main menu navigates with arrows/WASD and Enter starts the select screen', async ({ page }) => {
  const errors = await collectErrors(page);
  // the first control is focused when the screen opens, so the first arrow
  // navigates instead of being eaten by an initial focus step
  await expect(page.locator('[data-act="play"]')).toBeFocused();
  // vertical stack: down to The Club and Mute, W back up
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="club"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="mute"]')).toBeFocused();
  await page.keyboard.press('w');
  await expect(page.locator('[data-act="club"]')).toBeFocused();
  await page.keyboard.press('w');
  await expect(page.locator('[data-act="play"]')).toBeFocused();
  // Enter activates the focused control
  await page.keyboard.press('Enter');
  await expect(page.locator('.char-card')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('leaderboard: arrows reach Refresh/VIP and the name field releases', async ({ page }) => {
  const errors = await collectErrors(page);
  // down: Kick Off → The Club → Mute
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="mute"]')).toBeFocused();
  // right walks into the leaderboard panel: Refresh → VIP
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-act="leaderboard-refresh"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-act="vip-open"]')).toBeFocused();
  // a focused text field releases on up/down instead of trapping arrows
  await page.focus('.leaderboard-name input');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="mute"]')).toBeFocused();
  // back into the panel: Enter opens the admin overlay, Escape returns
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-act="vip-open"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#vip-screen')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#vip-screen')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('character select: arrows pick a player and reach the action row', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await expect(page.locator('.char-card')).toHaveCount(4);
  // the first card is focused when the screen opens
  await expect(page.locator('.char-card').first()).toBeFocused();
  // right/left move between cards
  await page.keyboard.press('d');
  await expect(page.locator('.char-card').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.char-card').first()).toBeFocused();
  // Enter picks the focused card; focus survives the re-render
  await page.keyboard.press('Enter');
  await expect(page.locator('.char-card').first()).toBeFocused();
  // down leaves the cards and reaches the Back/Start row
  await page.keyboard.press('ArrowDown');
  const act = await page.evaluate(() => document.activeElement?.getAttribute('data-act') ?? null);
  expect(['back', 'start']).toContain(act);
  // right reaches Start, Enter kicks off the match
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-act="start"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#hud')).toBeVisible();
  expect(errors).toEqual([]);
});

test('pause overlay: arrows navigate, Enter resumes, Escape also closes', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await page.locator('.char-card').first().click();
  await page.click('[data-act="start"]');
  await expect(page.locator('#hud')).toBeVisible();
  await page.click('#pause-btn');
  await expect(page.locator('#pause-screen')).toBeVisible();
  // the dialog focuses its first control, arrows move through the stack
  await expect(page.locator('[data-act="resume"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="restart"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-act="resume"]')).toBeFocused();
  // Enter activates Play On and closes the overlay
  await page.keyboard.press('Enter');
  await expect(page.locator('#pause-screen')).toHaveCount(0);
  await expect(page.locator('#hud')).toBeVisible();
  expect(errors).toEqual([]);
});

test('pause: P closes from a volume slider and WASD then moves', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await expect(page.locator('#hud')).toBeVisible();
  await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    sim.debugDirectorPaused = true;
    sim.player.hp = sim.player.maxHp = 9999;
  });
  await page.click('#pause-btn');
  await expect(page.locator('#pause-screen')).toBeVisible();
  await page.locator('#pause-screen input[data-vol="music"]').focus();
  await page.keyboard.press('p');
  await expect(page.locator('#pause-screen')).toHaveCount(0);
  const beforeY = await page.evaluate(() => window.__FF.getSim()!.player.y);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(180);
  const after = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return { y: sim.player.y, ay: window.__FF.getInputState().ay };
  });
  await page.keyboard.up('KeyW');
  expect(after.ay).toBeLessThan(0);
  expect(after.y).toBeLessThan(beforeY);
  expect(errors).toEqual([]);
});

test('club: Training Ground is the only tab and focus reaches Back', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="club"]');
  await expect(page.locator('#club-screen')).toBeVisible();
  await expect(page.locator('#club-tab-upgrades')).toBeFocused();
  await expect(page.locator('#club-tab-skins')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#club-screen button:focus')).toHaveCount(1);
  await expect.poll(async () => {
    await page.keyboard.press('ArrowDown');
    return page.evaluate(() => document.activeElement?.getAttribute('data-act') ?? null);
  }).toBe('back');
  await page.keyboard.press('Enter');
  await expect(page.locator('#club-screen')).toHaveCount(0);
  await expect(page.locator('.game-logo')).toBeVisible();
  expect(errors).toEqual([]);
});

test('VIP admin: typing and Enter still submit the token, Escape closes', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="vip-open"]');
  const screen = page.locator('#vip-screen');
  const token = screen.locator('input[type="password"]');
  // the dialog focuses its first control (the close button); the password
  // field is not hijacked and Enter submits the form natively
  await expect(screen.locator('[data-act="vip-close"]')).toBeFocused();
  await token.fill('test-vip-token-123456789');
  await page.keyboard.press('Enter');
  await expect(screen.locator('.vip-status')).toContainText('Authorized');
  await page.keyboard.press('Escape');
  await expect(screen).toHaveCount(0);
  expect(errors.filter((error) => !error.includes('status of 401'))).toEqual([]);
});

test('club: buying with the keyboard advances the ring so more can be bought', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.evaluate(() => window.__FF.addCoins(300));
  await page.click('[data-act="club"]');
  await expect(page.locator('#club-screen')).toBeVisible();
  // the active tab is focused when the screen opens; WASD mirrors the arrows
  // on tabs: S drops into the panel, W climbs back
  await expect(page.locator('#club-tab-upgrades')).toBeFocused();
  await page.keyboard.press('s');
  await expect(page.locator('#club-screen #club-panel button:focus')).toHaveCount(1);
  await page.keyboard.press('w');
  await expect(page.locator('#club-tab-upgrades')).toBeFocused();
  await expect.poll(async () => {
    await page.keyboard.press('ArrowDown');
    return page.evaluate(() => document.activeElement?.getAttribute('data-buy') ?? null);
  }).not.toBeNull();
  // first purchase: coins drop and the ring lands on an enabled buy control
  const before = await page.evaluate(() => window.__FF.getSave().data.coins);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__FF.getSave().data.coins)).toBeLessThan(before);
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-buy') ?? false)).toBe(true);
  // second Enter keeps the buying spree flowing
  const before2 = await page.evaluate(() => window.__FF.getSave().data.coins);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__FF.getSave().data.coins)).toBeLessThan(before2);
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-buy') ?? false)).toBe(true);
  expect(errors).toEqual([]);
});

test('menu: the mute toggle keeps the ring on the mute button', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="mute"]')).toBeFocused();
  // a fresh save ships muted, so the button reads Unmute; Enter flips it off
  // and the ring stays on the button for the next toggle
  await expect(page.locator('[data-act="mute"]')).toContainText('Unmute');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-act="mute"]')).toContainText('Mute');
  await expect(page.locator('[data-act="mute"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-act="mute"]')).toContainText('Unmute');
  await expect(page.locator('[data-act="mute"]')).toBeFocused();
  expect(errors).toEqual([]);
});

test('after ability draft WASD and arrows move the player, not leftover HUD focus', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.evaluate(() => {
    window.__FF.startRun('messi');
    const sim = window.__FF.getSim()!;
    sim.debugDirectorPaused = true;
    sim.player.hp = sim.player.maxHp = 9999;
  });
  const scenarios = ['enter', 'digit', 'click', 'wasd-nav'] as const;
  for (const scenario of scenarios) {
    await page.evaluate(() => window.__FF.showAbilityCards(['strike', 'pressure', 'curveball']));
    await expect(page.locator('#levelup-screen .upgrade-card').first()).toBeFocused();
    if (scenario === 'enter') {
      await page.keyboard.press('Enter');
    } else if (scenario === 'digit') {
      await page.keyboard.press('1');
    } else if (scenario === 'click') {
      await page.locator('#levelup-screen .upgrade-card').nth(1).click();
    } else {
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('d');
      await page.keyboard.press('Enter');
    }
    await expect(page.locator('#levelup-screen')).toHaveCount(0);
    await page.waitForTimeout(40);
    const before = await page.evaluate(() => {
      const sim = window.__FF.getSim()!;
      return {
        run: window.__FF.getState().run,
        focus: document.activeElement instanceof HTMLElement ? document.activeElement.id : '',
        x: sim.player.x,
        y: sim.player.y,
      };
    });
    expect(before.run).toBe('playing');
    expect(before.focus).not.toBe('pause-btn');
    expect(before.focus).not.toBe('dash-btn');
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(180);
    const up = await page.evaluate(() => {
      const sim = window.__FF.getSim()!;
      const input = window.__FF.getInputState();
      return { y: sim.player.y, ay: input.ay, focus: input.focus, keys: input.keys };
    });
    await page.keyboard.up('ArrowUp');
    expect(up.ay).toBeLessThan(0);
    expect(up.y).toBeLessThan(before.y);
    expect(up.focus).not.toBe('pause-btn');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(120);
    const w = await page.evaluate(() => window.__FF.getInputState());
    await page.keyboard.up('KeyW');
    expect(w.ay).toBeLessThan(0);
    expect(w.keys).toContain('w');
  }
  expect(errors).toEqual([]);
});

test('pause: setting toggles keep the ring on the same control', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await page.locator('.char-card').first().click();
  await page.click('[data-act="start"]');
  await expect(page.locator('#hud')).toBeVisible();
  await page.click('#pause-btn');
  await expect(page.locator('#pause-screen')).toBeVisible();
  // dialog autofocuses Play On; walk down to the Reduced VFX toggle
  await expect(page.locator('[data-act="resume"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="reduced-vfx"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-act="reduced-vfx"]')).toContainText('Reduced VFX: On');
  await expect(page.locator('[data-act="reduced-vfx"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-act="reduced-vfx"]')).toContainText('Reduced VFX: Off');
  expect(errors).toEqual([]);
});
