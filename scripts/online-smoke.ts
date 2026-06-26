/**
 * Headless end-to-end check of the online authority: two ws clients create/join a
 * room and play a full game to completion, driving moves off each client's OWN
 * redacted hand. Asserts the redaction never leaks (opponent hand + bag are always
 * placeholders, seed always stripped) and that a winner is produced.
 *
 * Requires the server running:  pnpm server   (in another terminal)
 * Then:                         pnpm tsx scripts/online-smoke.ts
 */
import { WebSocket } from "ws";
import { Game } from "../src/game/game";
import { isPlaceholder } from "../src/game/redact";
import type { ClientMsg, ServerMsg } from "../src/net/protocol";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const KIT = (id: string, name: string) => ({
  name,
  colour: "#888",
  animal: "🐷",
  farmerId: id,
  farmerName: name,
});

function assertRedacted(snap: ServerMsg & { t: "state" }, seat: number): void {
  const s = snap.snap;
  if (s.config.seed !== undefined) throw new Error("LEAK: seed present");
  if (!s.bag.every(isPlaceholder)) throw new Error("LEAK: bag not redacted");
  s.players.forEach((p, i) => {
    if (i !== seat && !p.hand.every(isPlaceholder)) throw new Error(`LEAK: seat ${i} hand visible`);
  });
}

function client(label: string, onSeated: (code: string) => void) {
  const ws = new WebSocket(URL);
  let seat = -1;
  const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
  ws.on("open", () => onSeated && label === "A" && send({ t: "create", kit: KIT("rosie", "A") }));
  return new Promise<string>((resolve) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.t === "seated") {
        seat = msg.seat;
        if (label === "A") onSeated(msg.code);
      } else if (msg.t === "state") {
        assertRedacted(msg, seat);
        if (msg.snap.gameOver) {
          console.log(`[${label}] game over — winner seat ${msg.snap.winnerId}, scores ${msg.snap.players.map((p) => p.score).join("-")}`);
          resolve(`done`);
          return;
        }
        if (msg.snap.current === seat) {
          // it's my turn — derive a legal move from my (real) hand via a mirror
          const mirror = new Game({ players: msg.snap.config.players });
          mirror.applySnapshot(msg.snap);
          const move = mirror.legalMoves(1)[0];
          if (move) send({ t: "move", move });
          else throw new Error(`[${label}] no legal move but engine didn't end`);
        }
      } else if (msg.t === "error") {
        throw new Error(`[${label}] server error: ${msg.reason}`);
      }
    });
  });
}

async function main() {
  let codeResolve: (c: string) => void;
  const codeP = new Promise<string>((r) => (codeResolve = r));
  const aDone = client("A", (code) => codeResolve(code));
  const code = await codeP;
  console.log("room code:", code);
  const wsB = new WebSocket(URL);
  let seatB = -1;
  const bDone = new Promise<string>((resolve) => {
    wsB.on("open", () => wsB.send(JSON.stringify({ t: "join", code, kit: KIT("jack", "B") } as ClientMsg)));
    wsB.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.t === "seated") seatB = msg.seat;
      else if (msg.t === "state") {
        assertRedacted(msg, seatB);
        if (msg.snap.gameOver) return resolve("done");
        if (msg.snap.current === seatB) {
          const mirror = new Game({ players: msg.snap.config.players });
          mirror.applySnapshot(msg.snap);
          const move = mirror.legalMoves(1)[0];
          if (move) wsB.send(JSON.stringify({ t: "move", move } as ClientMsg));
        }
      } else if (msg.t === "error") throw new Error(`[B] server error: ${msg.reason}`);
    });
  });
  await Promise.all([aDone, bDone]);
  console.log("✅ full online game completed with no redaction leaks");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
