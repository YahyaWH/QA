import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { simpleGit as defaultSimpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';

/**
 * Parsed `owner/repo` pair extracted from an `origin` remote URL.
 */
export interface OwnerRepo {
  owner: string;
  repo: string;
}

/**
 * Minimal shape of the git client actually used by this module. Kept narrow
 * so tests can supply a fake without stubbing the full SimpleGit surface.
 *
 * All methods return promises (the real `simple-git` fluent chain is also
 * awaitable; each operation we care about is terminal).
 */
export interface GitLike {
  fetch(remote?: string, branch?: string): Promise<unknown>;
  listRemote(args?: string[]): Promise<string>;
  raw(args: string[]): Promise<string>;
  getRemotes(
    verbose: true,
  ): Promise<Array<{ name: string; refs: { fetch: string; push: string } }>>;
  add(paths: string | string[]): Promise<unknown>;
  commit(message: string): Promise<unknown>;
  push(remote: string, branch: string): Promise<unknown>;
}

/**
 * Factory returning a GitLike bound to a directory. Matches the shape of
 * `simple-git`'s top-level `simpleGit(cwd?: string)` export.
 */
export type GitFactory = (cwd?: string) => GitLike;

export interface HostArtifactsOptions {
  /** The artifacts branch to push to (e.g. `qa-artifacts`). Never `main`. */
  branch: string;
  /** Run identifier — used as a namespace inside the branch. */
  runId: string;
  /**
   * Path to the source git repo (so the host can read `origin` remote + fetch).
   * Defaults to `process.cwd()`. The main repo is **not** mutated; all
   * per-run work happens inside an isolated worktree.
   */
  repoRoot?: string;
  /** Dependency injection hook for tests. Defaults to the real `simple-git`. */
  gitFactory?: GitFactory;
}

/**
 * Host artifacts on a dedicated git branch and return a map of public URLs.
 *
 * The function:
 *   1. Reads the `origin` remote URL from the source repo.
 *   2. Fetches origin, then creates a worktree — orphan when the branch is
 *      missing from origin, otherwise a checkout of the existing branch.
 *   3. Copies each input file to `<worktree>/android-qa/<runId>/<key>`,
 *      where `key` is the file basename unless two inputs collide on it, in
 *      which case `<short-sha1(path)>-<basename>` is used instead to keep
 *      names unique inside the flat per-run directory.
 *   4. Stages, commits with message `artifacts: <runId>`, and pushes to
 *      `origin <branch>`.
 *   5. Tears down the worktree + its tmp dir regardless of outcome.
 *
 * Returns `{ [originalAbsPath]: publicUrl }` with URLs of the form
 *   `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/android-qa/<runId>/<key>`.
 *
 * Empty `files` short-circuits to `{}` without touching git.
 */
export async function hostArtifacts(
  files: string[],
  opts: HostArtifactsOptions,
): Promise<Record<string, string>> {
  if (files.length === 0) return {};

  const { branch, runId } = opts;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const gitFactory: GitFactory = opts.gitFactory ?? (defaultSimpleGit as unknown as GitFactory);

  // Derive one stable key per input file. Collision semantics are in
  // `deriveArtifactKeys`.
  const keys = deriveArtifactKeys(files);

  // Resolve owner/repo from origin before we create the worktree so that a
  // malformed remote fails fast.
  const sourceGit = gitFactory(repoRoot);
  const remotes = await sourceGit.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin');
  if (!origin) {
    throw new Error('hostArtifacts: no `origin` remote is configured on the source repo');
  }
  const { owner, repo } = parseOriginUrl(origin.refs.fetch);

  // Fetch first so the branch existence check is accurate.
  await sourceGit.fetch('origin');
  const branchExistsRemotely = await remoteHasBranch(sourceGit, branch);

  // Provision an isolated worktree under the OS tmp dir.
  const tmpParent = await mkdtemp(join(tmpdir(), 'android-qa-artifacts-'));
  const worktreePath = join(tmpParent, 'wt');

  try {
    if (branchExistsRemotely) {
      // `git worktree add <path> origin/<branch>` — checks out the existing
      // branch at its remote tip. We use `origin/<branch>` explicitly to
      // avoid "branch already checked out" errors if a local ref also exists.
      await sourceGit.raw(['worktree', 'add', worktreePath, `origin/${branch}`]);
      // Attach the local branch pointer so the subsequent push knows its ref.
      const wtGit = gitFactory(worktreePath);
      await wtGit.raw(['checkout', '-B', branch]);
    } else {
      // Orphan: brand-new history on the artifacts branch.
      await sourceGit.raw(['worktree', 'add', '--orphan', branch, worktreePath]);
    }

    const wtGit = gitFactory(worktreePath);
    const runDir = join(worktreePath, 'android-qa', runId);
    await mkdir(runDir, { recursive: true });

    // Copy each file and remember the relative repo path for staging.
    const relPaths: string[] = [];
    for (const src of files) {
      const key = keys.get(src);
      if (!key) {
        throw new Error(`hostArtifacts: no key derived for file ${src}`);
      }
      const dest = join(runDir, key);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      // Stage using a path relative to the worktree root; simple-git joins on
      // its own cwd.
      relPaths.push(join('android-qa', runId, key));
    }

    await wtGit.add(relPaths);
    await wtGit.commit(`artifacts: ${runId}`);
    await wtGit.push('origin', branch);

    // Build the public URL map.
    const urls: Record<string, string> = {};
    for (const src of files) {
      const key = keys.get(src)!;
      urls[src] = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/android-qa/${runId}/${key}`;
    }
    return urls;
  } finally {
    // Best-effort cleanup — we must not hide the original failure. Swallow
    // cleanup errors and log them only if they would otherwise be lost.
    try {
      await sourceGit.raw(['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // Worktree may not exist if `worktree add` itself failed; ignore.
    }
    await rm(tmpParent, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parse an `origin` remote URL into its `{ owner, repo }` components.
 *
 * Supports:
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo`
 *   - `https://github.com/owner/repo/`
 *   - `git@github.com:owner/repo.git`
 *   - `git@github.com:owner/repo`
 *
 * Throws for any other shape (file://, missing owner, etc.).
 */
export function parseOriginUrl(url: string): OwnerRepo {
  if (!url) {
    throw new Error(`parseOriginUrl: empty remote URL`);
  }

  // ssh form: git@github.com:owner/repo(.git)?
  const ssh = /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2] };
  }

  // https form: https://github.com/owner/repo(.git)?/?
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (https) {
    return { owner: https[1], repo: https[2] };
  }

  throw new Error(
    `parseOriginUrl: unrecognised origin format: ${url}. Expected github https or ssh URL.`,
  );
}

/**
 * Compute a stable key for each input file path so that files can coexist in
 * a single flat directory inside a run.
 *
 * Rules:
 *   - If every input has a unique basename, the key IS the basename.
 *   - If two inputs share a basename, each collided entry gets a
 *     `<short-sha1(src)>-<basename>` prefix; non-collided entries keep their
 *     bare basename.
 *   - Two identical input paths are caller error and throw — returning one
 *     key for two URLs would silently drop an artifact.
 */
export function deriveArtifactKeys(files: string[]): Map<string, string> {
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f)) {
      throw new Error(`deriveArtifactKeys: duplicate input path: ${f}`);
    }
    seen.add(f);
  }

  const basenameCounts = new Map<string, number>();
  for (const f of files) {
    const b = basename(f);
    basenameCounts.set(b, (basenameCounts.get(b) ?? 0) + 1);
  }

  const keys = new Map<string, string>();
  for (const f of files) {
    const b = basename(f);
    if ((basenameCounts.get(b) ?? 0) > 1) {
      const short = createHash('sha1').update(f).digest('hex').slice(0, 8);
      keys.set(f, `${short}-${b}`);
    } else {
      keys.set(f, b);
    }
  }
  return keys;
}

/**
 * True when the given branch exists on `origin` (based on `git ls-remote`).
 */
async function remoteHasBranch(git: GitLike, branch: string): Promise<boolean> {
  const out = await git.listRemote(['--heads', 'origin', branch]);
  return out.trim().length > 0;
}
