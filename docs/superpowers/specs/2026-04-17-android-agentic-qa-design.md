# Android Agentic QA — Design Spec

**Date:** 2026-04-17
**Status:** Approved
**Topic:** Autonomous UI/UX exploration agent for the WasteHero React Native Android app
**Owner:** product.denmark.claude@wastehero.io

## 1. Goal

Build an autonomous QA agent that explores the WasteHero Android app (React Native), judges UI/UX quality across a defined set of categories, and produces human-reviewable reports. Approved findings are published to Linear with artifacts attached. The agent gets smarter across runs by persisting its map of the app and a history of findings.

This is a new, independent system. It does not share the Cypress-based pipeline architecture used by `packages/e2e`, `packages/reporting`, or `packages/gc-pipeline`. It lives as a new workspace package `packages/android-qa`.

## 2. Scope

### In scope (v1)

- Local Android emulator as the target device. Device access abstracted behind a driver interface so a device farm can be swapped in later.
- Curiosity-driven exploration: the agent autonomously picks unvisited screens and elements, builds and extends a map of the app, prioritizes unexplored surface area, judges UX at each step.
- Authenticated exploration using pre-seeded credentials in `.env` (one per role). Agent picks a role per run.
- Finding categories:
  - **A.** Hard failures — crashes, ANRs, white screens, infinite spinners, network errors shown to user
  - **B.** Broken interactions — taps that do nothing, visibly-disabled buttons without explanation, forms that reject valid input, unexpected navigation loops
  - **C.** Visual bugs — text overflow/truncation, overlapping elements, off-screen content, misaligned layouts, missing images, broken icons
  - **D.** Copy/content — typos, untranslated strings, placeholder text, broken formatting
  - **E.** UX judgment — confusing labels, unclear error messages, missing confirmation on destructive actions
- Output per run: `report.md` (with `☐/☑` checkboxes), full video, logcat, per-finding screenshot/clip/logcat excerpt, full `session.json` trace.
- Publisher: reads ticked findings from `report.md`, creates Linear issues with artifacts attached.
- Triggers: on-demand CLI + scheduled (nightly) run. Scheduled runs never auto-publish.
- Persistent memory across runs: `app-map.json` + `findings-history.jsonl`.

### Out of scope (v1)

- Accessibility audit (category F) — warrants its own scanner (Android accessibility scanner integration) later.
- Performance/perf-regression (category G) — warrants tracing-based tooling later.
- Multi-device parallelism. One emulator at a time.
- Cloud device farm integration. Design accommodates it; implementation is deferred.
- iOS. Android only.
- Automatic closing/updating of Linear issues when findings are marked resolved. Publisher is write-only in v1.
- Auto-retry of aborted runs.

## 3. Architecture

### 3.1 Runtime topology

```
┌────────────────────────────────────────────────────────────────────┐
│  packages/android-qa  (Node + TypeScript)                          │
│                                                                    │
│   ┌──────────────┐   tree+screenshot    ┌──────────────────────┐   │
│   │  Agent Loop  │ ◄──────────────────  │  Device Driver       │   │
│   │  (Claude     │                      │  (Appium client)     │   │
│   │   reasoning) │  tap/type/swipe ───► │                      │   │
│   └──────┬───────┘                      └──────────┬───────────┘   │
│          │                                         │               │
│          │ findings + events                       │ Appium WD     │
│          ▼                                         ▼               │
│   ┌──────────────┐                      ┌──────────────────────┐   │
│   │  Recorder    │                      │  Appium Server       │   │
│   │  (markdown,  │                      │  (UIAutomator2)      │   │
│   │  screenshots,│                      └──────────┬───────────┘   │
│   │  logcat,     │                                 │ ADB           │
│   │  video)      │                                 ▼               │
│   └──────────────┘                      ┌──────────────────────┐   │
│                                         │  Android Emulator    │   │
│                                         │  (WasteHero APK)     │   │
│                                         └──────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
                   │
                   ▼ on `android-qa:publish` (after human ticks boxes)
          ┌──────────────────────┐
          │  Linear MCP client   │  creates issues w/ attachments
          └──────────────────────┘
```

### 3.2 Components

- **Agent Loop** (`src/agent/`) — Claude API client running the perceive → evaluate → decide → act cycle. Owns in-memory session state. Only this module talks to Claude.
- **Device Driver** (`src/device/`) — thin abstraction over Appium WebDriver. Exposes `tap`, `type`, `swipe`, `back`, `scrollTo`, `getViewTree`, `screenshot`, `getCurrentActivity`, `isAppAlive`. Only this module talks to Appium/ADB. Swapping to a different backend (cloud farm, DeviceFarmer) means replacing this module's implementation, not the agent.
- **Appium Server** — standard `appium` process with `uiautomator2` driver. Started automatically by the package at run time (spawned child process), torn down on exit.
- **Android Emulator** — locally-created AVD (Pixel 7 / API 34 by default; configurable via `ANDROID_AVD_NAME`). APK installed from `WASTEHERO_APK_PATH`. Emulator lifecycle (boot, wait-for-ready, snapshot, shutdown) handled by `src/device/emulator.ts`.
- **Recorder** (`src/recorder/`) — owns `output/android-qa/<runId>/`. Writes append-only `session.json` after every turn (fsync on turn boundary). Manages screenshot capture, `adb screenrecord` lifecycle, logcat tail capture.
- **Reporter** (`src/report/`) — at end of run, renders `report.md` from `session.json` + findings history. Slices per-finding artifacts (video clips, logcat excerpts) out of the full-session artifacts.
- **Publisher** (`src/publish/`) — separate CLI entrypoint. Parses `report.md`, creates Linear issues for ticked findings via Linear MCP tools. Handles artifact hosting (see §7.3).
- **State store** (`src/state/`) — read/write helpers for `packages/android-qa/state/app-map.json` and `packages/android-qa/state/findings-history.jsonl`. Atomic writes (temp file + rename).

### 3.3 CLI entrypoints (bin scripts)

- `android-qa:explore` — start a run
- `android-qa:publish --run <runId>` — push ticked findings to Linear
- `android-qa:smoke` — 3-min bounded run against canary APK (CI)
- `android-qa:replay --run <runId>` — replay a recorded session for debugging
- `android-qa:eval-judgment` — run the Evaluate prompt against the labeled fixtures set
- `android-qa:reset-state` — archive current state, start fresh (for major app rewrites)

### 3.4 Package layout

```
packages/android-qa/
├── package.json                      (@wastehero-qa/android-qa)
├── tsconfig.json                     (extends ../../tsconfig.base.json)
├── bin/                              (CLI entry scripts)
│   ├── explore.ts
│   ├── publish.ts
│   ├── smoke.ts
│   ├── replay.ts
│   ├── eval-judgment.ts
│   └── reset-state.ts
├── src/
│   ├── agent/                        (perceive, evaluate, decide, prompts)
│   ├── device/                       (Driver interface + Appium impl + emulator mgmt)
│   ├── recorder/                     (session.json, screenshots, video, logcat)
│   ├── report/                       (report.md renderer)
│   ├── publish/                      (Linear MCP bridge, artifact hosting)
│   ├── state/                        (app-map + findings-history I/O)
│   ├── config/                       (env + constants)
│   └── types/                        (shared TS types)
├── state/                            (VERSIONED)
│   ├── app-map.json
│   └── findings-history.jsonl
├── test-fixtures/
│   ├── sessions/                     (replay test inputs)
│   ├── screens/                      (judgment eval labeled screenshots)
│   └── view-trees/                   (fingerprinting unit test inputs)
└── README.md
```

Per-run artifacts live outside the package in `output/android-qa/<runId>/` (gitignored).

## 4. Agent loop

### 4.1 Session state (in memory + checkpointed to `session.json`)

- **Screen map** — set of distinct screens visited in this run, keyed by fingerprint. Deltas applied to the persistent `app-map.json` at run end (not mid-run, to keep the persistent store consistent in case of abort).
- **Frontier** — per-screen queue of unvisited/deprioritized interactive elements.
- **Findings** — running list of issues noticed so far, each with category (A–E), severity, screen, element, artifact refs, Claude reasoning.
- **Action history** — last N actions (screen → action → outcome) for anti-loop detection.
- **Budget** — seconds remaining, turns remaining.
- **Counters** — crash count, consecutive-no-new-screen count, malformed-response count.

### 4.2 Screen fingerprint

Stable hash (SHA-1 → first 16 hex chars) of:
- Current activity name
- Sorted list of `(resource-id, class, isClickable)` tuples for elements with non-empty `resource-id`

Deliberately ignores text content (so text changes don't create new fingerprints) and bounds (so layout jitter doesn't either). Sensitive to new/removed elements. Cosmetic changes do not create new fingerprints; structural changes do.

### 4.3 One turn

```
1. PERCEIVE
   - Always: get view tree (UIAutomator2)
   - Always: capture screenshot (cheap, goes to run artifacts)
   - Compute fingerprint; if new, push new interactive elements onto frontier
     (respecting persistent app-map priorities)
   - Capture logcat delta since previous turn

2. EVALUATE
   - Cheap always-on checks:
     - Logcat delta contains FATAL EXCEPTION / ANR → category A finding
     - Tree contains error banners / "Something went wrong" text → candidate A/B
   - Vision pass (triggered when):
     - New screen (first-time visit this run), OR
     - Tree looks suspicious (empty, unchanged after action, error-looking text), OR
     - Every Nth turn (default N=10) for periodic re-check
   - Vision returns JSON list of findings in categories C/D/E with severity
     and element reference, plus optional A/B confirmations.
   - Findings deduped against in-run + persistent history by (screenFp, element, category)
     plus Claude-scored fuzzy match on summary.

3. DECIDE
   - Claude text call with:
     - Current screen fingerprint + compact tree (only interactive elements + visible text)
     - Current frontier (top K unvisited elements, K=20)
     - Recent action history (last 5)
     - Budget remaining
     - List of known-triaged findings on this screen (so agent doesn't repeat them)
   - Returns ONE of:
     tap(elementId) | type(elementId, text) | swipe(direction) | back()
     | scrollTo(elementId) | done(reason)
   - Heuristics enforced outside the prompt:
     - Prefer frontier elements
     - Never repeat last action if fingerprint didn't change
     - Never tap destructive-action deny list (see §4.5)

4. ACT
   - Device Driver executes. Wait for screen-settled (no layout change 500ms)
     OR activity-changed signal, capped at 10s.
   - Record action + duration + before/after screenshots to session.json.

5. CHECK TERMINATION
   - Stop if:
     * time budget elapsed, OR
     * frontier empty across all screens in this run's map AND across any app-map
       screens reachable from here (curiosity exhausted), OR
     * turn budget elapsed, OR
     * agent returned done().
```

### 4.4 Prompting

Two Claude calls per turn maximum (often one — Evaluate skipped on most turns).

- **Model:** `claude-opus-4-7` for both Evaluate and Decide. We prioritize judgment quality over cost in v1; can downgrade Decide to `claude-sonnet-4-6` if latency becomes an issue.
- **Prompt caching:** system prompts + stable context (app version, session id, role) cached across turns.
- **Structured output:** JSON-only responses. One retry on malformed JSON with an explicit "return only the JSON object" reprompt; second failure = turn becomes an event (not a finding).
- **Vision:** screenshot passed as an `image` content block on Evaluate turns only. Full-res PNG; model resizes internally.

### 4.5 Safety protections

- **Destructive-action deny list** — configurable `DENY_ACTIONS` env var + hardcoded defaults (`logout`, `sign-out`, `delete-account`, `delete-customer`, `delete-route`, `factory-reset`). Agent can observe these elements but the driver refuses to tap them and records the observation as a "deny-listed; not tested" event.
- **Anti-loop** — if same action 3× in a row with no fingerprint change → force `back()` + mark element `marked: broken` + record as finding B.
- **Anti-wander** — if 5 turns pass with no new screen → force `back()` to parent.
- **Modal first** — if screen has small-bounds overlay detected (bounds < 70% of device bounds + dim background), prefer dismissing before other actions.
- **Rate-limit guard** — at most 1 adversarial-shaped input per run (e.g. very long strings, SQL-fragment-like strings, control characters). Fuzz-testing is out of scope for v1; this bound only prevents the agent from accidentally stumbling into fuzz territory.

### 4.6 Anti-loop / reproducibility

Every turn appended to `session.json` before moving to the next. A crash mid-run leaves a resumable record. `replay` CLI re-drives the same action sequence on a fresh emulator for debugging (same pattern as existing onboarding recipes).

## 5. Persistent memory across runs

Two stores under `packages/android-qa/state/`, versioned in git.

### 5.1 `app-map.json`

Canonical structure:

```json
{
  "appVersion": "2.14.3",
  "generatedAt": "2026-04-17T09:30:00Z",
  "schemaVersion": 1,
  "screens": {
    "<fingerprint>": {
      "activity": "com.wastehero.MainActivity",
      "firstSeenRun": "run-20260410-…",
      "lastSeenRun":  "run-20260417-…",
      "seenCount": 12,
      "elements": {
        "<resource-id>": {
          "role": "button|input|text|list-item|…",
          "text": "Log in",
          "firstSeen": "…", "lastSeen": "…",
          "tapped": true,
          "outcomes": [
            { "action": "tap", "ledToScreen": "<fp>", "count": 5 },
            { "action": "tap", "ledToScreen": null, "count": 1, "note": "no change" }
          ],
          "marked": "broken"
        }
      }
    }
  },
  "transitions": [
    { "from": "<fpA>", "via": "tap:<elId>", "to": "<fpB>", "occurrences": 5 }
  ]
}
```

### 5.2 How a new run uses the map

1. **Warm start** — load `app-map.json` at run start.
2. **Smart frontier seeding** — per-screen frontier prioritized by:
   1. Elements never tapped (highest)
   2. Elements tapped but leading to screens with remaining unexplored elements
   3. Elements not seen in last M runs (re-validation; M=5 default)
   4. Elements marked `broken` (re-tested every M runs in case of fix)
3. **Navigation shortcuts** — to reach screen X from current, query transitions graph for known path, follow with vision-pass verification at each hop.
4. **Coverage signal** — "unexplored" measured against cumulative map. Five 20-min runs accumulate more coverage than one 100-min run.

### 5.3 `findings-history.jsonl`

Append-only (one JSON per line, easy to diff in git):

```json
{ "id": "f-0042", "runId": "run-…", "screenFp": "…", "element": "…",
  "category": "B", "severity": "med", "summary": "Save button disabled with no explanation",
  "firstSeenRun": "run-…", "lastSeenRun": "run-…", "occurrences": 3,
  "status": "open|triaged|published|resolved|resurrected",
  "linearIssueId": "WH-1234",
  "artifactRefs": { "screenshot": "…", "video": "…", "logcat": "…" } }
```

### 5.4 Deduplication and known-issue surfacing

On new finding:
- Match against history by `(screenFp, element, category)` + Claude-scored fuzzy summary match.
- `open`/`published`/`triaged` match → increment `occurrences`, update `lastSeenRun`, include under **"Previously seen"** in report.
- `resolved` match → regression. Mark `resurrected`, bump severity one level, include under **"Regressions"** in report.
- No match → new finding, under **"New this run"** in report.

### 5.5 App-version invalidation

- `app-map.json` records the app version from APK metadata (extracted via `aapt dump badging`).
- On version change: fingerprints not re-seen after 3 runs are archived (`status: "stale"`). A best-effort matcher links old→new fingerprints by activity + element-overlap, surfaced only as a hint on the Decide prompt.
- `reset-state` CLI archives current state (under `packages/android-qa/state/archive/<timestamp>/`) and starts empty.

### 5.6 Storage hygiene

- `app-map.json` + `findings-history.jsonl` committed to git under `packages/android-qa/state/`.
- Per-run artifacts in `output/android-qa/<runId>/` — gitignored.
- Archives in `packages/android-qa/state/archive/` — committed.

## 6. Data flow

### 6.1 Per-run artifact layout

```
output/android-qa/<runId>/              (gitignored)
├── report.md                           ← human reviews, ticks boxes
├── session.json                        ← full turn-by-turn trace
├── video.mp4                           ← full session (adb screenrecord, up to device-supported fps)
├── logcat.log                          ← full logcat for run
├── screenshots/
│   ├── turn-0001-before.png
│   ├── turn-0001-after.png
│   └── …
└── findings/
    ├── f-0042/
    │   ├── before.png
    │   ├── after.png
    │   ├── clip.mp4                    ← 8s window (±4s around the action)
    │   └── logcat-excerpt.log          ← ±30s window
    └── …
```

### 6.2 `report.md` structure

```markdown
# Android QA Run — run-20260417-0930

**App version:** 2.14.3
**Device:** Pixel 7 / API 34
**Duration:** 27m   **Turns:** 184   **Status:** completed
**Screens visited:** 23 (of 31 known)
**Coverage delta:** +4 new screens, +47 new elements tapped

## Run status
completed — budget reached, frontier not fully exhausted

## Regressions (previously resolved, now back) — 1

### ☐ f-0087 — [HIGH] Crash when opening Route Detail from Schedule
- **Screen:** `RouteDetailScreen` (fp: `a3f…`)
- **Element:** `route-card-item`
- **Category:** A (hard failure)
- **Linear (previous):** WH-0911 (resolved 2026-03-29)
- **Artifacts:** [screenshot](findings/f-0087/before.png) · [clip](findings/f-0087/clip.mp4) · [logcat](findings/f-0087/logcat-excerpt.log)
- **Evidence:**
  > `FATAL EXCEPTION: main — java.lang.NullPointerException at RouteDetailScreen.render…`

---

## New this run — 4

### ☐ f-0150 — [MED] Save button disabled without explanation on "New Pickup"
- **Screen:** `NewPickupScreen` (fp: `b21…`)
- **Element:** `save-pickup-btn`
- **Category:** B (broken interaction)
- **Artifacts:** [screenshot](findings/f-0150/before.png) · [clip](findings/f-0150/clip.mp4)
- **Agent reasoning:** All fields appear valid; no error text shown; button is present but `enabled=false`.

### ☐ f-0151 — [LOW] Danish string shown in English locale on Settings › Notifications
…

## Previously seen (already triaged; informational) — 12

### ☑ f-0042 — [MED] Search results don't clear after tapping back — WH-1142 (open)
(collapsed)
```

### 6.3 Ticking rules (HITL gate)

- `☐` → `☑` on a new-or-regression finding = "publish this to Linear"
- Already-published findings appear pre-checked with Linear ID — re-ticking is a no-op
- Human may edit title, severity, or category inline before publishing — publisher respects edits
- Unchecked findings are never pushed

### 6.4 Publisher

`android-qa:publish --run <runId>` steps:

1. Parse `report.md`. Extract every finding block where checkbox is checked AND `linearIssueId` not already present.
2. For each such finding:
   a. Host artifacts (see §7.3) to obtain public URLs for screenshot, video clip, logcat excerpt.
   b. `save_issue` via Linear MCP:
      - `team` = `LINEAR_TEAM_ID` (env)
      - `project` = `LINEAR_PROJECT_ID` (env)
      - `title` = finding summary
      - `description` = full finding block rendered as markdown, with artifact links
      - `labels` = `["android-qa", "auto", "category-<X>", "severity-<Y>"]`
   c. `create_attachment` for each artifact URL.
   d. Record `linearIssueId` back in `findings-history.jsonl`; set `status = "published"`.
3. Rewrite `report.md` in place: each published finding now shows `— WH-NNNN (open)` next to its title, checkbox remains ticked.
4. Commit the updated `findings-history.jsonl` locally (via `simple-git`). Publisher never invokes `git push`; remote sync is the human's decision.

### 6.5 Publisher safety

- `--dry-run` prints issues-to-create without calling Linear.
- Re-running on the same run is safe: findings with `linearIssueId` are skipped.
- If a Linear call fails, that finding's state is rolled back (no partial publish).
- Never modifies unchecked findings.
- Never auto-publishes — always user-initiated.

### 6.6 Scheduled runs

Cron job runs `android-qa:explore` nightly, writes `report.md`. Does not publish. Posts a one-line summary to Slack the next morning: `"Last night: 27 turns, 4 new findings, 1 regression — report: output/android-qa/run-…/report.md"`. The `notify-slack` helper from `packages/reporting` may be reused or a thin wrapper added.

## 7. Error handling and fault tolerance

### 7.1 Failure modes and responses

| Failure | Detection | Response |
|---|---|---|
| App crash / ANR | Logcat watcher sees `FATAL EXCEPTION` or `ANR in`; Appium throws `NoSuchElementException` + activity changed to system dialog | Record finding (A, HIGH). Dismiss dialog, relaunch app, resume from home. Bump `crash_count`; >3 in run → abort `aborted-crash-loop`. |
| Emulator dies / ADB disconnect | `adb devices` empty or Appium connection error | One reconnect attempt. If fail: tear down, re-create AVD from snapshot, re-install APK, resume from checkpoint. If fail again: abort `aborted-device`. |
| Appium session timeout | WebDriver command hangs >60s | Kill + restart Appium server, new session, resume from checkpoint. |
| Claude API rate-limit/5xx | SDK error | Exponential backoff (1, 2, 4, 8, 30 capped). After 5 retries, fall back to rule-based action picker (first unvisited frontier element). |
| Claude API malformed JSON | Parse fail | One reprompt. After 2 failures, skip turn (event, not finding). |
| Action fails (element gone) | Appium throws on action | Re-perceive. Treat as finding only if repeats on same fingerprint 2 consecutive turns. |
| Login fails | Expected post-login screen not reached within 15s | HIGH finding (A). Abort `aborted-auth`. |
| Disk full / artifact write error | Write fails | Abort cleanly; preserve `session.json` + stub `report.md`. |
| Stuck in a loop | Same 5-turn action sequence repeats | Force `back()` 3x, then kill-relaunch app. Record loop screen as B. |

### 7.2 Checkpointing

- `session.json` append + fsync after every turn.
- `--resume <runId>` loads `session.json`, reopens Appium session, continues.

### 7.3 Budget enforcement

- Wall-clock timeout (default 30 min) via top-level `AbortController`.
- Per-turn timeout (default 90s) — overrun = event, loop continues.
- Claude API calls have a 60s client timeout — treated as transient 5xx.

### 7.4 Run status

Every run's `session.json` ends with one of:
- `completed`
- `aborted-crash-loop`
- `aborted-device`
- `aborted-auth`
- `aborted-error` (+ stack trace)

Aborted runs still emit their partial `report.md`.

## 8. Testing the agent itself

### 8.1 Layer 1 — Unit tests (Jest/Vitest, no emulator)

Runs on every PR.

- Screen fingerprinting (golden view-tree XML fixtures)
- Frontier prioritization (map + screen → frontier order)
- Anti-loop detection (action history → flag)
- `report.md` parser (markdown → extracted findings; unchecked ignored)
- Findings deduplication (history + new finding → new/previously-seen/resurrected)
- Linear issue body renderer (finding → expected markdown + labels)

### 8.2 Layer 2 — Replay tests (mocked Claude, no emulator)

`packages/android-qa/test-fixtures/sessions/` holds frozen `session.json` files. Replay tests feed recorded perceive-outputs into `Decide` with a mocked Claude client returning recorded decisions; verify state-machine end-state (frontier, map, findings) matches recorded. Same for `Evaluate` with mocked vision responses.

### 8.3 Layer 3 — End-to-end smoke (real emulator + canary APK)

`android-qa:smoke` runs 3-min bounded session against committed canary APK; expects `status: completed` and ≥N distinct screens visited. No assertions on which findings appear. Runs nightly + on PRs touching `packages/android-qa/**`.

### 8.4 Layer 4 — Judgment quality

`packages/android-qa/test-fixtures/screens/` — ~30 screenshots with ground-truth annotations. `android-qa:eval-judgment` runs Evaluate prompt against each, reports precision/recall per category.

Targets (tunable after first data):
- Recall > 80% for A/B
- Precision > 60% for C/D/E

### 8.5 Layer 5 — Published-finding feedback (deferred)

Once Linear issues have human-triage labels, compute precision of published findings; Slack-alert on drop. Not in v1.

### 8.6 CI

- PR touching `packages/android-qa/**` → Layer 1 + Layer 2
- Nightly / on release tag → Layer 3 + Layer 4

## 9. Configuration

All configuration via env (no runtime flags for anything credential-ish):

```
# Device
ANDROID_SDK_ROOT=/path/to/android/sdk
ANDROID_AVD_NAME=Pixel_7_API_34
WASTEHERO_APK_PATH=/path/to/wastehero.apk
APPIUM_HOST=127.0.0.1
APPIUM_PORT=4723

# Auth (one per role in scope)
WH_CREDS_ADMIN_EMAIL=...
WH_CREDS_ADMIN_PASSWORD=...
WH_CREDS_DRIVER_EMAIL=...
WH_CREDS_DRIVER_PASSWORD=...
WH_CREDS_DISPATCHER_EMAIL=...
WH_CREDS_DISPATCHER_PASSWORD=...

# Agent
ANTHROPIC_API_KEY=...
AGENT_MODEL=claude-opus-4-7
AGENT_VISION_EVERY_N_TURNS=10
AGENT_WALL_CLOCK_MIN=30
AGENT_TURN_BUDGET=500
DENY_ACTIONS=logout,sign-out,delete-account,delete-customer,delete-route,factory-reset

# Publishing
LINEAR_TEAM_ID=...
LINEAR_PROJECT_ID=...
ARTIFACT_HOST_MODE=github-branch    # or "s3"
ARTIFACT_GITHUB_BRANCH=android-qa-artifacts
ARTIFACT_S3_BUCKET=...              # only if mode=s3
```

### Artifact hosting

For Linear attachments, artifacts need public URLs. Two supported modes:

- **github-branch (default)** — publisher commits artifacts to a dedicated `android-qa-artifacts` branch (orphan branch, shallow history), links to raw.githubusercontent.com URLs. No extra infra.
- **s3** — publisher uploads to S3, links to presigned URLs. Requires AWS credentials. Fallback if repo size becomes a concern.

## 10. Non-functional requirements

- **Latency:** single turn budget 90s p95. Typical turn ~5–15s (one decide call + action + settle).
- **Cost:** single 30-min run typical = 1 Evaluate call every ~10 turns, so ~18 Evaluate + ~180 Decide. With Opus 4.7 pricing and prompt caching, budget ≤ ~$5/run. If real-world runs exceed this materially, downgrade Decide to Sonnet 4.6 (preserve Opus for Evaluate).
- **Reliability:** a run should complete or cleanly abort. Silent hangs are unacceptable.
- **Reproducibility:** every decision traceable via `session.json` + `replay` CLI.
- **Security:** credentials only in `.env` (gitignored). APK not committed. Artifacts branch flagged as machine-generated; never merged to main.

## 11. Open questions / deferred

- Linear `LINEAR_TEAM_ID` and `LINEAR_PROJECT_ID` values — to be filled in before first publish. Not design-blocking.
- Source code of the WasteHero Android RN app — will be supplied; informs `testID` strategy and which screens to prioritize. Not design-blocking; default priority falls out of curiosity-driven exploration.
- Choice between GitHub-branch artifact hosting vs S3 — start with GitHub-branch, revisit if repo bloat becomes a problem.
- Should findings also persist to the existing Express API (`packages/api`) for cross-device trend reporting? Deferred; flat file is sufficient for v1.

## 12. Risks

- **React Native tree depth** — RN view hierarchies can be deep and noisy. If `testID` coverage in the app is thin, agent will rely heavily on vision (cost up). Mitigation: after first runs, identify high-value screens with missing `testID`s and patch them in the RN app.
- **Emulator flakiness** — AVDs are notoriously cranky. Mitigation: snapshot known-good state, re-create from snapshot on device failure.
- **Agent over-reports trivial "findings"** — Mitigation: HITL gate catches false positives; judgment-eval layer flags prompt-quality drift.
- **App version churn invalidates map** — Mitigation: version-tagged fingerprints + best-effort matcher + `reset-state` escape hatch.

## 13. Milestones

(Implementation plan will refine. High-level:)

1. Device driver + emulator lifecycle + Appium glue — bring up "tap this element on this screen" end-to-end.
2. Recorder + session.json shape + report.md scaffold.
3. Agent loop with Decide only (no Evaluate) + in-run map/frontier — verify it can explore.
4. Persistent `app-map.json` across runs.
5. Evaluate pass + vision + findings pipeline.
6. `findings-history.jsonl` + dedup + regression detection.
7. Publisher + Linear MCP integration + artifact hosting.
8. CI: Layer 1 + Layer 2 tests.
9. Smoke test + judgment-eval fixtures.
10. Scheduled run + Slack summary.
