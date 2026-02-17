/// <reference types="cypress" />

// ***********************************************
// Custom Cypress Commands
// ***********************************************

/**
 * Custom command to login with session caching
 * Uses flexible selectors to work with different login page implementations
 * @example cy.login('user@example.com', 'password123')
 * @example cy.login() // Uses credentials from environment variables
 */
Cypress.Commands.add('login', (email?: string, password?: string) => {
  // Use provided credentials or fallback to environment variables
  const loginEmail = email || Cypress.env('TEST_ADMIN_EMAIL');
  const loginPassword = password || Cypress.env('TEST_ADMIN_PASSWORD');

  if (!loginEmail || !loginPassword) {
    throw new Error('Login credentials not provided. Pass as parameters or set in .env file');
  }

  cy.session(
    ['wastehero-session', loginEmail],
    () => {
      cy.log('🔐 Performing login...');
      cy.visit('/');

      // Use direct selectors that work on WasteHero
      cy.get('input[placeholder="Username"]').clear().type(loginEmail);
      cy.get('input[placeholder="Password"]').clear().type(loginPassword);
      cy.contains('button', 'Log in').click();

      // Try multiple selectors for password input
      const passwordSelectors = [
        'input[placeholder="Password"]', // WasteHero specific
        '[data-testid="password-input"]',
        '[data-testid="password"]',
        'input[type="password"]',
        'input[name="password"]',
      ];

      // Find and fill password - uses Cypress retry-ability
      cy.get('body').then(($body) => {
        for (const selector of passwordSelectors) {
          if ($body.find(selector).length > 0) {
            cy.get(selector).first().clear().type(loginPassword);
            return;
          }
        }
        throw new Error('Could not find password input field with any known selector');
      });

      // Try multiple selectors for submit button
      const buttonSelectors = [
        'button:contains("Log in")', // WasteHero specific
        '[data-testid="login-button"]',
        'button[type="submit"]',
        'button:contains("Sign in")',
        'button:contains("Login")',
        'input[type="submit"]',
      ];

      // Find and click submit button - uses Cypress retry-ability
      cy.get('body').then(($body) => {
        for (const selector of buttonSelectors) {
          if ($body.find(selector).length > 0) {
            cy.get(selector).first().click();
            return;
          }
        }
        throw new Error('Could not find login button with any known selector');
      });

      // Wait for navigation away from login page
      cy.url({ timeout: 10000 }).should('not.include', '/login');
      cy.log('✅ Login successful');
    },
    {
      validate() {
        // Verify session is still valid by checking for auth cookie
        cy.getCookie('connect.sid').should('exist');
      },
      cacheAcrossSpecs: true,
    }
  );
});

/**
 * Custom command to wait for API response
 * @example cy.waitForApi('@getTransactions')
 */
Cypress.Commands.add('waitForApi', (alias: string) => {
  cy.wait(alias).its('response.statusCode').should('eq', 200);
});

/**
 * Custom command to check if element is visible and enabled
 * @example cy.shouldBeInteractable('[data-testid="submit-btn"]')
 */
Cypress.Commands.add('shouldBeInteractable', (selector: string) => {
  cy.get(selector).should('be.visible').and('not.be.disabled');
});

// ***********************************************
// Step Logging Commands (for Google Sheets reporting)
// ***********************************************

import { testContext } from './test-context';

/**
 * Log a custom step (will appear in "Steps to Reproduce")
 * @example cy.stepLog('Navigate to contacts page')
 */
Cypress.Commands.add('stepLog', (description: string) => {
  testContext.addStep(description, { source: 'manual' });
  cy.log(`📝 ${description}`);
});

/**
 * Click with automatic step logging
 * @example cy.clickAndLog('[data-testid="submit"]', 'Click submit button')
 */
Cypress.Commands.add('clickAndLog', (selector: string, description?: string) => {
  const desc = description || `Click ${selector}`;
  testContext.addStep(desc);
  cy.get(selector).click();
});

/**
 * Type with automatic step logging
 * @example cy.typeAndLog('[data-testid="email"]', 'test@example.com', 'Enter email address')
 */
Cypress.Commands.add('typeAndLog', (selector: string, text: string, description?: string) => {
  const desc = description || `Type '${text}' into ${selector}`;
  testContext.addStep(desc);
  cy.get(selector).type(text);
});

/**
 * Verify with automatic step logging
 * @example cy.verifyAndLog('[data-testid="message"]', 'be.visible', 'Success message displayed')
 */
Cypress.Commands.add(
  'verifyAndLog',
  (selector: string, assertion: string, description?: string) => {
    const desc = description || `Verify ${selector} ${assertion}`;
    testContext.addStep(desc);
    cy.get(selector).should(assertion);
  }
);

// Declare custom commands for TypeScript
declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Custom command to login with email and password
       */
      login(email: string, password: string): Chainable<void>;

      /**
       * Custom command to wait for API and verify 200 status
       */
      waitForApi(alias: string): Chainable<void>;

      /**
       * Custom command to verify element is visible and enabled
       */
      shouldBeInteractable(selector: string): Chainable<void>;

      /**
       * Log a custom step for "Steps to Reproduce"
       */
      stepLog(description: string): Chainable<void>;

      /**
       * Click with automatic step logging
       */
      clickAndLog(selector: string, description?: string): Chainable<void>;

      /**
       * Type with automatic step logging
       */
      typeAndLog(selector: string, text: string, description?: string): Chainable<void>;

      /**
       * Verify with automatic step logging
       */
      verifyAndLog(selector: string, assertion: string, description?: string): Chainable<void>;
    }
  }
}

export {};
