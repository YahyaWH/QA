import { describe, it, expect, vi } from 'vitest';
import { evaluate, type EvaluateConfig, type EvaluateContext } from './evaluate';
import { ClaudeClient, MalformedJsonError } from './claude';
import type {
  Action,
  Fingerprint,
  Screen,
  SessionState,
  ViewElement,
  ViewNode,
} from '../types/index';

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

function screen(
  elements: Record<string, ViewElement>,
  fp: Fingerprint = 'fp-current',
  activity = 'MainActivity',
): Screen {
  return { fingerprint: fp, activity, elements };
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  const current =
    overrides.screens?.['fp-current'] ??
    screen({
      'btn-a': elem({ role: 'button', text: 'A' }),
      'btn-b': elem({ role: 'button', text: 'B' }),
    });
  return {
    runId: overrides.runId ?? 'run-1',
    appVersion: overrides.appVersion ?? '1.0.0',
    role: overrides.role ?? 'admin',
    startedAt: overrides.startedAt ?? '2026-01-01T00:00:00.000Z',
    endedAt: overrides.endedAt,
    status: overrides.status,
    budget: overrides.budget ?? { wallClockMs: 60_000, turns: 50 },
    counters:
      overrides.counters ?? { crashCount: 0, noNewScreenStreak: 0, malformedJsonCount: 0 },
    screens: overrides.screens ?? { 'fp-current': current },
    frontier: overrides.frontier ?? [],
    findings: overrides.findings ?? [],
    history: overrides.history ?? [],
  };
}

/**
 * Build a minimal `SessionState.history` slice of length `n`, enough to satisfy
 * the modulo-N vision trigger without exercising fingerprint bookkeeping.
 */
function historyOfLength(
  n: number,
  fp: Fingerprint = 'fp-current',
): SessionState['history'] {
  const action: Action = { kind: 'back' };
  const out: SessionState['history'] = [];
  for (let i = 0; i < n; i++) {
    out.push({ turn: i + 1, screenFp: fp, action, outcomeFp: fp, ms: 10 });
  }
  return out;
}

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

function baseCtx(overrides: Partial<EvaluateContext> = {}): EvaluateContext {
  return {
    currentScreenFp: overrides.currentScreenFp ?? 'fp-current',
    currentTree: overrides.currentTree ?? null,
    logcatDelta: overrides.logcatDelta ?? [],
    isNewScreen: overrides.isNewScreen ?? false,
    treeSuspicious: overrides.treeSuspicious ?? false,
    screenshotBase64: overrides.screenshotBase64 ?? null,
    imageMediaType: overrides.imageMediaType ?? 'image/png',
  };
}

const cfg: EvaluateConfig = { model: 'claude-opus-4-7', visionEveryNTurns: 10 };

type VisionParams = Parameters<ClaudeClient['callJsonWithImage']>[0];

function fakeClaude(impl: (params: VisionParams) => Promise<unknown>): {
  client: ClaudeClient;
  calls: VisionParams[];
  fn: ReturnType<typeof vi.fn>;
} {
  const calls: VisionParams[] = [];
  const fn = vi.fn(async (params: VisionParams) => {
    calls.push(params);
    return impl(params);
  });
  const client = { callJsonWithImage: fn } as unknown as ClaudeClient;
  return { client, calls, fn };
}

describe('evaluate', () => {
  it('returns a canned vision finding shaped correctly when vision is triggered', async () => {
    const state = baseState({ runId: 'run-xyz' });
    const ctx = baseCtx({
      currentScreenFp: 'fp-home',
      isNewScreen: true,
      screenshotBase64: 'ZmFrZS1wbmc=',
      imageMediaType: 'image/png',
    });
    const { client, calls } = fakeClaude(async () => ({
      findings: [
        {
          category: 'C',
          severity: 'med',
          summary: 'unlabeled icon',
          element: 'fab-btn',
          reasoning: 'icon has no contentDescription or visible label',
        },
      ],
    }));

    const result = await evaluate(state, ctx, cfg, client);

    expect(calls.length).toBe(1);
    expect(calls[0].cacheControl).toBe(true);
    expect(typeof calls[0].system).toBe('string');
    expect(calls[0].imageBase64).toBe('ZmFrZS1wbmc=');
    expect(calls[0].imageMediaType).toBe('image/png');
    expect(result).toHaveLength(1);
    const f = result[0];
    expect(f.runId).toBe('run-xyz');
    expect(f.screenFp).toBe('fp-home');
    expect(f.element).toBe('fab-btn');
    expect(f.category).toBe('C');
    expect(f.severity).toBe('med');
    expect(f.summary).toBe('unlabeled icon');
    expect(f.status).toBe('new');
    expect(typeof f.id).toBe('string');
    expect(f.id).toMatch(/^[0-9a-f]{16}$/);
    expect(f.reasoning).toBe('icon has no contentDescription or visible label');
  });

  it('detects FATAL EXCEPTION in logcat without calling vision', async () => {
    const state = baseState({ history: historyOfLength(5) });
    const ctx = baseCtx({
      currentScreenFp: 'fp-current',
      logcatDelta: [
        '01-02 03:04:05.678  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main',
        'some other line',
      ],
      isNewScreen: false,
      treeSuspicious: false,
    });
    const { client, fn } = fakeClaude(async () => {
      throw new Error('vision must not be called');
    });

    const result = await evaluate(state, ctx, cfg, client);

    expect(fn).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('A');
    expect(result[0].severity).toBe('critical');
    expect(result[0].element).toBeNull();
    expect(result[0].summary).toMatch(/FATAL EXCEPTION/);
    expect(result[0].reasoning).toMatch(/FATAL EXCEPTION/);
  });

  it('fires vision when treeSuspicious is true even off the modulo cadence', async () => {
    const state = baseState({ history: historyOfLength(3) });
    const ctx = baseCtx({
      isNewScreen: false,
      treeSuspicious: true,
      screenshotBase64: 'YmFzZTY0',
      imageMediaType: 'image/jpeg',
    });
    const { client, fn } = fakeClaude(async () => ({
      findings: [
        {
          category: 'C',
          severity: 'low',
          summary: 'confusing copy',
          element: null,
          reasoning: 'wording is ambiguous about what action will happen',
        },
      ],
    }));

    const result = await evaluate(state, ctx, cfg, client);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('C');
    expect(result[0].element).toBeNull();
  });

  it('fires vision exactly once when history length hits the modulo-N cadence', async () => {
    const state = baseState({ history: historyOfLength(10) });
    const ctx = baseCtx({
      isNewScreen: false,
      treeSuspicious: false,
      screenshotBase64: 'YWJj',
      imageMediaType: 'image/png',
    });
    const { client, fn } = fakeClaude(async () => ({ findings: [] }));

    const result = await evaluate(state, ctx, cfg, client);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it('skips vision when triggered but screenshot is absent', async () => {
    const state = baseState();
    const ctx = baseCtx({ isNewScreen: true, screenshotBase64: null });
    const { client, fn } = fakeClaude(async () => {
      throw new Error('vision must not be called when screenshot is null');
    });

    const result = await evaluate(state, ctx, cfg, client);

    expect(fn).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('dedupes a duplicate (screenFp, element, category) tuple from logcat and vision', async () => {
    const state = baseState({ history: historyOfLength(0) });
    const ctx = baseCtx({
      currentScreenFp: 'fp-crash',
      logcatDelta: [
        '01-02 03:04:05.678  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main',
      ],
      isNewScreen: true,
      screenshotBase64: 'cG5n',
      imageMediaType: 'image/png',
    });
    const { client, fn } = fakeClaude(async () => ({
      findings: [
        {
          category: 'A',
          severity: 'critical',
          summary: 'app crashed',
          element: null,
          reasoning: 'full-screen crash dialog with stack trace visible',
        },
      ],
    }));

    const result = await evaluate(state, ctx, cfg, client);

    // Vision was actually invoked — a regression where it got skipped would
    // produce the same single-finding result but without exercising dedup.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    // First occurrence (logcat) wins over the duplicate vision entry.
    expect(result[0].reasoning).toMatch(/logcat:/);
    expect(result[0].category).toBe('A');
    expect(result[0].element).toBeNull();
  });

  it('produces identical Finding ids on re-run with identical inputs', async () => {
    const makeCtx = (): EvaluateContext =>
      baseCtx({
        currentScreenFp: 'fp-crash',
        logcatDelta: [
          '01-02 03:04:05.678  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main',
        ],
        isNewScreen: true,
        screenshotBase64: 'cG5n',
        imageMediaType: 'image/png',
      });
    const mkClient = () =>
      fakeClaude(async () => ({
        findings: [
          {
            category: 'C',
            severity: 'med',
            summary: 'unlabeled fab',
            element: 'fab-btn',
            reasoning: 'no accessible label on the floating action button',
          },
        ],
      })).client;

    const first = await evaluate(baseState({ runId: 'run-1' }), makeCtx(), cfg, mkClient());
    const second = await evaluate(baseState({ runId: 'run-1' }), makeCtx(), cfg, mkClient());

    expect(first.length).toBeGreaterThan(0);
    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id));
    for (const f of first) {
      expect(f.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('does not throw when the vision response fails schema validation', async () => {
    const state = baseState();
    const ctx = baseCtx({
      isNewScreen: true,
      screenshotBase64: 'cG5n',
      imageMediaType: 'image/png',
      currentTree: node({
        resourceId: 'banner',
        text: 'Something went wrong',
        visible: true,
      }),
    });
    const { client, fn } = fakeClaude(async () => ({ wrong: 'shape' }));

    const result = await evaluate(state, ctx, cfg, client);

    expect(fn).toHaveBeenCalledTimes(1);
    // Deterministic tree-scan finding still returned.
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('A');
    expect(result[0].element).toBe('banner');
    expect(result[0].reasoning).toMatch(/tree:/);
  });

  it('does not throw when the vision call raises MalformedJsonError', async () => {
    const state = baseState();
    const ctx = baseCtx({
      isNewScreen: true,
      screenshotBase64: 'cG5n',
      imageMediaType: 'image/png',
    });
    const { client, fn } = fakeClaude(async () => {
      throw new MalformedJsonError('bad json', '{nope');
    });

    const result = await evaluate(state, ctx, cfg, client);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });
});
