# AGENTS.md - WasteHero Cypress E2E Testing Guide

This document provides coding guidelines and conventions for AI agents working on this project.

---

## Commands

### Installation

```bash
npm install
cd api && npm install   # API dependencies (separate package.json)
```

### Running Tests

```bash
# Open Cypress Test Runner (interactive mode)
npm run cypress:open

# Run all tests (headless)
npm test
npm run cypress:run

# Run tests in specific browser
npm run cypress:run:chrome
npm run cypress:run:firefox
npm run cypress:run:edge

# Run tests with browser visible
npm run test:headed

# Run a single test file
npm run test:spec "cypress/e2e/authentication/FR-001-login.cy.ts"

# Run tests by tag
npm run test:smoke      # Run smoke tests
npm run test:critical   # Run critical tests
npm run test:regression # Run regression tests

# Run PD-042 suite
npm run test:pd042
npm run test:pd042:html  # With HTML report
```

### Reports & Notifications

```bash
npm run report:generate  # Parse mochawesome -> sheets-report.json
npm run report:html      # Generate HTML report
npm run report:full      # Generate + HTML
npm run notify:slack     # Post failures to Slack
```

### Garbage Collection (Agentic Pipeline)

```bash
npm run gc:mark          # Audit agent: investigate failures, post to Slack
npm run gc:sweep         # Fix agent: create draft PRs from approved fixes
```

### Onboarding Video Recording

```bash
npm run onboarding:discover              # Deep crawl WasteHero UI
npm run onboarding:video:export          # Record: Export to Excel
npm run onboarding:video:create-container # Record: Create a Container
npm run onboarding:video:change-language  # Record: Change Language
npm run onboarding:video:impersonate-user # Record: Impersonate User
npm run onboarding:video:customer-service # Record: Customer Service Lookup
```

### Linting & Formatting

```bash
npm run lint             # Run ESLint
npm run lint:fix         # Fix ESLint issues
npm run format           # Format with Prettier
npm run format:check     # Check formatting
npm run type-check       # TypeScript type checking
```

### Infrastructure

```bash
docker compose up -d     # Start MongoDB + QA API + Cloudflare Tunnel
docker compose logs tunnel | grep "trycloudflare"  # Get webhook URL
```

---

## Project Structure

```
wastehero-cypress-tests/
|
|-- .github/workflows/
|   |-- cypress-tests.yml              # CI: install -> run -> report -> notify -> gc:mark
|
|-- api/                               # Express API (runs in Docker, port 3001)
|   |-- server.ts                      # Entry point
|   |-- models/
|   |   |-- test-run.ts                # Mongoose: test run metadata
|   |   |-- test-result.ts             # Mongoose: individual test results
|   |   |-- agent-investigation.ts     # Mongoose: GC agent findings
|   |-- routes/
|       |-- runs.ts                    # CRUD for test runs
|       |-- results.ts                 # CRUD for test results
|       |-- investigations.ts          # CRUD for agent investigations
|       |-- slack-webhooks.ts          # Slack interactive button handler
|
|-- cypress/
|   |-- e2e/                           # Test specs
|   |   |-- authentication/
|   |   |   |-- FR-001-login.cy.ts
|   |   |-- FR-020/                    # 23 specs (FR-020-001 to FR-020-023)
|   |   |-- PD-042/                    # 5 specs (billing, categories, data-transfer, reports)
|   |-- fixtures/
|   |   |-- testData.json
|   |   |-- customerCategories.json
|   |-- plugins/
|   |   |-- error-classifier.ts        # Classify test failures by type
|   |   |-- step-logger.ts             # Log test steps for debugging
|   |   |-- test-reporter.ts           # Custom Mochawesome reporter hooks
|   |-- results/                       # Generated test results (gitignored)
|   |-- scripts/
|   |   |-- generate-report.ts         # Mochawesome -> sheets-report.json
|   |   |-- generate-html-report.ts    # HTML report generator
|   |   |-- notify-slack.ts            # Post failure summary to Slack
|   |   |-- gc/                        # Garbage Collection pipeline
|   |       |-- mark.ts                # Phase 1: audit agent (Claude API)
|   |       |-- sweep.ts               # Phase 2: fix agent (draft PRs)
|   |       |-- tools/
|   |           |-- github-tools.ts        # GitHub read (search, files, commits)
|   |           |-- github-write-tools.ts  # GitHub write (branch, update, PR)
|   |           |-- slack-tools.ts         # Slack reply tool
|   |           |-- dom-analyzer-tool.ts   # DOM snapshot analysis
|   |           |-- history-tool.ts        # Test history + flakiness
|   |           |-- cypress-runner-tool.ts # Re-run tests + Slack confirmation
|   |-- support/
|       |-- commands.ts                # Custom Cypress commands
|       |-- e2e.ts                     # Global hooks and setup
|       |-- test-context.ts            # Test context management
|       |-- helpers/
|       |   |-- authHelpers.ts         # Login/session helpers
|       |-- page-objects/
|       |   |-- LoginPage.ts
|       |   |-- DashboardPage.ts
|       |   |-- ContactsPage.ts
|       |   |-- CustomerCategoriesPage.ts
|       |-- types/
|           |-- test-results.ts        # Test result type definitions
|
|-- scripts/
|   |-- onboarding/                    # QA onboarding video system
|       |-- discover.ts                # Deep crawl: screenshots, a11y, actions, mutations
|       |-- videos/
|           |-- create-container.ts
|           |-- export-to-excel.ts
|           |-- change-language.ts
|           |-- impersonate-user.ts
|           |-- customer-service-lookup.ts
|
|-- onboarding-output/                 # Generated onboarding artifacts (gitignored)
|   |-- deep-flow-map.json             # Primary source of truth (from discover)
|   |-- flow-map.json                  # Legacy format
|   |-- wastehero-platform-reference.md # Architecture reference
|   |-- screenshots/                   # Page screenshots
|   |-- snapshots/                     # Accessibility snapshots
|   |-- videos/
|       |-- <topic-slug>/              # Each video in its own folder
|           |-- <topic-slug>.mp4       # Final video with TTS
|           |-- <topic-slug>.webm      # Raw video
|           |-- tts-segments/          # TTS audio files
|
|-- .claude/
|   |-- settings.json                  # Claude Code project settings
|   |-- skills/
|       |-- QA/skill.md               # /QA skill (discover, video, onboard)
|
|-- docs/
|   |-- DESIGN-DOC-agentic-bug-investigation.md  # GC pipeline design doc
|   |-- SECURITY.md                    # Security best practices
|   |-- RESUME.md                      # GC setup guide
|
|-- .env.example                       # Environment variable template
|-- .eslintrc.json                     # ESLint config
|-- .prettierrc                        # Prettier config
|-- cypress.config.ts                  # Cypress configuration
|-- docker-compose.yml                 # MongoDB + API + Tunnel
|-- package.json                       # Root dependencies + scripts
|-- tsconfig.json                      # TypeScript config
```

---

## Code Style Guidelines

### File Naming Conventions

- **Test files**: `FR-{ID}-{description}.cy.ts` or `PD-{ID}-{description}.cy.ts`
- **Page Objects**: `PascalCase.ts` (e.g., `LoginPage.ts`, `DashboardPage.ts`)
- **Helper files**: `camelCase.ts` (e.g., `authHelpers.ts`)
- **Fixtures**: `camelCase.json` (e.g., `testData.json`)
- **Video scripts**: `kebab-case.ts` (e.g., `customer-service-lookup.ts`)

### TypeScript Guidelines

- Strict typing - avoid `any`
- Selectors as `private readonly` in page objects
- Single quotes, semicolons, 2-space indent (Prettier)
- Explicit return types for functions

### Test Structure

Use **Arrange-Act-Assert (AAA)**:

```typescript
describe('FR-XXX: Feature Name', { tags: ['@priority'] }, () => {
  beforeEach(() => { /* common setup */ });

  context('Happy Path', () => {
    it('should perform main functionality', () => {});
  });

  context('Edge Cases', () => {
    it('should handle edge case', () => {});
  });
});
```

### Selectors

- Prefer `data-testid` for stability
- Use semantic selectors as fallback: `button[type="submit"]`
- Avoid CSS classes that may change

### Tags

- `@critical` - Must pass before deployment
- `@smoke` - Quick validation (5-10 min)
- `@regression` - Full test suite

---

## Security

- **NEVER hardcode** credentials in test files
- **USE `.env`** for secrets (gitignored)
- **ACCESS via** `Cypress.env('KEY')`
- **NEVER test on production** - use `app-development.wastehero.io`
- **PREFIX test data** with `[TEST]` for cleanup
- Onboarding scripts include `assertNotProduction()` safety guard

See `docs/SECURITY.md` for full guidelines.
