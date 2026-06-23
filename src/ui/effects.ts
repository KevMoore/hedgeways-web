import { COLOUR_HEX } from "../game/constants";

const PALETTE = Object.values(COLOUR_HEX);

export function confetti(): void {
  const layer = document.createElement("div");
  layer.className = "confetti";
  document.body.appendChild(layer);
  for (let i = 0; i < 80; i++) {
    const p = document.createElement("i");
    p.style.left = Math.random() * 100 + "vw";
    p.style.background = PALETTE[i % PALETTE.length];
    p.style.animationDelay = Math.random() * 0.6 + "s";
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.appendChild(p);
  }
  setTimeout(() => layer.remove(), 3200);
}

export function callout(text: string): void {
  const el = document.createElement("div");
  el.className = "callout";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}
