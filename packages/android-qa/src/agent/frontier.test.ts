import { describe, it, expect } from 'vitest';
import { buildFrontier } from './frontier';
import type { AppMap, PersistedScreen, Screen, ViewElement } from '../types/index';

function elem(overrides: Partial<ViewElement> = {}): ViewElement {
  return {
    resourceId: overrides.resourceId ?? 'com.example:id/btn',
    role: overrides.role ?? 'button',
    text: overrides.text ?? null,
    firstSeen: overrides.firstSeen ?? '2026-01-01T00:00:00.000Z',
    lastSeen: overrides.lastSeen ?? '2026-01-01T00:00:00.000Z',
    tapped: overrides.tapped ?? false,
    outcomes: overrides.outcomes ?? [],
    marked: overrides.marked,
  };
}

function screen(elements: Record<string, ViewElement>, fingerprint = 'fp-current', activity = 'MainActivity'): Screen {
  return { fingerprint, activity, elements };
}

function persisted(
  s: Screen,
  firstSeenRun: string,
  lastSeenRun: string,
  seenCount = 1,
): PersistedScreen {
  return { ...s, firstSeenRun, lastSeenRun, seenCount };
}

function emptyAppMap(overrides: Partial<AppMap> = {}): AppMap {
  return {
    appVersion: overrides.appVersion ?? '1.0.0',
    generatedAt: overrides.generatedAt ?? '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    screens: overrides.screens ?? {},
    transitions: overrides.transitions ?? [],
  };
}

describe('buildFrontier', () => {
  it('returns 5 priority-100 entries for a new screen with 5 untapped elements, sorted by elementId', () => {
    const s = screen({
      'e-zebra': elem({ tapped: false }),
      'e-alpha': elem({ tapped: false }),
      'e-mango': elem({ tapped: false }),
      'e-delta': elem({ tapped: false }),
      'e-bravo': elem({ tapped: false }),
    });
    const appMap = emptyAppMap();
    const result = buildFrontier(s, appMap, { currentRunId: 'run-1' });
    expect(result).toHaveLength(5);
    expect(result.every((e) => e.priority === 100)).toBe(true);
    expect(result.map((e) => e.elementId)).toEqual([
      'e-alpha',
      'e-bravo',
      'e-delta',
      'e-mango',
      'e-zebra',
    ]);
    expect(result.every((e) => e.screenFp === 'fp-current')).toBe(true);
  });

  it('excludes tapped elements with no qualifier, keeps only the 2 untapped', () => {
    const s = screen(
      {
        'e-1': elem({ tapped: true, outcomes: [] }),
        'e-2': elem({ tapped: true, outcomes: [] }),
        'e-3': elem({ tapped: true, outcomes: [] }),
        'e-4': elem({ tapped: false }),
        'e-5': elem({ tapped: false }),
      },
      'fp-current',
    );
    // Map has the current screen marked as already seen THIS run so band-3 doesn't fire.
    const appMap = emptyAppMap({
      screens: {
        'fp-current': persisted(s, 'run-1', 'run-1'),
      },
    });
    const result = buildFrontier(s, appMap, { currentRunId: 'run-1' });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.elementId).sort()).toEqual(['e-4', 'e-5']);
    expect(result.every((e) => e.priority === 100)).toBe(true);
  });

  it('gives priority 80 to a tapped element whose outcome leads to a screen with untapped elements', () => {
    const homeScreen = screen(
      {
        'home-1': elem({ tapped: false }),
        'home-2': elem({ tapped: true }),
      },
      'fp-home',
      'HomeActivity',
    );
    const s = screen(
      {
        'e-go-home': elem({
          tapped: true,
          outcomes: [{ action: 'tap', ledToScreen: 'fp-home', count: 1 }],
        }),
      },
      'fp-current',
    );
    const appMap = emptyAppMap({
      screens: {
        'fp-current': persisted(s, 'run-1', 'run-1'),
        'fp-home': persisted(homeScreen, 'run-1', 'run-1'),
      },
    });
    const result = buildFrontier(s, appMap, { currentRunId: 'run-1' });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ screenFp: 'fp-current', elementId: 'e-go-home', priority: 80 });
  });

  it('gives priority 40 to broken elements when the screen was not seen in the current run, and excludes them when it was', () => {
    const s = screen(
      {
        'e-broken': elem({ tapped: true, marked: 'broken' }),
      },
      'fp-current',
    );
    const staleMap = emptyAppMap({
      screens: {
        'fp-current': persisted(s, 'run-0', 'run-0'),
      },
    });
    const resultStale = buildFrontier(s, staleMap, { currentRunId: 'run-1' });
    expect(resultStale).toHaveLength(1);
    expect(resultStale[0]).toEqual({
      screenFp: 'fp-current',
      elementId: 'e-broken',
      priority: 40,
    });

    const freshMap = emptyAppMap({
      screens: {
        'fp-current': persisted(s, 'run-0', 'run-1'),
      },
    });
    const resultFresh = buildFrontier(s, freshMap, { currentRunId: 'run-1' });
    expect(resultFresh).toHaveLength(0);
  });

  it('always excludes deny-listed elements, even if untapped', () => {
    const s = screen({
      'e-untapped': elem({ tapped: false }),
      'e-deny': elem({ tapped: false, marked: 'deny-listed' }),
    });
    const appMap = emptyAppMap();
    const result = buildFrontier(s, appMap, { currentRunId: 'run-1' });
    expect(result).toHaveLength(1);
    expect(result[0].elementId).toBe('e-untapped');
  });

  it('uses stable elementId ascending order as tiebreaker within the same priority band', () => {
    const s = screen({
      'e-zzz': elem({ tapped: false }),
      'e-aaa': elem({ tapped: false }),
      'e-mmm': elem({ tapped: false }),
    });
    const appMap = emptyAppMap();
    const result = buildFrontier(s, appMap, { currentRunId: 'run-1' });
    expect(result.map((e) => e.elementId)).toEqual(['e-aaa', 'e-mmm', 'e-zzz']);
  });
});
