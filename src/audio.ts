/** WebAudio SFX (procedural) + looping music + subtle, random animal ambience. */
let ctx: AudioContext | null = null;
let enabled = true;

function ac(): AudioContext | null {
	if (!enabled) return null;
	if (!ctx) {
		try {
			ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
		} catch {
			enabled = false; // no WebAudio in this browser — stop retrying
			return null;
		}
	}
	if (ctx.state === 'suspended') void ctx.resume();
	return ctx;
}

function tone(
	freq: number,
	dur: number,
	type: OscillatorType,
	gain = 0.12,
	when = 0,
): void {
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

// ---- background music ----
let music: HTMLAudioElement | null = null;
function ensureMusic(): HTMLAudioElement {
	if (!music) {
		music = new Audio('/audio/wurzel-ridge-ramble.mp3');
		music.loop = true;
		music.volume = 0.18; // gentle background
	}
	return music;
}

// ---- animal samples (optional drop-ins) with a procedural fallback ----
const ANIMAL_FILE: Record<string, string> = {
	'🐷': 'pig',
	'🐮': 'cow',
	'🐑': 'sheep',
	'🐓': 'chicken',
};
const samples = new Map<string, { el: HTMLAudioElement; ok: boolean }>();
function sampleFor(
	emoji: string,
): { el: HTMLAudioElement; ok: boolean } | null {
	const name = ANIMAL_FILE[emoji];
	if (!name) return null;
	let s = samples.get(emoji);
	if (!s) {
		const el = new Audio(`/audio/animals/${name}.mp3`);
		s = { el, ok: false };
		el.addEventListener('canplaythrough', () => (s!.ok = true), { once: true });
		el.addEventListener('error', () => (s!.ok = false), { once: true });
		samples.set(emoji, s);
	}
	return s;
}

/** Procedural fallback calls — crude but recognisable, kept quiet + short. */
function synthAnimal(emoji: string): void {
	switch (emoji) {
		case '🐷': // oink-oink
			tone(170, 0.12, 'sawtooth', 0.05);
			tone(150, 0.12, 'sawtooth', 0.05, 0.16);
			break;
		case '🐮': // moo (falling)
			{
				const a = ac();
				if (!a) return;
				const t = a.currentTime;
				const o = a.createOscillator();
				const g = a.createGain();
				o.type = 'sine';
				o.frequency.setValueAtTime(160, t);
				o.frequency.exponentialRampToValueAtTime(110, t + 0.5);
				g.gain.setValueAtTime(0, t);
				g.gain.linearRampToValueAtTime(0.06, t + 0.05);
				g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
				o.connect(g).connect(a.destination);
				o.start(t);
				o.stop(t + 0.62);
			}
			break;
		case '🐑': // baa (with wobble)
			{
				const a = ac();
				if (!a) return;
				const t = a.currentTime;
				const o = a.createOscillator();
				const lfo = a.createOscillator();
				const lg = a.createGain();
				const g = a.createGain();
				o.type = 'sawtooth';
				o.frequency.value = 330;
				lfo.frequency.value = 18;
				lg.gain.value = 18;
				lfo.connect(lg).connect(o.frequency);
				g.gain.setValueAtTime(0, t);
				g.gain.linearRampToValueAtTime(0.045, t + 0.04);
				g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
				o.connect(g).connect(a.destination);
				lfo.start(t);
				o.start(t);
				o.stop(t + 0.42);
				lfo.stop(t + 0.42);
			}
			break;
		case '🐓': // cluck
			tone(900, 0.04, 'square', 0.04);
			tone(1150, 0.05, 'square', 0.04, 0.07);
			break;
	}
}

function playAnimal(emoji: string): void {
	if (!enabled) return;
	const s = sampleFor(emoji);
	if (s && s.ok) {
		const clip = s.el.cloneNode() as HTMLAudioElement;
		clip.volume = 0.22;
		clip.playbackRate = 0.92 + Math.random() * 0.16;
		void clip.play().catch(() => {});
	} else {
		synthAnimal(emoji);
	}
}

// ---- subtle, random ambience ----
let unlocked = false; // a user gesture has satisfied the autoplay policy
let ambientAnimals: string[] = [];
let ambientTimer: number | null = null;
function scheduleAmbient(): void {
	if (ambientTimer !== null) window.clearTimeout(ambientTimer);
	ambientTimer = window.setTimeout(
		() => {
			// random subtleness: not every tick fires, and only one animal at a time
			if (enabled && ambientAnimals.length && Math.random() < 0.65) {
				playAnimal(
					ambientAnimals[Math.floor(Math.random() * ambientAnimals.length)],
				);
			}
			scheduleAmbient();
		},
		5000 + Math.random() * 9000, // every 5-14s
	);
}
function stopAmbient(): void {
	if (ambientTimer !== null) {
		window.clearTimeout(ambientTimer);
		ambientTimer = null;
	}
}

export const sfx = {
	setEnabled(v: boolean) {
		enabled = v;
		const m = music;
		if (m) {
			if (v) void m.play().catch(() => {});
			else m.pause();
		}
	},
	isEnabled() {
		return enabled;
	},
	/** Call from a user gesture to satisfy autoplay policies (unlocks the audio ctx). */
	unlock() {
		unlocked = true;
		ac();
	},
	/** Start gameplay audio (music loop + animal ambience). Safe to call repeatedly. */
	startMusic() {
		if (!unlocked) return;
		if (enabled)
			void ensureMusic()
				.play()
				.catch(() => {});
		if (ambientTimer === null) scheduleAmbient();
	},
	/** Stop gameplay audio when leaving a game (back to the menu). */
	stopMusic() {
		music?.pause();
		stopAmbient();
	},
	/** The set of livestock currently grazing on the board (drives random ambience). */
	setAnimals(animals: Iterable<string>) {
		ambientAnimals = [...new Set(animals)];
	},
	/** One animal call, e.g. when a field is sealed. */
	celebrate(animal: string) {
		playAnimal(animal);
	},
	place() {
		tone(220 + Math.random() * 40, 0.12, 'triangle', 0.1);
	},
	pickup() {
		tone(520, 0.06, 'sine', 0.07);
	},
	rotate() {
		tone(380, 0.05, 'square', 0.05);
	},
	/** Tiny ascending two-note chime — played when a placed hedge sits next to
	 *  a matching-colour neighbour ("it clicked into place"). */
	connect() {
		tone(660, 0.07, 'triangle', 0.09);
		tone(990, 0.09, 'triangle', 0.07, 0.05);
	},
	/** Soft reverse-pickup tone — played when a tile is dragged back to the
	 *  hand and "un-played". */
	unplay() {
		tone(380, 0.06, 'sine', 0.06);
		tone(280, 0.08, 'sine', 0.05, 0.04);
	},
	/** Soft tile-drawn-from-bag tap — fires per tile in a staggered burst
	 *  when new hedges fly into the hand at turn start. */
	deal() {
		tone(820 + Math.random() * 80, 0.05, 'triangle', 0.06);
	},
	invalid() {
		// Cartoony donkey "hee-haw" for an illegal move — a saw-tone rising "hee"
		// followed immediately by a falling "haw". Sample at /audio/animals/donkey.mp3
		// would override, but the procedural version stands alone.
		const a = ac();
		if (!a) return;
		const now = a.currentTime;
		// Hee
		const hee = a.createOscillator();
		const hg = a.createGain();
		hee.type = 'sawtooth';
		hee.frequency.setValueAtTime(640, now);
		hee.frequency.linearRampToValueAtTime(720, now + 0.18);
		hg.gain.setValueAtTime(0, now);
		hg.gain.linearRampToValueAtTime(0.16, now + 0.02);
		hg.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
		hee.connect(hg).connect(a.destination);
		hee.start(now);
		hee.stop(now + 0.25);
		// Haw
		const haw = a.createOscillator();
		const hwg = a.createGain();
		haw.type = 'sawtooth';
		const hawT = now + 0.22;
		haw.frequency.setValueAtTime(220, hawT);
		haw.frequency.linearRampToValueAtTime(140, hawT + 0.34);
		hwg.gain.setValueAtTime(0, hawT);
		hwg.gain.linearRampToValueAtTime(0.2, hawT + 0.02);
		hwg.gain.exponentialRampToValueAtTime(0.001, hawT + 0.4);
		haw.connect(hwg).connect(a.destination);
		haw.start(hawT);
		haw.stop(hawT + 0.44);
	},
	score(acres: number) {
		const n = Math.min(acres, 6);
		for (let i = 0; i < n; i++)
			tone(440 * Math.pow(1.18, i), 0.18, 'triangle', 0.12, i * 0.07);
	},
	win() {
		[523, 659, 784, 1047].forEach((f, i) =>
			tone(f, 0.3, 'triangle', 0.13, i * 0.12),
		);
	},
	/** Rising arpeggio whose length grows with the streak level — juice for a combo. */
	streak(level: number) {
		const steps = Math.min(2 + level, 6);
		for (let i = 0; i < steps; i++)
			tone(523 * Math.pow(1.2, i), 0.16, 'square', 0.09, i * 0.06);
	},
};
