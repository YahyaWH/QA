/**
 * Slack Interactivity Webhook
 * Receives button clicks from Slack (approve/skip fix) and:
 *   1. Updates investigation approvalStatus in MongoDB
 *   2. Acks Slack immediately (200 within 3s)
 *   3. Spawns Sweep (fix agent) for approved items
 */

import { Router, type Request, type Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { AgentInvestigation } from '../models/agent-investigation';

const router = Router();

// In-memory store for rerun approvals (PoC — not persisted across restarts)
const rerunApprovals = new Map<string, 'pending' | 'approved' | 'denied'>();

export function getRerunStatus(testId: string): 'pending' | 'approved' | 'denied' | 'not_found' {
  return rerunApprovals.get(testId) ?? 'not_found';
}

export function registerRerunRequest(testId: string): void {
  rerunApprovals.set(testId, 'pending');
}

interface SlackAction {
  type: string;
  action_id: string;
  value: string;
}

interface SlackInteractionPayload {
  type: string;
  user: { id: string; username: string; name: string };
  actions: SlackAction[];
  channel: { id: string };
  message: { ts: string };
  response_url: string;
}

// POST /api/v1/slack/interactions — Slack sends button clicks here
router.post('/interactions', async (req: Request, res: Response) => {
  // Slack sends the payload as a URL-encoded `payload` field
  let payload: SlackInteractionPayload;
  try {
    const raw = typeof req.body === 'string' ? req.body : req.body.payload;
    payload = JSON.parse(raw) as SlackInteractionPayload;
  } catch {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  // Ack immediately — Slack requires 200 within 3 seconds
  res.status(200).json({ ok: true });

  if (payload.type !== 'block_actions' || !payload.actions?.length) return;

  for (const action of payload.actions) {
    // Handle rerun approval/denial buttons
    const rerunApproveMatch = action.action_id.match(/^approve_rerun_(.+)$/);
    const rerunDenyMatch = action.action_id.match(/^deny_rerun_(.+)$/);

    if (rerunApproveMatch || rerunDenyMatch) {
      const testId = (rerunApproveMatch || rerunDenyMatch)![1];
      const rerunStatus = rerunApproveMatch ? 'approved' : 'denied';
      const userName = payload.user.username || payload.user.name || 'unknown';
      rerunApprovals.set(testId, rerunStatus);

      const statusText = rerunStatus === 'approved'
        ? `:white_check_mark: Re-run approved by @${userName}`
        : `:no_entry_sign: Re-run denied by @${userName}`;

      await updateSlackMessage(payload.response_url, statusText, rerunStatus === 'approved' ? 'approved' : 'skipped');
      continue;
    }

    // action_id format: approve_fix_{investigationId} or skip_fix_{investigationId}
    const approveMatch = action.action_id.match(/^approve_fix_(.+)$/);
    const skipMatch = action.action_id.match(/^skip_fix_(.+)$/);

    const investigationId = approveMatch?.[1] || skipMatch?.[1];
    if (!investigationId) continue;

    const status = approveMatch ? 'approved' : 'skipped';
    const userName = payload.user.username || payload.user.name || 'unknown';

    try {
      const investigation = await AgentInvestigation.findByIdAndUpdate(
        investigationId,
        {
          $set: {
            approvalStatus: status,
            approvedBy: userName,
            approvedAt: new Date(),
            slackApprovalTs: payload.message.ts,
          },
        },
        { new: true }
      ).lean();

      if (!investigation) continue;

      // Update the Slack message to show the decision
      const statusText = status === 'approved'
        ? `Approved by @${userName} — Sweep starting...`
        : `Skipped by @${userName}`;

      await updateSlackMessage(payload.response_url, statusText, status);

      // If approved, spawn Sweep for this investigation
      if (status === 'approved') {
        spawnSweep(investigationId, payload.channel.id, payload.message.ts);
      }
    } catch (err) {
      console.error(`Failed to process Slack action for ${investigationId}:`, err);
    }
  }
});

/**
 * Update the original Slack message via response_url to reflect the decision.
 */
async function updateSlackMessage(
  responseUrl: string,
  statusText: string,
  status: 'approved' | 'skipped'
): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replace_original: false,
        text: status === 'approved'
          ? `:white_check_mark: ${statusText}`
          : `:no_entry_sign: ${statusText}`,
      }),
    });
  } catch (err) {
    console.error('Failed to update Slack message:', err);
  }
}

/**
 * Spawn Sweep as a child process.
 * It runs gc/sweep.ts with the investigation ID passed via env.
 */
function spawnSweep(
  investigationId: string,
  channelId: string,
  threadTs: string
): void {
  const scriptPath = path.resolve(
    process.cwd(),
    '..', // up from api/ to project root
    'cypress/scripts/gc/sweep.ts'
  );

  console.log(`Spawning Sweep for investigation ${investigationId}`);

  const child = spawn('npx', ['tsx', scriptPath], {
    env: {
      ...process.env,
      INVESTIGATION_ID: investigationId,
      SLACK_THREAD_CHANNEL: channelId,
      SLACK_THREAD_TS: threadTs,
    },
    stdio: 'inherit',
    detached: false,
    shell: true,
  });

  child.on('error', (err) => {
    console.error(`Sweep spawn error: ${err.message}`);
  });

  child.on('exit', (code) => {
    console.log(`Sweep exited with code ${code}`);
  });
}

// GET /api/v1/slack/rerun-status/:testId — Poll rerun approval status
router.get('/rerun-status/:testId', (req: Request, res: Response) => {
  const testId = req.params.testId as string;
  const status = getRerunStatus(testId);
  res.json({ testId, status });
});

// POST /api/v1/slack/rerun-request — Register a pending rerun request
router.post('/rerun-request', (req: Request, res: Response) => {
  const { testId } = req.body as { testId?: string };
  if (!testId) {
    res.status(400).json({ error: 'testId required' });
    return;
  }
  registerRerunRequest(testId);
  res.status(201).json({ testId, status: 'pending' });
});

export default router;
