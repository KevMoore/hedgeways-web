import "./style.css";
import gsap from "gsap";
import { GameUI } from "./ui/game-ui";
import { showHowTo } from "./ui/howto";
import type { Difficulty } from "./game/types";
import type { GameConfig, GameSnapshot } from "./game/game";
import { describeSave, loadActive } from "./game/persistence";
import { FARMERS, LIVESTOCK, PLAYER_KITS } from "./game/constants";
import { mountHomeCritters } from "./ui/home-critters";
import { mountFarmerPortrait } from "./ui/farmer-portrait";
import { getFarmerSprites } from "./render/farmer-sprites";
import { sfx } from "./audio";

const app = document.getElementById("app")!;
let ui: GameUI | null = null;
let stopHome: (() => void) | null = null;

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

const DIFFS: Difficulty[] = ["easy", "medium", "hard", "expert"];

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

function renderStart(): void {
  teardown();
  const saved = loadActive();
  const resumable = saved && !saved.gameOver ? saved : null;
  app.innerHTML = `
    ${ambientField()}
    <div class="hedgerow" aria-hidden="true"></div>
    <div class="start">
      <div class="logo">Hedge<span>ways</span></div>
      <div class="hedge-row" aria-hidden="true">${PLAYER_KITS.map((k, i) => `<span style="--c:${k.colour};--i:${i}" data-animal="${k.animal}"></span>`).join("")}</div>
      <p class="tag">Plant hedges, enclose fields, claim the most acres of farmland.</p>
      ${
        resumable
          ? `<button class="btn primary resume" id="resume">▶ Resume game<small>${describeSave(resumable)}</small></button>`
          : ""
      }
      <div class="setup">
        <label class="count-row">Players
          <div class="count" id="count">
            <button data-n="2">2</button><button data-n="3">3</button><button data-n="4">4</button>
          </div>
        </label>
        <div id="slots" class="slots"></div>
        <div class="identity">
          <div class="pick">
            <span class="pick-label">Your farmer</span>
            <div class="cards farmers" id="farmers">
              ${FARMERS.map(
                (f, i) =>
                  `<button class="card" data-i="${i}" data-fid="${f.id}" style="--pc:${f.colour}" title="${f.name}"><span class="card-pic farmer-pic"></span><span class="card-dot"></span></button>`,
              ).join("")}
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
          <div class="preview" id="preview" aria-live="polite"></div>
        </div>
      </div>
      <div class="start-btns">
        <button class="btn" id="how">How to play</button>
        <button class="btn primary" id="play">Start game</button>
      </div>
    </div>`;

  let count = 2;
  const slotsEl = app.querySelector("#slots")!;
  type Slot = { type: "human" | "bot"; diff: Difficulty };
  const slots: Slot[] = [
    { type: "human", diff: "medium" },
    { type: "bot", diff: "medium" },
    { type: "bot", diff: "medium" },
    { type: "bot", diff: "medium" },
  ];

  const drawSlots = () => {
    slotsEl.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const s = slots[i];
      const row = document.createElement("div");
      row.className = "slot";
      row.innerHTML = `
        <span class="slot-name">Farmer ${i + 1}</span>
        <select class="slot-type">
          <option value="human" ${s.type === "human" ? "selected" : ""}>Human</option>
          <option value="bot" ${s.type === "bot" ? "selected" : ""}>Bot</option>
        </select>
        <select class="slot-diff" ${s.type === "human" ? "disabled" : ""}>
          ${DIFFS.map((d) => `<option value="${d}" ${d === s.diff ? "selected" : ""}>${d}</option>`).join("")}
        </select>`;
      const typeSel = row.querySelector<HTMLSelectElement>(".slot-type")!;
      const diffSel = row.querySelector<HTMLSelectElement>(".slot-diff")!;
      typeSel.addEventListener("change", () => {
        s.type = typeSel.value as Slot["type"];
        diffSel.disabled = s.type === "human";
      });
      diffSel.addEventListener("change", () => (s.diff = diffSel.value as Difficulty));
      slotsEl.appendChild(row);
    }
  };
  drawSlots();

  app.querySelectorAll<HTMLButtonElement>("#count button").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.n) === count);
    b.addEventListener("click", () => {
      count = Number(b.dataset.n);
      app.querySelectorAll("#count button").forEach((x) => x.classList.toggle("on", x === b));
      drawSlots();
    });
  });

  // The human picks a farmer (their identity colour + portrait) and, separately,
  // a livestock (the animal stamped on their acres + its perk). Both are honoured
  // straight through to the in-game players; bots fill the remaining ones.
  // On short screens the cards shrink (see the max-height CSS), so the mounted
  // portrait canvases shrink to match or they'd overflow and clip the heads.
  const compact = typeof matchMedia !== "undefined" && matchMedia("(max-height: 720px)").matches;
  const FARMER_CARD_SIZE = compact ? 40 : 48;
  const PREVIEW_SIZE = compact ? 44 : 52;
  let farmerIdx = 0;
  let livestockIdx = 0;
  const pickerWidgets: { dispose: () => void }[] = [];

  const farmerBtns = app.querySelectorAll<HTMLButtonElement>("#farmers .card");
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
      farmerIdx = idx;
      farmerBtns.forEach((x, j) => x.classList.toggle("on", j === farmerIdx));
      renderPreview();
    });
  });

  const livestockBtns = app.querySelectorAll<HTMLButtonElement>("#livestock .card");
  livestockBtns.forEach((b, idx) => {
    b.classList.toggle("on", idx === livestockIdx);
    b.addEventListener("click", () => {
      sfx.unlock();
      sfx.celebrate(LIVESTOCK[idx].animal); // hear the critter you picked
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

  let previewWidget: { dispose: () => void } | null = null;
  const previewEl = app.querySelector<HTMLElement>("#preview")!;
  const renderPreview = (): void => {
    const f = FARMERS[farmerIdx];
    const l = LIVESTOCK[livestockIdx];
    previewWidget?.dispose();
    previewWidget = null;
    previewEl.style.setProperty("--pc", f.colour);
    previewEl.innerHTML = `
      <span class="pv-farmer"></span>
      <div class="pv-text">
        <span class="pv-name">${f.name} <span class="pv-with">+ ${l.animal} ${l.name}</span></span>
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
  app.querySelector("#play")!.addEventListener("click", () => {
    // The first human gets their chosen farmer + livestock; every other seat draws
    // a distinct farmer (unique colour/portrait) and a distinct livestock so the
    // board stays readable. Farmers and livestock are independent picks now.
    const sel = slots.slice(0, count);
    const firstHuman = sel.findIndex((s) => s.type === "human");
    const farmerPool = [0, 1, 2, 3].filter((i) => firstHuman < 0 || i !== farmerIdx);
    const livestockPool = [0, 1, 2, 3].filter((i) => firstHuman < 0 || i !== livestockIdx);
    let fp = 0;
    let lp = 0;
    const players = sel.map((s, i) => {
      const fi = i === firstHuman ? farmerIdx : farmerPool[fp++];
      const li = i === firstHuman ? livestockIdx : livestockPool[lp++];
      const f = FARMERS[fi];
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

  // animate the decorative livestock chips with the real sprites (idle/graze)
  const stopCritters = mountHomeCritters([...app.querySelectorAll<HTMLElement>(".hedge-row span")]);
  stopHome = () => {
    stopCritters?.();
    stopLivestockCritters?.();
    previewWidget?.dispose();
    for (const w of pickerWidgets) w.dispose();
  };

  // staggered entrance
  gsap.from(".start > *", { y: 16, opacity: 0, duration: 0.5, ease: "back.out(1.6)", stagger: 0.07 });
  gsap.from(".hedge-row span", { scale: 0, opacity: 0, duration: 0.5, ease: "back.out(2.5)", stagger: 0.08, delay: 0.15 });
  gsap.from(".identity .card", { scale: 0.6, opacity: 0, duration: 0.45, ease: "back.out(2)", stagger: 0.05, delay: 0.2 });
}

// start audio on the first user gesture (autoplay policy)
window.addEventListener("pointerdown", () => sfx.unlock(), { once: true });

// expose a pre-game hook for e2e
(window as any).__hedge = { newGame: (c: GameConfig) => startGame(c) };

renderStart();
