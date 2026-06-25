import gsap from "gsap";
import { COLOUR_HEX, COLOUR_HEX_DARK, HAND_SIZE, LIVESTOCK, MAX_LAY, PLAYER_KITS } from "../game/constants";
import { ACRES_PER_HERD } from "../game/scoring";
import type { Colour } from "../game/types";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const reduced = (): boolean =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- small building blocks (use the real game palette so the how-to matches the board) ----

/** A 1×3 hedge tile — three coloured leaf segments. */
function strip(colours: [Colour, Colour, Colour]): HTMLElement {
  const s = el("span", "ht-strip");
  for (const c of colours) s.append(leaf(el("span", "ht-seg"), c));
  return s;
}

/** A single leafy hedge chip. */
function chip(colour: Colour): HTMLElement {
  return leaf(el("span", "ht-chip"), colour);
}

function leaf(node: HTMLElement, colour: Colour): HTMLElement {
  node.style.setProperty("--leaf", COLOUR_HEX[colour]);
  node.style.setProperty("--leaf-dark", COLOUR_HEX_DARK[colour]);
  return node;
}

type CellKind = "empty" | "hedge" | "acre";
interface CellOpts {
  colour?: Colour; // hedge leaf colour
  tint?: string; // owned-acre tint (a player-kit hex)
  animal?: string; // livestock glyph
}

function setCell(cell: HTMLElement, kind: CellKind, opts: CellOpts = {}): void {
  cell.className = "ht-cell " + kind + (opts.tint ? " owned" : "");
  cell.textContent = opts.animal ?? "";
  cell.style.removeProperty("--leaf");
  cell.style.removeProperty("--leaf-dark");
  cell.style.removeProperty("--tint");
  if (kind === "hedge" && opts.colour) leaf(cell, opts.colour);
  if (opts.tint) cell.style.setProperty("--tint", opts.tint);
}

interface GridApi {
  node: HTMLElement;
  cell(r: number, c: number): HTMLElement;
}

/** A mini board from a char map: '.'=empty, G/Y/B/P=hedge, 'a'=acre. */
function grid(map: string[]): GridApi {
  const cols = Math.max(...map.map((r) => r.length));
  const node = el("div", "ht-grid");
  node.style.setProperty("--cols", String(cols));
  const cells: HTMLElement[][] = [];
  map.forEach((row, r) => {
    cells[r] = [];
    for (let c = 0; c < cols; c++) {
      const ch = row[c] ?? ".";
      const cell = el("div", "ht-cell");
      if (ch === "a") setCell(cell, "acre");
      else if (ch in COLOUR_HEX) setCell(cell, "hedge", { colour: ch as Colour });
      else setCell(cell, "empty");
      cells[r][c] = cell;
      node.append(cell);
    }
  });
  return { node, cell: (r, c) => cells[r][c] };
}

function diagram(...nodes: (HTMLElement | string)[]): HTMLElement {
  const d = el("div", "ht-diagram");
  for (const n of nodes) d.append(typeof n === "string" ? el("span", "ht-note", n) : n);
  return d;
}

function section(emoji: string, title: string, body: string, extra?: HTMLElement): HTMLElement {
  const s = el("section", "ht-section");
  const h = el("h3", "ht-head");
  h.append(el("span", "ht-emoji", emoji), document.createTextNode(title));
  s.append(h, el("p", "ht-body", body));
  if (extra) s.append(extra);
  return s;
}

const centerIn = (wrap: HTMLElement, cell: HTMLElement): { x: number; y: number } => {
  const w = wrap.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  return { x: c.left - w.left + c.width / 2, y: c.top - w.top + c.height / 2 };
};

// ---- animated demos ---------------------------------------------------------
// Each returns the node plus a play() that loops the mechanic (or, under reduced
// motion, simply leaves the resolved final state on screen).

interface Demo {
  node: HTMLElement;
  play(): void;
}

/** Lay the closing hedges → the field seals → its acres are claimed. */
function encloseDemo(): Demo {
  const kit = PLAYER_KITS[0]; // 🐷
  // built in the final, sealed state; play() rewinds to the open state and replays
  const g = grid(["GGGGG", "GaaaG", "GGGGG"]);
  const interior = [g.cell(1, 1), g.cell(1, 2), g.cell(1, 3)];
  interior.forEach((c, i) => setCell(c, "acre", { tint: kit.colour, animal: i === 1 ? kit.animal : "" }));
  const lid = [g.cell(0, 1), g.cell(0, 2), g.cell(0, 3)]; // the hedge tile that closes the top

  const wrap = el("div", "ht-demo");
  const label = el("div", "ht-pop", `${kit.animal} +3 acres`);
  wrap.append(g.node, label);

  return {
    node: wrap,
    play() {
      if (reduced()) return; // leave the sealed result visible
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.6, defaults: { ease: "power2.out" } });
      tl.set(lid, { autoAlpha: 0, y: -22 }, 0)
        .set(interior, { autoAlpha: 0, scale: 0, transformOrigin: "50% 50%" }, 0)
        .set(label, { autoAlpha: 0, y: 8 }, 0)
        .to(lid, { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.06, ease: "back.out(1.7)" }, 0.3)
        .to(interior, { autoAlpha: 1, scale: 1, duration: 0.4, stagger: 0.08, ease: "back.out(2)" }, ">-0.05")
        .to(label, { autoAlpha: 1, y: -14, duration: 0.5 }, "<0.1")
        .to(label, { autoAlpha: 0, duration: 0.4 }, ">0.7");
    },
  };
}

/** A field walled only at the corners leaks — seal the corners edge-to-edge. */
function cornerDemo(): Demo {
  const kit = PLAYER_KITS[2]; // 🐑
  const g = grid(["GGGG", "GaaG", "GaaG", "GGGG"]);
  const interior = [g.cell(1, 1), g.cell(1, 2), g.cell(2, 1), g.cell(2, 2)];
  interior.forEach((c, i) => setCell(c, "acre", { tint: kit.colour, animal: i === 0 ? kit.animal : "" }));
  const corners = [g.cell(0, 0), g.cell(0, 3), g.cell(3, 0), g.cell(3, 3)];

  const wrap = el("div", "ht-demo");
  const escapee = el("div", "ht-escapee", kit.animal);
  const bad = el("div", "ht-tag bad", "open — leaks at the corners");
  const good = el("div", "ht-tag good", "sealed!");
  wrap.append(g.node, escapee, bad, good);

  return {
    node: wrap,
    play() {
      if (reduced()) {
        gsap.set(escapee, { autoAlpha: 0 });
        gsap.set(bad, { autoAlpha: 0 });
        return; // leave the sealed result + "sealed!" tag visible
      }
      const inside = centerIn(wrap, g.cell(2, 1));
      const gap = centerIn(wrap, g.cell(3, 0));
      const out = { x: gap.x + (gap.x - inside.x) * 0.8, y: gap.y + (gap.y - inside.y) * 0.8 };
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.4, defaults: { ease: "power2.out" } });
      tl.set(corners, { autoAlpha: 0, scale: 0.4, transformOrigin: "50% 50%" }, 0)
        .set(interior, { autoAlpha: 0, scale: 0.6, transformOrigin: "50% 50%" }, 0)
        .set(good, { autoAlpha: 0 }, 0)
        .set(bad, { autoAlpha: 0 }, 0)
        .set(escapee, { autoAlpha: 0, x: inside.x, y: inside.y, xPercent: -50, yPercent: -50 }, 0)
        // 1) the field looks walled, but a sheep wanders out through the corner gap
        .to(bad, { autoAlpha: 1, duration: 0.3 }, 0.2)
        .to(escapee, { autoAlpha: 1, duration: 0.2 }, 0.3)
        .to(escapee, { x: gap.x, y: gap.y, duration: 0.55, ease: "power1.inOut" }, ">")
        .to(escapee, { x: out.x, y: out.y, autoAlpha: 0, duration: 0.5, ease: "power1.in" }, ">")
        // 2) seal the corners → the field encloses → acres are claimed
        .to(bad, { autoAlpha: 0, duration: 0.25 }, ">-0.1")
        .to(corners, { autoAlpha: 1, scale: 1, duration: 0.4, stagger: 0.07, ease: "back.out(1.7)" }, ">")
        .to(interior, { autoAlpha: 1, scale: 1, duration: 0.4, stagger: 0.07, ease: "back.out(2)" }, ">-0.1")
        .fromTo(good, { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.4, ease: "back.out(2)" }, "<0.1");
    },
  };
}

let open = false;

/** Full-screen, animated "How to play" reference. */
export function showHowTo(): void {
  if (open) return;
  open = true;

  const overlay = el("div", "ht-overlay");
  const card = el("div", "ht-card");

  const top = el("div", "ht-top");
  const logo = el("div", "ht-logo");
  logo.append(document.createTextNode("Hedge"), el("span", undefined, "ways"));
  top.append(logo, el("div", "ht-tagline", "How to play"));
  card.append(top);

  card.append(
    section(
      "🎯",
      "The goal",
      "You're farmers competing for land. Fence off fields with hedges — every empty square you enclose is one acre, worth one point.",
      diagram(grid(["GGG", "GaG", "GGG"]).node, "→ 1 enclosed square = 1 acre"),
    ),
  );

  card.append(
    section(
      "🌿",
      "Your hedges",
      `Each hedge is a 1×3 strip of leafy colours — green, yellow, blue and pink. You hold ${HAND_SIZE} in your hand.`,
      diagram(strip(["G", "G", "Y"]), strip(["B", "P", "P"])),
    ),
  );

  card.append(
    section(
      "✋",
      "Your turn",
      `Lay ${MAX_LAY === 3 ? "1, 2 or 3" : `1–${MAX_LAY}`} hedges, then top your hand back up to ${HAND_SIZE}.`,
      diagram(strip(["G", "Y", "B"]), "lay 1–3", "→", "refill to 4 🌿"),
    ),
  );

  card.append(
    section(
      "🎨",
      "Link by colour",
      "Where hedges touch, the colours must match — both to hedges already down and to each other. (Your very first hedge of the game is the only exception.)",
      diagram(chip("G"), chip("G"), "match ✓", "  ", chip("B"), chip("Y"), "clash ✗"),
    ),
  );

  const enclose = encloseDemo();
  card.append(
    section(
      "🔲",
      "Enclose to score",
      "Wall empty squares in on every side to seal a field. Whoever lays the sealing hedge claims every acre inside — even ones a rival helped fence.",
      enclose.node,
    ),
  );

  const corner = cornerDemo();
  card.append(
    section(
      "✂️",
      "Mind the corners",
      "Hedges that meet only at a corner leave a gap — the outside slips through diagonally and the field stays open. Close the corners edge-to-edge to truly seal it.",
      corner.node,
    ),
  );

  const claim = grid(["GGGG", "GaaG", "GGGG"]);
  const claimKit = PLAYER_KITS[3]; // 🐓
  setCell(claim.cell(1, 1), "acre", { tint: claimKit.colour, animal: claimKit.animal });
  setCell(claim.cell(1, 2), "acre", { tint: claimKit.colour });
  card.append(
    section(
      "🐷",
      "Claim the land",
      "A sealed field turns your colour and your livestock move in to graze the acres you've won.",
      diagram(claim.node, "→ your colour + animals"),
    ),
  );

  // Herd bonus — bigger connected pastures accommodate bigger herds.
  const herdKit = PLAYER_KITS[2]; // 🐑
  const bigField = grid(["GGGGG", "GaaaG", "GaaaG", "GGGGG"]);
  ([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]] as [number, number][]).forEach(([r, c], i) =>
    setCell(bigField.cell(r, c), "acre", { tint: herdKit.colour, animal: i % 2 === 0 ? herdKit.animal : "" }),
  );
  const pen = grid(["GGG", "GaG", "GGG"]);
  setCell(pen.cell(1, 1), "acre", { tint: herdKit.colour, animal: herdKit.animal });
  card.append(
    section(
      "🐑",
      "Room to roam",
      `Big open pastures house big herds. On top of each acre, a connected field earns a herd bonus of +1 for every ${ACRES_PER_HERD} acres it spans — so one wide field is worth more than the same land split into little pens.`,
      diagram(bigField.node, "→ 6 acres = +2 🐾", pen.node, "→ 1 acre = +0"),
    ),
  );

  // Bonus acres — flair points (🔥) stacked on top of rules-pure acres.
  const bonusList = el("ul", "ht-controls ht-bonuses");
  const bonusRows: [string, string][] = [
    ["🔁", "Streak — seal a field on back-to-back turns for Double, Triple… On fire! Each turn in the run adds flair."],
    ["🌾", "Bumper turn — wall in 3+ acres, or seal 2+ fields, in a single turn for a Mega bonus."],
    ...LIVESTOCK.map((l): [string, string] => [l.animal, `${l.perkName} — ${l.perkBlurb.toLowerCase()}`]),
  ];
  for (const [k, v] of bonusRows) {
    const li = el("li");
    li.append(el("span", "ht-emoji", k), document.createTextNode(v));
    bonusList.append(li);
  }
  card.append(
    section(
      "🏆",
      "Bonus acres",
      "Bold farming earns flair points (🔥) on top of your acres — and they count toward winning. Your livestock has its own knack, too:",
      bonusList,
    ),
  );

  card.append(
    section(
      "🚜",
      "Sundown & the harvest",
      "The day ends when a farmer plants their last hedge (empty hand and empty bag). The farmer with the highest total — acres plus herd and flair bonuses — wins the harvest. Sealed fields are locked — no hedges may be planted inside them.",
    ),
  );

  const controls = el("section", "ht-section");
  const ch = el("h3", "ht-head");
  ch.append(el("span", "ht-emoji", "🎮"), document.createTextNode("Controls"));
  controls.append(ch);
  const list = el("ul", "ht-controls");
  for (const [k, v] of [
    ["👆", "Tap a highlighted square to lay the selected hedge"],
    ["↻", "Rotate the selected hedge; Undo takes back a pending hedge"],
    ["✅", "Confirm turn once you're happy with your hedges"],
    ["🖐️", "Drag to pan, pinch or scroll to zoom, ⤢ recenters the board"],
    ["🔊", "Mute or unmute sound"],
    ["✕", "Quit to the menu — your game is saved"],
  ] as [string, string][]) {
    const li = el("li");
    li.append(el("span", "ht-emoji", k), document.createTextNode(v));
    list.append(li);
  }
  controls.append(list);
  card.append(controls);

  const close = el("button", "btn primary ht-close", "Got it — let's play");
  card.append(close);

  overlay.append(card);
  document.body.append(overlay);
  card.scrollTop = 0;

  const reduce = reduced();
  let closing = false;
  const dismiss = (): void => {
    if (closing) return;
    closing = true;
    const done = (): void => {
      overlay.remove();
      open = false;
    };
    if (reduce) return done();
    gsap.to(card, { scale: 0.95, y: 16, autoAlpha: 0, duration: 0.24, ease: "power2.in" });
    gsap.to(overlay, { autoAlpha: 0, duration: 0.28, ease: "power2.in", onComplete: done });
  };
  close.onclick = dismiss;
  overlay.onclick = (e) => {
    if (e.target === overlay) dismiss();
  };

  const startDemos = (): void => {
    enclose.play();
    corner.play();
  };

  if (reduce) {
    startDemos();
    return;
  }

  // Entrance: backdrop fades, the card springs in, sections cascade up, the
  // example tiles pop — then the two mini-board demos start looping.
  gsap
    .timeline({ onComplete: startDemos })
    .from(overlay, { autoAlpha: 0, duration: 0.3, ease: "power2.out" }, 0)
    .from(card, { scale: 0.9, y: 28, autoAlpha: 0, duration: 0.5, ease: "back.out(1.5)" }, 0.05)
    .from(card.children, { y: 22, autoAlpha: 0, duration: 0.45, stagger: 0.05, ease: "power3.out" }, 0.2)
    .from(
      card.querySelectorAll(".ht-diagram .ht-cell, .ht-strip, .ht-chip"),
      { scale: 0, autoAlpha: 0, duration: 0.32, stagger: 0.01, ease: "back.out(2.2)" },
      0.32,
    );
}
