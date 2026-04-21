/**
 * `android-qa:publish --run <runId> [--dry-run]`
 *
 * Flow (spec §6.4):
 *
 *   1. Load `output/android-qa/<runId>/report.md`, parse into findings.
 *   2. Filter: `checked === true && linearIssueId` is absent — these are the
 *      ones the human has ticked and not yet published.
 *   3. Correlate each ticked finding to its entry in
 *      `state/findings-history.jsonl` (by 4-hex display id prefix, latest
 *      match wins).
 *   4. For each candidate:
 *        - collect absolute artifact paths (screenshot / clip / logcat) from
 *          the finding's `artifactRefs`,
 *        - `hostArtifacts(...)` → `{absPath: publicUrl}` map,
 *        - `publishFinding(finding, urls, client)` → `{id, identifier}`,
 *        - `updateFindingStatus(fullId, {status: 'published', linearIssueId})`,
 *        - buffer a report patch appending ` — WH-… (open)` to the heading.
 *   5. After the loop, write the patched report.md, stage report.md +
 *      findings-history.jsonl, and make ONE local commit (no push).
 *
 * `--dry-run` logs the candidates (+ their artifact refs) and stops before
 * touching Linear, the filesystem, or git. Exit code is 0 on success and 1
 * if any candidate failed — partial success still commits the successes.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { parseReport, type ParsedFinding } from '../src/report/parse';
import {
  defaultFindingsHistoryPath,
  readHistory,
  updateFindingStatus,
} from '../src/state/findings-history';
import { hostArtifacts } from '../src/publish/artifacts-github';
import { LinearGraphQLClient } from '../src/publish/linear-graphql-client';
import {
  publishFinding,
  type ArtifactUrls,
  type LinearClient,
  type LinearIssueRef,
} from '../src/publish/linear';
import { patchReportHeader } from '../src/publish/report-patch';
import type { Finding } from '../src/types/index';

const log = (msg: string): void => {
  console.log(`[publish] ${msg}`);
};

/** Publisher-side config, read directly from env (`loadConfig` pulls in
 *  Appium/Anthropic requirements we don't need here). */
interface PublishEnv {
  linearApiKey?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  artifactBranch: string;
  artifactHostMode: 'github-branch' | 's3';
}

function readEnv(env: Record<string, string | undefined> = process.env): PublishEnv {
  return {
    linearApiKey: env.LINEAR_API_KEY,
    linearTeamId: env.LINEAR_TEAM_ID,
    linearProjectId: env.LINEAR_PROJECT_ID,
    artifactBranch: env.ARTIFACT_GITHUB_BRANCH ?? 'android-qa-artifacts',
    artifactHostMode: (env.ARTIFACT_HOST_MODE ?? 'github-branch') as 'github-branch' | 's3',
  };
}

interface ParsedArgs {
  runId: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: Partial<ParsedArgs> = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run') {
      const v = argv[i + 1];
      if (!v) throw new Error('--run requires a runId argument');
      out.runId = v;
      i += 1;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '-h' || a === '--help') {
      throw new Error(
        'usage: android-qa:publish --run <runId> [--dry-run]',
      );
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!out.runId) {
    throw new Error(
      'missing --run <runId> (e.g. run-20260421-0830-ab12)',
    );
  }
  return out as ParsedArgs;
}

/** Absolute path of `<repo>/output/android-qa/<runId>`. `bin/publish.ts`
 *  lives at `packages/android-qa/bin/` so we climb three `..` to the repo
 *  root — same pattern as `bin/explore.ts`. */
function runDirFor(runId: string): string {
  return join(
    fileURLToPath(new URL('../../../output/android-qa', import.meta.url)),
    runId,
  );
}

/** Repo root — used for the local commit. Mirror of `runDirFor`. */
function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/**
 * Find the history entry whose full 16-hex id begins with the 4-hex body of
 * `displayId`. Prefer the most recent match — findings get reborn across
 * runs with the same prefix (content-addressed id collision), and the latest
 * copy carries the current status.
 *
 * Returns `null` when nothing matches — the caller logs and skips.
 */
function matchHistory(displayId: string, history: Finding[]): Finding | null {
  const body = displayId.replace(/^f-/, '');
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].id.startsWith(body)) return history[i];
  }
  return null;
}

/**
 * Resolve the finding's `artifactRefs` (relative to `runDir`) into the
 * `screenshot | clip | logcat` keys that `hostArtifacts` + `publishFinding`
 * consume. The `video`→`clip` rename crosses the storage/presentation
 * boundary — internally we call it "video" (the raw screenrecord mp4),
 * externally it's the "clip" attached to the issue.
 *
 * Returns only entries whose files exist on disk; missing artifacts are
 * skipped silently (agent may have been unable to capture them).
 */
function collectArtifactPaths(
  finding: Finding,
  runDir: string,
): Partial<Record<'screenshot' | 'clip' | 'logcat', string>> {
  const refs = finding.artifactRefs ?? {};
  const out: Partial<Record<'screenshot' | 'clip' | 'logcat', string>> = {};
  const pairs: Array<[keyof typeof out, string | undefined]> = [
    ['screenshot', refs.screenshot],
    ['clip', refs.video],
    ['logcat', refs.logcat],
  ];
  for (const [key, rel] of pairs) {
    if (!rel) continue;
    const abs = join(runDir, rel);
    if (existsSync(abs)) out[key] = abs;
  }
  return out;
}

/** Build the screen-ref string that matches `renderFindingBlock`'s output. */
function makeScreenRef(finding: Finding, parsed: ParsedFinding): string {
  const activity = parsed.screen ?? finding.screenFp;
  return `\`${activity}\` (fp: \`${finding.screenFp.slice(0, 6)}…\`)`;
}

interface Candidate {
  parsed: ParsedFinding;
  finding: Finding;
  artifactPaths: Partial<Record<'screenshot' | 'clip' | 'logcat', string>>;
}

function summarise(c: Candidate): string {
  const keys = Object.keys(c.artifactPaths).sort().join(',') || 'none';
  return `${c.parsed.id} [${c.parsed.severity}] artifacts=${keys} ${c.parsed.summary}`;
}

async function publishOne(
  candidate: Candidate,
  client: LinearClient,
  env: PublishEnv,
  runId: string,
  repoRootPath: string,
): Promise<LinearIssueRef> {
  const paths = Object.values(candidate.artifactPaths).filter(
    (v): v is string => typeof v === 'string',
  );

  let urlMap: Record<string, string> = {};
  if (paths.length > 0) {
    if (env.artifactHostMode !== 'github-branch') {
      throw new Error(
        `unsupported ARTIFACT_HOST_MODE=${env.artifactHostMode} (only "github-branch" is implemented)`,
      );
    }
    urlMap = await hostArtifacts(paths, {
      branch: env.artifactBranch,
      runId,
      repoRoot: repoRootPath,
    });
  }

  const artifactUrls: ArtifactUrls = {};
  for (const key of ['screenshot', 'clip', 'logcat'] as const) {
    const abs = candidate.artifactPaths[key];
    if (abs && urlMap[abs]) artifactUrls[key] = urlMap[abs];
  }

  return publishFinding(
    candidate.finding,
    artifactUrls,
    client,
    {
      teamId: env.linearTeamId,
      projectId: env.linearProjectId,
      screenRef: makeScreenRef(candidate.finding, candidate.parsed),
    },
  );
}

async function main(): Promise<number> {
  const { runId, dryRun } = parseArgs(process.argv.slice(2));
  const env = readEnv();
  const runDir = runDirFor(runId);
  const reportPath = join(runDir, 'report.md');
  const rootPath = repoRoot();

  log(`runId=${runId} dryRun=${dryRun}`);
  log(`runDir=${runDir}`);

  if (!existsSync(reportPath)) {
    console.error(`[publish] report not found: ${reportPath}`);
    return 1;
  }

  const reportRaw = await readFile(reportPath, 'utf8');
  const parsed = parseReport(reportRaw);
  const history = await readHistory();
  log(
    `parsed findings=${parsed.length} history=${history.length}`,
  );

  const ticked = parsed.filter((p) => p.checked && !p.linearIssueId);
  if (ticked.length === 0) {
    log('no unpublished ticked findings — nothing to do');
    return 0;
  }

  const candidates: Candidate[] = [];
  for (const p of ticked) {
    const finding = matchHistory(p.id, history);
    if (!finding) {
      console.error(`[publish] ${p.id}: no matching entry in findings-history`);
      continue;
    }
    candidates.push({
      parsed: p,
      finding,
      artifactPaths: collectArtifactPaths(finding, runDir),
    });
  }

  log(`candidates=${candidates.length} (ticked=${ticked.length})`);
  for (const c of candidates) log(`  ${summarise(c)}`);

  if (dryRun) {
    log('dry-run: stopping before Linear / filesystem changes');
    return 0;
  }

  if (!env.linearApiKey) {
    console.error('[publish] LINEAR_API_KEY is not set');
    return 1;
  }

  const client: LinearClient = new LinearGraphQLClient({
    apiKey: env.linearApiKey,
  });

  let exitCode = 0;
  let patchedReport = reportRaw;

  for (const c of candidates) {
    try {
      const ref = await publishOne(c, client, env, runId, rootPath);
      log(`  ${c.parsed.id} → ${ref.identifier} (${ref.id})`);

      // Persist FIRST, then patch the report. If the history write fails we
      // haven't corrupted the report; the next re-run will re-publish and
      // generate a duplicate issue — acceptable, since `updateFindingStatus`
      // only throws on I/O errors (rare) and the alternative (stale report +
      // unupdated history) is worse.
      await updateFindingStatus(c.finding.id, {
        status: 'published',
        linearIssueId: ref.identifier,
      });
      patchedReport = patchReportHeader(
        patchedReport,
        c.parsed.id,
        ref.identifier,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[publish] ${c.parsed.id}: ${message}`);
      exitCode = 1;
    }
  }

  // Only touch report.md / git if at least one publish actually succeeded —
  // otherwise the commit would be empty and `simple-git` would throw.
  if (patchedReport !== reportRaw) {
    await writeFile(reportPath, patchedReport, 'utf8');
    log(`report patched: ${reportPath}`);

    try {
      const git = simpleGit(rootPath);
      const relReport = `output/android-qa/${runId}/report.md`;
      const relHistory = 'packages/android-qa/state/findings-history.jsonl';
      const toAdd: string[] = [relReport];
      if (existsSync(join(rootPath, relHistory))) toAdd.push(relHistory);
      await git.add(toAdd);
      await git.commit(`android-qa: publish ${runId}`);
      log(`committed: ${toAdd.join(', ')}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[publish] git commit failed: ${message}`);
      exitCode = 1;
    }
  }

  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[publish] unhandled: ${message}`);
    process.exit(1);
  },
);
