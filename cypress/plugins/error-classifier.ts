/**
 * Error Classifier Plugin
 * Analyzes test context (network requests, console logs, error stack) to determine
 * whether a failure is BACKEND, FRONTEND, or INCONCLUSIVE, with evidence and a
 * root-cause suggestion.
 */

import type {
  ErrorClassification,
  NetworkRequest,
  SavedTestContext,
} from '../support/types/test-results';

// Patterns that indicate a backend / server-side issue
const BACKEND_CONSOLE_PATTERNS = [
  /5\d{2}/,
  /server error/i,
  /internal server/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /network error/i,
  /failed to fetch/i,
];

// Patterns that indicate a frontend / client-side issue
const FRONTEND_ERROR_PATTERNS = [
  /AssertionError/i,
  /AssertionError/i, // common misspelling kept for safety
  /expected .+ to .+/i,
  /TypeError/,
  /ReferenceError/,
  /Cannot read propert/i,
  /is not a function/i,
  /is not defined/i,
  /Syntax ?Error/i,
  /Timed out retrying.*found/i,
  /expected.*to be.*visible/i,
  /expected.*to exist/i,
  /expected.*to contain/i,
  /expected.*to have/i,
];

/**
 * Classify a test failure into BACKEND, FRONTEND, or INCONCLUSIVE.
 *
 * @param context  Saved runtime context (steps, network, console logs)
 * @param errorStack  The Mochawesome error stack / message
 * @returns ErrorClassification object, or null if the test passed
 */
export function classifyError(
  context: SavedTestContext | undefined,
  errorStack: string
): ErrorClassification | null {
  if (!errorStack && !context) return null;

  const failedRequests: NetworkRequest[] = [];
  const serverErrors: NetworkRequest[] = [];
  const clientErrors: NetworkRequest[] = [];
  const consoleErrors: string[] = [];

  // ---- Collect network evidence ----
  if (context?.networkRequests) {
    for (const req of context.networkRequests) {
      // Skip Cypress internal, Sentry, analytics
      if (isNoiseRequest(req.url)) continue;

      if (req.status >= 500) {
        serverErrors.push(req);
        failedRequests.push(req);
      } else if (req.status >= 400) {
        clientErrors.push(req);
        failedRequests.push(req);
      }
    }
  }

  // ---- Collect console error evidence ----
  if (context?.consoleLogs) {
    for (const log of context.consoleLogs) {
      if (log.type === 'error') {
        // Trim to a readable length
        consoleErrors.push(log.message.substring(0, 300));
      }
    }
  }

  // ---- Classify ----
  const hasServerErrors = serverErrors.length > 0;
  const hasClientErrors = clientErrors.length > 0;
  const hasBackendConsoleHints = consoleErrors.some((msg) =>
    BACKEND_CONSOLE_PATTERNS.some((p) => p.test(msg))
  );
  const hasFrontendErrorPattern = FRONTEND_ERROR_PATTERNS.some((p) => p.test(errorStack));
  const isTimeout = /timed?\s*out/i.test(errorStack) || /timeout/i.test(errorStack);

  let type: ErrorClassification['type'];
  const evidence: string[] = [];
  let likelyCause: string;

  if (hasServerErrors) {
    // ---- BACKEND (strong signal) ----
    type = 'BACKEND';

    if (isTimeout) {
      evidence.push(`Timeout: ${errorStack.split('\n')[0]?.substring(0, 200)}`);
    }
    for (const req of serverErrors) {
      evidence.push(`${req.method} ${shortenUrl(req.url)} → ${req.status} (${req.duration}ms)`);
    }
    if (hasBackendConsoleHints) {
      const hint = consoleErrors.find((msg) => BACKEND_CONSOLE_PATTERNS.some((p) => p.test(msg)));
      if (hint) evidence.push(`Console: ${hint.substring(0, 150)}`);
    }

    const endpoints = serverErrors
      .map((r) => shortenUrl(r.url))
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ');

    if (isTimeout) {
      likelyCause =
        `A server error (${serverErrors[0].status}) likely caused the page to stall,` +
        ` which led to the element timeout.` +
        ` Check server logs for: ${endpoints}.`;
    } else {
      likelyCause =
        `The server returned ${serverErrors.length > 1 ? `${serverErrors.length} errors` : `a ${serverErrors[0].status} error`}` +
        ` before the assertion ran.` +
        ` Check server logs for: ${endpoints}.`;
    }
  } else if (hasFrontendErrorPattern && !hasClientErrors && !hasBackendConsoleHints) {
    // ---- FRONTEND (strong signal) ----
    type = 'FRONTEND';

    // Extract the most meaningful part of the error
    const firstLine = errorStack.split('\n')[0] || errorStack;
    evidence.push(firstLine.substring(0, 250));

    if (consoleErrors.length > 0) {
      const jsErrors = consoleErrors.filter((msg) =>
        FRONTEND_ERROR_PATTERNS.some((p) => p.test(msg))
      );
      for (const err of jsErrors.slice(0, 3)) {
        evidence.push(`Console: ${err.substring(0, 150)}`);
      }
    }

    evidence.push('No failed API requests during this test');

    likelyCause =
      `The API returned successful responses but the UI assertion failed.` +
      ` This is likely a frontend rendering or logic issue.` +
      ` Check the component that displays the expected data.`;
  } else if (isTimeout) {
    // ---- INCONCLUSIVE (timeout without network evidence) ----
    type = 'INCONCLUSIVE';

    evidence.push(`Timeout: ${errorStack.split('\n')[0]?.substring(0, 200)}`);
    if (consoleErrors.length > 0) {
      evidence.push(`Console errors: ${consoleErrors.length} total`);
      evidence.push(consoleErrors[0]?.substring(0, 150));
    }
    evidence.push('No 5xx API errors recorded');

    likelyCause =
      `The element was not found within the timeout period.` +
      ` This could be a slow backend response (not captured as 5xx),` +
      ` a frontend rendering delay, or the element selector may have changed.` +
      ` Investigate network timing and DOM state.`;
  } else if (hasClientErrors && hasFrontendErrorPattern) {
    // ---- INCONCLUSIVE (4xx + assertion failure -- ambiguous) ----
    type = 'INCONCLUSIVE';

    const firstLine = errorStack.split('\n')[0] || errorStack;
    evidence.push(firstLine.substring(0, 250));
    for (const req of clientErrors.slice(0, 3)) {
      evidence.push(`${req.method} ${shortenUrl(req.url)} → ${req.status}`);
    }

    likelyCause =
      `The test hit both client-side assertion failures and ${clientErrors.length} HTTP 4xx error(s).` +
      ` The 4xx response may have caused missing data on the page, or the page may have` +
      ` an independent rendering bug. Check both the API contract and the UI logic.`;
  } else {
    // ---- Fallback classification ----
    if (hasBackendConsoleHints) {
      type = 'BACKEND';
      const hint = consoleErrors.find((msg) => BACKEND_CONSOLE_PATTERNS.some((p) => p.test(msg)));
      evidence.push(`Console: ${hint?.substring(0, 200)}`);
      likelyCause = 'Console logs suggest a server-side issue. Check backend logs.';
    } else if (hasFrontendErrorPattern) {
      type = 'FRONTEND';
      evidence.push(errorStack.split('\n')[0]?.substring(0, 250));
      likelyCause = 'The error pattern suggests a client-side issue.';
    } else {
      type = 'INCONCLUSIVE';
      evidence.push(errorStack.split('\n')[0]?.substring(0, 250) || 'Unknown error');
      likelyCause =
        'Could not determine if this is a backend or frontend issue.' +
        ' Review the error stack, network requests, and console logs.';
    }
  }

  return {
    type,
    evidence,
    likelyCause,
    failedRequests,
    consoleErrors: consoleErrors.slice(0, 5),
  };
}

/**
 * Format an ErrorClassification into a human-readable string for the Sheets column.
 */
export function formatClassification(classification: ErrorClassification | null): string {
  if (!classification) return '';

  const lines: string[] = [];

  lines.push(classification.type);
  lines.push('━'.repeat(classification.type.length));
  lines.push('');
  lines.push('Evidence:');
  for (const item of classification.evidence) {
    lines.push(`  • ${item}`);
  }
  lines.push('');
  lines.push('Likely Cause:');
  // Wrap cause text at ~60 chars for readability in a Sheet cell
  const words = classification.likelyCause.split(' ');
  let line = ' ';
  for (const word of words) {
    if (line.length + word.length > 60) {
      lines.push(line);
      line = '  ' + word;
    } else {
      line += ' ' + word;
    }
  }
  if (line.trim()) lines.push(line);

  return lines.join('\n');
}

// =========================================================================
// Helpers
// =========================================================================

/**
 * Shorten a URL for display -- keep path, drop query params and domain noise.
 */
function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    // Keep the pathname, drop Sentry/tracking query strings
    return u.pathname.length > 1 ? u.pathname : url.substring(0, 80);
  } catch {
    return url.substring(0, 80);
  }
}

/**
 * Returns true if a URL is noise (Sentry, analytics, static assets).
 */
function isNoiseRequest(url: string): boolean {
  const noisePatterns = [
    /sentry\.io/i,
    /mixpanel\.com/i,
    /refiner\.io/i,
    /transifex/i,
    /google-analytics/i,
    /googletagmanager/i,
    /hotjar/i,
    /intercom/i,
    /facebook\.com/i,
    /cdn\./i,
    /\.png(\?|$)/i,
    /\.jpg(\?|$)/i,
    /\.svg(\?|$)/i,
    /\.css(\?|$)/i,
    /\.js(\?|$)/i,
    /\.woff/i,
    /__cypress/,
  ];
  return noisePatterns.some((p) => p.test(url));
}
