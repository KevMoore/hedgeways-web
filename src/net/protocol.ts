import type { GameSnapshot, TurnResult } from "../game/game";
import type { Move } from "../game/types";

/** Bumped on any breaking wire change. The server rejects clients whose version
 *  doesn't match (stale surge-cached build hitting a new authority → a clean
 *  "refresh to update" instead of a cryptic desync). */
export const PROTOCOL_VERSION = 2;

/** A player's chosen online identity (no PII — just farmer + livestock kit). */
export interface OnlineKit {
  name: string;
  colour: string;
  animal: string;
  farmerId: string;
  farmerName: string;
}

/** One row of the pre-game lobby table. Humans are the seats people have joined;
 *  every remaining slot is `empty` and becomes a bot when the host starts. */
export interface LobbySlot {
  idx: number;
  type: "human" | "empty";
  name: string; // farmerName for a human seat; "" for an empty slot
  colour?: string;
  animal?: string;
  farmerId?: string;
  connected: boolean;
}

/** Messages the browser sends to the authority. */
export type ClientMsg =
  | { t: "create"; kit: OnlineKit; version: number }
  | { t: "join"; code: string; kit: OnlineKit; version: number }
  | { t: "reconnect"; code: string; token: string; version: number }
  | { t: "start" } // host only: lock the table, fill empties with bots, begin
  | { t: "move"; move: Move }
  | { t: "ghost"; cells: [number, number][] } // live presence: my tentative cells (positions only)
  | { t: "rematch" }
  | { t: "leave" };

/** Messages the authority sends to the browser. `snap` is ALWAYS redacted for
 *  the receiving seat — secret state never leaves the server. `lobby` is built
 *  per-recipient (host-only fields differ by seat). */
export type ServerMsg =
  | { t: "seated"; code: string; seat: number; token: string }
  | {
      t: "lobby";
      slots: LobbySlot[];
      size: number; // fixed table size (= MAX_SEATS)
      humans: number; // human seats currently joined
      minHumans: number; // humans required before the host can start
      youAreHost: boolean;
      canStart: boolean;
    }
  | { t: "state"; snap: GameSnapshot; last?: TurnResult; mySeat: number; turnDeadline: number }
  | { t: "playerLeft"; seat: number; name: string; graceMs: number } // a human dropped; grace running
  | { t: "playerBack"; seat: number; name: string }
  | { t: "ghost"; cells: [number, number][] } // opponent's tentative cells, relayed live
  | { t: "roomClosed"; reason: string }
  | { t: "error"; reason: string };

/** Shot-clock and disconnect grace, shared so client countdowns match the server. */
export const TURN_MS = 180_000; // 3 minutes per HUMAN turn
export const GRACE_MS = 120_000; // hold a dropped player's seat for 2 minutes
export const BOT_MOVE_MS = 1600; // base delay before a server bot commits (+ jitter), so plays are legible

/** Fixed online table: up to 4 seats, empties become bots. At least 2 humans
 *  must be present before the host can start (online is never solo-vs-bots —
 *  that's the offline game). */
export const MAX_SEATS = 4;
export const MIN_HUMANS = 2;
