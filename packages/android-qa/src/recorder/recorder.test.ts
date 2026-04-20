import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Recorder } from './recorder';
import type { Turn } from './recorder';
import type { SessionState } from '../types';

function makeInitialState(): SessionState {
  return {
    runId: 'run-test',
    appVersion: '1.0.0',
    role: 'driver',
    startedAt: '2026-01-01T00:00:00.000Z',
    budget: { wallClockMs: 60000, turns: 30 },
    counters: { crashCount: 0, noNewScreenStreak: 0, malformedJsonCount: 0 },
    screens: {},
    frontier: [],
    findings: [],
    history: [],
  };
}

describe('Recorder', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'android-qa-recorder-' + randomUUID() + '-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('constructor creates directories and writes session.json', async () => {
    const initialState = makeInitialState();
    new Recorder({ runDir, initialState });

    const sessionPath = join(runDir, 'session.json');
    const screenshotsDir = join(runDir, 'screenshots');
    const findingsDir = join(runDir, 'findings');

    const sessionStat = await stat(sessionPath);
    expect(sessionStat.isFile()).toBe(true);

    const ssStat = await stat(screenshotsDir);
    expect(ssStat.isDirectory()).toBe(true);

    const findingsStat = await stat(findingsDir);
    expect(findingsStat.isDirectory()).toBe(true);

    const parsed = JSON.parse(await readFile(sessionPath, 'utf8')) as SessionState;
    expect(parsed.runId).toBe('run-test');
    expect(parsed.history).toEqual([]);
  });

  it('appendTurn appends entries to history in order', async () => {
    const rec = new Recorder({ runDir, initialState: makeInitialState() });

    const turns: Turn[] = [
      { turn: 1, screenFp: 'aaaa', action: { kind: 'tap', elementId: 'btn-1' }, outcomeFp: 'bbbb', ms: 100 },
      { turn: 2, screenFp: 'bbbb', action: { kind: 'back' }, outcomeFp: 'aaaa', ms: 50 },
      { turn: 3, screenFp: 'aaaa', action: { kind: 'swipe', direction: 'down' }, outcomeFp: null, ms: 25 },
    ];

    for (const t of turns) {
      await rec.appendTurn(t);
    }

    const parsed = JSON.parse(await readFile(join(runDir, 'session.json'), 'utf8')) as SessionState;
    expect(parsed.history).toHaveLength(3);
    expect(parsed.history[0]).toEqual(turns[0]);
    expect(parsed.history[1]).toEqual(turns[1]);
    expect(parsed.history[2]).toEqual(turns[2]);
  });

  it('saveScreenshot writes PNG bytes to turn-NNNN-<phase>.png', async () => {
    const rec = new Recorder({ runDir, initialState: makeInitialState() });
    const bytes = Buffer.from('png-bytes');

    const savedPath = await rec.saveScreenshot(42, 'pre', bytes);

    const expectedPath = join(runDir, 'screenshots', 'turn-0042-pre.png');
    expect(savedPath).toBe(expectedPath);

    const onDisk = await readFile(expectedPath);
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it('updateState shallow-merges patch into session.json', async () => {
    const rec = new Recorder({ runDir, initialState: makeInitialState() });

    await rec.updateState({
      counters: { crashCount: 1, noNewScreenStreak: 0, malformedJsonCount: 0 },
    });

    const parsed = JSON.parse(await readFile(join(runDir, 'session.json'), 'utf8')) as SessionState;
    expect(parsed.counters).toEqual({ crashCount: 1, noNewScreenStreak: 0, malformedJsonCount: 0 });
    // Untouched fields preserved
    expect(parsed.runId).toBe('run-test');
    expect(parsed.budget).toEqual({ wallClockMs: 60000, turns: 30 });
  });

  it('finalize sets endedAt ISO string and status', async () => {
    const rec = new Recorder({ runDir, initialState: makeInitialState() });

    await rec.finalize('completed');

    const parsed = JSON.parse(await readFile(join(runDir, 'session.json'), 'utf8')) as SessionState;
    expect(parsed.status).toBe('completed');
    expect(typeof parsed.endedAt).toBe('string');
    // ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(parsed.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('saveScreenshot supports different phase labels and turn indices', async () => {
    const rec = new Recorder({ runDir, initialState: makeInitialState() });

    const postPath = await rec.saveScreenshot(1, 'post', Buffer.from('post-bytes'));
    expect(postPath).toBe(join(runDir, 'screenshots', 'turn-0001-post.png'));

    const highPath = await rec.saveScreenshot(9999, 'pre', Buffer.from('high-bytes'));
    expect(highPath).toBe(join(runDir, 'screenshots', 'turn-9999-pre.png'));

    expect((await readFile(postPath)).toString()).toBe('post-bytes');
    expect((await readFile(highPath)).toString()).toBe('high-bytes');
  });
});
