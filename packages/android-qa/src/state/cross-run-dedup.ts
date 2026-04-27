import { findingTupleKey } from '../agent/finding-keys';
import { JACCARD_THRESHOLD, jaccard, tokenize } from '../agent/similarity';
import type { Finding, Severity } from '../types/index';

/**
 * Severity ordering used both for bumping (resurrection) and for taking the
 * max between current and historical severities. Kept separate from
 * `dedup.ts` so the two modules stay independent, but the values are
 * intentionally identical — this IS the canonical severity total order.
 */
const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  med: 1,
  high: 2,
  critical: 3,
};

const SEVERITY_BY_RANK: Severity[] = ['low', 'med', 'high', 'critical'];

/**
 * Classify freshly-generated (in-run deduped) findings against the persisted
 * findings history and return a new array with `status`, `severity`,
 * `occurrences`, `firstSeenRun`, and `lastSeenRun` updated per the rules:
 *
 *   - No historical match → `status: 'new'`, occurrences default to 1,
 *     firstSeenRun = lastSeenRun = current runId.
 *   - Tuple match (`screenFp|element|category`) AND summary Jaccard > 0.7:
 *       * historical.status === 'stale' → `resurrected`, severity bumped
 *         one rank (capped at `critical`) but never downgraded from historical.
 *       * otherwise → `previously-seen`, severity = max(current, historical).
 *     Occurrences sum, firstSeenRun preserved from history, lastSeenRun
 *     advances to the current runId.
 *
 * When multiple historical findings match, the one with the most recent
 * `lastSeenRun` wins; ties break on higher severity, then on first-occurrence
 * order in the history array.
 *
 * Pure — no I/O, no input mutation, returned Findings are fresh objects.
 */
export function classifyAgainstHistory(
  findings: Finding[],
  history: Finding[],
): Finding[] {
  if (findings.length === 0) return [];

  // Bucket history by tuple key so per-finding lookup stays O(bucket-size).
  const historyByTuple = new Map<string, Array<{ finding: Finding; index: number }>>();
  for (let i = 0; i < history.length; i += 1) {
    const h = history[i];
    const key = findingTupleKey(h);
    const bucket = historyByTuple.get(key);
    if (bucket) {
      bucket.push({ finding: h, index: i });
    } else {
      historyByTuple.set(key, [{ finding: h, index: i }]);
    }
  }

  return findings.map((f) => classifyOne(f, historyByTuple));
}

function classifyOne(
  current: Finding,
  historyByTuple: Map<string, Array<{ finding: Finding; index: number }>>,
): Finding {
  const bucket = historyByTuple.get(findingTupleKey(current));
  const match = bucket ? pickBestMatch(current, bucket) : null;

  if (!match) {
    return freshCopy(current, {
      status: 'new',
      severity: current.severity,
      occurrences: current.occurrences ?? 1,
      firstSeenRun: current.runId,
      lastSeenRun: current.runId,
    });
  }

  const historical = match;
  const historicalFirstSeen = historical.firstSeenRun ?? historical.runId;
  const totalOccurrences = (historical.occurrences ?? 1) + (current.occurrences ?? 1);

  if (historical.status === 'stale') {
    // Resurrection: escalate current severity by one rank (capped), then take
    // max against historical so we never silently downgrade.
    const bumped = bumpSeverity(current.severity);
    const severity = maxSeverity(bumped, historical.severity);
    return freshCopy(current, {
      status: 'resurrected',
      severity,
      occurrences: totalOccurrences,
      firstSeenRun: historicalFirstSeen,
      lastSeenRun: current.runId,
    });
  }

  // All other prior statuses (new, previously-seen, published, resurrected)
  // collapse to previously-seen on re-observation.
  return freshCopy(current, {
    status: 'previously-seen',
    severity: maxSeverity(current.severity, historical.severity),
    occurrences: totalOccurrences,
    firstSeenRun: historicalFirstSeen,
    lastSeenRun: current.runId,
  });
}

/**
 * Pick the best historical match from a tuple-keyed bucket. Passes the Jaccard
 * filter first; among survivors, prefers most recent `lastSeenRun`, then
 * higher severity, then earliest history index.
 */
function pickBestMatch(
  current: Finding,
  bucket: Array<{ finding: Finding; index: number }>,
): Finding | null {
  const currentTokens = tokenize(current.summary);
  let best: { finding: Finding; index: number } | null = null;

  for (const candidate of bucket) {
    if (jaccard(currentTokens, tokenize(candidate.finding.summary)) <= JACCARD_THRESHOLD) {
      continue;
    }
    if (best === null) {
      best = candidate;
      continue;
    }
    if (isMoreRecent(candidate.finding, best.finding)) {
      best = candidate;
      continue;
    }
    if (isSameRecency(candidate.finding, best.finding)) {
      const candRank = SEVERITY_RANK[candidate.finding.severity];
      const bestRank = SEVERITY_RANK[best.finding.severity];
      if (candRank > bestRank) {
        best = candidate;
        continue;
      }
      // Equal recency AND equal severity → keep earlier history index (best).
    }
  }

  return best ? best.finding : null;
}

/**
 * "More recent" is decided by `lastSeenRun` lexicographic comparison — runIds
 * in this codebase are monotonic timestamps (e.g. `run-1`, `run-2026-04-20`),
 * so string compare is a stable proxy for temporal ordering. A missing
 * `lastSeenRun` falls back to `runId`.
 */
function isMoreRecent(a: Finding, b: Finding): boolean {
  return (a.lastSeenRun ?? a.runId) > (b.lastSeenRun ?? b.runId);
}

function isSameRecency(a: Finding, b: Finding): boolean {
  return (a.lastSeenRun ?? a.runId) === (b.lastSeenRun ?? b.runId);
}

function bumpSeverity(s: Severity): Severity {
  const nextRank = Math.min(SEVERITY_RANK[s] + 1, SEVERITY_RANK.critical);
  return SEVERITY_BY_RANK[nextRank];
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Build a fresh Finding object from `current`, overriding exactly the five
 * cross-run-classification fields. Optional fields are copied only when
 * present so `JSON.stringify` round-trips remain tight.
 */
function freshCopy(
  current: Finding,
  patch: {
    status: Finding['status'];
    severity: Severity;
    occurrences: number;
    firstSeenRun: string;
    lastSeenRun: string;
  },
): Finding {
  const next: Finding = {
    id: current.id,
    runId: current.runId,
    screenFp: current.screenFp,
    element: current.element,
    category: current.category,
    severity: patch.severity,
    summary: current.summary,
    reasoning: current.reasoning,
    status: patch.status,
    occurrences: patch.occurrences,
    firstSeenRun: patch.firstSeenRun,
    lastSeenRun: patch.lastSeenRun,
  };
  if (current.linearIssueId !== undefined) next.linearIssueId = current.linearIssueId;
  if (current.artifactRefs !== undefined) next.artifactRefs = { ...current.artifactRefs };
  return next;
}
