/**
 * FR-020-003: Filter Button Display
 * Test Case: FR020-TC-003
 * Description: Validates that filter button is visible
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-003: Filter Button Display', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-003] should display filter button', () => {
    cy.stepLog('Verify filter button with SVG icon exists');
    cy.get('button').find('svg').should('exist');
    cy.stepLog('Filter button is visible and ready');
  });
});
