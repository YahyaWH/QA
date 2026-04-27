/**
 * Reusable Authentication Helpers
 * Provides functions for login, session management, and navigation
 */

/**
 * Login to WasteHero application with session caching
 * @param email - User email
 * @param password - User password
 */
export function loginWithSession(email: string, password: string) {
  cy.stepLog(`Login as ${email} (session-cached)`);
  cy.session(
    ['wastehero-user', email],
    () => {
      cy.visit('/');
      cy.get('input[placeholder="Username"]').type(email);
      cy.get('input[placeholder="Password"]').type(password, { log: false });
      cy.contains('button', 'Log in').click();
      cy.url().should('not.include', '/login', { timeout: 15000 });
    },
    {
      cacheAcrossSpecs: true,
      validate() {
        // Verify session is still valid by checking authentication status
        cy.visit('/app/dashboard');
        cy.url().should('include', '/app/dashboard', { timeout: 10000 });
        cy.url().should('not.include', '/login');
      },
    }
  );
}

/**
 * Login with default admin credentials from environment
 */
export function loginAsAdmin() {
  const email = Cypress.env('TEST_ADMIN_EMAIL');
  const password = Cypress.env('TEST_ADMIN_PASSWORD');
  cy.stepLog('Login as admin user');
  loginWithSession(email, password);
}

/**
 * Login and navigate to a specific page
 * @param page - Page URL to navigate to after login
 */
export function loginAndNavigateTo(page: string) {
  loginAsAdmin();
  cy.stepLog(`Navigate to ${page}`);
  cy.visit(page);
  cy.url().should('include', page);
}

/**
 * Navigate to Contacts page via direct URL
 * Assumes user is already logged in
 */
export function navigateToContacts() {
  cy.stepLog('Navigate to Contacts page');
  cy.visit('/app/customer-management/contacts');
  cy.url().should('include', '/customer-management/contacts');
}

/**
 * Full flow: Login as admin and navigate to Contacts page
 */
export function setupContactsTest() {
  loginAsAdmin();
  navigateToContacts();
}

/**
 * Navigate to Customer Categories page via direct URL
 * Assumes user is already logged in
 */
export function navigateToCustomerCategories() {
  cy.stepLog('Navigate to Customer Categories page');
  cy.visit('/app/customer-management/customer-categories');
  cy.url().should('include', '/customer-management/customer-categories');
}

/**
 * Full flow: Login as admin and navigate to Customer Categories page
 */
export function setupCustomerCategoriesTest() {
  loginAsAdmin();
  navigateToCustomerCategories();
}

/**
 * Navigate to a specific customer profile
 * Assumes user is already logged in
 * @param customerId - The customer ID to navigate to
 */
export function navigateToCustomerProfile(customerId: string) {
  cy.stepLog(`Navigate to customer profile: ${customerId}`);
  cy.visit(`/app/customer-management/contacts/${customerId}`);
  cy.url().should('include', `/customer-management/contacts/${customerId}`);
}

/**
 * Full flow: Login as admin and navigate to a customer profile
 * @param customerId - The customer ID to navigate to
 */
export function setupCustomerProfileTest(customerId: string) {
  loginAsAdmin();
  navigateToCustomerProfile(customerId);
}

/**
 * Navigate to Reports page via direct URL
 * Assumes user is already logged in
 */
export function navigateToReports() {
  cy.stepLog('Navigate to Reports page');
  cy.visit('/app/reports');
  cy.url().should('include', '/reports');
}

/**
 * Full flow: Login as admin and navigate to Reports page
 */
export function setupReportsTest() {
  loginAsAdmin();
  navigateToReports();
}
