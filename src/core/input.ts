/** Keyboard + virtual joystick input. */
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
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
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
      x += this.joyX;
      y += this.joyY;
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
