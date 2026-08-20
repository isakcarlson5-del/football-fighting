export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function len(x: number, y: number): number {
  return Math.hypot(x, y);
}

export function norm(x: number, y: number): { x: number; y: number } {
  const l = Math.hypot(x, y);
  if (l < 1e-6) return { x: 0, y: 0 };
  return { x: x / l, y: y / l };
}

export function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** Format run seconds as a football match clock: 600s -> 90', then 91' and up. */
export function matchClock(seconds: number): string {
  const mins = Math.max(0, Math.floor((Math.max(0, seconds) / 600) * 90));
  return `${mins}'`;
}

/** Leaderboard/VIP clock with seconds of the current football minute. */
export function matchClockPrecise(seconds: number): string {
  const totalMins = Math.max(0, (Math.max(0, seconds) / 600) * 90);
  const mins = Math.floor(totalMins);
  const extra = Math.min(59, Math.floor((totalMins - mins) * 60));
  return `${mins}'${String(extra).padStart(2, '0')}`;
}
