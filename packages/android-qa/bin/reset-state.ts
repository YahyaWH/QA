/**
 * `android-qa:reset-state`
 *
 * Archive the current `state/app-map.json` + `state/findings-history.jsonl`
 * into `state/archive/<UTC-timestamp>/`, replace them with empty shells,
 * and commit locally (no push). Used when:
 *   - the APK under test has drifted far enough that the existing app map
 *     misleads the agent,
 *   - stale findings are confusing cross-run dedup,
 *   - a developer wants a clean-slate rerun for a bisect.
 *
 * Archive layout keeps the same filenames so a future `git revert` on this
 * commit OR a manual `cp state/archive/<ts>/* state/` restore brings the
 * previous state back byte-for-byte.
 *
 * Exits 0 on success. Missing source files are treated as "already reset"
 * — we still write the empty shells (idempotent) and commit if anything
 * actually changed.
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';

const log = (msg: string): void => {
  console.log(`[reset-state] ${msg}`);
};

/** Repo root (`<repo>/`). `bin/reset-state.ts` → up three `..`. */
function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/** Package state directory (`packages/android-qa/state/`). */
function stateDir(): string {
  return fileURLToPath(new URL('../state/', import.meta.url));
}

/** `YYYYMMDD-HHMMSS` UTC for the archive subdirectory name. Collision-proof
 *  down to the second — no suffix needed, since this CLI is manually invoked. */
function utcStamp(): string {
  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function main(): Promise<number> {
  const root = repoRoot();
  const state = stateDir();
  const archiveRoot = join(state, 'archive');
  const stamp = utcStamp();
  const archiveDir = join(archiveRoot, stamp);

  const appMapPath = join(state, 'app-map.json');
  const historyPath = join(state, 'findings-history.jsonl');

  log(`archive → ${archiveDir}`);

  await mkdir(archiveDir, { recursive: true });

  const archived: string[] = [];
  if (existsSync(appMapPath)) {
    await rename(appMapPath, join(archiveDir, 'app-map.json'));
    archived.push('app-map.json');
  }
  if (existsSync(historyPath)) {
    await rename(historyPath, join(archiveDir, 'findings-history.jsonl'));
    archived.push('findings-history.jsonl');
  }
  log(`archived: ${archived.length > 0 ? archived.join(', ') : '(nothing — already empty)'}`);

  // Empty shells so loadAppMap() / readHistory() don't go down their
  // "missing file" branches on the next run — both honour ENOENT, but an
  // empty file is the explicit "yes, reset on purpose" signal.
  const emptyAppMap = {
    appVersion: '',
    generatedAt: '',
    schemaVersion: 1,
    screens: {},
    transitions: [],
  };
  await writeFile(appMapPath, JSON.stringify(emptyAppMap, null, 2) + '\n', 'utf8');
  await writeFile(historyPath, '', 'utf8');
  log('wrote empty shells');

  try {
    const git = simpleGit(root);
    // Stage the archived files + the new empty shells. simple-git's add takes
    // paths relative to the git root.
    const rel = 'packages/android-qa/state';
    await git.add([
      `${rel}/app-map.json`,
      `${rel}/findings-history.jsonl`,
      `${rel}/archive/${stamp}`,
    ]);
    await git.commit(`android-qa: reset state (archive ${stamp})`);
    log(`committed: archive ${stamp} + empty shells`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reset-state] git commit failed: ${message}`);
    return 1;
  }

  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reset-state] unhandled: ${message}`);
    process.exit(1);
  },
);
