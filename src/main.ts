import "./style.css";
import gsap from "gsap";
import { GameUI } from "./ui/game-ui";
import { showHowTo } from "./ui/howto";
import type { Difficulty } from "./game/types";
import type { GameConfig, GameSnapshot } from "./game/game";
import { describeSave, loadActive } from "./game/persistence";
import { PLAYER_KITS } from "./game/constants";
import { mountHomeCritters } from "./ui/home-critters";
import { farmerSvg } from "./ui/farmers";
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
        <label class="count-row">Your farmer
          <div class="animals" id="animals">
            ${PLAYER_KITS.map(
              (k, i) =>
                `<button data-a="${i}" title="${k.farmerName}" style="--pc:${k.colour}"><span class="apic">${farmerSvg(k.farmerId, 38)}</span><span class="aani">${k.animal}</span></button>`,
            ).join("")}
          </div>
        </label>
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

  let humanKit = 0;
  const animalBtns = app.querySelectorAll<HTMLButtonElement>("#animals button");
  animalBtns.forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.a) === humanKit);
    b.addEventListener("click", () => {
      humanKit = Number(b.dataset.a);
      animalBtns.forEach((x) => x.classList.toggle("on", x === b));
    });
  });

  if (resumable) {
    app.querySelector("#resume")!.addEventListener("click", () => {
      startGame(resumable.config, resumable);
    });
  }

  app.querySelector("#how")!.addEventListener("click", () => showHowTo());
  app.querySelector("#play")!.addEventListener("click", () => {
    // assign livestock kits: the first human gets their chosen one, others fill the rest
    const firstHuman = slots.slice(0, count).findIndex((s) => s.type === "human");
    const free = [0, 1, 2, 3].filter((k) => firstHuman < 0 || k !== humanKit);
    let ptr = 0;
    const players = slots.slice(0, count).map((s, i) => {
      const kitIdx = i === firstHuman ? humanKit : free[ptr++];
      const kit = PLAYER_KITS[kitIdx];
      return {
        name: s.type === "human" ? "You" : kit.farmerName,
        isBot: s.type === "bot",
        difficulty: s.diff,
        colour: kit.colour,
        animal: kit.animal,
        farmerId: kit.farmerId,
        farmerName: kit.farmerName,
      };
    });
    startGame({ players, seed: (Math.random() * 0xffffffff) >>> 0 });
  });

  // animate the livestock chips with the real sprites (idle/graze)
  stopHome = mountHomeCritters([...app.querySelectorAll<HTMLElement>(".hedge-row span")]);

  // staggered entrance
  gsap.from(".start > *", { y: 16, opacity: 0, duration: 0.5, ease: "back.out(1.6)", stagger: 0.07 });
  gsap.from(".hedge-row span", { scale: 0, opacity: 0, duration: 0.5, ease: "back.out(2.5)", stagger: 0.08, delay: 0.15 });
}

// start audio on the first user gesture (autoplay policy)
window.addEventListener("pointerdown", () => sfx.unlock(), { once: true });

// expose a pre-game hook for e2e
(window as any).__hedge = { newGame: (c: GameConfig) => startGame(c) };

renderStart();
