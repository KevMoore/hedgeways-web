/**
 * Animated livestock sprites — one AutoSprite-generated sheet per animal per
 * animation state, sliced via the shared atlas core (see sprite-atlas.ts).
 * Frame geometry lives in sprite-manifest.ts (generated from AutoSprite's atlas
 * metadata); there are no hand-tuned grids here. Until a sheet loads the caller
 * falls back to the emoji.
 */
import { SpriteSet, prefersReducedMotion, type SpriteState } from "./sprite-atlas";
import { ANIMAL_SHEETS } from "./sprite-manifest";

export { prefersReducedMotion };

/** Behaviour states the renderer asks for; "graze" maps to the action sheet. */
export type AnimalState = "walk" | "graze" | "idle" | "happy";

export class Sprites {
  private sets = new Map<string, SpriteSet>();

  private set(animal: string): SpriteSet | undefined {
    if (!(animal in ANIMAL_SHEETS)) return undefined;
    let s = this.sets.get(animal);
    if (!s) {
      s = new SpriteSet(ANIMAL_SHEETS[animal]);
      this.sets.set(animal, s);
    }
    return s;
  }

  ready(animal: string): boolean {
    return this.set(animal)?.ready() ?? false;
  }

  /** Draw the current frame for an animal/state, centred in a size box at (cx,cy). */
  draw(
    ctx: CanvasRenderingContext2D,
    animal: string,
    state: AnimalState,
    timeMs: number,
    phase: number,
    cx: number,
    cy: number,
    size: number,
  ): void {
    const s = this.set(animal);
    if (!s) return;
    const mapped: SpriteState = state === "graze" ? "action" : state;
    s.drawCentred(ctx, mapped, timeMs, phase, cx, cy, size);
  }
}

// Share one instance (and its decoded sheets) across the home screen and game.
let shared: Sprites | null = null;
export function getSprites(): Sprites {
  return (shared ??= new Sprites());
}
