const VISITOR_KEY = 'ff_visitor_v1';

export interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
  kills: number;
  time: number;
  level: number;
  won: boolean;
}

export interface LeaderboardResult {
  online: boolean;
  entries: LeaderboardEntry[];
}

export interface RunSubmission {
  name: string;
  playerId: string;
  kills: number;
  time: number;
  level: number;
  won: boolean;
}

export interface VipVisitor {
  id: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  visits: number;
  games: number;
  wins: number;
  totalKills: number;
  bestScore: number;
  playcount?: number;
  avgPlayClock?: string;
}

export interface VipAdminStats {
  summary: {
    visitors: number;
    active24h: number;
    visits: number;
    games: number;
    wins: number;
    totalKills: number;
    avgPlayClock?: string;
    totalPlaySeconds?: number;
  };
  visitors: VipVisitor[];
  recentRuns: Array<{
    id: string;
    visitorId: string;
    name: string;
    playerId: string;
    kills: number;
    time: number;
    level: number;
    won: boolean;
    score: number;
    createdAt: string;
  }>;
}

export interface VipAdminResult {
  status: 'ok' | 'unauthorized' | 'unavailable';
  data?: VipAdminStats;
}

export function normalizeLeaderboardName(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (normalized || 'Guest').slice(0, 20);
}

function makeVisitorId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `visitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Same-origin community API with a silent offline path. The game remains
 * fully playable on static portals; only online leaderboard features pause
 * when the optional free server is unavailable. */
export class CommunityClient {
  readonly visitorId: string;
  private readonly apiBase: string;

  constructor(storage: Storage | null, apiBase?: string) {
    this.apiBase = apiBase ?? (typeof document !== 'undefined'
      ? new URL('api/', document.baseURI).toString()
      : '/api/');
    let visitorId = '';
    try {
      visitorId = storage?.getItem(VISITOR_KEY) ?? '';
    } catch {
      // Private browsing may expose Storage while rejecting access.
    }
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(visitorId)) {
      visitorId = makeVisitorId();
      try {
        storage?.setItem(VISITOR_KEY, visitorId);
      } catch {
        // Session-only identity still keeps the game functional.
      }
    }
    this.visitorId = visitorId;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T | null> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 2_800);
    try {
      const response = await fetch(new URL(path, this.apiBase), {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...init?.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json() as T;
    } catch {
      return null;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async registerVisit(name: string): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>('visit', {
      method: 'POST',
      body: JSON.stringify({ visitorId: this.visitorId, name: normalizeLeaderboardName(name) }),
    });
    return result?.ok === true;
  }

  async updateName(name: string): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>('profile', {
      method: 'PATCH',
      body: JSON.stringify({ visitorId: this.visitorId, name: normalizeLeaderboardName(name) }),
    });
    return result?.ok === true;
  }

  async getLeaderboard(): Promise<LeaderboardResult> {
    const result = await this.request<{ entries: LeaderboardEntry[] }>('leaderboard?limit=16');
    return result ? { online: true, entries: result.entries } : { online: false, entries: [] };
  }

  async submitRun(run: RunSubmission): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>('run', {
      method: 'POST',
      body: JSON.stringify({
        visitorId: this.visitorId,
        ...run,
        name: normalizeLeaderboardName(run.name),
      }),
    });
    return result?.ok === true;
  }

  async getVipAdminStats(token: string): Promise<VipAdminResult> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 2_800);
    try {
      const response = await fetch(new URL('admin/stats', this.apiBase), {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (response.status === 401) return { status: 'unauthorized' };
      if (!response.ok) return { status: 'unavailable' };
      return { status: 'ok', data: await response.json() as VipAdminStats };
    } catch {
      return { status: 'unavailable' };
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}
