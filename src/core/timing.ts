export interface FixedStepConsumption {
  steps: number;
  remainder: number;
  discarded: number;
}

/** Frame-rate-independent smoothing factor. `rate` is responsiveness per
 * second, so the same motion is produced at 60, 120 or uneven refresh rates. */
export function exponentialSmoothing(rate: number, dt: number): number {
  if (!Number.isFinite(rate) || !Number.isFinite(dt) || rate <= 0 || dt <= 0) return 0;
  return 1 - Math.exp(-rate * Math.min(dt, 0.25));
}

/** Consume a bounded fixed-step budget while retaining one catch-up step.
 * Only the genuinely unserviceable surplus is discarded and reported. */
export function consumeFixedSteps(
  accumulator: number,
  dt: number,
  step = 1 / 60,
  maxSteps = 8,
): FixedStepConsumption {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1 / 60;
  const safeMax = Math.max(1, Math.floor(maxSteps));
  const total = Math.max(0, Number.isFinite(accumulator) ? accumulator : 0)
    + Math.max(0, Number.isFinite(dt) ? dt : 0);
  const steps = Math.min(Math.floor(total / safeStep), safeMax);
  let remainder = Math.max(0, total - steps * safeStep);
  let discarded = 0;
  if (steps === safeMax && remainder > safeStep) {
    discarded = remainder - safeStep;
    remainder = safeStep;
  }
  return { steps, remainder, discarded };
}
