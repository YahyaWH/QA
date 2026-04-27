import { describe, it, expect } from 'vitest';
import { FakeDriver } from './fake-driver';
import type { RecordedAction } from './fake-driver';

const SCREEN_A = `
<hierarchy>
  <node class="FrameLayout" resource-id="" clickable="false" bounds="[0,0][100,100]">
    <node class="Button" resource-id="com.test:id/go" clickable="true" bounds="[10,10][90,90]"/>
  </node>
</hierarchy>
`;

const SCREEN_B = `
<hierarchy>
  <node class="FrameLayout" resource-id="com.test:id/home" clickable="false" bounds="[0,0][100,100]">
    <node class="TextView" resource-id="com.test:id/welcome" clickable="false" bounds="[10,10][90,30]"/>
  </node>
</hierarchy>
`;

describe('FakeDriver', () => {
  it('starts and reports the first screen activity', async () => {
    const d = new FakeDriver({
      screens: [
        { xml: SCREEN_A, activity: '.LoginActivity' },
        { xml: SCREEN_B, activity: '.HomeActivity' },
      ],
      transitions: {},
    });
    await d.start();
    expect(await d.getCurrentActivity()).toBe('.LoginActivity');
  });

  it('records actions in order', async () => {
    const d = new FakeDriver({
      screens: [{ xml: SCREEN_A, activity: '.LoginActivity' }],
      transitions: {},
    });
    await d.start();

    await d.tap('email-input');
    await d.type('email-input', 'a@b.com');
    await d.back();
    await d.swipe('down');
    await d.scrollTo('x');

    const expected: RecordedAction[] = [
      { kind: 'tap', resourceId: 'email-input' },
      { kind: 'type', resourceId: 'email-input', text: 'a@b.com' },
      { kind: 'back' },
      { kind: 'swipe', direction: 'down' },
      { kind: 'scrollTo', resourceId: 'x' },
    ];
    expect(d.actionsRecorded).toEqual(expected);
  });

  it('advances screen when a matching transition exists', async () => {
    const d = new FakeDriver({
      screens: [
        { xml: SCREEN_A, activity: '.LoginActivity' },
        { xml: SCREEN_B, activity: '.HomeActivity' },
      ],
      transitions: {
        '0': { 'tap:submit-btn': 1 },
      },
    });
    await d.start();
    await d.tap('submit-btn');
    expect(await d.getCurrentActivity()).toBe('.HomeActivity');
  });

  it('stays on current screen when no transition matches', async () => {
    const d = new FakeDriver({
      screens: [
        { xml: SCREEN_A, activity: '.LoginActivity' },
        { xml: SCREEN_B, activity: '.HomeActivity' },
      ],
      transitions: {
        '0': { 'tap:submit-btn': 1 },
      },
    });
    await d.start();
    await d.tap('not-a-button');
    expect(await d.getCurrentActivity()).toBe('.LoginActivity');
  });

  it('honors all action-kind transition formats', async () => {
    const d = new FakeDriver({
      screens: [
        { xml: SCREEN_A, activity: '.S0' },
        { xml: SCREEN_B, activity: '.S1' },
        { xml: SCREEN_A, activity: '.S2' },
        { xml: SCREEN_B, activity: '.S3' },
        { xml: SCREEN_A, activity: '.S4' },
        { xml: SCREEN_B, activity: '.S5' },
      ],
      transitions: {
        '0': { 'tap:go': 1 },
        '1': { 'type:email:hi': 2 },
        '2': { 'swipe:up': 3 },
        '3': { back: 4 },
        '4': { 'scrollTo:footer': 5 },
      },
    });
    await d.start();
    await d.tap('go');
    expect(await d.getCurrentActivity()).toBe('.S1');
    await d.type('email', 'hi');
    expect(await d.getCurrentActivity()).toBe('.S2');
    await d.swipe('up');
    expect(await d.getCurrentActivity()).toBe('.S3');
    await d.back();
    expect(await d.getCurrentActivity()).toBe('.S4');
    await d.scrollTo('footer');
    expect(await d.getCurrentActivity()).toBe('.S5');
  });

  it('returns a non-empty Buffer from screenshot()', async () => {
    const d = new FakeDriver({
      screens: [{ xml: SCREEN_A, activity: '.LoginActivity' }],
      transitions: {},
    });
    await d.start();
    const buf = await d.screenshot();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('isAppAlive defaults true; setAlive(false) flips it; relaunchApp resets to true', async () => {
    const d = new FakeDriver({
      screens: [{ xml: SCREEN_A, activity: '.LoginActivity' }],
      transitions: {},
    });
    await d.start();
    expect(await d.isAppAlive()).toBe(true);
    d.setAlive(false);
    expect(await d.isAppAlive()).toBe(false);
    await d.relaunchApp();
    expect(await d.isAppAlive()).toBe(true);
    expect(d.actionsRecorded).toEqual([{ kind: 'relaunch' }]);
  });

  it('relaunch transition advances the screen', async () => {
    const d = new FakeDriver({
      screens: [
        { xml: SCREEN_A, activity: '.LoginActivity' },
        { xml: SCREEN_B, activity: '.HomeActivity' },
      ],
      transitions: {
        '0': { relaunch: 1 },
      },
    });
    await d.start();
    await d.relaunchApp();
    expect(await d.getCurrentActivity()).toBe('.HomeActivity');
  });

  it('getViewTree parses XML via parseViewTree', async () => {
    const d = new FakeDriver({
      screens: [{ xml: SCREEN_A, activity: '.LoginActivity' }],
      transitions: {},
    });
    await d.start();
    const tree = await d.getViewTree();
    expect(tree.className).toBe('FrameLayout');
    expect(tree.children[0].resourceId).toBe('com.test:id/go');
    expect(tree.children[0].clickable).toBe(true);
  });

  it('getViewTree throws if not started', async () => {
    const d = new FakeDriver({
      screens: [{ xml: SCREEN_A, activity: '.LoginActivity' }],
      transitions: {},
    });
    await expect(d.getViewTree()).rejects.toThrow();
  });
});
