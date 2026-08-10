/**
 * WebAudio synthesized sound: SFX + adaptive music. No external audio assets.
 * Everything is generated from oscillators/noise so the bundle stays tiny.
 *
 * Autoplay-safe: the AudioContext is only created/resumed after a user
 * gesture (unlock()). Mute + master/sfx/music volumes persist via Save.
 */

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private crowd: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  muted = false;
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
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.02);
    if (this.sfxGain) this.sfxGain.gain.setTargetAtTime(this.volumes.sfx * 0.9, t, 0.02);
    if (this.musicGain) this.musicGain.gain.setTargetAtTime(this.volumes.music * 0.6, t, 0.02);
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private tone(opts: {
    freq: number; freqEnd?: number; dur: number; type?: OscillatorType;
    gain?: number; when?: number; dest?: GainNode;
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
    osc.connect(g).connect(opts.dest ?? this.sfxGain);
    osc.start(t);
    osc.stop(t + opts.dur + 0.02);
  }

  private noise(opts: { dur: number; gain?: number; freq?: number; q?: number; when?: number; sweepTo?: number }): void {
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
    src.connect(filt).connect(g).connect(this.sfxGain);
    src.start(t);
  }

  /* ---------------- SFX ---------------- */

  kick(): void {
    this.tone({ freq: 220, freqEnd: 60, dur: 0.12, type: 'triangle', gain: 0.5 });
    this.noise({ dur: 0.06, gain: 0.15, freq: 900 });
  }
  hit(): void {
    this.tone({ freq: 140, freqEnd: 50, dur: 0.09, type: 'square', gain: 0.28 });
  }
  hurt(): void {
    this.tone({ freq: 320, freqEnd: 90, dur: 0.25, type: 'sawtooth', gain: 0.3 });
    this.noise({ dur: 0.15, gain: 0.2, freq: 400 });
  }
  xp(): void {
    this.tone({ freq: 660, freqEnd: 990, dur: 0.07, type: 'sine', gain: 0.14 });
  }
  coin(): void {
    this.tone({ freq: 990, dur: 0.06, type: 'square', gain: 0.12 });
    this.tone({ freq: 1320, dur: 0.1, type: 'square', gain: 0.12, when: this.now() + 0.05 });
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
  bossHorn(): void {
    const t = this.now();
    [98, 123, 147].forEach((f) => this.tone({ freq: f, freqEnd: f * 0.94, dur: 0.7, type: 'sawtooth', gain: 0.2, when: t }));
    this.noise({ dur: 0.5, gain: 0.12, freq: 250 });
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
      this.noise({ dur: 0.03, gain: 0.05, freq: 6000, q: 2, when: t });
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
