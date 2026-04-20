import { stringifyAction } from '../agent/decide';
import type {
  AppMap,
  PersistedScreen,
  Screen,
  SessionState,
  ViewElement,
} from '../types/index';

/**
 * Fold a completed run's `SessionState` into the persistent `AppMap`.
 *
 * Pure function — never mutates `map` or `session`. Returns a fresh `AppMap`.
 *
 * Merge semantics (see Task 18 spec):
 *   - Screens new to the map are added with `firstSeenRun = lastSeenRun =
 *     session.runId` and `seenCount = 1`.
 *   - Screens already in the map keep their `firstSeenRun`, update
 *     `lastSeenRun = session.runId`, increment `seenCount`, and refresh
 *     `activity` to the session's value. Elements are merged by id.
 *   - Element merge: `tapped` becomes OR of the two; `lastSeen` is the latest
 *     ISO; outcomes are merged by `action` key (counts summed, session's
 *     `ledToScreen`/`note` win); `marked` prefers the session's value.
 *   - Transitions are derived from `session.history` where the action led to
 *     a fingerprint change (`outcomeFp !== null && outcomeFp !== screenFp`).
 *     `via` is computed with the shared `stringifyAction` helper.
 *   - Idempotency: `map.mergedRunIds` tracks run IDs already folded in;
 *     merging the same session twice is a no-op (still returns a deep-cloned
 *     fresh map so callers never alias the input).
 *   - `generatedAt` is set deterministically from `session.endedAt` (falls
 *     back to `session.startedAt`) so repeated merges produce equal maps.
 *   - `appVersion` is updated to `session.appVersion` because the session is
 *     always the latest source of truth.
 */
export function mergeRunIntoMap(map: AppMap, session: SessionState): AppMap {
  // Always start from a deep-cloned copy so the returned map is never
  // aliased to the caller's input — preserves function purity regardless of
  // whether we take the early-return or the full-merge branch.
  const next = cloneMap(map);

  if (next.mergedRunIds && next.mergedRunIds.includes(session.runId)) {
    return next;
  }

  const generatedAt = session.endedAt ?? session.startedAt;

  // Merge screens.
  for (const fp of Object.keys(session.screens)) {
    const fromSession = session.screens[fp];
    const existing = next.screens[fp];
    next.screens[fp] = existing
      ? mergeScreen(existing, fromSession, session.runId)
      : freshPersistedScreen(fromSession, session.runId);
  }

  // Merge transitions — derived from history, keyed by (from, via, to).
  for (const entry of session.history) {
    if (entry.outcomeFp === null) continue;
    if (entry.outcomeFp === entry.screenFp) continue;
    const via = stringifyAction(entry.action);
    const existingIdx = next.transitions.findIndex(
      (t) => t.from === entry.screenFp && t.via === via && t.to === entry.outcomeFp,
    );
    if (existingIdx >= 0) {
      const current = next.transitions[existingIdx];
      next.transitions[existingIdx] = { ...current, occurrences: current.occurrences + 1 };
    } else {
      next.transitions.push({
        from: entry.screenFp,
        via,
        to: entry.outcomeFp,
        occurrences: 1,
      });
    }
  }

  // Record that this run has now been merged so a second call is a no-op.
  const mergedRunIds = next.mergedRunIds ? [...next.mergedRunIds] : [];
  mergedRunIds.push(session.runId);
  next.mergedRunIds = mergedRunIds;

  next.appVersion = session.appVersion;
  next.generatedAt = generatedAt;

  return next;
}

/**
 * Build a fresh `PersistedScreen` from a session-side `Screen`. Deep-clones
 * the elements map so later edits to the returned map never bleed back into
 * the caller's `SessionState`.
 */
function freshPersistedScreen(screen: Screen, runId: string): PersistedScreen {
  return {
    fingerprint: screen.fingerprint,
    activity: screen.activity,
    elements: cloneElements(screen.elements),
    firstSeenRun: runId,
    lastSeenRun: runId,
    seenCount: 1,
  };
}

/**
 * Merge an incoming session-side `Screen` into an existing `PersistedScreen`.
 * The returned screen is a fresh object — inputs are untouched.
 */
function mergeScreen(
  existing: PersistedScreen,
  fromSession: Screen,
  runId: string,
): PersistedScreen {
  const elements: Record<string, ViewElement> = {};
  for (const id of Object.keys(existing.elements)) {
    elements[id] = cloneElement(existing.elements[id]);
  }
  for (const id of Object.keys(fromSession.elements)) {
    const sessionEl = fromSession.elements[id];
    const existingEl = elements[id];
    elements[id] = existingEl ? mergeElement(existingEl, sessionEl) : cloneElement(sessionEl);
  }

  return {
    fingerprint: existing.fingerprint,
    activity: fromSession.activity,
    elements,
    firstSeenRun: existing.firstSeenRun,
    lastSeenRun: runId,
    seenCount: existing.seenCount + 1,
  };
}

/**
 * Merge an incoming session-side `ViewElement` into an existing element.
 * `resourceId` is preserved from the existing element (it's the identity key
 * under which the element is indexed, so changing it would be incoherent).
 * `role` and `text` are refreshed from the session because the session is the
 * latest source of truth for user-visible element metadata (labels/roles can
 * shift between app versions).
 * - `tapped` becomes true if either side observed a tap.
 * - `firstSeen` keeps the earliest ISO; `lastSeen` keeps the latest.
 * - Outcomes are merged by `action` key — counts summed, session's
 *   `ledToScreen`/`note` take precedence when present.
 * - `marked` prefers the session's value if set, else keeps the existing.
 */
function mergeElement(existing: ViewElement, fromSession: ViewElement): ViewElement {
  const outcomes = mergeOutcomes(existing.outcomes, fromSession.outcomes);
  const merged: ViewElement = {
    resourceId: existing.resourceId,
    role: fromSession.role,
    text: fromSession.text,
    firstSeen: earliestIso(existing.firstSeen, fromSession.firstSeen),
    lastSeen: latestIso(existing.lastSeen, fromSession.lastSeen),
    tapped: existing.tapped || fromSession.tapped,
    outcomes,
  };
  const marked = fromSession.marked ?? existing.marked;
  if (marked !== undefined) merged.marked = marked;
  return merged;
}

function mergeOutcomes(
  existing: ViewElement['outcomes'],
  incoming: ViewElement['outcomes'],
): ViewElement['outcomes'] {
  const result: ViewElement['outcomes'] = existing.map((o) => ({ ...o }));
  for (const inc of incoming) {
    const idx = result.findIndex((o) => o.action === inc.action);
    if (idx >= 0) {
      const current = result[idx];
      const next: ViewElement['outcomes'][number] = {
        action: current.action,
        ledToScreen: inc.ledToScreen ?? current.ledToScreen,
        count: current.count + inc.count,
      };
      const note = inc.note ?? current.note;
      if (note !== undefined) next.note = note;
      result[idx] = next;
    } else {
      const copy: ViewElement['outcomes'][number] = {
        action: inc.action,
        ledToScreen: inc.ledToScreen,
        count: inc.count,
      };
      if (inc.note !== undefined) copy.note = inc.note;
      result.push(copy);
    }
  }
  return result;
}

function earliestIso(a: string, b: string): string {
  return a <= b ? a : b;
}

function latestIso(a: string, b: string): string {
  return a >= b ? a : b;
}

function cloneElements(
  elements: Record<string, ViewElement>,
): Record<string, ViewElement> {
  const out: Record<string, ViewElement> = {};
  for (const id of Object.keys(elements)) {
    out[id] = cloneElement(elements[id]);
  }
  return out;
}

function cloneElement(el: ViewElement): ViewElement {
  const copy: ViewElement = {
    resourceId: el.resourceId,
    role: el.role,
    text: el.text,
    firstSeen: el.firstSeen,
    lastSeen: el.lastSeen,
    tapped: el.tapped,
    outcomes: el.outcomes.map((o) => {
      const c: ViewElement['outcomes'][number] = {
        action: o.action,
        ledToScreen: o.ledToScreen,
        count: o.count,
      };
      if (o.note !== undefined) c.note = o.note;
      return c;
    }),
  };
  if (el.marked !== undefined) copy.marked = el.marked;
  return copy;
}

/**
 * Deep-clone an `AppMap`. Kept local to this module since the map shape is
 * fully known and `structuredClone` isn't required for our simple JSON-like
 * payload.
 */
function cloneMap(map: AppMap): AppMap {
  const screens: Record<string, PersistedScreen> = {};
  for (const fp of Object.keys(map.screens)) {
    const s = map.screens[fp];
    screens[fp] = {
      fingerprint: s.fingerprint,
      activity: s.activity,
      elements: cloneElements(s.elements),
      firstSeenRun: s.firstSeenRun,
      lastSeenRun: s.lastSeenRun,
      seenCount: s.seenCount,
    };
  }
  const clone: AppMap = {
    appVersion: map.appVersion,
    generatedAt: map.generatedAt,
    schemaVersion: map.schemaVersion,
    screens,
    transitions: map.transitions.map((t) => ({ ...t })),
  };
  if (map.mergedRunIds !== undefined) clone.mergedRunIds = [...map.mergedRunIds];
  return clone;
}
