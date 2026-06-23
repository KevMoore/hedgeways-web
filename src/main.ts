import "./style.css";
import { GameUI } from "./ui/game-ui";
import { showHowTo } from "./ui/howto";
import type { Difficulty } from "./game/types";
import type { GameConfig } from "./game/game";

const app = document.getElementById("app")!;
let ui: GameUI | null = null;

function startGame(config: GameConfig): GameUI {
  ui = new GameUI(app, config, () => renderStart());
  (window as any).__hedge = {
    ui,
    state: () => ui!.state(),
    autoPlayTurn: () => ui!.autoPlayTurn(),
    newGame: (c: GameConfig) => (ui = new GameUI(app, c, () => renderStart())),
  };
  return ui;
}

const DIFFS: Difficulty[] = ["easy", "medium", "hard", "expert"];

function renderStart(): void {
  app.innerHTML = `
    <div class="start">
      <div class="logo">Hedge<span>ways</span></div>
      <p class="tag">Lay hedges, enclose fields, claim the most acres of land.</p>
      <div class="setup">
        <label class="count-row">Players
          <div class="count" id="count">
            <button data-n="2">2</button><button data-n="3">3</button><button data-n="4">4</button>
          </div>
        </label>
        <div id="slots" class="slots"></div>
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

  app.querySelector("#how")!.addEventListener("click", () => showHowTo());
  app.querySelector("#play")!.addEventListener("click", () => {
    const players = slots.slice(0, count).map((s, i) => ({
      name: s.type === "human" ? "You" : `Bot ${i + 1}`,
      isBot: s.type === "bot",
      difficulty: s.diff,
    }));
    startGame({ players, seed: (Math.random() * 0xffffffff) >>> 0 });
  });
}

// expose a pre-game hook for e2e
(window as any).__hedge = { newGame: (c: GameConfig) => startGame(c) };

renderStart();
