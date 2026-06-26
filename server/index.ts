/**
 * Hedgeways online authority — a thin WebSocket referee.
 *
 * Holds the ONE true Game per room (in memory), validates every move through the
 * existing pure engine (game.commit), and broadcasts a per-seat REDACTED snapshot
 * so secret state (seed / bag / opponent hand) never leaves this process.
 *
 * Single instance by design (Render free tier): all rooms live in one Map. A
 * restart wipes in-flight games — acceptable for a live PoC. Run with:
 *   pnpm server        (tsx server/index.ts)
 *   pnpm dev:server    (tsx watch …)
 */
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Game, type GameConfig, type GameSnapshot } from "../src/game/game";
import { redactFor } from "../src/game/redact";
import {
  GRACE_MS,
  SEATS,
  TURN_MS,
  type ClientMsg,
  type LobbySeat,
  type OnlineKit,
  type ServerMsg,
} from "../src/net/protocol";

interface Seat {
  token: string;
  kit: OnlineKit;
  ws: WebSocket | null;
  connected: boolean;
}

interface Room {
  code: string;
  seats: Seat[];
  game: Game | null;
  started: boolean;
  turnTimer: ReturnType<typeof setTimeout> | null;
  turnDeadline: number;
  graceTimer: ReturnType<typeof setTimeout> | null;
  rematchVotes: Set<number>;
}

const rooms = new Map<string, Room>();
/** Reverse lookup so a socket close can find its seat. */
const conns = new Map<WebSocket, { code: string; seat: number }>();

// ---- helpers ----

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1 (ambiguous)
const CODE_LEN = 6;
function newCode(): string {
  let code = "";
  do {
    code = Array.from({ length: CODE_LEN }, () => CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join("");
  } while (rooms.has(code));
  return code;
}

function newToken(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function send(ws: WebSocket | null, msg: ServerMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function lobbySeats(room: Room): LobbySeat[] {
  return room.seats.map((s) => ({ name: s.kit.farmerName || s.kit.name, connected: s.connected }));
}

function sendLobby(room: Room): void {
  const msg: ServerMsg = { t: "lobby", seats: lobbySeats(room), needed: SEATS - room.seats.length };
  for (const s of room.seats) send(s.ws, msg);
}

/** Pick a kit for the joining seat that doesn't clash with seats already taken. */
function distinctKit(room: Room, kit: OnlineKit): OnlineKit {
  const taken = new Set(room.seats.map((s) => s.kit.farmerId));
  if (!taken.has(kit.farmerId)) return kit;
  // bump to the first free farmer kit colour/animal so the board stays readable
  const POOL: OnlineKit[] = [
    { name: "Rosie", colour: "#e0524d", animal: "🐷", farmerId: "rosie", farmerName: "Farmer Rosie" },
    { name: "Jack", colour: "#7b61ff", animal: "🐮", farmerId: "jack", farmerName: "Farmer Jack" },
    { name: "Molly", colour: "#1f9e8f", animal: "🐑", farmerId: "molly", farmerName: "Farmer Molly" },
    { name: "Billy", colour: "#e0852b", animal: "🐓", farmerId: "billy", farmerName: "Farmer Billy" },
  ];
  return POOL.find((k) => !taken.has(k.farmerId)) ?? kit;
}

function broadcastState(room: Room, last?: ReturnType<Game["commit"]>): void {
  if (!room.game) return;
  const snap: GameSnapshot = room.game.toSnapshot();
  for (let seat = 0; seat < room.seats.length; seat++) {
    const s = room.seats[seat];
    if (!s.connected) continue;
    send(s.ws, {
      t: "state",
      snap: redactFor(snap, seat),
      last: last && last.ok ? last : undefined,
      mySeat: seat,
      turnDeadline: room.turnDeadline,
    });
  }
}

function clearTurnTimer(room: Room): void {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

/** Arm the shot-clock for the current player. On expiry the turn is skipped. */
function scheduleTurn(room: Room): void {
  clearTurnTimer(room);
  if (!room.game || room.game.gameOver) {
    room.turnDeadline = 0;
    return;
  }
  room.turnDeadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    if (!room.game || room.game.gameOver) return;
    // ran out of time → forfeit the turn (no placement) and move on
    room.game.skipStuck();
    broadcastState(room);
    scheduleTurn(room);
  }, TURN_MS);
}

function startGame(room: Room): void {
  const players = room.seats.map((s) => ({
    name: s.kit.name,
    isBot: false,
    colour: s.kit.colour,
    animal: s.kit.animal,
    farmerId: s.kit.farmerId,
    farmerName: s.kit.farmerName,
  }));
  const config: GameConfig = { players, seed: (Math.random() * 0xffffffff) >>> 0 };
  room.game = new Game(config);
  room.started = true;
  room.rematchVotes.clear();
  scheduleTurn(room);
  broadcastState(room);
}

/** Free a room's timers + socket bookkeeping and forget it. No client messaging. */
function retireRoom(room: Room): void {
  clearTurnTimer(room);
  if (room.graceTimer) clearTimeout(room.graceTimer);
  for (const s of room.seats) if (s.ws) conns.delete(s.ws);
  rooms.delete(room.code);
}

/** Close a room with a neutral notice to everyone still connected. */
function closeRoom(room: Room, reason: string): void {
  for (const s of room.seats) send(s.ws, { t: "roomClosed", reason });
  retireRoom(room);
}

/** A player forfeited a LIVE game (quit or never returned). Everyone else still
 *  connected wins by default → they get a proper win end screen. */
function forfeitGame(room: Room, leaverSeat: number): void {
  for (let i = 0; i < room.seats.length; i++)
    if (i !== leaverSeat && room.seats[i].connected) send(room.seats[i].ws, { t: "opponentForfeit" });
  retireRoom(room);
}

// ---- message handling ----

function handle(ws: WebSocket, msg: ClientMsg): void {
  switch (msg.t) {
    case "create": {
      const code = newCode();
      const token = newToken();
      const room: Room = {
        code,
        seats: [{ token, kit: msg.kit, ws, connected: true }],
        game: null,
        started: false,
        turnTimer: null,
        turnDeadline: 0,
        graceTimer: null,
        rematchVotes: new Set(),
      };
      rooms.set(code, room);
      conns.set(ws, { code, seat: 0 });
      send(ws, { t: "seated", code, seat: 0, token });
      sendLobby(room);
      return;
    }

    case "join": {
      const room = rooms.get(msg.code.toUpperCase());
      if (!room) return send(ws, { t: "error", reason: "No game with that code." });
      if (room.seats.length >= SEATS) return send(ws, { t: "error", reason: "That game is full." });
      const seat = room.seats.length;
      const token = newToken();
      room.seats.push({ token, kit: distinctKit(room, msg.kit), ws, connected: true });
      conns.set(ws, { code: room.code, seat });
      send(ws, { t: "seated", code: room.code, seat, token });
      sendLobby(room);
      if (room.seats.length === SEATS) startGame(room);
      return;
    }

    case "reconnect": {
      const room = rooms.get(msg.code.toUpperCase());
      if (!room) return send(ws, { t: "error", reason: "That game has ended." });
      const seat = room.seats.findIndex((s) => s.token === msg.token);
      if (seat < 0) return send(ws, { t: "error", reason: "Could not rejoin that seat." });
      const s = room.seats[seat];
      if (s.ws) conns.delete(s.ws);
      s.ws = ws;
      s.connected = true;
      conns.set(ws, { code: room.code, seat });
      if (room.graceTimer) {
        clearTimeout(room.graceTimer);
        room.graceTimer = null;
      }
      // tell the other seat the wanderer is back
      for (let i = 0; i < room.seats.length; i++)
        if (i !== seat) send(room.seats[i].ws, { t: "opponentBack" });
      sendLobby(room);
      // Resume play with a FRESH shot-clock (the timer was paused on disconnect)
      // and resync BOTH clients so their countdowns match the new deadline.
      if (room.started && room.game) {
        scheduleTurn(room); // no-ops to deadline 0 if the game is already over
        broadcastState(room);
      }
      return;
    }

    case "move": {
      const at = conns.get(ws);
      if (!at) return;
      const room = rooms.get(at.code);
      if (!room || !room.game || room.game.gameOver) return;
      if (room.game.current !== at.seat) return send(ws, { t: "error", reason: "Not your turn." });
      const res = room.game.commit(msg.move);
      if (!res.ok) return send(ws, { t: "error", reason: res.reason ?? "Illegal move." });
      if (res.ended) clearTurnTimer(room);
      else scheduleTurn(room);
      broadcastState(room, res);
      return;
    }

    case "rematch": {
      const at = conns.get(ws);
      if (!at) return;
      const room = rooms.get(at.code);
      if (!room || !room.game || !room.game.gameOver) return;
      room.rematchVotes.add(at.seat);
      if (room.rematchVotes.size === room.seats.length) startGame(room);
      return;
    }

    case "leave": {
      const at = conns.get(ws);
      if (!at) return;
      const room = rooms.get(at.code);
      if (!room) return;
      // After game-over both players already saw the result — just notify anyone
      // still on the end screen so a pending rematch doesn't hang. Mid-game it's
      // a forfeit: the other player wins by default (proper win screen).
      if (room.game?.gameOver) closeRoom(room, "Your opponent left.");
      else forfeitGame(room, at.seat);
      return;
    }
  }
}

function onClose(ws: WebSocket): void {
  const at = conns.get(ws);
  conns.delete(ws);
  if (!at) return;
  const room = rooms.get(at.code);
  if (!room) return;
  const s = room.seats[at.seat];
  if (!s) return;
  s.connected = false;
  s.ws = null;

  if (!room.started) {
    // someone bailed from the lobby before the game began → tear it down
    closeRoom(room, "Your opponent left before the game started.");
    return;
  }
  if (room.game && room.game.gameOver) {
    // finished game: once nobody's left connected, retire the room (no leak)
    if (room.seats.every((x) => !x.connected)) closeRoom(room, "Game over.");
    return;
  }

  // live game: hold the seat for a grace period, then close if they don't return
  for (let i = 0; i < room.seats.length; i++)
    if (i !== at.seat && room.seats[i].connected)
      send(room.seats[i].ws, { t: "opponentLeft", graceMs: GRACE_MS });
  clearTurnTimer(room);
  if (room.graceTimer) clearTimeout(room.graceTimer);
  room.graceTimer = setTimeout(() => {
    // never came back → the remaining player wins by forfeit
    if (!room.seats[at.seat]?.connected) forfeitGame(room, at.seat);
  }, GRACE_MS);
}

// ---- origin allowlist (WebSocket's equivalent of CORS) ----
// Browsers send an Origin header on the WS handshake; we reject cross-site
// connections (CSWSH defence). Non-browser clients (our tests / tooling) send no
// Origin and are allowed. Extra origins via ALLOWED_ORIGINS (comma-separated).
const STATIC_ALLOWED = ["https://hedgeways.surge.sh"];
const ENV_ALLOWED = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED = new Set([...STATIC_ALLOWED, ...ENV_ALLOWED]);

function originAllowed(origin?: string): boolean {
  if (!origin) return true; // non-browser client (Playwright ws lib, smoke script, curl)
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true; // local dev client
    if (u.hostname.endsWith(".onrender.com")) return true; // any Render-hosted frontend
    return ALLOWED.has(origin);
  } catch {
    return false;
  }
}

// ---- boot ----

const PORT = Number(process.env.PORT ?? 8787);

// A tiny HTTP server so Render's health check gets a 200 (a bare ws server would
// answer plain HTTP GETs with 426). WS upgrades are handled by the ws lib.
const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Hedgeways authority OK");
});
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info: { origin?: string }) => originAllowed(info.origin),
});

// Heartbeat: a half-open socket (laptop sleep, dropped tunnel) may never fire
// 'close', leaving the opponent hanging. Ping every 20s; a socket that misses a
// pong is terminated, which triggers onClose → the disconnect/grace flow.
const HEARTBEAT_MS = 20_000;
const alive = new WeakMap<WebSocket, boolean>();
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

wss.on("connection", (ws) => {
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));
  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString()) as ClientMsg;
    } catch {
      return send(ws, { t: "error", reason: "Malformed message." });
    }
    try {
      handle(ws, msg);
    } catch (err) {
      send(ws, { t: "error", reason: "Server error." });
      console.error("handler error", err);
    }
  });
  ws.on("close", () => onClose(ws));
  ws.on("error", () => onClose(ws));
});

httpServer.listen(PORT, () => {
  console.log(`Hedgeways authority listening on :${PORT} (http health + ws upgrade)`);
});
