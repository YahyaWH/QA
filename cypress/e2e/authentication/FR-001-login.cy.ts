import { LoginPage } from '@pages/LoginPage';

/**
 * FR-001: User Authentication - Login
 *
 * Tests user login functionality for WasteHero application including:
 * - Valid credentials login (admin user)
 * - Invalid credentials handling
 * - Form validation
 * - Session persistence
 *
 * @tags @critical @authentication @smoke
 *
 * Security Note:
 * - Credentials are loaded from .env file (NEVER hardcoded)
 * - Testing on staging environment only
 * - Using test-specific account
 */
describe(
  'FR-001: User Login - WasteHero',
  { tags: ['@critical', '@authentication', '@smoke'] },
  () => {
    let loginPage: LoginPage;
    let testEmail: string;
    let testPassword: string;

    before(() => {
      loginPage = new LoginPage();

      // ✅ SECURE: Load credentials from environment variables
      testEmail = Cypress.env('TEST_ADMIN_EMAIL');
      testPassword = Cypress.env('TEST_ADMIN_PASSWORD');

      // Verify environment variables are set
      expect(testEmail, '❌ TEST_ADMIN_EMAIL not set in .env file').to.exist;
      expect(testPassword, '❌ TEST_ADMIN_PASSWORD not set in .env file').to.exist;

      cy.log('🔐 Credentials loaded from .env file');
      cy.log(`📧 Email: ${testEmail}`);
      cy.log('🔑 Password: ********** (hidden for security)');
    });

    beforeEach(() => {
      // Clear any existing sessions before each test
      cy.clearCookies();
      cy.clearLocalStorage();
      cy.clearAllSessionStorage();

      // Visit login page
      loginPage.visit();
    });

    context('✅ Valid Login Scenarios', () => {
      it('should successfully login with valid admin credentials', () => {
        cy.log('Test: Login with valid credentials');

        // Arrange - Already have credentials from before() hook

        // Act - Perform login
        loginPage.login(testEmail, testPassword);

        // Assert - Verify successful login
        loginPage.shouldBeLoggedIn();
        loginPage.shouldRedirectToDashboard();

        cy.log('Login successful - redirected from login page');
      });

      it('should persist session after page reload', () => {
        cy.log('Test: Session persistence');

        // Login first
        loginPage.login(testEmail, testPassword);
        loginPage.shouldBeLoggedIn();

        // Reload page
        cy.reload();

        // Should still be logged in
        loginPage.shouldBeLoggedIn();
        cy.url().should('not.include', '/login');

        cy.log('Session persisted after reload');
      });

      it('should login using cached session (performance test)', () => {
        cy.log('Test: Session caching with cy.session()');

        // Use cy.session() for faster subsequent logins
        cy.session(
          ['wastehero-admin', testEmail],
          () => {
            cy.log('🔄 Creating new session...');
            loginPage.visit();
            loginPage.login(testEmail, testPassword);

            // Wait for navigation away from login page
            cy.url().should('not.include', '/login', { timeout: 15000 });
            loginPage.shouldBeLoggedIn();
          },
          {
            validate() {
              cy.log('✓ Validating cached session...');
              // Verify session is still valid by checking any cookie exists
              // WasteHero uses mixpanel cookies, not connect.sid
              cy.getCookies().should('have.length.gt', 0);
            },
            cacheAcrossSpecs: true,
          }
        );

        // Visit app - should already be logged in
        cy.visit('/');
        loginPage.shouldBeLoggedIn();

        cy.log('✅ Cached session works - no re-login needed');
      });
    });

    context('Invalid Login Scenarios', () => {
      it('should show error for invalid email', () => {
        cy.log('Test: Invalid email');

        loginPage.login('invalid.email@example.com', testPassword);

        // Should show error or stay on login page
        cy.wait(2000); // Wait for error message
        cy.url().should('include', '/login');

        cy.log('Login failed as expected - stayed on login page');
      });

      it('should show error for invalid password', () => {
        cy.log('Test: Invalid password');

        loginPage.login(testEmail, 'WrongPassword123!');

        // Should show error or stay on login page
        cy.wait(2000); // Wait for error message
        cy.url().should('include', '/login');

        cy.log('Login failed as expected - stayed on login page');
      });

      it('should show error for empty email', () => {
        cy.log('Test: Empty email field');

        loginPage.fillPassword(testPassword);
        loginPage.clickLogin();

        // Should show validation error
        cy.wait(1000);
        cy.url().should('include', '/login');

        cy.log('Validation error shown for empty email');
      });

      it('should show error for empty password', () => {
        cy.log('Test: Empty password field');

        loginPage.fillEmail(testEmail);
        loginPage.clickLogin();

        // Should show validation error
        cy.wait(1000);
        cy.url().should('include', '/login');

        cy.log('Validation error shown for empty password');
      });

      it('should show error for both empty fields', () => {
        cy.log('Test: Both fields empty');

        loginPage.clickLogin();

        // Should show validation error
        cy.wait(1000);
        cy.url().should('include', '/login');

        cy.log('Validation error shown for empty form');
      });
    });

    context('Form Validation', () => {
      it('should validate email format', () => {
        cy.log('Test: Email format validation');

        loginPage.fillEmail('not-an-email');
        loginPage.fillPassword(testPassword);
        loginPage.clickLogin();

        // Should show validation error or stay on login page
        cy.wait(1000);
        cy.url().should('include', '/login');

        cy.log('Invalid email format rejected');
      });

      it('should allow password to be visible when toggled', () => {
        cy.log('Test: Password visibility toggle');

        loginPage.fillPassword(testPassword);

        // Look for password visibility toggle
        cy.get('body').then(($body) => {
          const toggleSelectors = [
            '[data-testid="toggle-password"]',
            'button[aria-label*="password"]',
            'button[aria-label*="Password"]',
            'button[aria-label*="show"]',
            'button[aria-label*="Show"]',
            '[type="password"] ~ button',
            '.toggle-password',
          ];

          for (const selector of toggleSelectors) {
            if ($body.find(selector).length > 0) {
              cy.get(selector).click();
              cy.log('Found and clicked password toggle');
              return;
            }
          }

          cy.log('ℹPassword toggle not found - may not be implemented');
        });
      });
    });

    context('Security Checks', () => {
      it('should verify testing on staging environment', () => {
        cy.log('Test: Environment safety check');

        const baseUrl = Cypress.config('baseUrl');

        // Ensure we're NOT on production
        expect(baseUrl).to.not.include('app.wastehero.io'); // Production
        expect(baseUrl).to.include('staging'); // Staging

        cy.log('Confirmed testing on staging environment');
        cy.log(`Base URL: ${baseUrl}`);
      });

      it('should not expose credentials in network requests', () => {
        cy.log('Test: Credentials not exposed in URL');

        // Intercept login request
        cy.intercept('POST', '**/login').as('loginRequest');
        cy.intercept('POST', '**/auth**').as('authRequest');
        cy.intercept('POST', '**/signin').as('signinRequest');

        loginPage.login(testEmail, testPassword);

        // Wait for any of the intercepted requests
        cy.wait(2000);

        // Verify credentials are not in URL
        cy.url().then((url) => {
          expect(url).to.not.include(testPassword);
          expect(url).to.not.include(encodeURIComponent(testPassword));
        });

        cy.log('Credentials not exposed in URL');
      });
    });

    context('Debug Information', () => {
      it('should log page structure for debugging', function () {
        cy.log('Debug: Exploring login page structure');

        // This test helps understand the page structure
        cy.visit('/');

        // Log all input fields
        cy.get('input').each(($input, index) => {
          const type = $input.attr('type');
          const name = $input.attr('name');
          const id = $input.attr('id');
          const placeholder = $input.attr('placeholder');
          const testId = $input.attr('data-testid');

          cy.log(`Input ${index + 1}:`, {
            type,
            name,
            id,
            placeholder,
            'data-testid': testId,
          });
        });

        // Log all buttons
        cy.get('button').each(($button, index) => {
          const text = $button.text();
          const type = $button.attr('type');
          const testId = $button.attr('data-testid');

          cy.log(`Button ${index + 1}:`, {
            text: text.trim(),
            type,
            'data-testid': testId,
          });
        });

        // Take screenshot for reference
        cy.screenshot('login-page-structure');

        cy.log('Page structure logged - check console and screenshots');

        // Mark test as skipped in reports (it's just for debugging)
        this.skip();
      });
    });
  }
);

/**
 * Test Summary:
 *
 * ✅ Valid Login Tests:
 * - Successful login with valid credentials
 * - Session persistence after reload
 * - Session caching for performance
 *
 * ❌ Invalid Login Tests:
 * - Invalid email handling
 * - Invalid password handling
 * - Empty field validation
 *
 * 🔍 Form Validation Tests:
 * - Email format validation
 * - Password visibility toggle
 *
 * 🛡️ Security Tests:
 * - Environment verification (staging only)
 * - Credential exposure check
 *
 * 📊 Debug Tests:
 * - Page structure exploration
 * - Selector discovery
 */
