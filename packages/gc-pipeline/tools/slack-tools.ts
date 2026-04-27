/**
 * Slack tools for both Mark (audit) and Sweep (fix) phases.
 * Posts analysis results and PR links to Slack threads.
 */

import { WebClient, type KnownBlock } from '@slack/web-api';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';

let slackClient: WebClient | null = null;

function getClient(): WebClient | null {
  if (!slackClient && process.env.SLACK_BOT_TOKEN) {
    slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  return slackClient;
}

// ---- Tool: slack_reply ----

export async function slackReply(input: {
  channelId: string;
  threadTs: string;
  text: string;
  blocks?: KnownBlock[];
}): Promise<ToolResultBlockParam['content']> {
  const client = getClient();

  if (!client) {
    return `[DRY RUN] Would reply to thread ${input.threadTs}:\n${input.text}`;
  }

  try {
    const result = await client.chat.postMessage({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: input.text,
      blocks: input.blocks,
    });

    return `Message posted to thread: ts=${result.ts}`;
  } catch (err) {
    return `Failed to post to Slack: ${(err as Error).message}`;
  }
}

// ---- Claude tool definition ----

export const SLACK_TOOL_DEFINITIONS = [
  {
    name: 'slack_reply' as const,
    description: 'Post a message to a Slack thread (used to share investigation results or PR links with the team)',
    input_schema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string' as const, description: 'Slack channel ID' },
        threadTs: { type: 'string' as const, description: 'Thread timestamp to reply to' },
        text: { type: 'string' as const, description: 'Message text (supports Slack mrkdwn)' },
      },
      required: ['channelId', 'threadTs', 'text'],
    },
  },
];

export type SlackToolName = (typeof SLACK_TOOL_DEFINITIONS)[number]['name'];
