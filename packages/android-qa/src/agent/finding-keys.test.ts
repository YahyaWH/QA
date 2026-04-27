import { describe, it, expect } from 'vitest';
import { findingTupleKey } from './finding-keys';

describe('findingTupleKey', () => {
  it('formats a key as screenFp|element|category', () => {
    expect(findingTupleKey({ screenFp: 'fp-1', element: 'btn', category: 'A' })).toBe(
      'fp-1|btn|A',
    );
  });

  it('stringifies a null element to the literal "null"', () => {
    expect(findingTupleKey({ screenFp: 'fp-1', element: null, category: 'B' })).toBe(
      'fp-1|null|B',
    );
  });

  it('produces distinct keys when only screenFp differs', () => {
    const a = findingTupleKey({ screenFp: 'fp-1', element: 'btn', category: 'A' });
    const b = findingTupleKey({ screenFp: 'fp-2', element: 'btn', category: 'A' });
    expect(a).not.toBe(b);
  });
});
