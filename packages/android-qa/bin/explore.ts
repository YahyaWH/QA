import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { customAlphabet } from 'nanoid';
import { loadConfig } from '../src/config/index';
import { ClaudeClient } from '../src/agent/claude';
import { run } from '../src/agent/orchestrator';
import { AppiumDriver } from '../src/device/appium-driver';
import type { AppiumServerHandle } from '../src/device/appium-server';
import type { EmulatorHandle } from '../src/device/emulator';
import {
  extractApkVersion,
  installApk,
  startEmulator,
  waitForBoot,
} from '../src/device/emulator';
import { startAppium } from '../src/device/appium-server';
import { LogcatTail } from '../src/recorder/logcat';
import { Recorder } from '../src/recorder/recorder';
import { VideoRecorder } from '../src/recorder/video';
import { render } from '../src/report/render';
import { loadAppMap, saveAppMap } from '../src/state/app-map';
import { classifyAgainstHistory } from '../src/state/cross-run-dedup';
import {
  appendFindings,
  readHistory,
} from '../src/state/findings-history';
import { mergeRunIntoMap } from '../src/state/map-merge';
import type { Finding, SessionState } from '../src/types/index';

// TODO(task-27): move appPackage into config once a WASTEHERO_APP_PACKAGE env
// var is introduced. For now we use the canonical id used across fixtures,
// the design doc, and the planning spec.
const APP_PACKAGE = 'com.wastehero';

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
 * unique-per-run even when the same minute is retried.
 */
function newRunId(): string {
  const suffix = customAlphabet('0123456789abcdef', 4);
  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  return `run-${yyyy}${mm}${dd}-${hh}${mi}-${suffix()}`;
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
 * each resource is successfully created in `main()` and consumed by the
 * SIGINT/SIGTERM handlers as defence-in-depth against Ctrl+C leaking the
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
// skip main()'s finally block, leaking the emulator process, Appium server,
// `adb logcat`, and `adb shell screenrecord` as orphans — the next run then
// fails on port 4723 and the emulator lingers as a ~6GB process. Running
// teardown here before exit keeps those transient resources bounded.
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

async function main(): Promise<number> {
  const config = loadConfig();
  const role = pickRole(process.argv.slice(2), config.auth.roles);

  const runId = newRunId();
  // `runDir` resolves off `import.meta.url` so Windows quirks around cwd don't
  // matter. `bin/explore.ts` → repo root is three `..` segments.
  const runDir = join(
    fileURLToPath(new URL('../../../output/android-qa', import.meta.url)),
    runId,
  );
  mkdirSync(runDir, { recursive: true });

  log(`runId=${runId}`);
  log(`runDir=${runDir}`);
  log(`role=${role}`);

  const appMap = await loadAppMap();
  const history = await readHistory();
  log(`app-map screens=${Object.keys(appMap.screens).length} history findings=${history.length}`);

  log('starting emulator...');
  const emulator = await startEmulator(config.device.avdName, config.device.sdkRoot);
  shutdown.emulator = emulator;

  const logcatTail = new LogcatTail();
  const videoRecorder = new VideoRecorder();
  shutdown.logcatTail = logcatTail;
  shutdown.videoRecorder = videoRecorder;

  let recorder: Recorder | null = null;
  let exitCode = 1;

  try {
    await waitForBoot();
    log('emulator booted');

    log('installing APK...');
    await installApk(config.device.apkPath);
    const appVersion = await extractApkVersion(config.device.apkPath);
    log(`appVersion=${appVersion}`);

    log('starting Appium...');
    const appiumServer = await startAppium(config.device.appiumHost, config.device.appiumPort);
    shutdown.appiumServer = appiumServer;

    log('creating driver session...');
    const driver = new AppiumDriver({
      appiumUrl: `http://${config.device.appiumHost}:${config.device.appiumPort}`,
      avdName: config.device.avdName,
      apkPath: config.device.apkPath,
      appPackage: APP_PACKAGE,
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

    const initialState: SessionState = {
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

    recorder = new Recorder({ runDir, initialState });

    log('starting agent loop...');
    const session = await run({
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
    await saveAppMap(nextMap);

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
      await appendFindings(session.findings);
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
  return exitCode;
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

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[explore] unhandled: ${message}`);
    process.exit(1);
  },
);
