import type { GameSnapshot } from "./game";

const ACTIVE_KEY = "hw_active_v1";

export function saveActive(snap: GameSnapshot): void {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(snap));
  } catch {
    /* no localStorage (or full) — progress just isn't kept */
  }
}

export function loadActive(): GameSnapshot | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GameSnapshot;
  } catch {
    return null;
  }
}

export function clearActive(): void {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

/** Short human summary of a saved game for the menu (no board rehydration). */
export function describeSave(s: GameSnapshot): string {
  const leader = [...s.players].sort((a, b) => b.score - a.score)[0];
  const names = s.players.map((p) => `${p.name} ${p.score}`).join(" · ");
  void leader;
  return `Turn ${s.turn + 1} — ${names}`;
}
