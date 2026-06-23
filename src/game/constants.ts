import type { Colour } from "./types";

export const HAND_SIZE = 4;
export const MAX_LAY = 3; // tiles per turn

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

/** Dark forest-green wooden tile frame + black cracks. */
export const FRAME_HEX = "#1f3d2b";
export const FRAME_CRACK_HEX = "#0c1a12";
export const ACRE_HEX = "#dff0c8"; // enclosed field fill
export const BOARD_BG = "#eef3e6";
