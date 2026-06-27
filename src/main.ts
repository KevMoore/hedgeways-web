import "./style.css";
import gsap from "gsap";
import { GameUI } from "./ui/game-ui";
import { showHowTo } from "./ui/howto";
import type { Difficulty } from "./game/types";
import type { GameConfig, GameSnapshot, TurnResult } from "./game/game";
import { describeSave, loadActive } from "./game/persistence";
import { FARMERS, LIVESTOCK, PLAYER_KITS, PUBLIC_FARMERS, SECRET_FARMER_ID, type Farmer } from "./game/constants";
import { NetClient, clearSession, loadSession, saveSession, type LobbyInfo, type NetHandlers, type OnlineSession } from "./net/client";
import type { OnlineKit } from "./net/protocol";
import { confetti, callout } from "./ui/effects";
import { mountHomeCritters } from "./ui/home-critters";
import { mountFarmScene } from "./ui/farm-scene";
import { mountFarmerPortrait } from "./ui/farmer-portrait";
import { getFarmerSprites } from "./render/farmer-sprites";
import { sfx } from "./audio";

const app = document.getElementById("app")!;
let ui: GameUI | null = null;
let stopHome: (() => void) | null = null;
let net: NetClient | null = null;
/** false until the first authoritative state arrives and the online board mounts */
let onlineStarted = false;
/** the room code we're in, used to (re)render the lobby on each lobby update */
let myCode = "";

// ---- secret farmer (Easter egg) — unlocked by tapping the title 7× ----
const SECRET_FARMER = FARMERS.find((f) => f.id === SECRET_FARMER_ID)!;
const SECRET_KEY = "hedgeways.secretFarmer";
const secretUnlocked = (): boolean => {
  try {
    return localStorage.getItem(SECRET_KEY) === "1";
  } catch {
    return false;
  }
};
const unlockSecret = (): void => {
  try {
    localStorage.setItem(SECRET_KEY, "1");
  } catch {
    /* private mode — the unlock just won't persist */
  }
};
/** Set when the player unlocks the farmer, so the next renderStart auto-selects
 *  it and throws a little celebration. */
let revealSecretOnRender = false;

function teardownNet(): void {
  net?.close();
  net = null;
  onlineStarted = false;
}

/** Dispose any running game (stop its render loop + bot timers) before swapping the screen. */
function teardown(): void {
  ui?.dispose();
  ui = null;
  stopHome?.();
  stopHome = null;
  sfx.setAnimals([]); // no critter ambience on the menu
  sfx.stopMusic(); // music + ambience only play during a game
}

function startGame(config: GameConfig, restore?: GameSnapshot): GameUI {
  teardown();
  const opts = {
    onQuit: () => renderStart(),
    onRestart: (c: GameConfig) => startGame(c),
    restore,
  };
  ui = new GameUI(app, config, opts);
  sfx.startMusic();
  (window as any).__hedge = {
    ui,
    state: () => ui!.state(),
    autoPlayTurn: () => ui!.autoPlayTurn(),
    newGame: (c: GameConfig) => (ui = new GameUI(app, c, opts)),
  };
  return ui;
}

/** Easter egg: sit back and watch four bots — one of each tier — farm it out.
 *  Reuses the normal all-bot flow (the turn loop auto-drives any isBot seat). */
function startSpectate(): void {
  const farmerPool = PUBLIC_FARMERS.map((_, i) => i).sort(() => Math.random() - 0.5);
  const diffs: Difficulty[] = ["easy", "medium", "hard", "expert"];
  const players = [0, 1, 2, 3].map((i) => {
    const f = PUBLIC_FARMERS[farmerPool[i]];
    const l = LIVESTOCK[i];
    return {
      name: f.name,
      isBot: true,
      difficulty: diffs[i],
      colour: f.colour,
      animal: l.animal,
      farmerId: f.id,
      farmerName: f.name,
    };
  });
  startGame({ players, seed: (Math.random() * 0xffffffff) >>> 0 });
}

// ---- online (human-vs-human) ----

/** A dismissable centered overlay for online lobby/connection UI. Tagged
 *  `net-overlay` so clearOverlays() never touches the game's own modals
 *  (end screen, how-to, bag peek). */
function overlay(html: string): HTMLElement {
  const back = document.createElement("div");
  back.className = "modal-back net-overlay";
  back.innerHTML = `<div class="modal">${html}</div>`;
  app.appendChild(back);
  return back;
}
function clearOverlays(): void {
  app.querySelectorAll(".net-overlay").forEach((m) => m.remove());
}

/** Reconnection backoff state (transient network drops mid-game). */
let reconnectTries = 0;
let reconnecting = false;
const RECONNECT_DELAYS = [600, 1500, 3000, 5000];

function showConnLost(): void {
  clearOverlays();
  const back = overlay(`<h2>Connection lost</h2><p>Couldn't reach the game server — your game may have ended.</p><div class="end-btns"><button class="btn primary" id="ov-menu">Back to menu</button></div>`);
  back.querySelector("#ov-menu")!.addEventListener("click", () => {
    teardownNet();
    clearSession();
    renderStart();
  });
}

/** Try to silently rejoin an in-progress game after a transient drop, backing off
 *  over a few attempts before surfacing "connection lost". */
function scheduleReconnect(): void {
  const sess = loadSession();
  if (!sess || reconnectTries >= RECONNECT_DELAYS.length) {
    reconnecting = false;
    return showConnLost();
  }
  reconnecting = true;
  const delay = RECONNECT_DELAYS[reconnectTries++];
  clearOverlays();
  overlay(`<h2>Reconnecting…</h2><p>Lost contact — rejoining your game (attempt ${reconnectTries})…</p>`);
  window.setTimeout(() => {
    net = new NetClient(makeNetHandlers());
    net.connect(() => net?.reconnect(sess.code, sess.token));
  }, delay);
}

/** Build the player's online identity from their chosen farmer + livestock. */
function buildKit(f: Farmer, livestockIdx: number): OnlineKit {
  const l = LIVESTOCK[livestockIdx];
  return { name: f.name, colour: f.colour, animal: l.animal, farmerId: f.id, farmerName: f.name };
}

/** Mount the live board on the first authoritative snapshot; thereafter feed
 *  every snapshot straight into the running GameUI. */
function makeNetHandlers(): NetHandlers {
  return {
    onSeated(code: string, seat: number, token: string) {
      myCode = code;
      saveSession({ code, token, seat });
    },
    onLobby(info: LobbyInfo) {
      renderLobby(info); // every seat sees the table fill; host gets the Start button
    },
    onState(snap: GameSnapshot, last: TurnResult | undefined, mySeat: number, turnDeadline: number) {
      // any authoritative state means we're connected and in sync again
      reconnecting = false;
      reconnectTries = 0;
      clearOverlays();
      if (!onlineStarted) {
        onlineStarted = true;
        startOnlineGame(snap, mySeat, turnDeadline);
      } else {
        ui?.applyServerState(snap, last, mySeat, turnDeadline);
      }
    },
    onPlayerLeft(_seat: number, name: string, graceMs: number) {
      // graceMs > 0: a human dropped and the game is paused while we wait for them.
      // graceMs === 0: a bot has already taken the seat — the next state shows it,
      // so just flag it briefly.
      if (graceMs > 0) ui?.showOpponentLeft(graceMs, name);
      else ui?.notePlayerLeft(name);
    },
    onPlayerBack(_seat: number, name: string) {
      ui?.showOpponentBack(name);
    },
    onGhost(cells: [number, number][]) {
      ui?.applyOpponentGhost(cells);
    },
    onClosed(reason: string) {
      clearSession();
      teardownNet();
      const back = overlay(`<h2>Game over</h2><p>${reason}</p><div class="end-btns"><button class="btn primary" id="ov-menu">Back to menu</button></div>`);
      back.querySelector("#ov-menu")!.addEventListener("click", () => renderStart());
    },
    onError(reason: string) {
      if (reconnecting) {
        // a reconnect attempt hit a hard error (room ended) — stop retrying
        reconnecting = false;
        teardownNet();
        clearSession();
        return showConnLost();
      }
      if (onlineStarted && ui) {
        ui.showActionError(reason); // in-game rejection (e.g. not your turn) — non-fatal
        return;
      }
      // lobby / connection error
      clearSession();
      const e = app.querySelector(".ov-error");
      if (e) e.textContent = reason;
      else {
        const back = overlay(`<h2>Couldn't connect</h2><p>${reason}</p><div class="end-btns"><button class="btn primary" id="ov-menu">Back to menu</button></div>`);
        back.querySelector("#ov-menu")!.addEventListener("click", () => {
          teardownNet();
          renderStart();
        });
      }
    },
    onDisconnect() {
      if (onlineStarted) scheduleReconnect();
      else {
        const e = app.querySelector(".ov-error");
        if (e) e.textContent = "Lost connection to the server.";
      }
    },
  };
}

/** One lobby slot row: a joined human (their farmer kit) or an empty slot that
 *  will become a bot when the host starts. */
function lobbySlotHtml(slot: LobbyInfo["slots"][number]): string {
  if (slot.type === "human") {
    const tag = slot.connected ? "" : `<span class="lslot-tag">reconnecting…</span>`;
    return `<div class="lslot" style="--c:${slot.colour ?? "#888"}">
      <span class="lslot-pic">${slot.animal ?? "🧑‍🌾"}</span>
      <span class="lslot-name">${slot.name}</span>${tag}</div>`;
  }
  return `<div class="lslot empty">
    <span class="lslot-pic">🤖</span>
    <span class="lslot-name">Bot</span>
    <span class="lslot-tag">fills on start</span></div>`;
}

/** Render (or re-render) the pre-game lobby. Driven by every `lobby` message so
 *  all seats watch the table fill; only the host sees an enabled Start button. */
function renderLobby(info: LobbyInfo): void {
  if (onlineStarted) return; // the game has begun — ignore any late lobby frame
  const code = myCode;
  const canShare = typeof navigator !== "undefined" && !!navigator.share;
  const note = info.youAreHost
    ? info.canStart
      ? "Everyone in? Start whenever you're ready — empty seats become bots."
      : `Waiting for at least ${info.minHumans} players to join…`
    : "Waiting for the host to start…";
  clearOverlays();
  const back = overlay(`
    <h2>Game lobby</h2>
    <p>Share this code so friends can join:</p>
    <div class="room-code" id="ov-code-display" title="Tap to copy">${code}</div>
    <div class="end-btns">
      <button class="btn" id="ov-copy">📋 Copy code</button>
      ${canShare ? `<button class="btn" id="ov-share">Share…</button>` : ""}
    </div>
    <div class="lobby-slots">${info.slots.map(lobbySlotHtml).join("")}</div>
    <p class="lobby-note">${note}</p>
    <div class="end-btns">
      ${info.youAreHost ? `<button class="btn primary" id="ov-start" ${info.canStart ? "" : "disabled"}>Start game</button>` : ""}
      <button class="btn" id="ov-cancel">Leave</button>
    </div>`);

  const shareText = `Join my Hedgeways game! Code: ${code} — play at https://hedgeways.surge.sh`;
  const copyBtn = back.querySelector<HTMLButtonElement>("#ov-copy")!;
  const flash = (msg: string) => {
    copyBtn.textContent = msg;
    window.setTimeout(() => (copyBtn.textContent = "📋 Copy code"), 1500);
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      flash("✓ Copied!");
    } catch {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(back.querySelector("#ov-code-display")!);
      sel?.removeAllRanges();
      sel?.addRange(range);
      flash("Select & copy");
    }
  };
  copyBtn.addEventListener("click", copyCode);
  back.querySelector("#ov-code-display")!.addEventListener("click", copyCode);
  back.querySelector("#ov-share")?.addEventListener("click", () => {
    navigator.share({ title: "Hedgeways", text: shareText }).catch(() => {
      /* user dismissed the share sheet — no-op */
    });
  });
  back.querySelector("#ov-start")?.addEventListener("click", () => net?.start());
  back.querySelector("#ov-cancel")!.addEventListener("click", () => {
    net?.leave();
    clearSession();
    teardownNet();
    renderStart();
  });
}

function connectCreate(kit: OnlineKit): void {
  teardownNet();
  reconnectTries = 0;
  reconnecting = false;
  net = new NetClient(makeNetHandlers());
  clearOverlays();
  overlay(`<h2>Connecting…</h2><p class="ov-error">Waking the game server — this can take up to a minute the first time.</p>`);
  net.connect(() => net?.create(kit));
}

function connectJoin(code: string, kit: OnlineKit): void {
  teardownNet();
  reconnectTries = 0;
  reconnecting = false;
  net = new NetClient(makeNetHandlers());
  clearOverlays();
  overlay(`<h2>Joining ${code}…</h2><p class="ov-error">Waking the game server — this can take up to a minute the first time.</p>`);
  net.connect(() => net?.join(code, kit));
}

/** Try to rejoin an in-progress game after a refresh/disconnect. */
function tryReconnect(sess: OnlineSession): void {
  teardownNet();
  myCode = sess.code; // so a lobby re-render after reconnect knows the room code
  reconnecting = true; // a hard error here means the game is gone → back to menu
  net = new NetClient(makeNetHandlers());
  net.connect(() => net?.reconnect(sess.code, sess.token));
}

/** The "Play online" menu: create a room or join one by code. */
function openOnlineMenu(kit: OnlineKit): void {
  const back = overlay(`
    <h2>Play online</h2>
    <p>Play with 2–4 friends. Any empty seats become bots.</p>
    <div class="online-opts">
      <button class="btn primary" id="ov-create">Create a game</button>
      <div class="join-row">
        <input id="ov-code" maxlength="6" placeholder="CODE" autocomplete="off" spellcheck="false" />
        <button class="btn" id="ov-join">Join</button>
      </div>
      <p class="ov-error"></p>
    </div>
    <div class="end-btns"><button class="btn" id="ov-back">Back</button></div>`);
  back.querySelector("#ov-create")!.addEventListener("click", () => connectCreate(kit));
  const input = back.querySelector<HTMLInputElement>("#ov-code")!;
  input.addEventListener("input", () => (input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "")));
  const join = () => {
    const code = input.value.trim().toUpperCase();
    if (code.length < 6) {
      back.querySelector(".ov-error")!.textContent = "Enter the 6-character code.";
      return;
    }
    connectJoin(code, kit);
  };
  back.querySelector("#ov-join")!.addEventListener("click", join);
  input.addEventListener("keydown", (e) => e.key === "Enter" && join());
  back.querySelector("#ov-back")!.addEventListener("click", () => back.remove());
}

function startOnlineGame(snap: GameSnapshot, mySeat: number, turnDeadline: number): void {
  teardown();
  clearOverlays();
  ui = new GameUI(app, { players: snap.config.players }, {
    restore: snap,
    onQuit: () => {
      net?.leave(); // tell the server (and opponent) we're going — not a silent drop
      teardownNet();
      clearSession();
      renderStart();
    },
    online: {
      mySeat,
      sendMove: (m) => net?.move(m),
      requestRematch: () => net?.rematch(),
      sendGhost: (cells) => net?.ghost(cells),
      turnDeadline,
    },
  });
  sfx.startMusic();
  (window as any).__hedge = {
    ui,
    state: () => ui!.state(),
    autoPlayTurn: () => ui!.autoPlayTurn(),
  };
}

const DIFFS: Difficulty[] = ["easy", "medium", "hard", "expert"];
// Single-letter labels for the compact difficulty segmented control. Expert is
// "X" because it shares its first letter with easy.
const DIFF_ABBR: Record<Difficulty, string> = { easy: "E", medium: "M", hard: "H", expert: "X" };

// Farmyard ambience drifting up behind the menu — foliage + a little farm life.
const AMBIENT = ["🌿", "🍃", "🌱", "🌾", "🌻", "🐝", "🍃", "🦋", "🌿", "🌾", "🌱", "🐝"];
function ambientField(): string {
  const items = AMBIENT.map((g, i) => {
    const x = ((i + 0.5) * (100 / AMBIENT.length)).toFixed(1);
    const sway = Math.round(Math.random() * 40 - 20);
    const dur = (14 + Math.random() * 9).toFixed(1);
    return `<i style="--i:${i};--x:${x}%;--sway:${sway}px;--dur:${dur}s">${g}</i>`;
  });
  return `<div class="field" aria-hidden="true">${items.join("")}</div>`;
}

/** Shared payoff for the start-screen Easter eggs: confetti, a rainbow sweep over
 *  the decorative hedge-row, a critter chorus and the hidden barn-dance jingle. */
function barnParty(hedgeRow: HTMLElement | null, label: string): void {
  sfx.unlock();
  confetti(120);
  callout(label, "streak");
  sfx.jingle();
  ["🐷", "🐮", "🐑", "🐓"].forEach((a, i) => window.setTimeout(() => sfx.celebrate(a), 220 + i * 230));
  if (hedgeRow) {
    hedgeRow.classList.remove("party");
    void hedgeRow.offsetWidth; // reflow so the animation restarts on repeat triggers
    hedgeRow.classList.add("party");
    window.setTimeout(() => hedgeRow.classList.remove("party"), 1500);
  }
}

function renderStart(): void {
  teardown();
  const saved = loadActive();
  const resumable = saved && !saved.gameOver ? saved : null;
  // The secret farmer only appears in the picker once it's been unlocked.
  const pickFarmers = secretUnlocked() ? [...PUBLIC_FARMERS, SECRET_FARMER] : PUBLIC_FARMERS;
  app.innerHTML = `
    ${ambientField()}
    <div class="farm-scene" aria-hidden="true"></div>
    <div class="hedgerow" aria-hidden="true"></div>
    <div class="start">
      <div class="logo">Hedge<span>ways</span></div>
      <div class="hedge-row" aria-hidden="true">${PLAYER_KITS.map((k, i) => `<span style="--c:${k.colour};--i:${i}" data-animal="${k.animal}"></span>`).join("")}</div>
      <p class="tag">Plant hedges, enclose fields, claim the most acres of farmland.</p>
      <p class="hint" id="hint" aria-hidden="true"></p>
      ${
        resumable
          ? `<button class="btn primary resume" id="resume">▶ Resume game<small>${describeSave(resumable)}</small></button>`
          : ""
      }
      <div class="setup">
        <div class="hero" id="preview" aria-live="polite"></div>
        <div class="pick">
          <span class="pick-label">Your farmer</span>
          <div class="carousel-wrap">
            <button class="car-arrow prev" id="far-prev" type="button" aria-label="Previous farmer">‹</button>
            <div class="cards farmers carousel" id="farmers">
              ${pickFarmers
                .map(
                  (f, i) =>
                    `<button class="card${f.secret ? " secret" : ""}" data-i="${i}" data-fid="${f.id}" style="--pc:${f.colour}" title="${f.name}"><span class="card-pic farmer-pic"></span><span class="card-name">${f.name.replace(/^Farmer\s+/, "")}</span><span class="card-dot"></span></button>`,
                )
                .join("")}
            </div>
            <button class="car-arrow next" id="far-next" type="button" aria-label="Next farmer">›</button>
          </div>
        </div>
        <div class="pick">
          <span class="pick-label">Your livestock</span>
          <div class="cards livestock" id="livestock">
            ${LIVESTOCK.map(
              (l, i) =>
                `<button class="card" data-i="${i}" data-animal="${l.animal}" title="${l.name} — ${l.perkName}"><span class="card-pic critter-pic" data-animal="${l.animal}">${l.animal}</span><span class="card-name">${l.name}</span></button>`,
            ).join("")}
          </div>
        </div>
        <button class="opp-summary" id="opp-toggle" type="button">
          <span class="opp-label" id="opp-label"></span>
          <span class="opp-chevron" aria-hidden="true">›</span>
        </button>
      </div>
      <div class="start-btns">
        <button class="btn" id="how">How to play</button>
        <button class="btn" id="online">Play online</button>
        <button class="btn primary" id="play">Start game</button>
      </div>
    </div>`;

  let count = 2;
  type Slot = { type: "human" | "bot"; diff: Difficulty };
  const slots: Slot[] = [
    { type: "human", diff: "medium" },
    { type: "bot", diff: "medium" },
    { type: "bot", diff: "medium" },
    { type: "bot", diff: "medium" },
  ];

  // Summary chip above the collapsed opponents panel — "vs 3 bots", "2 humans +
  // 1 bot", etc. — so the common case (you + bots) needs no opening at all.
  const oppLabelEl = app.querySelector<HTMLElement>("#opp-label")!;
  const updateOppLabel = () => {
    const sel = slots.slice(0, count);
    const humans = sel.filter((s) => s.type === "human").length;
    const bots = count - humans;
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    let text: string;
    if (humans <= 1) text = bots === 0 ? "Solo" : `vs ${plural(bots, "bot")}`;
    else if (bots === 0) text = `${plural(humans, "human")} · hotseat`;
    else text = `${plural(humans, "human")} + ${plural(bots, "bot")}`;
    oppLabelEl.textContent = text;
  };

  const drawSlots = (slotsEl: HTMLElement) => {
    slotsEl.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const s = slots[i];
      const row = document.createElement("div");
      row.className = "slot";
      row.innerHTML = `
        <span class="slot-name">Farmer ${i + 1}</span>
        <button class="chip type-chip ${s.type}" type="button">${s.type === "human" ? "🧑 Human" : "🤖 Bot"}</button>
        <div class="diff-seg" ${s.type === "human" ? "hidden" : ""}>
          ${DIFFS.map((d) => `<button type="button" data-d="${d}" class="${d === s.diff ? "on" : ""}" title="${d}">${DIFF_ABBR[d]}</button>`).join("")}
        </div>`;
      const typeChip = row.querySelector<HTMLButtonElement>(".type-chip")!;
      const diffSeg = row.querySelector<HTMLElement>(".diff-seg")!;
      typeChip.addEventListener("click", () => {
        s.type = s.type === "human" ? "bot" : "human";
        typeChip.classList.toggle("human", s.type === "human");
        typeChip.classList.toggle("bot", s.type === "bot");
        typeChip.textContent = s.type === "human" ? "🧑 Human" : "🤖 Bot";
        diffSeg.hidden = s.type === "human";
        updateOppLabel();
      });
      diffSeg.querySelectorAll<HTMLButtonElement>("button").forEach((db) => {
        db.addEventListener("click", () => {
          s.diff = db.dataset.d as Difficulty;
          diffSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === db));
        });
      });
      slotsEl.appendChild(row);
    }
  };
  updateOppLabel();

  // The opponents chip opens a modal for the table setup — player count + each
  // seat's human/bot + difficulty. Keeping it in a modal means the start screen
  // never grows with player count (4 seats no longer pushes Start off-screen).
  const oppToggle = app.querySelector<HTMLButtonElement>("#opp-toggle")!;
  oppToggle.addEventListener("click", () => {
    const back = document.createElement("div");
    back.className = "modal-back opp-modal";
    back.innerHTML = `
      <div class="modal opp-modal-card">
        <h2>Set up the table</h2>
        <div class="count-row">Players
          <div class="count" id="opp-count">
            <button type="button" data-n="2">2</button><button type="button" data-n="3">3</button><button type="button" data-n="4">4</button>
          </div>
        </div>
        <div id="opp-slots" class="slots"></div>
        <div class="end-btns"><button class="btn primary" id="opp-done" type="button">Done</button></div>
      </div>`;
    app.appendChild(back);
    const slotsEl = back.querySelector<HTMLElement>("#opp-slots")!;
    const countEl = back.querySelector<HTMLElement>("#opp-count")!;
    drawSlots(slotsEl);
    countEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.classList.toggle("on", Number(b.dataset.n) === count);
      b.addEventListener("click", () => {
        count = Number(b.dataset.n);
        countEl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        drawSlots(slotsEl);
        updateOppLabel();
      });
    });
    const close = () => {
      updateOppLabel();
      back.remove();
      window.removeEventListener("keydown", onEsc);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onEsc);
    back.addEventListener("click", (e) => e.target === back && close());
    back.querySelector("#opp-done")!.addEventListener("click", close);
  });

  // The human picks a farmer (their identity colour + portrait) and, separately,
  // a livestock (the animal stamped on their acres + its perk). Both are honoured
  // straight through to the in-game players; bots fill the remaining ones.
  // On short screens the cards shrink (see the max-height CSS), so the mounted
  // portrait canvases shrink to match or they'd overflow and clip the heads.
  const compact = typeof matchMedia !== "undefined" && matchMedia("(max-height: 720px)").matches;
  const FARMER_CARD_SIZE = compact ? 44 : 52;
  const PREVIEW_SIZE = compact ? 58 : 68;
  let farmerIdx = 0;
  let livestockIdx = 0;
  const pickerWidgets: { dispose: () => void }[] = [];

  const carouselEl = app.querySelector<HTMLElement>("#farmers")!;
  const farmerBtns = app.querySelectorAll<HTMLButtonElement>("#farmers .card");
  // Centre the chosen farmer in the swipe strip and refresh the hero preview.
  const selectFarmer = (idx: number): void => {
    farmerIdx = (idx + farmerBtns.length) % farmerBtns.length;
    farmerBtns.forEach((x, j) => x.classList.toggle("on", j === farmerIdx));
    farmerBtns[farmerIdx]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    renderPreview();
  };
  farmerBtns.forEach((b, idx) => {
    b.classList.toggle("on", idx === farmerIdx);
    const host = b.querySelector<HTMLElement>(".farmer-pic");
    const fid = b.dataset.fid || "";
    if (host && getFarmerSprites().knows(fid)) {
      const w = mountFarmerPortrait(host, fid, { size: FARMER_CARD_SIZE, state: "idle", phase: idx * 0.27 });
      if (w) pickerWidgets.push(w);
    }
    b.addEventListener("click", () => {
      if (idx === farmerIdx) return;
      selectFarmer(idx);
    });
  });
  app.querySelector("#far-prev")!.addEventListener("click", () => selectFarmer(farmerIdx - 1));
  app.querySelector("#far-next")!.addEventListener("click", () => selectFarmer(farmerIdx + 1));
  // Fade the arrows out at the ends of the strip (and hide both when it all fits).
  const syncArrows = () => {
    const max = carouselEl.scrollWidth - carouselEl.clientWidth - 1;
    const fits = max <= 0;
    app.querySelector("#far-prev")!.classList.toggle("hide", fits || carouselEl.scrollLeft <= 1);
    app.querySelector("#far-next")!.classList.toggle("hide", fits || carouselEl.scrollLeft >= max);
  };
  carouselEl.addEventListener("scroll", syncArrows, { passive: true });

  // Easter egg: click the livestock cards in the order 🐷🐮🐑🐓 for a barn dance.
  const hedgeRowEl = app.querySelector<HTMLElement>(".hedge-row");
  const CRITTER_SECRET = ["🐷", "🐮", "🐑", "🐓"];
  const critterSeq: string[] = [];

  const livestockBtns = app.querySelectorAll<HTMLButtonElement>("#livestock .card");
  livestockBtns.forEach((b, idx) => {
    b.classList.toggle("on", idx === livestockIdx);
    b.addEventListener("click", () => {
      sfx.unlock();
      sfx.celebrate(LIVESTOCK[idx].animal); // hear the critter you picked
      critterSeq.push(LIVESTOCK[idx].animal);
      if (critterSeq.length > CRITTER_SECRET.length) critterSeq.shift();
      if (CRITTER_SECRET.every((a, j) => critterSeq[j] === a)) {
        critterSeq.length = 0;
        barnParty(hedgeRowEl, "🎺 Barn dance!");
      }
      if (idx === livestockIdx) return;
      livestockIdx = idx;
      livestockBtns.forEach((x, j) => x.classList.toggle("on", j === livestockIdx));
      renderPreview();
    });
  });
  // bring the livestock cards to life with the real sprites
  const stopLivestockCritters = mountHomeCritters([
    ...app.querySelectorAll<HTMLElement>("#livestock .critter-pic"),
  ]);
  // living pasture behind the panel
  const farmSceneEl = app.querySelector<HTMLElement>(".farm-scene");
  const stopFarmScene = farmSceneEl ? mountFarmScene(farmSceneEl) : null;

  let previewWidget: { dispose: () => void } | null = null;
  const previewEl = app.querySelector<HTMLElement>("#preview")!;
  const renderPreview = (): void => {
    const f = pickFarmers[farmerIdx];
    const l = LIVESTOCK[livestockIdx];
    previewWidget?.dispose();
    previewWidget = null;
    previewEl.style.setProperty("--pc", f.colour);
    previewEl.innerHTML = `
      <span class="pv-farmer"></span>
      <div class="pv-text">
        <span class="pv-name">${f.name} <span class="pv-with">+ ${l.animal} ${l.name}</span></span>
        <span class="pv-style">${f.blurb}</span>
        <span class="pv-perk"><b>${l.perkName}</b> — ${l.perkBlurb}</span>
      </div>`;
    const host = previewEl.querySelector<HTMLElement>(".pv-farmer");
    if (host && getFarmerSprites().knows(f.id)) {
      previewWidget = mountFarmerPortrait(host, f.id, { size: PREVIEW_SIZE, state: "happy", phase: 0.1 });
    }
    gsap.fromTo(previewEl, { opacity: 0.35, y: 4 }, { opacity: 1, y: 0, duration: 0.32, ease: "power2.out" });
  };
  renderPreview();

  if (resumable) {
    app.querySelector("#resume")!.addEventListener("click", () => {
      startGame(resumable.config, resumable);
    });
  }

  app.querySelector("#how")!.addEventListener("click", () => showHowTo());
  app.querySelector("#online")!.addEventListener("click", () => openOnlineMenu(buildKit(pickFarmers[farmerIdx], livestockIdx)));
  app.querySelector("#play")!.addEventListener("click", () => {
    // The first human gets their chosen farmer + livestock; every other seat draws
    // a distinct farmer (unique colour/portrait) and a distinct livestock so the
    // board stays readable. Farmers and livestock are independent picks now.
    const sel = slots.slice(0, count);
    const firstHuman = sel.findIndex((s) => s.type === "human");
    const humanFarmer = pickFarmers[farmerIdx];
    // bots draw distinct farmers from the PUBLIC roster (never the secret one,
    // never the human's), shuffled so the personality mix varies game to game;
    // livestock pool stays the 4 animals
    const farmerPool = PUBLIC_FARMERS.filter((f) => firstHuman < 0 || f.id !== humanFarmer.id).sort(
      () => Math.random() - 0.5,
    );
    const livestockPool = [0, 1, 2, 3].filter((i) => firstHuman < 0 || i !== livestockIdx);
    let fp = 0;
    let lp = 0;
    const players = sel.map((s, i) => {
      const f = i === firstHuman ? humanFarmer : farmerPool[fp++];
      const li = i === firstHuman ? livestockIdx : livestockPool[lp++];
      const l = LIVESTOCK[li];
      return {
        name: s.type === "human" ? "You" : f.name,
        isBot: s.type === "bot",
        difficulty: s.diff,
        colour: f.colour,
        animal: l.animal,
        farmerId: f.id,
        farmerName: f.name,
      };
    });
    startGame({ players, seed: (Math.random() * 0xffffffff) >>> 0 });
  });

  // Easter egg: tap the title seven times to wake the hidden scarecrow farmer.
  const logoEl = app.querySelector<HTMLElement>(".logo");
  if (logoEl && !secretUnlocked()) {
    let taps = 0;
    logoEl.style.cursor = "pointer";
    logoEl.addEventListener("click", () => {
      if (secretUnlocked()) return;
      taps++;
      gsap.fromTo(logoEl, { scale: 0.94 }, { scale: 1, duration: 0.25, ease: "back.out(3)" });
      if (taps >= 7) {
        unlockSecret();
        revealSecretOnRender = true;
        renderStart(); // re-render so the picker now includes the secret farmer
      }
    });
  }

  // Just unlocked it (we re-rendered above): select the secret farmer + celebrate.
  if (revealSecretOnRender) {
    revealSecretOnRender = false;
    selectFarmer(pickFarmers.length - 1); // the secret farmer is appended last
    barnParty(hedgeRowEl, `🌾 ${SECRET_FARMER.name} joins your farm!`);
  }

  // A rotating, intentionally-cryptic teaser line so the secrets below are
  // discoverable without spelling them out (the how-to lists them in full).
  let hintTimer: number | null = null;
  const hintEl = app.querySelector<HTMLElement>("#hint");
  if (hintEl) {
    const HINTS = [
      "🥚 The farm keeps a few secrets…",
      "🐷 The animals like to be greeted in the right order",
      "🌈 Some old codes still work around here",
      "👀 Weary farmers let the bots take over",
      "🌾 Tap the title a lucky few times to wake a sleeping scarecrow",
    ];
    let hi = 0;
    const showHint = () => {
      hintEl.textContent = HINTS[hi++ % HINTS.length];
      hintEl.classList.remove("show");
      void hintEl.offsetWidth; // restart the fade each rotation
      hintEl.classList.add("show");
    };
    showHint();
    hintTimer = window.setInterval(showHint, 5200);
  }

  // Easter eggs: the Konami code throws a barn dance; typing "watch" hands the
  // game to four bots to play out while you spectate.
  const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let konamiPos = 0;
  let typed = "";
  const onStartKey = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    konamiPos = k === KONAMI[konamiPos] ? konamiPos + 1 : k === KONAMI[0] ? 1 : 0;
    if (konamiPos === KONAMI.length) {
      konamiPos = 0;
      barnParty(hedgeRowEl, "🌈 Up up down down…");
    }
    if (/^[a-z]$/.test(k)) {
      typed = (typed + k).slice(-5);
      if (typed === "watch") {
        typed = "";
        callout("👀 Sit back — the farm plays itself", "info");
        window.setTimeout(startSpectate, 650);
      }
    }
  };
  window.addEventListener("keydown", onStartKey);

  // animate the decorative livestock chips with the real sprites (idle/graze)
  const stopCritters = mountHomeCritters([...app.querySelectorAll<HTMLElement>(".hedge-row span")]);
  window.addEventListener("resize", syncArrows);
  stopHome = () => {
    stopCritters?.();
    stopLivestockCritters?.();
    stopFarmScene?.();
    previewWidget?.dispose();
    for (const w of pickerWidgets) w.dispose();
    window.removeEventListener("keydown", onStartKey);
    window.removeEventListener("resize", syncArrows);
    if (hintTimer !== null) window.clearInterval(hintTimer);
  };

  // staggered entrance
  gsap.from(".start > *", { y: 16, opacity: 0, duration: 0.5, ease: "back.out(1.6)", stagger: 0.07 });
  gsap.from(".hedge-row span", { scale: 0, opacity: 0, duration: 0.5, ease: "back.out(2.5)", stagger: 0.08, delay: 0.15 });
  gsap.from(".setup .card", { scale: 0.6, opacity: 0, duration: 0.45, ease: "back.out(2)", stagger: 0.05, delay: 0.2 });
  requestAnimationFrame(syncArrows); // arrows depend on post-layout scroll metrics
}

// start audio on the first user gesture (autoplay policy)
window.addEventListener("pointerdown", () => sfx.unlock(), { once: true });

// expose a pre-game hook for e2e
(window as any).__hedge = { newGame: (c: GameConfig) => startGame(c) };

// If we have a saved online session (e.g. the tab was refreshed mid-game), try to
// rejoin it before falling back to the menu.
const sess = loadSession();
if (sess) {
  overlay(`<h2>Reconnecting…</h2><p>Rejoining your game.</p>`);
  tryReconnect(sess);
  window.setTimeout(() => {
    if (!onlineStarted) {
      teardownNet();
      clearSession();
      renderStart();
    }
  }, 4000);
} else {
  renderStart();
}
