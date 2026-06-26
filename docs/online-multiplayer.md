# Online Multiplayer (Human vs Human) — Plan

**Status:** ✅ built. Originally 2-human H-v-H; extended to **up to 4 seats with
bot-fill** (branch `online-4p-bots`) — see "4-player tables + bot fill" below.
**Scope:** live, 2–4 players per room; empty seats become server-driven bots.

## 4-player tables + bot fill

The room is a **fixed 4-seat table**. Humans join by code; when the **host** (lowest
connected human seat) starts, every empty seat is filled by a **bot the server drives**
via the pure `chooseAiMove`. Design decisions (grilled out with the owner):

- **Start trigger:** host-controlled. The lobby shows a **Start** button, gated until
  **≥2 humans** are seated (`MIN_HUMANS`). Online is never solo-vs-bots — that's the
  offline game.
- **Table is locked at start.** No new humans join a running game (`join` rejects once
  `started`). The only post-start seat changes are drop→bot and own-seat reconnect.
- **Bots:** fixed `medium` difficulty (expert is deliberately *excluded* online — ISMCTS
  per bot per turn would tax the Render free box). Each bot draws a distinct farmer from
  the full roster of 8 (with their personality `style`), so the board stays readable.
- **Bot turns** run server-side in `scheduleTurn`/`runBotTurn`: a bot gets a short jittered
  delay (`BOT_MOVE_MS`, env-overridable to `0` for e2e), then `chooseAiMove → commit →
  broadcast`, chaining through consecutive bots. Bots are exempt from the human shot-clock.
- **Disconnect → bot.** A dropped human's seat is held for the grace period (reconnect
  reclaims it); on grace expiry — or an explicit mid-game quit — the seat **converts to a
  bot** (`seatToBot`) and the game plays on. The game ends only when nobody human remains
  (room retired). There is **no forfeit-win** mid-game anymore.
- **Below 2 humans mid-game:** the game continues to its natural end — `MIN_HUMANS` is a
  *start gate*, not a per-turn invariant.
- **Rematch** fires when every *connected human* seat has voted (bots auto-accept; dropped
  humans don't block — their seats refill as bots).
- **Protocol gate:** `PROTOCOL_VERSION` is sent on create/join/reconnect; a mismatch (stale
  surge-cached client vs new authority) is rejected with a clean "refresh to update". Deploy
  **server first**, then the client, then bust the surge cache.

Key code: `server/index.ts` (`fillBots`, `seatToBot`, `runBotTurn`, host/lobby helpers),
`src/net/protocol.ts` (`MAX_SEATS`/`MIN_HUMANS`/`BOT_MOVE_MS`/`PROTOCOL_VERSION`, richer
`lobby` message + `LobbySlot`, `start` client msg, `playerLeft`/`playerBack`), `src/main.ts`
(`renderLobby` interactive lobby with Start button + bot-preview slots). The engine, the
per-seat `redactFor`, and the in-game `beginOnlineTurn` were already N-player-safe.

---

### Original 2-human plan (below) — retained for protocol/security context.

## Running it locally

Two processes — the static frontend (Vite) and the authority (Node `ws`):

```bash
pnpm dev          # terminal 1 — frontend on :5173
pnpm dev:server   # terminal 2 — authority on ws://localhost:8787
```

Open two browser tabs/windows on the dev URL. In tab 1: **Play online → Create a game**,
copy the 4-char code. In tab 2: **Play online**, type the code, **Join**. Play head-to-head;
hands stay hidden, a shot-clock runs each turn, refresh rejoins your seat, and "Rematch"
restarts both in the same room.

**Tests:**
```bash
pnpm test                              # incl. redact.test.ts (the no-leak proof)
pnpm tsx scripts/online-smoke.ts       # headless 2-client full game (needs pnpm server running)
pnpm exec playwright test online.spec  # two real browsers play a full game
```

For a deployed server, set `VITE_WS_URL=wss://<host>` at build time; the client defaults to
`ws://localhost:8787`.

### Live server (Render)

- **URL:** `wss://hedgeways-server.onrender.com` · health: `https://hedgeways-server.onrender.com/`
- **Service:** `hedgeways-server` (`srv-d8v2jgg0697c73f4hp6g`), Render **free**, **Frankfurt**.
  Dashboard: https://dashboard.render.com/web/srv-d8v2jgg0697c73f4hp6g
- **Deploys are MANUAL** (the service is connected via a public-repo URL, so Render offers no
  auto-deploy/webhook). After pushing server changes to `main`: dashboard → **Manual Deploy →
  Deploy latest commit**. Verify live with `WS_URL=wss://hedgeways-server.onrender.com pnpm tsx
  scripts/ghost-smoke.ts` (and `online-smoke.ts`).
- **Origin allowlist (CORS-equivalent):** localhost (any port), `*.onrender.com`, `hedgeways.surge.sh`.
  Add more via the `ALLOWED_ORIGINS` env var (comma-separated).
- **Test local client → live server:** `.env.local` holds `VITE_WS_URL=wss://hedgeways-server.onrender.com`
  (gitignored). Delete it + restart `pnpm dev` to go back to the local authority.
- **Free-tier note:** idle >15 min → ~60s cold start on the first connection (WS traffic keeps it
  awake during play); in-memory rooms are lost on restart/redeploy.
- **Pending manual step:** move the service into the Hedgeways project (`prj-d8v1prkvikkc73f50tgg`) via
  the dashboard — the MCP can't assign a project.

## What was built

- `src/game/redact.ts` — `redactFor(snap, seat)` + `Game.applySnapshot()`. The security boundary.
- `server/index.ts` — the `ws` authority (rooms, create/join by code, move→commit→broadcast,
  reconnect tokens, grace period, shot-clock, rematch). Own `server/tsconfig.json` (Node types).
- `src/net/protocol.ts` — shared client/server message types + `TURN_MS`/`GRACE_MS`.
- `src/net/client.ts` — `NetClient` (typed socket, session persistence for reconnect).
- `src/ui/game-ui.ts` — online driver: `applyServerState`, per-seat hand, waiting state,
  opponent-move FX, shot-clock, rematch (additive; local single-player path untouched).
- `src/main.ts` — Play-Online / Join-by-code lobby, waiting/disconnect overlays, reconnect-on-boot.

## Robustness (network loss & end-game) — beta hardening

- **3-minute turn shot-clock** (`TURN_MS`), **6-char room codes** (~887M space).
- **Disconnect pauses everything**: the server clears the shot-clock and the connected
  player's board freezes with a live grace countdown — neither player is penalised.
  **Reconnect resumes with a fresh turn clock** and resyncs both tabs (fixed a bug where the
  clock never restarted and the deadline was stale).
- **Heartbeat** (server ping/pong, 20s): terminates half-open sockets (laptop sleep / dropped
  tunnel) so the grace flow fires within ~40s instead of hanging.
- **Auto-reconnect**: a transient drop silently retries (600ms→5s backoff) using the saved seat
  token before surfacing "connection lost". A refresh also rejoins on boot.
- **Forfeit = win**: quitting mid-game (explicit `leave`) or never returning (120s grace expiry)
  gives the remaining player a proper **win end screen** ("opponent forfeited"), not a neutral notice.
- **Graceful move rejection**: a server-rejected move un-sticks the optimistic wait and lets the
  player retry (no fatal overlay) — only true connection/lobby errors are fatal.
- **No room leaks**: finished/abandoned rooms are retired once nobody's connected.
- **End states covered**: last-hedge finish, deadlock (mutual timeout), tie, and win keyed to
  *seat* not name. Verified by `tests/e2e/online.spec.ts` (full game, forfeit, refresh-rejoin).

## Live presence ("ghosting")

While the active player arranges tiles, their **tentative cell positions** (never colours/ids)
are streamed to the opponent as colourless shadows, and the watcher's camera gently pans to
follow — a sense of "something's happening" before the tiles drop. It's a **separate presence
channel** (`ghost` messages), never touched by `redactFor` or the authoritative snapshot:
server relays it active-player→opponent only, capped, never stored. Hidden info preserved
(positions reveal no colour; an adjacent hedge only hints what the commit reveals anyway).
Relay verified by `scripts/ghost-smoke.ts`.

---

The original design follows (the spine we built against).

## TL;DR

The engine (`src/game/`) was *built* for this: pure, deterministic, seedable, fully
serializable (`toSnapshot`/`load`). ~90% of the work is the **authority server we've never
had** plus **decoupling one fat UI file's turn loop** from the local engine. No engine
rewrite, no framework adoption, no PII, surge stays as the frontend host.

## Decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| **Authority** | Thin WebSocket server runs the *real* `Game`; secret state never leaves it | Hidden info (bag + hands) means a player's browser can't be trusted as referee. |
| **Transport** | WebSocket, not WebRTC | Turn-based → latency irrelevant. WebRTC adds complexity, still needs a signaling server, and can't hide the bag from a peer. |
| **Session** | Live, both present | No durable storage / notifications / day-long turn clocks. Smallest correct PoC. |
| **Seats** | 2 humans only | No server-side AI for the PoC. |
| **Join** | Short room code | Code *is* the room name on the server — no lookup table. Friend types it on a Join screen. |
| **Disconnect** | Grace period (~90s) + reconnect | A wifi blip shouldn't end the game. Defines the identity model (reconnect token). |
| **Hosting** | Render free web service (`ws`) | Genuinely $0, `wss` via managed TLS, single instance = in-memory rooms. Portable Node — clean migration path to Cloudflare/PartyKit if cold starts/latency bite. |

In scope for PoC: per-player identity picker, rematch-in-room, turn timer/shot-clock,
spectator-proof-from-start redaction. (Turn timer is the one item that adds real
server complexity — it needs a timer that fires when no client is connected.)

## Architecture

```
Browser A ──┐                 ┌─ Node ws server (Render free) ──┐
            ├── wss ──────────┤  rooms: Map<code, Game>          │
Browser B ──┘                 │  • owns the ONE true Game        │
                              │  • validates via game.commit()   │
   surge static frontend      │  • redactFor(seat) per client    │
   (unchanged)                │  • grace timer + turn timer      │
                              └──────────────────────────────────┘
```

- **Server** holds the only real `Game`. All rooms live in one process as
  `Map<roomCode, RoomState>` (single Render instance → no shared store needed).
- **Restart wipes in-flight games** (in-memory, free tier). Acceptable for live PoC.

## The security model: `redactFor`

This is the entire fairness guarantee. One pure, exhaustively-tested function.

```ts
// src/game/redact.ts
export interface RedactedSnapshot {
  config: { players: PlayerConfig[] };   // NOTE: seed REMOVED
  cells: [string, Cell][];
  enclosed: string[];
  acreOwner: [string, number][];
  bagCount: number;                       // was: bag: Tile[]
  players: RedactedPlayer[];              // own hand full; others → handCount only
  current: number;
  turn: number;
  gameOver: boolean;
  winnerId: number | null;
  passes: number;
}

/** Strip everything the given seat must not see. Pure. */
export function redactFor(snap: GameSnapshot, seat: number): RedactedSnapshot;
```

**Must strip — each is a silent game-breaker if leaked:**
1. `config.seed` — bag order is `shuffle(buildBag(n), makeRng(seed))`. Seed → entire bag
   and every hand is reconstructable. **Most dangerous leak.**
2. `bag` array → `bagCount` only.
3. Every *other* seat's `hand` contents → `handCount` only.

**Test:** assert no secret key survives for any seat, in *every* phase including the
pre-game lobby (the "spectator-proof from start" requirement). A property test that walks
the redacted object and fails on any `seed`/`bag`/foreign-`hand` key.

## Message protocol (client ⇄ server)

```ts
// client → server
{ t: "create", kit: PlayerKit }                       // → { roomCode, seat, token }
{ t: "join",   roomCode, kit: PlayerKit }             // → { seat, token } | { error }
{ t: "reconnect", roomCode, token }                   // reclaim seat after refresh/drop
{ t: "move", move: Move }                             // validated via game.commit
{ t: "rematch" }                                      // both ready → fresh seed, new Game

// server → client (per-connection, already redacted)
{ t: "state", snap: RedactedSnapshot, last?: TurnResult }  // last drives opponent FX
{ t: "lobby", seats: SeatInfo[] }                     // who's in, picker state
{ t: "opponentLeft", graceMs }                        // start the reconnect countdown
{ t: "opponentBack" }
{ t: "clock", seat, msLeft }                          // turn timer tick
{ t: "error", reason }
```

Sync granularity: **full redacted snapshot per turn** (board is tiny; `game.load()`
already rehydrates a snapshot perfectly). No deltas. The `last: TurnResult` rides along
so the *opponent's* client can play scoring flair/confetti (the actor computed it locally).

## Code impact

**Engine (`src/game/`) — additive, stays pure:**
- New `redact.ts` (`redactFor` + `RedactedSnapshot`). ~40 lines.
- `Game.load()` already tolerant; ensure it accepts a redacted snapshot for the
  *spectator/own* view (own hand present; bag/others as counts → client renders backs).
- Everything else reused verbatim.

**New `server/` (portable Node + `ws`):**
- Room registry, seat assignment, reconnect-token check, grace timer, turn-clock timer,
  rematch (new seed → `new Game`). Imports the engine directly (shared package / path).
- `onMessage("move")` → `game.commit(move)` → broadcast `redactFor(seat)` to each conn.

**Client (`src/ui/game-ui.ts`) — the biggest *client* refactor:**
- `beginTurn()` (line ~126) is the dispatch hook. Today: human path vs bot timer path.
  Add a third: **remote turn** → show "waiting for opponent", no local search.
- Replace, for online games only, the local `commit` with **send `move` → await
  `state` broadcast → `game.load(snap)` → animate via existing `botLayMoveAnimated`-style
  path** (reuse the animation, drive it from the broadcast instead of `chooseAiMove`).
- Keep **local single-player on the existing path untouched** — online is a *parallel*
  driver, not a rewrite of the turn loop.
- New screens: Play Online (create → show code), Join (enter code), lobby/waiting,
  "opponent disconnected" + reconnect countdown, rematch button.

**Frontend hosting:** unchanged — surge. Server is a separate `wss://…onrender.com`
origin; client connects cross-origin (fine over TLS). Add a `pnpm deploy:server`.

## Risks (ranked)

1. **Redaction correctness = fairness itself.** A single leaked secret silently breaks the
   game with no error. → pure fn + exhaustive test (above).
2. **Client turn-loop refactor** touches the most complex file (`game-ui.ts`, ~1360 lines):
   the `pendingMove`→settle→commit choreography must re-point at the network without
   breaking local play. → parallel driver, not a rewrite.
3. **Turn timer** needs a server timer that fires with no client connected (the one piece
   that isn't pure request/response).
4. **Render free cold start (~60s)** on first connect to an idle server; **in-memory state
   lost on restart**. Tolerable for friends-PoC; $7 Starter or PartyKit migration if not.
5. **Guessable room codes** — a stranger could grab seat 2 of an active room. → expire codes,
   seal the room once both reconnect tokens are issued, free the code on game end.

## Build order (each independently testable)

1. `redactFor()` + exhaustive tests — proves the security model with zero network.
2. `ws` server running `Game` + 2 connections echoing redacted snapshots (throwaway driver script).
3. Client online-driver + create/join/code screens.
4. Reconnect tokens + grace period.
5. Rematch, turn timer, per-player picker, polish.

## Hosting reference (Render free tier, mid-2026)

- Free **web service** supports WebSockets; **WS messages now keep it awake** (so an active
  game stays warm) — idle spin-down only after 15 min with no traffic.
- ~60s cold start on first connect to an idle service. 750 free instance-hours/month/workspace.
- Single instance (good — in-memory rooms), no persistent disk (not needed), managed TLS +
  custom domain (so `wss://` works), no credit card.
- Migration path: same engine + `redactFor`; only the socket glue changes for Cloudflare/PartyKit.
</content>
</invoke>
