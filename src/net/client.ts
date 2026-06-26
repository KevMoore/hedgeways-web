import type { GameSnapshot, TurnResult } from "../game/game";
import type { Move } from "../game/types";
import type { ClientMsg, LobbySeat, OnlineKit, ServerMsg } from "./protocol";

export interface NetHandlers {
  onSeated?(code: string, seat: number, token: string): void;
  onLobby?(seats: LobbySeat[], needed: number): void;
  onState?(snap: GameSnapshot, last: TurnResult | undefined, mySeat: number, turnDeadline: number): void;
  onOpponentLeft?(graceMs: number): void;
  onOpponentBack?(): void;
  onOpponentForfeit?(): void;
  onClosed?(reason: string): void;
  onError?(reason: string): void;
  /** transport-level drop (network), distinct from a server-initiated close */
  onDisconnect?(): void;
}

/** Where the authority lives. Set VITE_WS_URL for a deployed server; defaults to
 *  the local dev authority (pnpm dev:server). */
export function defaultWsUrl(): string {
  const env = (import.meta as { env?: Record<string, string> }).env;
  return env?.VITE_WS_URL || "ws://localhost:8787";
}

const SESSION_KEY = "hw_online_v1";
export interface OnlineSession {
  code: string;
  token: string;
  seat: number;
}
export function saveSession(s: OnlineSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
export function loadSession(): OnlineSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as OnlineSession) : null;
  } catch {
    return null;
  }
}
export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Thin typed WebSocket wrapper for the Hedgeways authority. */
export class NetClient {
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(
    private handlers: NetHandlers,
    private url = defaultWsUrl(),
  ) {}

  connect(onOpen?: () => void): void {
    this.closedByUs = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => onOpen?.());
    ws.addEventListener("message", (e) => this.dispatch(e.data));
    ws.addEventListener("close", () => {
      if (!this.closedByUs) this.handlers.onDisconnect?.();
    });
    ws.addEventListener("error", () => {
      if (!this.closedByUs) this.handlers.onError?.("Couldn't reach the game server.");
    });
  }

  private dispatch(raw: unknown): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(raw)) as ServerMsg;
    } catch {
      return;
    }
    const h = this.handlers;
    switch (msg.t) {
      case "seated":
        return void h.onSeated?.(msg.code, msg.seat, msg.token);
      case "lobby":
        return void h.onLobby?.(msg.seats, msg.needed);
      case "state":
        return void h.onState?.(msg.snap, msg.last, msg.mySeat, msg.turnDeadline);
      case "opponentLeft":
        return void h.onOpponentLeft?.(msg.graceMs);
      case "opponentBack":
        return void h.onOpponentBack?.();
      case "opponentForfeit":
        return void h.onOpponentForfeit?.();
      case "roomClosed":
        return void h.onClosed?.(msg.reason);
      case "error":
        return void h.onError?.(msg.reason);
    }
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  create(kit: OnlineKit): void {
    this.send({ t: "create", kit });
  }
  join(code: string, kit: OnlineKit): void {
    this.send({ t: "join", code, kit });
  }
  reconnect(code: string, token: string): void {
    this.send({ t: "reconnect", code, token });
  }
  move(move: Move): void {
    this.send({ t: "move", move });
  }
  rematch(): void {
    this.send({ t: "rematch" });
  }
  leave(): void {
    this.send({ t: "leave" });
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }
}
