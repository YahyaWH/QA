import type { ViewNode } from '../types';
import type { Driver } from './driver';
import { parseViewTree } from './tree';

/**
 * A single scripted screen the FakeDriver can return.
 *
 * - `xml` is a uiautomator-style page-source dump parsed on demand by `getViewTree()`.
 * - `activity` is returned verbatim by `getCurrentActivity()`.
 */
export interface FakeScreen {
  xml: string;
  activity: string;
}

/**
 * Transition table for FakeDriver.
 *
 * Outer key: current screen index, stringified (e.g. `'0'`, `'1'`).
 * Inner key: action string encoding what the agent just did:
 *   - `'tap:<resourceId>'`
 *   - `'type:<resourceId>:<text>'` — no escaping; tests should avoid `:` inside `text`.
 *   - `'swipe:<direction>'`
 *   - `'back'`
 *   - `'scrollTo:<resourceId>'`
 *   - `'relaunch'`
 *
 * Value: the next screen index to land on. If no entry matches the current
 * action, the screen stays the same.
 */
export type FakeTransitions = Record<string, Record<string, number>>;

export interface FakeDriverOptions {
  screens: FakeScreen[];
  transitions: FakeTransitions;
}

/**
 * Every action the FakeDriver has been asked to perform, in call order.
 *
 * Exported so tests can assert exact call sequences without stringly-typed comparisons.
 */
export type RecordedAction =
  | { kind: 'tap'; resourceId: string }
  | { kind: 'tapAt'; x: number; y: number }
  | { kind: 'type'; resourceId: string; text: string }
  | { kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'back' }
  | { kind: 'scrollTo'; resourceId: string }
  | { kind: 'relaunch' };

/**
 * In-memory scripted `Driver` for unit tests and deterministic replays.
 *
 * Given a list of screens and a transition table, FakeDriver simulates the flow of
 * the app under test: each action the agent performs is recorded in
 * `actionsRecorded`, and if the transition table has an entry for the current
 * screen + action, the "current screen" cursor advances. Otherwise the cursor
 * stays put — matching real-app behavior where taps on irrelevant regions are
 * no-ops.
 *
 * Not for production use: `screenshot()` returns a placeholder buffer, and
 * `isAppAlive()` is controlled by the `setAlive()` test helper rather than by
 * observing any real process.
 */
export class FakeDriver implements Driver {
  public readonly actionsRecorded: RecordedAction[] = [];

  private readonly screens: FakeScreen[];
  private readonly transitions: FakeTransitions;
  private currentIndex: number = 0;
  private started: boolean = false;
  private alive: boolean = true;

  constructor(options: FakeDriverOptions) {
    if (options.screens.length === 0) {
      throw new Error('FakeDriver: screens must be non-empty');
    }
    this.screens = options.screens;
    this.transitions = options.transitions;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async getViewTree(): Promise<ViewNode> {
    this.requireStarted('getViewTree');
    return parseViewTree(this.currentScreen().xml);
  }

  async getCurrentActivity(): Promise<string> {
    this.requireStarted('getCurrentActivity');
    return this.currentScreen().activity;
  }

  async getWindowSize(): Promise<{ width: number; height: number }> {
    this.requireStarted('getWindowSize');
    return { width: 1080, height: 2400 };
  }

  async screenshot(): Promise<Buffer> {
    this.requireStarted('screenshot');
    return Buffer.from('fake-screenshot');
  }

  async tap(resourceId: string): Promise<void> {
    this.requireStarted('tap');
    this.actionsRecorded.push({ kind: 'tap', resourceId });
    this.applyTransition(`tap:${resourceId}`);
  }

  async tapAt(x: number, y: number): Promise<void> {
    this.requireStarted('tapAt');
    this.actionsRecorded.push({ kind: 'tapAt', x, y });
    this.applyTransition(`tapAt:${x},${y}`);
  }

  async type(resourceId: string, text: string): Promise<void> {
    this.requireStarted('type');
    this.actionsRecorded.push({ kind: 'type', resourceId, text });
    this.applyTransition(`type:${resourceId}:${text}`);
  }

  async swipe(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    this.requireStarted('swipe');
    this.actionsRecorded.push({ kind: 'swipe', direction });
    this.applyTransition(`swipe:${direction}`);
  }

  async back(): Promise<void> {
    this.requireStarted('back');
    this.actionsRecorded.push({ kind: 'back' });
    this.applyTransition('back');
  }

  async scrollTo(resourceId: string): Promise<void> {
    this.requireStarted('scrollTo');
    this.actionsRecorded.push({ kind: 'scrollTo', resourceId });
    this.applyTransition(`scrollTo:${resourceId}`);
  }

  async isAppAlive(): Promise<boolean> {
    return this.alive;
  }

  async relaunchApp(): Promise<void> {
    this.requireStarted('relaunchApp');
    this.actionsRecorded.push({ kind: 'relaunch' });
    this.alive = true;
    this.applyTransition('relaunch');
  }

  /**
   * Test helper: flip the alive flag that `isAppAlive()` returns.
   * Not part of the `Driver` interface — only call from tests.
   */
  setAlive(alive: boolean): void {
    this.alive = alive;
  }

  private currentScreen(): FakeScreen {
    const s = this.screens[this.currentIndex];
    if (!s) {
      throw new Error(`FakeDriver: current screen index ${this.currentIndex} out of range`);
    }
    return s;
  }

  private applyTransition(actionKey: string): void {
    const row = this.transitions[String(this.currentIndex)];
    if (!row) return;
    const next = row[actionKey];
    if (typeof next !== 'number') return;
    if (next < 0 || next >= this.screens.length) {
      throw new Error(
        `FakeDriver: transition from ${this.currentIndex} via '${actionKey}' points at out-of-range screen ${next}`,
      );
    }
    this.currentIndex = next;
  }

  private requireStarted(op: string): void {
    if (!this.started) {
      throw new Error(`FakeDriver: ${op}() called before start()`);
    }
  }
}
