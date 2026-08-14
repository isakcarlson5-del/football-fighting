/** Local save-data: coins, meta ranks, skins, stats, settings. */

import { META_TRACKS, SKINS, type MetaTrackId } from './data';

const KEY = 'ff_save_v1';
export const SAVE_VERSION = 2;

export interface SaveData {
  version: number;
  coins: number;
  ranks: Record<MetaTrackId, number>;
  ownedSkins: string[];
  equipped: Record<string, string>; // playerId -> skinId
  stats: { runs: number; wins: number; totalKills: number; bestTime: number; bestLevel: number };
  leaderboardName: string;
  muted: boolean;
  reducedVfx: boolean;
  haptics: boolean;
  volume: { master: number; sfx: number; music: number };
}

function defaults(): SaveData {
  return {
    version: SAVE_VERSION,
    coins: 0,
    ranks: { power: 0, move: 0, magnet: 0, guard: 0 },
    ownedSkins: [],
    equipped: {},
    stats: { runs: 0, wins: 0, totalKills: 0, bestTime: 0, bestLevel: 0 },
    leaderboardName: 'Guest',
    muted: true,
    reducedVfx: false,
    haptics: true,
    volume: { master: 0.9, sfx: 1, music: 0.7 },
  };
}

function finite(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** Migrate and validate old/local data without discarding legitimate progress. */
function normalizeSave(value: unknown): SaveData {
  const base = defaults();
  if (!value || typeof value !== 'object') return base;
  const raw = value as Partial<SaveData>;
  const ranks = raw.ranks && typeof raw.ranks === 'object' ? raw.ranks : base.ranks;
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : base.stats;
  const volume = raw.volume && typeof raw.volume === 'object' ? raw.volume : base.volume;
  const equipped = raw.equipped && typeof raw.equipped === 'object'
    ? Object.fromEntries(Object.entries(raw.equipped).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};
  return {
    version: SAVE_VERSION,
    coins: Math.round(finite(raw.coins, base.coins)),
    ranks: Object.fromEntries(META_TRACKS.map((track) => [
      track.id,
      Math.round(finite(ranks[track.id], 0, 0, track.maxRank)),
    ])) as Record<MetaTrackId, number>,
    ownedSkins: Array.isArray(raw.ownedSkins)
      ? [...new Set(raw.ownedSkins.filter((id): id is string => typeof id === 'string'))]
      : [],
    equipped,
    stats: {
      runs: Math.round(finite(stats.runs, 0)),
      wins: Math.round(finite(stats.wins, 0)),
      totalKills: Math.round(finite(stats.totalKills, 0)),
      bestTime: Math.round(finite(stats.bestTime, 0)),
      bestLevel: Math.round(finite(stats.bestLevel, 0)),
    },
    leaderboardName: typeof raw.leaderboardName === 'string'
      ? raw.leaderboardName.trim().slice(0, 20) || base.leaderboardName
      : base.leaderboardName,
    muted: typeof raw.muted === 'boolean' ? raw.muted : base.muted,
    reducedVfx: typeof raw.reducedVfx === 'boolean' ? raw.reducedVfx : base.reducedVfx,
    haptics: typeof raw.haptics === 'boolean' ? raw.haptics : base.haptics,
    volume: {
      master: finite(volume.master, base.volume.master, 0, 1),
      sfx: finite(volume.sfx, base.volume.sfx, 0, 1),
      music: finite(volume.music, base.volume.music, 0, 1),
    },
  };
}

export class Save {
  data: SaveData;
  private storage: Storage | null = null;

  constructor(storage: Storage | null) {
    this.data = defaults();
    this.storage = storage;
    if (!storage) return;
    try {
      const raw = storage.getItem(KEY);
      if (raw) {
        this.data = normalizeSave(JSON.parse(raw));
      }
    } catch {
      // Corrupt save: fall back to defaults rather than crashing.
    }
  }

  persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Storage may be unavailable (private mode); game still works session-only.
    }
  }

  rank(id: MetaTrackId): number {
    return this.data.ranks[id] ?? 0;
  }

  buyRank(id: MetaTrackId, cost: number): boolean {
    const track = META_TRACKS.find((t) => t.id === id);
    if (!track) return false;
    const r = this.rank(id);
    if (r >= track.maxRank || this.data.coins < cost) return false;
    this.data.coins -= cost;
    this.data.ranks[id] = r + 1;
    this.persist();
    return true;
  }

  ownsSkin(id: string): boolean {
    return this.data.ownedSkins.includes(id);
  }

  buySkin(id: string): boolean {
    const skin = SKINS.find((s) => s.id === id);
    if (!skin || this.ownsSkin(id) || this.data.coins < skin.cost) return false;
    this.data.coins -= skin.cost;
    this.data.ownedSkins.push(id);
    this.persist();
    return true;
  }

  equipSkin(playerId: string, skinId: string | null): void {
    if (skinId === null) delete this.data.equipped[playerId];
    else this.data.equipped[playerId] = skinId;
    this.persist();
  }

  equippedSkin(playerId: string): string | null {
    const id = this.data.equipped[playerId];
    return id && this.ownsSkin(id) ? id : null;
  }

  /** Meta-derived permanent bonuses. */
  bonuses() {
    const r = this.data.ranks;
    return {
      power: 1 + (r.power * 6) / 100,
      speed: 1 + (r.move * 4) / 100,
      magnet: 1 + (r.magnet * 15) / 100,
      guardDamage: 1 + (r.guard * 12) / 100,
      guardExtra: (r.guard >= 3 ? 1 : 0) + (r.guard >= 5 ? 1 : 0),
    };
  }

  addCoins(n: number): void {
    this.data.coins += Math.round(n);
    this.persist();
  }

  recordRun(opts: { kills: number; time: number; level: number; won: boolean }): void {
    const s = this.data.stats;
    s.runs += 1;
    if (opts.won) s.wins += 1;
    s.totalKills += opts.kills;
    s.bestTime = Math.max(s.bestTime, Math.round(opts.time));
    s.bestLevel = Math.max(s.bestLevel, opts.level);
    this.persist();
  }
}
