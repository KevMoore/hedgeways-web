import type { Colour } from "./types";

export const HAND_SIZE = 4;
export const MAX_LAY = 3; // tiles per turn

/** Each farmer claims acres with their livestock + player colour. */
export interface PlayerKit {
  animal: string;
  colour: string;
  /** Farmer character ID — picks one of the drawn farmer portraits. */
  farmerId: "rosie" | "jack" | "molly" | "billy";
  farmerName: string;
}
export const PLAYER_KITS: PlayerKit[] = [
  { animal: "🐷", colour: "#e0524d", farmerId: "rosie", farmerName: "Farmer Rosie" },
  { animal: "🐮", colour: "#7b61ff", farmerId: "jack", farmerName: "Farmer Jack" },
  { animal: "🐑", colour: "#1f9e8f", farmerId: "molly", farmerName: "Farmer Molly" },
  { animal: "🐓", colour: "#e0852b", farmerId: "billy", farmerName: "Farmer Billy" },
];

/**
 * Farmer + livestock are picked independently on the home screen. The farmer
 * carries the player's identity colour (their acres' tint + portrait); the
 * livestock is the animal stamped on those acres, its ambient call, and a small
 * scoring perk. Both are honoured straight through to the in-game Player.
 */
export interface Farmer {
  id: PlayerKit["farmerId"];
  name: string;
  colour: string;
}
export const FARMERS: Farmer[] = PLAYER_KITS.map((k) => ({
  id: k.farmerId,
  name: k.farmerName,
  colour: k.colour,
}));

/** A livestock perk fires for a small flair bonus when its move matches the kind. */
export type LivestockPerk = "wide" | "multi" | "streak" | "steady";

export interface Livestock {
  animal: string;
  /** Plural herd name, e.g. "Cattle". */
  name: string;
  perk: LivestockPerk;
  perkName: string;
  /** One-line UI blurb describing when the +1 fires. */
  perkBlurb: string;
}
export const LIVESTOCK: Livestock[] = [
  { animal: "🐮", name: "Cattle", perk: "wide", perkName: "Wide Pastures", perkBlurb: "+1 when a move seals a field of 4+ acres" },
  { animal: "🐷", name: "Pigs", perk: "multi", perkName: "Forager", perkBlurb: "+1 when a move seals 2+ fields at once" },
  { animal: "🐓", name: "Chickens", perk: "streak", perkName: "Brood", perkBlurb: "+1 extra on a 3-turn (or longer) sealing streak" },
  { animal: "🐑", name: "Sheep", perk: "steady", perkName: "Flock", perkBlurb: "+1 when a move seals 2+ acres" },
];

/** Resolve a livestock's perk kind from its emoji (null if unknown). */
export const livestockPerk = (animal: string): LivestockPerk | null =>
  LIVESTOCK.find((l) => l.animal === animal)?.perk ?? null;

/** Stats describing the acres a single move just sealed. */
export interface SealStats {
  scored: number; // total acres sealed this move
  fields: number; // distinct fields sealed this move
  biggest: number; // acres in the largest single field sealed
  streak: number; // actor's scoring streak AFTER this move
}

/** Does this livestock's perk fire (a +1) for the given move? Pure — engine + tests share it. */
export function livestockPerkFires(perk: LivestockPerk | null, s: SealStats): boolean {
  if (s.scored <= 0) return false;
  switch (perk) {
    case "wide":
      return s.biggest >= 4;
    case "multi":
      return s.fields >= 2;
    case "streak":
      return s.streak >= 3;
    case "steady":
      return s.scored >= 2;
    default:
      return false;
  }
}

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
