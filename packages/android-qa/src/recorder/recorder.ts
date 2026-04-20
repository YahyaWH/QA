import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, rename, open } from 'node:fs/promises';
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
    const current = await this.readState();
    current.history.push(turn);
    await this.atomicWriteState(current);
  }

  async saveScreenshot(turnIdx: number, phase: string, buf: Buffer): Promise<string> {
    const name = `turn-${turnIdx.toString().padStart(4, '0')}-${phase}.png`;
    const target = join(this.screenshotsDir, name);
    await writeFile(target, buf);
    return target;
  }

  async updateState(patch: Partial<SessionState>): Promise<void> {
    const current = await this.readState();
    const merged: SessionState = { ...current, ...patch };
    await this.atomicWriteState(merged);
  }

  async finalize(status: RunStatus): Promise<void> {
    await this.updateState({ endedAt: new Date().toISOString(), status });
  }

  private async readState(): Promise<SessionState> {
    const raw = await readFile(this.sessionPath, 'utf8');
    return JSON.parse(raw) as SessionState;
  }

  private async atomicWriteState(state: SessionState): Promise<void> {
    const tmp = this.sessionPath + '.tmp';
    const json = JSON.stringify(state, null, 2);
    await writeFile(tmp, json, 'utf8');
    await rename(tmp, this.sessionPath);
    const handle = await open(this.sessionPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
