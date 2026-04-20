import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stopChild } from '../device/emulator';

const execFileAsync = promisify(execFile);

export interface VideoRecorderOptions {
  adbPath?: string;
  /** Path to the `ffmpeg` binary. Defaults to `'ffmpeg'` (on PATH). */
  ffmpegPath?: string;
  /** Per-segment cap in ms. `adb screenrecord` enforces a 180s limit. */
  segmentMs?: number;
  /** Target video bit rate for `adb screenrecord --bit-rate`. */
  bitRate?: number;
  /** Path prefix used on-device for segment files (e.g. `/sdcard/run`). */
  remotePathPrefix?: string;
}

/**
 * Chained `adb shell screenrecord` recorder that stitches segments into a
 * single `video.mp4` at `stop()` time.
 *
 * `adb screenrecord` caps each run at 180s, so `start()` spawns a background
 * loop that chains `run-0.mp4`, `run-1.mp4`, ... sequentially. `stop()` kills
 * the current segment, waits for the loop to exit, pulls all segment files
 * off-device, and concatenates them via `ffmpeg -f concat ... -c copy`.
 *
 * If `ffmpeg` is missing we warn and leave the individual segment files in
 * the run directory instead of throwing.
 */
export class VideoRecorder {
  private readonly adbPath: string;
  private readonly ffmpegPath: string;
  private readonly segmentMs: number;
  private readonly bitRate: number;
  private readonly remotePathPrefix: string;

  private runDir: string | null = null;
  private currentChild: ChildProcess | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopping: boolean = false;
  private segmentCount: number = 0;
  private ffmpegAvailable: boolean | null = null;

  constructor(opts: VideoRecorderOptions = {}) {
    this.adbPath = opts.adbPath ?? 'adb';
    this.ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
    this.segmentMs = opts.segmentMs ?? 180_000;
    this.bitRate = opts.bitRate ?? 4_000_000;
    this.remotePathPrefix = opts.remotePathPrefix ?? '/sdcard/run';
  }

  /**
   * Start the segment chain. Resolves after the first segment has been
   * spawned — subsequent segments start automatically as the previous one
   * hits its cap or `stop()` is invoked.
   */
  async start(runDir: string): Promise<void> {
    if (this.loopPromise) {
      throw new Error('VideoRecorder: already started');
    }
    this.runDir = runDir;
    this.stopping = false;
    this.segmentCount = 0;

    // Kick off the first segment synchronously so the loop is guaranteed to
    // have a live child before `start()` resolves.
    this.spawnSegment(0);
    this.loopPromise = this.runLoop();
  }

  /**
   * Stop recording, pull all segment files, and (if ffmpeg is available)
   * concatenate into `${runDir}/video.mp4`. Always resolves — any errors
   * during pull/concat are logged rather than thrown.
   */
  async stop(): Promise<void> {
    if (!this.loopPromise) return;
    this.stopping = true;

    const child = this.currentChild;
    if (child) {
      await stopChild(child, `screenrecord:${child.pid ?? '?'}`);
    }

    try {
      await this.loopPromise;
    } catch (err) {
      console.error(`[video] loop exited with error: ${String(err)}`);
    }
    this.loopPromise = null;

    if (!this.runDir) return;
    const runDir = this.runDir;

    // Pull each segment to disk before attempting concat.
    const localSegments: string[] = [];
    for (let i = 0; i < this.segmentCount; i++) {
      const remote = `${this.remotePathPrefix}-${i}.mp4`;
      const local = join(runDir, `segment-${i}.mp4`);
      try {
        await execFileAsync(this.adbPath, ['pull', remote, local]);
        localSegments.push(local);
      } catch (err) {
        console.error(`[video] adb pull ${remote} failed: ${String(err)}`);
      }
    }

    if (localSegments.length === 0) {
      console.error('[video] no segments pulled; skipping concat');
      return;
    }

    const available = await this.checkFfmpeg();
    if (!available) {
      console.warn(
        `[video] ffmpeg not available; leaving ${localSegments.length} segment(s) in ${runDir}`,
      );
      return;
    }

    const listPath = join(runDir, 'segments.txt');
    // Concat demuxer expects `file 'path'` lines; backslashes on Windows are
    // tolerated but forward slashes are safer.
    const listBody = localSegments
      .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    await writeFile(listPath, listBody, 'utf8');

    const outPath = join(runDir, 'video.mp4');
    try {
      await execFileAsync(this.ffmpegPath, [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        outPath,
      ]);
    } catch (err) {
      console.error(`[video] ffmpeg concat failed: ${String(err)}`);
    }
  }

  /**
   * Trim `[startMs, endMs]` out of `srcPath` into `outPath` using
   * `ffmpeg -ss ... -to ... -c copy`. No-op (logs warn + resolves) when
   * ffmpeg isn't on PATH, so callers don't need to guard each invocation.
   */
  async clip(srcPath: string, startMs: number, endMs: number, outPath: string): Promise<void> {
    const available = await this.checkFfmpeg();
    if (!available) {
      console.warn(`[video] ffmpeg not available; skipping clip to ${outPath}`);
      return;
    }

    const startSec = (startMs / 1000).toFixed(3);
    const endSec = (endMs / 1000).toFixed(3);

    try {
      await execFileAsync(this.ffmpegPath, [
        '-y',
        '-ss',
        startSec,
        '-to',
        endSec,
        '-i',
        srcPath,
        '-c',
        'copy',
        outPath,
      ]);
    } catch (err) {
      console.error(`[video] ffmpeg clip failed: ${String(err)}`);
    }
  }

  private async runLoop(): Promise<void> {
    // First segment was already spawned by start(). Wait for each segment to
    // exit, then (if not stopping) spawn the next one.
    while (this.currentChild && !this.stopping) {
      const child = this.currentChild;
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        child.once('exit', done);
      });

      if (this.stopping) break;

      // Previous segment finished naturally (hit the 180s cap). Chain the next.
      this.spawnSegment(this.segmentCount);
    }
    this.currentChild = null;
  }

  private spawnSegment(index: number): void {
    const remote = `${this.remotePathPrefix}-${index}.mp4`;
    // adb screenrecord takes --time-limit in seconds; default 180s cap.
    const timeLimitSec = Math.floor(this.segmentMs / 1000);

    const args = [
      'shell',
      'screenrecord',
      '--bit-rate',
      String(this.bitRate),
      '--time-limit',
      String(timeLimitSec),
      remote,
    ];

    console.log(`[video] spawning segment ${index}: ${this.adbPath} ${args.join(' ')}`);
    const child = spawn(this.adbPath, args, { stdio: 'ignore', windowsHide: true });
    this.currentChild = child;
    this.segmentCount = index + 1;
  }

  private async checkFfmpeg(): Promise<boolean> {
    if (this.ffmpegAvailable !== null) return this.ffmpegAvailable;
    try {
      await execFileAsync(this.ffmpegPath, ['-version']);
      this.ffmpegAvailable = true;
    } catch (err) {
      // ENOENT → ffmpeg not on PATH. Anything else is also treated as "not
      // usable" for our purposes — we never want to throw out of clip/stop.
      console.warn(`[video] ffmpeg check failed: ${String(err)}`);
      this.ffmpegAvailable = false;
    }
    return this.ffmpegAvailable;
  }
}
