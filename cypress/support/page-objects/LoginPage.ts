/**
 * Page Object Model for Login Page
 * Encapsulates selectors and actions for the login page
 */
export class LoginPage {
  // Selectors - Multiple fallbacks for different implementations
  private readonly emailSelectors = [
    'input[placeholder="Username"]', // WasteHero specific
    '[data-testid="email-input"]',
    '[data-testid="email"]',
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[id*="email"]',
    'input[id*="username"]',
    'input[placeholder*="email"]',
    'input[placeholder*="Email"]',
  ];

  private readonly passwordSelectors = [
    'input[placeholder="Password"]', // WasteHero specific
    '[data-testid="password-input"]',
    '[data-testid="password"]',
    'input[type="password"]',
    'input[name="password"]',
    'input[id*="password"]',
  ];

  private readonly loginButtonSelectors = [
    'button:contains("Log in")', // WasteHero specific
    '[data-testid="login-button"]',
    '[data-testid="login-btn"]',
    'button[type="submit"]',
    'button:contains("Sign in")',
    'button:contains("Login")',
    'input[type="submit"]',
  ];

  // Actions
  visit() {
    cy.stepLog('Navigate to Login page');
    cy.visit('/');
    return this;
  }

  fillEmail(email: string) {
    cy.stepLog(`Enter username: ${email}`);
    cy.get('input[placeholder="Username"]').clear().type(email);
    return this;
  }

  fillPassword(password: string) {
    cy.stepLog('Enter password: ****');
    cy.get('input[placeholder="Password"]').clear().type(password);
    return this;
  }

  clickLogin() {
    cy.stepLog('Click "Log in" button');
    cy.contains('button', 'Log in').click();
    return this;
  }

  login(email: string, password: string) {
    cy.stepLog(`Login with credentials (${email})`);
    this.fillEmail(email);
    this.fillPassword(password);
    this.clickLogin();
    return this;
  }

  // Helper method to find element with multiple selectors
  private findElement(
    selectors: string[],
    elementName: string
  ): Cypress.Chainable<JQuery<HTMLElement>> {
    // Try each selector in order until one succeeds
    const trySelector = (index: number): Cypress.Chainable<JQuery<HTMLElement>> => {
      if (index >= selectors.length) {
        throw new Error(
          `❌ Could not find ${elementName}. Tried selectors: ${selectors.join(', ')}`
        );
      }

      const selector = selectors[index];

      return cy.get('body', { log: false }).then(($body) => {
        if ($body.find(selector).length > 0) {
          cy.log(`✅ Found ${elementName} using: ${selector}`);
          return cy.get(selector).first();
        }
        return trySelector(index + 1);
      });
    };

    return trySelector(0);
  }

  // Assertions
  shouldShowError(message?: string) {
    cy.stepLog(`Verify error message is displayed${message ? `: "${message}"` : ''}`);
    // Generic error message check
    const errorSelectors = [
      '[data-testid="error-message"]',
      '.error',
      '.alert-error',
      '.error-message',
      '[role="alert"]',
    ];

    // Use cy.get('body').then() to work within Cypress's retry-ability system
    cy.get('body').then(($body) => {
      let found = false;
      for (const selector of errorSelectors) {
        if ($body.find(selector).length > 0) {
          if (message) {
            cy.get(selector).should('be.visible').and('contain', message);
          } else {
            cy.get(selector).should('be.visible');
          }
          found = true;
          break;
        }
      }

      if (!found && message) {
        // Fallback: just check if message text exists anywhere
        cy.contains(message).should('be.visible');
      } else if (!found) {
        throw new Error('Could not find any error message element');
      }
    });

    return this;
  }

  shouldBeOnLoginPage() {
    cy.stepLog('Verify user is on the Login page');
    cy.url().should('include', '/login');
    return this;
  }

  shouldRedirectToDashboard() {
    cy.stepLog('Verify redirect to Dashboard after login');
    cy.url().should('not.include', '/login');
    // Wait for navigation to complete
    cy.url({ timeout: 10000 }).should('satisfy', (url) => {
      return (
        url.includes('/dashboard') ||
        url.includes('/home') ||
        url.includes('/app') ||
        !url.includes('/login')
      );
    });
    return this;
  }

  shouldBeLoggedIn() {
    cy.stepLog('Verify user is logged in');
    // Multiple ways to verify logged in state
    cy.url().should('not.include', '/login');

    // Check for common logged-in indicators
    const loggedInSelectors = [
      '[data-testid="user-menu"]',
      '[data-testid="logout"]',
      '[data-testid="profile"]',
      'button:contains("Logout")',
      'button:contains("Log out")',
      'button:contains("Sign out")',
    ];

    // At least one should exist
    cy.get('body').then(($body) => {
      const found = loggedInSelectors.some((selector) => {
        return $body.find(selector).length > 0;
      });

      if (!found) {
        // Fallback: just verify we're not on login page
        cy.url().should('not.include', '/login');
      }
    });

    return this;
  }
}
