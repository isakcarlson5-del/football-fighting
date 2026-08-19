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

test('main-menu leaderboard accepts a name and renders server-ranked runs safely', async ({ page }) => {
  const errors = await collectErrors(page);
  const panel = page.locator('.leaderboard-panel');
  const nameInput = panel.locator('.leaderboard-name input');
  await expect(panel).toBeVisible();
  await expect(nameInput).toHaveValue('Guest');
  await expect.poll(async () => panel.locator('.leaderboard-status').textContent()).not.toContain('Connecting');

  await nameInput.fill('Isak FC');
  await nameInput.press('Enter');
  expect(await page.evaluate(() => window.__FF.getSave().data.leaderboardName)).toBe('Isak FC');

  await page.evaluate(async () => {
    const visitorId = localStorage.getItem('ff_visitor_v1');
    const run = (id: string, name: string, kills: number, won: boolean) => fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId: id, name, playerId: 'messi', kills, time: won ? 600 : 420, level: won ? 32 : 22, won }),
    });
    await run(visitorId!, 'Isak FC', 180, false);
    await fetch('/api/visit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId: 'visitor-rival-safe', name: '<b>Rival</b>' }),
    });
    await run('visitor-rival-safe', '<b>Rival</b>', 330, true);
  });
  await panel.locator('[data-act="leaderboard-refresh"]').click();
  await expect(panel.locator('.leaderboard-row')).toHaveCount(2);
  await expect(panel.locator('.leaderboard-row').first()).toContainText('<b>Rival</b>');
  await expect(panel.locator('.leaderboard-row').first().locator('b b')).toHaveCount(0);
  await expect(panel.locator('.leaderboard-row').nth(1)).toContainText('Isak FC');
  expect(errors).toEqual([]);
});

test('VIP admin rejects an invalid token and reveals aggregate and per-visitor stats only after authorization', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.evaluate(async () => {
    const visitorId = localStorage.getItem('ff_visitor_v1')!;
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        visitorId,
        name: 'VIP Inspector',
        playerId: 'messi',
        kills: 42,
        time: 180,
        level: 9,
        won: false,
      }),
    });
  });

  await page.locator('[data-act="vip-open"]').click();
  const screen = page.locator('#vip-screen');
  const token = screen.locator('input[type="password"]');
  await token.fill('wrong-token-long-enough');
  await screen.locator('.vip-login button[type="submit"]').click();
  await expect(screen.locator('.vip-status')).toHaveText('Invalid VIP token.');
  await expect(screen.locator('.vip-content')).toBeEmpty();

  await token.fill('test-vip-token-123456789');
  await screen.locator('.vip-login button[type="submit"]').click();
  await expect(screen.locator('.vip-status')).toContainText('Authorized');
  await expect(screen.locator('.vip-metrics')).toContainText('Visitors');
  await expect(screen.locator('.vip-metrics')).toContainText('Games');
  const visitor = screen.locator('.vip-visitor-row', { hasText: 'VIP Inspector' });
  await expect(visitor).toHaveCount(1);
  await expect(visitor).toContainText('1 games');
  await expect(visitor).toContainText('42 KOs');
  expect(errors.filter((error) => !error.includes('status of 401'))).toEqual([]);
});

test('character select shows all 4 players with stats and traits', async ({ page }) => {
  await page.click('[data-act="play"]');
  const cards = page.locator('.char-card');
  const runners = page.locator('.char-card .runner-sprite');
  await expect(cards).toHaveCount(4);
  await expect(runners).toHaveCount(4);
  for (const name of ['Lionel Messi', 'Cristiano Ronaldo', 'Neymar Jr', 'Lamine Yamal']) {
    await expect(page.locator('.char-card', { hasText: name })).toBeVisible();
  }
  await expect(page.locator('.char-card .stat-bars')).toHaveCount(4);
  await expect(page.locator('.char-card .starts-with')).toHaveCount(4);
  const initialFrames = await runners.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundPositionX));
  const resolvedPreviewUrls = await runners.evaluateAll((elements) => elements
    .map((element) => getComputedStyle(element).backgroundImage));
  expect(resolvedPreviewUrls.every((url) => url.includes('/art/players/directional-v4/'))).toBe(true);
  expect(resolvedPreviewUrls.every((url) => !url.includes('/assets/art/'))).toBe(true);
  await expect.poll(async () => runners.evaluateAll((elements) => elements
    .map((element) => getComputedStyle(element).backgroundPositionX)
    .join('|'))).not.toBe(initialFrames.join('|'));
  const loadedStrips = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('/art/players/directional-v4/') && entry.name.endsWith('/e.webp'))
    .map((entry) => entry.name));
  expect(loadedStrips.length).toBeGreaterThanOrEqual(4);
});

test('cold character previews show the tunnel transition instead of blank portrait cards', async ({ page }) => {
  await page.goto('/?debug=1&previewDelay=1800', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.game-logo');
  await page.click('[data-act="play"]');
  await expect(page.locator('.select-tunnel')).toBeVisible();
  await expect(page.locator('.char-card')).toHaveCount(4, { timeout: 5_000 });
  await expect(page.locator('.select-tunnel')).toHaveCount(0);
});

test('all 32 directional player cycles load during real movement', async ({ page }) => {
  // This deliberately performs 32 complete navigations so every authored
  // direction is proven in a fresh runtime. On WebKit-less CI and cold local
  // caches the work legitimately exceeds Playwright's generic 60s test cap.
  test.setTimeout(120_000);
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
          .some((entry) => new URL(entry.name).pathname.endsWith(`/art/players/directional-v4/${playerId}/${directionId}.webp`)),
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

test('player locomotion ramps, plants by distance and brakes to a stable idle', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=player-directions&player=messi&arena=world-cup-hybrid-25d');
  const start = await page.evaluate(() => {
    const p = window.__FF.getSim()!.player;
    return { x: p.x, runDistance: p.runDistance, animT: p.animT };
  });

  await page.keyboard.down('KeyD');
  await expect.poll(() => page.evaluate(() => window.__FF.getSim()!.player.moveVx)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return sim.player.moveVx / sim.moveSpeed;
  })).toBeGreaterThan(0.98);
  const running = await page.evaluate(() => {
    const p = window.__FF.getSim()!.player;
    return {
      moving: p.moving,
      x: p.x,
      runDistance: p.runDistance,
      runStep: p.runStep,
      visualDir: p.visualDir,
      lean: p.accelLean,
    };
  });
  expect(running.moving).toBe(true);
  expect(running.x).toBeGreaterThan(start.x);
  expect(running.runDistance).toBeGreaterThan(start.runDistance);
  expect(running.visualDir).toBe(0);

  await page.keyboard.up('KeyD');
  await expect.poll(() => page.evaluate(() => window.__FF.getSim()!.player.moving)).toBe(false);
  const planted = await page.evaluate(() => {
    const p = window.__FF.getSim()!.player;
    return { runDistance: p.runDistance, animT: p.animT };
  });
  await page.waitForTimeout(150);
  const idle = await page.evaluate(() => {
    const p = window.__FF.getSim()!.player;
    return { moving: p.moving, speed: Math.hypot(p.moveVx, p.moveVy), runDistance: p.runDistance, animT: p.animT };
  });
  expect(idle.moving).toBe(false);
  expect(idle.speed).toBeLessThan(0.01);
  expect(idle.runDistance).toBeCloseTo(planted.runDistance, 5);
  expect(idle.animT).toBeCloseTo(planted.animT, 5);
  expect(errors).toEqual([]);
});

test('movement review keeps every enemy skin and advances grounded gait by real distance', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=movement-review&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getSim()!.enemies.filter((enemy: { active: boolean }) => enemy.active).length)).toBe(19);
  await page.waitForTimeout(1_500);
  const review = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    const enemies = sim.enemies
      .filter((enemy: { active: boolean }) => enemy.active)
      .map((enemy: { def: { id: string; behavior: string }; boss: string; runDistance: number; moving: boolean }) => ({
        id: enemy.boss || enemy.def.id,
        aerial: enemy.def.behavior === 'aerial',
        runDistance: enemy.runDistance,
        moving: enemy.moving,
      }));
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    return { enemies, resources, guards: sim.guards.map((guard: { runDistance: number }) => guard.runDistance) };
  });
  const ordinaryIds = ['invader', 'sprinter', 'lobber', 'flare', 'flag', 'foam', 'steward', 'drummer', 'vuvuzela', 'mascot', 'banner', 'paparazzo', 'chant', 'bull', 'drone', 'varcam'];
  expect(review.enemies.map((enemy: { id: string }) => enemy.id)).toEqual(expect.arrayContaining([...ordinaryIds, 'drumboss', 'official', 'captain']));
  for (const id of ordinaryIds) {
    expect(review.resources.some((resource: string) => resource.endsWith(`/art/enemies/${id}.png`))).toBe(true);
  }
  expect(review.enemies.filter((enemy: { aerial: boolean }) => !enemy.aerial).every((enemy: { runDistance: number }) => enemy.runDistance > 0)).toBe(true);
  expect(review.guards.length).toBe(4);
  expect(review.guards.every((distance: number) => distance > 0)).toBe(true);
  expect(errors).toEqual([]);
});

test('captain charge shows a stable 500ms lane before committed travel and braking', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=captain-charge&arena=world-cup-hybrid-25d');
  // The 500ms windup window re-opens every 6.8s, so a slow page load under
  // parallel load must be able to catch the next cycle.
  await expect.poll(() => page.evaluate(() => {
    const boss = window.__FF.getSim()!.enemies.find((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === 'captain');
    return boss?.chargeWindupT ?? 0;
  }), { timeout: 20_000 }).toBeGreaterThan(0);
  const anticipated = await page.evaluate(() => {
    const boss = window.__FF.getSim()!.enemies.find((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === 'captain')!;
    return { x: boss.x, windup: boss.chargeWindupT, laneLoaded: performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('/art/vfx/bull-charge-lane-strip.png')) };
  });
  expect(anticipated.windup).toBeGreaterThan(0);
  expect(anticipated.laneLoaded).toBe(true);
  await expect.poll(() => page.evaluate((startX) => {
    const boss = window.__FF.getSim()!.enemies.find((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === 'captain')!;
    return boss.chargeWindupT <= 0
      && boss.chargeLaneFadeT <= 0
      && boss.chargeBrakeT <= 0
      && boss.casting === ''
      && startX - boss.x > 250;
  }, anticipated.x), { timeout: 3_000 }).toBe(true);
  const completed = await page.evaluate(() => {
    const boss = window.__FF.getSim()!.enemies.find((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === 'captain')!;
    return { x: boss.x, windup: boss.chargeWindupT, laneFade: boss.chargeLaneFadeT, brake: boss.chargeBrakeT, casting: boss.casting };
  });
  expect(anticipated.x - completed.x).toBeGreaterThan(250);
  expect(completed.windup).toBe(0);
  expect(completed.brake).toBe(0);
  expect(completed.casting).toBe('');
  expect(errors).toEqual([]);
});

test('touch joystick remaps its radial deadzone without a movement-speed jump', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debug=1&stage=player-directions&player=messi&arena=world-cup-hybrid-25d');
  const origin = { x: 78, y: 610 };
  const pointerId = 41;
  await page.evaluate(({ x, y, id }) => {
    window.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      isPrimary: true,
      pointerId: id,
      pointerType: 'touch',
      clientX: x,
      clientY: y,
    }));
  }, { ...origin, id: pointerId });
  await expect(page.locator('#joystick')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/touch/);

  const moveTo = async (rawMagnitude: number) => {
    await page.evaluate(async ({ x, y, id, raw }) => {
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        isPrimary: true,
        pointerId: id,
        pointerType: 'touch',
        clientX: x + 52 * raw,
        clientY: y,
      }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, { ...origin, id: pointerId, raw: rawMagnitude });
    return page.evaluate(() => window.__FF.getInputState());
  };

  const below = await moveTo(0.17);
  expect(below.joyActive).toBe(true);
  expect(below.joyX).toBeCloseTo(0.17, 5);
  expect(below.ax).toBe(0);

  const justAbove = await moveTo(0.19);
  expect(justAbove.ax).toBeCloseTo((0.19 - 0.18) / 0.82, 4);
  expect(justAbove.ax).toBeLessThan(0.02);

  const middle = await moveTo(0.5);
  expect(middle.ax).toBeCloseTo((0.5 - 0.18) / 0.82, 4);
  const visualTravel = await page.evaluate(() => {
    const base = document.getElementById('joystick')!.getBoundingClientRect();
    const nub = document.querySelector<HTMLElement>('#joystick .nub')!.getBoundingClientRect();
    return (nub.left + nub.width / 2) - (base.left + base.width / 2);
  });
  expect(visualTravel).toBeCloseTo(26, 1);

  const full = await moveTo(1);
  expect(full.ax).toBeCloseTo(1, 5);
  await expect.poll(() => page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return sim.player.moveVx / sim.moveSpeed;
  })).toBeGreaterThan(0.98);

  await page.evaluate(({ x, y, id }) => {
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      isPrimary: true,
      pointerId: id,
      pointerType: 'touch',
      clientX: x + 52,
      clientY: y,
    }));
  }, { ...origin, id: pointerId });
  await expect(page.locator('#joystick')).toBeHidden();
  expect(await page.evaluate(() => window.__FF.getInputState().joyActive)).toBe(false);
  expect(errors).toEqual([]);
});

test('Nutmeg Dash requires a new keyboard press for each charge', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.evaluate(() => window.__FF.startRun('neymar'));
  await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy: { active: boolean }) => (enemy.active = false));
    sim.player.abilities.dash = 4;
    sim.player.dashCds = [0, 0];
  });
  const dashButton = page.locator('#dash-btn');
  await expect(dashButton).toBeVisible();
  await expect(dashButton.locator('.dash-charges i')).toHaveCount(2);
  await expect(dashButton.locator('.dash-charges i.ready')).toHaveCount(2);

  await page.keyboard.down('KeyD');
  await expect.poll(() => page.evaluate(() => window.__FF.getSim()!.player.moving)).toBe(true);
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => window.__FF.getSim()!.player.dashCds.every((cooldown: number) => cooldown <= 0))).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => {
    const p = window.__FF.getSim()!.player;
    return p.dashWindupT > 0 || p.dashT > 0 || p.dashRecoveryT > 0;
  })).toBe(true);
  expect(await page.evaluate(() => window.__FF.getSim()!.player.dashDx)).toBeCloseTo(1, 5);
  expect(await page.evaluate(() => window.__FF.getSim()!.player.dashCds.filter((cooldown: number) => cooldown <= 0).length)).toBe(1);

  // Repeating Space during the same committed action cannot burn charge two.
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.__FF.getSim()!.player.dashCds.filter((cooldown: number) => cooldown <= 0).length)).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const p = window.__FF.getSim()!.player;
    return p.dashWindupT <= 0 && p.dashT <= 0 && p.dashRecoveryT <= 0;
  })).toBe(true);
  await expect(dashButton.locator('.dash-charges i.ready')).toHaveCount(1);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__FF.getSim()!.player.dashCds.every((cooldown: number) => cooldown > 0))).toBe(true);
  await page.keyboard.up('KeyD');
  expect(errors).toEqual([]);
});

test('mobile analog stick rotates visibly and its separate dash button follows thumb direction', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__FF.startRun('neymar'));
  await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    sim.debugDirectorPaused = true;
    sim.enemies.forEach((enemy: { active: boolean }) => (enemy.active = false));
  });
  const origin = { x: 76, y: 620 };
  const pointerId = 71;
  await page.evaluate(({ x, y, id }) => {
    window.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, isPrimary: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, isPrimary: true, pointerId: id, pointerType: 'touch', clientX: x + 38, clientY: y - 38,
    }));
  }, { ...origin, id: pointerId });
  await expect(page.locator('#joystick')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__FF.getInputState().ax)).toBeGreaterThan(0.5);
  await expect.poll(() => page.evaluate(() => window.__FF.getInputState().ay)).toBeLessThan(-0.5);
  const joystickDirection = await page.locator('#joystick').evaluate((element) => ({
    angle: element.style.getPropertyValue('--joy-angle'),
    strength: Number(element.style.getPropertyValue('--joy-strength')),
  }));
  expect(joystickDirection.angle).toContain('rad');
  expect(joystickDirection.strength).toBeGreaterThan(0.9);

  const dashButton = page.locator('#dash-btn');
  await expect(dashButton).toBeVisible();
  const buttonBox = await dashButton.boundingBox();
  const joystickBox = await page.locator('#joystick').boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(joystickBox).not.toBeNull();
  expect(buttonBox!.x).toBeGreaterThan(joystickBox!.x + joystickBox!.width);
  await dashButton.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 72, isPrimary: true });
  await dashButton.click();
  await expect.poll(() => page.evaluate(() => {
    const p = window.__FF.getSim()!.player;
    return p.dashWindupT > 0 || p.dashT > 0 || p.dashRecoveryT > 0;
  })).toBe(true);
  const locked = await page.evaluate(() => {
    const p = window.__FF.getSim()!.player;
    return { x: p.dashDx, y: p.dashDy };
  });
  expect(locked.x).toBeGreaterThan(0.6);
  expect(locked.y).toBeLessThan(-0.6);

  await page.evaluate(({ x, y, id }) => {
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, isPrimary: true, pointerId: id, pointerType: 'touch', clientX: x + 38, clientY: y - 38,
    }));
  }, { ...origin, id: pointerId });
  expect(errors).toEqual([]);
});

test('all calibrated arena views load their intended plate and remain playable', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [arena, expectedPlate] of [
    ['world-cup-classic', 'world-cup-classic'],
    ['world-cup-showpiece', 'world-cup-showpiece'],
    ['world-cup-hybrid-25d', 'world-cup-showpiece'],
    ['world-cup-modern-ai', 'world-cup-modern-ai'],
  ] as const) {
    await page.goto(`/?debug=1&stage=arena-preview&move=e&arena=${arena}`);
    await expect.poll(() => page.evaluate(
      (plateId) => performance
        .getEntriesByType('resource')
        .some((entry) => entry.name.endsWith(`/art/arena/world-cup/${plateId}.webp`)),
      expectedPlate,
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

test('preserved Showpiece route never enables the optional hybrid construction', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [arena, expectedHybrid] of [
    ['world-cup-showpiece', false],
    ['world-cup-hybrid-25d', true],
  ] as const) {
    await page.goto(`/?debug=1&stage=arena-preview&arena=${arena}`);
    await expect.poll(() => page.evaluate(() => window.__FF.getArenaRenderMode())).toEqual({
      liveStadium: true,
      hybridDepth: expectedHybrid,
    });
  }
  expect(errors).toEqual([]);
});

test('hybrid camera adds restrained directional look-ahead while Showpiece stays neutral', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [arena, expectedLook] of [
    ['world-cup-showpiece', false],
    ['world-cup-hybrid-25d', true],
  ] as const) {
    await page.goto(`/?debug=1&stage=player-directions&player=messi&move=e&arena=${arena}`);
    await expect.poll(() => page.evaluate(() => window.__FF.getSim()!.player.moving)).toBe(true);
    await expect.poll(
      () => page.evaluate((needsLook) => {
        const lookX = window.__FF.getCameraState().lookX;
        return needsLook ? lookX > 22 && lookX <= 38.01 : Math.abs(lookX) < 0.001;
      }, expectedLook),
      { timeout: 4_000 },
    ).toBe(true);
    const camera = await page.evaluate(() => window.__FF.getCameraState());
    expect(Math.abs(camera.lookY)).toBeLessThan(0.01);
  }
  expect(errors).toEqual([]);
});

test('hybrid match keeps the wider readable frame and never clears on duplicate resize', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=arena-preview&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await expect.poll(() => page.evaluate(() => window.__FF.getCameraState().viewWorldH)).toBeCloseTo(1320, 1);

  const resizeProof = await page.evaluate(() => {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const x = Math.floor(canvas.width * 0.22);
    const y = Math.floor(canvas.height * 0.32);
    const before = [...ctx.getImageData(x, y, 1, 1).data];
    window.dispatchEvent(new Event('resize'));
    const after = [...ctx.getImageData(x, y, 1, 1).data];
    return { before, after };
  });
  expect(resizeProof.after).toEqual(resizeProof.before);
  expect(resizeProof.after[3]).toBe(255);
  expect(errors).toEqual([]);
});

test('hurt feedback stays clearly red without darkening the complete pitch', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=arena-preview&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await page.waitForTimeout(350);

  const sampleCanvas = () => page.evaluate(() => {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 18;
    const ctx = probe.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      red += data[i];
      green += data[i + 1];
      blue += data[i + 2];
    }
    const count = data.length / 4;
    return {
      red: red / count,
      green: green / count,
      blue: blue / count,
      luminance: (red * 0.2126 + green * 0.7152 + blue * 0.0722) / count,
    };
  });

  const before = await sampleCanvas();
  await page.evaluate(() => window.__FF.hurt(8));
  await page.waitForTimeout(35);
  const during = await sampleCanvas();
  expect(during.red).toBeGreaterThan(before.red + 1);
  expect(during.luminance).toBeGreaterThanOrEqual(before.luminance * 0.98);
  expect(errors).toEqual([]);
});

test('hybrid structural bowl parallax stays clamped while camera crosses the pitch', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=arena-preview&move=e&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await expect.poll(() => page.evaluate(() => window.__FF.getCameraState().x), { timeout: 5_000 }).toBeGreaterThan(1450);
  const state = await page.evaluate(() => ({
    camera: window.__FF.getCameraState(),
    renderMode: window.__FF.getArenaRenderMode(),
  }));
  expect(state.renderMode).toEqual({ liveStadium: true, hybridDepth: true });
  expect(state.camera.x).toBeGreaterThan(1450);
  expect(Math.abs(state.camera.lookX)).toBeLessThanOrEqual(38.01);
  expect(errors).toEqual([]);
});

test('a restarted hybrid run snaps the camera back to the real centre spawn', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-board-corner&side=left&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await expect.poll(() => page.evaluate(() => window.__FF.getCameraState().x)).toBeLessThan(800);
  await page.evaluate(() => window.__FF.startRun('messi'));
  const state = await page.evaluate(() => ({
    camera: window.__FF.getCameraState(),
    player: window.__FF.getSim()!.player,
  }));
  expect(state.camera.x).toBeCloseTo(state.player.x, 10);
  expect(state.camera.y).toBeCloseTo(state.player.y, 10);
  expect(state.camera.lookX).toBe(0);
  expect(state.camera.lookY).toBe(0);
  expect(errors).toEqual([]);
});

test('preserved Showpiece keeps its original camera continuity across restarts', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-board-corner&side=left&arena=world-cup-showpiece');
  await expect.poll(() => page.evaluate(() => window.__FF.getCameraState().x)).toBeLessThan(800);
  const continuity = await page.evaluate(() => {
    // Capture both values in the same browser task. Separate evaluate calls
    // allow an RAF with the old left-corner target to run between samples,
    // which can legitimately move the camera either side of the first value.
    const before = window.__FF.getCameraState().x;
    window.__FF.startRun('messi');
    return { before, after: window.__FF.getCameraState().x };
  });
  // The preserved route does not invoke the hybrid-only camera reset. Its
  // damped camera therefore stays exactly where it was until the next RAF.
  expect(continuity.after).toBeCloseTo(continuity.before, 8);
  expect(continuity.after).toBeLessThan(1_000);
  expect(errors).toEqual([]);
});

test('hybrid goal crowd fixture keeps its separate arena route and dense staged lineup', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-goal-crowd&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getSim()?.enemies.filter((enemy: { active: boolean }) => enemy.active).length ?? 0)).toBe(18);
  const staged = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    const active = sim.enemies.filter((enemy: { active: boolean }) => enemy.active);
    return {
      state: window.__FF.getState(),
      playerX: sim.player.x,
      centred: Math.abs(sim.player.y - 1416 / 2) < 1,
      nearGoal: active.filter((enemy: { x: number }) => enemy.x >= 2350).length,
      leftmost: Math.min(...active.map((enemy: { x: number }) => enemy.x)),
      damaged: active.filter((enemy: { hp: number; maxHp: number }) => enemy.hp < enemy.maxHp).length,
      stationary: active.filter((enemy: { speed: number; attackCd: number; rangedCd: number }) => (
        enemy.speed === 0 && enemy.attackCd > 900 && enemy.rangedCd > 900
      )).length,
    };
  });
  expect(staged.state).toEqual({ app: 'run', run: 'playing' });
  expect(staged.playerX).toBeGreaterThan(2400);
  expect(staged.centred).toBe(true);
  expect(staged.nearGoal).toBeGreaterThanOrEqual(15);
  expect(staged.leftmost).toBeGreaterThan(2280);
  expect(staged.damaged).toBeGreaterThanOrEqual(4);
  expect(staged.stationary).toBe(18);
  expect(errors).toEqual([]);
});

test('hybrid edge fixture pins the player against the physical near turf lip', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-edge-preview&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  const staged = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      x: sim.player.x,
      y: sim.player.y,
      enemies: sim.enemies.filter((enemy: { active: boolean }) => enemy.active).length,
    };
  });
  expect(staged.x).toBe(1300);
  expect(staged.y).toBe(1348);
  expect(staged.enemies).toBe(0);
  expect(errors).toEqual([]);
});

test('hybrid near-edge grounding fixture keeps physical pickups settled above the turf lip', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-near-grounding&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  const staged = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      player: { x: sim.player.x, y: sim.player.y },
      pickups: sim.pickups
        .filter((pickup: { active: boolean }) => pickup.active)
        .map((pickup: { kind: string; x: number; y: number; vx: number; vy: number }) => ({
          kind: pickup.kind,
          x: pickup.x,
          y: pickup.y,
          speed: Math.hypot(pickup.vx, pickup.vy),
        }))
        .sort((a: { x: number }, b: { x: number }) => a.x - b.x),
    };
  });
  expect(staged.player).toEqual({ x: 1300, y: 1416 - 280 });
  expect(staged.pickups.map((pickup: { kind: string }) => pickup.kind)).toEqual(['trophy', 'magnet', 'bomb']);
  expect(staged.pickups.every((pickup: { y: number; speed: number }) => (
    Math.abs(pickup.y - (1416 - 72)) < 0.1 && pickup.speed < 0.1
  ))).toBe(true);
  expect(errors).toEqual([]);
});

test('every pickup family shares the measured near-edge ground anchor', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-pickup-grounding&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  const pickups = await page.evaluate(() => window.__FF.getSim()!.pickups
    .filter((pickup: { active: boolean }) => pickup.active)
    .map((pickup: { kind: string; y: number; vx: number; vy: number }) => ({
      kind: pickup.kind,
      y: pickup.y,
      speed: Math.hypot(pickup.vx, pickup.vy),
    })));
  expect(pickups.map((pickup: { kind: string }) => pickup.kind)).toEqual([
    'xp', 'coin', 'heal', 'trophy', 'magnet', 'bomb', 'freeze',
  ]);
  expect(pickups.every((pickup: { y: number; speed: number }) => (
    Math.abs(pickup.y - (1416 - 72)) < 0.1 && pickup.speed < 0.1
  ))).toBe(true);
  expect(errors).toEqual([]);
});

test('hybrid mirrored fixtures expose the left goal and far pitch lip', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [stage, expectedX, expectedY] of [
    ['hybrid-left-goal', 118, 1416 / 2],
    ['hybrid-far-edge-preview', 2600 / 2, 68],
  ] as const) {
    await page.goto(`/?debug=1&stage=${stage}&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    const position = await page.evaluate(() => {
      const player = window.__FF.getSim()!.player;
      return { x: player.x, y: player.y };
    });
    expect(position.x).toBe(expectedX);
    expect(position.y).toBe(expectedY);
  }
  expect(errors).toEqual([]);
});

test('hybrid raised goal and board scenery remain outside physical traversal', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [stage, move, side, expected] of [
    ['hybrid-left-goal', 'w', null, { x: 112, y: 1416 / 2 }],
    ['hybrid-board-corner', 'e', 'right', { x: 2600 - 112, y: 118 }],
    ['hybrid-far-edge-preview', 'n', null, { x: 2600 / 2, y: 68 }],
    ['hybrid-edge-preview', 's', null, { x: 2600 / 2, y: 1416 - 68 }],
  ] as const) {
    const sideQuery = side ? `&side=${side}` : '';
    await page.goto(`/?debug=1&stage=${stage}&move=${move}${sideQuery}&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    await page.waitForTimeout(400);
    const player = await page.evaluate(() => {
      const state = window.__FF.getSim()!.player;
      return { x: state.x, y: state.y };
    });
    expect(player.x).toBeCloseTo(expected.x, 5);
    expect(player.y).toBeCloseTo(expected.y, 5);
  }
  expect(errors).toEqual([]);
});

test('all hybrid boss bodies keep radius-aware clearance from both goal cages', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [bossId, radius, visualPad] of [
    ['drumboss', 38, 128],
    ['official', 48, 136],
    ['captain', 58, 166],
  ] as const) {
    for (const side of ['left', 'right'] as const) {
      await page.goto(`/?debug=1&stage=hybrid-boss-edge&boss=${bossId}&side=${side}&arena=world-cup-hybrid-25d`);
      await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
      await page.waitForTimeout(100);
      const staged = await page.evaluate((id) => {
        const boss = window.__FF.getSim()!.enemies.find((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === id)!;
        return { x: boss.x, y: boss.y, radius: boss.radius };
      }, bossId);
      const expectedInset = 80 + visualPad;
      expect(staged.radius).toBe(radius);
      expect(staged.x).toBe(side === 'left' ? expectedInset : 2600 - expectedInset);
      expect(staged.y).toBe(1416 / 2);
    }
  }
  expect(errors).toEqual([]);
});

test('hybrid drone billboard and elevated shadow stay clear of both goal cages', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const side of ['left', 'right'] as const) {
    await page.goto(`/?debug=1&stage=hybrid-drone-edge&side=${side}&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    await page.waitForTimeout(100);
    const drone = await page.evaluate(() => {
      const enemy = window.__FF.getSim()!.enemies.find((entry: { active: boolean; def: { id: string } }) => entry.active && entry.def.id === 'drone')!;
      return { x: enemy.x, y: enemy.y };
    });
    expect(drone.x).toBe(side === 'left' ? 134 : 2600 - 134);
    expect(drone.y).toBe(1416 / 2);
  }
  expect(errors).toEqual([]);
});

test('hybrid touchline clearance keeps full silhouettes far and feet close near', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [entity, farY, nearY] of [
    ['drumboss', 180, 1346],
    ['captain', 218, 1326],
    ['drone', 106, 1364],
  ] as const) {
    for (const [edge, expectedY] of [['far', farY], ['near', nearY]] as const) {
      await page.goto(`/?debug=1&stage=hybrid-touchline-entity&entity=${entity}&edge=${edge}&arena=world-cup-hybrid-25d`);
      await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
      await page.waitForTimeout(100);
      const y = await page.evaluate(() => window.__FF.getSim()!.enemies.find((enemy: { active: boolean }) => enemy.active)!.y);
      expect(y).toBe(expectedY);
    }
  }
  expect(errors).toEqual([]);
});

test('hybrid giant boss body contact prevents player-silhouette overlap', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [bossId, bodyContact] of [['drumboss', 108], ['official', 112], ['captain', 148]] as const) {
    await page.goto(`/?debug=1&stage=hybrid-boss-edge&boss=${bossId}&side=left&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    await page.waitForTimeout(100);
    const separation = await page.evaluate((id) => {
      const sim = window.__FF.getSim()!;
      const boss = sim.enemies.find((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === id)!;
      return Math.hypot(sim.player.x - boss.x, sim.player.y - boss.y);
    }, bossId);
    expect(separation).toBeGreaterThanOrEqual(bodyContact - 0.01);
  }
  expect(errors).toEqual([]);
});

test('hybrid corner resolver never traps the player between captain and scenery', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-boss-edge&boss=captain&side=left&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    const captain = sim.enemies.find((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === 'captain')!;
    sim.player.x = 112;
    sim.player.y = captain.y;
  });
  await page.waitForTimeout(100);
  const state = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    const captain = sim.enemies.find((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === 'captain')!;
    return {
      player: { x: sim.player.x, y: sim.player.y },
      separation: Math.hypot(sim.player.x - captain.x, sim.player.y - captain.y),
    };
  });
  expect(state.player.x).toBeGreaterThanOrEqual(112);
  expect(state.player.y).toBeGreaterThanOrEqual(68);
  expect(state.separation).toBeGreaterThanOrEqual(147.99);
  expect(errors).toEqual([]);
});

test('hybrid boss HUD docks away from giant silhouettes while Showpiece stays centred', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [arena, side, expectedDock] of [
    ['world-cup-hybrid-25d', 'left', 'right'],
    ['world-cup-hybrid-25d', 'right', 'left'],
    ['world-cup-showpiece', 'left', 'centre'],
  ] as const) {
    await page.goto(`/?debug=1&stage=hybrid-boss-edge&boss=captain&side=${side}&arena=${arena}`);
    await expect(page.locator('#boss-plate')).toBeVisible();
    await page.waitForTimeout(300);
    const layout = await page.locator('#boss-plate').evaluate((plate) => {
      const rect = plate.getBoundingClientRect();
      return { centre: rect.left + rect.width / 2, viewport: innerWidth };
    });
    if (expectedDock === 'right') expect(layout.centre).toBeGreaterThan(layout.viewport * 0.65);
    else if (expectedDock === 'left') expect(layout.centre).toBeLessThan(layout.viewport * 0.35);
    else expect(layout.centre).toBeCloseTo(layout.viewport / 2, 1);
  }
  expect(errors).toEqual([]);
});

test('hybrid HUD remains centred when the shorter drummer does not overlap it', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-boss-edge&boss=drumboss&side=left&arena=world-cup-hybrid-25d');
  await expect(page.locator('#boss-plate')).toBeVisible();
  await page.waitForTimeout(300);
  const layout = await page.locator('#boss-plate').evaluate((plate) => {
    const rect = plate.getBoundingClientRect();
    return { centre: rect.left + rect.width / 2, viewport: innerWidth };
  });
  expect(layout.centre).toBeCloseTo(layout.viewport / 2, 1);
  expect(errors).toEqual([]);
});

test('hybrid portrait camera keeps the complete boss below a centred mobile HUD', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const side of ['left', 'right'] as const) {
    await page.goto(`/?debug=1&stage=hybrid-boss-edge&boss=captain&side=${side}&arena=world-cup-hybrid-25d`);
    await expect(page.locator('#boss-plate')).toBeVisible();
    await expect.poll(
      () => page.evaluate(() => {
        const rect = window.__FF.getBossScreenRect();
        return rect !== null && rect.left >= -5 && rect.right <= 395;
      }),
      { timeout: 1800 },
    ).toBe(true);
    const layout = await page.locator('#boss-plate').evaluate((plate) => {
      const rect = plate.getBoundingClientRect();
      const boss = window.__FF.getBossScreenRect()!;
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        centre: rect.left + rect.width / 2,
        viewport: innerWidth,
        boss,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport);
    expect(layout.centre).toBeCloseTo(layout.viewport / 2, 1);
    expect(layout.boss.left).toBeGreaterThanOrEqual(-5);
    expect(layout.boss.right).toBeLessThanOrEqual(395);
    expect(layout.boss.top).toBeGreaterThan(layout.bottom + 18);
    expect(layout.boss.bottom).toBeLessThanOrEqual(844 * 0.82);
  }
  expect(errors).toEqual([]);
});

test('hybrid live boards stay behind a dense far-touchline lineup', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-board-crowd&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await page.waitForTimeout(2_000);
  const staged = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    const active = sim.enemies.filter((enemy: { active: boolean }) => enemy.active);
    return {
      player: { x: sim.player.x, y: sim.player.y },
      enemies: active.length,
      nearFarTouchline: active.filter((enemy: { y: number }) => enemy.y < 280).length,
      fps: window.__FF.getFps(),
    };
  });
  expect(staged.player).toEqual({ x: 1300, y: 74 });
  expect(staged.enemies).toBe(20);
  expect(staged.nearFarTouchline).toBe(20);
  expect(staged.fps).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});

test('hybrid board returns expose mirrored far corners', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [side, expectedX] of [['left', 112], ['right', 2488]] as const) {
    await page.goto(`/?debug=1&stage=hybrid-board-corner&side=${side}&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    const position = await page.evaluate(() => {
      const player = window.__FF.getSim()!.player;
      return { x: player.x, y: player.y };
    });
    expect(position).toEqual({ x: expectedX, y: 118 });
  }
  expect(errors).toEqual([]);
});

test('all four hybrid corner-flag fixtures keep symmetric physical anchor positions', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [side, edge, expected] of [
    ['left', 'far', { x: 150, y: 150 }],
    ['right', 'far', { x: 2450, y: 150 }],
    ['left', 'near', { x: 150, y: 1266 }],
    ['right', 'near', { x: 2450, y: 1266 }],
  ] as const) {
    await page.goto(`/?debug=1&stage=hybrid-corner-flag&side=${side}&edge=${edge}&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    const player = await page.evaluate(() => {
      const stagedPlayer = window.__FF.getSim()!.player;
      return { x: stagedPlayer.x, y: stagedPlayer.y };
    });
    expect(player).toEqual(expected);
  }
  expect(errors).toEqual([]);
});

test('hybrid technical-zone fixture keeps the player clear of both dugouts and broadcast camera', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-technical-preview&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await expect.poll(() => page.evaluate(() => window.__FF.getFps()), { timeout: 5_000 }).toBeGreaterThan(35);
  const staged = await page.evaluate(() => {
    const player = window.__FF.getSim()!.player;
    return { x: player.x, y: player.y };
  });
  expect(staged.x).toBe(1300);
  expect(staged.y).toBe(360);
  expect(errors).toEqual([]);
});

test('hybrid goal and edge remain readable in a narrow mobile viewport', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const stage of ['hybrid-goal-crowd', 'hybrid-left-goal', 'hybrid-board-corner', 'hybrid-corner-flag', 'hybrid-near-grounding', 'hybrid-pickup-grounding', 'hybrid-edge-preview', 'hybrid-markings-preview', 'hybrid-centre-markings']) {
    await page.goto(`/?debug=1&stage=${stage}&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    // Cold WebP decoding and the intentionally damped camera follow are not
    // steady-state frame rate. Let both settle before judging mobile render
    // performance and the final on-screen composition.
    await page.waitForTimeout(stage === 'hybrid-goal-crowd' ? 2_400 : 1_200);
    await expect.poll(() => page.evaluate(() => window.__FF.getFps()), { timeout: 5_000 }).toBeGreaterThan(40);
    const layout = await page.evaluate(() => {
      const canvas = document.getElementById('game')!;
      const pause = document.getElementById('pause-btn')!;
      const canvasRect = canvas.getBoundingClientRect();
      const pauseRect = pause.getBoundingClientRect();
      return {
        canvasWidth: canvasRect.width,
        canvasHeight: canvasRect.height,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        pauseInside: pauseRect.right <= innerWidth && pauseRect.top >= 0,
      };
    });
    expect(layout.canvasWidth).toBe(390);
    expect(layout.canvasHeight).toBe(844);
    expect(layout.documentWidth).toBe(layout.viewportWidth);
    expect(layout.pauseInside).toBe(true);
    if (stage === 'hybrid-left-goal') {
      const player = await page.evaluate(() => {
        const stagedPlayer = window.__FF.getSim()!.player;
        return { x: stagedPlayer.x, y: stagedPlayer.y };
      });
      expect(player).toEqual({ x: 118, y: 1416 / 2 });
    }
  }
  expect(errors).toEqual([]);
});

test('hybrid live penalty markings expose symmetric review fixtures', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const [side, expectedX] of [['left', 520], ['right', 2080]] as const) {
    await page.goto(`/?debug=1&stage=hybrid-markings-preview&side=${side}&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    const staged = await page.evaluate(() => {
      const sim = window.__FF.getSim()!;
      return { x: sim.player.x, y: sim.player.y };
    });
    expect(staged.x).toBe(expectedX);
    expect(staged.y).toBe(1416 / 2);
  }
  expect(errors).toEqual([]);
});

test('hybrid centre marking exposes a stable grounded review fixture', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-centre-markings&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  const staged = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      player: { x: sim.player.x, y: sim.player.y },
      mode: window.__FF.getArenaRenderMode(),
    };
  });
  expect(staged.player).toEqual({ x: 1300, y: 1416 / 2 + 126 });
  expect(staged.mode).toEqual({ liveStadium: true, hybridDepth: true });
  expect(errors).toEqual([]);
});

test('player pose locator engages only when a living body is painted in front', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const arena of ['world-cup-showpiece', 'world-cup-hybrid-25d']) {
    await page.goto(`/?debug=1&stage=player-occlusion&arena=${arena}`);
    await expect.poll(() => page.evaluate(() => window.__FF.getPlayerOcclusionStrength())).toBeGreaterThan(0.45);
    expect(await page.evaluate(() => window.__FF.getSim()!.enemies.filter((enemy: { active: boolean }) => enemy.active).length)).toBe(1);

    await page.goto(`/?debug=1&stage=player-occlusion&occlusion=behind&arena=${arena}`);
    await expect.poll(() => page.evaluate(() => window.__FF.getPlayerOcclusionStrength())).toBeLessThan(0.01);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debug=1&stage=player-occlusion&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getPlayerOcclusionStrength())).toBeGreaterThan(0.45);
  await expect(page.locator('#game')).toBeVisible();
  expect(errors).toEqual([]);
});

test('combat presentation budget preserves telegraphs at 50, 80 and 120 enemies', async ({ page }) => {
  const errors = await collectErrors(page);
  const expectations = [
    { count: 50, bars: 10, impacts: 24, trails: 10, numbers: 22 },
    { count: 80, bars: 7, impacts: 14, trails: 7, numbers: 16 },
    { count: 120, bars: 5, impacts: 10, trails: 5, numbers: 11 },
  ];
  for (const expected of expectations) {
    await page.goto(`/?debug=1&stage=combat-readability&count=${expected.count}&arena=world-cup-hybrid-25d`);
    await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
    await page.waitForTimeout(2_000);
    const result = await page.evaluate(() => ({
      metrics: window.__FF.getCombatPresentationMetrics(),
      activeTelegraphs: window.__FF.getSim()!.telegraphs.filter((telegraph: { active: boolean }) => telegraph.active).length,
      fps: window.__FF.getFps(),
    }));
    expect(result.metrics.activeEnemies).toBe(expected.count);
    expect(result.metrics.visibleHealthBars).toBeLessThanOrEqual(expected.bars);
    expect(result.metrics.renderedImpacts).toBeLessThanOrEqual(expected.impacts);
    expect(result.metrics.renderedSeekerTrails).toBeLessThanOrEqual(expected.trails);
    expect(result.metrics.renderedDamageNumbers).toBeLessThanOrEqual(expected.numbers);
    expect(result.activeTelegraphs).toBe(2);
    expect(result.fps).toBeGreaterThan(40);
  }
  await page.goto('/?debug=1&stage=combat-readability&count=120&arena=world-cup-showpiece');
  await page.waitForTimeout(2_000);
  const originalMetrics = await page.evaluate(() => window.__FF.getCombatPresentationMetrics());
  expect(originalMetrics.activeEnemies).toBe(120);
  expect(originalMetrics.visibleHealthBars).toBeLessThanOrEqual(5);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debug=1&stage=combat-readability&count=120&arena=world-cup-hybrid-25d');
  await page.waitForTimeout(2_000);
  const mobileResult = await page.evaluate(() => ({
    metrics: window.__FF.getCombatPresentationMetrics(),
    fps: window.__FF.getFps(),
    canvasWidth: document.getElementById('game')!.getBoundingClientRect().width,
  }));
  expect(mobileResult.metrics.visibleHealthBars).toBeLessThanOrEqual(5);
  expect(mobileResult.metrics.renderedSeekerTrails).toBeLessThanOrEqual(5);
  expect(mobileResult.fps).toBeGreaterThan(35);
  expect(mobileResult.canvasWidth).toBe(390);
  expect(errors).toEqual([]);
});

test('hybrid penalty markings remain performant under dense combat overlap', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=hybrid-markings-combat&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await page.waitForTimeout(2_400);
  const staged = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      x: sim.player.x,
      y: sim.player.y,
      enemies: sim.enemies.filter((enemy: { active: boolean }) => enemy.active).length,
      fps: window.__FF.getFps(),
    };
  });
  expect(staged.x).toBe(1950);
  expect(staged.y).toBe(1416 / 2);
  expect(staged.enemies).toBe(24);
  expect(staged.fps).toBeGreaterThan(40);
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
    await expect(page.locator('.upgrade-card .role-tag')).toHaveCount(3);
    await expect.poll(async () => art.evaluateAll((images) => images.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const sources = await art.evaluateAll((images) => images.map((img) => (img as HTMLImageElement).getAttribute('src')));
    expect(sources).toEqual(ids.map((id) => `art/abilities/${id}.webp`));
  }
});

test('First Touch Blast uses distinct generated ground and aerial animation strips', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=blast-vfx&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      ground: sim.rings.some((ring: { active: boolean; color: string }) => ring.active && ring.color === '#a8ff4d'),
      air: sim.impacts.some((impact: { active: boolean; kind: string }) => impact.active && impact.kind === 'blastair'),
    };
  }), { timeout: 6_000 }).toEqual({ ground: true, air: true });
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes('/art/vfx/first-touch-')));
  expect(loaded.some((name) => name.endsWith('/first-touch-ground-strip.webp'))).toBe(true);
  expect(loaded.some((name) => name.endsWith('/first-touch-air-strip.webp'))).toBe(true);
  expect(errors).toEqual([]);
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

test('ability draft exposes exact comparisons and supports keyboard selection', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.evaluate(() => window.__FF.showAbilityCards(['strike', 'pressure', 'curveball']));

  const cards = page.locator('#levelup-screen .upgrade-card');
  await expect(cards).toHaveCount(3);
  expect(await cards.evaluateAll((nodes) => nodes.every((node) => node.tagName === 'BUTTON'))).toBe(true);
  await expect(page.locator('#levelup-screen .uc-compare')).toHaveCount(3);
  await expect(page.locator('#levelup-screen .uc-details')).toHaveCount(3);
  await expect(cards.first()).toContainText('Current');
  await expect(cards.first()).toContainText('After pick');
  await expect(cards.first()).toContainText('Cap');
  await expect(cards.first()).toContainText('AERIAL');

  await expect(cards.first()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#levelup-screen')).toHaveCount(0);
  expect(await page.evaluate(() => window.__FF.getState().run)).toBe('playing');
  expect(errors).toEqual([]);
});

test('draft supports WASD and arrows while two rerolls are shared across the run', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.evaluate(() => window.__FF.showAbilityCards(['strike', 'pressure', 'curveball']));

  const cards = page.locator('#levelup-screen .upgrade-card');
  const reroll = page.locator('#levelup-screen [data-act="reroll"]');
  await expect(cards.first()).toBeFocused();
  await expect(reroll).toHaveText('Reroll cards · 2 left');

  // Keyboard navigation must recover even if the browser or canvas caused
  // focus to leave the draft between frames.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('KeyD');
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press('KeyA');
  await expect(cards.first()).toBeFocused();

  await page.keyboard.press('KeyD');
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press('KeyA');
  await expect(cards.first()).toBeFocused();
  await page.keyboard.press('KeyS');
  await expect(reroll).toBeFocused();

  // Pointer use is a first-class path: the first click consumes exactly one.
  await reroll.click();
  await expect(reroll).toHaveText('Reroll cards · 1 left');
  expect(await page.evaluate(() => window.__FF.getSim()!.rerollsRemaining)).toBe(1);
  await expect(cards.first()).toBeFocused();

  // Arrow navigation reaches the same control; Enter spends the final reroll.
  await page.keyboard.press('ArrowDown');
  await expect(reroll).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(reroll).toHaveText('No rerolls left');
  await expect(reroll).toBeDisabled();
  expect(await page.evaluate(() => window.__FF.getSim()!.rerollsRemaining)).toBe(0);

  // Opening another draft in the same run must not refill the budget.
  await page.evaluate(() => window.__FF.showTrainingCards(['power', 'speed', 'maxhp']));
  const nextReroll = page.locator('#levelup-screen [data-act="reroll"]');
  await expect(nextReroll).toHaveText('No rerolls left');
  await expect(nextReroll).toBeDisabled();
  await page.keyboard.press('KeyD');
  await expect(page.locator('#levelup-screen .upgrade-card').nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#levelup-screen')).toHaveCount(0);
  expect(errors).toEqual([]);
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
  await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    sim.boss0Spawned = true;
    sim.boss1Spawned = true;
    sim.boss2Spawned = true;
    window.__FF.setTime(598);
  });
  await page.waitForSelector('.victory-screen', { timeout: 15000 });
  await expect(page.locator('.screen-title')).toContainText('Full Time');
});

test('full time holds in a readable sudden death until the living final boss falls', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debug=1&stage=full-time-boss&arena=world-cup-hybrid-25d');
  const clock = page.locator('#match-clock');
  await expect(clock).toHaveClass(/sudden-death/);
  await expect(clock.locator('.clock-value')).toHaveText("90'");
  await expect(clock.locator('.clock-phase')).toHaveText('Sudden Death');
  await expect(page.locator('#boss-plate')).toBeVisible();
  await expect(page.locator('.victory-screen')).toHaveCount(0);
  // The two-actor camera eases into the wider portrait frame instead of
  // snapping. Its settled frame must contain the complete boss quickly.
  await expect.poll(
    () => page.evaluate(() => window.__FF.getBossScreenRect()?.right ?? Number.POSITIVE_INFINITY),
    { timeout: 1500 },
  ).toBeLessThanOrEqual(395);

  const before = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    const rect = document.getElementById('match-clock')!.getBoundingClientRect();
    const bossRect = window.__FF.getBossScreenRect();
    return {
      time: sim.time,
      over: sim.over,
      suddenDeath: sim.suddenDeath,
      boss: sim.bossAlive?.boss,
      clock: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      bossRect,
    };
  });
  expect(before).toMatchObject({ time: 600, over: 'playing', suddenDeath: true, boss: 'captain' });
  expect(before.clock.left).toBeGreaterThanOrEqual(0);
  expect(before.clock.right).toBeLessThanOrEqual(390);
  expect(before.clock.top).toBeGreaterThanOrEqual(0);
  expect(before.clock.bottom).toBeLessThan(844 * 0.22);
  expect(before.bossRect).not.toBeNull();
  expect(before.bossRect!.left).toBeGreaterThanOrEqual(-5);
  expect(before.bossRect!.right).toBeLessThanOrEqual(395);
  expect(before.bossRect!.top).toBeGreaterThan(844 * 0.16);
  expect(before.bossRect!.bottom).toBeLessThan(844 * 0.84);

  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__FF.getSim()!.time)).toBe(600);
  await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    const bossIndex = sim.enemies.findIndex((enemy: { active: boolean; boss: string }) => enemy.active && enemy.boss === 'captain');
    sim.damageEnemy(bossIndex, sim.enemies[bossIndex].hp + 1);
  });
  await page.waitForSelector('#levelup-screen', { timeout: 5000 });
  expect(await page.evaluate(() => window.__FF.getSim()!.pendingBossAbilities)).toBe(2);
  await page.locator('.upgrade-card').first().click();
  await expect.poll(() => page.evaluate(() => window.__FF.getSim()!.pendingBossAbilities)).toBe(1);
  await page.waitForSelector('#levelup-screen .upgrade-card', { timeout: 5000 });
  await page.locator('.upgrade-card').first().click();
  await expect.poll(() => page.evaluate(() => window.__FF.getSim()!.pendingBossAbilities)).toBe(0);
  await page.waitForSelector('.victory-screen', { timeout: 5000 });
  await expect(page.locator('.screen-title')).toContainText('Full Time');
  expect(errors).toEqual([]);
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

test('all boss arrivals stay in the top HUD while hostile play is safely paused', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const boss of ['drumboss', 'official', 'captain']) {
    await page.goto(`/?debug=1&stage=boss-intro&boss=${boss}&phase=0.46&arena=world-cup-hybrid-25d`);
    await expect(page.locator('#boss-plate')).toBeVisible();
    await expect(page.locator('#boss-plate')).toHaveClass(/arriving/);
    await expect(page.locator('#boss-plate .title')).toContainText('ARRIVING');
    await expect(page.locator('#banner')).not.toHaveClass(/show/);
    const before = await page.evaluate(() => {
      const sim = window.__FF.getSim()!;
      return {
        intro: sim.bossIntroT,
        hp: sim.player.hp,
        bossHp: sim.bossAlive!.hp,
        bossX: sim.bossAlive!.x,
        bossY: sim.bossAlive!.y,
        time: sim.time,
      };
    });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const sim = window.__FF.getSim()!;
      const plate = document.getElementById('boss-plate')!.getBoundingClientRect();
      return {
        intro: sim.bossIntroT,
        hp: sim.player.hp,
        bossHp: sim.bossAlive!.hp,
        bossX: sim.bossAlive!.x,
        bossY: sim.bossAlive!.y,
        time: sim.time,
        plate: { top: plate.top, bottom: plate.bottom },
        viewport: innerHeight,
      };
    });
    expect(after.intro).toBeCloseTo(before.intro, 6);
    expect(after.hp).toBe(before.hp);
    expect(after.bossHp).toBe(before.bossHp);
    expect(after.bossX).toBeCloseTo(before.bossX, 6);
    expect(after.bossY).toBeCloseTo(before.bossY, 6);
    expect(after.time).toBeCloseTo(before.time, 6);
    expect(after.plate.bottom).toBeLessThan(after.viewport * 0.3);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debug=1&stage=boss-intro&boss=captain&phase=0.46&arena=world-cup-hybrid-25d');
  await page.waitForTimeout(500);
  const mobilePlate = await page.locator('#boss-plate').boundingBox();
  const mobileBoss = await page.evaluate(() => window.__FF.getBossScreenRect());
  expect(mobilePlate).not.toBeNull();
  expect(mobileBoss).not.toBeNull();
  expect(mobilePlate!.x).toBeGreaterThanOrEqual(0);
  expect(mobilePlate!.x + mobilePlate!.width).toBeLessThanOrEqual(390);
  expect(mobilePlate!.y + mobilePlate!.height).toBeLessThan(844 * 0.25);
  expect(mobileBoss!.left).toBeGreaterThanOrEqual(-5);
  expect(mobileBoss!.right).toBeLessThanOrEqual(395);
  expect(mobileBoss!.top).toBeGreaterThanOrEqual(844 * 0.18);
  expect(mobileBoss!.bottom).toBeLessThanOrEqual(844 * 0.82);
  expect(errors).toEqual([]);
});

test('melee anticipation, body contact and recovery remain distinct for mobs and bosses', async ({ page }) => {
  const errors = await collectErrors(page);
  for (const actor of ['invader', 'captain']) {
    for (const phase of ['anticipation', 'contact', 'recovery']) {
      await page.goto(`/?debug=1&stage=melee-contact&actor=${actor}&phase=${phase}&arena=world-cup-hybrid-25d`);
      await expect(page.locator('#hud')).toBeVisible();
      await expect(page.locator('#banner')).not.toHaveClass(/show/);
      const state = await page.evaluate(({ actorId, phaseId }) => {
        const sim = window.__FF.getSim()!;
        const attacker = sim.enemies.find((enemy: { active: boolean }) => enemy.active)!;
        const bossRect = actorId === 'captain' ? window.__FF.getBossScreenRect() : null;
        return {
          actorId,
          phaseId,
          over: sim.over,
          windup: attacker.windup,
          lungeT: attacker.lungeT,
          attackAnimT: attacker.attackAnimT,
          meleeHit: attacker.meleeHit,
          meleeDx: attacker.meleeDx,
          hurtT: sim.player.hurtT,
          bossRect,
          viewport: { width: innerWidth, height: innerHeight },
        };
      }, { actorId: actor, phaseId: phase });
      expect(state.over).toBe('playing');
      expect(state.meleeDx).toBeCloseTo(-1, 6);
      if (phase === 'anticipation') {
        expect(state.windup).toBeGreaterThan(0);
        expect(state.lungeT).toBe(0);
        expect(state.meleeHit).toBe(false);
      } else if (phase === 'contact') {
        expect(state.windup).toBe(0);
        expect(state.lungeT).toBeGreaterThan(0);
        expect(state.meleeHit).toBe(true);
        expect(state.hurtT).toBeGreaterThan(0);
      } else {
        expect(state.windup).toBe(0);
        expect(state.lungeT).toBe(0);
        expect(state.attackAnimT).toBeGreaterThan(0);
        expect(state.meleeHit).toBe(true);
      }
      if (state.bossRect) {
        expect(state.bossRect.left).toBeGreaterThanOrEqual(-20);
        expect(state.bossRect.right).toBeLessThanOrEqual(state.viewport.width + 20);
        expect(state.bossRect.top).toBeGreaterThanOrEqual(-20);
        expect(state.bossRect.bottom).toBeLessThanOrEqual(state.viewport.height + 20);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debug=1&stage=melee-contact&actor=captain&phase=contact&arena=world-cup-hybrid-25d');
  await expect.poll(
    () => page.evaluate(() => window.__FF.getBossScreenRect()?.right ?? Number.POSITIVE_INFINITY),
    { timeout: 1800 },
  ).toBeLessThanOrEqual(395);
  const portrait = await page.evaluate(() => {
    const boss = window.__FF.getBossScreenRect()!;
    const plate = document.getElementById('boss-plate')!.getBoundingClientRect();
    return {
      boss,
      plate: { left: plate.left, right: plate.right, top: plate.top, bottom: plate.bottom },
    };
  });
  expect(portrait.boss.left).toBeGreaterThanOrEqual(-5);
  expect(portrait.boss.top).toBeGreaterThan(844 * 0.15);
  expect(portrait.boss.bottom).toBeLessThan(844 * 0.78);
  expect(portrait.plate.left).toBeGreaterThanOrEqual(0);
  expect(portrait.plate.right).toBeLessThanOrEqual(390);
  expect(portrait.plate.bottom).toBeLessThan(844 * 0.24);
  expect(errors).toEqual([]);
});

test('kick anticipation, committed contact and recovery stay distinct around a locked body aim', async ({ page }) => {
  const errors = await collectErrors(page);
  let lockedAim: { x: number; y: number } | null = null;
  for (const phase of ['anticipation', 'contact', 'recovery']) {
    await page.goto(`/?debug=1&stage=kick-commitment&phase=${phase}&arena=world-cup-hybrid-25d`);
    await expect(page.locator('#hud')).toBeVisible();
    const state = await page.evaluate(() => {
      const sim = window.__FF.getSim()!;
      const marker = sim.reticles.find((entry: { active: boolean; phase: string }) => entry.active && entry.phase === 'aim');
      const target = sim.enemies[sim.player.kickTargetIdx];
      return {
        run: window.__FF.getState().run,
        kickT: sim.player.kickT,
        aim: { x: sim.player.aimDx, y: sim.player.aimDy },
        targetActive: target?.active ?? false,
        markerTarget: marker?.targetIdx,
        markerX: marker?.x,
        markerY: marker?.y,
        targetX: target?.x,
        targetY: target?.y,
        kickGroundContacts: sim.impacts.filter((impact: { active: boolean; kind: string }) => impact.active && impact.kind === 'kickground').length,
        kickDustLoaded: performance.getEntriesByType('resource')
          .some((entry) => entry.name.endsWith('/art/vfx/kick-dust-motes.png')),
      };
    });
    expect(state.run).toBe('paused');
    expect(state.targetActive).toBe(true);
    expect(state.markerTarget).toBeGreaterThanOrEqual(0);
    expect(state.markerX).toBeCloseTo(state.targetX!, 5);
    expect(state.markerY).toBeCloseTo(state.targetY!, 5);
    lockedAim ??= state.aim;
    expect(state.aim.x).toBeCloseTo(lockedAim.x, 6);
    expect(state.aim.y).toBeCloseTo(lockedAim.y, 6);
    if (phase === 'anticipation') {
      expect(state.kickT).toBeGreaterThan(0.25);
      expect(state.kickGroundContacts).toBe(0);
    }
    if (phase === 'contact') {
      expect(state.kickT).toBeGreaterThan(0.1);
      expect(state.kickT).toBeLessThan(0.25);
      expect(state.kickGroundContacts).toBe(1);
      expect(state.kickDustLoaded).toBe(true);
    }
    if (phase === 'recovery') {
      expect(state.kickT).toBeLessThan(0.1);
      expect(state.kickGroundContacts).toBe(0);
    }
  }
  expect(errors).toEqual([]);
});

test('Orbiting Press loads its generated curved orbital trail', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=orbit-reactions&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource')
    .some((entry) => new URL(entry.name).pathname.endsWith('/art/vfx/orbit-ball-curved-trail.png')))).toBe(true);
  const orbit = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      level: sim.abilityLevel('orbit'),
      angle: sim.player.orbitAngle,
      activeEnemies: sim.enemies.filter((enemy: { active: boolean }) => enemy.active).length,
    };
  });
  expect(orbit.level).toBe(5);
  expect(orbit.angle).toBeGreaterThan(0);
  expect(orbit.activeEnemies).toBe(6);
  expect(errors).toEqual([]);
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

test('HUD pause button opens the overlay and Play On resumes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(300);
  await page.click('#pause-btn');
  await page.waitForSelector('#pause-screen');
  await expect(page.locator('#pause-screen')).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#pause-screen')).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('[data-act="resume"]')).toBeFocused();
  expect(await page.evaluate(() => window.__FF.getState().run)).toBe('paused');
  await page.click('[data-act="resume"]');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__FF.getState().run)).toBe('playing');
});

test('mobile viewport stays zoomable and HUD exposes live progress semantics', async ({ page }) => {
  await page.goto('/?debug=1&stage=player-directions&arena=world-cup-hybrid-25d');
  await page.waitForSelector('#hud');
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).not.toContain('user-scalable=no');
  expect(viewport).not.toContain('maximum-scale');
  await expect(page.locator('#xp-bar')).toHaveAttribute('role', 'progressbar');
  await expect(page.locator('#xp-bar')).toHaveAttribute('aria-valuemax', '999999');
  await expect(page.locator('#hp-bar')).toHaveAttribute('aria-valuenow', '99999');
});

test('club sections expose a keyboard-operable tab interface', async ({ page }) => {
  await page.click('[data-act="club"]');
  const training = page.getByRole('tab', { name: 'Training Ground' });
  const kits = page.getByRole('tab', { name: 'Kit Room' });
  await expect(training).toHaveAttribute('aria-selected', 'true');
  await training.focus();
  await page.keyboard.press('ArrowRight');
  await expect(kits).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#club-panel')).toHaveAttribute('aria-labelledby', 'club-tab-skins');
});

test('reduced VFX and haptics settings apply live and persist after reload', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.click('[data-act="play"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pause-screen');

  const reducedVfx = page.locator('[data-act="reduced-vfx"]');
  const haptics = page.locator('[data-act="haptics"]');
  await expect(reducedVfx).toHaveText('Reduced VFX: Off');
  await expect(haptics).toHaveText('Haptics: On');
  expect(await page.evaluate(() => window.__FF.getReducedVfx())).toBe(false);

  await reducedVfx.click();
  await expect(reducedVfx).toHaveText('Reduced VFX: On');
  expect(await page.evaluate(() => window.__FF.getReducedVfx())).toBe(true);
  await haptics.click();
  await expect(haptics).toHaveText('Haptics: Off');
  expect(await page.evaluate(() => ({
    reducedVfx: window.__FF.getSave().data.reducedVfx,
    haptics: window.__FF.getSave().data.haptics,
  }))).toEqual({ reducedVfx: true, haptics: false });

  await page.reload();
  await page.waitForSelector('.game-logo');
  expect(await page.evaluate(() => ({
    reducedVfx: window.__FF.getSave().data.reducedVfx,
    haptics: window.__FF.getSave().data.haptics,
    rendererReducedVfx: window.__FF.getReducedVfx(),
  }))).toEqual({ reducedVfx: true, haptics: false, rendererReducedVfx: true });
  expect(errors).toEqual([]);
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

test('security guards screen toward a distant coherent crowd without leaving the player', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=guard-screening&arena=world-cup-hybrid-25d');
  await page.waitForTimeout(800);
  const screening = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      player: { x: sim.player.x, y: sim.player.y },
      guards: sim.guards.map((guard: { x: number; y: number; tx: number; target: number }) => ({
        x: guard.x,
        y: guard.y,
        tx: guard.tx,
        target: guard.target,
      })),
      enemies: sim.enemies.filter((enemy: { active: boolean }) => enemy.active).map((enemy: { x: number; y: number }) => ({
        x: enemy.x,
        y: enemy.y,
      })),
    };
  });
  expect(screening.guards).toHaveLength(4);
  expect(screening.guards.every((guard: { target: number }) => guard.target === -1)).toBe(true);
  expect(screening.guards.every((guard: { tx: number }) => guard.tx > screening.player.x + 45)).toBe(true);
  expect(screening.guards.every((guard: { x: number; y: number }) => (
    Math.hypot(guard.x - screening.player.x, guard.y - screening.player.y) < 185
  ))).toBe(true);
  expect(screening.enemies.every((enemy: { x: number }) => enemy.x > screening.player.x + 600)).toBe(true);
  expect(errors).toEqual([]);
});

test('Keeper\'s Halo loads the twelve-frame shield-backed runtime strip', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=aerial-defence&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource')
    .some((entry) => new URL(entry.name).pathname.endsWith('/art/abilities/keeper-halo-strip-v2.png')))).toBe(true);
  expect(await page.evaluate(() => window.__FF.getSim()!.player.abilities.keeperhalo)).toBe(5);
  expect(errors).toEqual([]);
});

test('art-direction scene presents the shared player, guard and threat scale stack', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=art-direction&arena=world-cup-hybrid-25d');
  await page.waitForTimeout(600);
  const lineup = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      state: window.__FF.getState(),
      guards: sim.guards.length,
      enemies: sim.enemies.filter((enemy: { active: boolean }) => enemy.active).map((enemy: { def: { id: string }; boss: string }) => ({
        id: enemy.def.id,
        boss: enemy.boss,
      })),
      arena: window.__FF.getArenaRenderMode(),
    };
  });
  expect(lineup.state).toEqual({ app: 'run', run: 'playing' });
  expect(lineup.guards).toBe(1);
  expect(lineup.enemies.map((enemy: { id: string }) => enemy.id)).toEqual(expect.arrayContaining(['invader', 'bull', 'drone']));
  expect(lineup.enemies.some((enemy: { boss: string }) => enemy.boss === 'captain')).toBe(true);
  expect(lineup.arena).toEqual({ liveStadium: true, hybridDepth: true });
  expect(errors).toEqual([]);
});

test('security guards patrol a close independent zone instead of mirroring player input', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/?debug=1&stage=guards&arena=world-cup-hybrid-25d');
  const before = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    sim.guards.forEach((guard: { decisionT: number }) => (guard.decisionT = 10));
    return {
      playerX: sim.player.x,
      escorts: sim.guards.map((guard: { escortX: number }) => guard.escortX),
      angles: sim.guards.map((guard: { patrolAngle: number }) => guard.patrolAngle),
      radii: sim.guards.map((guard: { patrolRadius: number }) => guard.patrolRadius),
    };
  });

  await page.keyboard.down('KeyD');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyD');
  const after = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      playerX: sim.player.x,
      escorts: sim.guards.map((guard: { escortX: number }) => guard.escortX),
      angles: sim.guards.map((guard: { patrolAngle: number }) => guard.patrolAngle),
      guards: sim.guards.map((guard: { x: number; y: number; vx: number; vy: number; face: number; moving: boolean }) => ({
        x: guard.x,
        y: guard.y,
        vx: guard.vx,
        vy: guard.vy,
        face: guard.face,
        moving: guard.moving,
      })),
    };
  });

  const playerTravel = after.playerX - before.playerX;
  expect(playerTravel).toBeGreaterThan(80);
  expect(Math.min(...before.radii)).toBeGreaterThanOrEqual(80);
  expect(Math.max(...before.radii)).toBeLessThanOrEqual(190);
  expect(after.angles).toEqual(before.angles);
  expect(after.escorts.every((escort: number, index: number) => {
    const travel = escort - before.escorts[index];
    return travel > 0 && travel < playerTravel * 0.55;
  })).toBe(true);
  expect(after.guards.some((guard: { moving: boolean }) => guard.moving)).toBe(true);
  const runningGuards = after.guards.filter((guard: { vx: number; vy: number }) => Math.hypot(guard.vx, guard.vy) > 20);
  expect(runningGuards.length).toBeGreaterThan(0);
  expect(runningGuards.every((guard: { vx: number; face: number }) => Math.sign(guard.vx) === guard.face)).toBe(true);
  expect(runningGuards.every((guard: { vx: number; vy: number }) => Number.isFinite(guard.vx) && Number.isFinite(guard.vy))).toBe(true);
  expect(errors).toEqual([]);
});

test('performance: stable fps with a heavy late-game horde on both Showpiece render paths', async ({ page }) => {
  for (const arena of ['world-cup-showpiece', 'world-cup-hybrid-25d']) {
    // Measure both the preserved original and its optional 2.5D construction.
    await page.goto(`/?arena=${arena}`);
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
      sim.player.xp = 0;
      sim.player.xpNext = 1_000_000_000;
      sim.pendingLevelups = 0;
      // This is a render-load fixture, not a pacing assertion. The production
      // director now introduces threats continuously one at a time, so stage a
      // real dense horde explicitly before measuring sustained FPS.
      const ids = ['invader', 'sprinter', 'lobber', 'flag', 'steward', 'drone'];
      for (let i = 0; i < 120; i++) {
        const angle = (i / 120) * Math.PI * 2;
        const radius = 300 + (i % 5) * 55;
        ff.debugSpawn(ids[i % ids.length], Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      // The fixture measures sustained draw cost, not kill speed. Immortal,
      // harmless targets keep all 120 authored sprites, health bars and maxed
      // ability VFX alive for the complete sample window and prevent a real
      // XP draft from pausing requestAnimationFrame halfway through the test.
      for (const enemy of sim.enemies) {
        if (!enemy.active) continue;
        enemy.maxHp = 1_000_000;
        enemy.hp = enemy.maxHp;
        enemy.barHp = enemy.maxHp;
        enemy.damage = 0;
      }
    });
    await page.waitForTimeout(5000); // exercise max abilities against the staged horde
    const { fps, enemies } = await page.evaluate(() => ({
      fps: window.__FF.getFps(),
      enemies: window.__FF.getSim()!.enemies.filter((e: { active: boolean }) => e.active).length,
    }));
    expect(enemies, arena).toBeGreaterThan(60);
    expect(fps, arena).toBeGreaterThan(45);
  }
});

test('hybrid dense rendering balances every canvas save and restore', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.addInitScript(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const originalSave = proto.save;
    const originalRestore = proto.restore;
    const state = { depth: 0, minimum: 0, saves: 0, restores: 0 };
    (window as unknown as { __CANVAS_STATE: typeof state }).__CANVAS_STATE = state;
    proto.save = function patchedSave(): void {
      state.depth += 1;
      state.saves += 1;
      originalSave.call(this);
    };
    proto.restore = function patchedRestore(): void {
      state.depth -= 1;
      state.restores += 1;
      state.minimum = Math.min(state.minimum, state.depth);
      originalRestore.call(this);
    };
  });
  await page.goto('/?debug=1&stage=hybrid-markings-combat&arena=world-cup-hybrid-25d');
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });
  await page.waitForTimeout(2_400);
  const state = await page.evaluate(() => (
    window as unknown as { __CANVAS_STATE: { depth: number; minimum: number; saves: number; restores: number } }
  ).__CANVAS_STATE);
  expect(state.saves).toBeGreaterThan(2_000);
  expect(state.restores).toBe(state.saves);
  expect(state.depth).toBe(0);
  expect(state.minimum).toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
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
  const soakStartedAt = Date.now();
  const soakTarget = 375.25;
  const movementKeys = ['KeyD', 'KeyS', 'KeyA', 'KeyW'];
  let movementIndex = 0;
  let activeKey = movementKeys[movementIndex];
  await page.keyboard.down(activeKey);
  while (await page.evaluate(() => window.__FF.getSim()!.time) < soakTarget) {
    if (Date.now() - soakStartedAt > 35_000) {
      throw new Error('Live-play soak failed to advance 15 simulated seconds within 35 real seconds');
    }
    await page.waitForTimeout(250);
    // Boss reward drafts are valid gameplay, not a crash. Resolve them while
    // polling simulation time so late-suite scheduler pressure cannot turn a
    // fixed wall-clock sleep into a false failed soak.
    for (let pick = 0; pick < 2; pick++) {
      const runState = await page.evaluate(() => window.__FF.getState().run);
      if (runState !== 'levelup') break;
      const firstCard = page.locator('.upgrade-card').first();
      if (await firstCard.count() === 0) break;
      await firstCard.click();
      await page.waitForTimeout(40);
    }
    const nextMovementIndex = Math.min(3, Math.floor((Date.now() - soakStartedAt) / 5_000));
    if (nextMovementIndex !== movementIndex) {
      await page.keyboard.up(activeKey);
      movementIndex = nextMovementIndex;
      activeKey = movementKeys[movementIndex];
      await page.keyboard.down(activeKey);
    }
  }
  await page.keyboard.up(activeKey);

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
