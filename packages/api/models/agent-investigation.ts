import mongoose, { Schema, type Document } from 'mongoose';

export interface IAgentInvestigation extends Document {
  runId: string;
  testId: string;
  rootCause: string;
  suspectFiles: Array<{
    path: string;
    lines?: string;
    reason: string;
  }>;
  recentCommits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
  category: 'regression' | 'flaky' | 'new_bug' | 'test_issue' | 'unknown';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendedAction: string;
  agentModel: string;
  tokensUsed: {
    input: number;
    output: number;
  };
  toolCallCount: number;
  durationMs: number;
  fixPr?: {
    repo: string;
    prNumber: number;
    prUrl: string;
    branch: string;
    status: 'draft' | 'open' | 'merged' | 'closed';
  };
  approvalStatus: 'pending' | 'approved' | 'skipped';
  approvedBy?: string;
  approvedAt?: Date;
  slackApprovalTs?: string;
  slackReplyTs?: string;
  createdAt: Date;
  expiresAt: Date;
}

const agentInvestigationSchema = new Schema<IAgentInvestigation>(
  {
    runId: { type: String, required: true },
    testId: { type: String, required: true },
    rootCause: { type: String, required: true },
    suspectFiles: [
      {
        path: { type: String, required: true },
        lines: String,
        reason: { type: String, required: true },
        _id: false,
      },
    ],
    recentCommits: [
      {
        sha: { type: String, required: true },
        message: { type: String, required: true },
        author: { type: String, required: true },
        date: { type: String, required: true },
        _id: false,
      },
    ],
    category: {
      type: String,
      enum: ['regression', 'flaky', 'new_bug', 'test_issue', 'unknown'],
      required: true,
    },
    confidence: {
      type: String,
      enum: ['HIGH', 'MEDIUM', 'LOW'],
      required: true,
    },
    recommendedAction: { type: String, required: true },
    agentModel: { type: String, required: true },
    tokensUsed: {
      input: { type: Number, required: true },
      output: { type: Number, required: true },
    },
    toolCallCount: { type: Number, required: true },
    durationMs: { type: Number, required: true },
    fixPr: {
      repo: String,
      prNumber: Number,
      prUrl: String,
      branch: String,
      status: { type: String, enum: ['draft', 'open', 'merged', 'closed'] },
    },
    approvalStatus: {
      type: String,
      enum: ['pending', 'approved', 'skipped'],
      default: 'pending',
    },
    approvedBy: String,
    approvedAt: Date,
    slackApprovalTs: String,
    slackReplyTs: String,
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

agentInvestigationSchema.index({ runId: 1, testId: 1 }, { unique: true });
agentInvestigationSchema.index({ testId: 1, createdAt: -1 });
agentInvestigationSchema.index({ approvalStatus: 1, confidence: 1 });

export const AgentInvestigation = mongoose.model<IAgentInvestigation>(
  'AgentInvestigation',
  agentInvestigationSchema
);
