import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from './render';
import type { Finding, SessionState } from '../types/index';

/** Build a minimal Finding with deterministic defaults. */
function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? '0000000000000000',
    runId: overrides.runId ?? 'run-20260420-1200',
    screenFp: overrides.screenFp ?? 'fp00000000000000',
    element: overrides.element === undefined ? 'btn-default' : overrides.element,
    category: overrides.category ?? 'C',
    severity: overrides.severity ?? 'med',
    summary: overrides.summary ?? 'default summary',
    reasoning: overrides.reasoning ?? 'default reasoning',
    status: overrides.status ?? 'new',
    firstSeenRun: overrides.firstSeenRun,
    lastSeenRun: overrides.lastSeenRun,
    occurrences: overrides.occurrences,
    linearIssueId: overrides.linearIssueId,
    artifactRefs: overrides.artifactRefs,
  };
}

/** Build a minimal SessionState with deterministic defaults. */
function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    runId: overrides.runId ?? 'run-20260420-1200',
    appVersion: overrides.appVersion ?? '2.14.3',
    role: overrides.role ?? 'driver',
    startedAt: overrides.startedAt ?? '2026-04-20T12:00:00.000Z',
    endedAt: overrides.endedAt ?? '2026-04-20T12:27:00.000Z',
    status: overrides.status ?? 'completed',
    budget: overrides.budget ?? { wallClockMs: 30 * 60_000, turns: 200 },
    counters: overrides.counters ?? {
      crashCount: 0,
      noNewScreenStreak: 0,
      malformedJsonCount: 0,
    },
    screens: overrides.screens ?? {},
    frontier: overrides.frontier ?? [],
    findings: overrides.findings ?? [],
    history: overrides.history ?? [],
  };
}

/**
 * Load the hand-written expected markdown for the happy-path golden test.
 * Kept next to the report source so diffs show in review.
 */
function loadGolden(): string {
  const path = fileURLToPath(
    new URL('../../test-fixtures/reports/golden-report.md', import.meta.url),
  );
  return readFileSync(path, 'utf8');
}

describe('render', () => {
  it('renders the happy-path golden snapshot exactly', () => {
    const resurrected: Finding = finding({
      id: 'a3f2b7d09c1e8fa2',
      screenFp: 'a3f2b7d09c1e8fa2',
      element: 'route-card-item',
      category: 'A',
      severity: 'high',
      summary: 'Crash when opening Route Detail from Schedule',
      reasoning:
        'logcat: FATAL EXCEPTION: main — java.lang.NullPointerException at RouteDetailScreen.render',
      status: 'resurrected',
      firstSeenRun: 'run-20260329-0800',
      lastSeenRun: 'run-20260420-1200',
      occurrences: 3,
      linearIssueId: 'WH-0911',
    });

    const newHigh: Finding = finding({
      id: 'b210000000000000',
      screenFp: 'b21feedcafe01234',
      element: 'save-pickup-btn',
      category: 'B',
      severity: 'med',
      summary: 'Save button disabled without explanation on "New Pickup"',
      reasoning:
        'All fields appear valid; no error text shown; button is present but enabled=false.',
      status: 'new',
      firstSeenRun: 'run-20260420-1200',
      lastSeenRun: 'run-20260420-1200',
      occurrences: 1,
    });

    const newLow: Finding = finding({
      id: 'c4d5000000000000',
      screenFp: 'c4d5abcd00000000',
      element: null,
      category: 'C',
      severity: 'low',
      summary: 'Danish string shown in English locale on Settings > Notifications',
      reasoning: 'Language toggle set to English but button label reads "Gem".',
      status: 'new',
      firstSeenRun: 'run-20260420-1200',
      lastSeenRun: 'run-20260420-1200',
      occurrences: 1,
    });

    const previouslySeen: Finding = finding({
      id: '0042000000000000',
      screenFp: '0042abc000000000',
      element: 'search-results',
      category: 'D',
      severity: 'med',
      summary: "Search results don't clear after tapping back",
      reasoning: 'Stale results from previous query remain visible.',
      status: 'previously-seen',
      firstSeenRun: 'run-20260101-0900',
      lastSeenRun: 'run-20260420-1200',
      occurrences: 5,
      linearIssueId: 'WH-1142',
    });

    // A history entry from a prior run not in THIS run's findings.
    // Should surface in "Previously seen" because it's published and not
    // collapsed by the current run's previously-seen set.
    const publishedInHistoryOnly: Finding = finding({
      id: '0099000000000000',
      runId: 'run-20260410-0800',
      screenFp: '0099fedc00000000',
      element: 'nav-drawer',
      category: 'C',
      severity: 'low',
      summary: 'Nav drawer overlaps FAB on short screens',
      reasoning: 'FAB is visually clipped when drawer is open.',
      status: 'published',
      firstSeenRun: 'run-20260405-0700',
      lastSeenRun: 'run-20260410-0800',
      occurrences: 2,
      linearIssueId: 'WH-1050',
    });

    // History for "resurrected" needs a matching entry with stale status +
    // Linear id so the renderer can emit the "Linear (previous)" line.
    const staleHistorical: Finding = finding({
      id: 'a3f200000000beef',
      runId: 'run-20260329-0800',
      screenFp: 'a3f2b7d09c1e8fa2',
      element: 'route-card-item',
      category: 'A',
      severity: 'high',
      summary: 'Crash when opening Route Detail from Schedule',
      reasoning: 'original reasoning',
      status: 'stale',
      firstSeenRun: 'run-20260329-0800',
      lastSeenRun: 'run-20260329-0800',
      occurrences: 1,
      linearIssueId: 'WH-0911',
    });

    const state = session({
      findings: [resurrected, newHigh, newLow, previouslySeen],
      screens: {
        'a3f2b7d09c1e8fa2': {
          fingerprint: 'a3f2b7d09c1e8fa2',
          activity: 'RouteDetailScreen',
          elements: {},
        },
        'b21feedcafe01234': {
          fingerprint: 'b21feedcafe01234',
          activity: 'NewPickupScreen',
          elements: {},
        },
        'c4d5abcd00000000': {
          fingerprint: 'c4d5abcd00000000',
          activity: 'SettingsNotificationsScreen',
          elements: {},
        },
      },
    });

    const history: Finding[] = [staleHistorical, publishedInHistoryOnly];

    const out = render({
      session: state,
      history,
      runDir: 'output/android-qa/run-20260420-1200',
    });

    expect(out).toEqual(loadGolden());
  });

  it('renders a zero-findings run as valid markdown with empty sections', () => {
    const state = session({ findings: [] });

    const out = render({
      session: state,
      history: [],
      runDir: 'output/android-qa/run-20260420-1200',
    });

    expect(out).toContain('# Android QA Run — run-20260420-1200');
    expect(out).toContain('## Regressions (previously resolved, now back) — 0');
    expect(out).toContain('## New this run — 0');
    expect(out).toContain('## Previously seen (already triaged; informational) — 0');
    // "(none)" placeholder is used when a section is empty.
    expect(out).toContain('(none)');
  });

  it('uppercases severity tokens in the finding header', () => {
    const critical = finding({
      id: '1111000000000000',
      severity: 'critical',
      status: 'new',
      summary: 'Critical thing',
    });
    const mid = finding({
      id: '2222000000000000',
      severity: 'med',
      status: 'new',
      summary: 'Medium thing',
    });
    const state = session({ findings: [critical, mid] });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).toContain('[CRITICAL] Critical thing');
    expect(out).toContain('[MED] Medium thing');
  });

  it('renders null element as (unknown)', () => {
    const f = finding({
      id: '3333000000000000',
      element: null,
      status: 'new',
      summary: 'No element',
    });
    const state = session({ findings: [f] });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).toContain('**Element:** (unknown)');
  });

  it('omits the Linear (previous) line for a resurrection with no historical linear id', () => {
    const resurrected = finding({
      id: 'aaaa000000000000',
      screenFp: 'fp-aaaa000000',
      status: 'resurrected',
      summary: 'Back again',
    });
    const historyMatch = finding({
      id: 'bbbb000000000000',
      runId: 'run-prev',
      screenFp: 'fp-aaaa000000',
      element: 'btn-default',
      category: 'C',
      status: 'stale',
      summary: 'Back again',
      // no linearIssueId
    });

    const state = session({ findings: [resurrected] });
    const out = render({
      session: state,
      history: [historyMatch],
      runDir: 'out',
    });

    expect(out).toContain('## Regressions');
    expect(out).not.toContain('**Linear (previous):**');
  });

  it('adds an Evidence blockquote for category A + FATAL EXCEPTION reasoning', () => {
    const crashing = finding({
      id: '4444000000000000',
      category: 'A',
      severity: 'critical',
      status: 'new',
      summary: 'Hard crash',
      reasoning:
        'logcat: FATAL EXCEPTION: main — java.lang.NullPointerException at X',
    });
    const state = session({ findings: [crashing] });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).toContain('**Evidence:**');
    expect(out).toMatch(/>\s+`[^`]*FATAL EXCEPTION[^`]*`/);
  });

  it('does NOT add an Evidence blockquote for category B findings', () => {
    const notCrash = finding({
      id: '5555000000000000',
      category: 'B',
      severity: 'med',
      status: 'new',
      summary: 'Broken thing',
      // Even if someone wrote "FATAL EXCEPTION" in reasoning — B is not A.
      reasoning: 'button does not work even though FATAL EXCEPTION is mentioned',
    });
    const state = session({ findings: [notCrash] });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).not.toContain('**Evidence:**');
  });

  it('maps a full 16-hex finding id to a stable 4-hex display id', () => {
    const f = finding({
      id: 'a3f2b7d09c1e8fa2',
      status: 'new',
      summary: 'Stable display id',
    });
    const state = session({ findings: [f] });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    // The spec-style display form is "f-XXXX" (first 4 hex chars of id).
    expect(out).toContain('f-a3f2');
    // Should appear in the header as "### ☐ f-a3f2 — ..."
    expect(out).toMatch(/### ☐ f-a3f2 /);
  });

  it('orders sections: Regressions before New before Previously-seen', () => {
    const resurrected = finding({
      id: '6666000000000000',
      screenFp: 'fp-res000000',
      status: 'resurrected',
      summary: 'Back',
    });
    const neu = finding({
      id: '7777000000000000',
      screenFp: 'fp-new000000',
      status: 'new',
      summary: 'Fresh',
    });
    const seen = finding({
      id: '8888000000000000',
      screenFp: 'fp-old000000',
      status: 'previously-seen',
      summary: 'Known',
    });

    const historyMatch = finding({
      id: '6666aaaa00000000',
      runId: 'run-prev',
      screenFp: 'fp-res000000',
      element: 'btn-default',
      category: 'C',
      status: 'stale',
      summary: 'Back',
    });

    const state = session({ findings: [seen, neu, resurrected] });
    const out = render({
      session: state,
      history: [historyMatch],
      runDir: 'out',
    });

    const regressionsIdx = out.indexOf('## Regressions');
    const newIdx = out.indexOf('## New this run');
    const seenIdx = out.indexOf('## Previously seen');

    expect(regressionsIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(regressionsIdx);
    expect(seenIdx).toBeGreaterThan(newIdx);
  });

  it('dedupes Previously-seen rows by tuple key even when ids differ across runs', () => {
    // Same underlying bug: (screenFp A, element btn, category B).
    // Current-run classified it `previously-seen` with id 'x...'.
    // History has it `published` under a different run — id 'y...'.
    // Finding ids embed runId, so a naive id-based dedup would emit BOTH rows.
    // The renderer must collapse them using findingTupleKey.
    const currentSeen = finding({
      id: 'x0000000000000aa',
      screenFp: 'aaaaaaaaaaaaaaaa',
      element: 'btn',
      category: 'B',
      severity: 'med',
      status: 'previously-seen',
      summary: 'Shared bug seen this run',
      reasoning: 'current-run reasoning',
      // No linearIssueId on the current-run entry — should inherit from history.
    });

    const publishedInHistory = finding({
      id: 'y0000000000000bb',
      runId: 'run-20260410-0800',
      screenFp: 'aaaaaaaaaaaaaaaa',
      element: 'btn',
      category: 'B',
      severity: 'med',
      status: 'published',
      summary: 'Shared bug — stale summary from earlier publish',
      reasoning: 'historical reasoning',
      linearIssueId: 'WH-1',
    });

    const state = session({ findings: [currentSeen] });
    const out = render({
      session: state,
      history: [publishedInHistory],
      runDir: 'out',
    });

    // Count rows in the Previously-seen section.
    const seenSection = out.slice(out.indexOf('## Previously seen'));
    const rowCount = (seenSection.match(/^### ☑ /gm) ?? []).length;
    expect(rowCount).toBe(1);

    // Header count should reflect the single merged row.
    expect(out).toContain('## Previously seen (already triaged; informational) — 1');

    // The current-run entry wins for display (fresher summary)…
    expect(out).toContain('Shared bug seen this run');
    expect(out).not.toContain('stale summary from earlier publish');

    // …but inherits the historical linear id since the current entry lacks one.
    expect(out).toContain('WH-1 (open)');
  });

  it('emits "completed — turn budget reached" when history.length === budget.turns', () => {
    const turns = 5;
    const fakeHistory = Array.from({ length: turns }, (_, i) => ({
      turn: i,
      screenFp: 'fp00000000000000',
      action: { kind: 'tap' as const, elementId: 'btn' },
      outcomeFp: null,
      ms: 100,
    }));
    const state = session({
      status: 'completed',
      budget: { wallClockMs: 60 * 60_000, turns },
      history: fakeHistory,
    });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).toContain('## Run status\ncompleted — turn budget reached');
  });

  it('emits "completed — wall-clock budget reached" when elapsed time is within 5% of wallClockMs', () => {
    // Budget 30 min, elapsed ~29 min → 3.3% under budget → within tolerance.
    const state = session({
      status: 'completed',
      startedAt: '2026-04-20T12:00:00.000Z',
      endedAt: '2026-04-20T12:29:00.000Z',
      budget: { wallClockMs: 30 * 60_000, turns: 10_000 },
      history: [],
    });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).toContain('## Run status\ncompleted — wall-clock budget reached');
  });

  it('emits "completed — agent signalled done" when the last action was done', () => {
    const state = session({
      status: 'completed',
      budget: { wallClockMs: 60 * 60_000, turns: 1_000 },
      // Make elapsed clearly NOT a wall-clock hit (e.g. 5 minutes of a 60-min budget).
      startedAt: '2026-04-20T12:00:00.000Z',
      endedAt: '2026-04-20T12:05:00.000Z',
      history: [
        {
          turn: 0,
          screenFp: 'fp00000000000000',
          action: { kind: 'done', reason: 'explored everything reachable' },
          outcomeFp: null,
          ms: 100,
        },
      ],
    });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).toContain('## Run status\ncompleted — agent signalled done');
  });

  it('falls back to "completed — frontier exhausted" when no other reason applies', () => {
    const state = session({
      status: 'completed',
      // Well under the turn budget.
      budget: { wallClockMs: 60 * 60_000, turns: 1_000 },
      // Well under the wall-clock budget (5 min of 60).
      startedAt: '2026-04-20T12:00:00.000Z',
      endedAt: '2026-04-20T12:05:00.000Z',
      history: [
        {
          turn: 0,
          screenFp: 'fp00000000000000',
          action: { kind: 'tap', elementId: 'btn' },
          outcomeFp: null,
          ms: 100,
        },
      ],
    });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).toContain('## Run status\ncompleted — frontier exhausted');
  });

  it.each([
    ['aborted-crash-loop', 'crash count reached 3'],
    ['aborted-device', 'emulator unrecoverable'],
    ['aborted-auth', 'login flow failed'],
    ['aborted-error', 'unexpected exception in main loop'],
  ] as const)(
    'emits "%s — %s" for aborted runs',
    (status, reason) => {
      const state = session({ status });
      const out = render({
        session: state,
        history: [],
        runDir: 'out',
      });
      expect(out).toContain(`## Run status\n${status} — ${reason}`);
    },
  );

  it('adds an Evidence blockquote for category A + ANR in reasoning', () => {
    const anr = finding({
      id: '9999000000000000',
      category: 'A',
      severity: 'high',
      status: 'new',
      summary: 'ANR on splash',
      reasoning: 'ANR in com.example — main thread blocked for 5.2s',
    });
    const state = session({ findings: [anr] });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    expect(out).toContain('**Evidence:**');
    expect(out).toMatch(/>\s+`[^`]*ANR in com\.example[^`]*`/);
  });

  it('strips backticks from reasoning before wrapping in the Evidence code-span', () => {
    // A raw backtick inside `${reasoning}` would break the surrounding code-span.
    const crashy = finding({
      id: 'bbbb111100000000',
      category: 'A',
      severity: 'critical',
      status: 'new',
      summary: 'Crash with quoted log line',
      reasoning: 'FATAL EXCEPTION: something went `wrong` here',
    });
    const state = session({ findings: [crashy] });

    const out = render({
      session: state,
      history: [],
      runDir: 'out',
    });

    // The evidence line must not contain any internal backticks that would
    // prematurely close the code-span.
    const evidenceLine = out
      .split('\n')
      .find((l) => l.trim().startsWith('> `'));
    expect(evidenceLine).toBeDefined();
    const inner = evidenceLine!.trim().slice(2).trim(); // strip "> "
    // Strip the leading/trailing backtick delimiters and assert the inside
    // has none.
    expect(inner.startsWith('`') && inner.endsWith('`')).toBe(true);
    const codeSpanBody = inner.slice(1, -1);
    expect(codeSpanBody).not.toContain('`');
    // Original message is preserved with backticks replaced by single quotes.
    expect(codeSpanBody).toContain("something went 'wrong' here");
  });

});
