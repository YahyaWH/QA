import { Router, type Request, type Response } from 'express';
import { TestResult } from '../models/test-result';

const router = Router();
const TTL_DAYS = 90;

function expiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + TTL_DAYS);
  return d;
}

// POST /api/v1/runs/:runId/results — Bulk insert results for a run
router.post('/runs/:runId/results', async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const results: unknown[] = req.body;

    if (!Array.isArray(results)) {
      res.status(400).json({ error: 'Body must be an array of test results' });
      return;
    }

    const docs = results.map((r) => {
      const rec = r as Record<string, unknown>;
      return {
        ...rec,
        runId,
        investigationStatus: rec.status === 'FAILED' ? 'pending' : 'skipped',
        expiresAt: expiresAt(),
      };
    });

    const inserted = await TestResult.insertMany(docs, { ordered: false });
    res.status(201).json({ inserted: inserted.length });
  } catch (err: unknown) {
    const error = err as Error & { code?: number; insertedDocs?: unknown[] };
    if (error.code === 11000) {
      res.status(409).json({
        error: 'Some results already exist',
        inserted: error.insertedDocs?.length ?? 0,
      });
      return;
    }
    res.status(500).json({ error: 'Failed to insert results' });
  }
});

// GET /api/v1/runs/:runId/results — Get all results for a run
router.get('/runs/:runId/results', async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const { status } = req.query;
    const filter: Record<string, unknown> = { runId };
    if (status) filter.status = status;

    const results = await TestResult.find(filter).sort({ testId: 1 }).lean();
    res.json(results);
  } catch {
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// GET /api/v1/results/:testId/history — Historical results for a test
router.get('/results/:testId/history', async (req: Request, res: Response) => {
  try {
    const { testId } = req.params;
    const days = Number(req.query.days) || 30;
    const limit = Number(req.query.limit) || 50;

    const since = new Date();
    since.setDate(since.getDate() - days);

    const results = await TestResult.find({
      testId,
      createdAt: { $gte: since },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json(results);
  } catch {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// PATCH /api/v1/results/:id/slack — Set Slack thread info on a result
router.patch('/results/:id/slack', async (req: Request, res: Response) => {
  try {
    const result = await TestResult.findByIdAndUpdate(
      req.params.id,
      { $set: { slack: req.body } },
      { new: true }
    ).lean();

    if (!result) {
      res.status(404).json({ error: 'Result not found' });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to update result' });
  }
});

// PATCH /api/v1/results/:id/investigation-status — Update investigation status
router.patch('/results/:id/investigation-status', async (req: Request, res: Response) => {
  try {
    const { investigationStatus } = req.body;
    const result = await TestResult.findByIdAndUpdate(
      req.params.id,
      { $set: { investigationStatus } },
      { new: true }
    ).lean();

    if (!result) {
      res.status(404).json({ error: 'Result not found' });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to update investigation status' });
  }
});

// GET /api/v1/results/failures/unanalyzed — Get failures pending investigation
router.get('/results/failures/unanalyzed', async (req: Request, res: Response) => {
  try {
    const results = await TestResult.find({
      status: 'FAILED',
      investigationStatus: 'pending',
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json(results);
  } catch {
    res.status(500).json({ error: 'Failed to fetch unanalyzed failures' });
  }
});

// GET /api/v1/results/flaky — Get flaky tests
router.get('/results/flaky', async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const flaky = await TestResult.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$testId',
          statuses: { $push: '$status' },
          count: { $sum: 1 },
          lastSeen: { $max: '$createdAt' },
          description: { $first: '$description' },
        },
      },
      {
        $addFields: {
          distinctStatuses: { $size: { $setUnion: ['$statuses', []] } },
          failCount: {
            $size: {
              $filter: { input: '$statuses', as: 's', cond: { $eq: ['$$s', 'FAILED'] } },
            },
          },
        },
      },
      { $match: { distinctStatuses: { $gt: 1 }, count: { $gte: 3 } } },
      {
        $project: {
          testId: '$_id',
          description: 1,
          count: 1,
          failCount: 1,
          flakinessRate: {
            $round: [{ $multiply: [{ $divide: ['$failCount', '$count'] }, 100] }, 1],
          },
          lastSeen: 1,
        },
      },
      { $sort: { flakinessRate: -1 } },
    ]);

    res.json(flaky);
  } catch {
    res.status(500).json({ error: 'Failed to compute flakiness' });
  }
});

export default router;
