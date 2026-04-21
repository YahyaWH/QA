# `@wastehero-qa/android-qa`

Autonomous Android QA agent for the WasteHero app: explores the app under
test on a real emulator, finds bugs across five categories (hard failure,
functional bug, UX, polish, suggestion), renders a human-reviewable report,
and — after a human ticks the boxes they want filed — publishes the chosen
findings to Linear with hosted screenshot / clip / logcat artifacts.

Design spec:
[`docs/superpowers/specs/2026-04-17-android-agentic-qa-design.md`](../../docs/superpowers/specs/2026-04-17-android-agentic-qa-design.md).
Implementation plan:
[`docs/superpowers/plans/2026-04-17-android-agentic-qa.md`](../../docs/superpowers/plans/2026-04-17-android-agentic-qa.md).

---

## Prerequisites

- **Node 20+** (matches CI).
- **Android SDK** with an AVD pre-created. If you don't have one:
  `sdkmanager "system-images;android-34;google_apis;x86_64"` then
  `avdmanager create avd -n Pixel_7_API_34 -k "system-images;android-34;google_apis;x86_64"`.
- **APK under test** — a build of the WasteHero app at the revision you want
  to QA. The recorder hashes its version code into each run's metadata.
- **Appium 2** — installed as a workspace dependency; no global install
  needed. The CLI starts and stops its own server on port 4723.
- **ffmpeg** on `$PATH` — used to slice per-finding 15s clips out of the run
  video. Optional: if it's missing the run still produces screenshots +
  logcat excerpts, just no clips.
- **`.env`** — copy `.env.example` and fill in the placeholders.

```bash
cp packages/android-qa/.env.example packages/android-qa/.env
# edit — at minimum set ANDROID_SDK_ROOT, WASTEHERO_APK_PATH,
# ANTHROPIC_API_KEY, and one set of WH_CREDS_<ROLE>_* credentials.
```

---

## Quick start

```bash
# From repo root
npm install
npm run explore -w @wastehero-qa/android-qa
```

This boots the emulator, installs the APK, runs the agent loop for up to 30
minutes (default), and writes:

- `output/android-qa/<runId>/report.md`      — the human-review surface.
- `output/android-qa/<runId>/session.json`   — full recorder state.
- `output/android-qa/<runId>/screenshots/`   — per-turn PNGs.
- `output/android-qa/<runId>/findings/<f-XXXX>/` — per-finding clip +
  logcat slice.
- `output/android-qa/<runId>/video.mp4`      — the full run screencast.

The run also updates
[`packages/android-qa/state/app-map.json`](./state/app-map.json) and
[`packages/android-qa/state/findings-history.jsonl`](./state/findings-history.jsonl)
— the persistent memory that makes each subsequent run smarter about where
to explore and what findings to de-duplicate.

---

## CLI reference

All CLIs are available as `npm run <name> -w @wastehero-qa/android-qa`.

| CLI              | Purpose                                                                                                  |
|------------------|----------------------------------------------------------------------------------------------------------|
| `explore`        | Run the full agent loop. Default entrypoint.                                                             |
| `smoke`          | Short (3-minute) explore used by CI; asserts `status=completed` + `≥3` screens visited.                  |
| `replay`         | `--run <runId>` — replay a recorded run's action history on a fresh emulator (no Claude). Debug tool.    |
| `reset-state`    | Archive `state/*` to `state/archive/<UTC>/`, replace with empty shells, commit locally (no push).        |
| `publish`        | `--run <runId> [--dry-run]` — publish ticked findings from the report to Linear with hosted artifacts.   |
| `eval-judgment`  | Offline precision/recall harness over `test-fixtures/screens/*` (see that directory's README).           |
| `test` / `test:watch` | Vitest unit suite for the package.                                                                 |
| `typecheck`      | `tsc --noEmit` against the package's `tsconfig.json`.                                                    |

---

## HITL publishing flow

1. **Run explore.** `npm run explore -w @wastehero-qa/android-qa`. Note the
   `runId` it prints (e.g. `run-20260421-0830-ab12`).

2. **Review the report.** Open
   `output/android-qa/<runId>/report.md`. Each finding is a checkbox block:

   ```
   ### ☐ f-a3f2 — [HIGH] Crash when opening Route Detail from Schedule
   - **Severity:** HIGH
   - **Category:** A (hard failure)
   - **Screen:** `RouteDetailScreen` (fp: `a3f2b7…`)
   - **Element:** `route-card-item`
   - **Agent reasoning:** logcat: FATAL EXCEPTION: main — NullPointerException…
   - **Artifacts:** [screenshot](findings/f-a3f2/before.png) · [clip](findings/f-a3f2/clip.mp4) · [logcat](findings/f-a3f2/logcat-excerpt.log)
   ```

   Tick (`☐` → `☑`) the ones that should become Linear issues. Leave false
   positives unticked. Feel free to edit the summary, reasoning, or any
   body field — the publisher preserves everything except the heading
   suffix.

3. **Dry-run.** `npm run publish -w @wastehero-qa/android-qa -- --run <runId> --dry-run`.
   Prints the candidates it would file and exits without touching Linear or
   the filesystem.

4. **Publish.** Drop `--dry-run`. The CLI:
   - hosts each ticked finding's artifacts on a dedicated git branch
     (`ARTIFACT_GITHUB_BRANCH`, default `android-qa-artifacts`),
   - creates a Linear issue via `issueCreate` + one `attachmentCreate` per
     artifact,
   - rewrites the report heading with the `WH-…` identifier,
   - updates the finding's `status = published` in
     `findings-history.jsonl`,
   - commits both files locally. It **does not push** — you push the
     history update yourself, or open a PR.

Re-running publish is safe: findings that already have a `linearIssueId`
are skipped.

---

## Linear configuration

- `LINEAR_API_KEY` (required) — personal API key from Linear
  Settings → Account → API. Keys start with `lin_api_`.
- `LINEAR_TEAM_ID` (optional) — UUID of the Linear team the issues belong
  to. Without it, labels are dropped (they're team-scoped) and the issue is
  filed into the key-owner's default team.
- `LINEAR_PROJECT_ID` (optional) — UUID of the Linear project to slot
  issues into. Skip to leave the project field empty.

Label set (applied when `LINEAR_TEAM_ID` is set):
`["android-qa", "auto", "category-<A–E>", "severity-<low|med|high|critical>"]`.
Missing labels are created on first publish; subsequent publishes reuse the
cached IDs.

---

## Troubleshooting

### Emulator won't boot
- Verify the AVD exists: `$ANDROID_SDK_ROOT/emulator/emulator -list-avds`.
  If it's missing, (re-)create it per the Prerequisites section.
- On a headless Linux box, install `libpulse0 libgl1` and make sure KVM is
  enabled (`ls /dev/kvm` + you're in the `kvm` group).
- If `adb devices` shows the emulator as `offline`, run
  `adb kill-server && adb start-server` and retry.

### `Error: listen EADDRINUSE: port 4723`
Appium's port is held by a previous run. Either:
- Kill the stale server: `lsof -i :4723` → `kill <pid>`, then rerun.
- Or override the port: `APPIUM_PORT=4724 npm run explore ...`.

A SIGINT mid-run should have cleaned this up automatically — if you see
this after Ctrl+C'ing explore, please open an issue with the log tail.

### Claude rate limit / 429
The ClaudeClient retries with exponential backoff on 429 + 5xx. If you hit
the retry ceiling:
- Bump your Anthropic plan.
- Lower the evaluate cadence: `AGENT_VISION_EVERY_N_TURNS=20` cuts the
  vision pass rate in half.

### Login fails with "email field not found"
The login heuristics depend on the form elements having a resource-id or a
recognisable label. If a release moves fields around, update
`src/agent/login.ts` and add a test. The agent cannot explore past a login
failure.

### Publish fails with "no matching entry in findings-history"
Report IDs (`f-XXXX`) are a 4-hex prefix of the full SHA-1 id stored in
`findings-history.jsonl`. A prefix collision (~1/65k) is the only way this
happens — `reset-state` and re-explore, or edit the display id in the
report by hand.

### Artifact hosting push rejected
The `ARTIFACT_GITHUB_BRANCH` branch must be pushable by whoever runs
publish — create a PAT with `contents:write` scope and set it as your git
credential, or pick a branch protected only by review (the publish flow
bypasses the main branch by design).

---

## Layout

```
packages/android-qa/
  bin/                      — user-facing CLIs (see table above)
    explore.ts
    smoke.ts
    replay.ts
    reset-state.ts
    publish.ts
    eval-judgment.ts
  src/
    agent/                  — Claude client, orchestrator loop,
                              perceive/decide/evaluate passes, dedup,
                              anti-loop, login, fingerprinting
    cli/                    — pipeline shared by explore + smoke
    config/                 — env → typed Config
    device/                 — Driver interface, Fake + Appium + emulator
                              bootstrap + UIAutomator2 XML → ViewNode
    publish/                — Linear GraphQL client, publishFinding,
                              artifact hosting, report patcher
    recorder/               — session.json writer, video, logcat tail
    report/                 — report.md renderer + parser
    state/                  — app-map + findings-history JSONL +
                              cross-run dedup + map-merge
    types/                  — shared domain types
  test-fixtures/            — vitest fixtures (reports, view trees, screens)
  state/
    app-map.json            — persisted app map (empty shell seeded here)
    findings-history.jsonl  — persisted findings (empty shell seeded here)
    archive/                — reset-state drops the old state here
```
