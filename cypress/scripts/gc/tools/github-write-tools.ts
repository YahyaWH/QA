/**
 * GitHub Write tools for Sweep (fix phase)
 * Provides branch creation, file updates, and PR creation against
 * the WasteHero app repo OR the Cypress test repo.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';

const GITHUB_API = 'https://api.github.com';

function headers(): Record<string, string> {
  const token = process.env.WASTEHERO_GITHUB_TOKEN;
  return {
    Accept: 'application/vnd.github.v3+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function repo(): string {
  return process.env.WASTEHERO_REPO || '';
}

// ---- Tool: github_create_branch ----

export async function githubCreateBranch(input: {
  branch: string;
  baseBranch?: string;
  targetRepo?: string;
}): Promise<ToolResultBlockParam['content']> {
  const targetRepo = input.targetRepo || repo();
  const baseBranch = input.baseBranch || 'main';

  // Get the SHA of the base branch
  const refRes = await fetch(
    `${GITHUB_API}/repos/${targetRepo}/git/ref/heads/${baseBranch}`,
    { headers: headers() }
  );

  if (!refRes.ok) {
    return `Failed to get base branch "${baseBranch}": ${refRes.status} ${refRes.statusText}`;
  }

  const refData = (await refRes.json()) as { object: { sha: string } };

  // Create the new branch
  const createRes = await fetch(
    `${GITHUB_API}/repos/${targetRepo}/git/refs`,
    {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/heads/${input.branch}`,
        sha: refData.object.sha,
      }),
    }
  );

  if (!createRes.ok) {
    const errText = await createRes.text();
    return `Failed to create branch "${input.branch}": ${createRes.status} ${errText}`;
  }

  return `Branch "${input.branch}" created from "${baseBranch}" (SHA: ${refData.object.sha.substring(0, 7)})`;
}

// ---- Tool: github_update_file ----

export async function githubUpdateFile(input: {
  path: string;
  content: string;
  message: string;
  branch: string;
  targetRepo?: string;
}): Promise<ToolResultBlockParam['content']> {
  const targetRepo = input.targetRepo || repo();

  // Get the current file SHA (if it exists, required for updates)
  let existingSha: string | undefined;
  const getRes = await fetch(
    `${GITHUB_API}/repos/${targetRepo}/contents/${input.path}?ref=${input.branch}`,
    { headers: headers() }
  );

  if (getRes.ok) {
    const data = (await getRes.json()) as { sha: string };
    existingSha = data.sha;
  }

  // Create or update the file
  const updateRes = await fetch(
    `${GITHUB_API}/repos/${targetRepo}/contents/${input.path}`,
    {
      method: 'PUT',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: input.message,
        content: Buffer.from(input.content).toString('base64'),
        branch: input.branch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    }
  );

  if (!updateRes.ok) {
    const errText = await updateRes.text();
    return `Failed to update file "${input.path}": ${updateRes.status} ${errText}`;
  }

  return `File "${input.path}" updated on branch "${input.branch}"`;
}

// ---- Tool: github_create_pr ----

export async function githubCreatePr(input: {
  title: string;
  body: string;
  head: string;
  base?: string;
  targetRepo?: string;
  labels?: string[];
}): Promise<ToolResultBlockParam['content']> {
  const targetRepo = input.targetRepo || repo();
  const base = input.base || 'main';

  const prRes = await fetch(
    `${GITHUB_API}/repos/${targetRepo}/pulls`,
    {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base,
        draft: true,
      }),
    }
  );

  if (!prRes.ok) {
    const errText = await prRes.text();
    return `Failed to create PR: ${prRes.status} ${errText}`;
  }

  const pr = (await prRes.json()) as {
    number: number;
    html_url: string;
  };

  // Add labels if provided
  if (input.labels && input.labels.length > 0) {
    await fetch(
      `${GITHUB_API}/repos/${targetRepo}/issues/${pr.number}/labels`,
      {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: input.labels }),
      }
    );
  }

  return `Draft PR #${pr.number} created: ${pr.html_url}`;
}

// ---- Claude tool definitions ----

export const GITHUB_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'github_create_branch' as const,
    description: 'Create a new branch in the WasteHero app repo or the Cypress test repo',
    input_schema: {
      type: 'object' as const,
      properties: {
        branch: { type: 'string' as const, description: 'New branch name (e.g., "fix/FR-020-005-sanitize-utf8")' },
        baseBranch: { type: 'string' as const, description: 'Branch to base off (default: main)' },
        targetRepo: { type: 'string' as const, description: 'Target repo in owner/name format (default: WASTEHERO_REPO)' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'github_update_file' as const,
    description: 'Create or update a file on a branch. Used to apply fixes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'File path in the repo' },
        content: { type: 'string' as const, description: 'Complete file content (will replace existing)' },
        message: { type: 'string' as const, description: 'Commit message' },
        branch: { type: 'string' as const, description: 'Branch to commit to' },
        targetRepo: { type: 'string' as const, description: 'Target repo (default: WASTEHERO_REPO)' },
      },
      required: ['path', 'content', 'message', 'branch'],
    },
  },
  {
    name: 'github_create_pr' as const,
    description: 'Open a DRAFT pull request for a fix. Always creates as draft (requires human review).',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' as const, description: 'PR title (e.g., "fix: FR-020-005 - handle UTF-8 in search")' },
        body: { type: 'string' as const, description: 'PR description with investigation context' },
        head: { type: 'string' as const, description: 'Source branch name' },
        base: { type: 'string' as const, description: 'Target branch (default: main)' },
        targetRepo: { type: 'string' as const, description: 'Target repo (default: WASTEHERO_REPO)' },
        labels: { type: 'array' as const, items: { type: 'string' as const }, description: 'Labels to add (e.g., ["automated-fix", "needs-review"])' },
      },
      required: ['title', 'body', 'head'],
    },
  },
];

export type GitHubWriteToolName = (typeof GITHUB_WRITE_TOOL_DEFINITIONS)[number]['name'];
