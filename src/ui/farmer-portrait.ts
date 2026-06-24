import { getFarmerSprites, type FarmerState } from "../render/farmer-sprites";

interface MountOpts {
  /** Pixel size (canvas is drawn square at this size; aspect handled inside). */
  size: number;
  state?: FarmerState; // default: idle
  /** crop="head" focuses on head+shoulders — better for tiny chip avatars. */
  crop?: "full" | "head";
  /** disable raf loop (single static frame only). default: false */
  static?: boolean;
  /** randomised time offset so multiple chips don't tick in unison */
  phase?: number;
}

interface MountedFarmer {
  el: HTMLCanvasElement;
  dispose: () => void;
}

/**
 * Mount an animated farmer portrait into a host element. Returns the canvas
 * plus a `dispose` to stop the raf loop and remove the canvas. If the host
 * is re-rendered, callers MUST call dispose() before clearing innerHTML.
 */
export function mountFarmerPortrait(
  host: HTMLElement,
  farmerId: string,
  opts: MountOpts,
): MountedFarmer | null {
  const sprites = getFarmerSprites();
  if (!sprites.knows(farmerId)) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = opts.size;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = true;
  host.appendChild(canvas);

  const state: FarmerState = opts.state ?? "idle";
  const crop = opts.crop ?? "full";
  const phase = opts.phase ?? Math.random();

  let rafId = 0;
  let lastFrame = -1;
  let pulseT = 0; // for idle bob

  const draw = (t: number) => {
    const frame = sprites.frame(farmerId, state, t, phase);
    // small vertical bob on idle so the chip feels alive even when static
    const bob = state === "idle" ? Math.sin(t / 700 + phase * 6.28) * size * 0.025 : 0;
    if (frame !== lastFrame || state === "idle") {
      ctx.clearRect(0, 0, size, size);
      sprites.drawFrame(ctx, farmerId, frame, 0, bob, size, size, crop);
      lastFrame = frame;
    }
    pulseT = t;
  };

  let prevReady = false;
  const loop = (t: number) => {
    if (!prevReady && sprites.ready(farmerId)) {
      prevReady = true;
      lastFrame = -1; // force first draw when the sheet finishes loading
    }
    if (prevReady) draw(t);
    if (!opts.static) rafId = requestAnimationFrame(loop);
  };

  if (opts.static) {
    // schedule a single draw once the sheet is ready
    const tryDraw = (t: number) => {
      if (sprites.ready(farmerId)) draw(t);
      else rafId = requestAnimationFrame(tryDraw);
    };
    rafId = requestAnimationFrame(tryDraw);
  } else {
    rafId = requestAnimationFrame(loop);
  }

  return {
    el: canvas,
    dispose: () => {
      cancelAnimationFrame(rafId);
      canvas.remove();
      void pulseT;
    },
  };
}
