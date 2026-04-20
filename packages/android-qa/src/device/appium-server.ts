import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { stopChild } from './emulator';

/**
 * Handle to a running Appium server child process.
 *
 * `pid` is the OS process id of the `appium` binary (or `appium.cmd` wrapper
 * on Windows). `stop()` terminates it the same way as `EmulatorHandle.stop`:
 * SIGTERM, then SIGKILL after 5s if it hasn't exited.
 */
export interface AppiumServerHandle {
  pid: number;
  stop(): Promise<void>;
}

/**
 * Spawn a local Appium server and wait for it to answer `/status`.
 *
 * The binary is resolved from `./node_modules/.bin/appium` relative to
 * `process.cwd()` — that's `packages/android-qa` in production use; tests that
 * want to avoid a real spawn should stub this module. On Windows we pick the
 * `.cmd` shim so `spawn` works without `shell: true` (which would hide the
 * real pid behind a cmd.exe wrapper).
 *
 * Polling: GET `http://<host>:<port>/status` every 1s until HTTP 2xx or 30s.
 * Connection-refused during startup is expected and treated as "not ready".
 */
export async function startAppium(host: string, port: number): Promise<AppiumServerHandle> {
  const binName = process.platform === 'win32' ? 'appium.cmd' : 'appium';
  const binPath = path.resolve(process.cwd(), 'node_modules', '.bin', binName);

  const args = [
    '--address',
    host,
    '--port',
    String(port),
    '--log-no-colors',
    '--log-level',
    'warn',
  ];
  console.log(`[appium] spawning ${binPath} ${args.join(' ')}`);

  const child = spawn(binPath, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });

  if (child.pid === undefined) {
    await new Promise<void>((resolve) => {
      child.once('spawn', () => resolve());
      child.once('error', () => resolve());
    });
  }

  if (child.pid === undefined) {
    throw new Error(`startAppium: failed to spawn ${binPath}`);
  }

  const pid = child.pid;
  const label = `appium:${pid}`;
  console.log(`[appium] pid=${pid}`);

  const statusUrl = `http://${host}:${port}/status`;
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `startAppium: process exited before ${statusUrl} responded ` +
          `(code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }
    try {
      const response = await fetch(statusUrl);
      if (response.ok) {
        console.log(`[appium] ${statusUrl} ready`);
        return {
          pid,
          stop: () => stopChild(child, label),
        };
      }
    } catch (err) {
      lastError = err;
    }
    await delay(1_000);
  }

  // Timed out: clean up the child before throwing.
  await stopChild(child, label);
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`startAppium: ${statusUrl} did not respond within 30s${suffix}`);
}
