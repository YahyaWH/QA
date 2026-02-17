#!/usr/bin/env ts-node
/**
 * Generate Report Script
 * Processes Cypress test results and contexts into a unified report
 *
 * Usage: npm run sheets:generate
 */

import * as fs from 'fs';
import * as path from 'path';
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
    console.error(`❌ Mochawesome directory not found: ${MOCHAWESOME_DIR}`);
    console.log('   Run tests first: npm run cypress:run');
    process.exit(1);
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

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(reportData, null, 2));
  console.log(`\n✅ Report generated: ${OUTPUT_FILE}`);

  // Print summary
  console.log('\n📈 Summary:');
  console.log(`   Total Tests: ${reportData.summary.totalTests}`);
  console.log(`   Passed: ${reportData.summary.passed}`);
  console.log(`   Failed: ${reportData.summary.failed}`);
  console.log(
    `   Pass Rate: ${((reportData.summary.passed / reportData.summary.totalTests) * 100).toFixed(1)}%`
  );
}

// Run
generateReport().catch((error) => {
  console.error('❌ Failed to generate report:', error);
  process.exit(1);
});
