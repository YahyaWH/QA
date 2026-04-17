#!/usr/bin/env ts-node
/**
 * Garbage Collection — Mark Phase
 *
 * Mark traverses failed tests and identifies root causes (the "garbage").
 * HIGH-confidence findings are posted to Slack with [Approve Fix] / [Skip]
 * buttons. Humans approve in the morning; Sweep (gc/sweep.ts)
 * is spawned by the Slack webhook handler on approval.
 *
 * Usage: npx tsx cypress/scripts/gc/mark.ts
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY       — Claude API key
 *   WASTEHERO_GITHUB_TOKEN  — GitHub PAT (read access)
 *   WASTEHERO_REPO          — App repo in owner/name format
 *
 * Optional env vars:
 *   QA_API_URL              — QA API base URL (default: http://localhost:3001)
 *   SLACK_BOT_TOKEN         — For Slack thread replies + approval buttons
 *   SLACK_CHANNEL_ID        — Target Slack channel
 *   AGENT_MODEL             — Claude model (default: claude-haiku-4-5-20251001)
 *   AGENT_MAX_TOKENS        — Max output tokens (default: 4096)
 *   AGENT_MAX_TOOL_CALLS    — Max tool calls per investigation (default: 10)
 *   AGENT_CONCURRENCY       — Parallel investigations (default: 3)
 *   GITHUB_RUN_ID           — CI run ID
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { WebClient, type KnownBlock } from '@slack/web-api';

// Mark phase tools
import {
  githubSearchCode, githubGetFile, githubGetCommits, githubGetPr,
  GITHUB_TOOL_DEFINITIONS,
} from './tools/github-tools';
import { getTestHistory, getFlakyTests, HISTORY_TOOL_DEFINITIONS } from './tools/history-tool';
import { analyzeDom, DOM_TOOL_DEFINITIONS } from './tools/dom-analyzer-tool';
import { slackReply, SLACK_TOOL_DEFINITIONS } from './tools/slack-tools';
import {
  runCypressTest, requestRerunConfirmation,
  CYPRESS_RUNNER_TOOL_DEFINITIONS,
} from './tools/cypress-runner-tool';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RESULTS_DIR = path.join(process.cwd(), 'cypress/results');
const REPORT_FILE = path.join(RESULTS_DIR, 'sheets-report.json');
const THREAD_MAP_FILE = path.join(RESULTS_DIR, 'slack-threads.json');
const INVESTIGATIONS_DIR = path.join(RESULTS_DIR, 'investigations');
const PLATFORM_REF_PATH = path.join(process.cwd(), 'onboarding-output/wastehero-platform-reference.md');

// Load the WasteHero platform reference if available — gives the agent
// accurate knowledge of routes, components, architecture, and UI patterns.
let PLATFORM_REFERENCE = '';
try {
  PLATFORM_REFERENCE = fs.readFileSync(PLATFORM_REF_PATH, 'utf8');
  console.log(`[mark] Loaded platform reference (${(PLATFORM_REFERENCE.length / 1024).toFixed(0)} KB)`);
} catch {
  console.log('[mark] Platform reference not found — agent will rely on GitHub search only');
}

const MODEL = process.env.AGENT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = parseInt(process.env.AGENT_MAX_TOKENS || '4096', 10);
const MAX_TOOL_CALLS = parseInt(process.env.AGENT_MAX_TOOL_CALLS || '10', 10);
const CONCURRENCY = parseInt(process.env.AGENT_CONCURRENCY || '1', 10);

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface FailedTest {
  testId: string;
  frNumber: string;
  description: string;
  status: string;
  duration: number;
  errorStack: string;
  errorClassification: string;
  stepsToReproduce: string;
  consoleLogs: string;
  networkRequests: string;
  domStateAtFailure: string;
  screenshotUrl: string;
  videoUrl: string;
  environment: string;
  browser: string;
  viewport: string;
}

/**
 * Normalize a failure record from either source:
 *   - API (structured: error.stack, error.classification, steps[], etc.)
 *   - Local sheets-report.json (flat strings: errorStack, errorClassification, etc.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeFailure(raw: any): FailedTest {
  // Already flat (from sheets-report.json) — pass through
  if (raw.errorStack !== undefined) return raw as FailedTest;

  // Structured (from API) — flatten
  const err = raw.error || {};
  const cls = err.classification || {};
  const steps: { stepNumber?: number; description?: string }[] = raw.steps || [];
  const logs: { type?: string; message?: string }[] = raw.consoleLogs || [];
  const reqs: { method?: string; url?: string; status?: number; duration?: number }[] = raw.networkRequests || [];

  return {
    testId: raw.testId,
    frNumber: raw.frNumber,
    description: raw.description,
    status: raw.status,
    duration: raw.duration,
    errorStack: err.stack || '',
    errorClassification: cls.type
      ? `${cls.type}: ${cls.likelyCause || ''}\nEvidence: ${(cls.evidence || []).join('; ')}`
      : '',
    stepsToReproduce: steps
      .map((s) => `${s.stepNumber}. ${s.description}`)
      .join('\n') || '',
    consoleLogs: logs
      .map((l) => `[${l.type}] ${l.message}`)
      .join('\n') || '',
    networkRequests: reqs
      .map((r) => `${r.method} ${r.url} → ${r.status} (${r.duration}ms)`)
      .join('\n') || '',
    domStateAtFailure: err.domStateAtFailure || '',
    screenshotUrl: raw.screenshotUrl || '',
    videoUrl: raw.videoUrl || '',
    environment: raw.environment || '',
    browser: raw.browser || '',
    viewport: raw.viewport || '',
  };
}

interface SlackThread {
  channelId: string;
  threadTs: string;
}

interface InvestigationResult {
  testId: string;
  runId: string;
  rootCause: string;
  suspectFiles: Array<{ path: string; lines?: string; reason: string }>;
  recentCommits: Array<{ sha: string; message: string; author: string; date: string }>;
  category: 'regression' | 'flaky' | 'new_bug' | 'test_issue' | 'unknown';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendedAction: string;
  agentModel: string;
  tokensUsed: { input: number; output: number };
  toolCallCount: number;
  durationMs: number;
  slackReplyTs?: string;
}

// =========================================================================
// MARK — AUDIT & IDENTIFY
// =========================================================================

const AUDIT_SYSTEM_PROMPT = `You are Mark, the audit agent for the WasteHero E2E test pipeline (project: Garbage Collection).
Your job is to analyze failed E2E test results and determine the root cause.

You receive structured failure context including:
- Error classification (BACKEND/FRONTEND/INCONCLUSIVE) with evidence
- Full error stack trace
- Network requests (with status codes and timing)
- Browser console logs
- Steps to reproduce
- DOM snapshot at failure
- Screenshot and video links

${PLATFORM_REFERENCE ? `
=== WASTEHERO PLATFORM REFERENCE ===
Use this reference to understand the application architecture, route structure, UI patterns,
sidebar navigation, and component hierarchy. This is authoritative — prefer it over guessing
when identifying which page/route/component a failure relates to.

${PLATFORM_REFERENCE}
=== END PLATFORM REFERENCE ===
` : ''}

Investigation process:
1. Start with the error classification — this is your pre-triage
2. Cross-reference the failing test's URL/page against the Platform Reference routes to identify the exact component area
3. Search the WasteHero codebase with GitHub tools — use the Source Structure and route map from the reference to narrow your search
4. Identify specific file(s) and line(s) responsible
5. Check recent commits to suspect files
6. Check historical test results (regression vs flaky vs new)
7. Assess confidence (HIGH/MEDIUM/LOW)

Your FINAL message must be a JSON object (no markdown fences):
{
  "rootCause": "Concise root cause (2-3 sentences)",
  "suspectFiles": [{"path": "src/...", "lines": "42-50", "reason": "..."}],
  "recentCommits": [{"sha": "abc1234", "message": "...", "author": "...", "date": "..."}],
  "category": "regression|flaky|new_bug|test_issue|unknown",
  "confidence": "HIGH|MEDIUM|LOW",
  "recommendedAction": "What to do next"
}

Re-running tests:
- If you suspect a test is flaky (intermittent failure), you can re-run it to verify
- FIRST call request_rerun_confirmation to ask a human for approval via Slack
- THEN call run_cypress_test — it will wait for approval before executing
- Use the re-run result to adjust your confidence (e.g., passes on retry → likely flaky)
- Only request re-runs when it adds diagnostic value (e.g., flaky suspicion, environment issue)
- Max 1 re-run per investigation

Rules:
- Be specific — name files, functions, line numbers
- Use the Platform Reference to map errors to exact routes and components (e.g. a failure on /app/tickets maps to Tickets section, route defined in src/components/main/routes/...)
- If uncertain, say so (LOW confidence is fine)
- Always check history before saying "new bug"
- Consider that the TEST might be wrong
- Post analysis to Slack thread via slack_reply when done
- Max ${MAX_TOOL_CALLS} tool calls`;

const AUDIT_TOOLS: Anthropic.Tool[] = [
  ...GITHUB_TOOL_DEFINITIONS,
  ...HISTORY_TOOL_DEFINITIONS,
  ...DOM_TOOL_DEFINITIONS,
  ...SLACK_TOOL_DEFINITIONS,
  ...CYPRESS_RUNNER_TOOL_DEFINITIONS,
].map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
}));

async function executeAuditTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'github_search_code':
      return (await githubSearchCode(input as Parameters<typeof githubSearchCode>[0])) as string;
    case 'github_get_file':
      return (await githubGetFile(input as Parameters<typeof githubGetFile>[0])) as string;
    case 'github_get_commits':
      return (await githubGetCommits(input as Parameters<typeof githubGetCommits>[0])) as string;
    case 'github_get_pr':
      return (await githubGetPr(input as Parameters<typeof githubGetPr>[0])) as string;
    case 'get_test_history':
      return (await getTestHistory(input as Parameters<typeof getTestHistory>[0])) as string;
    case 'get_flaky_tests':
      return (await getFlakyTests(input as Parameters<typeof getFlakyTests>[0])) as string;
    case 'analyze_dom':
      return (await analyzeDom(input as Parameters<typeof analyzeDom>[0])) as string;
    case 'slack_reply':
      return (await slackReply(input as Parameters<typeof slackReply>[0])) as string;
    case 'request_rerun_confirmation':
      return (await requestRerunConfirmation(input as Parameters<typeof requestRerunConfirmation>[0])) as string;
    case 'run_cypress_test':
      return (await runCypressTest(input as Parameters<typeof runCypressTest>[0])) as string;
    default:
      return `Unknown tool: ${name}`;
  }
}

async function runAuditAgent(
  client: Anthropic,
  failure: FailedTest,
  slackThread: SlackThread | undefined,
  runId: string
): Promise<InvestigationResult> {
  const startTime = Date.now();
  let toolCallCount = 0;
  let totalInput = 0;
  let totalOutput = 0;

  const userPrompt = [
    `Investigate this failed test:`,
    ``,
    `Test ID: ${failure.testId}`,
    `FR: ${failure.frNumber}`,
    `Description: ${failure.description}`,
    `Duration: ${failure.duration}ms`,
    `Environment: ${failure.environment} | ${failure.browser} | ${failure.viewport}`,
    ``,
    `=== Error Classification ===`, failure.errorClassification || '(none)',
    ``, `=== Error Stack ===`, failure.errorStack || '(none)',
    ``, `=== Steps to Reproduce ===`, failure.stepsToReproduce || '(none)',
    ``, `=== Network Requests ===`, failure.networkRequests || '(none)',
    ``, `=== Console Logs ===`, failure.consoleLogs || '(none)',
    ``, `=== DOM State at Failure ===`, (failure.domStateAtFailure || '(none)').substring(0, 5000),
    ...(slackThread ? [
      ``, `=== Slack Thread ===`,
      `Channel: ${slackThread.channelId}`, `Thread: ${slackThread.threadTs}`,
      `Post your analysis to this thread via slack_reply.`,
    ] : []),
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];

  while (true) {
    let response: Anthropic.Message;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: AUDIT_SYSTEM_PROMPT,
          tools: AUDIT_TOOLS,
          messages,
        });
        break;
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status === 429 && attempt < 3) {
          const wait = Math.pow(2, attempt + 1) * 15_000; // 30s, 60s, 120s
          console.log(`    [${failure.testId}] rate limited, waiting ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    if (response.stop_reason === 'end_turn' || response.content.every((b) => b.type === 'text')) {
      const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text || '';
      return { testId: failure.testId, runId, ...parseAnalysis(text), agentModel: MODEL, tokensUsed: { input: totalInput, output: totalOutput }, toolCallCount, durationMs: Date.now() - startTime };
    }

    const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    if (toolCallCount + toolBlocks.length > MAX_TOOL_CALLS) {
      messages.push({ role: 'assistant', content: response.content });
      // Must provide a tool_result for EVERY tool_use block
      const limitResults: Anthropic.ToolResultBlockParam[] = toolBlocks.map((tb) => ({
        type: 'tool_result' as const,
        tool_use_id: tb.id,
        content: 'Tool limit reached. Provide final JSON analysis now.',
        is_error: true,
      }));
      messages.push({ role: 'user', content: limitResults });
      continue;
    }

    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolBlocks) {
      toolCallCount++;
      console.log(`    [${failure.testId}] audit: ${tool.name}`);
      const result = await executeAuditTool(tool.name, tool.input as Record<string, unknown>);
      results.push({ type: 'tool_result', tool_use_id: tool.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }
}

function parseAnalysis(text: string) {
  const defaults = {
    rootCause: 'Unable to determine root cause',
    suspectFiles: [] as InvestigationResult['suspectFiles'],
    recentCommits: [] as InvestigationResult['recentCommits'],
    category: 'unknown' as const,
    confidence: 'LOW' as const,
    recommendedAction: 'Manual investigation required',
  };
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return defaults;
    const parsed = JSON.parse(match[0]);
    return {
      rootCause: parsed.rootCause || defaults.rootCause,
      suspectFiles: parsed.suspectFiles || defaults.suspectFiles,
      recentCommits: parsed.recentCommits || defaults.recentCommits,
      category: parsed.category || defaults.category,
      confidence: parsed.confidence || defaults.confidence,
      recommendedAction: parsed.recommendedAction || defaults.recommendedAction,
    };
  } catch {
    return { ...defaults, rootCause: text.substring(0, 500) || defaults.rootCause };
  }
}

// =========================================================================
// CONCURRENCY HELPER
// =========================================================================

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// =========================================================================
// SLACK APPROVAL BUTTONS
// =========================================================================

async function postApprovalButtons(
  investigation: InvestigationResult,
  investigationId: string,
  slackThread: SlackThread | undefined
): Promise<void> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const channelId = slackThread?.channelId || process.env.SLACK_CHANNEL_ID;
  if (!slackToken || !channelId) {
    console.log(`  [approval] DRY RUN — would post buttons for ${investigation.testId} (${investigation.confidence})`);
    return;
  }

  const slack = new WebClient(slackToken);

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${investigation.testId}* — ${investigation.category.toUpperCase()}`,
          `*Confidence:* ${investigation.confidence}`,
          `*Root Cause:* ${investigation.rootCause.substring(0, 300)}`,
          investigation.suspectFiles.length > 0
            ? `*Suspect:* \`${investigation.suspectFiles[0].path}\`${investigation.suspectFiles.length > 1 ? ` (+${investigation.suspectFiles.length - 1})` : ''}`
            : '',
          `*Action:* ${investigation.recommendedAction.substring(0, 200)}`,
        ].filter(Boolean).join('\n'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve Fix' },
          style: 'primary',
          action_id: `approve_fix_${investigationId}`,
          value: investigationId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip' },
          action_id: `skip_fix_${investigationId}`,
          value: investigationId,
        },
      ],
    },
  ];

  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: slackThread?.threadTs,
    text: `Approval needed: ${investigation.testId} (${investigation.confidence} ${investigation.category})`,
    blocks,
  });
}

// =========================================================================
// MAIN PIPELINE
// =========================================================================

async function main(): Promise<void> {
  console.log('=== Garbage Collection: Mark Phase ===\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Exiting.');
    return;
  }
  if (!process.env.WASTEHERO_REPO) {
    console.error('WASTEHERO_REPO not set. Exiting.');
    return;
  }

  const client = new Anthropic();
  const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
  const apiUrl = process.env.QA_API_URL;

  // ---- Load failures ----
  let failures: FailedTest[] = [];
  if (apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/api/v1/results/failures/unanalyzed`);
      if (res.ok) {
        const raw = (await res.json()) as unknown[];
        failures = raw.map(normalizeFailure);
      }
    } catch { /* fall through */ }
  }
  if (failures.length === 0 && fs.existsSync(REPORT_FILE)) {
    const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'));
    failures = ((report.results as unknown[]).filter((r: any) => r.status === 'FAILED')).map(normalizeFailure);
  }
  if (failures.length === 0) {
    console.log('No failures to investigate. Pipeline complete.');
    return;
  }

  // ---- Load Slack threads ----
  let threadMap: Record<string, SlackThread> = {};
  if (fs.existsSync(THREAD_MAP_FILE)) {
    threadMap = JSON.parse(fs.readFileSync(THREAD_MAP_FILE, 'utf-8'));
  }

  // ================================================================
  // MARK: AUDIT & IDENTIFY
  // ================================================================
  console.log(`--- Mark: Scanning for failures ---`);
  console.log(`Investigating ${failures.length} failure(s), concurrency=${CONCURRENCY}\n`);

  const investigations = await runWithConcurrency(failures, CONCURRENCY, async (failure) => {
    console.log(`  [audit] ${failure.testId} — ${failure.description}`);
    try {
      const result = await runAuditAgent(client, failure, threadMap[failure.testId], runId);
      console.log(`  [audit] ${failure.testId} done — ${result.confidence} ${result.category}`);
      return result;
    } catch (err) {
      console.error(`  [audit] ${failure.testId} error:`, (err as Error).message);
      return {
        testId: failure.testId, runId,
        rootCause: `Investigation failed: ${(err as Error).message}`,
        suspectFiles: [], recentCommits: [],
        category: 'unknown' as const, confidence: 'LOW' as const,
        recommendedAction: 'Manual investigation required',
        agentModel: MODEL, tokensUsed: { input: 0, output: 0 },
        toolCallCount: 0, durationMs: 0,
      };
    }
  });

  // Save audit results locally
  fs.mkdirSync(INVESTIGATIONS_DIR, { recursive: true });
  for (const inv of investigations) {
    fs.writeFileSync(path.join(INVESTIGATIONS_DIR, `${inv.testId}.json`), JSON.stringify(inv, null, 2));
  }

  // Persist to API and collect investigation IDs
  const investigationIds: Record<string, string> = {};
  if (apiUrl) {
    for (const inv of investigations) {
      try {
        const res = await fetch(`${apiUrl}/api/v1/investigations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(inv),
        });
        if (res.ok) {
          const doc = (await res.json()) as { _id: string };
          investigationIds[inv.testId] = doc._id;
        }
      } catch { /* ignore */ }
    }
  }

  // Audit summary
  const highConf = investigations.filter((i) => i.confidence === 'HIGH').length;
  const medConf = investigations.filter((i) => i.confidence === 'MEDIUM').length;
  const totalAuditTokens = investigations.reduce((s, i) => s + i.tokensUsed.input + i.tokensUsed.output, 0);

  console.log(`\nMark Summary: ${investigations.length} investigated, ${highConf} HIGH, ${medConf} MEDIUM, ${totalAuditTokens} tokens\n`);

  // ================================================================
  // POST APPROVAL BUTTONS TO SLACK
  // ================================================================
  const fixable = investigations.filter(
    (inv) => inv.confidence === 'HIGH' &&
      ['regression', 'test_issue', 'new_bug'].includes(inv.category) &&
      inv.suspectFiles.length > 0
  );

  if (fixable.length === 0) {
    console.log('No HIGH-confidence fixable findings. Pipeline complete.');
    return;
  }

  console.log(`--- Posting ${fixable.length} approval button(s) to Slack ---\n`);

  for (const inv of fixable) {
    const investigationId = investigationIds[inv.testId];
    if (!investigationId) {
      console.log(`  [approval] ${inv.testId} — no API ID, skipping button`);
      continue;
    }

    try {
      await postApprovalButtons(inv, investigationId, threadMap[inv.testId]);
      console.log(`  [approval] ${inv.testId} — button posted`);
    } catch (err) {
      console.error(`  [approval] ${inv.testId} error:`, (err as Error).message);
    }
  }

  console.log('\n=== Mark Phase Complete — awaiting human approval in Slack for Sweep ===');
}

main().catch((error) => {
  console.error('Pipeline failed:', error);
  process.exit(1);
});
