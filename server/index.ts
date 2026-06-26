/**
 * Hedgeways online authority — a thin WebSocket referee.
 *
 * Holds the ONE true Game per room (in memory), validates every move through the
 * existing pure engine (game.commit), and broadcasts a per-seat REDACTED snapshot
 * so secret state (seed / bag / opponent hand) never leaves this process.
 *
 * Tables are up to 4 seats. Humans join by code; when the host starts, any empty
 * seat is filled by a bot the SERVER drives via the pure AI (chooseAiMove). A
 * human who drops mid-game has their seat held for a grace period, then converted
 * to a bot so the game plays on for everyone else.
 *
 * Single instance by design (Render free tier): all rooms live in one Map. A
 * restart wipes in-flight games — acceptable for a live PoC. Run with:
 *   pnpm server        (tsx server/index.ts)
 *   pnpm dev:server    (tsx watch …)
 */
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Game, type GameConfig, type GameSnapshot } from "../src/game/game";
import { chooseAiMove } from "../src/game/ai";
import { redactFor } from "../src/game/redact";
import { FARMERS, LIVESTOCK } from "../src/game/constants";
import {
  BOT_MOVE_MS,
  GRACE_MS,
  MAX_SEATS,
  MIN_HUMANS,
  PROTOCOL_VERSION,
  TURN_MS,
  type ClientMsg,
  type LobbySlot,
  type OnlineKit,
  type ServerMsg,
} from "../src/net/protocol";

interface Seat {
  token: string;
  kit: OnlineKit;
  ws: WebSocket | null;
  connected: boolean;
  isBot: boolean;
  /** per-seat disconnect grace timer (a dropped human → bot on expiry) */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface Room {
  code: string;
  seats: Seat[];
  game: Game | null;
  started: boolean;
  turnTimer: ReturnType<typeof setTimeout> | null;
  turnDeadline: number;
  rematchVotes: Set<number>;
}

const rooms = new Map<string, Room>();
/** Reverse lookup so a socket close can find its room. The seat is derived from
 *  the socket (seats can be spliced pre-start, so a stored index would go stale). */
const conns = new Map<WebSocket, string>();

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

/** Full farmer roster as online kits (8 farmers, cycling the 4 livestock animals)
 *  — the pool bots draw distinct identities from when filling a table. */
const ANIMALS = LIVESTOCK.map((l) => l.animal);
const KIT_POOL: OnlineKit[] = FARMERS.map((f, i) => ({
  name: f.name,
  colour: f.colour,
  animal: ANIMALS[i % ANIMALS.length],
  farmerId: f.id,
  farmerName: f.name,
}));

const seatOf = (room: Room, ws: WebSocket): number => room.seats.findIndex((s) => s.ws === ws);
const connectedHumans = (room: Room): number => room.seats.filter((s) => !s.isBot && s.connected).length;
/** The host is the lowest-indexed connected human seat (recomputed, never stored,
 *  so it migrates automatically when a creator bails pre-start). */
const hostSeat = (room: Room): number => room.seats.findIndex((s) => !s.isBot && s.connected);

/** Pick a kit for a joining human that doesn't clash with seats already taken. */
function distinctKit(room: Room, kit: OnlineKit): OnlineKit {
  const taken = new Set(room.seats.map((s) => s.kit.farmerId));
  if (!taken.has(kit.farmerId)) return kit;
  return KIT_POOL.find((k) => !taken.has(k.farmerId)) ?? kit;
}

/** Append bot seats until the table is full, each with a distinct farmer + (where
 *  possible) a distinct animal, so the board stays readable. */
function fillBots(room: Room): void {
  const takenFarmers = new Set(room.seats.map((s) => s.kit.farmerId));
  const takenAnimals = new Set(room.seats.map((s) => s.kit.animal));
  while (room.seats.length < MAX_SEATS) {
    const f = KIT_POOL.find((k) => !takenFarmers.has(k.farmerId));
    if (!f) break;
    takenFarmers.add(f.farmerId);
    let animal = f.animal;
    if (takenAnimals.has(animal)) animal = ANIMALS.find((a) => !takenAnimals.has(a)) ?? animal;
    takenAnimals.add(animal);
    room.seats.push({ token: newToken(), kit: { ...f, animal }, ws: null, connected: false, isBot: true, graceTimer: null });
  }
}

/** The pre-game lobby table, built fresh per recipient (host-only fields differ). */
function sendLobby(room: Room): void {
  const slots: LobbySlot[] = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    const s = room.seats[i];
    if (s && !s.isBot)
      slots.push({
        idx: i,
        type: "human",
        name: s.kit.farmerName || s.kit.name,
        colour: s.kit.colour,
        animal: s.kit.animal,
        farmerId: s.kit.farmerId,
        connected: s.connected,
      });
    else slots.push({ idx: i, type: "empty", name: "", connected: false });
  }
  const humans = connectedHumans(room);
  const host = hostSeat(room);
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    if (s.isBot || !s.ws) continue;
    const youAreHost = i === host;
    send(s.ws, {
      t: "lobby",
      slots,
      size: MAX_SEATS,
      humans,
      minHumans: MIN_HUMANS,
      youAreHost,
      canStart: youAreHost && humans >= MIN_HUMANS,
    });
  }
}

function broadcastState(room: Room, last?: ReturnType<Game["commit"]>): void {
  if (!room.game) return;
  const snap: GameSnapshot = room.game.toSnapshot();
  for (let seat = 0; seat < room.seats.length; seat++) {
    const s = room.seats[seat];
    if (!s.connected || !s.ws) continue; // bots + dropped humans have no socket
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

/** Arm the next turn. A human gets the shot-clock; a bot gets a short, jittered
 *  delay then plays itself (server-side) — so a run of bots is legible, not a jump. */
function scheduleTurn(room: Room): void {
  clearTurnTimer(room);
  if (!room.game || room.game.gameOver) {
    room.turnDeadline = 0;
    return;
  }
  if (room.game.currentPlayer.isBot) {
    room.turnDeadline = 0; // no human shot-clock for a bot turn
    // BOT_MOVE_MS env override lets e2e run bots instantly; prod keeps the jittered pace.
    const env = process.env.BOT_MOVE_MS;
    const delay = env != null ? Number(env) : BOT_MOVE_MS + Math.floor(Math.random() * 700);
    room.turnTimer = setTimeout(() => runBotTurn(room), delay);
    return;
  }
  room.turnDeadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    if (!room.game || room.game.gameOver) return;
    room.game.skipStuck(); // ran out of time → forfeit the turn (no placement)
    broadcastState(room);
    scheduleTurn(room);
  }, TURN_MS);
}

/** Run one bot turn through the pure AI, commit it, broadcast, and chain on. */
function runBotTurn(room: Room): void {
  room.turnTimer = null;
  if (!room.game || room.game.gameOver) return;
  if (!room.game.currentPlayer.isBot) return; // seat reclaimed by a returning human
  const move = chooseAiMove(room.game);
  const res = move ? room.game.commit(move) : room.game.skipStuck();
  if (res.ended) clearTurnTimer(room);
  else scheduleTurn(room);
  broadcastState(room, res.ok ? res : undefined);
}

function buildPlayers(room: Room) {
  return room.seats.map((s) => ({
    name: s.isBot ? s.kit.farmerName : s.kit.name,
    isBot: s.isBot,
    difficulty: "medium" as const,
    colour: s.kit.colour,
    animal: s.kit.animal,
    farmerId: s.kit.farmerId,
    farmerName: s.kit.farmerName,
  }));
}

function startGame(room: Room): void {
  const config: GameConfig = { players: buildPlayers(room), seed: (Math.random() * 0xffffffff) >>> 0 };
  room.game = new Game(config);
  room.started = true;
  room.rematchVotes.clear();
  scheduleTurn(room);
  broadcastState(room);
}

/** Free a room's timers + socket bookkeeping and forget it. No client messaging. */
function retireRoom(room: Room): void {
  clearTurnTimer(room);
  for (const s of room.seats) {
    if (s.graceTimer) clearTimeout(s.graceTimer);
    if (s.ws) conns.delete(s.ws);
  }
  rooms.delete(room.code);
}

/** Close a room with a neutral notice to everyone still connected. */
function closeRoom(room: Room, reason: string): void {
  for (const s of room.seats) send(s.ws, { t: "roomClosed", reason });
  retireRoom(room);
}

/** Turn a seat (dropped or quit human) into a bot and play on. If no humans are
 *  left to watch, retire the room instead. */
function seatToBot(room: Room, seat: number): void {
  const s = room.seats[seat];
  if (!s) return;
  if (s.graceTimer) {
    clearTimeout(s.graceTimer);
    s.graceTimer = null;
  }
  s.isBot = true;
  s.connected = false;
  s.ws = null;
  if (room.game) room.game.players[seat].isBot = true;
  if (connectedHumans(room) === 0) return retireRoom(room);
  if (room.game && !room.game.gameOver) {
    scheduleTurn(room); // re-derive for the current player (bot timer if it's their turn)
    broadcastState(room);
  }
}

// ---- message handling ----

function handle(ws: WebSocket, msg: ClientMsg): void {
  switch (msg.t) {
    case "create": {
      if (msg.version !== PROTOCOL_VERSION) return send(ws, { t: "error", reason: "Out of date — refresh the page to update." });
      const code = newCode();
      const room: Room = {
        code,
        seats: [{ token: newToken(), kit: msg.kit, ws, connected: true, isBot: false, graceTimer: null }],
        game: null,
        started: false,
        turnTimer: null,
        turnDeadline: 0,
        rematchVotes: new Set(),
      };
      rooms.set(code, room);
      conns.set(ws, code);
      send(ws, { t: "seated", code, seat: 0, token: room.seats[0].token });
      sendLobby(room);
      return;
    }

    case "join": {
      if (msg.version !== PROTOCOL_VERSION) return send(ws, { t: "error", reason: "Out of date — refresh the page to update." });
      const room = rooms.get(msg.code.toUpperCase());
      if (!room) return send(ws, { t: "error", reason: "No game with that code." });
      if (room.started) return send(ws, { t: "error", reason: "That game has already started." });
      if (room.seats.length >= MAX_SEATS) return send(ws, { t: "error", reason: "That game is full." });
      const seat = room.seats.length;
      const token = newToken();
      room.seats.push({ token, kit: distinctKit(room, msg.kit), ws, connected: true, isBot: false, graceTimer: null });
      conns.set(ws, room.code);
      send(ws, { t: "seated", code: room.code, seat, token });
      sendLobby(room);
      return;
    }

    case "start": {
      const code = conns.get(ws);
      const room = code ? rooms.get(code) : undefined;
      if (!room || room.started) return;
      if (seatOf(room, ws) !== hostSeat(room)) return send(ws, { t: "error", reason: "Only the host can start." });
      if (connectedHumans(room) < MIN_HUMANS) return send(ws, { t: "error", reason: `Need at least ${MIN_HUMANS} players to start.` });
      fillBots(room);
      startGame(room);
      return;
    }

    case "reconnect": {
      if (msg.version !== PROTOCOL_VERSION) return send(ws, { t: "error", reason: "Out of date — refresh the page to update." });
      const room = rooms.get(msg.code.toUpperCase());
      if (!room) return send(ws, { t: "error", reason: "That game has ended." });
      const seat = room.seats.findIndex((s) => s.token === msg.token);
      if (seat < 0) return send(ws, { t: "error", reason: "Could not rejoin that seat." });
      const s = room.seats[seat];
      if (s.ws) conns.delete(s.ws);
      s.ws = ws;
      s.connected = true;
      s.isBot = false; // a human reclaiming a seat that may have been bot-covered
      if (room.game) room.game.players[seat].isBot = false;
      if (s.graceTimer) {
        clearTimeout(s.graceTimer);
        s.graceTimer = null;
      }
      conns.set(ws, room.code);
      for (let i = 0; i < room.seats.length; i++)
        if (i !== seat && room.seats[i].connected) send(room.seats[i].ws, { t: "playerBack", seat, name: s.kit.farmerName || s.kit.name });
      if (!room.started) {
        sendLobby(room);
        return;
      }
      // Resume play with a FRESH shot-clock and resync everyone's countdowns.
      if (room.game) {
        scheduleTurn(room);
        broadcastState(room);
      }
      return;
    }

    case "move": {
      const code = conns.get(ws);
      const room = code ? rooms.get(code) : undefined;
      if (!room || !room.game || room.game.gameOver) return;
      const seat = seatOf(room, ws);
      if (room.game.current !== seat) return send(ws, { t: "error", reason: "Not your turn." });
      const res = room.game.commit(msg.move);
      if (!res.ok) return send(ws, { t: "error", reason: res.reason ?? "Illegal move." });
      if (res.ended) clearTurnTimer(room);
      else scheduleTurn(room);
      broadcastState(room, res);
      return;
    }

    case "ghost": {
      // Live presence relay: the active player's tentative cell POSITIONS only
      // (never colours/ids), forwarded to the others. Not part of game state.
      const code = conns.get(ws);
      const room = code ? rooms.get(code) : undefined;
      if (!room || !room.game || room.game.gameOver) return;
      const seat = seatOf(room, ws);
      if (room.game.current !== seat) return; // only the player whose turn it is
      if (!Array.isArray(msg.cells) || msg.cells.length > 9) return;
      for (let i = 0; i < room.seats.length; i++)
        if (i !== seat && room.seats[i].connected) send(room.seats[i].ws, { t: "ghost", cells: msg.cells });
      return;
    }

    case "rematch": {
      const code = conns.get(ws);
      const room = code ? rooms.get(code) : undefined;
      if (!room || !room.game || !room.game.gameOver) return;
      const seat = seatOf(room, ws);
      if (seat < 0) return;
      room.rematchVotes.add(seat);
      // fire when every CONNECTED HUMAN has voted (bots auto-accept; dropped
      // humans don't block — their seats just refill as bots on the new game)
      const humanSeats = room.seats.map((s, i) => ({ s, i })).filter((x) => !x.s.isBot && x.s.connected);
      if (humanSeats.length > 0 && humanSeats.every((x) => room.rematchVotes.has(x.i))) startGame(room);
      return;
    }

    case "leave": {
      const code = conns.get(ws);
      const room = code ? rooms.get(code) : undefined;
      if (!room) return;
      const seat = seatOf(room, ws);
      if (seat < 0) return;
      conns.delete(ws);
      if (!room.started) {
        // lobby: drop the seat; tear down only if nobody human is left
        room.seats.splice(seat, 1);
        if (room.seats.length === 0) retireRoom(room);
        else sendLobby(room);
        return;
      }
      if (room.game?.gameOver) {
        // end screen: just mark them gone; retire once everyone has left
        room.seats[seat].connected = false;
        room.seats[seat].ws = null;
        if (room.seats.every((x) => !x.connected)) retireRoom(room);
        return;
      }
      // mid-game quit → a bot takes the seat and the game plays on
      for (let i = 0; i < room.seats.length; i++)
        if (i !== seat && room.seats[i].connected)
          send(room.seats[i].ws, { t: "playerLeft", seat, name: room.seats[seat].kit.farmerName || room.seats[seat].kit.name, graceMs: 0 });
      seatToBot(room, seat);
      return;
    }
  }
}

function onClose(ws: WebSocket): void {
  const code = conns.get(ws);
  conns.delete(ws);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const seat = room.seats.findIndex((s) => s.ws === ws);
  if (seat < 0) return;
  const s = room.seats[seat];
  s.connected = false;
  s.ws = null;

  if (!room.started) {
    // bailed from the lobby before the game began → drop the seat (host migrates
    // to the next human automatically); tear the room down only if it's now empty
    room.seats.splice(seat, 1);
    if (room.seats.length === 0) retireRoom(room);
    else sendLobby(room);
    return;
  }
  if (room.game && room.game.gameOver) {
    if (room.seats.every((x) => !x.connected)) closeRoom(room, "Game over.");
    return;
  }

  // live game: hold the seat for a grace period, then convert it to a bot so the
  // others play on. A reconnect within grace reclaims it (see "reconnect").
  for (let i = 0; i < room.seats.length; i++)
    if (i !== seat && room.seats[i].connected) send(room.seats[i].ws, { t: "playerLeft", seat, name: s.kit.farmerName || s.kit.name, graceMs: GRACE_MS });
  clearTurnTimer(room); // pause the shot-clock while we wait for them
  if (s.graceTimer) clearTimeout(s.graceTimer);
  s.graceTimer = setTimeout(() => {
    if (!room.seats[seat]?.connected) seatToBot(room, seat); // never came back → bot
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
// 'close', leaving the others hanging. Ping every 20s; a socket that misses a
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
