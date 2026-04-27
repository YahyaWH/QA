import { describe, it, expect } from 'vitest';
import {
  evaluate,
  scanLogcat,
  scanTree,
  scanBoundsOverflow,
  scanUnlabeledClickables,
  scanDeadButtons,
  scanFrozenUI,
  makeFindingId,
} from './evaluate';
import type {
  Action,
  Fingerprint,
  Screen,
  SessionState,
  ViewElement,
  ViewNode,
} from '../types/index';

function node(overrides: Partial<ViewNode> = {}): ViewNode {
  return {
    resourceId: overrides.resourceId ?? null,
    className: overrides.className ?? 'android.view.View',
    text: overrides.text ?? null,
    contentDesc: overrides.contentDesc ?? null,
    bounds: overrides.bounds ?? { x: 0, y: 0, w: 100, h: 100 },
    clickable: overrides.clickable ?? false,
    enabled: overrides.enabled ?? true,
    visible: overrides.visible ?? true,
    children: overrides.children ?? [],
  };
}

function elem(overrides: Partial<ViewElement> = {}): ViewElement {
  return {
    resourceId: overrides.resourceId ?? 'btn',
    role: overrides.role ?? 'android.widget.Button',
    text: overrides.text ?? null,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z',
    tapped: overrides.tapped ?? false,
    outcomes: overrides.outcomes ?? [],
    marked: overrides.marked,
  };
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    runId: overrides.runId ?? 'run-1',
    appVersion: '1.0.0',
    role: 'admin',
    startedAt: '2026-01-01T00:00:00.000Z',
    budget: { wallClockMs: 60000, turns: 50 },
    counters: { crashCount: 0, noNewScreenStreak: 0, malformedJsonCount: 0 },
    screens: overrides.screens ?? {},
    frontier: [],
    findings: [],
    history: overrides.history ?? [],
  };
}

describe('makeFindingId', () => {
  it('produces a stable 16-hex prefix', () => {
    const id1 = makeFindingId('run-x', 'fp-y', 'btn', 'A', 'crash');
    const id2 = makeFindingId('run-x', 'fp-y', 'btn', 'A', 'crash');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('scanLogcat extended patterns', () => {
  it('flags FATAL EXCEPTION as A/critical', () => {
    const out = scanLogcat(['... E AndroidRuntime: FATAL EXCEPTION: main']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'A', severity: 'critical' });
  });

  it('flags ANR as A/high', () => {
    const out = scanLogcat(['... E ActivityManager: ANR in com.wastehero (...)']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'A', severity: 'high' });
  });

  it('flags OutOfMemoryError as A/critical', () => {
    const out = scanLogcat(['java.lang.OutOfMemoryError: Failed to allocate']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'A', severity: 'critical' });
  });

  it('flags Skipped frames ≥30 as D, escalating to med at ≥100', () => {
    const out = scanLogcat([
      'I Choreographer: Skipped 45 frames!  The application may be doing too much work on its main thread.',
      'I Choreographer: Skipped 200 frames!',
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ category: 'D', severity: 'low' });
    expect(out[1]).toMatchObject({ category: 'D', severity: 'med' });
  });

  it('does NOT flag Skipped frames below 30', () => {
    const out = scanLogcat(['I Choreographer: Skipped 12 frames!']);
    expect(out).toEqual([]);
  });

  it('flags StrictMode policy violations as D/low', () => {
    const out = scanLogcat(['D StrictMode: StrictMode policy violation; ~duration=412ms']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'D', severity: 'low' });
  });

  it('flags HTTP 5xx with explicit HTTP context as B/med', () => {
    const ok1 = scanLogcat(['W OkHttp: 503 https://api.example.com/v1/routes']);
    expect(ok1).toHaveLength(1);
    expect(ok1[0].summary).toContain('503');
    expect(ok1[0].summary).toContain('https://api.example.com/v1/routes');

    const ok2 = scanLogcat(['HTTP/1.1 502 Bad Gateway']);
    expect(ok2).toHaveLength(1);
    expect(ok2[0].summary).toContain('502');

    const ok3 = scanLogcat(['Got 503 Service Unavailable from upstream']);
    expect(ok3).toHaveLength(1);
    expect(ok3[0].summary).toContain('503');
  });

  it('does NOT flag PID columns or process IDs that happen to be 5xx', () => {
    const fp1 = scanLogcat([
      '04-27 11:49:05.438   538   568 I CredManSysServiceImpl: ConstructedFor: com.google.android.gms/.auth.api',
    ]);
    expect(fp1).toEqual([]);
    const fp2 = scanLogcat([
      'W ProcessStats: Tracking association com.google.android.gms.persistent/10128 BTop #3229',
    ]);
    expect(fp2).toEqual([]);
    const fp3 = scanLogcat([
      'I ActivityManager: Start proc 521:com.example.app for service ...',
    ]);
    expect(fp3).toEqual([]);
  });
});

describe('scanTree (error banners)', () => {
  it('flags "Something went wrong" as A/med', () => {
    const tree = node({ resourceId: 'banner', text: 'Something went wrong', visible: true });
    const out = scanTree(tree);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'A', severity: 'med', element: 'banner' });
  });

  it('flags generic "error" mention as B/med', () => {
    const tree = node({ resourceId: 'msg', text: 'Network error occurred', visible: true });
    const out = scanTree(tree);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('B');
  });
});

describe('scanBoundsOverflow', () => {
  const win = { width: 1080, height: 2400 };

  it('flags an element extending past the right edge', () => {
    const tree = node({
      resourceId: 'wide-text',
      text: 'lorem ipsum dolor sit amet',
      bounds: { x: 800, y: 200, w: 400, h: 60 }, // right=1200 > 1080
      visible: true,
    });
    const out = scanBoundsOverflow(tree, win);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'B', severity: 'med', element: 'wide-text' });
    expect(out[0].summary).toMatch(/right/);
  });

  it('does NOT flag framework wrappers spanning the full screen', () => {
    const tree = node({
      resourceId: 'android:id/content',
      bounds: { x: 0, y: 0, w: 1080, h: 2400 },
      visible: true,
    });
    const out = scanBoundsOverflow(tree, win);
    expect(out).toEqual([]);
  });

  it('does NOT flag overflow on invisible elements', () => {
    const tree = node({
      resourceId: 'hidden',
      text: 'x',
      bounds: { x: 0, y: 0, w: 2000, h: 100 },
      visible: false,
    });
    const out = scanBoundsOverflow(tree, win);
    expect(out).toEqual([]);
  });

  it('respects 4px slack for sub-pixel rendering', () => {
    const tree = node({
      resourceId: 'edge',
      text: 'x',
      bounds: { x: 0, y: 0, w: 1083, h: 100 }, // 3px past, within slack
      visible: true,
    });
    const out = scanBoundsOverflow(tree, win);
    expect(out).toEqual([]);
  });
});

describe('scanUnlabeledClickables', () => {
  it('flags clickable+enabled+visible element with no text/contentDesc', () => {
    const tree = node({
      resourceId: 'fab-btn',
      className: 'android.widget.ImageButton',
      clickable: true,
      enabled: true,
      visible: true,
    });
    const out = scanUnlabeledClickables(tree);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'C', severity: 'low', element: 'fab-btn' });
  });

  it('does NOT flag if contentDesc is set', () => {
    const tree = node({
      resourceId: 'fab-btn',
      className: 'android.widget.ImageButton',
      clickable: true,
      enabled: true,
      visible: true,
      contentDesc: 'Add new item',
    });
    expect(scanUnlabeledClickables(tree)).toEqual([]);
  });

  it('does NOT flag container classes (ScrollView, FrameLayout, etc.)', () => {
    const tree = node({
      resourceId: 'list',
      className: 'android.widget.ScrollView',
      clickable: true,
      enabled: true,
      visible: true,
    });
    expect(scanUnlabeledClickables(tree)).toEqual([]);
  });

  it('does NOT flag disabled clickables', () => {
    const tree = node({
      resourceId: 'btn',
      className: 'android.widget.Button',
      clickable: true,
      enabled: false,
      visible: true,
    });
    expect(scanUnlabeledClickables(tree)).toEqual([]);
  });
});

describe('scanDeadButtons', () => {
  const fp: Fingerprint = 'aaaa';

  it('flags element tapped ≥5 times with all outcomes self-looping', () => {
    const screen: Screen = {
      fingerprint: fp,
      activity: '.MainActivity',
      elements: {
        'dead-btn': elem({
          resourceId: 'dead-btn',
          tapped: true,
          outcomes: [{ action: 'tap', ledToScreen: fp, count: 7 }],
        }),
      },
    };
    const out = scanDeadButtons(baseState({ screens: { [fp]: screen } }), fp);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'B', severity: 'med', element: 'dead-btn' });
  });

  it('does NOT flag with fewer than 5 taps', () => {
    const screen: Screen = {
      fingerprint: fp,
      activity: '.MainActivity',
      elements: {
        'btn': elem({
          resourceId: 'btn',
          tapped: true,
          outcomes: [{ action: 'tap', ledToScreen: fp, count: 3 }],
        }),
      },
    };
    expect(scanDeadButtons(baseState({ screens: { [fp]: screen } }), fp)).toEqual([]);
  });

  it('does NOT flag if any outcome led to a different screen', () => {
    const screen: Screen = {
      fingerprint: fp,
      activity: '.MainActivity',
      elements: {
        'btn': elem({
          resourceId: 'btn',
          tapped: true,
          outcomes: [
            { action: 'tap', ledToScreen: fp, count: 6 },
            { action: 'tap', ledToScreen: 'bbbb', count: 1 },
          ],
        }),
      },
    };
    expect(scanDeadButtons(baseState({ screens: { [fp]: screen } }), fp)).toEqual([]);
  });

  it('does NOT flag framework wrapper resourceIds', () => {
    const screen: Screen = {
      fingerprint: fp,
      activity: '.MainActivity',
      elements: {
        'android:id/content': elem({
          resourceId: 'android:id/content',
          tapped: true,
          outcomes: [{ action: 'tap', ledToScreen: fp, count: 99 }],
        }),
      },
    };
    expect(scanDeadButtons(baseState({ screens: { [fp]: screen } }), fp)).toEqual([]);
  });
});

describe('scanFrozenUI', () => {
  const fp: Fingerprint = 'aaaa';
  const tap: Action = { kind: 'tap', elementId: 'x' };

  it('flags 5 consecutive turns on same fp with no progress', () => {
    const history = Array.from({ length: 5 }, (_, i) => ({
      turn: i + 1,
      screenFp: fp,
      action: tap,
      outcomeFp: fp,
      ms: 100,
    }));
    const out = scanFrozenUI(baseState({ history }), fp);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: 'B', severity: 'high' });
  });

  it('does NOT flag if any recent turn produced a different fp', () => {
    const history = [
      { turn: 1, screenFp: fp, action: tap, outcomeFp: fp, ms: 100 },
      { turn: 2, screenFp: fp, action: tap, outcomeFp: fp, ms: 100 },
      { turn: 3, screenFp: fp, action: tap, outcomeFp: 'bbbb', ms: 100 },
      { turn: 4, screenFp: fp, action: tap, outcomeFp: fp, ms: 100 },
      { turn: 5, screenFp: fp, action: tap, outcomeFp: fp, ms: 100 },
    ];
    expect(scanFrozenUI(baseState({ history }), fp)).toEqual([]);
  });

  it('does NOT fire with fewer than 5 turns', () => {
    const history = [
      { turn: 1, screenFp: fp, action: tap, outcomeFp: fp, ms: 100 },
    ];
    expect(scanFrozenUI(baseState({ history }), fp)).toEqual([]);
  });
});

describe('evaluate (integration)', () => {
  it('runs all scans and dedups by tuple', () => {
    const fp: Fingerprint = 'fp-x';
    const tree = node({
      resourceId: 'banner',
      text: 'Something went wrong',
      visible: true,
    });
    const findings = evaluate(baseState({ runId: 'r1' }), {
      currentScreenFp: fp,
      currentTree: tree,
      logcatDelta: ['... FATAL EXCEPTION: main'],
      windowSize: { width: 1080, height: 2400 },
    });
    // FATAL EXCEPTION (cat A, element=null) + tree banner (cat A, element=banner)
    // — both A but different elements, so both kept.
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const cats = findings.map((f) => f.category);
    expect(cats).toContain('A');
  });

  it('skips bounds-overflow scan when windowSize is null', () => {
    const tree = node({
      resourceId: 'wide',
      text: 'x',
      bounds: { x: 0, y: 0, w: 9999, h: 60 },
      visible: true,
    });
    const findings = evaluate(baseState(), {
      currentScreenFp: 'fp-x',
      currentTree: tree,
      logcatDelta: [],
      windowSize: null,
    });
    expect(findings.find((f) => f.summary.includes('past'))).toBeUndefined();
  });
});
