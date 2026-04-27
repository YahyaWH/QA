/**
 * Diagnostic CLI: boot emulator + install APK + create Appium session, then
 * dump the raw page-source XML, current activity, parsed view tree, and a
 * screenshot to `output/android-qa/diag-<UTC>/`. Used to inspect what the
 * login heuristic sees when it fails on a new APK build.
 *
 * Usage: `npm run diag-login -w @wastehero-qa/android-qa`.
 */

import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config/index';
import { AppiumDriver } from '../src/device/appium-driver';
import { startAppium } from '../src/device/appium-server';
import {
  extractApkVersion,
  installApk,
  startEmulator,
  waitForBoot,
} from '../src/device/emulator';

const APP_PACKAGE = process.env.WASTEHERO_APP_PACKAGE ?? 'com.wastehero_mobileapp_navigator';

function utcStamp(): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const d = new Date();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const outDir = join(
    fileURLToPath(new URL('../../../output/android-qa', import.meta.url)),
    `diag-${utcStamp()}`,
  );
  mkdirSync(outDir, { recursive: true });
  console.log(`[diag] outDir=${outDir}`);

  const emulator = await startEmulator({
    avdName: config.device.avdName,
    sdkRoot: config.device.sdkRoot,
  });
  const appiumServer = await startAppium(config.device.appiumHost, config.device.appiumPort);
  let driver: AppiumDriver | null = null;

  try {
    const bootTimeoutMs = Number(process.env.ANDROID_EMULATOR_BOOT_TIMEOUT_MS ?? 300_000);
    await waitForBoot(emulator.serial, bootTimeoutMs);
    console.log('[diag] emulator booted');

    await installApk(config.device.apkPath, emulator.serial);
    const appVersion = await extractApkVersion(config.device.apkPath, config.device.sdkRoot);
    console.log(`[diag] appVersion=${appVersion}`);
    await writeFile(join(outDir, 'appVersion.txt'), appVersion, 'utf8');

    driver = new AppiumDriver({
      appiumUrl: `http://${config.device.appiumHost}:${config.device.appiumPort}`,
      avdName: config.device.avdName,
      apkPath: config.device.apkPath,
      appPackage: APP_PACKAGE,
      udid: emulator.serial,
    });
    await driver.start();
    console.log('[diag] driver session created');

    const probeDelayMs = Number(process.env.DIAG_PROBE_DELAY_MS ?? 20_000);
    console.log(`[diag] waiting ${probeDelayMs}ms for app to render...`);
    await delay(probeDelayMs);

    // Use webdriverio directly via a short-lived browser cast to keep this
    // diagnostic self-contained: we want the RAW XML, not the parsed tree.
    // AppiumDriver.getViewTree() only returns the parsed tree. Reaching past
    // the private `browser` field is intentional here.
    const browser = (driver as unknown as { browser: { getPageSource: () => Promise<string> } })
      .browser;
    const xml = await browser.getPageSource();
    await writeFile(join(outDir, 'page-source.xml'), xml, 'utf8');
    console.log(`[diag] page-source.xml ${xml.length} bytes`);

    const activity = await driver.getCurrentActivity();
    await writeFile(join(outDir, 'current-activity.txt'), activity, 'utf8');
    console.log(`[diag] current activity: ${activity}`);

    const tree = await driver.getViewTree();
    await writeFile(join(outDir, 'tree.json'), JSON.stringify(tree, null, 2), 'utf8');

    const shot = await driver.screenshot();
    await writeFile(join(outDir, 'screen.png'), shot);
    console.log(`[diag] screenshot ${shot.length} bytes`);

    const resourceIds: string[] = [];
    const walk = (n: typeof tree): void => {
      if (n.resourceId) resourceIds.push(n.resourceId);
      for (const c of n.children) walk(c);
    };
    walk(tree);
    await writeFile(
      join(outDir, 'resource-ids.txt'),
      resourceIds.length > 0 ? resourceIds.join('\n') + '\n' : '(no resource ids)\n',
      'utf8',
    );
    console.log(`[diag] resource ids (${resourceIds.length}):`);
    for (const id of resourceIds.slice(0, 40)) console.log(`  ${id}`);
  } finally {
    console.log('[diag] tearing down...');
    if (driver) await driver.stop().catch((e: unknown) => console.error(`[diag] driver stop: ${String(e)}`));
    await appiumServer.stop().catch((e: unknown) => console.error(`[diag] appium stop: ${String(e)}`));
    await emulator.stop().catch((e: unknown) => console.error(`[diag] emulator stop: ${String(e)}`));
    console.log('[diag] done');
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[diag] fatal: ${message}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
