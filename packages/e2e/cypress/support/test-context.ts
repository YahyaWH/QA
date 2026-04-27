/**
 * Test Context Manager
 * Singleton class to store test execution data during runtime
 * Accessible throughout the test lifecycle
 */

import type { TestContext, TestStep, ConsoleLog, NetworkRequest } from './types/test-results';

/**
 * TestContextManager class - manages test execution data
 */
class TestContextManager {
  private context: TestContext;
  private stepCounter: number;

  constructor() {
    this.context = this.createEmptyContext();
    this.stepCounter = 0;
  }

  /**
   * Create an empty context
   */
  private createEmptyContext(): TestContext {
    return {
      testId: '',
      testTitle: '',
      startTime: Date.now(),
      steps: [],
      consoleLogs: [],
      networkRequests: [],
      screenshots: [],
      retryCount: 0,
    };
  }

  /**
   * Reset context for a new test
   */
  reset(): void {
    this.context = this.createEmptyContext();
    this.stepCounter = 0;
  }

  /**
   * Set test ID (extracted from file path)
   */
  setTestId(testId: string): void {
    this.context.testId = testId;
  }

  /**
   * Set test title
   */
  setTestTitle(title: string): void {
    this.context.testTitle = title;
  }

  /**
   * Set start time
   */
  setStartTime(time: number): void {
    this.context.startTime = time;
  }

  /**
   * Set end time
   */
  setEndTime(time: number): void {
    this.context.endTime = time;
  }

  /**
   * Add a test step
   */
  addStep(
    description: string,
    options: {
      isFailed?: boolean;
      source?: 'manual' | 'auto';
      type?: 'navigation' | 'action' | 'input' | 'assertion' | 'wait' | 'setup';
      selector?: string;
      value?: string;
    } = {}
  ): void {
    this.stepCounter++;
    const step: TestStep = {
      stepNumber: this.stepCounter,
      description,
      timestamp: Date.now(),
      source: options.source || 'manual',
      type: options.type,
      selector: options.selector,
      value: options.value,
      isFailed: options.isFailed,
    };
    this.context.steps.push(step);
  }

  /**
   * Add a console log entry
   */
  addConsoleLog(type: 'log' | 'error' | 'warn' | 'info' | 'debug', message: string): void {
    const log: ConsoleLog = {
      type,
      message,
      timestamp: Date.now(),
    };
    this.context.consoleLogs.push(log);
  }

  /**
   * Add a network request
   */
  addNetworkRequest(request: NetworkRequest): void {
    this.context.networkRequests.push(request);
  }

  /**
   * Add a screenshot path
   */
  addScreenshot(path: string): void {
    this.context.screenshots.push(path);
  }

  /**
   * Set video path
   */
  setVideoPath(path: string): void {
    this.context.videoPath = path;
  }

  /**
   * Set DOM state (for failures)
   */
  setDomState(html: string): void {
    // Truncate if too long (limit to 5000 chars)
    if (html.length > 5000) {
      this.context.domState = html.substring(0, 5000) + '... (truncated)';
    } else {
      this.context.domState = html;
    }
  }

  /**
   * Set retry count
   */
  setRetryCount(count: number): void {
    this.context.retryCount = count;
  }

  /**
   * Get current context
   */
  getContext(): TestContext {
    return structuredClone(this.context);
  }

  /**
   * Get steps as formatted string for "Steps to Reproduce"
   */
  getFormattedSteps(): string {
    if (this.context.steps.length === 0) {
      return 'No steps recorded';
    }

    return this.context.steps
      .map((step) => {
        const prefix = step.isFailed ? '❌ FAILED: ' : '';
        return `${step.stepNumber}. ${prefix}${step.description}`;
      })
      .join('\n');
  }

  /**
   * Get console logs as formatted string
   */
  getFormattedConsoleLogs(): string {
    if (this.context.consoleLogs.length === 0) {
      return '';
    }

    return this.context.consoleLogs
      .map((log) => {
        const timestamp = new Date(log.timestamp).toISOString();
        return `[${timestamp}] [${log.type.toUpperCase()}] ${log.message}`;
      })
      .join('\n');
  }

  /**
   * Get network requests as formatted string
   */
  getFormattedNetworkRequests(): string {
    if (this.context.networkRequests.length === 0) {
      return '';
    }

    return this.context.networkRequests
      .map((req) => {
        const statusText = req.status >= 400 ? '❌' : '✅';
        return `${statusText} ${req.method} ${req.url} → ${req.status} (${req.duration}ms)`;
      })
      .join('\n');
  }
}

/**
 * Export singleton instance
 */
export const testContext = new TestContextManager();
