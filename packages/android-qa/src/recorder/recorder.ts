import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionState, RunStatus } from '../types';

export interface RecorderOptions {
  runDir: string;
  initialState: SessionState;
}

export interface Turn {
  turn: number;
  screenFp: string;
  action: SessionState['history'][number]['action'];
  outcomeFp: string | null;
  ms: number;
}

export class Recorder {
  private readonly runDir: string;
  private readonly sessionPath: string;
  private readonly screenshotsDir: string;
  private readonly findingsDir: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: RecorderOptions) {
    this.runDir = opts.runDir;
    this.sessionPath = join(this.runDir, 'session.json');
    this.screenshotsDir = join(this.runDir, 'screenshots');
    this.findingsDir = join(this.runDir, 'findings');

    mkdirSync(this.runDir, { recursive: true });
    mkdirSync(this.screenshotsDir, { recursive: true });
    mkdirSync(this.findingsDir, { recursive: true });

    writeFileSync(this.sessionPath, JSON.stringify(opts.initialState, null, 2), 'utf8');
  }

  async appendTurn(turn: Turn): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readState();
      current.history.push(turn);
      await this.atomicWriteState(current);
    });
  }

  /**
   * Persist a screenshot as `turn-NNNN-<phase>.png` under `screenshots/`.
   *
   * @remarks Overwrites existing file at same (turnIdx, phase).
   */
  async saveScreenshot(turnIdx: number, phase: string, buf: Buffer): Promise<string> {
    const name = `turn-${turnIdx.toString().padStart(4, '0')}-${phase}.png`;
    const target = join(this.screenshotsDir, name);
    await writeFile(target, buf);
    return target;
  }

  /**
   * Merge a patch into the persisted session state.
   *
   * @remarks Shallow merge only — pass full nested objects (e.g. full counters),
   * since nested keys are replaced wholesale.
   */
  async updateState(patch: Partial<SessionState>): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readState();
      const merged: SessionState = { ...current, ...patch };
      await this.atomicWriteState(merged);
    });
  }

  async finalize(status: RunStatus): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readState();
      const merged: SessionState = { ...current, endedAt: new Date().toISOString(), status };
      await this.atomicWriteState(merged);
    });
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    // Chain onto the queue; run even if a prior op rejected.
    const chained = this.writeQueue.then(op, op);
    // The queue itself should never reject — swallow so subsequent ops still run.
    this.writeQueue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private async readState(): Promise<SessionState> {
    const raw = await readFile(this.sessionPath, 'utf8');
    return JSON.parse(raw) as SessionState;
  }

  private async atomicWriteState(state: SessionState): Promise<void> {
    const tmp = this.sessionPath + '.tmp';
    const json = JSON.stringify(state, null, 2);
    try {
      // Open tmp, write contents, fsync, close — so the bytes are durable on
      // disk BEFORE the rename publishes them as session.json.
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(json, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.sessionPath);
    } catch (err) {
      // Best-effort cleanup so we don't leak .tmp files across runs.
      await unlink(tmp).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to write ${this.sessionPath}: ${message}`, { cause: err });
    }
  }
}
