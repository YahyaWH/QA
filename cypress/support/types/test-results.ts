/**
 * TypeScript interfaces for test results and reporting
 * Used throughout the test automation pipeline
 */

/**
 * Individual step in test execution
 */
export interface TestStep {
  stepNumber: number;
  description: string;
  timestamp: number;
  source: 'manual' | 'auto';
  type?: 'navigation' | 'action' | 'input' | 'assertion' | 'wait' | 'setup';
  selector?: string;
  value?: string;
  isFailed?: boolean;
}

/**
 * Error classification for failed tests
 */
export interface ErrorClassification {
  type: 'BACKEND' | 'FRONTEND' | 'INCONCLUSIVE';
  evidence: string[];
  likelyCause: string;
  failedRequests: NetworkRequest[];
  consoleErrors: string[];
}

/**
 * Browser console log entry
 */
export interface ConsoleLog {
  type: 'log' | 'error' | 'warn' | 'info' | 'debug';
  message: string;
  timestamp: number;
}

/**
 * Network request captured during test
 */
export interface NetworkRequest {
  method: string;
  url: string;
  status: number;
  duration: number;
  timestamp: number;
}

/**
 * Runtime test context data
 */
export interface TestContext {
  testId: string;
  testTitle: string;
  startTime: number;
  endTime?: number;
  steps: TestStep[];
  consoleLogs: ConsoleLog[];
  networkRequests: NetworkRequest[];
  screenshots: string[];
  videoPath?: string;
  domState?: string;
  retryCount: number;
}

/**
 * Complete test result
 */
export interface TestResult {
  testId: string; // "FR-020-001"
  frNumber: string; // "FR-020"
  testNumber: string; // "001"
  description: string; // "Search Input Display"
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  duration: number; // milliseconds
  retryCount: number;
  timestamp: string; // ISO format
  stepsToReproduce: string; // Numbered list as string
  screenshotUrl: string; // GitHub artifact URL or empty
  videoUrl: string; // GitHub artifact URL or empty
  consoleLogs: string; // Formatted console output
  networkRequests: string; // Formatted network activity
  errorStack: string; // Full error (if failed)
  errorClassification: string; // "BACKEND" / "FRONTEND" / "INCONCLUSIVE" with evidence
  domStateAtFailure: string; // HTML snapshot (if failed)
  environment: string; // "GitHub Actions" or "Local"
  browser: string; // "Chrome 120.0"
  viewport: string; // "1280x720"
}

/**
 * Mochawesome test object from JSON report
 */
export interface MochawesomeTest {
  title: string;
  fullTitle: string;
  file?: string;
  duration?: number;
  currentRetry?: number;
  err?: {
    message: string;
    estack?: string;
    diff?: string;
  };
  state?: 'passed' | 'failed' | 'pending';
  pass?: boolean;
  fail?: boolean;
  pending?: boolean;
  code?: string;
  isHook?: boolean;
  skipped?: boolean;
  context?: string;
}

/**
 * Mochawesome suite object
 */
export interface MochawesomeSuite {
  title: string;
  fullFile?: string;
  file?: string;
  tests: MochawesomeTest[];
  suites: MochawesomeSuite[];
  passes?: string[];
  failures?: string[];
  pending?: string[];
  skipped?: string[];
  duration?: number;
  root?: boolean;
  rootEmpty?: boolean;
  _timeout?: number;
}

/**
 * Mochawesome result object (root)
 */
export interface MochawesomeResult {
  stats: {
    suites: number;
    tests: number;
    passes: number;
    pending: number;
    failures: number;
    start: string;
    end: string;
    duration: number;
    testsRegistered: number;
    passPercent: number;
    pendingPercent: number;
    other: number;
    hasOther: boolean;
    skipped: number;
    hasSkipped: boolean;
  };
  results: MochawesomeSuite[];
  meta: {
    mocha: {
      version: string;
    };
    mochawesome: {
      options: Record<string, unknown>;
      version: string;
    };
    marge: {
      options: Record<string, unknown>;
      version: string;
    };
  };
}

/**
 * Saved test context from JSON file
 */
export interface SavedTestContext extends TestContext {
  savedAt: string;
}

/**
 * TestResult enriched with structured data for MongoDB persistence.
 * The flat string fields remain for Slack/HTML consumers;
 * the structured fields feed the QA API.
 */
export interface EnrichedTestResult extends TestResult {
  _classification?: ErrorClassification | null;
  _steps?: TestStep[];
  _consoleLogs?: ConsoleLog[];
  _networkRequests?: NetworkRequest[];
  _domState?: string;
}
