/**
 * The start-screen "living pasture": a depth-layered farm scene behind the
 * centred panel. Soft hills + barn + sun behind; a far field (small/faint) and
 * near field (big) of characters in front; the page's .hedgerow is the
 * foreground.
 *
 * Each character runs a little behaviour "brain" that cycles its four sprite
 * states into a believable workday — farmers walk, hoe, cheer, then rest;
 * animals wander, graze, rest, and now and then do a happy hop. Walkers pace
 * within the scene and turn at the edges. Reduced-motion freezes everything
 * into a calm tableau; narrow screens thin the cast and drop the barn.
 */
import { mountCritter, type CritterHandle } from "./home-critters";
import { mountFarmerPortrait } from "./farmer-portrait";
import { prefersReducedMotion } from "../render/sprites";
import { getFarmerSprites } from "../render/farmer-sprites";
import { FARMERS } from "../game/constants";

interface Phase {
  state: string;
  min: number; // seconds
  max: number;
  move?: boolean;
  chance?: number; // 0..1 probability the phase runs this cycle (default 1)
}

// Farmer workday: stroll → hoe the soil → satisfied cheer → rest.
const FARMER_PHASES: Phase[] = [
  { state: "walk", min: 2.5, max: 5, move: true },
  { state: "action", min: 3, max: 5 },
  { state: "happy", min: 1.2, max: 2, chance: 0.7 },
  { state: "idle", min: 1.5, max: 3 },
];
// Animal life: wander → graze → rest → occasional happy hop.
const ANIMAL_PHASES: Phase[] = [
  { state: "walk", min: 2, max: 4, move: true },
  { state: "graze", min: 3, max: 6 },
  { state: "idle", min: 1, max: 2.5 },
  { state: "happy", min: 0.8, max: 1.5, chance: 0.5 },
];

interface Brain {
  ctrl: { setState: (s: string) => void; setFacing: (f: 1 | -1) => void };
  wrap: HTMLElement;
  phases: Phase[];
  idx: number;
  tLeft: number;
  x: number;
  size: number;
  dir: 1 | -1;
  speed: number;
  moving: boolean;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

const barnSvg = () => `
  <svg viewBox="0 0 120 100" width="100%" height="100%" aria-hidden="true">
    <rect x="20" y="44" width="80" height="52" fill="#b8483f"/>
    <rect x="20" y="44" width="80" height="52" fill="none" stroke="#933" stroke-width="2"/>
    <path d="M14,46 L60,16 L106,46 Z" fill="#8f3a33"/>
    <rect x="52" y="62" width="16" height="34" fill="#f3ead7"/>
    <path d="M52,62 L68,62 M60,62 L60,96 M52,79 L68,79" stroke="#b8483f" stroke-width="2"/>
    <rect x="28" y="52" width="13" height="13" fill="#f3ead7"/>
    <rect x="79" y="52" width="13" height="13" fill="#f3ead7"/>
    <path d="M54,28 L66,28 M60,22 L60,40" stroke="#f3ead7" stroke-width="2"/>
  </svg>`;

const hillsSvg = (fill: string, path: string) =>
  `<svg class="fs-hill" viewBox="0 0 1440 240" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="${fill}"/></svg>`;

// the game's link palette (kept in step with constants.ts COLOUR_HEX) — used
// for the COLOURED fences. Hedges themselves are green and leafy.
const LINK: Record<string, string> = { G: "#6cc24a", Y: "#f5a623", B: "#29abe2", P: "#e83e8c" };
const LINK_DARK: Record<string, string> = { G: "#4e9a34", Y: "#d4861a", B: "#1d87b8", P: "#c22d72" };

/** A leafy green hedge: a scalloped bushy row in layered greens. */
const hedgeSvg = () => {
  const bumps = 5;
  const seg = 24;
  const top = 28;
  const peak = 8;
  const scallop = (offY: number) => {
    let d = `M0,48 L0,${top - offY}`;
    for (let i = 0; i < bumps; i++) d += ` Q${i * seg + seg / 2},${peak - offY} ${(i + 1) * seg},${top - offY}`;
    return d + ` L120,48 Z`;
  };
  let dabs = "";
  for (let i = 0; i < bumps; i++) {
    dabs += `<circle cx="${i * seg + seg / 2}" cy="${peak + 6}" r="4.5" fill="#86cd5a"/>`;
    dabs += `<circle cx="${i * seg + 6}" cy="${top - 4}" r="3" fill="#4f9a34"/>`;
  }
  return `<svg viewBox="0 0 120 50" width="100%" height="100%" aria-hidden="true">
    <path d="${scallop(4)}" fill="#3c7a2b"/>
    <path d="${scallop(0)}" fill="#58a53a"/>
    ${dabs}
    <rect x="0" y="43" width="120" height="7" rx="3" fill="#356d27"/>
  </svg>`;
};

/** A post-and-rail fence painted in one of the game's link colours. */
const fenceSvg = (c: string) => {
  const col = LINK[c];
  const dk = LINK_DARK[c];
  return `<svg viewBox="0 0 84 40" width="100%" height="100%" aria-hidden="true">
    <rect x="7" y="6" width="8" height="33" rx="2" fill="${dk}"/>
    <rect x="40" y="6" width="8" height="33" rx="2" fill="${dk}"/>
    <rect x="69" y="6" width="8" height="33" rx="2" fill="${dk}"/>
    <rect x="0" y="13" width="84" height="6" rx="3" fill="${col}"/>
    <rect x="0" y="26" width="84" height="6" rx="3" fill="${col}"/>
  </svg>`;
};

export function mountFarmScene(host: HTMLElement): () => void {
  const reduce = prefersReducedMotion();
  const vw = () => host.clientWidth || window.innerWidth;
  const narrow = vw() < 620;

  host.innerHTML = `
    <div class="fs-sun"></div>
    ${hillsSvg("#d2e7b6", "M0,240 L0,150 C240,96 480,176 720,128 C960,84 1200,168 1440,116 L1440,240 Z")}
    ${hillsSvg("#bcdc98", "M0,240 L0,188 C300,150 540,202 800,168 C1080,134 1260,196 1440,172 L1440,240 Z")}
    ${narrow ? "" : `<div class="fs-barn">${barnSvg()}</div>`}
    <div class="fs-field fs-far"></div>
    <div class="fs-field fs-near"></div>`;

  const far = host.querySelector<HTMLElement>(".fs-far")!;
  const near = host.querySelector<HTMLElement>(".fs-near")!;
  const handles: { dispose: () => void }[] = [];
  const brains: Brain[] = [];

  // Green hedges + colour-coded fences dressing the field — added first so the
  // characters walk in front. All four link colours appear across the fences.
  const addDeco = (layer: HTMLElement, xPct: number, widthPx: number, svg: string, cls: string) => {
    const el = document.createElement("div");
    el.className = cls;
    el.style.left = `${xPct}%`;
    el.style.width = `${widthPx}px`;
    el.innerHTML = svg;
    layer.appendChild(el);
  };
  addDeco(far, 20, 92, hedgeSvg(), "fs-hedge");
  if (!narrow) addDeco(far, 50, 62, fenceSvg("Y"), "fs-fence");
  if (!narrow) addDeco(far, 76, 58, fenceSvg("G"), "fs-fence");
  addDeco(near, 40, 150, hedgeSvg(), "fs-hedge");
  addDeco(near, 66, 92, fenceSvg("B"), "fs-fence"); // shown on mobile — vivid vs the green hedges
  if (!narrow) addDeco(near, 87, 84, fenceSvg("P"), "fs-fence");

  type Def = { layer: "far" | "near"; animal?: string; farmer?: string; size: number; mobile?: boolean };
  // a random four of the eight farmers each load — so everyone turns up across
  // visits without crowding the band
  const fids = FARMERS.map((f) => f.id).sort(() => Math.random() - 0.5);
  const cast: Def[] = [
    { layer: "near", farmer: fids[0], size: 66, mobile: true },
    { layer: "near", farmer: fids[1], size: 62, mobile: true },
    { layer: "near", animal: "🐮", size: 60, mobile: true },
    { layer: "near", animal: "🐷", size: 54 },
    { layer: "far", farmer: fids[2], size: 46, mobile: true },
    { layer: "far", farmer: fids[3], size: 44, mobile: true },
    { layer: "far", animal: "🐑", size: 40, mobile: true },
    { layer: "far", animal: "🐓", size: 34 },
  ];

  const enterPhase = (b: Brain, initial = false) => {
    for (let tries = 0; tries < b.phases.length; tries++) {
      b.idx = initial && tries === 0 ? b.idx : (b.idx + 1) % b.phases.length;
      const p = b.phases[b.idx];
      if (p.chance != null && Math.random() > p.chance) continue;
      b.tLeft = initial ? rnd(p.min * 0.2, p.max) : rnd(p.min, p.max);
      b.moving = !!p.move;
      if (p.move) {
        b.dir = Math.random() < 0.5 ? 1 : -1;
        b.ctrl.setFacing(b.dir);
      }
      b.ctrl.setState(p.state);
      return;
    }
    b.tLeft = 2;
    b.moving = false;
    b.ctrl.setState("idle");
  };

  for (const d of cast) {
    if (narrow && !d.mobile) continue;
    if (d.farmer && !getFarmerSprites().knows(d.farmer)) continue;
    const layerEl = d.layer === "far" ? far : near;
    const wrap = document.createElement("div");
    wrap.className = "fs-actor";
    layerEl.appendChild(wrap);

    let ctrl: { setState: (s: string) => void; setFacing: (f: 1 | -1) => void };
    if (d.farmer) {
      const h = mountFarmerPortrait(wrap, d.farmer, {
        size: d.size,
        state: reduce ? "idle" : "idle",
        crop: "full",
        static: reduce,
        phase: Math.random(),
      });
      if (!h) {
        wrap.remove();
        continue;
      }
      handles.push(h);
      ctrl = { setState: (s) => h.setState(s as never), setFacing: h.setFacing };
    } else {
      const h: CritterHandle = mountCritter(wrap, d.animal!, {
        size: d.size,
        state: reduce ? "graze" : "idle",
        phase: Math.random(),
      });
      handles.push(h);
      ctrl = { setState: (s) => h.setState(s as never), setFacing: h.setFacing };
    }

    const w = vw();
    const x = rnd(0, Math.max(1, w - d.size));
    wrap.style.transform = `translateX(${x}px)`;
    if (reduce) continue; // frozen tableau — no brain

    const b: Brain = {
      ctrl,
      wrap,
      phases: d.farmer ? FARMER_PHASES : ANIMAL_PHASES,
      idx: Math.floor(Math.random() * (d.farmer ? FARMER_PHASES : ANIMAL_PHASES).length),
      tLeft: 0,
      x,
      size: d.size,
      dir: Math.random() < 0.5 ? 1 : -1,
      speed: d.layer === "far" ? rnd(12, 20) : rnd(22, 34),
      moving: false,
    };
    enterPhase(b, true);
    brains.push(b);
  }

  let raf = 0;
  let last = 0;
  let alive = true;
  const loop = (t: number) => {
    if (!alive) return;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    const w = vw();
    for (const b of brains) {
      b.tLeft -= dt;
      if (b.tLeft <= 0) enterPhase(b);
      if (b.moving) {
        const minX = -b.size * 0.25;
        const maxX = w - b.size * 0.75;
        b.x += b.speed * b.dir * dt;
        if (b.x <= minX) {
          b.x = minX;
          b.dir = 1;
          b.ctrl.setFacing(1);
        } else if (b.x >= maxX) {
          b.x = maxX;
          b.dir = -1;
          b.ctrl.setFacing(-1);
        }
        b.wrap.style.transform = `translateX(${b.x}px)`;
      }
    }
    raf = requestAnimationFrame(loop);
  };
  if (brains.length) raf = requestAnimationFrame(loop);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    for (const h of handles) h.dispose();
    host.innerHTML = "";
  };
}
