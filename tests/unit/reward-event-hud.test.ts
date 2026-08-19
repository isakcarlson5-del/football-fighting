// @ts-nocheck -- the browser project intentionally does not ship Node typings.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewardEventTimerView } from '../../src/game/ui';
import { REWARD_EVENT_LABEL } from '../../src/game/sim';

describe('reward event timer HUD', () => {
  it('shows remaining seconds while the shipped buff is live and hides when it expires', () => {
    const live = rewardEventTimerView({ kind: 'both', t: 29.2, label: REWARD_EVENT_LABEL });
    expect(live.show).toBe(true);
    expect(live.label).toBe(REWARD_EVENT_LABEL);
    expect(live.seconds).toBe('30');
    expect(live.progress).toBeGreaterThan(0.96);
    const late = rewardEventTimerView({ kind: 'both', t: 0.2, label: REWARD_EVENT_LABEL });
    expect(late.show).toBe(true);
    expect(late.seconds).toBe('1');
    expect(late.progress).toBeLessThan(0.02);
    expect(rewardEventTimerView(null).show).toBe(false);
    expect(rewardEventTimerView({ kind: 'both', t: 0, label: REWARD_EVENT_LABEL }).show).toBe(false);
  });

  it('ships the timer in Kick Off / The Club button language with a real CSS animation', () => {
    const hud = readFileSync(resolve('src/game/ui.ts'), 'utf8');
    const css = readFileSync(resolve('src/styles.css'), 'utf8');
    expect(hud).toContain('id="reward-event"');
    expect(hud).toContain('rewardEventTimerView(sim.rewardBuff)');
    expect(css).toContain('#reward-event');
    expect(css).toContain("font-family: 'Archivo Black'");
    expect(css).toContain('background: var(--gold)');
    expect(css).toContain('box-shadow: var(--shadow)');
    expect(css).toContain('text-transform: uppercase');
    expect(css).toContain('@keyframes reward-event-enter');
    expect(css).toContain('@keyframes reward-event-idle');
    expect(css).toContain('@keyframes reward-event-tick');
    expect(css).toContain('@keyframes reward-event-ring-tick');
    expect(css).toContain('@keyframes reward-event-face-tick');
    expect(css).toContain('#reward-event.show');
    expect(css).toContain('border-radius: 50%');
    expect(css).toContain('.reward-event-progress');
    expect(css).toContain('width: 176px');
    expect(css).toContain('font-size: 48px');
    expect(css).toContain('top: calc(96px + env(safe-area-inset-top))');
    expect(hud).toContain('reward-event-ring');
    expect(hud).toContain('classList.add(\'tick\')');
    const ringBlock = css.slice(css.indexOf('.reward-event-ring'), css.indexOf('.reward-event-track,'));
    expect(ringBlock).not.toContain('drop-shadow');
    expect(css).not.toMatch(/\.reward-event-progress\s*\{[^}]*transition:\s*stroke-dashoffset/);
  });

  it('drops leftover HUD focus so movement keys are not stuck on pause', () => {
    const input = readFileSync(resolve('src/core/input.ts'), 'utf8');
    const ui = readFileSync(resolve('src/game/ui.ts'), 'utf8');
    expect(input).toContain('export function blurHudKeyboardFocus');
    expect(input).toContain('if (movement) blurHudKeyboardFocus()');
    expect(ui).toContain('releaseGameplayFocus');
    expect(ui).toContain('tabindex="-1"');
    expect(ui).toContain('id="pause-btn"');
  });
});
