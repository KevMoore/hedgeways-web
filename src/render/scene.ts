import {
  ACRE_HEX,
  BOARD_BG,
  COLOUR_HEX,
  COLOUR_HEX_DARK,
  FRAME_CRACK_HEX,
  FRAME_HEX,
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
  private ghost: Ghost | null = null;
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
  private userMoved = false;
  private needsDraw = true;
  private lastDraw = 0; // perf.now() of the previous draw (for idle-animation throttle)

  tapHandler: ((x: number, y: number) => void) | null = null;
  hoverHandler: ((x: number, y: number) => void) | null = null;
  leaveHandler: (() => void) | null = null;
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
      const moving = this.stepCamera();
      const now = performance.now();
      const transient =
        this.needsDraw || this.flash.size || this.acrePops.length || this.bursts.length || this.animating();
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
    this.userMoved = false;
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
    if (!this.userMoved) this.fitBoard();
    else this.ensureVisible();
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

  /** Manual recenter (e.g. a Fit button). */
  recenter(): void {
    this.userMoved = false;
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

  setGhost(cells: PlacedCell[] | null, valid: boolean): void {
    this.ghost = cells && cells.length ? { cells, valid } : null;
    this.needsDraw = true;
  }

  setHighlights(cells: Map<string, Colour>): void {
    this.highlights = new Map(cells);
    this.needsDraw = true;
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

    const c = this.canvas;
    c.style.touchAction = "none";

    c.addEventListener("pointerdown", (e) => {
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
        this.userMoved = true;
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
        this.userMoved = true;
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
    c.addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));
    c.addEventListener("pointerleave", () => {
      this.hoverCell = "";
      if (this.leaveHandler) this.leaveHandler();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        this.userMoved = true;
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

    // tiles (with placement pop-in)
    for (const [k, cell] of this.cells) {
      const [x, y] = k.split(",").map(Number);
      const t0 = this.placedAt.get(k);
      let pop = 1;
      if (t0 !== undefined) {
        const p = (now - t0) / POP_MS;
        pop = p >= 1 ? 1 : easeOutBack(p);
      }
      this.drawHedge(x, y, cell.colour, 1, false, pop);
    }

    // free-range livestock roaming inside the fields (only if the sheet loaded)
    if (this.critters.size) {
      const dt = this.reduceMotion ? 0 : Math.min(60, now - this.lastT);
      if (dt > 0) this.updateCritters(dt);
      this.drawCritters();
    }

    // highlights — faded ghost hedges showing where the selected tile could sit
    for (const [k, colour] of this.highlights) {
      const [x, y] = k.split(",").map(Number);
      this.drawHedge(x, y, colour, 0.32);
    }

    // ghost
    if (this.ghost) {
      for (const c of this.ghost.cells) this.drawHedge(c.x, c.y, c.colour, this.ghost.valid ? 0.55 : 0.4, !this.ghost.valid);
    }

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

    ctx.restore();
    this.needsDraw = false;
    this.lastT = this.t;
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
  private drawAcreFlash(x: number, y: number, alpha: number): void {
    const ctx = this.ctx;
    const [px, py] = this.worldToScreen(x, y);
    ctx.fillStyle = `rgba(245,200,60,${0.55 * alpha})`;
    ctx.fillRect(px, py, this.scale, this.scale);
  }

  /** Procedural hedge cell: dark wooden frame + a bushy foliage cluster. */
  private drawHedge(x: number, y: number, colour: Colour, alpha: number, danger = false, pop = 1): void {
    const ctx = this.ctx;
    const [px, py] = this.worldToScreen(x, y);
    const s = this.scale;
    const cx = px + s / 2;
    const cy = py + s / 2;
    const gap = Math.max(1, s * 0.045);
    const seed = hash(x, y);

    ctx.save();
    ctx.globalAlpha = alpha;
    if (pop !== 1) {
      ctx.translate(cx, cy);
      ctx.scale(pop, pop);
      ctx.translate(-cx, -cy);
    }

    // wooden frame
    roundRect(ctx, px + gap, py + gap, s - gap * 2, s - gap * 2, s * 0.14);
    ctx.fillStyle = danger ? "#7a2230" : FRAME_HEX;
    ctx.fill();
    // wood grain
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = Math.max(1, s * 0.02);
    const grain = makeRng(seed);
    for (let i = 0; i < 3; i++) {
      const gy = py + gap + grain() * (s - gap * 2);
      ctx.beginPath();
      ctx.moveTo(px + gap, gy);
      ctx.bezierCurveTo(px + s * 0.35, gy - s * 0.03, px + s * 0.65, gy + s * 0.03, px + s - gap, gy);
      ctx.stroke();
    }
    ctx.restore();
    // crack outline
    roundRect(ctx, px + gap, py + gap, s - gap * 2, s - gap * 2, s * 0.14);
    ctx.strokeStyle = FRAME_CRACK_HEX;
    ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.stroke();

    // foliage: a bold spiky colour splat (matches the painted physical tiles)
    const fill = danger ? "#ffffff" : COLOUR_HEX[colour];
    const dark = danger ? "#cfcfcf" : COLOUR_HEX_DARK[colour];
    splat(ctx, cx, cy, s * 0.4, seed, fill, dark);

    ctx.restore();
  }

  /** convenience for callers/tests: cell at screen coords */
  cellAtClient(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return this.screenToCell(clientX - rect.left, clientY - rect.top);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function easeOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = p - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

/** Build a spiky, irregular "paint splat" path (alternating long/short spikes). */
function splatPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, seed: number) {
  const rand = makeRng(seed);
  const spikes = 11;
  ctx.beginPath();
  for (let i = 0; i < spikes; i++) {
    const ang = (i / spikes) * Math.PI * 2 + rand() * 0.18;
    const outer = radius * (0.92 + rand() * 0.18);
    const inner = radius * (0.46 + rand() * 0.14);
    const ox = cx + Math.cos(ang) * outer;
    const oy = cy + Math.sin(ang) * outer;
    const midAng = ang + Math.PI / spikes;
    const ix = cx + Math.cos(midAng) * inner;
    const iy = cy + Math.sin(midAng) * inner;
    if (i === 0) ctx.moveTo(ox, oy);
    else ctx.lineTo(ox, oy);
    ctx.lineTo(ix, iy);
  }
  ctx.closePath();
}

/** One bold spiky colour splat per hedge segment, like the hand-painted tiles. */
function splat(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  seed: number,
  fill: string,
  dark: string,
) {
  ctx.lineJoin = "round";
  // dark backing splat (depth + outline)
  splatPath(ctx, cx, cy, radius * 1.04, seed);
  ctx.fillStyle = dark;
  ctx.fill();
  // bright top splat
  splatPath(ctx, cx, cy, radius * 0.92, seed ^ 0x9e37);
  ctx.fillStyle = fill;
  ctx.fill();
  // subtle highlight blob
  splatPath(ctx, cx - radius * 0.12, cy - radius * 0.12, radius * 0.4, seed ^ 0x55aa);
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.fill();
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
