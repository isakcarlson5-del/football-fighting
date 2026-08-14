// @ts-nocheck -- this integration test exercises the Node-only optional
// community server while the browser bundle intentionally ships DOM typings.
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLeaderboardName } from '../../src/core/community';
import { createCommunityServer } from '../../server/community-server.mjs';

async function jsonRequest(base: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  return { status: response.status, body: await response.json() };
}

describe('community leaderboard server', () => {
  it('normalizes names without allowing invisible control characters', () => {
    expect(normalizeLeaderboardName('  Isak\u0000 FC  ')).toBe('Isak FC');
    expect(normalizeLeaderboardName('')).toBe('Guest');
    expect(normalizeLeaderboardName('123456789012345678901234')).toBe('12345678901234567890');
  });

  it('tracks anonymous visitors, ranks server-scored runs and protects VIP stats', async () => {
    const adminToken = 'test-vip-token-123456789';
    const { server } = await createCommunityServer({ ephemeral: true, adminToken });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const [visitorId, name] of [['visitor-alpha', 'Alpha'], ['visitor-bravo', 'Bravo']]) {
        const visit = await jsonRequest(base, '/api/visit', {
          method: 'POST',
          body: JSON.stringify({ visitorId, name }),
        });
        expect(visit).toEqual({ status: 200, body: { ok: true } });
      }

      await jsonRequest(base, '/api/run', {
        method: 'POST',
        body: JSON.stringify({ visitorId: 'visitor-alpha', name: 'Alpha', playerId: 'messi', kills: 200, time: 480, level: 25, won: false }),
      });
      await jsonRequest(base, '/api/run', {
        method: 'POST',
        body: JSON.stringify({ visitorId: 'visitor-alpha', name: 'Alpha', playerId: 'messi', kills: 20, time: 80, level: 5, won: false }),
      });
      await jsonRequest(base, '/api/run', {
        method: 'POST',
        body: JSON.stringify({ visitorId: 'visitor-bravo', name: 'Bravo', playerId: 'yamal', kills: 350, time: 600, level: 34, won: true }),
      });

      const leaderboard = await jsonRequest(base, '/api/leaderboard?limit=8');
      expect(leaderboard.status).toBe(200);
      expect(leaderboard.body.entries.map((entry) => entry.name)).toEqual(['Bravo', 'Alpha']);
      expect(leaderboard.body.entries[0]).toMatchObject({ rank: 1, kills: 350, won: true });
      expect(leaderboard.body.entries[1]).toMatchObject({ rank: 2, kills: 200, won: false });

      const denied = await jsonRequest(base, '/api/admin/stats', {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(denied.status).toBe(401);
      const admin = await jsonRequest(base, '/api/admin/stats', {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(admin.status).toBe(200);
      expect(admin.body.summary).toMatchObject({ visitors: 2, active24h: 2, visits: 2, games: 3, wins: 1, totalKills: 570 });
      expect(admin.body.visitors).toHaveLength(2);
      expect(admin.body.recentRuns).toHaveLength(3);
      expect(JSON.stringify(admin.body)).not.toContain('remoteAddress');
      expect(JSON.stringify(admin.body)).not.toContain('127.0.0.1');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('serves SPA routes without disguising missing assets and only caches hashed files immutably', async () => {
    const staticDir = await mkdtemp(join(tmpdir(), 'football-fighting-static-'));
    await mkdir(join(staticDir, 'assets'));
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Football Fighting</title>');
    await writeFile(join(staticDir, 'art.webp'), 'stable-art');
    await writeFile(join(staticDir, 'assets', 'index-AbCd1234.js'), 'hashed-code');
    const { server } = await createCommunityServer({ ephemeral: true, staticDir });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const route = await fetch(`${base}/career/history`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain('Football Fighting');
      expect(route.headers.get('cache-control')).toBe('no-cache');

      const missing = await fetch(`${base}/art/missing-player.webp`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control')).toBe('no-store');

      const stable = await fetch(`${base}/art.webp`);
      expect(stable.headers.get('cache-control')).toBe('public, max-age=3600, must-revalidate');
      const hashed = await fetch(`${base}/assets/index-AbCd1234.js`);
      expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
