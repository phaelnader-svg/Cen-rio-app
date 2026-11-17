/**
 * Som do jogo, todo sintetizado no navegador (Web Audio, sem arquivos): ambiente leve de oficina,
 * cliques, aviso de nova tarefa, alerta de atraso, passos e comemoração. Respeita o botão de mudo
 * (guardado no navegador) e só começa depois do primeiro toque/clique, como os navegadores exigem.
 */

type Cue = 'click' | 'open' | 'task' | 'late' | 'celebrate' | 'step' | 'whoosh' | 'error';

const KEY = 'firma-som';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: { gain: GainNode; stop: () => void } | null = null;
  private muted = true;
  private workers = 0;
  private timer: number | null = null;
  private listeners = new Set<(m: boolean) => void>();

  constructor() {
    if (typeof window === 'undefined') return;
    try {
      this.muted = window.localStorage.getItem(KEY) === 'mudo';
    } catch {
      this.muted = false;
    }
    const unlock = () => {
      this.ensure();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  isMuted() {
    return this.muted;
  }

  subscribe(fn: (m: boolean) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      window.localStorage.setItem(KEY, m ? 'mudo' : 'ligado');
    } catch {
      /* sem armazenamento */
    }
    if (this.master && this.ctx)
      this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.08);
    if (!m) this.ensure();
    for (const l of this.listeners) l(m);
  }

  /** Quantas pessoas trabalhando agora (o ambiente fica mais "movimentado"). */
  setActivity(workers: number) {
    this.workers = workers;
    if (this.ambient && this.ctx)
      this.ambient.gain.gain.setTargetAtTime(
        0.018 + Math.min(6, workers) * 0.004,
        this.ctx.currentTime,
        1.5,
      );
  }

  private ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
    this.startAmbient();
  }

  /** Ambiente: ruído grave filtrado (galpão), costura e grampos ocasionais quando há gente trabalhando. */
  private startAmbient() {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // Ruído marrom (suave).
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const gain = ctx.createGain();
    gain.gain.value = 0.018;
    src.connect(lp).connect(gain).connect(this.master!);
    src.start();
    this.ambient = { gain, stop: () => src.stop() };
    this.setActivity(this.workers);
    const tick = () => {
      this.timer = window.setTimeout(tick, 2500 + Math.random() * 5000);
      if (this.muted || !this.workers || document.hidden) return;
      if (Math.random() < 0.5) this.sewing();
      else this.staples();
    };
    this.timer = window.setTimeout(tick, 3000);
  }

  private sewing() {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const dur = 0.6 + Math.random() * 1.2;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 38 + Math.random() * 8;
    const g = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 3;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.012, t0 + 0.05);
    g.gain.setValueAtTime(0.012, t0 + dur);
    g.gain.linearRampToValueAtTime(0, t0 + dur + 0.08);
    osc.connect(bp).connect(g).connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + dur + 0.1);
  }

  private staples() {
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this.noiseHit(this.ctx!.currentTime + i * 0.35, 0.02, 2600, 0.03);
  }

  private noiseHit(at: number, vol: number, freq: number, dur: number) {
    const ctx = this.ctx!;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master!);
    src.start(at);
  }

  private tone(
    freq: number,
    at: number,
    dur: number,
    vol: number,
    type: OscillatorType = 'sine',
    glide?: number,
  ) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.master!);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  play(cue: Cue) {
    if (this.muted) return;
    this.ensure();
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    switch (cue) {
      case 'click':
        this.tone(1250, t, 0.05, 0.05, 'triangle');
        break;
      case 'open':
        this.tone(660, t, 0.08, 0.05, 'triangle');
        this.tone(990, t + 0.05, 0.1, 0.04, 'triangle');
        break;
      case 'step':
        this.noiseHit(t, 0.012, 500, 0.05);
        break;
      case 'whoosh':
        this.noiseHit(t, 0.05, 700, 0.35);
        break;
      case 'task':
        // Nova etapa iniciada: dois toques de sino.
        this.tone(880, t, 0.35, 0.06);
        this.tone(1320, t + 0.12, 0.45, 0.05);
        break;
      case 'late':
        this.tone(330, t, 0.25, 0.07, 'sawtooth', 300);
        this.tone(262, t + 0.22, 0.35, 0.07, 'sawtooth', 240);
        break;
      case 'error':
        this.tone(220, t, 0.18, 0.06, 'square');
        break;
      case 'celebrate': {
        const notes = [523, 659, 784, 1047];
        notes.forEach((n, i) => this.tone(n, t + i * 0.1, 0.35, 0.06, 'triangle'));
        this.tone(1568, t + 0.42, 0.6, 0.04);
        for (let i = 0; i < 6; i++) this.noiseHit(t + 0.4 + i * 0.05, 0.02, 4000 + i * 300, 0.04);
        break;
      }
    }
  }
}

let instance: SoundEngine | null = null;
export function sound() {
  if (!instance) instance = new SoundEngine();
  return instance;
}
