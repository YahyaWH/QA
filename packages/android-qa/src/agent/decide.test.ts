import { describe, it, expect, vi } from 'vitest';
import { decide } from './decide';
import type { ClaudeClient } from './claude';
import type { Action, Finding, Screen, SessionState, ViewElement } from '../types/index';
import type { FrontierEntry } from './frontier';

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

function screen(elements: Record<string, ViewElement>, fp = 'fp-current', activity = 'MainActivity'): Screen {
  return { fingerprint: fp, activity, elements };
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  const current = overrides.screens?.['fp-current']
    ?? screen({
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
    counters: overrides.counters ?? { crashCount: 0, noNewScreenStreak: 0, malformedJsonCount: 0 },
    screens: overrides.screens ?? { 'fp-current': current },
    frontier: overrides.frontier ?? [],
    findings: overrides.findings ?? [],
    history: overrides.history ?? [],
  };
}

function fakeClaude(value: unknown): {
  client: ClaudeClient;
  calls: Array<Parameters<ClaudeClient['callJson']>[0]>;
} {
  const calls: Array<Parameters<ClaudeClient['callJson']>[0]> = [];
  const callJson = vi.fn(async (params: Parameters<ClaudeClient['callJson']>[0]) => {
    calls.push(params);
    return value;
  });
  const client = { callJson } as unknown as ClaudeClient;
  return { client, calls };
}

describe('decide', () => {
  it('returns a valid tap action when Claude responds with one', async () => {
    const state = baseState({
      screens: {
        'fp-current': screen({
          'btn-a': elem(),
          'btn-b': elem(),
        }),
      },
    });
    const frontier: FrontierEntry[] = [
      { screenFp: 'fp-current', elementId: 'btn-a', priority: 100 },
      { screenFp: 'fp-current', elementId: 'btn-b', priority: 100 },
    ];
    const { client, calls } = fakeClaude({
      action: { kind: 'tap', elementId: 'btn-a' },
      reasoning: 'tap the first button',
    });

    const result = await decide(
      { state, frontier, denyActions: [], triagedFindings: [] },
      { model: 'claude-opus-4-7' },
      client,
    );

    expect(result.action).toEqual({ kind: 'tap', elementId: 'btn-a' });
    expect(result.reasoning).toBe('tap the first button');
    expect(calls.length).toBe(1);
    expect(calls[0].cacheControl).toBe(true);
    expect(typeof calls[0].system).toBe('string');
    expect(calls[0].messages).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe('user');
  });

  it('falls back to the highest-priority frontier entry when schema validation fails', async () => {
    const state = baseState();
    const frontier: FrontierEntry[] = [
      { screenFp: 'fp-current', elementId: 'btn-a', priority: 100 },
      { screenFp: 'fp-current', elementId: 'btn-b', priority: 80 },
    ];
    const { client } = fakeClaude({ action: { kind: 'bogus', whatever: true }, reasoning: 'x' });

    const result = await decide(
      { state, frontier, denyActions: [], triagedFindings: [] },
      { model: 'claude-opus-4-7' },
      client,
    );

    expect(result.action).toEqual({ kind: 'tap', elementId: 'btn-a' });
    expect(result.reasoning).toBe('fallback: schema validation failed');
  });

  it('enforces the deny list by falling back when Claude picks a denied action', async () => {
    const state = baseState({
      screens: {
        'fp-current': screen({
          'settings-btn': elem({ role: 'button', text: 'Settings' }),
          'home-btn': elem({ role: 'button', text: 'Home' }),
        }),
      },
    });
    const frontier: FrontierEntry[] = [
      { screenFp: 'fp-current', elementId: 'home-btn', priority: 100 },
      { screenFp: 'fp-current', elementId: 'settings-btn', priority: 100 },
    ];
    const { client } = fakeClaude({
      action: { kind: 'tap', elementId: 'settings-btn' },
      reasoning: 'open settings',
    });

    const result = await decide(
      { state, frontier, denyActions: ['tap:settings-btn'], triagedFindings: [] },
      { model: 'claude-opus-4-7' },
      client,
    );

    expect(result.action).toEqual({ kind: 'tap', elementId: 'home-btn' });
    expect(result.reasoning).toMatch(/fallback:/);
  });

  it('avoids repeating a no-progress action from recent history', async () => {
    const lastAction: Action = { kind: 'tap', elementId: 'foo' };
    const state = baseState({
      screens: {
        'fp-current': screen({
          foo: elem(),
          bar: elem(),
        }, 'A'),
      },
      history: [
        { turn: 1, screenFp: 'A', action: lastAction, outcomeFp: 'A', ms: 100 },
      ],
    });
    const frontier: FrontierEntry[] = [
      { screenFp: 'A', elementId: 'bar', priority: 100 },
      { screenFp: 'A', elementId: 'foo', priority: 100 },
    ];
    const { client } = fakeClaude({
      action: { kind: 'tap', elementId: 'foo' },
      reasoning: 'tap foo again',
    });

    const result = await decide(
      { state, frontier, denyActions: [], triagedFindings: [] },
      { model: 'claude-opus-4-7' },
      client,
    );

    expect(result.action).toEqual({ kind: 'tap', elementId: 'bar' });
    expect(result.reasoning).toMatch(/fallback:/);
  });

  it('returns {kind:"back"} when frontier is empty and Claude returns garbage', async () => {
    const state = baseState();
    const { client } = fakeClaude({ something: 'not a valid response' });

    const result = await decide(
      { state, frontier: [], denyActions: [], triagedFindings: [] },
      { model: 'claude-opus-4-7' },
      client,
    );

    expect(result.action).toEqual({ kind: 'back' });
    expect(result.reasoning).toBe('fallback: empty frontier');
  });

  it('passes a valid done action through unchanged', async () => {
    const state = baseState();
    const frontier: FrontierEntry[] = [
      { screenFp: 'fp-current', elementId: 'btn-a', priority: 100 },
    ];
    const { client } = fakeClaude({
      action: { kind: 'done', reason: 'explored everything' },
      reasoning: 'nothing useful left to probe',
    });

    const result = await decide(
      { state, frontier, denyActions: [], triagedFindings: [] },
      { model: 'claude-opus-4-7' },
      client,
    );

    expect(result.action).toEqual({ kind: 'done', reason: 'explored everything' });
    expect(result.reasoning).toBe('nothing useful left to probe');
  });
});
