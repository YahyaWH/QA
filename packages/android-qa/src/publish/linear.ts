import type { Category, Finding } from '../types/index';

/**
 * Reference returned by Linear's `issueCreate` mutation. We surface the two
 * fields the publisher needs:
 *   - `id`         — UUID used as the target for `attachmentCreate`.
 *   - `identifier` — public slug (e.g. `WH-1234`) persisted back into
 *                    `findings-history.jsonl` and spliced into `report.md`.
 */
export interface LinearIssueRef {
  id: string;
  identifier: string;
}

/** Input to `LinearClient.saveIssue` — maps 1-1 to `issueCreate(input:)`. */
export interface SaveIssueInput {
  /** Linear team the issue belongs to. The GraphQL client resolves labels
   *  against this team; absent ⇒ labels are dropped. */
  teamId?: string;
  /** Linear project to file under. Optional. */
  projectId?: string;
  /** Issue title — spec §6.4: "finding summary". */
  title: string;
  /** Full markdown body — see `renderIssueBody`. */
  description: string;
  /** Label names per spec §6.4 (not IDs — the client resolves names). */
  labels: string[];
}

/** Input to `LinearClient.createAttachment` — maps 1-1 to `attachmentCreate`. */
export interface CreateAttachmentInput {
  /** The UUID returned by `saveIssue`, NOT the `WH-…` identifier. */
  issueId: string;
  /** Public URL of the hosted artifact. */
  url: string;
  /** Human label: `screenshot | clip | logcat`. */
  title: string;
}

/**
 * Narrow interface the publisher calls against. Keeping it this small lets the
 * CLI inject either a live GraphQL client or a fake for tests — see
 * `src/publish/linear-graphql-client.ts` for the wire-level implementation.
 */
export interface LinearClient {
  saveIssue(input: SaveIssueInput): Promise<LinearIssueRef>;
  createAttachment(input: CreateAttachmentInput): Promise<void>;
}

/**
 * Public URLs of the three artifact classes the pipeline produces. Keys match
 * `Finding.artifactRefs` so the publisher can wire one to the other without
 * translation. Any key may be absent — attachments only fire for present URLs.
 */
export interface ArtifactUrls {
  screenshot?: string;
  clip?: string;
  logcat?: string;
}

/** Category → human label for the issue body. */
const CATEGORY_LABELS: Record<Category, string> = {
  A: 'hard failure',
  B: 'functional bug',
  C: 'UX issue',
  D: 'polish',
  E: 'suggestion',
};

/** Order of the attachment entries — stable so tests can assert it verbatim. */
const ATTACHMENT_LABELS = ['screenshot', 'clip', 'logcat'] as const;

/**
 * Options for `publishFinding`. `screenRef` is a pre-rendered string (the CLI
 * has `SessionState` at hand, this function is pure) and defaults to a bare
 * fingerprint stub when omitted. `teamId` / `projectId` are forwarded verbatim.
 */
export interface PublishFindingOptions {
  screenRef?: string;
  teamId?: string;
  projectId?: string;
}

/**
 * Render the issue body markdown. Mirrors the structure of the per-finding
 * report block (§6.2) but uses absolute public URLs instead of relative paths.
 *
 * Pure — no I/O, no side effects. Callers must have already resolved URLs.
 */
export function renderIssueBody(
  finding: Finding,
  artifactUrls: ArtifactUrls,
  screenRef: string,
): string {
  const lines: string[] = [];
  lines.push(`- **Severity:** ${finding.severity.toUpperCase()}`);
  lines.push(
    `- **Category:** ${finding.category} (${CATEGORY_LABELS[finding.category]})`,
  );
  lines.push(`- **Screen:** ${screenRef}`);
  lines.push(`- **Element:** ${renderElement(finding.element)}`);
  lines.push('');
  lines.push(`**Agent reasoning:** ${finding.reasoning}`);

  const artLinks: string[] = [];
  for (const label of ATTACHMENT_LABELS) {
    const url = artifactUrls[label];
    if (url) artLinks.push(`- [${label}](${url})`);
  }
  if (artLinks.length > 0) {
    lines.push('');
    lines.push('**Artifacts:**');
    lines.push(...artLinks);
  }
  return lines.join('\n');
}

/**
 * Build the canonical label set per spec §6.4:
 * `["android-qa", "auto", "category-<X>", "severity-<Y>"]`.
 */
export function buildIssueLabels(finding: Finding): string[] {
  return [
    'android-qa',
    'auto',
    `category-${finding.category}`,
    `severity-${finding.severity}`,
  ];
}

/**
 * Publish one finding to Linear. Strict ordering:
 *
 *   1. `saveIssue` first — if it throws, no attachments are created, no state
 *      is committed.
 *   2. `createAttachment` once per present URL in a stable order.
 *
 * If `createAttachment` throws after `saveIssue` has already succeeded, the
 * error propagates. The caller decides whether to treat a partially-attached
 * issue as "published" (§6.5 says no — do not update findings-history).
 *
 * Returns the `{id, identifier}` pair so the caller can persist the public
 * `WH-…` slug back to findings-history and splice it into `report.md`.
 */
export async function publishFinding(
  finding: Finding,
  artifactUrls: ArtifactUrls,
  client: LinearClient,
  options: PublishFindingOptions = {},
): Promise<LinearIssueRef> {
  const screenRef = options.screenRef ?? defaultScreenRef(finding);
  const description = renderIssueBody(finding, artifactUrls, screenRef);
  const labels = buildIssueLabels(finding);

  const issue = await client.saveIssue({
    teamId: options.teamId,
    projectId: options.projectId,
    title: finding.summary,
    description,
    labels,
  });

  for (const label of ATTACHMENT_LABELS) {
    const url = artifactUrls[label];
    if (!url) continue;
    await client.createAttachment({ issueId: issue.id, url, title: label });
  }
  return issue;
}

/**
 * Pure fallback screen ref when the CLI hasn't pre-rendered one. Matches the
 * shape of `makeScreenRef` in `src/report/render.ts` so the issue body looks
 * identical to the report block it mirrors.
 */
function defaultScreenRef(finding: Finding): string {
  return `\`${finding.screenFp}\` (fp: \`${finding.screenFp.slice(0, 6)}…\`)`;
}

function renderElement(element: string | null): string {
  return element === null ? '(unknown)' : `\`${element}\``;
}
