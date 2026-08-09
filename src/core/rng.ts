/** Seeded deterministic RNG (mulberry32) — deterministic runs for tests. */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Weighted pick from {weight} items. Returns null when total weight is 0. */
export function weightedPick<T extends { weight: number }>(
  rng: Rng,
  items: readonly T[],
): T | null {
  let total = 0;
  for (const it of items) total += Math.max(0, it.weight);
  if (total <= 0) return null;
  let roll = rng.next() * total;
  for (const it of items) {
    roll -= Math.max(0, it.weight);
    if (roll <= 0) return it;
  }
  return items[items.length - 1] ?? null;
}
