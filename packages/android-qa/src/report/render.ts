import type {
  Category,
  Finding,
  SessionState,
  Severity,
} from '../types/index';

/**
 * Options accepted by the report renderer. A pure function — no I/O, no
 * filesystem access — so it can be safely called from the orchestrator or
 * a CLI without worrying about side effects.
 */
export interface RenderOptions {
  /**
   * The just-finished run's session state. `session.findings` are the
   * classified findings for this run (post-`classifyAgainstHistory`).
   */
  session: SessionState;
  /**
   * Full historical findings (all prior runs). Used to:
   *   - resolve `linearIssueId` for resurrection entries whose current
   *     classified Finding doesn't carry it forward;
   *   - surface `published` entries NOT present in the current run as
   *     additional "Previously seen" rows.
   */
  history: Finding[];
  /**
   * Run directory such as `output/android-qa/run-20260417-0930`. Kept for
   * symmetry with the CLI signature (Task 22) even though the body does not
   * currently reference it — all artifact paths in the report are relative
   * to the report file itself, which lives inside `runDir` on disk.
   */
  runDir: string;
}

/** Resolves a Finding's screenFp to the on-screen label shown in the report. */
type ScreenRef = (f: Finding) => string;

/**
 * Render a run's session + history into the Markdown report described in
 * the Android QA design spec §6.2.
 *
 * Display id convention: a `Finding.id` is a 16-char SHA-1 hex prefix; the
 * human-facing display id is `f-<first 4 hex chars>`. This keeps the id
 * stable across runs (content-addressed), parseable by the report parser
 * (Task 24) via a lookup through findings-history, and consistent with the
 * rest of the system's content-addressed approach. E.g. id
 * `a3f2b7d09c1e8fa2` → display `f-a3f2`.
 *
 * Pure: no I/O, no filesystem probes, no network calls. Safe to call
 * from any context.
 */
export function render(opts: RenderOptions): string {
  // `runDir` is accepted for signature symmetry with the CLI (Task 22) —
  // all artifact links in the output are relative to the report file, so
  // the body does not need to consume it here.
  const { session, history } = opts;
  const screenRef = makeScreenRef(session);

  const regressions = session.findings.filter((f) => f.status === 'resurrected');
  const newFindings = session.findings.filter((f) => f.status === 'new');
  const currentlyPreviouslySeen = session.findings.filter(
    (f) => f.status === 'previously-seen',
  );

  // Merge current "previously-seen" with historical "published" entries that
  // don't appear in this run's findings — surface those as additional rows.
  const previouslySeenAll = mergePreviouslySeen(currentlyPreviouslySeen, history);

  const parts: string[] = [];
  parts.push(renderHeader(session));
  parts.push(renderRunStatus(session));
  parts.push(renderRegressions(regressions, history, screenRef));
  parts.push(renderNew(newFindings, screenRef));
  parts.push(renderPreviouslySeen(previouslySeenAll));

  // Sections emit a leading blank line, so joining with '\n' is enough.
  // Ensure a single trailing newline on the whole document.
  return parts.join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/*  Header + status                                                            */
/* -------------------------------------------------------------------------- */

function renderHeader(session: SessionState): string {
  const durationStr = formatDuration(session.startedAt, session.endedAt);
  const turns = session.history.length;
  const status = session.status ?? 'completed';
  const screensVisited = Object.keys(session.screens).length;

  // TODO(task-22): `SessionState` does not currently carry device info; the
  // CLI will inject it once device metadata is threaded through.
  const device = 'unknown';

  // Coverage-delta is intentionally omitted here — it requires comparing
  // against an AppMap that this signature doesn't take. Revisit in Task 22
  // when the CLI has access to the loaded AppMap.
  return [
    `# Android QA Run — ${session.runId}`,
    '',
    `**App version:** ${session.appVersion}`,
    `**Device:** ${device}`,
    `**Duration:** ${durationStr}   **Turns:** ${turns}   **Status:** ${status}`,
    `**Screens visited:** ${screensVisited}`,
  ].join('\n');
}

function renderRunStatus(session: SessionState): string {
  const status = session.status ?? 'completed';
  return ['', '## Run status', status].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Regressions                                                                */
/* -------------------------------------------------------------------------- */

function renderRegressions(
  regressions: Finding[],
  history: Finding[],
  screenRef: ScreenRef,
): string {
  const heading = `## Regressions (previously resolved, now back) — ${regressions.length}`;
  if (regressions.length === 0) {
    return ['', heading, '', '(none)'].join('\n');
  }
  const blocks = regressions.map((f) =>
    renderFindingBlock(f, { history, isResurrection: true, screenRef }),
  );
  // Separate blocks within the section with a blank line, then close the
  // whole section with the spec's `---` divider before the next section.
  return ['', heading, '', blocks.join('\n\n'), '', '---'].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  New this run                                                               */
/* -------------------------------------------------------------------------- */

function renderNew(findings: Finding[], screenRef: ScreenRef): string {
  const heading = `## New this run — ${findings.length}`;
  if (findings.length === 0) {
    return ['', heading, '', '(none)'].join('\n');
  }
  const blocks = findings.map((f) =>
    renderFindingBlock(f, { isResurrection: false, screenRef }),
  );
  return ['', heading, '', blocks.join('\n\n')].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Previously seen                                                            */
/* -------------------------------------------------------------------------- */

function mergePreviouslySeen(current: Finding[], history: Finding[]): Finding[] {
  const present = new Set(current.map((f) => f.id));
  const extras: Finding[] = [];
  for (const h of history) {
    if (h.status !== 'published') continue;
    if (present.has(h.id)) continue;
    extras.push(h);
  }
  return [...current, ...extras];
}

function renderPreviouslySeen(findings: Finding[]): string {
  const heading = `## Previously seen (already triaged; informational) — ${findings.length}`;
  if (findings.length === 0) {
    return ['', heading, '', '(none)'].join('\n');
  }
  const blocks = findings.map((f) => renderPreviouslySeenBlock(f));
  return ['', heading, '', blocks.join('\n\n')].join('\n');
}

function renderPreviouslySeenBlock(f: Finding): string {
  const display = displayId(f.id);
  const sev = severityLabel(f.severity);
  const head = `### ☑ ${display} — [${sev}] ${f.summary}`;
  const linearSuffix = f.linearIssueId ? ` — ${f.linearIssueId} (open)` : '';
  return [`${head}${linearSuffix}`, '(collapsed)'].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Finding block (new + regression)                                           */
/* -------------------------------------------------------------------------- */

interface FindingBlockOpts {
  history?: Finding[];
  isResurrection: boolean;
  screenRef: ScreenRef;
}

function renderFindingBlock(f: Finding, opts: FindingBlockOpts): string {
  const display = displayId(f.id);
  const sev = severityLabel(f.severity);
  const lines: string[] = [];

  lines.push(`### ☐ ${display} — [${sev}] ${f.summary}`);
  lines.push(`- **Screen:** ${opts.screenRef(f)}`);
  lines.push(`- **Element:** ${renderElement(f.element)}`);
  lines.push(`- **Category:** ${f.category} (${categoryLabel(f.category)})`);

  if (opts.isResurrection) {
    const linearId = resolveLinearForResurrection(f, opts.history ?? []);
    if (linearId) {
      lines.push(`- **Linear (previous):** ${linearId}`);
    }
  }

  lines.push(renderArtifacts(display, f));
  lines.push(`- **Agent reasoning:** ${f.reasoning}`);

  if (shouldShowEvidence(f)) {
    lines.push('- **Evidence:**');
    lines.push(`  > \`${f.reasoning}\``);
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a screen-reference renderer bound to the current session's
 * `screens` dictionary. Falls back to the raw fingerprint when the screen
 * is not registered in the session — e.g. for historical findings whose
 * screen is not in this run's visited set.
 */
function makeScreenRef(session: SessionState): ScreenRef {
  return (f: Finding): string => {
    const screen = session.screens[f.screenFp];
    const activity = screen?.activity ?? f.screenFp;
    return `\`${activity}\` (fp: \`${f.screenFp.slice(0, 6)}…\`)`;
  };
}

/**
 * Human-facing display id — first 4 hex chars of the 16-char SHA-1 prefix.
 * Prefixed `f-`. See the render() JSDoc for rationale.
 */
function displayId(id: string): string {
  return `f-${id.slice(0, 4)}`;
}

function severityLabel(s: Severity): string {
  return s.toUpperCase();
}

const CATEGORY_LABELS: Record<Category, string> = {
  A: 'hard failure',
  B: 'functional bug',
  C: 'UX issue',
  D: 'polish',
  E: 'suggestion',
};

function categoryLabel(c: Category): string {
  return CATEGORY_LABELS[c];
}

function renderElement(element: string | null): string {
  return element === null ? '(unknown)' : `\`${element}\``;
}

/**
 * Build the "Artifacts" line for a finding. We always link the screenshot
 * and clip (the orchestrator's Recorder always produces both) and add a
 * logcat link only when the finding carries one. We do NOT check file
 * existence on disk — the CLI is responsible for sliced artifact extraction
 * (Task 22).
 */
function renderArtifacts(displayIdStr: string, f: Finding): string {
  const links: string[] = [
    `[screenshot](findings/${displayIdStr}/before.png)`,
    `[clip](findings/${displayIdStr}/clip.mp4)`,
  ];
  if (f.artifactRefs?.logcat) {
    links.push(`[logcat](findings/${displayIdStr}/logcat-excerpt.log)`);
  }
  return `- **Artifacts:** ${links.join(' · ')}`;
}

/**
 * Evidence blockquote rule: ONLY add when category is A AND the finding's
 * reasoning contains a `FATAL EXCEPTION` or `ANR in ` marker. This keeps
 * the renderer from hunting through logs — it just echoes what evaluate
 * already captured.
 */
function shouldShowEvidence(f: Finding): boolean {
  if (f.category !== 'A') return false;
  return f.reasoning.includes('FATAL EXCEPTION') || f.reasoning.includes('ANR in ');
}

/**
 * For a resurrected finding, try the current Finding's `linearIssueId`
 * first, then fall back to the most-recent matching history entry's
 * `linearIssueId`. Matching uses (screenFp, element, category) which is
 * stable across the stale→resurrected transition.
 */
function resolveLinearForResurrection(f: Finding, history: Finding[]): string | undefined {
  if (f.linearIssueId) return f.linearIssueId;

  const matches = history.filter(
    (h) =>
      h.screenFp === f.screenFp &&
      (h.element ?? null) === (f.element ?? null) &&
      h.category === f.category &&
      h.linearIssueId,
  );
  if (matches.length === 0) return undefined;

  // Pick the most-recent by lastSeenRun (fallback runId), lexicographic.
  const sorted = [...matches].sort((a, b) => {
    const ar = a.lastSeenRun ?? a.runId;
    const br = b.lastSeenRun ?? b.runId;
    return ar < br ? 1 : ar > br ? -1 : 0;
  });
  return sorted[0].linearIssueId;
}

/**
 * Format the wall-clock span between two ISO timestamps. Output is
 * "Xm Ys" when seconds > 0, otherwise "Xm". Unknown end -> "n/a".
 */
function formatDuration(startedAt: string, endedAt: string | undefined): string {
  if (!endedAt) return 'n/a';
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 'n/a';

  const totalSec = Math.round((end - start) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}
