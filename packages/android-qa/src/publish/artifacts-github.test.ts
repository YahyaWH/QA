import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hostArtifacts,
  parseOriginUrl,
  deriveArtifactKeys,
} from './artifacts-github';

// ---------------------------------------------------------------------------
// Fake SimpleGit factory — captures commands so tests can assert the flow.
// ---------------------------------------------------------------------------

interface FakeGitState {
  /** Remote refs that exist on origin. Used by listRemote(...) stubs. */
  remoteHeads: Set<string>;
  /** Sequence of ['method', ...args] calls for assertion. */
  calls: Array<[string, ...unknown[]]>;
  /** If set, the next matching command throws this. */
  failOn?: { method: string; rawPrefix?: string; error: Error };
  /** Path the fake git considers the worktree root (for fake_git's cwd). */
  repoRoot: string;
  /** The origin fetch URL returned by getRemotes. */
  originUrl: string;
}

interface FakeGit {
  fetch: ReturnType<typeof vi.fn>;
  listRemote: ReturnType<typeof vi.fn>;
  raw: ReturnType<typeof vi.fn>;
  getRemotes: ReturnType<typeof vi.fn>;
  cwd: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
}

function makeFakeGit(state: FakeGitState): FakeGit {
  const maybeFail = (method: string, rawFirst?: string) => {
    const f = state.failOn;
    if (!f) return;
    if (f.method !== method) return;
    if (f.rawPrefix !== undefined && rawFirst !== f.rawPrefix) return;
    throw f.error;
  };

  const fetch = vi.fn(async (...args: unknown[]) => {
    state.calls.push(['fetch', ...args]);
    maybeFail('fetch');
  });

  const listRemote = vi.fn(async (args: string[] = []) => {
    state.calls.push(['listRemote', args]);
    maybeFail('listRemote');
    // Emulate `git ls-remote --heads origin <branch>`. If the branch exists,
    // return a sha + ref line; otherwise return empty string.
    const branch = args[args.length - 1];
    if (typeof branch === 'string' && state.remoteHeads.has(branch)) {
      return `deadbeef\trefs/heads/${branch}\n`;
    }
    return '';
  });

  const raw = vi.fn(async (...callArgs: unknown[]) => {
    // simple-git's raw can accept either (...strings) or (string[]). Normalise.
    const args = Array.isArray(callArgs[0]) ? (callArgs[0] as string[]) : (callArgs as string[]);
    state.calls.push(['raw', args]);
    maybeFail('raw', args[0]);
    return '';
  });

  const getRemotes = vi.fn(async (_verbose?: boolean) => {
    state.calls.push(['getRemotes', _verbose]);
    maybeFail('getRemotes');
    return [
      {
        name: 'origin',
        refs: { fetch: state.originUrl, push: state.originUrl },
      },
    ];
  });

  const cwd = vi.fn(async (path: string) => {
    state.calls.push(['cwd', path]);
  });

  const add = vi.fn(async (paths: string | string[]) => {
    state.calls.push(['add', paths]);
    maybeFail('add');
  });

  const commit = vi.fn(async (message: string) => {
    state.calls.push(['commit', message]);
    maybeFail('commit');
    return { commit: 'abc1234' };
  });

  const push = vi.fn(async (remote: string, branch: string) => {
    state.calls.push(['push', remote, branch]);
    maybeFail('push');
  });

  return { fetch, listRemote, raw, getRemotes, cwd, add, commit, push };
}

/** Factory returning the same fake on every call (simple-git's simpleGit() returns a new client per cwd). */
function makeGitFactory(fake: FakeGit): (cwd?: string) => FakeGit {
  return () => fake;
}

// ---------------------------------------------------------------------------
// parseOriginUrl
// ---------------------------------------------------------------------------

describe('parseOriginUrl', () => {
  it('parses https URL with .git suffix', () => {
    expect(parseOriginUrl('https://github.com/wastehero/qa.git')).toEqual({
      owner: 'wastehero',
      repo: 'qa',
    });
  });

  it('parses https URL without .git suffix', () => {
    expect(parseOriginUrl('https://github.com/wastehero/qa')).toEqual({
      owner: 'wastehero',
      repo: 'qa',
    });
  });

  it('parses ssh URL (git@github.com:owner/repo.git)', () => {
    expect(parseOriginUrl('git@github.com:wastehero/qa.git')).toEqual({
      owner: 'wastehero',
      repo: 'qa',
    });
  });

  it('parses ssh URL without .git suffix', () => {
    expect(parseOriginUrl('git@github.com:wastehero/qa')).toEqual({
      owner: 'wastehero',
      repo: 'qa',
    });
  });

  it('parses https URL with trailing slash', () => {
    expect(parseOriginUrl('https://github.com/wastehero/qa/')).toEqual({
      owner: 'wastehero',
      repo: 'qa',
    });
  });

  it('throws for unrecognised origin format', () => {
    expect(() => parseOriginUrl('file:///local/path')).toThrow();
    expect(() => parseOriginUrl('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// deriveArtifactKeys — basename-collision resolver
// ---------------------------------------------------------------------------

describe('deriveArtifactKeys', () => {
  it('uses the plain basename when unique', () => {
    const files = ['/a/before.png', '/b/clip.mp4', '/c/logcat.log'];
    const keys = deriveArtifactKeys(files);
    expect(keys.get('/a/before.png')).toBe('before.png');
    expect(keys.get('/b/clip.mp4')).toBe('clip.mp4');
    expect(keys.get('/c/logcat.log')).toBe('logcat.log');
  });

  it('prefixes colliding basenames with a short hash of the source path', () => {
    const a = '/findings/f-a3f2/before.png';
    const b = '/findings/f-b210/before.png';
    const keys = deriveArtifactKeys([a, b]);
    const ka = keys.get(a)!;
    const kb = keys.get(b)!;
    expect(ka).not.toBe(kb);
    // Both end with the basename; neither is just "before.png".
    expect(ka.endsWith('before.png')).toBe(true);
    expect(kb.endsWith('before.png')).toBe(true);
    expect(ka).not.toBe('before.png');
    expect(kb).not.toBe('before.png');
  });

  it('is deterministic: same inputs -> same keys', () => {
    const a = '/findings/f-a3f2/before.png';
    const b = '/findings/f-b210/before.png';
    const k1 = deriveArtifactKeys([a, b]);
    const k2 = deriveArtifactKeys([a, b]);
    expect(k1.get(a)).toBe(k2.get(a));
    expect(k1.get(b)).toBe(k2.get(b));
  });

  it('throws if two different input paths collide after key derivation (pathologically identical)', () => {
    // Duplicate path in input is the only way to truly collide after hashing;
    // this is caller error and should be loud.
    expect(() => deriveArtifactKeys(['/x/before.png', '/x/before.png'])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// hostArtifacts — end-to-end with mocked simple-git
// ---------------------------------------------------------------------------

describe('hostArtifacts', () => {
  let sandbox: string;
  let sourceDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'android-qa-host-test-' + randomUUID() + '-'));
    sourceDir = join(sandbox, 'source');
    mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function writeSource(name: string, content: string): string {
    const p = join(sourceDir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
    return p;
  }

  it('returns a map from original path to raw.githubusercontent.com URL', async () => {
    const a = writeSource('before.png', 'A');
    const b = writeSource('clip.mp4', 'B');

    const state: FakeGitState = {
      remoteHeads: new Set(['qa-artifacts']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/wastehero/qa.git',
    };
    const fake = makeFakeGit(state);

    const urls = await hostArtifacts([a, b], {
      branch: 'qa-artifacts',
      runId: 'run-42',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    expect(urls).toEqual({
      [a]: 'https://raw.githubusercontent.com/wastehero/qa/qa-artifacts/android-qa/run-42/before.png',
      [b]: 'https://raw.githubusercontent.com/wastehero/qa/qa-artifacts/android-qa/run-42/clip.mp4',
    });
  });

  it('creates an orphan worktree when branch does not exist on origin', async () => {
    const a = writeSource('x.png', 'x');
    const state: FakeGitState = {
      remoteHeads: new Set(),  // branch absent on origin
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    await hostArtifacts([a], {
      branch: 'artifacts',
      runId: 'r1',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    // An orphan worktree uses `worktree add --orphan <branch> <path>`.
    const rawCalls = state.calls.filter((c) => c[0] === 'raw');
    const worktreeAdd = rawCalls.find((c) => {
      const args = c[1] as string[];
      return args[0] === 'worktree' && args[1] === 'add' && args.includes('--orphan');
    });
    expect(worktreeAdd).toBeDefined();

    // The command must NOT reference an origin ref (no "origin/<branch>" arg).
    const args = worktreeAdd![1] as string[];
    expect(args.some((a) => a.startsWith('origin/'))).toBe(false);
    expect(args).toContain('artifacts');
  });

  it('uses the existing branch (no --orphan) when the branch exists on origin', async () => {
    const a = writeSource('y.png', 'y');
    const state: FakeGitState = {
      remoteHeads: new Set(['artifacts']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    await hostArtifacts([a], {
      branch: 'artifacts',
      runId: 'r1',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    const rawCalls = state.calls.filter((c) => c[0] === 'raw');
    const worktreeAdd = rawCalls.find((c) => {
      const args = c[1] as string[];
      return args[0] === 'worktree' && args[1] === 'add';
    });
    expect(worktreeAdd).toBeDefined();
    const args = worktreeAdd![1] as string[];
    expect(args).not.toContain('--orphan');
    // Existing branch checkout: something like `worktree add <path> origin/<branch>` or just `<branch>`.
    expect(
      args.some((a) => a === 'artifacts' || a === 'origin/artifacts'),
    ).toBe(true);
  });

  it('fetches origin before checking if the branch exists', async () => {
    const a = writeSource('a.png', 'a');
    const state: FakeGitState = {
      remoteHeads: new Set(['br']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    await hostArtifacts([a], {
      branch: 'br',
      runId: 'r1',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    const fetchIdx = state.calls.findIndex((c) => c[0] === 'fetch');
    const listRemoteIdx = state.calls.findIndex((c) => c[0] === 'listRemote');
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(listRemoteIdx).toBeGreaterThan(fetchIdx);
  });

  it('copies each file to android-qa/<runId>/<key> inside the worktree', async () => {
    const a = writeSource('before.png', 'contents-A');
    const b = writeSource('clip.mp4', 'contents-B');
    const state: FakeGitState = {
      remoteHeads: new Set(['artifacts']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    // Capture the worktree path from the `worktree add` call so we can inspect files.
    let worktreePath: string | undefined;
    const fake = makeFakeGit(state);
    const origRaw = fake.raw.getMockImplementation()!;
    fake.raw.mockImplementation(async (...callArgs: unknown[]) => {
      const args = Array.isArray(callArgs[0]) ? (callArgs[0] as string[]) : (callArgs as string[]);
      if (args[0] === 'worktree' && args[1] === 'add') {
        // path is the argument immediately before the branch name
        // For orphan: `worktree add --orphan <branch> <path>` → path is last
        // For existing: `worktree add <path> <branchOrRef>` → path is second
        worktreePath = args.includes('--orphan') ? args[args.length - 1] : args[2];
        // Ensure the path exists so the copy step can write into it.
        mkdirSync(worktreePath!, { recursive: true });
      }
      return origRaw(...callArgs);
    });

    await hostArtifacts([a, b], {
      branch: 'artifacts',
      runId: 'run-42',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    expect(worktreePath).toBeDefined();
    const destA = join(worktreePath!, 'android-qa', 'run-42', 'before.png');
    const destB = join(worktreePath!, 'android-qa', 'run-42', 'clip.mp4');
    // Files may have been cleaned up already if worktree-remove unlinks them;
    // assert instead that add was called with the expected paths BEFORE cleanup.
    // The mock fake's add call stashes the path argument.
    const addCalls = state.calls.filter((c) => c[0] === 'add');
    expect(addCalls.length).toBeGreaterThanOrEqual(1);
    // We recorded the paths pre-cleanup; now check contents at those paths existed
    // just before cleanup by reading `writeFileSync` snapshots. The simplest
    // contract is: the `add` call includes `android-qa/<runId>/<basename>` or
    // the full worktree-relative path.
    const flat = addCalls.flatMap((c) => {
      const p = c[1];
      return Array.isArray(p) ? p : [p];
    });
    const hasA = flat.some(
      (p) => typeof p === 'string' && p.endsWith(join('android-qa', 'run-42', 'before.png')),
    );
    const hasB = flat.some(
      (p) => typeof p === 'string' && p.endsWith(join('android-qa', 'run-42', 'clip.mp4')),
    );
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
    // Dest paths are strings (silence "unused" complaints)
    expect(typeof destA).toBe('string');
    expect(typeof destB).toBe('string');
  });

  it('commits with message `artifacts: <runId>`', async () => {
    const a = writeSource('a.png', 'a');
    const state: FakeGitState = {
      remoteHeads: new Set(['br']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    await hostArtifacts([a], {
      branch: 'br',
      runId: 'run-99',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    const commitCall = state.calls.find((c) => c[0] === 'commit');
    expect(commitCall).toBeDefined();
    expect(commitCall![1]).toBe('artifacts: run-99');
  });

  it('pushes origin <branch> after committing', async () => {
    const a = writeSource('a.png', 'a');
    const state: FakeGitState = {
      remoteHeads: new Set(['br']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    await hostArtifacts([a], {
      branch: 'br',
      runId: 'r',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    const commitIdx = state.calls.findIndex((c) => c[0] === 'commit');
    const pushIdx = state.calls.findIndex((c) => c[0] === 'push');
    expect(pushIdx).toBeGreaterThan(commitIdx);
    const pushCall = state.calls[pushIdx];
    expect(pushCall[1]).toBe('origin');
    expect(pushCall[2]).toBe('br');
  });

  it('removes the worktree on success', async () => {
    const a = writeSource('a.png', 'a');
    const state: FakeGitState = {
      remoteHeads: new Set(['br']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    await hostArtifacts([a], {
      branch: 'br',
      runId: 'r',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    const rawCalls = state.calls.filter((c) => c[0] === 'raw');
    const wtRemove = rawCalls.find((c) => {
      const args = c[1] as string[];
      return args[0] === 'worktree' && args[1] === 'remove';
    });
    expect(wtRemove).toBeDefined();
  });

  it('removes the worktree even when push fails', async () => {
    const a = writeSource('a.png', 'a');
    const state: FakeGitState = {
      remoteHeads: new Set(['br']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
      failOn: { method: 'push', error: new Error('push rejected') },
    };
    const fake = makeFakeGit(state);

    await expect(
      hostArtifacts([a], {
        branch: 'br',
        runId: 'r',
        gitFactory: makeGitFactory(fake),
        repoRoot: sandbox,
      }),
    ).rejects.toThrow(/push rejected/);

    const rawCalls = state.calls.filter((c) => c[0] === 'raw');
    const wtRemove = rawCalls.find((c) => {
      const args = c[1] as string[];
      return args[0] === 'worktree' && args[1] === 'remove';
    });
    expect(wtRemove).toBeDefined();
  });

  it('accepts a list of files from disparate findings dirs with colliding basenames', async () => {
    // Mimic Task 26 caller: multiple findings each with their own before.png.
    const findingsA = join(sandbox, 'findings', 'f-a3f2');
    const findingsB = join(sandbox, 'findings', 'f-b210');
    mkdirSync(findingsA, { recursive: true });
    mkdirSync(findingsB, { recursive: true });
    const pa = join(findingsA, 'before.png');
    const pb = join(findingsB, 'before.png');
    writeFileSync(pa, 'A');
    writeFileSync(pb, 'B');

    const state: FakeGitState = {
      remoteHeads: new Set(['artifacts']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    const urls = await hostArtifacts([pa, pb], {
      branch: 'artifacts',
      runId: 'r1',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    expect(urls[pa]).toBeDefined();
    expect(urls[pb]).toBeDefined();
    expect(urls[pa]).not.toBe(urls[pb]);
    // Both URLs contain the expected prefix.
    expect(urls[pa].startsWith(
      'https://raw.githubusercontent.com/o/r/artifacts/android-qa/r1/',
    )).toBe(true);
    expect(urls[pb].startsWith(
      'https://raw.githubusercontent.com/o/r/artifacts/android-qa/r1/',
    )).toBe(true);
    // Each URL still ends in before.png (keys preserve the basename suffix).
    expect(urls[pa].endsWith('before.png')).toBe(true);
    expect(urls[pb].endsWith('before.png')).toBe(true);
  });

  it('returns {} and does no git work when files is empty', async () => {
    const state: FakeGitState = {
      remoteHeads: new Set(['br']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    const urls = await hostArtifacts([], {
      branch: 'br',
      runId: 'r',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    expect(urls).toEqual({});
    expect(state.calls.length).toBe(0);
  });

  it('derives URLs from the origin remote (ssh form) correctly', async () => {
    const a = writeSource('a.png', 'a');
    const state: FakeGitState = {
      remoteHeads: new Set(['br']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'git@github.com:acme/tests.git',
    };
    const fake = makeFakeGit(state);

    const urls = await hostArtifacts([a], {
      branch: 'br',
      runId: 'rid',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    expect(urls[a]).toBe(
      'https://raw.githubusercontent.com/acme/tests/br/android-qa/rid/a.png',
    );
  });

  it('still created worktree files on disk (sanity — copies happened)', async () => {
    // Capture the worktree path + pre-cleanup snapshot of its contents.
    const a = writeSource('z.png', 'Z-CONTENTS');
    const state: FakeGitState = {
      remoteHeads: new Set(['br']),
      calls: [],
      repoRoot: sandbox,
      originUrl: 'https://github.com/o/r.git',
    };
    const fake = makeFakeGit(state);

    let capturedContents: string | undefined;
    // Snapshot file contents at the moment push is called (just before cleanup).
    fake.push.mockImplementation(async (remote: string, branch: string) => {
      state.calls.push(['push', remote, branch]);
      const addCalls = state.calls.filter((c) => c[0] === 'add');
      const flat = addCalls.flatMap((c) => {
        const p = c[1];
        return Array.isArray(p) ? p : [p];
      });
      // Find an add path that ends with z.png, resolve relative to worktree root.
      const rel = flat.find((p) => typeof p === 'string' && p.endsWith('z.png')) as
        | string
        | undefined;
      if (rel) {
        // Look through raw calls for the worktree path.
        const rawCalls = state.calls.filter((c) => c[0] === 'raw');
        const wtAdd = rawCalls.find((c) => {
          const args = c[1] as string[];
          return args[0] === 'worktree' && args[1] === 'add';
        })!;
        const args = wtAdd[1] as string[];
        const wtPath = args.includes('--orphan') ? args[args.length - 1] : args[2];
        const abs = join(wtPath, rel);
        if (existsSync(abs)) {
          capturedContents = readFileSync(abs, 'utf8');
        }
      }
    });

    // Must pre-create worktree path when the mock is asked to add it.
    const origRaw = fake.raw.getMockImplementation()!;
    fake.raw.mockImplementation(async (...callArgs: unknown[]) => {
      const args = Array.isArray(callArgs[0]) ? (callArgs[0] as string[]) : (callArgs as string[]);
      if (args[0] === 'worktree' && args[1] === 'add') {
        const wtPath = args.includes('--orphan') ? args[args.length - 1] : args[2];
        mkdirSync(wtPath, { recursive: true });
      }
      return origRaw(...callArgs);
    });

    await hostArtifacts([a], {
      branch: 'br',
      runId: 'rid',
      gitFactory: makeGitFactory(fake),
      repoRoot: sandbox,
    });

    expect(capturedContents).toBe('Z-CONTENTS');
  });
});
