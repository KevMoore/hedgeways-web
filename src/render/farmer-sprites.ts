/**
 * Farmer character sprites — one AutoSprite-generated sheet per farmer per
 * animation state, sliced via the shared atlas core (see sprite-atlas.ts).
 * Frame geometry lives in sprite-manifest.ts (generated from AutoSprite's atlas
 * metadata); the old hand-tuned ROW_BOX/COL_BOX tables are gone.
 *
 * Farmer ids: jack (cow), molly (sheep), rosie (pig), billy (chicken).
 */
import { SpriteSet, type SpriteState } from "./sprite-atlas";
import { FARMER_SHEETS } from "./sprite-manifest";

export type FarmerState = SpriteState; // "idle" | "walk" | "action" | "happy"

class FarmerSprites {
  private sets = new Map<string, SpriteSet>();

  knows(farmerId: string): boolean {
    return farmerId in FARMER_SHEETS;
  }

  private set(farmerId: string): SpriteSet | undefined {
    if (!(farmerId in FARMER_SHEETS)) return undefined;
    let s = this.sets.get(farmerId);
    if (!s) {
      s = new SpriteSet(FARMER_SHEETS[farmerId]);
      this.sets.set(farmerId, s);
    }
    return s;
  }

  ready(farmerId: string): boolean {
    return this.set(farmerId)?.ready() ?? false;
  }

  /**
   * Draw the current frame fitted into (dx,dy,dw,dh), bottom-aligned so feet
   * sit on the floor. crop="head" samples the top of the cell for tiny chips.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    farmerId: string,
    state: FarmerState,
    timeMs: number,
    phase: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    crop: "full" | "head" = "full",
  ): void {
    const s = this.set(farmerId);
    if (!s) return;
    s.drawFitted(ctx, state, timeMs, phase, dx, dy, dw, dh, crop);
  }
}

let shared: FarmerSprites | null = null;
export function getFarmerSprites(): FarmerSprites {
  return (shared ??= new FarmerSprites());
}
