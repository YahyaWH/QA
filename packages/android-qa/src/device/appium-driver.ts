import { remote } from 'webdriverio';
import type { ViewNode } from '../types';
import type { Driver } from './driver';
import { parseViewTree } from './tree';

/**
 * Construction options for `AppiumDriver`.
 *
 * `appiumUrl` is parsed once in `start()` into hostname / port / path fields that
 * match the `remote()` RemoteOptions contract. The rest map 1:1 onto Appium
 * UIAutomator2 capabilities.
 */
export interface AppiumDriverOptions {
  /** Full Appium server URL, e.g. `http://127.0.0.1:4723` or `.../wd/hub`. */
  appiumUrl: string;
  /** Android Virtual Device name to boot (`appium:avd`). */
  avdName: string;
  /** Filesystem path to the APK under test (`appium:app`). */
  apkPath: string;
  /** Android package id of the app under test, used by `isAppAlive` + `relaunchApp`. */
  appPackage: string;
  /**
   * Main activity to launch. Defaults to `${appPackage}.MainActivity` which
   * matches the WasteHero APK; override when a different launch intent is
   * required (e.g. a demo build with a different entry activity).
   */
  appActivity?: string;
  /** Specific device/emulator UDID. Omitted capability if unset. */
  udid?: string;
  /** Auto-grant runtime permissions on install. Default `true`. */
  autoGrantPermissions?: boolean;
  /** Android platform version. Omitted capability if unset. */
  platformVersion?: string;
}

/**
 * The concrete `WebdriverIO.Browser` type returned by `remote(...)`.
 * Using `Awaited<ReturnType<...>>` avoids depending on the `WebdriverIO`
 * ambient namespace being visible in every consumer's tsconfig.
 */
type AppiumSession = Awaited<ReturnType<typeof remote>>;

/**
 * Real-device / emulator `Driver` implementation backed by Appium + UIAutomator2.
 *
 * The session lifecycle mirrors `Driver`: `start()` creates a WebdriverIO session
 * with the configured capabilities, `stop()` tears it down idempotently. All
 * observation/actuation methods require `start()` to have succeeded.
 *
 * Locator strategy for `tap` / `type`:
 * - Primary: accessibility id (`~<resourceId>`).
 * - Fallback: Android UiSelector `resourceId(...)`.
 *
 * Gesture implementation leans on Appium's `mobile: swipeGesture` /
 * `mobile: scrollGesture` commands rather than raw pointer actions, which is the
 * recommended approach under UIAutomator2 v3.
 */
export class AppiumDriver implements Driver {
  private readonly options: AppiumDriverOptions;
  private browser: AppiumSession | null = null;

  constructor(options: AppiumDriverOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const url = new URL(this.options.appiumUrl);
    const port = url.port ? Number(url.port) : 4723;
    // Appium 2 serves at `/` by default (no `/wd/hub` prefix). Only honor a
    // caller-provided path if they set one explicitly.
    const path = url.pathname === '' ? '/' : url.pathname;

    const capabilities: Record<string, unknown> = {
      platformName: 'Android',
      'appium:automationName': 'UIAutomator2',
      'appium:app': this.options.apkPath,
      // Explicit package + activity so Appium launches the target activity
      // even when the APK is already installed (in which case `app` alone is
      // a no-op and the session lands on whatever is currently foreground).
      'appium:appPackage': this.options.appPackage,
      'appium:appActivity': this.options.appActivity ?? `${this.options.appPackage}.MainActivity`,
      // Ensure the app is force-stopped + relaunched each session so we
      // never start on a stale screen from a previous run.
      'appium:forceAppLaunch': true,
      'appium:autoGrantPermissions': this.options.autoGrantPermissions ?? true,
    };
    // udid and avd are both valid ways to target a device, but in parallel mode
    // every instance shares the same AVD name and the uiautomator2 driver will
    // resolve `avd` to the FIRST running emulator matching it (regardless of
    // `udid`). That hijacks another instance's device and crashes both runs.
    // When we have a udid (we always boot the emulator ourselves and pass its
    // serial), skip avd entirely — udid uniquely identifies the target device.
    if (this.options.udid) {
      capabilities['appium:udid'] = this.options.udid;
    } else {
      capabilities['appium:avd'] = this.options.avdName;
    }
    if (this.options.platformVersion) {
      capabilities['appium:platformVersion'] = this.options.platformVersion;
    }

    this.browser = await remote({
      hostname: url.hostname,
      port,
      path,
      logLevel: 'silent',
      capabilities,
    });
  }

  async stop(): Promise<void> {
    if (this.browser === null) return;
    const b = this.browser;
    this.browser = null;
    await b.deleteSession();
  }

  async getViewTree(): Promise<ViewNode> {
    const xml = await this.b().getPageSource();
    return parseViewTree(xml);
  }

  async getCurrentActivity(): Promise<string> {
    return this.b().getCurrentActivity();
  }

  async getWindowSize(): Promise<{ width: number; height: number }> {
    const { width, height } = await this.b().getWindowSize();
    return { width, height };
  }

  async screenshot(): Promise<Buffer> {
    const base64 = await this.b().takeScreenshot();
    return Buffer.from(base64, 'base64');
  }

  async tap(resourceId: string): Promise<void> {
    const el = await this.resolveElement(resourceId);
    await el.click();
  }

  async tapAt(x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw new Error(`AppiumDriver.tapAt: invalid coordinates (${x}, ${y})`);
    }
    await this.b().executeScript('mobile: clickGesture', [
      { x: Math.round(x), y: Math.round(y) },
    ]);
  }

  async type(resourceId: string, text: string): Promise<void> {
    const el = await this.resolveElement(resourceId);
    await el.setValue(text);
  }

  async swipe(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    const { width, height } = await this.b().getWindowSize();
    const left = Math.round(width * 0.2);
    const top = Math.round(height * 0.2);
    const w = Math.round(width * 0.6);
    const h = Math.round(height * 0.6);
    await this.b().executeScript('mobile: swipeGesture', [
      { left, top, width: w, height: h, direction, percent: 0.8 },
    ]);
  }

  async back(): Promise<void> {
    await this.b().back();
  }

  async scrollTo(resourceId: string): Promise<void> {
    this.assertNoQuote(resourceId);
    const { width, height } = await this.b().getWindowSize();
    const left = Math.round(width * 0.1);
    const top = Math.round(height * 0.2);
    const w = Math.round(width * 0.8);
    const h = Math.round(height * 0.6);
    await this.b().executeScript('mobile: scrollGesture', [
      {
        left,
        top,
        width: w,
        height: h,
        direction: 'down',
        percent: 1.0,
        strategy: '-android uiautomator',
        selector: `new UiSelector().resourceId("${resourceId}")`,
      },
    ]);
  }

  async isAppAlive(): Promise<boolean> {
    const state = await this.b().queryAppState(this.options.appPackage);
    return state === 4;
  }

  async relaunchApp(): Promise<void> {
    await this.b().terminateApp(this.options.appPackage, {});
    await this.b().activateApp(this.options.appPackage);
  }

  /** Assert the session has been started and return it. */
  private b(): AppiumSession {
    if (this.browser === null) {
      throw new Error('AppiumDriver not started');
    }
    return this.browser;
  }

  /**
   * Resolve a resource id to a WebdriverIO element.
   *
   * Try accessibility id first (common for views whose `content-desc` matches the
   * resource id). Fall back to Android UiSelector `resourceId(...)`, which is
   * what most real resource ids match against.
   */
  private async resolveElement(
    resourceId: string,
  ): Promise<Awaited<ReturnType<AppiumSession['$']>>> {
    this.assertNoQuote(resourceId);
    const browser = this.b();
    const primary = await browser.$(`~${resourceId}`);
    if (await primary.isExisting()) return primary;
    return browser.$(`android=new UiSelector().resourceId("${resourceId}")`);
  }

  /**
   * Pragmatic guard: reject resource ids containing a `"` because we embed them
   * unescaped inside UiSelector strings. Callers should never be passing quoted
   * ids in practice.
   */
  private assertNoQuote(resourceId: string): void {
    if (resourceId.includes('"')) {
      throw new Error(`AppiumDriver: resourceId must not contain '"': ${resourceId}`);
    }
  }
}
