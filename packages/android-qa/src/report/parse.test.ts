import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReport } from './parse';

/**
 * Load the hand-written sample report used to verify parser behavior.
 * Covers regression (with Linear body field), new (no Linear), new with
 * (unknown) element, and previously-seen (collapsed, Linear in heading).
 */
function loadSample(): string {
  const path = fileURLToPath(
    new URL('../../test-fixtures/reports/sample-report.md', import.meta.url),
  );
  return readFileSync(path, 'utf8');
}

describe('parseReport', () => {
  it('parses every finding block in the fixture', () => {
    const md = loadSample();
    // Fixture has: 1 regression + 2 new + 1 previously-seen = 4 blocks.
    expect(parseReport(md)).toHaveLength(4);
  });

  it('extracts the checked state from the ☐/☑ markers', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const byId = new Map(findings.map((f) => [f.id, f]));

    expect(byId.get('f-a3f2')!.checked).toBe(false);
    expect(byId.get('f-b210')!.checked).toBe(false);
    expect(byId.get('f-c4d5')!.checked).toBe(false);
    expect(byId.get('f-0042')!.checked).toBe(true);
  });

  it('normalizes severity to lowercase', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const byId = new Map(findings.map((f) => [f.id, f]));

    expect(byId.get('f-a3f2')!.severity).toBe('high');
    expect(byId.get('f-b210')!.severity).toBe('med');
    expect(byId.get('f-c4d5')!.severity).toBe('low');
    expect(byId.get('f-0042')!.severity).toBe('med');
  });

  it('extracts the Linear ID from the "- **Linear (previous):**" body field', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const regression = findings.find((f) => f.id === 'f-a3f2');
    expect(regression).toBeDefined();
    expect(regression!.linearIssueId).toBe('WH-0911');
  });

  it('extracts the Linear ID from the heading suffix of a previously-seen block and strips it from summary', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const seen = findings.find((f) => f.id === 'f-0042');
    expect(seen).toBeDefined();
    expect(seen!.linearIssueId).toBe('WH-1142');
    expect(seen!.summary).toBe("Search results don't clear after tapping back");
    // The heading suffix must not leak into the summary.
    expect(seen!.summary).not.toContain('WH-1142');
    expect(seen!.summary).not.toContain('(open)');
  });

  it('applies the publish filter: checked && !linearIssueId selects nothing in this fixture', () => {
    // Task 26's publish CLI filters `checked && !linearIssueId`. In this
    // fixture the only checked block already has a Linear ID, so the filter
    // selects zero findings — demonstrating the contract.
    const md = loadSample();
    const selected = parseReport(md).filter(
      (f) => f.checked && !f.linearIssueId,
    );
    expect(selected).toHaveLength(0);
  });

  it('selects checked + no-linearIssueId findings when present', () => {
    // Construct an inline report where a ticked block has no Linear id —
    // this is the exact shape the publish CLI will pick up later.
    const md = [
      '# Header',
      '',
      '## Previously seen (already triaged; informational) — 1',
      '',
      '### \u2611 f-dead — [HIGH] Ticked but unfiled',
      '(collapsed)',
      '',
    ].join('\n');

    const selected = parseReport(md).filter(
      (f) => f.checked && !f.linearIssueId,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('f-dead');
  });

  it('extracts artifact paths from the Artifacts line', () => {
    const md = loadSample();
    const findings = parseReport(md);

    const regression = findings.find((f) => f.id === 'f-a3f2')!;
    expect(regression.artifacts?.screenshot).toBe('findings/f-a3f2/before.png');
    expect(regression.artifacts?.clip).toBe('findings/f-a3f2/clip.mp4');
    expect(regression.artifacts?.logcat).toBe(
      'findings/f-a3f2/logcat-excerpt.log',
    );

    // A block without a logcat link should leave that field undefined.
    const lowBlock = findings.find((f) => f.id === 'f-c4d5')!;
    expect(lowBlock.artifacts?.screenshot).toBe('findings/f-c4d5/before.png');
    expect(lowBlock.artifacts?.clip).toBe('findings/f-c4d5/clip.mp4');
    expect(lowBlock.artifacts?.logcat).toBeUndefined();
  });

  it('extracts element `null` when the Element line is "(unknown)"', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const unknownElement = findings.find((f) => f.id === 'f-c4d5')!;
    expect(unknownElement.element).toBeNull();
  });

  it('extracts the screen activity name and ignores the fingerprint', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const byId = new Map(findings.map((f) => [f.id, f]));

    expect(byId.get('f-a3f2')!.screen).toBe('RouteDetailScreen');
    expect(byId.get('f-b210')!.screen).toBe('NewPickupScreen');
    expect(byId.get('f-c4d5')!.screen).toBe('SettingsNotificationsScreen');
  });

  it('extracts the category letter only', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const byId = new Map(findings.map((f) => [f.id, f]));

    expect(byId.get('f-a3f2')!.category).toBe('A');
    expect(byId.get('f-b210')!.category).toBe('B');
    expect(byId.get('f-c4d5')!.category).toBe('C');
  });

  it('extracts the agent reasoning text', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const regression = findings.find((f) => f.id === 'f-a3f2')!;
    expect(regression.reasoning).toBe(
      'logcat: FATAL EXCEPTION: main — java.lang.NullPointerException at RouteDetailScreen.render',
    );
  });

  it('leaves collapsed previously-seen blocks with only id/checked/severity/summary/linearIssueId populated', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const collapsed = findings.find((f) => f.id === 'f-0042')!;

    expect(collapsed.id).toBe('f-0042');
    expect(collapsed.checked).toBe(true);
    expect(collapsed.severity).toBe('med');
    expect(collapsed.summary).toBe("Search results don't clear after tapping back");
    expect(collapsed.linearIssueId).toBe('WH-1142');

    expect(collapsed.screen).toBeUndefined();
    expect(collapsed.element).toBeUndefined();
    expect(collapsed.category).toBeUndefined();
    expect(collapsed.reasoning).toBeUndefined();
    expect(collapsed.artifacts).toBeUndefined();
  });

  it('returns [] for empty input', () => {
    expect(parseReport('')).toEqual([]);
  });

  it('returns [] when the document has no finding blocks', () => {
    expect(parseReport('# Just a header\n\nNo findings.')).toEqual([]);
  });

  it('leaves linearIssueId undefined when neither body field nor heading suffix is present', () => {
    const md = loadSample();
    const findings = parseReport(md);
    const noLinear = findings.find((f) => f.id === 'f-b210')!;
    expect(noLinear.linearIssueId).toBeUndefined();
  });

  it('does not confuse em-dashes inside summaries for the Linear suffix', () => {
    // Summary legitimately contains " — " text but no trailing "— WH-NNNN (open)".
    const md = [
      '# Header',
      '',
      '## New this run — 1',
      '',
      '### \u2610 f-1234 — [HIGH] Foo — bar — baz happens',
      '- **Screen:** `SomeScreen` (fp: `123456\u2026`)',
      '- **Element:** `some-btn`',
      '- **Category:** B (functional bug)',
      '- **Artifacts:** [screenshot](findings/f-1234/before.png) \u00b7 [clip](findings/f-1234/clip.mp4)',
      '- **Agent reasoning:** whatever',
      '',
    ].join('\n');

    const [f] = parseReport(md);
    expect(f.summary).toBe('Foo — bar — baz happens');
    expect(f.linearIssueId).toBeUndefined();
  });
});
