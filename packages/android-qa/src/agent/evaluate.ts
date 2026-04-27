import { createHash } from 'node:crypto';
import { findingTupleKey } from './finding-keys';
import type {
  Category,
  Fingerprint,
  Finding,
  SessionState,
  Severity,
  ViewNode,
} from '../types/index';

/**
 * Inputs the evaluate step needs from the perceive layer. The orchestrator (or
 * qa-server) computes screen fingerprint diffing and logcat delta, so this
 * accepts them as a struct rather than re-deriving here.
 *
 * The vision pass that used to run via Claude API was removed when the
 * skill-driven flow took over — Claude Code reviews screenshots natively. This
 * module is now purely deterministic: logcat scan + tree text scan.
 */
export interface EvaluateContext {
  currentScreenFp: Fingerprint;
  /** null if perceive failed — we still run the logcat scan in that case. */
  currentTree: ViewNode | null;
  /** Raw logcat lines since the previous turn (e.g. from LogcatTail.getDelta). */
  logcatDelta: string[];
}

/**
 * Run the deterministic evaluation pass over a perceived turn: logcat scan +
 * tree-text scan. Findings are de-duplicated by (screenFp, element, category)
 * so logcat and tree-scan don't double-report the same crash banner.
 */
export function evaluate(state: SessionState, ctx: EvaluateContext): Finding[] {
  const findings: Finding[] = [];

  for (const finding of scanLogcat(ctx.logcatDelta)) {
    findings.push({
      id: makeFindingId(
        state.runId,
        ctx.currentScreenFp,
        finding.element,
        finding.category,
        finding.summary,
      ),
      runId: state.runId,
      screenFp: ctx.currentScreenFp,
      element: finding.element,
      category: finding.category,
      severity: finding.severity,
      summary: finding.summary,
      reasoning: finding.reasoning,
      status: 'new',
    });
  }

  if (ctx.currentTree !== null) {
    for (const finding of scanTree(ctx.currentTree)) {
      findings.push({
        id: makeFindingId(
          state.runId,
          ctx.currentScreenFp,
          finding.element,
          finding.category,
          finding.summary,
        ),
        runId: state.runId,
        screenFp: ctx.currentScreenFp,
        element: finding.element,
        category: finding.category,
        severity: finding.severity,
        summary: finding.summary,
        reasoning: finding.reasoning,
        status: 'new',
      });
    }
  }

  return dedupeByTuple(findings);
}

/**
 * Deterministic, content-addressed Finding id. Stable under scan-order
 * reordering so `findings-history.jsonl` can treat the same logical finding
 * consistently across runs. 16-char SHA-1 hex prefix is collision-resistant
 * enough for a single exploration session.
 */
function makeFindingId(
  runId: string,
  screenFp: string,
  element: string | null,
  category: Category,
  summary: string,
): string {
  return createHash('sha1')
    .update(`${runId}|${screenFp}|${element ?? 'null'}|${category}|${summary}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Interim shape for a deterministic finding before the orchestrator-owned
 * fields (id, runId, screenFp, status) are attached.
 */
interface RawFinding {
  element: string | null;
  category: Category;
  severity: Severity;
  summary: string;
  reasoning: string;
}

/**
 * Scan raw logcat lines for the two fatal markers we care about. One match
 * per line wins — if a line contains FATAL EXCEPTION we don't also report it
 * as an ANR. Multiple distinct crash lines each produce their own finding.
 */
export function scanLogcat(lines: string[]): RawFinding[] {
  const out: RawFinding[] = [];
  for (const line of lines) {
    if (line.includes('FATAL EXCEPTION')) {
      out.push({
        element: null,
        category: 'A',
        severity: 'critical',
        summary: extractCrashSummary(line, 'FATAL EXCEPTION'),
        reasoning: `logcat: ${line.trim()}`,
      });
      continue;
    }
    if (line.includes('ANR in ')) {
      out.push({
        element: null,
        category: 'A',
        severity: 'high',
        summary: extractCrashSummary(line, 'ANR in '),
        reasoning: `logcat: ${line.trim()}`,
      });
    }
  }
  return out;
}

function extractCrashSummary(line: string, marker: string): string {
  const idx = line.indexOf(marker);
  if (idx < 0) return marker.trim();
  const tail = line.slice(idx).trim();
  return tail.length > 120 ? `${tail.slice(0, 117)}...` : tail;
}

const HARD_FAILURE_PATTERNS: RegExp[] = [
  /something went wrong/i,
  /unable to connect/i,
  /no internet/i,
];

const SOFT_ERROR_PATTERN = /error/i;

/**
 * Walk `tree` recursively and emit a finding per visible node whose text or
 * contentDescription matches an error banner / generic-error pattern. Dedupes
 * by node resourceId within this scan to avoid reporting the same banner twice
 * when both text and contentDescription match.
 */
export function scanTree(tree: ViewNode): RawFinding[] {
  const out: RawFinding[] = [];
  const seen = new Set<string>();

  const walk = (node: ViewNode): void => {
    if (node.visible) {
      const haystack = [node.text ?? '', node.contentDesc ?? ''].join(' ');
      const match = classifyTreeText(haystack);
      if (match) {
        const key = `${node.resourceId ?? 'null'}:${match.category}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            element: node.resourceId,
            category: match.category,
            severity: 'med',
            summary: match.summary,
            reasoning: `tree: visible node text "${haystack.trim()}"`,
          });
        }
      }
    }
    for (const child of node.children) walk(child);
  };

  walk(tree);
  return out;
}

function classifyTreeText(
  text: string,
): { category: Category; summary: string } | null {
  for (const pattern of HARD_FAILURE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      return {
        category: 'A',
        summary: `Error banner visible: "${m[0]}"`,
      };
    }
  }
  const m = text.match(SOFT_ERROR_PATTERN);
  if (m) {
    return {
      category: 'B',
      summary: `Error text visible: "${trimSnippet(text)}"`,
    };
  }
  return null;
}

function trimSnippet(text: string): string {
  const t = text.trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

/**
 * In-run dedup by the tuple (screenFp, element, category). First occurrence
 * wins so logcat scan (which runs first) takes precedence over tree scan when
 * they report the same issue.
 */
function dedupeByTuple(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = findingTupleKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
