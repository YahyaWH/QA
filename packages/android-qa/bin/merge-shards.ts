/**
 * `android-qa:merge-shards`
 *
 * Reconciler CLI for the parallel-explore pipeline. When explore runs with
 * `ANDROID_QA_INSTANCE_INDEX` set, it writes its post-run app-map + findings
 * to `state/shards/<runId>.{app-map.json,findings.jsonl}` instead of the
 * canonical state files, so N parallel instances never clobber each other.
 *
 * This CLI folds those shard files back into `state/app-map.json` and
 * `state/findings-history.jsonl`, then archives the shards under
 * `state/shards/.archive/<UTC-timestamp>/` so a failed merge can be retried or
 * inspected.
 *
 * Algorithm:
 *   1. Scan `state/shards/*.app-map.json` — each shard's filename is
 *      `<runId>.app-map.json`, encoding the runId directly.
 *   2. For each shard, load the matching `output/android-qa/<runId>/session.json`
 *      and apply `mergeRunIntoMap(canonical, session)` sequentially. This
 *      reuses the exact merge semantics explore itself uses, so the post-
 *      merge canonical is identical to what a serial N-run pass would produce.
 *      `mergeRunIntoMap` is idempotent via `mergedRunIds`, so re-running
 *      merge-shards after a partial failure is safe.
 *   3. Scan `state/shards/*.findings.jsonl` — each holds only that run's
 *      new findings. Dedup against canonical history by `finding.id` (a
 *      deterministic content hash) and append unseen ones.
 *   4. Archive (move) successfully-merged shard files into
 *      `state/shards/.archive/<stamp>/` so the next run sees an empty shards
 *      directory. Shards whose session.json is missing are left in place with
 *      a warning — they represent a crashed run worth debugging.
 *
 * Exits 0 on success (including "nothing to merge"), 1 on any I/O error.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultAppMapPath,
  loadAppMap,
  saveAppMap,
} from '../src/state/app-map';
import {
  appendFindings,
  defaultFindingsHistoryPath,
  readHistory,
} from '../src/state/findings-history';
import { mergeRunIntoMap } from '../src/state/map-merge';
import type { Finding, SessionState } from '../src/types/index';

const log = (msg: string): void => {
  console.log(`[merge-shards] ${msg}`);
};

/** Package state directory (`packages/android-qa/state/`). */
function stateDir(): string {
  return fileURLToPath(new URL('../state/', import.meta.url));
}

/** Shards subdirectory (`packages/android-qa/state/shards/`). */
function shardsDir(): string {
  return join(stateDir(), 'shards');
}

/** Run output directory (`<repo>/output/android-qa/`). `bin/merge-shards.ts`
 *  sits three `..` below the repo root. */
function outputDir(): string {
  return fileURLToPath(new URL('../../../output/android-qa', import.meta.url));
}

/** `YYYYMMDD-HHMMSS` UTC for the archive subdirectory name. Collision-proof
 *  down to the second — merge-shards is manually invoked (or once per
 *  parallel-run cycle), never multiple times per second. */
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

interface ShardFiles {
  /** runIds in deterministic order (sorted lexicographically — since runIds
   *  begin with `run-YYYYMMDD-HHMM`, sort-order is chronological). */
  runIds: string[];
  /** Absolute paths to shard app-map files, keyed by runId. */
  appMaps: Record<string, string>;
  /** Absolute paths to shard findings files, keyed by runId. Not every
   *  runId has findings (empty sessions skip the append step in run-explore). */
  findings: Record<string, string>;
}

async function scanShards(): Promise<ShardFiles> {
  const dir = shardsDir();
  if (!existsSync(dir)) {
    return { runIds: [], appMaps: {}, findings: {} };
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const appMaps: Record<string, string> = {};
  const findings: Record<string, string> = {};
  const runIdSet = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.endsWith('.app-map.json')) {
      const runId = name.slice(0, -'.app-map.json'.length);
      appMaps[runId] = join(dir, name);
      runIdSet.add(runId);
    } else if (name.endsWith('.findings.jsonl')) {
      const runId = name.slice(0, -'.findings.jsonl'.length);
      findings[runId] = join(dir, name);
      runIdSet.add(runId);
    }
    // Any other file is ignored — keeps the scan forgiving of stray .tmp
    // siblings from an interrupted atomic write.
  }

  const runIds = Array.from(runIdSet).sort();
  return { runIds, appMaps, findings };
}

/** Load a run's `session.json` from `output/android-qa/<runId>/session.json`.
 *  Returns null (with a logged warning) when the file is missing — that run's
 *  shard is skipped and stays in the shards dir for follow-up. */
async function loadSession(runId: string): Promise<SessionState | null> {
  const path = join(outputDir(), runId, 'session.json');
  if (!existsSync(path)) {
    console.warn(`[merge-shards] missing session.json for ${runId} at ${path}; skipping`);
    return null;
  }
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as SessionState;
}

/** Move (rename) a file into the archive directory, preserving its basename. */
async function archiveFile(src: string, archiveDir: string): Promise<void> {
  const base = src.split(/[\\/]/).pop() ?? 'unknown';
  const target = join(archiveDir, base);
  await rename(src, target);
}

async function main(): Promise<number> {
  const canonicalAppMapPath = defaultAppMapPath();
  const canonicalHistoryPath = defaultFindingsHistoryPath();

  log(`state/shards/ → ${shardsDir()}`);
  log(`canonical app-map → ${canonicalAppMapPath}`);
  log(`canonical history → ${canonicalHistoryPath}`);

  const shards = await scanShards();
  if (shards.runIds.length === 0) {
    log('no shards found; nothing to merge');
    return 0;
  }
  log(`found ${shards.runIds.length} shard run(s): ${shards.runIds.join(', ')}`);

  // --- App-map merge ------------------------------------------------------
  let canonical = await loadAppMap(canonicalAppMapPath);
  log(
    `canonical baseline: screens=${Object.keys(canonical.screens).length} transitions=${canonical.transitions.length} mergedRuns=${canonical.mergedRunIds?.length ?? 0}`,
  );

  const mergedAppMapRunIds: string[] = [];
  const skippedForMissingSession: string[] = [];
  for (const runId of shards.runIds) {
    if (!shards.appMaps[runId]) continue; // findings-only shard, handled below
    const session = await loadSession(runId);
    if (!session) {
      skippedForMissingSession.push(runId);
      continue;
    }
    canonical = mergeRunIntoMap(canonical, session);
    mergedAppMapRunIds.push(runId);
    log(
      `  merged ${runId}: canonical now screens=${Object.keys(canonical.screens).length} transitions=${canonical.transitions.length}`,
    );
  }

  if (mergedAppMapRunIds.length > 0) {
    await saveAppMap(canonical, canonicalAppMapPath);
    log(`wrote ${canonicalAppMapPath}`);
  } else {
    log('no app-map shards merged (all sessions missing or no app-map shards present)');
  }

  // --- Findings merge -----------------------------------------------------
  const canonicalHistory = await readHistory(canonicalHistoryPath);
  const seenIds = new Set(canonicalHistory.map((f) => f.id));
  log(`canonical history: ${canonicalHistory.length} finding(s) (${seenIds.size} unique id(s))`);

  const appendedFindings: Finding[] = [];
  const mergedFindingsRunIds: string[] = [];
  for (const runId of shards.runIds) {
    const path = shards.findings[runId];
    if (!path) continue;
    const shardFindings = await readHistory(path);
    const fresh = shardFindings.filter((f) => !seenIds.has(f.id));
    for (const f of fresh) {
      seenIds.add(f.id);
      appendedFindings.push(f);
    }
    mergedFindingsRunIds.push(runId);
    log(
      `  findings shard ${runId}: ${shardFindings.length} total, ${fresh.length} new (${shardFindings.length - fresh.length} duplicate id(s))`,
    );
  }

  if (appendedFindings.length > 0) {
    await appendFindings(appendedFindings, canonicalHistoryPath);
    log(`appended ${appendedFindings.length} finding(s) to ${canonicalHistoryPath}`);
  } else {
    log('no new findings to append');
  }

  // --- Archive successfully-merged shards --------------------------------
  // Only archive files whose merge succeeded. App-map shards with a missing
  // session.json stay put so the developer can debug the crashed run.
  const archivableAppMapRunIds = new Set(mergedAppMapRunIds);
  const archivableFindingsRunIds = new Set(mergedFindingsRunIds);
  const toArchive: string[] = [];
  for (const runId of shards.runIds) {
    if (shards.appMaps[runId] && archivableAppMapRunIds.has(runId)) {
      toArchive.push(shards.appMaps[runId]);
    }
    if (shards.findings[runId] && archivableFindingsRunIds.has(runId)) {
      toArchive.push(shards.findings[runId]);
    }
  }

  if (toArchive.length > 0) {
    const stamp = utcStamp();
    const archiveDir = join(shardsDir(), '.archive', stamp);
    await mkdir(archiveDir, { recursive: true });
    for (const src of toArchive) {
      await archiveFile(src, archiveDir);
    }
    log(`archived ${toArchive.length} shard file(s) → ${archiveDir}`);
  }

  if (skippedForMissingSession.length > 0) {
    console.warn(
      `[merge-shards] ${skippedForMissingSession.length} run(s) left in shards/ (no session.json): ${skippedForMissingSession.join(', ')}`,
    );
  }

  log('done');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[merge-shards] unhandled: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  },
);
