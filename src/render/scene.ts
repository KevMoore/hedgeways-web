import {
  ACRE_HEX,
  BOARD_BG,
  COLOUR_HEX,
  COLOUR_HEX_DARK,
  FRAME_CRACK_HEX,
  FRAME_HEX,
} from "../game/constants";
import type { Cell, Colour, PlacedCell } from "../game/types";

interface Ghost {
  cells: PlacedCell[];
  valid: boolean;
}

const MIN_SCALE = 18;
const MAX_SCALE = 110;

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  private cells = new Map<string, Cell>();
  private enclosed = new Set<string>();
  private ghost: Ghost | null = null;
  private highlights = new Set<string>();
  private flash = new Map<string, number>(); // cell -> start time

  private scale = 56;
  private camX = 0; // world coords at canvas centre
  private camY = 0;
  private userMoved = false;
  private needsDraw = true;

  tapHandler: ((x: number, y: number) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.bindInput();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    const loop = () => {
      if (this.needsDraw || this.flash.size) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  reset(): void {
    this.cells.clear();
    this.enclosed.clear();
    this.ghost = null;
    this.highlights.clear();
    this.flash.clear();
    this.userMoved = false;
    this.scale = 56;
    this.needsDraw = true;
  }

  syncBoard(cells: Map<string, Cell>, enclosed: Set<string>): void {
    this.cells = new Map(cells);
    this.enclosed = new Set(enclosed);
    if (!this.userMoved) this.fitBoard();
    this.needsDraw = true;
  }

  setGhost(cells: PlacedCell[] | null, valid: boolean): void {
    this.ghost = cells && cells.length ? { cells, valid } : null;
    this.needsDraw = true;
  }

  setHighlights(cells: Iterable<string>): void {
    this.highlights = new Set(cells);
    this.needsDraw = true;
  }

  flashEnclosed(cells: Iterable<string>): void {
    const now = performance.now();
    for (const k of cells) this.flash.set(k, now);
    this.needsDraw = true;
  }

  resize(): void {
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
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const consider = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const k of this.cells.keys()) {
      const [x, y] = k.split(",").map(Number);
      consider(x, y);
    }
    if (this.ghost) for (const c of this.ghost.cells) consider(c.x, c.y);
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
      if (!down) return;
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
      if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) moved = true;
      this.camX -= dx / this.scale;
      this.camY -= dy / this.scale;
      lastX = e.clientX;
      lastY = e.clientY;
      this.userMoved = true;
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

    // tiles
    for (const [k, cell] of this.cells) {
      const [x, y] = k.split(",").map(Number);
      this.drawHedge(x, y, cell.colour, 1);
    }

    // highlights
    if (this.highlights.size) {
      ctx.strokeStyle = "rgba(40,120,40,0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      for (const k of this.highlights) {
        const [x, y] = k.split(",").map(Number);
        const [px, py] = this.worldToScreen(x, y);
        ctx.strokeRect(px + 2, py + 2, this.scale - 4, this.scale - 4);
      }
      ctx.setLineDash([]);
    }

    // ghost
    if (this.ghost) {
      for (const c of this.ghost.cells) this.drawHedge(c.x, c.y, c.colour, this.ghost.valid ? 0.55 : 0.4, !this.ghost.valid);
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
    ctx.fillStyle = ACRE_HEX;
    ctx.fillRect(px, py, this.scale, this.scale);
  }
  private drawAcreFlash(x: number, y: number, alpha: number): void {
    const ctx = this.ctx;
    const [px, py] = this.worldToScreen(x, y);
    ctx.fillStyle = `rgba(245,166,35,${0.7 * alpha})`;
    ctx.fillRect(px, py, this.scale, this.scale);
  }

  /** Procedural wooden hedge cell with a jagged leaf blob. */
  private drawHedge(x: number, y: number, colour: Colour, alpha: number, danger = false): void {
    const ctx = this.ctx;
    const [px, py] = this.worldToScreen(x, y);
    const s = this.scale;
    const gap = Math.max(1, s * 0.04);
    ctx.save();
    ctx.globalAlpha = alpha;

    // wooden frame
    roundRect(ctx, px + gap, py + gap, s - gap * 2, s - gap * 2, s * 0.12);
    ctx.fillStyle = danger ? "#7a2230" : FRAME_HEX;
    ctx.fill();
    // crack
    ctx.strokeStyle = FRAME_CRACK_HEX;
    ctx.lineWidth = Math.max(1, s * 0.03);
    ctx.stroke();

    // leaf blob
    const cx = px + s / 2;
    const cy = py + s / 2;
    const base = s * 0.32;
    const seed = hash(x, y);
    leafBlob(ctx, cx, cy, base, seed);
    ctx.fillStyle = danger ? "#ffffff" : COLOUR_HEX[colour];
    ctx.fill();
    leafBlob(ctx, cx, cy, base * 0.6, seed ^ 0x55);
    ctx.fillStyle = danger ? "#e0e0e0" : COLOUR_HEX_DARK[colour];
    ctx.globalAlpha = alpha * 0.5;
    ctx.fill();

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

function leafBlob(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, seed: number) {
  const spikes = 11;
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  ctx.beginPath();
  for (let i = 0; i < spikes; i++) {
    const ang = (i / spikes) * Math.PI * 2;
    const rr = radius * (0.7 + rand() * 0.55);
    const x = cx + Math.cos(ang) * rr;
    const y = cy + Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}
