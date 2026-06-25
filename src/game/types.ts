export type Colour = "G" | "Y" | "B" | "P";

export const COLOURS: Colour[] = ["G", "Y", "B", "P"];

/** A hedge tile: a 1x3 strip of three coloured segments (segment 0 -> 1 -> 2). */
export interface Tile {
  id: number;
  segments: [Colour, Colour, Colour];
}

/** A single occupied board cell. */
export interface Cell {
  colour: Colour;
  tileId: number;
}

export type Orientation = "H" | "V";

/** Where one tile's three segments land on the grid, fully resolved. */
export interface PlacedTile {
  tileId: number;
  cells: PlacedCell[]; // length 3, in board order
}

export interface PlacedCell {
  x: number;
  y: number;
  colour: Colour;
}

/** A committed turn: lay 1-3 colour-linked tiles, or pass (empty). */
export interface Move {
  tiles: PlacedTile[];
}

export type Difficulty = "easy" | "medium" | "hard" | "expert";

export interface Player {
  id: number;
  name: string;
  isBot: boolean;
  difficulty: Difficulty;
  hand: Tile[];
  score: number; // acres enclosed (pure, rules-authoritative)
  bonus: number; // streak/mega flair points — extra on top of acres
  herdBonus: number; // "animals accommodated" — +1 per ACRES_PER_HERD acres in each owned field
  streak: number; // consecutive own turns that sealed ≥1 acre
  colour: string; // player colour (fills their claimed acres)
  animal: string; // livestock emoji stamped on their acres
  farmerId?: string; // matches a PLAYER_KITS farmerId — drives the farmer avatar
  farmerName?: string; // friendly farmer name (overrides the generic "Bot N" / "You" in chips)
}

export const key = (x: number, y: number): string => `${x},${y}`;
export const unkey = (k: string): [number, number] => {
  const [x, y] = k.split(",").map(Number);
  return [x, y];
};
