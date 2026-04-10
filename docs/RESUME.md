# Garbage Collection — Setup Guide

Pick up from here to get the PoC running end-to-end.

## Prerequisites

- Docker Desktop running
- Slack workspace with a channel for QA notifications
- Anthropic API key
- GitHub PAT with read access to the WasteHero app repo

## Step 1: Start Infrastructure

```bash
docker compose up -d
```

This starts 3 containers:
- **MongoDB** (port 27017) — test result persistence
- **QA API** (port 3001) — Express API
- **Cloudflare Tunnel** — public HTTPS URL for Slack webhooks

Get the tunnel URL:

```bash
docker compose logs tunnel | grep "trycloudflare"
```

You'll see something like `https://xxxx.trycloudflare.com`. This URL **changes on restart**.

Verify it works:

```bash
curl https://xxxx.trycloudflare.com/health
# → {"status":"ok","mongo":"connected"}
```

## Step 2: Create Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name: `GC Bot` (or whatever you like)
3. Pick your workspace

### Bot Token Scopes (OAuth & Permissions)

Add these scopes:
- `chat:write` — post messages
- `chat:write.public` — post to channels without joining

Install the app to your workspace. Copy the **Bot User OAuth Token** (`xoxb-...`).

### Interactivity

1. Go to **Interactivity & Shortcuts** → toggle **On**
2. Set **Request URL** to: `{TUNNEL_URL}/api/v1/slack/interactions`
   - Example: `https://xxxx.trycloudflare.com/api/v1/slack/interactions`
3. Save

### Get Channel ID

Right-click your QA channel → **View channel details** → copy the **Channel ID** at the bottom (starts with `C`).

## Step 3: Fill in .env

Open `.env` and set these values:

```env
# Infrastructure
QA_API_URL=https://xxxx.trycloudflare.com

# Slack
SLACK_BOT_TOKEN=xoxb-your-actual-token
SLACK_CHANNEL_ID=C0123456789

# AI Agent
ANTHROPIC_API_KEY=sk-ant-your-actual-key
WASTEHERO_GITHUB_TOKEN=ghp_your-actual-token
WASTEHERO_REPO=yourorg/wastehero-app

# App under test
BASE_URL=https://your-staging-url.com
TEST_ADMIN_EMAIL=your-test-admin@example.com
TEST_ADMIN_PASSWORD=your-test-password
```

## Step 4: Test the Pipeline Locally

Run each step sequentially to verify:

```bash
# 1. Run Cypress tests (will fail against staging — that's fine for testing GC)
npm run cypress:run || true

# 2. Generate the report
npm run report:generate

# 3. Send Slack notifications (Phase 1)
npm run notify:slack

# 4. Run Mark (audit agent)
npm run gc:mark
```

### What to expect

- **Step 2**: Creates `cypress/results/sheets-report.json` and persists results to API
- **Step 3**: Posts failure summaries to Slack, saves `cypress/results/slack-threads.json`
- **Step 4**: Mark investigates each failure, posts [Approve Fix] / [Skip] buttons to Slack

## Step 5: Test the Approval Flow

1. In Slack, click **[Approve Fix]** on one of Mark's findings
2. Watch the API logs: `docker compose logs -f qa-api`
3. Sweep should spawn and start creating a draft PR

## Step 6: GitHub Actions Secrets (Later)

When ready for CI, add these secrets to your GitHub repo (Settings → Secrets):

| Secret | Value |
|--------|-------|
| `QA_API_URL` | Your tunnel URL |
| `SLACK_BOT_TOKEN` | xoxb-... |
| `SLACK_CHANNEL_ID` | C... |
| `ANTHROPIC_API_KEY` | sk-ant-... |
| `WASTEHERO_GITHUB_TOKEN` | ghp_... |
| `WASTEHERO_REPO` | org/repo |
| `BASE_URL` | Staging URL |
| `TEST_ADMIN_EMAIL` | Test admin email |
| `TEST_ADMIN_PASSWORD` | Test admin password |

## Troubleshooting

**Tunnel URL changed?**
```bash
docker compose logs tunnel | grep "trycloudflare"
```
Update `QA_API_URL` in `.env` and Slack App interactivity URL.

**API not responding?**
```bash
docker compose ps          # check container status
docker compose logs qa-api # check for errors
```

**Mark finds no failures?**
Ensure `cypress/results/sheets-report.json` exists and has FAILED results:
```bash
cat cypress/results/sheets-report.json | jq '.summary'
```

**Slack buttons not working?**
- Verify interactivity URL is set in Slack App settings
- Check API logs: `docker compose logs -f qa-api`
- Ensure the tunnel URL in Slack matches the current running tunnel
