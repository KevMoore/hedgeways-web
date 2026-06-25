import {
  ACRE_HEX,
  BOARD_BG,
  COLOUR_HEX,
  HEDGE_BASE,
  HEDGE_DANGER,
  HEDGE_DANGER_DARK,
  HEDGE_DARK,
} from "../game/constants";
import type { Cell, Colour, PlacedCell } from "../game/types";
import { key } from "../game/types";
import { fields } from "../game/scoring";
import { makeRng } from "../game/rng";
import { getSprites, prefersReducedMotion } from "./sprites";

interface Ghost {
  cells: PlacedCell[];
  valid: boolean;
}

interface Critter {
  animal: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  state: "walk" | "graze" | "idle";
  until: number;
  walkStart: number; // for anti-stuck timeout
  happyUntil: number; // celebrate (jump) just after the field is sealed
  facing: number; // 1 right, -1 left
  phase: number;
}

const MIN_SCALE = 18;
const MAX_SCALE = 110;
const TAP_SLOP = 12; // px of finger drift still treated as a tap (not a pan)
const POP_MS = 320; // tile placement pop-in
const ACRE_POP_MS = 1300; // floating "+N acres" lifetime
const BURST_MS = 1100; // enclosure celebration spark lifetime
const IDLE_FRAME_MS = 1000 / 30; // cap ambient-livestock redraws at ~30fps

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  private cells = new Map<string, Cell>();
  private enclosed = new Set<string>();
  /** cell keys to pulse red — set when the engine rejects a Confirm. */
  private dangerCells = new Set<string>();
  /** cell key → start time, for the connect ring pulse */
  private connectFlash = new Map<string, number>();
  private CONNECT_FLASH_MS = 600;
  private ghost: Ghost | null = null;
  /** When true, mobile touch drags are in "lifted" mode — game-ui passes
   *  ghost cells that sit above the finger, and a subtle dot is drawn at
   *  the finger position. The lift math (cell offset) is exposed via
   *  liftedCellAt() so game-ui's input handlers and the renderer agree. */
  private touchGhostOffset = false;
  /** Finger cell to draw a small "you are here" dot during a touch drag. */
  private fingerMarker: { x: number; y: number } | null = null;
  /** Cached client point of the active drag — used to auto-pan the camera
   *  when the finger/cursor lingers near a canvas edge so the player can
   *  reach off-screen areas of large boards. Cleared on drag end. */
  private dragClient: { x: number; y: number } | null = null;
  /** perf.now() of the previous auto-pan tick — gives us frame-rate-
   *  independent pan speed without depending on Scene-wide lastT. */
  private autoPanLastT = 0;
  private highlights = new Map<string, Colour>(); // cell -> colour of the hedge segment that could sit there
  private flash = new Map<string, number>(); // cell -> start time
  private placedAt = new Map<string, number>(); // cell -> placement time (pop-in anim)
  private acres = new Map<string, { colour: string; animal: string }>(); // enclosed cell -> owner style
  private acrePops: { x: number; y: number; n: number; t0: number; animal: string }[] = [];
  private bursts: { x: number; y: number; vx: number; vy: number; t0: number; colour: string; emoji: string }[] = [];

  private scale = 56;
  private camX = 0; // world coords at canvas centre (rendered)
  private camY = 0;
  private tScale = 56; // camera targets (eased toward each frame)
  private tCamX = 0;
  private tCamY = 0;
  /** Set after the first syncBoard. A board that already has tiles on that
   *  first sync (a resumed / pre-loaded game) gets framed once; a fresh game
   *  that starts empty never force-zooms as it grows — it only nudges via
   *  ensureVisible() when a tile lands outside the viewport. A manual Fit
   *  (recenter) re-frames on demand. */
  private firstSyncDone = false;
  private needsDraw = true;
  private lastDraw = 0; // perf.now() of the previous draw (for idle-animation throttle)

  tapHandler: ((x: number, y: number) => void) | null = null;
  hoverHandler: ((x: number, y: number) => void) | null = null;
  leaveHandler: (() => void) | null = null;
  /** Pointer-down hook: return true to take over the gesture (e.g. picking up
   *  a pending tile to drag around the board). When this fires and returns
   *  true, the scene routes pointermove/pointerup to dragMove/dragEnd instead
   *  of panning. clientX/clientY are passed through so handlers can detect
   *  drop targets outside the canvas (e.g. the hand strip below the board). */
  dragStart:
    | ((cellX: number, cellY: number, clientX: number, clientY: number, isTouch: boolean) => boolean)
    | null = null;
  dragMove: ((cellX: number, cellY: number, clientX: number, clientY: number) => void) | null = null;
  dragEnd: ((cellX: number, cellY: number, clientX: number, clientY: number) => void) | null = null;
  /** Fires each frame the camera auto-pans during a drag, so game-ui can
   *  re-resolve the ghost cell from the cached client point (the cell under
   *  the finger shifts as the camera moves, even if the finger is still). */
  onAutoPan: ((clientX: number, clientY: number) => void) | null = null;
  /** World cell to anchor a floating rotate icon to (top-right corner of the
   *  cell). When null, no icon is drawn. */
  private rotateAt: { x: number; y: number } | null = null;
  /** Fires when the user taps the floating rotate icon. */
  rotateRequestHandler: (() => void) | null = null;
  /** Active smooth-rotation overlays. Each animates a tile's old cells
   *  through 90° around its anchor while the new cells stay hidden. */
  private rotateAnims: Array<{
    fromCells: PlacedCell[];
    toKeys: Set<string>;
    anchorWx: number;
    anchorWy: number;
    startTime: number;
  }> = [];
  private ROTATE_ANIM_MS = 220;
  private hoverCell = "";
  private rafId = 0;
  private alive = true;
  private onResize = () => this.resize();
  private t = 0; // current frame time, for idle animations
  private lastT = 0;
  private sprites = getSprites();
  private critters = new Map<string, Critter>(); // home-cell key -> roaming animal
  private critterComp = new Map<string, string[]>(); // enclosed cell -> its field's cells
  private reduceMotion = prefersReducedMotion();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.bindInput();
    this.resize();
    window.addEventListener("resize", this.onResize);
    const loop = () => {
      if (!this.alive) return;
      // Auto-pan FIRST so stepCamera can ease toward the freshly-nudged target
      // in the same frame; otherwise the player sees a one-frame lag at edges.
      const panned = this.maybeAutoPan();
      const moving = this.stepCamera();
      const now = performance.now();
      const transient =
        this.needsDraw ||
        this.flash.size ||
        this.acrePops.length ||
        this.bursts.length ||
        this.dangerCells.size > 0 ||
        this.ghost !== null || // pulse the held-tile ghost while it exists
        this.rotateAnims.length > 0 ||
        this.connectFlash.size > 0 ||
        panned ||
        this.animating();
      const idleAnimals = !this.reduceMotion && this.acres.size > 0;
      // Real-time animation (camera ease, acre pops, bursts) draws every frame.
      // Ambient livestock only needs ~30fps, so throttle that path to halve render
      // work on 60Hz displays (and cut it further on 120Hz) once a field is claimed.
      let drawNow = moving || transient;
      if (!drawNow && idleAnimals && now - this.lastDraw >= IDLE_FRAME_MS) drawNow = true;
      if (drawNow) {
        this.draw();
        this.lastDraw = now;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Ease the rendered camera toward its target. Returns true while still moving. */
  private stepCamera(): boolean {
    const e = 0.22;
    const dx = this.tCamX - this.camX;
    const dy = this.tCamY - this.camY;
    const ds = this.tScale - this.scale;
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3 && Math.abs(ds) < 0.04) {
      this.camX = this.tCamX;
      this.camY = this.tCamY;
      this.scale = this.tScale;
      return false;
    }
    this.camX += dx * e;
    this.camY += dy * e;
    this.scale += ds * e;
    return true;
  }

  /** Stop the render loop and detach listeners (call when the game is torn down). */
  destroy(): void {
    this.alive = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.onResize);
    this.tapHandler = null;
    this.hoverHandler = null;
    this.leaveHandler = null;
    this.dragStart = null;
    this.dragMove = null;
    this.dragEnd = null;
    this.onAutoPan = null;
    this.dragClient = null;
  }

  private animating(): boolean {
    if (this.placedAt.size === 0) return false;
    const now = performance.now();
    for (const t of this.placedAt.values()) if (now - t < POP_MS) return true;
    return false;
  }

  reset(): void {
    this.cells.clear();
    this.enclosed.clear();
    this.ghost = null;
    this.highlights.clear();
    this.flash.clear();
    this.placedAt.clear();
    this.acres.clear();
    this.acrePops = [];
    this.bursts = [];
    this.critters.clear();
    this.critterComp.clear();
    this.firstSyncDone = false;
    this.scale = this.tScale = 56;
    this.camX = this.tCamX = 0.5;
    this.camY = this.tCamY = 0.5;
    this.needsDraw = true;
  }

  syncBoard(
    cells: Map<string, Cell>,
    enclosed: Set<string>,
    acres?: Map<string, { colour: string; animal: string }>,
  ): void {
    // stamp cells that are newly on the board so they pop in
    const now = performance.now();
    for (const k of cells.keys()) if (!this.cells.has(k) && !this.placedAt.has(k)) this.placedAt.set(k, now);
    // forget pop timers for cells no longer present (undo)
    for (const k of [...this.placedAt.keys()]) if (!cells.has(k)) this.placedAt.delete(k);
    this.cells = new Map(cells);
    this.enclosed = new Set(enclosed);
    if (acres) this.acres = new Map(acres);
    this.rebuildCritters();
    // Frame a resumed/pre-loaded board once (tiles present on the very first
    // sync); otherwise only re-fit when a tile drifts off-screen, so a fresh
    // game never force-zooms as it grows. Manual recenter (Fit) overrides this.
    if (!this.firstSyncDone) {
      this.firstSyncDone = true;
      if (this.cells.size > 0) this.fitBoard();
      else this.ensureVisible();
    } else {
      this.ensureVisible();
    }
    this.needsDraw = true;
  }

  /** Keep ~one free-range animal per enclosed cell, grouped by field for roaming. */
  private rebuildCritters(): void {
    // connected components of the enclosed region (each = one field), using the
    // engine's own field grouping so the two never diverge
    this.critterComp = new Map();
    for (const group of fields(this.enclosed)) for (const c of group) this.critterComp.set(c, group);
    // drop critters whose home is no longer enclosed
    for (const home of [...this.critters.keys()]) if (!this.enclosed.has(home)) this.critters.delete(home);
    // spawn one per newly-claimed cell
    for (const k of this.enclosed) {
      const owner = this.acres.get(k);
      if (!owner || this.critters.has(k)) continue;
      const [x, y] = k.split(",").map(Number);
      // a freshly-claimed field: the animal hops with joy for a moment.
      // use the real clock (not this.t, which is stale before the first draw,
      // e.g. when syncBoard runs during a resume) so the jump actually fires.
      const happy = this.reduceMotion ? 0 : performance.now() + 1500 + Math.random() * 700;
      this.critters.set(k, {
        animal: owner.animal,
        x: x + 0.5,
        y: y + 0.5,
        tx: x + 0.5,
        ty: y + 0.5,
        state: "idle",
        until: happy + Math.random() * 800,
        walkStart: 0,
        happyUntil: happy,
        facing: Math.random() < 0.5 ? -1 : 1,
        phase: Math.random(),
      });
    }
  }

  private updateCritters(dt: number): void {
    const list = [...this.critters.values()];
    for (const c of list) {
      if (this.t < c.happyUntil) continue; // celebrating in place — hold position
      if (c.state === "walk") {
        const dx = c.tx - c.x;
        const dy = c.ty - c.y;
        const d = Math.hypot(dx, dy);
        const inField = (x: number, y: number) => this.enclosed.has(key(Math.floor(x), Math.floor(y)));
        if (d < 0.06 || this.t - c.walkStart > 4000) {
          // arrived, or anti-stuck timeout -> rest then pick a new target
          c.state = Math.random() < 0.6 ? "graze" : "idle";
          c.until = this.t + 800 + Math.random() * 2200;
        } else {
          const sp = Math.min(d, 0.0013 * dt);
          const ux = dx / d;
          const uy = dy / d;
          // try straight, then slide along a wall (x-only / y-only) for concave fields
          let moved = false;
          if (inField(c.x + ux * sp, c.y + uy * sp)) {
            c.x += ux * sp;
            c.y += uy * sp;
            moved = true;
          } else if (Math.abs(ux) > 0.01 && inField(c.x + ux * sp, c.y)) {
            c.x += ux * sp;
            moved = true;
          } else if (Math.abs(uy) > 0.01 && inField(c.x, c.y + uy * sp)) {
            c.y += uy * sp;
            moved = true;
          }
          if (moved) {
            if (Math.abs(dx) > 0.02) c.facing = dx < 0 ? -1 : 1;
          } else {
            c.state = "idle"; // boxed in this instant — rest briefly then retarget
            c.until = this.t + 250;
          }
        }
      } else if (this.t >= c.until) {
        const cells = this.critterComp.get(key(Math.floor(c.x), Math.floor(c.y)));
        if (cells && cells.length) {
          // prefer a nearby cell so paths rarely cross hedges
          const here = [Math.floor(c.x), Math.floor(c.y)];
          let pick = cells[Math.floor(Math.random() * cells.length)];
          for (let tries = 0; tries < 4; tries++) {
            const cand = cells[Math.floor(Math.random() * cells.length)];
            const [px, py] = cand.split(",").map(Number);
            if (Math.abs(px - here[0]) + Math.abs(py - here[1]) <= 4) {
              pick = cand;
              break;
            }
          }
          const [tx, ty] = pick.split(",").map(Number);
          c.tx = tx + 0.25 + Math.random() * 0.5;
          c.ty = ty + 0.25 + Math.random() * 0.5;
          c.state = "walk";
          c.walkStart = this.t;
        } else {
          c.until = this.t + 1000;
        }
      }
    }

    // basic collision: push overlapping animals apart (but never out of the field)
    const min = 0.38;
    const min2 = min * min;
    const inField = (x: number, y: number) => this.enclosed.has(key(Math.floor(x), Math.floor(y)));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 >= min2) continue;
        if (d2 < 1e-6) {
          dx = 0.01;
          dy = 0;
          d2 = 1e-4;
        }
        const d = Math.sqrt(d2);
        const overlap = min - d;
        const ux = dx / d;
        const uy = dy / d;
        const aCan = inField(a.x - ux * overlap, a.y - uy * overlap);
        const bCan = inField(b.x + ux * overlap, b.y + uy * overlap);
        // split the push normally; if one is wedged against a hedge, the other takes it all
        const aShare = aCan ? (bCan ? 0.5 : 1) : 0;
        const bShare = bCan ? (aCan ? 0.5 : 1) : 0;
        a.x -= ux * overlap * aShare;
        a.y -= uy * overlap * aShare;
        b.x += ux * overlap * bShare;
        b.y += uy * overlap * bShare;
      }
    }
  }

  private drawCritters(): void {
    const ctx = this.ctx;
    const size = this.scale * 0.46;
    const ordered = [...this.critters.values()].sort((a, b) => a.y - b.y); // back-to-front
    for (const c of ordered) {
      const [px, py] = this.worldToScreen(c.x, c.y);
      const happy = this.t < c.happyUntil;
      const frame = this.reduceMotion
        ? this.sprites.frame(c.animal, "idle", 0, c.phase)
        : this.sprites.frame(c.animal, happy ? "happy" : c.state, this.t, c.phase);
      const jump = happy && !this.reduceMotion ? -Math.abs(Math.sin(this.t / 110 + c.phase * 6)) * size * 0.3 : 0;
      ctx.save();
      ctx.translate(px, py + jump);
      if (c.facing < 0) ctx.scale(-1, 1); // sheet faces right
      this.sprites.drawFrame(ctx, frame, 0, 0, size);
      ctx.restore();
    }
  }

  /** Re-fit only if part of the board has drifted outside the viewport. */
  ensureVisible(): void {
    if (this.cells.size === 0) return;
    const { minX, minY, maxX, maxY } = this.boundsWithGhost();
    const vw = this.canvas.width / this.dpr;
    const vh = this.canvas.height / this.dpr;
    const [x0, y0] = this.worldToScreen(minX, minY);
    const [x1, y1] = this.worldToScreen(maxX + 1, maxY + 1);
    const pad = 8;
    if (x0 < pad || y0 < pad || x1 > vw - pad || y1 > vh - pad) this.fitBoard();
  }

  /** Manual recenter (e.g. a Fit button) — re-frames the whole board on demand. */
  recenter(): void {
    this.fitBoard();
  }

  private boundsWithGhost(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const consider = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const k of this.cells.keys()) {
      const [x, y] = k.split(",").map(Number);
      consider(x, y);
    }
    if (this.ghost) for (const c of this.ghost.cells) consider(c.x, c.y);
    return { minX, minY, maxX, maxY };
  }

  /** Game-ui calls this whenever the active drag's finger/cursor position
   *  changes (and with null on drag end). The scene uses the cached point
   *  to auto-pan the camera when the finger lingers near a canvas edge. */
  setDragClient(clientX: number | null, clientY = 0): void {
    if (clientX === null) {
      this.dragClient = null;
      this.autoPanLastT = 0;
    } else {
      this.dragClient = { x: clientX, y: clientY };
    }
  }

  /** Per-frame auto-pan: if a drag is active and the cached client point sits
   *  in an edge band of the canvas, push tCam* (and cam*) toward that edge.
   *  Speed is in screen pixels/ms so it feels the same at any zoom level. */
  private maybeAutoPan(): boolean {
    if (!this.dragClient) {
      this.autoPanLastT = 0;
      return false;
    }
    const rect = this.canvas.getBoundingClientRect();
    const x = this.dragClient.x - rect.left;
    const y = this.dragClient.y - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      this.autoPanLastT = 0;
      return false;
    }
    const margin = Math.min(rect.width, rect.height) * 0.18;
    let fx = 0;
    let fy = 0;
    if (x < margin) fx = -(1 - x / margin);
    else if (x > rect.width - margin) fx = 1 - (rect.width - x) / margin;
    if (y < margin) fy = -(1 - y / margin);
    else if (y > rect.height - margin) fy = 1 - (rect.height - y) / margin;
    if (fx === 0 && fy === 0) {
      this.autoPanLastT = 0;
      return false;
    }
    const now = performance.now();
    const dt = this.autoPanLastT === 0 ? 16 : Math.min(60, now - this.autoPanLastT);
    this.autoPanLastT = now;
    const speedPxPerMs = 0.45; // ~450 px/sec at max intensity
    const dxCells = (fx * speedPxPerMs * dt) / this.scale;
    const dyCells = (fy * speedPxPerMs * dt) / this.scale;
    this.camX += dxCells;
    this.camY += dyCells;
    this.tCamX += dxCells;
    this.tCamY += dyCells;
    this.needsDraw = true;
    if (this.onAutoPan) this.onAutoPan(this.dragClient.x, this.dragClient.y);
    return true;
  }

  /** Game-ui toggles this when a touch-initiated drag starts/ends. */
  setTouchGhostOffset(on: boolean): void {
    if (this.touchGhostOffset !== on) {
      this.touchGhostOffset = on;
      if (!on) this.fingerMarker = null;
      this.needsDraw = true;
    }
  }

  /** Game-ui sets the finger cell during a touch drag so the renderer can
   *  draw a small "you are here" dot offset from the lifted ghost. */
  setFingerMarker(cell: { x: number; y: number } | null): void {
    this.fingerMarker = cell;
    this.needsDraw = true;
  }

  /** Convert client coords to the cell where the LIFTED ghost should sit.
   *  When touch-mode is off, this is just the finger cell. When on, the ghost
   *  is offset PERPENDICULAR to the tile's long axis — a horizontal tile lifts
   *  up, a vertical tile slides to the side — so the finger never sits under
   *  the tile and the offset stays as small as possible (the tile is only one
   *  cell thick across its short axis). The offset flips away from the nearest
   *  canvas edge so the tile doesn't get pushed off-screen. */
  liftedCellAt(clientX: number, clientY: number, ori: "H" | "V"): {
    target: [number, number];
    finger: [number, number];
  } {
    const [fx, fy] = this.cellAtClient(clientX, clientY);
    if (!this.touchGhostOffset) return { target: [fx, fy], finger: [fx, fy] };
    const rect = this.canvas.getBoundingClientRect();
    const SEP = 2; // one clear cell between the finger and the tile's near edge
    if (ori === "H") {
      // horizontal tile (1 cell tall) → offset vertically; up by default, down
      // if the finger is near the top edge.
      const down = clientY - rect.top < rect.height * 0.3;
      return { target: [fx, down ? fy + SEP : fy - SEP], finger: [fx, fy] };
    }
    // vertical tile (1 cell wide) → offset sideways; left by default, right if
    // the finger is near the left edge. A small upward bias lifts it to sit
    // beside-and-slightly-above the finger rather than hanging straight down.
    const right = clientX - rect.left < rect.width * 0.3;
    const UP_BIAS = 1;
    return { target: [right ? fx + SEP : fx - SEP, fy - UP_BIAS], finger: [fx, fy] };
  }

  setGhost(cells: PlacedCell[] | null, valid: boolean): void {
    this.ghost = cells && cells.length ? { cells, valid } : null;
    this.needsDraw = true;
  }

  setHighlights(cells: Map<string, Colour>): void {
    this.highlights = new Map(cells);
    this.needsDraw = true;
  }

  /** Mark these cell keys as "in danger" — they pulse red until cleared. */
  setDangerCells(keys: Iterable<string>): void {
    this.dangerCells = new Set(keys);
    this.needsDraw = true;
  }

  /** Anchor the floating rotate icon at this world cell (top-right corner of
   *  the cell), or null to hide it. */
  setRotateAt(cell: { x: number; y: number } | null): void {
    this.rotateAt = cell;
    this.needsDraw = true;
  }

  /** Brief expanding ring on these cells — fired when a placed hedge sits
   *  next to a matching-colour neighbour. */
  flashConnections(cellKeys: Iterable<string>): void {
    const now = performance.now();
    for (const k of cellKeys) this.connectFlash.set(k, now);
    this.needsDraw = true;
  }

  /** Kick off a smooth 90° rotation of one pending tile. The old cells are
   *  rendered with a rotating canvas transform around their anchor; the new
   *  cells are hidden until the animation completes. */
  startRotateAnim(fromCells: PlacedCell[], toCells: PlacedCell[]): void {
    if (fromCells.length === 0) return;
    const anchor = fromCells[0]; // segment 0 — pivot point
    this.rotateAnims.push({
      fromCells: fromCells.map((c) => ({ ...c })),
      toKeys: new Set(toCells.map((c) => key(c.x, c.y))),
      anchorWx: anchor.x,
      anchorWy: anchor.y,
      startTime: performance.now(),
    });
    this.needsDraw = true;
  }

  /** Screen-space bounding box of the floating rotate icon (or null if not
   *  shown). Used by the tap handler to hit-test the icon. */
  private rotateIconRect(): { cx: number; cy: number; r: number } | null {
    if (!this.rotateAt) return null;
    // Anchor at the top-right corner of the cell (cell extends right+down
    // from its (x,y), so top-right = (x+1, y) in world space).
    const [sx, sy] = this.worldToScreen(this.rotateAt.x + 1, this.rotateAt.y);
    return { cx: sx, cy: sy, r: Math.max(18, this.scale * 0.32) };
  }

  /** Whether anything is currently flashing — used to keep the render loop
   *  ticking at the pulse rate even when the camera is still. */
  hasDanger(): boolean {
    return this.dangerCells.size > 0;
  }

  flashEnclosed(cells: Iterable<string>, animal = "", colour = "#ffd34d"): void {
    const now = performance.now();
    let sx = 0;
    let sy = 0;
    let n = 0;
    const rand = makeRng(hash(Math.round(now), n));
    for (const k of cells) {
      this.flash.set(k, now);
      const [x, y] = k.split(",").map(Number);
      sx += x;
      sy += y;
      n++;
    }
    if (n > 0) {
      const cx = sx / n + 0.5;
      const cy = sy / n + 0.5;
      this.acrePops.push({ x: cx, y: cy, n, t0: now, animal });
      // celebratory burst: coloured sparks + a couple of the farmer's animals
      const sparks = Math.min(8 + n, 22);
      for (let i = 0; i < sparks; i++) {
        const ang = rand() * Math.PI * 2;
        const spd = 0.04 + rand() * 0.07;
        const emoji = animal && i % 6 === 0 ? animal : "";
        this.bursts.push({ x: cx, y: cy, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 0.03, t0: now, colour, emoji });
      }
    }
    this.needsDraw = true;
  }

  resize(): void {
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1)); // may change across displays
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.needsDraw = true;
  }

  fitBoard(): void {
    // writes camera TARGETS; the render loop eases the rendered camera toward them
    if (this.cells.size === 0) {
      this.tCamX = 0.5;
      this.tCamY = 0.5;
      this.tScale = 56;
      this.needsDraw = true;
      return;
    }
    const { minX, minY, maxX, maxY } = this.boundsWithGhost();
    const wCells = maxX - minX + 1;
    const hCells = maxY - minY + 1;
    const pad = 1.5;
    const vw = this.canvas.width / this.dpr;
    const vh = this.canvas.height / this.dpr;
    const sx = vw / (wCells + pad * 2);
    const sy = vh / (hCells + pad * 2);
    this.tScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(sx, sy)));
    this.tCamX = (minX + maxX + 1) / 2;
    this.tCamY = (minY + maxY + 1) / 2;
    this.needsDraw = true;
  }

  // ---- transforms ----
  private worldToScreen(wx: number, wy: number): [number, number] {
    const vw = this.canvas.width / this.dpr;
    const vh = this.canvas.height / this.dpr;
    return [vw / 2 + (wx - this.camX) * this.scale, vh / 2 + (wy - this.camY) * this.scale];
  }
  private screenToCell(sx: number, sy: number): [number, number] {
    const vw = this.canvas.width / this.dpr;
    const vh = this.canvas.height / this.dpr;
    const wx = (sx - vw / 2) / this.scale + this.camX;
    const wy = (sy - vh / 2) / this.scale + this.camY;
    return [Math.floor(wx), Math.floor(wy)];
  }

  // ---- input ----
  private bindInput(): void {
    let down = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    let startX = 0;
    let startY = 0;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    /** Single-finger drag claimed by game-ui (e.g. picking up a pending tile).
     *  When set, pointermove/up route to dragMove/dragEnd instead of panning. */
    let claimedPointer = -1;
    /** Pointer currently pressing the floating rotate icon. */
    let rotatePointer = -1;

    const c = this.canvas;
    c.style.touchAction = "none";

    c.addEventListener("pointerdown", (e) => {
      // If a tile-drag or rotate-icon press is already in flight, ignore
      // any additional touches — they must not start a pan / pinch on top
      // of the active gesture.
      if (claimedPointer !== -1 || rotatePointer !== -1) return;
      // First-finger only: rotate-icon tap (highest priority — sits above
      // tiles and ghost). If this pointerdown lands on the icon, route the
      // gesture into rotate mode (no pan, no tile pickup).
      if (pointers.size === 0) {
        const ri = this.rotateIconRect();
        if (ri) {
          const rect = c.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          if (Math.hypot(px - ri.cx, py - ri.cy) <= ri.r + 8) {
            c.setPointerCapture(e.pointerId);
            rotatePointer = e.pointerId;
            return;
          }
        }
      }
      // First-finger only: let game-ui claim the gesture (pick up a pending).
      if (pointers.size === 0 && this.dragStart) {
        const rect = c.getBoundingClientRect();
        const [cx, cy] = this.screenToCell(e.clientX - rect.left, e.clientY - rect.top);
        if (this.dragStart(cx, cy, e.clientX, e.clientY, e.pointerType === "touch")) {
          c.setPointerCapture(e.pointerId);
          claimedPointer = e.pointerId;
          this.setDragClient(e.clientX, e.clientY); // arm edge-auto-pan
          return;
        }
      }
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = true;
      moved = false;
      lastX = startX = e.clientX;
      lastY = startY = e.clientY;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (claimedPointer === e.pointerId) {
        this.setDragClient(e.clientX, e.clientY); // keep auto-pan tracking
        if (this.dragMove) {
          const rect = c.getBoundingClientRect();
          const [cx, cy] = this.screenToCell(e.clientX - rect.left, e.clientY - rect.top);
          this.dragMove(cx, cy, e.clientX, e.clientY);
        }
        return;
      }
      if (!down) {
        // hover preview (desktop / pen — touch never fires move without a button)
        if (this.hoverHandler && e.pointerType !== "touch") {
          const rect = c.getBoundingClientRect();
          const [cx, cy] = this.screenToCell(e.clientX - rect.left, e.clientY - rect.top);
          const k = `${cx},${cy}`;
          if (k !== this.hoverCell) {
            this.hoverCell = k;
            this.hoverHandler(cx, cy);
          }
        }
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) this.zoomBy(d / pinchDist);
        pinchDist = d;
        moved = true;
        return;
      }
      // Don't pan until movement passes a finger-friendly threshold; below it the
      // gesture stays a tap (fixes "tapped a valid square but nothing placed" when a
      // finger drifts a few px) and the camera doesn't shift under the tap.
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < TAP_SLOP) {
        return;
      }
      if (!moved) {
        moved = true;
        lastX = e.clientX; // reset origin so the camera doesn't jump by the slop amount
        lastY = e.clientY;
        return;
      }
      this.camX -= (e.clientX - lastX) / this.scale;
      this.camY -= (e.clientY - lastY) / this.scale;
      this.tCamX = this.camX; // keep target synced so easing doesn't fight the drag
      this.tCamY = this.camY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.needsDraw = true;
    });
    const up = (e: PointerEvent) => {
      if (rotatePointer === e.pointerId) {
        rotatePointer = -1;
        // Fire if release is still inside the icon (cancel by drifting off).
        const ri = this.rotateIconRect();
        if (ri && this.rotateRequestHandler) {
          const rect = c.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          if (Math.hypot(px - ri.cx, py - ri.cy) <= ri.r + 12) this.rotateRequestHandler();
        }
        return;
      }
      if (claimedPointer === e.pointerId) {
        claimedPointer = -1;
        this.setDragClient(null); // disarm edge-auto-pan
        if (this.dragEnd) {
          const rect = c.getBoundingClientRect();
          const [cx, cy] = this.screenToCell(e.clientX - rect.left, e.clientY - rect.top);
          this.dragEnd(cx, cy, e.clientX, e.clientY);
        }
        return;
      }
      pointers.delete(e.pointerId);
      if (!down) return;
      down = pointers.size > 0;
      if (!moved && this.tapHandler) {
        const rect = c.getBoundingClientRect();
        const [cx, cy] = this.screenToCell(e.clientX - rect.left, e.clientY - rect.top);
        this.tapHandler(cx, cy);
      }
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", (e) => {
      if (rotatePointer === e.pointerId) {
        rotatePointer = -1;
        return;
      }
      if (claimedPointer === e.pointerId) {
        claimedPointer = -1;
        this.setDragClient(null);
        if (this.dragEnd) {
          const rect = c.getBoundingClientRect();
          const [cx, cy] = this.screenToCell(e.clientX - rect.left, e.clientY - rect.top);
          this.dragEnd(cx, cy, e.clientX, e.clientY);
        }
        return;
      }
      pointers.delete(e.pointerId);
    });
    c.addEventListener("pointerleave", () => {
      this.hoverCell = "";
      if (this.leaveHandler) this.leaveHandler();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      },
      { passive: false },
    );
  }

  private zoomBy(f: number): void {
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * f));
    this.tScale = this.scale; // immediate for user zoom
    this.needsDraw = true;
  }

  // ---- drawing ----
  private draw(): void {
    const ctx = this.ctx;
    // self-heal: if the backing store no longer matches the CSS box (mobile URL-bar
    // show/hide, late layout), the canvas gets stretched and cells look rectangular.
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw > 0 && ch > 0 && (Math.abs(this.canvas.width - cw * this.dpr) > 1 || Math.abs(this.canvas.height - ch * this.dpr) > 1)) {
      this.resize();
    }
    this.t = performance.now();
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    const vw = this.canvas.width / this.dpr;
    const vh = this.canvas.height / this.dpr;
    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, vw, vh);

    this.drawGrid(vw, vh);

    // enclosed acres
    for (const k of this.enclosed) {
      const [x, y] = k.split(",").map(Number);
      this.drawAcre(x, y);
    }
    // flashing newly-scored acres
    const now = performance.now();
    for (const [k, t0] of this.flash) {
      const age = now - t0;
      if (age > 900) {
        this.flash.delete(k);
        continue;
      }
      const [x, y] = k.split(",").map(Number);
      const a = 1 - age / 900;
      this.drawAcreFlash(x, y, a);
    }

    // purge finished rotation animations
    this.rotateAnims = this.rotateAnims.filter((a) => now - a.startTime < this.ROTATE_ANIM_MS);
    // cells currently animating a rotation — render via the rotated overlay, not here
    const rotateSkipKeys = new Set<string>();
    for (const a of this.rotateAnims) for (const k of a.toKeys) rotateSkipKeys.add(k);

    // tiles (with placement pop-in)
    for (const [k, cell] of this.cells) {
      if (rotateSkipKeys.has(k)) continue;
      const [x, y] = k.split(",").map(Number);
      const t0 = this.placedAt.get(k);
      let pop = 1;
      if (t0 !== undefined) {
        const p = (now - t0) / POP_MS;
        pop = p >= 1 ? 1 : easeOutBack(p);
      }
      const mask =
        (this.cells.has(key(x, y - 1)) ? 1 : 0) |
        (this.cells.has(key(x + 1, y)) ? 2 : 0) |
        (this.cells.has(key(x, y + 1)) ? 4 : 0) |
        (this.cells.has(key(x - 1, y)) ? 8 : 0);
      // Pulse a danger-marked cell red (engine rejected this placement at
      // Confirm). The pulse alternates ~2Hz so it's noticeable but not jarring.
      const danger = this.dangerCells.has(k) && Math.floor(now / 280) % 2 === 0;
      this.drawHedge(x, y, cell.colour, 1, danger, pop, mask);
    }

    // connect-flash: brief expanding ring on cells that "clicked" into place
    for (const [k, t0] of this.connectFlash) {
      const age = now - t0;
      if (age > this.CONNECT_FLASH_MS) {
        this.connectFlash.delete(k);
        continue;
      }
      const p = age / this.CONNECT_FLASH_MS;
      const [x, y] = k.split(",").map(Number);
      const [sx, sy] = this.worldToScreen(x, y);
      const cx = sx + this.scale / 2;
      const cy = sy + this.scale / 2;
      const r = this.scale * (0.45 + p * 0.55);
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.85;
      ctx.strokeStyle = "#ffd34d";
      ctx.lineWidth = Math.max(2, this.scale * 0.08 * (1 - p));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // smooth-rotation overlays — the OLD cells are drawn with the canvas
    // rotated around the anchor cell's centre. At t=0 the visual matches the
    // pre-rotation state; at t=1 it lines up exactly with the new positions.
    for (const a of this.rotateAnims) {
      const p = Math.min(1, (now - a.startTime) / this.ROTATE_ANIM_MS);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      const angle = eased * (Math.PI / 2);
      const [px, py] = this.worldToScreen(a.anchorWx, a.anchorWy);
      const acx = px + this.scale / 2;
      const acy = py + this.scale / 2;
      const fromKeys = new Set(a.fromCells.map((c) => key(c.x, c.y)));
      ctx.save();
      ctx.translate(acx, acy);
      ctx.rotate(angle);
      ctx.translate(-acx, -acy);
      for (const c of a.fromCells) {
        const mask =
          (fromKeys.has(key(c.x, c.y - 1)) ? 1 : 0) |
          (fromKeys.has(key(c.x + 1, c.y)) ? 2 : 0) |
          (fromKeys.has(key(c.x, c.y + 1)) ? 4 : 0) |
          (fromKeys.has(key(c.x - 1, c.y)) ? 8 : 0);
        this.drawHedge(c.x, c.y, c.colour, 1, false, 1, mask);
      }
      ctx.restore();
    }

    // free-range livestock roaming inside the fields (only if the sheet loaded)
    if (this.critters.size) {
      const dt = this.reduceMotion ? 0 : Math.min(60, now - this.lastT);
      if (dt > 0) this.updateCritters(dt);
      this.drawCritters();
    }

    // highlights — quiet hint that the selected tile could sit here (a small
    // colour dot in the centre, no hedge frame so the existing board stays clear)
    for (const [k, colour] of this.highlights) {
      const [x, y] = k.split(",").map(Number);
      const [hpx, hpy] = this.worldToScreen(x, y);
      const hs = this.scale;
      ctx.fillStyle = hexA(COLOUR_HEX[colour], 0.35);
      ctx.beginPath();
      ctx.arc(hpx + hs / 2, hpy + hs / 2, hs * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }

    // ghost — pulses gently to indicate it's the "selected / in-hand" tile.
    // The mask is computed from the ghost's OWN cells only — never the committed
    // board — so the held tile renders as a discrete floating hedge with full
    // outer puffs. (Merging its puffs into adjacent committed tiles made the
    // tile look like it was snapping/fusing onto them mid-drag.) It fuses for
    // real only once it's actually placed and becomes a board cell.
    if (this.ghost) {
      const gKeys = new Set(this.ghost.cells.map((c) => key(c.x, c.y)));
      const hasHedge = (x: number, y: number) => gKeys.has(key(x, y));
      // Soft 1.4Hz pulse: alpha breathes 0.45→0.75, scale 0.97→1.03.
      const pulse = (Math.sin(now / 220) + 1) / 2; // 0..1
      const ghostAlpha = this.ghost.valid ? 0.5 + pulse * 0.25 : 0.4;
      const ghostScale = this.ghost.valid ? 0.97 + pulse * 0.06 : 1;
      for (const c of this.ghost.cells) {
        const mask =
          (hasHedge(c.x, c.y - 1) ? 1 : 0) |
          (hasHedge(c.x + 1, c.y) ? 2 : 0) |
          (hasHedge(c.x, c.y + 1) ? 4 : 0) |
          (hasHedge(c.x - 1, c.y) ? 8 : 0);
        this.drawHedge(c.x, c.y, c.colour, ghostAlpha, !this.ghost.valid, ghostScale, mask);
      }
    }
    // Touch finger indicator — small ring at the actual finger cell during a
    // touch drag, so the player can tell where their finger is even though
    // the placement target is the lifted ghost above.
    if (this.fingerMarker) this.drawFingerDot(this.fingerMarker);

    // floating "+N acres" pops
    this.acrePops = this.acrePops.filter((p) => now - p.t0 < ACRE_POP_MS);
    for (const p of this.acrePops) {
      const age = (now - p.t0) / ACRE_POP_MS;
      const [px, py] = this.worldToScreen(p.x, p.y);
      const rise = 26 * age;
      const alpha = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
      const scale = age < 0.2 ? 0.6 + (age / 0.2) * 0.5 : 1.1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.translate(px, py - rise);
      ctx.scale(scale, scale);
      ctx.font = `800 ${Math.max(16, this.scale * 0.42)}px "Trebuchet MS", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = `${p.animal ? p.animal + " " : ""}+${p.n} acre${p.n === 1 ? "" : "s"}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(20,40,24,0.9)";
      ctx.strokeText(label, 0, 0);
      ctx.fillStyle = "#ffd34d";
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

    // celebration bursts (sparks + animals flying out from a sealed field)
    this.bursts = this.bursts.filter((b) => now - b.t0 < BURST_MS);
    for (const b of this.bursts) {
      const age = (now - b.t0) / BURST_MS;
      const t = (now - b.t0) / 16;
      const wx = b.x + b.vx * t;
      const wy = b.y + b.vy * t + 0.0009 * t * t; // gravity
      const [px, py] = this.worldToScreen(wx, wy);
      ctx.globalAlpha = Math.max(0, 1 - age);
      if (b.emoji) {
        ctx.font = `${Math.max(14, this.scale * 0.5)}px serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(b.emoji, px, py);
      } else {
        ctx.fillStyle = b.colour;
        const r = Math.max(2, this.scale * 0.08) * (1 - age * 0.5);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Floating rotate icon — drawn last so it sits above tiles and effects.
    const ri = this.rotateIconRect();
    if (ri) this.drawRotateIcon(ri.cx, ri.cy, ri.r);

    ctx.restore();
    this.needsDraw = false;
    this.lastT = this.t;
  }

  /** Draw a chunky "rotate" disc with a circular arrow. Tappable hit-target. */
  /** Subtle "you are here" dot at the finger cell during a touch drag. The
   *  placement target is the LIFTED ghost, not the finger — this dot is
   *  just a positional hint so the player knows where their finger sits
   *  relative to where the ghost ends up. */
  private drawFingerDot(cell: { x: number; y: number }): void {
    const ctx = this.ctx;
    const [sx, sy] = this.worldToScreen(cell.x, cell.y);
    const cx = sx + this.scale / 2;
    const cy = sy + this.scale / 2;
    const r = Math.max(7, this.scale * 0.14);
    ctx.save();
    ctx.fillStyle = "rgba(80,80,90,0.22)";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(50,50,60,0.5)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawRotateIcon(cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.save();
    // shadow
    ctx.fillStyle = "rgba(20,40,24,0.32)";
    ctx.beginPath();
    ctx.arc(cx + 1, cy + 2, r, 0, Math.PI * 2);
    ctx.fill();
    // disc
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#234b2f";
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // arc arrow
    const ar = r * 0.55;
    ctx.strokeStyle = "#234b2f";
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, ar, -Math.PI * 0.95, Math.PI * 0.7);
    ctx.stroke();
    // arrow head at the open end
    const tipAng = Math.PI * 0.7;
    const tipX = cx + Math.cos(tipAng) * ar;
    const tipY = cy + Math.sin(tipAng) * ar;
    const head = r * 0.32;
    ctx.fillStyle = "#234b2f";
    ctx.beginPath();
    ctx.moveTo(tipX + head * 0.9, tipY - head * 0.1);
    ctx.lineTo(tipX - head * 0.2, tipY - head * 0.85);
    ctx.lineTo(tipX - head * 0.2, tipY + head * 0.65);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawGrid(vw: number, vh: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(120,140,110,0.18)";
    ctx.lineWidth = 1;
    const [ox, oy] = this.worldToScreen(0, 0);
    const startX = ox - Math.ceil(ox / this.scale + 1) * this.scale;
    const startY = oy - Math.ceil(oy / this.scale + 1) * this.scale;
    ctx.beginPath();
    for (let x = startX; x < vw; x += this.scale) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, vh);
    }
    for (let y = startY; y < vh; y += this.scale) {
      ctx.moveTo(0, y);
      ctx.lineTo(vw, y);
    }
    ctx.stroke();
  }

  private drawAcre(x: number, y: number): void {
    const ctx = this.ctx;
    const [px, py] = this.worldToScreen(x, y);
    const s = this.scale;
    const owner = this.acres.get(key(x, y));
    ctx.fillStyle = ACRE_HEX;
    ctx.fillRect(px, py, s, s);
    if (owner) {
      ctx.fillStyle = hexA(owner.colour, 0.3); // tint the claimed land in the farmer's colour
      ctx.fillRect(px, py, s, s);
    }
    // faint furrows so enclosed land reads as a tended field
    ctx.strokeStyle = "rgba(120,160,80,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      ctx.moveTo(px + 2, py + (s * i) / 4);
      ctx.lineTo(px + s - 2, py + (s * i) / 4);
    }
    ctx.stroke();
    // owner's livestock feed scattered on their land: grass (sheep/cow),
    // grain (chicken), mud wallow (pig) — a deterministic, per-cell touch.
    if (owner && s > 14) this.drawAcreFood(px, py, s, owner.animal, hash(x, y));
    // Animals: when the sprite sheet is loaded they roam free-range (drawn
    // separately as critters). Without it, fall back to a bobbing emoji per cell.
    if (owner && s > 22 && !this.sprites.ready(owner.animal)) {
      const phase = (hash(x, y) & 1023) / 1023;
      let bob = 0;
      let squash = 1;
      if (!this.reduceMotion) {
        const cyc = this.t / 900 + phase * 6.28;
        bob = -Math.abs(Math.sin(cyc)) * s * 0.12;
        squash = 1 + Math.sin(cyc * 2) * 0.04;
      }
      ctx.font = `${Math.round(s * 0.58)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.save();
      ctx.translate(px + s / 2, py + s / 2 + s * 0.04 + bob);
      ctx.scale(1, squash);
      ctx.fillText(owner.animal, 0, 0);
      ctx.restore();
    }
  }
  /** Scatter the owner's feed across an enclosed acre (deterministic per cell). */
  private drawAcreFood(px: number, py: number, s: number, animal: string, seed: number): void {
    const ctx = this.ctx;
    const rng = makeRng(seed);
    const inset = s * 0.12;
    const x0 = px + inset;
    const y0 = py + inset;
    const w = s - inset * 2;
    const h = s - inset * 2;
    ctx.save();

    if (animal === "🐷") {
      // mud wallow: a couple of earthy puddles with a few rooted flecks
      const puddles = 2 + (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < puddles; i++) {
        const cx = x0 + rng() * w;
        const cy = y0 + rng() * h;
        const r = s * (0.11 + rng() * 0.1);
        ctx.fillStyle = `rgba(${88 + Math.round(rng() * 22)},${60 + Math.round(rng() * 16)},38,0.5)`;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * 0.66, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(58,40,24,0.55)";
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(x0 + rng() * w, y0 + rng() * h, Math.max(0.8, s * 0.02), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }

    if (animal === "🐓") {
      // grain: scattered golden seeds
      const seeds = Math.max(4, Math.round(s / 9));
      for (let i = 0; i < seeds; i++) {
        const cx = x0 + rng() * w;
        const cy = y0 + rng() * h;
        ctx.fillStyle = rng() < 0.5 ? "rgba(216,162,48,0.85)" : "rgba(186,128,32,0.85)";
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(0.8, s * 0.03), Math.max(0.5, s * 0.016), rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }

    // grass (sheep, cow, default): little green tufts
    const tufts = Math.max(3, Math.round(s / 11));
    const lw = Math.max(1, s * 0.022);
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    for (let i = 0; i < tufts; i++) {
      const bx = x0 + rng() * w;
      const by = y0 + h * (0.35 + rng() * 0.6);
      const len = s * (0.12 + rng() * 0.08);
      ctx.strokeStyle = rng() < 0.5 ? "rgba(95,160,60,0.85)" : "rgba(70,130,46,0.85)";
      for (let b = -1; b <= 1; b++) {
        ctx.beginPath();
        ctx.moveTo(bx + b * lw, by);
        ctx.lineTo(bx + b * lw * 1.5 + b * len * 0.3, by - len);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawAcreFlash(x: number, y: number, alpha: number): void {
    const ctx = this.ctx;
    const [px, py] = this.worldToScreen(x, y);
    ctx.fillStyle = `rgba(245,200,60,${0.55 * alpha})`;
    ctx.fillRect(px, py, this.scale, this.scale);
  }

  /**
   * Hedge cell: solid colour panel with bushy hedge puffs along its OUTWARD-
   * facing edges only. `hedgeMask` is a bitmask of sides that already abut
   * another hedge cell (1=N, 2=E, 4=S, 8=W); those sides skip their puffs so
   * adjacent cells flow into one continuous coloured strip.
   */
  private drawHedge(
    x: number,
    y: number,
    colour: Colour,
    alpha: number,
    danger = false,
    pop = 1,
    hedgeMask = 0,
  ): void {
    const ctx = this.ctx;
    const [px, py] = this.worldToScreen(x, y);
    const s = this.scale;
    const cx = px + s / 2;
    const cy = py + s / 2;

    ctx.save();
    ctx.globalAlpha = alpha;
    if (pop !== 1) {
      ctx.translate(cx, cy);
      ctx.scale(pop, pop);
      ctx.translate(-cx, -cy);
    }

    // Solid colour panel. In danger mode at low alpha (ghost preview) we
    // wash it white so the red hedge reads as "this won't sit there"; for
    // fully-opaque danger flashes on placed tiles we keep the colour so the
    // player can still identify their tile.
    ctx.fillStyle = danger && alpha < 1 ? "#ffffff" : COLOUR_HEX[colour];
    ctx.fillRect(px, py, s, s);

    const nH = (hedgeMask & 1) !== 0;
    const eH = (hedgeMask & 2) !== 0;
    const sH = (hedgeMask & 4) !== 0;
    const wH = (hedgeMask & 8) !== 0;
    if (nH && eH && sH && wH) {
      ctx.restore();
      return; // fully interior: no perimeter hedge to draw
    }

    // Hedge perimeter: a chunky continuous base stripe along outward-facing
    // sides — like an English-countryside boundary hedge — with variable
    // bushy puffs and a soft sun-catch highlight on the very outer rim.
    const body = danger ? HEDGE_DANGER : HEDGE_BASE;
    const dark = danger ? HEDGE_DANGER_DARK : HEDGE_DARK;

    // continuous base stripe (the "joined" perimeter) — thicker for hedgerow heft
    const stripe = s * 0.15;
    ctx.fillStyle = dark;
    if (!nH) ctx.fillRect(px, py, s, stripe);
    if (!sH) ctx.fillRect(px, py + s - stripe, s, stripe);
    if (!wH) ctx.fillRect(px, py, stripe, s);
    if (!eH) ctx.fillRect(px + s - stripe, py, stripe, s);

    // thin dark separator on internal edges (so adjacent placed cells still
    // read as individual tiles). Inset by the hedge-stripe thickness on the
    // perpendicular outward sides so the separator never cuts through hedge.
    ctx.fillStyle = `rgba(20,40,24,0.35)`;
    const sep = Math.max(1, s * 0.022);
    const iN = nH ? 0 : stripe;
    const iE = eH ? 0 : stripe;
    const iS = sH ? 0 : stripe;
    const iW = wH ? 0 : stripe;
    if (nH) ctx.fillRect(px + iW, py, s - iW - iE, sep);
    if (eH) ctx.fillRect(px + s - sep, py + iN, sep, s - iN - iS);
    if (sH) ctx.fillRect(px + iW, py + s - sep, s - iW - iE, sep);
    if (wH) ctx.fillRect(px, py + iN, sep, s - iN - iS);

    // Bushy clumps along the outward sides — fewer, larger puffs with size
    // variation so the hedge reads as individual shrubs, not a uniform ring.
    const rng = makeRng(hash(x, y));
    const puffsPerSide = Math.max(6, Math.round(s * 0.22));
    const margin = s * 0.07;
    const puff = (cxp: number, cyp: number, r: number) => {
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.arc(cxp, cyp, r * 1.06, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cxp, cyp, r * 0.93, 0, Math.PI * 2);
      ctx.fill();
    };
    // Always draw the full puff sequence on each outward side, including
    // corners — adjacent cells overlap their corner puffs to form a
    // continuous ribbon around the whole hedge group.
    const side = (
      enabled: boolean,
      xAt: (t: number) => number,
      yAt: (t: number) => number,
    ) => {
      if (!enabled) return;
      for (let i = 0; i <= puffsPerSide; i++) {
        const t = i / puffsPerSide;
        const jx = (rng() - 0.5) * s * 0.035;
        const jy = (rng() - 0.5) * s * 0.035;
        // most puffs are medium; ~25% are big bushy clumps
        const big = rng() < 0.25;
        const r = s * (big ? 0.12 + rng() * 0.025 : 0.085 + rng() * 0.025);
        puff(xAt(t) + jx, yAt(t) + jy, r);
      }
    };
    side(!nH, (t) => px + margin + t * (s - 2 * margin), () => py + margin);
    side(!eH, () => px + s - margin, (t) => py + margin + t * (s - 2 * margin));
    side(!sH, (t) => px + margin + t * (s - 2 * margin), () => py + s - margin);
    side(!wH, () => px + margin, (t) => py + margin + t * (s - 2 * margin));

    // Sun-catch highlights: a few brighter dots scattered along the outer rim
    const rng2 = makeRng(hash(x, y) ^ 0x5a7d);
    const hl = body === HEDGE_DANGER ? "rgba(255,210,170,0.55)" : "rgba(180,230,150,0.7)";
    ctx.fillStyle = hl;
    const dot = (enabled: boolean, xAt: (t: number) => number, yAt: (t: number) => number) => {
      if (!enabled) return;
      const n = Math.max(2, Math.round(s * 0.07));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.3 + rng2() * 0.4) / n;
        const r = s * (0.02 + rng2() * 0.015);
        ctx.beginPath();
        ctx.arc(xAt(t), yAt(t), r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    dot(!nH, (t) => px + margin + t * (s - 2 * margin), () => py + margin * 0.6);
    dot(!eH, () => px + s - margin * 0.6, (t) => py + margin + t * (s - 2 * margin));
    dot(!sH, (t) => px + margin + t * (s - 2 * margin), () => py + s - margin * 0.6);
    dot(!wH, () => px + margin * 0.6, (t) => py + margin + t * (s - 2 * margin));

    ctx.restore();
  }

  /** convenience for callers/tests: cell at screen coords */
  cellAtClient(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return this.screenToCell(clientX - rect.left, clientY - rect.top);
  }
  /** true if the client point is inside the board canvas (drag-and-drop use). */
  pointOverBoard(clientX: number, clientY: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }
}

function easeOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = p - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

/** "#rrggbb" -> "rgba(r,g,b,a)" */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}
