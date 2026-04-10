# WasteHero QA Automation Suite

End-to-end test automation for the [WasteHero](https://wastehero.io) waste management platform — combining **Cypress E2E tests**, an **agentic bug investigation pipeline** (Mark & Sweep), and an **AI-powered onboarding video system**.

---

## Table of Contents

- [QA Onboarding Video System](#qa-onboarding-video-system)
  - [Demo](#demo)
  - [Prerequisites](#prerequisites-onboarding)
  - [Quick Start](#quick-start-onboarding)
  - [Available Videos](#available-videos)
  - [Creating New Videos](#creating-new-videos)
  - [How It Works](#how-it-works)
- [Garbage Collection: Mark & Sweep](#garbage-collection-mark--sweep)
  - [Overview](#overview)
  - [Prerequisites](#prerequisites-gc)
  - [Infrastructure Setup](#infrastructure-setup)
  - [Running the Pipeline](#running-the-pipeline)
  - [Slack Integration](#slack-integration)
  - [CI/CD Integration](#cicd-integration)
- [Cypress E2E Tests](#cypress-e2e-tests)
  - [Prerequisites](#prerequisites-tests)
  - [Running Tests](#running-tests)
  - [Test Structure](#test-structure)
- [Project Structure](#project-structure)

---

## QA Onboarding Video System

Automatically generate narrated how-to videos for the WasteHero platform using **Playwright** for browser recording and **ElevenLabs** for Danish/English TTS narration.

### Demo

> **Customer Service: Look Up a Customer**
> Navigate to a property, view waste fractions, route & pickup info, contracts, and owner details.

<video src="docs/demo/customer-service-lookup.mp4" controls width="100%"></video>

*Video recorded automatically via Playwright with on-screen step labels. TTS narration is overlaid when ElevenLabs quota is available.*

### Prerequisites (Onboarding)

| Requirement | Version | Purpose |
|-------------|---------|---------|
| **Node.js** | 18+ | Runtime |
| **npm** | 9+ | Package manager |
| **Playwright** | 1.59+ | Browser automation & video recording |
| **ffmpeg-static** | 5.x | Audio/video merging (installed via npm) |
| **Claude Code** | Latest | Runs the `/QA` skill for script generation |

**API Keys** (set in `.env`):

| Key | Required | Purpose |
|-----|----------|---------|
| `ELEVENLABS_API_KEY` | For TTS | Danish/English narration (ElevenLabs free tier works) |

**Access**:
- WasteHero development environment (`app-development.wastehero.io`)
- Test account credentials (pre-configured in scripts)

**Optional** (for generating new video scripts):
- WasteHero frontend source code at `C:\Users\YahyaAli\Desktop\wastehero_frontend\src\` (used by the `/QA onboard` skill to analyze UI components)

### Quick Start (Onboarding)

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers
npx playwright install chromium

# 3. Run an existing video script
npm run onboarding:video:customer-service

# 4. Find output in:
#    onboarding-output/videos/customer-service-lookup/
#      customer-service-lookup.mp4   (final video with TTS)
#      customer-service-lookup.webm  (raw video, no audio)
```

### Available Videos

| npm Script | Description | Output Folder |
|------------|-------------|---------------|
| `onboarding:video:customer-service` | Look up customer, waste fractions, route/pickup, contracts, owner | `customer-service-lookup/` |
| `onboarding:video:export` | Export filtered data to Excel | `export-to-excel/` |
| `onboarding:video:create-container` | Create a new container in Assets | `create-container/` |
| `onboarding:video:change-language` | Change the platform language | `change-language/` |
| `onboarding:video:impersonate-user` | Impersonate a user (staff only) | `impersonate-user/` |

All output is written to `onboarding-output/videos/<topic>/`.

### Creating New Videos

Use the Claude Code `/QA onboard` skill to generate new video scripts from a free-text topic:

```
/QA onboard create a ticket --lang=da --description="Show how to create a support ticket"
```

The skill runs a **7-phase pipeline**:

| Phase | Name | What Happens |
|-------|------|--------------|
| 1 | **Resolve** | Match topic to a module in the platform (via `deep-flow-map.json` or frontend source) |
| 2 | **Analyze** | Deep-dive into frontend source code to map the UI flow, selectors, and mutations |
| 3 | **Narrate** | Generate TTS narration script in Danish/English. **Waits for user approval** before calling ElevenLabs |
| 4 | **Discover** | Headless Playwright pass to verify selectors and capture actual UI state |
| 5 | **Dry-run** | Full end-to-end headless validation with timing |
| 6 | **Record** | Generate the TypeScript video script file |
| 7 | **Execute** | Run the script, verify output, report results |

**Discovery crawl** (rebuilds the platform map):

```bash
npm run onboarding:discover
# Output: onboarding-output/deep-flow-map.json
```

### How It Works

Each video script follows a 3-phase recording strategy:

1. **TTS Pre-generation** — calls ElevenLabs API to generate all narration audio segments upfront, measures exact durations
2. **Video Recording** — launches a headed Playwright browser at 2560x1440, paces each step to match its TTS segment duration, overlays subtitle labels and step badges, highlights UI elements with spotlight effect
3. **ffmpeg Merge** — overlays TTS audio onto the video at the recorded timestamps, outputs final `.mp4`

All scripts include `assertNotProduction()` — they **refuse to run** against `app.wastehero.io`.

---

## Garbage Collection: Mark & Sweep

An agentic pipeline that **automatically investigates test failures** using Claude, posts findings to Slack with actionable buttons, and creates draft PRs for approved fixes.

### Overview

```
Cypress Tests (CI)
       |
       v
  notify:slack          Post failure summary to Slack
       |
       v
  gc:mark               Claude agent investigates each failure:
       |                   - Reads test code + error messages
       |                   - Searches app source (GitHub API)
       |                   - Analyzes DOM snapshots
       |                   - Checks test history for flakiness
       |                   - Posts findings + [Approve Fix] [Skip] buttons
       v
  Slack HITL             Human reviews findings, clicks Approve or Skip
       |
       v
  gc:sweep               For approved fixes:
                           - Creates a branch
                           - Applies the fix (max 2 files)
                           - Opens a DRAFT PR
```

### Prerequisites (GC)

| Requirement | Version | Purpose |
|-------------|---------|---------|
| **Node.js** | 18+ | Runtime |
| **Docker Desktop** | Latest | MongoDB + API + Cloudflare Tunnel |
| **Slack Workspace** | - | Notification channel + interactive buttons |

**API Keys & Tokens** (set in `.env`):

| Key | Required | Purpose |
|-----|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claude API for agent investigations |
| `SLACK_BOT_TOKEN` | Yes | Post messages, read channels (`xoxb-...`) |
| `SLACK_CHANNEL_ID` | Yes | Target channel for notifications |
| `WASTEHERO_GITHUB_TOKEN` | Yes | GitHub PAT — read source code, create PRs |
| `WASTEHERO_REPO` | Yes | GitHub repo in `org/repo` format |
| `QA_API_URL` | Yes | API endpoint (local or tunnel URL) |

**Slack App Configuration**:

Your Slack App needs these scopes:
- `chat:write` — post messages
- `files:write` — upload reports
- `commands` — (optional) slash commands

Under **Interactivity & Shortcuts**, set the Request URL to:
```
{YOUR_TUNNEL_URL}/api/v1/slack/interactions
```

### Infrastructure Setup

```bash
# 1. Copy environment template
cp .env.example .env
# Edit .env with your API keys and tokens

# 2. Start infrastructure (MongoDB + API + Tunnel)
docker compose up -d

# 3. Get the public tunnel URL
docker compose logs tunnel | grep "trycloudflare"
# Output: https://xxxx.trycloudflare.com

# 4. Update .env with the tunnel URL
# QA_API_URL=https://xxxx.trycloudflare.com

# 5. Set the Slack interactivity URL
# Go to https://api.slack.com/apps > Your App > Interactivity
# Request URL: https://xxxx.trycloudflare.com/api/v1/slack/interactions
```

**Docker services**:

| Service | Port | Purpose |
|---------|------|---------|
| `mongodb` | 27017 | Test result persistence |
| `qa-api` | 3001 | Express API (runs, results, investigations, Slack webhooks) |
| `tunnel` | - | Cloudflare Tunnel (public HTTPS URL for Slack) |

> **Note**: The quick-start tunnel URL **changes on restart**. For a persistent URL, create a named Cloudflare tunnel (see `docker-compose.yml` comments).

### Running the Pipeline

```bash
# Run the full pipeline manually:

# 1. Run tests (generates results)
npm test

# 2. Generate report
npm run report:full

# 3. Post failures to Slack
npm run notify:slack

# 4. Run the audit agent (investigates failures, posts to Slack)
npm run gc:mark

# 5. After approving fixes in Slack, run the fix agent
npm run gc:sweep
```

**Mark agent tools**:

| Tool | Purpose |
|------|---------|
| `github_search` | Search app source for relevant code |
| `github_get_file` | Read specific source files |
| `github_get_commits` | Check recent changes |
| `github_get_pr` | Review related PRs |
| `slack_reply` | Post findings to Slack thread |
| `dom_analyzer` | Analyze DOM snapshots from failed tests |
| `test_history` | Check flakiness and historical pass rates |
| `cypress_runner` | Re-run tests with Slack confirmation gate |

**Sweep agent tools** (write operations):

| Tool | Purpose |
|------|---------|
| `github_create_branch` | Create fix branch |
| `github_update_file` | Apply code changes (max 2 files) |
| `github_create_pr` | Open DRAFT pull request |

### Slack Integration

After `gc:mark` runs, each failure gets a Slack message with:

- Root cause analysis
- Suggested fix with code snippets
- Confidence level
- **[Approve Fix]** — triggers `gc:sweep` to create a draft PR
- **[Skip]** — marks the investigation as skipped
- **[Re-run]** — re-executes the test to confirm it's not flaky

### CI/CD Integration

The GitHub Actions workflow (`.github/workflows/cypress-tests.yml`) runs the full pipeline automatically:

```
Trigger: push to master/main/develop, daily at 8:00 UTC, or manual

Steps:
  1. Checkout + install
  2. Cypress run (chrome, headless)
  3. Generate report (sheets-report.json + HTML)
  4. Slack notification (failure summary)
  5. gc:mark (audit agent — posts findings for morning review)
  6. Upload artifacts (videos, screenshots, results)
  7. Job summary (pass/fail counts)
```

**Required GitHub Secrets**:

| Secret | Value |
|--------|-------|
| `BASE_URL` | WasteHero staging URL |
| `TEST_ADMIN_EMAIL` | Test account email |
| `TEST_ADMIN_PASSWORD` | Test account password |
| `ANTHROPIC_API_KEY` | Claude API key |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_CHANNEL_ID` | Slack channel ID |
| `WASTEHERO_GITHUB_TOKEN` | GitHub PAT |
| `WASTEHERO_REPO` | `org/repo` |
| `QA_API_URL` | Tunnel URL |

---

## Cypress E2E Tests

### Prerequisites (Tests)

| Requirement | Version | Purpose |
|-------------|---------|---------|
| **Node.js** | 18+ | Runtime |
| **npm** | 9+ | Package manager |
| **Chrome** | Latest | Default test browser |

```bash
# 1. Install
npm install

# 2. Set up environment
cp .env.example .env
# Fill in BASE_URL, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD

# 3. Run
npm test                    # Headless
npm run cypress:open        # Interactive
npm run test:headed         # Headed
```

### Running Tests

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests headless |
| `npm run cypress:open` | Open Cypress interactive runner |
| `npm run test:headed` | Run headless with browser visible |
| `npm run cypress:run:chrome` | Chrome specifically |
| `npm run test:smoke` | Smoke tests only (`@smoke` tag) |
| `npm run test:critical` | Critical tests only (`@critical` tag) |
| `npm run test:pd042` | PD-042 suite only |
| `npm run report:full` | Generate JSON + HTML reports |

### Test Structure

| Suite | Specs | Coverage |
|-------|-------|----------|
| `FR-001` | 1 | Authentication / Login |
| `FR-020` | 23 | Core workflows (FR-020-001 through FR-020-023) |
| `PD-042` | 5 | Billing, categories, data transfer, reports |

Tests use the **Page Object Model** with `private readonly` selectors and follow the **Arrange-Act-Assert** pattern.

---

## Project Structure

```
wastehero-cypress-tests/
|
|-- .github/workflows/cypress-tests.yml    CI pipeline
|
|-- api/                                   Express API (Docker, port 3001)
|   |-- server.ts
|   |-- models/                            Mongoose schemas
|   |-- routes/                            REST endpoints + Slack webhook
|
|-- cypress/
|   |-- e2e/                               Test specs
|   |   |-- authentication/FR-001-login.cy.ts
|   |   |-- FR-020/                        23 specs
|   |   |-- PD-042/                        5 specs
|   |-- fixtures/                          Test data
|   |-- plugins/                           Error classifier, step logger, reporter
|   |-- scripts/
|   |   |-- generate-report.ts             Report generation
|   |   |-- generate-html-report.ts        HTML report
|   |   |-- notify-slack.ts               Slack notifications
|   |   |-- gc/                            Mark & Sweep pipeline
|   |       |-- mark.ts                    Audit agent
|   |       |-- sweep.ts                   Fix agent
|   |       |-- tools/                     6 agent tools
|   |-- support/                           Commands, page objects, helpers
|
|-- scripts/onboarding/                    QA video system
|   |-- discover.ts                        Platform discovery crawl
|   |-- videos/                            Video recording scripts
|
|-- onboarding-output/                     Generated artifacts (gitignored)
|   |-- videos/<topic-slug>/               Video output per topic
|
|-- docs/
|   |-- demo/                              README demo videos
|   |-- DESIGN-DOC-agentic-bug-investigation.md
|   |-- SECURITY.md
|   |-- RESUME.md                          GC setup guide
|
|-- docker-compose.yml                     MongoDB + API + Tunnel
|-- package.json
|-- cypress.config.ts
|-- tsconfig.json
```

---

## License

ISC
