/**
 * Animated livestock sprite-sheet support.
 *
 * Sheet: public/sprites/livestock.webp — 1024x1024, an 8x8 grid of 128px cells.
 * The background is already keyed to true alpha transparency offline, so the
 * renderer draws it directly (no runtime flood-fill). Frame index = row*8 + col
 * (0-based), left->right, top->bottom. Each animal spans two rows: Idle1-2,
 * Walk1-4, Action1-4 (peck/eat/graze), Happy1-4. Until the sheet loads the
 * renderer falls back to the animated emoji.
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

const SRC = "/sprites/livestock.webp";

export class Sprites {
  private img = new Image();
  private loaded = false;
  private fw = 0;
  private fh = 0;

  constructor() {
    this.img.onload = () => {
      this.fw = this.img.width / COLS;
      this.fh = this.fw; // square cells
      this.loaded = this.fw > 0;
    };
    this.img.onerror = () => {
      this.loaded = false;
    };
    this.img.src = SRC;
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

  /** Draw a frame (by absolute index) centred in a size x size box at (cx,cy). */
  drawFrame(ctx: CanvasRenderingContext2D, frame: number, cx: number, cy: number, size: number): void {
    if (!this.loaded) return;
    const sx = (frame % COLS) * this.fw;
    const sy = Math.floor(frame / COLS) * this.fh;
    ctx.drawImage(this.img, sx, sy, this.fw, this.fh, cx - size / 2, cy - size / 2, size, size);
  }
}

// Share one decoded instance across the home screen and the game.
let shared: Sprites | null = null;
export function getSprites(): Sprites {
  return (shared ??= new Sprites());
}

/** SSR-safe reduced-motion probe, shared by the renderer and home critters. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
