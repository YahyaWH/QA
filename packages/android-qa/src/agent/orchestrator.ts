import type { Driver } from '../device/driver';
import type { LogcatTail } from '../recorder/logcat';
import type { Recorder } from '../recorder/recorder';
import type { Config } from '../config/index';
import type {
  Action,
  AppMap,
  Fingerprint,
  Finding,
  RunStatus,
  Screen,
  SessionState,
  ViewElement,
  ViewNode,
} from '../types/index';
import type { ClaudeClient } from './claude';
import { decide } from './decide';
import { dedupInRun } from './dedup';
import { evaluate } from './evaluate';
import { fingerprintFromTree } from './fingerprint';
import { buildFrontier } from './frontier';
import type { FrontierEntry } from './frontier';
import { login, LoginFailedError } from './login';

/**
 * Main-loop options. `driver`, `claude`, `recorder`, `config`, `appMap`,
 * `history`, and `role` are the "wire it together" inputs the pipeline passes
 * every run. `logcatTail` is optional — unit tests that don't care about
 * crash detection may pass `null`. `now` / `sleepFn` are injectable clocks so
 * tests can drive wall-clock termination deterministically.
 *
 * @remarks `history` is accepted as part of the stable signature for when the
 * CLI (Task 22) wires cross-run classification through; this orchestrator
 * currently does not pre-seed state from it because that classification is the
 * CLI's responsibility per the design doc.
 */
export interface RunOptions {
  driver: Driver;
  claude: ClaudeClient;
  recorder: Recorder;
  config: Config;
  appMap: AppMap;
  history: Finding[];
  role: string;
  logcatTail?: LogcatTail | null;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Run the agentic exploration loop against `driver` until a termination
 * condition fires. Drives login, per-turn perceive/evaluate/decide/act,
 * crash-loop and device-death handling, and persists every turn to
 * `recorder.session.json`. Returns the final in-memory `SessionState`; the
 * same object is written to disk via `recorder.finalize`.
 */
export async function run(opts: RunOptions): Promise<SessionState> {
  const { driver, claude, recorder, config, appMap, role, logcatTail } = opts;
  const now = opts.now ?? Date.now;
  // sleepFn is accepted for API stability but not yet used inside the loop.
  void opts.sleepFn;
  void opts.history;

  const state: SessionState = buildInitialState(config, role);

  const startMs = now();

  // Login is attempted before the loop; a LoginFailedError terminates cleanly
  // as aborted-auth. Any other error bubbles out via finalizeRun.
  try {
    await login(driver, config.auth.roles[role]);
  } catch (err) {
    if (err instanceof LoginFailedError) {
      return finalizeRun(state, recorder, 'aborted-auth');
    }
    return finalizeWithError(state, recorder, err);
  }

  let prevLogcatTs = now();
  let turnIdx = 0;

  try {
    while (true) {
      // Wall-clock trip wire — checked first so a budget-exhausted run exits
      // cleanly even if decide would otherwise have produced a valid action.
      if (now() - startMs >= state.budget.wallClockMs) {
        return finalizeRun(state, recorder, 'completed');
      }
      if (state.history.length >= state.budget.turns) {
        return finalizeRun(state, recorder, 'completed');
      }

      turnIdx += 1;
      const turnStart = now();

      let perceived: PerceiveResult;
      try {
        perceived = await perceive(driver, logcatTail, prevLogcatTs);
      } catch {
        // Perceive failure is a strong device-death signal — try recovery once.
        const recovered = await tryRecoverDevice(driver);
        if (!recovered) {
          return finalizeRun(state, recorder, 'aborted-device');
        }
        try {
          perceived = await perceive(driver, logcatTail, prevLogcatTs);
        } catch {
          return finalizeRun(state, recorder, 'aborted-device');
        }
      }
      prevLogcatTs = now();

      // Crash-loop handling: one `detectCrash` hit per turn counts for one.
      if (logcatTail) {
        const crash = logcatTail.detectCrash(perceived.logcatDelta);
        if (crash) {
          state.counters.crashCount += 1;
          if (state.counters.crashCount >= 3) {
            return finalizeRun(state, recorder, 'aborted-crash-loop');
          }
        }
      }

      // Screen registration + frontier seeding. `isNewScreen` is captured
      // BEFORE the insert so evaluate's vision trigger sees the correct signal.
      const isNewScreen = state.screens[perceived.fp] === undefined;
      const nowIso = new Date().toISOString();
      const screen: Screen = isNewScreen
        ? buildScreen(perceived.tree, perceived.activity, nowIso, perceived.fp)
        : state.screens[perceived.fp];

      if (isNewScreen) {
        state.screens[perceived.fp] = screen;
        const newEntries = buildFrontier(screen, appMap, { currentRunId: state.runId });
        state.frontier = mergeFrontier(state.frontier, newEntries, perceived.fp);
      }

      // Evaluate — always produces deterministic findings; vision is gated by
      // evaluate's internal shouldRunVision checks.
      const newFindings = await evaluate(
        state,
        {
          currentScreenFp: perceived.fp,
          currentTree: perceived.tree,
          logcatDelta: perceived.logcatDelta,
          isNewScreen,
          treeSuspicious: false,
          screenshotBase64: null,
          imageMediaType: 'image/png',
        },
        { model: config.agent.model, visionEveryNTurns: config.agent.visionEveryNTurns },
        claude,
      );
      if (newFindings.length > 0) {
        state.findings = dedupInRun([...state.findings, ...newFindings]);
      }

      // Decide — deny-list and repeat-guard filtering happen inside decide().
      const triaged = state.findings.filter((f) => f.screenFp === perceived.fp);
      const decision = await decide(
        {
          state,
          frontier: frontierForScreen(state.frontier, perceived.fp),
          denyActions: config.agent.denyActions,
          triagedFindings: triaged,
          visionEveryNTurns: config.agent.visionEveryNTurns,
        },
        { model: config.agent.model },
        claude,
      );

      // Act. Done terminates the loop immediately — not recorded as a turn.
      if (decision.action.kind === 'done') {
        return finalizeRun(state, recorder, 'completed');
      }

      // Dispatch the action. Appium errors are non-fatal — the same
      // re-perceive path below recovers either way.
      try {
        await dispatchAction(driver, decision.action);
      } catch {
        // Swallow; the liveness probe + re-perceive below handle recovery.
      }

      // Always probe liveness after the action so we can recover from an
      // emulator death that didn't surface as a thrown driver error.
      const aliveAfter = await safeIsAppAlive(driver);
      if (!aliveAfter) {
        const recovered = await tryRecoverDevice(driver);
        if (!recovered) {
          return finalizeRun(state, recorder, 'aborted-device');
        }
      }

      // Re-perceive (tree + screenshot only — logcat belongs to the next
      // turn's pre-perceive) to capture the action's outcome fingerprint. On
      // failure, leave outcomeFp null so history reflects "no observation".
      let outcomeFp: Fingerprint | null;
      try {
        const post = await observeOutcome(driver);
        outcomeFp = post.fp;
        await recorder.saveScreenshot(turnIdx, 'post', post.shot);
      } catch {
        outcomeFp = null;
      }

      const elapsed = now() - turnStart;
      await appendTurn(recorder, state, turnIdx, perceived.fp, decision.action, outcomeFp, elapsed);
    }
  } catch (err) {
    return finalizeWithError(state, recorder, err);
  }
}

// --------------------------------------------------------------------------
// Private helpers
// --------------------------------------------------------------------------

interface PerceiveResult {
  tree: ViewNode;
  activity: string;
  shot: Buffer;
  logcatDelta: string[];
  fp: Fingerprint;
}

/**
 * Capture a turn's observations: view tree, current activity, screenshot,
 * logcat delta since `sinceTs`, and the screen fingerprint. Kept deliberately
 * minimal — no retry logic, no state mutation. Callers handle recovery.
 */
async function perceive(
  driver: Driver,
  logcatTail: LogcatTail | null | undefined,
  sinceTs: number,
): Promise<PerceiveResult> {
  const tree = await driver.getViewTree();
  const activity = await driver.getCurrentActivity();
  const shot = await driver.screenshot();
  const logcatDelta = logcatTail ? logcatTail.getDelta(sinceTs) : [];
  const fp = fingerprintFromTree(tree, activity);
  return { tree, activity, shot, logcatDelta, fp };
}

/**
 * Light-weight post-action re-perceive: tree, activity, screenshot, and
 * fingerprint. Does NOT touch logcat so we avoid double-consuming the delta
 * window that belongs to the next turn's pre-perceive.
 */
async function observeOutcome(driver: Driver): Promise<{ fp: Fingerprint; shot: Buffer }> {
  const tree = await driver.getViewTree();
  const activity = await driver.getCurrentActivity();
  const shot = await driver.screenshot();
  const fp = fingerprintFromTree(tree, activity);
  return { fp, shot };
}

/**
 * Convert the captured view tree into a `Screen` with one `ViewElement` per
 * resource-id-bearing node. Elements start untapped with empty outcomes so
 * the frontier can promote them on the first pass.
 */
function buildScreen(
  tree: ViewNode,
  activity: string,
  nowIso: string,
  fp: Fingerprint,
): Screen {
  const elements: Record<string, ViewElement> = {};
  walkForElements(tree, elements, nowIso);
  return { fingerprint: fp, activity, elements };
}

function walkForElements(
  node: ViewNode,
  out: Record<string, ViewElement>,
  nowIso: string,
): void {
  if (node.resourceId && node.resourceId.length > 0 && !(node.resourceId in out)) {
    out[node.resourceId] = {
      resourceId: node.resourceId,
      role: node.className,
      text: node.text,
      firstSeen: nowIso,
      lastSeen: nowIso,
      tapped: false,
      outcomes: [],
    };
  }
  for (const child of node.children) {
    walkForElements(child, out, nowIso);
  }
}

/**
 * Merge `newEntries` into `existing`, dropping any stale entries for `screenFp`
 * that no longer appear in `newEntries` (so a re-seeded screen doesn't carry
 * stale priorities). Entries for other screens are preserved unchanged.
 */
function mergeFrontier(
  existing: FrontierEntry[],
  newEntries: FrontierEntry[],
  screenFp: Fingerprint,
): FrontierEntry[] {
  const kept = existing.filter((e) => e.screenFp !== screenFp);
  return [...kept, ...newEntries];
}

/** Frontier entries filtered to one screen — used for the decide prompt. */
function frontierForScreen(frontier: FrontierEntry[], fp: Fingerprint): FrontierEntry[] {
  return frontier.filter((e) => e.screenFp === fp);
}

/**
 * Dispatch a validated `Action` onto the driver. `done` is handled by the
 * caller (it should never reach this helper). Any driver error bubbles up to
 * the caller's catch, which triggers the Appium-error recovery path.
 */
async function dispatchAction(driver: Driver, action: Action): Promise<void> {
  switch (action.kind) {
    case 'tap':
      return driver.tap(action.elementId);
    case 'type':
      return driver.type(action.elementId, action.text);
    case 'swipe':
      return driver.swipe(action.direction);
    case 'back':
      return driver.back();
    case 'scrollTo':
      return driver.scrollTo(action.elementId);
    case 'done':
      // Terminal action — caller handles this before dispatching.
      return;
  }
}

/**
 * Try one `relaunchApp()`. Returns true iff the app is alive afterward. Any
 * thrown error from relaunch is treated as an un-recoverable device death.
 */
async function tryRecoverDevice(driver: Driver): Promise<boolean> {
  try {
    await driver.relaunchApp();
  } catch {
    return false;
  }
  try {
    return await driver.isAppAlive();
  } catch {
    return false;
  }
}

/** `isAppAlive` with a swallowed exception — absence of a truthy result == dead. */
async function safeIsAppAlive(driver: Driver): Promise<boolean> {
  try {
    return await driver.isAppAlive();
  } catch {
    return false;
  }
}

/**
 * Record a turn in both the in-memory state and the persisted session.json.
 * The recorder's append is atomic (tmp + fsync + rename), so a crash after
 * appendTurn still leaves a consistent session file.
 */
async function appendTurn(
  recorder: Recorder,
  state: SessionState,
  turn: number,
  screenFp: Fingerprint,
  action: Action,
  outcomeFp: Fingerprint | null,
  ms: number,
): Promise<void> {
  const entry = { turn, screenFp, action, outcomeFp, ms };
  state.history.push(entry);
  await recorder.appendTurn(entry);
  // Full state update so screens/frontier/findings are reflected on disk.
  await recorder.updateState({
    screens: state.screens,
    frontier: state.frontier,
    findings: state.findings,
    counters: state.counters,
  });
}

/**
 * Build the initial in-memory `SessionState`. `runId` is derived from the
 * current timestamp to stay consistent with the recorder's initialState when
 * the caller has not pre-populated one.
 */
function buildInitialState(config: Config, role: string): SessionState {
  const startedAt = new Date().toISOString();
  const runId = `run-${Date.now()}`;
  return {
    runId,
    appVersion: 'unknown',
    role,
    startedAt,
    budget: {
      wallClockMs: config.agent.wallClockMinutes * 60_000,
      turns: config.agent.turnBudget,
    },
    counters: { crashCount: 0, noNewScreenStreak: 0, malformedJsonCount: 0 },
    screens: {},
    frontier: [],
    findings: [],
    history: [],
  };
}

/**
 * Set the terminal status on `state`, persist it via the recorder, and return
 * the same state object so callers can `return finalizeRun(...)` directly.
 */
async function finalizeRun(
  state: SessionState,
  recorder: Recorder,
  status: RunStatus,
): Promise<SessionState> {
  state.status = status;
  state.endedAt = new Date().toISOString();
  await recorder.finalize(status);
  return state;
}

/**
 * Unexpected-error path: finalize as `aborted-error` on disk, then rethrow so
 * the caller sees the original stack. Never swallows errors silently.
 */
async function finalizeWithError(
  state: SessionState,
  recorder: Recorder,
  err: unknown,
): Promise<SessionState> {
  state.status = 'aborted-error';
  state.endedAt = new Date().toISOString();
  await recorder.finalize('aborted-error');
  throw err;
}
