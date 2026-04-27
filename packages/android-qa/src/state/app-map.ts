import { readFile, rename, open, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppMap } from '../types';

export const APP_MAP_SCHEMA_VERSION = 1 as const;

/**
 * Default on-disk location of the app map, resolved to
 * `<package-root>/state/app-map.json` via `import.meta.url`.
 *
 * Side-effect-free and deterministic — callers may stash the result.
 */
export function defaultAppMapPath(): string {
  // From `packages/android-qa/src/state/app-map.ts`, climb two dirs to reach
  // the package root, then join `state/app-map.json`.
  return fileURLToPath(new URL('../../state/app-map.json', import.meta.url));
}

/**
 * Build the empty app map returned on a cold load. `appVersion` is seeded as
 * `'unknown'` because we can't know the APK version before the first run;
 * callers (e.g. `mergeRunIntoMap`) overwrite it before the next save.
 */
function emptyAppMap(): AppMap {
  return {
    appVersion: 'unknown',
    generatedAt: new Date().toISOString(),
    schemaVersion: APP_MAP_SCHEMA_VERSION,
    screens: {},
    transitions: [],
    mergedRunIds: [],
  };
}

/**
 * Load the app map from disk.
 *
 * - Missing file → returns a fresh empty map with current `schemaVersion`.
 * - Any other I/O or JSON-parse error is rethrown (do NOT silently reset).
 */
export async function loadAppMap(path: string = defaultAppMapPath()): Promise<AppMap> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return emptyAppMap();
    throw err;
  }
  return JSON.parse(raw) as AppMap;
}

/**
 * Atomically persist the app map to disk using the canonical
 * open → writeFile → fsync → close → rename sequence. Creates the parent
 * directory if it does not yet exist. On any failure, cleans up the `.tmp`
 * sibling and rethrows so the previous good `app-map.json` is never clobbered.
 */
export async function saveAppMap(
  map: AppMap,
  path: string = defaultAppMapPath(),
): Promise<void> {
  const tmp = path + '.tmp';
  const json = JSON.stringify(map, null, 2);
  try {
    await mkdir(dirname(path), { recursive: true });
    // Open tmp, write contents, fsync, close — so the bytes are durable on
    // disk BEFORE the rename publishes them as app-map.json.
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup so we don't leak .tmp files across runs.
    await unlink(tmp).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to write ${path}: ${message}`, { cause: err });
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
