import type { ViewNode } from '../types';

/**
 * Abstract device driver that the agent uses to observe and act on the app under test.
 *
 * Implementations:
 * - `FakeDriver` — in-memory scripted driver used by tests and deterministic replays.
 * - `AppiumDriver` — real-device / emulator driver backed by Appium + uiautomator2 (later task).
 *
 * All methods are async; side-effecting ones (tap/type/swipe/back/scrollTo/relaunchApp)
 * should not resolve until the corresponding UI transition has settled.
 */
export interface Driver {
  start(): Promise<void>;
  stop(): Promise<void>;
  getViewTree(): Promise<ViewNode>;
  getCurrentActivity(): Promise<string>;
  /** Device window size in absolute pixels — same coordinate space as the
   *  screenshot bytes and `tapAt(x, y)`. */
  getWindowSize(): Promise<{ width: number; height: number }>;
  screenshot(): Promise<Buffer>;
  tap(resourceId: string): Promise<void>;
  /**
   * Tap at absolute device coordinates. Used when no resource-id is available
   * or when multiple elements share the same id (e.g. list rows). Coordinates
   * are device pixels; pair with `getViewTree()` / a screenshot review to pick
   * a target. No-op if (x,y) lands on a non-interactive region.
   */
  tapAt(x: number, y: number): Promise<void>;
  type(resourceId: string, text: string): Promise<void>;
  swipe(direction: 'up' | 'down' | 'left' | 'right'): Promise<void>;
  back(): Promise<void>;
  scrollTo(resourceId: string): Promise<void>;
  isAppAlive(): Promise<boolean>;
  relaunchApp(): Promise<void>;
}
