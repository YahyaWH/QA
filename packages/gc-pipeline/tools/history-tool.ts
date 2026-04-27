/**
 * History tool for Mark (audit phase)
 * Queries the QA API (MongoDB) for historical test results.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';

function apiUrl(): string {
  return process.env.QA_API_URL || 'http://localhost:3001';
}

// ---- Tool: get_test_history ----

export async function getTestHistory(input: {
  testId: string;
  days?: number;
}): Promise<ToolResultBlockParam['content']> {
  const days = input.days || 30;
  const url = `${apiUrl()}/api/v1/results/${input.testId}/history?days=${days}`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      return `Failed to fetch history for ${input.testId}: ${res.status}`;
    }

    const results = (await res.json()) as Array<{
      runId: string;
      status: string;
      duration: number;
      error?: { classification?: { type: string } };
      createdAt: string;
    }>;

    if (results.length === 0) {
      return `No historical results found for ${input.testId} in the last ${days} days.`;
    }

    const passCount = results.filter((r) => r.status === 'PASSED').length;
    const failCount = results.filter((r) => r.status === 'FAILED').length;
    const distinctStatuses = new Set(results.map((r) => r.status));
    const isFlaky = distinctStatuses.size > 1 && results.length >= 3;

    const lines = results.slice(0, 15).map((r) => {
      const icon = r.status === 'PASSED' ? 'PASS' : r.status === 'FAILED' ? 'FAIL' : 'SKIP';
      const classType = r.error?.classification?.type || '';
      return `${icon} ${r.createdAt} run=${r.runId} ${r.duration}ms ${classType}`;
    });

    return [
      `History for ${input.testId} (last ${days} days):`,
      `  Total runs: ${results.length}`,
      `  Passed: ${passCount}, Failed: ${failCount}`,
      `  Flaky: ${isFlaky ? 'YES (multiple statuses across runs)' : 'NO'}`,
      '',
      ...lines,
    ].join('\n');
  } catch (err) {
    return `QA API not reachable: ${(err as Error).message}`;
  }
}

// ---- Tool: get_flaky_tests ----

export async function getFlakyTests(input: {
  days?: number;
}): Promise<ToolResultBlockParam['content']> {
  const days = input.days || 30;
  const url = `${apiUrl()}/api/v1/results/flaky?days=${days}`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      return `Failed to fetch flaky tests: ${res.status}`;
    }

    const flaky = (await res.json()) as Array<{
      _id: string;
      statuses: string[];
      runCount: number;
      failRate: number;
    }>;

    if (flaky.length === 0) {
      return `No flaky tests detected in the last ${days} days.`;
    }

    const lines = flaky.map((f) => {
      return `${f._id}: ${f.runCount} runs, ${(f.failRate * 100).toFixed(0)}% fail rate, statuses: ${f.statuses.join(',')}`;
    });

    return `Flaky tests (last ${days} days):\n\n${lines.join('\n')}`;
  } catch (err) {
    return `QA API not reachable: ${(err as Error).message}`;
  }
}

// ---- Claude tool definitions ----

export const HISTORY_TOOL_DEFINITIONS = [
  {
    name: 'get_test_history' as const,
    description: 'Get historical test results for a specific test ID from the QA database. Shows pass/fail pattern and whether the test is flaky.',
    input_schema: {
      type: 'object' as const,
      properties: {
        testId: { type: 'string' as const, description: 'Test ID (e.g., "FR-020-005")' },
        days: { type: 'number' as const, description: 'Number of days to look back (default: 30)' },
      },
      required: ['testId'],
    },
  },
  {
    name: 'get_flaky_tests' as const,
    description: 'Get a list of tests that have been flaky (alternating pass/fail) recently.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number' as const, description: 'Number of days to look back (default: 30)' },
      },
      required: [],
    },
  },
];

export type HistoryToolName = (typeof HISTORY_TOOL_DEFINITIONS)[number]['name'];
