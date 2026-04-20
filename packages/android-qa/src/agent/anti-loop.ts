import type { SessionState } from '../types/index';

type HistoryEntry = SessionState['history'][number];

/**
 * True when the agent has issued the same action `n` times consecutively at the tail of history
 * AND none of those turns produced a fingerprint change (either `outcomeFp === screenFp` or
 * `outcomeFp === null`). Actions are compared by `JSON.stringify` so discriminated-union variants
 * like `{ kind: 'tap', elementId }` compare correctly.
 *
 * Returns false if fewer than `n` turns exist.
 */
export function detectRepeat(history: HistoryEntry[], n = 3): boolean {
  if (history.length < n) return false;
  const tail = history.slice(-n);
  const target = JSON.stringify(tail[0].action);
  for (const turn of tail) {
    if (JSON.stringify(turn.action) !== target) return false;
    if (!noProgress(turn)) return false;
  }
  return true;
}

/**
 * True when none of the last `n` turns produced a fingerprint not previously seen elsewhere in
 * history. Specifically: each of the last `n` turns has an `outcomeFp` that either is null or
 * already appears in the {screenFp, outcomeFp} set of all turns strictly earlier than the window.
 * Null outcomes count as "not new".
 *
 * Returns false if fewer than `n` turns exist.
 */
export function detectWander(history: HistoryEntry[], n = 5): boolean {
  if (history.length < n) return false;
  const windowStart = history.length - n;
  const earlier = history.slice(0, windowStart);
  const seen = new Set<string>();
  for (const turn of earlier) {
    seen.add(turn.screenFp);
    if (turn.outcomeFp !== null) seen.add(turn.outcomeFp);
  }
  const windowTurns = history.slice(windowStart);
  for (const turn of windowTurns) {
    if (turn.outcomeFp === null) continue; // null counts as "not new"
    if (!seen.has(turn.outcomeFp)) return false;
  }
  return true;
}

/**
 * True when the last `2 * len` turns' `screenFp` values alternate between two distinct
 * fingerprints — the classic A-B-A-B-A-B loop. For len=3 this means 6 turns where
 * `screenFps[i] === screenFps[i + 2]` for all valid i, and `screenFps[0] !== screenFps[1]`.
 *
 * Returns false if fewer than `2 * len` turns exist.
 */
export function detectCycle(history: HistoryEntry[], len = 3): boolean {
  const needed = 2 * len;
  if (history.length < needed) return false;
  const tail = history.slice(-needed);
  const fps = tail.map((t) => t.screenFp);
  if (fps[0] === fps[1]) return false;
  for (let i = 0; i < needed - 2; i++) {
    if (fps[i] !== fps[i + 2]) return false;
  }
  return true;
}

/**
 * A turn made no progress if its outcome fingerprint equals the screen it started on, or is null
 * (no observation / no change). Used by `detectRepeat` to confirm a repeated action is actually
 * stuck rather than making forward progress.
 */
function noProgress(turn: HistoryEntry): boolean {
  return turn.outcomeFp === null || turn.outcomeFp === turn.screenFp;
}
