/** Procedural WebAudio SFX — no assets. */
let ctx: AudioContext | null = null;
let enabled = true;

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      enabled = false;
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType, gain = 0.12, when = 0): void {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + when;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  setEnabled(v: boolean) {
    enabled = v;
  },
  isEnabled() {
    return enabled;
  },
  place() {
    tone(220 + Math.random() * 40, 0.12, "triangle", 0.1);
  },
  pickup() {
    tone(520, 0.06, "sine", 0.07);
  },
  rotate() {
    tone(380, 0.05, "square", 0.05);
  },
  invalid() {
    tone(140, 0.16, "sawtooth", 0.06);
  },
  score(acres: number) {
    const n = Math.min(acres, 6);
    for (let i = 0; i < n; i++) tone(440 * Math.pow(1.18, i), 0.18, "triangle", 0.12, i * 0.07);
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, "triangle", 0.13, i * 0.12));
  },
};
