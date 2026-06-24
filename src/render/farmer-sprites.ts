/**
 * Farmer character sheet — 4 farmer kits (one per livestock), each with an
 * idle/walk cycle drawn from the new sprite sheet.
 *
 * Sheet: public/sprites/farmers.webp — 1024x1024 transparent webp, 8 columns
 * x 6 rows. Cells are non-square (~128w x 170h) because the characters are
 * humanoid. Frame index = row*8 + col (0-based).
 *
 * Row mapping (rows 0-indexed):
 *   0 — Buck (cow / "Farmer Jack"), idle/walk poses
 *   1 — Buck action poses (tools, planting)
 *   2 — Sunny (sheep / "Farmer Molly")
 *   3 — Pop (gnome) — UNUSED
 *   4 — Mae (pig / "Farmer Rosie")
 *   5 — Nan (chicken / "Farmer Billy")
 */
const COLS = 8;
// The artist did not lay sprites on a uniform grid — rows + columns sit at
// hand-placed origins. Use the per-row/per-column bboxes detected from the
// sheet so each frame crops tightly around its character.
const ROW_BOX: Array<[number, number]> = [
  [19, 163],
  [180, 317],
  [333, 476],
  [492, 629],
  [642, 783],
  [797, 956],
];
const COL_BOX: Array<[number, number]> = [
  [32, 125],
  [153, 251],
  [272, 368],
  [388, 489],
  [517, 612],
  [636, 733],
  [761, 858],
  [885, 982],
];

interface FarmerFrames {
  /** Source-sheet rows this farmer occupies, top to bottom. */
  rows: number[];
  /** Frame indices used for each cycle (relative to row*8+col absolute). */
  idle: number[];
  walk: number[];
  action: number[];
  happy: number[];
}

// Frame numbering: idx = row*8 + col.
// Within each character's row(s) the 8 cells run left-to-right. The poses
// aren't strictly ordered, so we cherry-pick frames that read well as each
// animation state. Reuse frames freely — a 4-frame walk with two distinct
// poses cycling looks alive.
const FARMERS: Record<string, FarmerFrames> = {
  // jack — Buck (rows 0 + 1, 16 frames)
  jack: {
    rows: [0, 1],
    idle: [0, 1],
    walk: [2, 3, 4, 5],
    action: [10, 11, 8, 9], // row 1: tool / planting poses
    happy: [12, 13, 14, 15], // row 1 tail: hands-up / wave
  },
  // molly — Sunny (row 2)
  molly: {
    rows: [2],
    idle: [16, 17],
    walk: [18, 19, 20, 21],
    action: [22, 23, 22, 23],
    happy: [22, 23, 22, 23],
  },
  // rosie — Mae (row 4)
  rosie: {
    rows: [4],
    idle: [32, 33],
    walk: [34, 35, 36, 37],
    action: [38, 39, 38, 39],
    happy: [38, 39, 38, 39],
  },
  // billy — Nan (row 5)
  billy: {
    rows: [5],
    idle: [40, 41],
    walk: [42, 43, 44, 45],
    action: [46, 47, 46, 47],
    happy: [46, 47, 46, 47],
  },
};

const SRC = "/sprites/farmers.webp";

class FarmerSprites {
  private img = new Image();
  private loaded = false;

  constructor() {
    this.img.onload = () => {
      this.loaded = this.img.width > 0;
    };
    this.img.onerror = () => {
      this.loaded = false;
    };
    this.img.src = SRC;
  }

  ready(farmerId: string): boolean {
    return this.loaded && farmerId in FARMERS;
  }

  knows(farmerId: string): boolean {
    return farmerId in FARMERS;
  }

  /** Absolute frame index for a farmer in a given state at time t (ms). */
  frame(farmerId: string, state: "idle" | "walk" | "action" | "happy", timeMs: number, phase = 0): number {
    const f = FARMERS[farmerId];
    if (!f) return 0;
    const seq = f[state];
    const fps = state === "walk" ? 7 : state === "happy" ? 6 : state === "action" ? 5 : 1.5;
    const i = Math.floor((timeMs / 1000) * fps + phase * seq.length);
    return seq[((i % seq.length) + seq.length) % seq.length];
  }

  /**
   * Draw a frame into a destination rect. Maintains the sprite's aspect
   * ratio by fitting it inside (dx,dy,dw,dh) centred horizontally and
   * baseline-aligned to the bottom so the farmer's feet sit on the floor.
   * If `crop` is set to "head" the top of the cell is sampled (good for
   * tiny chip avatars where the body would render too small).
   */
  drawFrame(
    ctx: CanvasRenderingContext2D,
    farmerId: string,
    frame: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    crop: "full" | "head" = "full",
  ): void {
    if (!this.loaded) return;
    const col = frame % COLS;
    const row = Math.floor(frame / COLS);
    const [x0, x1] = COL_BOX[col];
    const [y0, y1] = ROW_BOX[row];
    let sx = x0;
    let sy = y0;
    let srcW = x1 - x0 + 1;
    let srcH = y1 - y0 + 1;
    if (crop === "head") {
      // top 55% of the bbox is the head + shoulders
      srcH = Math.round(srcH * 0.55);
    }
    // fit (srcW x srcH) into (dw x dh) keeping aspect; centre horizontally,
    // bottom-align vertically so feet/grounding are stable
    const scale = Math.min(dw / srcW, dh / srcH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const drawX = dx + (dw - drawW) / 2;
    const drawY = dy + (dh - drawH);
    ctx.drawImage(this.img, sx, sy, srcW, srcH, drawX, drawY, drawW, drawH);
    void farmerId; // available for future per-farmer offset tuning
  }
}

let shared: FarmerSprites | null = null;
export function getFarmerSprites(): FarmerSprites {
  return (shared ??= new FarmerSprites());
}

export type FarmerState = "idle" | "walk" | "action" | "happy";
