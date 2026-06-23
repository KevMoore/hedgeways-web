import { chooseAiMove } from "../game/ai";
import { isPalindrome, orient } from "../game/board";
import { COLOUR_HEX, COLOUR_HEX_DARK, MAX_LAY } from "../game/constants";
import { Game, type GameConfig } from "../game/game";
import { generateMoves } from "../game/moves";
import { validateMove } from "../game/placement";
import type { Cell, Move, Orientation, PlacedTile, Tile } from "../game/types";
import { key } from "../game/types";
import { sfx } from "../audio";
import { Scene } from "../render/scene";
import { callout, confetti } from "./effects";
import { showHowTo } from "./howto";

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
  private usedIds = new Set<number>();
  private selectedId: number | null = null;
  private oriIndex = 0;
  private busy = false;
  private invalidTimer: number | null = null;
  /** tappable cell -> the placement that would result (covers any of the hedge's cells) */
  private placementByCell = new Map<string, PlacedTile>();

  constructor(root: HTMLElement, config: GameConfig) {
    this.root = root;
    this.game = new Game(config);
    root.innerHTML = TEMPLATE;
    const canvas = root.querySelector<HTMLCanvasElement>(".board")!;
    this.scene = new Scene(canvas);
    this.scene.tapHandler = (x, y) => this.onTapCell(x, y);
    this.scene.hoverHandler = (x, y) => this.onHover(x, y);
    this.scene.leaveHandler = () => this.scene.setGhost(null, false);

    root.querySelector("#btn-rotate")!.addEventListener("click", () => this.rotate());
    root.querySelector("#btn-undo")!.addEventListener("click", () => this.undo());
    root.querySelector("#btn-confirm")!.addEventListener("click", () => this.confirm());
    root.querySelector("#btn-pass")!.addEventListener("click", () => this.passTurn());
    root.querySelector("#btn-help")!.addEventListener("click", () => showHowTo());
    root.querySelector("#btn-fit")!.addEventListener("click", () => this.scene.recenter());
    root.querySelector("#btn-sound")!.addEventListener("click", (e) => this.toggleSound(e));

    this.syncScene();
    this.renderHud();
    this.beginTurn();
  }

  // ---- turn lifecycle ----
  private beginTurn(): void {
    this.clearTurnState();
    this.renderHud();
    if (this.game.gameOver) return this.showEnd();
    const p = this.game.currentPlayer;
    if (p.isBot) {
      this.setStatus(`${p.name} is planning…`);
      this.renderHand(true);
      this.updateButtons();
      window.setTimeout(() => this.botMove(), 480);
      return;
    }
    // human
    const hasMove = this.game.hasLegalMove();
    this.renderHand(false);
    this.setStatus(
      hasMove
        ? `Your turn — pick a hedge, then choose a highlighted square`
        : `No legal move — you must pass`,
    );
    this.updateButtons();
  }

  private botMove(): void {
    if (this.game.gameOver) return;
    const move = chooseAiMove(this.game, { iterations: 200 });
    const name = this.game.currentPlayer.name;
    if (!move) {
      this.game.pass();
      callout(`${name} passes`);
    } else {
      const res = this.game.commit(move);
      this.afterCommit(res.newlyEnclosed ?? [], res.scored ?? 0, name);
    }
    this.syncScene();
    this.beginTurn();
  }

  private afterCommit(newly: string[], scored: number, name: string): void {
    if (scored > 0) {
      this.scene.flashEnclosed(newly);
      sfx.score(scored);
      callout(`${name} +${scored} acre${scored === 1 ? "" : "s"}`);
    } else {
      sfx.place();
    }
  }

  // ---- human input ----
  private onTapCell(x: number, y: number): void {
    if (this.busy || this.game.currentPlayer.isBot) return;
    if (this.selectedId == null) return;
    // tap ANY cell a legal placement would cover
    const candidate = this.placementByCell.get(key(x, y));
    if (candidate) {
      this.pending.push(candidate);
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
          ? `${this.pending.length} laid — tap Confirm, or add up to ${left} more`
          : `3 hedges laid — tap Confirm turn`,
      );
      return;
    }
    // invalid spot: brief red feedback in the current orientation
    const tile = this.handTile(this.selectedId);
    if (!tile) return;
    const [dir, flip] = ALL_ORI[this.oriIndex];
    this.flashInvalid(orient(tile, x, y, dir, flip));
  }

  private onHover(x: number, y: number): void {
    if (this.busy || this.game.currentPlayer.isBot || this.selectedId == null) return;
    const candidate = this.placementByCell.get(key(x, y));
    if (candidate) {
      this.scene.setGhost(candidate.cells, true);
      return;
    }
    const tile = this.handTile(this.selectedId);
    if (!tile) return;
    const [dir, flip] = ALL_ORI[this.oriIndex];
    this.scene.setGhost(orient(tile, x, y, dir, flip), false);
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
    this.selectedId = this.selectedId === id ? null : id;
    this.oriIndex = this.firstUsableOri(id);
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
    if (this.selectedId == null) return;
    const tile = this.handTile(this.selectedId)!;
    const allowed = isPalindrome(tile) ? [0, 1] : [0, 1, 2, 3];
    const pos = allowed.indexOf(this.oriIndex);
    this.oriIndex = allowed[(pos + 1) % allowed.length];
    sfx.rotate();
    this.refreshHighlights();
  }

  private undo(): void {
    const last = this.pending.pop();
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
    const res = this.game.commit(move);
    if (!res.ok) {
      this.setStatus(`Illegal: ${res.reason}`);
      return;
    }
    this.afterCommit(res.newlyEnclosed ?? [], res.scored ?? 0, "You");
    this.syncScene();
    this.beginTurn();
  }

  passTurn(): void {
    if (this.game.gameOver) return;
    this.game.pass();
    this.beginTurn();
  }

  // ---- highlights ----
  private refreshHighlights(): void {
    this.placementByCell.clear();
    if (this.selectedId == null) {
      this.scene.setHighlights([]);
      return;
    }
    const tile = this.handTile(this.selectedId)!;
    const cands = this.anchorsFor(tile, ALL_ORI[this.oriIndex]);
    const cover = new Set<string>();
    // map every covered cell -> a placement, so tapping anywhere on the hedge works.
    // prefer the placement whose anchor is the tapped cell for predictable behaviour.
    for (const [anchorKey, cand] of cands) {
      this.placementByCell.set(anchorKey, cand);
      for (const c of cand.cells) cover.add(key(c.x, c.y));
    }
    for (const cand of cands.values()) {
      for (const c of cand.cells) {
        const ck = key(c.x, c.y);
        if (!this.placementByCell.has(ck)) this.placementByCell.set(ck, cand);
      }
    }
    this.scene.setHighlights(cover);
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
    this.scene.syncBoard(this.workingCells(), this.game.board.enclosed);
  }

  private handTile(id: number): Tile | undefined {
    return this.game.currentPlayer.hand.find((t) => t.id === id);
  }

  private renderHand(hidden: boolean): void {
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
      d.addEventListener("click", () => this.selectTile(tile.id));
      el.appendChild(d);
    }
  }

  private renderHud(): void {
    const ps = this.root.querySelector(".players")!;
    ps.innerHTML = "";
    this.game.players.forEach((p) => {
      const chip = document.createElement("div");
      chip.className = "pchip" + (p.id === this.game.current && !this.game.gameOver ? " active" : "");
      chip.innerHTML = `<b>${p.name}</b><span>${p.score}</span>`;
      ps.appendChild(chip);
    });
    this.root.querySelector(".bag")!.textContent = `Bag ${this.game.bag.length}`;
  }

  private updateButtons(): void {
    const human = !this.game.currentPlayer.isBot && !this.game.gameOver;
    const hasMove = human && this.game.hasLegalMove();
    btn(this.root, "#btn-rotate", human && this.selectedId != null);
    btn(this.root, "#btn-undo", human && this.pending.length > 0);
    btn(this.root, "#btn-confirm", human && this.pending.length > 0);
    btn(this.root, "#btn-pass", human && !hasMove && this.pending.length === 0);
  }

  private setStatus(msg: string): void {
    this.root.querySelector(".status")!.textContent = msg;
  }

  private clearTurnState(): void {
    this.pending = [];
    this.usedIds.clear();
    this.selectedId = null;
    this.oriIndex = 0;
    this.placementByCell.clear();
    this.scene.setHighlights([]);
    this.scene.setGhost(null, false);
  }

  private toggleSound(e: Event): void {
    const on = !sfx.isEnabled();
    sfx.setEnabled(on);
    (e.currentTarget as HTMLElement).textContent = on ? "🔊" : "🔇";
  }

  private showEnd(): void {
    const standings = this.game.standings();
    const winner = standings[0];
    const tie = standings.filter((p) => p.score === winner.score).length > 1;
    confetti();
    sfx.win();
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
      <div class="modal end">
        <h2>${tie ? "It's a tie!" : `${winner.name} wins!`}</h2>
        <table>${standings
          .map((p) => `<tr><td>${p.name}</td><td>${p.score} acres</td></tr>`)
          .join("")}</table>
        <div class="end-btns">
          <button class="btn" id="end-inspect">Inspect board</button>
          <button class="btn primary" id="end-again">Play again</button>
        </div>
      </div>`;
    this.root.appendChild(back);
    back.querySelector("#end-inspect")!.addEventListener("click", () => back.remove());
    back.querySelector("#end-again")!.addEventListener("click", () => location.reload());
  }

  // ---- test hook ----
  /** Play one legal move (or pass) for the current player; returns true if a move was laid. */
  autoPlayTurn(): boolean {
    if (this.game.gameOver) return false;
    const moves = generateMoves(this.game.board, this.game.currentPlayer.hand, { limit: 1 });
    if (moves.length === 0) {
      this.game.pass();
      this.syncScene();
      this.beginTurn();
      return false;
    }
    const res = this.game.commit(moves[0]);
    this.afterCommit(res.newlyEnclosed ?? [], res.scored ?? 0, this.game.currentPlayer.name);
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

const TEMPLATE = `
  <div class="game">
    <header class="hud">
      <div class="brand">Hedge<span>ways</span></div>
      <div class="players"></div>
      <div class="bag"></div>
      <button id="btn-fit" class="icon" title="Recenter board">⤢</button>
      <button id="btn-sound" class="icon" title="Sound">🔊</button>
      <button id="btn-help" class="icon" title="How to play">?</button>
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
