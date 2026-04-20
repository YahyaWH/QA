/**
 * Inverse of `render()` — parses a rendered Android QA report back into a
 * flat list of findings the publish CLI (Task 26) can correlate with
 * `findings-history.jsonl`.
 *
 * Design note: this parser is intentionally lenient — it tolerates missing
 * fields (collapsed blocks), optional logcat artifacts, and em-dash runs
 * inside summaries that look like (but aren't) the Linear heading suffix.
 * The reverse direction is one-way: we don't reconstruct full `Finding`
 * objects, only the subset needed to route a report-driven publish pass.
 */

export interface ParsedFinding {
  /** Display id with f- prefix, e.g. "f-a3f2". */
  id: string;
  /** true when the box was ticked `☑`, false when `☐`. */
  checked: boolean;
  /** Lowercase severity matching the `Severity` union. */
  severity: 'low' | 'med' | 'high' | 'critical';
  /** The human-readable summary text (post-severity, pre-Linear suffix). */
  summary: string;
  /** Activity name from the Screen line, or undefined for collapsed blocks. */
  screen?: string;
  /** Resource id, or null when "(unknown)", or undefined when the field is absent. */
  element?: string | null;
  /** "A"–"E" or undefined when absent. */
  category?: 'A' | 'B' | 'C' | 'D' | 'E';
  /** Linear issue id like "WH-0911". Undefined when absent. */
  linearIssueId?: string;
  /** Agent reasoning text. Undefined when absent. */
  reasoning?: string;
  /** Artifact URLs/paths extracted from the Artifacts line. */
  artifacts?: {
    screenshot?: string;
    clip?: string;
    logcat?: string;
  };
}

/**
 * Matches the header of a finding block. Captures:
 *   1 — the check mark (☐ or ☑)
 *   2 — the display id body (hex after `f-`)
 *   3 — the severity label (HIGH/MED/LOW/CRITICAL)
 *   4 — everything after the severity bracket (summary + optional Linear suffix)
 *
 * Anchored on `^### ` at the start of a line. We compile it with the `m`
 * flag when used via `.match` but here we only consume a known single-line
 * heading, so no multiline flag is needed.
 */
const HEADER_RE =
  /^### (\u2610|\u2611) f-([0-9a-f]+) \u2014 \[(CRITICAL|HIGH|MED|LOW)\] (.+)$/;

/** Extracts a `WH-NNNN` id from a trailing ` — WH-NNNN (open)` heading suffix. */
const HEADING_LINEAR_SUFFIX_RE = / \u2014 (WH-\d+) \(open\)$/;

/** `- **Linear (previous):** WH-NNNN` body field. */
const BODY_LINEAR_RE = /^- \*\*Linear \(previous\):\*\* (WH-\d+)\s*$/;

/** `- **Screen:** \`Activity\` (fp: \`hash…\`)` — we only keep the activity. */
const SCREEN_RE = /^- \*\*Screen:\*\* `([^`]+)` \(fp: `[^`]+`\)\s*$/;

/** `- **Element:** (unknown)` — the explicit-null form. */
const ELEMENT_UNKNOWN_RE = /^- \*\*Element:\*\* \(unknown\)\s*$/;
/** `- **Element:** \`resource-id\`` — the present form. */
const ELEMENT_RE = /^- \*\*Element:\*\* `([^`]+)`\s*$/;

/** `- **Category:** A (hard failure)` — keep only the letter. */
const CATEGORY_RE = /^- \*\*Category:\*\* ([A-E]) \([^)]+\)\s*$/;

/** `- **Artifacts:** <bullet-separated links>` — label/url extracted below. */
const ARTIFACTS_LINE_RE = /^- \*\*Artifacts:\*\* (.+)$/;
/** Individual `[label](url)` link within the Artifacts bullet list. */
const ARTIFACT_LINK_RE = /^\[(screenshot|clip|logcat)\]\(([^)]+)\)$/;

/** `- **Agent reasoning:** <rest of line>` — single line (see renderer). */
const REASONING_RE = /^- \*\*Agent reasoning:\*\* (.+)$/;

/**
 * Parse a rendered Markdown report into an array of `ParsedFinding`.
 * Returns every `### ☐|☑ f-XXXX` block in document order. Callers apply
 * their own downstream filter (Task 26 uses `checked && !linearIssueId`).
 */
export function parseReport(md: string): ParsedFinding[] {
  if (!md) return [];

  const lines = md.split(/\r?\n/);
  const blocks = splitIntoBlocks(lines);
  const out: ParsedFinding[] = [];

  for (const block of blocks) {
    const parsed = parseBlock(block);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Walk the document line-by-line and group into blocks that start with a
 * finding heading (`### ☐|☑ f-...`) and end at the next `### ` heading or
 * the end of the document.
 *
 * We scan ALL `### ` lines (not just the ones matching HEADER_RE) so a
 * stray non-finding `### ` subsection between findings still terminates
 * the preceding block instead of being captured as body content.
 */
function splitIntoBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const isFindingHeader = HEADER_RE.test(line);
    const isAnyH3 = line.startsWith('### ');

    if (isFindingHeader) {
      if (current) blocks.push(current);
      current = [line];
    } else if (isAnyH3) {
      // Non-finding H3 terminates a finding block without starting a new one.
      if (current) {
        blocks.push(current);
        current = null;
      }
    } else if (current) {
      current.push(line);
    }
  }

  if (current) blocks.push(current);
  return blocks;
}

/**
 * Parse a single finding block (heading + body lines) into `ParsedFinding`.
 * Returns `null` for anything that doesn't look like a finding heading.
 *
 * The block's "body" is every line after the heading up to (but not
 * including) the next heading — splitIntoBlocks already enforces that
 * boundary, so here we just sweep the remaining lines for each field.
 */
function parseBlock(block: string[]): ParsedFinding | null {
  const headerLine = block[0];
  const headerMatch = HEADER_RE.exec(headerLine);
  if (!headerMatch) return null;

  const [, mark, idHex, sevRaw, tail] = headerMatch;

  // Pull the Linear id off the heading suffix first so we can strip it from
  // the summary. Body `- **Linear (previous):**` (checked in the loop below)
  // takes precedence; headings carrying a suffix never do, so this ordering
  // is safe.
  const headingSuffix = HEADING_LINEAR_SUFFIX_RE.exec(tail);
  const summary = headingSuffix
    ? tail.slice(0, headingSuffix.index)
    : tail;
  const headingLinearId = headingSuffix?.[1];

  const finding: ParsedFinding = {
    id: `f-${idHex}`,
    checked: mark === '\u2611',
    severity: sevRaw.toLowerCase() as ParsedFinding['severity'],
    summary,
  };
  if (headingLinearId) finding.linearIssueId = headingLinearId;

  // Sweep body lines. `(collapsed)` blocks produce no field matches, which
  // leaves the optional fields `undefined` per the design contract.
  for (let i = 1; i < block.length; i++) {
    const line = block[i];
    applyBodyLine(finding, line);
  }

  return finding;
}

/**
 * Apply a single body line to the partially-built `ParsedFinding`. Each
 * regex is anchored to the renderer's canonical format; anything else —
 * evidence blockquotes, `(collapsed)` filler, blank lines — is ignored.
 */
function applyBodyLine(finding: ParsedFinding, line: string): void {
  const trimmed = line.trimEnd();

  const bodyLinear = BODY_LINEAR_RE.exec(trimmed);
  if (bodyLinear) {
    // Body field wins over heading suffix in the rare case both appear.
    finding.linearIssueId = bodyLinear[1];
    return;
  }

  const screen = SCREEN_RE.exec(trimmed);
  if (screen) {
    finding.screen = screen[1];
    return;
  }

  if (ELEMENT_UNKNOWN_RE.test(trimmed)) {
    finding.element = null;
    return;
  }
  const element = ELEMENT_RE.exec(trimmed);
  if (element) {
    finding.element = element[1];
    return;
  }

  const category = CATEGORY_RE.exec(trimmed);
  if (category) {
    finding.category = category[1] as ParsedFinding['category'];
    return;
  }

  const artifacts = ARTIFACTS_LINE_RE.exec(trimmed);
  if (artifacts) {
    finding.artifacts = parseArtifacts(artifacts[1]);
    return;
  }

  const reasoning = REASONING_RE.exec(trimmed);
  if (reasoning) {
    finding.reasoning = reasoning[1];
    return;
  }
}

/**
 * Split the Artifacts bullet content on ` · ` (U+00B7 surrounded by spaces)
 * and map each `[label](url)` token into the typed artifacts record.
 * Unknown labels are ignored — the renderer only emits screenshot/clip/logcat.
 */
function parseArtifacts(body: string): ParsedFinding['artifacts'] {
  const out: NonNullable<ParsedFinding['artifacts']> = {};
  const parts = body.split(' \u00b7 ');
  for (const part of parts) {
    const m = ARTIFACT_LINK_RE.exec(part.trim());
    if (!m) continue;
    const [, label, url] = m;
    out[label as 'screenshot' | 'clip' | 'logcat'] = url;
  }
  return out;
}
