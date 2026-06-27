import { chooseAiMove } from "../game/ai";
import { orient } from "../game/board";
import { COLOUR_HEX, COLOUR_HEX_DARK, COLOUR_NAME, MAX_LAY } from "../game/constants";
import { Game, type GameConfig, type GameSnapshot, type TurnResult, totalScore } from "../game/game";
import { generateMoves } from "../game/moves";
import { validateMove } from "../game/placement";
import type { Cell, Colour, Difficulty, Move, Orientation, PlacedTile, Tile } from "../game/types";
import { COLOURS, key } from "../game/types";
import gsap from "gsap";
import { sfx } from "../audio";
import { mountFarmerPortrait } from "./farmer-portrait";
import { mountCritter } from "./home-critters";
import { getFarmerSprites } from "../render/farmer-sprites";
import { Scene } from "../render/scene";
import { prefersReducedMotion } from "../render/sprites";
import { callout, confetti } from "./effects";
import { showHowTo } from "./howto";
import { clearActive, saveActive } from "../game/persistence";

/** Wiring for an online (human-vs-human) game. The GameUI never owns the socket
 *  — main.ts holds the NetClient, feeds snapshots in via applyServerState(), and
 *  receives the player's move via sendMove(). The authoritative engine lives on
 *  the server; this.game is a per-seat redacted MIRROR. */
export interface OnlineOptions {
  mySeat: number;
  sendMove: (move: Move) => void;
  requestRematch: () => void;
  /** stream my tentative tile positions (colourless) so the opponent sees presence */
  sendGhost: (cells: [number, number][]) => void;
  /** deadline (epoch ms) of the first turn, for the shot-clock */
  turnDeadline?: number;
}

export interface GameUiOptions {
  onQuit?: () => void;
  onRestart?: (config: GameConfig) => void;
  restore?: GameSnapshot;
  online?: OnlineOptions;
}

type OriSpec = [Orientation, boolean];
const ALL_ORI: OriSpec[] = [
  ["H", false],
  ["V", false],
  ["H", true],
  ["V", true],
];
const DEFAULT_ORI = 1; // ["V", false] — a fresh hedge lays vertical (top-to-bottom)
/** How far a dropped tile may be nudged to find a free spot when it lands on an
 *  occupied cell, instead of bouncing back. Rings out cell-by-cell; on the
 *  unbounded sparse grid a free anchor is always within a step or two. */
const NUDGE_RADIUS = 8;
/** Glide duration (s) for a dropped tile settling into its snapped cell. */
const SNAP_TWEEN = 0.18;

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
  /** Current preview/placement orientation. Default 1 = V (top→bottom) to
   *  match the hand chip's vertical 3-segment layout. */
  private oriIndex = DEFAULT_ORI;
  private busy = false;
  /** True while a dropped tile is mid-glide into its snapped cell. Blocks new
   *  pickups/taps for the ~180ms tween so a second gesture can't race it. */
  private placing = false;
  private invalidTimer: number | null = null;
  private botTimer: number | null = null;
  /** active farmer-portrait raf widgets, disposed before re-render */
  private farmerWidgets: { dispose: () => void }[] = [];
  private alive = true;
  /** Honour the OS "reduce motion" setting — bot beats collapse to a quick,
   *  near-instant cadence so the game stays snappy and comfortable. */
  private reduceMotion = prefersReducedMotion();
  /** low-bag tiers already announced, so each callout fires at most once */
  private bagWarned = new Set<number>();
  /** bot player ids that have already taken their first turn — used to give an
   *  expert a one-off longer "opening ponder" the first time it plays. */
  private pondered = new Set<number>();
  /** when a board pending is picked up via drag, remember where it came from
   *  so we can restore on cancel / invalid drop */
  private pickedOrigin: { placement: PlacedTile; oriIdx: number } | null = null;
  /** True while a tile is being actively dragged (hand chip OR board pickup).
   *  Suppresses the mid-drag red/green ghost flicker as the cursor skims past
   *  occupied cells — validity is reported once at drop time via bray + bounce
   *  / flashInvalid, never while the finger is still moving. */
  private dragging = false;
  /** Offset (in cells) from the dragged tile's anchor (segment 0) to the cell
   *  the player actually grabbed. Applied so the grabbed point stays under the
   *  finger — the tile keeps its position on pickup instead of snapping its
   *  anchor to the grab cell. Zero for fresh hand placement (anchor = finger). */
  private grabOffset = { dx: 0, dy: 0 };
  /** Which side a vertical tile's touch lift sits on — fixed at drag start to
   *  the side the tile was lifted from, so the ghost doesn't flip mid-drag. */
  private liftSide: "L" | "R" = "L";
  /** Per-player snapshot of hand tile ids on the last renderHand — used to
   *  detect which tiles are NEW so they can fly in from the bag. */
  private lastHandIds = new Map<number, Set<number>>();

  private onQuit: (() => void) | null;
  private onRestart: ((config: GameConfig) => void) | null;
  private config: GameConfig;

  // ---- online (human-vs-human) state ----
  private online: OnlineOptions | null;
  /** seat whose turn it was on the last applied snapshot — the mover to credit
   *  with the next state's scoring FX (null until the first move). */
  private prevCurrent: number | null = null;
  private turnDeadline = 0;
  private clockTimer: number | null = null;
  /** the end-of-game modal, kept so a server-driven rematch can dismiss it */
  private endModal: HTMLElement | null = null;
  /** last ghost frame sent, to avoid spamming identical presence updates */
  private lastGhostKey = "";

  constructor(root: HTMLElement, config: GameConfig, opts: GameUiOptions = {}) {
    this.root = root;
    this.config = config;
    this.onQuit = opts.onQuit ?? null;
    this.onRestart = opts.onRestart ?? null;
    this.online = opts.online ?? null;
    this.turnDeadline = opts.online?.turnDeadline ?? 0;
    this.game = new Game(config, opts.restore);
    if (this.online) this.prevCurrent = this.game.current;
    // don't shout "bag low" on resume for tiers already passed before this session
    const n0 = this.game.bag.length;
    for (const t of [12, 6, 0]) if (n0 <= t) this.bagWarned.add(t);
    root.innerHTML = TEMPLATE;
    const canvas = root.querySelector<HTMLCanvasElement>(".board")!;
    this.scene = new Scene(canvas);
    this.scene.tapHandler = (x, y) => this.onTapCell(x, y);
    this.scene.hoverHandler = (x, y) => this.onHover(x, y);
    this.scene.leaveHandler = () => this.scene.setGhost(null, false);
    // Drag a placed pending tile around the board to reposition it (or off
    // the board entirely, back to the hand).
    this.scene.dragStart = (x, y) => this.tryPickPending(x, y);
    this.scene.dragMove = (x, y, cx, cy) => this.onPickedMove(x, y, cx, cy);
    this.scene.dragEnd = (x, y, cx, cy) => this.onPickedRelease(x, y, cx, cy);
    // When the scene auto-pans the camera during a drag, the cell under the
    // finger shifts even though the finger hasn't moved — re-resolve the ghost
    // from the cached client point so it tracks the world correctly.
    this.scene.onAutoPan = (cx, cy) => this.updateGhostFromClient(cx, cy);
    // Floating rotate icon on the board → rotate the most recent pending.
    this.scene.rotateRequestHandler = () => this.rotate();

    root.querySelector("#btn-undo")!.addEventListener("click", () => this.undo());
    root.querySelector("#btn-rotate")!.addEventListener("click", () => this.rotate());
    root.querySelector("#btn-confirm")!.addEventListener("click", () => this.confirm());
    root.querySelector("#btn-help")!.addEventListener("click", () => showHowTo());
    root.querySelector("#btn-fit")!.addEventListener("click", () => this.scene.recenter());
    root.querySelector("#btn-zoom-in")!.addEventListener("click", () => this.scene.zoomStep(1.35, this.userTileCenter()));
    root.querySelector("#btn-zoom-out")!.addEventListener("click", () => this.scene.zoomStep(1 / 1.35, this.userTileCenter()));
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
      this.stopClock();
      if (!this.online) clearActive();
      return this.showEnd();
    }
    if (this.online) return this.beginOnlineTurn();
    saveActive(this.game.toSnapshot()); // auto-save at each turn boundary
    const p = this.game.currentPlayer;
    // Bots may re-frame the camera (zoom out to follow the play); on the human's
    // own turn their chosen zoom is respected.
    this.scene.setAutoFrame(p.isBot);
    if (p.isBot) {
      this.setStatus(""); // bot messaging lives in the flashy banner, not the footer
      this.showBotBanner(`${p.animal} ${p.name}`, this.planningLine(p.id), true, p.colour);
      this.renderHand(true);
      this.updateButtons();
      this.setBotThinking(true); // amber glow on the active chip while it ponders
      // Tiny beat so "planning…" paints before the (synchronous) search runs.
      this.botTimer = window.setTimeout(() => this.botMove(), this.reduceMotion ? 40 : 90);
      return;
    }
    // human. If — against all odds — there's no legal placement, quietly hand the
    // turn on (no "pass" is ever shown to the player). See Game.skipStuck.
    if (!this.game.hasLegalMove()) {
      this.game.skipStuck();
      this.syncScene();
      return this.beginTurn();
    }
    this.renderHand(false, true);
    this.setStatus(`Your turn — drag a hedge onto the field`);
    this.updateButtons();
  }

  // ---- online turn driver ----

  /** Online turn dispatch: my turn → enable input; opponent's turn → wait. The
   *  footer always shows MY hand (this client only ever sees its own). Stuck/skip
   *  is the SERVER's job — we never mutate the local mirror here. */
  private beginOnlineTurn(): void {
    const mySeat = this.online!.mySeat;
    const mine = this.game.current === mySeat;
    this.scene.setAutoFrame(!mine); // follow the opponent's play, respect my zoom on my turn
    if (mine) {
      this.hideBotBanner();
      this.renderHand(false, true, { seat: mySeat, interactive: true });
      if (!this.game.hasLegalMove()) {
        // empirically unreachable; the server's shot-clock will skip the turn.
        this.stopClock();
        this.setStatus("No legal placement — your turn will pass.");
      } else {
        this.startClock("Your turn — drag a hedge onto the field");
      }
    } else {
      const opp = this.game.players[this.game.current];
      this.showBotBanner(`${opp.animal} ${opp.name}`, "is planting", true, opp.colour);
      this.renderHand(false, false, { seat: mySeat, interactive: false });
      this.startClock(`${opp.farmerName ?? opp.name} is planting…`);
    }
    this.updateButtons();
  }

  /** Apply an authoritative (redacted) snapshot from the server, animate the move
   *  that produced it, and hand the turn on. Drives BOTH my own committed moves
   *  and the opponent's. */
  applyServerState(snap: GameSnapshot, last: TurnResult | undefined, mySeat: number, turnDeadline: number): void {
    if (!this.online) return;
    this.online.mySeat = mySeat;
    this.turnDeadline = turnDeadline;
    // a rematch arrives as a fresh, non-over state — dismiss the end modal
    if (this.endModal && !snap.gameOver) {
      this.endModal.remove();
      this.endModal = null;
    }
    const mover = this.prevCurrent;
    const oldKeys = new Set(this.game.board.cells.keys());
    this.clearTurnState(); // drop any local pending preview before the truth lands
    this.busy = false;
    this.game.applySnapshot(snap);
    this.syncScene();
    // celebrate the move just made (mine or theirs) using the authoritative result
    if (mover !== null && last && last.ok) {
      const newCells = [...this.game.board.cells.keys()].filter((k) => !oldKeys.has(k));
      if (newCells.length) {
        sfx.place();
        this.scene.flashConnections(newCells);
      }
      const p = this.game.players[mover];
      this.afterCommit(last, { name: p.name, animal: p.animal, colour: p.colour });
    }
    this.prevCurrent = this.game.current;
    this.beginTurn();
  }

  /** Opponent dropped: freeze the game and run a live grace countdown. The turn
   *  shot-clock is paused on the server too, so neither player is penalised for
   *  the other's blip. busy is cleared when the authoritative state resumes. */
  showOpponentLeft(graceMs: number, name?: string): void {
    if (!this.online) return;
    this.hideBotBanner();
    this.busy = true; // no input while the game is paused
    this.renderHand(false, false, { seat: this.online.mySeat, interactive: false });
    this.updateButtons();
    this.turnDeadline = Date.now() + graceMs;
    this.startClock(`${name ?? "A player"} disconnected — waiting for them to return`);
  }

  /** A player returned. A fresh authoritative state (with a reset clock) is
   *  broadcast right after this by the server, which re-renders and unfreezes. */
  showOpponentBack(name?: string): void {
    this.setStatus(`${name ?? "A player"} reconnected — resuming…`);
  }

  /** A player dropped/quit and a bot has already taken their seat. The next
   *  authoritative state shows the bot playing; flag it briefly here. */
  notePlayerLeft(name: string): void {
    if (!this.online) return;
    this.setStatus(`${name} left — a bot takes over their farm 🤖`);
  }

  /** Stream my current tentative placement (settled pending + an optional live
   *  drag preview) to the opponent as colourless presence. Deduped so identical
   *  frames aren't re-sent; only positions ever leave this client. */
  private emitGhost(preview?: PlacedTile["cells"]): void {
    if (!this.online || this.game.current !== this.online.mySeat) return;
    const cells: [number, number][] = [];
    for (const p of this.pending) for (const c of p.cells) cells.push([c.x, c.y]);
    if (preview) for (const c of preview) cells.push([c.x, c.y]);
    const key = cells.map((c) => c.join(",")).sort().join("|");
    if (key === this.lastGhostKey) return;
    this.lastGhostKey = key;
    this.online.sendGhost(cells);
  }

  /** Render the opponent's tentative tiles (positions only — see scene) and pan
   *  the camera to follow them, so the watcher feels the move building. */
  applyOpponentGhost(cells: [number, number][]): void {
    this.scene.setOpponentGhost(cells);
    if (cells.length) this.scene.followCells(cells);
  }

  /** The server rejected our move (e.g. a race, or an illegal lay it caught that
   *  our local pre-check didn't). Un-stick the optimistic 'busy' wait and let the
   *  player try again — no fatal overlay. */
  showActionError(reason: string): void {
    if (!this.online) return;
    this.busy = false;
    if (this.game.current === this.online.mySeat && !this.game.gameOver) {
      this.clearTurnState();
      this.renderHand(false, false, { seat: this.online.mySeat, interactive: true });
      this.updateButtons();
      this.startClock(`Rejected: ${reason} — try again`);
    }
  }

  /** Update the shot-clock against the current turnDeadline, prefixed with `base`. */
  private startClock(base: string): void {
    this.stopClock();
    const statusEl = this.root.querySelector(".status")!;
    const tick = () => {
      if (!this.turnDeadline) {
        statusEl.textContent = base;
        return;
      }
      const s = Math.max(0, Math.ceil((this.turnDeadline - Date.now()) / 1000));
      const mmss = `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
      statusEl.innerHTML = `${base} <b class="clk${s <= 10 ? " low" : ""}">${mmss}</b>`;
    };
    tick();
    this.clockTimer = window.setInterval(tick, 500);
  }

  private stopClock(): void {
    if (this.clockTimer !== null) {
      window.clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private botMove(): void {
    this.botTimer = null;
    if (!this.alive || this.game.gameOver || !this.game.currentPlayer.isBot) return;
    void this.runBotTurn();
  }

  /** Drive one bot turn: search, then a tier-flavoured "planning" beat (with
   *  the AI's actual search latency absorbed so the felt think-time stays
   *  consistent), then the animated lay. */
  private async runBotTurn(): Promise<void> {
    const actor = this.game.currentPlayer;
    const t0 = performance.now();
    const move = chooseAiMove(this.game);
    if (!this.alive || this.game.currentPlayer !== actor) return;
    if (!move) {
      // No legal placement (effectively never happens). Quietly hand the turn on
      // — no "pass" is surfaced. See Game.skipStuck.
      await this.botDelay(this.reduceMotion ? 80 : 200);
      if (!this.alive || this.game.currentPlayer !== actor) return;
      this.setBotThinking(false);
      this.game.skipStuck();
      this.syncScene();
      this.beginTurn();
      return;
    }
    // Hold the planning beat for the remainder of the tier budget that the
    // search didn't already eat (harder AIs deliberate visibly longer). An
    // expert gets a one-off longer ponder on its very first move of the game.
    let budget = this.botThinkBudget(actor.difficulty);
    if (actor.difficulty === "expert" && !this.pondered.has(actor.id) && !this.reduceMotion) {
      budget += 700;
    }
    this.pondered.add(actor.id);
    const remaining = budget - (performance.now() - t0);
    if (remaining > 0) await this.botDelay(remaining);
    if (!this.alive || this.game.currentPlayer !== actor) return;
    await this.botLayMoveAnimated(move, actor);
  }

  /** Toggle the "thinking" amber glow on the current active player chip.
   *  Skipped under reduced motion. The class is naturally cleared when
   *  renderHud() rebuilds the chips at the next turn boundary. */
  private setBotThinking(on: boolean): void {
    const chip = this.root.querySelector(".pchip.active");
    if (chip) chip.classList.toggle("thinking", on && !this.reduceMotion);
  }

  /** Felt "thinking" budget (ms) from search-start to the first hedge landing,
   *  by difficulty — easy is impulsive, expert deliberates. */
  private botThinkBudget(difficulty: Difficulty): number {
    if (this.reduceMotion) return 200;
    const base = { easy: 1100, medium: 1700, hard: 2200, expert: 2800 }[difficulty] ?? 1700;
    return this.ponderMs(base);
  }

  /** Humanise a deliberation pause: wide jitter around `base`, plus an occasional
   *  longer "deep think" — like a person who usually plays briskly but now and
   *  then stops to weigh a tricky spot. Bounded well short of a real 30s ponder. */
  private ponderMs(base: number): number {
    if (this.reduceMotion) return Math.min(200, base);
    let ms = base * (0.6 + Math.random() * 0.9); // ~0.6×–1.5× — very un-metronomic
    if (Math.random() < 0.25) ms += 1000 + Math.random() * 2600; // deep think (~1–3.6s extra)
    return Math.round(ms);
  }

  /** Cancellable delay used between bot placement beats. Parks the handle in
   *  botTimer so a teardown (dispose) cancels any in-flight wait. */
  private botDelay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.botTimer = window.setTimeout(() => {
        this.botTimer = null;
        resolve();
      }, ms);
    });
  }

  /** Animated bot placement with a think→place→think rhythm: each tile is
   *  appended to `pending` in sequence with a `place` sfx, the renderer's pop-in,
   *  and a connect-ring + chime when it abuts a matching neighbour — same feedback
   *  the human gets — but a visible "thinking…" beat (amber glow + status) is held
   *  before each subsequent hedge so the bot reads as deliberating rather than
   *  dumping its whole hand at once. The move is then committed atomically; a beat
   *  is held afterwards so
   *  the placement (and any scoring celebration) reads before the turn passes.
   *  The engine state isn't touched until commit, so a mid-animation teardown
   *  cleanly aborts. */
  private async botLayMoveAnimated(move: Move, actor: { name: string; animal: string; colour?: string }): Promise<void> {
    this.busy = true;
    const rm = this.reduceMotion;
    const THINK_MS = rm ? 120 : 1400; // base "thinking…" beat before each extra hedge (humanised)
    const SETTLE_MS = rm ? 90 : 480; // brief pause after a hedge lands, before the next ponder
    const who = `${actor.animal} ${actor.name}`;
    const colour = actor.colour ?? "#6cc24a";
    for (let i = 0; i < move.tiles.length; i++) {
      if (!this.alive) return;
      if (this.game.currentPlayer !== actor) return; // turn changed under us
      // Deliberate before each subsequent hedge (the first is covered by the
      // pre-lay planning beat) — amber "thinking…" glow + flashy banner, so the
      // bot reads as mulling each placement instead of dumping its whole hand.
      if (i > 0) {
        this.setBotThinking(true);
        this.showBotBanner(who, this.botThinkingLine(i), true, colour);
        await this.botDelay(this.ponderMs(THINK_MS)); // wide jitter + occasional deep think
        if (!this.alive || this.game.currentPlayer !== actor) return;
      }
      // Lay the hedge.
      this.setBotThinking(false);
      const t = move.tiles[i];
      const cells = t.cells.map((c) => ({ ...c }));
      this.pending.push({ tileId: t.tileId, cells });
      this.pendingOri.push(0); // orientation doesn't matter for the visualisation
      sfx.place();
      this.showBotBanner(who, "plants a hedge 🌿", false, colour);
      this.syncScene();
      // Reward connections the same way a human placement does — a ring flash +
      // chime on cells that just clicked into a matching-colour neighbour.
      const hits = this.connectingCells(cells, t.tileId);
      if (hits.length > 0) {
        sfx.connect();
        this.scene.flashConnections(hits.map((c) => key(c.x, c.y)));
      }
      if (i < move.tiles.length - 1) await this.botDelay(SETTLE_MS);
    }
    if (!this.alive) return;
    // Let the last tile's pop-in settle before committing.
    await this.botDelay(rm ? 100 : 400);
    if (!this.alive) return;
    // Clear the visualisation pending and commit the real move so scoring,
    // streaks, and end-of-game checks all run against engine state.
    this.pending = [];
    this.pendingOri = [];
    const res = this.game.commit(move);
    this.afterCommit(res, actor);
    this.syncScene();
    // Hold on the result before handing the turn on — a sealed field savours
    // longer, scaling a touch with the size of the haul (capped), so a big
    // enclosure lands before the next hand flies in.
    const scored = res.scored ?? 0;
    const hold = rm ? 250 : scored > 0 ? Math.min(1600, 760 + scored * 110) : 460;
    await this.botDelay(hold);
    if (!this.alive) return;
    this.busy = false;
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
    const herdTxt = (res.herd ?? 0) > 0 ? ` +${res.herd}🐾` : "";
    const perkTxt = res.perk ? ` · ${res.perk}!` : "";

    let head = "";
    let hot = false;
    if (streak >= 4) (head = "ON FIRE! "), (hot = true);
    else if (streak === 3) (head = "Triple! "), (hot = true);
    else if (streak === 2) (head = "Double! "), (hot = true);
    else if (res.mega) (head = "Bumper field! "), (hot = true);
    else if (res.perk) hot = true; // a fired perk earns the warmer styling too

    callout(`${head}${who} fences in ${acresTxt}${fieldsTxt}${perkTxt}${bonusTxt}${herdTxt}`, hot ? "streak" : "score");
    if (hot) {
      sfx.streak(streak);
      if (res.perk) sfx.bonus(); // a bright little flourish when a livestock perk pays off
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
  /** True iff any of these cells is already occupied (committed tile,
   * enclosed acre, or another pending). The ONLY pre-confirm constraint —
   * everything else (adjacency, colour rules) is verified by the engine
   * when Confirm is pressed. */
  private overlapsOccupied(cells: PlacedTile["cells"], excludePendingIdx = -1): boolean {
    for (const c of cells) {
      const k = key(c.x, c.y);
      if (this.game.board.cells.has(k)) return true;
      if (this.game.board.enclosed.has(k)) return true;
      for (let i = 0; i < this.pending.length; i++) {
        if (i === excludePendingIdx) continue;
        if (this.pending[i].cells.some((pc) => pc.x === c.x && pc.y === c.y)) return true;
      }
    }
    return false;
  }

  /** True iff every pending hedge physically fits: no two pendings share a
   *  cell, and none sits on a committed hedge or enclosed acre. Colour /
   *  adjacency rules are deliberately NOT checked here — those stay deferred to
   *  Confirm. Backstops the input guards so Confirm can never dead-end at a
   *  physical-overlap rejection, regardless of how the pending set was reached. */
  private pendingFits(): boolean {
    const seen = new Set<string>();
    for (const p of this.pending)
      for (const c of p.cells) {
        const k = key(c.x, c.y);
        if (seen.has(k)) return false; // two pending hedges overlap
        if (this.game.board.cells.has(k)) return false; // on a committed hedge
        if (this.game.board.enclosed.has(k)) return false; // inside an enclosed field
        seen.add(k);
      }
    return true;
  }

  /** Nearest anchor to (tx,ty) where the oriented tile physically fits (clear of
   *  committed hedges, enclosed acres, and other pendings), searched ring by ring
   *  out to NUDGE_RADIUS. Returns the fitting cells + anchor, or null if boxed in
   *  on every side (pathological on the unbounded grid). Adjacency/colour are NOT
   *  considered — like every drop, those stay deferred to Confirm, so a lone first
   *  hedge or a not-yet-connected run still lands. */
  private nearestFit(
    tile: Tile,
    tx: number,
    ty: number,
    oriIndex: number,
  ): { cells: PlacedTile["cells"]; tx: number; ty: number } | null {
    const [dir, flip] = ALL_ORI[oriIndex];
    const at = (ax: number, ay: number) => {
      const cells = orient(tile, ax, ay, dir, flip);
      return this.overlapsOccupied(cells) ? null : cells;
    };
    const direct = at(tx, ty);
    if (direct) return { cells: direct, tx, ty };
    for (let r = 1; r <= NUDGE_RADIUS; r++) {
      let best: { cells: PlacedTile["cells"]; tx: number; ty: number } | null = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
          const cells = at(tx + dx, ty + dy);
          if (!cells) continue;
          const d = dx * dx + dy * dy; // nearest by Euclidean distance within the ring
          if (d < bestD) {
            bestD = d;
            best = { cells, tx: tx + dx, ty: ty + dy };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Land a tile as a pending placement: nudge to the nearest free anchor if the
   *  requested one is blocked (never bounce back), then glide it from where it was
   *  released (startOx/startOy = sub-cell drift at drop, world units) into its
   *  snapped cell. Commits the pending only once the tween settles. */
  private dropTile(tile: Tile, anchorX: number, anchorY: number, startOx: number, startOy: number): void {
    const fit = this.nearestFit(tile, anchorX, anchorY, this.oriIndex);
    if (!fit) {
      // Boxed in on every side within NUDGE_RADIUS — return the tile to hand
      // rather than force an overlap. Essentially unreachable in real play.
      this.selectedId = null;
      sfx.invalid();
      this.scene.setGhost(null, false);
      this.syncScene();
      this.renderHand(false);
      this.updateButtons();
      this.emitGhost();
      return;
    }
    const commit = () => {
      this.placing = false;
      if (!this.alive) return; // torn down mid-glide — nothing to commit to
      this.pending.push({ tileId: tile.id, cells: fit.cells });
      this.pendingOri.push(this.oriIndex);
      this.usedIds.add(tile.id);
      this.selectedId = null;
      sfx.place();
      this.scene.setGhost(null, false);
      this.refreshHighlights();
      this.syncScene();
      this.renderHand(false);
      this.updateButtons();
      this.emitGhost();
      const hits = this.connectingCells(fit.cells, tile.id);
      if (hits.length > 0) {
        sfx.connect();
        this.scene.flashConnections(hits.map((c) => key(c.x, c.y)));
      }
    };
    // Glide from the release position (final cell + leftover drift) to the cell.
    const sx = anchorX - fit.tx + startOx;
    const sy = anchorY - fit.ty + startOy;
    if (this.reduceMotion || (Math.abs(sx) < 0.01 && Math.abs(sy) < 0.01)) {
      commit();
      return;
    }
    this.placing = true;
    this.scene.setGhost(fit.cells, true);
    const o = { ox: sx, oy: sy };
    this.scene.setGhostFloat(sx, sy);
    gsap.to(o, {
      ox: 0,
      oy: 0,
      duration: SNAP_TWEEN,
      ease: "power3.out",
      onUpdate: () => this.scene.setGhostFloat(o.ox, o.oy),
      onComplete: commit,
    });
  }

  private onTapCell(x: number, y: number): void {
    if (this.busy || this.placing || this.game.currentPlayer.isBot) return;
    if (this.selectedId == null || this.pending.length >= MAX_LAY) return;
    const tile = this.handTile(this.selectedId);
    if (!tile) return;
    // Free placement: lands at the tapped cell, or glides to the nearest free
    // spot if that one's taken (never a flat rejection). Adjacency / colour
    // rules stay deferred to Confirm.
    this.dropTile(tile, x, y, 0, 0);
  }

  /** Return the cells of a freshly-placed tile whose colour matches at least
   *  one orthogonally-adjacent neighbour cell (committed tile OR another
   *  pending tile, excluding the tile being placed itself). */
  private connectingCells(placedCells: PlacedTile["cells"], placedTileId: number): PlacedTile["cells"] {
    const out: PlacedTile["cells"] = [];
    const ownKeys = new Set(placedCells.map((c) => key(c.x, c.y)));
    for (const c of placedCells) {
      const here = c.colour;
      const neighbours = [
        [c.x + 1, c.y],
        [c.x - 1, c.y],
        [c.x, c.y + 1],
        [c.x, c.y - 1],
      ] as const;
      for (const [nx, ny] of neighbours) {
        const nk = key(nx, ny);
        if (ownKeys.has(nk)) continue;
        // committed tile?
        const committed = this.game.board.cells.get(nk);
        if (committed && committed.colour === here) {
          out.push(c);
          break;
        }
        // another pending?
        let matched = false;
        for (const p of this.pending) {
          if (p.tileId === placedTileId) continue;
          for (const pc of p.cells) {
            if (pc.x === nx && pc.y === ny && pc.colour === here) {
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (matched) {
          out.push(c);
          break;
        }
      }
    }
    return out;
  }

  /** Pointerdown on a board cell — if it's part of a pending tile, pick it
   *  up (remove from pending, set as selected, remember origin). Returns
   *  true to claim the gesture; false to let the scene pan as normal. */
  private tryPickPending(x: number, y: number): boolean {
    if (this.busy || this.placing || this.game.currentPlayer.isBot) return false;
    if (this.pickedOrigin !== null) return false;
    const idx = this.pending.findIndex((p) => p.cells.some((c) => c.x === x && c.y === y));
    if (idx < 0) return false;
    const placement = this.pending.splice(idx, 1)[0];
    const oriIdx = this.pendingOri.splice(idx, 1)[0];
    this.usedIds.delete(placement.tileId);
    this.selectedId = placement.tileId;
    this.oriIndex = oriIdx;
    this.pickedOrigin = { placement, oriIdx };
    this.dragging = true;
    // Keep the grabbed point under the finger so the tile stays exactly where it
    // was on pickup (no anchor-snap, no lift jump). It then tracks the finger
    // 1:1. No touch lift on a re-drag — the tile is already visible on the board
    // and the player expects it to sit still until they move it.
    const anchor = placement.cells[0];
    this.grabOffset = { dx: x - anchor.x, dy: y - anchor.y };
    this.scene.setTouchGhostOffset(false);
    this.clearDanger();
    sfx.pickup();
    this.syncScene();
    this.renderHand(false);
    this.updateButtons();
    this.scene.setGhostFloat(0, 0); // overlay sits exactly on the picked-up tile
    this.onHover(x, y); // ghost overlays the tile exactly where it sat
    return true;
  }

  /** Orientation of the current tile — drives which way the touch lift offsets. */
  private currentOri(): Orientation {
    return ALL_ORI[this.oriIndex][0];
  }

  private onPickedMove(x: number, y: number, clientX: number, clientY: number): void {
    this.updateGhostFromClient(clientX, clientY);
    void x;
    void y;
  }

  /** Centre (world cell-centre) of the hedges the player is laying this turn, so
   *  the zoom buttons home in on the player's own tiles. Undefined when nothing
   *  is pending yet — the zoom then just scales around the current view. */
  private userTileCenter(): { x: number; y: number } | undefined {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const p of this.pending)
      for (const c of p.cells) {
        sx += c.x + 0.5;
        sy += c.y + 0.5;
        n++;
      }
    return n ? { x: sx / n, y: sy / n } : undefined;
  }

  /** Shared ghost/finger-marker update from a raw client point. Used by both
   *  drag entry points (hand-chip drag, board-pickup drag) AND by the scene's
   *  auto-pan callback — whenever the camera moves, the cell under the cached
   *  finger position changes and the ghost must follow. */
  private updateGhostFromClient(clientX: number, clientY: number): void {
    if (!this.scene.pointOverBoard(clientX, clientY)) {
      // Drifted off the board — clear the ghost; release here will un-play.
      this.scene.setGhost(null, false);
      this.scene.setFingerMarker(null);
      this.emitGhost(); // preview gone — fall back to just the settled pending
      return;
    }
    const { target, finger } = this.scene.liftedCellAt(clientX, clientY, this.currentOri(), this.liftSide);
    // The finger dot only makes sense when the ghost is lifted away from the
    // finger (touch hand-placement). On a flush drag the ghost sits at the
    // finger, so the dot would just sit under it — skip it.
    const lifted = target[0] !== finger[0] || target[1] !== finger[1];
    this.scene.setFingerMarker(lifted ? { x: finger[0], y: finger[1] } : null);
    this.onHover(target[0], target[1]);
    // Glide the tile under the finger: the snapped cells above are the drop
    // target; this sub-cell offset is the smooth part. Set AFTER onHover so it
    // isn't zeroed by the non-drag reset there.
    const [ox, oy] = this.scene.dragFloatAt(clientX, clientY);
    this.scene.setGhostFloat(ox, oy);
  }

  private onPickedRelease(x: number, y: number, clientX: number, clientY: number): void {
    this.dragging = false;
    if (this.selectedId == null) return;
    const tile = this.handTile(this.selectedId);
    if (!tile) return;
    // Resolve the lifted target BEFORE clearing the offset flag — liftedCellAt
    // reads `touchGhostOffset` to know whether to apply the lift. If we clear
    // first the tile drops at the finger cell, not the ghost cell.
    const overBoard = this.scene.pointOverBoard(clientX, clientY);
    const lifted = overBoard ? this.scene.liftedCellAt(clientX, clientY, this.currentOri(), this.liftSide) : null;
    this.scene.setTouchGhostOffset(false); // touch drag ending — back to flush
    this.scene.setFingerMarker(null);
    // Released anywhere off the board canvas — un-play. Tile returns to hand
    // with its current orientation preserved so the next pick keeps it.
    if (!overBoard) {
      const tileId = this.selectedId;
      this.pickedOrigin = null;
      this.selectedId = null;
      this.scene.setGhost(null, false);
      this.syncScene();
      this.renderHand(false);
      this.updateButtons();
      sfx.unplay();
      this.emitGhost();
      // Bounce the returning chip so it's obvious the tile is back in hand.
      const chip = this.root.querySelector<HTMLElement>(`.tile[data-tid="${tileId}"]`);
      if (chip) gsap.fromTo(chip, { scale: 0.4, y: -22 }, { scale: 1, y: 0, duration: 0.42, ease: "back.out(2.4)" });
      return;
    }
    // Land where the ghost sat — back out the grab offset so the anchor lands
    // such that the grabbed point is under the finger (WYSIWYG with the preview).
    // If that cell is occupied, dropTile nudges to the nearest free spot rather
    // than bouncing the tile back to where it came from.
    const tx = lifted!.target[0] - this.grabOffset.dx;
    const ty = lifted!.target[1] - this.grabOffset.dy;
    const [sox, soy] = this.scene.dragFloatAt(clientX, clientY);
    void x;
    void y;
    this.pickedOrigin = null;
    this.dropTile(tile, tx, ty, sox, soy);
  }

  private onHover(x: number, y: number): void {
    if (this.busy || this.placing || this.game.currentPlayer.isBot || this.selectedId == null) return;
    const tile = this.handTile(this.selectedId);
    if (!tile) return;
    const [dir, flip] = ALL_ORI[this.oriIndex];
    // (x,y) is where the grabbed point should land — back out the grab offset to
    // get the anchor so the tile keeps its position relative to the finger.
    const cells = orient(tile, x - this.grabOffset.dx, y - this.grabOffset.dy, dir, flip);
    // Ghost colour reflects only whether the tile fits physically. Adjacency
    // / colour rules are deferred to Confirm. Mid-drag we always render valid
    // so the ghost doesn't strobe red as it crosses occupied cells — drop-time
    // validation (bray + bounce-back / flashInvalid) carries the "no" signal.
    const valid = this.dragging ? true : !this.overlapsOccupied(cells);
    if (!this.dragging) this.scene.setGhostFloat(0, 0); // hover/tap preview sits on the grid
    this.scene.setGhost(cells, valid);
    this.emitGhost(cells); // stream the live preview position to the opponent
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
    this.grabOffset = { dx: 0, dy: 0 }; // fresh placement anchors at the finger
    // The orientation NEVER changes silently between picks. The player
    // controls rotation via the Rotate button. If the current orientation
    // has no legal placements for this tile, every cell will read red and
    // the player rotates to find a valid one.
    sfx.pickup();
    this.renderHand(false);
    this.refreshHighlights();
    this.updateButtons();
  }

  private rotate(): void {
    if (this.placing) return; // don't desync orientation from a tile mid-glide
    this.clearDanger();
    // 1) An in-hand tile is selected → rotate its preview orientation by 90°.
    if (this.selectedId != null) {
      this.oriIndex = (this.oriIndex + 1) % 4;
      sfx.rotate();
      this.refreshHighlights();
      return;
    }
    // 2) No selection but a tile is already pending → rotate the last placed
    //    tile in place around its anchor by 90°.
    if (this.pending.length > 0) this.rotateLastPending();
  }

  /** Rotate the most recent pending placement 90° around its anchor, landing on
   *  the next orientation that PHYSICALLY FITS. Rotation obeys the same "can't
   *  sit on an occupied cell" rule as tap/drag placement, so a spin can never
   *  silently park a hedge on top of another (which used to slip through to a
   *  confusing "tiles overlap" rejection only at Confirm). Orientations that
   *  would overlap are skipped; if none of the other three fit, the tile stays
   *  put and brays. Colour/adjacency rules remain deferred to Confirm. */
  private rotateLastPending(): void {
    const lastIdx = this.pending.length - 1;
    const last = this.pending[lastIdx];
    const lastOri = this.pendingOri[lastIdx];
    const tile = this.game.currentPlayer.hand.find((t) => t.id === last.tileId);
    if (!tile) return;
    const anchor = last.cells[0];
    for (let step = 1; step <= 3; step++) {
      const tryOri = (lastOri + step) % 4;
      const [dir, flip] = ALL_ORI[tryOri];
      const cells = orient(tile, anchor.x, anchor.y, dir, flip);
      if (this.overlapsOccupied(cells, lastIdx)) continue; // can't sit here — skip it
      const fromCells = last.cells.map((c) => ({ ...c }));
      this.pending[lastIdx] = { tileId: tile.id, cells };
      this.pendingOri[lastIdx] = tryOri;
      sfx.rotate();
      this.scene.startRotateAnim(fromCells, cells); // smooth 90° transition
      this.syncScene();
      this.updateButtons();
      this.emitGhost();
      return;
    }
    this.flashInvalid(last.cells); // every other orientation overlaps — stay put
  }

  private undo(): void {
    const last = this.pending.pop();
    this.pendingOri.pop();
    if (!last) return;
    this.usedIds.delete(last.tileId);
    this.selectedId = null;
    this.clearDanger();
    this.syncScene();
    this.renderHand(false);
    this.refreshHighlights();
    this.updateButtons();
    this.emitGhost();
  }

  private confirm(): void {
    if (this.pending.length === 0) return;
    const move: Move = { tiles: this.pending.map((t) => ({ tileId: t.tileId, cells: t.cells })) };
    if (this.online) {
      // Pre-validate locally for instant feedback; the server re-validates as the
      // authority. On success, hand the move off and wait for the broadcast — the
      // committed tiles + scoring arrive via applyServerState.
      const v = validateMove(this.game.board, move.tiles);
      if (!v.ok) {
        sfx.invalid();
        this.setStatus(`Can't confirm — ${v.reason}. Adjust your hedges and try again.`);
        this.markDanger();
        return;
      }
      this.clearDanger();
      this.busy = true;
      this.stopClock();
      this.setStatus("Planting…");
      this.updateButtons();
      this.lastGhostKey = "";
      this.online.sendGhost([]); // tiles are committing — drop the presence shadows
      this.online.sendMove(move);
      return;
    }
    const actor = { name: "You", animal: this.game.currentPlayer.animal, colour: this.game.currentPlayer.colour };
    const res = this.game.commit(move);
    if (!res.ok) {
      // Validation happens here, not while dragging. Tell the player exactly
      // what's wrong, bray, flash the offending hedges, and leave them in
      // place to adjust.
      sfx.invalid();
      this.setStatus(`Can't confirm — ${res.reason}. Adjust your hedges and try again.`);
      this.markDanger();
      return;
    }
    this.clearDanger();
    this.afterCommit(res, actor);
    this.syncScene();
    this.beginTurn();
  }

  /** Mark every pending cell as "in danger" — they pulse red until the
   *  player adjusts (move / rotate / undo / pickup). */
  private markDanger(): void {
    const keys: string[] = [];
    for (const p of this.pending) for (const c of p.cells) keys.push(key(c.x, c.y));
    this.scene.setDangerCells(keys);
  }

  private clearDanger(): void {
    this.scene.setDangerCells([]);
  }

  /** Anchor the floating rotate icon at the top-right cell of the LAST
   *  pending tile, or clear if there isn't one. */
  private refreshRotateIcon(): void {
    // Bots never rotate — keep the board free of the floating rotate icon on
    // their turns (e.g. a leftover icon from the human's just-confirmed move).
    if (this.pending.length === 0 || this.game.currentPlayer.isBot) {
      this.scene.setRotateAt(null);
      return;
    }
    const last = this.pending[this.pending.length - 1];
    let maxX = -Infinity;
    let minY = Infinity;
    for (const c of last.cells) {
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
    }
    this.scene.setRotateAt({ x: maxX, y: minY });
  }

  /** Resync the status bar message to reflect the current pending count. */
  private refreshStatus(): void {
    if (this.game.gameOver) return;
    if (this.game.currentPlayer.isBot) return;
    const n = this.pending.length;
    if (n === 0) {
      this.setStatus(`Your turn — drag a hedge onto the field`);
      return;
    }
    const left = 3 - n;
    this.setStatus(
      left > 0
        ? `${n} hedge${n === 1 ? "" : "s"} laid — confirm, or plant up to ${left} more`
        : `3 hedges laid — confirm to end the day`,
    );
  }

  /** Free placement means there are no pre-computed candidate dots to show.
   *  Kept as a stub so existing call-sites don't have to be touched. */
  private refreshHighlights(): void {
    this.scene.setHighlights(new Map());
  }

  /** Legal anchor cells (segment-0 position) for placing `tile` in this orientation now. */
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
    // Keep the floating rotate icon + status text in sync with the pending set.
    this.refreshRotateIcon();
    this.refreshStatus();
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

  private renderHand(hidden: boolean, animate = false, opts?: { seat?: number; interactive?: boolean }): void {
    const el = this.root.querySelector(".hand")!;
    el.innerHTML = "";
    // Online: the footer always shows THIS client's hand (opts.seat), regardless
    // of whose turn it is, and is non-interactive when it isn't our move.
    const p = this.game.players[opts?.seat ?? this.game.current];
    const interactive = opts?.interactive ?? true;
    if (hidden || p.isBot) {
      el.innerHTML = `<div class="hand-hidden">${p.name}'s hedges</div>`;
      return;
    }
    const prev = this.lastHandIds.get(p.id) ?? new Set<number>();
    const freshChips: HTMLElement[] = [];
    for (const tile of p.hand) {
      const d = document.createElement("button");
      d.className = "tile";
      d.dataset.tid = String(tile.id);
      if (this.usedIds.has(tile.id)) d.classList.add("used");
      if (this.selectedId === tile.id) d.classList.add("sel");
      for (const c of tile.segments) {
        const seg = document.createElement("span");
        seg.style.background = COLOUR_HEX[c];
        seg.style.boxShadow = `inset 0 0 0 2px ${COLOUR_HEX_DARK[c]}`;
        d.appendChild(seg);
      }
      if (interactive) this.attachTileInput(d, tile.id);
      else d.classList.add("disabled");
      el.appendChild(d);
      if (!prev.has(tile.id)) freshChips.push(d);
    }
    this.lastHandIds.set(p.id, new Set(p.hand.map((t) => t.id)));
    if (animate) this.flyTilesFromBag(freshChips);
  }

  /** Animate fresh hand chips flying from the bag icon into their slots —
   *  staggered, springy, with a soft "deal" tap per tile. The whole turn-
   *  start render uses this when `animate=true`. */
  private flyTilesFromBag(freshChips: HTMLElement[]): void {
    if (freshChips.length === 0) return;
    const bag = this.root.querySelector(".bag") as HTMLElement | null;
    if (!bag) return;
    const bagRect = bag.getBoundingClientRect();
    if (bagRect.width === 0) return; // bag hidden (e.g. mobile collapse) — skip
    const bagCx = bagRect.left + bagRect.width / 2;
    const bagCy = bagRect.top + bagRect.height / 2;
    freshChips.forEach((chip, i) => {
      const r = chip.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = bagCx - cx;
      const dy = bagCy - cy;
      gsap.fromTo(
        chip,
        { x: dx, y: dy, scale: 0.3, rotation: -200, opacity: 0 },
        {
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          duration: 0.55,
          ease: "back.out(1.8)",
          delay: i * 0.11,
          onStart: () => sfx.deal(),
        },
      );
    });
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
      if (this.busy || this.placing) return;
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
        this.dragging = true; // suppress mid-drag ghost validity flicker
        this.grabOffset = { dx: 0, dy: 0 }; // from-hand: anchor sits at the finger
        // Touch drag → lift the ghost off the finger so it isn't occluded.
        // Seed the lift toward the side the tile was lifted from (where the
        // gesture started), so the ghost stays on that side instead of flipping.
        this.liftSide = this.scene.sideOfClientX(startX);
        this.scene.setTouchGhostOffset(e.pointerType === "touch");
        // commit to the drag: select this tile so the ghost-preview path is live.
        // A fresh hand tile always starts at the default orientation — the last
        // tile's rotation shouldn't carry over to the next one dragged out.
        if (this.selectedId !== tileId) {
          this.selectedId = tileId;
          this.oriIndex = DEFAULT_ORI;
          sfx.pickup();
          this.refreshHighlights();
          this.updateButtons();
        }
      }
      // Feed the scene so edge-auto-pan can fire while the finger lingers near
      // a canvas edge — the scene no-ops the pan when the point is off-canvas.
      this.scene.setDragClient(e.clientX, e.clientY);
      this.updateGhostFromClient(e.clientX, e.clientY);
    });
    const finish = (e: PointerEvent) => {
      if (!pressed) return;
      const wasDrag = dragging;
      pressed = false;
      dragging = false;
      this.dragging = false;
      this.scene.setDragClient(null); // disarm edge-auto-pan
      try {
        d.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
      if (!wasDrag) {
        this.scene.setTouchGhostOffset(false);
        this.scene.setFingerMarker(null);
        this.selectTile(tileId); // short tap toggles selection
        return;
      }
      // IMPORTANT: resolve the lifted target BEFORE clearing the offset flag
      // — liftedCellAt depends on `touchGhostOffset` to know whether to
      // shift up. Clearing first would make it return the bare finger cell
      // and the tile would drop where the finger is, not where the ghost is.
      if (this.scene.pointOverBoard(e.clientX, e.clientY)) {
        const { target } = this.scene.liftedCellAt(e.clientX, e.clientY, this.currentOri(), this.liftSide);
        const [sox, soy] = this.scene.dragFloatAt(e.clientX, e.clientY);
        this.scene.setTouchGhostOffset(false);
        this.scene.setFingerMarker(null);
        const tile = this.handTile(tileId);
        // Glide the dropped tile into its snapped cell (nudging to the nearest
        // free spot if the target's taken). Guard mirrors onTapCell's.
        if (tile && !this.busy && !this.placing && this.pending.length < MAX_LAY) {
          this.dropTile(tile, target[0], target[1], sox, soy);
        }
      } else {
        this.scene.setTouchGhostOffset(false);
        this.scene.setFingerMarker(null);
        this.scene.setGhost(null, false); // off-board: silent abort
      }
      this.renderHand(false);
    };
    d.addEventListener("pointerup", finish);
    d.addEventListener("pointercancel", finish);
  }

  private prevScores: number[] = [];

  private renderHud(): void {
    const ps = this.root.querySelector(".players") as HTMLElement;
    // dispose any prior farmer canvases before clearing the chips
    for (const w of this.farmerWidgets) w.dispose();
    this.farmerWidgets = [];
    ps.innerHTML = "";
    // Drive the mobile score-row grid: one equal column per farmer so 3-4
    // players sit in a single row instead of wrapping into a stack.
    ps.style.setProperty("--pcols", String(this.game.players.length));
    const lead = Math.max(...this.game.players.map((p) => totalScore(p)));
    this.game.players.forEach((p) => {
      const total = totalScore(p);
      const chip = document.createElement("div");
      const active = p.id === this.game.current && !this.game.gameOver;
      chip.className = "pchip" + (active ? " active" : "") + (total === lead && lead > 0 ? " lead" : "");
      chip.style.setProperty("--pc", p.colour);
      const tip = `${p.score} acres${p.bonus > 0 ? ` + ${p.bonus} flair 🔥` : ""}${p.herdBonus > 0 ? ` + ${p.herdBonus} herd 🐾` : ""}`;
      const bonusTag = p.bonus > 0 ? `<span class="pbonus" title="${tip}">+${p.bonus}<i>🔥</i></span>` : "";
      const herdTag = p.herdBonus > 0 ? `<span class="pbonus herd" title="${tip} — bigger pastures house bigger herds">+${p.herdBonus}<i>🐾</i></span>` : "";
      const usingSprite = !!p.farmerId && getFarmerSprites().knows(p.farmerId);
      const portraitHtml = usingSprite
        ? `<span class="pfarmer"></span>`
        : `<span class="panimal">${p.animal}</span>`;
      chip.innerHTML =
        portraitHtml +
        `<span class="pname">${p.name}</span>` +
        `<span class="pscore">${total}<small>🌿</small></span>` +
        bonusTag +
        herdTag;
      ps.appendChild(chip);
      // Mount the animated farmer head-shot into the placeholder span. Active
      // player gets idle bob; others render a single static frame (cheap).
      if (usingSprite && p.farmerId) {
        const host = chip.querySelector(".pfarmer") as HTMLElement | null;
        if (host) {
          // Smaller head-shot on phones so 3-4 chips + bonus tags fit the score row.
          const portraitSize = window.innerWidth <= 600 ? 22 : 30;
          const w = mountFarmerPortrait(host, p.farmerId, {
            size: portraitSize,
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
    const myOnlineTurn = !this.online || (this.game.current === this.online.mySeat && !this.busy);
    const human = !this.game.currentPlayer.isBot && !this.game.gameOver && myOnlineTurn;
    const canConfirm = human && this.pending.length > 0 && this.pendingFits();
    btn(this.root, "#btn-undo", human && this.pending.length > 0);
    // Rotate works on a selected (not-yet-placed) tile or the last pending one —
    // so the player never has to hunt for the small floating board icon.
    btn(this.root, "#btn-rotate", human && (this.selectedId != null || this.pending.length > 0));
    btn(this.root, "#btn-confirm", canConfirm);
    (this.root.querySelector("#btn-confirm") as HTMLElement).classList.toggle("ready", canConfirm);
  }

  private setStatus(msg: string): void {
    this.root.querySelector(".status")!.textContent = msg;
  }

  /** Flashy "whose turn / what they're doing" banner pinned just below the score
   *  header (SproutWord-style): the bot's animal + name, an action line, a radial
   *  glow tinted to the player's colour, and animated "…" dots while thinking.
   *  Re-springs in on every beat so the deliberation reads as a live callout. */
  private showBotBanner(who: string, action: string, thinking: boolean, colour: string): void {
    const el = this.root.querySelector(".turn-banner") as HTMLElement | null;
    if (!el) return;
    el.hidden = false;
    el.style.setProperty("--accent", colour || "#6cc24a");
    el.classList.toggle("thinking", thinking);
    const base = action.replace(/…\s*$/, "");
    const dots = thinking && !this.reduceMotion ? `<span class="think-dots"><i>.</i><i>.</i><i>.</i></span>` : thinking ? "…" : "";
    el.innerHTML =
      `<span class="tb-glow"></span>` +
      `<span class="tb-who">${who}</span>` +
      `<span class="tb-act">${base}${dots}</span>`;
    if (this.reduceMotion) return;
    gsap.fromTo(
      el,
      { y: -16, scale: 0.7, opacity: 0, rotate: -2 },
      { y: 0, scale: 1, opacity: 1, rotate: 0, duration: 0.5, ease: "back.out(2.6)", clearProps: "opacity,transform" },
    );
  }

  private hideBotBanner(): void {
    const el = this.root.querySelector(".turn-banner") as HTMLElement | null;
    if (!el) return;
    el.hidden = true;
    el.innerHTML = "";
    el.classList.remove("thinking");
  }

  private clearTurnState(): void {
    this.hideBotBanner(); // a bot turn's banner never bleeds into the next turn
    this.pending = [];
    this.pendingOri = [];
    this.usedIds.clear();
    this.selectedId = null;
    this.oriIndex = DEFAULT_ORI;
    this.dragging = false;
    this.grabOffset = { dx: 0, dy: 0 };
    this.scene.setHighlights(new Map());
    this.scene.setGhost(null, false);
    this.scene.setOpponentGhost([]); // drop any opponent presence shadows
  }

  /** A warm, farmer-ish "thinking" line for a bot's turn (stable per turn). */
  private planningLine(playerId: number): string {
    const lines = [
      "is sizing up the field…",
      "is eyeing the hedgerows…",
      "scratches their chin…",
      "is pacing the furrows…",
      "weighs up where to plant…",
      "is reading the land…",
    ];
    return lines[(playerId + this.game.turn) % lines.length];
  }

  /** A "thinking…" line shown before each extra hedge in a multi-tile lay, so the
   *  pauses between placements clearly read as deliberation. Varied per tile to
   *  stay un-robotic. */
  private botThinkingLine(i: number): string {
    const lines = [
      "is thinking…",
      "ponders the next hedge…",
      "eyes another spot…",
      "weighs a second hedge…",
    ];
    return lines[(i + this.game.turn) % lines.length];
  }

  private toggleSound(e: Event): void {
    const on = !sfx.isEnabled();
    sfx.setEnabled(on);
    (e.currentTarget as HTMLElement).textContent = on ? "🔊" : "🔇";
  }

  /** Tear down: stop the render loop, cancel pending bot/animation timers. */
  dispose(): void {
    this.alive = false;
    this.stopClock();
    if (this.botTimer !== null) window.clearTimeout(this.botTimer);
    if (this.invalidTimer !== null) window.clearTimeout(this.invalidTimer);
    for (const w of this.farmerWidgets) w.dispose();
    this.farmerWidgets = [];
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
    if (this.online) {
      // online: the bag is hidden on the server; we only know the count.
      const back = document.createElement("div");
      back.className = "modal-back";
      back.innerHTML = `
        <div class="modal bag-modal">
          <h2>🌱 ${bag.length} hedge${bag.length === 1 ? "" : "s"} left</h2>
          <p>${empty ? "The bag is empty — everyone's playing out their final hands." : "The bag is shuffled on the server and hidden from both players — only the count is shared."}</p>
          <div class="end-btns"><button class="btn primary" id="bag-close">Got it</button></div>
        </div>`;
      this.root.appendChild(back);
      const close = () => back.remove();
      back.querySelector("#bag-close")!.addEventListener("click", close);
      back.addEventListener("click", (e) => {
        if (e.target === back) close();
      });
      return;
    }
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

  /** The opponent forfeited a live game (quit / never returned) → this client
   *  wins by default. Force the game over locally and show a win end screen. */
  showForfeitWin(): void {
    if (!this.online || this.game.gameOver) return;
    this.stopClock();
    this.hideBotBanner();
    this.busy = true;
    this.game.gameOver = true;
    this.game.winnerId = this.online.mySeat;
    this.showEnd({ forfeit: true });
  }

  private showEnd(opts?: { forfeit?: boolean }): void {
    const forfeit = opts?.forfeit ?? false;
    const mySeat = this.online?.mySeat ?? -1;
    const standings = this.game.standings();
    const winner = standings[0];
    // a forfeit is always a win for the viewer (only the remaining player sees it)
    const tie = !forfeit && standings.filter((p) => totalScore(p) === totalScore(winner)).length > 1;
    const iWon = forfeit || (this.online ? winner.id === mySeat : winner.name === "You");
    const winLine = tie
      ? "Sundown — it's a tie!"
      : iWon
        ? "Sundown — you win the farm!"
        : `Sundown — ${winner.farmerName ?? winner.name} wins the farm!`;
    confetti();
    sfx.win();
    // Hero tableau: the winner's farmer + livestock celebrating, when we have
    // sprite art and a clear (non-tie) winner; otherwise the plain trophy.
    const heroFid = winner.farmerId && getFarmerSprites().knows(winner.farmerId) ? winner.farmerId : "";
    const showHero = !tie && !!heroFid;
    const heroHtml = showHero
      ? `<div class="victory-stage"><span class="vs-farmer" data-fid="${heroFid}"></span><span class="vs-animal" data-animal="${winner.animal}"></span></div>`
      : `<div class="trophy">${tie ? "🤝" : "🚜"}</div>`;
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
      <div class="modal end">
        ${heroHtml}
        <h2>${winLine}</h2>
        ${forfeit ? `<p class="forfeit-note">Your opponent forfeited the game.</p>` : ""}
        <table>${standings
          .map((p, i) => {
            const parts: string[] = [];
            if (p.bonus > 0) parts.push(`${p.bonus}🔥`);
            if (p.herdBonus > 0) parts.push(`${p.herdBonus}🐾`);
            const bonusNote = parts.length ? `<small> (${p.score} + ${parts.join(" + ")})</small>` : "";
            const portrait = p.farmerId && getFarmerSprites().knows(p.farmerId)
              ? `<span class="endfarmer" data-fid="${p.farmerId}" data-pos="${i}"></span>`
              : `${p.animal}`;
            const winRow = forfeit ? p.id === mySeat : i === 0 && !tie;
            return `<tr class="${winRow ? "win" : ""}"><td>${medal(i)} ${portrait} ${p.name}</td><td>${totalScore(p)} acre${totalScore(p) === 1 ? "" : "s"}${bonusNote}</td></tr>`;
          })
          .join("")}</table>
        <div class="end-btns">
          <button class="btn" id="end-inspect">View field</button>
          <button class="btn" id="end-menu">Farmhouse</button>
          ${forfeit ? "" : `<button class="btn primary" id="end-again">${this.online ? "Rematch" : "Next harvest"}</button>`}
        </div>
      </div>`;
    this.root.appendChild(back);
    // Mount farmer animations into the standings rows — winners get a happy
    // cheer cycle, others a calmer idle.
    const podiumWidgets: { dispose: () => void }[] = [];
    if (showHero) {
      const fHost = back.querySelector<HTMLElement>(".vs-farmer");
      const aHost = back.querySelector<HTMLElement>(".vs-animal");
      if (fHost) {
        const w = mountFarmerPortrait(fHost, heroFid, { size: 116, crop: "full", state: "happy", phase: 0 });
        if (w) podiumWidgets.push(w);
      }
      // animal faces left (mirrored) so it turns toward the farmer
      if (aHost) podiumWidgets.push(mountCritter(aHost, winner.animal, { size: 92, state: "happy", facing: -1, phase: 0.5 }));
    }
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
      if (this.endModal === back) this.endModal = null;
    };
    this.endModal = back; // so a server rematch can tear it down
    back.querySelector("#end-inspect")!.addEventListener("click", closeModal);
    back.querySelector("#end-menu")!.addEventListener("click", () => {
      closeModal();
      if (this.onQuit) this.onQuit();
      else location.reload();
    });
    back.querySelector("#end-again")?.addEventListener("click", () => {
      if (this.online) {
        // ask the server for a rematch; the fresh game arrives as a new state and
        // closes this modal (see applyServerState). Reflect the wait here.
        this.online.requestRematch();
        const btn = back.querySelector("#end-again") as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = "Waiting for opponent…";
        return;
      }
      closeModal();
      this.restart();
    });
  }

  // ---- test hook ----
  /** Play one legal move for the current player; returns true if a move was laid. */
  autoPlayTurn(): boolean {
    if (this.game.gameOver) return false;
    if (this.online) {
      if (this.game.current !== this.online.mySeat || this.busy) return false;
      const mine = generateMoves(this.game.board, this.game.players[this.online.mySeat].hand, { limit: 1, maxNodes: Infinity });
      if (mine.length === 0) return false;
      this.busy = true;
      this.online.sendMove(mine[0]);
      return true;
    }
    const moves = generateMoves(this.game.board, this.game.currentPlayer.hand, { limit: 1, maxNodes: Infinity });
    if (moves.length === 0) {
      this.game.skipStuck();
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
      <button id="btn-sound" class="icon" title="Sound">🔊</button>
      <button id="btn-help" class="icon" title="How to play">?</button>
      <button id="btn-quit" class="icon" title="Quit to menu">✕</button>
    </header>
    <div class="stage">
      <canvas class="board"></canvas>
      <div class="turn-banner" hidden></div>
      <div class="zoom-cta">
        <button id="btn-zoom-in" class="zbtn" title="Zoom in" aria-label="Zoom in">+</button>
        <button id="btn-zoom-out" class="zbtn" title="Zoom out" aria-label="Zoom out">−</button>
        <button id="btn-fit" class="zbtn" title="Centre grid" aria-label="Centre grid">⤢</button>
      </div>
    </div>
    <footer class="controls">
      <div class="status"></div>
      <div class="hand"></div>
      <div class="buttons">
        <button id="btn-undo" class="btn">Undo</button>
        <button id="btn-rotate" class="btn">↻ Rotate</button>
        <button id="btn-confirm" class="btn primary">Plant hedges</button>
      </div>
    </footer>
  </div>`;
