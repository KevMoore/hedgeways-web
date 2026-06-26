import { getSprites, prefersReducedMotion, type AnimalState } from "../render/sprites";

interface CritterOpts {
  size: number;
  state?: AnimalState; // default idle
  phase?: number;
  facing?: 1 | -1; // -1 mirrors (sheets face right)
}

/** A mounted sprite whose state + facing can be driven over time. */
export interface CritterHandle {
  el: HTMLCanvasElement;
  dispose: () => void;
  setState: (s: AnimalState) => void;
  setFacing: (f: 1 | -1) => void;
}

/**
 * Mount a single animated livestock sprite into a host element. Returns a
 * handle with dispose()/setState()/setFacing(). Falls back to the emoji until
 * the sheet decodes. Shared by the home chips, end-screen tableau, farm scene.
 */
export function mountCritter(host: HTMLElement, animal: string, opts: CritterOpts): CritterHandle {
  const sprites = getSprites();
  const reduce = prefersReducedMotion();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = opts.size;
  let curState = opts.state ?? "idle";
  let curFacing = opts.facing ?? 1;
  const phase = opts.phase ?? Math.random();
  const cv = document.createElement("canvas");
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  cv.style.width = `${size}px`;
  cv.style.height = `${size}px`;
  cv.style.display = "block";
  const ctx = cv.getContext("2d")!;
  ctx.scale(dpr, dpr);
  host.appendChild(cv);

  let raf = 0;
  let alive = true;
  const loop = (t: number) => {
    if (!alive) return;
    if (sprites.ready(animal)) {
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.translate(size / 2, 0);
      ctx.scale(curFacing, 1);
      sprites.draw(ctx, animal, reduce ? "idle" : curState, reduce ? 0 : t, phase, 0, size / 2, size);
      ctx.restore();
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return {
    el: cv,
    dispose: () => {
      alive = false;
      cancelAnimationFrame(raf);
      cv.remove();
    },
    setState: (s) => (curState = s),
    setFacing: (f) => (curFacing = f),
  };
}

/**
 * Animate the four livestock chips on the home screen with the real sprites
 * (gentle idle/graze loop). Falls back to the emoji until the sheet loads.
 * Returns a stop() to cancel the loop when leaving the screen.
 */
export function mountHomeCritters(spans: HTMLElement[]): () => void {
  const sprites = getSprites();
  const reduce = prefersReducedMotion();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const SIZE = 40;

  const items = spans.map((el) => {
    const animal = el.dataset.animal || "";
    el.textContent = animal; // emoji fallback until the sheet loads
    const cv = document.createElement("canvas");
    cv.width = SIZE * dpr;
    cv.height = SIZE * dpr;
    cv.style.width = `${SIZE}px`;
    cv.style.height = `${SIZE}px`;
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    return { animal, el, cv, ctx, phase: Math.random(), appended: false };
  });

  let alive = true;
  let raf = 0;
  const loop = () => {
    if (!alive) return;
    const t = performance.now();
    for (const it of items) {
      if (!sprites.ready(it.animal)) continue;
      if (!it.appended) {
        it.el.textContent = "";
        it.el.appendChild(it.cv);
        it.appended = true;
      }
      it.ctx.clearRect(0, 0, SIZE, SIZE);
      const phase = it.phase;
      // mostly idle, an occasional graze for a touch of life
      const grazing = !reduce && Math.floor(t / 2600 + phase * 5) % 3 === 0;
      sprites.draw(it.ctx, it.animal, grazing ? "graze" : "idle", reduce ? 0 : t, phase, SIZE / 2, SIZE / 2 + 1, SIZE - 4);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
  };
}
