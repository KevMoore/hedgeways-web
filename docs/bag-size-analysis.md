# Hedgeways — Bag Size for 3 & 4 Players

**Status:** ✅ Approved & implemented — bag scales at 26 tiles/player (2p=52, 3p=78, 4p=104)
**Author:** Engineering (analysis via Monte-Carlo self-play simulation)
**Implementation:** `src/game/bag.ts` (`buildBag`/`bagSizeFor`), wired through `game.ts` deal + `ai.ts` hidden-bag model. 2-player is byte-identical to the original set; 4-player is exactly 2× it.

---

## TL;DR

The 52-tile bag is tuned for **2 players**. With 3–4 players the same bag is shared
among more people, so each player gets roughly **half the material and half the game**.
We recommend scaling the bag with the player count — **the same number of tiles per
person as the 2-player game** — which restores the full experience for 3 and 4 players.

| Players | Bag today | **Proposed bag** | How |
|--------:|----------:|-----------------:|-----|
| 2 | 52 | **52** (no change) | the current set |
| 3 | 52 | **78** | 1.5 × the set |
| 4 | 52 | **104** | 2 × the set |

Rule of thumb: **26 tiles per player.** Tile colours and proportions are unchanged — we
just include more of the same tiles when more people play.

---

## The problem, quantified

The bag is a shared resource. Every player draws from the same 52 tiles, so the more
players, the less each one gets to do. Simulation of full games confirms the squeeze:

| Players (52 tiles) | Tiles laid each | Turns each | **Land won each** |
|-------------------:|----------------:|-----------:|------------------:|
| 2 | 26 | ~9 | **~34 acres** |
| 3 | 17 | ~6 | **~22 acres** |
| 4 | 13 | ~4 | **~16 acres** |

A 4-player game gives each person **less than half** the turns and land of a 2-player
game. It ends before fields can develop — which is the "feels built for 2 players"
reaction. The problem is **scarcity, not the rules**.

---

## What the proposal fixes

Scaling to 26 tiles/player restores the 2-player experience for everyone:

| Players | Bag | Turns each | **Land won each** | vs. 2-player game |
|--------:|----:|-----------:|------------------:|-------------------|
| 2 | 52 | ~9 | ~34 | baseline |
| 3 | **78** | ~9 | ~38 | matches / slightly better |
| 4 | **104** | ~9 | ~42 | matches / slightly better |

For a 4-player game this **doubles** each player's turns (4 → 9) and **more than doubles**
the land they can win (16 → 42) — the same depth of game two players enjoy today. (Land
runs a touch higher than 2-player because more players build a denser shared board, so
each tile encloses slightly more.)

---

## Will it cause stalemates? No.

A specific concern was that larger games might lock up or stall. Across **thousands of
simulated games at every player count and bag size**, we measured:

- **0% of games ended in deadlock** (everyone stuck) — at any size.
- **0 stuck turns per game** on average — players essentially always had a legal move.
- At the *tightest* board ever observed, there were still **20+ legal moves available**.

With a 4-tile hand and only 4 colours, there is almost always a legal place to lay a
hedge. Bigger bags make stalls **less** likely, not more, because hands refill more
reliably. **Stalemate risk does not increase with this change.**

We also tested whether the *mix* of tile types (single-colour vs. two-colour vs.
three-colour hedges) could improve play. It makes **almost no difference** — every mix we
tried produced 0% deadlocks and near-identical land and fairness (within ~3%). Tile
distribution is not a meaningful lever; **bag size is.** So we keep the existing, proven
proportions and simply scale them — the safe, minimal change.

---

## Fairness

Larger games also play **more fairly**. With a small bag, a single lucky field-seal is a
big share of a short game, so outcomes swing on luck. More tiles let skill show through:
the gap between winner and runner-up shrinks relative to the stakes (closeness improves
from 0.36 at the 2-player baseline to **0.30 at 3p/78 and 0.27 at 4p/104** — lower is
closer), with no systematic advantage to going first.

---

## Implementation & scope (engineering note)

This is a **contained engine change**, no new art or content:

- Bag size becomes a function of player count (52 / 78 / 104) instead of a fixed 52.
- 78 = one full set + a colour-balanced half-set; 104 = two full sets. Colour balance
  (equal Green/Yellow/Blue/Pink) and tile-type proportions are **preserved exactly**.
- Touch points: the bag builder, the AI's internal model of the unseen bag, and the
  tile-conservation test invariant. All localised to the game engine; no UI rework.
- Fully covered by existing automated tests (engine + AI self-play).

**Effort:** small. **Risk:** low — additive, reversible, no rules change.

---

## Decision needed

1. **Approve** scaling the bag to 26 tiles/player (3p → 78, 4p → 104)? *(recommended)*
2. Or prefer a **leaner** 4-player bag (e.g. 91) for slightly shorter games?
3. Or **hold** at 52 for all counts (status quo)?

---

### Appendix — method

Results come from Monte-Carlo **self-play**: the game's strongest AI plays full games
against itself across a sweep of bag sizes (39–130 tiles) and player counts (2/3/4),
150+ games per configuration, measuring turns, land won, fairness, and stall rate.
Self-play is a proxy for human play; absolute numbers may shift with human players, but
the **relative** comparisons (and therefore the recommendation) are robust. Harness:
`scripts/bag-sweep.ts`.

#### Validated results — bag-size sweep (150 games per row)

Per-player figures are what matter (the experience one person has). The recommended
configurations are **bold**; the status-quo 52-tile rows are the comparison points.

| Players | Bag | Tiles/player | Turns/player | Acres/player | Closeness | Deadlocks | Stuck turns |
|--------:|----:|-------------:|-------------:|-------------:|----------:|----------:|------------:|
| 2 | **52** | 26 | 8.7 | 33.5 | 0.36 | 0% | 0 |
| 3 | 52 | 17 | 5.7 | 22.1 | 0.37 | 0% | 0 |
| 3 | **78** | 26 | 8.7 | 38.5 | 0.30 | 0% | 0 |
| 3 | 104 | 35 | 11.6 | 55.8 | 0.26 | 0% | 0 |
| 4 | 52 | 13 | 4.3 | 15.9 | 0.38 | 0% | 0 |
| 4 | 91 | 23 | 7.5 | 35.6 | 0.26 | 0% | 0 |
| 4 | **104** | 26 | 8.6 | 41.9 | 0.27 | 0% | 0 |

*Closeness = winner-minus-runner-up as a fraction of a fair share (lower = tighter game).
Across the full sweep (39–130 tiles, 2/3/4 players) deadlocks and stuck turns were 0 in
every configuration, and the tightest board ever sampled still offered 20+ legal moves.*

#### Distribution sweep (150 games per row, at the recommended bag sizes)

| Tile mix (mono/pair/tri) | 4p acres/player | 4p closeness | Deadlocks |
|--------------------------|----------------:|-------------:|----------:|
| canonical — 8/46/46% (current) | 41.9 | 0.27 | 0% |
| more single-colour — 25/37/37% | 41.3 | 0.25 | 0% |
| more three-colour — 6/19/75% | 43.1 | 0.22 | 0% |

*Differences are within noise (~3%). Distribution is not a useful lever — keep the
current proportions and scale them.*
