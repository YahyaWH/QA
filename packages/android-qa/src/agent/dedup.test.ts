import { describe, it, expect } from 'vitest';
import { dedupInRun } from './dedup';
import type { Finding } from '../types/index';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? 'id-default',
    runId: overrides.runId ?? 'run-1',
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

describe('dedupInRun', () => {
  it('returns [] for empty input', () => {
    expect(dedupInRun([])).toEqual([]);
  });

  it('returns a single finding unchanged, but with occurrences defaulted to 1', () => {
    const f = finding({ id: 'id-1', summary: 'only one thing' });
    const result = dedupInRun([f]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('id-1');
    expect(result[0].summary).toBe('only one thing');
    expect(result[0].occurrences).toBe(1);
  });

  it('merges two findings with identical (screenFp, element, category)', () => {
    const a = finding({
      id: 'id-a',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'low',
      summary: 'some text',
    });
    const b = finding({
      id: 'id-b',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      severity: 'high',
      summary: 'different wording entirely',
    });

    const result = dedupInRun([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrences).toBe(2);
    expect(result[0].severity).toBe('high');
    // Winner is the higher-severity finding — its id/summary come through.
    expect(result[0].id).toBe('id-b');
    expect(result[0].summary).toBe('different wording entirely');
  });

  it('does NOT merge findings with different screenFps', () => {
    const a = finding({ id: 'id-a', screenFp: 'fp-A', element: 'btn-x', category: 'C' });
    const b = finding({ id: 'id-b', screenFp: 'fp-B', element: 'btn-x', category: 'C' });

    const result = dedupInRun([a, b]);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(['id-a', 'id-b']);
  });

  it('does NOT merge findings with different categories', () => {
    const a = finding({ id: 'id-a', screenFp: 'fp-A', element: 'btn-x', category: 'C' });
    const b = finding({ id: 'id-b', screenFp: 'fp-A', element: 'btn-x', category: 'D' });

    const result = dedupInRun([a, b]);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(['id-a', 'id-b']);
  });

  it('merges fuzzy-matching summaries within the same (screenFp, category) bucket', () => {
    // Jaccard:
    //   A = {unlabeled, fab, icon, has, no, accessible, name} (7)
    //   B = {unlabeled, icon, no, accessible, name} (5)
    //   intersection = 5, union = 7, jaccard = 5/7 ~ 0.714 > 0.7
    const a = finding({
      id: 'id-a',
      screenFp: 'fp-A',
      category: 'C',
      element: null,
      severity: 'low',
      summary: 'unlabeled FAB icon has no accessible name',
    });
    const b = finding({
      id: 'id-b',
      screenFp: 'fp-A',
      category: 'C',
      element: 'fab-btn',
      severity: 'high',
      summary: 'unlabeled icon no accessible name',
    });

    const result = dedupInRun([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('high');
    expect(result[0].id).toBe('id-b'); // higher-severity winner
    expect(result[0].element).toBe('fab-btn');
    expect(result[0].occurrences).toBe(2);
  });

  it('does NOT fuzzy-merge summaries below the Jaccard threshold', () => {
    const a = finding({
      id: 'id-a',
      screenFp: 'fp-A',
      category: 'C',
      element: 'btn-label',
      summary: 'button has no label',
    });
    const b = finding({
      id: 'id-b',
      screenFp: 'fp-A',
      category: 'C',
      element: 'net-err',
      summary: 'network request failed to complete',
    });

    const result = dedupInRun([a, b]);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id).sort()).toEqual(['id-a', 'id-b']);
  });

  it('keeps the highest severity when merging critical + low', () => {
    const a = finding({
      id: 'id-crit',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'A',
      severity: 'critical',
      summary: 'app crashed',
    });
    const b = finding({
      id: 'id-low',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'A',
      severity: 'low',
      summary: 'minor cosmetic',
    });

    const [first] = dedupInRun([b, a]);
    expect(first.severity).toBe('critical');
    expect(first.id).toBe('id-crit');
    expect(first.occurrences).toBe(2);
  });

  it('sums occurrences across merged findings (not just counts them)', () => {
    const a = finding({
      id: 'id-a',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      occurrences: 3,
    });
    const b = finding({
      id: 'id-b',
      screenFp: 'fp-A',
      element: 'btn-x',
      category: 'C',
      occurrences: 5,
    });

    const result = dedupInRun([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrences).toBe(8);
  });

  it('does not mutate the input array or its member Findings', () => {
    const input: Finding[] = [
      finding({
        id: 'id-a',
        screenFp: 'fp-A',
        element: 'btn-x',
        category: 'C',
        severity: 'low',
        summary: 'some summary here',
        occurrences: 2,
      }),
      finding({
        id: 'id-b',
        screenFp: 'fp-A',
        element: 'btn-x',
        category: 'C',
        severity: 'high',
        summary: 'another summary',
        occurrences: 4,
      }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input)) as Finding[];

    dedupInRun(input);

    expect(input).toEqual(snapshot);
    // Ensure the array itself wasn't reordered either.
    expect(input.map((f) => f.id)).toEqual(['id-a', 'id-b']);
  });

  it('is deterministic — repeated calls return identical results', () => {
    const input: Finding[] = [
      finding({ id: 'id-1', screenFp: 'fp-A', element: 'e1', category: 'C', severity: 'low', summary: 'one' }),
      finding({ id: 'id-2', screenFp: 'fp-A', element: 'e1', category: 'C', severity: 'high', summary: 'two' }),
      finding({ id: 'id-3', screenFp: 'fp-B', element: 'e2', category: 'B', severity: 'med', summary: 'three' }),
      finding({
        id: 'id-4',
        screenFp: 'fp-A',
        element: null,
        category: 'C',
        severity: 'med',
        summary: 'one with more context',
      }),
      finding({
        id: 'id-5',
        screenFp: 'fp-A',
        element: 'e9',
        category: 'C',
        severity: 'critical',
        summary: 'completely unrelated crash on open',
      }),
    ];

    const first = dedupInRun(input);
    const second = dedupInRun(input);
    expect(second).toEqual(first);
    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id));
  });
});
