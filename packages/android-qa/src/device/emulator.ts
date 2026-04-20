import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

const execFileAsync = promisify(execFile);

/**
 * Handle to a running Android emulator process.
 *
 * `pid` is the OS process id of the `emulator` binary. `stop()` terminates it
 * idempotently: sends `SIGTERM`, waits up to 5s for graceful exit, then
 * escalates to `SIGKILL`. On Windows `SIGTERM` is effectively a forced kill, so
 * the escalation is mostly a safety net.
 */
export interface EmulatorHandle {
  pid: number;
  stop(): Promise<void>;
}

/**
 * Spawn `$sdkRoot/emulator/emulator -avd <avdName> -no-snapshot-save -no-boot-anim`.
 *
 * Returns once the child process has a pid — does NOT wait for boot. Call
 * `waitForBoot()` afterwards to block until the emulator is ready for adb.
 *
 * The child is spawned detached: false, stdio: 'ignore' so it lives for exactly
 * as long as the parent keeps the handle around. If the child exits on its own
 * (e.g. bad AVD name) the `stop()` method becomes a no-op.
 */
export async function startEmulator(avdName: string, sdkRoot: string): Promise<EmulatorHandle> {
  const emulatorBin =
    process.platform === 'win32'
      ? path.join(sdkRoot, 'emulator', 'emulator.exe')
      : path.join(sdkRoot, 'emulator', 'emulator');

  const args = ['-avd', avdName, '-no-snapshot-save', '-no-boot-anim'];
  console.log(`[emulator] spawning ${emulatorBin} ${args.join(' ')}`);
  const child = spawn(emulatorBin, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  if (child.pid === undefined) {
    await new Promise<void>((resolve) => {
      child.once('spawn', () => resolve());
      child.once('error', () => resolve());
    });
  }

  if (child.pid === undefined) {
    throw new Error(`startEmulator: failed to spawn ${emulatorBin}`);
  }

  const pid = child.pid;
  console.log(`[emulator] pid=${pid}`);

  return {
    pid,
    stop: () => stopChild(child, `emulator:${pid}`),
  };
}

/**
 * Block until `adb shell getprop sys.boot_completed` returns `"1"`.
 *
 * Polls every 2 seconds; throws if the emulator hasn't booted within
 * `timeoutMs` (default 120s). Transient adb errors (device offline, no
 * devices yet) are swallowed and retried — only the final timeout surfaces.
 */
export async function waitForBoot(timeoutMs: number = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('adb', ['shell', 'getprop', 'sys.boot_completed']);
      if (stdout.trim() === '1') {
        console.log('[emulator] boot completed');
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await delay(2_000);
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`waitForBoot: emulator did not boot within ${timeoutMs}ms${suffix}`);
}

/**
 * Run `adb install -r <apkPath>`. Re-installs on top of any existing package.
 * Propagates any non-zero exit as a thrown error.
 */
export async function installApk(apkPath: string): Promise<void> {
  console.log(`[emulator] installing ${apkPath}`);
  await execFileAsync('adb', ['install', '-r', apkPath]);
  console.log('[emulator] install complete');
}

/**
 * Return the APK's `versionName` by parsing `aapt dump badging <apkPath>`.
 *
 * Looks for a `versionName='...'` token in stdout. Throws if the token is
 * missing (malformed APK, wrong tool on PATH, etc.).
 */
export async function extractApkVersion(apkPath: string): Promise<string> {
  const { stdout } = await execFileAsync('aapt', ['dump', 'badging', apkPath]);
  const match = stdout.match(/versionName='([^']+)'/);
  if (!match) {
    throw new Error(`extractApkVersion: no versionName found in aapt output for ${apkPath}`);
  }
  return match[1] as string;
}

/**
 * Shared SIGTERM-then-SIGKILL shutdown used by both the emulator and appium handles.
 *
 * Resolves immediately if the child has already exited. Otherwise sends
 * `SIGTERM`, waits up to 5s for the `exit` event, then escalates to `SIGKILL`
 * and waits for exit.
 */
export async function stopChild(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  try {
    child.kill('SIGTERM');
  } catch (err) {
    console.error(`[${label}] SIGTERM failed: ${String(err)}`);
  }

  const timedOut = Symbol('timeout');
  const result = await Promise.race([exited.then(() => 'exited' as const), delay(5_000, timedOut)]);

  if (result === timedOut) {
    console.error(`[${label}] SIGTERM timed out after 5s, escalating to SIGKILL`);
    try {
      child.kill('SIGKILL');
    } catch (err) {
      console.error(`[${label}] SIGKILL failed: ${String(err)}`);
    }
    await exited;
  }

  console.log(`[${label}] stopped`);
}
