import type { GameSnapshot, TurnResult } from "../game/game";
import type { Move } from "../game/types";

/** A player's chosen online identity (no PII — just farmer + livestock kit). */
export interface OnlineKit {
  name: string;
  colour: string;
  animal: string;
  farmerId: string;
  farmerName: string;
}

export interface LobbySeat {
  name: string;
  connected: boolean;
}

/** Messages the browser sends to the authority. */
export type ClientMsg =
  | { t: "create"; kit: OnlineKit }
  | { t: "join"; code: string; kit: OnlineKit }
  | { t: "reconnect"; code: string; token: string }
  | { t: "move"; move: Move }
  | { t: "ghost"; cells: [number, number][] } // live presence: my tentative cells (positions only)
  | { t: "rematch" }
  | { t: "leave" };

/** Messages the authority sends to the browser. `snap` is ALWAYS redacted for
 *  the receiving seat — secret state never leaves the server. */
export type ServerMsg =
  | { t: "seated"; code: string; seat: number; token: string }
  | { t: "lobby"; seats: LobbySeat[]; needed: number }
  | { t: "state"; snap: GameSnapshot; last?: TurnResult; mySeat: number; turnDeadline: number }
  | { t: "opponentLeft"; graceMs: number }
  | { t: "opponentBack" }
  | { t: "opponentForfeit" } // opponent quit / never returned → you win by default
  | { t: "ghost"; cells: [number, number][] } // opponent's tentative cells, relayed live
  | { t: "roomClosed"; reason: string }
  | { t: "error"; reason: string };

/** Shot-clock and disconnect grace, shared so client countdowns match the server. */
export const TURN_MS = 180_000; // 3 minutes per turn
export const GRACE_MS = 120_000; // hold a dropped player's seat for 2 minutes
export const SEATS = 2;
