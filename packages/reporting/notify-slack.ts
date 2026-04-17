#!/usr/bin/env ts-node
/**
 * Slack Notification Script (Phase 1)
 *
 * Posts a summary message, then one top-level message per failure (title only).
 * Error details, steps, and agent findings all go into each failure's thread.
 *
 * Usage:
 *   npx tsx cypress/scripts/notify-slack.ts
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN   — Bot OAuth token (xoxb-...)
 *   SLACK_CHANNEL_ID  — Target channel ID
 *
 * Optional env vars:
 *   SLACK_BACKEND_GROUP_ID  — Slack user group ID for @backend-team
 *   SLACK_FRONTEND_GROUP_ID — Slack user group ID for @frontend-team
 *   GITHUB_RUN_ID           — For linking to the Actions run
 *   GITHUB_REPOSITORY       — For linking to the Actions run
 *   SLACK_NOTIFY_MODE       — "failures-only" (default) or "always"
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { WebClient, type KnownBlock } from '@slack/web-api';
import type { TestResult } from '../support/types/test-results';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RESULTS_DIR = path.join(process.cwd(), 'cypress/results');
const REPORT_FILE = path.join(RESULTS_DIR, 'sheets-report.json');
const THREAD_MAP_FILE = path.join(RESULTS_DIR, 'slack-threads.json');

interface ReportData {
  generatedAt: string;
  artifactBaseUrl?: string;
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    frGroups: number;
  };
  results: TestResult[];
}

interface SlackThreadMap {
  [testId: string]: {
    channelId: string;
    threadTs: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeError(errorStack: string, maxLen = 200): string {
  if (!errorStack) return 'No error details captured';
  const firstLine = errorStack.split('\n')[0] || errorStack;
  return firstLine.length > maxLen ? firstLine.substring(0, maxLen) + '...' : firstLine;
}

function extractClassificationType(
  classification: string
): 'BACKEND' | 'FRONTEND' | 'INCONCLUSIVE' {
  if (classification.startsWith('BACKEND')) return 'BACKEND';
  if (classification.startsWith('FRONTEND')) return 'FRONTEND';
  return 'INCONCLUSIVE';
}

function getMention(classificationType: string): string {
  const backendGroupId = process.env.SLACK_BACKEND_GROUP_ID;
  const frontendGroupId = process.env.SLACK_FRONTEND_GROUP_ID;

  if (!backendGroupId && !frontendGroupId) return '';

  switch (classificationType) {
    case 'BACKEND':
      return backendGroupId ? `<!subteam^${backendGroupId}>` : '';
    case 'FRONTEND':
      return frontendGroupId ? `<!subteam^${frontendGroupId}>` : '';
    case 'INCONCLUSIVE':
    default: {
      const mentions: string[] = [];
      if (backendGroupId) mentions.push(`<!subteam^${backendGroupId}>`);
      if (frontendGroupId) mentions.push(`<!subteam^${frontendGroupId}>`);
      return mentions.join(' ');
    }
  }
}

function getActionsUrl(): string | null {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null;
}

// ---------------------------------------------------------------------------
// Slack Message Builders
// ---------------------------------------------------------------------------

function buildSummaryBlocks(
  reportData: ReportData,
  failedResults: TestResult[]
): KnownBlock[] {
  const { summary } = reportData;
  const passRate = ((summary.passed / summary.totalTests) * 100).toFixed(1);
  const actionsUrl = getActionsUrl();

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*QA Run Complete* — ${summary.failed > 0 ? `${summary.failed} failure${summary.failed > 1 ? 's' : ''}` : 'all passed'}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Total:* ${summary.totalTests}` },
        { type: 'mrkdwn', text: `*Pass Rate:* ${passRate}%` },
        { type: 'mrkdwn', text: `*Passed:* ${summary.passed}` },
        { type: 'mrkdwn', text: `*Failed:* ${summary.failed}` },
      ],
    },
  ];

  if (failedResults.length > 0) {
    const failureList = failedResults
      .map((r) => {
        const classType = extractClassificationType(r.errorClassification);
        return `\`${r.testId}\` ${r.description} — ${classType}`;
      })
      .join('\n');

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Failures:*\n${failureList}` },
    });
  }

  const contextParts: string[] = [reportData.generatedAt];
  if (actionsUrl) contextParts.push(`<${actionsUrl}|GitHub Actions>`);

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: contextParts.join('  |  ') }],
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function notifySlack(): Promise<void> {
  console.log('Slack Notification Script\n');

  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!token) {
    console.error('SLACK_BOT_TOKEN not set. Skipping.');
    if (!fs.existsSync(REPORT_FILE)) {
      console.error(`Report file not found: ${REPORT_FILE}`);
      process.exit(1);
    }
    const reportData: ReportData = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'));
    const failedResults = reportData.results.filter((r) => r.status === 'FAILED');
    console.log(`--- DRY RUN ---`);
    console.log(`Summary: ${reportData.summary.totalTests} tests, ${reportData.summary.failed} failed`);
    for (const r of failedResults) {
      console.log(`  ${r.testId} — ${r.description}`);
    }
    console.log(`--- END DRY RUN ---`);
    return;
  }

  if (!channelId) {
    console.error('SLACK_CHANNEL_ID not set.');
    process.exit(1);
  }

  if (!fs.existsSync(REPORT_FILE)) {
    console.error(`Report file not found: ${REPORT_FILE}`);
    process.exit(1);
  }

  const reportData: ReportData = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'));
  console.log(`Loaded ${reportData.results.length} test results`);

  const failedResults = reportData.results.filter((r) => r.status === 'FAILED');
  const notifyMode = process.env.SLACK_NOTIFY_MODE || 'failures-only';

  if (failedResults.length === 0 && notifyMode === 'failures-only') {
    console.log('All tests passed. Nothing to post.');
    return;
  }

  const slack = new WebClient(token);
  const apiUrl = process.env.QA_API_URL;
  const runId = process.env.GITHUB_RUN_ID;

  // ---- Post summary ----
  console.log('Posting summary...');
  const summaryBlocks = buildSummaryBlocks(reportData, failedResults);
  const summaryResult = await slack.chat.postMessage({
    channel: channelId,
    blocks: summaryBlocks,
    text: `QA Run: ${reportData.summary.totalTests} tests, ${reportData.summary.failed} failed`,
  });
  console.log(`  Summary: ts=${summaryResult.ts}`);

  if (apiUrl && runId && summaryResult.ts) {
    try {
      await fetch(`${apiUrl}/api/v1/runs/${runId}/slack`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, summaryTs: summaryResult.ts }),
      });
    } catch { /* ignore */ }
  }

  // ---- Post one top-level message per failure (title only) ----
  // Details go into the thread under each failure message.
  const threadMap: SlackThreadMap = {};

  try {
    for (const result of failedResults) {
      await new Promise((resolve) => setTimeout(resolve, 1200));

      try {
        const classType = extractClassificationType(result.errorClassification);
        const mention = getMention(classType);
        const titleText = `*${result.testId}* — ${result.description}  |  ${classType}`;

        // Top-level message: title only
        console.log(`  Posting: ${result.testId}...`);
        const titleResult = await slack.chat.postMessage({
          channel: channelId,
          text: `${result.testId} — ${result.description} (${classType})`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: mention ? `${titleText}\ncc: ${mention}` : titleText },
            },
          ],
        });

        if (!titleResult.ts) continue;

        threadMap[result.testId] = {
          channelId,
          threadTs: titleResult.ts,
        };
        console.log(`    Title: ts=${titleResult.ts}`);

        // Thread reply 1: error details
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const errorSummary = summarizeError(result.errorStack);
        const classLines = result.errorClassification.split('\n').filter((l) => l.trim());
        const causeIdx = classLines.findIndex((l) => l.includes('Likely Cause:'));
        const likelyCause = causeIdx >= 0
          ? classLines.slice(causeIdx + 1).map((l) => l.trim()).join(' ').trim()
          : '';

        let detailText = `*Error:*\n\`\`\`${errorSummary}\`\`\``;
        if (likelyCause) detailText += `\n*Likely Cause:* ${likelyCause}`;
        detailText += `\n*Duration:* ${(result.duration / 1000).toFixed(1)}s  |  *Retries:* ${result.retryCount}`;

        await slack.chat.postMessage({
          channel: channelId,
          thread_ts: titleResult.ts,
          text: `Error: ${errorSummary}`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: detailText } },
          ],
        });

        // Thread reply 2: steps to reproduce (if available)
        if (result.stepsToReproduce && result.stepsToReproduce !== 'No steps recorded') {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          await slack.chat.postMessage({
            channel: channelId,
            thread_ts: titleResult.ts,
            text: `Steps to Reproduce:\n${result.stepsToReproduce}`,
          });
        }
      } catch (msgError) {
        console.error(`  Failed to post ${result.testId}:`, msgError);
      }
    }
  } finally {
    // Save thread map — Mark/Sweep use this to post into the right thread
    fs.writeFileSync(THREAD_MAP_FILE, JSON.stringify(threadMap, null, 2));
    console.log(`\nThread map saved: ${Object.keys(threadMap).length} threads`);

    // Persist to API
    if (apiUrl && runId) {
      try {
        const resultsRes = await fetch(`${apiUrl}/api/v1/runs/${runId}/results?status=FAILED`);
        if (resultsRes.ok) {
          const dbResults = (await resultsRes.json()) as Array<{ _id: string; testId: string }>;
          for (const dbResult of dbResults) {
            const thread = threadMap[dbResult.testId];
            if (thread) {
              await fetch(`${apiUrl}/api/v1/results/${dbResult._id}/slack`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(thread),
              });
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  console.log('Done.');
}

notifySlack().catch((error) => {
  console.error('Failed to send Slack notifications:', error);
  process.exit(1);
});
