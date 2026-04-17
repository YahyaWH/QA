#!/usr/bin/env ts-node
/**
 * Generate HTML Report Script
 * Reads the unified sheets-report.json and produces a standalone HTML report
 * with inline video embeds, screenshots, steps-to-reproduce, error details, etc.
 *
 * Usage: npm run report:html
 */

import * as fs from 'fs';
import * as path from 'path';

interface TestResult {
  testId: string;
  frNumber: string;
  testNumber: string;
  description: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  duration: number;
  retryCount: number;
  timestamp: string;
  stepsToReproduce: string;
  screenshotUrl: string;
  videoUrl: string;
  consoleLogs: string;
  networkRequests: string;
  errorStack: string;
  errorClassification: string;
  domStateAtFailure: string;
  environment: string;
  browser: string;
  viewport: string;
}

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

const RESULTS_DIR = path.join(process.cwd(), 'cypress/results');
const INPUT_FILE = path.join(RESULTS_DIR, 'sheets-report.json');
const OUTPUT_FILE = path.join(RESULTS_DIR, 'html-report.html');

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function extractClassificationType(classification: string): string {
  if (!classification) return '';
  if (classification.startsWith('BACKEND')) return 'BACKEND';
  if (classification.startsWith('FRONTEND')) return 'FRONTEND';
  if (classification.startsWith('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return '';
}

function groupByFr(results: TestResult[]): Map<string, TestResult[]> {
  const map = new Map<string, TestResult[]>();
  for (const r of results) {
    const key = r.frNumber || 'Unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}

function getFrTitle(frNumber: string): string {
  const titles: Record<string, string> = {
    'FR-001': 'Authentication — Login',
    'FR-020': 'Customer Search & Filtering',
    'PD-042': 'Customer Category Management',
  };
  return titles[frNumber] || frNumber;
}

function renderSteps(steps: string): string {
  if (!steps || steps === 'No steps recorded') {
    return '<div class="empty-state">No steps recorded</div>';
  }
  const lines = steps.split('\n').filter((l) => l.trim());
  let html = '<ul class="steps-list">';
  for (const line of lines) {
    const match = line.match(/^(\d+)\.\s*(.*)/);
    if (match) {
      const num = match[1];
      const text = match[2];
      const isFailed = text.includes('FAILED');
      html += `<li class="${isFailed ? 'step-failed' : ''}">`;
      html += `<span class="step-number">${escapeHtml(num)}</span>`;
      html += `<span class="step-text">${escapeHtml(text)}</span>`;
      html += '</li>';
    }
  }
  html += '</ul>';
  return html;
}

function renderNetworkRequests(network: string): string {
  if (!network) return '<div class="empty-state">No network requests captured</div>';
  const lines = network.split('\n').filter((l) => l.trim());
  let html = '<ul class="network-list">';
  for (const line of lines) {
    const isError = line.startsWith('\u274C');
    const isOk = line.startsWith('\u2705');
    const statusClass = isError ? 'error' : isOk ? 'ok' : '';
    // Parse: METHOD URL → STATUS (DURATIONms)
    const match = line.match(
      /[^\s]+\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS)\s+(https?:\/\/\S+)\s+.\s+(\d+)\s+\((\d+)ms\)/
    );
    if (match) {
      html += '<li>';
      html += `<span class="status-dot ${statusClass}"></span>`;
      html += `<span class="network-method">${escapeHtml(match[1])}</span>`;
      const shortUrl = match[2].length > 80 ? match[2].substring(0, 77) + '...' : match[2];
      html += `<span class="network-url" title="${escapeHtml(match[2])}">${escapeHtml(shortUrl)}</span>`;
      html += `<span class="network-status ${statusClass}">${escapeHtml(match[3])}</span>`;
      html += `<span class="network-duration">${escapeHtml(match[4])}ms</span>`;
      html += '</li>';
    } else {
      html += `<li><span class="network-url">${escapeHtml(line)}</span></li>`;
    }
  }
  html += '</ul>';
  return html;
}

function renderConsoleLogs(logs: string): string {
  if (!logs) return '<div class="empty-state">No console logs captured</div>';
  return `<pre class="console-output">${escapeHtml(logs)}</pre>`;
}

function renderVideoEmbed(videoUrl: string, testId: string): string {
  if (!videoUrl) {
    return `<div class="video-container"><div class="video-placeholder">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <span>No video available for this test</span>
    </div></div>`;
  }
  // If Google Drive link, convert to embeddable preview
  const driveMatch = videoUrl.match(/\/file\/d\/([^/]+)/);
  if (driveMatch) {
    const fileId = driveMatch[1];
    return `<div class="video-container">
      <iframe src="https://drive.google.com/file/d/${escapeHtml(fileId)}/preview"
              allow="autoplay" allowfullscreen></iframe>
    </div>
    <div class="video-label">${escapeHtml(testId)}.mp4</div>`;
  }
  // Fallback: link
  return `<div class="video-container">
    <a href="${escapeHtml(videoUrl)}" target="_blank" class="video-link">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      Open Video
    </a>
  </div>`;
}

function renderScreenshot(screenshotUrl: string): string {
  if (!screenshotUrl) {
    return `<div class="screenshot-placeholder">
      <svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
      <span>No screenshot available</span>
    </div>`;
  }
  return `<div class="screenshot-container">
    <img src="${escapeHtml(screenshotUrl)}" alt="Failure screenshot" loading="lazy" />
  </div>`;
}

function renderErrorBlock(test: TestResult): string {
  if (!test.errorStack) return '<div class="empty-state">No errors</div>';
  const classType = extractClassificationType(test.errorClassification);
  let html = '';
  if (classType) {
    html += `<span class="classification-badge ${classType.toLowerCase()}">${escapeHtml(classType)}</span>`;
  }
  // Truncate error stack for display
  const stack =
    test.errorStack.length > 2000
      ? test.errorStack.substring(0, 2000) + '\n... (truncated)'
      : test.errorStack;
  html += `<div class="error-block">
    <div class="error-block-header">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm-.9 4.2v4.6h1.8V4.2H7.1zm0 6h1.8v1.6H7.1v-1.6z"/></svg>
      Error
    </div>
    <pre>${escapeHtml(stack)}</pre>
  </div>`;
  if (test.errorClassification) {
    const classLines = test.errorClassification.split('\n').slice(2).join('\n').trim();
    if (classLines) {
      html += `<div class="classification-detail">${escapeHtml(classLines)}</div>`;
    }
  }
  return html;
}

function renderTestDetail(test: TestResult, index: number): string {
  const detailId = `detail-${index}`;
  return `<div class="test-detail" id="${detailId}">
  <div class="detail-inner">
    <div class="detail-tabs">
      <button class="detail-tab active" onclick="switchTab(this,'video','${detailId}')">Video</button>
      <button class="detail-tab" onclick="switchTab(this,'screenshot','${detailId}')">Screenshot</button>
      <button class="detail-tab" onclick="switchTab(this,'steps','${detailId}')">Steps to Reproduce</button>
      <button class="detail-tab" onclick="switchTab(this,'error','${detailId}')">Error</button>
      <button class="detail-tab" onclick="switchTab(this,'network','${detailId}')">Network</button>
      <button class="detail-tab" onclick="switchTab(this,'console','${detailId}')">Console</button>
    </div>
    <div class="detail-content">
      <div class="tab-panel active" data-tab="video">${renderVideoEmbed(test.videoUrl, test.testId)}</div>
      <div class="tab-panel" data-tab="screenshot">${renderScreenshot(test.screenshotUrl)}</div>
      <div class="tab-panel" data-tab="steps">${renderSteps(test.stepsToReproduce)}</div>
      <div class="tab-panel" data-tab="error">${renderErrorBlock(test)}</div>
      <div class="tab-panel" data-tab="network">${renderNetworkRequests(test.networkRequests)}</div>
      <div class="tab-panel" data-tab="console">${renderConsoleLogs(test.consoleLogs)}</div>
    </div>
  </div>
</div>`;
}

function renderTestRow(test: TestResult, index: number): string {
  const hasVideo = !!test.videoUrl;
  const hasScreenshot = !!test.screenshotUrl;
  const retryClass = test.retryCount > 0 ? 'has-retries' : '';
  return `<div class="test-row" data-status="${test.status.toLowerCase()}" onclick="toggleDetail('detail-${index}', this)">
  <span class="test-id">${escapeHtml(test.testId)}</span>
  <span class="test-desc">${escapeHtml(test.description)}</span>
  <span><span class="badge ${test.status.toLowerCase()}">${test.status}</span></span>
  <span class="duration">${formatDuration(test.duration)}</span>
  <span class="retries ${retryClass}">${test.retryCount}</span>
  <span class="media-icons">
    <span class="media-icon ${hasVideo ? 'available' : ''}" title="${hasVideo ? 'Video available' : 'No video'}"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M16 3.75v8.5a.75.75 0 01-1.136.643L11 10.575v.675A1.75 1.75 0 019.25 13h-7.5A1.75 1.75 0 010 11.25v-6.5C0 3.784.784 3 1.75 3h7.5c.966 0 1.75.784 1.75 1.75v.675l3.864-2.318A.75.75 0 0116 3.75z"/></svg></span>
    <span class="media-icon ${hasScreenshot ? 'available' : ''}" title="${hasScreenshot ? 'Screenshot available' : 'No screenshot'}"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.75 0h6.5a.75.75 0 01.542.232l3.976 4.158A.75.75 0 0116 4.908V14.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 010 14.5v-13A1.5 1.5 0 011.5 0h3.25zm5.75 6.5a2.5 2.5 0 10-5 0 2.5 2.5 0 005 0z"/></svg></span>
  </span>
</div>
${renderTestDetail(test, index)}`;
}

function generateHtml(data: ReportData): string {
  const grouped = groupByFr(data.results);
  const skipped = data.summary.totalTests - data.summary.passed - data.summary.failed;
  const passRate =
    data.summary.totalTests > 0
      ? ((data.summary.passed / data.summary.totalTests) * 100).toFixed(1)
      : '0.0';
  const totalDuration = data.results.reduce((sum, r) => sum + r.duration, 0);
  const avgDuration = data.results.length > 0 ? totalDuration / data.results.length : 0;
  const genDate = new Date(data.generatedAt);
  const dateStr = genDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const timeStr = genDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const env = data.results[0]?.environment || 'Local';
  const browser = data.results[0]?.browser || 'Chrome';
  const viewport = data.results[0]?.viewport || '1280x720';

  let frGroupsHtml = '';
  let globalIndex = 0;

  for (const [frNumber, tests] of grouped) {
    const passed = tests.filter((t) => t.status === 'PASSED').length;
    const failed = tests.filter((t) => t.status === 'FAILED').length;
    const title = getFrTitle(frNumber);

    let testRowsHtml = '';
    for (const test of tests) {
      testRowsHtml += renderTestRow(test, globalIndex);
      globalIndex++;
    }

    frGroupsHtml += `
    <div class="fr-group open" data-fr="${escapeHtml(frNumber)}">
      <div class="fr-group-header" onclick="toggleGroup(this)">
        <svg class="chevron" viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>
        <span class="fr-id">${escapeHtml(frNumber)}</span>
        <span class="fr-title">${escapeHtml(title)}</span>
        <div class="fr-stats">
          <span class="passed-count">${passed} passed</span>
          <span class="failed-count">${failed} failed</span>
          <span>${tests.length} total</span>
        </div>
      </div>
      <div class="fr-group-body">
        <div class="table-header">
          <span>Test ID</span>
          <span>Description</span>
          <span>Status</span>
          <span>Duration</span>
          <span>Retries</span>
          <span>Media</span>
        </div>
        ${testRowsHtml}
      </div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cypress Test Report</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg-primary:#0d1117;--bg-secondary:#161b22;--bg-tertiary:#1c2128;
      --bg-hover:#21262d;--border:#30363d;--border-light:#3d444d;
      --text-primary:#e6edf3;--text-secondary:#8b949e;--text-muted:#6e7681;
      --accent-blue:#58a6ff;--accent-green:#3fb950;--accent-red:#f85149;
      --accent-orange:#d29922;--accent-purple:#bc8cff;--accent-cyan:#39d2c0;
      --passed-bg:rgba(63,185,80,0.1);--passed-border:rgba(63,185,80,0.3);
      --failed-bg:rgba(248,81,73,0.1);--failed-border:rgba(248,81,73,0.3);
      --radius:8px;--radius-lg:12px;--transition:150ms ease;
    }
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg-primary);color:var(--text-primary);line-height:1.5;min-height:100vh}
    .container{max-width:1400px;margin:0 auto;padding:24px 32px}
    .report-header{display:flex;align-items:flex-start;justify-content:space-between;padding-bottom:24px;border-bottom:1px solid var(--border);margin-bottom:24px}
    .report-header h1{font-size:28px;font-weight:600;letter-spacing:-0.5px}
    .report-header h1 span{color:var(--text-secondary);font-weight:400}
    .header-meta{text-align:right;color:var(--text-secondary);font-size:13px;line-height:1.8}
    .header-meta strong{color:var(--text-primary);font-weight:500}
    .summary-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-bottom:28px}
    .summary-card{background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px 24px;position:relative;overflow:hidden}
    .summary-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px}
    .summary-card.total::before{background:var(--accent-blue)}
    .summary-card.passed::before{background:var(--accent-green)}
    .summary-card.failed::before{background:var(--accent-red)}
    .summary-card.rate::before{background:var(--accent-purple)}
    .summary-card.duration::before{background:var(--accent-cyan)}
    .summary-card .label{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-secondary);margin-bottom:8px}
    .summary-card .value{font-size:32px;font-weight:700;font-variant-numeric:tabular-nums}
    .summary-card.passed .value{color:var(--accent-green)}
    .summary-card.failed .value{color:var(--accent-red)}
    .summary-card.rate .value{color:var(--accent-purple)}
    .summary-card.duration .value{color:var(--accent-cyan)}
    .pass-rate-bar{width:100%;height:8px;background:var(--bg-tertiary);border-radius:4px;overflow:hidden;margin-bottom:28px}
    .pass-rate-fill{height:100%;border-radius:4px;transition:width .5s ease}
    .controls{display:flex;align-items:center;gap:12px;margin-bottom:24px;flex-wrap:wrap}
    .filter-btn{padding:6px 16px;border-radius:20px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-secondary);font-size:13px;cursor:pointer;transition:all var(--transition);font-family:inherit}
    .filter-btn:hover{border-color:var(--border-light);color:var(--text-primary);background:var(--bg-hover)}
    .filter-btn.active{background:var(--accent-blue);color:#fff;border-color:var(--accent-blue)}
    .filter-btn .count{display:inline-block;background:rgba(255,255,255,.15);border-radius:10px;padding:0 7px;margin-left:6px;font-size:11px;font-weight:600}
    .search-input{flex:1;min-width:200px;padding:7px 14px;border-radius:20px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;font-family:inherit;outline:none;transition:border-color var(--transition)}
    .search-input:focus{border-color:var(--accent-blue)}
    .search-input::placeholder{color:var(--text-muted)}
    .fr-group{margin-bottom:16px}
    .fr-group-header{display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);cursor:pointer;user-select:none;transition:background var(--transition)}
    .fr-group-header:hover{background:var(--bg-hover)}
    .fr-group.open .fr-group-header{border-radius:var(--radius-lg) var(--radius-lg) 0 0;border-bottom-color:transparent}
    .fr-group-header .chevron{width:20px;height:20px;color:var(--text-muted);transition:transform var(--transition);flex-shrink:0}
    .fr-group.open .fr-group-header .chevron{transform:rotate(90deg)}
    .fr-group-header .fr-id{font-weight:700;font-size:15px;color:var(--accent-blue);min-width:70px}
    .fr-group-header .fr-title{flex:1;font-size:14px;color:var(--text-primary)}
    .fr-group-header .fr-stats{display:flex;gap:16px;font-size:12px;color:var(--text-secondary)}
    .fr-group-header .fr-stats .passed-count{color:var(--accent-green)}
    .fr-group-header .fr-stats .failed-count{color:var(--accent-red)}
    .fr-group-body{display:none;border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius-lg) var(--radius-lg);overflow:hidden}
    .fr-group.open .fr-group-body{display:block}
    .table-header{display:grid;grid-template-columns:120px 1fr 80px 90px 70px 80px;padding:8px 20px;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-muted);background:var(--bg-secondary);border-bottom:1px solid var(--border);gap:12px}
    .test-row{display:grid;grid-template-columns:120px 1fr 80px 90px 70px 80px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--bg-primary);cursor:pointer;transition:background var(--transition);gap:12px}
    .test-row:hover{background:var(--bg-hover)}
    .test-row .test-id{font-size:12px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text-secondary)}
    .test-row .test-desc{font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
    .badge.passed{background:var(--passed-bg);color:var(--accent-green);border:1px solid var(--passed-border)}
    .badge.failed{background:var(--failed-bg);color:var(--accent-red);border:1px solid var(--failed-border)}
    .badge.skipped{background:rgba(210,153,34,0.1);color:var(--accent-orange);border:1px solid rgba(210,153,34,0.3)}
    .test-row .duration{font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
    .test-row .retries{font-size:12px;color:var(--text-muted)}
    .test-row .retries.has-retries{color:var(--accent-orange)}
    .media-icons{display:flex;gap:8px}
    .media-icon{width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;background:var(--bg-tertiary);border:1px solid var(--border);color:var(--text-muted);transition:all var(--transition)}
    .media-icon.available{color:var(--accent-blue);border-color:rgba(88,166,255,.3);background:rgba(88,166,255,.08)}
    .media-icon svg{width:14px;height:14px}
    .test-detail{display:none;background:var(--bg-tertiary);border-bottom:1px solid var(--border)}
    .test-detail.open{display:block;animation:fadeIn 200ms ease}
    .detail-inner{padding:20px 24px}
    .detail-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:16px}
    .detail-tab{padding:8px 18px;font-size:12px;font-weight:500;color:var(--text-secondary);cursor:pointer;border-bottom:2px solid transparent;transition:all var(--transition);font-family:inherit;background:none;border-top:none;border-left:none;border-right:none}
    .detail-tab:hover{color:var(--text-primary)}
    .detail-tab.active{color:var(--accent-blue);border-bottom-color:var(--accent-blue)}
    .tab-panel{display:none}
    .tab-panel.active{display:block}
    .video-container{position:relative;background:#000;border-radius:var(--radius);overflow:hidden;max-width:800px;border:1px solid var(--border)}
    .video-container iframe{width:100%;aspect-ratio:16/9;border:none;display:block}
    .video-placeholder{width:100%;aspect-ratio:16/9;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1e2e 0%,#0d1117 100%);color:var(--text-muted);gap:12px}
    .video-placeholder svg{width:48px;height:48px;opacity:.3}
    .video-placeholder span{font-size:13px}
    .video-label{margin-top:8px;font-size:12px;color:var(--text-muted)}
    .video-link{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;aspect-ratio:16/9;background:linear-gradient(135deg,#1a1e2e,#0d1117);color:var(--accent-blue);text-decoration:none;gap:12px;font-size:14px}
    .video-link svg{width:48px;height:48px}
    .screenshot-container{max-width:800px}
    .screenshot-container img{width:100%;border-radius:var(--radius);border:1px solid var(--border)}
    .screenshot-placeholder{width:100%;height:300px;border-radius:var(--radius);border:1px solid var(--border);display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg-secondary);color:var(--text-muted);gap:8px}
    .screenshot-placeholder svg{width:40px;height:40px;opacity:.4}
    .steps-list{list-style:none}
    .steps-list li{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:1px solid rgba(48,54,61,.5);font-size:13px}
    .steps-list li:last-child{border-bottom:none}
    .step-number{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--bg-secondary);border:1px solid var(--border);font-size:11px;font-weight:600;color:var(--text-secondary);flex-shrink:0}
    .step-text{color:var(--text-primary);padding-top:2px}
    .step-failed .step-number{background:var(--failed-bg);border-color:var(--failed-border);color:var(--accent-red)}
    .step-failed .step-text{color:var(--accent-red)}
    .error-block{background:var(--bg-secondary);border:1px solid var(--failed-border);border-radius:var(--radius);overflow:hidden}
    .error-block-header{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--failed-bg);border-bottom:1px solid var(--failed-border);font-size:12px;font-weight:600;color:var(--accent-red)}
    .error-block pre{padding:14px;font-size:12px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;line-height:1.6;max-height:300px;overflow-y:auto}
    .classification-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.5px;margin-bottom:12px}
    .classification-badge.backend{background:rgba(210,153,34,.12);color:var(--accent-orange);border:1px solid rgba(210,153,34,.3)}
    .classification-badge.frontend{background:rgba(88,166,255,.12);color:var(--accent-blue);border:1px solid rgba(88,166,255,.3)}
    .classification-badge.inconclusive{background:rgba(139,148,158,.12);color:var(--text-secondary);border:1px solid rgba(139,148,158,.3)}
    .classification-detail{margin-top:12px;padding:12px 16px;background:var(--bg-secondary);border-radius:var(--radius);border:1px solid var(--border);font-size:13px;color:var(--text-secondary);line-height:1.7;white-space:pre-wrap}
    .network-list{list-style:none}
    .network-list li{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;font-family:'SFMono-Regular',Consolas,monospace;border-bottom:1px solid rgba(48,54,61,.3)}
    .network-list li:last-child{border-bottom:none}
    .status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
    .status-dot.ok{background:var(--accent-green)}
    .status-dot.error{background:var(--accent-red)}
    .network-method{font-weight:600;color:var(--accent-purple);min-width:40px}
    .network-url{color:var(--text-secondary);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .network-status{font-weight:600;min-width:32px;text-align:right}
    .network-status.ok{color:var(--accent-green)}
    .network-status.error{color:var(--accent-red)}
    .network-duration{color:var(--text-muted);min-width:60px;text-align:right}
    .console-output{padding:14px;font-size:12px;font-family:'SFMono-Regular',Consolas,monospace;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;line-height:1.6;max-height:400px;overflow-y:auto;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius)}
    .empty-state{text-align:center;padding:40px;color:var(--text-muted);font-size:13px}
    .report-footer{text-align:center;padding:32px;color:var(--text-muted);font-size:12px;border-top:1px solid var(--border);margin-top:40px}
    ::-webkit-scrollbar{width:8px;height:8px}
    ::-webkit-scrollbar-track{background:var(--bg-primary)}
    ::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
    @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
  </style>
</head>
<body>
<div class="container">
  <header class="report-header">
    <div><h1>Cypress Test Report <span>— WasteHero</span></h1></div>
    <div class="header-meta">
      <div><strong>Run:</strong> ${escapeHtml(dateStr)} at ${escapeHtml(timeStr)}</div>
      <div><strong>Environment:</strong> ${escapeHtml(env)}</div>
      <div><strong>Browser:</strong> ${escapeHtml(browser)} &middot; ${escapeHtml(viewport)}</div>
      <div><strong>Duration:</strong> ${formatDuration(totalDuration)}</div>
    </div>
  </header>

  <div class="summary-grid">
    <div class="summary-card total"><div class="label">Total Tests</div><div class="value">${data.summary.totalTests}</div></div>
    <div class="summary-card passed"><div class="label">Passed</div><div class="value">${data.summary.passed}</div></div>
    <div class="summary-card failed"><div class="label">Failed</div><div class="value">${data.summary.failed}</div></div>
    <div class="summary-card rate"><div class="label">Pass Rate</div><div class="value">${passRate}%</div></div>
    <div class="summary-card duration"><div class="label">Avg Duration</div><div class="value">${formatDuration(avgDuration)}</div></div>
  </div>

  <div class="pass-rate-bar">
    <div class="pass-rate-fill" style="width:${passRate}%;background:linear-gradient(90deg,var(--accent-green) 0%,var(--accent-green) 100%)"></div>
  </div>

  <div class="controls">
    <button class="filter-btn active" onclick="filterTests('all',this)">All<span class="count">${data.summary.totalTests}</span></button>
    <button class="filter-btn" onclick="filterTests('passed',this)">Passed<span class="count">${data.summary.passed}</span></button>
    <button class="filter-btn" onclick="filterTests('failed',this)">Failed<span class="count">${data.summary.failed}</span></button>
    <button class="filter-btn" onclick="filterTests('skipped',this)">Skipped<span class="count">${skipped}</span></button>
    <input type="text" class="search-input" placeholder="Search tests by ID or description..." oninput="searchTests(this.value)">
  </div>

  ${frGroupsHtml}

  <footer class="report-footer">
    Generated by Cypress HTML Reporter &middot; WasteHero E2E Tests &middot; ${escapeHtml(dateStr)} at ${escapeHtml(timeStr)}
  </footer>
</div>

<script>
function toggleGroup(header){header.closest('.fr-group').classList.toggle('open')}
function toggleDetail(id,row){
  var el=document.getElementById(id);
  if(!el)return;
  // close all other open details
  document.querySelectorAll('.test-detail.open').forEach(function(d){if(d.id!==id)d.classList.remove('open')});
  el.classList.toggle('open');
}
function switchTab(btn,tabName,detailId){
  var detail=document.getElementById(detailId);
  if(!detail)return;
  detail.querySelectorAll('.detail-tab').forEach(function(t){t.classList.remove('active')});
  btn.classList.add('active');
  detail.querySelectorAll('.tab-panel').forEach(function(p){
    p.classList.toggle('active',p.getAttribute('data-tab')===tabName);
  });
}
function filterTests(status,btn){
  document.querySelectorAll('.filter-btn').forEach(function(b){b.classList.remove('active')});
  if(btn)btn.classList.add('active');
  document.querySelectorAll('.test-row').forEach(function(row){
    if(status==='all'){row.style.display=''}
    else{row.style.display=row.getAttribute('data-status')===status?'':'none'}
  });
  // hide detail panels when filtering
  document.querySelectorAll('.test-detail.open').forEach(function(d){d.classList.remove('open')});
}
function searchTests(query){
  var q=query.toLowerCase();
  document.querySelectorAll('.test-row').forEach(function(row){
    var id=(row.querySelector('.test-id')||{}).textContent||'';
    var desc=(row.querySelector('.test-desc')||{}).textContent||'';
    row.style.display=(id.toLowerCase().indexOf(q)!==-1||desc.toLowerCase().indexOf(q)!==-1)?'':'none';
  });
}
</script>
</body>
</html>`;
}

async function main(): Promise<void> {
  console.log('Generating HTML report...\n');

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input file not found: ${INPUT_FILE}`);
    console.log('Run "npm run sheets:generate" first to create sheets-report.json');
    process.exit(1);
  }

  const raw = fs.readFileSync(INPUT_FILE, 'utf-8');
  const data: ReportData = JSON.parse(raw);

  console.log(`Loaded ${data.results.length} test results`);
  console.log(`  Passed: ${data.summary.passed}`);
  console.log(`  Failed: ${data.summary.failed}`);

  const html = generateHtml(data);

  // Ensure output directory exists
  const outDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');
  console.log(`\nHTML report written to: ${OUTPUT_FILE}`);
  console.log(`File size: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error('Failed to generate HTML report:', err);
  process.exit(1);
});
