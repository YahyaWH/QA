import { describe, it, expect, vi } from 'vitest';
import {
  buildIssueLabels,
  publishFinding,
  renderIssueBody,
  type ArtifactUrls,
  type LinearClient,
} from './linear';
import type { Finding } from '../types/index';

/** Canonical "new HIGH/A crash" finding used across tests unless overridden. */
function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'a3f2b7d09c1e8fa2',
    runId: 'run-1',
    screenFp: 'fp-route-detail',
    element: 'route-card-item',
    category: 'A',
    severity: 'high',
    summary: 'Crash when opening Route Detail from Schedule',
    reasoning:
      'logcat: FATAL EXCEPTION: main — java.lang.NullPointerException at RouteDetailScreen.render',
    status: 'new',
    ...over,
  };
}

/** Build a LinearClient mock whose saveIssue returns a deterministic ref. */
function mockClient(
  over: Partial<{
    saveIssue: LinearClient['saveIssue'];
    createAttachment: LinearClient['createAttachment'];
  }> = {},
): LinearClient & {
  saveIssue: ReturnType<typeof vi.fn>;
  createAttachment: ReturnType<typeof vi.fn>;
} {
  const saveIssue = vi
    .fn()
    .mockImplementation(async () => ({ id: 'issue-uuid-1', identifier: 'WH-42' }));
  const createAttachment = vi.fn().mockImplementation(async () => undefined);
  return {
    saveIssue: over.saveIssue ?? saveIssue,
    createAttachment: over.createAttachment ?? createAttachment,
  } as LinearClient & {
    saveIssue: ReturnType<typeof vi.fn>;
    createAttachment: ReturnType<typeof vi.fn>;
  };
}

describe('renderIssueBody', () => {
  it('includes severity, category, screen ref, element, reasoning, and all artifacts', () => {
    const body = renderIssueBody(
      makeFinding(),
      {
        screenshot: 'https://raw/a.png',
        clip: 'https://raw/a.mp4',
        logcat: 'https://raw/a.log',
      },
      '`RouteDetailScreen` (fp: `a3f2b7…`)',
    );

    expect(body).toContain('**Severity:** HIGH');
    expect(body).toContain('**Category:** A (hard failure)');
    expect(body).toContain('**Screen:** `RouteDetailScreen` (fp: `a3f2b7…`)');
    expect(body).toContain('**Element:** `route-card-item`');
    expect(body).toContain(
      '**Agent reasoning:** logcat: FATAL EXCEPTION: main',
    );
    expect(body).toContain('**Artifacts:**');
    expect(body).toContain('[screenshot](https://raw/a.png)');
    expect(body).toContain('[clip](https://raw/a.mp4)');
    expect(body).toContain('[logcat](https://raw/a.log)');
  });

  it('renders element as "(unknown)" when null', () => {
    const body = renderIssueBody(
      makeFinding({ element: null }),
      {},
      '`Screen` (fp: `abc123…`)',
    );
    expect(body).toContain('**Element:** (unknown)');
  });

  it('omits the Artifacts section when no URLs are provided', () => {
    const body = renderIssueBody(makeFinding(), {}, 'ref');
    expect(body).not.toContain('**Artifacts:**');
    expect(body).not.toContain('[screenshot]');
    expect(body).not.toContain('[clip]');
    expect(body).not.toContain('[logcat]');
  });

  it('emits only the artifact links that are present', () => {
    const body = renderIssueBody(
      makeFinding(),
      { screenshot: 'https://raw/s.png' },
      'ref',
    );
    expect(body).toContain('[screenshot](https://raw/s.png)');
    expect(body).not.toContain('[clip]');
    expect(body).not.toContain('[logcat]');
  });

  it('ends without a trailing newline (caller decides wrapping)', () => {
    const body = renderIssueBody(makeFinding(), {}, 'ref');
    expect(body.endsWith('\n')).toBe(false);
  });
});

describe('buildIssueLabels', () => {
  it('returns the canonical android-qa + auto + category + severity labels', () => {
    const labels = buildIssueLabels(
      makeFinding({ category: 'B', severity: 'med' }),
    );
    expect(labels).toEqual([
      'android-qa',
      'auto',
      'category-B',
      'severity-med',
    ]);
  });

  it('uses finding category + severity verbatim (critical + E edge case)', () => {
    const labels = buildIssueLabels(
      makeFinding({ category: 'E', severity: 'critical' }),
    );
    expect(labels).toEqual([
      'android-qa',
      'auto',
      'category-E',
      'severity-critical',
    ]);
  });
});

describe('publishFinding', () => {
  it('calls saveIssue with title=summary, description=renderIssueBody, correct labels', async () => {
    const client = mockClient();
    const urls: ArtifactUrls = { screenshot: 'https://raw/s.png' };
    const ref = await publishFinding(makeFinding(), urls, client, {
      screenRef: '`RouteDetailScreen` (fp: `a3f2b7…`)',
      teamId: 'team-1',
      projectId: 'proj-1',
    });

    expect(ref).toEqual({ id: 'issue-uuid-1', identifier: 'WH-42' });
    expect(client.saveIssue).toHaveBeenCalledTimes(1);
    const [saveInput] = client.saveIssue.mock.calls[0];
    expect(saveInput.title).toBe('Crash when opening Route Detail from Schedule');
    expect(saveInput.teamId).toBe('team-1');
    expect(saveInput.projectId).toBe('proj-1');
    expect(saveInput.labels).toEqual([
      'android-qa',
      'auto',
      'category-A',
      'severity-high',
    ]);
    expect(saveInput.description).toContain('**Severity:** HIGH');
    expect(saveInput.description).toContain('**Category:** A (hard failure)');
    expect(saveInput.description).toContain('**Screen:** `RouteDetailScreen`');
    expect(saveInput.description).toContain('[screenshot](https://raw/s.png)');
  });

  it('creates one attachment per present artifact URL with matching label titles', async () => {
    const client = mockClient();
    await publishFinding(
      makeFinding(),
      {
        screenshot: 'https://raw/s.png',
        clip: 'https://raw/s.mp4',
        logcat: 'https://raw/s.log',
      },
      client,
    );

    expect(client.createAttachment).toHaveBeenCalledTimes(3);
    const calls = client.createAttachment.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { issueId: 'issue-uuid-1', url: 'https://raw/s.png', title: 'screenshot' },
      { issueId: 'issue-uuid-1', url: 'https://raw/s.mp4', title: 'clip' },
      { issueId: 'issue-uuid-1', url: 'https://raw/s.log', title: 'logcat' },
    ]);
  });

  it('skips attachment calls for absent URLs', async () => {
    const client = mockClient();
    await publishFinding(makeFinding(), {}, client);
    expect(client.createAttachment).not.toHaveBeenCalled();
  });

  it('calls saveIssue strictly before any attachment', async () => {
    const order: string[] = [];
    const client = mockClient({
      saveIssue: vi.fn().mockImplementation(async () => {
        order.push('save');
        return { id: 'i1', identifier: 'WH-1' };
      }),
      createAttachment: vi.fn().mockImplementation(async () => {
        order.push('attach');
      }),
    });
    await publishFinding(
      makeFinding(),
      { screenshot: 'u1', clip: 'u2' },
      client,
    );
    expect(order).toEqual(['save', 'attach', 'attach']);
  });

  it('propagates saveIssue errors without firing any attachments', async () => {
    const createAttachment = vi.fn();
    const client: LinearClient = {
      saveIssue: vi.fn().mockRejectedValue(new Error('auth rejected')),
      createAttachment,
    };
    await expect(
      publishFinding(
        makeFinding(),
        { screenshot: 'u1' },
        client,
      ),
    ).rejects.toThrow('auth rejected');
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it('propagates attachment errors (caller decides rollback)', async () => {
    const client = mockClient({
      createAttachment: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('attachment failed')),
    });
    await expect(
      publishFinding(
        makeFinding(),
        { screenshot: 'u1', clip: 'u2' },
        client,
      ),
    ).rejects.toThrow('attachment failed');
  });

  it('falls back to a bare fingerprint screen ref when none is provided', async () => {
    const client = mockClient();
    await publishFinding(makeFinding(), {}, client);
    const [saveInput] = client.saveIssue.mock.calls[0];
    // Finding.screenFp is "fp-route-detail"; the first 6 chars form the fallback.
    expect(saveInput.description).toContain('(fp: `fp-rou…`)');
  });
});
