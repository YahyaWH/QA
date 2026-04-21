/**
 * Wire-level Linear GraphQL client. Implements the narrow `LinearClient`
 * interface from `./linear` so the publisher can swap this for a fake in
 * tests. All I/O goes through the injected `fetchImpl` — no hidden globals,
 * no SDK dependency — which keeps the publisher testable end-to-end.
 *
 * Label handling: Linear's `issueCreate` expects label *IDs*, not names. We
 * resolve name → id lazily per team: on first `saveIssue` for a `teamId` we
 * fetch the team's label catalog once, then create any missing labels as we
 * go. Subsequent calls for the same team reuse the cached map.
 */

import type {
  CreateAttachmentInput,
  LinearClient,
  LinearIssueRef,
  SaveIssueInput,
} from './linear';

export interface LinearGraphQLClientOptions {
  /** Linear API key. Sent verbatim as the `Authorization` header — Linear
   *  does NOT expect a "Bearer " prefix. */
  apiKey: string;
  /** Override the GraphQL endpoint. Defaults to Linear's production URL. */
  endpoint?: string;
  /** Injectable `fetch` — unit tests pass a fake; production uses the global. */
  fetchImpl?: typeof fetch;
}

/** Shape of the Linear GraphQL envelope. Either `data` xor `errors`. */
interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';

export class LinearGraphQLClient implements LinearClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  /** teamId → (label name → label id). Populated lazily per team. */
  private readonly labelCache = new Map<string, Map<string, string>>();

  constructor(options: LinearGraphQLClientOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async saveIssue(input: SaveIssueInput): Promise<LinearIssueRef> {
    // Without a teamId we can't resolve labels (team-scoped resource) — drop
    // them rather than fail the publish. Spec §6.4 prefers an issue with
    // partial metadata over no issue at all.
    const labelIds = input.teamId
      ? await this.resolveLabelIds(input.teamId, input.labels)
      : [];

    const mutation = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier }
        }
      }
    `;
    type Resp = {
      issueCreate: {
        success: boolean;
        issue?: { id: string; identifier: string };
      };
    };
    const data = await this.graphql<Resp>(mutation, {
      input: {
        teamId: input.teamId,
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        labelIds,
      },
    });
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new Error('Linear issueCreate reported success=false');
    }
    return {
      id: data.issueCreate.issue.id,
      identifier: data.issueCreate.issue.identifier,
    };
  }

  async createAttachment(input: CreateAttachmentInput): Promise<void> {
    const mutation = `
      mutation AttachmentCreate($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) { success }
      }
    `;
    type Resp = { attachmentCreate: { success: boolean } };
    const data = await this.graphql<Resp>(mutation, {
      input: {
        issueId: input.issueId,
        url: input.url,
        title: input.title,
      },
    });
    if (!data.attachmentCreate.success) {
      throw new Error('Linear attachmentCreate reported success=false');
    }
  }

  private async resolveLabelIds(
    teamId: string,
    names: string[],
  ): Promise<string[]> {
    let cache = this.labelCache.get(teamId);
    if (!cache) {
      cache = await this.fetchTeamLabels(teamId);
      this.labelCache.set(teamId, cache);
    }
    const resolved: string[] = [];
    for (const name of names) {
      const existing = cache.get(name);
      if (existing !== undefined) {
        resolved.push(existing);
        continue;
      }
      const created = await this.createLabel(teamId, name);
      cache.set(name, created);
      resolved.push(created);
    }
    return resolved;
  }

  private async fetchTeamLabels(teamId: string): Promise<Map<string, string>> {
    const query = `
      query TeamLabels($id: String!) {
        team(id: $id) {
          labels {
            nodes { id name }
          }
        }
      }
    `;
    type Resp = {
      team: { labels: { nodes: Array<{ id: string; name: string }> } };
    };
    const data = await this.graphql<Resp>(query, { id: teamId });
    const map = new Map<string, string>();
    for (const node of data.team.labels.nodes) {
      map.set(node.name, node.id);
    }
    return map;
  }

  private async createLabel(teamId: string, name: string): Promise<string> {
    const mutation = `
      mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }
    `;
    type Resp = {
      issueLabelCreate: {
        success: boolean;
        issueLabel?: { id: string; name: string };
      };
    };
    const data = await this.graphql<Resp>(mutation, {
      input: { teamId, name },
    });
    if (!data.issueLabelCreate.success || !data.issueLabelCreate.issueLabel) {
      throw new Error(
        `Linear issueLabelCreate reported success=false for "${name}"`,
      );
    }
    return data.issueLabelCreate.issueLabel.id;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Linear GraphQL ${response.status}: ${text}`);
    }
    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((e) => e.message).join('; '));
    }
    if (!payload.data) {
      throw new Error('Linear GraphQL: empty response');
    }
    return payload.data;
  }
}
