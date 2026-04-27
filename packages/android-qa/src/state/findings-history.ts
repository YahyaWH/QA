import {
  readFile,
  appendFile,
  rename,
  open,
  unlink,
  mkdir,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, FindingStatus } from '../types/index';

export const FINDINGS_HISTORY_FILENAME = 'findings-history.jsonl';

/**
 * Default on-disk location of the findings history, resolved to
 * `<package-root>/state/findings-history.jsonl` via `import.meta.url`.
 *
 * Side-effect-free and deterministic — callers may stash the result.
 */
export function defaultFindingsHistoryPath(): string {
  // From `packages/android-qa/src/state/findings-history.ts`, climb two dirs
  // to reach the package root, then join `state/findings-history.jsonl`.
  return fileURLToPath(new URL('../../state/' + FINDINGS_HISTORY_FILENAME, import.meta.url));
}

/**
 * Append the given findings as JSONL lines (one `JSON.stringify(finding)` per
 * line + `\n`). Preserves all existing content. Creates the parent directory
 * and/or file if missing.
 *
 * Uses a streaming append (`appendFile`) — no lock needed because the pipeline
 * never runs parallel writes. A partial line from a crash is detected and
 * rejected at read time (`readHistory` throws with a 1-based line number).
 *
 * Empty `findings` array is a no-op — neither the parent directory nor the
 * file is touched.
 */
export async function appendFindings(
  findings: Finding[],
  path: string = defaultFindingsHistoryPath(),
): Promise<void> {
  if (findings.length === 0) return;

  await mkdir(dirname(path), { recursive: true });

  // One compact JSON object per line, trailing newline terminator.
  const payload = findings.map((f) => JSON.stringify(f)).join('\n') + '\n';
  await appendFile(path, payload, 'utf8');
}

/**
 * Read the full history.
 *
 * - Missing file (ENOENT) → returns `[]`.
 * - Empty file → `[]`.
 * - Each non-empty line is parsed as `Finding`. Whitespace-only lines are
 *   ignored so a trailing newline does not produce a ghost entry.
 * - A malformed line throws `Error` whose message includes the 1-based line
 *   number and the file path. Other I/O errors propagate unchanged.
 */
export async function readHistory(
  path: string = defaultFindingsHistoryPath(),
): Promise<Finding[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const lines = raw.split('\n');
  const out: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as Finding);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `findings-history: malformed JSON at line ${i + 1} of ${path}: ${message}`,
        { cause: err },
      );
    }
  }
  return out;
}

/**
 * Update exactly one finding's `status` (and optionally `linearIssueId`).
 *
 * Rewrites the whole file atomically using the canonical open → writeFile →
 * fsync → close → rename sequence, preserving line order. On any failure, the
 * `.tmp` sibling is cleaned up so the previous good file is never clobbered.
 *
 * `patch.status` is required.
 * `patch.linearIssueId` semantics:
 *   - `string`    → set the field.
 *   - `null`      → clear the field (removes it from the serialized JSON).
 *   - `undefined` → leave the field untouched.
 *
 * Throws if no finding with the given `id` is present.
 */
export async function updateFindingStatus(
  id: string,
  patch: { status: FindingStatus; linearIssueId?: string | null },
  path: string = defaultFindingsHistoryPath(),
): Promise<void> {
  const history = await readHistory(path);
  const index = history.findIndex((f) => f.id === id);
  if (index === -1) {
    throw new Error(`findings-history: no finding with id=${id} in ${path}`);
  }

  // Copy then patch, so we never mutate the array returned by readHistory.
  const existing = history[index];
  const { linearIssueId: _existingLinear, ...rest } = existing;
  let next: Finding;
  if (patch.linearIssueId === null) {
    // Explicit clear: drop the field entirely.
    next = { ...rest, status: patch.status };
  } else if (typeof patch.linearIssueId === 'string') {
    next = { ...existing, status: patch.status, linearIssueId: patch.linearIssueId };
  } else {
    // Absent / undefined: preserve existing linearIssueId (if any) unchanged.
    next = { ...existing, status: patch.status };
  }

  const rewritten = history.slice();
  rewritten[index] = next;
  const payload = rewritten.map((f) => JSON.stringify(f)).join('\n') + '\n';

  const tmp = path + '.tmp';
  try {
    await mkdir(dirname(path), { recursive: true });
    // Open tmp, write contents, fsync, close — so the bytes are durable on
    // disk BEFORE the rename publishes them as findings-history.jsonl.
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
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
