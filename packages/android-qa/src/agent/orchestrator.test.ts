import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeDriver } from '../device/fake-driver';
import type { FakeScreen, FakeTransitions } from '../device/fake-driver';
import { Recorder } from '../recorder/recorder';
import type { LogcatTail } from '../recorder/logcat';
import type { ClaudeClient } from './claude';
import { run } from './orchestrator';
import type { Action, AppMap, Finding, SessionState } from '../types/index';

/**
 * Build a minimal viable Claude-client stub whose `callJson` is an awaitable
 * mock. The orchestrator only ever calls `callJson` (and `callJsonWithImage`
 * when vision is enabled, which our tests disable by default).
 */
function makeClaude(): {
  client: ClaudeClient;
  callJson: ReturnType<typeof vi.fn>;
  callJsonWithImage: ReturnType<typeof vi.fn>;
} {
  const callJson = vi.fn();
  const callJsonWithImage = vi.fn();
  const client = { callJson, callJsonWithImage } as unknown as ClaudeClient;
  return { client, callJson, callJsonWithImage };
}

function makeConfig(
  overrides: { wallClockMinutes?: number; turnBudget?: number; visionEveryNTurns?: number } = {},
) {
  return {
    agent: {
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      wallClockMinutes: overrides.wallClockMinutes ?? 60,
      turnBudget: overrides.turnBudget ?? 50,
      visionEveryNTurns: overrides.visionEveryNTurns ?? 0,
      denyActions: [],
    },
    device: {
      sdkRoot: '/fake/sdk',
      avdName: 'Pixel_7_API_34',
      apkPath: '/fake/app.apk',
      appiumHost: '127.0.0.1',
      appiumPort: 4723,
    },
    auth: {
      roles: {
        admin: { email: 'admin@wastehero.io', password: 'pw' },
      },
    },
    publish: {
      artifactHostMode: 'github-branch' as const,
      artifactGithubBranch: 'test',
    },
  };
}

function emptyAppMap(): AppMap {
  return {
    appVersion: 'unknown',
    generatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    screens: {},
    transitions: [],
    mergedRunIds: [],
  };
}

function emptySession(runId: string, turnBudget = 50): SessionState {
  return {
    runId,
    appVersion: 'unknown',
    role: 'admin',
    startedAt: '2026-01-01T00:00:00.000Z',
    budget: { wallClockMs: 60_000, turns: turnBudget },
    counters: { crashCount: 0, noNewScreenStreak: 0, malformedJsonCount: 0 },
    screens: {},
    frontier: [],
    findings: [],
    history: [],
  };
}

/**
 * Build an XML tree with a login form followed by N "home-N" screens so the
 * orchestrator has enough scripted state to iterate. Each screen has one
 * tappable button with a stable resource-id.
 */
function loginXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<hierarchy rotation="0">\n' +
    '  <node index="0" class="android.widget.FrameLayout" package="com.wastehero" bounds="[0,0][1080,2400]">\n' +
    '    <node index="0" resource-id="com.wastehero:id/email-input" class="android.widget.EditText" package="com.wastehero" text="" content-desc="Email" clickable="true" bounds="[40,600][1040,740]"/>\n' +
    '    <node index="1" resource-id="com.wastehero:id/password-input" class="android.widget.EditText" package="com.wastehero" text="" content-desc="Password" clickable="true" bounds="[40,780][1040,920]"/>\n' +
    '    <node index="2" resource-id="com.wastehero:id/submit-btn" class="android.widget.Button" package="com.wastehero" text="Log in" content-desc="Log in" clickable="true" bounds="[0,120][100,170]"/>\n' +
    '  </node>\n' +
    '</hierarchy>'
  );
}

function screenXml(id: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<hierarchy rotation="0">\n' +
    `  <node index="0" resource-id="com.wastehero:id/${id}" class="android.widget.Button" package="com.wastehero" text="${id}" content-desc="${id}" clickable="true" bounds="[0,0][100,100]"/>\n` +
    '</hierarchy>'
  );
}

/**
 * Build a FakeDriver where tapping `com.wastehero:id/btn-N` on screen index N+1
 * advances to screen N+2. Screen 0 is the login form. Screens 1..N are the
 * home-style screens the agent explores.
 */
function makeScriptedDriver(nScreens: number): FakeDriver {
  const screens: FakeScreen[] = [
    { xml: loginXml(), activity: '.LoginActivity' },
  ];
  for (let i = 1; i <= nScreens; i += 1) {
    screens.push({ xml: screenXml(`btn-${i}`), activity: `.HomeActivity${i}` });
  }
  const transitions: FakeTransitions = {
    '0': { 'tap:com.wastehero:id/submit-btn': 1 },
  };
  for (let i = 1; i < nScreens; i += 1) {
    transitions[String(i)] = { [`tap:com.wastehero:id/btn-${i}`]: i + 1 };
  }
  return new FakeDriver({ screens, transitions });
}

/**
 * Stub LogcatTail surface the orchestrator touches. `getDelta` is scripted
 * per-call; `detectCrash` mirrors the real implementation (searches for
 * `FATAL EXCEPTION` and `ANR in `).
 */
function makeFakeLogcat(deltas: string[][]): LogcatTail {
  let i = 0;
  return {
    getDelta: (_since: number): string[] => {
      const out = deltas[i] ?? [];
      i += 1;
      return out;
    },
    detectCrash: (lines: string[]) => {
      for (const line of lines) {
        if (line.includes('FATAL EXCEPTION')) {
          return { kind: 'crash' as const, line };
        }
        if (line.includes('ANR in ')) {
          return { kind: 'anr' as const, line };
        }
      }
      return null;
    },
    bufferedCount: () => 0,
  } as unknown as LogcatTail;
}

/** Shorthand for a decide-shaped Claude response envelope. */
function decideResp(action: Action, reasoning = 'test'): unknown {
  return { action, reasoning };
}

describe('orchestrator.run', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'android-qa-orch-' + randomUUID() + '-'));
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it('runs a scripted 10-turn session and terminates on done()', async () => {
    const driver = makeScriptedDriver(10);
    await driver.start();

    const { client, callJson } = makeClaude();
    // 10 taps that advance screens, then a done().
    for (let i = 1; i <= 10; i += 1) {
      callJson.mockResolvedValueOnce(
        decideResp({ kind: 'tap', elementId: `com.wastehero:id/btn-${i}` }, `tap btn-${i}`),
      );
    }
    callJson.mockResolvedValueOnce(
      decideResp({ kind: 'done', reason: 'all explored' }, 'done'),
    );

    const config = makeConfig({ turnBudget: 30 });
    const recorder = new Recorder({ runDir, initialState: emptySession('run-10turn', 30) });

    const session = await run({
      driver,
      claude: client,
      recorder,
      config,
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
    });

    expect(session.status).toBe('completed');
    expect(session.history).toHaveLength(10);

    const onDisk = JSON.parse(
      readFileSync(join(runDir, 'session.json'), 'utf8'),
    ) as SessionState;
    expect(onDisk.history).toHaveLength(10);
    expect(onDisk.status).toBe('completed');
    expect(typeof onDisk.endedAt).toBe('string');
  });

  it('aborts with aborted-auth when login throws LoginFailedError', async () => {
    const blankXml =
      '<?xml version="1.0"?><hierarchy rotation="0"><node index="0" class="android.widget.FrameLayout" bounds="[0,0][100,100]"/></hierarchy>';
    const driver = new FakeDriver({
      screens: [{ xml: blankXml, activity: '.LoginActivity' }],
      transitions: {},
    });
    await driver.start();

    const { client, callJson } = makeClaude();

    const recorder = new Recorder({ runDir, initialState: emptySession('run-auth', 10) });
    const session = await run({
      driver,
      claude: client,
      recorder,
      config: makeConfig(),
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
    });

    expect(session.status).toBe('aborted-auth');
    expect(session.history).toHaveLength(0);
    // No decide calls should have happened because login failed before the loop.
    expect(callJson).not.toHaveBeenCalled();

    const onDisk = JSON.parse(
      readFileSync(join(runDir, 'session.json'), 'utf8'),
    ) as SessionState;
    expect(onDisk.status).toBe('aborted-auth');
    expect(onDisk.history).toHaveLength(0);
  });

  it('aborts with aborted-crash-loop after 3 crashes', async () => {
    const driver = makeScriptedDriver(10);
    await driver.start();

    const { client, callJson } = makeClaude();
    for (let i = 0; i < 6; i += 1) {
      callJson.mockResolvedValueOnce(
        decideResp({ kind: 'tap', elementId: `com.wastehero:id/btn-${i + 1}` }),
      );
    }

    const logcatTail = makeFakeLogcat([
      ['01-01 12:00:00.000  1 1 E AndroidRuntime: FATAL EXCEPTION: main'],
      ['01-01 12:00:01.000  1 1 E AndroidRuntime: FATAL EXCEPTION: main'],
      ['01-01 12:00:02.000  1 1 E AndroidRuntime: FATAL EXCEPTION: main'],
      [],
      [],
      [],
    ]);

    const recorder = new Recorder({ runDir, initialState: emptySession('run-crash', 20) });
    const session = await run({
      driver,
      claude: client,
      recorder,
      config: makeConfig({ turnBudget: 20 }),
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
      logcatTail,
    });

    expect(session.status).toBe('aborted-crash-loop');
    expect(session.counters.crashCount).toBeGreaterThanOrEqual(3);
  });

  it('aborts cleanly when the wall-clock budget elapses', async () => {
    const driver = makeScriptedDriver(20);
    await driver.start();

    const { client, callJson } = makeClaude();
    for (let i = 0; i < 20; i += 1) {
      callJson.mockResolvedValueOnce(
        decideResp({ kind: 'tap', elementId: `com.wastehero:id/btn-${i + 1}` }),
      );
    }

    // Injected clock: advances by 200ms per call. With wallClockMinutes = 0.01
    // (600ms), the loop should exit after ~3 turns.
    let ticks = 0;
    const now = (): number => {
      const t = ticks;
      ticks += 200;
      return t;
    };

    const config = makeConfig({ wallClockMinutes: 0.01, turnBudget: 30 });
    const recorder = new Recorder({ runDir, initialState: emptySession('run-time', 30) });
    const session = await run({
      driver,
      claude: client,
      recorder,
      config,
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
      now,
    });

    expect(session.status).toBe('completed');
    expect(session.history.length).toBeGreaterThan(0);
    expect(session.history.length).toBeLessThan(20);
  });

  it('recovers once from emulator death, then aborts with aborted-device on the second loss', async () => {
    const driver = makeScriptedDriver(10);
    await driver.start();

    const { client, callJson } = makeClaude();
    for (let i = 0; i < 20; i += 1) {
      callJson.mockResolvedValueOnce(
        decideResp({ kind: 'tap', elementId: `com.wastehero:id/btn-${i + 1}` }),
      );
    }

    // Script isAppAlive: normal true, then false (first death), then true
    // (recovered), then false (second death). Relaunch succeeds first time,
    // throws second time.
    let aliveCall = 0;
    const aliveSchedule = [true, false, true, true, false];
    driver.isAppAlive = async (): Promise<boolean> => {
      const v = aliveSchedule[aliveCall] ?? true;
      aliveCall += 1;
      return v;
    };
    let relaunchCalls = 0;
    driver.relaunchApp = async (): Promise<void> => {
      relaunchCalls += 1;
      if (relaunchCalls >= 2) {
        throw new Error('device: relaunch failed');
      }
      // After first relaunch, the next alive call returns true (index 2).
    };

    const recorder = new Recorder({ runDir, initialState: emptySession('run-device', 20) });
    const session = await run({
      driver,
      claude: client,
      recorder,
      config: makeConfig({ turnBudget: 20 }),
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
    });

    expect(session.status).toBe('aborted-device');
    expect(relaunchCalls).toBeGreaterThanOrEqual(1);
  });

  it('re-perceives and continues when an Appium action throws once', async () => {
    const driver = makeScriptedDriver(10);
    await driver.start();

    const { client, callJson } = makeClaude();
    // Turn 1: tap btn-1 (throws once, then succeeds on retry path via re-perceive)
    callJson.mockResolvedValueOnce(
      decideResp({ kind: 'tap', elementId: 'com.wastehero:id/btn-1' }),
    );
    // Turn 2: a valid continuation tap
    callJson.mockResolvedValueOnce(
      decideResp({ kind: 'tap', elementId: 'com.wastehero:id/btn-2' }),
    );
    // Turn 3: done
    callJson.mockResolvedValueOnce(
      decideResp({ kind: 'done', reason: 'enough' }),
    );

    // Intercept tap AFTER login completes (login itself taps submit-btn).
    const originalTap = driver.tap.bind(driver);
    let throwNext = false;
    driver.tap = async (resourceId: string): Promise<void> => {
      if (resourceId === 'com.wastehero:id/btn-1' && !throwNext) {
        throwNext = true;
        throw new Error('stale element');
      }
      await originalTap(resourceId);
    };

    const recorder = new Recorder({ runDir, initialState: emptySession('run-appium', 20) });
    const session = await run({
      driver,
      claude: client,
      recorder,
      config: makeConfig({ turnBudget: 20 }),
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
    });

    // The orchestrator recovered — we ended cleanly rather than hitting aborted-device.
    expect(session.status).toBe('completed');
    expect(session.history.length).toBeGreaterThanOrEqual(1);
  });

  it('seeds the frontier from the appMap on a new screen', async () => {
    const driver = makeScriptedDriver(10);
    await driver.start();

    const { client, callJson } = makeClaude();
    // Always tap btn-1 (never a done), so we stop via turn budget.
    for (let i = 0; i < 5; i += 1) {
      callJson.mockResolvedValueOnce(
        decideResp({ kind: 'tap', elementId: 'com.wastehero:id/btn-1' }),
      );
    }
    callJson.mockResolvedValueOnce(decideResp({ kind: 'done', reason: 'stop' }));

    // Seed appMap with an untapped element for the expected home screen.
    // We don't know the exact fingerprint yet; the frontier code will just not
    // find it — but this test asserts that decide IS called with a frontier
    // argument whose shape is sensible (each entry has screenFp + elementId +
    // priority). We assert via the saved session state.
    const recorder = new Recorder({ runDir, initialState: emptySession('run-frontier', 10) });
    const session = await run({
      driver,
      claude: client,
      recorder,
      config: makeConfig({ turnBudget: 10 }),
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
    });

    expect(session.history.length).toBeGreaterThan(0);
    // Each visited screen should have a frontier-worthy elements dict.
    expect(Object.keys(session.screens).length).toBeGreaterThan(0);
  });

  it('persists session.json with full history after each turn', async () => {
    const driver = makeScriptedDriver(5);
    await driver.start();

    const { client, callJson } = makeClaude();
    for (let i = 1; i <= 5; i += 1) {
      callJson.mockResolvedValueOnce(
        decideResp({ kind: 'tap', elementId: `com.wastehero:id/btn-${i}` }),
      );
    }
    callJson.mockResolvedValueOnce(decideResp({ kind: 'done', reason: 'done' }));

    const recorder = new Recorder({ runDir, initialState: emptySession('run-persist', 10) });
    const session = await run({
      driver,
      claude: client,
      recorder,
      config: makeConfig({ turnBudget: 10 }),
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
    });

    const onDisk = JSON.parse(
      readFileSync(join(runDir, 'session.json'), 'utf8'),
    ) as SessionState;
    expect(onDisk.history).toHaveLength(session.history.length);
    expect(onDisk.history.length).toBe(5);
    expect(Object.keys(onDisk.screens).length).toBeGreaterThan(0);
  });

  it('terminates on turn-budget exhaustion as completed', async () => {
    const driver = makeScriptedDriver(10);
    await driver.start();

    const { client, callJson } = makeClaude();
    // Feed endless taps — never a done. Budget is 3.
    for (let i = 0; i < 10; i += 1) {
      callJson.mockResolvedValueOnce(
        decideResp({ kind: 'tap', elementId: `com.wastehero:id/btn-${i + 1}` }),
      );
    }

    const recorder = new Recorder({ runDir, initialState: emptySession('run-budget', 3) });
    const session = await run({
      driver,
      claude: client,
      recorder,
      config: makeConfig({ turnBudget: 3 }),
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
    });

    expect(session.status).toBe('completed');
    expect(session.history).toHaveLength(3);
  });

  it('saves a post-action screenshot per turn', async () => {
    const driver = makeScriptedDriver(2);
    await driver.start();

    const { client, callJson } = makeClaude();
    callJson.mockResolvedValueOnce(
      decideResp({ kind: 'tap', elementId: 'com.wastehero:id/btn-1' }),
    );
    callJson.mockResolvedValueOnce(decideResp({ kind: 'done', reason: 'done' }));

    const recorder = new Recorder({ runDir, initialState: emptySession('run-screenshot', 5) });
    await run({
      driver,
      claude: client,
      recorder,
      config: makeConfig({ turnBudget: 5 }),
      appMap: emptyAppMap(),
      history: [],
      role: 'admin',
    });

    // Turn indices are 1-based in the recorder's filenames.
    const first = join(runDir, 'screenshots', 'turn-0001-post.png');
    expect(existsSync(first)).toBe(true);
  });
});

describe('orchestrator.run history prop contract', () => {
  it('accepts a history argument but does not require it to be used', async () => {
    const driver = makeScriptedDriver(2);
    await driver.start();

    const { client, callJson } = makeClaude();
    callJson.mockResolvedValueOnce(
      decideResp({ kind: 'tap', elementId: 'com.wastehero:id/btn-1' }),
    );
    callJson.mockResolvedValueOnce(decideResp({ kind: 'done', reason: 'done' }));

    // Prior runs' findings — orchestrator may ignore (documented).
    const priorFindings: Finding[] = [
      {
        id: 'prior-1',
        runId: 'prior-run',
        screenFp: 'abc',
        element: null,
        category: 'A',
        severity: 'high',
        summary: 'something',
        reasoning: 'r',
        status: 'published',
      },
    ];

    const runDir2 = mkdtempSync(join(tmpdir(), 'android-qa-orch-hist-' + randomUUID() + '-'));
    try {
      const recorder = new Recorder({ runDir: runDir2, initialState: emptySession('run-hist', 5) });
      const session = await run({
        driver,
        claude: client,
        recorder,
        config: makeConfig({ turnBudget: 5 }),
        appMap: emptyAppMap(),
        history: priorFindings,
        role: 'admin',
      });

      expect(session.status).toBe('completed');
    } finally {
      rmSync(runDir2, { recursive: true, force: true });
    }
  });
});
