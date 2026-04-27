import mongoose, { Schema, type Document } from 'mongoose';

export interface ITestRun extends Document {
  runId: string;
  trigger: 'push' | 'pull_request' | 'schedule' | 'workflow_dispatch' | 'local';
  branch: string;
  commitSha: string;
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
    duration: number;
  };
  environment: {
    runner: string;
    browser: string;
    viewport: string;
    nodeVersion: string;
    cypressVersion: string;
  };
  artifacts: {
    artifactBaseUrl?: string;
    htmlReportUrl?: string;
  };
  slack?: {
    channelId: string;
    summaryTs: string;
  };
  generatedAt: Date;
  createdAt: Date;
  expiresAt: Date;
}

const testRunSchema = new Schema<ITestRun>(
  {
    runId: { type: String, required: true, unique: true, index: true },
    trigger: {
      type: String,
      enum: ['push', 'pull_request', 'schedule', 'workflow_dispatch', 'local'],
      required: true,
    },
    branch: { type: String, required: true },
    commitSha: { type: String, required: true },
    summary: {
      totalTests: { type: Number, required: true },
      passed: { type: Number, required: true },
      failed: { type: Number, required: true },
      skipped: { type: Number, required: true },
      passRate: { type: Number, required: true },
      duration: { type: Number, required: true },
    },
    environment: {
      runner: { type: String, required: true },
      browser: { type: String, required: true },
      viewport: { type: String, required: true },
      nodeVersion: { type: String, default: '' },
      cypressVersion: { type: String, default: '' },
    },
    artifacts: {
      artifactBaseUrl: String,
      htmlReportUrl: String,
    },
    slack: {
      channelId: String,
      summaryTs: String,
    },
    generatedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

testRunSchema.index({ createdAt: -1 });
testRunSchema.index({ branch: 1, createdAt: -1 });

export const TestRun = mongoose.model<ITestRun>('TestRun', testRunSchema);
