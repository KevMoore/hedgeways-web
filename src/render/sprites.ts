/**
 * Animated livestock sprite-sheet support.
 *
 * Sheet: public/sprites/livestock.png — 1024x1024, transparent, an 8x8 grid of
 * 128px cells. Frame index = row*8 + col (0-based), left->right, top->bottom.
 * Each animal spans two rows: Idle1-2, Walk1-4, Action1-4 (peck/eat/graze),
 * Happy1-4. Until the PNG loads the renderer falls back to the animated emoji.
 */
const COLS = 8;

interface AnimalFrames {
  idle: number[];
  walk: number[];
  action: number[]; // peck / eat / graze
  happy: number[];
}

// keyed by the player-kit emoji used throughout the game
const ANIMALS: Record<string, AnimalFrames> = {
  "🐓": { idle: [0, 1], walk: [2, 3, 4, 5], action: [6, 7, 8, 9], happy: [10, 11, 12, 13] },
  "🐷": { idle: [16, 17], walk: [18, 19, 20, 21], action: [22, 23, 24, 25], happy: [26, 27, 28, 29] },
  "🐑": { idle: [32, 33], walk: [34, 35, 36, 37], action: [38, 39, 40, 41], happy: [42, 43, 44, 45] },
  "🐮": { idle: [48, 49], walk: [50, 51, 52, 53], action: [54, 55, 56, 57], happy: [58, 59, 60, 61] },
};

const SRC = "/sprites/livestock.png";

export class Sprites {
  private img = new Image();
  private sheet: HTMLCanvasElement | null = null; // background-keyed copy we draw from
  private loaded = false;
  private fw = 0;
  private fh = 0;

  constructor() {
    this.img.onload = () => {
      this.fw = this.img.width / COLS;
      this.fh = this.fw; // square cells
      this.sheet = this.keyBackground();
      this.loaded = this.fw > 0 && this.sheet !== null;
    };
    this.img.onerror = () => {
      this.loaded = false;
    };
    this.img.src = SRC;
  }

  /**
   * The sheet is delivered opaque (baked transparency checkerboard), so make the
   * background transparent: flood-fill from each cell's corners, removing light,
   * near-neutral pixels. The animals' dark outlines block the flood, so their
   * white/cream fills are preserved.
   */
  private keyBackground(): HTMLCanvasElement | null {
    const w = this.img.width;
    const h = this.img.height;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(this.img, 0, 0);
    let data: ImageData;
    try {
      data = ctx.getImageData(0, 0, w, h);
    } catch {
      return cv; // canvas tainted (shouldn't happen for same-origin) — use as-is
    }
    const px = data.data;
    const isBg = (i: number) => {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      if (px[i + 3] === 0) return false; // already cleared
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return min > 184 && max - min < 34; // light + near-neutral = checkerboard
    };
    const stack: number[] = [];
    const fw = Math.round(this.fw);
    const fh = Math.round(this.fh);
    for (let cy = 0; cy < COLS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const x0 = cx * fw;
        const y0 = cy * fh;
        const x1 = Math.min(w, x0 + fw);
        const y1 = Math.min(h, y0 + fh);
        const seeds: [number, number][] = [
          [x0, y0],
          [x1 - 1, y0],
          [x0, y1 - 1],
          [x1 - 1, y1 - 1],
        ];
        for (const [sx, sy] of seeds) stack.push(sx, sy);
        while (stack.length) {
          const y = stack.pop()!;
          const x = stack.pop()!;
          if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
          const i = (y * w + x) * 4;
          if (!isBg(i)) continue;
          px[i + 3] = 0; // transparent (also marks visited)
          stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
        }
      }
    }
    ctx.putImageData(data, 0, 0);
    return cv;
  }

  ready(animal: string): boolean {
    return this.loaded && animal in ANIMALS;
  }

  /** Absolute frame index for an animal in a given behaviour state. */
  frame(animal: string, state: "walk" | "graze" | "idle" | "happy", timeMs: number, phase: number): number {
    const a = ANIMALS[animal];
    if (!a) return 0;
    const seq =
      state === "walk" ? a.walk : state === "graze" ? a.action : state === "happy" ? a.happy : a.idle;
    const fps = state === "walk" ? 8 : state === "graze" ? 6 : state === "happy" ? 9 : 2;
    const i = Math.floor((timeMs / 1000) * fps + phase * seq.length);
    return seq[((i % seq.length) + seq.length) % seq.length];
  }

  /** A celebratory "happy" frame (for freshly-claimed bursts). */
  happyFrame(animal: string, timeMs: number): number {
    const a = ANIMALS[animal];
    if (!a) return 0;
    const i = Math.floor((timeMs / 1000) * 8) % a.happy.length;
    return a.happy[i];
  }

  /** Draw a frame (by absolute index) centred in a size x size box at (cx,cy). */
  drawFrame(ctx: CanvasRenderingContext2D, frame: number, cx: number, cy: number, size: number): void {
    const src = this.sheet;
    if (!this.loaded || !src) return;
    const sx = (frame % COLS) * this.fw;
    const sy = Math.floor(frame / COLS) * this.fh;
    ctx.drawImage(src, sx, sy, this.fw, this.fh, cx - size / 2, cy - size / 2, size, size);
  }
}
