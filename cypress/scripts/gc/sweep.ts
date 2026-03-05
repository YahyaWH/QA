#!/usr/bin/env ts-node
/**
 * Garbage Collection — Sweep Phase
 * Spawned by the Slack webhook when a human approves a fix.
 *
 * Reads the approved investigation from MongoDB, creates a minimal fix,
 * and posts real-time progress to the Slack thread.
 *
 * Required env vars:
 *   INVESTIGATION_ID        — MongoDB _id of the approved investigation
 *   ANTHROPIC_API_KEY       — Claude API key
 *   WASTEHERO_GITHUB_TOKEN  — GitHub PAT (write access for PRs)
 *   WASTEHERO_REPO          — App repo in owner/name format
 *
 * Optional env vars:
 *   QA_API_URL              — QA API base URL (default: http://localhost:3001)
 *   SLACK_BOT_TOKEN         — For Slack thread updates
 *   SLACK_THREAD_CHANNEL    — Channel to post progress to
 *   SLACK_THREAD_TS         — Thread timestamp to reply to
 *   AGENT_MODEL             — Claude model (default: claude-sonnet-4-6)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import Anthropic from '@anthropic-ai/sdk';

import {
  githubGetFile,
  GITHUB_TOOL_DEFINITIONS,
} from './tools/github-tools';
import {
  githubCreateBranch, githubUpdateFile, githubCreatePr,
  GITHUB_WRITE_TOOL_DEFINITIONS,
} from './tools/github-write-tools';
import { slackReply, SLACK_TOOL_DEFINITIONS } from './tools/slack-tools';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INVESTIGATION_ID = process.env.INVESTIGATION_ID;
const API_URL = process.env.QA_API_URL || 'http://localhost:3001';
const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
const CHANNEL = process.env.SLACK_THREAD_CHANNEL;
const THREAD_TS = process.env.SLACK_THREAD_TS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Investigation {
  _id: string;
  testId: string;
  runId: string;
  rootCause: string;
  suspectFiles: Array<{ path: string; lines?: string; reason: string }>;
  recentCommits: Array<{ sha: string; message: string; author: string; date: string }>;
  category: string;
  confidence: string;
  recommendedAction: string;
}

// ---------------------------------------------------------------------------
// Slack progress helper
// ---------------------------------------------------------------------------

async function postProgress(text: string): Promise<void> {
  if (!CHANNEL || !THREAD_TS) {
    console.log(`  [progress] ${text}`);
    return;
  }
  try {
    await slackReply({ channelId: CHANNEL, threadTs: THREAD_TS, text });
  } catch {
    console.log(`  [progress] ${text}`);
  }
}

// ---------------------------------------------------------------------------
// SWEEP — FIX & CLEAN UP
// ---------------------------------------------------------------------------

const SOLUTION_SYSTEM_PROMPT = `You are Sweep, the fix agent for the WasteHero E2E test pipeline (project: Garbage Collection).
You receive a HIGH-confidence audit finding and must create a minimal fix as a draft PR.

Tools available:
- github_get_file: Read files from the repo
- github_create_branch: Create a fix branch
- github_update_file: Apply changes to files
- github_create_pr: Open a draft PR
- slack_reply: Post progress and PR link to Slack thread

Process:
1. Read the suspect file(s)
2. Determine the minimal change needed
3. Create branch: fix/{testId}-{short-description}
4. Apply the fix (fewest lines possible)
5. Open a DRAFT PR with full context
6. Post PR link to Slack thread

Safety rules:
- ONLY modify files from the investigation's suspectFiles
- Make the SMALLEST possible change
- Max 2 files per PR
- Never include secrets or internal URLs in PR body
- If fix is unclear or complex, SKIP and explain why
- All PRs are DRAFT (require human review)

IMPORTANT: Post updates to Slack at each major step (reading file, creating branch, etc.)
so the team can see progress in real-time.

Final message must be JSON:
{
  "status": "created|skipped",
  "reason": "Why you created or skipped",
  "branch": "fix/FR-020-005-desc",
  "filesModified": ["path/to/file.ts"]
}`;

const SOLUTION_TOOLS: Anthropic.Tool[] = [
  ...GITHUB_TOOL_DEFINITIONS.filter((t) => t.name === 'github_get_file'),
  ...GITHUB_WRITE_TOOL_DEFINITIONS,
  ...SLACK_TOOL_DEFINITIONS,
].map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
}));

async function executeSolutionTool(
  name: string,
  input: Record<string, unknown>,
  allowedFiles: string[]
): Promise<string> {
  // Safety: block writes to files not in suspect list
  if (name === 'github_update_file') {
    const filePath = (input as { path?: string }).path;
    if (filePath && !allowedFiles.some((a) => filePath.includes(a) || a.includes(filePath))) {
      return `BLOCKED: "${filePath}" not in suspect files: ${allowedFiles.join(', ')}`;
    }
  }

  switch (name) {
    case 'github_get_file':
      return (await githubGetFile(input as Parameters<typeof githubGetFile>[0])) as string;
    case 'github_create_branch':
      return (await githubCreateBranch(input as Parameters<typeof githubCreateBranch>[0])) as string;
    case 'github_update_file':
      return (await githubUpdateFile(input as Parameters<typeof githubUpdateFile>[0])) as string;
    case 'github_create_pr':
      return (await githubCreatePr(input as Parameters<typeof githubCreatePr>[0])) as string;
    case 'slack_reply':
      return (await slackReply(input as Parameters<typeof slackReply>[0])) as string;
    default:
      return `Unknown tool: ${name}`;
  }
}

async function runSolutionAgent(
  client: Anthropic,
  investigation: Investigation
): Promise<{ status: string; prUrl?: string; prNumber?: number; branch?: string; reason?: string }> {
  let toolCallCount = 0;
  const maxToolCalls = 15;
  const allowedFiles = investigation.suspectFiles.map((f) => f.path);

  const slackContext = CHANNEL && THREAD_TS
    ? `\n\n=== Slack Thread ===\nChannel: ${CHANNEL}\nThread: ${THREAD_TS}\nPost progress updates and the final PR link here.`
    : '';

  const userPrompt = [
    `Create a minimal fix for this approved HIGH-confidence finding:`,
    ``,
    `Test ID: ${investigation.testId}`,
    `Category: ${investigation.category}`,
    `Confidence: ${investigation.confidence}`,
    ``,
    `=== Root Cause ===`, investigation.rootCause,
    ``,
    `=== Suspect Files ===`,
    ...investigation.suspectFiles.map((f) => `  ${f.path}${f.lines ? `:${f.lines}` : ''} — ${f.reason}`),
    ``,
    `=== Recent Commits ===`,
    ...investigation.recentCommits.map((c) => `  ${c.sha} ${c.date} ${c.author}: ${c.message}`),
    ``,
    `=== Recommended Action ===`, investigation.recommendedAction,
    slackContext,
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SOLUTION_SYSTEM_PROMPT,
      tools: SOLUTION_TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn' || response.content.every((b) => b.type === 'text')) {
      const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text || '';
      try {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
      } catch { /* fall through */ }
      return { status: 'failed', reason: 'Could not parse agent output' };
    }

    const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    if (toolCallCount + toolBlocks.length > maxToolCalls) {
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolBlocks[0].id, content: 'Tool limit reached. Provide final JSON status.', is_error: true }] });
      continue;
    }

    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolBlocks) {
      toolCallCount++;
      console.log(`    [${investigation.testId}] fix: ${tool.name}`);
      const result = await executeSolutionTool(tool.name, tool.input as Record<string, unknown>, allowedFiles);
      results.push({ type: 'tool_result', tool_use_id: tool.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Garbage Collection: Sweep Phase ===\n');

  if (!INVESTIGATION_ID) {
    console.error('INVESTIGATION_ID not set. Exiting.');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Exiting.');
    process.exit(1);
  }
  if (!process.env.WASTEHERO_REPO) {
    console.error('WASTEHERO_REPO not set. Exiting.');
    process.exit(1);
  }

  // Fetch investigation from API by MongoDB _id
  const res = await fetch(`${API_URL}/api/v1/investigations/by-id/${INVESTIGATION_ID}`);
  if (!res.ok) {
    console.error(`Failed to fetch investigation ${INVESTIGATION_ID}: ${res.status}`);
    process.exit(1);
  }

  const investigation = (await res.json()) as Investigation;

  console.log(`Investigation: ${investigation.testId} (${investigation.confidence} ${investigation.category})`);
  console.log(`Suspect files: ${investigation.suspectFiles.map((f) => f.path).join(', ')}`);

  await postProgress(`:broom: Sweep starting for *${investigation.testId}*...`);

  const client = new Anthropic();

  try {
    const result = await runSolutionAgent(client, investigation);

    console.log(`\nResult: ${result.status}`);
    if (result.prUrl) console.log(`PR: ${result.prUrl}`);
    if (result.reason) console.log(`Reason: ${result.reason}`);

    // Persist fix PR to API
    if (result.status === 'created' && result.prUrl) {
      try {
        await fetch(`${API_URL}/api/v1/investigations/${INVESTIGATION_ID}/fix-pr`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: process.env.WASTEHERO_REPO,
            prNumber: result.prNumber,
            prUrl: result.prUrl,
            branch: result.branch,
            status: 'draft',
          }),
        });
      } catch { /* ignore */ }

      await postProgress(`:white_check_mark: Draft PR created: ${result.prUrl}`);
    } else if (result.status === 'skipped') {
      await postProgress(`:no_entry_sign: Fix skipped: ${result.reason}`);
    } else {
      await postProgress(`:x: Fix failed: ${result.reason}`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error('Sweep failed:', msg);
    await postProgress(`:x: Sweep error: ${msg}`);
    process.exit(1);
  }

  console.log('\n=== Sweep Phase Complete ===');
}

main().catch((error) => {
  console.error('Sweep failed:', error);
  process.exit(1);
});
