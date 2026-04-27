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
 * Inputs the evaluate step needs from the perceive layer. The qa-server
 * computes screen fingerprint diffing and logcat delta, so this accepts them
 * as a struct rather than re-deriving here.
 *
 * The vision pass that used to run via Claude API was removed when the
 * skill-driven flow took over — Claude Code reviews screenshots natively.
 * Everything here is purely deterministic.
 */
export interface EvaluateContext {
  currentScreenFp: Fingerprint;
  /** null if perceive failed — we still run the logcat scan in that case. */
  currentTree: ViewNode | null;
  /** Raw logcat lines since the previous turn (e.g. from LogcatTail.getDelta). */
  logcatDelta: string[];
  /** Device window size in absolute pixels. Required for bounds-overflow scan;
   *  pass `null` to skip that scan when window size isn't known. */
  windowSize: { width: number; height: number } | null;
}

/**
 * Run the deterministic evaluation pass for a perceived turn. Six scan
 * families, each emitting `RawFinding`s that get tupled into `Finding`s and
 * dedup'd:
 *
 *   - logcat — `FATAL EXCEPTION`, `ANR`, `OutOfMemoryError`, `Skipped N frames`,
 *     `StrictMode policy violation`, HTTP `5\d\d` mentions
 *   - tree text — error banners (`something went wrong` / `error` / etc.)
 *   - bounds-overflow — visible elements whose `bounds` extend past the device
 *     window (cut-off content / layout regression)
 *   - unlabeled clickables — clickable+visible+enabled element with no `text`
 *     and no `contentDesc` (a11y / UX issue)
 *   - dead buttons — element that has been tapped multiple times across runs
 *     and every recorded outcome is a self-loop (interactive in appearance,
 *     no effect)
 *   - frozen UI — last several turns all on the same fingerprint with no
 *     forward progress (stuck, possible hang)
 *
 * Findings are deduplicated by `(screenFp, element, category)` so the same
 * banner detected by both logcat and tree-text scans isn't double-reported.
 */
export function evaluate(state: SessionState, ctx: EvaluateContext): Finding[] {
  const raw: RawFinding[] = [];

  raw.push(...scanLogcat(ctx.logcatDelta));
  if (ctx.currentTree !== null) {
    raw.push(...scanTree(ctx.currentTree));
    if (ctx.windowSize !== null) {
      raw.push(...scanBoundsOverflow(ctx.currentTree, ctx.windowSize));
    }
    raw.push(...scanUnlabeledClickables(ctx.currentTree));
  }
  raw.push(...scanDeadButtons(state, ctx.currentScreenFp));
  raw.push(...scanFrozenUI(state, ctx.currentScreenFp));

  const findings: Finding[] = raw.map((r) => ({
    id: makeFindingId(state.runId, ctx.currentScreenFp, r.element, r.category, r.summary),
    runId: state.runId,
    screenFp: ctx.currentScreenFp,
    element: r.element,
    category: r.category,
    severity: r.severity,
    summary: r.summary,
    reasoning: r.reasoning,
    status: 'new',
  }));

  return dedupeByTuple(findings);
}

/**
 * Deterministic, content-addressed Finding id. Stable under scan-order
 * reordering so `findings-history.jsonl` can treat the same logical finding
 * consistently across runs. 16-char SHA-1 hex prefix is collision-resistant
 * enough for a single exploration session. Exported so qa-server's
 * `POST /finding` (skill-filed findings) uses the same id scheme.
 */
export function makeFindingId(
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

// ---------------------------------------------------------------------------
// Logcat scans
// ---------------------------------------------------------------------------

/**
 * Scan raw logcat lines for several patterns that map to user-impacting bugs.
 * One match per line wins — if a line contains FATAL EXCEPTION we don't also
 * report it as an ANR.
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
      continue;
    }
    if (line.includes('OutOfMemoryError') || /low memory/i.test(line)) {
      out.push({
        element: null,
        category: 'A',
        severity: 'critical',
        summary: 'OutOfMemoryError / low-memory event in logcat',
        reasoning: `logcat: ${line.trim()}`,
      });
      continue;
    }
    const skippedMatch = line.match(/Skipped (\d+) frames/);
    if (skippedMatch) {
      const n = Number(skippedMatch[1]);
      if (n >= 30) {
        out.push({
          element: null,
          category: 'D',
          severity: n >= 100 ? 'med' : 'low',
          summary: `Skipped ${n} frames — UI thread jank`,
          reasoning: `logcat: ${line.trim()}`,
        });
        continue;
      }
    }
    if (line.includes('StrictMode policy violation')) {
      out.push({
        element: null,
        category: 'D',
        severity: 'low',
        summary: 'StrictMode policy violation (main-thread I/O or leaked resource)',
        reasoning: `logcat: ${line.trim()}`,
      });
      continue;
    }
    // HTTP 5xx — require explicit HTTP context to avoid matching PID columns
    // or other 3-digit numbers that happen to start with 5. Three accepted
    // shapes:
    //   - `HTTP/1.1 5xx`              (server response line)
    //   - `OkHttp ... <5xx>`           (Android's HTTP client logs status)
    //   - `5xx <reason phrase>`        (e.g. "503 Service Unavailable")
    const httpFail =
      line.match(/HTTP\/\d\.\d (5\d{2})\b/) ??
      line.match(/\bOkHttp\b[^\n]*?\b(5\d{2})\b/) ??
      line.match(/\b(5\d{2})\s+(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|HTTP Version Not Supported|Insufficient Storage|Loop Detected|Not Extended|Network Authentication Required)\b/);
    if (httpFail) {
      const url = line.match(/https?:\/\/\S+/);
      out.push({
        element: null,
        category: 'B',
        severity: 'med',
        summary: url
          ? `Backend HTTP ${httpFail[1]} on ${url[0]}`
          : `Backend HTTP ${httpFail[1]} response`,
        reasoning: `logcat: ${line.trim()}`,
      });
      continue;
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

// ---------------------------------------------------------------------------
// Tree text scan (error banners)
// ---------------------------------------------------------------------------

const HARD_FAILURE_PATTERNS: RegExp[] = [
  /something went wrong/i,
  /unable to connect/i,
  /no internet/i,
];

const SOFT_ERROR_PATTERN = /error/i;

/**
 * Walk `tree` recursively and emit a finding per visible node whose text or
 * contentDescription matches an error banner / generic-error pattern.
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
    if (m) return { category: 'A', summary: `Error banner visible: "${m[0]}"` };
  }
  const m = text.match(SOFT_ERROR_PATTERN);
  if (m) return { category: 'B', summary: `Error text visible: "${trimSnippet(text)}"` };
  return null;
}

function trimSnippet(text: string): string {
  const t = text.trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

// ---------------------------------------------------------------------------
// Bounds overflow scan — content cut off the screen
// ---------------------------------------------------------------------------

/**
 * Walk `tree` and report visible elements whose `bounds` extend past the
 * device window. Skips framework wrappers (`android:id/content`,
 * `<pkg>:id/action_bar_root`, `:id/decor_view`) — those legitimately span the
 * full screen and would trigger constantly.
 *
 * A 4px slack absorbs anti-aliasing / sub-pixel rendering off-by-one drift.
 */
export function scanBoundsOverflow(
  tree: ViewNode,
  windowSize: { width: number; height: number },
): RawFinding[] {
  const out: RawFinding[] = [];
  const seen = new Set<string>();
  const SLACK = 4;
  const walk = (node: ViewNode): void => {
    if (node.visible && !isFrameworkWrapper(node.resourceId)) {
      const right = node.bounds.x + node.bounds.w;
      const bottom = node.bounds.y + node.bounds.h;
      const offRight = right > windowSize.width + SLACK;
      const offBottom = bottom > windowSize.height + SLACK;
      const offLeft = node.bounds.x < -SLACK;
      const offTop = node.bounds.y < -SLACK;
      if ((offRight || offBottom || offLeft || offTop) && (node.text || node.contentDesc)) {
        const key = node.resourceId ?? `bounds:${node.bounds.x},${node.bounds.y}`;
        if (!seen.has(key)) {
          seen.add(key);
          const which = [
            offRight && 'right',
            offBottom && 'bottom',
            offLeft && 'left',
            offTop && 'top',
          ].filter(Boolean).join('/');
          out.push({
            element: node.resourceId,
            category: 'B',
            severity: 'med',
            summary: `Element extends past ${which} edge of screen`,
            reasoning: `bounds=${node.bounds.x},${node.bounds.y},${node.bounds.w}x${node.bounds.h} window=${windowSize.width}x${windowSize.height}`,
          });
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return out;
}

function isFrameworkWrapper(resourceId: string | null): boolean {
  if (!resourceId) return true;
  if (resourceId.startsWith('android:id/')) return true;
  if (/:id\/(action_bar_root|action_mode_bar_stub|action_bar_container|decor_view|content_frame)$/.test(resourceId)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Unlabeled clickables — a11y issue
// ---------------------------------------------------------------------------

/**
 * Walk `tree` and report clickable+enabled+visible elements that have neither
 * `text` nor `contentDesc`. These look interactive but TalkBack can't announce
 * what they do.
 *
 * Ignores framework wrappers (which are rarely the affordance the user
 * actually targets) and elements whose className suggests a container
 * (ScrollView, ViewGroup, FrameLayout, LinearLayout) — those carry click
 * listeners for ergonomic reasons but the visible affordance is a child node.
 */
export function scanUnlabeledClickables(tree: ViewNode): RawFinding[] {
  const out: RawFinding[] = [];
  const seen = new Set<string>();
  const containerPattern = /(ScrollView|ViewGroup|FrameLayout|LinearLayout|RecyclerView)$/;
  const walk = (node: ViewNode): void => {
    if (
      node.visible &&
      node.clickable &&
      node.enabled &&
      !node.text &&
      !node.contentDesc &&
      !isFrameworkWrapper(node.resourceId) &&
      !containerPattern.test(node.className) &&
      node.resourceId
    ) {
      if (!seen.has(node.resourceId)) {
        seen.add(node.resourceId);
        out.push({
          element: node.resourceId,
          category: 'C',
          severity: 'low',
          summary: `Clickable element has no text or content-description (a11y)`,
          reasoning: `clickable+visible+enabled, class=${node.className}, no text/contentDesc — TalkBack will announce this as the resourceId only`,
        });
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return out;
}

// ---------------------------------------------------------------------------
// Dead buttons — tapped multiple times, all outcomes self-loop
// ---------------------------------------------------------------------------

/**
 * Identify elements on the current screen that have been tapped at least
 * `MIN_TAPS` times across runs and whose every recorded outcome is a
 * self-loop (the screen never changed when they were tapped). The
 * carry-forward in `buildScreen` means `state.screens[fp].elements[id].outcomes`
 * already holds the cross-run history.
 *
 * Deliberately conservative: requires ≥5 taps and ALL outcomes self-looping.
 * A button that's a self-loop sometimes (e.g. validation failed when no input)
 * but works with proper input shouldn't trigger.
 */
export function scanDeadButtons(state: SessionState, currentFp: Fingerprint): RawFinding[] {
  const MIN_TAPS = 5;
  const screen = state.screens[currentFp];
  if (!screen) return [];
  const out: RawFinding[] = [];
  for (const [resourceId, el] of Object.entries(screen.elements)) {
    if (!el.tapped || el.outcomes.length === 0) continue;
    if (isFrameworkWrapper(resourceId)) continue;
    const tapOutcomes = el.outcomes.filter((o) => o.action === 'tap');
    if (tapOutcomes.length === 0) continue;
    const totalTaps = tapOutcomes.reduce((acc, o) => acc + o.count, 0);
    if (totalTaps < MIN_TAPS) continue;
    const allSelfLoop = tapOutcomes.every((o) => o.ledToScreen === currentFp);
    if (!allSelfLoop) continue;
    out.push({
      element: resourceId,
      category: 'B',
      severity: 'med',
      summary: 'Dead button: tapped repeatedly, screen never changes',
      reasoning: `${totalTaps} taps recorded, every outcome led back to ${currentFp.slice(0, 8)}…; element looks interactive but produces no navigation or visible state change`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frozen UI — many turns on same fingerprint, no progress
// ---------------------------------------------------------------------------

/**
 * Looking at the recent history tail, flag when the last `WINDOW` turns are
 * all on the same fingerprint AND none of them produced a fingerprint change
 * (outcomeFp is null OR equals screenFp). Indicates a stuck modal, frozen
 * webview, or a button-bash loop that's making no headway.
 *
 * Fires only at the end of the window — i.e. when history.length ≥ WINDOW and
 * all recent turns match. Avoids triggering once per turn while stuck.
 */
export function scanFrozenUI(state: SessionState, currentFp: Fingerprint): RawFinding[] {
  const WINDOW = 5;
  if (state.history.length < WINDOW) return [];
  const tail = state.history.slice(-WINDOW);
  for (const t of tail) {
    if (t.screenFp !== currentFp) return [];
    if (t.outcomeFp !== null && t.outcomeFp !== currentFp) return [];
  }
  return [
    {
      element: null,
      category: 'B',
      severity: 'high',
      summary: `UI frozen: ${WINDOW} consecutive turns on same screen with no progress`,
      reasoning: `last ${WINDOW} history entries all on fp=${currentFp.slice(0, 8)}… with no fp change — possible stuck modal, frozen webview, or non-responsive control`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

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
