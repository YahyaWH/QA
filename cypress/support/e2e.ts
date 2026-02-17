// ***********************************************************
// This support file is processed and loaded automatically before test files.
//
// You can change the location of this file or turn off loading automatically
// via 'supportFile' configuration option in cypress.config.ts.
//
// See: https://docs.cypress.io/guides/core-concepts/writing-and-organizing-tests#Support-file
// ***********************************************************

// Import commands.ts using ES2015 syntax:
import './commands';
import { testContext } from './test-context';
import { processCommand, resetStepBuffer } from '../plugins/step-logger';

// Alternatively you can use CommonJS syntax:
// require('./commands')

// Global before hook - runs once before all tests
before(() => {
  cy.log('Starting test suite');
});

// ***********************************************
// Automatic Step Capture
// Intercepts every Cypress command and logs
// meaningful ones as auto-generated steps.
// ***********************************************

Cypress.on('command:start', (command) => {
  try {
    // Cypress types CommandQueue loosely; cast to our expected shape
    const cmd = command as unknown as { attributes: { name: string; args: unknown[] } };
    if (cmd?.attributes?.name) {
      processCommand(cmd);
    }
  } catch (_e) {
    // Never let step logging break a test
  }
});

// ***********************************************
// Console Log Capture
// ***********************************************

/**
 * Capture browser console logs
 * Intercepts console methods and stores them in test context
 */
Cypress.on('window:before:load', (win) => {
  // Save original console methods
  const originalConsole = {
    log: win.console.log,
    error: win.console.error,
    warn: win.console.warn,
    info: win.console.info,
    debug: win.console.debug,
  };

  // Override console methods to capture logs
  const methods: Array<'log' | 'error' | 'warn' | 'info' | 'debug'> = [
    'log',
    'error',
    'warn',
    'info',
    'debug',
  ];

  methods.forEach((method) => {
    win.console[method] = (...args: unknown[]) => {
      // Add to test context
      testContext.addConsoleLog(method, args.map((arg) => String(arg)).join(' '));

      // Call original method
      (originalConsole[method] as (...args: unknown[]) => void)(...args);
    };
  });
});

// ***********************************************
// Before Each Test
// ***********************************************

beforeEach(function () {
  // Reset context for new test
  testContext.reset();
  resetStepBuffer();

  // Extract test ID using multiple fallback strategies.
  // this.currentTest?.file is often empty in Cypress browser runtime,
  // so we use several sources to reliably extract the FR-XXX-YYY test ID.
  let testId = '';

  // Strategy 1: Cypress.spec (always available — gives the current spec file)
  const specRelative = Cypress.spec?.relative || Cypress.spec?.name || '';
  const specMatch = specRelative.match(/FR-(\d+)-(\d+)/);
  if (specMatch) {
    testId = `FR-${specMatch[1]}-${specMatch[2]}`;
  }

  // Strategy 2: invocationDetails.relativeFile (Cypress-specific, sometimes available)
  if (!testId) {
    // @ts-expect-error - invocationDetails is internal but accessible
    const relFile: string = this.currentTest?.invocationDetails?.relativeFile || '';
    const relMatch = relFile.match(/FR-(\d+)-(\d+)/);
    if (relMatch) {
      testId = `FR-${relMatch[1]}-${relMatch[2]}`;
    }
  }

  // Strategy 3: Test title (e.g. "[FR020-TC-015] should have actionable rows")
  if (!testId) {
    const title = this.currentTest?.title || '';
    const titleMatch = title.match(/\[FR(\d+)-TC-(\d+)\]/);
    if (titleMatch) {
      testId = `FR-${titleMatch[1].padStart(3, '0')}-${titleMatch[2].padStart(3, '0')}`;
    }
  }

  // Strategy 4: Suite (parent) title (e.g. "FR-020-015: Actionable Rows")
  if (!testId) {
    const suiteTitle = this.currentTest?.parent?.title || '';
    const suiteMatch = suiteTitle.match(/FR-(\d+)-(\d+)/);
    if (suiteMatch) {
      testId = `FR-${suiteMatch[1]}-${suiteMatch[2]}`;
    }
  }

  // Strategy 5: this.currentTest.file (original, rarely works in browser)
  if (!testId) {
    const testFile = this.currentTest?.file || '';
    const fileMatch = testFile.match(/FR-(\d+)-(\d+)/);
    if (fileMatch) {
      testId = `FR-${fileMatch[1]}-${fileMatch[2]}`;
    }
  }

  // Strategy 6: FR-XXX only (no test number) from spec file — for single-file
  // multi-test specs like FR-001-login.cy.ts. We append a short hash of the
  // test title to make each context file unique.
  if (!testId) {
    const specName2 = Cypress.spec?.relative || Cypress.spec?.name || '';
    const frOnlyMatch = specName2.match(/FR-(\d+)/);
    if (frOnlyMatch) {
      const frBase = `FR-${frOnlyMatch[1]}`;
      const title = this.currentTest?.title || '';
      // Create a simple numeric hash from the title for uniqueness
      let hash = 0;
      for (let i = 0; i < title.length; i++) {
        hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
      }
      const hashStr = Math.abs(hash).toString(36).substring(0, 6);
      testId = `${frBase}-${hashStr}`;
    }
  }

  if (testId) {
    testContext.setTestId(testId);
  }

  // Set test title
  if (this.currentTest?.title) {
    testContext.setTestTitle(this.currentTest.title);
  }

  // Set start time
  testContext.setStartTime(Date.now());

  // Get retry count from Cypress test object
  // @ts-expect-error - _currentRetry is internal but accessible
  const currentRetry = this.currentTest?._currentRetry || 0;
  testContext.setRetryCount(currentRetry);

  // Intercept API requests only (XHR/fetch) - avoid intercepting static assets
  // which can cause socket errors
  cy.intercept({ resourceType: /xhr|fetch/ }, (req) => {
    const startTime = Date.now();

    req.on('response', (res) => {
      const duration = Date.now() - startTime;

      // Add to test context
      testContext.addNetworkRequest({
        method: req.method,
        url: req.url,
        status: res.statusCode || 0,
        duration,
        timestamp: Date.now(),
      });
    });
  });
});

// Note: Global beforeEach was removed to avoid conflicts with cy.session()
// Individual tests should clear cookies/storage only when needed:
// beforeEach(() => {
//   cy.clearCookies();
//   cy.clearLocalStorage();
// });

// ***********************************************
// After Each Test
// ***********************************************

afterEach(function () {
  // Set end time
  testContext.setEndTime(Date.now());

  const testState = this.currentTest?.state || 'unknown';
  const testTitle = this.currentTest?.title || 'unknown';

  // If test failed, capture DOM state
  if (testState === 'failed') {
    cy.get('body').then(($body) => {
      testContext.setDomState($body.html());
    });

    // Take screenshot on test failure
    cy.screenshot(`FAILED-${testTitle}`);

    // Mark last step as failed
    testContext.addStep('Test failed at this step', { isFailed: true, source: 'auto' });
  }

  // Save context to JSON file
  const contextData = testContext.getContext();

  // Determine the file name for saving. Use testId if available;
  // otherwise re-extract from Cypress.spec / title as a fallback.
  let saveId = contextData.testId;
  if (!saveId) {
    const specName = Cypress.spec?.relative || Cypress.spec?.name || '';
    const sm = specName.match(/FR-(\d+)-(\d+)/);
    if (sm) {
      saveId = `FR-${sm[1]}-${sm[2]}`;
    }
  }
  if (!saveId) {
    const title = this.currentTest?.title || '';
    const tm = title.match(/\[FR(\d+)-TC-(\d+)\]/);
    if (tm) {
      saveId = `FR-${tm[1].padStart(3, '0')}-${tm[2].padStart(3, '0')}`;
    }
  }
  if (!saveId) {
    saveId = 'unknown';
  }

  cy.task('log', `Saving test context for ${saveId}`).then(() => {
    cy.writeFile(`cypress/results/contexts/${saveId}.json`, {
      ...contextData,
      testId: saveId,
      savedAt: new Date().toISOString(),
    });
  });
});
