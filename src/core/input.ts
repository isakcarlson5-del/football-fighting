/** Keyboard + virtual joystick input. */

export const JOYSTICK_DEADZONE = 0.18;

export interface InputAxis {
  x: number;
  y: number;
}

/** Remove a radial joystick deadzone without introducing a speed step at its
 * edge. Direction is preserved and the remaining physical travel maps back to
 * the complete 0..1 gameplay range. */
export function remapRadialDeadzone(
  x: number,
  y: number,
  deadzone = JOYSTICK_DEADZONE,
): InputAxis {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
  const safeDeadzone = Math.min(0.999, Math.max(0, Number.isFinite(deadzone) ? deadzone : JOYSTICK_DEADZONE));
  const rawMagnitude = Math.hypot(x, y);
  if (rawMagnitude <= safeDeadzone || rawMagnitude <= Number.EPSILON) return { x: 0, y: 0 };
  const clampedMagnitude = Math.min(1, rawMagnitude);
  const remappedMagnitude = (clampedMagnitude - safeDeadzone) / (1 - safeDeadzone);
  return {
    x: (x / rawMagnitude) * remappedMagnitude,
    y: (y / rawMagnitude) * remappedMagnitude,
  };
}

export const MOVEMENT_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];

export function gameplayOverlayOpen(doc: Document = document): boolean {
  return !!(doc.getElementById('levelup-screen') || doc.getElementById('pause-screen'));
}

/** After a draft/pause the browser often parks focus on #pause-btn (the
 * top HUD control). ArrowUp then looks "stuck" until the player presses
 * Down to leave it. Drop that leftover so WASD is movement again. */
export function blurHudKeyboardFocus(doc: Document = document): void {
  const leftover = doc.activeElement;
  if (!(leftover instanceof HTMLElement)) return;
  if (leftover.closest('#hud, #levelup-screen, #pause-screen')) leftover.blur();
}

export class Input {
  keys = new Set<string>();
  /** Movement axis, -1..1 each. */
  ax = 0;
  ay = 0;
  /** Virtual joystick state (touch). */
  joyActive = false;
  joyX = 0;
  joyY = 0;
  private pressed = new Set<string>();

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      const overlay = gameplayOverlayOpen();
      const movement = MOVEMENT_KEYS.includes(k);
      if (!typing && (movement || k === ' ')) e.preventDefault();
      if (overlay && movement) return;
      if (movement) blurHudKeyboardFocus();
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
    });
    target.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    target.addEventListener('blur', () => this.keys.clear());
  }

  /** True only on the frame the key went down. Call endFrame() after sim. */
  justPressed(key: string): boolean {
    return this.pressed.has(key.toLowerCase());
  }

  update(): void {
    const k = this.keys;
    let x = 0;
    let y = 0;
    if (k.has('a') || k.has('arrowleft')) x -= 1;
    if (k.has('d') || k.has('arrowright')) x += 1;
    if (k.has('w') || k.has('arrowup')) y -= 1;
    if (k.has('s') || k.has('arrowdown')) y += 1;
    if (this.joyActive) {
      const joy = remapRadialDeadzone(this.joyX, this.joyY);
      x += joy.x;
      y += joy.y;
    }
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    this.ax = x;
    this.ay = y;
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
