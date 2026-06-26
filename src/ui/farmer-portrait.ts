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
  /** -1 mirrors horizontally (sheets face right) so the farmer can face left */
  facing?: 1 | -1;
}

interface MountedFarmer {
  el: HTMLCanvasElement;
  dispose: () => void;
  setState: (s: FarmerState) => void;
  setFacing: (f: 1 | -1) => void;
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

  let curState: FarmerState = opts.state ?? "idle";
  let curFacing = opts.facing ?? 1;
  const crop = opts.crop ?? "full";
  const phase = opts.phase ?? Math.random();

  let rafId = 0;

  const draw = (t: number) => {
    // small vertical bob on idle so the chip feels alive even when static
    const bob = curState === "idle" ? Math.sin(t / 700 + phase * 6.28) * size * 0.025 : 0;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    if (curFacing === -1) {
      ctx.translate(size, 0);
      ctx.scale(-1, 1);
    }
    sprites.draw(ctx, farmerId, curState, t, phase, 0, bob, size, size, crop);
    ctx.restore();
  };

  let prevReady = false;
  const loop = (t: number) => {
    if (!prevReady && sprites.ready(farmerId)) prevReady = true;
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
    },
    setState: (s) => (curState = s),
    setFacing: (f) => (curFacing = f),
  };
}
