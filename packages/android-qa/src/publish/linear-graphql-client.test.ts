import { describe, it, expect, vi } from 'vitest';
import { LinearGraphQLClient } from './linear-graphql-client';

/**
 * Build a fake `fetch` that dispatches GraphQL requests to a script of typed
 * handlers. Each handler returns `{ data }` (wrapped into a Response). The
 * test asserts call shapes against `captured`.
 */
type Handler = (
  body: { query: string; variables: Record<string, unknown> },
) => { data: unknown } | { errors: unknown[] };

function makeFakeFetch(handlers: Handler[]): {
  fetchImpl: typeof fetch;
  captured: Array<{ body: { query: string; variables: Record<string, unknown> }; headers: Record<string, string> }>;
} {
  const captured: Array<{ body: { query: string; variables: Record<string, unknown> }; headers: Record<string, string> }> = [];
  let idx = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (idx >= handlers.length) {
      throw new Error(`fakeFetch: no handler for call #${idx + 1}`);
    }
    const handler = handlers[idx];
    idx += 1;
    const body = JSON.parse(String(init?.body ?? '{}'));
    captured.push({
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const result = handler(body);
    return {
      ok: true,
      status: 200,
      async json() {
        return result;
      },
      async text() {
        return JSON.stringify(result);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

describe('LinearGraphQLClient', () => {
  it('saveIssue: resolves labels by name, creates missing ones, and posts with labelIds', async () => {
    const { fetchImpl, captured } = makeFakeFetch([
      // 1. team labels query — returns existing "android-qa" + "auto"
      () => ({
        data: {
          team: {
            labels: {
              nodes: [
                { id: 'lbl-android', name: 'android-qa' },
                { id: 'lbl-auto', name: 'auto' },
              ],
            },
          },
        },
      }),
      // 2. issueLabelCreate — category-A
      () => ({
        data: {
          issueLabelCreate: {
            success: true,
            issueLabel: { id: 'lbl-cat-A', name: 'category-A' },
          },
        },
      }),
      // 3. issueLabelCreate — severity-high
      () => ({
        data: {
          issueLabelCreate: {
            success: true,
            issueLabel: { id: 'lbl-sev-high', name: 'severity-high' },
          },
        },
      }),
      // 4. issueCreate
      () => ({
        data: {
          issueCreate: {
            success: true,
            issue: { id: 'issue-uuid-1', identifier: 'WH-42' },
          },
        },
      }),
    ]);

    const client = new LinearGraphQLClient({
      apiKey: 'lin_api_testkey',
      fetchImpl,
    });
    const ref = await client.saveIssue({
      teamId: 'team-1',
      title: 'Crash',
      description: 'body',
      labels: ['android-qa', 'auto', 'category-A', 'severity-high'],
    });

    expect(ref).toEqual({ id: 'issue-uuid-1', identifier: 'WH-42' });

    // 4 calls: 1 labels query, 2 createLabel, 1 issueCreate.
    expect(captured).toHaveLength(4);
    // Last call: issueCreate with the resolved label IDs.
    const last = captured[3];
    expect(last.body.query).toMatch(/issueCreate/);
    const input = last.body.variables.input as Record<string, unknown>;
    expect(input.teamId).toBe('team-1');
    expect(input.title).toBe('Crash');
    expect(input.description).toBe('body');
    expect(input.labelIds).toEqual([
      'lbl-android',
      'lbl-auto',
      'lbl-cat-A',
      'lbl-sev-high',
    ]);

    // Auth header present on every call.
    for (const c of captured) {
      expect(c.headers.Authorization).toBe('lin_api_testkey');
    }
  });

  it('saveIssue: caches labels after the first resolution (second call skips label query)', async () => {
    const { fetchImpl, captured } = makeFakeFetch([
      // Call 1: labels query
      () => ({
        data: {
          team: {
            labels: {
              nodes: [
                { id: 'l1', name: 'a' },
                { id: 'l2', name: 'b' },
              ],
            },
          },
        },
      }),
      // Call 2: issueCreate
      () => ({
        data: {
          issueCreate: { success: true, issue: { id: 'i1', identifier: 'WH-1' } },
        },
      }),
      // Call 3: issueCreate (second saveIssue; no label query expected)
      () => ({
        data: {
          issueCreate: { success: true, issue: { id: 'i2', identifier: 'WH-2' } },
        },
      }),
    ]);

    const client = new LinearGraphQLClient({
      apiKey: 'k',
      fetchImpl,
    });
    await client.saveIssue({
      teamId: 't',
      title: 'x',
      description: 'y',
      labels: ['a', 'b'],
    });
    await client.saveIssue({
      teamId: 't',
      title: 'z',
      description: 'w',
      labels: ['a'],
    });

    expect(captured).toHaveLength(3);
    expect(captured[0].body.query).toMatch(/team\(id/);
    expect(captured[1].body.query).toMatch(/issueCreate/);
    // No label query on the second saveIssue — the cache covered it.
    expect(captured[2].body.query).toMatch(/issueCreate/);
  });

  it('saveIssue: drops labels when teamId is absent (can\'t resolve without a team)', async () => {
    const { fetchImpl, captured } = makeFakeFetch([
      () => ({
        data: { issueCreate: { success: true, issue: { id: 'i', identifier: 'WH-9' } } },
      }),
    ]);

    const client = new LinearGraphQLClient({ apiKey: 'k', fetchImpl });
    await client.saveIssue({
      title: 't',
      description: 'd',
      labels: ['a', 'b', 'c'],
    });

    // Only one call: issueCreate. No labels query because teamId is absent.
    expect(captured).toHaveLength(1);
    const input = captured[0].body.variables.input as Record<string, unknown>;
    expect(input.labelIds).toEqual([]);
  });

  it('createAttachment: posts attachmentCreate with issueId/url/title', async () => {
    const { fetchImpl, captured } = makeFakeFetch([
      () => ({ data: { attachmentCreate: { success: true } } }),
    ]);
    const client = new LinearGraphQLClient({ apiKey: 'k', fetchImpl });
    await client.createAttachment({
      issueId: 'issue-1',
      url: 'https://x/s.png',
      title: 'screenshot',
    });

    expect(captured).toHaveLength(1);
    const body = captured[0].body;
    expect(body.query).toMatch(/attachmentCreate/);
    const input = body.variables.input as Record<string, unknown>;
    expect(input).toEqual({
      issueId: 'issue-1',
      url: 'https://x/s.png',
      title: 'screenshot',
    });
  });

  it('throws when GraphQL response includes errors', async () => {
    const { fetchImpl } = makeFakeFetch([
      () => ({ errors: [{ message: 'auth failed' }] }),
    ]);
    const client = new LinearGraphQLClient({ apiKey: 'k', fetchImpl });
    await expect(
      client.createAttachment({
        issueId: 'i',
        url: 'https://x',
        title: 'screenshot',
      }),
    ).rejects.toThrow(/auth failed/);
  });

  it('throws when issueCreate reports success=false', async () => {
    const { fetchImpl } = makeFakeFetch([
      // labels query (no teamId → skipped)
      // Actually: no teamId, so we skip to issueCreate
      () => ({
        data: { issueCreate: { success: false } },
      }),
    ]);
    const client = new LinearGraphQLClient({ apiKey: 'k', fetchImpl });
    await expect(
      client.saveIssue({ title: 't', description: 'd', labels: [] }),
    ).rejects.toThrow(/issueCreate/);
  });

  it('throws on non-2xx HTTP', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 500,
        async text() {
          return 'internal';
        },
      }) as unknown as typeof fetch;
    const client = new LinearGraphQLClient({ apiKey: 'k', fetchImpl });
    await expect(
      client.createAttachment({ issueId: 'i', url: 'u', title: 't' }),
    ).rejects.toThrow(/500/);
  });
});
