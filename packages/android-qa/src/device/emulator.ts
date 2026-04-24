import { spawn, execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

const execFileAsync = promisify(execFile);

/** Default console port used by `emulator` when `-port` is not passed. */
export const DEFAULT_EMULATOR_CONSOLE_PORT = 5554;

/**
 * Handle to a running Android emulator process.
 *
 * `pid` is the OS process id of the `emulator` binary. `serial` is the adb
 * device identifier (`emulator-<console_port>`) every subsequent adb command
 * must target, which matters once we run more than one emulator on the box.
 * `stop()` terminates it idempotently and sweeps the whole descendant tree.
 */
export interface EmulatorHandle {
  pid: number;
  serial: string;
  consolePort: number;
  stop(): Promise<void>;
}

/**
 * Inputs to `startEmulator`. `avdName` + `sdkRoot` are required; everything
 * else is opt-in for multi-instance parallel runs.
 */
export interface EmulatorSpec {
  avdName: string;
  sdkRoot: string;
  /**
   * Emulator console port. adb port is always `consolePort + 1` and the
   * resulting device serial is `emulator-${consolePort}`. Pass distinct ports
   * (5554, 5556, 5558, …) when running multiple concurrent emulators.
   */
  consolePort?: number;
  /**
   * Boot the AVD in `-read-only` mode so multiple instances can share the same
   * base image without userdata write contention. Intended for parallel runs
   * where every instance wipe-installs the APK after boot anyway.
   */
  readOnly?: boolean;
}

/**
 * Spawn `$sdkRoot/emulator/emulator -avd <avd> -no-snapshot-save -no-boot-anim`
 * with optional `-port`, `-read-only`, `-gpu`, and `-no-window -no-audio` flags.
 *
 * Returns once the child process has a pid — does NOT wait for boot. Call
 * `waitForBoot(handle.serial)` afterwards to block until the emulator answers
 * adb.
 *
 * Env-var overrides (both optional):
 *   ANDROID_EMULATOR_GPU       — passed through as `-gpu <value>`. Common
 *                                values: `host`, `swiftshader_indirect`,
 *                                `angle_indirect`. Leave unset to let the
 *                                emulator auto-select. On Win11 + AMD iGPU
 *                                only `swiftshader_indirect` boots reliably.
 *   ANDROID_EMULATOR_NO_WINDOW — `1` adds `-no-window -no-audio`. Use for
 *                                headless agent runs / CI.
 */
export async function startEmulator(spec: EmulatorSpec): Promise<EmulatorHandle> {
  const { avdName, sdkRoot } = spec;
  const consolePort = spec.consolePort ?? DEFAULT_EMULATOR_CONSOLE_PORT;

  const emulatorBin =
    process.platform === 'win32'
      ? path.join(sdkRoot, 'emulator', 'emulator.exe')
      : path.join(sdkRoot, 'emulator', 'emulator');

  const args = [
    '-avd',
    avdName,
    '-port',
    String(consolePort),
    '-no-snapshot-save',
    '-no-boot-anim',
  ];
  if (spec.readOnly) {
    args.push('-read-only');
  }
  const gpu = process.env.ANDROID_EMULATOR_GPU;
  if (gpu) {
    args.push('-gpu', gpu);
  }
  if (process.env.ANDROID_EMULATOR_NO_WINDOW === '1') {
    args.push('-no-window', '-no-audio');
  }
  // Headed mode on Windows: qemu-system-x86_64.exe dynamically links Qt6*AndroidEmu.dll
  // which lives in `<sdkRoot>/emulator/lib64/qt/lib`, a directory the launcher binary
  // does NOT add to the child process's DLL search path. Without this shim, spawn
  // fails with `LoadLibrary error 126` / "Qt6SvgAndroidEmu.dll: cannot open shared
  // object file". Prepending the qt/lib dir to PATH is enough — Windows LoadLibrary
  // honours it before falling back to the app-local search path.
  const qtLibDir = path.join(sdkRoot, 'emulator', 'lib64', 'qt', 'lib');
  const spawnEnv = { ...process.env, PATH: `${qtLibDir}${path.delimiter}${process.env.PATH ?? ''}` };
  const serial = `emulator-${consolePort}`;
  console.log(`[emulator:${serial}] spawning ${emulatorBin} ${args.join(' ')}`);
  const child = spawn(emulatorBin, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    env: spawnEnv,
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
  console.log(`[emulator:${serial}] pid=${pid}`);

  return {
    pid,
    serial,
    consolePort,
    stop: async () => {
      // Graceful shutdown first — `adb emu kill` tells the emulator console to
      // shut qemu down cleanly. This is important on Windows where the grand-
      // child `qemu-system-x86_64-headless.exe` routinely escapes taskkill /T
      // (it re-parents out of the emulator.exe launcher's tree), leaving a
      // zombie bound to the console/adb ports for the next run. A graceful
      // kill avoids needing to chase the grandchild at all.
      await adbEmuKill(serial).catch((err) => {
        console.error(`[emulator:${serial}] adb emu kill failed: ${String(err)}`);
      });
      await stopChild(child, `emulator:${serial}:${pid}`);
    },
  };
}

/**
 * Ask the emulator console to terminate itself: `adb -s <serial> emu kill`.
 *
 * This is the supported way to shut down an Android emulator. When it
 * succeeds the qemu process exits on its own within a few seconds, so the
 * subsequent `stopChild` only has to mop up the emulator.exe launcher.
 *
 * Throws if adb itself is missing or the serial can't be reached; callers
 * should treat those as soft failures and fall back to tree-kill.
 */
async function adbEmuKill(serial: string): Promise<void> {
  await execFileAsync('adb', ['-s', serial, 'emu', 'kill']);
}

/**
 * Block until `adb -s <serial> shell getprop sys.boot_completed` returns `"1"`.
 *
 * Polls every 2 seconds; throws if the emulator hasn't booted within
 * `timeoutMs` (default 120s). Transient adb errors (device offline, no
 * devices yet) are swallowed and retried — only the final timeout surfaces.
 */
export async function waitForBoot(serial: string, timeoutMs: number = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('adb', [
        '-s',
        serial,
        'shell',
        'getprop',
        'sys.boot_completed',
      ]);
      if (stdout.trim() === '1') {
        console.log(`[emulator:${serial}] boot completed`);
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await delay(2_000);
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`waitForBoot(${serial}): emulator did not boot within ${timeoutMs}ms${suffix}`);
}

/**
 * Run `adb -s <serial> install -r <apkPath>`. Re-installs on top of any
 * existing package. Propagates any non-zero exit as a thrown error.
 */
export async function installApk(apkPath: string, serial: string): Promise<void> {
  console.log(`[emulator:${serial}] installing ${apkPath}`);
  await execFileAsync('adb', ['-s', serial, 'install', '-r', apkPath]);
  console.log(`[emulator:${serial}] install complete`);
}

/**
 * Return the APK's `versionName` by parsing `aapt dump badging <apkPath>`.
 *
 * `aapt` is resolved from `$sdkRoot/build-tools/<highest-version>/aapt[.exe]`
 * because the SDK does not put it on PATH by default. Falls back to the
 * `aapt` on PATH only when the build-tools lookup fails.
 *
 * Looks for a `versionName='...'` token in stdout. Throws if the token is
 * missing (malformed APK, wrong tool, etc.).
 */
export async function extractApkVersion(apkPath: string, sdkRoot?: string): Promise<string> {
  const aapt = sdkRoot ? (resolveAapt(sdkRoot) ?? 'aapt') : 'aapt';
  const { stdout } = await execFileAsync(aapt, ['dump', 'badging', apkPath]);
  const match = stdout.match(/versionName='([^']+)'/);
  if (!match) {
    throw new Error(`extractApkVersion: no versionName found in aapt output for ${apkPath}`);
  }
  return match[1] as string;
}

function resolveAapt(sdkRoot: string): string | null {
  const buildToolsDir = path.join(sdkRoot, 'build-tools');
  let versions: string[];
  try {
    versions = readdirSync(buildToolsDir);
  } catch {
    return null;
  }
  if (versions.length === 0) {
    return null;
  }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const bin = process.platform === 'win32' ? 'aapt.exe' : 'aapt';
  return path.join(buildToolsDir, versions[0] as string, bin);
}

/**
 * Shared shutdown used by both the emulator and appium handles. Kills the
 * child and every descendant it spawned — not just the top-level process.
 *
 * Why the full tree: on Windows the launcher binaries we use (`emulator.exe`,
 * `appium.cmd`) spawn long-lived grandchildren (`qemu-system-x86_64-headless`,
 * a `node` subprocess) that `child.kill()` cannot reach. Killing the parent
 * alone orphans them and the next run fails with EADDRINUSE / device-busy.
 *
 * Strategy:
 *   - win32: `taskkill /T /F /PID <pid>` walks the tree (`/T`) and force-kills
 *            (`/F`) every process. Exit code 128 ("process not found") is
 *            treated as already-gone.
 *   - posix: SIGTERM on the child, wait up to 5s, then SIGKILL if still alive.
 *            Process groups aren't used here because we spawn with
 *            `detached: false`; direct SIGTERM is sufficient for our binaries.
 *
 * Resolves immediately if the child has already exited.
 */
export async function stopChild(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (child.pid === undefined) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  if (process.platform === 'win32') {
    // child.kill() terminates the root (and triggers any test-mock exit hooks);
    // taskkill /T sweeps grandchildren that child.kill cannot reach.
    try {
      child.kill();
    } catch (err) {
      console.error(`[${label}] child.kill failed: ${String(err)}`);
    }
    await killTreeWindows(child.pid, label);
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      exited.then(() => 'exited' as const),
      delay(5_000, timedOut),
    ]);
    if (result === timedOut) {
      console.error(`[${label}] child never emitted exit after tree kill; continuing`);
    }
    console.log(`[${label}] stopped`);
    return;
  }

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

async function killTreeWindows(pid: number, label: string): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/T', '/F', '/PID', String(pid)]);
  } catch (err) {
    // taskkill exits 128 when the pid is already gone. Anything else is real.
    const code = (err as { code?: number } | null)?.code;
    if (code === 128) {
      return;
    }
    console.error(`[${label}] taskkill /T /F /PID ${pid} failed: ${String(err)}`);
  }
}
