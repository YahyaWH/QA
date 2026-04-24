import { z } from 'zod';
import type { ClaudeClient } from './claude';
import type { FrontierEntry } from './frontier';
import type { Action, Finding, SessionState, ViewElement } from '../types/index';

/**
 * Inputs the decide step needs from the orchestrator to build the prompt and apply filters.
 *
 * `denyActions` uses the stringified-action format described in `stringifyAction` below —
 * e.g. `'tap:settings-btn'`, `'type:email-field'` (matches prefix, so `'type:email-field:any'`
 * is also denied), `'swipe:up'`, `'back'`, `'scrollTo:x'`, or `'done:some-reason'`.
 */
export interface DecideContext {
  state: SessionState;
  frontier: FrontierEntry[];
  denyActions: string[];
  triagedFindings: Finding[];
  /** Unused here but preserved so the orchestrator can pass its agent config unchanged. */
  visionEveryNTurns?: number;
}

export interface DecideConfig {
  model: string;
}

export interface DecideResult {
  action: Action;
  reasoning: string;
}

const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), elementId: z.string() }),
  z.object({ kind: z.literal('type'), elementId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('swipe'), direction: z.enum(['up', 'down', 'left', 'right']) }),
  z.object({ kind: z.literal('back') }),
  z.object({ kind: z.literal('scrollTo'), elementId: z.string() }),
  z.object({ kind: z.literal('done'), reason: z.string() }),
]);

const DecideResponseSchema = z.object({
  action: ActionSchema,
  reasoning: z.string(),
});

const SYSTEM_PROMPT = `You are an Android QA tester agent.

Your job each turn is to pick the single best next action that maximizes exploration
coverage of the app under test. Follow these rules strictly:

1. Prefer high-priority elements from the Frontier list provided by the orchestrator.
2. Never emit an action that appears on the Deny list.
3. If the immediately previous action did not change the screen fingerprint, do not
   repeat the same action — try a different element, a swipe, or a back action instead.
4. If there is clearly nothing useful left to probe (frontier fully exhausted,
   duplicates only), emit a {"kind":"done","reason":"..."} action with a short
   explanation.

Respond with ONLY valid JSON matching this schema:

{
  "action": <Action>,
  "reasoning": string
}

where <Action> is one of:
  {"kind":"tap","elementId":string}
  {"kind":"type","elementId":string,"text":string}
  {"kind":"swipe","direction":"up"|"down"|"left"|"right"}
  {"kind":"back"}
  {"kind":"scrollTo","elementId":string}
  {"kind":"done","reason":string}

No prose, no code fences, no commentary — JSON only.`;

/**
 * Ask Claude for the next action given the current exploration state, then apply
 * deterministic post-validation (schema, deny list, anti-repeat). Any failure falls
 * back to the highest-priority frontier entry, or `back` if the frontier is empty.
 */
export async function decide(
  ctx: DecideContext,
  cfg: DecideConfig,
  claude: ClaudeClient,
): Promise<DecideResult> {
  void cfg;
  const userMessage = buildUserMessage(ctx);

  let raw: unknown;
  try {
    raw = await claude.callJson<unknown>({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      cacheControl: true,
    });
  } catch {
    return fallback(ctx, 'fallback: claude call failed');
  }

  const parsed = DecideResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return fallback(ctx, 'fallback: schema validation failed');
  }

  const action = parsed.data.action;

  if (violatesDenyList(action, ctx.denyActions)) {
    return fallback(ctx, 'fallback: deny-listed action');
  }

  if (duplicatesLastNoProgressAction(action, ctx.state)) {
    return fallback(ctx, 'fallback: repeats last no-progress action');
  }

  return { action, reasoning: parsed.data.reasoning };
}

/**
 * Build the per-turn user message that carries all dynamic context. Kept dense but
 * human-skimmable so Claude can cross-reference elements, frontier entries, and the
 * recent history quickly.
 */
function buildUserMessage(ctx: DecideContext): string {
  const { state, frontier, denyActions, triagedFindings } = ctx;
  const currentFp = inferCurrentFingerprint(state);
  const currentScreen = currentFp !== null ? state.screens[currentFp] : undefined;
  const activity = currentScreen?.activity ?? 'unknown';

  const elementSection = renderElementSection(currentScreen, frontier, currentFp);
  const frontierSection = renderFrontier(frontier);
  const historySection = renderHistory(state);
  const findingsSection = renderFindings(triagedFindings);

  return [
    '# Current screen',
    `fingerprint: ${currentFp ?? 'unknown'}`,
    `activity: ${activity}`,
    'interactive elements:',
    elementSection,
    '',
    '# Frontier (top 20)',
    frontierSection,
    '',
    '# Recent history (last 5)',
    historySection,
    '',
    '# Budget remaining',
    `wallClockMs=${state.budget.wallClockMs} turns=${state.budget.turns}`,
    '',
    '# Deny list',
    denyActions.length > 0 ? denyActions.join(', ') : '(none)',
    '',
    '# Known triaged findings on this screen',
    findingsSection,
    '',
    'Respond ONLY with valid JSON matching the schema: { "action": {...}, "reasoning": string }',
  ].join('\n');
}

/**
 * Pick the fingerprint that represents "where the agent is right now". Prefer the
 * last history entry's outcome if present; otherwise fall back to the sole screen
 * in `state.screens` when there's only one (initial turn). Returns `null` only when
 * no screens are known yet.
 */
function inferCurrentFingerprint(state: SessionState): string | null {
  if (state.history.length > 0) {
    const last = state.history[state.history.length - 1];
    if (last.outcomeFp !== null) return last.outcomeFp;
    return last.screenFp;
  }
  const fps = Object.keys(state.screens);
  if (fps.length === 1) return fps[0];
  if (fps.length > 1) return fps[0];
  return null;
}

/**
 * Render the top 20 interactive elements on the current screen, ordered by their
 * frontier priority. Elements not in the frontier are rendered last (at the bottom
 * of the list, in their natural iteration order). Keeps the prompt compact while
 * still showing Claude everything that might be clickable.
 */
function renderElementSection(
  screen: { elements: Record<string, ViewElement> } | undefined,
  frontier: FrontierEntry[],
  currentFp: string | null,
): string {
  if (!screen) return '(no screen captured yet)';
  const priorityById = new Map<string, number>();
  for (const entry of frontier) {
    if (entry.screenFp === currentFp) {
      priorityById.set(entry.elementId, entry.priority);
    }
  }

  const ids = Object.keys(screen.elements);
  ids.sort((a, b) => {
    const pa = priorityById.get(a) ?? -1;
    const pb = priorityById.get(b) ?? -1;
    if (pa !== pb) return pb - pa;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const top = ids.slice(0, 20);
  if (top.length === 0) return '(no interactive elements)';
  return top
    .map((id) => {
      const e = screen.elements[id];
      const text = e.text ?? '';
      return `- ${id}: role=${e.role} text="${text}"`;
    })
    .join('\n');
}

function renderFrontier(frontier: FrontierEntry[]): string {
  const top = frontier.slice(0, 20);
  if (top.length === 0) return '(empty)';
  return top
    .map((e) => `${e.screenFp}:${e.elementId} priority=${e.priority}`)
    .join('\n');
}

function renderHistory(state: SessionState): string {
  const recent = state.history.slice(-5);
  if (recent.length === 0) return '(no prior turns)';
  return recent
    .map(
      (h) =>
        `turn=${h.turn} action=${JSON.stringify(h.action)} -> outcomeFp=${h.outcomeFp ?? 'null'}`,
    )
    .join('\n');
}

function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return '(none)';
  return findings
    .map((f) => `- ${f.category}/${f.severity}: ${f.summary}`)
    .join('\n');
}

/**
 * Stringify an action to the canonical deny-list format. The format is chosen to
 * make partial matches cheap for parameterized actions: `tap:<id>`, `type:<id>:<text>`,
 * `swipe:<dir>`, `back`, `scrollTo:<id>`, `done:<reason>`.
 */
export function stringifyAction(action: Action): string {
  switch (action.kind) {
    case 'tap':
      return `tap:${action.elementId}`;
    case 'type':
      return `type:${action.elementId}:${action.text}`;
    case 'swipe':
      return `swipe:${action.direction}`;
    case 'back':
      return 'back';
    case 'scrollTo':
      return `scrollTo:${action.elementId}`;
    case 'done':
      return `done:${action.reason}`;
  }
}

/**
 * True if `action` is blocked by the deny list. For `tap:X` and `type:X:Y` we match
 * on the `<kind>:<elementId>` prefix so operators don't have to enumerate every
 * possible text payload when denying a specific input. All other shapes require an
 * exact string equality on the canonical form.
 */
function violatesDenyList(action: Action, denyActions: string[]): boolean {
  if (denyActions.length === 0) return false;
  const full = stringifyAction(action);
  if (denyActions.includes(full)) return true;
  if (action.kind === 'tap' || action.kind === 'type') {
    const prefix = `${action.kind}:${action.elementId}`;
    return denyActions.includes(prefix);
  }
  return false;
}

/**
 * True when the proposed action equals the previous turn's action and that previous
 * turn made no progress (outcome was the same screen, or unknown). Uses a structural
 * `JSON.stringify` comparison so parameterized payloads (e.g. typed text) are
 * considered distinct.
 */
function duplicatesLastNoProgressAction(action: Action, state: SessionState): boolean {
  const last = state.history[state.history.length - 1];
  if (!last) return false;
  const noProgress = last.outcomeFp === null || last.outcomeFp === last.screenFp;
  if (!noProgress) return false;
  return JSON.stringify(last.action) === JSON.stringify(action);
}

/**
 * Deterministic fallback used whenever Claude's answer is unusable. Walks the frontier
 * top-down, skipping entries whose tap would repeat the immediately-prior no-progress
 * action — otherwise the old behaviour (pick `frontier[0]` unconditionally) dispatched the
 * same target we just rejected, and the loop went nowhere. Emits `back` when no viable
 * non-duplicate entry remains.
 */
function fallback(ctx: DecideContext, reason: string): DecideResult {
  const { frontier, state } = ctx;
  const last = state.history[state.history.length - 1];
  const lastWasNoProgress =
    last !== undefined && (last.outcomeFp === null || last.outcomeFp === last.screenFp);
  const blockedAction = lastWasNoProgress ? last.action : null;
  for (const entry of frontier) {
    const candidate: Action = { kind: 'tap', elementId: entry.elementId };
    if (blockedAction !== null && JSON.stringify(candidate) === JSON.stringify(blockedAction)) {
      continue;
    }
    return { action: candidate, reasoning: reason };
  }
  return {
    action: { kind: 'back' },
    reasoning: frontier.length === 0 ? 'fallback: empty frontier' : 'fallback: frontier saturated with repeats',
  };
}
