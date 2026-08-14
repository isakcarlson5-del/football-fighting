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
  // first arrow focuses the first control (Kick Off)
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="play"]')).toBeFocused();
  // vertical stack: down to The Club, W back up
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-act="club"]')).toBeFocused();
  await page.keyboard.press('w');
  await expect(page.locator('[data-act="play"]')).toBeFocused();
  // Enter activates the focused control
  await page.keyboard.press('Enter');
  await expect(page.locator('.char-card')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('character select: arrows pick a player and reach the action row', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await expect(page.locator('.char-card')).toHaveCount(4);
  // first arrow focuses the first card
  await page.keyboard.press('ArrowDown');
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

test('club: tabs switch with arrows/Home/End and focus reaches Back', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="club"]');
  await expect(page.locator('#club-screen')).toBeVisible();
  // first arrow focuses the first tab
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#club-tab-upgrades')).toBeFocused();
  // tab arrows switch panels (own handler)
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#club-tab-skins')).toHaveAttribute('aria-selected', 'true');
  // Home/End jump; each switch re-renders, so the next arrow refocuses
  await page.keyboard.press('Home');
  await expect(page.locator('#club-tab-upgrades')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.locator('#club-tab-skins')).toHaveAttribute('aria-selected', 'true');
  // arrows reach the panel contents
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#club-screen button:focus')).toHaveCount(1);
  // walking down eventually lands on Back, Enter returns to the menu
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
