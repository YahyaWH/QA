#!/usr/bin/env ts-node
/**
 * Generate Artifact URLs Script
 * Creates artifact base URL for GitHub Actions
 *
 * Usage: npm run sheets:artifacts
 */

import * as fs from 'fs';
import * as path from 'path';

const RESULTS_DIR = path.join(process.cwd(), 'cypress/results');
const OUTPUT_FILE = path.join(RESULTS_DIR, 'artifact-base-url.txt');

function generateArtifactUrls(): void {
  console.log('🔗 Generating artifact URLs...\n');

  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;

  if (!repository || !runId) {
    console.log('⚠️  Not running in GitHub Actions');
    console.log('   GITHUB_REPOSITORY:', repository || 'not set');
    console.log('   GITHUB_RUN_ID:', runId || 'not set');
    console.log('\n   Skipping artifact URL generation.');
    return;
  }

  const baseUrl = `https://github.com/${repository}/actions/runs/${runId}`;

  // Ensure results directory exists
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  // Save to file
  fs.writeFileSync(OUTPUT_FILE, baseUrl);

  console.log('✅ Artifact base URL generated:');
  console.log(`   ${baseUrl}`);
  console.log(`\n   Saved to: ${OUTPUT_FILE}`);
}

// Run
generateArtifactUrls();
