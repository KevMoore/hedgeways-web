import { chooseAiMove } from "../game/ai";
import { isPalindrome, orient } from "../game/board";
import { COLOUR_HEX, COLOUR_HEX_DARK, COLOUR_NAME, MAX_LAY } from "../game/constants";
import { Game, type GameConfig, type GameSnapshot, type TurnResult, totalScore } from "../game/game";
import { generateMoves } from "../game/moves";
import { validateMove } from "../game/placement";
import type { Cell, Colour, Move, Orientation, PlacedTile, Tile } from "../game/types";
import { COLOURS, key } from "../game/types";
import gsap from "gsap";
import { sfx } from "../audio";
import { mountFarmerPortrait } from "./farmer-portrait";
import { getFarmerSprites } from "../render/farmer-sprites";
import { Scene } from "../render/scene";
import { callout, confetti } from "./effects";
import { showHowTo } from "./howto";
import { clearActive, saveActive } from "../game/persistence";

export interface GameUiOptions {
  onQuit?: () => void;
  onRestart?: (config: GameConfig) => void;
  restore?: GameSnapshot;
}

type OriSpec = [Orientation, boolean];
const ALL_ORI: OriSpec[] = [
  ["H", false],
  ["V", false],
  ["H", true],
  ["V", true],
];

export class GameUI {
  game: Game;
  private scene: Scene;
  private root: HTMLElement;

  private pending: PlacedTile[] = [];
  /** orientation index used for each entry in `pending` (parallel array) —
   * lets the Rotate button cycle a tile in place after it's been dropped. */
  private pendingOri: number[] = [];
  private usedIds = new Set<number>();
  private selectedId: number | null = null;
  private oriIndex = 0;
  private busy = false;
  private invalidTimer: number | null = null;
  private botTimer: number | null = null;
  /** active farmer-portrait raf widgets, disposed before re-render */
  private farmerWidgets: { dispose: () => void }[] = [];
  /** in-flight drag of a pending placement off the board */
  private boardDragPointer = -1;
  private boardDragOriginal: { placement: PlacedTile; oriIdx: number } | null = null;
  private alive = true;
  /** low-bag tiers already announced, so each callout fires at most once */
  private bagWarned = new Set<number>();
  /** anchor cell -> the placement that would result (finger-position = anchor) */
  private placementByCell = new Map<string, PlacedTile>();

  private onQuit: (() => void) | null;
  private onRestart: ((config: GameConfig) => void) | null;
  private config: GameConfig;

  constructor(root: HTMLElement, config: GameConfig, opts: GameUiOptions = {}) {
    this.root = root;
    this.config = config;
    this.onQuit = opts.onQuit ?? null;
    this.onRestart = opts.onRestart ?? null;
    this.game = new Game(config, opts.restore);
    // don't shout "bag low" on resume for tiers already passed before this session
    const n0 = this.game.bag.length;
    for (const t of [12, 6, 0]) if (n0 <= t) this.bagWarned.add(t);
    root.innerHTML = TEMPLATE;
    const canvas = root.querySelector<HTMLCanvasElement>(".board")!;
    this.scene = new Scene(canvas);
    this.scene.tapHandler = (x, y) => this.onTapCell(x, y);
    this.scene.hoverHandler = (x, y) => this.onHover(x, y);
    this.scene.leaveHandler = () => this.scene.setGhost(null, false);
    this.scene.boardClaimHandler = (x, y, e) => this.tryStartBoardDrag(x, y, e);

    root.querySelector("#btn-rotate")!.addEventListener("click", () => this.rotate());
    root.querySelector("#btn-undo")!.addEventListener("click", () => this.undo());
    root.querySelector("#btn-confirm")!.addEventListener("click", () => this.confirm());
    root.querySelector("#btn-pass")!.addEventListener("click", () => this.passTurn());
    root.querySelector("#btn-help")!.addEventListener("click", () => showHowTo());
    root.querySelector("#btn-fit")!.addEventListener("click", () => this.scene.recenter());
    root.querySelector("#btn-sound")!.addEventListener("click", (e) => this.toggleSound(e));
    root.querySelector("#btn-quit")!.addEventListener("click", () => this.confirmQuit());
    root.querySelector("#btn-bag")!.addEventListener("click", () => this.showBag());

    this.syncScene();
    this.renderHud();
    this.beginTurn();
  }

  // ---- turn lifecycle ----
  private beginTurn(): void {
    this.clearTurnState();
    this.renderHud();
    if (this.game.gameOver) {
      clearActive();
      return this.showEnd();
    }
    saveActive(this.game.toSnapshot()); // auto-save at each turn boundary
    const p = this.game.currentPlayer;
    if (p.isBot) {
      this.setStatus(`${p.name} is planning…`);
      this.renderHand(true);
      this.updateButtons();
      this.botTimer = window.setTimeout(() => this.botMove(), 480);
      return;
    }
    // human
    const hasMove = this.game.hasLegalMove();
    this.renderHand(false, true);
    this.setStatus(
      hasMove
        ? `Your turn — drag a hedge onto the field`
        : `No legal move — you must pass`,
    );
    this.updateButtons();
  }

  private botMove(): void {
    this.botTimer = null;
    if (!this.alive || this.game.gameOver || !this.game.currentPlayer.isBot) return;
    const move = chooseAiMove(this.game);
    if (!this.alive) return; // torn down while the (synchronous) search ran
    const actor = this.game.currentPlayer;
    if (!move) {
      this.game.pass();
      callout(`${actor.animal} ${actor.name} passes`, "pass");
    } else {
      const res = this.game.commit(move);
      this.afterCommit(res, actor);
    }
    this.syncScene();
    this.beginTurn();
  }

  private afterCommit(res: TurnResult, actor: { name: string; animal: string; colour?: string }): void {
    const scored = res.scored ?? 0;
    if (scored > 0) {
      this.scene.flashEnclosed(res.newlyEnclosed ?? [], actor.animal, actor.colour);
      sfx.score(scored);
      sfx.celebrate(actor.animal);
      this.streakCallout(res, actor);
    } else {
      sfx.place();
    }
    this.checkBagLow();
  }

  /** Escalating scoring callout: Double / Triple / On fire / Mega field, with the small bonus. */
  private streakCallout(res: TurnResult, actor: { name: string; animal: string }): void {
    const scored = res.scored ?? 0;
    const streak = res.streak ?? 1;
    const fields = res.fields ?? 1;
    const who = `${actor.animal} ${actor.name}`;
    const acresTxt = `${scored} acre${scored === 1 ? "" : "s"}`;
    const fieldsTxt = fields >= 2 ? ` in ${fields} fields` : "";
    const bonusTxt = (res.bonus ?? 0) > 0 ? ` +${res.bonus}🔥` : "";

    let head = "";
    let hot = false;
    if (streak >= 4) (head = "ON FIRE! "), (hot = true);
    else if (streak === 3) (head = "Triple! "), (hot = true);
    else if (streak === 2) (head = "Double! "), (hot = true);
    else if (res.mega) (head = "Mega field! "), (hot = true);

    callout(`${head}${who} encloses ${acresTxt}${fieldsTxt}${bonusTxt}`, hot ? "streak" : "score");
    if (hot) {
      sfx.streak(streak);
      if (streak >= 3 || res.mega) confetti(40);
    }
  }

  private checkBagLow(): void {
    const n = this.game.bag.length;
    (this.root.querySelector(".bag") as HTMLElement | null)?.classList.toggle("low", n > 0 && n <= 6);
    let tier: number | null = null;
    if (n === 0) tier = 0;
    else if (n <= 6) tier = 6;
    else if (n <= 12) tier = 12;
    if (tier === null || this.bagWarned.has(tier)) return;
    this.bagWarned.add(tier);
    const msg =
      tier === 0
        ? "🚜 Bag empty — final hands!"
        : tier === 6
          ? `⏳ Almost out — ${n} hedge${n === 1 ? "" : "s"} left`
          : `🌱 Bag running low — ${n} hedges left`;
    callout(msg, "low");
  }

  // ---- human input ----
  private onTapCell(x: number, y: number): void {
    if (this.busy || this.game.currentPlayer.isBot) return;
    if (this.selectedId == null || this.pending.length >= MAX_LAY) return;
    // tap ANY cell a legal placement would cover
    const candidate = this.placementByCell.get(key(x, y));
    if (candidate) {
      this.pending.push(candidate);
      this.pendingOri.push(this.oriIndex);
      this.usedIds.add(candidate.tileId);
      this.selectedId = null;
      sfx.place();
      this.scene.setGhost(null, false);
      this.refreshHighlights();
      this.syncScene();
      this.renderHand(false);
      this.updateButtons();
      const left = 3 - this.pending.length;
      this.setStatus(
        left > 0
          ? `${this.pending.length} hedge${this.pending.length === 1 ? "" : "s"} laid — confirm, or plant up to ${left} more`
          : `3 hedges laid — confirm to end the day`,
      );
      return;
    }
    // invalid spot: brief red feedback in the current orientation
    const tile = this.handTile(this.selectedId);
    if (!tile) return;
    const [dir, flip] = ALL_ORI[this.oriIndex];
    this.flashInvalid(orient(tile, x, y, dir, flip));
  }

  /** Single-finger pointerdown on the board: if it lands on a pending tile,
   *  pick that pending up (removing it from `pending`, becoming selectedId)
   *  so the player can drag it to a new position. Returns true to claim the
   *  gesture so the scene doesn't try to pan.
   */
  private tryStartBoardDrag(x: number, y: number, e: PointerEvent): boolean {
    if (this.busy || this.game.currentPlayer.isBot) return false;
    if (this.boardDragPointer !== -1) return false;
    const idx = this.pending.findIndex((p) => p.cells.some((c) => c.x === x && c.y === y));
    if (idx < 0) return false;
    // Pick up: remove from pending, set as selected, refresh placement candidates
    const placement = this.pending.splice(idx, 1)[0];
    const oriIdx = this.pendingOri.splice(idx, 1)[0];
    this.usedIds.delete(placement.tileId);
    this.selectedId = placement.tileId;
    this.oriIndex = oriIdx;
    this.refreshHighlights();
    this.syncScene();
    this.renderHand(false);
    this.updateButtons();
    this.boardDragOriginal = { placement, oriIdx };
    this.boardDragPointer = e.pointerId;
    // ghost-preview at current finger position
    this.updateGhostFromClient(e.clientX, e.clientY);
    window.addEventListener("pointermove", this.onBoardDragMove);
    window.addEventListener("pointerup", this.onBoardDragEnd);
    window.addEventListener("pointercancel", this.onBoardDragEnd);
    sfx.pickup();
    return true;
  }

  private updateGhostFromClient(clientX: number, clientY: number): void {
    if (this.scene.pointOverBoard(clientX, clientY)) {
      const [cx, cy] = this.scene.cellAtClient(clientX, clientY);
      this.onHover(cx, cy);
    } else {
      this.scene.setGhost(null, false);
    }
  }

  private onBoardDragMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.boardDragPointer) return;
    this.updateGhostFromClient(e.clientX, e.clientY);
  };

  private onBoardDragEnd = (e: PointerEvent): void => {
    if (e.pointerId !== this.boardDragPointer) return;
    window.removeEventListener("pointermove", this.onBoardDragMove);
    window.removeEventListener("pointerup", this.onBoardDragEnd);
    window.removeEventListener("pointercancel", this.onBoardDragEnd);
    const orig = this.boardDragOriginal!;
    this.boardDragPointer = -1;
    this.boardDragOriginal = null;
    if (this.scene.pointOverBoard(e.clientX, e.clientY)) {
      const [cx, cy] = this.scene.cellAtClient(e.clientX, e.clientY);
      const candidate = this.placementByCell.get(key(cx, cy));
      if (candidate) {
        // valid drop — onTapCell will place it (using the current orientation
        // which we preserved from the original pending)
        this.onTapCell(cx, cy);
        return;
      }
    }
    // Invalid drop: bray donkey, restore the placement to where it was so the
    // player can grab it again and try a fresh position.
    sfx.invalid();
    this.pending.push(orig.placement);
    this.pendingOri.push(orig.oriIdx);
    this.usedIds.add(orig.placement.tileId);
    this.selectedId = null;
    this.scene.setGhost(null, false);
    this.refreshHighlights();
    this.syncScene();
    this.renderHand(false);
    this.updateButtons();
  };

  private onHover(x: number, y: number): void {
    if (this.busy || this.game.currentPlayer.isBot || this.selectedId == null) return;
    const tile = this.handTile(this.selectedId);
    if (!tile) return;
    const [dir, flip] = ALL_ORI[this.oriIndex];
    // Ghost always anchors at the finger's cell. Green when that exact anchor
    // is a legal placement; red otherwise. No auto-snap to a different cell.
    const cells = orient(tile, x, y, dir, flip);
    const valid = this.placementByCell.has(key(x, y));
    this.scene.setGhost(cells, valid);
  }

  private flashInvalid(cells: PlacedTile["cells"]): void {
    this.scene.setGhost(cells, false);
    sfx.invalid();
    if (this.invalidTimer) window.clearTimeout(this.invalidTimer);
    this.invalidTimer = window.setTimeout(() => this.scene.setGhost(null, false), 450);
  }

  private selectTile(id: number): void {
    if (this.usedIds.has(id)) return;
    if (this.pending.length >= MAX_LAY) return; // at most 3 hedges per turn
    const becomingSelected = this.selectedId !== id;
    this.selectedId = becomingSelected ? id : null;
    if (becomingSelected) {
      // Keep the player's chosen orientation if it has legal placements for
      // the newly picked tile — so rotating once is enough for the whole turn.
      const tile = this.handTile(id)!;
      if (this.anchorsFor(tile, ALL_ORI[this.oriIndex]).size === 0) {
        this.oriIndex = this.firstUsableOri(id);
      }
    }
    sfx.pickup();
    this.renderHand(false);
    this.refreshHighlights();
    this.updateButtons();
  }

  private firstUsableOri(id: number): number {
    const tile = this.handTile(id);
    if (!tile) return 0;
    const oris = isPalindrome(tile) ? [0, 1] : [0, 1, 2, 3];
    for (const i of oris) if (this.anchorsFor(tile, ALL_ORI[i]).size > 0) return i;
    return oris[0];
  }

  private rotate(): void {
    // 1) An in-hand tile is selected → rotate its preview orientation.
    if (this.selectedId != null) {
      const tile = this.handTile(this.selectedId)!;
      const allowed = isPalindrome(tile) ? [0, 1] : [0, 1, 2, 3];
      const pos = allowed.indexOf(this.oriIndex);
      this.oriIndex = allowed[(pos + 1) % allowed.length];
      sfx.rotate();
      this.refreshHighlights();
      return;
    }
    // 2) No selection but a tile is already pending → rotate the last placed
    //    tile in place around its anchor, keeping every placement legal.
    if (this.pending.length > 0) this.rotateLastPending();
  }

  /** Rotate the most recent pending placement around its anchor. Tries each
   *  remaining orientation in cycle; the first one that yields a legal
   *  combined move wins. If none work, no change + an "invalid" bray. */
  private rotateLastPending(): void {
    const lastIdx = this.pending.length - 1;
    const last = this.pending[lastIdx];
    const lastOri = this.pendingOri[lastIdx];
    const tile = this.game.currentPlayer.hand.find((t) => t.id === last.tileId);
    if (!tile) return;
    const anchor = last.cells[0];
    const allowed = isPalindrome(tile) ? [0, 1] : [0, 1, 2, 3];
    const startPos = allowed.indexOf(lastOri);
    for (let i = 1; i <= allowed.length; i++) {
      const tryOri = allowed[(startPos + i) % allowed.length];
      const [dir, flip] = ALL_ORI[tryOri];
      const cells = orient(tile, anchor.x, anchor.y, dir, flip);
      // Don't intersect other pending placements or already-placed cells
      const otherPending = this.pending.filter((_, j) => j !== lastIdx);
      const occupied = new Set<string>([
        ...otherPending.flatMap((p) => p.cells.map((c) => key(c.x, c.y))),
        ...this.game.board.cells.keys(),
      ]);
      if (cells.some((c) => occupied.has(key(c.x, c.y)))) continue;
      if (cells.some((c) => this.game.board.enclosed.has(key(c.x, c.y)))) continue;
      const candidate: PlacedTile = { tileId: tile.id, cells };
      // Engine-level validation in the context of the full pending set
      const allTiles = [...otherPending, candidate].map((p) => ({ tileId: p.tileId, cells: p.cells }));
      if (validateMove(this.game.board, allTiles).ok) {
        this.pending[lastIdx] = candidate;
        this.pendingOri[lastIdx] = tryOri;
        sfx.rotate();
        this.syncScene();
        this.updateButtons();
        return;
      }
    }
    sfx.invalid(); // no legal rotation at this anchor
  }

  private undo(): void {
    const last = this.pending.pop();
    this.pendingOri.pop();
    if (!last) return;
    this.usedIds.delete(last.tileId);
    this.selectedId = null;
    this.syncScene();
    this.renderHand(false);
    this.refreshHighlights();
    this.updateButtons();
  }

  private confirm(): void {
    if (this.pending.length === 0) return;
    const move: Move = { tiles: this.pending.map((t) => ({ tileId: t.tileId, cells: t.cells })) };
    const actor = { name: "You", animal: this.game.currentPlayer.animal, colour: this.game.currentPlayer.colour };
    const res = this.game.commit(move);
    if (!res.ok) {
      this.setStatus(`Illegal: ${res.reason}`);
      return;
    }
    this.afterCommit(res, actor);
    this.syncScene();
    this.beginTurn();
  }

  passTurn(): void {
    if (this.game.gameOver) return;
    this.game.pass();
    this.beginTurn();
  }

  // Build the cell -> placement map so tapping/dragging onto a cell knows
  // which placement to apply. Highlights (visible dots) are intentionally
  // NOT shown — the player discovers valid moves themselves; the ghost
  // preview during a drag/tap confirms validity in the moment.
  private refreshHighlights(): void {
    this.placementByCell.clear();
    this.scene.setHighlights(new Map());
    if (this.selectedId == null) return;
    const tile = this.handTile(this.selectedId)!;
    const cands = this.anchorsFor(tile, ALL_ORI[this.oriIndex]);
    // Anchor-only: finger position IS the anchor. No magnetic snap from any
    // covered cell to a candidate elsewhere — the player chooses the exact spot.
    for (const [anchorKey, cand] of cands) this.placementByCell.set(anchorKey, cand);
  }

  /** Legal anchor cells (segment-0 position) for placing `tile` in this orientation now. */
  private anchorsFor(tile: Tile, ori: OriSpec): Map<string, PlacedTile> {
    const [dir, flip] = ori;
    const out = new Map<string, PlacedTile>();
    const working = this.workingCells();
    const blocked = new Set([...working.keys(), ...this.game.board.enclosed]);

    let anchors: Set<string>;
    if (working.size === 0) {
      anchors = new Set(["0,0"]);
    } else {
      anchors = new Set();
      for (const k of working.keys()) {
        const [x, y] = k.split(",").map(Number);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nk = key(x + dx, y + dy);
          if (!blocked.has(nk)) anchors.add(nk);
        }
      }
    }
    const [ux, uy] = dir === "H" ? [1, 0] : [0, 1];
    for (const a of anchors) {
      const [ax, ay] = a.split(",").map(Number);
      // try anchor so that any of the 3 segments lands on the frontier cell
      for (let i = 0; i < 3; i++) {
        const ox = ax - ux * i;
        const oy = ay - uy * i;
        const cells = orient(tile, ox, oy, dir, flip);
        if (!cells.every((c) => !blocked.has(key(c.x, c.y)))) continue;
        const cand: PlacedTile = { tileId: tile.id, cells };
        if (validateMove(this.game.board, [...this.pending, cand]).ok) {
          out.set(key(ox, oy), cand);
        }
      }
    }
    return out;
  }

  // ---- rendering ----
  private workingCells(): Map<string, Cell> {
    const m = new Map(this.game.board.cells);
    for (const t of this.pending) for (const c of t.cells) m.set(key(c.x, c.y), { colour: c.colour, tileId: t.tileId });
    return m;
  }

  private syncScene(): void {
    const acres = this.acresMap();
    this.scene.syncBoard(this.workingCells(), this.game.board.enclosed, acres);
    sfx.setAnimals([...acres.values()].map((a) => a.animal)); // drive random ambience
  }

  /** enclosed cell -> the owning farmer's colour + animal, for the renderer */
  private acresMap(): Map<string, { colour: string; animal: string }> {
    const m = new Map<string, { colour: string; animal: string }>();
    for (const [k, pid] of this.game.board.acreOwner) {
      const p = this.game.players[pid];
      if (p) m.set(k, { colour: p.colour, animal: p.animal });
    }
    return m;
  }

  private handTile(id: number): Tile | undefined {
    return this.game.currentPlayer.hand.find((t) => t.id === id);
  }

  private renderHand(hidden: boolean, animate = false): void {
    const el = this.root.querySelector(".hand")!;
    el.innerHTML = "";
    const p = this.game.currentPlayer;
    if (hidden || p.isBot) {
      el.innerHTML = `<div class="hand-hidden">${p.name}'s hedges</div>`;
      return;
    }
    for (const tile of p.hand) {
      const d = document.createElement("button");
      d.className = "tile";
      if (this.usedIds.has(tile.id)) d.classList.add("used");
      if (this.selectedId === tile.id) d.classList.add("sel");
      for (const c of tile.segments) {
        const seg = document.createElement("span");
        seg.style.background = COLOUR_HEX[c];
        seg.style.boxShadow = `inset 0 0 0 2px ${COLOUR_HEX_DARK[c]}`;
        d.appendChild(seg);
      }
      this.attachTileInput(d, tile.id);
      el.appendChild(d);
    }
    if (animate)
      gsap.from([...el.children], { y: 14, opacity: 0, duration: 0.32, ease: "back.out(2)", stagger: 0.05 });
  }

  /**
   * Hand chip input: short tap toggles selection (existing behaviour); a real
   * drag picks the tile up, follows the finger/cursor with the ghost preview,
   * and on release either places (if released over a valid board cell) or
   * snaps back. Off-board release silently aborts.
   */
  private attachTileInput(d: HTMLElement, tileId: number): void {
    const DRAG_SLOP = 3; // finger only needs to move ~3px for the drag to engage
    let startX = 0;
    let startY = 0;
    let pressed = false;
    let dragging = false;
    let pid = -1;
    d.addEventListener("pointerdown", (e) => {
      if (this.usedIds.has(tileId)) return;
      if (this.pending.length >= MAX_LAY && this.selectedId !== tileId) return;
      e.preventDefault(); // suppress browser drag/select fallback (mobile especially)
      pressed = true;
      dragging = false;
      pid = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      try {
        d.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    d.addEventListener("pointermove", (e) => {
      if (!pressed) return;
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP) return;
        dragging = true;
        // commit to the drag: select this tile so the ghost-preview path is live
        if (this.selectedId !== tileId) {
          this.selectedId = tileId;
          // preserve the current orientation if it still has legal placements
          // for this tile (so a rotate before the drag isn't thrown away)
          const tile = this.handTile(tileId)!;
          if (this.anchorsFor(tile, ALL_ORI[this.oriIndex]).size === 0) {
            this.oriIndex = this.firstUsableOri(tileId);
          }
          sfx.pickup();
          this.refreshHighlights();
          this.updateButtons();
        }
      }
      // ghost-preview at the finger position (only while over the board)
      if (this.scene.pointOverBoard(e.clientX, e.clientY)) {
        const [cx, cy] = this.scene.cellAtClient(e.clientX, e.clientY);
        this.onHover(cx, cy);
      } else {
        this.scene.setGhost(null, false);
      }
    });
    const finish = (e: PointerEvent) => {
      if (!pressed) return;
      const wasDrag = dragging;
      pressed = false;
      dragging = false;
      try {
        d.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
      if (!wasDrag) {
        this.selectTile(tileId); // short tap toggles selection
        return;
      }
      // Drag release: place if over a valid board cell, else abort
      if (this.scene.pointOverBoard(e.clientX, e.clientY)) {
        const [cx, cy] = this.scene.cellAtClient(e.clientX, e.clientY);
        this.onTapCell(cx, cy); // places, or flashInvalid + donkey
      } else {
        this.scene.setGhost(null, false); // off-board: silent abort
      }
      this.renderHand(false);
    };
    d.addEventListener("pointerup", finish);
    d.addEventListener("pointercancel", finish);
  }

  private prevScores: number[] = [];

  private renderHud(): void {
    const ps = this.root.querySelector(".players")!;
    // dispose any prior farmer canvases before clearing the chips
    for (const w of this.farmerWidgets) w.dispose();
    this.farmerWidgets = [];
    ps.innerHTML = "";
    const lead = Math.max(...this.game.players.map((p) => totalScore(p)));
    this.game.players.forEach((p) => {
      const total = totalScore(p);
      const chip = document.createElement("div");
      const active = p.id === this.game.current && !this.game.gameOver;
      chip.className = "pchip" + (active ? " active" : "") + (total === lead && lead > 0 ? " lead" : "");
      chip.style.setProperty("--pc", p.colour);
      const bonusTag = p.bonus > 0 ? `<span class="pbonus" title="${p.score} acres + ${p.bonus} streak">+${p.bonus}🔥</span>` : "";
      const usingSprite = !!p.farmerId && getFarmerSprites().knows(p.farmerId);
      const portraitHtml = usingSprite
        ? `<span class="pfarmer"></span>`
        : `<span class="panimal">${p.animal}</span>`;
      chip.innerHTML =
        portraitHtml +
        `<span class="pname">${p.name}</span>` +
        `<span class="pscore">${total}<small>🌿</small></span>` +
        bonusTag;
      ps.appendChild(chip);
      // Mount the animated farmer head-shot into the placeholder span. Active
      // player gets idle bob; others render a single static frame (cheap).
      if (usingSprite && p.farmerId) {
        const host = chip.querySelector(".pfarmer") as HTMLElement | null;
        if (host) {
          const w = mountFarmerPortrait(host, p.farmerId, {
            size: 30,
            crop: "head",
            state: active ? "idle" : "idle",
            static: !active,
            phase: p.id * 0.13,
          });
          if (w) this.farmerWidgets.push(w);
        }
      }
      // pop the score when it just increased
      if (this.prevScores[p.id] !== undefined && total > this.prevScores[p.id]) {
        gsap.fromTo(
          chip.querySelector(".pscore"),
          { scale: 1.8, color: "#ffd34d" },
          { scale: 1, color: "", duration: 0.6, ease: "back.out(3)" },
        );
      }
    });
    this.prevScores = this.game.players.map((p) => totalScore(p));
    const n = this.game.bag.length;
    const bag = this.root.querySelector(".bag") as HTMLElement;
    bag.textContent = `🌱 ${n} in bag`;
    bag.classList.toggle("low", n > 0 && n <= 6);
  }

  private updateButtons(): void {
    const human = !this.game.currentPlayer.isBot && !this.game.gameOver;
    const hasMove = human && this.game.hasLegalMove();
    btn(this.root, "#btn-rotate", human && (this.selectedId != null || this.pending.length > 0));
    btn(this.root, "#btn-undo", human && this.pending.length > 0);
    btn(this.root, "#btn-confirm", human && this.pending.length > 0);
    btn(this.root, "#btn-pass", human && !hasMove && this.pending.length === 0);
    (this.root.querySelector("#btn-confirm") as HTMLElement).classList.toggle(
      "ready",
      human && this.pending.length > 0,
    );
  }

  private setStatus(msg: string): void {
    this.root.querySelector(".status")!.textContent = msg;
  }

  private clearTurnState(): void {
    this.pending = [];
    this.pendingOri = [];
    this.usedIds.clear();
    this.selectedId = null;
    this.oriIndex = 0;
    this.placementByCell.clear();
    this.scene.setHighlights(new Map());
    this.scene.setGhost(null, false);
  }

  private toggleSound(e: Event): void {
    const on = !sfx.isEnabled();
    sfx.setEnabled(on);
    (e.currentTarget as HTMLElement).textContent = on ? "🔊" : "🔇";
  }

  /** Tear down: stop the render loop, cancel pending bot/animation timers. */
  dispose(): void {
    this.alive = false;
    if (this.botTimer !== null) window.clearTimeout(this.botTimer);
    if (this.invalidTimer !== null) window.clearTimeout(this.invalidTimer);
    for (const w of this.farmerWidgets) w.dispose();
    this.farmerWidgets = [];
    if (this.boardDragPointer !== -1) {
      window.removeEventListener("pointermove", this.onBoardDragMove);
      window.removeEventListener("pointerup", this.onBoardDragEnd);
      window.removeEventListener("pointercancel", this.onBoardDragEnd);
      this.boardDragPointer = -1;
      this.boardDragOriginal = null;
    }
    this.scene.destroy();
  }

  private restart(): void {
    clearActive();
    const fresh: GameConfig = {
      players: this.config.players,
      seed: (Math.random() * 0xffffffff) >>> 0,
    };
    if (this.onRestart) this.onRestart(fresh);
    else if (this.onQuit) this.onQuit();
  }

  private confirmQuit(): void {
    if (this.game.gameOver) {
      this.onQuit?.();
      return;
    }
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
      <div class="modal confirm">
        <h2>Game menu</h2>
        <p>Restart with the same farmers, or quit to the main menu.</p>
        <div class="end-btns">
          <button class="btn" id="q-cancel">Keep playing</button>
          <button class="btn" id="q-restart">Restart</button>
          <button class="btn primary" id="q-ok">Quit to menu</button>
        </div>
      </div>`;
    this.root.appendChild(back);
    const close = () => back.remove();
    back.querySelector("#q-cancel")!.addEventListener("click", close);
    back.querySelector("#q-restart")!.addEventListener("click", () => {
      close();
      this.restart();
    });
    back.querySelector("#q-ok")!.addEventListener("click", () => {
      close();
      clearActive();
      this.onQuit?.();
    });
    back.addEventListener("click", (e) => {
      if (e.target === back) close();
    });
  }

  /** Read-only peek at the shared bag — draws stay random, this is just info. */
  private showBag(): void {
    const bag = this.game.bag;
    const empty = bag.length === 0;
    const tally: Partial<Record<Colour, number>> = {};
    for (const t of bag) for (const c of t.segments) tally[c] = (tally[c] ?? 0) + 1;
    const seg = (c: Colour) =>
      `<span style="background:${COLOUR_HEX[c]};box-shadow:inset 0 0 0 2px ${COLOUR_HEX_DARK[c]}"></span>`;
    const tallyHtml = COLOURS.map(
      (c) =>
        `<span class="bag-tally"><i style="background:${COLOUR_HEX[c]};box-shadow:inset 0 0 0 2px ${COLOUR_HEX_DARK[c]}"></i>${COLOUR_NAME[c]} ×${tally[c] ?? 0}</span>`,
    ).join("");
    const sorted = [...bag].sort((a, b) => a.segments.join("").localeCompare(b.segments.join("")));
    const tilesHtml = sorted
      .map((t) => `<div class="bagtile">${t.segments.map(seg).join("")}</div>`)
      .join("");

    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
      <div class="modal bag-modal">
        <h2>🌱 ${bag.length} hedge${bag.length === 1 ? "" : "s"} left</h2>
        <p>${
          empty
            ? "The bag is empty — everyone's playing out their final hands."
            : "Draws are random — you can't pick from the bag — but here's everything still out there."
        }</p>
        ${empty ? "" : `<div class="bag-tallies">${tallyHtml}</div><div class="bagtiles">${tilesHtml}</div>`}
        <div class="end-btns"><button class="btn primary" id="bag-close">Got it</button></div>
      </div>`;
    this.root.appendChild(back);
    const close = () => back.remove();
    back.querySelector("#bag-close")!.addEventListener("click", close);
    back.addEventListener("click", (e) => {
      if (e.target === back) close();
    });
    gsap.from(back.querySelectorAll(".bagtile"), {
      scale: 0.4,
      opacity: 0,
      duration: 0.3,
      ease: "back.out(2)",
      stagger: 0.01,
    });
  }

  private showEnd(): void {
    const standings = this.game.standings();
    const winner = standings[0];
    const tie = standings.filter((p) => totalScore(p) === totalScore(winner)).length > 1;
    const winLine = tie
      ? "Sundown — it's a tie!"
      : winner.name === "You"
        ? "Sundown — you win the farm!"
        : `Sundown — ${winner.name} wins the farm!`;
    confetti();
    sfx.win();
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
      <div class="modal end">
        <div class="trophy">${tie ? "🤝" : "🚜"}</div>
        <h2>${winLine}</h2>
        <table>${standings
          .map((p, i) => {
            const bonusNote = p.bonus > 0 ? `<small> (${p.score} + ${p.bonus}🔥)</small>` : "";
            const portrait = p.farmerId && getFarmerSprites().knows(p.farmerId)
              ? `<span class="endfarmer" data-fid="${p.farmerId}" data-pos="${i}"></span>`
              : `${p.animal}`;
            return `<tr class="${i === 0 && !tie ? "win" : ""}"><td>${medal(i)} ${portrait} ${p.name}</td><td>${totalScore(p)} acre${totalScore(p) === 1 ? "" : "s"}${bonusNote}</td></tr>`;
          })
          .join("")}</table>
        <div class="end-btns">
          <button class="btn" id="end-inspect">View field</button>
          <button class="btn" id="end-menu">Farmhouse</button>
          <button class="btn primary" id="end-again">Next harvest</button>
        </div>
      </div>`;
    this.root.appendChild(back);
    // Mount farmer animations into the standings rows — winners get a happy
    // cheer cycle, others a calmer idle.
    const podiumWidgets: { dispose: () => void }[] = [];
    back.querySelectorAll<HTMLElement>(".endfarmer").forEach((host) => {
      const fid = host.dataset.fid || "";
      const pos = Number(host.dataset.pos || "999");
      if (!fid) return;
      const w = mountFarmerPortrait(host, fid, {
        size: 36,
        crop: "full",
        state: pos === 0 ? "happy" : "idle",
        phase: pos * 0.31,
      });
      if (w) podiumWidgets.push(w);
    });
    const closeModal = () => {
      for (const w of podiumWidgets) w.dispose();
      back.remove();
    };
    back.querySelector("#end-inspect")!.addEventListener("click", closeModal);
    back.querySelector("#end-menu")!.addEventListener("click", () => {
      closeModal();
      if (this.onQuit) this.onQuit();
      else location.reload();
    });
    back.querySelector("#end-again")!.addEventListener("click", () => {
      closeModal();
      this.restart();
    });
  }

  // ---- test hook ----
  /** Play one legal move (or pass) for the current player; returns true if a move was laid. */
  autoPlayTurn(): boolean {
    if (this.game.gameOver) return false;
    const moves = generateMoves(this.game.board, this.game.currentPlayer.hand, { limit: 1, maxNodes: Infinity });
    if (moves.length === 0) {
      this.game.pass();
      this.syncScene();
      this.beginTurn();
      return false;
    }
    const actor = { name: this.game.currentPlayer.name, animal: this.game.currentPlayer.animal, colour: this.game.currentPlayer.colour };
    const res = this.game.commit(moves[0]);
    this.afterCommit(res, actor);
    this.syncScene();
    this.beginTurn();
    return true;
  }

  state() {
    return {
      current: this.game.current,
      gameOver: this.game.gameOver,
      winnerId: this.game.winnerId,
      bag: this.game.bag.length,
      scores: this.game.players.map((p) => p.score),
      handSize: this.game.currentPlayer.hand.length,
      pending: this.pending.length,
    };
  }
}

function btn(root: HTMLElement, sel: string, enabled: boolean): void {
  (root.querySelector(sel) as HTMLButtonElement).disabled = !enabled;
}

function medal(i: number): string {
  return ["🥇", "🥈", "🥉"][i] ?? "•";
}

const TEMPLATE = `
  <div class="game">
    <header class="hud">
      <div class="brand">Hedge<span>ways</span></div>
      <div class="players"></div>
      <button id="btn-bag" class="bag" title="See what's left in the bag"></button>
      <button id="btn-fit" class="icon" title="Recenter board">⤢</button>
      <button id="btn-sound" class="icon" title="Sound">🔊</button>
      <button id="btn-help" class="icon" title="How to play">?</button>
      <button id="btn-quit" class="icon" title="Quit to menu">✕</button>
    </header>
    <canvas class="board"></canvas>
    <footer class="controls">
      <div class="status"></div>
      <div class="hand"></div>
      <div class="buttons">
        <button id="btn-rotate" class="btn">Rotate</button>
        <button id="btn-undo" class="btn">Undo</button>
        <button id="btn-pass" class="btn">Pass</button>
        <button id="btn-confirm" class="btn primary">Confirm turn</button>
      </div>
    </footer>
  </div>`;
