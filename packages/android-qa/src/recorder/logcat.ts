import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { stopChild } from '../device/emulator';

/**
 * Parsed logcat line with a normalized epoch-ms timestamp.
 *
 * `ts` is reconstructed from the threadtime prefix `MM-DD HH:MM:SS.mmm` plus
 * the current year at ingestion time. On parse failure we fall back to
 * `Date.now()` so callers always get a monotonic-ish numeric stamp.
 */
export interface LogLine {
  ts: number;
  raw: string;
}

/**
 * Result of scanning a window of log lines for common fatal markers.
 *
 * - `kind: 'crash'` — matched `FATAL EXCEPTION` (JVM crash in app).
 * - `kind: 'anr'`   — matched `ANR in ` (Application Not Responding).
 *
 * `line` is the raw matching log line so callers can attach it to findings.
 */
export interface CrashInfo {
  kind: 'crash' | 'anr';
  line: string;
}

export interface LogcatTailOptions {
  adbPath?: string;
  /**
   * Device serial to scope the `adb logcat` call to (`adb -s <serial> logcat`).
   * Required once more than one emulator is running on the host; optional when
   * only the default emulator is present.
   */
  serial?: string;
  /**
   * Optional injected spawner — used by tests to feed synthetic stdout.
   * Defaults to `child_process.spawn` when omitted.
   */
  spawner?: (cmd: string, args: string[]) => ChildProcess;
}

/**
 * Long-running `adb logcat` tail with in-memory buffering and crash detection.
 *
 * Spawns `adb [-s <serial>] logcat -T 1 -v threadtime`, parses each line's
 * timestamp prefix, and buffers `{ ts, raw }` in memory. Callers ask for
 * deltas since a per-turn start time, scan windows for crashes, or pull
 * excerpts around a center timestamp for report attachments.
 */
export class LogcatTail {
  private readonly adbPath: string;
  private readonly serial: string | undefined;
  private readonly spawner: (cmd: string, args: string[]) => ChildProcess;
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private buffer: LogLine[] = [];

  constructor(opts: LogcatTailOptions = {}) {
    this.adbPath = opts.adbPath ?? 'adb';
    this.serial = opts.serial;
    this.spawner = opts.spawner ?? ((cmd: string, args: string[]): ChildProcess => spawn(cmd, args));
  }

  /**
   * Spawn `adb logcat` and begin buffering parsed lines.
   *
   * Resolves as soon as stdout is bound to a readline reader — callers can
   * start pushing lines into the buffer on the next microtask tick.
   */
  async start(): Promise<void> {
    if (this.child) return;

    const args = this.serial
      ? ['-s', this.serial, 'logcat', '-T', '1', '-v', 'threadtime']
      : ['logcat', '-T', '1', '-v', 'threadtime'];
    const child = this.spawner(this.adbPath, args);
    this.child = child;

    const stdout = child.stdout;
    if (!stdout) {
      throw new Error('LogcatTail: spawned child has no stdout');
    }

    const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    this.rl = rl;

    rl.on('line', (raw: string) => {
      this.buffer.push({ ts: this.parseTimestamp(raw), raw });
    });
  }

  /**
   * Shut down the underlying adb process and release the readline reader.
   *
   * Idempotent — calling `stop()` on a LogcatTail that was never started (or
   * already stopped) resolves immediately.
   */
  async stop(): Promise<void> {
    const child = this.child;
    const rl = this.rl;
    this.child = null;
    this.rl = null;

    if (rl) {
      rl.close();
    }
    if (child) {
      await stopChild(child, `logcat:${child.pid ?? '?'}`);
    }
  }

  /**
   * Return buffered raw lines whose parsed timestamp is strictly greater than
   * `sinceTs`. Order is preserved (buffer is append-only).
   */
  getDelta(sinceTs: number): string[] {
    const out: string[] = [];
    for (const line of this.buffer) {
      if (line.ts > sinceTs) out.push(line.raw);
    }
    return out;
  }

  /**
   * Scan the given raw lines for the first match of either `FATAL EXCEPTION`
   * (→ `crash`) or `ANR in ` (→ `anr`). Returns `null` if neither is found.
   *
   * Does NOT consult the internal buffer — pass in the window you care about.
   */
  detectCrash(lines: string[]): CrashInfo | null {
    for (const line of lines) {
      if (line.includes('FATAL EXCEPTION')) {
        return { kind: 'crash', line };
      }
      if (line.includes('ANR in ')) {
        return { kind: 'anr', line };
      }
    }
    return null;
  }

  /**
   * Return buffered raw lines with parsed timestamp in
   * `[centerTs - windowMs, centerTs + windowMs]` (inclusive both sides).
   */
  excerpt(centerTs: number, windowMs: number): string[] {
    const lo = centerTs - windowMs;
    const hi = centerTs + windowMs;
    const out: string[] = [];
    for (const line of this.buffer) {
      if (line.ts >= lo && line.ts <= hi) out.push(line.raw);
    }
    return out;
  }

  /**
   * Test helper: current size of the in-memory buffer. Exposed so tests can
   * poll for lines having arrived without relying on arbitrary timeouts.
   */
  bufferedCount(): number {
    return this.buffer.length;
  }

  /**
   * Parse a threadtime-prefixed logcat line into an epoch-ms timestamp.
   *
   * Threadtime format: `MM-DD HH:MM:SS.mmm PID TID LEVEL TAG: message`.
   * We reconstruct year from `new Date().getFullYear()` since logcat omits it.
   * Any parse failure (malformed prefix, NaN result) falls back to
   * `Date.now()` so the buffer always has a usable numeric stamp.
   */
  private parseTimestamp(raw: string): number {
    const match = raw.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    if (!match) return Date.now();
    const year = new Date().getFullYear();
    const [, mm, dd, hh, mi, ss, ms] = match;
    const iso = `${year}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}`;
    const parsed = new Date(iso).getTime();
    // new Date('...local...').getTime() returns NaN on invalid strings.
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
}
