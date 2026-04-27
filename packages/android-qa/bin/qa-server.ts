/**
 * `qa-server` — single-instance Android exploration server driven by a Claude
 * Code skill (no Anthropic API calls).
 *
 * Boots the emulator + Appium + driver + login flow once, then exposes a tiny
 * localhost HTTP API:
 *
 *   GET  /status                     → run metadata + driver liveness
 *   POST /perceive                   → capture observation, return JSON state
 *                                       + path to a freshly-saved screenshot
 *   POST /act       { action: ... }  → dispatch action, observe outcome,
 *                                       record turn, return outcome JSON
 *   POST /finalize  { status?: ... } → render report + merge into canonical
 *                                       app-map, tear down, exit(0)
 *
 * The Claude Code skill drives this server via Bash + curl, doing the
 * decide/evaluate work in-conversation (using its own screenshot review and
 * the perception JSON). All persistence — session.json, screenshots,
 * findings-history.jsonl, app-map.json, report.md — is unchanged from the old
 * Claude-API path; only the brain moved.
 *
 * Single-instance only. No --n / shards / parallel mode. Re-add via the API
 * path once the skill workflow is proven.
 */

import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { loadConfig } from '../src/config/index';
import { AppiumDriver } from '../src/device/appium-driver';
import type { AppiumServerHandle } from '../src/device/appium-server';
import { startAppium } from '../src/device/appium-server';
import type { EmulatorHandle } from '../src/device/emulator';
import {
  DEFAULT_EMULATOR_CONSOLE_PORT,
  extractApkVersion,
  installApk,
  startEmulator,
  waitForBoot,
} from '../src/device/emulator';
import { LogcatTail } from '../src/recorder/logcat';
import { Recorder } from '../src/recorder/recorder';
import { VideoRecorder } from '../src/recorder/video';
import { render } from '../src/report/render';
import {
  defaultAppMapPath,
  loadAppMap,
  saveAppMap,
} from '../src/state/app-map';
import { classifyAgainstHistory } from '../src/state/cross-run-dedup';
import {
  appendFindings,
  defaultFindingsHistoryPath,
  readHistory,
} from '../src/state/findings-history';
import { mergeRunIntoMap } from '../src/state/map-merge';
import { dedupInRun } from '../src/agent/dedup';
import { evaluate } from '../src/agent/evaluate';
import { buildFrontier } from '../src/agent/frontier';
import {
  buildScreen,
  dispatchAction,
  frontierForScreen,
  mergeFrontier,
  observeOutcome,
  perceive as perceiveTurn,
  recordActionOutcome,
  refreshFrontierForScreen,
  safeIsAppAlive,
  stringifyAction,
  tryRecoverDevice,
} from '../src/agent/handlers';
import { login, LoginFailedError } from '../src/agent/login';
import type {
  Action,
  AppMap,
  Fingerprint,
  Finding,
  RunStatus,
  Screen,
  SessionState,
} from '../src/types/index';

const APP_PACKAGE = process.env.WASTEHERO_APP_PACKAGE ?? 'com.wastehero_mobileapp_navigator';

const log = (msg: string): void => console.log(`[qa-server] ${msg}`);

// --------------------------------------------------------------------------
// CLI args
// --------------------------------------------------------------------------

interface Args {
  role: string | undefined;
  port: number;
}

function parseArgs(argv: string[]): Args {
  let role: string | undefined;
  let port = 7099;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--role' && i + 1 < argv.length) {
      role = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--port' && i + 1 < argv.length) {
      port = Number(argv[i + 1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port must be a valid TCP port, got ${argv[i + 1]}`);
      }
      i += 1;
    }
  }
  return { role, port };
}

function pickRole(
  explicit: string | undefined,
  roles: Record<string, { email: string; password: string }>,
): string {
  if (explicit) {
    if (!roles[explicit]) {
      throw new Error(
        `--role ${explicit}: no credentials configured (set WH_CREDS_${explicit.toUpperCase()}_EMAIL + _PASSWORD)`,
      );
    }
    return explicit;
  }
  const keys = Object.keys(roles);
  if (keys.length === 0) {
    throw new Error('no auth roles configured (set WH_CREDS_<ROLE>_EMAIL + _PASSWORD)');
  }
  if (keys.length > 1) {
    throw new Error(`multiple roles configured (${keys.join(', ')}); pass --role <name>`);
  }
  return keys[0];
}

function newRunId(): string {
  const suffix = customAlphabet('0123456789abcdef', 4);
  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `run-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}-${suffix()}`;
}

// --------------------------------------------------------------------------
// Action validation
// --------------------------------------------------------------------------

const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), elementId: z.string().min(1) }),
  z.object({
    kind: z.literal('tapAt'),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  }),
  z.object({ kind: z.literal('type'), elementId: z.string().min(1), text: z.string() }),
  z.object({ kind: z.literal('swipe'), direction: z.enum(['up', 'down', 'left', 'right']) }),
  z.object({ kind: z.literal('back') }),
  z.object({ kind: z.literal('scrollTo'), elementId: z.string().min(1) }),
  z.object({ kind: z.literal('done'), reason: z.string() }),
]);

function violatesDenyList(action: Action, denyList: string[]): string | null {
  const key = stringifyAction(action);
  for (const entry of denyList) {
    if (key === entry || key.startsWith(`${entry}:`) || entry === key.split(':')[0]) {
      return entry;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Server state
// --------------------------------------------------------------------------

interface ServerState {
  config: ReturnType<typeof loadConfig>;
  role: string;
  runId: string;
  runDir: string;
  appVersion: string;
  appMap: AppMap;
  history: Finding[];
  driver: AppiumDriver;
  recorder: Recorder;
  logcatTail: LogcatTail;
  videoRecorder: VideoRecorder;
  appiumServer: AppiumServerHandle;
  emulator: EmulatorHandle;
  startMs: number;
  state: SessionState;
  /** Logcat timestamp boundary for the next perceive's delta window. */
  prevLogcatTs: number;
  /** Set true after /finalize starts so /perceive and /act stop accepting. */
  finalized: boolean;
  /** Device pixel dimensions — same coordinate space as screenshots + tapAt. */
  windowSize: { width: number; height: number };
}

// --------------------------------------------------------------------------
// Bootstrap
// --------------------------------------------------------------------------

async function bootstrap(args: Args): Promise<ServerState> {
  const config = loadConfig();
  const role = pickRole(args.role, config.auth.roles);
  const runId = newRunId();
  const runDir = join(
    fileURLToPath(new URL('../../../output/android-qa', import.meta.url)),
    runId,
  );
  mkdirSync(runDir, { recursive: true });

  log(`runId=${runId}`);
  log(`runDir=${runDir}`);
  log(`role=${role}`);

  const appMap = await loadAppMap(defaultAppMapPath());
  const history = await readHistory(defaultFindingsHistoryPath());
  log(
    `app-map screens=${Object.keys(appMap.screens).length} history-findings=${history.length}`,
  );

  log('starting emulator...');
  const emulator = await startEmulator({
    avdName: config.device.avdName,
    sdkRoot: config.device.sdkRoot,
    consolePort: DEFAULT_EMULATOR_CONSOLE_PORT,
    readOnly: process.env.ANDROID_EMULATOR_READ_ONLY === '1',
  });

  const logcatTail = new LogcatTail({ serial: emulator.serial });
  const videoRecorder = new VideoRecorder({ serial: emulator.serial });

  const bootTimeoutMs = Number(process.env.ANDROID_EMULATOR_BOOT_TIMEOUT_MS ?? 300_000);
  await waitForBoot(emulator.serial, bootTimeoutMs);
  log('emulator booted');

  log('installing APK...');
  await installApk(config.device.apkPath, emulator.serial);
  const appVersion = await extractApkVersion(config.device.apkPath, config.device.sdkRoot);
  log(`appVersion=${appVersion}`);

  log('starting Appium...');
  const appiumServer = await startAppium(config.device.appiumHost, config.device.appiumPort);

  log('creating driver session...');
  const driver = new AppiumDriver({
    appiumUrl: `http://${config.device.appiumHost}:${config.device.appiumPort}`,
    avdName: config.device.avdName,
    apkPath: config.device.apkPath,
    appPackage: APP_PACKAGE,
    udid: emulator.serial,
  });
  await driver.start();
  log('driver session created');

  await logcatTail.start();
  log('logcat tail started');

  await videoRecorder.start(runDir);
  log('video recording started');

  const state: SessionState = {
    runId,
    appVersion,
    role,
    startedAt: new Date().toISOString(),
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
  const recorder = new Recorder({ runDir, initialState: state });

  log('logging in...');
  try {
    await login(driver, config.auth.roles[role]);
    log('login succeeded');
  } catch (err) {
    if (err instanceof LoginFailedError) {
      console.error(`[qa-server] login failed: ${err.message}`);
      // Surface the failure cleanly: persist aborted-auth, tear down, exit 1.
      state.status = 'aborted-auth';
      state.endedAt = new Date().toISOString();
      await recorder.finalize('aborted-auth');
      await teardownPartial({ driver, appiumServer, emulator, logcatTail, videoRecorder });
      process.exit(1);
    }
    throw err;
  }

  const windowSize = await driver.getWindowSize();
  log(`windowSize=${windowSize.width}x${windowSize.height}`);

  return {
    config,
    role,
    runId,
    runDir,
    appVersion,
    appMap,
    history,
    driver,
    recorder,
    logcatTail,
    videoRecorder,
    appiumServer,
    emulator,
    startMs: Date.now(),
    state,
    prevLogcatTs: Date.now(),
    finalized: false,
    windowSize,
  };
}

// --------------------------------------------------------------------------
// HTTP handlers
// --------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function elapsedMs(s: ServerState): number {
  return Date.now() - s.startMs;
}

function budgetRemaining(s: ServerState): {
  wallClockMsRemaining: number;
  turnsRemaining: number;
} {
  return {
    wallClockMsRemaining: Math.max(0, s.state.budget.wallClockMs - elapsedMs(s)),
    turnsRemaining: Math.max(0, s.state.budget.turns - s.state.history.length),
  };
}

async function handleStatus(s: ServerState, res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    runId: s.runId,
    runDir: s.runDir,
    role: s.role,
    appVersion: s.appVersion,
    appMapScreens: Object.keys(s.appMap.screens).length,
    appMapTransitions: s.appMap.transitions.length,
    windowSize: s.windowSize,
    turn: s.state.history.length,
    findings: s.state.findings.length,
    crashCount: s.state.counters.crashCount,
    finalized: s.finalized,
    budget: s.state.budget,
    budgetRemaining: budgetRemaining(s),
  });
}

async function handlePerceive(s: ServerState, res: ServerResponse): Promise<void> {
  if (s.finalized) {
    sendJson(res, 409, { error: 'session already finalized' });
    return;
  }

  let perceived;
  try {
    perceived = await perceiveTurn(s.driver, s.logcatTail, s.prevLogcatTs);
  } catch (err) {
    const recovered = await tryRecoverDevice(s.driver);
    if (!recovered) {
      sendJson(res, 502, {
        error: 'perceive failed; device unrecoverable',
        detail: errorMessage(err),
      });
      return;
    }
    try {
      perceived = await perceiveTurn(s.driver, s.logcatTail, s.prevLogcatTs);
    } catch (err2) {
      sendJson(res, 502, {
        error: 'perceive failed twice',
        detail: errorMessage(err2),
      });
      return;
    }
  }
  s.prevLogcatTs = Date.now();

  // Crash detection — increments counter; the skill decides whether to keep going.
  const crash = s.logcatTail.detectCrash(perceived.logcatDelta);
  if (crash) s.state.counters.crashCount += 1;

  // Register the screen if new; carry forward persisted element flags so the
  // frontier doesn't re-promote already-tapped elements to priority 100.
  const isNewScreen = s.state.screens[perceived.fp] === undefined;
  const nowIso = new Date().toISOString();
  const screen: Screen = isNewScreen
    ? buildScreen(perceived.tree, perceived.activity, nowIso, perceived.fp, s.appMap)
    : s.state.screens[perceived.fp];
  if (isNewScreen) {
    s.state.screens[perceived.fp] = screen;
    const newFront = buildFrontier(screen, s.appMap, {
      currentRunId: s.state.runId,
      sessionScreens: s.state.screens,
    });
    s.state.frontier = mergeFrontier(s.state.frontier, newFront, perceived.fp);
  }

  // Deterministic findings (logcat + tree text scans).
  const evalFindings = evaluate(s.state, {
    currentScreenFp: perceived.fp,
    currentTree: perceived.tree,
    logcatDelta: perceived.logcatDelta,
  });
  if (evalFindings.length > 0) {
    s.state.findings = dedupInRun([...s.state.findings, ...evalFindings]);
  }

  // Save the pre-action screenshot so the skill can Read() it.
  const turnIdx = s.state.history.length + 1;
  const screenshotPath = await s.recorder.saveScreenshot(
    turnIdx,
    'pre',
    perceived.shot,
  );

  sendJson(res, 200, {
    runId: s.runId,
    turn: turnIdx,
    fingerprint: perceived.fp,
    activity: perceived.activity,
    isNewScreen,
    crashCount: s.state.counters.crashCount,
    crashThisTurn: !!crash,
    screenshotPath,
    windowSize: s.windowSize,
    screen: {
      fingerprint: screen.fingerprint,
      activity: screen.activity,
      elements: Object.values(screen.elements).map((el) => ({
        resourceId: el.resourceId,
        role: el.role,
        text: el.text,
        tapped: el.tapped,
        marked: el.marked,
        outcomes: el.outcomes,
      })),
    },
    frontier: frontierForScreen(s.state.frontier, perceived.fp).map((f) => ({
      elementId: f.elementId,
      priority: f.priority,
    })),
    triagedFindings: s.state.findings
      .filter((f) => f.screenFp === perceived.fp)
      .map((f) => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        summary: f.summary,
        element: f.element,
      })),
    historyTail: s.state.history.slice(-5).map((h) => ({
      turn: h.turn,
      screenFp: h.screenFp,
      action: h.action,
      outcomeFp: h.outcomeFp,
      ms: h.ms,
    })),
    denyList: s.config.agent.denyActions,
    budgetRemaining: budgetRemaining(s),
  });
}

async function handleAct(
  s: ServerState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (s.finalized) {
    sendJson(res, 409, { error: 'session already finalized' });
    return;
  }

  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid JSON body', detail: errorMessage(err) });
    return;
  }
  const actionParse = z
    .object({ action: ActionSchema })
    .safeParse(parsed);
  if (!actionParse.success) {
    sendJson(res, 400, {
      error: 'action failed schema validation',
      issues: actionParse.error.issues,
    });
    return;
  }
  const { action } = actionParse.data;

  const denied = violatesDenyList(action, s.config.agent.denyActions);
  if (denied) {
    sendJson(res, 400, { error: 'action denied by deny-list', denyMatch: denied });
    return;
  }

  // Capture the origin fingerprint from the most recent perceive context — we
  // pull it directly from the driver since /perceive and /act are independent
  // requests and the skill might call /act without /perceive first.
  const turnStart = Date.now();
  let originFp: Fingerprint;
  try {
    const tree = await s.driver.getViewTree();
    const activity = await s.driver.getCurrentActivity();
    const { fingerprintFromTree } = await import('../src/agent/fingerprint');
    originFp = fingerprintFromTree(tree, activity);
  } catch (err) {
    sendJson(res, 502, { error: 'could not read origin screen', detail: errorMessage(err) });
    return;
  }

  // 'done' is a marker action — does not dispatch, does not advance the turn
  // counter. The skill can still call /finalize next.
  if (action.kind === 'done') {
    sendJson(res, 200, {
      done: true,
      reason: action.reason,
      message: 'agent signalled done; call /finalize to persist + tear down',
    });
    return;
  }

  try {
    await dispatchAction(s.driver, action);
  } catch (err) {
    log(`dispatchAction(${stringifyAction(action)}) error: ${errorMessage(err)}`);
    // The liveness probe + observe below handle recovery.
  }

  const aliveAfter = await safeIsAppAlive(s.driver);
  if (!aliveAfter) {
    const recovered = await tryRecoverDevice(s.driver);
    if (!recovered) {
      sendJson(res, 502, { error: 'app died after action and could not be relaunched' });
      return;
    }
  }

  let outcomeFp: Fingerprint | null;
  let postShotPath: string | null = null;
  try {
    const post = await observeOutcome(s.driver);
    outcomeFp = post.fp;
    const turnIdx = s.state.history.length + 1;
    postShotPath = await s.recorder.saveScreenshot(turnIdx, 'post', post.shot);
  } catch {
    outcomeFp = null;
  }

  recordActionOutcome(s.state, originFp, action, outcomeFp);
  refreshFrontierForScreen(s.state, s.appMap, originFp);

  const elapsed = Date.now() - turnStart;
  const turn = s.state.history.length + 1;
  const entry = { turn, screenFp: originFp, action, outcomeFp, ms: elapsed };
  s.state.history.push(entry);
  await s.recorder.appendTurn(entry);
  await s.recorder.updateState({
    screens: s.state.screens,
    frontier: s.state.frontier,
    findings: s.state.findings,
    counters: s.state.counters,
  });

  // Wall-clock + turn-budget tripwires. The skill can also stop on its own.
  const budgetExpired =
    elapsedMs(s) >= s.state.budget.wallClockMs ||
    s.state.history.length >= s.state.budget.turns;

  sendJson(res, 200, {
    turn,
    originFp,
    outcomeFp,
    fpChanged: outcomeFp !== null && outcomeFp !== originFp,
    postScreenshotPath: postShotPath,
    elapsedMs: elapsed,
    budgetRemaining: budgetRemaining(s),
    budgetExpired,
  });
}

async function handleFinalize(
  s: ServerState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (s.finalized) {
    sendJson(res, 409, { error: 'session already finalized' });
    return;
  }
  s.finalized = true;

  let status: RunStatus = 'completed';
  try {
    const body = await readBody(req);
    if (body.trim().length > 0) {
      const parsed = JSON.parse(body) as { status?: RunStatus };
      if (parsed.status) status = parsed.status;
    }
  } catch {
    // Use default status. Don't fail finalize on a parse error.
  }

  log('merging run into app-map...');
  const nextMap = mergeRunIntoMap(s.appMap, s.state);
  await saveAppMap(nextMap, defaultAppMapPath());

  log('classifying findings against history...');
  const classified = classifyAgainstHistory(s.state.findings, s.history);
  s.state.findings = classified;
  const counts = classified.reduce(
    (acc, f) => {
      acc[f.status] = (acc[f.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  log(
    `new=${counts.new ?? 0} previously-seen=${counts['previously-seen'] ?? 0} resurrected=${counts.resurrected ?? 0}`,
  );

  log('slicing artifacts...');
  await sliceArtifacts(s.state, s.runDir, s.logcatTail, s.videoRecorder);

  if (s.state.findings.length > 0) {
    await appendFindings(s.state.findings, defaultFindingsHistoryPath());
  }

  log('writing report.md');
  const md = render({ session: s.state, history: s.history, runDir: s.runDir });
  await writeFile(join(s.runDir, 'report.md'), md, 'utf8');
  await s.recorder.updateState({ findings: s.state.findings });
  await s.recorder.finalize(status);

  log('tearing down...');
  await teardownPartial({
    driver: s.driver,
    appiumServer: s.appiumServer,
    emulator: s.emulator,
    logcatTail: s.logcatTail,
    videoRecorder: s.videoRecorder,
  });

  sendJson(res, 200, {
    status,
    runId: s.runId,
    runDir: s.runDir,
    reportPath: join(s.runDir, 'report.md'),
    findings: s.state.findings.length,
    appMapScreens: Object.keys(nextMap.screens).length,
    appMapTransitions: nextMap.transitions.length,
  });

  // Give the response a moment to flush before exiting.
  setTimeout(() => process.exit(0), 200).unref();
}

// --------------------------------------------------------------------------
// Helpers (artifact slicing — extracted from deleted run-explore.ts)
// --------------------------------------------------------------------------

function findingDisplayId(id: string): string {
  return `f-${id.slice(0, 4)}`;
}

function findingTurnOffsetMs(
  finding: Finding,
  history: SessionState['history'],
): { turnIdx: number; offsetMs: number } | null {
  let acc = 0;
  for (const turn of history) {
    if (turn.screenFp === finding.screenFp) {
      return { turnIdx: turn.turn, offsetMs: acc };
    }
    acc += turn.ms;
  }
  return null;
}

async function sliceArtifacts(
  session: SessionState,
  runDir: string,
  logcatTail: LogcatTail,
  videoRecorder: VideoRecorder,
): Promise<void> {
  const videoPath = join(runDir, 'video.mp4');
  const videoExists = existsSync(videoPath);
  const startMs = Date.parse(session.startedAt);

  for (let i = 0; i < session.findings.length; i += 1) {
    const finding = session.findings[i];
    const loc = findingTurnOffsetMs(finding, session.history);
    if (!loc) continue;

    const displayId = findingDisplayId(finding.id);
    const findingDir = join(runDir, 'findings', displayId);
    mkdirSync(findingDir, { recursive: true });

    const refs: NonNullable<Finding['artifactRefs']> = { ...(finding.artifactRefs ?? {}) };

    const turnIdx = loc.turnIdx.toString().padStart(4, '0');
    const postShot = join(runDir, 'screenshots', `turn-${turnIdx}-post.png`);
    if (existsSync(postShot)) {
      const dest = join(findingDir, 'before.png');
      try {
        await copyFile(postShot, dest);
        refs.screenshot = `findings/${displayId}/before.png`;
      } catch (err) {
        console.error(`[qa-server] copy screenshot ${finding.id} failed: ${errorMessage(err)}`);
      }
    }

    if (finding.category === 'A' && Number.isFinite(startMs)) {
      const centerTs = startMs + loc.offsetMs;
      const lines = logcatTail.excerpt(centerTs, 30_000);
      if (lines.length > 0) {
        const rel = `findings/${displayId}/logcat-excerpt.log`;
        await writeFile(join(runDir, rel), lines.join('\n') + '\n', 'utf8');
        refs.logcat = rel;
      }
    }

    if (videoExists) {
      const clipRel = `findings/${displayId}/clip.mp4`;
      const clipPath = join(runDir, clipRel);
      const clipStart = Math.max(0, loc.offsetMs - 5_000);
      const clipEnd = loc.offsetMs + 10_000;
      try {
        await videoRecorder.clip(videoPath, clipStart, clipEnd, clipPath);
        if (existsSync(clipPath)) {
          refs.video = clipRel;
        }
      } catch (err) {
        console.error(`[qa-server] clip ${finding.id} failed: ${errorMessage(err)}`);
      }
    }

    session.findings[i] = { ...finding, artifactRefs: refs };
  }
}

// --------------------------------------------------------------------------
// Teardown
// --------------------------------------------------------------------------

interface TeardownRefs {
  driver?: AppiumDriver;
  appiumServer?: AppiumServerHandle;
  emulator?: EmulatorHandle;
  logcatTail?: LogcatTail;
  videoRecorder?: VideoRecorder;
}

async function tryTeardown(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[qa-server] teardown (${label}) failed: ${errorMessage(err)}`);
  }
}

async function teardownPartial(refs: TeardownRefs): Promise<void> {
  if (refs.videoRecorder) await tryTeardown('video', () => refs.videoRecorder!.stop());
  if (refs.logcatTail) await tryTeardown('logcat', () => refs.logcatTail!.stop());
  if (refs.driver) await tryTeardown('driver', () => refs.driver!.stop());
  if (refs.appiumServer) await tryTeardown('appium', () => refs.appiumServer!.stop());
  if (refs.emulator) await tryTeardown('emulator', () => refs.emulator!.stop());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Bootstrap may exit on auth failure; ServerState is always present after.
  const s = await bootstrap(args);

  const sigHandler = async (sig: string): Promise<void> => {
    console.error(`[qa-server] ${sig} — tearing down`);
    s.finalized = true;
    await teardownPartial({
      driver: s.driver,
      appiumServer: s.appiumServer,
      emulator: s.emulator,
      logcatTail: s.logcatTail,
      videoRecorder: s.videoRecorder,
    });
    process.exit(130);
  };
  process.once('SIGINT', () => void sigHandler('SIGINT'));
  process.once('SIGTERM', () => void sigHandler('SIGTERM'));

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    void (async () => {
      try {
        if (method === 'GET' && url === '/status') {
          await handleStatus(s, res);
        } else if (method === 'POST' && url === '/perceive') {
          await handlePerceive(s, res);
        } else if (method === 'POST' && url === '/act') {
          await handleAct(s, req, res);
        } else if (method === 'POST' && url === '/finalize') {
          await handleFinalize(s, req, res);
        } else {
          sendJson(res, 404, { error: 'not found', method, url });
        }
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'unhandled', detail: errorMessage(err) });
        }
      }
    })();
  });

  server.listen(args.port, '127.0.0.1', () => {
    log(`READY runId=${s.runId} port=${args.port} role=${s.role}`);
    log(`endpoints: GET /status, POST /perceive, POST /act, POST /finalize`);
  });
}

main().catch((err) => {
  console.error(`[qa-server] fatal: ${errorMessage(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
