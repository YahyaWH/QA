import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { customAlphabet } from 'nanoid';
import { loadConfig } from '../src/config/index';
import { ClaudeClient } from '../src/agent/claude';
import { run } from '../src/agent/orchestrator';
import { AppiumDriver } from '../src/device/appium-driver';
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
  let appiumServer: Awaited<ReturnType<typeof startAppium>> | null = null;
  let driver: AppiumDriver | null = null;
  const logcatTail = new LogcatTail();
  const videoRecorder = new VideoRecorder();
  let logcatStarted = false;
  let videoStarted = false;
  let recorder: Recorder | null = null;
  let session: SessionState | null = null;
  let exitCode = 1;

  try {
    await waitForBoot();
    log('emulator booted');

    log('installing APK...');
    await installApk(config.device.apkPath);
    const appVersion = await extractApkVersion(config.device.apkPath);
    log(`appVersion=${appVersion}`);

    log('starting Appium...');
    appiumServer = await startAppium(config.device.appiumHost, config.device.appiumPort);

    log('creating driver session...');
    driver = new AppiumDriver({
      appiumUrl: `http://${config.device.appiumHost}:${config.device.appiumPort}`,
      avdName: config.device.avdName,
      apkPath: config.device.apkPath,
      appPackage: APP_PACKAGE,
    });
    await driver.start();
    log('driver session created');

    await logcatTail.start();
    logcatStarted = true;
    log('logcat tail started');

    await videoRecorder.start(runDir);
    videoStarted = true;
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

    if (classified.length > 0) {
      await appendFindings(classified);
    }

    log('slicing artifacts...');
    await sliceArtifacts(session, runDir, logcatTail, videoRecorder, recorder);

    log('writing report.md');
    const md = render({ session, history, runDir });
    await writeFile(join(runDir, 'report.md'), md, 'utf8');

    await recorder.updateState({ findings: classified });

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
    // Capture into consts so the narrowing survives across the arrow closures —
    // TypeScript won't narrow `let`-bindings inside a callback.
    const d = driver;
    const a = appiumServer;
    if (videoStarted) await tryTeardown('video', () => videoRecorder.stop());
    if (logcatStarted) await tryTeardown('logcat', () => logcatTail.stop());
    if (d) await tryTeardown('driver', () => d.stop());
    if (a) await tryTeardown('appium', () => a.stop());
    await tryTeardown('emulator', () => emulator.stop());
    log(`done; exiting ${exitCode}`);
  }
  return exitCode;
}

/**
 * Populate each finding's `artifactRefs` with paths to per-finding assets:
 *   - `screenshot`: pre-action screenshot for the first turn observing this
 *     screen (always relative to `runDir`).
 *   - `logcat`: 30s logcat excerpt around that turn's start, only for
 *     category-A findings (crashes/ANRs are the ones with logcat signal).
 *   - `video`: 7s clip (-2s .. +5s) around that turn, only when `video.mp4`
 *     exists AND ffmpeg is available (VideoRecorder.clip handles both as
 *     soft failures so we probe via existsSync first).
 *
 * Mutates `session.findings` in place.
 */
async function sliceArtifacts(
  session: SessionState,
  runDir: string,
  logcatTail: LogcatTail,
  videoRecorder: VideoRecorder,
  recorder: Recorder,
): Promise<void> {
  const videoPath = join(runDir, 'video.mp4');
  const videoExists = existsSync(videoPath);
  const startMs = Date.parse(session.startedAt);

  for (let i = 0; i < session.findings.length; i += 1) {
    const finding = session.findings[i];
    const loc = findingTurnOffsetMs(finding, session.history);
    if (!loc) continue;

    const refs: NonNullable<Finding['artifactRefs']> = { ...(finding.artifactRefs ?? {}) };

    // Screenshot: the recorder saves pre-action shots as turn-NNNN-pre.png,
    // but the orchestrator only records turn-NNNN-post.png today. Probe for
    // either so we still link something usable.
    const turnIdx = loc.turnIdx.toString().padStart(4, '0');
    const preShot = join('screenshots', `turn-${turnIdx}-pre.png`);
    const postShot = join('screenshots', `turn-${turnIdx}-post.png`);
    if (existsSync(join(runDir, preShot))) {
      refs.screenshot = preShot.replaceAll('\\', '/');
    } else if (existsSync(join(runDir, postShot))) {
      refs.screenshot = postShot.replaceAll('\\', '/');
    }

    if (finding.category === 'A' && Number.isFinite(startMs)) {
      const centerTs = startMs + loc.offsetMs;
      const lines = logcatTail.excerpt(centerTs, 30_000);
      if (lines.length > 0) {
        const rel = join('findings', `${finding.id}.log.txt`);
        await writeFile(join(runDir, rel), lines.join('\n') + '\n', 'utf8');
        refs.logcat = rel.replaceAll('\\', '/');
      }
    }

    if (videoExists) {
      const clipRel = join('findings', `${finding.id}.mp4`);
      const clipPath = join(runDir, clipRel);
      const clipStart = Math.max(0, loc.offsetMs - 2_000);
      const clipEnd = loc.offsetMs + 5_000;
      try {
        await videoRecorder.clip(videoPath, clipStart, clipEnd, clipPath);
        if (existsSync(clipPath)) {
          refs.video = clipRel.replaceAll('\\', '/');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[explore] clip ${finding.id} failed: ${message}`);
      }
    }

    session.findings[i] = { ...finding, artifactRefs: refs };
  }

  // Touch the recorder so session.json reflects the enriched findings; the
  // caller writes once more after `render` so this is technically redundant,
  // but keeping it locked-in here means a crash during render still leaves a
  // consistent on-disk snapshot.
  await recorder.updateState({ findings: session.findings });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[explore] unhandled: ${message}`);
    process.exit(1);
  },
);
