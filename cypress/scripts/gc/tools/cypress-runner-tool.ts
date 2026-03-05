/**
 * Cypress runner tool for Mark (audit phase).
 * Runs a single spec file headlessly and returns pass/fail with summary.
 * Gated: Mark must get Slack confirmation before executing.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function findSpecFile(testId: string): string | null {
  const e2eDir = path.join(process.cwd(), 'cypress/e2e');
  if (!fs.existsSync(e2eDir)) return null;

  for (const dir of fs.readdirSync(e2eDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const subDir = path.join(e2eDir, dir.name);
    for (const file of fs.readdirSync(subDir)) {
      if (file.startsWith(testId) && file.endsWith('.cy.ts')) {
        return path.join('cypress/e2e', dir.name, file);
      }
    }
  }
  return null;
}

const RERUN_POLL_INTERVAL_MS = 5_000; // 5 seconds
const RERUN_POLL_TIMEOUT_MS = 300_000; // 5 minutes

async function waitForRerunApproval(testId: string): Promise<boolean> {
  const apiUrl = process.env.QA_API_URL || 'http://localhost:3001';
  const deadline = Date.now() + RERUN_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/api/v1/slack/rerun-status/${encodeURIComponent(testId)}`);
      if (res.ok) {
        const data = (await res.json()) as { status: string };
        if (data.status === 'approved') return true;
        if (data.status === 'denied') return false;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, RERUN_POLL_INTERVAL_MS));
  }

  return false; // timed out
}

// ---- Tool: run_cypress_test ----

export async function runCypressTest(input: {
  testId: string;
}): Promise<string> {
  const { testId } = input;

  // Check approval status — poll API until approved, denied, or timeout
  const approved = await waitForRerunApproval(testId);
  if (!approved) {
    return `Re-run of ${testId} was denied or timed out. Skipping.`;
  }

  // Resolve testId -> spec file path (e.g., FR-020-001 -> cypress/e2e/FR-020/FR-020-001.cy.ts)
  const specFile = findSpecFile(testId);
  if (!specFile) {
    return `No spec file found for testId "${testId}".`;
  }
  const resultsDir = path.join(process.cwd(), 'cypress/results/rerun');
  fs.mkdirSync(resultsDir, { recursive: true });

  const reportFile = path.join(resultsDir, `${testId}.json`);

  try {
    execSync(
      `npx cypress run --spec "${specFile}" --browser chrome --headless --reporter json --reporter-options "output=${reportFile}"`,
      {
        cwd: process.cwd(),
        timeout: 180_000, // 3 min max per test
        stdio: 'pipe',
        env: { ...process.env },
      }
    );

    // Cypress exited 0 → all tests passed
    return formatResult(testId, specFile, reportFile, true);
  } catch (err) {
    const exitCode = (err as { status?: number }).status;
    // Cypress exits 1 when tests fail (not an error)
    if (exitCode === 1) {
      return formatResult(testId, specFile, reportFile, false);
    }
    return `Cypress execution error for ${testId}: ${(err as Error).message?.substring(0, 500)}`;
  }
}

function formatResult(
  testId: string,
  specFile: string,
  reportFile: string,
  passed: boolean
): string {
  let detail = '';
  try {
    if (fs.existsSync(reportFile)) {
      const raw = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
      const stats = raw.stats || {};
      detail = [
        `Tests: ${stats.tests ?? '?'}, Passes: ${stats.passes ?? '?'}, Failures: ${stats.failures ?? '?'}`,
        `Duration: ${stats.duration ?? '?'}ms`,
        stats.failures > 0 && raw.failures?.length > 0
          ? `First failure: ${raw.failures[0]?.fullTitle || 'unknown'} — ${raw.failures[0]?.err?.message?.substring(0, 300) || 'no message'}`
          : '',
      ].filter(Boolean).join('\n');
    }
  } catch { /* ignore parse errors */ }

  return [
    `Re-run result for ${testId}: ${passed ? 'PASSED' : 'FAILED'}`,
    `Spec: ${specFile}`,
    detail,
  ].filter(Boolean).join('\n');
}

// ---- Tool: request_rerun_confirmation ----

import { WebClient } from '@slack/web-api';

const API_URL = process.env.QA_API_URL || 'http://localhost:3001';

export async function requestRerunConfirmation(input: {
  channelId: string;
  threadTs: string;
  testId: string;
  reason: string;
}): Promise<string> {
  // Register the rerun request with the API so it can track approval
  try {
    await fetch(`${API_URL}/api/v1/slack/rerun-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testId: input.testId }),
    });
  } catch { /* best-effort */ }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return `[DRY RUN] Would ask for rerun confirmation of ${input.testId}: ${input.reason}`;
  }

  const slack = new WebClient(slackToken);

  try {
    const result = await slack.chat.postMessage({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: `Mark wants to re-run test ${input.testId}. Approve?`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `:recycle: *Mark wants to re-run \`${input.testId}\`*`,
              `*Reason:* ${input.reason.substring(0, 300)}`,
            ].join('\n'),
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve Re-run' },
              style: 'primary',
              action_id: `approve_rerun_${input.testId}`,
              value: JSON.stringify({ testId: input.testId, threadTs: input.threadTs, channelId: input.channelId }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              action_id: `deny_rerun_${input.testId}`,
              value: input.testId,
            },
          ],
        },
      ],
    });

    return `Rerun confirmation posted to thread (ts=${result.ts}). Waiting for human approval — do NOT call run_cypress_test until approved.`;
  } catch (err) {
    return `Failed to post rerun confirmation: ${(err as Error).message}`;
  }
}

// ---- Claude tool definitions ----

export const CYPRESS_RUNNER_TOOL_DEFINITIONS = [
  {
    name: 'request_rerun_confirmation' as const,
    description:
      'Post a Slack message asking a human to approve re-running a specific Cypress test. ' +
      'You MUST call this and receive approval BEFORE calling run_cypress_test. ' +
      'Provide a clear reason why you want to re-run the test (e.g., "flaky test — want to check if it passes on retry").',
    input_schema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string' as const, description: 'Slack channel ID' },
        threadTs: { type: 'string' as const, description: 'Thread timestamp to reply to' },
        testId: { type: 'string' as const, description: 'Test ID to re-run (e.g., FR-020-001)' },
        reason: { type: 'string' as const, description: 'Why you want to re-run this test' },
      },
      required: ['channelId', 'threadTs', 'testId', 'reason'],
    },
  },
  {
    name: 'run_cypress_test' as const,
    description:
      'Run a single Cypress spec file headlessly and return pass/fail results. ' +
      'IMPORTANT: Only call this AFTER receiving human approval via request_rerun_confirmation. ' +
      'Takes ~1-3 minutes. Returns test status, pass/fail counts, and failure details if any.',
    input_schema: {
      type: 'object' as const,
      properties: {
        testId: { type: 'string' as const, description: 'Test ID to run (e.g., FR-020-001). Must match a spec file.' },
      },
      required: ['testId'],
    },
  },
];

export type CypressRunnerToolName = (typeof CYPRESS_RUNNER_TOOL_DEFINITIONS)[number]['name'];
