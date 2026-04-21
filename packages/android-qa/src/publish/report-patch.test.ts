import { describe, it, expect } from 'vitest';
import { patchReportHeader } from './report-patch';

describe('patchReportHeader', () => {
  const baseLine =
    '### \u2611 f-0087 \u2014 [HIGH] Crash when opening Route Detail from Schedule';

  it('appends the Linear identifier as a heading suffix', () => {
    const md = [baseLine, 'body line'].join('\n');
    const patched = patchReportHeader(md, 'f-0087', 'WH-1999');
    expect(patched).toContain(`${baseLine} \u2014 WH-1999 (open)`);
  });

  it('is a no-op when the exact suffix is already present', () => {
    const line = `${baseLine} \u2014 WH-1999 (open)`;
    const md = [line, 'body'].join('\n');
    const patched = patchReportHeader(md, 'f-0087', 'WH-1999');
    expect(patched).toBe(md);
  });

  it('replaces a stale suffix when the identifier differs', () => {
    const line = `${baseLine} \u2014 WH-0001 (open)`;
    const md = [line, 'body'].join('\n');
    const patched = patchReportHeader(md, 'f-0087', 'WH-1999');
    expect(patched).toContain(`${baseLine} \u2014 WH-1999 (open)`);
    expect(patched).not.toContain('WH-0001');
  });

  it('only patches the matching display id, not other findings', () => {
    const md = [
      '### \u2611 f-0087 \u2014 [HIGH] Target',
      'body a',
      '### \u2611 f-0088 \u2014 [MED] Other',
      'body b',
    ].join('\n');
    const patched = patchReportHeader(md, 'f-0087', 'WH-9');
    expect(patched).toContain('### \u2611 f-0087 \u2014 [HIGH] Target \u2014 WH-9 (open)');
    expect(patched).toContain('### \u2611 f-0088 \u2014 [MED] Other');
    expect(patched).not.toContain('### \u2611 f-0088 \u2014 [MED] Other \u2014');
  });

  it('leaves body lines untouched', () => {
    const md = [baseLine, '- **Screen:** `X`', '- **Category:** A'].join('\n');
    const patched = patchReportHeader(md, 'f-0087', 'WH-1');
    expect(patched).toContain('- **Screen:** `X`');
    expect(patched).toContain('- **Category:** A');
  });

  it('returns the input unchanged when no matching heading exists', () => {
    const md = [
      '### \u2611 f-0001 \u2014 [LOW] Unrelated',
      'body',
    ].join('\n');
    const patched = patchReportHeader(md, 'f-0087', 'WH-1');
    expect(patched).toBe(md);
  });

  it('tolerates unticked matches (☐) just as well as ticked ones', () => {
    // The CLI only patches ticked findings, but the helper is agnostic; keep
    // the regex tolerant of either mark so no invisible assumption creeps in.
    const line = '### \u2610 f-0087 \u2014 [HIGH] Target';
    const md = [line, 'body'].join('\n');
    const patched = patchReportHeader(md, 'f-0087', 'WH-2');
    expect(patched).toContain(`${line} \u2014 WH-2 (open)`);
  });
});
