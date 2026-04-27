---
name: qa-android-explore
description: Explore the WasteHero Android app on a real emulator. Drives `qa-server` over localhost HTTP — the server boots emulator + Appium + driver and runs login; you (Claude Code) act as the per-turn brain via /perceive → review → /act → repeat. Persists session.json, screenshots, findings, and a markdown report; merges into the canonical app-map at finalize. Single-instance, no Anthropic API spend.
argument-hint: <start|continue|status|stop> [--role admin|driver|dispatcher] [--turns N] [--port 7099]
---

# WasteHero Android Exploration Skill

You drive the `qa-server` in `packages/android-qa/bin/qa-server.ts` over localhost HTTP. The server runs the emulator, Appium, the driver, and login; you act as the decide/evaluate brain by calling `/perceive`, reviewing the returned screenshot, picking the next action, and calling `/act`. Repeat until budget hits or you decide there's nothing left to explore, then call `/finalize`.

**No Anthropic API calls anywhere in this loop.** All the per-turn intelligence comes from this Claude Code session.

## Subcommands

### `start [--role <role>] [--turns <N>] [--port 7099]`

1. Verify `packages/android-qa/.env` has at minimum `ANTHROPIC_API_KEY` (still needed for the SDK loader path even though we don't call the API), `ANDROID_SDK_ROOT`, `WASTEHERO_APK_PATH`, and `WH_CREDS_<ROLE>_EMAIL`/`_PASSWORD` for the chosen role. Default role is the only configured one.
2. Kill any orphan emulator/adb/appium processes before launch (Windows: PowerShell; otherwise `pkill`). The user has standing approval to do this for android-qa.
3. Launch the server in the background:
   ```bash
   npm run qa-server -w @wastehero-qa/android-qa -- --role <role> --port 7099 \
     2>&1 | tee packages/android-qa/logs/qa-server-$(date -u +%Y%m%d-%H%M%S).log
   ```
   Run via Bash with `run_in_background: true`. Capture the task id.
4. Tail the log file via Bash with an `until` loop until you see a line matching `READY runId=run-... port=7099 role=...`. Extract `runId` and `runDir` from the log (also available via `GET /status`). If the boot fails (login failure, missing APK, port collision), the server exits non-zero and the log shows the error — surface it to the user and stop.
5. Once `READY`, enter the **exploration loop** below.

### `continue`

Resume an exploration loop against an already-running server. Useful after a user interrupt or when the conversation context is reset. Hit `GET http://127.0.0.1:7099/status` first to confirm the server is alive and `finalized=false`. If `finalized=true` or the GET fails, tell the user there's no live session and offer `start`.

### `status`

`curl -s http://127.0.0.1:7099/status` and summarize the JSON in 4–5 lines: turn count, screens visited, findings, crash count, budget remaining.

### `stop`

Send `POST http://127.0.0.1:7099/finalize` with body `{"status":"completed"}`. The server tears down emulator + Appium + logcat + video, merges the run into the canonical `app-map.json`, writes `report.md`, then exits cleanly. Confirm to the user with the report path.

## Exploration Loop

Repeat until you decide to stop or the server's `budgetRemaining` reaches zero on either axis (`wallClockMsRemaining` or `turnsRemaining`):

### 1. Perceive

```bash
curl -s -X POST http://127.0.0.1:7099/perceive
```

The response shape:
```ts
{
  runId, turn, fingerprint, activity, isNewScreen,
  crashCount, crashThisTurn,
  screenshotPath,                            // absolute path to a fresh PNG
  windowSize: { width, height },             // device pixels — same coord space as the PNG
  screen: {
    fingerprint, activity,
    elements: [{ resourceId, role, text, tapped, marked, outcomes }]
  },
  frontier: [{ elementId, priority }],       // already filtered to current screen
  triagedFindings: [{ id, category, severity, summary, element }],
  historyTail: [{ turn, screenFp, action, outcomeFp, ms }],
  denyList: [...],
  budgetRemaining: { wallClockMsRemaining, turnsRemaining },
}
```

### 2. Review the screenshot

`Read` the file at `screenshotPath`. The image counts as evaluation context for free in this session — use it to:
- Confirm the tree-derived element list matches what's actually visible (the tree can lag during transitions).
- Spot visual issues the deterministic scans miss: bad layout, cut-off text, unlabeled icons, weird color contrast, broken images, error banners that aren't in the tree as text.
- Catch hard-failure UI states (white screens, infinite spinners, crash dialogs) that didn't surface in logcat.

If you spot a visual issue worth filing, **note it in your turn message** and include the category/severity. (Filing it as a real Finding is a future addition — for now, surface it in conversation so the user can decide.)

### 3. Decide

Pick the **single best action** for this turn. Rules, in order:

1. **Frontier priorities** — prefer `priority=100` (never tapped) over `80` (tapped but leads to unexplored) over `60` (stale revisit). Tie-break alphabetically by `elementId` (matches the deterministic frontier sort).
2. **Deny list** — never emit an action whose stringified form (`tap:elementId`, `tapAt:x,y`, `type:elementId`, `swipe:up`, `back`, `scrollTo:elementId`, `done:reason`) is in `denyList` or has `denyList` entry as a prefix. The server will reject it with 400 anyway, but checking client-side avoids the round trip.
3. **Anti-repeat** — if the previous action made no progress (`historyTail[-1].outcomeFp === historyTail[-1].screenFp` or `null`), do **not** repeat it. Pick a different element, a swipe, a `tapAt` on a different visible region, or `back`.
4. **Anti-cycle** — if the last 4–6 turns are bouncing between known fingerprints (e.g. `A→B→A→B`), break the cycle by either (a) tapping a band-2 element that you have not previously tapped, (b) `tapAt` on a different visible row/card the resource-id-based tap can't reach, (c) trying `swipe` to reveal hidden content, or (d) calling `done` with a clear reason — but **only if you've genuinely run out of frontier AND coordinate-distinct visible elements**.
5. **Done condition** — when the frontier is saturated AND the screenshot shows no further visible-but-uncovered targets you could `tapAt`, emit `{kind: "done", reason: "..."}` and finalize.

Avoid `back` as a default. The deleted Claude-API path used to fall through to `back` whenever its API call failed, which produced 400-turn back-loops. **Pressing `back` should be deliberate** — only when you actively want to leave a screen and you can name the reason.

**Saturation ≠ done.** An empty frontier means every *resource-id* on this screen has been tapped. The screenshot may still show 2–10 visually distinct rows / cards / tiles that share resource-ids. Before declaring done, scan the screenshot for these and prefer `tapAt` on the next unvisited one.

Action shapes:
```ts
{ kind: "tap",      elementId: "..." }
{ kind: "tapAt",    x: number, y: number }   // absolute device px — see "Coordinate-based tap" below
{ kind: "type",     elementId: "...", text: "..." }
{ kind: "swipe",    direction: "up"|"down"|"left"|"right" }
{ kind: "back" }
{ kind: "scrollTo", elementId: "..." }       // scroll a list/scroll-view to bring elementId into view
{ kind: "done",     reason: "..." }          // does not dispatch; signals you're ready to finalize
```

#### Coordinate-based tap (`tapAt`)

`tap` resolves a `resourceId` via UIAutomator's accessibility-id / resource-id selectors, which find the **first** matching element. When multiple visible elements share the same resource-id (list rows on the project-select screen, identical card views on a feed, etc.), `tap` cannot reach rows 2..N.

`tapAt` bypasses the selector and clicks at absolute device pixels. The screenshot you `Read`ed is at the same coordinate space — top-left is `(0, 0)`, bottom-right is `(windowSize.width, windowSize.height)`. The Pixel 7 AVD is `1080x2400` so a tap on a list row near `y=1100` lands ~halfway down.

**When to use `tapAt` instead of `tap`:**
- Frontier on the current screen is empty (everything's marked tapped) but the screenshot shows multiple visually distinct rows / cards / tiles you haven't really visited. The persisted `tapped=true` flag on a single resource-id was set by visiting row 1 — rows 2..N are still unexplored *visually* and `tapAt` is the only way to reach them.
- An element you want to interact with has no `resourceId` at all (it shows up in the screenshot but not in `screen.elements`).
- A button is part of a complex composite that the tree exposes as a non-clickable parent (e.g. text + icon both rendered from a single ViewGroup with no id).

**How to pick coordinates:**
1. `Read` `screenshotPath`. The image dimensions match `windowSize` — read the pixel position of the target element directly off the visual.
2. Aim at the **center of the element**, not the edge. List rows are usually 150-220px tall, so y = (rowTop + rowBottom) / 2.
3. Round to integers. Negative values are rejected by the schema.
4. Validate against `windowSize` before sending — `x < width && y < height`. The server will dispatch a tap outside bounds and Appium will fail silently.

**`tapAt` does not advance the persisted-frontier `tapped` flag.** That flag is keyed by resource-id; coordinate-based taps have no element id to attribute progress to. The transition (origin → outcome) is still recorded in `session.json.history` and folded into the canonical app-map's `transitions` array via `via: "tapAt:<x>,<y>"`, so the run still grows coverage. After a successful `tapAt` the next `/perceive` will re-tree the new screen and any genuinely new resource-ids on it will land in the frontier at priority 100.

### 4. Act

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"action":{"kind":"tap","elementId":"settings-btn"}}' \
  http://127.0.0.1:7099/act
```

Response:
```ts
{
  turn,
  originFp,
  outcomeFp,                     // null if observe failed
  fpChanged,                     // outcomeFp !== originFp && outcomeFp !== null
  postScreenshotPath,            // null if observe failed
  elapsedMs,
  budgetRemaining,
  budgetExpired,                 // true → loop should stop
}
```

If `done: true`, stop the loop and call `/finalize`.
If `budgetExpired: true`, stop and call `/finalize`.
If `outcomeFp === null`, the observation failed — `/perceive` next turn will re-establish state, no need to special-case.

**CRITICAL: always `/perceive` after `fpChanged: true`.** Screen *details* (element list, frontier priorities, deterministic findings) are captured only on `/perceive` — the `outcomeFp` returned by `/act` is just a fingerprint marker. If you chain multiple `/act` calls back-to-back across new fingerprints, the canonical app-map records the *transitions* but loses the *screen contents*. That's how the first real run only captured 2 of 7 new screens with full detail. The strict pattern is `/perceive → /act → /perceive → /act → …`, never `act → act → perceive`.

### 5. Update the user every ~10 turns

Keep the user oriented without flooding chat: after every ~10 acted turns, post a one-line summary — turn count, current fingerprint, screens visited, findings found, budget remaining. Skip per-turn status dumps; stay quiet during the working loop unless something interesting happens (new screen, crash, finding).

## Finding Categories

When you spot a problem visually or in the perception, use this taxonomy (matches the deterministic scans):

- **A — hard failure**: crash dialog, blank/white screen, error banner ("Something went wrong"), full-app freeze.
- **B — functional bug**: broken layout, cut-off text, wrong content, unresponsive control.
- **C — UX issue**: unlabeled icon, bad contrast, hidden affordance, confusing copy.
- **D — polish**: alignment, spacing, minor inconsistency.
- **E — suggestion**: feature idea, low-confidence observation.

Severity: `critical` (blocks use), `high` (major impact), `med` (noticeable), `low` (cosmetic).

Surface findings inline in the conversation — the deterministic scans (logcat + tree text) auto-file the obvious ones into `triagedFindings` and you'll see them in `/perceive` responses. Vision-only findings need a future tool to file them; for now mention them clearly so the user can act.

## Termination

Three ways the loop ends:

1. **Budget hit** — `budgetExpired: true` from `/act`, OR `budgetRemaining.{wallClockMsRemaining,turnsRemaining}` reaches 0 before you act. Call `/finalize`.
2. **You're done** — frontier exhausted, no compelling unexplored element, no new findings for several turns. Emit `{kind:"done", reason:"..."}` to `/act`, then `/finalize`.
3. **User interrupt** — user types stop / cancel / Ctrl+C the conversation. Call `/finalize` with `{"status":"completed"}` (or the appropriate `aborted-*` if you know why) so persistence still happens.

After `/finalize`, the server exits and tears down the emulator. The report lives at `<runDir>/report.md` and the canonical `state/app-map.json` has been updated. Confirm to the user with the path.

## Things that go wrong

- **`/perceive` returns 502** — driver lost the device or the tree dump failed. The server tries one recovery before returning 502; on failure, finalize with `{status:"aborted-device"}` and surface to the user.
- **`/act` returns 400 with `error: "action denied by deny-list"`** — your action is on the deny list. Pick a different action.
- **`/act` returns 400 with `error: "action failed schema validation"`** — your action JSON is malformed. Fix the shape (see Action shapes above).
- **`crashCount >= 3`** — the app has crashed three times. The deterministic logcat scan files crashes as findings automatically; you should call `/finalize` with `{"status":"aborted-crash-loop"}`.
- **Server stops responding** — Bash background task may have died. Read the log file via `Read` to see the last lines; surface to the user.

## State on disk (unchanged from the API path)

- `output/android-qa/<runId>/session.json` — full per-turn state (atomic writes via tmp + fsync + rename).
- `output/android-qa/<runId>/screenshots/turn-NNNN-{pre,post}.png` — per-turn screenshots.
- `output/android-qa/<runId>/findings/<f-XXXX>/` — per-finding clip + screenshot + logcat excerpt.
- `output/android-qa/<runId>/report.md` — written at `/finalize`.
- `packages/android-qa/state/app-map.json` — canonical persistent app map; `/finalize` folds this run in.
- `packages/android-qa/state/findings-history.jsonl` — canonical findings history; `/finalize` appends.
- `packages/android-qa/logs/qa-server-*.log` — server stdout/stderr.

The HITL publish flow (`npm run publish -w @wastehero-qa/android-qa -- --run <runId>`) is unchanged.
