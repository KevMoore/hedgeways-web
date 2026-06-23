import { Game } from "../src/game/game";
import { chooseAiMove } from "../src/game/ai";
import { makeRng } from "../src/game/rng";

const t0 = Date.now();
const game = new Game({
  seed: 42,
  players: [
    { name: "M1", isBot: true, difficulty: "medium" },
    { name: "M2", isBot: true, difficulty: "medium" },
  ],
});
const rng = makeRng(99);
let turns = 0;
while (!game.gameOver && turns < 2000) {
  const tt = Date.now();
  const move = chooseAiMove(game, { rng });
  const dur = Date.now() - tt;
  if (dur > 50)
    console.log(
      `turn ${turns} player ${game.current} took ${dur}ms hand=${game.currentPlayer.hand.length} bag=${game.bag.length} board=${game.board.size}`,
    );
  if (move) game.commit(move);
  else game.pass();
  turns++;
  if (Date.now() - t0 > 30000) {
    console.log("ABORT 30s");
    break;
  }
}
console.log(
  `done in ${Date.now() - t0}ms turns=${turns} over=${game.gameOver} scores=${game.players.map((p) => p.score).join(",")}`,
);
