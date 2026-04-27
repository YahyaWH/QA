import { describe, it, expect } from 'vitest';
import { classifyAgainstHistory } from './cross-run-dedup';
import type { Finding } from '../types/index';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? 'id-default',
    runId: overrides.runId ?? 'run-2',
    screenFp: overrides.screenFp ?? 'fp-A',
    element: overrides.element === undefined ? 'btn-default' : overrides.element,
    category: overrides.category ?? 'C',
    severity: overrides.severity ?? 'med',
    summary: overrides.summary ?? 'default summary',
    reasoning: overrides.reasoning ?? 'default reasoning',
    status: overrides.status ?? 'new',
    firstSeenRun: overrides.firstSeenRun,
    lastSeenRun: overrides.lastSeenRun,
    occurrences: overrides.occurrences,
    linearIssueId: overrides.linearIssueId,
    artifactRefs: overrides.artifactRefs,
  };
}

describe('classifyAgainstHistory', () => {
  it('marks every finding as "new" when history is empty', () => {
    const a = finding({ id: 'a', runId: 'run-2', summary: 'first thing' });
    const b = finding({ id: 'b', runId: 'run-2', summary: 'second thing' });

    const result = classifyAgainstHistory([a, b], []);
    expect(result).toHaveLength(2);
    for (const f of result) {
      expect(f.status).toBe('new');
      expect(f.occurrences).toBe(1);
      expect(f.firstSeenRun).toBe('run-2');
      expect(f.lastSeenRun).toBe('run-2');
    }
  });

  it('marks unmatched findings as "new" even when history has unrelated entries', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-OTHER',
      element: 'btn-unrelated',
      category: 'A',
      status: 'previously-seen',
      summary: 'totally different problem over here',
      firstSeenRun: 'run-0',
      lastSeenRun: 'run-1',
      occurrences: 5,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      summary: 'something wholly unrelated',
    });

    const [classified] = classifyAgainstHistory([fresh], [historical]);
    expect(classified.status).toBe('new');
    expect(classified.occurrences).toBe(1);
    expect(classified.firstSeenRun).toBe('run-2');
    expect(classified.lastSeenRun).toBe('run-2');
  });

  it('classifies tuple + summary match against prior "new" as "previously-seen"', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'new',
      severity: 'low',
      summary: 'unlabeled icon no accessible name',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      occurrences: 2,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'med',
      summary: 'unlabeled FAB icon has no accessible name',
      occurrences: 1,
    });

    const [classified] = classifyAgainstHistory([fresh], [historical]);
    expect(classified.status).toBe('previously-seen');
    expect(classified.severity).toBe('med'); // max(low, med)
    expect(classified.occurrences).toBe(3); // 2 + 1
    expect(classified.firstSeenRun).toBe('run-1');
    expect(classified.lastSeenRun).toBe('run-2');
    // Current finding's id/summary/reasoning survive unchanged.
    expect(classified.id).toBe('f-1');
    expect(classified.summary).toBe('unlabeled FAB icon has no accessible name');
  });

  it('classifies tuple + summary match against prior "stale" as "resurrected" with bumped severity', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'stale',
      severity: 'low',
      summary: 'unlabeled icon no accessible name',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      occurrences: 3,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'med',
      summary: 'unlabeled FAB icon has no accessible name',
      occurrences: 1,
    });

    const [classified] = classifyAgainstHistory([fresh], [historical]);
    expect(classified.status).toBe('resurrected');
    // med bumped to high; historical was low — max picks bumped current.
    expect(classified.severity).toBe('high');
    expect(classified.occurrences).toBe(4);
    expect(classified.firstSeenRun).toBe('run-1');
    expect(classified.lastSeenRun).toBe('run-2');
  });

  it('does NOT match when tuple matches but summary Jaccard is below threshold', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'new',
      summary: 'button has no label at all',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      occurrences: 1,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      summary: 'network request failed to complete',
    });

    const [classified] = classifyAgainstHistory([fresh], [historical]);
    expect(classified.status).toBe('new');
    expect(classified.occurrences).toBe(1);
    expect(classified.firstSeenRun).toBe('run-2');
    expect(classified.lastSeenRun).toBe('run-2');
  });

  it('picks the most-recent historical match when multiple candidates exist', () => {
    const older = finding({
      id: 'h-old',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'stale',
      severity: 'low',
      summary: 'unlabeled icon no accessible name',
      firstSeenRun: 'run-0',
      lastSeenRun: 'run-1',
      occurrences: 1,
    });
    const newer = finding({
      id: 'h-new',
      runId: 'run-3',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'previously-seen',
      severity: 'high',
      summary: 'unlabeled icon no accessible name',
      firstSeenRun: 'run-2',
      lastSeenRun: 'run-3',
      occurrences: 4,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-4',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'med',
      summary: 'unlabeled FAB icon has no accessible name',
      occurrences: 1,
    });

    // Order the older one first to ensure recency, not order, drives selection.
    const [classified] = classifyAgainstHistory([fresh], [older, newer]);
    // newer was "previously-seen" (not stale) → classification comes from newer.
    expect(classified.status).toBe('previously-seen');
    // severity = max(med, high) from newer.
    expect(classified.severity).toBe('high');
    // occurrences = newer.occurrences + fresh.occurrences.
    expect(classified.occurrences).toBe(5);
    // firstSeenRun preserved from newer.
    expect(classified.firstSeenRun).toBe('run-2');
    expect(classified.lastSeenRun).toBe('run-4');
  });

  it('caps severity at "critical" when resurrecting from a critical stale finding', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'A',
      status: 'stale',
      severity: 'critical',
      summary: 'app crashed on launch screen entirely',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      occurrences: 1,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'A',
      severity: 'med',
      summary: 'app crashed on launch screen entirely',
    });

    const [classified] = classifyAgainstHistory([fresh], [historical]);
    expect(classified.status).toBe('resurrected');
    // bump med → high, historical critical — max picks critical and stays capped.
    expect(classified.severity).toBe('critical');
  });

  it('preserves input order in the output', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'new',
      summary: 'one two three four five six',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      occurrences: 1,
    });
    const f1 = finding({ id: 'f-1', runId: 'run-2', screenFp: 'fp-Z', element: 'e1', category: 'B' });
    const f2 = finding({
      id: 'f-2',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      summary: 'one two three four five six',
    });
    const f3 = finding({ id: 'f-3', runId: 'run-2', screenFp: 'fp-Y', element: 'e3', category: 'D' });

    const result = classifyAgainstHistory([f1, f2, f3], [historical]);
    expect(result.map((f) => f.id)).toEqual(['f-1', 'f-2', 'f-3']);
    expect(result[0].status).toBe('new');
    expect(result[1].status).toBe('previously-seen');
    expect(result[2].status).toBe('new');
  });

  it('does not mutate input findings or the history array', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'stale',
      severity: 'low',
      summary: 'unlabeled icon no accessible name',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      occurrences: 2,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'med',
      summary: 'unlabeled FAB icon has no accessible name',
      occurrences: 1,
    });
    const findings = [fresh];
    const history = [historical];
    const findingsSnapshot = JSON.parse(JSON.stringify(findings));
    const historySnapshot = JSON.parse(JSON.stringify(history));

    classifyAgainstHistory(findings, history);

    expect(findings).toEqual(findingsSnapshot);
    expect(history).toEqual(historySnapshot);
  });

  it('never downgrades severity — current low vs historical critical yields critical', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'new',
      severity: 'critical',
      summary: 'unlabeled icon no accessible name',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      occurrences: 1,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'low',
      summary: 'unlabeled FAB icon has no accessible name',
    });

    const [classified] = classifyAgainstHistory([fresh], [historical]);
    expect(classified.status).toBe('previously-seen');
    expect(classified.severity).toBe('critical');
  });

  it('matches when both elements are null (tuple equality includes null-literal)', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: null,
      category: 'C',
      status: 'new',
      severity: 'med',
      summary: 'screen is missing a required heading',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      occurrences: 1,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: null,
      category: 'C',
      severity: 'med',
      summary: 'screen missing a required heading',
    });

    const [classified] = classifyAgainstHistory([fresh], [historical]);
    expect(classified.status).toBe('previously-seen');
    expect(classified.firstSeenRun).toBe('run-1');
    expect(classified.lastSeenRun).toBe('run-2');
  });

  it('prefers higher severity when tie-breaking equally-recent historical matches', () => {
    const lowSev = finding({
      id: 'h-low',
      runId: 'run-3',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'previously-seen',
      severity: 'low',
      summary: 'unlabeled icon no accessible name',
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-3',
      occurrences: 1,
    });
    const highSev = finding({
      id: 'h-high',
      runId: 'run-3',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'previously-seen',
      severity: 'high',
      summary: 'unlabeled icon no accessible name',
      firstSeenRun: 'run-2',
      lastSeenRun: 'run-3',
      occurrences: 4,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-4',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'med',
      summary: 'unlabeled FAB icon has no accessible name',
      occurrences: 1,
    });

    const [classified] = classifyAgainstHistory([fresh], [lowSev, highSev]);
    expect(classified.status).toBe('previously-seen');
    expect(classified.severity).toBe('high');
    // firstSeenRun should come from highSev (the tie-breaker winner).
    expect(classified.firstSeenRun).toBe('run-2');
    // occurrences = highSev.occurrences + fresh.occurrences
    expect(classified.occurrences).toBe(5);
  });

  it('falls back to history.runId when historical.firstSeenRun is undefined', () => {
    const historical = finding({
      id: 'h-1',
      runId: 'run-1',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      status: 'new',
      severity: 'med',
      summary: 'some shared summary with many words here',
      firstSeenRun: undefined,
      lastSeenRun: undefined,
      occurrences: 1,
    });
    const fresh = finding({
      id: 'f-1',
      runId: 'run-2',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'med',
      summary: 'some shared summary with many words here',
    });

    const [classified] = classifyAgainstHistory([fresh], [historical]);
    expect(classified.status).toBe('previously-seen');
    expect(classified.firstSeenRun).toBe('run-1');
    expect(classified.lastSeenRun).toBe('run-2');
  });
});
