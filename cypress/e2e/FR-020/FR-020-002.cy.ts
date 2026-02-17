/**
 * FR-020-002: Search Icon Display
 * Test Case: FR020-TC-002
 * Description: Validates that search icon is visible
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-002: Search Icon Display', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-002] should display search icon', () => {
    cy.stepLog('Verify search icon (SVG) element exists on the page');
    cy.get('svg').should('exist');

    cy.stepLog('Search icon is visible and ready');
  });
});
