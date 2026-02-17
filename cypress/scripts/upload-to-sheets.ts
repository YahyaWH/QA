#!/usr/bin/env ts-node
/**
 * Upload to Google Sheets Script
 * Optionally uploads artifacts to Google Drive first, then uploads
 * test results (with Drive links) to Google Sheets.
 *
 * Usage: npm run sheets:upload
 *
 * Required environment variables:
 * - GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_PATH
 * - GOOGLE_SHEET_ID
 *
 * Optional environment variables:
 * - GOOGLE_DRIVE_FOLDER_ID  — if set, screenshots & videos are uploaded
 *   to Google Drive and clickable HYPERLINK formulas are written into the
 *   Screenshot / Video columns.  If unset, those columns remain plain text.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { GoogleSheetsClient } from '../plugins/sheets-uploader';
import { GoogleDriveClient, ArtifactLinks } from '../plugins/drive-uploader';
import type { TestResult } from '../support/types/test-results';

const RESULTS_DIR = path.join(process.cwd(), 'cypress/results');
const REPORT_FILE = path.join(RESULTS_DIR, 'sheets-report.json');
const SCREENSHOTS_DIR = path.join(process.cwd(), 'cypress/screenshots');
const VIDEOS_DIR = path.join(process.cwd(), 'cypress/videos');

// README sheet content
const README_CONTENT = [
  ['QA - Automated Tests'],
  [''],
  ['Overview'],
  ['This spreadsheet contains automated test results from Cypress E2E tests.'],
  ['Tests run automatically on every push to main/develop and daily at 8 AM UTC.'],
  [''],
  ['Sheet Organization'],
  ['- README (this sheet) - Documentation and guide'],
  ['- FR-XXX sheets - Test results for each Functional Requirement'],
  [''],
  ['Column Definitions'],
  ['Test ID - Unique identifier (e.g., FR-020-001)'],
  ['Description - What the test validates'],
  ['Status - PASSED or FAILED'],
  ['Duration - Test execution time in milliseconds'],
  ['Retry Count - Number of retry attempts'],
  ['Timestamp - When the test ran'],
  ['Steps to Reproduce - Numbered list of actions taken'],
  ['Screenshot - Clickable link to failure screenshot in Google Drive'],
  ['Video - Clickable link to test video in Google Drive'],
  ['Console Logs - Browser console output'],
  ['Network Requests - API calls made during test'],
  ['Error Stack - Full error details (if failed)'],
  ['Error Classification - BACKEND / FRONTEND / INCONCLUSIVE with evidence'],
  ['DOM State - HTML snapshot at failure (if failed)'],
  ['Environment - Where test ran (GitHub Actions or Local)'],
  ['Browser - Browser used for testing'],
  ['Viewport - Screen resolution used'],
  [''],
  ['Color Coding'],
  ['Green background = Test PASSED'],
  ['Red background = Test FAILED'],
  ['Orange Error Classification = BACKEND issue'],
  ['Blue Error Classification = FRONTEND issue'],
  ['Gray Error Classification = INCONCLUSIVE'],
  [''],
  ['Update Frequency'],
  ['- On Push: Every commit to main/develop triggers tests'],
  ['- Scheduled: Daily at 8:00 AM UTC'],
  ['- Manual: Can be triggered manually via GitHub Actions'],
  [''],
  ['Last Updated'],
  [`${new Date().toISOString()}`],
];

interface ReportData {
  generatedAt: string;
  artifactBaseUrl?: string;
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    frGroups: number;
  };
  results: TestResult[];
}

// ---------------------------------------------------------------------------
// Credential loading (shared between Sheets and Drive clients)
// ---------------------------------------------------------------------------

function loadCredentials(): object {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log('   Using credentials from GOOGLE_CREDENTIALS_JSON env var');
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  if (process.env.GOOGLE_CREDENTIALS) {
    console.log('   Using credentials from GOOGLE_CREDENTIALS env var');
    return JSON.parse(process.env.GOOGLE_CREDENTIALS);
  }
  if (process.env.GOOGLE_CREDENTIALS_PATH) {
    const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
    if (!fs.existsSync(credPath)) {
      console.error(`❌ Credentials file not found: ${credPath}`);
      process.exit(1);
    }
    console.log(`   Using credentials from file: ${credPath}`);
    return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  }
  console.error('❌ No Google credentials provided.');
  console.log('   Set GOOGLE_CREDENTIALS_JSON, GOOGLE_CREDENTIALS, or GOOGLE_CREDENTIALS_PATH');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Google Drive artifact upload
// ---------------------------------------------------------------------------

async function uploadArtifactsToDrive(credentials: object): Promise<ArtifactLinks> {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    console.log('\n⏭️  GOOGLE_DRIVE_FOLDER_ID not set — skipping Drive upload.');
    console.log('   Screenshot / Video columns will contain plain text.');
    return {};
  }

  console.log('\n📁 Uploading artifacts to Google Drive...');
  console.log(`   Target folder: ${folderId}`);

  const drive = new GoogleDriveClient(credentials, folderId);

  // Build a run label like "Run 2026-02-16T14-30-00Z"
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
  const runLabel = `Run ${now}`;
  console.log(`   Run label: ${runLabel}`);

  const links = await drive.uploadAllArtifacts(SCREENSHOTS_DIR, VIDEOS_DIR, runLabel);

  const testIds = Object.keys(links);
  const withScreenshots = testIds.filter((id) => links[id].screenshotUrl).length;
  const withVideos = testIds.filter((id) => links[id].videoUrl).length;
  console.log(
    `\n   Drive upload complete: ${withScreenshots} screenshot(s), ${withVideos} video(s) linked to ${testIds.length} test(s).`
  );

  return links;
}

// ---------------------------------------------------------------------------
// Inject Drive links into test results
// ---------------------------------------------------------------------------

/**
 * Replace screenshotUrl / videoUrl on each TestResult with a Google Sheets
 * =HYPERLINK() formula pointing to the Google Drive file, or a short FR-level
 * fallback link when an exact test-level match isn't available.
 *
 * Sheets' USER_ENTERED mode will interpret the formula and render a clickable
 * link in the cell.
 */
function injectDriveLinks(results: TestResult[], links: ArtifactLinks): void {
  if (Object.keys(links).length === 0) return;

  for (const result of results) {
    const exact = links[result.testId];
    // Fallback: try the FR-level key (e.g. "FR-001" for multi-test files)
    const frLevel = links[result.frNumber];

    const screenshotUrl = exact?.screenshotUrl || frLevel?.screenshotUrl;
    const videoUrl = exact?.videoUrl || frLevel?.videoUrl;

    if (screenshotUrl) {
      result.screenshotUrl = `=HYPERLINK("${screenshotUrl}","View Screenshot")`;
    }
    if (videoUrl) {
      result.videoUrl = `=HYPERLINK("${videoUrl}","View Video")`;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function uploadToSheets(): Promise<void> {
  console.log('📤 Uploading results to Google Sheets...\n');

  // Check if report file exists
  if (!fs.existsSync(REPORT_FILE)) {
    console.error(`❌ Report file not found: ${REPORT_FILE}`);
    console.log('   Run: npm run sheets:generate');
    process.exit(1);
  }

  // Load report data
  console.log('📂 Loading report data...');
  const reportData: ReportData = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'));
  console.log(`   Found ${reportData.results.length} test results`);

  // Load Google credentials
  console.log('🔐 Loading Google credentials...');
  const credentials = loadCredentials();

  // Get spreadsheet ID
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.error('❌ GOOGLE_SHEET_ID not set');
    process.exit(1);
  }
  console.log(`   Spreadsheet ID: ${spreadsheetId}`);

  // ---- Phase 1: Upload artifacts to Google Drive (optional) ----
  const artifactLinks = await uploadArtifactsToDrive(credentials);
  injectDriveLinks(reportData.results, artifactLinks);

  // ---- Phase 2: Upload to Google Sheets ----
  console.log('\n🔄 Connecting to Google Sheets...');
  const sheets = new GoogleSheetsClient(credentials, spreadsheetId);

  // Create/update README sheet
  console.log('\n📝 Updating README sheet...');
  await sheets.createReadmeSheet(README_CONTENT);
  console.log('   README sheet updated');

  // Group results by FR
  const groupedResults = new Map<string, TestResult[]>();
  for (const result of reportData.results) {
    const frNumber = result.frNumber;
    if (!groupedResults.has(frNumber)) {
      groupedResults.set(frNumber, []);
    }
    groupedResults.get(frNumber)!.push(result);
  }

  // Upload each FR
  console.log(`\n📊 Uploading ${groupedResults.size} FR sheets...`);
  for (const [frNumber, tests] of groupedResults) {
    console.log(`   ${frNumber}: ${tests.length} tests`);

    // Get or create sheet
    await sheets.getOrCreateSheet(frNumber);

    // Clear old data
    await sheets.clearSheet(frNumber);

    // Upload results
    await sheets.uploadResults(frNumber, tests);

    // Apply formatting
    await sheets.formatSheet(frNumber, tests.length);

    const passed = tests.filter((t) => t.status === 'PASSED').length;
    const failed = tests.filter((t) => t.status === 'FAILED').length;
    console.log(`     ✅ ${passed} passed, ❌ ${failed} failed`);
  }

  console.log('\n✅ Successfully uploaded to Google Sheets!');
  console.log(`   View: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

// Run
uploadToSheets().catch((error) => {
  console.error('❌ Failed to upload to sheets:', error);
  process.exit(1);
});
