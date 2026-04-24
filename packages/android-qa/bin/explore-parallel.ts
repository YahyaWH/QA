/**
 * `android-qa:explore-parallel --n <count> [--role <name>]`
 *
 * Spawn N concurrent `explore` children, each pinned to its own instance
 * index via `ANDROID_QA_INSTANCE_INDEX=0..N-1`. run-explore uses that index to
 * offset every externally-bindable resource (emulator console port, adb
 * serial, Appium port, state shard paths, run directory suffix) so the N
 * instances never collide.
 *
 * After all children have exited we invoke `merge-shards` once, folding the
 * per-run shards back into the canonical `state/app-map.json` and
 * `state/findings-history.jsonl`. Merge runs even when individual instances
 * failed, so partial progress is still captured.
 *
 * Each child's stdout/stderr is teed to `output/android-qa/parallel-<stamp>/
 * instance-<i>.log` so you can inspect per-instance behaviour without having
 * to untangle interleaved output on the terminal. The parent also mirrors a
 * condensed `[i:N]`-prefixed line-per-line view to its own stdout so you can
 * watch progress live.
 *
 * Exit code: 0 only when every instance AND the final merge succeeded.
 * Otherwise 1 — callers (CI, wrapper scripts) should treat partial success as
 * a failure until explicit policy dictates otherwise.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = (msg: string): void => {
  console.log(`[parallel] ${msg}`);
};

interface ParsedArgs {
  n: number;
  role: string | undefined;
  staggerMs: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let n = 3;
  let role: string | undefined;
  let staggerMs = 15_000;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--n' || arg === '--count') {
      n = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--role') {
      role = argv[i + 1];
      i += 1;
    } else if (arg === '--stagger-ms') {
      staggerMs = Number(argv[i + 1]);
      i += 1;
    }
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--n must be a positive integer, got ${argv.join(' ')}`);
  }
  if (!Number.isInteger(staggerMs) || staggerMs < 0) {
    throw new Error(`--stagger-ms must be a non-negative integer, got ${staggerMs}`);
  }
  return { n, role, staggerMs };
}

/** `YYYYMMDD-HHMMSS` UTC — parallel-run log directory name. */
function utcStamp(): string {
  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/** Run output directory (`<repo>/output/android-qa/`). `bin/explore-parallel.ts`
 *  sits three `..` below the repo root. */
function outputDir(): string {
  return fileURLToPath(new URL('../../../output/android-qa', import.meta.url));
}

/** Absolute path to the tsx-runnable `bin/explore.ts` sibling. */
function explorePath(): string {
  return fileURLToPath(new URL('./explore.ts', import.meta.url));
}

/** Absolute path to the tsx-runnable `bin/merge-shards.ts` sibling. */
function mergeShardsPath(): string {
  return fileURLToPath(new URL('./merge-shards.ts', import.meta.url));
}

interface InstanceResult {
  index: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function tee(
  child: ChildProcess,
  label: string,
  logStream: WriteStream,
): Promise<void> {
  const pipeReadable = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WritableStream): Promise<void> =>
    new Promise((resolve) => {
      if (!stream) {
        resolve();
        return;
      }
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line: string) => {
        // Tee raw line to the per-instance log file (preserve original prefix).
        logStream.write(line + '\n');
        // Mirror a condensed view to parent stdout so live progress is visible.
        sink.write(`${label} ${line}\n`);
      });
      rl.on('close', () => resolve());
    });

  return Promise.all([
    pipeReadable(child.stdout, process.stdout),
    pipeReadable(child.stderr, process.stderr),
  ]).then(() => undefined);
}

function spawnInstance(
  index: number,
  role: string | undefined,
  parallelDir: string,
): { done: Promise<InstanceResult>; child: ChildProcess } {
  const label = `[i${index}]`;
  const childArgs = [explorePath()];
  if (role) {
    childArgs.push('--role', role);
  }

  const env = {
    ...process.env,
    ANDROID_QA_INSTANCE_INDEX: String(index),
  };

  const logPath = join(parallelDir, `instance-${index}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(
    `# instance=${index} runner=tsx args=${JSON.stringify(childArgs)} startedAt=${new Date().toISOString()}\n`,
  );

  log(`spawning instance ${index} → ${logPath}`);
  const child = spawn('npx', ['tsx', ...childArgs], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // On Windows, `npx tsx` is a .cmd shim; shell:true lets spawn find it on
    // PATH without requiring an absolute resolve here.
    shell: process.platform === 'win32',
  });

  const teePromise = tee(child, label, logStream);
  const exitPromise: Promise<InstanceResult> = new Promise((resolve) => {
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Force-close stdio pipes after a short grace window. On Windows, an
      // orphaned grandchild (appium node, adb fork-server) that inherited
      // these pipes from the tsx child can hold them open after the child
      // itself exits, which keeps readline from firing `close` and hangs the
      // parent indefinitely. Draining is cheap and the grace window (3s) is
      // plenty for any last-line output to flush before we destroy.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 3_000).unref();
      resolve({ index, exitCode: code, signal });
    });
  });

  const done = Promise.all([teePromise, exitPromise]).then(([, result]) => {
    logStream.end(
      `# instance=${index} exit=${result.exitCode} signal=${result.signal ?? ''} endedAt=${new Date().toISOString()}\n`,
    );
    return result;
  });

  return { done, child };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runMergeShards(parallelDir: string): Promise<number> {
  const logPath = join(parallelDir, 'merge-shards.log');
  const logStream = createWriteStream(logPath, { flags: 'a' });
  log(`running merge-shards → ${logPath}`);

  const child = spawn('npx', ['tsx', mergeShardsPath()], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32',
  });

  const teePromise = tee(child, '[merge]', logStream);
  return new Promise<number>((resolve) => {
    child.once('exit', (code: number | null) => {
      void teePromise.then(() => {
        logStream.end();
        resolve(code ?? 1);
      });
    });
  });
}

async function main(): Promise<number> {
  const { n, role, staggerMs } = parseArgs(process.argv.slice(2));
  const stamp = utcStamp();
  const parallelDir = join(outputDir(), `parallel-${stamp}`);
  mkdirSync(parallelDir, { recursive: true });

  log(`n=${n} role=${role ?? '(inherit)'} staggerMs=${staggerMs} parallelDir=${parallelDir}`);

  // Kick off each child, optionally staggering subsequent instances to spread
  // the cold-boot CPU storm on swiftshader (3-4 threads/emulator on our 16-
  // thread host saturates if N cold-boots hit simultaneously).
  const inFlight: Array<{ done: Promise<InstanceResult>; child: ChildProcess }> = [];
  for (let i = 0; i < n; i += 1) {
    if (i > 0 && staggerMs > 0) {
      log(`staggering ${staggerMs}ms before instance ${i}`);
      await sleep(staggerMs);
    }
    inFlight.push(spawnInstance(i, role, parallelDir));
  }

  // Defensive teardown: a SIGINT on the parent should propagate SIGTERM to
  // every child so its own signal handler can tear down emulator + appium.
  let forwarding = false;
  const forwardSignal = (sig: NodeJS.Signals): void => {
    if (forwarding) return;
    forwarding = true;
    log(`received ${sig}; forwarding SIGTERM to ${inFlight.length} child(ren)`);
    for (const { child } of inFlight) {
      if (!child.killed) {
        try {
          child.kill('SIGTERM');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[parallel] failed to signal child pid=${child.pid ?? '?'}: ${message}`);
        }
      }
    }
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  const results = await Promise.all(inFlight.map(({ done }) => done));
  for (const r of results) {
    log(`instance ${r.index}: exit=${r.exitCode} signal=${r.signal ?? ''}`);
  }

  const okInstances = results.every((r) => r.exitCode === 0);

  // Always merge — even if some children failed, successful shards should
  // still be folded back so their work isn't wasted.
  const mergeCode = await runMergeShards(parallelDir);
  log(`merge-shards exit=${mergeCode}`);

  const overall = okInstances && mergeCode === 0 ? 0 : 1;
  log(`overall exit=${overall}`);
  return overall;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[parallel] unhandled: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  },
);
