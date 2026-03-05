#!/usr/bin/env ts-node
/**
 * Slack Notification Script (Phase 1 — PoC)
 *
 * Reads cypress/results/sheets-report.json, filters for FAILED tests,
 * and posts structured notifications to a Slack channel using Block Kit.
 *
 * Each failure gets its own message; a summary is posted first.
 * Failures are tagged by classification:
 *   BACKEND  → mentions @backend-team
 *   FRONTEND → mentions @frontend-team
 *   INCONCLUSIVE → mentions both
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

/**
 * Extract a short, readable error summary from the full error stack.
 * Returns the first meaningful line, truncated to maxLen.
 */
function summarizeError(errorStack: string, maxLen = 200): string {
  if (!errorStack) return 'No error details captured';
  const firstLine = errorStack.split('\n')[0] || errorStack;
  return firstLine.length > maxLen ? firstLine.substring(0, maxLen) + '...' : firstLine;
}

/**
 * Extract the classification type (BACKEND/FRONTEND/INCONCLUSIVE) from
 * the formatted errorClassification string.
 */
function extractClassificationType(
  classification: string
): 'BACKEND' | 'FRONTEND' | 'INCONCLUSIVE' {
  if (classification.startsWith('BACKEND')) return 'BACKEND';
  if (classification.startsWith('FRONTEND')) return 'FRONTEND';
  return 'INCONCLUSIVE';
}

/**
 * Build a mention string based on classification type and configured group IDs.
 */
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

/**
 * Get an emoji for the classification type.
 */
function getClassificationEmoji(classificationType: string): string {
  switch (classificationType) {
    case 'BACKEND':
      return ':gear:';
    case 'FRONTEND':
      return ':art:';
    case 'INCONCLUSIVE':
    default:
      return ':grey_question:';
  }
}

/**
 * Build the GitHub Actions URL if env vars are available.
 */
function getActionsUrl(): string | null {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null;
}

// ---------------------------------------------------------------------------
// Slack Message Builders
// ---------------------------------------------------------------------------

/**
 * Build the summary message blocks (posted first to the channel).
 */
function buildSummaryBlocks(
  reportData: ReportData,
  failedResults: TestResult[]
): KnownBlock[] {
  const { summary } = reportData;
  const passRate = ((summary.passed / summary.totalTests) * 100).toFixed(1);
  const actionsUrl = getActionsUrl();

  const failureList = failedResults
    .map((r) => {
      const classType = extractClassificationType(r.errorClassification);
      const emoji = getClassificationEmoji(classType);
      return `${emoji} \`${r.testId}\` — ${r.description} (*${classType}*)`;
    })
    .join('\n');

  const links: string[] = [];
  if (actionsUrl) links.push(`<${actionsUrl}|:package: GitHub Actions>`);

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `:test_tube: QA Run Complete — ${summary.failed > 0 ? `${summary.failed} Failure${summary.failed > 1 ? 's' : ''}` : 'All Passed'}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Total Tests:*\n${summary.totalTests}` },
        { type: 'mrkdwn', text: `*Pass Rate:*\n${passRate}%` },
        {
          type: 'mrkdwn',
          text: `*Passed:*\n:large_green_circle: ${summary.passed}`,
        },
        {
          type: 'mrkdwn',
          text: `*Failed:*\n:red_circle: ${summary.failed}`,
        },
      ],
    },
    { type: 'divider' },
  ];

  if (failedResults.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Failed Tests:*\n${failureList}` },
    });
  }

  if (links.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: links.join('  |  ') + `  |  ${reportData.generatedAt}`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build the per-failure message blocks (one message per failed test).
 */
function buildFailureBlocks(result: TestResult): {
  blocks: KnownBlock[];
  text: string;
} {
  const classType = extractClassificationType(result.errorClassification);
  const classEmoji = getClassificationEmoji(classType);
  const mention = getMention(classType);
  const errorSummary = summarizeError(result.errorStack);

  // Extract evidence and likely cause from the formatted classification
  const classLines = result.errorClassification.split('\n').filter((l) => l.trim());
  const evidenceLines = classLines
    .filter((l) => l.trim().startsWith('•'))
    .map((l) => l.trim())
    .slice(0, 3);
  const causeIdx = classLines.findIndex((l) => l.includes('Likely Cause:'));
  const likelyCause =
    causeIdx >= 0
      ? classLines
          .slice(causeIdx + 1)
          .map((l) => l.trim())
          .join(' ')
          .trim()
      : '';

  // Count steps
  const stepCount = (result.stepsToReproduce.match(/^\d+\./gm) || []).length;

  // Build action buttons
  const actionElements: Array<{
    type: 'button';
    text: { type: 'plain_text'; text: string; emoji: boolean };
    url: string;
    action_id: string;
  }> = [];

  // Only add buttons with real URLs (not HYPERLINK formulas)
  const screenshotUrl = result.screenshotUrl?.match(/HYPERLINK\("([^"]+)"/)?.[1];
  const videoUrl = result.videoUrl?.match(/HYPERLINK\("([^"]+)"/)?.[1];

  if (screenshotUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: ':frame_with_picture: Screenshot', emoji: true },
      url: screenshotUrl,
      action_id: `screenshot_${result.testId}`,
    });
  }
  if (videoUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: ':movie_camera: Video', emoji: true },
      url: videoUrl,
      action_id: `video_${result.testId}`,
    });
  }
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `:red_circle: ${result.testId} — ${result.description}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Classification:*\n${classEmoji} \`${classType}\``,
        },
        {
          type: 'mrkdwn',
          text: `*Duration:*\n${(result.duration / 1000).toFixed(1)}s`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:*\n\`\`\`${errorSummary}\`\`\``,
      },
    },
  ];

  // Evidence section
  if (evidenceLines.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Evidence:*\n${evidenceLines.join('\n')}`,
      },
    });
  }

  // Likely cause
  if (likelyCause) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Likely Cause:*\n${likelyCause}`,
      },
    });
  }

  // Context line
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${stepCount} steps captured | ${result.browser} | ${result.environment} | ${result.timestamp}`,
      },
    ],
  });

  // Action buttons
  if (actionElements.length > 0) {
    blocks.push({ type: 'actions', elements: actionElements });
  }

  // Mention line (if configured)
  if (mention) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `cc: ${mention}` },
    });
  }

  return {
    blocks,
    text: `Test Failed: ${result.testId} — ${result.description} (${classType})`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function notifySlack(): Promise<void> {
  console.log(':bell: Slack Notification Script\n');

  // ---- Validate env ----
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!token) {
    console.error('SLACK_BOT_TOKEN not set. Skipping Slack notifications.');
    console.log('Set SLACK_BOT_TOKEN in .env or GitHub Secrets.');
    // In PoC mode, print what would be sent instead of exiting
    if (!fs.existsSync(REPORT_FILE)) {
      console.error(`Report file not found: ${REPORT_FILE}`);
      process.exit(1);
    }
    const reportData: ReportData = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'));
    const failedResults = reportData.results.filter((r) => r.status === 'FAILED');
    console.log(`\n--- DRY RUN (no SLACK_BOT_TOKEN) ---`);
    console.log(
      `Would post summary: ${reportData.summary.totalTests} tests, ${reportData.summary.failed} failed`
    );
    for (const result of failedResults) {
      const classType = extractClassificationType(result.errorClassification);
      console.log(`\nWould post failure: ${result.testId} — ${result.description}`);
      console.log(`  Classification: ${classType}`);
      console.log(`  Error: ${summarizeError(result.errorStack, 100)}`);
      console.log(`  Mention: ${getMention(classType) || '(no groups configured)'}`);
    }
    console.log(`\n--- END DRY RUN ---`);
    return;
  }

  if (!channelId) {
    console.error('SLACK_CHANNEL_ID not set.');
    process.exit(1);
  }

  // ---- Load report ----
  if (!fs.existsSync(REPORT_FILE)) {
    console.error(`Report file not found: ${REPORT_FILE}`);
    console.log('Run: npm run sheets:generate');
    process.exit(1);
  }

  const reportData: ReportData = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'));
  console.log(`Loaded ${reportData.results.length} test results`);

  const failedResults = reportData.results.filter((r) => r.status === 'FAILED');
  const notifyMode = process.env.SLACK_NOTIFY_MODE || 'failures-only';

  if (failedResults.length === 0 && notifyMode === 'failures-only') {
    console.log('All tests passed. SLACK_NOTIFY_MODE is "failures-only". Nothing to post.');
    return;
  }

  // ---- Initialize Slack client ----
  const slack = new WebClient(token);

  // ---- Post summary message ----
  console.log('\nPosting summary message...');
  const summaryBlocks = buildSummaryBlocks(reportData, failedResults);
  const summaryResult = await slack.chat.postMessage({
    channel: channelId,
    blocks: summaryBlocks,
    text: `QA Run: ${reportData.summary.totalTests} tests, ${reportData.summary.failed} failed`,
  });

  console.log(`  Summary posted: ts=${summaryResult.ts}`);

  // Persist summary Slack metadata to QA API
  const apiUrl = process.env.QA_API_URL;
  const runId = process.env.GITHUB_RUN_ID;
  if (apiUrl && runId && summaryResult.ts) {
    try {
      await fetch(`${apiUrl}/api/v1/runs/${runId}/slack`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, summaryTs: summaryResult.ts }),
      });
      console.log('  Run Slack metadata persisted to API');
    } catch {
      console.warn('  Could not persist run Slack metadata to API');
    }
  }

  // Rate limit: pause before posting per-failure messages (Slack Tier 1)
  await new Promise((resolve) => setTimeout(resolve, 1100));

  // ---- Post per-failure messages ----
  const threadMap: SlackThreadMap = {};

  try {
    for (const result of failedResults) {
      try {
        console.log(`\nPosting failure: ${result.testId}...`);

        const { blocks, text } = buildFailureBlocks(result);

        const msgResult = await slack.chat.postMessage({
          channel: channelId,
          blocks,
          text,
        });

        if (msgResult.ts) {
          threadMap[result.testId] = {
            channelId,
            threadTs: msgResult.ts,
          };

          // Rate limit: pause before thread reply
          await new Promise((resolve) => setTimeout(resolve, 1100));

          // Post steps to reproduce as a thread reply (keeps the main message clean)
          if (result.stepsToReproduce) {
            await slack.chat.postMessage({
              channel: channelId,
              thread_ts: msgResult.ts,
              text: `*Steps to Reproduce:*\n\`\`\`\n${result.stepsToReproduce}\n\`\`\``,
            });
          }

          console.log(`  Posted: ts=${msgResult.ts}`);
        }

        // Rate limit: 1 message per second (Slack Tier 1)
        await new Promise((resolve) => setTimeout(resolve, 1100));
      } catch (msgError) {
        console.error(`  Failed to post notification for ${result.testId}:`, msgError);
        // Continue with remaining failures
      }
    }
  } finally {
    // ---- Save thread map for Phase 2 agent (even on partial failure) ----
    fs.writeFileSync(THREAD_MAP_FILE, JSON.stringify(threadMap, null, 2));
    console.log(`\nThread map saved: ${THREAD_MAP_FILE}`);
    console.log(`  ${Object.keys(threadMap).length} threads created`);

    // Persist per-failure Slack thread metadata to QA API
    if (apiUrl && runId) {
      try {
        const resultsRes = await fetch(
          `${apiUrl}/api/v1/runs/${runId}/results?status=FAILED`
        );
        if (resultsRes.ok) {
          const dbResults = (await resultsRes.json()) as Array<{
            _id: string;
            testId: string;
          }>;
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
          console.log('  Failure Slack metadata persisted to API');
        }
      } catch {
        console.warn('  Could not persist failure Slack metadata to API');
      }
    }
  }

  console.log('\nSlack notifications complete.');
}

// Run
notifySlack().catch((error) => {
  console.error('Failed to send Slack notifications:', error);
  process.exit(1);
});
