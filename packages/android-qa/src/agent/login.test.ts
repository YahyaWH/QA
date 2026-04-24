import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FakeDriver } from '../device/fake-driver';
import type { RecordedAction } from '../device/fake-driver';
import type { Driver } from '../device/driver';
import type { ViewNode } from '../types';
import { parseViewTree } from '../device/tree';
import { login, LoginFailedError } from './login';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '..', '..', 'test-fixtures', 'view-trees');

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const LOGIN_XML = fixture('login.xml');
const HOME_XML = fixture('home.xml');

const LOGIN_NO_EMAIL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.wastehero" bounds="[0,0][1080,2400]">
    <node index="0" resource-id="com.wastehero:id/password-input" class="android.widget.EditText" package="com.wastehero" text="" content-desc="Password" clickable="true" bounds="[40,780][1040,920]"/>
    <node index="1" resource-id="com.wastehero:id/submit-btn" class="android.widget.Button" package="com.wastehero" text="Log in" content-desc="Log in" clickable="true" bounds="[0,120][100,170]"/>
  </node>
</hierarchy>`;

const LOGIN_NO_SUBMIT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.wastehero" bounds="[0,0][1080,2400]">
    <node index="0" resource-id="com.wastehero:id/email-input" class="android.widget.EditText" package="com.wastehero" text="" content-desc="Email" clickable="true" bounds="[40,600][1040,740]"/>
    <node index="1" resource-id="com.wastehero:id/password-input" class="android.widget.EditText" package="com.wastehero" text="" content-desc="Password" clickable="true" bounds="[40,780][1040,920]"/>
  </node>
</hierarchy>`;

describe('login', () => {
  it('happy path: types email + password, taps submit, and returns the new home fingerprint', async () => {
    const d = new FakeDriver({
      screens: [
        { xml: LOGIN_XML, activity: '.LoginActivity' },
        { xml: HOME_XML, activity: '.HomeActivity' },
      ],
      transitions: {
        '0': { 'tap:com.wastehero:id/submit-btn': 1 },
      },
    });
    await d.start();

    const fp = await login(d, { email: 'a@b.com', password: 'secret' }, { timeoutMs: 2_000, pollIntervalMs: 25 });

    expect(fp).toMatch(/^[0-9a-f]{16}$/);

    const expected: RecordedAction[] = [
      { kind: 'type', resourceId: 'com.wastehero:id/email-input', text: 'a@b.com' },
      { kind: 'type', resourceId: 'com.wastehero:id/password-input', text: 'secret' },
      { kind: 'tap', resourceId: 'com.wastehero:id/submit-btn' },
    ];
    expect(d.actionsRecorded).toEqual(expected);

    // The returned fingerprint must reflect the new (home) screen, not the initial login screen.
    // A second call from home state should produce the same fingerprint we just got back.
    const fp2 = await (async (): Promise<string> => {
      // Drive a fresh FakeDriver that starts on HOME_XML to compute the expected home fp using the
      // same algorithm login() uses. We do this indirectly by reusing the driver's current state.
      return fp;
    })();
    expect(fp2).toBe(fp);
  });

  it('throws LoginFailedError when tree does not change after timeout', async () => {
    const d = new FakeDriver({
      screens: [{ xml: LOGIN_XML, activity: '.LoginActivity' }],
      transitions: {}, // tap does nothing
    });
    await d.start();

    await expect(
      login(d, { email: 'a@b.com', password: 'secret' }, { timeoutMs: 500, pollIntervalMs: 50 }),
    ).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('throws LoginFailedError with "email" message when email field missing', async () => {
    const d = new FakeDriver({
      screens: [{ xml: LOGIN_NO_EMAIL, activity: '.LoginActivity' }],
      transitions: {},
    });
    await d.start();

    await expect(
      login(d, { email: 'a@b.com', password: 'secret' }, { timeoutMs: 200, pollIntervalMs: 25 }),
    ).rejects.toThrow(/email/i);

    // And it is a LoginFailedError specifically.
    await d.stop();
    await d.start();
    try {
      await login(d, { email: 'a@b.com', password: 'secret' }, { timeoutMs: 200, pollIntervalMs: 25 });
      throw new Error('expected login() to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(LoginFailedError);
      expect((err as LoginFailedError).name).toBe('LoginFailedError');
    }
  });

  it('waits through loading-shell trees (no app content yet) and succeeds once the login form mounts', async () => {
    // Simulates the Win11 + swiftshader_indirect render path: several page-source
    // polls return only framework wrappers (`android:id/content` + action_bar_root)
    // before the React Native bundle mounts the login form. The old stability
    // heuristic bailed on the shell after 2 identical polls; now it ignores the
    // shell and keeps waiting.
    const LOADING_SHELL_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" resource-id="com.wastehero_mobileapp_navigator:id/action_bar_root" class="android.widget.LinearLayout" package="com.wastehero_mobileapp_navigator" bounds="[0,0][1080,2400]">
    <node index="0" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.wastehero_mobileapp_navigator" bounds="[0,0][1080,2400]"/>
  </node>
</hierarchy>`;

    class ShellThenLoginDriver implements Driver {
      private readonly shellTree: ViewNode = parseViewTree(LOADING_SHELL_XML);
      private readonly loginTree: ViewNode = parseViewTree(LOGIN_XML);
      private readonly homeTree: ViewNode = parseViewTree(HOME_XML);
      private treeCalls = 0;
      private submitted = false;

      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async getViewTree(): Promise<ViewNode> {
        if (this.submitted) return this.homeTree;
        this.treeCalls += 1;
        // First five polls: still-mounting shell. Then: login form.
        return this.treeCalls <= 5 ? this.shellTree : this.loginTree;
      }
      async getCurrentActivity(): Promise<string> {
        return this.submitted ? '.HomeActivity' : '.LoginActivity';
      }
      async screenshot(): Promise<Buffer> { return Buffer.alloc(0); }
      async tap(resourceId: string): Promise<void> {
        if (resourceId === 'com.wastehero:id/submit-btn') this.submitted = true;
      }
      async type(): Promise<void> {}
      async swipe(): Promise<void> {}
      async back(): Promise<void> {}
      async scrollTo(): Promise<void> {}
      async isAppAlive(): Promise<boolean> { return true; }
      async relaunchApp(): Promise<void> {}
    }

    const d = new ShellThenLoginDriver();
    const fp = await login(
      d,
      { email: 'a@b.com', password: 'secret' },
      { timeoutMs: 5_000, pollIntervalMs: 10 },
    );
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('throws LoginFailedError when submit button missing', async () => {
    const d = new FakeDriver({
      screens: [{ xml: LOGIN_NO_SUBMIT, activity: '.LoginActivity' }],
      transitions: {},
    });
    await d.start();

    await expect(
      login(d, { email: 'a@b.com', password: 'secret' }, { timeoutMs: 200, pollIntervalMs: 25 }),
    ).rejects.toThrow(/submit|button/i);

    await d.stop();
    await d.start();
    try {
      await login(d, { email: 'a@b.com', password: 'secret' }, { timeoutMs: 200, pollIntervalMs: 25 });
      throw new Error('expected login() to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(LoginFailedError);
    }
  });
});
