#!/usr/bin/env ts-node
/**
 * Generate Report Script
 * Processes Cypress test results and contexts into a unified report
 *
 * Usage: npm run sheets:generate
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  loadMochawesomeResults,
  loadTestContexts,
  processResults,
  groupByFr,
} from '../plugins/test-reporter';

const RESULTS_DIR = path.join(process.cwd(), 'cypress/results');
const MOCHAWESOME_DIR = path.join(RESULTS_DIR, 'mochawesome');
const CONTEXTS_DIR = path.join(RESULTS_DIR, 'contexts');
const OUTPUT_FILE = path.join(RESULTS_DIR, 'sheets-report.json');

async function generateReport(): Promise<void> {
  console.log('📊 Generating test report...\n');

  // Check if directories exist
  if (!fs.existsSync(MOCHAWESOME_DIR)) {
    console.warn('Mochawesome directory not found: ' + MOCHAWESOME_DIR);
    console.log('   No test results to process. Generating empty report.');
    // Fall through with empty results
  }

  // Load artifact base URL from environment or file
  let artifactBaseUrl: string | undefined;
  const artifactUrlFile = path.join(RESULTS_DIR, 'artifact-base-url.txt');
  if (fs.existsSync(artifactUrlFile)) {
    artifactBaseUrl = fs.readFileSync(artifactUrlFile, 'utf-8').trim();
  } else if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID) {
    artifactBaseUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  }

  console.log('📂 Loading Mochawesome results...');
  const mochawesomeResults = loadMochawesomeResults(MOCHAWESOME_DIR);
  console.log(`   Found ${mochawesomeResults.length} report file(s)`);

  console.log('📂 Loading test contexts...');
  const contexts = loadTestContexts(CONTEXTS_DIR);
  console.log(`   Found ${contexts.byId.size} context file(s) (${contexts.byTitle.size} by title)`);

  console.log('\n🔄 Processing results...');
  const results = processResults(mochawesomeResults, contexts, artifactBaseUrl);
  console.log(`   Processed ${results.length} test result(s)`);

  // Group by FR
  const grouped = groupByFr(results);
  console.log(`   Found ${grouped.size} FR group(s):`);
  grouped.forEach((tests, frNumber) => {
    const passed = tests.filter((t) => t.status === 'PASSED').length;
    const failed = tests.filter((t) => t.status === 'FAILED').length;
    console.log(`     ${frNumber}: ${tests.length} tests (${passed} passed, ${failed} failed)`);
  });

  // Save to file
  const reportData = {
    generatedAt: new Date().toISOString(),
    artifactBaseUrl,
    summary: {
      totalTests: results.length,
      passed: results.filter((r) => r.status === 'PASSED').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
      frGroups: grouped.size,
    },
    results,
  };

  // Strip underscore-prefixed fields from JSON (they're only for API persistence)
  const jsonSafe = JSON.stringify(reportData, (key, value) =>
    key.startsWith('_') ? undefined : value as unknown, 2);
  fs.writeFileSync(OUTPUT_FILE, jsonSafe);
  console.log(`\n✅ Report generated: ${OUTPUT_FILE}`);

  // Print summary
  console.log('\n📈 Summary:');
  console.log(`   Total Tests: ${reportData.summary.totalTests}`);
  console.log(`   Passed: ${reportData.summary.passed}`);
  console.log(`   Failed: ${reportData.summary.failed}`);
  console.log(
    `   Pass Rate: ${reportData.summary.totalTests > 0 ? ((reportData.summary.passed / reportData.summary.totalTests) * 100).toFixed(1) : '0.0'}%`
  );

  // ---- Persist to QA API (MongoDB) ----
  await persistToApi(reportData);
}

async function persistToApi(reportData: {
  generatedAt: string;
  artifactBaseUrl?: string;
  summary: { totalTests: number; passed: number; failed: number; frGroups: number };
  results: import('../support/types/test-results').EnrichedTestResult[];
}): Promise<void> {
  const apiUrl = process.env.QA_API_URL;
  if (!apiUrl) {
    console.log('\nQA_API_URL not set. Skipping MongoDB persistence.');
    return;
  }

  const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
  const branch = process.env.GITHUB_REF_NAME || 'local';
  const commitSha = process.env.GITHUB_SHA || 'unknown';
  const trigger = process.env.GITHUB_EVENT_NAME as string || 'local';
  const skipped = reportData.results.filter((r) => r.status === 'SKIPPED').length;

  console.log(`\n📡 Persisting to QA API (${apiUrl})...`);

  try {
    // Create the test run
    const runPayload = {
      runId,
      trigger,
      branch,
      commitSha,
      summary: {
        totalTests: reportData.summary.totalTests,
        passed: reportData.summary.passed,
        failed: reportData.summary.failed,
        skipped,
        passRate: reportData.summary.totalTests > 0
          ? Number(((reportData.summary.passed / reportData.summary.totalTests) * 100).toFixed(1))
          : 0,
        duration: reportData.results.reduce((sum, r) => sum + r.duration, 0),
      },
      environment: {
        runner: process.env.GITHUB_ACTIONS ? 'GitHub Actions' : 'Local',
        browser: process.env.BROWSER || 'Chrome',
        viewport: '1280x720',
        nodeVersion: process.version,
        cypressVersion: '',
      },
      artifacts: {
        artifactBaseUrl: reportData.artifactBaseUrl,
      },
      generatedAt: reportData.generatedAt,
    };

    const runRes = await fetch(`${apiUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runPayload),
    });

    if (!runRes.ok && runRes.status !== 409) {
      console.error(`   Failed to create run: ${runRes.status} ${await runRes.text()}`);
      return;
    }
    console.log(`   Run created: ${runId}`);

    // Bulk insert test results (structured data for MongoDB schema)
    const resultPayloads = reportData.results.map((r) => ({
      testId: r.testId,
      frNumber: r.frNumber,
      testNumber: r.testNumber,
      description: r.description,
      status: r.status,
      duration: r.duration,
      retryCount: r.retryCount,
      // Structured error object (matches api/models/test-result.ts schema)
      error: r.status === 'FAILED' && r.errorStack ? {
        stack: r.errorStack,
        classification: r._classification ? {
          type: r._classification.type,
          evidence: r._classification.evidence,
          likelyCause: r._classification.likelyCause,
          failedRequests: r._classification.failedRequests,
          consoleErrors: r._classification.consoleErrors,
        } : undefined,
        domStateAtFailure: r._domState || undefined,
      } : undefined,
      // Structured arrays from test context
      steps: r._steps || [],
      consoleLogs: r._consoleLogs || [],
      networkRequests: r._networkRequests || [],
      screenshotUrl: r.screenshotUrl || undefined,
      videoUrl: r.videoUrl || undefined,
      environment: r.environment,
      browser: r.browser,
      viewport: r.viewport,
      timestamp: r.timestamp,
    }));

    const resultsRes = await fetch(`${apiUrl}/api/v1/runs/${runId}/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resultPayloads),
    });

    if (resultsRes.ok || resultsRes.status === 409) {
      const body = await resultsRes.json() as { inserted: number };
      console.log(`   Results persisted: ${body.inserted} test(s)`);
    } else {
      console.error(`   Failed to persist results: ${resultsRes.status}`);
    }
  } catch (err) {
    console.error('   QA API not reachable (skipping persistence):', (err as Error).message);
  }
}

// Run
generateReport().catch((error) => {
  console.error('❌ Failed to generate report:', error);
  process.exit(1);
});
