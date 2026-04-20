import { z } from 'zod';
import { ClaudeClient, MalformedJsonError } from './claude';
import type {
  Category,
  Fingerprint,
  Finding,
  SessionState,
  Severity,
  ViewNode,
} from '../types/index';

/**
 * Inputs the evaluate step needs from the orchestrator. These are things the
 * orchestrator is in the best position to compute (screen-fingerprint diffing,
 * logcat delta since last turn, captured screenshot bytes), so we accept them
 * as a struct rather than re-deriving them here.
 */
export interface EvaluateContext {
  currentScreenFp: Fingerprint;
  /** null if perceive failed — we still run the logcat scan in that case. */
  currentTree: ViewNode | null;
  /** Raw logcat lines since the previous turn (e.g. from LogcatTail.getDelta). */
  logcatDelta: string[];
  /** True on the first turn this fingerprint is seen this run. */
  isNewScreen: boolean;
  /**
   * True when the orchestrator decides the tree is worth a vision pass even
   * off-cadence — empty tree, unchanged-post-action, error-looking text, etc.
   */
  treeSuspicious: boolean;
  /** null => skip vision even if one of the triggers fires. */
  screenshotBase64: string | null;
  imageMediaType: 'image/png' | 'image/jpeg';
}

export interface EvaluateConfig {
  model: string;
  /** Even off-trigger, every Nth turn gets a vision pass. 0/negative disables. */
  visionEveryNTurns: number;
}

/**
 * Zod schema for the vision response. The model is only asked to return the
 * interesting fields (category, severity, summary, element); the evaluator
 * fills in runId/screenFp/id/status/reasoning on our side.
 */
const CategorySchema: z.ZodType<Category> = z.enum(['A', 'B', 'C', 'D', 'E']);
const SeveritySchema: z.ZodType<Severity> = z.enum(['low', 'med', 'high', 'critical']);

const VisionFindingSchema = z.object({
  category: CategorySchema,
  severity: SeveritySchema,
  summary: z.string(),
  element: z.string().nullable(),
});

const VisionResponseSchema = z.object({
  findings: z.array(VisionFindingSchema),
});

const SYSTEM_PROMPT = `You are an Android QA visual auditor.

Given a screenshot of a screen from the app under test, find *concrete*
quality issues visible in the image. Stay grounded in what the pixels show —
do not speculate about things off-screen.

Categorize each issue strictly with one of these letters:
  A — hard failure (crash dialog, blank/white screen, error banner, "Something went wrong")
  B — functional bug (broken layout, cut-off text, wrong content, unresponsive-looking control)
  C — UX issue (unlabeled icon, bad contrast, hidden affordance, confusing copy)
  D — polish (alignment, spacing, minor inconsistency)
  E — suggestion (feature idea, low-confidence observation)

Severity: "critical" (blocks use), "high" (major impact), "med" (noticeable), "low" (cosmetic).

If you can identify the UI element responsible (by its visible resource id or
a stable contentDescription), put it in "element"; otherwise use null.

Respond with ONLY valid JSON matching this schema:

{
  "findings": [
    { "category": "A"|"B"|"C"|"D"|"E", "severity": "low"|"med"|"high"|"critical",
      "summary": string, "element": string | null }
  ]
}

No prose, no code fences, no commentary — JSON only. If nothing is visibly
wrong, return {"findings": []}.`;

/**
 * Run the three-source evaluation pass: logcat scan (always), tree text scan
 * (always), and an optional vision pass when one of the triggers fires. The
 * returned findings are de-duplicated by (screenFp, element, category) so the
 * orchestrator doesn't see obvious double-reports from the same turn.
 *
 * This is a SMALL dedup — Task 16 will add fuzzy summary-based dedup across
 * turns. Here we only collapse the cheap exact-tuple collision that happens
 * when e.g. a crash is detected both in logcat and "Something went wrong" on
 * the screen.
 */
export async function evaluate(
  state: SessionState,
  ctx: EvaluateContext,
  cfg: EvaluateConfig,
  claude: ClaudeClient,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let counter = 0;
  const nextId = (element: string | null, category: Category): string => {
    counter += 1;
    return `${state.runId}:${ctx.currentScreenFp}:${element ?? 'null'}:${category}:${counter}`;
  };

  // 1) Logcat scan — always.
  for (const finding of scanLogcat(ctx.logcatDelta)) {
    findings.push({
      id: nextId(finding.element, finding.category),
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

  // 2) Tree text scan — always (no-op if tree is null).
  if (ctx.currentTree !== null) {
    for (const finding of scanTree(ctx.currentTree)) {
      findings.push({
        id: nextId(finding.element, finding.category),
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

  // 3) Vision — conditional on triggers and screenshot availability.
  if (shouldRunVision(state, ctx, cfg) && ctx.screenshotBase64 !== null) {
    const visionFindings = await runVision(ctx, claude);
    for (const vf of visionFindings) {
      findings.push({
        id: nextId(vf.element, vf.category),
        runId: state.runId,
        screenFp: ctx.currentScreenFp,
        element: vf.element,
        category: vf.category,
        severity: vf.severity,
        summary: vf.summary,
        reasoning: 'vision: ' + vf.summary,
        status: 'new',
      });
    }
  }

  return dedupeByTuple(findings);
}

/**
 * Determine whether to fire the vision pass this turn. Triggers:
 *   - new screen this run,
 *   - orchestrator-flagged suspicious tree,
 *   - every Nth turn after turn 0 (so we don't also fire on the first turn
 *     when history is empty — `isNewScreen` already covers that case).
 */
function shouldRunVision(
  state: SessionState,
  ctx: EvaluateContext,
  cfg: EvaluateConfig,
): boolean {
  if (ctx.isNewScreen) return true;
  if (ctx.treeSuspicious) return true;
  if (
    cfg.visionEveryNTurns > 0 &&
    state.history.length > 0 &&
    state.history.length % cfg.visionEveryNTurns === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Interim shape for a deterministic (logcat / tree) finding before we attach
 * the orchestrator-owned fields (id, runId, screenFp, status).
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
 * as an ANR. Multiple distinct crash lines each produce their own finding so
 * the operator sees all of them, but the usual case is one per turn.
 */
function scanLogcat(lines: string[]): RawFinding[] {
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

/**
 * Pull a short human-readable reason from the tail of a logcat crash line.
 * For `... FATAL EXCEPTION: main` we keep "FATAL EXCEPTION: main"; for `... ANR in com.pkg`
 * we keep "ANR in com.pkg". Trims trailing punctuation / whitespace.
 */
function extractCrashSummary(line: string, marker: string): string {
  const idx = line.indexOf(marker);
  if (idx < 0) return marker.trim();
  const tail = line.slice(idx).trim();
  // Cap length so summaries stay one-liner friendly in reports.
  return tail.length > 120 ? `${tail.slice(0, 117)}...` : tail;
}

/** Error-banner text patterns we treat as an A (hard failure). */
const HARD_FAILURE_PATTERNS: RegExp[] = [
  /something went wrong/i,
  /unable to connect/i,
  /no internet/i,
];

/** Generic "error" mentions get B (functional bug) unless a hard-failure pattern also matched. */
const SOFT_ERROR_PATTERN = /error/i;

/**
 * Walk `tree` recursively and emit a finding per visible node whose text or
 * contentDescription matches an error banner / generic-error pattern. We dedupe
 * by node resourceId within this scan to avoid reporting the same banner twice
 * when both its text and contentDescription match.
 */
function scanTree(tree: ViewNode): RawFinding[] {
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

/**
 * Map a visible text blob to a (category, summary) pair, or null if nothing
 * matches. Hard-failure banners win over generic "error" mentions.
 */
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
 * Fire the vision pass. On any failure — schema mismatch, malformed JSON,
 * or transport error — return [] so the caller still gets the deterministic
 * findings. We never throw out of here.
 */
async function runVision(
  ctx: EvaluateContext,
  claude: ClaudeClient,
): Promise<Array<{ category: Category; severity: Severity; summary: string; element: string | null }>> {
  if (ctx.screenshotBase64 === null) return [];

  let raw: unknown;
  try {
    raw = await claude.callJsonWithImage<unknown>({
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            'Review this Android screenshot for quality issues and respond with the JSON schema described in the system prompt.',
        },
      ],
      cacheControl: true,
      imageBase64: ctx.screenshotBase64,
      imageMediaType: ctx.imageMediaType,
    });
  } catch (e) {
    if (e instanceof MalformedJsonError) {
      console.warn('[evaluate] vision malformed JSON after reprompt — skipping');
    } else {
      console.warn('[evaluate] vision call failed — skipping:', (e as Error).message);
    }
    return [];
  }

  const parsed = VisionResponseSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[evaluate] vision response failed schema validation — skipping');
    return [];
  }
  return parsed.data.findings;
}

/**
 * In-run dedup by the tuple (screenFp, element, category). First occurrence
 * wins so deterministic scans (which run first) take precedence over vision
 * when they report the same issue.
 */
function dedupeByTuple(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.screenFp}|${f.element ?? 'null'}|${f.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
