import { Router, type Request, type Response } from 'express';
import { AgentInvestigation } from '../models/agent-investigation';

const router = Router();
const TTL_DAYS = 90;

function expiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + TTL_DAYS);
  return d;
}

// POST /api/v1/investigations — Save an investigation result
router.post('/', async (req: Request, res: Response) => {
  try {
    const investigation = new AgentInvestigation({
      ...req.body,
      expiresAt: expiresAt(),
    });
    await investigation.save();
    res.status(201).json(investigation);
  } catch (err: unknown) {
    const error = err as Error & { code?: number };
    if (error.code === 11000) {
      res.status(409).json({ error: 'Investigation already exists for this run+test' });
      return;
    }
    res.status(500).json({ error: 'Failed to create investigation' });
  }
});

// GET /api/v1/investigations/approved — Approved investigations awaiting fix
router.get('/approved', async (_req: Request, res: Response) => {
  try {
    const investigations = await AgentInvestigation.find({
      approvalStatus: 'approved',
      fixPr: { $exists: false },
      confidence: 'HIGH',
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json(investigations);
  } catch {
    res.status(500).json({ error: 'Failed to fetch approved investigations' });
  }
});

// PATCH /api/v1/investigations/:id/approve — Set approval status
router.patch('/:id/approve', async (req: Request, res: Response) => {
  try {
    const { status, approvedBy } = req.body as {
      status: 'approved' | 'skipped';
      approvedBy?: string;
    };

    if (!status || !['approved', 'skipped'].includes(status)) {
      res.status(400).json({ error: 'status must be "approved" or "skipped"' });
      return;
    }

    const investigation = await AgentInvestigation.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          approvalStatus: status,
          approvedBy: approvedBy || 'unknown',
          approvedAt: new Date(),
        },
      },
      { new: true }
    ).lean();

    if (!investigation) {
      res.status(404).json({ error: 'Investigation not found' });
      return;
    }
    res.json(investigation);
  } catch {
    res.status(500).json({ error: 'Failed to update approval status' });
  }
});

// GET /api/v1/investigations/by-id/:id — Get single investigation by MongoDB _id
router.get('/by-id/:id', async (req: Request, res: Response) => {
  try {
    const investigation = await AgentInvestigation.findById(req.params.id).lean();
    if (!investigation) {
      res.status(404).json({ error: 'Investigation not found' });
      return;
    }
    res.json(investigation);
  } catch {
    res.status(500).json({ error: 'Failed to fetch investigation' });
  }
});

// GET /api/v1/investigations/:testId — Get investigation history for a test
router.get('/:testId', async (req: Request, res: Response) => {
  try {
    const investigations = await AgentInvestigation.find({
      testId: req.params.testId,
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json(investigations);
  } catch {
    res.status(500).json({ error: 'Failed to fetch investigations' });
  }
});

// PATCH /api/v1/investigations/:id/fix-pr — Link a fix PR
router.patch('/:id/fix-pr', async (req: Request, res: Response) => {
  try {
    const investigation = await AgentInvestigation.findByIdAndUpdate(
      req.params.id,
      { $set: { fixPr: req.body } },
      { new: true }
    ).lean();

    if (!investigation) {
      res.status(404).json({ error: 'Investigation not found' });
      return;
    }
    res.json(investigation);
  } catch {
    res.status(500).json({ error: 'Failed to update investigation' });
  }
});

export default router;
