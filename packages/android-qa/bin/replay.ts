/**
 * `android-qa:replay --run <runId>`
 *
 * Debug tool: load a completed run's `session.json` and replay its `history`
 * — the ordered list of `{turn, action}` the orchestrator recorded — onto a
 * fresh emulator + Appium session. No Claude calls, no recorder, no report.
 *
 * Purpose: bisect "did the agent make the right call" from "did the UI
 * behave the same on re-observation". Runs deterministically for as long as
 * the app's state is reproducible — which is why it's a debug tool, not a
 * test harness.
 *
 * Login is always performed before the replay starts, using the session's
 * recorded `role` and the matching `WH_CREDS_<ROLE>_…` env credentials. The
 * replayed `history` excludes login (the orchestrator starts recording after
 * the login fingerprint stabilises), so driving login separately keeps the
 * driver on the same screen the recorded turn #0 was captured from.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index';
import { login } from '../src/agent/login';
import { AppiumDriver } from '../src/device/appium-driver';
import { startAppium } from '../src/device/appium-server';
import {
  installApk,
  startEmulator,
  waitForBoot,
} from '../src/device/emulator';
import type { Action, SessionState } from '../src/types/index';

const APP_PACKAGE = 'com.wastehero';

const log = (msg: string): void => {
  console.log(`[replay] ${msg}`);
};

function parseArgs(argv: string[]): { runId: string } {
  let runId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--run') {
      runId = argv[i + 1];
      i += 1;
    }
  }
  if (!runId) throw new Error('usage: android-qa:replay --run <runId>');
  return { runId };
}

/** Absolute path of `<repo>/output/android-qa/<runId>/session.json`. */
function sessionPathFor(runId: string): string {
  return join(
    fileURLToPath(new URL('../../../output/android-qa', import.meta.url)),
    runId,
    'session.json',
  );
}

/** Dispatch one recorded action onto a live driver. Mirrors the qa-server's
 *  dispatch switch (`src/agent/handlers.ts:dispatchAction`) so behaviour stays
 *  aligned — any new action kind must be added in both. */
async function dispatchAction(driver: AppiumDriver, action: Action): Promise<void> {
  switch (action.kind) {
    case 'tap':
      return driver.tap(action.elementId);
    case 'tapAt':
      return driver.tapAt(action.x, action.y);
    case 'type':
      return driver.type(action.elementId, action.text);
    case 'swipe':
      return driver.swipe(action.direction);
    case 'back':
      return driver.back();
    case 'scrollTo':
      return driver.scrollTo(action.elementId);
    case 'done':
      return;
  }
}

/** Compact one-line description of an action for the replay log. */
function describeAction(action: Action): string {
  switch (action.kind) {
    case 'tap':
      return `tap ${action.elementId}`;
    case 'tapAt':
      return `tapAt (${action.x}, ${action.y})`;
    case 'type':
      return `type ${action.elementId} "${action.text}"`;
    case 'swipe':
      return `swipe ${action.direction}`;
    case 'back':
      return 'back';
    case 'scrollTo':
      return `scrollTo ${action.elementId}`;
    case 'done':
      return `done (${action.reason})`;
  }
}

async function tryTeardown(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[replay] teardown (${label}) failed: ${message}`);
  }
}

async function main(): Promise<number> {
  const { runId } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const sessionPath = sessionPathFor(runId);
  log(`reading ${sessionPath}`);
  const raw = await readFile(sessionPath, 'utf8');
  const session = JSON.parse(raw) as SessionState;
  log(`role=${session.role} turns=${session.history.length}`);

  const creds = config.auth.roles[session.role];
  if (!creds) {
    console.error(
      `[replay] no credentials for role=${session.role} (set WH_CREDS_${session.role.toUpperCase()}_EMAIL/_PASSWORD)`,
    );
    return 1;
  }

  log('starting emulator...');
  const emulator = await startEmulator({
    avdName: config.device.avdName,
    sdkRoot: config.device.sdkRoot,
  });
  let appiumServer: Awaited<ReturnType<typeof startAppium>> | null = null;
  let driver: AppiumDriver | null = null;
  let exitCode = 1;

  try {
    await waitForBoot(emulator.serial);
    log('emulator booted');

    log('installing APK...');
    await installApk(config.device.apkPath, emulator.serial);

    log('starting Appium...');
    appiumServer = await startAppium(config.device.appiumHost, config.device.appiumPort);

    log('creating driver session...');
    driver = new AppiumDriver({
      appiumUrl: `http://${config.device.appiumHost}:${config.device.appiumPort}`,
      avdName: config.device.avdName,
      apkPath: config.device.apkPath,
      appPackage: APP_PACKAGE,
      udid: emulator.serial,
    });
    await driver.start();

    log('logging in...');
    await login(driver, creds);

    log(`replaying ${session.history.length} turn(s)...`);
    for (const turn of session.history) {
      const desc = describeAction(turn.action);
      log(`  turn ${turn.turn.toString().padStart(3, '0')}: ${desc}`);
      try {
        await dispatchAction(driver, turn.action);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[replay] turn ${turn.turn} failed: ${message}`);
        // Replays are best-effort debug tools — keep going so the developer
        // sees how far the recorded flow gets before it diverges.
      }
    }

    exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[replay] fatal: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    exitCode = 1;
  } finally {
    log('tearing down...');
    if (driver) await tryTeardown('driver', () => driver!.stop());
    if (appiumServer) await tryTeardown('appium', () => appiumServer!.stop());
    await tryTeardown('emulator', () => emulator.stop());
    log(`done; exiting ${exitCode}`);
  }

  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[replay] unhandled: ${message}`);
    process.exit(1);
  },
);
