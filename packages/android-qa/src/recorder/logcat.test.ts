import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { LogcatTail } from './logcat';

/**
 * Build a fake adb logcat child:
 * - stdout is a pushable Readable the test controls via returned `pushLine`.
 * - stderr is an empty readable.
 * - kill() is a noop that emits 'exit' so stopChild resolves.
 */
function makeFakeSpawner(): {
  spawner: (cmd: string, args: string[]) => ChildProcess;
  pushLine: (line: string) => void;
  endStdout: () => void;
} {
  const stdout = new Readable({ read() {} });
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (child as any).stdout = stdout;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (child as any).stderr = new Readable({ read() {} });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (child as any).exitCode = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (child as any).signalCode = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (child as any).pid = 999;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (child as any).kill = (): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (child as any).exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  };

  const spawner = (_cmd: string, _args: string[]): ChildProcess => child as unknown as ChildProcess;

  return {
    spawner,
    pushLine: (line: string): void => {
      stdout.push(line + '\n');
    },
    endStdout: (): void => {
      stdout.push(null);
    },
  };
}

/**
 * Build a `MM-DD HH:MM:SS.mmm` threadtime prefix for the given epoch-ms value.
 * The LogcatTail parser reconstructs year = current year, so we use the same
 * convention in tests to get matching numeric timestamps back.
 */
function threadtimeLine(tsMs: number, rest: string): string {
  const d = new Date(tsMs);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${mm}-${dd} ${hh}:${mi}:${ss}.${ms}  1234  5678 I TestTag: ${rest}`;
}

/**
 * Wait for N lines to be buffered. Polls on microtask ticks; bails out after
 * `timeoutMs` so a failing assertion points at missing lines rather than
 * hanging the suite.
 */
async function waitForLineCount(
  tail: LogcatTail,
  count: number,
  timeoutMs: number = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tail.bufferedCount() >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('LogcatTail', () => {
  let fake: ReturnType<typeof makeFakeSpawner>;
  let tail: LogcatTail;

  beforeEach(async () => {
    fake = makeFakeSpawner();
    tail = new LogcatTail({ spawner: fake.spawner });
    await tail.start();
  });

  afterEach(async () => {
    await tail.stop();
  });

  it('parses lines and getDelta filters by timestamp', async () => {
    const t0 = new Date('2026-06-15T12:00:00.000Z').getTime();
    const t1 = new Date('2026-06-15T12:00:05.000Z').getTime();
    const t2 = new Date('2026-06-15T12:00:10.000Z').getTime();

    fake.pushLine(threadtimeLine(t0, 'first'));
    fake.pushLine(threadtimeLine(t1, 'second'));
    fake.pushLine(threadtimeLine(t2, 'third'));

    await waitForLineCount(tail, 3);

    const delta = tail.getDelta(t1);
    expect(delta).toHaveLength(1);
    expect(delta[0]).toContain('third');
  });

  it('detectCrash identifies FATAL EXCEPTION', () => {
    const lines = [
      '06-15 12:00:00.000  1 1 I Tag: boring',
      '06-15 12:00:01.000  1 1 E AndroidRuntime: FATAL EXCEPTION: main',
      '06-15 12:00:02.000  1 1 I Tag: after',
    ];
    const result = tail.detectCrash(lines);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('crash');
    expect(result?.line).toContain('FATAL EXCEPTION');
  });

  it('detectCrash identifies ANR', () => {
    const lines = [
      '06-15 12:00:00.000  1 1 I Tag: boring',
      '06-15 12:00:01.000  1 1 E ActivityManager: ANR in com.wastehero (com.wastehero/.MainActivity)',
    ];
    const result = tail.detectCrash(lines);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('anr');
    expect(result?.line).toContain('ANR in com.wastehero');
  });

  it('detectCrash returns null when no crash markers present', () => {
    const lines = [
      '06-15 12:00:00.000  1 1 I Tag: normal',
      '06-15 12:00:01.000  1 1 D Tag: debug',
      '06-15 12:00:02.000  1 1 W Tag: warning but not fatal',
    ];
    expect(tail.detectCrash(lines)).toBeNull();
  });

  it('excerpt filters lines to a window centered on centerTs', async () => {
    const center = new Date('2026-06-15T12:00:05.000Z').getTime();
    const lines: Array<{ ts: number; payload: string }> = [
      { ts: center - 4_000, payload: 'too-early' },
      { ts: center - 1_500, payload: 'within-before' },
      { ts: center, payload: 'center' },
      { ts: center + 1_500, payload: 'within-after' },
      { ts: center + 4_000, payload: 'too-late' },
    ];

    for (const l of lines) {
      fake.pushLine(threadtimeLine(l.ts, l.payload));
    }

    await waitForLineCount(tail, 5);

    const window = tail.excerpt(center, 2_000);
    expect(window).toHaveLength(3);
    expect(window[0]).toContain('within-before');
    expect(window[1]).toContain('center');
    expect(window[2]).toContain('within-after');
  });
});
