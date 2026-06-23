import gsap from "gsap";
import { COLOUR_HEX } from "../game/constants";

const PALETTE = Object.values(COLOUR_HEX);

export function confetti(): void {
  const layer = document.createElement("div");
  layer.className = "confetti";
  document.body.appendChild(layer);
  for (let i = 0; i < 90; i++) {
    const p = document.createElement("i");
    p.style.left = Math.random() * 100 + "vw";
    p.style.background = PALETTE[i % PALETTE.length];
    p.style.animationDelay = Math.random() * 0.6 + "s";
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.appendChild(p);
  }
  setTimeout(() => layer.remove(), 3400);
}

type CalloutKind = "info" | "score" | "pass";

export function callout(text: string, kind: CalloutKind = "info"): void {
  // only one callout at a time so they never overlap
  document.querySelectorAll(".callout").forEach((n) => n.remove());
  const el = document.createElement("div");
  el.className = `callout ${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  const tl = gsap.timeline({ onComplete: () => el.remove() });
  tl.fromTo(
    el,
    { y: 18, scale: 0.7, opacity: 0 },
    { y: 0, scale: 1, opacity: 1, duration: 0.28, ease: "back.out(2)" },
  )
    .to(el, { duration: kind === "score" ? 1.0 : 0.7 })
    .to(el, { y: -26, opacity: 0, duration: 0.4, ease: "power1.in" });
}
