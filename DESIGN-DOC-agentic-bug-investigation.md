# Design Document: Agentic Bug Investigation Pipeline

**Author:** QA Automation Team
**Date:** 2026-03-05
**Status:** DRAFT
**Inspired by:** KnowIt meetup — Pi-powered Slack bot for autonomous bug investigation

---

## 1. Executive Summary

We propose extending our existing Cypress E2E pipeline with an automated bug investigation system. When a test fails, the system will:

1. **Post a structured failure report to Slack** (Phase 1)
2. **Investigate the failure autonomously** using an AI agent connected to our codebase (Phase 2)
3. **Propose or apply a fix** via a draft PR (Phase 3)

Our pipeline already captures an unusually rich dataset per failure (error classification, steps to reproduce, network requests, console logs, DOM snapshots, screenshots, videos). This gives us a significant head start — the agent doesn't start cold, it starts with a pre-triaged, evidence-rich context.

### Expected Impact

| Metric                  | Current                     | With Phase 1    | With Phase 2     | With Phase 3     |
| ----------------------- | --------------------------- | --------------- | ---------------- | ---------------- |
| Time to awareness       | Next morning (Sheets check) | < 5 min (Slack) | < 5 min          | < 5 min          |
| Time to root cause      | 30-60 min (manual)          | 30-60 min       | < 10 min (agent) | < 10 min         |
| Time to fix proposal    | Hours-days                  | Hours-days      | Hours (manual)   | < 30 min (agent) |
| Finland team turnaround | 1-3 days                    | Same day        | Hours            | Minutes-hours    |

---

## 2. Current Pipeline (What We Already Have)

```
Cypress Test Execution
    |
    v
[RUNTIME CAPTURE] (e2e.ts + test-context.ts + step-logger.ts)
    |-- Auto-generates "Steps to Reproduce" from every Cypress command
    |-- Captures browser console (log/error/warn/info/debug)
    |-- Captures XHR/fetch network requests (method, URL, status, duration)
    |-- On failure: DOM snapshot, screenshot, marks failed step
    |-- Writes per-test JSON: cypress/results/contexts/{testId}.json
    |
    v
[MOCHAWESOME REPORTER]
    |-- Per-spec JSON: cypress/results/mochawesome/*.json
    |
    v
[generate-report.ts]
    |-- Merges Mochawesome + context JSONs
    |-- Runs error classification (BACKEND / FRONTEND / INCONCLUSIVE)
    |-- Writes: cypress/results/sheets-report.json
    |
    v
[upload-to-sheets.ts]
    |-- Uploads screenshots/videos to Google Drive
    |-- Injects HYPERLINK formulas
    |-- Uploads to Google Sheets with professional formatting
```

### Data Already Available Per Failed Test

| Field                 | Content                                                | Agent Value                |
| --------------------- | ------------------------------------------------------ | -------------------------- |
| `testId`              | `FR-020-001`                                           | Identify broken feature    |
| `description`         | Human-readable test name                               | What was being tested      |
| `errorStack`          | Full exception + stack trace                           | Root cause starting point  |
| `errorClassification` | BACKEND/FRONTEND/INCONCLUSIVE + evidence + likelyCause | **Pre-triage**             |
| `stepsToReproduce`    | Numbered auto-generated steps                          | Bug report ready           |
| `networkRequests`     | All API calls with status codes and durations          | API forensics              |
| `consoleLogs`         | Browser console output                                 | JS error diagnostics       |
| `domStateAtFailure`   | HTML snapshot (up to 5000 chars)                       | What was actually rendered |
| `screenshotUrl`       | Google Drive link                                      | Visual evidence            |
| `videoUrl`            | Google Drive link                                      | Full replay                |
| `duration`            | Milliseconds                                           | Timeout vs instant failure |
| `retryCount`          | Number                                                 | Flakiness indicator        |

### Error Classification System (Already Built)

Our `error-classifier.ts` already performs the first pass of investigation:

- **BACKEND**: 5xx responses detected, with specific endpoint + status + duration evidence
- **FRONTEND**: Assertion/TypeError/ReferenceError with no API failures
- **INCONCLUSIVE**: Timeout without network evidence, or mixed 4xx + assertion failure

Each classification includes `evidence[]`, `likelyCause` (natural language), `failedRequests[]`, and `consoleErrors[]`.

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                    EXISTING PIPELINE (unchanged)                  │
│                                                                  │
│  Cypress → Mochawesome → generate-report.ts → sheets-report.json │
│                                              → Google Sheets     │
│                                              → Google Drive      │
└──────────────────────┬───────────────────────────────────────────┘
                       |
                       v
┌──────────────────────────────────────────────────────────────────┐
│              PHASE 1: SLACK NOTIFICATION LAYER                    │
│                                                                  │
│  New file: cypress/scripts/notify-slack.ts                       │
│  New CI step: after upload-to-sheets                             │
│                                                                  │
│  For each FAILED test in sheets-report.json:                     │
│  ├── Post structured message to #bugs-finland                    │
│  ├── Include: classification, error summary, evidence            │
│  ├── Attach: screenshot, video, Sheets link                     │
│  └── Create thread for discussion / agent investigation          │
└──────────────────────┬───────────────────────────────────────────┘
                       |
                       v
┌──────────────────────────────────────────────────────────────────┐
│              PHASE 2: INVESTIGATION AGENT                         │
│                                                                  │
│  New file: cypress/scripts/investigate-failures.ts               │
│  New infra: Agent service (Claude API / Slack bot)               │
│                                                                  │
│  For each FAILED test:                                           │
│  ├── Receive full TestResult context                             │
│  ├── Query WasteHero app repo via GitHub API:                    │
│  │   ├── Search for failed endpoint handler code                 │
│  │   ├── Search for UI component matching selector               │
│  │   ├── Check git log for recent changes to suspect files       │
│  │   └── Cross-reference with deploy timeline                    │
│  ├── Analyze DOM snapshot vs expected markup                     │
│  ├── Compare with historical results (Sheets API)                │
│  ├── Produce: root cause, suspect files, confidence level        │
│  └── Post analysis to Slack thread                               │
└──────────────────────┬───────────────────────────────────────────┘
                       |
                       v
┌──────────────────────────────────────────────────────────────────┐
│              PHASE 3: AUTOMATED FIX PROPOSAL                     │
│                                                                  │
│  Extension of Phase 2 agent                                      │
│                                                                  │
│  If confidence >= HIGH:                                          │
│  ├── Create branch: fix/{testId}-{description}                   │
│  ├── Apply code changes                                          │
│  ├── Run affected tests to verify                                │
│  ├── Open draft PR with investigation as body                    │
│  └── Post PR link to Slack thread for human approval             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 4. Phase 1: Slack Notifications (Detailed Design)

### 4.1 Overview

A new script (`notify-slack.ts`) reads `sheets-report.json` and posts structured failure notifications to a Slack channel. This runs as a CI step after the Sheets upload.

### 4.2 New Files

```
cypress/
└── scripts/
    └── notify-slack.ts          # Slack notification script
```

### 4.3 Slack App Setup

1. **Create a Slack App** at https://api.slack.com/apps
   - App name: `QA Bug Reporter` (or similar)
   - Workspace: Your Slack workspace

2. **Required Scopes** (Bot Token Scopes):
   - `chat:write` — Post messages
   - `chat:write.customize` — Custom bot name/icon
   - `files:write` — Upload screenshots (optional, can use Drive links instead)

3. **Install to workspace**, get `SLACK_BOT_TOKEN` (xoxb-...)

4. **Create channel**: `#bugs-finland` (or `#qa-automated-bugs`)

5. **Invite the bot** to the channel

6. **Store secrets**:
   - `SLACK_BOT_TOKEN` → GitHub Secrets
   - `SLACK_CHANNEL_ID` → GitHub Secrets (channel ID, not name)

### 4.4 Message Format

Each failed test gets its own message with a thread-ready structure:

```
:red_circle: Test Failed: FR-020-005 — Search Table Filtering

Classification: BACKEND
━━━━━━━━━━━━━━━━━━━━━━━
Evidence:
  - GET /api/customers → 500 (1234ms)
  - Console: ECONNREFUSED...

Likely Cause:
  The server returned a 500 error before the assertion ran.
  Check server logs for: /api/customers.

━━━━━━━━━━━━━━━━━━━━━━━
Duration: 12340ms | Browser: Chrome 120.0 | Env: GitHub Actions
Steps: 8 steps captured | Retry: 0

:frame_with_picture: Screenshot  |  :movie_camera: Video  |  :bar_chart: Google Sheets
```

### Notification Strategy

- **On each CI run**: Post **only if there are failures**. Each failure gets its own message with a thread.
- **Daily digest** (scheduled, e.g., 08:00 EET): Post a summary of all runs in the last 24 hours — pass rate, trends, top recurring failures, and links to Sheets. This posts even if all tests passed (so the team knows the system is running).

**Summary message** (posted first, pinned):

```
:test_tube: QA Run Complete — 2026-03-05T08:00:00Z

Total: 65 | Passed: 60 | Failed: 5 | Pass Rate: 92.3%

Failed Tests:
  :red_circle: FR-020-005 — Search Table Filtering (BACKEND)
  :red_circle: FR-020-011 — No Results Display (FRONTEND)
  :red_circle: PD-042-003 — Category Assignment (INCONCLUSIVE)
  :red_circle: FR-001-007 — Session Persistence (BACKEND)
  :red_circle: FR-020-022 — Search Performance (INCONCLUSIVE)

:link: Full report: [Google Sheets] | :package: Artifacts: [GitHub Actions]
```

### 4.5 Script Design: `notify-slack.ts`

```typescript
// Pseudo-code structure

interface SlackConfig {
  botToken: string; // SLACK_BOT_TOKEN
  channelId: string; // SLACK_CHANNEL_ID
  sheetsUrl?: string; // Google Sheets URL for linking
  artifactsUrl?: string; // GitHub Actions artifacts URL
}

async function notifySlack(): Promise<void> {
  // 1. Load sheets-report.json
  // 2. Filter for FAILED results
  // 3. Post summary message to channel
  // 4. For each failure:
  //    a. Post detailed message with Block Kit formatting
  //    b. Store thread_ts for Phase 2 agent to reply to
  //    c. Optionally post screenshot as file attachment
  // 5. Write thread mapping to cypress/results/slack-threads.json
  //    (maps testId -> { channelId, threadTs } for Phase 2)
}
```

### 4.6 Slack Block Kit Message Structure

Using Slack's Block Kit for rich formatting:

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "Test Failed: FR-020-005" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Search Table Filtering*\n\n*Classification:* `BACKEND`"
      },
      "accessory": {
        "type": "image",
        "image_url": "<screenshot_drive_url>",
        "alt_text": "Failure screenshot"
      }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Evidence:*\n- GET /api/customers -> 500" },
        { "type": "mrkdwn", "text": "*Likely Cause:*\nServer returned 500..." }
      ]
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Duration: 12340ms | Chrome 120.0 | GitHub Actions" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View Screenshot" },
          "url": "<drive_url>"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View Video" },
          "url": "<drive_url>"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Google Sheets" },
          "url": "<sheets_url>"
        }
      ]
    }
  ]
}
```

### 4.7 CI Pipeline Changes

Add to `.github/workflows/cypress-tests.yml` after the Sheets upload step:

```yaml
- name: Notify Slack of failures
  if: always()
  continue-on-error: true
  run: npx tsx cypress/scripts/notify-slack.ts
  env:
    SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
    SLACK_CHANNEL_ID: ${{ secrets.SLACK_CHANNEL_ID }}
    GOOGLE_SHEET_ID: ${{ secrets.GOOGLE_SHEET_ID }}
    GITHUB_RUN_ID: ${{ github.run_id }}
    GITHUB_REPOSITORY: ${{ github.repository }}
```

### 4.8 New Dependencies

```json
{
  "@slack/web-api": "^7.0.0"
}
```

### 4.9 Environment Variables

| Variable            | Required | Source        | Purpose                                                                                                             |
| ------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`   | Yes      | GitHub Secret | Bot OAuth token (xoxb-...)                                                                                          |
| `SLACK_CHANNEL_ID`  | Yes      | GitHub Secret | Target channel ID                                                                                                   |
| `SLACK_NOTIFY_MODE` | No       | Env var       | `failures-only` (default during CI runs) or `always` (includes pass summary). Overridden by daily digest cron.      |
| `SLACK_DIGEST_CRON` | No       | Env var       | If set, posts a daily summary at this time (e.g., `08:00`). Includes pass rate, trends, and top recurring failures. |

---

## 5. Phase 2: Investigation Agent (Detailed Design)

### 5.1 Overview

An AI agent receives the full failure context from `sheets-report.json`, investigates the root cause by querying the WasteHero application's GitHub repository, and posts its analysis to the Slack thread created in Phase 1.

### 5.2 Technology Choice

#### Option A: Claude API + Custom Orchestration (Recommended)

- **Agent runtime**: Node.js script using the Anthropic Claude API
- **Tool use**: Claude's tool-use feature to call GitHub API, Sheets API, and custom analysis functions
- **Orchestration**: Custom TypeScript in `cypress/scripts/investigate-failures.ts`
- **Pros**: Full control, same language as pipeline, integrates with existing Google credentials
- **Cons**: Must build tool orchestration yourself

#### Option B: OpenAI Codex / ChatGPT API

- Similar to Option A but with OpenAI's API
- **Pros**: Codex has strong code understanding
- **Cons**: Less control over tool use patterns

#### Option C: Pi (pimom) — as seen at the KnowIt meetup

- **Agent runtime**: Pi framework with Slack integration
- **Pros**: Purpose-built for this use case, proven at scale
- **Cons**: Newer framework, less documentation, dependency on external tooling

#### Option D: GitHub Actions + Claude (Hybrid)

- **Agent runtime**: GitHub Action that calls Claude API with failure context
- **Pros**: No additional infrastructure, runs in existing CI
- **Cons**: Limited by Actions runtime (6-hour max), token costs per run

**Recommendation**: Start with **Option A** (Claude API + custom orchestration). It keeps everything in TypeScript, reuses your existing Google auth, and gives full control. If the team later wants the always-on Slack bot experience (like the KnowIt meetup demo), migrate to **Option C** (Pi) or a dedicated bot service.

### 5.3 Agent Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  INVESTIGATION AGENT                     │
│                                                         │
│  Input:                                                 │
│  ├── TestResult object (from sheets-report.json)        │
│  ├── SavedTestContext (from contexts/{testId}.json)      │
│  └── Slack thread_ts (from slack-threads.json)           │
│                                                         │
│  Tools available to the agent:                          │
│  ├── github_search_code   — Search WasteHero repo       │
│  ├── github_get_file      — Read specific file           │
│  ├── github_get_commits   — Recent commits to a file     │
│  ├── github_get_pr        — PR that introduced a change  │
│  ├── sheets_get_history   — Previous test results        │
│  ├── analyze_dom          — Compare DOM snapshot         │
│  ├── analyze_network      — Deep network analysis        │
│  └── slack_reply          — Post to Slack thread         │
│                                                         │
│  Output:                                                │
│  ├── Root cause analysis (natural language)              │
│  ├── Suspect file(s) + line(s) in WasteHero repo        │
│  ├── Recent commits that may have caused it              │
│  ├── Historical context (regression vs flaky vs new)     │
│  ├── Confidence level (HIGH / MEDIUM / LOW)              │
│  └── Recommended action                                 │
└─────────────────────────────────────────────────────────┘
```

### 5.4 Investigation Strategy (Agent System Prompt)

The agent follows a different investigation path based on the error classification:

#### BACKEND Failure Strategy

```
1. Extract failed API endpoint(s) from networkRequests
2. github_search_code: Find the route handler for that endpoint
3. github_get_file: Read the handler code
4. github_get_commits: Check recent changes (last 7 days) to that file
5. Cross-reference commit timestamps with when the test last passed (sheets_get_history)
6. If a recent commit modified the handler → HIGH confidence, link to commit
7. If no recent changes → Check if the endpoint depends on external services
8. Post analysis to Slack thread
```

#### FRONTEND Failure Strategy

```
1. Extract the CSS selector from the failed assertion step
2. github_search_code: Find the React/Vue component that renders that selector
3. github_get_file: Read the component code
4. analyze_dom: Compare domStateAtFailure against expected markup
5. github_get_commits: Check recent changes to the component
6. Check if the data source (API response) changed format
7. Post analysis to Slack thread
```

#### INCONCLUSIVE Failure Strategy

```
1. Check sheets_get_history: Has this test failed before? (flakiness detection)
2. If retryCount > 0 and intermittent history → Flag as FLAKY, LOW confidence
3. Analyze network timing: Are responses abnormally slow?
4. Check if the test has a cy.wait() or relies on timing
5. Examine DOM snapshot: Is the element present but hidden? Missing entirely?
6. Post analysis with recommendation to investigate manually
```

### 5.5 Tool Definitions (for Claude API)

```typescript
const tools = [
  {
    name: 'github_search_code',
    description: 'Search for code in the WasteHero application repository',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (code, filename, or symbol)' },
        path: { type: 'string', description: 'Optional path filter (e.g., "src/api/")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'github_get_file',
    description: 'Read the contents of a specific file from the WasteHero repo',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path in the repo (e.g., "src/api/customers.ts")',
        },
        ref: { type: 'string', description: 'Branch or commit SHA (default: main)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'github_get_commits',
    description: 'Get recent commits that modified a specific file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to check history for' },
        since: { type: 'string', description: 'ISO date to start from (default: 7 days ago)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sheets_get_history',
    description: 'Get historical test results for a specific test ID from Google Sheets',
    input_schema: {
      type: 'object',
      properties: {
        testId: { type: 'string', description: 'Test ID (e.g., "FR-020-005")' },
        limit: { type: 'number', description: 'Number of recent runs to fetch (default: 10)' },
      },
      required: ['testId'],
    },
  },
  {
    name: 'analyze_dom',
    description: 'Analyze the DOM snapshot from the failed test',
    input_schema: {
      type: 'object',
      properties: {
        domSnapshot: { type: 'string', description: 'HTML snapshot from domStateAtFailure' },
        expectedSelector: { type: 'string', description: 'CSS selector that was expected' },
        expectedContent: { type: 'string', description: 'Text content that was expected' },
      },
      required: ['domSnapshot'],
    },
  },
  {
    name: 'slack_reply',
    description: 'Post a message to the Slack thread for this failure',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text (supports Slack mrkdwn)' },
        blocks: { type: 'array', description: 'Optional Block Kit blocks for rich formatting' },
      },
      required: ['text'],
    },
  },
];
```

### 5.6 Agent System Prompt

```
You are a QA investigation agent for the WasteHero waste management application.
Your job is to analyze failed E2E test results and determine the root cause.

You will receive a structured failure context including:
- Error classification (BACKEND/FRONTEND/INCONCLUSIVE) with evidence
- Full error stack trace
- Network requests made during the test (with status codes and timing)
- Browser console logs
- Auto-generated steps to reproduce
- DOM snapshot at the moment of failure
- Screenshot and video links

Your investigation process:
1. Start with the error classification and evidence — this is your pre-triage
2. Use the GitHub tools to search the WasteHero application codebase
3. Identify the specific file(s) and line(s) most likely responsible
4. Check if recent commits modified the suspect code
5. Check historical test results to determine if this is a regression, flaky test, or new issue
6. Assess your confidence level (HIGH/MEDIUM/LOW)

Your output should be:
- Concise root cause analysis (2-3 sentences)
- Suspect file(s) with line numbers
- Recent relevant commits (if any)
- Whether this is a regression, flaky test, or new bug
- Confidence level with justification
- Recommended next action

Rules:
- Be specific — name files, functions, and line numbers
- If you cannot determine the cause, say so clearly and explain what additional information would help
- Do not speculate beyond the evidence. LOW confidence is better than a wrong HIGH confidence.
- Always check historical data before concluding "new bug"
- Consider that the TEST itself might be wrong (selector changed, timing issue, etc.)
```

### 5.7 Script Design: `investigate-failures.ts`

```typescript
// Pseudo-code structure

interface InvestigationResult {
  testId: string;
  rootCause: string;
  suspectFiles: Array<{ path: string; lines?: string; reason: string }>;
  recentCommits: Array<{ sha: string; message: string; author: string; date: string }>;
  category: 'regression' | 'flaky' | 'new_bug' | 'test_issue' | 'unknown';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendedAction: string;
  agentTokensUsed: number;
}

async function investigateFailures(): Promise<void> {
  // 1. Load sheets-report.json
  // 2. Load slack-threads.json (from Phase 1)
  // 3. Filter for FAILED results
  // 4. For each failure (with concurrency limit of 3):
  //    a. Load the full SavedTestContext from contexts/{testId}.json
  //    b. Build the agent prompt with all context
  //    c. Call Claude API with tool definitions
  //    d. Execute tool calls as the agent requests them
  //    e. When agent produces final analysis, post to Slack thread
  //    f. Save investigation result to cypress/results/investigations/{testId}.json
  // 5. Post summary of all investigations to Slack channel
}
```

### 5.8 Concurrency and Cost Management

| Concern                | Mitigation                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| API token costs        | Cap at 4096 output tokens per investigation; use `claude-sonnet` for cost efficiency, `claude-opus` only for INCONCLUSIVE cases |
| Rate limits            | Process max 3 failures concurrently; backoff on 429s                                                                            |
| GitHub API limits      | Use authenticated requests (5000/hr); cache file contents                                                                       |
| Runaway investigations | Max 10 tool calls per investigation; 60-second timeout                                                                          |
| All-pass runs          | Skip investigation entirely if 0 failures                                                                                       |

### 5.9 New Files

```
cypress/
└── scripts/
    ├── investigate-failures.ts      # Agent orchestration
    └── tools/
        ├── github-tools.ts          # GitHub API tool implementations
        ├── sheets-history-tool.ts   # Historical data from Sheets
        ├── dom-analyzer-tool.ts     # DOM snapshot analysis
        └── slack-tools.ts           # Slack thread reply tool
```

### 5.10 New Dependencies

```json
{
  "@anthropic-ai/sdk": "^0.30.0",
  "octokit": "^4.0.0"
}
```

### 5.11 Environment Variables

| Variable                 | Required | Source        | Purpose                                            |
| ------------------------ | -------- | ------------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | Yes      | GitHub Secret | Claude API authentication                          |
| `WASTEHERO_GITHUB_TOKEN` | Yes      | GitHub Secret | WasteHero app repo access (read)                   |
| `WASTEHERO_REPO`         | Yes      | GitHub Secret | Repo in `owner/name` format                        |
| `AGENT_MODEL`            | No       | Env var       | Claude model (default: `claude-sonnet-4-20250514`) |
| `AGENT_MAX_TOKENS`       | No       | Env var       | Max output tokens (default: 4096)                  |
| `AGENT_MAX_TOOL_CALLS`   | No       | Env var       | Max tool invocations (default: 10)                 |
| `AGENT_CONCURRENCY`      | No       | Env var       | Parallel investigations (default: 3)               |

### 5.12 CI Pipeline Changes

Add after the Slack notification step:

```yaml
- name: Investigate failures
  if: always()
  continue-on-error: true
  run: npx tsx cypress/scripts/investigate-failures.ts
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    WASTEHERO_GITHUB_TOKEN: ${{ secrets.WASTEHERO_GITHUB_TOKEN }}
    WASTEHERO_REPO: ${{ secrets.WASTEHERO_REPO }}
    SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
    SLACK_CHANNEL_ID: ${{ secrets.SLACK_CHANNEL_ID }}
    GOOGLE_CREDENTIALS_JSON: ${{ secrets.GOOGLE_CREDENTIALS_JSON }}
    GOOGLE_SHEET_ID: ${{ secrets.GOOGLE_SHEET_ID }}
```

### 5.13 Example Investigation Output (Slack Thread)

```
:mag: Investigation: FR-020-005 — Search Table Filtering

Root Cause: The /api/v2/customers endpoint handler in
src/api/routes/customers.ts:142 throws an unhandled exception
when the search query contains special characters (Finnish
characters like a, o). The sanitizeQuery() function on line 89
does not handle multi-byte UTF-8 characters.

Suspect Files:
  - src/api/routes/customers.ts:142 (endpoint handler)
  - src/api/utils/sanitize.ts:89 (sanitizeQuery function)

Recent Commits:
  - abc1234 "Refactor customer search to use v2 API" (developer@wastehero.com, 2 days ago)
    ^ This commit changed the search endpoint from /api/customers to /api/v2/customers
      and replaced the query sanitization logic

Category: Regression (introduced by abc1234)
Confidence: HIGH
  - The commit directly modified the failing endpoint
  - The test passed consistently before this commit (8/8 runs)
  - The error stack shows the exact line modified

Recommended Action:
  Fix sanitizeQuery() in src/api/utils/sanitize.ts to handle
  UTF-8 characters. The original implementation (before abc1234)
  handled this correctly.
```

---

## 6. Phase 3: Automated Fix Proposal (Detailed Design)

### 6.1 Overview

When the investigation agent has HIGH confidence in the root cause AND the fix is straightforward (e.g., a regex fix, a missing null check, a reverted change), the agent creates a branch, applies the fix, and opens a draft PR.

### 6.2 Prerequisites

- Phase 2 must be complete and stable (agent investigations are accurate)
- `WASTEHERO_GITHUB_TOKEN` must have write access (create branches, open PRs)
- Team must agree on the review process for agent-generated PRs

### 6.3 Fix Categories (What the Agent Can Fix)

| Category              | Example                                 | Confidence Threshold |
| --------------------- | --------------------------------------- | -------------------- |
| Missing null check    | `Cannot read property 'x' of undefined` | HIGH                 |
| Selector mismatch     | `data-testid` changed in UI             | HIGH (test fix)      |
| Encoding/sanitization | UTF-8 handling bug                      | HIGH                 |
| Reverted behavior     | Recent commit broke existing behavior   | HIGH                 |
| Missing import        | `X is not defined`                      | HIGH                 |
| Configuration drift   | Environment variable changed            | MEDIUM (flag only)   |

### 6.4 What the Agent Should NOT Fix

- Complex business logic changes
- Database schema issues
- Infrastructure / deployment problems
- Performance regressions
- Anything requiring manual QA verification

### 6.5 Fix Workflow

The agent targets **both repos** depending on the root cause:

- **BACKEND/FRONTEND app bug** → PR against the **WasteHero application repo**
- **Test issue** (selector changed, timing, stale fixture) → PR against the **Cypress test repo**
- **Both** (app bug + test needs updating) → Two separate PRs, linked in the Slack thread

```
1. Investigation agent determines root cause with HIGH confidence
2. Agent determines if fix is in the TEST repo, the APP repo, or both
3. Agent creates a branch: fix/{testId}-{short-description}
   - App repo: fix/FR-020-005-sanitize-utf8
   - Test repo: fix/FR-020-005-update-selector
4. Agent applies the minimal fix (smallest possible change)
5. Agent runs the affected test(s) to verify the fix works
6. Agent opens a DRAFT PR with:
   - Title: "fix: {testId} — {short description}"
   - Body: Full investigation context + before/after explanation
   - Labels: "automated-fix", "needs-review"
   - Reviewers: Auto-assigned based on CODEOWNERS
7. Agent posts the PR link(s) to the Slack thread
8. Human reviews and merges (or closes with feedback)
```

### 6.6 Safety Rails

| Risk                           | Mitigation                                                         |
| ------------------------------ | ------------------------------------------------------------------ |
| Agent makes wrong fix          | DRAFT PR only — requires human approval                            |
| Agent modifies unrelated code  | Diff must only touch files identified in investigation             |
| Agent creates too many PRs     | Max 3 auto-fix PRs per run; skip if existing open PR for same test |
| Agent creates breaking changes | Run the test suite on the fix branch before opening PR             |
| Credentials in PR body         | Never include env vars, tokens, or URLs in PR description          |

### 6.7 Additional Tools for Phase 3

```typescript
const phase3Tools = [
  {
    name: 'github_create_branch',
    description: 'Create a new branch from main/develop',
    input_schema: {
      /* ... */
    },
  },
  {
    name: 'github_update_file',
    description: 'Update a file in the repository on a branch',
    input_schema: {
      /* ... */
    },
  },
  {
    name: 'github_create_pr',
    description: 'Open a draft pull request',
    input_schema: {
      /* ... */
    },
  },
  {
    name: 'trigger_test_run',
    description: 'Trigger a Cypress test run for a specific spec on a branch',
    input_schema: {
      /* ... */
    },
  },
];
```

---

## 7. Security Considerations

### 7.1 Credential Management

| Secret                    | Scope                                     | Storage                          |
| ------------------------- | ----------------------------------------- | -------------------------------- |
| `SLACK_BOT_TOKEN`         | Post to Slack                             | GitHub Secrets                   |
| `ANTHROPIC_API_KEY`       | Claude API calls                          | GitHub Secrets                   |
| `WASTEHERO_GITHUB_TOKEN`  | Read (Phase 2) / Write (Phase 3) app repo | GitHub Secrets, fine-grained PAT |
| `GOOGLE_CREDENTIALS_JSON` | Sheets + Drive (existing)                 | GitHub Secrets                   |

### 7.2 Principle of Least Privilege

- **Phase 1**: Slack bot only needs `chat:write`
- **Phase 2**: GitHub token only needs `contents:read` on the app repo
- **Phase 3**: GitHub token needs `contents:write`, `pull-requests:write` — use a **separate token** from Phase 2, enabled only when Phase 3 is activated

### 7.3 Data Exposure

- The agent sees error stacks, DOM snapshots, and API endpoints — do NOT log full request/response bodies
- Slack messages should not include raw credentials, connection strings, or internal IPs
- Agent system prompts should instruct it to never output secrets found in code

### 7.4 Cost Controls

| Resource     | Limit                              | Alert                      |
| ------------ | ---------------------------------- | -------------------------- |
| Claude API   | Max $50/month initially            | Slack alert if > $10/day   |
| GitHub API   | 5000 requests/hour (authenticated) | Log rate limit headers     |
| Slack API    | Tier 1: 1 message/sec              | Built-in backoff           |
| Google Drive | 20,000 queries/100 sec             | Existing quota (unchanged) |

---

## 8. Data Flow Diagram (All Phases)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Cypress Run  │────>│  Mochawesome  │────>│  generate-report  │
│  (existing)   │     │  JSON files   │     │  .ts (existing)   │
└──────────────┘     └──────────────┘     └────────┬─────────┘
       |                                            |
       | contexts/{testId}.json                     | sheets-report.json
       v                                            v
┌──────────────────┐                    ┌──────────────────────┐
│  upload-to-sheets │<───────────────── │  sheets-report.json   │
│  .ts (existing)   │                    │  {                    │
└──────────────────┘                    │    results: [          │
       |                                │      { testId,         │
       | Google Sheets + Drive          │        errorClassifi-  │
       v                                │        cation,         │
┌──────────────────┐                    │        networkReqs,    │
│  Google Sheets    │                    │        consoleLogs,    │
│  Google Drive     │                    │        stepsToRepro,   │
└──────────────────┘                    │        domState, ... } │
                                        │    ]                   │
                                        │  }                     │
                                        └──────────┬─────────────┘
                                                   |
                    ┌──────────────────────────────┤
                    |                              |
                    v                              v
          ┌─────────────────┐           ┌─────────────────────┐
          │  notify-slack.ts │           │  investigate-        │
          │  (Phase 1)       │           │  failures.ts         │
          │                  │           │  (Phase 2)           │
          │  Posts to:       │           │                      │
          │  #bugs-finland   │           │  Uses:               │
          └───────┬─────────┘           │  - Claude API        │
                  |                      │  - GitHub API        │
                  | slack-threads.json   │  - Sheets history    │
                  |                      │                      │
                  └─────────>───────────>│  Posts analysis to   │
                                        │  Slack threads       │
                                        └──────────┬───────────┘
                                                   |
                                                   v (Phase 3 only)
                                        ┌─────────────────────┐
                                        │  Creates fix branch  │
                                        │  Opens draft PR      │
                                        │  Posts PR to thread  │
                                        └─────────────────────┘
```

---

## 9. Rollout Plan

### 9.1 Phase 1: Slack Notifications (Week 1-2)

| Day | Task                                                           |
| --- | -------------------------------------------------------------- |
| 1   | Create Slack app, install to workspace, get tokens             |
| 1   | Create `#bugs-finland` channel, invite bot                     |
| 2-3 | Implement `notify-slack.ts` with Block Kit messages            |
| 3   | Add `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` to GitHub Secrets |
| 4   | Add CI step to workflow, test with a manual dispatch           |
| 5   | Tune message format based on team feedback                     |
| 5   | Document setup in AGENTS.md                                    |

**Success criteria**: Finland team sees failure notifications in Slack within 5 minutes of a test run completing.

### 9.2 Phase 2: Investigation Agent (Week 3-5)

| Day   | Task                                                            |
| ----- | --------------------------------------------------------------- |
| 1-2   | Implement GitHub tool functions (search, get file, get commits) |
| 3     | Implement Sheets history tool                                   |
| 4-5   | Implement DOM analysis tool                                     |
| 6-7   | Build agent orchestration with Claude API tool-use              |
| 8-9   | Write and iterate on system prompt with real failure data       |
| 10    | Add CI step, test with manual dispatch                          |
| 11-12 | Run on 2 weeks of real failures, tune accuracy                  |
| 13    | Team review: Are investigations helpful? Accurate?              |
| 14    | Adjust based on feedback, document                              |

**Success criteria**: Agent correctly identifies root cause for > 60% of BACKEND and FRONTEND failures (measured by team agreement).

### 9.3 Phase 3: Auto-Fix (Week 7-10)

| Day   | Task                                                          |
| ----- | ------------------------------------------------------------- |
| 1-2   | Create fine-grained GitHub PAT with write access              |
| 3-5   | Implement branch creation, file update, and PR creation tools |
| 6-7   | Implement test-run verification on fix branch                 |
| 8-9   | Build safety rails (diff validation, PR limits, draft-only)   |
| 10-12 | Test with real failures — agent proposes fixes                |
| 13-14 | Team reviews agent PRs, provides feedback                     |
| 15+   | Iterate on fix quality, expand fix categories                 |

**Success criteria**: Agent opens valid draft PRs for > 30% of HIGH-confidence investigations. All PRs require human review before merge.

---

## 10. Monitoring and Observability

### 10.1 Metrics to Track

| Metric                                       | Source                                  | Target              |
| -------------------------------------------- | --------------------------------------- | ------------------- |
| Mean time from failure to Slack notification | Slack message timestamp - test end time | < 5 min             |
| Investigation accuracy (team rated)          | Manual review of agent analysis         | > 60%               |
| Investigation time                           | Agent start-to-finish                   | < 2 min per failure |
| API cost per run                             | Anthropic usage dashboard               | < $2 per run        |
| False positive rate (wrong root cause)       | Manual review                           | < 20%               |
| Auto-fix acceptance rate (Phase 3)           | PRs merged / PRs opened                 | > 50%               |

### 10.2 Alerting

- Slack notification script failure → post to `#qa-automation-alerts`
- Agent investigation timeout (> 5 min) → log and skip
- API cost spike (> $10/day) → Slack alert to team lead
- Agent opens > 3 PRs in a single run → pause and alert

---

## 11. Cost Estimate

### Monthly Costs (assuming daily runs, ~5 failures/day average)

| Resource              | Phase 1  | Phase 2              | Phase 3        |
| --------------------- | -------- | -------------------- | -------------- |
| Slack API             | Free     | Free                 | Free           |
| Claude API (Sonnet)   | —        | ~$15-30/mo           | ~$20-40/mo     |
| GitHub API            | —        | Free (within limits) | Free           |
| Google APIs           | Existing | Existing             | Existing       |
| **Total incremental** | **$0**   | **~$15-30/mo**       | **~$20-40/mo** |

Phase 1 is essentially free. Phase 2's cost scales linearly with failure count — fewer bugs = lower cost (a nice incentive).

---

## 12. Comparison: Our Approach vs. KnowIt Meetup Bot

| Aspect         | KnowIt / Pi Bot                    | Our Approach                                                  |
| -------------- | ---------------------------------- | ------------------------------------------------------------- |
| Trigger        | Slack channel (user-reported bugs) | Automated test pipeline (detected bugs)                       |
| Input data     | Bug report text (unstructured)     | Rich structured context (classification, network, DOM, steps) |
| Pre-triage     | None — agent must classify         | Already classified (BACKEND/FRONTEND/INCONCLUSIVE)            |
| Evidence       | Agent must gather from scratch     | Screenshots, videos, DOM snapshots, network logs pre-attached |
| Code access    | Connected to all systems           | GitHub API to WasteHero app repo                              |
| Fix capability | Full autonomous fix                | Draft PR requiring human review (safer)                       |
| Always-on      | Yes (Slack bot)                    | CI-triggered (runs after each test suite)                     |

**Key advantage**: Our pipeline already does the hard part (data capture and pre-classification). Their bot starts from a text message; our agent starts from a structured, evidence-rich failure context. This means higher investigation accuracy with fewer agent iterations.

**Potential evolution**: If we want the "always-on Slack bot" experience (users can also report bugs in the channel and the bot investigates), we can add that as a Phase 4 — the infrastructure from Phases 1-3 would support it directly.

---

## 13. Open Questions & TODOs

> **TODO**: Items marked with `[ ]` need team input before implementation can begin.

- [ ] **WasteHero repo access**: Confirm whether we have a service account / PAT that can read the WasteHero application repo. Determine the repo URL and whether it's a monorepo or split into frontend/backend repos. This is a **blocker for Phase 2**.

- [x] **Historical data**: Will use a **self-hosted database in Docker** on the developer's machine. Options: PostgreSQL (most mature) or SQLite (simplest). The CI pipeline will push test results to this DB after each run via an API endpoint or direct connection. The investigation agent queries the DB for historical data instead of Google Sheets. **Requires**: Docker Compose setup, a simple API or direct DB connection from CI, and the machine being reachable from GitHub Actions (or a sync mechanism).

  > **Decided**: **MongoDB** in Docker. TestResult objects map naturally to MongoDB documents (no ORM needed). Will use `mongodb` npm package. CI pipeline pushes results via a simple Express API or direct connection (requires the host machine to be reachable, or a post-run sync script).
  >
  > **Connectivity**: **Cloudflare Tunnel** (free, secure, no port forwarding). A `cloudflared` container in the Docker Compose stack exposes a small Express API to a stable public URL. GitHub Actions pushes results to that URL after each run. The agent also queries the same API for historical data.
  >
  > **Sub-TODO**: Design MongoDB collections, set up Docker Compose (MongoDB + Mongo Express + Express API + cloudflared), create the API endpoints (POST /results, GET /results/:testId/history).

- [x] **Finnish delivery specifics**: Multiple customers with different configurations — each customer may have unique data patterns, locale requirements, and business rules. The agent should be **customer-aware**: when investigating a failure, it should note which customer context the test ran against and consider customer-specific configuration as a potential root cause. The investigation agent's system prompt should instruct it to check for customer-specific config files or feature flags.

  > **Note**: This makes the Phase 2 agent more valuable — it can correlate failures to specific customer setups rather than assuming a universal bug.

- [x] **Team notification preferences**: Bot will **tag by classification** — BACKEND failures mention @backend-team, FRONTEND failures mention @frontend-team, INCONCLUSIVE mentions both. Requires Slack user group IDs stored as env vars (`SLACK_BACKEND_GROUP_ID`, `SLACK_FRONTEND_GROUP_ID`).

- [x] **Existing bug tracking**: Team uses Jira, but Jira integration is **out of scope** for this project. Slack is the primary notification channel. (Could be revisited as a future enhancement.)

- [ ] **Always-on vs CI-only**: Undecided. Starting with CI-triggered (no new infra). If the team later wants an always-on Slack bot (like the KnowIt demo), this requires a hosted service (e.g., AWS Lambda, Railway, Fly.io). **Decision deferred** — revisit after Phase 1 is running.

---

## 14. Decision Log

| Decision               | Options Considered                    | Chosen                                          | Rationale                                                                        |
| ---------------------- | ------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Agent framework        | Claude API, OpenAI Codex, Pi (pimom)  | **Claude API (confirmed)**                      | Full control, same language (TS), existing auth infra, best tool-use support     |
| Slack integration      | Webhook (simple) vs Bot (interactive) | Bot (Phase 1: post only; Phase 2+: interactive) | Bot allows threaded replies and future interactivity                             |
| Fix workflow           | Full autonomous vs Draft PR           | **Draft PR (both repos)**                       | Agent opens PRs against app repo AND test repo as needed. Human review required. |
| Historical storage     | Google Sheets vs Database             | **MongoDB (self-hosted Docker)**                | TestResult maps naturally to documents. Connected via Cloudflare Tunnel.         |
| Deployment             | GitHub Actions vs Hosted service      | **GitHub Actions (initially)**                  | No new infra; always-on bot decision deferred to post-Phase 1.                   |
| Notification frequency | Failures only vs Always               | **Failures + daily digest**                     | Failures posted immediately; daily summary at 08:00 EET with trends.             |
| Notification routing   | Channel only vs Tag teams             | **Tag by classification**                       | BACKEND → @backend-team, FRONTEND → @frontend-team, INCONCLUSIVE → both.         |
| AI provider            | Claude, OpenAI, Pi                    | **Claude (Anthropic)**                          | Best tool-use, same language (TS), confirmed by team.                            |

---

## 15. PoC: Getting Started

A minimal proof-of-concept is included and ready to test.

### 15.1 Files Created

| File                                      | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `cypress/scripts/notify-slack.ts`         | Phase 1 Slack notification script                                       |
| `cypress/results/mock-sheets-report.json` | Mock report with 12 tests (3 failures: BACKEND, FRONTEND, INCONCLUSIVE) |

### 15.2 Quick Test (Dry Run — No Slack Token Needed)

```bash
# Uses mock data, prints what would be sent to Slack
npm run notify:slack:mock
```

Expected output:

```
--- DRY RUN (no SLACK_BOT_TOKEN) ---
Would post summary: 12 tests, 3 failed
Would post failure: FR-020-005 — Search Table Filtering (BACKEND)
Would post failure: FR-020-011 — No Results Display (FRONTEND)
Would post failure: PD-042-003 — Category Assignment (INCONCLUSIVE)
--- END DRY RUN ---
```

### 15.3 Live Test (With Slack Token)

1. Create a Slack app (see Appendix B for manifest)
2. Install to your workspace, get the bot token
3. Create a test channel, invite the bot, get the channel ID
4. Add to `.env`:
   ```
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_CHANNEL_ID=C0123456789
   ```
5. Run:
   ```bash
   npm run notify:slack:mock
   ```
6. Check Slack — you should see 1 summary + 3 failure messages with threads

### 15.4 After a Real Test Run

```bash
# Run tests, generate report, then notify Slack
npm test || true
npm run sheets:generate
npm run notify:slack
```

---

## Appendix A: File Changes Summary

### New Files (Phase 1)

| File                              | Purpose                        |
| --------------------------------- | ------------------------------ |
| `cypress/scripts/notify-slack.ts` | Reads failures, posts to Slack |

### New Files (Phase 2)

| File                                           | Purpose                   |
| ---------------------------------------------- | ------------------------- |
| `cypress/scripts/investigate-failures.ts`      | Agent orchestration       |
| `cypress/scripts/tools/github-tools.ts`        | GitHub API wrappers       |
| `cypress/scripts/tools/sheets-history-tool.ts` | Historical data queries   |
| `cypress/scripts/tools/dom-analyzer-tool.ts`   | DOM snapshot analysis     |
| `cypress/scripts/tools/slack-tools.ts`         | Slack reply functionality |

### Modified Files

| File                                  | Change                                               |
| ------------------------------------- | ---------------------------------------------------- |
| `.github/workflows/cypress-tests.yml` | Add notify-slack and investigate steps               |
| `package.json`                        | Add `@slack/web-api`, `@anthropic-ai/sdk`, `octokit` |
| `.env.example`                        | Add Slack and Anthropic env vars                     |
| `AGENTS.md`                           | Document new scripts and commands                    |

### New GitHub Secrets

| Secret                   | Phase |
| ------------------------ | ----- |
| `SLACK_BOT_TOKEN`        | 1     |
| `SLACK_CHANNEL_ID`       | 1     |
| `ANTHROPIC_API_KEY`      | 2     |
| `WASTEHERO_GITHUB_TOKEN` | 2     |
| `WASTEHERO_REPO`         | 2     |

---

## Appendix B: Slack App Manifest (for quick setup)

```yaml
display_information:
  name: QA Bug Reporter
  description: Automated bug investigation from Cypress E2E tests
  background_color: '#2c2d30'

features:
  bot_user:
    display_name: QA Bug Reporter
    always_online: false

oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize
      - files:write
      - channels:read
      - groups:read

settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```
