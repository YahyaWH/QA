import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Finding } from '../types/index';
import {
  FINDINGS_HISTORY_FILENAME,
  defaultFindingsHistoryPath,
  appendFindings,
  readHistory,
  updateFindingStatus,
} from './findings-history';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? 'f-default',
    runId: overrides.runId ?? 'r-1',
    screenFp: overrides.screenFp ?? 'fp-1',
    element: overrides.element ?? null,
    category: overrides.category ?? 'A',
    severity: overrides.severity ?? 'med',
    summary: overrides.summary ?? 'summary text',
    reasoning: overrides.reasoning ?? 'reasoning text',
    status: overrides.status ?? 'new',
    occurrences: overrides.occurrences ?? 1,
    ...overrides,
  };
}

describe('findings-history JSONL store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'android-qa-findings-' + randomUUID() + '-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readHistory returns [] when the file is missing', async () => {
    const target = join(dir, 'does-not-exist', 'findings-history.jsonl');
    const history = await readHistory(target);
    expect(history).toEqual([]);
  });

  it('appendFindings + readHistory round-trip', async () => {
    const target = join(dir, 'nested', 'sub', 'findings-history.jsonl');
    const a = finding({ id: 'a', runId: 'r-1', summary: 'A' });
    const b = finding({ id: 'b', runId: 'r-1', summary: 'B' });

    await appendFindings([a, b], target);
    const history = await readHistory(target);
    expect(history).toEqual([a, b]);
  });

  it('appendFindings preserves existing content across multiple calls', async () => {
    const target = join(dir, 'findings-history.jsonl');
    const a = finding({ id: 'a' });
    const b = finding({ id: 'b' });
    const c = finding({ id: 'c' });

    await appendFindings([a], target);
    await appendFindings([b, c], target);

    const history = await readHistory(target);
    expect(history).toEqual([a, b, c]);
  });

  it('appendFindings with empty array is a no-op (no file created)', async () => {
    const target = join(dir, 'findings-history.jsonl');
    await appendFindings([], target);
    expect(existsSync(target)).toBe(false);
  });

  it('each JSONL line is compact (no pretty-print, no embedded newlines)', async () => {
    const target = join(dir, 'findings-history.jsonl');
    const a = finding({ id: 'a' });
    const b = finding({ id: 'b' });

    await appendFindings([a, b], target);
    const raw = readFileSync(target, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.includes('\n')).toBe(false);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('readHistory skips the trailing newline cleanly', async () => {
    const target = join(dir, 'findings-history.jsonl');
    const a = finding({ id: 'a' });

    await appendFindings([a], target);
    const raw = readFileSync(target, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);

    const history = await readHistory(target);
    expect(history).toEqual([a]);
  });

  it('readHistory throws a descriptive error on a malformed line (1-based line number + path)', async () => {
    const target = join(dir, 'findings-history.jsonl');
    const a = finding({ id: 'a' });
    const c = finding({ id: 'c' });
    const bytes =
      JSON.stringify(a) + '\n' +
      'not-json' + '\n' +
      JSON.stringify(c) + '\n';
    writeFileSync(target, bytes, 'utf8');

    await expect(readHistory(target)).rejects.toThrow(/line 2/);
    await expect(readHistory(target)).rejects.toThrowError(target);
  });

  it('updateFindingStatus updates status and preserves line order', async () => {
    const target = join(dir, 'findings-history.jsonl');
    const a = finding({ id: 'a', status: 'new' });
    const b = finding({ id: 'b', status: 'new' });
    const c = finding({ id: 'c', status: 'new' });

    await appendFindings([a, b, c], target);
    await updateFindingStatus('b', { status: 'published' }, target);

    const history = await readHistory(target);
    expect(history).toHaveLength(3);
    expect(history[0]).toEqual(a);
    expect(history[1]).toEqual({ ...b, status: 'published' });
    expect(history[2]).toEqual(c);
  });

  it('updateFindingStatus sets linearIssueId when string, clears when null, leaves when undefined', async () => {
    const target = join(dir, 'findings-history.jsonl');
    const a = finding({ id: 'a', status: 'new' });
    await appendFindings([a], target);

    // 1) set when string
    await updateFindingStatus('a', { status: 'published', linearIssueId: 'LIN-1' }, target);
    let [updated] = await readHistory(target);
    expect(updated.linearIssueId).toBe('LIN-1');
    expect(updated.status).toBe('published');

    // 2) leave untouched when absent (undefined)
    await updateFindingStatus('a', { status: 'stale' }, target);
    [updated] = await readHistory(target);
    expect(updated.linearIssueId).toBe('LIN-1');
    expect(updated.status).toBe('stale');

    // 3) clear when null
    await updateFindingStatus('a', { status: 'new', linearIssueId: null }, target);
    [updated] = await readHistory(target);
    expect(updated.linearIssueId).toBeUndefined();
    expect('linearIssueId' in updated).toBe(false);
    expect(updated.status).toBe('new');
  });

  it('updateFindingStatus throws when id is not found (message contains id)', async () => {
    const target = join(dir, 'findings-history.jsonl');
    // empty history: file doesn't exist yet; readHistory returns []
    await expect(
      updateFindingStatus('nope', { status: 'published' }, target),
    ).rejects.toThrow(/nope/);
  });

  it('updateFindingStatus leaves no .tmp sibling on success', async () => {
    const target = join(dir, 'findings-history.jsonl');
    const a = finding({ id: 'a' });
    await appendFindings([a], target);

    await updateFindingStatus('a', { status: 'published' }, target);

    expect(existsSync(target)).toBe(true);
    expect(existsSync(target + '.tmp')).toBe(false);
  });

  it('updateFindingStatus rethrows when the write path is invalid, leaving no .tmp in place', async () => {
    // Task-spec scenario: pre-create a regular file at `dir/blocker`, then target `dir/blocker/x.jsonl`.
    // dirname(target) == blocker (a file), so mkdir(dirname(target), { recursive: true }) throws
    // ENOTDIR — which also short-circuits readHistory (ENOENT → []), hence the id lookup throws
    // "no finding with id=..." before any write is attempted. Either way, NO .tmp sibling is left
    // behind, which is the invariant we care about.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const target = join(blocker, 'x.jsonl');

    await expect(
      updateFindingStatus('any', { status: 'published' }, target),
    ).rejects.toThrow();
    expect(existsSync(target + '.tmp')).toBe(false);
  });

  it('defaultFindingsHistoryPath() resolves to <package-root>/state/findings-history.jsonl', () => {
    const resolved = defaultFindingsHistoryPath();
    const suffix = ['packages', 'android-qa', 'state', 'findings-history.jsonl'].join(sep);
    expect(resolved.endsWith(suffix)).toBe(true);
    expect(FINDINGS_HISTORY_FILENAME).toBe('findings-history.jsonl');
  });

  it('appendFindings does not mutate the input array', async () => {
    const target = join(dir, 'findings-history.jsonl');
    const input: Finding[] = [finding({ id: 'a' }), finding({ id: 'b' })];
    const snapshot = JSON.stringify(input);

    await appendFindings(input, target);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
