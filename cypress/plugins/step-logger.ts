/**
 * Step Logger Plugin
 * Converts Cypress commands into human-readable steps for "Steps to Reproduce"
 * Automatically logs steps during test execution via Cypress.on('command:start')
 */

import { testContext } from '../support/test-context';

// Commands that should never generate a step (internal/noise)
const SKIP_COMMANDS = new Set([
  'then',
  'should',
  'and',
  'wrap',
  'task',
  'log',
  'invoke',
  'its',
  'as',
  'within',
  'window',
  'document',
  'exec',
  'readFile',
  'writeFile',
  'getCookie',
  'getCookies',
  'setCookie',
  'clearCookie',
  'clearCookies',
  'clearLocalStorage',
  'clearAllLocalStorage',
  'clearAllSessionStorage',
  'screenshot',
  'debug',
  'pause',
  'end',
  'root',
  'noop',
  'focused',
]);

// Commands that are "locators" -- they find elements but don't act on them.
// We buffer these and merge them with the next action command.
const LOCATOR_COMMANDS = new Set(['get', 'find', 'contains']);

// Commands that are "actions" -- they do something a user would see/do
const ACTION_COMMANDS = new Set([
  'click',
  'dblclick',
  'rightclick',
  'type',
  'clear',
  'check',
  'uncheck',
  'select',
  'trigger',
  'focus',
  'blur',
  'submit',
  'scrollTo',
  'scrollIntoView',
]);

// Buffer to hold the last locator command for merging
let pendingLocator: { selector: string; raw: string } | null = null;

/**
 * Reset the pending locator buffer (call on test start)
 */
export function resetStepBuffer(): void {
  pendingLocator = null;
}

/**
 * Determine the step type from a Cypress command name
 */
function getStepType(
  name: string
): 'navigation' | 'action' | 'input' | 'assertion' | 'wait' | 'setup' | undefined {
  if (name === 'visit' || name === 'go' || name === 'reload') return 'navigation';
  if (name === 'type' || name === 'clear' || name === 'select' || name === 'check') return 'input';
  if (name === 'wait') return 'wait';
  if (ACTION_COMMANDS.has(name)) return 'action';
  if (name === 'session' || name === 'intercept') return 'setup';
  return undefined;
}

/**
 * Process a Cypress command and optionally log it as a step.
 * Called from Cypress.on('command:start') in e2e.ts.
 *
 * Returns true if a step was logged, false if it was skipped/buffered.
 */
export function processCommand(command: {
  attributes: { name: string; args: unknown[] };
}): boolean {
  const { name, args } = command.attributes;

  // Skip internal commands
  if (SKIP_COMMANDS.has(name)) return false;

  // Handle locator commands -- buffer them
  if (LOCATOR_COMMANDS.has(name)) {
    const selectorArg = args[0];
    if (typeof selectorArg === 'string') {
      pendingLocator = {
        selector: selectorArg,
        raw: selectorArg,
      };
    }
    return false;
  }

  // Handle action/input commands -- merge with buffered locator
  if (ACTION_COMMANDS.has(name)) {
    const label = pendingLocator ? resolveSelector(pendingLocator.selector) : 'current element';
    const rawSelector = pendingLocator?.raw;
    pendingLocator = null; // consume

    const result = formatAction(name, args, label);
    if (result) {
      testContext.addStep(result.description, {
        source: 'auto',
        type: result.type,
        selector: rawSelector,
        value: result.value,
      });
      return true;
    }
    return false;
  }

  // Handle standalone commands (visit, wait, reload, etc.)
  const result = formatStandalone(name, args);
  if (result) {
    pendingLocator = null;
    testContext.addStep(result.description, {
      source: 'auto',
      type: result.type,
    });
    return true;
  }

  return false;
}

// =========================================================================
// Formatting helpers
// =========================================================================

interface StepInfo {
  description: string;
  type?: 'navigation' | 'action' | 'input' | 'assertion' | 'wait' | 'setup';
  value?: string;
}

/**
 * Format an action command (click, type, clear, etc.) with a resolved label.
 */
function formatAction(name: string, args: unknown[], label: string): StepInfo | null {
  const type = getStepType(name);

  switch (name) {
    case 'click':
      return { description: `Click ${label}`, type };
    case 'dblclick':
      return { description: `Double-click ${label}`, type };
    case 'rightclick':
      return { description: `Right-click ${label}`, type };
    case 'type': {
      const text = typeof args[0] === 'string' ? args[0] : String(args[0]);
      // Mask passwords
      const display = text.length > 0 && label.toLowerCase().includes('password') ? '****' : text;
      return { description: `Type "${display}" into ${label}`, type: 'input', value: display };
    }
    case 'clear':
      return { description: `Clear ${label}`, type: 'input' };
    case 'check':
      return { description: `Check ${label}`, type: 'input' };
    case 'uncheck':
      return { description: `Uncheck ${label}`, type: 'input' };
    case 'select': {
      const val = typeof args[0] === 'string' ? args[0] : String(args[0]);
      return { description: `Select "${val}" from ${label}`, type: 'input', value: val };
    }
    case 'submit':
      return { description: `Submit form ${label}`, type: 'action' };
    case 'focus':
      return { description: `Focus on ${label}`, type: 'action' };
    case 'blur':
      return { description: `Remove focus from ${label}`, type: 'action' };
    case 'scrollIntoView':
      return { description: `Scroll ${label} into view`, type: 'action' };
    case 'scrollTo':
      return { description: `Scroll to ${args[0]} in ${label}`, type: 'action' };
    case 'trigger':
      return { description: `Trigger "${args[0]}" on ${label}`, type: 'action' };
    default:
      return { description: `${name} on ${label}`, type };
  }
}

/**
 * Format a standalone command (visit, wait, reload, etc.)
 */
function formatStandalone(name: string, args: unknown[]): StepInfo | null {
  switch (name) {
    case 'visit': {
      const url = typeof args[0] === 'string' ? args[0] : String(args[0]);
      return { description: `Navigate to ${url}`, type: 'navigation' };
    }
    case 'reload':
      return { description: 'Reload the page', type: 'navigation' };
    case 'go': {
      const dir = String(args[0]);
      return { description: `Go ${dir} in browser history`, type: 'navigation' };
    }
    case 'wait': {
      if (typeof args[0] === 'string' && args[0].startsWith('@')) {
        return { description: `Wait for network request "${args[0]}"`, type: 'wait' };
      }
      if (typeof args[0] === 'number') {
        return { description: `Wait ${args[0]}ms`, type: 'wait' };
      }
      return null;
    }
    case 'session':
      return { description: 'Restore cached user session', type: 'setup' };
    case 'intercept':
      return null; // too noisy, skip
    case 'request': {
      const reqArg = args[0];
      if (typeof reqArg === 'object' && reqArg !== null) {
        const r = reqArg as { method?: string; url?: string };
        return {
          description: `Make ${r.method || 'GET'} request to ${r.url || 'unknown'}`,
          type: 'action',
        };
      }
      return { description: `Make GET request to ${reqArg}`, type: 'action' };
    }
    case 'url':
    case 'title':
    case 'location':
      return null; // informational, not a step
    default:
      return null;
  }
}

// =========================================================================
// Selector resolution -- turns CSS selectors into human-readable labels
// =========================================================================

/**
 * Turn a CSS selector string into a human-friendly label.
 *
 * Examples:
 *   'input[placeholder="Search"]'     -> 'Search input'
 *   '[data-testid="add-transaction"]' -> '"Add Transaction" button'
 *   'button:contains("Log in")'       -> '"Log in" button'
 *   '#email'                          -> '"email" field'
 *   'table tbody tr'                  -> 'table rows'
 */
export function resolveSelector(selector: string): string {
  if (!selector || typeof selector !== 'string') return 'element';

  // 1. placeholder="..." -- most descriptive for inputs
  const placeholderMatch = selector.match(/placeholder\s*=\s*"([^"]+)"/);
  if (placeholderMatch) {
    return `"${placeholderMatch[1]}" input`;
  }

  // 2. data-testid="..." -- standardised test handle
  const testIdMatch = selector.match(/data-testid\s*[=~*^$|]*\s*["']([^"']+)["']/);
  if (testIdMatch) {
    const raw = testIdMatch[1];
    const humanised = raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return `"${humanised}" element`;
  }

  // 3. :contains("...") -- text-based selectors
  const containsMatch = selector.match(/:contains\(\s*["']([^"']+)["']\s*\)/);
  if (containsMatch) {
    const text = containsMatch[1];
    // Figure out the tag name before :contains
    const tagMatch = selector.match(/^(\w+)/);
    const tag = tagMatch ? tagMatch[1] : 'element';
    const tagLabel = tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag;
    return `"${text}" ${tagLabel}`;
  }

  // 4. button, a -- bare tag names with special cases
  const bareTag = selector.match(/^(\w+)$/);
  if (bareTag) {
    const tagMap: Record<string, string> = {
      button: 'button',
      input: 'input field',
      select: 'dropdown',
      textarea: 'text area',
      table: 'table',
      form: 'form',
      a: 'link',
      img: 'image',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
    };
    return tagMap[bareTag[1]] || `<${bareTag[1]}> element`;
  }

  // 5. #id
  if (selector.startsWith('#')) {
    const id = selector.slice(1).replace(/[-_]/g, ' ');
    return `"${id}" field`;
  }

  // 6. input[type="..."]
  const inputTypeMatch = selector.match(/input\[type\s*=\s*["'](\w+)["']/);
  if (inputTypeMatch) {
    const typeMap: Record<string, string> = {
      text: 'text input',
      email: 'email input',
      password: 'password input',
      number: 'number input',
      checkbox: 'checkbox',
      radio: 'radio button',
      submit: 'submit button',
      file: 'file input',
    };
    return typeMap[inputTypeMatch[1]] || `${inputTypeMatch[1]} input`;
  }

  // 7. Common compound selectors
  if (selector.includes('tbody tr')) return 'table row';
  if (selector.includes('tbody')) return 'table body';

  // 8. Fallback -- truncate long selectors
  if (selector.length > 60) {
    return `element (${selector.substring(0, 40)}...)`;
  }

  return `element "${selector}"`;
}

/**
 * Log a custom step manually (for use in cy.stepLog() command).
 * Kept for backwards compatibility.
 */
export function logCustomStep(description: string): void {
  testContext.addStep(description, { source: 'manual' });
}
