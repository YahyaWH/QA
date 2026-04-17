import { Router, type Request, type Response } from 'express';
import { TestRun } from '../models/test-run';

const router = Router();
const TTL_DAYS = 90;

function expiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + TTL_DAYS);
  return d;
}

// POST /api/v1/runs — Create a new test run
router.post('/', async (req: Request, res: Response) => {
  try {
    const run = new TestRun({
      ...req.body,
      expiresAt: expiresAt(),
    });
    await run.save();
    res.status(201).json(run);
  } catch (err: unknown) {
    const error = err as Error & { code?: number };
    if (error.code === 11000) {
      res.status(409).json({ error: 'Run already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create run' });
  }
});

// GET /api/v1/runs — List runs (query: branch, limit, offset)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { branch, limit = '20', offset = '0' } = req.query;
    const filter: Record<string, unknown> = {};
    if (branch) filter.branch = branch;

    const runs = await TestRun.find(filter)
      .sort({ createdAt: -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .lean();

    res.json(runs);
  } catch {
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// GET /api/v1/runs/:runId — Get run by ID
router.get('/:runId', async (req: Request, res: Response) => {
  try {
    const run = await TestRun.findOne({ runId: req.params.runId }).lean();
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(run);
  } catch {
    res.status(500).json({ error: 'Failed to fetch run' });
  }
});

// PATCH /api/v1/runs/:runId/slack — Update Slack metadata on a run
router.patch('/:runId/slack', async (req: Request, res: Response) => {
  try {
    const run = await TestRun.findOneAndUpdate(
      { runId: req.params.runId },
      { $set: { slack: req.body } },
      { new: true }
    ).lean();

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(run);
  } catch {
    res.status(500).json({ error: 'Failed to update run' });
  }
});

export default router;
