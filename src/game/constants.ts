import type { Colour } from "./types";

export const HAND_SIZE = 4;
export const MAX_LAY = 3; // tiles per turn

/** Each farmer claims acres with their livestock + player colour. */
export interface PlayerKit {
  animal: string;
  colour: string;
}
export const PLAYER_KITS: PlayerKit[] = [
  { animal: "🐷", colour: "#e0524d" },
  { animal: "🐮", colour: "#7b61ff" },
  { animal: "🐑", colour: "#1f9e8f" },
  { animal: "🐓", colour: "#e0852b" },
];

/** Vivid leaf colours matching the physical tiles (kept close to the company brand palette). */
export const COLOUR_HEX: Record<Colour, string> = {
  G: "#6cc24a",
  Y: "#f5a623",
  B: "#29abe2",
  P: "#e83e8c",
};

/** Darker shade per colour, for leaf-blob shading. */
export const COLOUR_HEX_DARK: Record<Colour, string> = {
  G: "#4e9a34",
  Y: "#d4861a",
  B: "#1d87b8",
  P: "#c22d72",
};

export const COLOUR_NAME: Record<Colour, string> = {
  G: "Green",
  Y: "Yellow",
  B: "Blue",
  P: "Pink",
};

/** Dark forest-green hedge tile frame + deep shadow line. */
export const FRAME_HEX = "#1f3d2b";
export const FRAME_CRACK_HEX = "#0c1a12";
export const ACRE_HEX = "#dff0c8"; // enclosed field fill
export const BOARD_BG = "#eef3e6";

/** Leafy hedge tones — lighter green so the perimeter reads as fresh greenery. */
export const HEDGE_BASE = "#4b9a55";
export const HEDGE_DARK = "#2c5e38";
export const HEDGE_LEAVES = ["#3c7a45", "#5cb060", "#7ac172", "#2c5e38"];
export const HEDGE_DANGER = "#b65a44";
export const HEDGE_DANGER_DARK = "#7a3a2c";
export const HEDGE_DANGER_LEAVES = ["#7a3a32", "#9a4a3a", "#b65a44", "#5e2a2a"];
