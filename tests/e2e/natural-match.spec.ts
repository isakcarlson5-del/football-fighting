import { expect, test, type Page } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

const LONG_SOAK_ENABLED = process.env.FF_LONG_SOAK === '1';

async function chooseBestVisibleUpgrade(page: Page): Promise<boolean> {
  const cards = page.locator('#levelup-screen .upgrade-card');
  const count = await cards.count();
  if (count === 0) return false;
  const player = await page.evaluate(() => {
    const sim = window.__FF.getSim();
    return sim ? {
      hp: sim.player.hp,
      maxHp: sim.player.maxHp,
      time: sim.time,
      firstBossCleared: sim.boss0Spawned && !sim.bossAlive,
      abilities: sim.player.abilities,
      stats: sim.player.stats,
    } : {
      hp: 1,
      maxHp: 1,
      time: 0,
      firstBossCleared: false,
      abilities: {},
      stats: { power: 0, speed: 0, maxhp: 0, regen: 0, magnet: 0, armor: 0 },
    };
  });
  const rankLabels = (labels: string[]): { bestIndex: number; bestScore: number } => {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    const hpRatio = player.hp / Math.max(1, player.maxHp);
    // A competent run establishes damage first, then buys durability before
    // the 4:00 boss instead of waiting until the build is already collapsing.
    const survivalPhase = player.firstBossCleared || player.time >= 180 || hpRatio < 0.72;
    const abilityScore = (id: keyof typeof player.abilities, early: number, late: number, targetLevel = 5): number => {
      const level = player.abilities[id] ?? 0;
      return level >= targetLevel ? 0 : (survivalPhase ? late : early) + level * 100;
    };
    const statScore = (id: keyof typeof player.stats, early: number, late: number, cap: number): number =>
      player.stats[id] >= cap ? 0 : survivalPhase ? late : early;
    const priorities: Array<[string, number]> = [
      ['Orange Slices', hpRatio < 0.72 ? 2_100 : 120],
      // A competent player secures one active escape before the late horde.
      // The previous benchmark reached 9:42 without Dash and therefore never
      // exercised the real survival action despite pressing its input button.
      ['Nutmeg Dash', abilityScore('dash', 1_720, 2_050, 1)],
      ['Orbiting Press', abilityScore('orbit', 1_550, 1_300)],
      ["Captain's Whistle", abilityScore('whistle', 1_520, 1_290)],
      ['First Touch Blast', abilityScore('blast', 1_490, 1_280)],
      ['Golden Boot Seekers', abilityScore('bootseekers', 1_470, 1_260)],
      ['Curveball Swarm', abilityScore('curveball', 1_450, 1_240)],
      ['Precision Strike', abilityScore('strike', 1_430, 1_220)],
      ['Pitch Pressure', abilityScore('pressure', 1_400, 1_200)],
      ['Security Detail', abilityScore('guard', 1_250, 1_180, 3)],
      ['Shin Pads', statScore('armor', 1_240, 1_900, 5)],
      ['Captain’s Heart', statScore('maxhp', 1_210, 1_850, 8)],
      ['Energy Gel', statScore('regen', 1_180, 1_800, 5)],
      ['Fresh Boots', statScore('speed', 1_500, 1_750, 5)],
      ['Shot Power', statScore('power', 1_380, 1_700, 8)],
      ['Ball Magnet', 400],
      ['Signing Bonus', -100],
    ];
    labels.forEach((label, index) => {
      let score = priorities.find(([name]) => label.includes(name))?.[1] ?? 0;
      if (label.includes('MAX EVOLUTION')) score += 180;
      if (label.includes('Ability · Lv4')) score += 120;
      if (label.includes('Ability · Lv3')) score += 70;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return { bestIndex, bestScore };
  };
  let labels = await cards.evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
  let ranked = rankLabels(labels);
  if (ranked.bestScore < 1_000) {
    const reroll = page.locator('#levelup-screen [data-act="reroll"]');
    if (await reroll.isVisible()) {
      await reroll.click();
      await page.waitForTimeout(30);
      labels = await cards.evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
      ranked = rankLabels(labels);
    }
  }
  await cards.nth(ranked.bestIndex).click();
  return true;
}

function movementKeys(dx: number, dy: number): string[] {
  const keys: string[] = [];
  if (dx < -0.22) keys.push('KeyA');
  if (dx > 0.22) keys.push('KeyD');
  if (dy < -0.22) keys.push('KeyW');
  if (dy > 0.22) keys.push('KeyS');
  return keys;
}

test('natural late-game match sustains real pacing, input and drafts through a valid result', async ({ page }) => {
  test.skip(!LONG_SOAK_ENABLED, 'Run explicitly with FF_LONG_SOAK=1.');
  test.setTimeout(930_000);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`PAGEERROR: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`CONSOLE: ${message.text()}`);
  });

  // A fully progressed local profile is a real supported player state, not a
  // debug time skip. The match itself still starts at 0', runs every fixed
  // step, spawns naturally and uses the production UI for every draft.
  await page.goto('/?arena=world-cup-hybrid-25d&matchSeed=12648430');
  await page.evaluate(() => localStorage.setItem('ff_save_v1', JSON.stringify({
    coins: 0,
    ranks: { power: 5, move: 5, magnet: 5, guard: 5 },
    ownedSkins: [],
    equipped: {},
    stats: { runs: 0, wins: 0, totalKills: 0, bestTime: 0, bestLevel: 0 },
    muted: true,
    reducedVfx: false,
    haptics: false,
    volume: { master: 0.9, sfx: 1, music: 0.7 },
  })));
  await page.reload();
  await page.getByRole('button', { name: 'Kick Off' }).click();
  await page.locator('.char-card[data-player="messi"]').click();
  await page.getByRole('button', { name: 'To Kick Off' }).click();
  await expect.poll(() => page.evaluate(() => window.__FF.getState())).toEqual({ app: 'run', run: 'playing' });

  let held: string[] = [];
  let nextMovementAt = 0;
  let nextDashAt = 0;
  let nextCheckpointAt = 60;
  const startedAt = Date.now();

  while (true) {
    const state = await page.evaluate(() => {
      const sim = window.__FF.getSim();
      if (!sim) return null;
      const p = sim.player;
      const directions = Array.from({ length: 16 }, (_, i) => {
        const angle = (i / 16) * Math.PI * 2;
        return { x: Math.cos(angle), y: Math.sin(angle), score: 0, danger: 0 };
      });
      let nearestThreat = Number.POSITIVE_INFINITY;
      let nearbyThreats = 0;
      for (const direction of directions) {
        const futureX = p.x + direction.x * 310;
        const futureY = p.y + direction.y * 310;
        const edgeX = Math.min(futureX, 2600 - futureX);
        const edgeY = Math.min(futureY, 1416 - futureY);
        if (edgeX < 360) direction.score += (360 - edgeX) * 0.12;
        if (edgeY < 250) direction.score += (250 - edgeY) * 0.12;
        direction.score += Math.hypot(futureX - 1300, futureY - 708) / 1_800;
        const continuity = direction.x * p.moveDx + direction.y * p.moveDy;
        direction.score += (1 - continuity) * 0.16;
      }
      for (const enemy of sim.enemies) {
        if (!enemy.active) continue;
        const currentDistance = Math.hypot(p.x - enemy.x, p.y - enemy.y);
        nearestThreat = Math.min(nearestThreat, currentDistance);
        if (currentDistance < 430) nearbyThreats += 1;
        const behaviorWeight = enemy.def.behavior === 'charger' ? 2.8
          : enemy.def.behavior === 'thumper' ? 2.2
            : enemy.def.behavior === 'leaper' ? 1.8
              : enemy.def.behavior === 'aerial' ? 1.35
                : 1;
        const bodyWeight = enemy.boss ? 10 : enemy.elite ? 2.8 : 1;
        const dangerRadius = enemy.boss ? 700 : enemy.elite ? 530 : enemy.def.behavior === 'charger' ? 580 : 440;
        for (const direction of directions) {
          const futureX = p.x + direction.x * 310;
          const futureY = p.y + direction.y * 310;
          const futureDistance = Math.hypot(futureX - enemy.x, futureY - enemy.y);
          const midX = p.x + direction.x * 155;
          const midY = p.y + direction.y * 155;
          const nearX = p.x + direction.x * 72;
          const nearY = p.y + direction.y * 72;
          const midDistance = Math.hypot(midX - enemy.x, midY - enemy.y);
          const nearDistance = Math.hypot(nearX - enemy.x, nearY - enemy.y);
          const proximity = Math.max(0, 1 - futureDistance / dangerRadius);
          const pathProximity = Math.max(0, 1 - Math.min(midDistance, nearDistance) / (dangerRadius * 0.72));
          const toward = ((enemy.x - p.x) * direction.x + (enemy.y - p.y) * direction.y)
            / Math.max(1, currentDistance);
          const immediateToward = currentDistance < 280 ? Math.max(0, toward) * (1 - currentDistance / 280) : 0;
          const weight = bodyWeight * behaviorWeight * (1 + enemy.damage / 18);
          direction.score += (proximity * proximity + pathProximity * pathProximity * 2.4 + immediateToward * 3.2) * weight;
        }
      }
      for (const telegraph of sim.telegraphs) {
        if (!telegraph.active || telegraph.kind === 'chant' || telegraph.kind === 'summon') continue;
        for (const direction of directions) {
          const futureX = p.x + direction.x * 310;
          const futureY = p.y + direction.y * 310;
          const distance = Math.hypot(futureX - telegraph.x, futureY - telegraph.y);
          const dangerRadius = telegraph.r + 110;
          const proximity = Math.max(0, 1 - distance / dangerRadius);
          direction.score += proximity * proximity * 18;
        }
      }
      for (const zone of sim.flareZones) {
        for (const direction of directions) {
          const futureX = p.x + direction.x * 310;
          const futureY = p.y + direction.y * 310;
          const proximity = Math.max(0, 1 - Math.hypot(futureX - zone.x, futureY - zone.y) / (zone.r + 100));
          direction.score += proximity * proximity * 16;
        }
      }
      for (const direction of directions) direction.danger = direction.score;
      const pickupValue: Record<string, number> = {
        // Rescue drops are most valuable when the press is dense. A human
        // player would not ignore a visible full-pitch bomb at 20% health.
        heal: p.hp / Math.max(1, p.maxHp) < 0.72 ? 360 : 3,
        trophy: 8,
        bomb: nearbyThreats >= 9 ? 520 : 48,
        freeze: nearbyThreats >= 9 ? 360 : 32,
        magnet: nearbyThreats >= 9 ? 240 : 24,
        xp: 0.35,
        coin: 0.12,
      };
      for (const pickup of sim.pickups) {
        if (!pickup.active) continue;
        if (nearbyThreats >= 9 && !['heal', 'bomb', 'freeze', 'magnet'].includes(pickup.kind)) continue;
        const value = pickupValue[pickup.kind] ?? 0;
        if (value <= 0) continue;
        for (const direction of directions) {
          if (direction.danger > (nearbyThreats >= 9 ? 10 : 20)) continue;
          const futureX = p.x + direction.x * 310;
          const futureY = p.y + direction.y * 310;
          const distance = Math.hypot(futureX - pickup.x, futureY - pickup.y);
          direction.score -= Math.max(0, 1 - distance / 720) * value;
        }
      }
      directions.sort((a, b) => a.score - b.score);
      const desired = directions[0];
      const specialPickups = sim.pickups.reduce((counts: Record<string, number>, pickup: { active: boolean; kind: string }) => {
        if (pickup.active && ['heal', 'bomb', 'freeze', 'magnet'].includes(pickup.kind)) {
          counts[pickup.kind] = (counts[pickup.kind] ?? 0) + 1;
        }
        return counts;
      }, {});
      return {
        run: window.__FF.getState().run,
        time: sim.time,
        over: sim.over,
        hp: p.hp,
        maxHp: p.maxHp,
        kills: sim.kills,
        level: p.level,
        desiredX: desired.x,
        desiredY: desired.y,
        dangerScore: desired.score,
        nearestThreat,
        nearbyThreats,
        activeEnemies: sim.enemies.filter((enemy: { active: boolean }) => enemy.active).length,
        specialPickups,
        boss: sim.bossAlive ? {
          id: sim.bossAlive.boss,
          hp: sim.bossAlive.hp,
          maxHp: sim.bossAlive.maxHp,
        } : null,
        abilities: p.abilities,
        stats: p.stats,
      };
    });
    if (!state) throw new Error('Natural match lost its simulation instance.');
    if (state.over !== 'playing') break;
    if (Date.now() - startedAt > 900_000) throw new Error(`Natural match timed out at ${state.time.toFixed(2)}s.`);

    if (state.run === 'levelup') {
      for (const key of held) await page.keyboard.up(key);
      held = [];
      await chooseBestVisibleUpgrade(page);
      await page.waitForTimeout(50);
      continue;
    }

    const now = Date.now();
    if (now >= nextMovementAt) {
      for (const key of held) await page.keyboard.up(key);
      held = movementKeys(state.desiredX, state.desiredY);
      for (const key of held) await page.keyboard.down(key);
      nextMovementAt = now + 180;
    }
    if (now >= nextDashAt && (state.nearestThreat < 280 || state.nearbyThreats >= 5 || state.dangerScore > 3.5)) {
      await page.keyboard.press('Space');
      // Poll the real action at a human reaction cadence. The simulation still
      // enforces charges, cooldown, edge clearance, anticipation and recovery.
      nextDashAt = now + 700;
    }
    if (state.time >= nextCheckpointAt) {
      console.log(`NATURAL_MATCH_CHECKPOINT ${JSON.stringify(state)}`);
      nextCheckpointAt += 60;
    }
    await page.waitForTimeout(120);
  }

  for (const key of held) await page.keyboard.up(key);
  const result = await page.evaluate(() => {
    const sim = window.__FF.getSim()!;
    return {
      time: sim.time,
      over: sim.over,
      kills: sim.kills,
      level: sim.player.level,
      hp: sim.player.hp,
      maxHp: sim.player.maxHp,
      fps: window.__FF.getFps(),
      timing: window.__FF.getTimingMetrics(),
      abilities: sim.player.abilities,
      stats: sim.player.stats,
      activeEnemies: sim.enemies.filter((enemy: { active: boolean }) => enemy.active).length,
      boss0Spawned: sim.boss0Spawned,
      boss1Spawned: sim.boss1Spawned,
      boss2Spawned: sim.boss2Spawned,
      boss: sim.bossAlive ? {
        id: sim.bossAlive.boss,
        hp: sim.bossAlive.hp,
        maxHp: sim.bossAlive.maxHp,
      } : null,
    };
  });
  console.log(`NATURAL_MATCH_RESULT ${JSON.stringify(result)}`);
  // A hard roguelite must permit a legitimate loss. This soak proves a deep
  // natural run rather than forcing one seeded bot to win every time. Full-time
  // victory and final-boss sudden death remain deterministic E2E fixtures.
  expect(result.time).toBeGreaterThanOrEqual(480);
  expect(['lost', 'won']).toContain(result.over);
  if (result.over === 'won') expect(result.time).toBeGreaterThanOrEqual(600);
  else expect(result.hp).toBe(0);
  expect(result.kills).toBeGreaterThan(1_000);
  expect(result.level).toBeGreaterThanOrEqual(25);
  expect(result.boss0Spawned).toBe(true);
  expect(result.boss1Spawned).toBe(true);
  if (result.time >= 540) expect(result.boss2Spawned).toBe(true);
  expect(result.fps).toBeGreaterThan(35);
  expect(result.timing.tempoRatio).toBeGreaterThan(0.97);
  expect(errors).toEqual([]);
});
