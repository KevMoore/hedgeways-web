import { Sprites } from "../render/sprites";

/**
 * Animate the four livestock chips on the home screen with the real sprites
 * (gentle idle/graze loop). Falls back to the emoji until the sheet loads.
 * Returns a stop() to cancel the loop when leaving the screen.
 */
export function mountHomeCritters(spans: HTMLElement[]): () => void {
  const sprites = new Sprites();
  const reduce =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      const frame = sprites.frame(it.animal, grazing ? "graze" : "idle", reduce ? 0 : t, phase);
      sprites.drawFrame(it.ctx, frame, SIZE / 2, SIZE / 2 + 1, SIZE - 4);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
  };
}
