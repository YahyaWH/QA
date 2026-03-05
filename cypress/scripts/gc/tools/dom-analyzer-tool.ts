/**
 * DOM Analyzer tool for Mark (audit phase)
 * Analyzes DOM snapshots from failed tests to identify UI issues.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';

// ---- Tool: analyze_dom ----

export async function analyzeDom(input: {
  domSnapshot: string;
  expectedSelector?: string;
  expectedContent?: string;
}): Promise<ToolResultBlockParam['content']> {
  const { domSnapshot, expectedSelector, expectedContent } = input;

  if (!domSnapshot || domSnapshot.trim().length === 0) {
    return 'No DOM snapshot available for this test failure.';
  }

  const findings: string[] = [];

  // Check if expected selector exists in the DOM
  if (expectedSelector) {
    // Simple check: look for id, class, data-testid patterns in the HTML
    const selectorPatterns = extractSelectorPatterns(expectedSelector);
    const found = selectorPatterns.some((pattern) => domSnapshot.includes(pattern));

    if (found) {
      findings.push(`Selector "${expectedSelector}" IS present in the DOM snapshot.`);
      findings.push('The element exists but may be hidden, disabled, or not yet interactive.');

      // Check for common hidden patterns
      if (domSnapshot.includes('display: none') || domSnapshot.includes('display:none')) {
        findings.push('Found "display: none" in the DOM - element may be hidden via CSS.');
      }
      if (domSnapshot.includes('visibility: hidden') || domSnapshot.includes('visibility:hidden')) {
        findings.push('Found "visibility: hidden" in the DOM.');
      }
      if (domSnapshot.includes('aria-hidden="true"')) {
        findings.push('Found aria-hidden="true" - element may be intentionally hidden.');
      }
    } else {
      findings.push(`Selector "${expectedSelector}" is NOT found in the DOM snapshot.`);
      findings.push('The element was never rendered, or the selector has changed.');

      // Suggest similar selectors
      const dataTestIds = domSnapshot.match(/data-testid="[^"]+"/g) || [];
      if (dataTestIds.length > 0) {
        findings.push(`Available data-testid attributes: ${dataTestIds.slice(0, 10).join(', ')}`);
      }
    }
  }

  // Check for expected text content
  if (expectedContent) {
    if (domSnapshot.includes(expectedContent)) {
      findings.push(`Expected content "${expectedContent}" IS present in the DOM.`);
    } else {
      findings.push(`Expected content "${expectedContent}" is NOT found in the DOM.`);
    }
  }

  // General DOM analysis
  const errorElements = domSnapshot.match(/class="[^"]*error[^"]*"/gi) || [];
  if (errorElements.length > 0) {
    findings.push(`Found ${errorElements.length} element(s) with "error" in their class name.`);
  }

  const loadingElements = domSnapshot.match(/class="[^"]*loading[^"]*"/gi) ||
    domSnapshot.match(/class="[^"]*spinner[^"]*"/gi) || [];
  if (loadingElements.length > 0) {
    findings.push(`Found ${loadingElements.length} loading/spinner element(s) - page may not have finished loading.`);
  }

  // Check for empty state indicators
  if (domSnapshot.includes('no-data') || domSnapshot.includes('empty-state') || domSnapshot.includes('no results')) {
    findings.push('DOM contains empty-state/no-data indicators - the page may have loaded but with no data.');
  }

  // Truncate DOM for context
  const truncated = domSnapshot.length > 3000
    ? domSnapshot.substring(0, 3000) + `\n... (${domSnapshot.length - 3000} more chars)`
    : domSnapshot;

  return [
    'DOM Analysis:',
    '',
    ...findings,
    '',
    'DOM Snapshot (truncated):',
    truncated,
  ].join('\n');
}

/**
 * Extract searchable patterns from a CSS selector.
 */
function extractSelectorPatterns(selector: string): string[] {
  const patterns: string[] = [];

  // data-testid="value"
  const testIdMatch = selector.match(/\[data-testid="([^"]+)"\]/);
  if (testIdMatch) patterns.push(`data-testid="${testIdMatch[1]}"`);

  // #id
  const idMatch = selector.match(/#([\w-]+)/);
  if (idMatch) patterns.push(`id="${idMatch[1]}"`);

  // .class
  const classMatch = selector.match(/\.([\w-]+)/);
  if (classMatch) patterns.push(classMatch[1]);

  // If nothing matched, use the raw selector as a search string
  if (patterns.length === 0) {
    patterns.push(selector);
  }

  return patterns;
}

// ---- Claude tool definition ----

export const DOM_TOOL_DEFINITIONS = [
  {
    name: 'analyze_dom' as const,
    description: 'Analyze the DOM snapshot captured at the moment of test failure. Checks if expected selectors/content exist, identifies hidden elements, loading states, and error indicators.',
    input_schema: {
      type: 'object' as const,
      properties: {
        domSnapshot: { type: 'string' as const, description: 'HTML snapshot from domStateAtFailure' },
        expectedSelector: { type: 'string' as const, description: 'CSS selector that was expected to exist or be visible' },
        expectedContent: { type: 'string' as const, description: 'Text content that was expected on the page' },
      },
      required: ['domSnapshot'],
    },
  },
];

export type DomToolName = (typeof DOM_TOOL_DEFINITIONS)[number]['name'];
