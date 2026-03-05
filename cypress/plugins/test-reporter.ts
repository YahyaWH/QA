/**
 * Test Reporter Plugin
 * Processes Mochawesome results and test contexts to generate unified test report
 */

import * as fs from 'fs';
import * as path from 'path';
import dayjs from 'dayjs';
import type {
  TestResult,
  EnrichedTestResult,
  TestStep,
  MochawesomeResult,
  MochawesomeSuite,
  MochawesomeTest,
  SavedTestContext,
} from '../support/types/test-results';
import { classifyError, formatClassification } from './error-classifier';

/**
 * Load and merge all Mochawesome JSON reports
 */
export function loadMochawesomeResults(reportDir: string): MochawesomeResult[] {
  const results: MochawesomeResult[] = [];

  if (!fs.existsSync(reportDir)) {
    console.warn(`Report directory not found: ${reportDir}`);
    return results;
  }

  const files = fs.readdirSync(reportDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(reportDir, file), 'utf-8');
      const data = JSON.parse(content) as MochawesomeResult;
      results.push(data);
    } catch (error) {
      console.warn(`Failed to parse ${file}:`, error);
    }
  }

  return results;
}

/**
 * Load all test context JSON files.
 * Returns two maps:
 *  - byId: keyed by the file name (e.g. "FR-020-015")
 *  - byTitle: keyed by the testTitle stored inside the JSON
 * The second map is used as a fallback when the ID-based lookup fails
 * (e.g. for multi-test single-file specs like FR-001-login.cy.ts).
 */
export interface TestContextMaps {
  byId: Map<string, SavedTestContext>;
  byTitle: Map<string, SavedTestContext>;
}

export function loadTestContexts(contextDir: string): TestContextMaps {
  const byId = new Map<string, SavedTestContext>();
  const byTitle = new Map<string, SavedTestContext>();

  if (!fs.existsSync(contextDir)) {
    console.warn(`Context directory not found: ${contextDir}`);
    return { byId, byTitle };
  }

  const files = fs.readdirSync(contextDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(contextDir, file), 'utf-8');
      const data = JSON.parse(content) as SavedTestContext;
      const fileId = path.basename(file, '.json');
      byId.set(fileId, data);

      // Also index by test title for fallback matching
      if (data.testTitle) {
        byTitle.set(data.testTitle, data);
      }
    } catch (error) {
      console.warn(`Failed to parse context ${file}:`, error);
    }
  }

  return { byId, byTitle };
}

/**
 * Extract test ID from file path or title
 */
export function extractTestId(filePath: string, title: string): string {
  // Try to extract from file path first (e.g., FR-020-001.cy.ts)
  const fileMatch = filePath.match(/(FR|PD)-(\d+)-(\d+)\.cy\.ts/);
  if (fileMatch) {
    return `${fileMatch[1]}-${fileMatch[2]}-${fileMatch[3]}`;
  }

  // Try to extract from title (e.g., "[FR020-TC-001]")
  const titleMatch = title.match(/\[FR(\d+)-TC-(\d+)\]/);
  if (titleMatch) {
    return `FR-${titleMatch[1].padStart(3, '0')}-${titleMatch[2].padStart(3, '0')}`;
  }

  // Try to extract PD-prefixed IDs from title (e.g., "[PD042-TC-001]")
  const pdTitleMatch = title.match(/\[PD(\d+)-TC-(\d+)\]/);
  if (pdTitleMatch) {
    return `PD-${pdTitleMatch[1].padStart(3, '0')}-${pdTitleMatch[2].padStart(3, '0')}`;
  }

  // Fallback to generating from file name
  const baseName = path.basename(filePath, '.cy.ts');
  return baseName;
}

/**
 * Extract FR/PD number from test ID
 */
export function extractFrNumber(testId: string): string {
  const frMatch = testId.match(/FR-(\d+)/);
  if (frMatch) return `FR-${frMatch[1]}`;

  const pdMatch = testId.match(/PD-(\d+)/);
  if (pdMatch) return `PD-${pdMatch[1]}`;

  return 'FR-UNKNOWN';
}

/**
 * Flatten Mochawesome suites to get all tests
 */
function flattenTests(suite: MochawesomeSuite, filePath: string): MochawesomeTest[] {
  let tests: MochawesomeTest[] = [];

  // Add tests from this suite
  for (const test of suite.tests || []) {
    tests.push({
      ...test,
      file: filePath || suite.fullFile || suite.file,
    });
  }

  // Recursively add tests from nested suites
  for (const nestedSuite of suite.suites || []) {
    tests = tests.concat(flattenTests(nestedSuite, filePath || suite.fullFile || suite.file || ''));
  }

  return tests;
}

/**
 * Process Mochawesome results and contexts into TestResult objects
 */
export function processResults(
  mochawesomeResults: MochawesomeResult[],
  contexts: TestContextMaps,
  artifactBaseUrl?: string
): EnrichedTestResult[] {
  const results: EnrichedTestResult[] = [];

  for (const report of mochawesomeResults) {
    for (const suite of report.results) {
      const tests = flattenTests(suite, '');

      for (const test of tests) {
        // Skip hooks
        if (test.isHook) continue;

        const filePath = test.file || '';
        const testId = extractTestId(filePath, test.fullTitle || test.title);
        const frNumber = extractFrNumber(testId);
        const testNumberMatch = testId.match(/(?:FR|PD)-\d+-(\d+)/);
        const testNumber = testNumberMatch ? testNumberMatch[1] : '000';

        // Get context: try by ID first, then fall back to title-based lookup
        const context = contexts.byId.get(testId) || contexts.byTitle.get(test.title) || undefined;

        // Determine status
        const status: 'PASSED' | 'FAILED' | 'SKIPPED' =
          test.state === 'passed' || test.pass ? 'PASSED' :
          test.state === 'pending' || test.pending ? 'SKIPPED' : 'FAILED';

        // Format steps -- merge manual + auto, prefer manual when overlapping
        let stepsToReproduce = 'No steps recorded';
        if (context?.steps && context.steps.length > 0) {
          const merged = mergeSteps(context.steps);
          stepsToReproduce = merged
            .map((step, i) => {
              const num = i + 1;
              const prefix = step.isFailed ? '❌ FAILED: ' : '';
              return `${num}. ${prefix}${step.description}`;
            })
            .join('\n');
        }

        // Format console logs
        let consoleLogs = '';
        if (context?.consoleLogs && context.consoleLogs.length > 0) {
          consoleLogs = context.consoleLogs
            .slice(-20) // Last 20 logs
            .map((log) => `[${log.type.toUpperCase()}] ${log.message}`)
            .join('\n');
        }

        // Format network requests
        let networkRequests = '';
        if (context?.networkRequests && context.networkRequests.length > 0) {
          networkRequests = context.networkRequests
            .filter((req) => !req.url.includes('/__cypress'))
            .slice(-15) // Last 15 requests
            .map((req) => {
              const statusIcon = req.status >= 400 ? '❌' : '✅';
              return `${statusIcon} ${req.method} ${req.url} → ${req.status} (${req.duration}ms)`;
            })
            .join('\n');
        }

        // Error stack
        let errorStack = '';
        if (test.err?.message || test.err?.estack) {
          errorStack = [test.err.message, test.err.estack].filter(Boolean).join('\n\n');
        }

        // Error classification (only for failed tests)
        let errorClassification = '';
        let rawClassification = null;
        if (status === 'FAILED' && errorStack) {
          rawClassification = classifyError(context, errorStack);
          errorClassification = formatClassification(rawClassification);
        }

        // DOM state at failure
        const domStateAtFailure = context?.domState || '';

        // Screenshots and videos
        const screenshotUrl = artifactBaseUrl ? `${artifactBaseUrl} (View artifacts)` : '';
        const videoUrl = artifactBaseUrl ? `${artifactBaseUrl} (View artifacts)` : '';

        // Environment info
        const environment = process.env.GITHUB_ACTIONS ? 'GitHub Actions' : 'Local';
        const browser = process.env.BROWSER || 'Chrome';
        const viewport = '1280x720';

        // Merge steps for structured storage
        const mergedSteps = context?.steps ? mergeSteps(context.steps) : [];

        const result: EnrichedTestResult = {
          testId,
          frNumber,
          testNumber,
          description: test.title,
          status,
          duration: test.duration || 0,
          retryCount: context?.retryCount || test.currentRetry || 0,
          timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
          stepsToReproduce,
          screenshotUrl,
          videoUrl,
          consoleLogs,
          networkRequests,
          errorStack,
          errorClassification,
          domStateAtFailure,
          environment,
          browser,
          viewport,
          // Structured data for MongoDB (underscore-prefixed to avoid serialization clashes)
          _classification: rawClassification,
          _steps: mergedSteps,
          _consoleLogs: context?.consoleLogs,
          _networkRequests: context?.networkRequests,
          _domState: context?.domState,
        };

        results.push(result);
      }
    }
  }

  // Sort by test ID
  results.sort((a, b) => a.testId.localeCompare(b.testId));

  return results;
}

/**
 * Merge manual and auto-generated steps.
 *
 * Rules:
 *  - If a manual step and an auto step occur within 200ms and describe a similar
 *    action (same selector or overlapping description), keep only the manual step.
 *  - Deduplicate consecutive identical descriptions.
 *  - Always keep the failed-step sentinel.
 */
function mergeSteps(raw: TestStep[]): TestStep[] {
  if (raw.length === 0) return [];

  const result: TestStep[] = [];
  let i = 0;

  while (i < raw.length) {
    const current = raw[i];

    // Always keep failed sentinel
    if (current.isFailed) {
      result.push(current);
      i++;
      continue;
    }

    // If this is a manual step, look ahead for nearby auto steps to suppress
    if (current.source === 'manual') {
      result.push(current);
      // Skip auto steps within 200ms that overlap
      let j = i + 1;
      while (j < raw.length && raw[j].source === 'auto' && !raw[j].isFailed) {
        const timeDiff = raw[j].timestamp - current.timestamp;
        if (timeDiff >= 0 && timeDiff < 200) {
          // Suppress this auto step -- the manual one covers it
          j++;
        } else {
          break;
        }
      }
      i = j;
      continue;
    }

    // If this is an auto step, check if a manual step follows within 200ms
    if (current.source === 'auto') {
      const next = raw[i + 1];
      if (
        next &&
        next.source === 'manual' &&
        !next.isFailed &&
        next.timestamp - current.timestamp >= 0 &&
        next.timestamp - current.timestamp < 200
      ) {
        // Skip this auto step, the manual one coming next is better
        i++;
        continue;
      }

      // Deduplicate consecutive identical auto steps
      if (result.length > 0 && result[result.length - 1].description === current.description) {
        i++;
        continue;
      }

      result.push(current);
      i++;
      continue;
    }

    result.push(current);
    i++;
  }

  return result;
}

/**
 * Group results by FR number
 */
export function groupByFr(results: TestResult[]): Map<string, TestResult[]> {
  const grouped = new Map<string, TestResult[]>();

  for (const result of results) {
    const frNumber = result.frNumber;
    if (!grouped.has(frNumber)) {
      grouped.set(frNumber, []);
    }
    grouped.get(frNumber)!.push(result);
  }

  return grouped;
}
