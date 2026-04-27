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

  it('excludes tapped-no-qualifier elements on a screen freshly discovered this run (absent from appMap)', () => {
    // Regression for the "491 taps on android:id/content" loop: first-run
    // discovery of a screen meant `appMap.screens[fp]` was undefined, which
    // the old heuristic classified as stale → every tapped element reappeared
    // at priority 60 and the fallback kept picking the same alphabetically-
    // first element. A freshly-discovered screen must behave like one that's
    // already been registered under the current runId.
    const s = screen(
      {
        'e-content': elem({ tapped: true, outcomes: [{ action: 'tap', ledToScreen: 'fp-current', count: 1 }] }),
        'e-button': elem({ tapped: true, outcomes: [{ action: 'tap', ledToScreen: 'fp-current', count: 1 }] }),
      },
      'fp-current',
    );
    const emptyMap = emptyAppMap();
    const result = buildFrontier(s, emptyMap, { currentRunId: 'run-1' });
    expect(result).toHaveLength(0);
  });

  it('excludes a self-looping tapped element once the session view shows the target fully tapped', () => {
    // Regression for the run-3 loop: `android:id/content` self-loops. The stale appMap
    // still has the target screen at 2/7 tapped, so without `sessionScreens` the element
    // kept reporting band-2 forever. With the live-session view (7/7 tapped), band-2 must
    // drop and the element falls through to band-3 skip (screenSeenThisRun via session) → null.
    const s = screen(
      {
        'android:id/content': elem({
          tapped: true,
          outcomes: [{ action: 'tap', ledToScreen: 'fp-current', count: 10 }],
        }),
      },
      'fp-current',
    );
    const staleMap = emptyAppMap({
      screens: {
        // Prior-run snapshot: 5 untapped elements would otherwise trigger band-2.
        'fp-current': persisted(
          screen(
            {
              'android:id/content': elem({ tapped: true }),
              'other-1': elem({ tapped: false }),
              'other-2': elem({ tapped: false }),
              'other-3': elem({ tapped: false }),
              'other-4': elem({ tapped: false }),
              'other-5': elem({ tapped: false }),
            },
            'fp-current',
          ),
          'run-0',
          'run-0',
        ),
      },
    });
    // Live session: we've tapped every element on this screen this run.
    const freshSession: Record<string, Screen> = {
      'fp-current': screen(
        {
          'android:id/content': elem({ tapped: true }),
          'other-1': elem({ tapped: true }),
          'other-2': elem({ tapped: true }),
          'other-3': elem({ tapped: true }),
          'other-4': elem({ tapped: true }),
          'other-5': elem({ tapped: true }),
        },
        'fp-current',
      ),
    };
    const result = buildFrontier(s, staleMap, {
      currentRunId: 'run-1',
      sessionScreens: freshSession,
    });
    expect(result).toHaveLength(0);
  });

  it('prefers session state over appMap when judging whether an outcome target has untapped work', () => {
    // Inverse: the stale appMap shows target fully tapped, but the session just discovered a
    // new screen at that fingerprint with untapped elements. Band-2 should fire off the session.
    const s = screen(
      {
        'e-go-elsewhere': elem({
          tapped: true,
          outcomes: [{ action: 'tap', ledToScreen: 'fp-target', count: 1 }],
        }),
      },
      'fp-current',
    );
    const staleMap = emptyAppMap({
      screens: {
        'fp-current': persisted(s, 'run-0', 'run-0'),
        'fp-target': persisted(
          screen({ 't-1': elem({ tapped: true }) }, 'fp-target'),
          'run-0',
          'run-0',
        ),
      },
    });
    const freshSession: Record<string, Screen> = {
      'fp-current': s,
      'fp-target': screen({ 't-1': elem({ tapped: false }) }, 'fp-target'),
    };
    const result = buildFrontier(s, staleMap, {
      currentRunId: 'run-1',
      sessionScreens: freshSession,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ screenFp: 'fp-current', elementId: 'e-go-elsewhere', priority: 80 });
  });

  it('treats a screen in sessionScreens as seen-this-run even when appMap says otherwise', () => {
    // Broken element on a screen the appMap last saw in run-0. Without sessionScreens, band-4
    // fires at priority 40. With sessionScreens including the current fp, screenSeenThisRun
    // becomes true → band-4 excludes the broken element.
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
    const withoutSession = buildFrontier(s, staleMap, { currentRunId: 'run-1' });
    expect(withoutSession).toHaveLength(1);
    expect(withoutSession[0].priority).toBe(40);

    const withSession = buildFrontier(s, staleMap, {
      currentRunId: 'run-1',
      sessionScreens: { 'fp-current': s },
    });
    expect(withSession).toHaveLength(0);
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
