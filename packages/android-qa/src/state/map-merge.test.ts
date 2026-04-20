import { describe, it, expect } from 'vitest';
import { mergeRunIntoMap } from './map-merge';
import type {
  Action,
  AppMap,
  Fingerprint,
  PersistedScreen,
  Screen,
  SessionState,
  ViewElement,
} from '../types/index';

function element(overrides: Partial<ViewElement> = {}): ViewElement {
  return {
    resourceId: overrides.resourceId ?? 'btn-default',
    role: overrides.role ?? 'button',
    text: overrides.text === undefined ? 'default' : overrides.text,
    firstSeen: overrides.firstSeen ?? '2026-01-01T00:00:00.000Z',
    lastSeen: overrides.lastSeen ?? '2026-01-01T00:00:00.000Z',
    tapped: overrides.tapped ?? false,
    outcomes: overrides.outcomes ?? [],
    marked: overrides.marked,
  };
}

function screen(
  fp: Fingerprint,
  activity: string,
  elements: Record<string, ViewElement>,
): Screen {
  return { fingerprint: fp, activity, elements };
}

function persistedScreen(
  fp: Fingerprint,
  activity: string,
  elements: Record<string, ViewElement>,
  extras: { firstSeenRun: string; lastSeenRun: string; seenCount: number },
): PersistedScreen {
  return { fingerprint: fp, activity, elements, ...extras };
}

function emptyMap(overrides: Partial<AppMap> = {}): AppMap {
  return {
    appVersion: overrides.appVersion ?? '1.0.0',
    generatedAt: overrides.generatedAt ?? '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    screens: overrides.screens ?? {},
    transitions: overrides.transitions ?? [],
    mergedRunIds: overrides.mergedRunIds ?? [],
  };
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    runId: overrides.runId ?? 'run-1',
    appVersion: overrides.appVersion ?? '1.0.0',
    role: overrides.role ?? 'driver',
    startedAt: overrides.startedAt ?? '2026-04-20T10:00:00.000Z',
    endedAt: overrides.endedAt,
    status: overrides.status,
    budget: overrides.budget ?? { wallClockMs: 0, turns: 0 },
    counters:
      overrides.counters ?? { crashCount: 0, noNewScreenStreak: 0, malformedJsonCount: 0 },
    screens: overrides.screens ?? {},
    frontier: overrides.frontier ?? [],
    findings: overrides.findings ?? [],
    history: overrides.history ?? [],
  };
}

describe('mergeRunIntoMap', () => {
  it('adds a new screen with firstSeenRun=runId, lastSeenRun=runId, seenCount=1', () => {
    const el = element({ resourceId: 'btn-login', text: 'Sign in' });
    const sess = session({
      runId: 'run-new',
      screens: { fp1: screen('fp1', 'Main', { 'btn-login': el }) },
    });
    const result = mergeRunIntoMap(emptyMap(), sess);

    expect(Object.keys(result.screens)).toEqual(['fp1']);
    const s = result.screens['fp1'];
    expect(s.firstSeenRun).toBe('run-new');
    expect(s.lastSeenRun).toBe('run-new');
    expect(s.seenCount).toBe(1);
    expect(s.activity).toBe('Main');
    expect(s.elements['btn-login']).toEqual(el);
  });

  it('existing screen: lastSeenRun updated, seenCount incremented, firstSeenRun preserved', () => {
    const existing = persistedScreen(
      'fp1',
      'OldActivity',
      { a: element({ resourceId: 'a' }) },
      { firstSeenRun: 'r-old', lastSeenRun: 'r-old', seenCount: 1 },
    );
    const map: AppMap = emptyMap({ screens: { fp1: existing } });
    const sess = session({
      runId: 'r-new',
      screens: { fp1: screen('fp1', 'NewActivity', { a: element({ resourceId: 'a' }) }) },
    });

    const result = mergeRunIntoMap(map, sess);
    const s = result.screens['fp1'];
    expect(s.firstSeenRun).toBe('r-old');
    expect(s.lastSeenRun).toBe('r-new');
    expect(s.seenCount).toBe(2);
    // activity refreshed from the session.
    expect(s.activity).toBe('NewActivity');
  });

  it('existing screen: new element added, old element preserved', () => {
    const existing = persistedScreen(
      'fp1',
      'Main',
      { a: element({ resourceId: 'a' }) },
      { firstSeenRun: 'r-old', lastSeenRun: 'r-old', seenCount: 1 },
    );
    const sess = session({
      runId: 'r-new',
      screens: {
        fp1: screen('fp1', 'Main', {
          a: element({ resourceId: 'a' }),
          b: element({ resourceId: 'b' }),
        }),
      },
    });

    const result = mergeRunIntoMap(emptyMap({ screens: { fp1: existing } }), sess);
    const s = result.screens['fp1'];
    expect(Object.keys(s.elements).sort()).toEqual(['a', 'b']);
    expect(s.elements['b'].resourceId).toBe('b');
  });

  it('existing element: tapped, outcomes, marked are merged', () => {
    const existingEl = element({
      resourceId: 'btn',
      tapped: false,
      outcomes: [{ action: 'tap', ledToScreen: null, count: 1 }],
    });
    const sessionEl = element({
      resourceId: 'btn',
      tapped: true,
      firstSeen: '2026-02-01T00:00:00.000Z',
      lastSeen: '2026-02-02T00:00:00.000Z',
      outcomes: [
        { action: 'tap', ledToScreen: 'fp-next', count: 2, note: 'leads to dialog' },
        { action: 'type', ledToScreen: null, count: 1 },
      ],
      marked: 'broken',
    });
    const existing = persistedScreen(
      'fp1',
      'Main',
      { btn: existingEl },
      { firstSeenRun: 'r-old', lastSeenRun: 'r-old', seenCount: 1 },
    );
    const sess = session({
      runId: 'r-new',
      screens: { fp1: screen('fp1', 'Main', { btn: sessionEl }) },
    });

    const result = mergeRunIntoMap(emptyMap({ screens: { fp1: existing } }), sess);
    const merged = result.screens['fp1'].elements['btn'];
    expect(merged.tapped).toBe(true);
    expect(merged.marked).toBe('broken');
    // The 'tap' outcome from the session's ledToScreen wins; counts sum to 3.
    const tap = merged.outcomes.find((o) => o.action === 'tap');
    expect(tap).toEqual({
      action: 'tap',
      ledToScreen: 'fp-next',
      count: 3,
      note: 'leads to dialog',
    });
    // The 'type' outcome is added fresh.
    const type = merged.outcomes.find((o) => o.action === 'type');
    expect(type).toEqual({ action: 'type', ledToScreen: null, count: 1 });
    // firstSeen keeps the earliest, lastSeen keeps the latest.
    expect(merged.firstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.lastSeen).toBe('2026-02-02T00:00:00.000Z');
  });

  it('refreshes role and text from the session while preserving resourceId', () => {
    const existingEl = element({
      resourceId: 'btn-x',
      role: 'button',
      text: 'Old Label',
    });
    const sessionEl = element({
      resourceId: 'btn-x',
      role: 'menuitem',
      text: 'New Label',
    });
    const existing = persistedScreen(
      'fp1',
      'Main',
      { 'btn-x': existingEl },
      { firstSeenRun: 'r-old', lastSeenRun: 'r-old', seenCount: 1 },
    );
    const sess = session({
      runId: 'r-new',
      screens: { fp1: screen('fp1', 'Main', { 'btn-x': sessionEl }) },
    });

    const result = mergeRunIntoMap(emptyMap({ screens: { fp1: existing } }), sess);
    const merged = result.screens['fp1'].elements['btn-x'];
    expect(merged.resourceId).toBe('btn-x');
    expect(merged.role).toBe('menuitem');
    expect(merged.text).toBe('New Label');
  });

  it('earliestIso and latestIso pick correctly regardless of which side is earlier/later', () => {
    const existingEl = element({
      resourceId: 'btn',
      firstSeen: '2026-03-01T00:00:00.000Z',
      lastSeen: '2026-04-01T00:00:00.000Z',
    });
    const sessionEl = element({
      resourceId: 'btn',
      firstSeen: '2026-01-15T00:00:00.000Z',
      lastSeen: '2026-03-15T00:00:00.000Z',
    });
    const existing = persistedScreen(
      'fp1',
      'Main',
      { btn: existingEl },
      { firstSeenRun: 'r-old', lastSeenRun: 'r-old', seenCount: 1 },
    );
    const sess = session({
      runId: 'r-new',
      screens: { fp1: screen('fp1', 'Main', { btn: sessionEl }) },
    });

    const result = mergeRunIntoMap(emptyMap({ screens: { fp1: existing } }), sess);
    const merged = result.screens['fp1'].elements['btn'];
    // Session's firstSeen is earlier -> session wins.
    expect(merged.firstSeen).toBe('2026-01-15T00:00:00.000Z');
    // Existing's lastSeen is later -> existing wins.
    expect(merged.lastSeen).toBe('2026-04-01T00:00:00.000Z');
  });

  it('transitions: new (from, via, to) added from history', () => {
    const action: Action = { kind: 'tap', elementId: 'btn-login' };
    const sess = session({
      runId: 'run-1',
      screens: {
        fpA: screen('fpA', 'Main', { 'btn-login': element({ resourceId: 'btn-login' }) }),
        fpB: screen('fpB', 'Home', {}),
      },
      history: [{ turn: 1, screenFp: 'fpA', action, outcomeFp: 'fpB', ms: 100 }],
    });

    const result = mergeRunIntoMap(emptyMap(), sess);
    expect(result.transitions).toEqual([
      { from: 'fpA', via: 'tap:btn-login', to: 'fpB', occurrences: 1 },
    ]);
  });

  it('transitions: existing (from, via, to) increments occurrences', () => {
    const map: AppMap = emptyMap({
      transitions: [{ from: 'fpA', via: 'tap:btn-login', to: 'fpB', occurrences: 3 }],
    });
    const action: Action = { kind: 'tap', elementId: 'btn-login' };
    const sess = session({
      runId: 'run-2',
      screens: {
        fpA: screen('fpA', 'Main', {}),
        fpB: screen('fpB', 'Home', {}),
      },
      history: [{ turn: 1, screenFp: 'fpA', action, outcomeFp: 'fpB', ms: 100 }],
    });

    const result = mergeRunIntoMap(map, sess);
    expect(result.transitions).toEqual([
      { from: 'fpA', via: 'tap:btn-login', to: 'fpB', occurrences: 4 },
    ]);
  });

  it('skips history entries where outcomeFp is null or equal to screenFp', () => {
    const sess = session({
      runId: 'run-skip',
      screens: { fpA: screen('fpA', 'Main', {}) },
      history: [
        { turn: 1, screenFp: 'fpA', action: { kind: 'back' }, outcomeFp: null, ms: 10 },
        {
          turn: 2,
          screenFp: 'fpA',
          action: { kind: 'tap', elementId: 'stuck-btn' },
          outcomeFp: 'fpA',
          ms: 10,
        },
      ],
    });

    const result = mergeRunIntoMap(emptyMap(), sess);
    expect(result.transitions).toEqual([]);
  });

  it('is idempotent: merging the same session twice produces the same map', () => {
    const el = element({ resourceId: 'btn' });
    const action: Action = { kind: 'tap', elementId: 'btn' };
    const sess = session({
      runId: 'run-idem',
      endedAt: '2026-04-20T11:00:00.000Z',
      screens: {
        fpA: screen('fpA', 'Main', { btn: el }),
        fpB: screen('fpB', 'Home', {}),
      },
      history: [{ turn: 1, screenFp: 'fpA', action, outcomeFp: 'fpB', ms: 50 }],
    });

    const once = mergeRunIntoMap(emptyMap(), sess);
    const twice = mergeRunIntoMap(once, sess);
    expect(twice).toEqual(once);
    // Assert the guard really kicked in — seenCount did NOT double.
    expect(twice.screens['fpA'].seenCount).toBe(1);
    expect(twice.transitions[0].occurrences).toBe(1);
    expect(twice.mergedRunIds).toEqual(['run-idem']);
  });

  it('is pure: inputs are not mutated', () => {
    const el = element({ resourceId: 'btn' });
    const action: Action = { kind: 'tap', elementId: 'btn' };
    const map = emptyMap({
      screens: {
        fpA: persistedScreen(
          'fpA',
          'Main',
          { btn: element({ resourceId: 'btn', tapped: false }) },
          { firstSeenRun: 'r0', lastSeenRun: 'r0', seenCount: 1 },
        ),
      },
      transitions: [{ from: 'fpA', via: 'tap:btn', to: 'fpB', occurrences: 1 }],
    });
    const sess = session({
      runId: 'run-pure',
      screens: {
        fpA: screen('fpA', 'Main', { btn: { ...el, tapped: true } }),
        fpB: screen('fpB', 'Home', {}),
      },
      history: [{ turn: 1, screenFp: 'fpA', action, outcomeFp: 'fpB', ms: 50 }],
    });

    const mapSnap = JSON.parse(JSON.stringify(map));
    const sessSnap = JSON.parse(JSON.stringify(sess));

    mergeRunIntoMap(map, sess);

    expect(map).toEqual(mapSnap);
    expect(sess).toEqual(sessSnap);
  });

  it('updates appVersion from the session', () => {
    const map = emptyMap({ appVersion: '1.0.0' });
    const sess = session({ runId: 'run-ver', appVersion: '2.0.0' });

    const result = mergeRunIntoMap(map, sess);
    expect(result.appVersion).toBe('2.0.0');
  });

  it('sets generatedAt from session.endedAt when present', () => {
    const sess = session({
      runId: 'run-ts',
      startedAt: '2026-04-20T10:00:00.000Z',
      endedAt: '2026-04-20T11:30:00.000Z',
    });
    const result = mergeRunIntoMap(emptyMap(), sess);
    expect(result.generatedAt).toBe('2026-04-20T11:30:00.000Z');
  });

  it('falls back to session.startedAt when endedAt is absent', () => {
    const sess = session({
      runId: 'run-ts-2',
      startedAt: '2026-04-20T09:00:00.000Z',
      endedAt: undefined,
    });
    const result = mergeRunIntoMap(emptyMap(), sess);
    expect(result.generatedAt).toBe('2026-04-20T09:00:00.000Z');
  });
});
