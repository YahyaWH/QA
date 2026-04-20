import type { AppMap, Fingerprint, Screen, ViewElement } from '../types/index';

/**
 * One entry in the exploration frontier: a candidate (screen, element) pair the agent may act on
 * next, tagged with a priority score. Higher priority = more interesting to probe.
 */
export interface FrontierEntry {
  screenFp: string;
  elementId: string;
  priority: number;
}

export interface FrontierOptions {
  /** Identifier of the run currently executing; used to decide whether a screen was "seen" this run. */
  currentRunId: string;
  /**
   * How many runs may pass before a previously-tapped element becomes a re-validation candidate.
   * Default 5. Kept for future use; the current heuristic only checks `lastSeenRun !== currentRunId`,
   * treating any screen not seen this run as stale (see band-3 note below).
   */
  reValidateEveryNRuns?: number;
}

/**
 * Build a prioritized exploration frontier from the current screen and the persisted app map.
 *
 * Priority bands (from design spec §5.2.2, highest wins):
 *   100 — Never tapped (no `marked`).
 *    80 — Tapped but leads to a screen with at least one never-tapped element.
 *    60 — Screen not seen in the current run (stale; re-probe tapped elements).
 *    40 — Marked `broken`, screen not seen this run.
 *    -- — Marked `deny-listed`: always excluded.
 *    -- — Tapped, no qualifier: excluded (keeps the frontier small; matches the "5 new + 3 tapped-exclude" spec case).
 *
 * Band-3 simplification: the spec wants "not seen in last M runs" but we lack a run-number ordering
 * in memory, so we use the cheap proxy "the screen's lastSeenRun !== currentRunId" — i.e. any screen
 * not observed THIS run is treated as potentially stale. This over-includes on the first few runs
 * of a cold cache but never under-includes, and is easily refined later once run history is indexed.
 *
 * Sort is descending by priority; stable ties broken by `elementId` ascending.
 */
export function buildFrontier(
  screen: Screen,
  appMap: AppMap,
  opts: FrontierOptions,
): FrontierEntry[] {
  const { currentRunId } = opts;
  const persisted = appMap.screens[screen.fingerprint];
  const screenSeenThisRun = persisted !== undefined && persisted.lastSeenRun === currentRunId;

  const entries: FrontierEntry[] = [];

  for (const [elementId, element] of Object.entries(screen.elements)) {
    const priority = classify(element, appMap, screenSeenThisRun);
    if (priority === null) continue;
    entries.push({ screenFp: screen.fingerprint, elementId, priority });
  }

  entries.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0;
  });

  return entries;
}

/**
 * Assign a priority band to a single element, or `null` to exclude it from the frontier.
 * See the band order documented on `buildFrontier`.
 */
function classify(
  element: ViewElement,
  appMap: AppMap,
  screenSeenThisRun: boolean,
): number | null {
  if (element.marked === 'deny-listed') return null;

  if (element.marked === 'broken') {
    // Re-test broken elements only when the screen wasn't already seen this run.
    return screenSeenThisRun ? null : 40;
  }

  // Band 1: never tapped.
  if (!element.tapped) return 100;

  // Band 2: tapped, but at least one recorded outcome points to a screen in the map that still
  // has an untapped element.
  if (leadsToUnexploredScreen(element, appMap)) return 80;

  // Band 3: screen is stale (not seen this run) — tapped elements on stale screens are re-probe
  // candidates at priority 60.
  if (!screenSeenThisRun) return 60;

  // Fallback: tapped, no qualifier. Exclude to keep the frontier small.
  return null;
}

/**
 * True when any recorded outcome of `element` points to a screen that exists in the app map and
 * still contains at least one element with `tapped === false`.
 */
function leadsToUnexploredScreen(element: ViewElement, appMap: AppMap): boolean {
  for (const outcome of element.outcomes) {
    const target = outcome.ledToScreen;
    if (target === null) continue;
    const targetScreen = appMap.screens[target as Fingerprint];
    if (targetScreen === undefined) continue;
    for (const child of Object.values(targetScreen.elements)) {
      if (!child.tapped) return true;
    }
  }
  return false;
}
