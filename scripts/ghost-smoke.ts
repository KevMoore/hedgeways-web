/**
 * Headless check of the presence (ghost) relay: the active player's ghost cells
 * reach ONLY the opponent, and a non-active player's ghost is NOT relayed. Run
 * the server first (pnpm server), then: pnpm tsx scripts/ghost-smoke.ts
 */
import { WebSocket } from "ws";
import type { ClientMsg, ServerMsg } from "../src/net/protocol";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const kit = (id: string) => ({ name: id, colour: "#888", animal: "🐷", farmerId: id, farmerName: id });

function open(): Promise<WebSocket> {
  const ws = new WebSocket(URL);
  return new Promise((res) => ws.on("open", () => res(ws)));
}
const send = (ws: WebSocket, m: ClientMsg) => ws.send(JSON.stringify(m));

async function main() {
  const a = await open();
  const b = await open();
  let seatA = -1;
  let curA = -1;
  const got: Record<string, ServerMsg[]> = { a: [], b: [] };
  const wire = (ws: WebSocket, who: string, onSeat?: (s: number) => void, onState?: (c: number) => void) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      got[who].push(m);
      if (m.t === "seated" && onSeat) onSeat(m.seat);
      if (m.t === "state" && onState) onState(m.snap.current);
    });
  wire(a, "a", (s) => (seatA = s), (c) => (curA = c));
  wire(b, "b");

  send(a, { t: "create", kit: kit("rosie") });
  await new Promise((r) => setTimeout(r, 200));
  const code = (got.a.find((m) => m.t === "seated") as Extract<ServerMsg, { t: "seated" }>).code;
  send(b, { t: "join", code, kit: kit("jack") });
  await new Promise((r) => setTimeout(r, 400)); // let the game start + initial state land

  const active = curA === seatA ? a : b; // whoever's turn it is
  const idle = curA === seatA ? b : a;
  const activeWho = curA === seatA ? "a" : "b";
  const watcher = curA === seatA ? "b" : "a";

  // 1) active player ghosts → the watcher must receive it
  got.a.length = 0;
  got.b.length = 0;
  send(active, { t: "ghost", cells: [[2, 3], [2, 4]] });
  await new Promise((r) => setTimeout(r, 200));
  const relayed = got[watcher].find((m) => m.t === "ghost") as Extract<ServerMsg, { t: "ghost" }> | undefined;
  if (!relayed) throw new Error("active player's ghost was NOT relayed to the watcher");
  if (JSON.stringify(relayed.cells) !== JSON.stringify([[2, 3], [2, 4]])) throw new Error("ghost cells corrupted in relay");
  if (got[activeWho].some((m) => m.t === "ghost")) throw new Error("ghost echoed back to the sender");

  // 2) the idle (non-active) player ghosts → must be ignored (not relayed)
  got.a.length = 0;
  got.b.length = 0;
  send(idle, { t: "ghost", cells: [[9, 9]] });
  await new Promise((r) => setTimeout(r, 200));
  if (got.a.some((m) => m.t === "ghost") || got.b.some((m) => m.t === "ghost"))
    throw new Error("a non-active player's ghost was relayed (should be ignored)");

  console.log("✅ ghost relay: active→watcher only, non-active ignored, no echo, cells intact");
  process.exit(0);
}
main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
