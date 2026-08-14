/**
 * WebAudio synthesized sound: SFX + adaptive music. No external audio assets.
 * Everything is generated from oscillators/noise so the bundle stays tiny.
 *
 * Autoplay-safe: the AudioContext is only created/resumed after a user
 * gesture (unlock()). Mute + master/sfx/music volumes persist via Save.
 */

export type AudioThreatPriority = 1 | 2 | 3 | 4;

export interface AudioPriorityProfile {
  musicDuck: number;
  combatDuck: number;
  attack: number;
  hold: number;
  release: number;
}

/** Priority 1/2 are ordinary mix content. Priority 3 warning cues and
 * priority 4 immediate danger cues earn space by briefly lowering everything
 * below them, never by raising the master volume. */
export function audioPriorityProfile(priority: AudioThreatPriority): AudioPriorityProfile {
  if (priority === 4) return { musicDuck: 0.24, combatDuck: 0.34, attack: 0.012, hold: 0.24, release: 0.34 };
  if (priority === 3) return { musicDuck: 0.42, combatDuck: 0.58, attack: 0.018, hold: 0.16, release: 0.25 };
  return { musicDuck: 1, combatDuck: 1, attack: 0.02, hold: 0, release: 0.08 };
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private dangerGain: GainNode | null = null;
  private crowd: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  // Fail silent. The game explicitly opts into sound only when the player
  // chooses Unmute; no synthesized layer may start audible by default.
  muted = true;
  volumes = { master: 0.9, sfx: 1, music: 0.7 };
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private step = 0;

  /** Must be called from a user gesture before any sound plays. */
  unlock(): void {

    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.42;
    this.musicGain.connect(this.master);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.9;
    this.sfxGain.connect(this.master);
    this.dangerGain = this.ctx.createGain();
    this.dangerGain.gain.value = 0.94;
    this.dangerGain.connect(this.master);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolumes();
  }

  setVolumes(v: { master: number; sfx: number; music: number }): void {
    this.volumes = v;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const reset = (param: AudioParam, value: number): void => {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(value, t, 0.02);
    };
    if (this.master) reset(this.master.gain, this.muted ? 0 : this.volumes.master);
    if (this.sfxGain) reset(this.sfxGain.gain, this.volumes.sfx * 0.9);
    if (this.dangerGain) reset(this.dangerGain.gain, this.volumes.sfx * 0.94);
    if (this.musicGain) reset(this.musicGain.gain, this.volumes.music * 0.6);
  }

  private duckForThreat(priority: AudioThreatPriority): void {
    if (!this.ctx || !this.musicGain || !this.sfxGain || priority < 3) return;
    const profile = audioPriorityProfile(priority);
    const t = this.ctx.currentTime;
    const musicBase = this.volumes.music * 0.6;
    const combatBase = this.volumes.sfx * 0.9;
    const duck = (param: AudioParam, base: number, depth: number): void => {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(base * depth, t, profile.attack);
      param.setTargetAtTime(base, t + profile.hold, profile.release);
    };
    duck(this.musicGain.gain, musicBase, profile.musicDuck);
    duck(this.sfxGain.gain, combatBase, profile.combatDuck);
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private tone(opts: {
    freq: number; freqEnd?: number; dur: number; type?: OscillatorType;
    gain?: number; when?: number; dest?: GainNode; priority?: AudioThreatPriority;
  }): void {
    if (!this.ctx || !this.sfxGain) return;
    const t = opts.when ?? this.now();
    const osc = this.ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t + opts.dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.gain ?? 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    const output = opts.dest ?? (opts.priority && opts.priority >= 3 ? this.dangerGain : this.sfxGain);
    if (!output) return;
    osc.connect(g).connect(output);
    osc.start(t);
    osc.stop(t + opts.dur + 0.02);
  }

  private noise(opts: {
    dur: number; gain?: number; freq?: number; q?: number; when?: number;
    sweepTo?: number; dest?: GainNode; priority?: AudioThreatPriority;
  }): void {
    if (!this.ctx || !this.sfxGain) return;
    const t = opts.when ?? this.now();
    const len = Math.ceil(this.ctx.sampleRate * opts.dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(opts.freq ?? 1200, t);
    if (opts.sweepTo !== undefined) filt.frequency.exponentialRampToValueAtTime(opts.sweepTo, t + opts.dur);
    filt.Q.value = opts.q ?? 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.gain ?? 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    const output = opts.dest ?? (opts.priority && opts.priority >= 3 ? this.dangerGain : this.sfxGain);
    if (!output) return;
    src.connect(filt).connect(g).connect(output);
    src.start(t);
  }

  /* ---------------- SFX ---------------- */

  kick(): void {
    this.tone({ freq: 220, freqEnd: 60, dur: 0.12, type: 'triangle', gain: 0.5 });
    this.noise({ dur: 0.06, gain: 0.15, freq: 900 });
  }
  hit(heavy = false, crit = false): void {
    this.tone({
      freq: crit ? 210 : heavy ? 165 : 140,
      freqEnd: heavy || crit ? 42 : 50,
      dur: heavy || crit ? 0.13 : 0.09,
      type: heavy ? 'triangle' : 'square',
      gain: heavy || crit ? 0.38 : 0.28,
    });
    if (heavy || crit) this.noise({ dur: 0.055, gain: crit ? 0.18 : 0.12, freq: crit ? 2100 : 1200 });
    if (crit) this.tone({ freq: 920, freqEnd: 1450, dur: 0.08, type: 'sine', gain: 0.1 });
  }
  hurt(): void {
    this.duckForThreat(3);
    this.tone({ freq: 320, freqEnd: 90, dur: 0.25, type: 'sawtooth', gain: 0.3, priority: 3 });
    this.noise({ dur: 0.15, gain: 0.2, freq: 400, priority: 3 });
  }
  xp(): void {
    this.tone({ freq: 660, freqEnd: 990, dur: 0.07, type: 'sine', gain: 0.14 });
  }
  coin(): void {
    this.tone({ freq: 990, dur: 0.06, type: 'square', gain: 0.12 });
    this.tone({ freq: 1320, dur: 0.1, type: 'square', gain: 0.12, when: this.now() + 0.05 });
  }
  magnet(): void {
    const t = this.now();
    this.tone({ freq: 240, freqEnd: 920, dur: 0.42, type: 'sine', gain: 0.24, when: t });
    this.tone({ freq: 480, freqEnd: 1480, dur: 0.34, type: 'triangle', gain: 0.12, when: t + 0.06 });
    this.noise({ dur: 0.36, gain: 0.08, freq: 1100, sweepTo: 3200, q: 1.7, when: t });
  }
  arenaBomb(): void {
    const t = this.now();
    this.duckForThreat(3);
    this.tone({ freq: 92, freqEnd: 28, dur: 0.72, type: 'sine', gain: 0.56, when: t, priority: 3 });
    this.noise({ dur: 0.62, gain: 0.42, freq: 520, sweepTo: 70, q: 0.65, when: t, priority: 3 });
    this.tone({ freq: 620, freqEnd: 120, dur: 0.2, type: 'sawtooth', gain: 0.15, when: t + 0.02, priority: 3 });
  }
  timeFreeze(): void {
    const t = this.now();
    this.duckForThreat(3);
    [1320, 990, 740, 554].forEach((f, i) => this.tone({ freq: f, freqEnd: f * 0.72, dur: 0.18, type: 'sine', gain: 0.13, when: t + i * 0.045, priority: 3 }));
    this.noise({ dur: 0.5, gain: 0.1, freq: 3600, sweepTo: 900, q: 2, when: t, priority: 3 });
  }
  whistle(): void {
    const t = this.now();
    this.tone({ freq: 2200, freqEnd: 2600, dur: 0.28, type: 'square', gain: 0.22, when: t });
    this.tone({ freq: 2650, freqEnd: 2300, dur: 0.2, type: 'square', gain: 0.18, when: t + 0.05 });
  }
  levelup(): void {
    const t = this.now();
    [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, dur: 0.16, type: 'triangle', gain: 0.2, when: t + i * 0.07 }));
  }
  dash(): void {
    this.noise({ dur: 0.22, gain: 0.25, freq: 500, sweepTo: 2400, q: 1.4 });
  }
  punch(): void {
    this.tone({ freq: 100, freqEnd: 45, dur: 0.1, type: 'triangle', gain: 0.4 });
  }
  shockwave(): void {
    this.noise({ dur: 0.4, gain: 0.3, freq: 300, sweepTo: 90, q: 0.7 });
    this.tone({ freq: 90, freqEnd: 40, dur: 0.35, type: 'sine', gain: 0.4 });
  }
  /** First Touch Blast: low pitch impact followed by a crisp overhead pop. */
  blast(): void {
    const t = this.now();
    this.noise({ dur: 0.32, gain: 0.28, freq: 360, sweepTo: 75, q: 0.8 });
    this.tone({ freq: 105, freqEnd: 38, dur: 0.3, type: 'sine', gain: 0.42, when: t });
    this.tone({ freq: 720, freqEnd: 1380, dur: 0.1, type: 'triangle', gain: 0.16, when: t + 0.045 });
  }
  /** Fast corkscrew launch with a crisp tracking shimmer. */
  curveball(): void {
    const t = this.now();
    this.noise({ dur: 0.24, gain: 0.2, freq: 620, sweepTo: 2800, q: 1.3, when: t });
    this.tone({ freq: 410, freqEnd: 980, dur: 0.18, type: 'triangle', gain: 0.18, when: t });
    this.tone({ freq: 1240, freqEnd: 1740, dur: 0.1, type: 'sine', gain: 0.09, when: t + 0.06 });
  }
  /** Heavy golden-cleat launch; lower than the curveball to keep both readable. */
  goldenBoot(): void {
    const t = this.now();
    this.tone({ freq: 150, freqEnd: 62, dur: 0.18, type: 'triangle', gain: 0.42, when: t });
    this.noise({ dur: 0.3, gain: 0.24, freq: 420, sweepTo: 1700, q: 0.9, when: t });
    this.tone({ freq: 690, freqEnd: 1080, dur: 0.14, type: 'sine', gain: 0.1, when: t + 0.04 });
  }
  seekerImpact(kind: 'curveball' | 'goldenboot'): void {
    if (kind === 'curveball') {
      this.tone({ freq: 680, freqEnd: 230, dur: 0.09, type: 'triangle', gain: 0.2 });
      this.noise({ dur: 0.055, gain: 0.11, freq: 1900 });
    } else {
      this.tone({ freq: 125, freqEnd: 38, dur: 0.16, type: 'triangle', gain: 0.4 });
      this.noise({ dur: 0.15, gain: 0.22, freq: 520, sweepTo: 120, q: 0.7 });
    }
  }
  /** Vuvuzela blast: nasal low blat. */
  horn(): void {
    const t = this.now();
    this.tone({ freq: 233, freqEnd: 220, dur: 0.5, type: 'sawtooth', gain: 0.22, when: t });
    this.tone({ freq: 117, freqEnd: 110, dur: 0.5, type: 'square', gain: 0.14, when: t });
    this.noise({ dur: 0.3, gain: 0.08, freq: 700 });
  }
  /** Paparazzo flash: shutter click + faint charge whine. */
  cameraFlash(): void {
    this.noise({ dur: 0.05, gain: 0.22, freq: 3200, q: 1.6 });
    this.tone({ freq: 1800, freqEnd: 2600, dur: 0.09, type: 'sine', gain: 0.1 });
  }
  /** Crowd roar for chants/rallies (short). */
  chant(): void {
    this.noise({ dur: 0.7, gain: 0.16, freq: 500, sweepTo: 900, q: 0.5 });
    this.tone({ freq: 196, dur: 0.5, type: 'triangle', gain: 0.12 });
  }
  /** Shock Drone discharge: a short electrical crack with a descending core. */
  zap(): void {
    const t = this.now();
    this.duckForThreat(4);
    this.noise({ dur: 0.11, gain: 0.2, freq: 3400, sweepTo: 900, q: 2.1, when: t, priority: 4 });
    this.tone({ freq: 1320, freqEnd: 360, dur: 0.14, type: 'square', gain: 0.13, when: t, priority: 4 });
  }
  /** Heavy hoof launch without reusing the lighter player dash sound. */
  bullCharge(): void {
    const t = this.now();
    this.duckForThreat(4);
    this.tone({ freq: 78, freqEnd: 36, dur: 0.28, type: 'triangle', gain: 0.46, when: t, priority: 4 });
    this.noise({ dur: 0.3, gain: 0.22, freq: 260, sweepTo: 90, q: 0.7, when: t, priority: 4 });
  }
  bossHorn(): void {
    const t = this.now();
    this.duckForThreat(4);
    [98, 123, 147].forEach((f) => this.tone({ freq: f, freqEnd: f * 0.94, dur: 0.7, type: 'sawtooth', gain: 0.2, when: t, priority: 4 }));
    this.noise({ dur: 0.5, gain: 0.12, freq: 250, priority: 4 });
  }
  victory(): void {
    const t = this.now();
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.22, when: t + i * 0.12 }),
    );
    this.whistle();
  }
  defeat(): void {
    const t = this.now();
    [392, 370, 330, 262].forEach((f, i) => this.tone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.2, when: t + i * 0.16 }));
    this.whistle();
  }

  /* ---------------- Music + crowd ---------------- */

  /** Stadium crowd bed + simple driving loop during a run. */
  startMusic(): void {
    if (!this.ctx || !this.musicGain || this.musicTimer) return;
    // Crowd bed: looping filtered noise
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = last * 0.94 + (Math.random() * 2 - 1) * 0.06; // brown-ish
      d[i] = last * 6;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0.14;
    src.connect(g).connect(this.musicGain);
    src.start();
    this.crowd = { src, gain: g };

    const bpm = 128;
    const stepDur = 60 / bpm / 2; // eighth notes
    const bassLine = [55, 55, 65.4, 55, 49, 49, 58.3, 65.4];
    const arp = [220, 261.6, 329.6, 261.6, 220, 261.6, 392, 329.6];
    this.step = 0;
    this.musicTimer = setInterval(() => {
      if (!this.ctx || !this.musicGain || this.muted) {
        this.step++;
        return;
      }
      const i = this.step % 8;
      const t = this.ctx.currentTime + 0.02;
      // Four-on-the-floor kick
      if (i % 2 === 0) this.tone({ freq: 130, freqEnd: 45, dur: 0.12, type: 'sine', gain: 0.5, when: t, dest: this.musicGain });
      // Bass
      this.tone({ freq: bassLine[i], dur: stepDur * 0.9, type: 'sawtooth', gain: 0.12, when: t, dest: this.musicGain });
      // Arp sparkle on off-beats
      if (i % 2 === 1) this.tone({ freq: arp[i], dur: stepDur * 0.5, type: 'triangle', gain: 0.07, when: t, dest: this.musicGain });
      // Hat
      this.noise({ dur: 0.03, gain: 0.05, freq: 6000, q: 2, when: t, dest: this.musicGain });
      this.step++;
    }, stepDur * 1000);
  }

  stopMusic(): void {
    if (this.musicTimer) clearInterval(this.musicTimer);
    this.musicTimer = null;
    if (this.crowd) {
      try {
        this.crowd.src.stop();
      } catch {
        // already stopped
      }
      this.crowd = null;
    }
  }

  /** Crowd roar swell (goals, level-up, boss kills). */
  roar(intensity = 1): void {
    if (!this.ctx || !this.musicGain) return;
    const t = this.now();
    this.noise({ dur: 1.2, gain: 0.25 * intensity, freq: 800, sweepTo: 500, q: 0.4, when: t });
  }
}
