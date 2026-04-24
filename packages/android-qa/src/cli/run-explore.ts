/**
 * Shared explore pipeline. Both `bin/explore.ts` and `bin/smoke.ts` call
 * `runExplore(argv)`; smoke overrides config via env vars (loadConfig reads
 * `process.env`) and does its own post-run assertions on the returned
 * `SessionState`.
 *
 * Kept in `src/cli/` rather than `bin/` because bin files historically hold
 * the direct-execution top-level (signal handlers, process.exit) while this
 * module's exports are meant to be imported. The signal handlers are still
 * registered at module import time — each CLI is its own process, so the
 * cached module is loaded exactly once per invocation.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { customAlphabet } from 'nanoid';
import { loadConfig } from '../config/index';
import { ClaudeClient } from '../agent/claude';
import { run } from '../agent/orchestrator';
import { AppiumDriver } from '../device/appium-driver';
import type { AppiumServerHandle } from '../device/appium-server';
import type { EmulatorHandle } from '../device/emulator';
import {
  DEFAULT_EMULATOR_CONSOLE_PORT,
  extractApkVersion,
  installApk,
  startEmulator,
  waitForBoot,
} from '../device/emulator';
import { startAppium } from '../device/appium-server';
import { LogcatTail } from '../recorder/logcat';
import { Recorder } from '../recorder/recorder';
import { VideoRecorder } from '../recorder/video';
import { render } from '../report/render';
import {
  defaultAppMapPath,
  loadAppMap,
  saveAppMap,
} from '../state/app-map';
import { classifyAgainstHistory } from '../state/cross-run-dedup';
import {
  appendFindings,
  defaultFindingsHistoryPath,
  readHistory,
} from '../state/findings-history';
import { mergeRunIntoMap } from '../state/map-merge';
import type { Finding, SessionState } from '../types/index';

// Canonical package id for the WasteHero Android app. Overridable via env so
// dev builds under a different applicationId suffix can be driven without a
// code change.
const APP_PACKAGE = process.env.WASTEHERO_APP_PACKAGE ?? 'com.wastehero_mobileapp_navigator';

const log = (msg: string): void => {
  console.log(`[explore] ${msg}`);
};

async function tryTeardown(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[explore] teardown (${label}) failed: ${message}`);
  }
}

/**
 * runIds are `run-YYYYMMDD-HHMM-<nanoid(4)>` in UTC. Stable, sortable, and
 * unique-per-run even when the same minute is retried. When an explicit
 * instance index is passed, it's embedded as `-iN-` so parallel runs never
 * collide on the run directory name.
 */
function newRunId(instanceIndex?: number): string {
  const suffix = customAlphabet('0123456789abcdef', 4);
  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const instanceSuffix = typeof instanceIndex === 'number' ? `-i${instanceIndex}` : '';
  return `run-${yyyy}${mm}${dd}-${hh}${mi}${instanceSuffix}-${suffix()}`;
}

/**
 * Instance-level resource allocation. Driven by `ANDROID_QA_INSTANCE_INDEX`
 * (0-based). When unset, behaves exactly like the legacy single-instance
 * pipeline — no extra flags, default ports, canonical state files.
 *
 * When set (parallel mode), every externally-bindable resource is offset by
 * the index so N instances don't collide:
 *   - emulator console port = 5554 + i*2 (adb port = console+1)
 *   - emulator serial       = `emulator-<console_port>`
 *   - Appium port           = 4723 + i
 *   - read-only AVD boot    = true (every instance shares the base image;
 *                             wipe-installs the APK fresh on boot anyway)
 *   - state shards          = state/shards/<runId>.{app-map.json,findings.jsonl}
 *   - run directory suffix  = `-i<index>`
 */
interface InstanceAllocation {
  index: number | null;
  consolePort: number;
  serial: string;
  appiumPort: number;
  readOnly: boolean;
  shard: boolean;
}

function resolveInstance(configAppiumPort: number): InstanceAllocation {
  const raw = process.env.ANDROID_QA_INSTANCE_INDEX;
  if (raw === undefined || raw === '') {
    return {
      index: null,
      consolePort: DEFAULT_EMULATOR_CONSOLE_PORT,
      serial: `emulator-${DEFAULT_EMULATOR_CONSOLE_PORT}`,
      appiumPort: configAppiumPort,
      readOnly: process.env.ANDROID_EMULATOR_READ_ONLY === '1',
      shard: false,
    };
  }
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`ANDROID_QA_INSTANCE_INDEX must be a non-negative integer, got ${raw}`);
  }
  const consolePort = DEFAULT_EMULATOR_CONSOLE_PORT + index * 2;
  return {
    index,
    consolePort,
    serial: `emulator-${consolePort}`,
    appiumPort: configAppiumPort + index,
    // Default to read-only in parallel mode — overridable via env for debug.
    readOnly: process.env.ANDROID_EMULATOR_READ_ONLY !== '0',
    shard: true,
  };
}

/**
 * Resolve the on-disk paths used for app-map + findings-history reads/writes.
 *
 * Reads always come from the canonical state files — every instance sees the
 * same baseline. Writes are routed to `state/shards/<runId>.*` when sharding
 * is enabled so parallel instances don't clobber each other; a post-run
 * `merge-shards` step reconciles them back into canonical.
 */
function resolveStatePaths(
  runId: string,
  shard: boolean,
): { readAppMap: string; writeAppMap: string; readHistory: string; writeHistory: string } {
  const canonicalAppMap = defaultAppMapPath();
  const canonicalHistory = defaultFindingsHistoryPath();
  if (!shard) {
    return {
      readAppMap: canonicalAppMap,
      writeAppMap: canonicalAppMap,
      readHistory: canonicalHistory,
      writeHistory: canonicalHistory,
    };
  }
  const shardsDir = fileURLToPath(new URL('../../state/shards/', import.meta.url));
  return {
    readAppMap: canonicalAppMap,
    writeAppMap: join(shardsDir, `${runId}.app-map.json`),
    readHistory: canonicalHistory,
    writeHistory: join(shardsDir, `${runId}.findings.jsonl`),
  };
}

/**
 * Locate a turn whose pre-action observation matches `screenFp`, returning
 * the turn index plus the cumulative milliseconds spent before it. Used to
 * slice video clips + centre logcat excerpts around the moment a finding was
 * observed. Returns null when no history entry matches (finding on a screen
 * we never stepped through — nothing to slice).
 */
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

/**
 * Resources that must be torn down on exit (normal or signal). Populated as
 * each resource is successfully created in `runExplore()` and consumed by
 * the SIGINT/SIGTERM handlers as defence-in-depth against Ctrl+C leaking the
 * emulator (~6GB) and Appium (blocks port 4723 for subsequent runs).
 */
interface ShutdownRefs {
  videoRecorder?: VideoRecorder;
  videoStarted?: boolean;
  logcatTail?: LogcatTail;
  logcatStarted?: boolean;
  driver?: AppiumDriver;
  appiumServer?: AppiumServerHandle;
  emulator?: EmulatorHandle;
}

const shutdown: ShutdownRefs = {};

async function teardownAll(refs: ShutdownRefs): Promise<void> {
  if (refs.videoRecorder && refs.videoStarted) {
    await tryTeardown('video', () => refs.videoRecorder!.stop());
  }
  if (refs.logcatTail && refs.logcatStarted) {
    await tryTeardown('logcat', () => refs.logcatTail!.stop());
  }
  if (refs.driver) await tryTeardown('driver', () => refs.driver!.stop());
  if (refs.appiumServer) await tryTeardown('appium', () => refs.appiumServer!.stop());
  if (refs.emulator) await tryTeardown('emulator', () => refs.emulator!.stop());
}

// Defence-in-depth: Ctrl+C (SIGINT) or a supervisor's SIGTERM would otherwise
// skip runExplore()'s finally block, leaking the emulator process, Appium
// server, `adb logcat`, and `adb shell screenrecord` as orphans — the next
// run then fails on port 4723 and the emulator lingers as a ~6GB process.
// Running teardown here before exit keeps those transient resources bounded.
let sigReceived = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    if (sigReceived) process.exit(130);
    sigReceived = true;
    console.error(`[explore] ${sig} — tearing down`);
    try {
      await teardownAll(shutdown);
    } finally {
      process.exit(130);
    }
  });
}

/** Parse `--role <name>` out of argv. Ignored when not provided. */
function parseRoleArg(argv: string[]): string | undefined {
  const idx = argv.indexOf('--role');
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

/**
 * Pick the role for this run: `--role` flag wins; otherwise the sole role
 * defined in config.auth.roles; otherwise throw with a clear message.
 */
function pickRole(
  argv: string[],
  roles: Record<string, { email: string; password: string }>,
): string {
  const explicit = parseRoleArg(argv);
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
    throw new Error(
      'no auth roles configured (set WH_CREDS_<ROLE>_EMAIL + _PASSWORD for at least one role)',
    );
  }
  if (keys.length > 1) {
    throw new Error(
      `multiple roles configured (${keys.join(', ')}); pass --role <name> to pick one`,
    );
  }
  return keys[0];
}

/**
 * Result of a pipeline run. `session` is always the SessionState as it stood
 * when the agent loop terminated (or the initial state if setup failed
 * before `run()` returned). `exitCode` follows the "completed → 0, anything
 * else → 1" convention.
 */
export interface RunExploreResult {
  runId: string;
  runDir: string;
  session: SessionState;
  exitCode: number;
}

/**
 * Execute one explore pipeline end-to-end:
 *   start emulator → Appium → driver → logcat → video →
 *   Claude-driven agent loop → map merge → cross-run dedup →
 *   slice per-finding artifacts → render report.md → persist session.json.
 *
 * All teardown happens in `finally`, so the emulator and servers are always
 * released, even when the agent loop throws. Returns a result object the
 * caller can inspect — smoke uses this for post-run assertions.
 */
export async function runExplore(argv: string[]): Promise<RunExploreResult> {
  const config = loadConfig();
  const role = pickRole(argv, config.auth.roles);
  const instance = resolveInstance(config.device.appiumPort);

  const runId = newRunId(instance.index ?? undefined);
  // `runDir` resolves off `import.meta.url` so Windows quirks around cwd don't
  // matter. `src/cli/run-explore.ts` → repo root is four `..` segments.
  const runDir = join(
    fileURLToPath(new URL('../../../../output/android-qa', import.meta.url)),
    runId,
  );
  mkdirSync(runDir, { recursive: true });

  const statePaths = resolveStatePaths(runId, instance.shard);

  log(`runId=${runId}`);
  log(`runDir=${runDir}`);
  log(`role=${role}`);
  if (instance.index !== null) {
    log(
      `instance=${instance.index} serial=${instance.serial} appiumPort=${instance.appiumPort} readOnly=${instance.readOnly}`,
    );
    log(`shard=${statePaths.writeAppMap}`);
  }

  const appMap = await loadAppMap(statePaths.readAppMap);
  const history = await readHistory(statePaths.readHistory);
  log(`app-map screens=${Object.keys(appMap.screens).length} history findings=${history.length}`);

  log('starting emulator...');
  const emulator = await startEmulator({
    avdName: config.device.avdName,
    sdkRoot: config.device.sdkRoot,
    consolePort: instance.consolePort,
    readOnly: instance.readOnly,
  });
  shutdown.emulator = emulator;

  const logcatTail = new LogcatTail({ serial: emulator.serial });
  const videoRecorder = new VideoRecorder({ serial: emulator.serial });
  shutdown.logcatTail = logcatTail;
  shutdown.videoRecorder = videoRecorder;

  let recorder: Recorder | null = null;
  let exitCode = 1;

  const initialState: SessionState = {
    runId,
    appVersion: '',
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
  let session: SessionState = initialState;

  try {
    // Cold boots on Win11 + swiftshader_indirect (and post-reboot first-runs) routinely
    // take 2-3 min, so 120s is too aggressive. Env override for slower hosts / debug.
    const bootTimeoutMs = Number(process.env.ANDROID_EMULATOR_BOOT_TIMEOUT_MS ?? 300_000);
    await waitForBoot(emulator.serial, bootTimeoutMs);
    log('emulator booted');

    log('installing APK...');
    await installApk(config.device.apkPath, emulator.serial);
    const appVersion = await extractApkVersion(config.device.apkPath, config.device.sdkRoot);
    log(`appVersion=${appVersion}`);

    log('starting Appium...');
    const appiumServer = await startAppium(config.device.appiumHost, instance.appiumPort);
    shutdown.appiumServer = appiumServer;

    log('creating driver session...');
    const driver = new AppiumDriver({
      appiumUrl: `http://${config.device.appiumHost}:${instance.appiumPort}`,
      avdName: config.device.avdName,
      apkPath: config.device.apkPath,
      appPackage: APP_PACKAGE,
      udid: emulator.serial,
    });
    await driver.start();
    shutdown.driver = driver;
    log('driver session created');

    await logcatTail.start();
    shutdown.logcatStarted = true;
    log('logcat tail started');

    await videoRecorder.start(runDir);
    shutdown.videoStarted = true;
    log('video recording started');

    const claude = new ClaudeClient({ apiKey: config.agent.apiKey, model: config.agent.model });

    session = { ...initialState, appVersion };
    recorder = new Recorder({ runDir, initialState: session });

    log('starting agent loop...');
    session = await run({
      driver,
      claude,
      recorder,
      config,
      appMap,
      history,
      role,
      logcatTail,
      runId,
      appVersion,
    });
    log(`agent loop finished: status=${session.status ?? 'unknown'} turns=${session.history.length}`);

    log('merging run into app-map...');
    const nextMap = mergeRunIntoMap(appMap, session);
    await saveAppMap(nextMap, statePaths.writeAppMap);

    log('classifying findings against history...');
    const classified = classifyAgainstHistory(session.findings, history);
    session.findings = classified;
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

    // Slice BEFORE appending to history — sliceArtifacts mutates each
    // finding's `artifactRefs`, and the JSONL snapshot must reflect those
    // refs so downstream consumers (publisher, report parser) can resolve
    // per-finding assets without re-scanning the run directory.
    log('slicing artifacts...');
    await sliceArtifacts(session, runDir, logcatTail, videoRecorder);

    if (session.findings.length > 0) {
      await appendFindings(session.findings, statePaths.writeHistory);
    }

    log('writing report.md');
    const md = render({ session, history, runDir });
    await writeFile(join(runDir, 'report.md'), md, 'utf8');

    // Single post-slice persist — session.json now reflects the enriched
    // findings (with artifactRefs) and matches what the JSONL history holds.
    await recorder.updateState({ findings: session.findings });

    exitCode = session.status === 'completed' ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[explore] fatal: ${message}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    exitCode = 1;
  } finally {
    log('tearing down...');
    await teardownAll(shutdown);
    // Zero out the refs so the signal path, if it fires after normal return,
    // becomes a no-op (stopChild is idempotent, but this keeps the log clean).
    shutdown.videoStarted = false;
    shutdown.logcatStarted = false;
    shutdown.driver = undefined;
    shutdown.appiumServer = undefined;
    shutdown.emulator = undefined;
    log(`done; exiting ${exitCode}`);
  }

  return { runId, runDir, session, exitCode };
}

/**
 * Human-facing display id — first 4 hex chars of the 16-char SHA-1 prefix,
 * prefixed `f-`. Must stay in sync with `src/report/render.ts:displayId`,
 * because the report's hardcoded artifact paths use this exact directory name.
 */
function findingDisplayId(id: string): string {
  return `f-${id.slice(0, 4)}`;
}

/**
 * Write per-finding asset files at the paths the report renderer hardcodes:
 *   - `findings/<f-XXXX>/before.png`       — post-action screenshot (the
 *     orchestrator only writes `turn-NNNN-post.png` today).
 *   - `findings/<f-XXXX>/logcat-excerpt.log` — 30s logcat window, category A only.
 *   - `findings/<f-XXXX>/clip.mp4`          — 15s clip (-5s .. +10s) around the
 *     turn, only when `video.mp4` and ffmpeg are both available.
 *
 * Also populates each finding's `artifactRefs` with matching relative paths
 * so the JSONL history carries the refs for downstream consumers. Mutates
 * `session.findings` in place.
 *
 * TODO(task-27): the clip-window offset is computed from cumulative
 * per-turn `ms` values, which start from the first turn AFTER login. Login
 * duration itself is not in `session.history`, so clip timestamps drift by
 * the login wall-time (~15-30s today). Correct once per-turn wall-clock
 * timestamps are threaded through SessionState. Widening the window to
 * -5s / +10s is a hedge until then.
 */
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
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[explore] copy screenshot ${finding.id} failed: ${message}`);
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
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[explore] clip ${finding.id} failed: ${message}`);
      }
    }

    session.findings[i] = { ...finding, artifactRefs: refs };
  }
}
