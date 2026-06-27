# Hedgeways — Online PoC

A browser game recreation of **Hedgeways**, a physical board game of farmers laying coloured hedges to enclose acres of land. Human vs 1–3 AI opponents. **Live: https://hedgeways.surge.sh**

Single-page, 100% client-side. No backend. Vite + TypeScript + Canvas2D (no framework, no three.js — the game is flat tiles on a grid, and a removed three.js iteration of its sibling SproutWord proved 2D is sharper, lighter, and faster on mobile).

## Commands

```bash
pnpm install         # deps
pnpm dev             # vite dev server (HMR) on :5173
pnpm build           # tsc --noEmit + vite build -> dist/
pnpm typecheck       # tsc --noEmit
pnpm test            # Vitest: engine + AI unit tests (incl. AI-vs-AI self-play)
pnpm test:e2e        # Playwright: UI automation (desktop + mobile viewports)
pnpm run deploy      # build + 200.html fallback + surge ./dist hedgeways.surge.sh
```

- **Deploy is `pnpm run deploy`, NOT `pnpm deploy`** (`deploy` is a reserved pnpm command).
- Surge auth lives in `~/.netrc` (same as SproutWord). CDN caches aggressively — bust with `?cb=…` if a cold-start 504/404 sticks.

## Architecture

```
src/
  game/            # pure engine — no DOM, framework-agnostic
    types.ts       # Colour, Tile, Cell, Player, Move, Difficulty...
    constants.ts   # palette, hand size = 4, max-lay = 3
    bag.ts         # canonical 52-tile set (TILE_CODES); buildBag() scales it per player count
    board.ts       # sparse Map<"x,y",Cell> grid + orient/palindrome helpers
    placement.ts   # validateMove() — Qwirkle-strict colour-match rules
    scoring.ts     # findEnclosed() — exterior flood-fill identifies enclosed acres
    moves.ts       # generateMoves() — DFS up to 3 tiles with breadth limit
    game.ts        # Game state: deal, turns, replenish, end, N players
    ai.ts          # chooseAiMove() — tiered (easy/medium/hard greedy, expert ISMCTS)
    rng.ts         # seedable mulberry32 RNG
  render/
    scene.ts       # Canvas2D renderer: hedges, camera (pan/zoom/auto-fit), FX
  ui/
    game-ui.ts     # HUD, hand, ghost preview, callouts, end screen
    howto.ts       # rules modal
    effects.ts     # confetti + callout toasts
  audio.ts         # procedural WebAudio SFX (no assets)
  main.ts          # boot: start screen -> GameUI
tests/
  unit/            # Vitest — pure engine + AI, plus AI-vs-AI self-play
  e2e/             # Playwright — UI smoke on desktop + mobile via window.__hedge hook
```

The **engine (`src/game/`) is the source of truth and is UI-agnostic** — `scene.ts` exposes a stable interface (`syncBoard`, `setGhost`, `setHighlights`, `fitBoard`, `flashEnclosed`, `tapHandler`) so the renderer could be swapped without touching game logic.

**Online multiplayer (planned, not built):** live 2-human H-v-H over a thin WebSocket authority (Node `ws` on a Render free web service) that runs the existing pure `Game` and redacts secret state (`seed`/`bag`/other hands) per seat. Full plan + protocol in `docs/online-multiplayer.md`.

## Game rules (authoritative — from the physical rule card)

- **You are farmers competing for land.** Use hedges as boundaries to enclose fields. Every enclosed empty square = 1 acre = 1 point.
- A **hedge tile** is a 1×3 strip with three coloured segments drawn from {G, Y, B, P}. The physical game has 52 tiles; the digital version scales the bag with player count (see Key design decisions).
- A player has a hand of 4 hedges and on each turn lays **1, 2, or 3** hedges then replenishes back to 4 (until the bag is empty).
- **Placement (Qwirkle-strict on colour):** every orthogonally abutting segment-pair — between laid tiles and existing tiles, and between laid tiles within the same turn — must be the **same colour**. **All hedges laid in one turn must join up into a single connected run** — each hedge you lay must abut at least one other hedge laid that same turn (you cannot drop unrelated hedges in separate spots in one turn). After turn 1, that run must also touch ≥1 existing hedge (no hedges floating free of the network). This is a subtle rule from the physical card; the rejection message spells it out and the how-to has a "Join up your turn" diagram. (With max-lay 3, "each laid hedge touches another laid hedge" is equivalent to the laid cells forming one orthogonal component — see `validateMove` in `placement.ts`.)
- **Diagonal touches do not enclose** a field — hedges that meet only at a corner leave a gap the outside slips through, so the exterior is flooded with **8-connectivity** (the diagonal gap leaks).
- **No hedges may be laid inside a previously-enclosed field.**
- **Closer-takes-all scoring:** whoever's move seals a field scores every acre in it, regardless of who placed the surrounding hedges. One move may seal several fields (all count).
- **Stuck** = the current player has no legal placement → **pass**.
- **The game ends** when a farmer lays their last hedge (empty hand AND empty bag), or all players pass in one full round (deadlock). The winner has the most acres.

## Key design decisions (and why)

- **Canvas2D, not three.js** — the game is flat 1×3 tiles on a grid; 2D is sharper, ~10× lighter, easier to animate, and mobile-safe. (SproutWord removed three.js for the same reason; we follow that precedent.)
- **No player-coloured tiles.** Tile colours (G/Y/B/P) are intrinsic to the hedges and used for linking. Players are anonymous on the board — they differ only by hand + score totals. This matches the physical game (the bag is shared, hedges look the same once placed).
- **Sparse unbounded grid** (`Map<"x,y",Cell>`). The board grows in any direction. `findEnclosed()` floods the exterior from a 1-cell margin so every empty cell unreached by the flood is enclosed (8-connectivity exterior flood, so a diagonal-corner gap leaks and does **not** seal a field).
- **Tiered AI:**
  - `easy` greedy on immediate gain + 50% noise.
  - `medium` greedy minus a cheap near-closed-cell threat proxy (3-wall empties) — avoids gifting steals to the next mover.
  - `hard` same heuristic, deeper breadth, ranked top-K threat-evaluated.
  - `expert` Information-Set MCTS: determinize hidden bag/hands, root-UCT with cheap random rollouts. **On the empty board the search tree is huge and rollouts are noisy — expert falls back to the `hard` heuristic for the opening move only.**
- **Move generation** is a depth-1-to-3 DFS with a `limit` breadth cap (early-return on `results >= limit`), since the combinatorial fan-out of (anchors × hand × orientations × positions) is far larger than any AI/UX needs.
- **Bag is canonical** (`bag.ts` — 52 entries transcribed from the physical tile photos). **Verify against the real set** and correct misreads in `TILE_CODES` — that file is the single source of truth.
- **Bag scales with player count** (`buildBag(players)`): 26 tiles/player, so 2p→52, 3p→78, 4p→104. The fixed 52-tile bag left 3–4 players with ~half the per-capita material; scaling restores 2-player pacing, land, and fairness without raising stalemate risk (validated by Monte-Carlo self-play — see `docs/bag-size-analysis.md`, harness `scripts/bag-sweep.ts`). Even counts stack whole canonical sets; odd counts add one colour-balanced `HALF_SET`, so **2p is byte-identical to the original and 4p is exactly 2× it**. `bagSizeFor(n)` gives the size; the AI's hidden-bag model (`ai.ts` determinize) rebuilds the same scaled bag, so it must stay in sync with `buildBag`.
- **Hidden information:** other players' hands and the bag order are hidden from human + bots. ISMCTS samples a consistent hidden state per rollout.

## Conventions

- TypeScript strict, `noUnusedLocals/Parameters`. Plain DOM + Canvas, no framework.
- **Comments only when the *why* is non-obvious.** Don't narrate what the code does.
- Brand colours live in `constants.ts` (`COLOUR_HEX`/`COLOUR_HEX_DARK`) and CSS vars — keep them in sync.

## Testing

- **`pnpm test`** — Vitest unit tests for the pure engine (placement, scoring/enclosure, move generation) and AI (legal moves, AI-vs-AI 2p/4p self-play with tile-conservation invariant, expert produces a move within budget).
- **`pnpm test:e2e`** — Playwright drives the real app in Chromium at **desktop AND mobile** viewports. Uses `window.__hedge` hook (`autoPlayTurn`, `state`, `newGame`) for deterministic UI tests.
- **Tile-conservation invariant:** `bag.length + sum(hand.length) + uniqueTilesOnBoard === BAG_SIZE` at all times. Asserted in self-play tests.

## Gotchas

- `pnpm deploy` ≠ `pnpm run deploy` (see Commands).
- Surge edge caching (see Commands).
- **Render: only ever touch the Hedgeways project** (`prj-d8v1prkvikkc73f50tgg`, workspace "Kevs Account"). The account hosts other live apps (LittlePeople, Avon, HSS, Snewham) — never deploy to / modify / suspend any non-Hedgeways service. Any new service goes *inside* the Hedgeways project, and only after explicit go-ahead.
- **Vitest must stay on v2** — v4 needs Vite 6 and we're on Vite 5.
- The expert opening move falls back to heuristic — if you change this, expert's first turn can take many seconds. Do not remove without instrumentation.
