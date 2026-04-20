import type { Finding, Severity } from '../types/index';

/**
 * Severity ordering used to pick the "winner" Finding when merging duplicates.
 * Higher rank beats lower rank. Keep this as a `const` record so TypeScript
 * enforces exhaustiveness against `Severity`.
 */
const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  med: 1,
  high: 2,
  critical: 3,
};

/**
 * Jaccard similarity threshold for fuzzy summary matching. Strictly greater
 * than this value triggers a merge; equal does not. Tuned empirically for
 * short QA-style summaries where 0.7 catches near-paraphrases without
 * collapsing obviously distinct issues.
 */
const JACCARD_THRESHOLD = 0.7;

/**
 * Collapse near-duplicate findings across an entire run into a canonical list.
 * Two merge rules apply:
 *   1. Exact tuple match on `(screenFp, element, category)` — always merges.
 *   2. Fuzzy summary match — within the same `(screenFp, category)` bucket,
 *      when Jaccard similarity of word-sets (lowercased, tokenized on
 *      non-alphanumerics) is strictly > 0.7.
 *
 * Merge semantics:
 *   - `occurrences` = sum of all merged findings' `occurrences` (default 1).
 *   - `severity` = max severity among all merged findings.
 *   - Other fields (`id`, `summary`, `reasoning`, `element`, `category`,
 *     `screenFp`, `runId`, `firstSeenRun`, `lastSeenRun`, `status`,
 *     `linearIssueId`, `artifactRefs`) come from the "winner": the
 *     highest-severity finding, tie-broken by earliest input index so output
 *     stays stable.
 *
 * This function is pure — it never mutates inputs, reads no outer state, and
 * performs no I/O. Returned Findings are fresh objects.
 */
export function dedupInRun(findings: Finding[]): Finding[] {
  if (findings.length === 0) return [];

  // Stage 1 — exact-tuple merge. Keyed on (screenFp, element, category).
  // Preserve input order via the first-seen index of each key.
  const tupleGroups = new Map<string, number[]>();
  const tupleOrder: string[] = [];
  for (let i = 0; i < findings.length; i += 1) {
    const key = tupleKey(findings[i]);
    const existing = tupleGroups.get(key);
    if (existing) {
      existing.push(i);
    } else {
      tupleGroups.set(key, [i]);
      tupleOrder.push(key);
    }
  }

  const stage1: Finding[] = tupleOrder.map((key) => {
    const indices = tupleGroups.get(key);
    if (!indices) throw new Error('unreachable: tuple group missing');
    return mergeIndices(findings, indices);
  });

  // Stage 2 — fuzzy summary merge within each (screenFp, category) bucket.
  // Greedy agglomerative: for each finding, absorb all later findings in the
  // same bucket whose summary Jaccard > 0.7. Runs are small (<200 findings)
  // so the O(n^2) bucket-local scan is fine.
  const buckets = new Map<string, number[]>();
  const bucketOrder: string[] = [];
  for (let i = 0; i < stage1.length; i += 1) {
    const bk = bucketKey(stage1[i]);
    const existing = buckets.get(bk);
    if (existing) {
      existing.push(i);
    } else {
      buckets.set(bk, [i]);
      bucketOrder.push(bk);
    }
  }

  // Map each stage1 index to the cluster it belongs to (cluster id = index of
  // the first element absorbed into that cluster). Stable under the greedy
  // left-to-right pass.
  const clusterOf = new Array<number>(stage1.length);
  for (let i = 0; i < clusterOf.length; i += 1) clusterOf[i] = i;

  for (const bk of bucketOrder) {
    const idxs = buckets.get(bk);
    if (!idxs || idxs.length < 2) continue;
    const tokens = idxs.map((i) => tokenize(stage1[i].summary));
    for (let a = 0; a < idxs.length; a += 1) {
      const ia = idxs[a];
      if (clusterOf[ia] !== ia) continue; // already absorbed by an earlier anchor
      for (let b = a + 1; b < idxs.length; b += 1) {
        const ib = idxs[b];
        if (clusterOf[ib] !== ib) continue; // already in another cluster
        if (jaccard(tokens[a], tokens[b]) > JACCARD_THRESHOLD) {
          clusterOf[ib] = ia;
        }
      }
    }
  }

  // Assemble clusters in first-occurrence order.
  const clusterIndices = new Map<number, number[]>();
  const clusterFirstOrder: number[] = [];
  for (let i = 0; i < stage1.length; i += 1) {
    const c = clusterOf[i];
    const existing = clusterIndices.get(c);
    if (existing) {
      existing.push(i);
    } else {
      clusterIndices.set(c, [i]);
      clusterFirstOrder.push(c);
    }
  }

  return clusterFirstOrder.map((c) => {
    const members = clusterIndices.get(c);
    if (!members) throw new Error('unreachable: cluster members missing');
    return mergeIndices(stage1, members);
  });
}

function tupleKey(f: Finding): string {
  return `${f.screenFp}|${f.element ?? 'null'}|${f.category}`;
}

function bucketKey(f: Finding): string {
  return `${f.screenFp}|${f.category}`;
}

/**
 * Merge the findings at `indices` (in input order) into a single Finding.
 * The "winner" contributes all descriptive fields; severity is escalated to
 * the group max; occurrences is summed (defaulting to 1 per finding).
 */
function mergeIndices(source: Finding[], indices: number[]): Finding {
  let winnerPos = indices[0];
  let winnerRank = SEVERITY_RANK[source[winnerPos].severity];
  let totalOccurrences = 0;
  let maxSeverity: Severity = source[winnerPos].severity;

  for (const idx of indices) {
    const f = source[idx];
    const rank = SEVERITY_RANK[f.severity];
    if (rank > winnerRank) {
      winnerPos = idx;
      winnerRank = rank;
      maxSeverity = f.severity;
    } else if (rank > SEVERITY_RANK[maxSeverity]) {
      maxSeverity = f.severity;
    }
    totalOccurrences += f.occurrences ?? 1;
  }

  const winner = source[winnerPos];
  const merged: Finding = {
    id: winner.id,
    runId: winner.runId,
    screenFp: winner.screenFp,
    element: winner.element,
    category: winner.category,
    severity: maxSeverity,
    summary: winner.summary,
    reasoning: winner.reasoning,
    status: winner.status,
    occurrences: totalOccurrences,
  };
  if (winner.firstSeenRun !== undefined) merged.firstSeenRun = winner.firstSeenRun;
  if (winner.lastSeenRun !== undefined) merged.lastSeenRun = winner.lastSeenRun;
  if (winner.linearIssueId !== undefined) merged.linearIssueId = winner.linearIssueId;
  if (winner.artifactRefs !== undefined) merged.artifactRefs = { ...winner.artifactRefs };
  return merged;
}

/**
 * Lowercase and split on non-alphanumeric runs. Unicode-normalization is out
 * of scope — the spec targets English/ASCII QA summaries.
 */
function tokenize(summary: string): Set<string> {
  const words = summary.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(words);
}

/**
 * Jaccard similarity = |A ∩ B| / |A ∪ B|. Defined as 0 when both sets are
 * empty so two degenerate summaries never merge on vacuous similarity.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
