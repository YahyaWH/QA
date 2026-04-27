import mongoose, { Schema, type Document } from 'mongoose';

export interface INetworkRequest {
  method: string;
  url: string;
  status: number;
  duration: number;
  timestamp: number;
}

export interface IConsoleLog {
  type: 'log' | 'error' | 'warn' | 'info' | 'debug';
  message: string;
  timestamp: number;
}

export interface ITestStep {
  stepNumber: number;
  description: string;
  timestamp: number;
  source: 'manual' | 'auto';
  type?: string;
  selector?: string;
  value?: string;
  isFailed?: boolean;
}

export interface ITestResult extends Document {
  runId: string;
  testId: string;
  frNumber: string;
  testNumber: string;
  description: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  duration: number;
  retryCount: number;
  error?: {
    stack: string;
    classification: {
      type: 'BACKEND' | 'FRONTEND' | 'INCONCLUSIVE';
      evidence: string[];
      likelyCause: string;
      failedRequests: INetworkRequest[];
      consoleErrors: string[];
    };
    domStateAtFailure?: string;
  };
  steps: ITestStep[];
  consoleLogs: IConsoleLog[];
  networkRequests: INetworkRequest[];
  screenshotUrl?: string;
  videoUrl?: string;
  environment: string;
  browser: string;
  viewport: string;
  slack?: {
    channelId: string;
    threadTs: string;
  };
  investigationStatus: 'pending' | 'in_progress' | 'complete' | 'skipped';
  timestamp: Date;
  createdAt: Date;
  expiresAt: Date;
}

const networkRequestSchema = new Schema<INetworkRequest>(
  {
    method: String,
    url: String,
    status: Number,
    duration: Number,
    timestamp: Number,
  },
  { _id: false }
);

const consoleLogSchema = new Schema<IConsoleLog>(
  {
    type: { type: String, enum: ['log', 'error', 'warn', 'info', 'debug'] },
    message: String,
    timestamp: Number,
  },
  { _id: false }
);

const testStepSchema = new Schema<ITestStep>(
  {
    stepNumber: Number,
    description: String,
    timestamp: Number,
    source: { type: String, enum: ['manual', 'auto'] },
    type: String,
    selector: String,
    value: String,
    isFailed: Boolean,
  },
  { _id: false }
);

const testResultSchema = new Schema<ITestResult>(
  {
    runId: { type: String, required: true },
    testId: { type: String, required: true },
    frNumber: { type: String, required: true },
    testNumber: { type: String, required: true },
    description: { type: String, required: true },
    status: { type: String, enum: ['PASSED', 'FAILED', 'SKIPPED'], required: true },
    duration: { type: Number, required: true },
    retryCount: { type: Number, default: 0 },
    error: {
      stack: String,
      classification: {
        type: {
          type: String,
          enum: ['BACKEND', 'FRONTEND', 'INCONCLUSIVE'],
        },
        evidence: [String],
        likelyCause: String,
        failedRequests: [networkRequestSchema],
        consoleErrors: [String],
      },
      domStateAtFailure: String,
    },
    steps: [testStepSchema],
    consoleLogs: [consoleLogSchema],
    networkRequests: [networkRequestSchema],
    screenshotUrl: String,
    videoUrl: String,
    environment: { type: String, required: true },
    browser: { type: String, required: true },
    viewport: { type: String, required: true },
    slack: {
      channelId: String,
      threadTs: String,
    },
    investigationStatus: {
      type: String,
      enum: ['pending', 'in_progress', 'complete', 'skipped'],
      default: 'skipped',
    },
    timestamp: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

testResultSchema.index({ runId: 1, testId: 1 }, { unique: true });
testResultSchema.index({ testId: 1, createdAt: -1 });
testResultSchema.index({ status: 1, investigationStatus: 1 });
testResultSchema.index({ runId: 1, status: 1 });

export const TestResult = mongoose.model<ITestResult>('TestResult', testResultSchema);
