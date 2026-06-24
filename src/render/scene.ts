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

interface Ghost {
  cells: PlacedCell[];
  valid: boolean;
}

const MIN_SCALE = 18;
const MAX_SCALE = 110;
const POP_MS = 320; // tile placement pop-in
const ACRE_POP_MS = 1300; // floating "+N acres" lifetime

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  private cells = new Map<string, Cell>();
  private enclosed = new Set<string>();
  private ghost: Ghost | null = null;
  private highlights = new Set<string>();
  private flash = new Map<string, number>(); // cell -> start time
  private placedAt = new Map<string, number>(); // cell -> placement time (pop-in anim)
  private acres = new Map<string, { colour: string; animal: string }>(); // enclosed cell -> owner style
  private acrePops: { x: number; y: number; n: number; t0: number; animal: string }[] = [];

  private scale = 56;
  private camX = 0; // world coords at canvas centre
  private camY = 0;
  private userMoved = false;
  private needsDraw = true;

  tapHandler: ((x: number, y: number) => void) | null = null;
  hoverHandler: ((x: number, y: number) => void) | null = null;
  leaveHandler: (() => void) | null = null;
  private hoverCell = "";
  private rafId = 0;
  private alive = true;
  private onResize = () => this.resize();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.bindInput();
    this.resize();
    window.addEventListener("resize", this.onResize);
    const loop = () => {
      if (!this.alive) return;
      if (this.needsDraw || this.flash.size || this.acrePops.length || this.animating()) this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
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
    this.userMoved = false;
    this.scale = 56;
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
    if (!this.userMoved) this.fitBoard();
    else this.ensureVisible();
    this.needsDraw = true;
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

  setHighlights(cells: Iterable<string>): void {
    this.highlights = new Set(cells);
    this.needsDraw = true;
  }

  flashEnclosed(cells: Iterable<string>, animal = ""): void {
    const now = performance.now();
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const k of cells) {
      this.flash.set(k, now);
      const [x, y] = k.split(",").map(Number);
      sx += x;
      sy += y;
      n++;
    }
    if (n > 0) this.acrePops.push({ x: sx / n + 0.5, y: sy / n + 0.5, n, t0: now, animal });
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
    if (this.cells.size === 0) {
      this.camX = 0.5;
      this.camY = 0.5;
      this.scale = 56;
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
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(sx, sy)));
    this.camX = (minX + maxX + 1) / 2;
    this.camY = (minY + maxY + 1) / 2;
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
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      // only treat as an intentional pan (and pin the camera) past a small threshold,
      // so click jitter doesn't permanently disable auto-fit.
      if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) {
        moved = true;
        this.userMoved = true;
      }
      this.camX -= dx / this.scale;
      this.camY -= dy / this.scale;
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
    this.needsDraw = true;
  }

  // ---- drawing ----
  private draw(): void {
    const ctx = this.ctx;
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

    // highlights — cells where the selected hedge could legally sit
    if (this.highlights.size) {
      for (const k of this.highlights) {
        const [x, y] = k.split(",").map(Number);
        const [px, py] = this.worldToScreen(x, y);
        ctx.fillStyle = "rgba(108,194,74,0.32)";
        ctx.fillRect(px + 1, py + 1, this.scale - 2, this.scale - 2);
        ctx.strokeStyle = "rgba(40,110,40,0.7)";
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, this.scale - 4, this.scale - 4);
      }
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

    ctx.restore();
    this.needsDraw = false;
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
    if (owner && s > 22) {
      ctx.font = `${Math.round(s * 0.6)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(owner.animal, px + s / 2, py + s / 2 + s * 0.04);
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
    let g = seed >>> 0;
    for (let i = 0; i < 3; i++) {
      g = (g * 1664525 + 1013904223) >>> 0;
      const gy = py + gap + ((g / 4294967296) * (s - gap * 2));
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

    // foliage
    const fill = danger ? "#ffffff" : COLOUR_HEX[colour];
    const dark = danger ? "#cfcfcf" : COLOUR_HEX_DARK[colour];
    foliage(ctx, cx, cy, s * 0.42, seed, fill, dark, alpha);

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

/** A bushy cluster of small pointed leaves — reads as clipped hedge foliage. */
function foliage(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  seed: number,
  fill: string,
  dark: string,
  alpha: number,
) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const leaf = (lx: number, ly: number, len: number, ang: number, colour: string, a: number) => {
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(lx, ly);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, -len);
    ctx.quadraticCurveTo(len * 0.6, 0, 0, len);
    ctx.quadraticCurveTo(-len * 0.6, 0, 0, -len);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.restore();
  };
  // dark base layer (depth)
  for (let i = 0; i < 9; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = rand() * radius * 0.7;
    leaf(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, radius * (0.5 + rand() * 0.3), rand() * Math.PI, dark, alpha * 0.9);
  }
  // bright top layer
  for (let i = 0; i < 11; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = rand() * radius * 0.6;
    leaf(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, radius * (0.45 + rand() * 0.3), rand() * Math.PI, fill, alpha);
  }
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
