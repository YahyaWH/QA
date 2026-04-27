import { describe, it, expect } from 'vitest';
import { detectRepeat, detectWander, detectCycle } from './anti-loop';
import type { Action, Fingerprint, SessionState } from '../types/index';

type HistoryEntry = SessionState['history'][number];

function h(
  turn: number,
  screenFp: Fingerprint,
  action: Action,
  outcomeFp: Fingerprint | null,
  ms = 100,
): HistoryEntry {
  return { turn, screenFp, action, outcomeFp, ms };
}

describe('detectRepeat', () => {
  it('is true when the same tap action repeats 3 times with null outcomeFp (no progress)', () => {
    const history: HistoryEntry[] = [
      h(1, 'fp-a', { kind: 'tap', elementId: 'btn' }, null),
      h(2, 'fp-a', { kind: 'tap', elementId: 'btn' }, null),
      h(3, 'fp-a', { kind: 'tap', elementId: 'btn' }, null),
    ];
    expect(detectRepeat(history)).toBe(true);
  });

  it('is false when only 2 of the last 3 turns share the same action', () => {
    const history: HistoryEntry[] = [
      h(1, 'fp-a', { kind: 'tap', elementId: 'btn' }, null),
      h(2, 'fp-a', { kind: 'tap', elementId: 'btn' }, null),
      h(3, 'fp-a', { kind: 'tap', elementId: 'other' }, null),
    ];
    expect(detectRepeat(history)).toBe(false);
  });

  it('is false when the same action repeats but the last turn produced a real fingerprint change', () => {
    const history: HistoryEntry[] = [
      h(1, 'fp-a', { kind: 'tap', elementId: 'btn' }, null),
      h(2, 'fp-a', { kind: 'tap', elementId: 'btn' }, null),
      h(3, 'fp-a', { kind: 'tap', elementId: 'btn' }, 'fp-b'),
    ];
    expect(detectRepeat(history)).toBe(false);
  });
});

describe('detectWander', () => {
  it('is true when all 5 tail outcomeFps already appear earlier in history', () => {
    const history: HistoryEntry[] = [
      h(1, 'fp-a', { kind: 'tap', elementId: 'x1' }, 'fp-b'),
      h(2, 'fp-b', { kind: 'tap', elementId: 'x2' }, 'fp-c'),
      h(3, 'fp-c', { kind: 'tap', elementId: 'x3' }, 'fp-a'),
      h(4, 'fp-a', { kind: 'tap', elementId: 'x4' }, 'fp-b'),
      h(5, 'fp-b', { kind: 'tap', elementId: 'x5' }, 'fp-c'),
      h(6, 'fp-c', { kind: 'tap', elementId: 'x6' }, 'fp-a'),
      h(7, 'fp-a', { kind: 'tap', elementId: 'x7' }, 'fp-b'),
      h(8, 'fp-b', { kind: 'tap', elementId: 'x8' }, null),
    ];
    expect(detectWander(history)).toBe(true);
  });

  it('is false when one of the last 5 turns produces a brand-new fingerprint', () => {
    const history: HistoryEntry[] = [
      h(1, 'fp-a', { kind: 'tap', elementId: 'x1' }, 'fp-b'),
      h(2, 'fp-b', { kind: 'tap', elementId: 'x2' }, 'fp-c'),
      h(3, 'fp-c', { kind: 'tap', elementId: 'x3' }, 'fp-a'),
      h(4, 'fp-a', { kind: 'tap', elementId: 'x4' }, 'fp-b'),
      h(5, 'fp-b', { kind: 'tap', elementId: 'x5' }, 'fp-c'),
      h(6, 'fp-c', { kind: 'tap', elementId: 'x6' }, 'fp-a'),
      h(7, 'fp-a', { kind: 'tap', elementId: 'x7' }, 'fp-NEW'),
      h(8, 'fp-NEW', { kind: 'tap', elementId: 'x8' }, 'fp-a'),
    ];
    expect(detectWander(history)).toBe(false);
  });
});

describe('detectCycle', () => {
  it('is true for 6 turns alternating [A,B,A,B,A,B] with len=3', () => {
    const history: HistoryEntry[] = [
      h(1, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-B'),
      h(2, 'fp-B', { kind: 'tap', elementId: 'x' }, 'fp-A'),
      h(3, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-B'),
      h(4, 'fp-B', { kind: 'tap', elementId: 'x' }, 'fp-A'),
      h(5, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-B'),
      h(6, 'fp-B', { kind: 'tap', elementId: 'x' }, 'fp-A'),
    ];
    expect(detectCycle(history)).toBe(true);
  });

  it('is false when all 6 turns share the same screenFp (no alternation)', () => {
    const history: HistoryEntry[] = [
      h(1, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-A'),
      h(2, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-A'),
      h(3, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-A'),
      h(4, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-A'),
      h(5, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-A'),
      h(6, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-A'),
    ];
    expect(detectCycle(history)).toBe(false);
  });

  it('is false when len=3 but only 4 turns of history exist', () => {
    const history: HistoryEntry[] = [
      h(1, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-B'),
      h(2, 'fp-B', { kind: 'tap', elementId: 'x' }, 'fp-A'),
      h(3, 'fp-A', { kind: 'tap', elementId: 'x' }, 'fp-B'),
      h(4, 'fp-B', { kind: 'tap', elementId: 'x' }, 'fp-A'),
    ];
    expect(detectCycle(history)).toBe(false);
  });
});
