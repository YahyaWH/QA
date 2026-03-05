/**
 * GitHub API tool implementations for Mark (audit phase)
 * Provides read-only access to the WasteHero application repository.
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

// ---- Tool: github_search_code ----

export async function githubSearchCode(input: {
  query: string;
  path?: string;
}): Promise<ToolResultBlockParam['content']> {
  const q = `${input.query} repo:${repo()}${input.path ? ` path:${input.path}` : ''}`;

  const res = await fetch(
    `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=10`,
    { headers: headers() }
  );

  if (!res.ok) {
    return `GitHub search failed: ${res.status} ${res.statusText}`;
  }

  const data = (await res.json()) as {
    total_count: number;
    items: Array<{
      name: string;
      path: string;
      html_url: string;
      text_matches?: Array<{ fragment: string }>;
    }>;
  };

  if (data.total_count === 0) {
    return `No results found for: ${input.query}`;
  }

  const results = data.items.map((item) => {
    const fragments = item.text_matches
      ?.map((m) => m.fragment)
      .join('\n---\n') || '';
    return `File: ${item.path}\n${fragments}`;
  });

  return `Found ${data.total_count} result(s):\n\n${results.join('\n\n')}`;
}

// ---- Tool: github_get_file ----

export async function githubGetFile(input: {
  path: string;
  ref?: string;
}): Promise<ToolResultBlockParam['content']> {
  const url = `${GITHUB_API}/repos/${repo()}/contents/${input.path}${input.ref ? `?ref=${input.ref}` : ''}`;

  const res = await fetch(url, { headers: headers() });

  if (!res.ok) {
    return `Failed to get file: ${res.status} ${res.statusText}`;
  }

  const data = (await res.json()) as {
    content?: string;
    encoding?: string;
    size: number;
    html_url: string;
  };

  if (!data.content) {
    return `File ${input.path} exists but has no content (may be a directory or too large).`;
  }

  const decoded = Buffer.from(data.content, 'base64').toString('utf-8');

  // Truncate very large files to save tokens
  if (decoded.length > 15000) {
    return `File: ${input.path} (truncated to 15000 chars)\n\n${decoded.substring(0, 15000)}\n\n... (${decoded.length - 15000} more chars)`;
  }

  return `File: ${input.path}\n\n${decoded}`;
}

// ---- Tool: github_get_commits ----

export async function githubGetCommits(input: {
  path: string;
  since?: string;
}): Promise<ToolResultBlockParam['content']> {
  const since = input.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${GITHUB_API}/repos/${repo()}/commits?path=${encodeURIComponent(input.path)}&since=${since}&per_page=10`;

  const res = await fetch(url, { headers: headers() });

  if (!res.ok) {
    return `Failed to get commits: ${res.status} ${res.statusText}`;
  }

  const commits = (await res.json()) as Array<{
    sha: string;
    commit: {
      message: string;
      author: { name: string; date: string };
    };
    html_url: string;
  }>;

  if (commits.length === 0) {
    return `No commits found for ${input.path} since ${since}`;
  }

  const formatted = commits.map((c) => {
    const shortSha = c.sha.substring(0, 7);
    const msg = c.commit.message.split('\n')[0];
    return `${shortSha} ${c.commit.author.date} ${c.commit.author.name}\n  ${msg}`;
  });

  return `Recent commits for ${input.path}:\n\n${formatted.join('\n\n')}`;
}

// ---- Tool: github_get_pr ----

export async function githubGetPr(input: {
  sha: string;
}): Promise<ToolResultBlockParam['content']> {
  const url = `${GITHUB_API}/repos/${repo()}/commits/${input.sha}/pulls`;

  const res = await fetch(url, {
    headers: {
      ...headers(),
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!res.ok) {
    return `Failed to find PR for commit ${input.sha}: ${res.status}`;
  }

  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    html_url: string;
    user: { login: string };
    merged_at: string | null;
    body: string | null;
  }>;

  if (prs.length === 0) {
    return `No PRs found for commit ${input.sha}`;
  }

  const formatted = prs.map((pr) => {
    const body = pr.body ? pr.body.substring(0, 500) : '(no description)';
    return `PR #${pr.number}: ${pr.title}\nAuthor: ${pr.user.login}\nMerged: ${pr.merged_at || 'not merged'}\nURL: ${pr.html_url}\n\n${body}`;
  });

  return formatted.join('\n\n---\n\n');
}

// ---- Claude tool definitions ----

export const GITHUB_TOOL_DEFINITIONS = [
  {
    name: 'github_search_code' as const,
    description: 'Search for code in the WasteHero application repository',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Search query (code, filename, or symbol)' },
        path: { type: 'string' as const, description: 'Optional path filter (e.g., "src/api/")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'github_get_file' as const,
    description: 'Read the contents of a specific file from the WasteHero repo',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'File path in the repo (e.g., "src/api/customers.ts")' },
        ref: { type: 'string' as const, description: 'Branch or commit SHA (default: main)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'github_get_commits' as const,
    description: 'Get recent commits that modified a specific file',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'File path to check history for' },
        since: { type: 'string' as const, description: 'ISO date to start from (default: 7 days ago)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'github_get_pr' as const,
    description: 'Find the pull request that introduced a specific commit',
    input_schema: {
      type: 'object' as const,
      properties: {
        sha: { type: 'string' as const, description: 'Full or short commit SHA' },
      },
      required: ['sha'],
    },
  },
];

export type GitHubToolName = (typeof GITHUB_TOOL_DEFINITIONS)[number]['name'];
